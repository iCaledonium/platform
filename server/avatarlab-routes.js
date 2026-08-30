// Avatar Lab — the player's own body: adoption, readiness, the push into the
// worlds, and the artefacts the creation pipeline leaves on disk.
//
// Scope: this bench asserts on everything AROUND a body — whether the one you
// built is yours, whether it is really on disk, whether it is the size a
// runtime model should be, whether it reached the worlds, and whether the
// pipeline's leftovers (reference photos, personal media) stayed private.
//
// It now also runs the photo → DAZ → Blender → GLB pipeline itself, which this
// header used to rule out as "a long job, not a test action". That reasoning
// held only while a run needed a human to upload a photo first: the real cost
// was never the minutes, it was that the one input could not be supplied from
// here, so the bench could only ever assert about a body somebody else had
// already made. Taking the reference from the account's own profile picture
// removes that, and a build becomes reproducible. It is still minutes long.

import { existsSync, statSync, readdirSync, copyFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";

const MEDIA_ROOT = "/home/magnus/platform/public";
const DIST_ROOT = "/home/magnus/platform/dist";
// A runtime model is a dressed, baked body. Anything far past that is the
// GLTFExporter userData trap: layer caches ride into the GLB's `extras` and
// a 26MB runtime becomes 172MB without anything looking wrong.
const RUNTIME_SANE_MB = 60;

export function mount(app, { db, authUser, SERVICE_TOKEN, SIMULATOR_URL }) {
  const pass = (name, detail) => ({ verdict: "pass", name, detail });
  const fail = (name, detail) => ({ verdict: "fail", name, detail });
  const skip = (name, detail) => ({ verdict: "skip", name, detail });

  const fileFor = (url) => (url ? join(MEDIA_ROOT, url.split("?")[0]) : null);
  const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

  // Every user wearing a body, with the actor row behind it.
  const wearers = () => db.prepare(
    `SELECT u.id user_id, u.name user_name, u.avatar_actor_id,
            a.id actor_id, a.owner_id, a.name actor_name, a.age,
            a.glb_url, a.runtime_glb_url, a.draft_state
       FROM users u LEFT JOIN actors a ON a.id = u.avatar_actor_id
      WHERE u.avatar_actor_id IS NOT NULL`).all();

  // ── the bench's one state write, scoped to the caller's own row ───────────
  // Adoption has no undo in the product (POST /api/me/avatar demands an
  // actor_id), so a lab that can adopt must be able to put it back.
  app.post("/api/test/avatar/clear", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const before = db.prepare(`SELECT avatar_actor_id FROM users WHERE id = ?`).get(user.id);
    db.prepare(`UPDATE users SET avatar_actor_id = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(user.id);
    res.json({ ok: true, cleared: before?.avatar_actor_id || null });
  });

  // ── the reference photo, taken from the account instead of an upload ────
  //
  // The pipeline reads exactly one thing as its likeness input: an actor_media
  // row with state_slug 'profile'. Hand-uploading a photo on every run is what
  // kept a build out of this bench, so this puts the profile picture the
  // account already carries into precisely that row.
  //
  // Nothing is faked or short-circuited — generate-3d cannot tell this apart
  // from a wizard upload, because it IS the row a wizard upload writes. The
  // bytes are copied rather than pointing actor_media at /media/users/<id>/:
  // discarding an actor deletes its media by folder, so aiming the row at the
  // account's own picture would make a thrown-away test build take the user's
  // profile photo down with it.
  app.post("/api/test/avatar/use-profile-photo", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });

    const actorId = String(req.body?.actor_id || "").trim();
    if (!actorId) return res.status(400).json({ error: "actor_id required" });
    const actor = db.prepare(`SELECT id, media_folder FROM actors WHERE id = ? AND owner_id = ?`)
      .get(actorId, user.id);
    if (!actor) return res.status(404).json({ error: "not your character" });

    const row = db.prepare(`SELECT photo_url FROM users WHERE id = ?`).get(user.id);
    if (!row?.photo_url) {
      return res.status(400).json({ error: "your account has no profile photo to build from" });
    }
    const rel = row.photo_url.split("?")[0];
    const src = join(MEDIA_ROOT, rel);
    if (!existsSync(src)) {
      return res.status(400).json({ error: `profile photo row points at nothing on disk: ${rel}` });
    }

    const filename = `profile${extname(rel) || ".png"}`;
    const dir = join(MEDIA_ROOT, "media", "actors", actor.media_folder, "images");
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, join(dir, filename));

    const url = `/media/actors/${actor.media_folder}/images/${filename}`;
    const bytes = statSync(src).size;
    const now = new Date().toISOString();

    // One reference per actor. A re-run replaces the row instead of stacking a
    // second 'profile' that the pipeline's lookup would then pick between by
    // insertion order.
    db.transaction(() => {
      db.prepare(`DELETE FROM actor_media WHERE actor_id = ? AND state_slug = 'profile' AND world_id IS NULL`)
        .run(actorId);
      db.prepare(`INSERT INTO actor_media (id, actor_id, media_type, filename, url, state_slug, inserted_at, updated_at, file_size)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), actorId, "photo", filename, url, "profile", now, now, bytes);
    })();

    res.json({ ok: true, actor_id: actorId, url, bytes, source: rel });
  });

  app.get("/api/test/avatar/checks", async (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });

    const checks = [];
    const rows = wearers();

    // 1. The pointer must lead to a real actor that the wearer owns.
    if (rows.length === 0) {
      checks.push(skip("an avatar belongs to the person wearing it",
        "nobody is wearing an avatar right now — adopt one above to give this something to assert about"));
    } else {
      const dangling = rows.filter(r => !r.actor_id);
      const stolen = rows.filter(r => r.actor_id && r.owner_id !== r.user_id);
      if (dangling.length === 0 && stolen.length === 0) {
        checks.push(pass("an avatar belongs to the person wearing it",
          `${rows.length} wearer(s), each pointing at a character they own`));
      } else {
        checks.push(fail("an avatar belongs to the person wearing it",
          `${dangling.length} pointer(s) lead to no actor at all, ${stolen.length} to a character owned by someone else`));
      }
    }

    // 2. "Ready" is a claim about a file. Check the file.
    const ready = rows.filter(r => r.actor_id && (r.glb_url || r.runtime_glb_url));
    if (ready.length === 0) {
      checks.push(skip("a ready avatar has a model on disk", "no avatar is in the ready state"));
    } else {
      const missing = [];
      for (const r of ready) {
        for (const [kind, url] of [["model", r.glb_url], ["runtime", r.runtime_glb_url]]) {
          if (!url) continue;
          const f = fileFor(url);
          if (!existsSync(f) || statSync(f).size === 0) missing.push(`${r.actor_name} ${kind}`);
        }
      }
      checks.push(missing.length === 0
        ? pass("a ready avatar has a model on disk", `every model URL on ${ready.length} avatar(s) resolves to a non-empty file`)
        : fail("a ready avatar has a model on disk",
            `${missing.length} model URL(s) point at nothing on disk (${missing.join(", ")}) — the profile reads "ready" and there is no body`));
    }

    // 3. Size is the tell for the userData-in-extras trap.
    const runtimes = ready.filter(r => r.runtime_glb_url).map(r => {
      const f = fileFor(r.runtime_glb_url);
      return { name: r.actor_name, size: existsSync(f) ? statSync(f).size : 0 };
    }).filter(r => r.size > 0);
    if (runtimes.length === 0) {
      checks.push(skip("the runtime model is not carrying its own cache", "no runtime model on disk to weigh"));
    } else {
      const fat = runtimes.filter(r => mb(r.size) > RUNTIME_SANE_MB);
      checks.push(fat.length === 0
        ? pass("the runtime model is not carrying its own cache",
            `${runtimes.map(r => `${r.name} ${mb(r.size)}MB`).join(", ")} — all under ${RUNTIME_SANE_MB}MB`)
        : fail("the runtime model is not carrying its own cache",
            `${fat.map(r => `${r.name} ${mb(r.size)}MB`).join(", ")} exceeds ${RUNTIME_SANE_MB}MB — ` +
            "GLTFExporter serialises every userData into the GLB's extras, which is how a 26MB runtime becomes 172MB"));
    }

    // 4. Age. The only restraint in the product is an HTML min attribute.
    if (rows.length === 0) {
      checks.push(skip("no avatar is a minor", "nobody is wearing an avatar right now"));
    } else {
      const noAge = rows.filter(r => r.actor_id && (r.age === null || r.age === undefined));
      const under = rows.filter(r => typeof r.age === "number" && r.age < 18);
      if (under.length === 0 && noAge.length === 0) {
        checks.push(pass("no avatar is a minor",
          "every avatar carries an age of 18 or over — note this asserts the DATA; the only enforcement " +
          "in the product is min={18} on an input, so nothing server-side would refuse a younger one"));
      } else {
        checks.push(fail("no avatar is a minor",
          `${under.length} avatar(s) under 18, ${noAge.length} with no age at all — and there is no ` +
          "server-side floor on either host to have stopped it"));
      }
    }

    // 5. The likeness leak: reference photos republished into the built site.
    try {
      const hits = [];
      const walk = (dir, depth = 0) => {
        if (depth > 4 || hits.length > 5) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p, depth + 1);
          else if (/reference|likeness|body-photo|face-photo/i.test(e.name)) hits.push(p);
        }
      };
      if (existsSync(DIST_ROOT)) walk(DIST_ROOT);
      checks.push(hits.length === 0
        ? pass("reference photos never reach the built site",
            "nothing matching reference/likeness/body-photo under dist — vite's publicDir once republished them on every build")
        : fail("reference photos never reach the built site",
            `${hits.length} likeness file(s) inside dist (${hits.slice(0, 2).join(", ")}) — these ship to anyone who can load the site`));
    } catch (e) {
      checks.push(skip("reference photos never reach the built site", "could not read dist: " + e.message));
    }

    // 6. Personal media must stay behind auth on the public origin.
    try {
      let publicBase = null;
      try {
        const t = await fetch("http://127.0.0.1:4040/api/tunnels").then(r => r.json());
        publicBase = (t.tunnels || []).map(x => x.public_url).find(u => u && u.startsWith("https://")) || null;
      } catch { /* no tunnel API */ }
      if (!publicBase) {
        checks.push(skip("personal media stays behind auth on the public origin",
          "no ngrok tunnel answered on 127.0.0.1:4040 — cannot probe the public path from here"));
      } else {
        const probe = ready[0]?.runtime_glb_url || ready[0]?.glb_url || "/media/actors/probe/none.glb";
        const r = await fetch(`${publicBase}${probe.split("?")[0]}`, { redirect: "manual" });
        checks.push(r.status === 401
          ? pass("personal media stays behind auth on the public origin", `${publicBase} answered 401 for a /media path`)
          : fail("personal media stays behind auth on the public origin",
              `expected 401 from the public origin, got ${r.status} — personal bodies and faces are reachable`));
      }
    } catch (e) {
      checks.push(skip("personal media stays behind auth on the public origin", "probe failed: " + e.message));
    }

    // 7. Adoption is not finished until the body is in the worlds.
    if (ready.length === 0) {
      checks.push(skip("the body reached the worlds", "no ready avatar to have been pushed"));
    } else {
      const problems = [];
      let looked = 0;
      for (const r of ready) {
        const memberships = db.prepare(
          `SELECT world_id, actor_id FROM world_memberships WHERE user_id = ?`).all(r.user_id);
        for (const m of memberships) {
          looked++;
          try {
            const p = await fetch(`${SIMULATOR_URL}/internal/worlds/${m.world_id}/presence`,
              { headers: { "X-Service-Token": SERVICE_TOKEN } }).then(x => x.json());
            const me = (p.locations || []).flatMap(l => l.actors || [])
              .find(a => a.actor_id === m.actor_id);
            if (!me) problems.push(`${r.actor_name}: not present in ${m.world_id.slice(0, 8)}`);
            else if (!me.glb_url && !me.runtime_glb_url) problems.push(`${r.actor_name}: present in ${m.world_id.slice(0, 8)} with no model`);
          } catch (e) { problems.push(`${m.world_id.slice(0, 8)}: ${e.message}`); }
        }
      }
      if (looked === 0) {
        checks.push(skip("the body reached the worlds", "the wearer belongs to no worlds"));
      } else {
        checks.push(problems.length === 0
          ? pass("the body reached the worlds", `${looked} membership(s) checked, each carrying a model in the simulator`)
          : fail("the body reached the worlds",
              `${problems.join("; ")} — the platform says ready and the world it counts in disagrees`));
      }
    }

    // 8. The head-count metric is a constant wearing a measurement's clothes.
    const withDraft = rows.filter(r => r.draft_state);
    if (withDraft.length === 0) {
      checks.push(skip("head-length is measured, not assumed", "no avatar carries a draft_state to read"));
    } else {
      let verdicts = [];
      for (const r of withDraft) {
        try {
          const rm = JSON.parse(r.draft_state)?.referenceMeasurements;
          const h = rm?.input_height_cm, head = rm?.landmark?.estimated_head_length_cm ?? rm?.estimated_head_length_cm;
          if (!h || !head) continue;
          const ratio = Math.round((h / head) * 1000) / 1000;
          verdicts.push({ name: r.actor_name, ratio });
        } catch { /* unreadable blob */ }
      }
      if (verdicts.length === 0) {
        checks.push(skip("head-length is measured, not assumed", "no readable height/head pair in any draft_state"));
      } else if (verdicts.every(v => Math.abs(v.ratio - 7.5) < 0.01)) {
        checks.push(fail("head-length is measured, not assumed",
          `${verdicts.map(v => `${v.name} ${v.ratio}`).join(", ")} — exactly 7.5 heads, because ` +
          "estimated_head_length_cm is height/7.5 by definition. Any body scores adult here; score on silhouette ratios instead"));
      } else {
        checks.push(pass("head-length is measured, not assumed",
          verdicts.map(v => `${v.name} ${v.ratio}`).join(", ")));
      }
    }

    res.json({ ok: true, checked_at: new Date().toISOString(), checks });
  });
}
