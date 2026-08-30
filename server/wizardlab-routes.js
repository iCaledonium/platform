// Character Wizard Lab — the authoring surface itself: what a draft is worth
// when you come back to it, whether the controls on it are wired to anything,
// and whether the two ends of a wizard session (create, discard) are safe.
//
// Scope, stated because it is easy to widen by accident: this bench is about
// AUTHORING, not about the body. What the pipeline builds and where the bytes
// land belongs to the Avatar bench (/lab/user/avatar); the psychology the
// simulator later reads belongs to the world benches. Here the question is
// narrower and nobody else asks it — the wizard is one 3,000-line component
// holding a seven-step form, an autosave, a rename, a discard and a viewer, and
// almost everything it does to the server it does with a fire-and-forget
// fetch whose failure path is a console.error nobody is reading.
//
// That shape is the whole reason for this board. A rename that fails leaves
// the row and the folder disagreeing and says so only in a console; an
// autosave that never fired leaves a draft whose sliders silently return to
// zero on the next load, next to a body that still shows the shape they made.
// Neither is visible from inside the wizard, and both are trivially visible
// from here.
//
// Two halves, split on purpose:
//
//   The SCORECARD is strictly read-only, so the test manager can sweep it on a
//   schedule against whatever anybody is working on right now. It asserts
//   against live rows and against the source of the wizard itself.
//
//   The PROBES write. They walk a throwaway character through the production
//   endpoints — create, autosave, rename, discard — and clean up after
//   themselves. They are buttons and are never swept: a nightly job must not
//   be creating and deleting rows in the background.

import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const MEDIA_ROOT = process.env.LAB_MEDIA_ROOT || "/home/magnus/platform/public";
const REPO_ROOT  = process.env.LAB_REPO_ROOT  || "/home/magnus/platform";

const WIZARD_SRC  = join(REPO_ROOT, "src/pages/CharacterWizard.jsx");
const VIEWER_SRC  = join(REPO_ROOT, "src/pages/MiniGlbViewer.jsx");
const PIPELINE_SRC = join(REPO_ROOT, "server/generate3d.js");

// The keys loadDraft() actually reads back out of draft_state. A snapshot
// missing one of these does not fail loudly — the loader's law is "absent
// means cleared", which is right for inheritance and wrong for a save that
// half-happened: the draft opens, looks plausible, and has lost that section.
const RESUMED_KEYS = [
  "identity", "extraMorphValues", "accessories", "selectedAccessoryGlbUrls",
  "psychology", "personality", "lifestyle", "economy",
  "assessments", "assessmentResults",
];

// ── the morph vocabulary, and why the exceptions are named ───────────────────
//
// A slider in the wizard writes a camelCase key into extraMorphValues. The
// viewer turns that key into a shape key through MORPH_NAMES, and the shape
// key only exists in the GLB because generate3d.js baked it. Three lists, two
// hand-maintained joins, no test between them until now — and a key that falls
// out of the chain produces a control that moves smoothly and does nothing.
//
// The documented, correct exceptions:
//
// BONE_SCALED — four dials that are NOT shape keys at all. They are ERC
// meta-dials DAZ does not expose through getNumModifiers(), so the viewer
// applies them as bone scales instead. Their absence from MORPH_NAMES is the
// design, not a break; the check proves the sidestep exists rather than
// trusting this list.
const BONE_SCALED = ["headSize", "chestSize", "handSize", "footSize"];

// RENAMED_ON_EXPORT — Diffeomorphic renames five morphs on the way out, so the
// viewer (which reads the GLB) and DAZ (which bakes it) correctly speak
// different names for the same thing. Mapped back before comparing.
const DAZ_NAME_OF = {
  body_bs_BodyMuscularVolume: "body_bs_BodyMuscularMass",
  body_bs_BodyMass:           "body_bs_MassBody",
  body_bs_MassUpperarms:      "body_bs_MassUpperArms",
  body_bs_BreastSmall:        "body_bs_BreastsSmall",
  body_bs_BreastSize:         "body_bs_BreastsLarge",
};

// NEVER_APPLIED — looked up for diagnostics and deliberately never applied:
// the shape key data is broken (a documented DAZ bug — it behaves like Body
// Mass). Height is driven by torso+legs+arms together instead.
const NEVER_APPLIED = ["height"];

// The sweep (server/lab-incidents.js) needs this board as a value rather than
// as an HTTP route the server would have to authenticate to itself — same
// arrangement as the signup board.
let boundChecks = null;
export async function wizardChecks() {
  if (!boundChecks) throw new Error("the character wizard board is not mounted");
  return boundChecks();
}

export function mount(app, { db, authUser, PORT }) {
  const pass = (name, detail) => ({ verdict: "pass", name, detail });
  const fail = (name, detail) => ({ verdict: "fail", name, detail });
  const skip = (name, detail) => ({ verdict: "skip", name, detail });

  const short = (id) => String(id || "").slice(0, 8);
  const folderOf = (name, id) =>
    String(name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + String(id).slice(0, 8);

  const parseState = (raw) => {
    if (!raw) return { ok: false, reason: "absent" };
    try { return { ok: true, state: JSON.parse(raw) }; }
    catch (e) { return { ok: false, reason: "unparseable: " + e.message }; }
  };

  // ── the scorecard ─────────────────────────────────────────────────────────

  async function computeChecks() {
    const checks = [];
    const guarded = (name, fn) => {
      try { fn(); } catch (e) { checks.push(fail(name, "the check itself failed: " + e.message)); }
    };

    const actors = db.prepare(
      `SELECT id, name, status, owner_id, media_folder, glb_url, draft_state, age, gender
         FROM actors`).all();
    const drafts = actors.filter(a => a.status === "draft");

    // 1. The drafts rail offers a draft; loadDraft refuses one with no model
    //    ("loadDraft: draft has no glb_url — cannot load", console only) and
    //    restores nothing without a snapshot. Either way the row is listed,
    //    clicking it appears to do nothing, and the reason is in a console.
    guarded("a draft the rail offers can actually be resumed", () => {
      if (!drafts.length) {
        checks.push(skip("a draft the rail offers can actually be resumed",
          "no drafts exist — nothing is being offered for resume"));
        return;
      }
      const broken = [];
      for (const d of drafts) {
        const st = parseState(d.draft_state);
        if (!d.glb_url) broken.push(`${short(d.id)} ${d.name}: no model — loadDraft returns early and the click does nothing`);
        else if (!st.ok) broken.push(`${short(d.id)} ${d.name}: draft_state ${st.reason} — opens with every control back at its default beside the body it built`);
      }
      checks.push(broken.length === 0
        ? pass("a draft the rail offers can actually be resumed",
            `${drafts.length} draft(s), each with a model and a readable snapshot`)
        : fail("a draft the rail offers can actually be resumed", broken.join("; ")));
    });

    // 2. Auto-persist is the only thing that writes the snapshot, and it fails
    //    into a console.error. A draft missing a section it once had is
    //    indistinguishable from one that never had it — which is why this
    //    names the missing sections rather than counting them.
    guarded("a resumed draft brings back every section it was saving", () => {
      const readable = drafts.map(d => ({ d, st: parseState(d.draft_state) })).filter(x => x.st.ok);
      if (!readable.length) {
        checks.push(skip("a resumed draft brings back every section it was saving",
          "no draft carries a readable snapshot to inspect"));
        return;
      }
      const thin = readable
        .map(({ d, st }) => ({ d, missing: RESUMED_KEYS.filter(k => !(k in st.state)) }))
        .filter(x => x.missing.length);
      checks.push(thin.length === 0
        ? pass("a resumed draft brings back every section it was saving",
            `${readable.length} snapshot(s) carry all ${RESUMED_KEYS.length} sections the loader reads back`)
        : fail("a resumed draft brings back every section it was saving",
            thin.map(x => `${short(x.d.id)} ${x.d.name} is missing ${x.missing.join(", ")}`).join("; ") +
            " — the loader treats an absent section as cleared, so these open with that work gone"));
    });

    // 3. Avatar mode claims the draft at CREATE, which is what makes "save and
    //    finish later" true — and it puts users.avatar_actor_id on a row the
    //    discard path deletes outright. That FK is NO ACTION with
    //    foreign_keys=ON, so the DELETE raises; and abandon-draft unlinks the
    //    media files BEFORE the transaction that raises, so the failure is not
    //    even clean. Nothing in the product clears the pointer first.
    guarded("nobody is wearing a draft", () => {
      const worn = db.prepare(
        `SELECT u.id user_id, u.name user_name, a.id actor_id, a.name actor_name, a.status
           FROM users u JOIN actors a ON a.id = u.avatar_actor_id
          WHERE a.status = 'draft'`).all();
      checks.push(worn.length === 0
        ? pass("nobody is wearing a draft",
            "every adopted avatar points at a finished character, so the discard path cannot meet the avatar_actor_id foreign key")
        : fail("nobody is wearing a draft",
            worn.map(w => `${w.user_name} wears draft ${short(w.actor_id)} ${w.actor_name}`).join("; ") +
            " — avatar mode adopts at create, and discarding one of these unlinks its media files and then " +
            "fails on the users.avatar_actor_id foreign key, leaving a half-destroyed row still being worn"));
    });

    // 4. The media folder is {first}-{last}-{id8}. Rename moves the folder,
    //    rewrites the row and rewrites every media url in one transaction —
    //    and reports its failure to a console. A row whose folder no longer
    //    matches its name, or whose media points outside its folder, is that
    //    failure, days later.
    guarded("a character's media is where its name says it is", () => {
      const wrong = [];
      for (const a of actors) {
        const want = folderOf(a.name, a.id);
        if (want !== a.media_folder) { wrong.push(`${short(a.id)} ${a.name}: folder is ${a.media_folder}, the name says ${want}`); continue; }
        const dir = join(MEDIA_ROOT, "media/actors", a.media_folder || "");
        const media = db.prepare(`SELECT url FROM actor_media WHERE actor_id = ?`).all(a.id);
        if (media.length && !existsSync(dir)) { wrong.push(`${short(a.id)} ${a.name}: ${media.length} media row(s) and no folder on disk`); continue; }
        const stray = media.filter(m => !String(m.url || "").startsWith(`/media/actors/${a.media_folder}/`));
        if (stray.length) wrong.push(`${short(a.id)} ${a.name}: ${stray.length} media url(s) outside its own folder (${stray[0].url})`);
      }
      checks.push(wrong.length === 0
        ? pass("a character's media is where its name says it is",
            `${actors.length} character(s): folder matches the name, exists on disk, and every media url sits inside it`)
        : fail("a character's media is where its name says it is",
            wrong.join("; ") + " — a rename that half-applied looks exactly like this and only ever said so in a console"));
    });

    // 5. Every slider is wired to something. Three lists, two hand-maintained
    //    joins: the wizard's keys, the viewer's MORPH_NAMES, the pipeline's
    //    baked set. A key that falls out of the chain is a control that moves
    //    smoothly and changes nothing — and nothing anywhere would say so.
    guarded("every appearance slider is wired to a real morph", () => {
      for (const f of [WIZARD_SRC, VIEWER_SRC, PIPELINE_SRC]) {
        if (!existsSync(f)) { checks.push(skip("every appearance slider is wired to a real morph", `cannot read ${f}`)); return; }
      }
      const wiz = readFileSync(WIZARD_SRC, "utf8");
      const view = readFileSync(VIEWER_SRC, "utf8");
      const gen = readFileSync(PIPELINE_SRC, "utf8");

      const sliders = [...new Set([...wiz.matchAll(/setExtraMorph\("([A-Za-z0-9_]+)"/g)].map(m => m[1]))];
      const start = view.indexOf("const MORPH_NAMES");
      const block = start < 0 ? "" : view.slice(start, view.indexOf("};", start));
      const morphNames = Object.fromEntries(
        [...block.matchAll(/^\s*([A-Za-z0-9_]+):\s*"([A-Za-z0-9_]+)"/gm)].map(m => [m[1], m[2]]));
      const bakedBlock = gen.match(/const morphNames = \[([^\]]*)\]/);
      const baked = bakedBlock ? [...bakedBlock[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map(m => m[1]) : [];

      if (!sliders.length || !Object.keys(morphNames).length || !baked.length) {
        checks.push(skip("every appearance slider is wired to a real morph",
          `could not read all three lists (sliders ${sliders.length}, MORPH_NAMES ${Object.keys(morphNames).length}, baked ${baked.length}) — ` +
          "the shapes they are parsed out of have moved, so this proves nothing rather than passing"));
        return;
      }

      // The four bone-scaled dials are exempt from MORPH_NAMES, but only
      // because the viewer applies them another way. Prove that at the CALL
      // SITE — the value has to reach a scale function — rather than trusting
      // a function name: applyHeadBoneScale does not contain "headSize", and a
      // name-shaped test would have called that dial dead.
      const unscaled = BONE_SCALED.filter(k =>
        !new RegExp(`apply[A-Za-z]*Scale\\([^)]*extraMorphValues\\.${k}\\b`).test(view));
      const inert = sliders.filter(k => !morphNames[k] && !BONE_SCALED.includes(k));
      const unbaked = Object.entries(morphNames)
        .filter(([k]) => !NEVER_APPLIED.includes(k))
        .filter(([, daz]) => !baked.includes(DAZ_NAME_OF[daz] || daz))
        .map(([k, daz]) => `${k} → ${daz}`);

      const problems = [];
      if (inert.length) problems.push(`${inert.length} slider(s) write a key the viewer has no morph for (${inert.join(", ")})`);
      if (unbaked.length) problems.push(`${unbaked.length} morph name(s) are never baked, so the shape key is absent from the GLB (${unbaked.join(", ")})`);
      if (unscaled.length) problems.push(`${unscaled.length} dial(s) exempted here as bone-scaled have no scale path left in the viewer (${unscaled.join(", ")})`);

      checks.push(problems.length === 0
        ? pass("every appearance slider is wired to a real morph",
            `${sliders.length} sliders → ${Object.keys(morphNames).length} morph names → ${baked.length} baked shape keys; ` +
            `${BONE_SCALED.length} bone-scaled dials and ${Object.keys(DAZ_NAME_OF).length} export renames accounted for`)
        : fail("every appearance slider is wired to a real morph", problems.join("; ")));
    });

    // 6. Wardrobe lives in draft_state as urls, and the catalogue is discovered
    //    from disk. Removing an asset does not touch the drafts wearing it —
    //    the dressed export just quietly leaves that garment off.
    guarded("a saved wardrobe still exists on disk", () => {
      const dressed = actors
        .map(a => ({ a, st: parseState(a.draft_state) }))
        .filter(x => x.st.ok)
        .map(x => ({ a: x.a, urls: Object.values(x.st.state.selectedAccessoryGlbUrls || {}).filter(u => typeof u === "string" && u.startsWith("/")) }))
        .filter(x => x.urls.length);
      if (!dressed.length) {
        checks.push(skip("a saved wardrobe still exists on disk", "no saved character references an accessory"));
        return;
      }
      const gone = [];
      let looked = 0;
      for (const { a, urls } of dressed) {
        for (const u of urls) {
          looked++;
          if (!existsSync(join(MEDIA_ROOT, u.split("?")[0]))) gone.push(`${short(a.id)} ${a.name}: ${u}`);
        }
      }
      checks.push(gone.length === 0
        ? pass("a saved wardrobe still exists on disk", `${looked} garment reference(s) across ${dressed.length} character(s), all present`)
        : fail("a saved wardrobe still exists on disk",
            `${gone.length} of ${looked} reference(s) point at nothing (${gone.slice(0, 3).join("; ")}) — the dressed export drops these silently`));
    });

    // 7. The Session-150 family: five psychology fields were collected by the
    //    wizard, rendered as inputs, written into the prompt that generates
    //    them, POSTed — and left out of the INSERT. Every character had four
    //    permanently blank fields and nothing said why. This is the general
    //    form of that bug: what the snapshot holds, the row must hold too.
    //
    //    Drafts are exempt on purpose — the satellite rows are written at
    //    creation and filled at finalize, so a draft legitimately holds
    //    answers the row does not have yet.
    guarded("what the wizard collected, the server stored", () => {
      const finished = actors.filter(a => a.status !== "draft" && a.draft_state);
      if (!finished.length) {
        checks.push(skip("what the wizard collected, the server stored",
          "no finished character carries a snapshot to compare the row against"));
        return;
      }
      const cols = new Set(db.prepare(`SELECT * FROM actor_psychology LIMIT 1`).all().length
        ? Object.keys(db.prepare(`SELECT * FROM actor_psychology LIMIT 1`).get()) : []);
      const dropped = [];
      for (const a of finished) {
        const st = parseState(a.draft_state);
        if (!st.ok) continue;
        const authored = st.state.psychology || {};
        const row = db.prepare(`SELECT * FROM actor_psychology WHERE actor_id = ?`).get(a.id);
        if (!row) { dropped.push(`${short(a.id)} ${a.name}: no psychology row at all`); continue; }
        const lost = Object.entries(authored)
          .filter(([k, v]) => cols.has(k) && v !== "" && v != null && (row[k] === null || row[k] === undefined))
          .map(([k]) => k);
        const unknown = Object.keys(authored).filter(k => !cols.has(k));
        if (lost.length) dropped.push(`${short(a.id)} ${a.name}: ${lost.join(", ")} authored and not stored`);
        if (unknown.length) dropped.push(`${short(a.id)} ${a.name}: ${unknown.join(", ")} has no column to land in`);
      }
      checks.push(dropped.length === 0
        ? pass("what the wizard collected, the server stored",
            `${finished.length} finished character(s): every authored psychology field reached its column`)
        : fail("what the wizard collected, the server stored",
            dropped.join("; ") + " — the field is on the form, in the prompt and in the snapshot, and nowhere in the row"));
    });

    // 8. Assessment ANSWERS and the completion flags that gate the next step
    //    live in different places — the answers in a table, the flags in the
    //    snapshot. When they disagree the wizard re-locks a step whose
    //    evidence is sitting right there, or offers a verdict whose answers
    //    are gone. Both halves have been lost independently before.
    guarded("assessment answers and their completion flags agree", () => {
      const orphans = db.prepare(
        `SELECT COUNT(*) c FROM actor_assessment_results r
           LEFT JOIN actors a ON a.id = r.actor_id WHERE a.id IS NULL`).get().c;
      const claimed = [];
      for (const a of actors) {
        const st = parseState(a.draft_state);
        if (!st.ok) continue;
        const flags = st.state.assessments || {};
        const done = Object.entries(flags).filter(([, v]) => v === true || v?.completed).map(([k]) => k);
        if (!done.length) continue;
        const rows = db.prepare(`SELECT COUNT(*) c FROM actor_assessment_results WHERE actor_id = ?`).get(a.id).c;
        const kept = Object.keys(st.state.assessmentResults || {}).length;
        if (rows === 0 && kept === 0) claimed.push(`${short(a.id)} ${a.name}: ${done.length} assessment(s) marked complete with no answers anywhere`);
      }
      const problems = [];
      if (orphans) problems.push(`${orphans} assessment result row(s) belong to a character that no longer exists`);
      problems.push(...claimed);
      checks.push(problems.length === 0
        ? pass("assessment answers and their completion flags agree",
            "no orphaned results, and every completion flag has answers behind it")
        : fail("assessment answers and their completion flags agree", problems.join("; ")));
    });

    return checks;
  }

  boundChecks = computeChecks;

  app.get("/api/test/wizard/checks", async (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    res.json({ ok: true, checked_at: new Date().toISOString(), checks: await computeChecks() });
  });

  // ── the probes ────────────────────────────────────────────────────────────
  //
  // Everything below writes. Each one drives the SAME endpoints the wizard
  // drives, over loopback, carrying the caller's own cookie — so what passes
  // here is evidence about the product and not about a lab shortcut. Each
  // cleans up in a finally, including after its own failure.

  const api = (req, path, init = {}) =>
    fetch(`http://127.0.0.1:${PORT}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), cookie: req.headers.cookie || "" },
    });

  // Force-remove a throwaway the production path could not: clears an avatar
  // pointer that would block the delete, drops the satellite rows, removes the
  // folder. Only ever called on a row this bench created.
  function forceRemove(actorId, folder) {
    try {
      db.prepare(`UPDATE users SET avatar_actor_id = NULL WHERE avatar_actor_id = ?`).run(actorId);
      const tables = ["actor_psychology", "actor_big5", "actor_disc", "actor_hds", "actor_economic",
        "actor_lifestyle", "actor_mental_health", "actor_education", "actor_upbringing",
        "actor_diagnoses", "actor_media", "actor_shares", "actor_assessment_results",
        "actor_expense_defaults", "actor_deployments"];
      db.transaction(() => {
        for (const t of tables) { try { db.prepare(`DELETE FROM ${t} WHERE actor_id = ?`).run(actorId); } catch { /* table may not exist */ } }
        db.prepare(`DELETE FROM actors WHERE id = ?`).run(actorId);
      })();
      if (folder) rmSync(join(MEDIA_ROOT, "media/actors", folder), { recursive: true, force: true });
    } catch { /* best effort — the probe already reported what it found */ }
  }

  const LAB_FIRST = "Labcase";

  // Probe 1 — a whole draft lifecycle through the production endpoints.
  // create → autosave → resume → rename → discard, asserting after each.
  app.post("/api/test/wizard/probe/lifecycle", async (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });

    const checks = [];
    const stamp = String(Date.now()).slice(-6);
    let id = null, folder = null;
    try {
      // create
      const created = await api(req, "/api/actors", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: true, identity: { first_name: LAB_FIRST, last_name: `Before${stamp}`, gender: "female", age: 34 } }),
      });
      const cbody = await created.json().catch(() => ({}));
      id = cbody.id || null;
      const row = id ? db.prepare(`SELECT * FROM actors WHERE id = ?`).get(id) : null;
      folder = row?.media_folder || null;
      checks.push(created.ok && row?.status === "draft"
        ? pass("a draft is created as a draft", `${short(id)} · status ${row.status} · folder ${row.media_folder}`)
        : fail("a draft is created as a draft", `HTTP ${created.status} ${JSON.stringify(cbody).slice(0, 200)}`));
      if (!id) return res.json({ ok: false, checks });

      // the satellite rows the finalize path later UPDATEs must exist now —
      // finalize only ever UPDATEs, so a missing row is silently no work.
      const satellites = ["actor_psychology", "actor_big5", "actor_disc", "actor_hds", "actor_lifestyle", "actor_economic"];
      const missing = satellites.filter(t => !db.prepare(`SELECT 1 FROM ${t} WHERE actor_id = ?`).get(id));
      checks.push(missing.length === 0
        ? pass("creation lays down every row finalize will update", satellites.join(", "))
        : fail("creation lays down every row finalize will update",
            `${missing.join(", ")} absent — finalize UPDATEs these and an UPDATE against no row writes nothing, silently`));

      // autosave, then read it back the way loadDraft does
      const marker = { identity: { first_name: LAB_FIRST, last_name: `Before${stamp}`, age: 34 },
        extraMorphValues: { bodyTone: 42 }, accessories: {}, selectedAccessoryGlbUrls: {},
        psychology: { wound: `probe-${stamp}` }, personality: {}, lifestyle: {}, economy: {},
        assessments: {}, assessmentResults: {}, bodyHeightCm: 171 };
      const saved = await api(req, `/api/actors/${id}/draft-state`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: marker }),
      });
      const back = await api(req, `/api/actors/${id}`).then(r => r.json()).catch(() => ({}));
      let round = null;
      try { round = JSON.parse(back?.actor?.draft_state || "null"); } catch { /* reported below */ }
      const same = round && JSON.stringify(round) === JSON.stringify(marker);
      checks.push(saved.ok && same
        ? pass("the autosave survives a reload byte for byte",
            `${Object.keys(marker).length} sections written and read back identical through GET /api/actors/:id, which is where loadDraft reads them`)
        : fail("the autosave survives a reload byte for byte",
            `save HTTP ${saved.status}; read back ${round ? "differed from what was written" : "was absent or unparseable"}`));

      // rename — with a real file in the folder, because the interesting half
      // is the folder move and the url rewrite, not the row update
      mkdirSync(join(MEDIA_ROOT, "media/actors", folder, "images"), { recursive: true });
      writeFileSync(join(MEDIA_ROOT, "media/actors", folder, "images", "probe.txt"), `lab probe ${stamp}`);
      db.prepare(`INSERT INTO actor_media (id, actor_id, media_type, filename, url, state_slug, inserted_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?)`)
        .run(`probe-${stamp}`, id, "photo", "probe.txt", `/media/actors/${folder}/images/probe.txt`, "probe",
             new Date().toISOString(), new Date().toISOString());

      const renamed = await api(req, `/api/actors/${id}/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ first_name: LAB_FIRST, last_name: `After${stamp}` }),
      });
      const rbody = await renamed.json().catch(() => ({}));
      const after = db.prepare(`SELECT name, media_folder FROM actors WHERE id = ?`).get(id);
      const wantFolder = folderOf(`${LAB_FIRST} After${stamp}`, id);
      const movedFile = existsSync(join(MEDIA_ROOT, "media/actors", wantFolder, "images", "probe.txt"));
      const oldGone = !existsSync(join(MEDIA_ROOT, "media/actors", folder));
      const url = db.prepare(`SELECT url FROM actor_media WHERE id = ?`).get(`probe-${stamp}`)?.url || "";
      if (after?.media_folder) folder = after.media_folder;
      const renameOk = renamed.ok && after?.media_folder === wantFolder && movedFile && oldGone &&
        url === `/media/actors/${wantFolder}/images/probe.txt`;
      checks.push(renameOk
        ? pass("renaming a draft moves its folder and rewrites its urls",
            `${wantFolder} · file moved · media url rewritten — row, disk and references agree`)
        : fail("renaming a draft moves its folder and rewrites its urls",
            `HTTP ${renamed.status} ${rbody.error || ""} · folder now ${after?.media_folder} (wanted ${wantFolder}) · ` +
            `file moved ${movedFile} · old folder gone ${oldGone} · media url ${url || "missing"} — ` +
            "row, disk and references have to move together or the character loses its media"));

      // discard
      const abandoned = await api(req, `/api/actors/${id}/abandon-draft`, { method: "POST" });
      const stillRow = db.prepare(`SELECT 1 FROM actors WHERE id = ?`).get(id);
      const stillSat = satellites.filter(t => db.prepare(`SELECT 1 FROM ${t} WHERE actor_id = ?`).get(id));
      const stillDir = existsSync(join(MEDIA_ROOT, "media/actors", folder));
      checks.push(abandoned.status === 204 && !stillRow && !stillSat.length && !stillDir
        ? pass("discarding a draft leaves nothing behind", "row, satellite rows and media folder all gone")
        : fail("discarding a draft leaves nothing behind",
            `HTTP ${abandoned.status} · row ${stillRow ? "still there" : "gone"} · ` +
            `satellites left: ${stillSat.join(", ") || "none"} · folder ${stillDir ? "still on disk" : "gone"}`));
      if (!stillRow) id = null;
    } catch (e) {
      checks.push(fail("the lifecycle probe ran to the end", "it threw: " + e.message));
    } finally {
      if (id) forceRemove(id, folder);
    }
    res.json({ ok: checks.every(c => c.verdict !== "fail"), ran_at: new Date().toISOString(), checks });
  });

  // Probe 2 — the age floor. The wizard's input carries min={18}, which
  // constrains a native form submission and nothing else: the value it posts
  // is a React state value, and every other caller of this endpoint is
  // script. The floor has to be on the server, and the age travels — the
  // avatar push writes it onto the player's row in every world, where the
  // simulator interpolates it into an NPC's prompt.
  app.post("/api/test/wizard/probe/age-floor", async (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });

    const checks = [];
    const made = [];
    const stamp = String(Date.now()).slice(-6);
    const create = async (age, last) => {
      const r = await api(req, "/api/actors", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: true, identity: { first_name: LAB_FIRST, last_name: last, gender: "female", age } }),
      });
      const b = await r.json().catch(() => ({}));
      if (b?.id) made.push(b.id);
      return { status: r.status, body: b };
    };
    try {
      for (const [age, why] of [[7, "a child"], [17, "one year under"], [0, "zero"], [-3, "negative"], [200, "impossible"], ["twelve", "not a number"]]) {
        const r = await create(age, `Age${stamp}`);
        checks.push(r.status === 400
          ? pass(`age ${JSON.stringify(age)} is refused`, `${why} — HTTP 400: ${r.body.error || ""}`)
          : fail(`age ${JSON.stringify(age)} is refused`,
              `HTTP ${r.status} — ${why} was accepted; this value would ride the avatar push onto the player's row in every world and into an NPC's prompt`));
      }
      const ok = await create(18, `Adult${stamp}`);
      checks.push(ok.status === 200 || ok.status === 201
        ? pass("age 18 is accepted", `the floor is a floor, not a wall — HTTP ${ok.status}`)
        : fail("age 18 is accepted", `HTTP ${ok.status} ${ok.body.error || ""} — the bound is refusing legal values`));

      // An absent age has to stay legal: the wizard saves a draft long before
      // the Age field is filled in.
      const blank = await create(undefined, `Blank${stamp}`);
      checks.push(blank.status === 200 || blank.status === 201
        ? pass("a draft with no age yet is still allowed", "creation is not blocked to enforce a rule about content")
        : fail("a draft with no age yet is still allowed", `HTTP ${blank.status} ${blank.body.error || ""}`));
    } catch (e) {
      checks.push(fail("the age probe ran to the end", "it threw: " + e.message));
    } finally {
      for (const id of made) {
        const row = db.prepare(`SELECT media_folder FROM actors WHERE id = ?`).get(id);
        if (row) forceRemove(id, row.media_folder);
      }
    }
    res.json({ ok: checks.every(c => c.verdict !== "fail"), ran_at: new Date().toISOString(), checks });
  });

  // Probe 3 — the two ends of avatar mode meeting each other. Avatar mode
  // adopts the draft at CREATE so that "save it and finish later" is true.
  // Discard then deletes that row while users.avatar_actor_id still points at
  // it. This runs both halves on a throwaway and puts the caller's own pointer
  // back afterwards.
  //
  // Safe on a real account: a draft with no model is not `ready`, so adopting
  // it pushes nothing to any world — deployAvatarToWorlds returns
  // avatar_not_ready before it reaches the simulator. The worlds keep whatever
  // body they already hold, and the restore is a pointer, not a re-push.
  app.post("/api/test/wizard/probe/discard-worn-draft", async (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });

    const checks = [];
    const before = db.prepare(`SELECT avatar_actor_id FROM users WHERE id = ?`).get(user.id)?.avatar_actor_id || null;
    const stamp = String(Date.now()).slice(-6);
    let id = null, folder = null;
    try {
      const created = await api(req, "/api/actors", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: true, identity: { first_name: LAB_FIRST, last_name: `Worn${stamp}`, gender: "female" } }),
      });
      const cb = await created.json().catch(() => ({}));
      id = cb.id || null;
      if (!id) {
        checks.push(fail("a draft to wear could be created", `HTTP ${created.status} ${cb.error || ""}`));
        return res.json({ ok: false, checks });
      }
      folder = db.prepare(`SELECT media_folder FROM actors WHERE id = ?`).get(id)?.media_folder || null;

      const adopted = await api(req, "/api/me/avatar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_id: id }),
      });
      const ab = await adopted.json().catch(() => ({}));
      const pointed = db.prepare(`SELECT avatar_actor_id FROM users WHERE id = ?`).get(user.id)?.avatar_actor_id;
      checks.push(adopted.ok && pointed === id
        ? pass("avatar mode can adopt a draft that has no body yet",
            `pointer moved to ${short(id)}; the push correctly declined (${ab.deploy?.reason || "not ready"}), so no world was touched`)
        : fail("avatar mode can adopt a draft that has no body yet", `HTTP ${adopted.status} ${ab.error || ""}`));

      // The discard the wizard performs on Close → Discard, and on a closing tab.
      const filesBefore = db.prepare(`SELECT COUNT(*) c FROM actor_media WHERE actor_id = ?`).get(id).c;
      const abandoned = await api(req, `/api/actors/${id}/abandon-draft`, { method: "POST" });
      const survived = db.prepare(`SELECT 1 FROM actors WHERE id = ?`).get(id);
      const stillWorn = db.prepare(`SELECT avatar_actor_id FROM users WHERE id = ?`).get(user.id)?.avatar_actor_id === id;
      checks.push(abandoned.status === 204 && !survived
        ? pass("discarding a worn draft completes",
            "the row is gone and the pointer did not hold it hostage")
        : fail("discarding a worn draft completes",
            `HTTP ${abandoned.status} · the row ${survived ? "is still there" : "is gone"}${stillWorn ? " and is still being worn" : ""} — ` +
            `abandon-draft unlinks the media files (${filesBefore} row(s)) BEFORE the transaction that deletes the row, and the ` +
            "users.avatar_actor_id foreign key (NO ACTION, foreign_keys=ON) makes that delete raise. Nothing clears the pointer first, " +
            "so the draft ends up half destroyed and still adopted"));
    } catch (e) {
      checks.push(fail("the worn-draft probe ran to the end", "it threw: " + e.message));
    } finally {
      if (id) forceRemove(id, folder);
      // Put the caller back exactly as they were. Direct, because adopting
      // through the endpoint would re-push a body the worlds already hold.
      db.prepare(`UPDATE users SET avatar_actor_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(before, user.id);
    }
    const restored = db.prepare(`SELECT avatar_actor_id FROM users WHERE id = ?`).get(user.id)?.avatar_actor_id || null;
    checks.push(restored === before
      ? pass("the bench put your own avatar back", before ? `back to ${short(before)}` : "you were wearing nothing, and still are")
      : fail("the bench put your own avatar back", `expected ${before || "none"}, found ${restored || "none"} — restore this by hand`));
    res.json({ ok: checks.every(c => c.verdict !== "fail"), ran_at: new Date().toISOString(), checks });
  });
}
