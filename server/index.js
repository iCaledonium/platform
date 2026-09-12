import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import crypto from "crypto";
import { randomUUID } from "crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import path from "path";
import os from "os";
import zlib from "zlib";
import { fileURLToPath } from "url";
import multer from "multer";
import db from "./db.js";
import { summariseActorMedia } from "./actor-media-audit.js";
import { registerGenerate3DRoutes, deleteActorTmpFolder, appearanceHash } from "./generate3d.js";
import { mergeAnimationIntoActorGlb, removeAnimationFromActorGlb, parseDufFrames } from "./animations.js";
import { educationFromCv } from "./cv_edu.mjs";
import { mount as mountTestLabRoutes } from "./testlab-routes.js";
import { mount as mountSignupLabRoutes } from "./signuplab-routes.js";
import { mount as mountAvatarLabRoutes } from "./avatarlab-routes.js";
import { mount as mountSignInLabRoutes } from "./signinlab-routes.js";
import { mount as mountWizardLabRoutes } from "./wizardlab-routes.js";
import { mount as mountShareLinkRoutes } from "./sharelinks-routes.js";
import { mount as mountShareLabRoutes } from "./sharelab-routes.js";
import { mount as mountDeployLabRoutes } from "./deploylab-routes.js";
import { mount as mountWorldWizardLabRoutes } from "./worldwizardlab-routes.js";
import { mount as mountRoutineLabRoutes } from "./routinelab-routes.js";
import { mount as mountInteractionRoutes } from "./interaction-routes.js";

// Session 102 — drafts carry their wizard adjustment state (all morph
// slider values, the named body sliders, pose values, reference URLs,
// measurements) as one JSON blob, so a draft reloads as the SAME
// in-progress character, not just the same base GLB. Idempotent ALTER
// at boot: succeeds once, throws harmlessly ever after (SQLite has no
// ADD COLUMN IF NOT EXISTS).
try { db.prepare(`ALTER TABLE actors ADD COLUMN draft_state TEXT`).run(); } catch {}
// Session 106 — default home. The wizard's Economy-step picker writes a
// preferred interior template (a shared /media/homes asset, cataloged in
// interior_templates); world/place binding stays with the deploy wizard.
// Same idempotent-at-boot pattern as draft_state above.
try { db.prepare(`ALTER TABLE actors ADD COLUMN default_home_template_url TEXT`).run(); } catch {}
// Session 152 — the runtime character.
//
// glb_url is a working file: morph targets intact so every slider stays live,
// garments at identity so the editor can re-apply its own transforms, each
// garment keeping its own skeleton. All three are right for a model that has to
// round-trip through ActorModelPanel, and all three are wrong for one that gets
// fetched by a world and never edited again — 74.6MB of sculpting nobody reads,
// clothes that need the consumer to know how to dress her, and a `walk` clip
// that moves the body while the jeans stand still.
//
// So the wizard publishes a second file and this records it. The two never
// fight: editing writes glb_url, finishing writes this.
//
// Named for what it is used for, not for what happened to be wrong when it was
// written. "dressed" described the first symptom anyone noticed — an undressed
// figure in a doorway — but the clothes are one of three differences, and the
// file's job is to be the one a running world loads.
try { db.prepare(`ALTER TABLE actors ADD COLUMN runtime_glb_url TEXT`).run(); } catch {}
// The fingerprint the published file was built from — body, wardrobe, morph
// values. Staleness is then a comparison rather than a signal somebody has to
// remember to send: no cache to invalidate, and no hook to add to MiniGlbViewer.
try { db.prepare(`ALTER TABLE actors ADD COLUMN runtime_glb_hash TEXT`).run(); } catch {}
// Session 107 — the actors-table rebuild (Session ~105 schema recovery)
// came back WITHOUT the appearance column while the save handlers still
// referenced it; every draft finalize 500'd from that day until the
// first save attempt found it (SqliteError: no such column: appearance,
// index.js:3276). Restored here so a rebuilt DB self-heals instead of
// mining itself.
try { db.prepare(`ALTER TABLE actors ADD COLUMN appearance TEXT`).run(); } catch {}
// The structured appearance the profile editor's Appearance panel writes, as
// JSON. `appearance` above stays the prose the SIMULATOR reads (it slices it to
// 150 chars into a meeting prompt and feeds it to the video prompt builder), so
// the structured map cannot live there; this column holds it losslessly and the
// panel composes the prose from it.
try { db.prepare(`ALTER TABLE actors ADD COLUMN appearance_fields TEXT`).run(); } catch {}
// Session 147 — per-user preferences (first consumer: Explore display
// sliders). One TEXT JSON column, namespaced object inside (e.g.
// { exploreDisplay: {...} }) so future preference groups merge rather
// than collide. Same idempotent-at-boot pattern as draft_state above.
try { db.prepare(`ALTER TABLE users ADD COLUMN preferences TEXT`).run(); } catch {}
// Session 148 — nationality on the actor identity (ISO 3166-1 alpha-2
// code, e.g. "SE", "US"; the wizard renders it with a flag). First of
// the nationality/language attributes ruled in: pins what the three
// LLMs otherwise each infer differently from a name.
try { db.prepare(`ALTER TABLE actors ADD COLUMN nationality TEXT`).run(); } catch {}
// Session 152 — interests used to exist only as an INTERESTS section inside
// the Haiku-generated CV, which the platform never even persisted (it lived in
// wizard React state until deploy). Structured here so it can be edited, kept
// across sessions, and — the point — reach the simulator's decision prompt via
// lifestyle_context/2. Free text, comma-separated, matching the prose style of
// diet and exercise_type on the same table.
try { db.prepare(`ALTER TABLE actor_lifestyle ADD COLUMN interests TEXT`).run(); } catch {}
// Session 107, landmine #3 from the same rebuild: the recreated actors
// table lost PRIMARY KEY on id, which silently broke EVERY foreign key
// referencing actors ("foreign key mismatch" on actor_media insert) and
// removed the duplicate-id guard. SQLite cannot ALTER a PK in, but a
// unique index is the full equivalent for FK-parent and uniqueness
// purposes. Idempotent.
db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_actors_id_unique ON actors(id)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS interior_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  glb_url TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`).run();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100mb for videos

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Crash safety net ─────────────────────────────────────────────────────────
// Without this, ANY unhandled error anywhere in the process — including in
// unrelated background work like the simulator SSE reconnect loop — kills
// the entire server, taking down every in-flight request (character
// creation, 3D generation, everything) regardless of what actually failed.
// Confirmed cause of a real crash (30 Jul, ~09:57): a simulator SSE
// timeout threw inside undici's fetch internals and brought the whole
// process down mid-generation, unrelated to the generation itself.
// Registered as early as possible, before any route or background task
// that could throw.
// Boot-time errors are the exception: before server.listen's callback has
// fired, an uncaught error means module evaluation died partway and every
// route below the throwing line was never registered (found 2026-08-29: a
// module-scope require() in this ESM file left the service "active" with
// /api/enroll/start 404ing). Exiting non-zero lets systemd restart us and
// makes the failure loud instead of a silently half-booted route table.
let booted = false;
process.on("uncaughtException", (err) => {
  if (!booted) {
    console.error("[uncaughtException] during boot — exiting so the failure is loud:", err);
    process.exit(1);
  }
  console.error("[uncaughtException] not crashing the process:", err);
});
process.on("unhandledRejection", (reason) => {
  if (!booted) {
    console.error("[unhandledRejection] during boot — exiting so the failure is loud:", reason);
    process.exit(1);
  }
  console.error("[unhandledRejection] not crashing the process:", reason);
});

// ── Local LLM helper (dirty-muse on M4) — replaces Haiku for structured JSON tasks ──
const DIRTY_MUSE_URL  = "http://192.168.1.60:11434/api/chat";
const DIRTY_MUSE_MODEL = "dirty-muse-q4:latest";

async function callDirtyMuse(system, userContent, maxTokens = 600) {
  const messages = system
    ? [{ role: "system", content: system }, { role: "user", content: userContent }]
    : [{ role: "user", content: userContent }];
  console.log("[callDirtyMuse] posting to", DIRTY_MUSE_URL, "content length:", userContent.length);
  const res = await fetch(DIRTY_MUSE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: DIRTY_MUSE_MODEL, stream: false, keep_alive: -1,
      // Session 103 — maxTokens was ACCEPTED but never SENT: num_ctx
      // was hardcoded 2048 and num_predict absent, so every caller
      // requesting more than the window got silently truncated output
      // (found live: the 4000-token full-profile route — the only
      // caller that ever exceeded the window — was the only one that
      // failed, mid-JSON; dirty-muse itself was healthy all along).
      options: { num_ctx: 4096, num_predict: maxTokens }, messages }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!res.ok) throw new Error(`dirty-muse ${res.status}`);
  const data = await res.json();
  const raw = data.message?.content || data.choices?.[0]?.message?.content || "";
  // Strip any preamble before first { or [
  const match = raw.match(/[{\[].*/s);
  return match ? match[0] : raw;
}

// Session 149 — this didn't exist as a reusable function; the only real
// Anthropic Haiku call in the whole file was inlined directly inside
// /api/generate/profile. Every OTHER "suggest"/"generate" route in this
// file — despite several of their own comments literally saying "Haiku"
// — actually calls callDirtyMuse (the local Ollama model on .60), a
// mistake that has already happened and been fixed once before on this
// exact profile route (see the Session 103 comment below). Extracting
// this makes it trivial to actually use real Haiku instead of repeating
// that same mistake on every future generation endpoint.
async function callHaiku(system, userContent, maxTokens = 1000) {
  const key = process.env.CLAUDE_API_KEY;
  if (!key) throw new Error("no CLAUDE_API_KEY set");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: userContent }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) { const body = await r.text().catch(() => ""); throw new Error(`anthropic ${r.status}: ${body.slice(0, 200)}`); }
  const data = await r.json();
  const text = (data.content || []).map(c => c.text || "").join("");
  if (!text) throw new Error("anthropic returned empty content");
  return text;
}

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Per-request attribution ──────────────────────────────────────────────────
// Conduct watch, 2026-09-03/05: the platform app logged no request paths at
// all, so the only request record was nginx's access.log -- and ngrok delivers
// every external request as loopback, so 3847 of 3851 requests presented as
// 127.0.0.1 with no account, session or key beside them. Conduct signals could
// count actions and prove existence, but could never say WHO acted.
//
// One line per dynamic request, with the account resolved through the same
// authUser() the routes use, so the log cannot disagree with the authorisation.
// Resolved on 'finish' so the status and duration are real. Static asset paths
// are excluded: they carry no actor and would bury the signal.
// Behaviour watch, 2026-09-09: `media` was in this list, so a media fetch that
// reaches THIS process produced no [req] line in either arm -- served or refused --
// and the bytes under /media/actors|worlds|users are a real person's reference
// photographs, body models and voice. Most browser media on this host is served by
// nginx from disk (the ANIMA-INVARIANT auth_request stanzas) and lands in nginx
// access.log, but anything that reaches :4002 /media directly -- LAN clients,
// server-to-server fetches, anything bypassing nginx -- was completely unattributed.
// That is precisely the traffic that most needs a record. The simulator dropped
// /media from its own @skip the same day (request_log.ex) for the same reason, so
// one grep still reads both hosts. Bulk assets stay skipped: they carry no subject.
// ── Who the served media bytes DEPICT ────────────────────────────────────
// Conduct watch, 2026-09-09: the [req] line below records WHO ASKED (account,
// auth, ip) but said nothing about WHOSE photograph, body model or voice was
// handed over. The simulator's matching line (request_log.ex) already resolves a
// subject=/minor=/subject_age= triple from the actor id in the media path, and
// emits a separate [minor-media] record when the subject is a declared minor,
// precisely so a child-safety audit can grep ONE stable token instead of having
// to know the URL layout. This host emitted neither, so a `minor=yes` read
// across both journals came back clean on the platform BY CONSTRUCTION rather
// than by measurement -- a false clean, which is the failure mode this bench
// exists to catch. Resolved server-side against `actors`, never from a
// caller-supplied string.
//
// Paths whose subject lives on the SIMULATOR (/media/cities, /media/worlds)
// resolve to `remote:<id>` when this host has no row: the ambient cast is not
// stored here, so absence is EXPECTED and must not be reported as an orphan
// (that would manufacture a scary finding out of normal topology). The
// simulator's own [req]/[minor-media] lines are authoritative for those.
// /media/actors is this host's own canonical media, so a missing row there IS
// an orphaned file. Non-personal categories (places, accessories, homes, poses)
// carry no subject at all.
const SUBJ_BY_FOLDER = db.prepare(`SELECT id, age FROM actors WHERE media_folder = ?`);
const SUBJ_BY_ID = db.prepare(`SELECT id, age FROM actors WHERE id = ?`);
// Third key for the /media/worlds shape. A platform actor that has been DEPLOYED
// is addressed in world media by its SIMULATOR actor id (see the deployed-portrait
// writer, which builds /media/worlds/<world_id>/actors/<actor_id>/images/ from the
// simulator id), and that id matches no row in `actors` on this host. Without this
// the subject of a deployed person's own photographs resolved remote: and emitted
// minor=unknown even though this host holds their declared age one join away.
// Undeployed rows are deliberately INCLUDED: the bytes still depict that person
// after the deployment ends, and the audit question is who is in the picture, not
// whether the deployment is current. Newest deployment wins if an id was reused.
const SUBJ_BY_DEPLOYMENT = db.prepare(`SELECT a.id AS id, a.age AS age FROM actor_deployments d JOIN actors a ON a.id = d.platform_actor_id WHERE d.simulator_actor_id = ? ORDER BY d.deployed_at DESC LIMIT 1`);
// ── Fourth key: a declared age the SIMULATOR owns, cached locally ────────
// Conduct watch, 2026-09-11. nginx's /media/worlds/ stanza is
// `try_files $uri @simulator_media`, so when the file EXISTS on this host's
// disk this host serves it and the simulator never witnesses the fetch at
// all. For a simulator-NATIVE actor (no `actors` row here, no
// actor_deployments row) the three keys above all miss, the line fell back to
// subject=remote:<id> minor=unknown subject_age=-, and that was the ONLY
// journal line the fetch would ever produce ON EITHER HOST -- while the
// declared age sat in the simulator's dev.db, one LAN call away. Measured:
// /media/worlds/87c91ce8-.../actors/mk-87c91ce8/images/profile.jpg logged
// minor=unknown here; `select age from actors where id='mk-87c91ce8'` on
// 192.168.1.58 returns 49. The remote: label then sent an auditor to look for
// a simulator line that was never written -- each journal pointing at the
// other, which is the failure this bench exists to catch.
//
// The fix is a small LOCAL READ-MODEL, refreshed OUT OF BAND. Attribution
// must never be able to block or fail a request it is only observing, so the
// logger itself makes NO cross-host call: it reads this table synchronously,
// exactly like the three keys above. It is filled by refreshRemoteActorAges()
// below (20s after boot, then every 15 min) and opportunistically by the
// world-portrait writer the moment it puts such a file on our disk.
//
// Rows are deliberately NEVER deleted when an actor is destroyed: the bytes
// stay on disk and keep depicting that person, so the declared age has to
// outlive the row (same principle as the simulator's non-deletable
// content_deletion_log). This is a COPY of another host's declaration, so the
// line says so: age_src= carries which host corroborated it and when.
db.exec(`CREATE TABLE IF NOT EXISTS remote_actor_ages (
  actor_id   TEXT PRIMARY KEY,
  world_id   TEXT,
  age        INTEGER,
  updated_at TEXT NOT NULL
)`);
const SUBJ_BY_REMOTE_CACHE = db.prepare(`SELECT actor_id AS id, age AS age, updated_at AS updated_at FROM remote_actor_ages WHERE actor_id = ?`);
const UPSERT_REMOTE_AGE = db.prepare(`INSERT INTO remote_actor_ages (actor_id, world_id, age, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(actor_id) DO UPDATE SET world_id = excluded.world_id, age = excluded.age, updated_at = excluded.updated_at`);
function mediaSubject(p) {
  const none = { subject: "-", minor: "-", age: "-", src: "-" };
  try {
    const seg = String(p || "").split("/").filter(Boolean).map(decodeURIComponent);
    if (seg[0] !== "media") return none;
    let a = null;
    let fallback = null;
    // Filled only when no row on THIS host answers -- see remote_actor_ages.
    let cached = null;
    if (seg[1] === "actors" && seg[2]) {
      a = SUBJ_BY_FOLDER.get(seg[2]) || SUBJ_BY_ID.get(seg[2]);
      fallback = `orphan:${seg[2]}`;
    } else if (seg[1] === "worlds" && seg[3] === "actors" && seg[4]) {
      // Conduct watch, 2026-09-11: this branch resolved by id ONLY, but seg[4]
      // on this path is written as the actor MEDIA_FOLDER SLUG by this host own
      // writers -- the world-video upload urlBase `/media/worlds/${world_id}/actors/${actorSlug}`
      // and the deployed-portrait copy -- so every platform-local actor on this
      // shape missed its row, fell through to remote: and emitted minor=unknown,
      // subject_age=-. Measured: id lookup for frida-svensson-c2653aac returns 0
      // rows, media_folder lookup returns 1. That made minor=yes UNREACHABLE on
      // the one path the ping env block names personal_actor_media, i.e. the
      // canonical shape for real photographs of real people: a clean read by
      // construction rather than by measurement, which is the exact failure mode
      // this bench exists to catch, surviving one branch over from where it was
      // fixed on 2026-09-09. Resolve by slug OR id, same order as /media/actors.
      // The remote: fallback STAYS and the /media/cities branch below is left
      // alone: both shapes also carry simulator-owned actors whose rows really do
      // live on the other host, so absence there is normal topology and must not
      // be reported as an orphan.
      a = SUBJ_BY_FOLDER.get(seg[4]) || SUBJ_BY_ID.get(seg[4]) || SUBJ_BY_DEPLOYMENT.get(seg[4]);
      if (!a) cached = SUBJ_BY_REMOTE_CACHE.get(seg[4]);
      fallback = `remote:${seg[4]}`;
    } else if (seg[1] === "cities" && seg[3] === "ambient_actors" && seg[4]) {
      a = SUBJ_BY_ID.get(seg[4]);
      if (!a) cached = SUBJ_BY_REMOTE_CACHE.get(seg[4]);
      fallback = `remote:${seg[4]}`;
    } else if (seg[1] === "users" && seg[2]) {
      // A user's own media folder. `users` carries no declared age on this
      // host, so the honest answer is "unknown" -- never "no".
      return { subject: `user:${seg[2]}`, minor: "unknown", age: "-", src: "-" };
    } else {
      return none;
    }
    if (!a && cached && cached.age !== null && cached.age !== undefined) {
      // Declared on the other host, copied here out of band. The subject token
      // stays `remote:` -- the row really does live over there and an audit
      // greps for it -- but minor=/subject_age= are now ANSWERED rather than
      // unknown, and age_src= says the answer is a cached copy and how old it
      // is, so nobody mistakes it for a row this host owns.
      return { subject: fallback, minor: cached.age < 18 ? "yes" : "no", age: String(cached.age), src: `sim-cache@${cached.updated_at}` };
    }
    if (!a) return { subject: fallback, minor: "unknown", age: "-", src: "-" };
    if (a.age === null || a.age === undefined) return { subject: `actor:${a.id}`, minor: "unknown", age: "-", src: "local" };
    return { subject: `actor:${a.id}`, minor: a.age < 18 ? "yes" : "no", age: String(a.age), src: "local" };
  } catch (_e) {
    // Attribution must never be able to break a request it is only observing.
    return { subject: "unresolved", minor: "unknown", age: "-", src: "-" };
  }
}
// ── Keeping the fourth key current, off the request path ─────────────────
// Everything here runs on a TIMER or from a write handler, never from the
// attribution logger: a per-request cross-host lookup in something that only
// observes a request is the wrong shape, because it could delay or fail the
// request it is watching. SIMULATOR_URL/SERVICE_TOKEN are module consts
// declared further down this file; these functions only ever run after module
// init (20s after boot at the earliest), so that is safe.
async function fetchDeclaredAge(worldId, actorId) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${encodeURIComponent(worldId)}/actors/${encodeURIComponent(actorId)}/profile`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const age = j && j.identity ? j.identity.age : null;
    return (typeof age === "number" && Number.isFinite(age)) ? age : null;
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function localSubjectRow(id) {
  try {
    return SUBJ_BY_FOLDER.get(id) || SUBJ_BY_ID.get(id) || SUBJ_BY_DEPLOYMENT.get(id) || null;
  } catch (_e) { return null; }
}
async function cacheRemoteActorAge(worldId, actorId) {
  try {
    if (!worldId || !actorId || !SERVICE_TOKEN) return false;
    // A row on this host always wins: the read-model exists only for subjects
    // this host holds no declaration for.
    if (localSubjectRow(actorId)) return false;
    const age = await fetchDeclaredAge(worldId, actorId);
    if (age === null) return false;
    UPSERT_REMOTE_AGE.run(String(actorId), String(worldId), age, new Date().toISOString());
    return true;
  } catch (_e) { return false; }
}
async function refreshRemoteActorAges() {
  try {
    const root = path.join(__dirname, "../public/media/worlds");
    if (!fs.existsSync(root)) return;
    let filled = 0, unknown = 0;
    for (const worldId of await fs.promises.readdir(root)) {
      const actorsDir = path.join(root, worldId, "actors");
      if (!fs.existsSync(actorsDir)) continue;
      for (const actorId of await fs.promises.readdir(actorsDir)) {
        if (localSubjectRow(actorId)) continue;
        if (await cacheRemoteActorAge(worldId, actorId)) filled++; else unknown++;
      }
    }
    if (filled || unknown) console.log(`[media-attrib] remote_actor_ages refresh: ${filled} declared, ${unknown} still unknown`);
  } catch (e) {
    // Never fatal: a stale read-model degrades to the old minor=unknown, it
    // does not break serving or logging.
    console.log(`[media-attrib] remote_actor_ages refresh failed: ${e && e.message}`);
  }
}
setTimeout(() => { refreshRemoteActorAges(); }, 20 * 1000).unref();
setInterval(refreshRemoteActorAges, 15 * 60 * 1000).unref();

const ATTRIB_SKIP = /^\/(assets|js|favicon|static|phoenix|live)\b/;
app.use((req, res, next) => {
  if (ATTRIB_SKIP.test(req.path)) return next();
  const started = Date.now();
  res.on("finish", () => {
    let account = "anon";
    let how = "none";
    try {
      const u = authUser(req);
      if (u) {
        account = u.id;
        how = /anima_token=/.test(req.headers["cookie"] || "") ? "session" : "api_key";
      }
    } catch (_e) {
      account = "unresolved";
    }
    // Conduct watch, 2026-09-05: `ip=` has to be evidence, not testimony.
    // This line used to prefer the first x-forwarded-for value over the socket
    // peer, so any caller that could reach :4002 could author an arbitrary ip=
    // into the request record. nginx in front of this app (sites-enabled/anima)
    // now appends $proxy_add_x_forwarded_for, so the LAST element of xff is the
    // peer nginx actually saw; everything to its left is caller-supplied and
    // still forgeable. express `trust proxy` is deliberately left off, so
    // req.ip IS this process's socket peer. Same field shape as the simulator's
    // [req] line (request_log.ex) so one grep reads both hosts.
    const peer = req.ip || (req.socket && req.socket.remoteAddress) || "-";
    const xffRaw = String(req.headers["x-forwarded-for"] || "").replace(/\s+/g, "");
    // Caller-controlled values are sanitised before they enter the line: a
    // space (or an `=`-bearing token) in a path or a forwarded header would
    // otherwise inject a whole extra `account=` field and forge a log entry
    // for a request nobody made. Same reason as the simulator's safe/1.
    const safe = (v) => (String(v == null ? "" : v).replace(/[^A-Za-z0-9._:\/\[\]@%,+-]/g, "?").slice(0, 300) || "-");
    // originalUrl, NOT req.path: express STRIPS the mount prefix from req.url
    // while a mounted handler runs (`app.use("/media", express.static(...))`),
    // and only restores it if that handler calls next(). A media handler ends
    // the response instead, so by the time this 'finish' callback runs req.path
    // has lost its leading /media and every subject resolved to "-". Verified
    // live: probes logged subject=- before this line was changed.
    // ── Media served by nginx from disk, witnessed via the auth subrequest ──
    // Conduct watch, 2026-09-09: nginx serves /media/actors|users|worlds straight
    // from DISK (the ANIMA-INVARIANT auth_request stanzas in sites-enabled/anima),
    // so a browser media fetch never runs a route in this process and the line
    // above resolved subject=- for the ORDINARY path by which a real person's
    // reference photographs, body models and voice are handed over. An auditor
    // grepping `minor=yes` across both application journals therefore got an
    // answer that looked complete and was not -- a false clean, the exact failure
    // mode this bench exists to catch.
    //
    // But those stanzas carry `auth_request /api/auth/check`, and THAT subrequest
    // does reach this process, carrying the browser's real path in X-Original-URI.
    // The fetch is witnessable here after all, so attribute it from that URI
    // instead of from /api/auth/check. No nginx stanza is touched and nothing is
    // loosened: this only reads a header nginx already sends.
    //
    // NOTE ON res.statusCode for these lines: on the auth-check path it is the
    // ACCESS-CONTROL outcome (200 = nginx was cleared to serve the bytes, 401 =
    // refused), not the byte-transfer status. For an audit that is the more
    // useful of the two, but it is a different question from the one the same
    // field answers on a direct /media hit -- read it with via= alongside.
    //
    // Trusted ONLY on the auth-check path and ONLY from loopback: /api/auth/check
    // is `internal;` in nginx, so it is unreachable from outside, and nginx
    // proxies it from localhost. Anywhere else X-Original-URI is an unverified
    // caller string and is ignored, so it cannot forge a [minor-media] record for
    // a request nobody made. Same claim-vs-corroborated split as xff=/probe=/ua=.
    const fromLoopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    const origUri = (req.path === "/api/auth/check" && fromLoopback)
      ? String(req.headers["x-original-uri"] || "").split("?")[0]
      : "";
    // What the browser actually asked for when we know it, else our own URL.
    const attribPath = origUri || req.originalUrl.split("?")[0];
    const subj = mediaSubject(attribPath);
    // WHO ASKED, as far as the caller is willing to say. Conduct watch,
    // 2026-09-09: the auditor that probes this host over the public tunnel was
    // the loudest caller in its own journal and had no way to subtract itself,
    // because this line carried no marker for it. The simulator grew probe=/ua=
    // on the same day (request_log.ex probe/1, user_agent/1) and this is its
    // mirror, same names, same 40/120 char caps, so one grep still reads both
    // hosts. BOTH are CLAIMS, in the same class as xff= and never in the class
    // of account=/subject=, which are corroborated against a row: a caller can
    // set either header to anything. That is sound for the job it does --
    // self-exclusion only ever needs a cooperative marker -- but it means an
    // audit excludes on probe=, which only removes traffic that identified
    // itself, and reads ua= as corroboration alongside ip=/auth=. Never audit
    // by dropping ua=curl/* wholesale: that also hides the scripted caller an
    // audit exists to find.
    const tag = (v, n) => safe(String(v == null ? "" : v).slice(0, n));
    const probe = tag(req.headers["x-anima-audit-probe"], 40);
    const ua = tag(req.headers["user-agent"], 120);
    console.log(
      `[req] ${req.method} ${safe(req.originalUrl.split("?")[0])} ${res.statusCode} ` +
      `${Date.now() - started}ms account=${safe(account)} auth=${safe(how)} ` +
      `ip=${safe(peer)} xff=${safe(xffRaw)} ` +
      `subject=${safe(subj.subject)} minor=${safe(subj.minor)} subject_age=${safe(subj.age)} ` +
      `age_src=${safe(subj.src)} ` +
      `probe=${probe} ua=${ua} for=${safe(origUri || "-")}`
    );
    // The one line a child-safety audit can grep for WITHOUT knowing the media
    // URL layout, and which carries the OUTCOME. Same token and field shape as
    // the simulator's [minor-media] line, so one grep reads both hosts. It is an
    // audit record, not an alarm.
    if (subj.minor === "yes") {
      console.log(
        `[minor-media] ${req.method} ${safe(attribPath)} ${res.statusCode} ` +
        `${Date.now() - started}ms subject=${safe(subj.subject)} subject_age=${safe(subj.age)} ` +
        `age_src=${safe(subj.src)} ` +
        `auth=${safe(how)} ip=${safe(peer)} xff=${safe(xffRaw)} ` +
        `probe=${probe} ua=${ua} via=${origUri ? "auth_request" : "direct"}`
      );
    }
  });
  next();
});

// ── Signup: admin invite → self-enrolment ────────────────────────────────────
//
// Accounts are created by someone who already has one, never by the public. The
// created row is inert on its own: it has no secret, it is `status = 'invited'`
// so the login picker does not list it, and the only thing that can bring it to
// life is a single-use invite token handed to the new person out of band.
//
// The token is also what closes an account-takeover hole that predates it.
// Enrolment used to take a bare `user_id` and nothing else, while
// /api/orgs/:org/members published every id unauthenticated — and this host is
// on the public internet over ngrok. Anyone could open /enroll?user_id=<id> for
// any not-yet-enrolled account, scan the QR into their own authenticator, and
// own that account. So enrolment now demands one of exactly two proofs:
// a live invite token, or an existing session (re-enrolling your own phone).
// Neither is something a stranger can produce.
db.prepare(`CREATE TABLE IF NOT EXISTS user_invites (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  accepted_at TEXT,
  inserted_at TEXT NOT NULL
)`).run();

// ── Memberships — a person belongs to many orgs, and one of them is their own ──
//
// Session 157 (watcher 'Feature - User Signup and Creation'). Until now a user
// stood inside exactly one org, and a personal org's single occupant was born a
// 'member' — an org nobody could ever administer. Two intentional rules
// ("always born a member", "no org without an admin") only reconcile once the
// personal org is the person's OWN: everyone owns one and is its admin, and
// organization membership is the additive kind, born 'member'.
//
// users.org_id / org_role stay, redefined as the ACTIVE org — the one this
// session acts in — mirrored from memberships. Every route that reads a scalar
// org keeps working; role changes write memberships first and mirror back.
db.prepare(`CREATE TABLE IF NOT EXISTS memberships (
  user_id     TEXT NOT NULL REFERENCES users(id),
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  role        TEXT NOT NULL DEFAULT 'member',
  inserted_at TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, org_id)
)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS memberships_org_idx ON memberships (org_id)`).run();
try { db.prepare(`ALTER TABLE users ADD COLUMN personal_org_id TEXT REFERENCES orgs(id)`).run(); } catch { /* exists */ }

function addMembership(userId, orgId, role) {
  db.prepare(`INSERT OR IGNORE INTO memberships (user_id, org_id, role, inserted_at, updated_at)
              VALUES (?, ?, ?, datetime('now'), datetime('now'))`).run(userId, orgId, role);
}
function membershipOf(userId, orgId) {
  return db.prepare(`SELECT role FROM memberships WHERE user_id = ? AND org_id = ?`).get(userId, orgId) || null;
}
function membershipsOf(userId) {
  return db.prepare(`SELECT m.org_id, m.role, o.name, o.kind FROM memberships m JOIN orgs o ON o.id = m.org_id
                     WHERE m.user_id = ? AND o.status = 'active' ORDER BY o.kind DESC, o.name`).all(userId);
}
// Mirror the active org onto the users row, so authUser and every scalar
// reader stay honest. False when the user does not belong there.
function activateOrg(userId, orgId) {
  const m = membershipOf(userId, orgId);
  if (!m) return false;
  db.prepare(`UPDATE users SET org_id = ?, org_role = ?, updated_at = datetime('now') WHERE id = ?`).run(orgId, m.role, userId);
  return true;
}
function setMembershipRole(userId, orgId, role) {
  db.prepare(`UPDATE memberships SET role = ?, updated_at = datetime('now') WHERE user_id = ? AND org_id = ?`).run(role, userId, orgId);
  db.prepare(`UPDATE users SET org_role = ?, updated_at = datetime('now') WHERE id = ? AND org_id = ?`).run(role, userId, orgId);
}
// user_type follows membership: 'staff' means "belongs to at least one organization".
function syncUserType(userId) {
  const n = db.prepare(`SELECT COUNT(*) n FROM memberships m JOIN orgs o ON o.id = m.org_id
                        WHERE m.user_id = ? AND o.kind = 'organization'`).get(userId).n;
  db.prepare(`UPDATE users SET user_type = ?, updated_at = datetime('now') WHERE id = ?`).run(n > 0 ? "staff" : "personal", userId);
}
function mintPersonalOrg(name, createdByOrgId) {
  const orgId = `p-${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO orgs (id, name, kind, status, created_by_org_id, inserted_at, updated_at)
              VALUES (?, ?, 'personal', 'active', ?, datetime('now'), datetime('now'))`).run(orgId, name, createdByOrgId || null);
  return orgId;
}

// Boot migration, idempotent: every existing account gets its personal org and
// an admin membership there; its current org_id/org_role becomes a membership.
// An account that already lived in a personal org simply owns that one.
db.transaction(() => {
  for (const u of db.prepare(`SELECT u.*, o.kind AS org_kind FROM users u LEFT JOIN orgs o ON o.id = u.org_id`).all()) {
    if (!u.personal_org_id) {
      if (u.org_kind === "personal") {
        addMembership(u.id, u.org_id, "admin");
        db.prepare(`UPDATE memberships SET role = 'admin' WHERE user_id = ? AND org_id = ?`).run(u.id, u.org_id);
        db.prepare(`UPDATE users SET personal_org_id = ?, org_role = 'admin' WHERE id = ?`).run(u.org_id, u.id);
      } else {
        const pid = mintPersonalOrg(u.name, u.org_id);
        addMembership(u.id, pid, "admin");
        db.prepare(`UPDATE users SET personal_org_id = ? WHERE id = ?`).run(pid, u.id);
      }
    }
    if (u.org_id && u.org_kind === "organization") addMembership(u.id, u.org_id, u.org_role === "admin" ? "admin" : "member");
  }
})();

const INVITE_TTL_DAYS = 7;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// One live invite per user: minting a new one retires any unaccepted predecessor,
// so a link that was mailed to the wrong address stops working the moment it is
// re-issued.
function mintInvite(userId, createdBy) {
  const raw     = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86400 * 1000).toISOString();
  db.prepare(`DELETE FROM user_invites WHERE user_id = ? AND accepted_at IS NULL`).run(userId);
  db.prepare(`INSERT INTO user_invites (token_hash, user_id, created_by, expires_at, inserted_at)
              VALUES (?, ?, ?, ?, datetime('now'))`).run(sha256(raw), userId, createdBy, expires);
  return { token: raw, expires_at: expires };
}

// Returns the users row an invite token unlocks, or null. Shape-checks the token
// before it ever reaches the database.
function userForInvite(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ""))) return null;
  const row = db.prepare(`SELECT * FROM user_invites WHERE token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (row.accepted_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.user_id);
  return user || null;
}

// Initials, the way every hand-made id on this system was already built
// (Magnus Klack → mk). Numeric suffix only when that is taken.
function allocateUserId(name) {
  const base = (name.match(/\p{L}+/gu) || [])
    .map(w => w[0].toLowerCase()).join("").slice(0, 2) || "u";
  const taken = (id) => !!db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(id);
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n++) if (!taken(base + n)) return base + n;
  return "u" + randomUUID().slice(0, 8);
}

// Which accounts may this caller administer? Their own org's members, plus the
// members of any personal org their org provisioned — a private account created
// from the People page would otherwise be unreachable the moment it existed,
// with no way to re-issue an expired invite.
function administrableOrgIds(caller) {
  const own = caller.org_id;
  if (!own) return [];
  // Personal orgs this org provisioned — but only while their owner holds no
  // organization membership. A colleague's own personal org is theirs alone;
  // it is the truly private account that would otherwise be unreachable.
  const provisioned = db.prepare(
    `SELECT o.id FROM orgs o
      WHERE o.created_by_org_id = ? AND o.kind = 'personal'
        AND NOT EXISTS (SELECT 1 FROM memberships m JOIN orgs o2 ON o2.id = m.org_id
                         WHERE o2.kind = 'organization'
                           AND m.user_id IN (SELECT user_id FROM memberships WHERE org_id = o.id))`
  ).all(own).map(o => o.id);
  return [own, ...provisioned];
}

// Administering accounts takes three things, and all of them are load-bearing:
//
//   org.kind === "organization"   a private user's org holds only them
//   user_type === "staff"         the tier
//   org_role  === "admin"         the role — new, and the one that actually bites
//
// The role is what was missing. Until now "staff of an organization" was the
// whole gate, which made every Anima employee an implicit administrator of the
// company: anyone could invite, and shortly, erase.
function requireOrgAdmin(req, res) {
  const caller = authUser(req);
  if (!caller) { res.status(401).json({ error: "not authenticated" }); return null; }
  const org = db.prepare(`SELECT id, kind FROM orgs WHERE id = ?`).get(caller.org_id);
  if (!org || org.kind !== "organization") {
    res.status(403).json({ error: "only staff of an organization can manage accounts" });
    return null;
  }
  // memberships is the authority; users.org_role is its mirror.
  if (membershipOf(caller.id, caller.org_id)?.role !== "admin") {
    res.status(403).json({ error: "only an administrator of this organization can manage accounts" });
    return null;
  }
  return { caller, org };
}

// What a person still holds that outlives their access. Used to decide whether
// an account can be erased outright or only shut down, and to tell the admin
// what they are about to leave behind either way.
function belongingsOf(userId) {
  const actors = db.prepare(`SELECT COUNT(*) n FROM actors WHERE owner_id = ?`).get(userId).n;
  const worlds = db.prepare(`SELECT world_id, role FROM world_memberships WHERE user_id = ?`).all(userId);
  const keys   = db.prepare(`SELECT COUNT(*) n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL`).get(userId).n;
  return { actors, worlds, api_keys: keys };
}

// ── POST /api/admin/users — create an account and mint its invite ────────────
//
// `tier` decides what kind of account this is:
//   "staff"    — a colleague, joining the caller's own organization
//   "personal" — a private person, who gets an org of their own containing only
//                them. Provisioned by invite for now; when public registration
//                opens, it calls exactly this path with no admin attached.
app.post("/api/admin/users", (req, res) => {
  const ctx = requireOrgAdmin(req, res);
  if (!ctx) return;
  const { caller } = ctx;

  const name  = String(req.body?.name  || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const tier  = String(req.body?.tier || "staff").trim();
  // The vocabulary here is the simulator's, not this form's. A gender written
  // at creation rides the world-creation `members` payload and the add-member
  // body, and is pushed later by syncGenderToWorlds() — all three normalise
  // against male / female / non-binary / null. A value born outside that set is
  // a row that can never sync, so it is refused at the boundary rather than
  // left to a <select> to prevent. Empty is a real answer: "no gender recorded".
  const genderRaw = req.body?.gender;
  const gender = (genderRaw === null || genderRaw === undefined || String(genderRaw).trim() === "")
    ? null : String(genderRaw).trim().toLowerCase();

  if (!name)  return res.status(400).json({ error: "name required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "valid email required" });
  if (!["staff", "personal"].includes(tier)) return res.status(400).json({ error: "tier must be staff or personal" });
  if (![null, "male", "female", "non-binary"].includes(gender))
    return res.status(422).json({ error: "gender must be male, female, non-binary, or empty" });
  // Email is unique platform-wide, not per-org: it is the handle a private user
  // signs in with, so it has to resolve to one account without an org to scope it.
  const existing = db.prepare(`SELECT * FROM users WHERE lower(email) = ?`).get(email);
  if (existing) {
    // One person, several organizations. An address that already has an
    // account is not refused — it is added to THIS org as a member: no new
    // row, no new second factor, no invite. Nothing about the account changes
    // except that it now also belongs here.
    if (tier !== "staff") return res.status(409).json({ error: "a user with that email already exists" });
    if (existing.status === "removed") return res.status(409).json({ error: "that account was removed — it cannot be re-added" });
    if (membershipOf(existing.id, caller.org_id))
      return res.status(409).json({ error: `${existing.name} is already a member of this organization` });
    addMembership(existing.id, caller.org_id, "member");
    syncUserType(existing.id);
    return res.json({
      user: { id: existing.id, name: existing.name, email: existing.email, status: existing.status,
              user_type: "staff", gender: existing.gender, org_id: caller.org_id, tier },
      added_to_org: true, invite_path: null, expires_at: null,
    });
  }

  const id = allocateUserId(name);

  // A deleted user can leave its TOTP secret behind (there is one such orphan in
  // this database), and ids are short enough to be handed out again. Reusing an
  // id must never mean inheriting a stranger's second factor.
  db.prepare(`DELETE FROM user_totp_secrets WHERE user_id = ?`).run(id);
  db.prepare(`DELETE FROM user_invites      WHERE user_id = ?`).run(id);

  // Everyone owns a personal org and administers it — an org of one has nobody
  // else to invite or erase, so the role is harmless there and load-bearing
  // nowhere else. Organization membership is the additive kind, born 'member':
  // promotion is a separate, deliberate act — an account is never born able to
  // invite and erase colleagues.
  const personalOrgId = mintPersonalOrg(name, caller.org_id);
  const orgId  = tier === "personal" ? personalOrgId : caller.org_id;
  const role   = tier === "personal" ? "admin" : "member";
  db.transaction(() => {
    db.prepare(`INSERT INTO users (id, name, email, status, user_type, gender, org_id, org_role, personal_org_id, inserted_at, updated_at)
                VALUES (?, ?, ?, 'invited', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .run(id, name, email, tier === "personal" ? "personal" : "staff", gender, orgId, role, personalOrgId);
    addMembership(id, personalOrgId, "admin");
    if (tier === "staff") addMembership(id, caller.org_id, "member");
  })();

  const invite = mintInvite(id, caller.id);
  res.json({
    user: { id, name, email, status: "invited", user_type: tier === "personal" ? "personal" : "staff",
            gender, org_id: orgId, personal_org_id: personalOrgId, tier },
    // A path, not a URL: express sits behind nginx and an ngrok tunnel with no
    // `trust proxy`, so req.protocol here says "http" for a link that is only
    // ever handed out as https. The caller knows its own origin; let it say.
    invite_path: `/invite/${invite.token}`,
    expires_at: invite.expires_at,
  });
});

// ── GET /api/admin/users — every account and where it is in the flow ─────────
app.get("/api/admin/users", (req, res) => {
  const ctx = requireOrgAdmin(req, res);
  if (!ctx) return;
  const orgIds = administrableOrgIds(ctx.caller);
  const holes  = orgIds.map(() => "?").join(",");

  // One row per membership in an administrable org: the same person in two of
  // the caller's orgs is two rows, each with the role they hold THERE.
  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.status, u.user_type, m.role AS org_role, u.gender, u.photo_url, u.inserted_at,
           m.org_id, o.name AS org_name, o.kind AS org_kind, u.personal_org_id,
           CASE WHEN t.enrolled_at IS NOT NULL THEN 1 ELSE 0 END AS enrolled,
           i.expires_at AS invite_expires_at,
           (SELECT COUNT(*) FROM actors a WHERE a.owner_id = u.id) AS owned_actors,
           (SELECT COUNT(*) FROM world_memberships w WHERE w.user_id = u.id) AS world_count,
           (SELECT COUNT(*) FROM memberships m2 JOIN orgs o2 ON o2.id = m2.org_id
             WHERE m2.user_id = u.id AND o2.kind = 'organization') AS org_count
    FROM memberships m
    JOIN users u                  ON u.id = m.user_id
    JOIN orgs o                   ON o.id = m.org_id
    LEFT JOIN user_totp_secrets t ON t.user_id = u.id
    LEFT JOIN user_invites i      ON i.user_id = u.id AND i.accepted_at IS NULL
    WHERE m.org_id IN (${holes})
    ORDER BY o.kind, u.inserted_at DESC, u.name
  `).all(...orgIds).map(u => ({
    ...u,
    enrolled: !!u.enrolled,
    invite_state: u.enrolled ? "enrolled"
      : !u.invite_expires_at ? "none"
      : new Date(u.invite_expires_at) < new Date() ? "expired" : "pending",
  }));
  res.json(users);
});

// ── POST /api/admin/users/:id/invite — re-issue a link ───────────────────────
app.post("/api/admin/users/:id/invite", (req, res) => {
  const ctx = requireOrgAdmin(req, res);
  if (!ctx) return;
  const orgIds = administrableOrgIds(ctx.caller);
  const holes  = orgIds.map(() => "?").join(",");

  // 404 rather than 403 for an account outside the caller's reach: a wrong
  // status code here would confirm that some other tenant's user id exists.
  const user = db.prepare(`SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
                           WHERE u.id = ? AND m.org_id IN (${holes})`)
    .get(req.params.id, ...orgIds);
  if (!user) return res.status(404).json({ error: "user not found" });

  const invite = mintInvite(user.id, ctx.caller.id);
  res.json({
    // A path, not a URL: express sits behind nginx and an ngrok tunnel with no
    // `trust proxy`, so req.protocol here says "http" for a link that is only
    // ever handed out as https. The caller knows its own origin; let it say.
    invite_path: `/invite/${invite.token}`,
    expires_at: invite.expires_at,
  });
});

// ── PATCH /api/admin/users/:id/role — promote or demote ──────────────────────
//
// Without this the role would be a one-way door: the bootstrap makes exactly one
// admin, and there would be no way to ever make a second except by hand-editing
// SQLite. An organization with one administrator who loses their phone is an
// organization nobody can administer.
app.patch("/api/admin/users/:id/role", (req, res) => {
  const ctx = requireOrgAdmin(req, res);
  if (!ctx) return;
  const role = String(req.body?.org_role || "").trim();
  if (!["admin", "member"].includes(role)) return res.status(400).json({ error: "org_role must be admin or member" });

  // Only within your OWN organization. A personal org provisioned by this one is
  // administrable for invites, but its member is not a colleague to promote.
  const target = db.prepare(`SELECT u.id, u.name, m.role AS org_role FROM users u
                             JOIN memberships m ON m.user_id = u.id AND m.org_id = ? WHERE u.id = ?`)
    .get(ctx.caller.org_id, req.params.id);
  if (!target) return res.status(404).json({ error: "user not found" });

  if (target.id === ctx.caller.id && role === "member") {
    return res.status(409).json({ error: "You cannot demote yourself — ask another administrator." });
  }
  if (target.org_role === "admin" && role === "member" && lastAdminOf(ctx.caller.org_id, target.id)) {
    return res.status(409).json({ error: "This is the organization's only administrator." });
  }

  setMembershipRole(target.id, ctx.caller.org_id, role);
  res.json({ ok: true, id: target.id, org_role: role });
});

// True when removing/demoting this user would leave the org with no admin.
function lastAdminOf(orgId, excludingUserId) {
  const others = db.prepare(
    `SELECT COUNT(*) n FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? AND m.role = 'admin' AND u.status = 'active' AND u.id != ?`
  ).get(orgId, excludingUserId).n;
  return others === 0;
}

// ── DELETE /api/admin/users/:id — erase a member ─────────────────────────────
//
// Two strengths, because "erase" means two different things depending on what
// the person left behind.
//
// Default: their ACCESS ends, completely and immediately — every session
// revoked, the authenticator secret destroyed, invites and handoff tickets
// dropped, API keys revoked, world memberships removed (and their player actor
// erased in the simulator), status set to 'removed' so they vanish from the
// sign-in list and every picker. The row stays, so the characters they authored
// keep an owner and nothing they made becomes unattributable.
//
// ?purge=1: the row goes too. Allowed only when they own no characters —
// otherwise the FK on actors.owner_id would either refuse or, with foreign_keys
// off (which is the sqlite3 CLI default, and how the orphaned `as` TOTP secret
// in this database came to exist), quietly orphan them.
app.delete("/api/admin/users/:id", async (req, res) => {
  const ctx = requireOrgAdmin(req, res);
  if (!ctx) return;
  const orgIds = administrableOrgIds(ctx.caller);
  const holes  = orgIds.map(() => "?").join(",");

  const target = db.prepare(
    `SELECT DISTINCT u.id, u.name, u.email, u.org_id, u.org_role, u.personal_org_id FROM users u
      JOIN memberships m ON m.user_id = u.id WHERE u.id = ? AND m.org_id IN (${holes})`
  ).get(req.params.id, ...orgIds);
  if (!target) return res.status(404).json({ error: "user not found" });

  if (target.id === ctx.caller.id) {
    return res.status(409).json({ error: "You cannot remove your own account." });
  }
  // Erasing ends EVERY membership, so the guard runs over every organization
  // they administer, not just the one the caller is looking from.
  const stranded = db.prepare(
    `SELECT o.id, o.name FROM memberships m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.role = 'admin' AND o.kind = 'organization'`
  ).all(target.id).filter(o => lastAdminOf(o.id, target.id));
  if (stranded.length) {
    return res.status(409).json({ error: `${target.name} is the only administrator of ${stranded.map(o => o.name).join(", ")}. Promote someone else first.` });
  }

  const purge = req.query.purge === "1" || req.query.purge === "true";
  const held  = belongingsOf(target.id);
  if (purge && held.actors > 0) {
    return res.status(409).json({
      error: `${target.name} still owns ${held.actors} character${held.actors === 1 ? "" : "s"}. Reassign or delete them first, or remove the account without purging.`,
      belongings: held,
    });
  }

  // World memberships first, because this is the only step that has to reach
  // another service, and it is the one that can partially fail. Same contract as
  // DELETE /api/worlds/:id/members/:user_id: the local row goes regardless — a
  // person who has lost access must lose it even if the simulator is down — but
  // the failure is reported, never assumed away.
  const warnings = [];
  for (const m of held.worlds) {
    try {
      const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${m.world_id}/members/${target.id}`, {
        method: "DELETE", headers: { "X-Service-Token": SERVICE_TOKEN },
      });
      if (!r.ok) warnings.push(`World ${m.world_id}: simulator could not erase their player actor (HTTP ${r.status}).`);
    } catch (e) {
      warnings.push(`World ${m.world_id}: simulator unreachable (${e.message}) — their player actor may remain.`);
    }
    db.prepare(`DELETE FROM world_memberships WHERE user_id = ? AND world_id = ?`).run(target.id, m.world_id);
  }

  // Everything that could let them back in.
  db.prepare(`UPDATE auth_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`).run(target.id);
  db.prepare(`UPDATE api_keys    SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`).run(target.id);
  db.prepare(`DELETE FROM user_totp_secrets     WHERE user_id = ?`).run(target.id);
  db.prepare(`DELETE FROM user_invites          WHERE user_id = ?`).run(target.id);
  db.prepare(`DELETE FROM auth_handoff_tickets  WHERE user_id = ?`).run(target.id);
  db.prepare(`UPDATE users SET status = 'removed', updated_at = datetime('now') WHERE id = ?`).run(target.id);

  if (!purge) {
    return res.json({ ok: true, removed: target.id, purged: false, kept: held, warnings });
  }

  // Purge: nothing of theirs is left to orphan, so take the row and the shell of
  // a personal org that existed only to hold them.
  db.prepare(`DELETE FROM auth_tokens   WHERE user_id = ?`).run(target.id);
  db.prepare(`DELETE FROM api_keys      WHERE user_id = ?`).run(target.id);
  db.prepare(`DELETE FROM notifications WHERE user_id = ?`).run(target.id);
  db.prepare(`DELETE FROM actor_shares  WHERE shared_with_id = ? OR owner_id = ?`).run(target.id, target.id);
  db.prepare(`DELETE FROM registered_tools WHERE user_id = ?`).run(target.id);
  db.prepare(`DELETE FROM memberships WHERE user_id = ?`).run(target.id);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(target.id);

  // The personal org existed only to hold them; take the shell once it is empty.
  for (const orgId of new Set([target.personal_org_id, target.org_id].filter(Boolean))) {
    const org = db.prepare(`SELECT id, kind FROM orgs WHERE id = ?`).get(orgId);
    if (org?.kind !== "personal") continue;
    const left = db.prepare(`SELECT (SELECT COUNT(*) FROM memberships WHERE org_id = ?)
                                  + (SELECT COUNT(*) FROM users WHERE org_id = ? OR personal_org_id = ?) n`)
      .get(org.id, org.id, org.id).n;
    if (left === 0) db.prepare(`DELETE FROM orgs WHERE id = ?`).run(org.id);
  }

  res.json({ ok: true, removed: target.id, purged: true, kept: { actors: 0, worlds: [], api_keys: 0 }, warnings });
});

// ── DELETE /api/admin/users/:id/membership — take someone out of THIS org ────
//
// The third erase strength, and the mildest: the person keeps their account,
// their personal org and every other membership. Only the tie to the caller's
// organization is cut. If that was the org they were acting in, they fall back
// to their own.
app.delete("/api/admin/users/:id/membership", (req, res) => {
  const ctx = requireOrgAdmin(req, res);
  if (!ctx) return;
  const orgId  = ctx.caller.org_id;
  const target = db.prepare(`SELECT u.id, u.name, u.org_id, u.personal_org_id, m.role FROM users u
                             JOIN memberships m ON m.user_id = u.id AND m.org_id = ? WHERE u.id = ?`)
    .get(orgId, req.params.id);
  if (!target) return res.status(404).json({ error: "user not found" });
  if (target.id === ctx.caller.id) {
    return res.status(409).json({ error: "You cannot remove yourself from your own organization." });
  }
  if (target.role === "admin" && lastAdminOf(orgId, target.id)) {
    return res.status(409).json({ error: "This is the organization's only administrator. Promote someone else first." });
  }
  db.prepare(`DELETE FROM memberships WHERE user_id = ? AND org_id = ?`).run(target.id, orgId);
  if (target.org_id === orgId && target.personal_org_id) activateOrg(target.id, target.personal_org_id);
  syncUserType(target.id);
  res.json({ ok: true, id: target.id, left: orgId });
});

// ── GET /api/invite/:token — what the invitee sees before enrolling ──────────
app.get("/api/invite/:token", (req, res) => {
  const user = userForInvite(req.params.token);
  if (!user) return res.status(401).json({ error: "this invite is not valid — ask for a new link" });
  res.json({ name: user.name, email: user.email });
});

// ── POST /api/invite/:token/profile — the invitee's own details ──────────────
// The admin typed a name into a box; the person it belongs to gets the last word
// on it. Email is not editable here: it is half of what the admin vouched for.
app.post("/api/invite/:token/profile", (req, res) => {
  const user = userForInvite(req.params.token);
  if (!user) return res.status(401).json({ error: "this invite is not valid — ask for a new link" });
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  db.prepare(`UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?`).run(name, user.id);
  res.json({ ok: true, name });
});

// Enrolment identifies its subject by invite token, or by an existing session
// for someone re-enrolling themselves. `user_id` from the request body is not
// among the accepted proofs — that was the hole.
function enrollSubject(req) {
  if (req.body?.token) return userForInvite(req.body.token);
  const session = authUser(req);
  if (!session) return null;
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(session.id) || null;
}

app.post("/api/enroll/start", (req, res) => {
  const user = enrollSubject(req);
  if (!user) return res.status(401).json({ error: "a valid invite link or an active session is required" });
  let row = db.prepare("SELECT * FROM user_totp_secrets WHERE user_id = ?").get(user.id);
  if (!row || row.enrolled_at) {
    const totp = new OTPAuth.TOTP({ issuer: "Anima", label: user.email, algorithm: "SHA1", digits: 6, period: 30 });
    const secret = totp.secret.base32;
    db.prepare(`INSERT OR REPLACE INTO user_totp_secrets (id, user_id, secret, enrolled_at, inserted_at, updated_at) VALUES (?, ?, ?, NULL, datetime('now'), datetime('now'))`).run(randomUUID(), user.id, secret);
    row = db.prepare("SELECT * FROM user_totp_secrets WHERE user_id = ?").get(user.id);
  }
  const totp = new OTPAuth.TOTP({ issuer: "Anima", label: user.email, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(row.secret) });
  QRCode.toDataURL(totp.toString(), { width: 280, margin: 2 }, (err, url) => {
    if (err) return res.status(500).json({ error: "qr generation failed" });
    res.json({ qr: url, email: user.email, name: user.name });
  });
});

app.post("/api/enroll/confirm", (req, res) => {
  const user = enrollSubject(req);
  if (!user) return res.status(401).json({ error: "a valid invite link or an active session is required" });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });
  const row = db.prepare("SELECT * FROM user_totp_secrets WHERE user_id = ?").get(user.id);
  if (!row) return res.status(404).json({ error: "no secret found" });
  const totp = new OTPAuth.TOTP({ issuer: "Anima", algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(row.secret) });
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return res.status(401).json({ error: "invalid code" });
  db.prepare(`UPDATE user_totp_secrets SET enrolled_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?`).run(user.id);

  // The account becomes real here, not at creation: this is the first moment
  // anyone has proved they hold the second factor. Burning the invite is part of
  // the same step, so a forwarded link cannot enrol a second authenticator.
  db.prepare(`UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(user.id);
  if (req.body?.token && /^[a-f0-9]{64}$/.test(req.body.token)) {
    db.prepare(`UPDATE user_invites SET accepted_at = datetime('now')
                WHERE token_hash = ? AND accepted_at IS NULL`).run(sha256(req.body.token));
  }
  db.prepare(`DELETE FROM user_invites WHERE expires_at < datetime('now', '-30 days')`).run();
  res.json({ ok: true });
});

// ── Live session cap ─────────────────────────────────────────────────────────
//
// Every sign-in minted a 30-day token and nothing ever pruned them. Sign-out
// revokes only the cookie in the hand doing the signing out, so every other
// browser, phone and desktop handoff ever used stayed valid for a month —
// one account had 31 live tokens at once. A cookie lifted off a laptop last
// touched three weeks ago was still a working session.
//
// A sign-in now retires that account's oldest sessions past the cap instead
// of stacking on top of them. Rows are revoked, never deleted, so the trail
// survives exactly as sign-out leaves it, and the newest are the ones kept —
// the session just minted plus the devices actually in use. The cap sits
// under the 10 the sign-in board tolerates, leaving headroom for the
// short-lived rows the lab harnesses insert straight into the table.
//
// Deliberately not a timer: auth_tokens is still unreaped on a schedule (see
// the handoff sweep below, which says why). This runs only when a session is
// minted, and only ever touches that one user's oldest rows.
const MAX_LIVE_SESSIONS = 8;

function capLiveSessions(userId) {
  try {
    const r = db.prepare(`
      UPDATE auth_tokens SET revoked_at = datetime('now')
       WHERE user_id = ?
         AND revoked_at IS NULL
         AND julianday(expires_at) > julianday('now')
         AND id NOT IN (
           SELECT id FROM auth_tokens
            WHERE user_id = ?
              AND revoked_at IS NULL
              AND julianday(expires_at) > julianday('now')
            ORDER BY inserted_at DESC, rowid DESC
            LIMIT ?)`).run(userId, userId, MAX_LIVE_SESSIONS);
    if (r.changes) console.log(`[session cap] ${userId}: retired ${r.changes} session(s) past ${MAX_LIVE_SESSIONS}`);
  } catch (e) { console.error("[session cap]", e.message); }
}

// The hoard predates the cap, so apply it once at boot too — otherwise an
// account that already stacked up 31 stays that way until its next sign-in,
// which is the whole window the cap exists to close.
try {
  for (const u of db.prepare(`SELECT DISTINCT user_id FROM auth_tokens
                               WHERE revoked_at IS NULL
                                 AND julianday(expires_at) > julianday('now')`).all())
    capLiveSessions(u.user_id);
} catch (e) { console.error("[session cap] boot", e.message); }

// Two ways in, because there are two kinds of tenant:
//
//   { user_id, code }  an organization's member, picked off that org's list
//   { email, code }    a private person, who is not on any list to be picked
//
// BOTH paths answer 401 identically for a subject that has no account, an
// account that never enrolled, and a wrong code. A private account's existence
// is exactly what must not be discoverable here, and the user_id path is no
// safer than the email one: it accepts any id, not only ids drawn off a public
// member list, and ids are initials — short enough to enumerate.
app.post("/api/auth/verify", (req, res) => {
  const { user_id, code } = req.body;
  const email = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
  if (!code || (!user_id && !email)) return res.status(400).json({ error: "user_id or email, and code, required" });

  let userId = user_id;
  if (!userId) {
    const byEmail = db.prepare(`SELECT id FROM users WHERE lower(email) = ? AND status = 'active'`).get(email);
    if (!byEmail) return res.status(401).json({ error: "invalid email or code" });
    userId = byEmail.id;
  }

  const row = db.prepare("SELECT * FROM user_totp_secrets WHERE user_id = ? AND enrolled_at IS NOT NULL").get(userId);
  if (!row) {
    // Both paths answer here exactly as they answer a wrong code. The user_id
    // path used to say 403 "not enrolled", on the premise that its subjects are
    // all on a public member list anyway - but it accepts ANY id, including a
    // private person who is on no list at all, and ids are initials (2 chars,
    // enumerable). 403-vs-401 therefore mapped the whole id space into "is an
    // enrolled account" / "is not". Nothing consumed the 403: the sign-in page
    // never reaches it, because it refuses an un-enrolled member up front from
    // the `enrolled` flag on /api/orgs/:org/members.
    if (email) return res.status(401).json({ error: "invalid email or code" });
    return res.status(401).json({ error: "invalid code" });
  }
  const totp = new OTPAuth.TOTP({ issuer: "Anima", algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(row.secret) });
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return res.status(401).json({ error: email ? "invalid email or code" : "invalid code" });
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO auth_tokens (id, user_id, token_hash, expires_at, inserted_at) VALUES (?, ?, ?, ?, datetime('now'))`).run(randomUUID(), userId, hash, expires);
  capLiveSessions(userId);
  res.setHeader("Set-Cookie", `anima_token=${raw}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=2592000`);

  // Session 153 — the handoff ticket rides back with the login itself.
  //
  // The desktop app is opened by navigating to anima://, and a browser will
  // only launch an external application while the user's click is still
  // "live" — transient activation, a few seconds, easily spent. Minting the
  // ticket in a SECOND round-trip put another request between the click and
  // the launch for no reason. The user has just proved who they are one line
  // above; there is nothing further to check, so the ticket comes back here
  // and the page fires immediately.
  const handoffRaw  = crypto.randomBytes(32).toString("hex");
  const handoffHash = crypto.createHash("sha256").update(handoffRaw).digest("hex");
  const handoffExp  = new Date(Date.now() + 60 * 1000).toISOString();
  db.prepare(`INSERT INTO auth_handoff_tickets (ticket_hash, user_id, expires_at, inserted_at)
              VALUES (?, ?, ?, datetime('now'))`).run(handoffHash, userId, handoffExp);
  // Most sign-ins are web-only and never open the desktop app, so this ticket
  // is usually born to die unredeemed. Reap it when it expires rather than
  // leaving a dead session-grant lying about until the next tick.
  scheduleHandoffReap(handoffExp);

  // Push presence online to simulator
  const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? LIMIT 1`).get(userId);
  if (membership) {
    fetch(`${SIMULATOR_URL}/internal/presence/${membership.actor_id}`, {
      method: "POST",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "online" })
    }).catch(() => {});
  }
  res.json({ ok: true, handoff: `anima://auth?ticket=${handoffRaw}` });
});

// ── Desktop handoff ──────────────────────────────────────────────────────────
//
// Session 153. Identity stays in the browser; the desktop app borrows it.
//
// The desktop shell has its own cookie jar and its own origin (it loads the
// platform over an ssh tunnel at http://localhost:8899, because the session
// cookie is `Secure` and a browser will not send one back over plain http to a
// LAN IP). Rather than give it a second login screen — a second password path,
// a second place to get 2FA wrong — the browser mints a short-lived ticket for
// a session it already holds, and the app redeems it for a session of its own.
//
// The ticket is the secret, so it is stored hashed, single-use, and dead after
// a minute. Redeem is deliberately a GET: it has to be a top-level navigation
// so the Set-Cookie lands in the app's jar, which a fetch from another origin
// could not do.
db.prepare(`CREATE TABLE IF NOT EXISTS auth_handoff_tickets (
  ticket_hash TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  inserted_at TEXT NOT NULL
)`).run();

const HANDOFF_TTL_SECONDS = 60;

app.post("/api/auth/handoff/ticket", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });

  const raw  = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000).toISOString();
  db.prepare(`INSERT INTO auth_handoff_tickets (ticket_hash, user_id, expires_at, inserted_at)
              VALUES (?, ?, ?, datetime('now'))`).run(hash, user.id, expires);

  // Housekeeping: a ticket is worthless after a minute, so do not keep them.
  scheduleHandoffReap(expires);

  res.json({ ticket: raw, expires_in: HANDOFF_TTL_SECONDS,
             url: `anima://auth?ticket=${raw}` });
});

// Session 156: expired tickets used to linger because the only sweep rode along
// with minting a new one - if nobody minted, nothing swept. Timer, tickets only:
// auth_tokens is deliberately NOT reaped here (the lab CLI holds short-lived
// shell sessions and a broad reaper would kill them mid-call).
//
// 2026-09-09: the timer swept, but only rows expired for more than an HOUR, on a
// ten-minute tick - so a dead ticket sat visible for up to ~70 minutes after it
// stopped being redeemable. That is the whole gap the sign-in board reports as
// "no handoff ticket is left lying around": /api/auth/verify mints a ticket on
// EVERY sign-in whether or not the desktop app is ever opened, so a plain web
// login leaves an unburned row behind by design. There is nothing to keep once
// expires_at passes - redeem answers 401 for an expired ticket and 401 for an
// unknown one - so the grace is gone, and each mint now schedules its own reap
// so the row goes as it dies instead of at the next tick. The interval stays as
// the backstop for rows that outlived a restart.
function sweepHandoffTickets() {
  try {
    const r = db.prepare(`DELETE FROM auth_handoff_tickets
                           WHERE julianday(expires_at) <= julianday('now')`).run();
    if (r.changes) console.log(`[handoff sweep] removed ${r.changes} expired ticket(s)`);
  } catch (e) { console.error("[handoff sweep]", e.message); }
}
// Reap one ticket the instant it expires. Unref'd: never holds the loop open.
function scheduleHandoffReap(expiresAtISO) {
  try {
    const ms = new Date(expiresAtISO).getTime() - Date.now();
    if (!Number.isFinite(ms)) return sweepHandoffTickets();
    const t = setTimeout(sweepHandoffTickets, Math.max(0, ms) + 1000);
    if (typeof t.unref === "function") t.unref();
  } catch (e) { console.error("[handoff sweep] schedule", e.message); }
}
sweepHandoffTickets();
setInterval(sweepHandoffTickets, 10 * 60 * 1000).unref();

app.get("/api/auth/handoff/redeem", (req, res) => {
  const ticket = String(req.query.ticket || "");
  // Only ever a path on this host. Without this the ticket becomes an open
  // redirect that also hands the reader a live session.
  let next = String(req.query.next || "/home");
  if (!next.startsWith("/") || next.startsWith("//")) next = "/home";

  if (!/^[a-f0-9]{64}$/.test(ticket)) return res.status(400).send("bad ticket");
  const hash = crypto.createHash("sha256").update(ticket).digest("hex");

  const row = db.prepare(`SELECT * FROM auth_handoff_tickets WHERE ticket_hash = ?`).get(hash);
  if (!row)          return res.status(401).send("unknown ticket");
  if (row.used_at)   return res.status(401).send("ticket already used");
  if (new Date(row.expires_at) < new Date()) return res.status(401).send("ticket expired");

  // Burn it before issuing anything, so a race cannot mint two sessions.
  const burned = db.prepare(`UPDATE auth_handoff_tickets SET used_at = datetime('now')
                             WHERE ticket_hash = ? AND used_at IS NULL`).run(hash);
  if (burned.changes !== 1) return res.status(401).send("ticket already used");

  // From here it is an ordinary session — the same shape /api/auth/verify issues.
  const raw  = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO auth_tokens (id, user_id, token_hash, expires_at, inserted_at)
              VALUES (?, ?, ?, ?, datetime('now'))`).run(randomUUID(), row.user_id, tokenHash, expires);
  capLiveSessions(row.user_id);

  res.setHeader("Set-Cookie", `anima_token=${raw}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=2592000`);
  res.redirect(302, next);
});

app.get("/api/auth/check", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).end();
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const row = db.prepare(`SELECT id FROM auth_tokens WHERE token_hash = ? AND revoked_at IS NULL AND julianday(expires_at) > julianday('now')`).get(hash);
  if (!row) return res.status(401).end();
  res.status(200).end();
});

// ── GET /api/orgs — the tiles on the sign-in page ────────────────────────────
//
// Companies only. A private person's org is a real org with one member, and
// listing those here would publish the existence of every consumer account on a
// public page — so personal orgs are never enumerable, and their owners sign in
// by email instead of by picking themselves off a list.
app.get("/api/orgs", (req, res) => {
  res.json(db.prepare(
    `SELECT id, name FROM orgs WHERE kind = 'organization' AND status = 'active' ORDER BY name`
  ).all());
});

// ── GET /api/orgs/:org/members — sign-in page account list ───────────────────
//
// Unauthenticated, and it stays that way: the sign-in page has to draw this
// before anyone has proved anything. What changed is that `:org` now means
// something. It was accepted and then ignored entirely — /api/orgs/zzz/members
// returned every user on the platform — which was harmless only while exactly
// one org existed. The moment a second tenant lands, an ignored scope is a
// cross-tenant leak, so the fix belongs before the tenants, not after.
//
// Personal orgs are excluded rather than merely unlisted: otherwise guessing an
// org id would confirm a private account exists and hand over its email.
app.get("/api/orgs/:org/members", (req, res) => {
  const org = db.prepare(
    `SELECT id FROM orgs WHERE id = ? AND kind = 'organization' AND status = 'active'`
  ).get(req.params.org);
  if (!org) return res.status(404).json({ error: "no such organization" });

  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.photo_url,
           CASE WHEN t.enrolled_at IS NOT NULL THEN 1 ELSE 0 END as enrolled
    FROM users u
    JOIN memberships m            ON m.user_id = u.id AND m.org_id = ?
    LEFT JOIN user_totp_secrets t ON t.user_id = u.id
    WHERE u.status = 'active'
    ORDER BY u.name
  `).all(org.id);
  res.json(users);
});

// ── GET /api/users — org members for share picker ────────────────────────────
app.get("/api/users", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  // Session 150 — never list the caller.
  //
  // Both callers of this endpoint are "pick someone else": share targets in the
  // character dialog, and invitees in the world wizard. You cannot share a
  // character with yourself — the share endpoint rejects it with 400 — and you
  // are already the creator of a world you are making, so offering your own name
  // in either list is an invitation to an error.
  //
  // Session 156 — and never anyone outside your own org. Both callers offer
  // these names as people you can hand a character or a world to; across a
  // tenant boundary that is not a share target, it is a directory of strangers.
  // A private user's org holds only them, so this correctly returns nothing.
  const users = db.prepare(
    `SELECT u.id, u.name, u.email, u.photo_url FROM users u
      JOIN memberships m ON m.user_id = u.id AND m.org_id = ?
      WHERE u.status = 'active' AND u.id != ? ORDER BY u.name`
  ).all(user.org_id, user.id);
  res.json(users);
});

// ── Managing world members ───────────────────────────────────────────────────
//
// Session 150 — members could only be set when a world was created. There was
// no way to add anyone afterwards, promote a member to owner, or remove one, so
// a world's people were fixed at birth. That is a strange limit for a system
// whose whole premise is worlds you share.
//
// All three are owner-only. A world may have SEVERAL owners: the check is
// whether the caller holds the owner role, never whether they created it.

app.post("/api/worlds/:id/members", async (req, res) => {
  const ok = requireWorld(req, res, req.params.id, "owner");
  if (!ok) return;

  const { email, role = "player" } = req.body || {};
  if (!["owner", "player"].includes(role)) {
    return res.status(400).json({ error: "role must be owner or player" });
  }
  // Same-org only. Knowing someone's email is not authority to pull them into a
  // world across a tenant boundary, and an unscoped lookup here doubles as an
  // oracle for whether an address has an account at all.
  const target = db.prepare(
    `SELECT u.id, u.name, u.gender FROM users u JOIN memberships m ON m.user_id = u.id AND m.org_id = ?
      WHERE u.email = ? AND u.status = 'active'`
  ).get(ok.user.org_id, email);
  if (!target) return res.status(404).json({ error: "user not found" });

  const already = db.prepare(
    `SELECT role FROM world_memberships WHERE user_id = ? AND world_id = ?`
  ).get(target.id, req.params.id);
  if (already) return res.status(409).json({ error: `${target.name} is already a ${already.role} of this world.` });

  // The simulator mints the player actor, using the same id convention as world
  // creation, so a member added now is indistinguishable from an original one.
  let actorId = `${target.id}-${req.params.id.slice(0, 8)}`;
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.id}/members`, {
      method: "POST",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: target.id, name: target.name, gender: target.gender ?? null }),
    });
    if (!r.ok) return res.status(502).json({ error: `Simulator refused: HTTP ${r.status}` });
    const body = await r.json();
    if (body.actor_id) actorId = body.actor_id;
  } catch (e) {
    return res.status(502).json({ error: `Couldn't reach the simulator (${e.message}). Nobody was added.` });
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO world_memberships (id, user_id, world_id, actor_id, role, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?)`
  ).run(randomUUID(), target.id, req.params.id, actorId, role, now, now);

  res.json({ ok: true, user_id: target.id, name: target.name, role, actor_id: actorId });
});

app.patch("/api/worlds/:id/members/:user_id", (req, res) => {
  const ok = requireWorld(req, res, req.params.id, "owner");
  if (!ok) return;

  const { role } = req.body || {};
  if (!["owner", "player"].includes(role)) {
    return res.status(400).json({ error: "role must be owner or player" });
  }

  // A world must keep at least one owner, or it becomes unmanageable by anyone.
  if (role === "player") {
    const owners = db.prepare(
      `SELECT COUNT(*) AS n FROM world_memberships WHERE world_id = ? AND role = 'owner'`
    ).get(req.params.id).n;
    const targetIsOwner = db.prepare(
      `SELECT role FROM world_memberships WHERE world_id = ? AND user_id = ?`
    ).get(req.params.id, req.params.user_id)?.role === "owner";
    if (targetIsOwner && owners <= 1) {
      return res.status(409).json({ error: "This is the world's only owner. Make someone else an owner first." });
    }
  }

  const info = db.prepare(
    `UPDATE world_memberships SET role = ?, updated_at = ? WHERE world_id = ? AND user_id = ?`
  ).run(role, new Date().toISOString(), req.params.id, req.params.user_id);
  if (!info.changes) return res.status(404).json({ error: "not a member of this world" });
  res.json({ ok: true, user_id: req.params.user_id, role });
});

app.delete("/api/worlds/:id/members/:user_id", async (req, res) => {
  const ok = requireWorld(req, res, req.params.id, "owner");
  if (!ok) return;

  const m = db.prepare(
    `SELECT role FROM world_memberships WHERE world_id = ? AND user_id = ?`
  ).get(req.params.id, req.params.user_id);
  if (!m) return res.status(404).json({ error: "not a member of this world" });

  if (m.role === "owner") {
    const owners = db.prepare(
      `SELECT COUNT(*) AS n FROM world_memberships WHERE world_id = ? AND role = 'owner'`
    ).get(req.params.id).n;
    if (owners <= 1) return res.status(409).json({ error: "This is the world's only owner. Make someone else an owner first." });
  }

  // Removing a person erases their player actor, not the characters they
  // deployed — those belong to whoever owns them and stay where they are.
  // Session 150 — do not swallow this.
  //
  // The original comment here read "the membership row is the authority; a stale
  // sim actor is harmless". Both halves were wrong. The simulator was returning
  // 500 (a module-attribute ordering bug on its side), fetch does not throw on
  // 500 so the catch never even fired, and the removed members' player actors
  // stayed in the world — found only by reading the actor table by hand.
  //
  // The membership row is still removed either way: a person who has lost access
  // should lose it even if the simulator is unreachable. But the failure is now
  // reported rather than assumed away.
  let simWarning = null;
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.id}/members/${req.params.user_id}`, {
      method: "DELETE", headers: { "X-Service-Token": SERVICE_TOKEN },
    });
    if (!r.ok) {
      simWarning = `Membership removed, but the simulator could not erase their player actor (HTTP ${r.status}).`;
      console.warn(`[members] simulator refused DELETE for ${req.params.user_id}: HTTP ${r.status}`);
    }
  } catch (e) {
    simWarning = `Membership removed, but the simulator was unreachable (${e.message}) — their player actor may remain.`;
    console.warn(`[members] simulator unreachable on DELETE:`, e.message);
  }

  db.prepare(`DELETE FROM world_memberships WHERE world_id = ? AND user_id = ?`)
    .run(req.params.id, req.params.user_id);
  res.json({ ok: true, ...(simWarning ? { warning: simWarning } : {}) });
});

// ── GET /api/worlds/:id/members — users who are members of this world ─────────
app.get("/api/worlds/:id/members", (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const members = db.prepare(`
    SELECT u.id, u.name, u.email, u.photo_url, m.actor_id, m.role
    FROM world_memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.world_id = ?
    ORDER BY u.name
  `).all(req.params.id);
  res.json(members);
});

// ── POST /api/users/me/photo — upload profile photo for current user ──────────
app.post("/api/users/me/photo", upload.single("photo"), async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  if (!req.file) return res.status(400).json({ error: "no file uploaded" });

  const ext      = path.extname(req.file.originalname || "photo.jpg") || ".jpg";
  const filename = `photo${ext}`;
  const userDir  = path.join(__dirname, "../public/media/users", user.id);

  const { mkdirSync, writeFileSync } = await import("fs");
  mkdirSync(userDir, { recursive: true });
  writeFileSync(path.join(userDir, filename), req.file.buffer);

  try {
    const sharp = (await import("sharp")).default;
    await sharp(req.file.buffer).resize(200, 200, { fit:"cover" }).jpeg({ quality:82 }).toFile(path.join(userDir, "thumb_photo.jpg"));
  } catch {}

  const url = `/media/users/${user.id}/${filename}`;
  const now = new Date().toISOString();
  db.prepare(`UPDATE users SET photo_url = ?, updated_at = ? WHERE id = ?`).run(url, now, user.id);

  res.json({ url });
});

app.get("/api/me", async (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const row = db.prepare(`
    SELECT u.id, u.name, u.email, u.photo_url, u.user_type, u.org_id, u.org_role, u.gender, u.avatar_actor_id,
           u.personal_org_id, o.name AS org_name, o.kind AS org_kind
    FROM auth_tokens t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN orgs o ON o.id = u.org_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')
  `).get(hash);
  if (!row) return res.status(401).json({ error: "not authenticated" });
  const worlds = db.prepare(`SELECT world_id, actor_id, role FROM world_memberships WHERE user_id = ?`).all(row.id);
  const memberships = membershipsOf(row.id);
  const active = memberships.find(m => m.org_id === row.org_id) || null;
  res.json({
    id: row.id, name: row.name, email: row.email, photo_url: row.photo_url, worlds,
    user_type: row.user_type,
    org_role: active ? active.role : row.org_role,
    personal_org_id: row.personal_org_id,
    memberships,
    gender: row.gender,
    avatar: avatarStateOf(row.avatar_actor_id),
    // The UI hides account management from anyone who cannot use it — a member
    // is not an administrator, and a private user has no colleagues to invite.
    // This is a convenience, not the control: the admin endpoints refuse them
    // regardless of what the page renders.
    org: row.org_id ? { id: row.org_id, name: row.org_name, kind: row.org_kind } : null,
    can_manage_users: row.org_kind === "organization" && active?.role === "admin",
  });
});

// ── Gender → every world the user plays in ───────────────────────────────────
//
// The simulator keeps its own copy on the player actor, so a gender written
// only on the platform drifts silently. Both edit paths — an admin's
// PUT /api/users/:id/gender and a person's own PATCH /api/me — push through
// here; two copies of this loop would be two things to keep in step. Each world
// is reported separately, because a partial success has to stay visible.
async function syncGenderToWorlds(userId, gender) {
  const memberships = db.prepare(
    `SELECT world_id, actor_id FROM world_memberships WHERE user_id = ?`
  ).all(userId);

  const synced = [];
  for (const m of memberships) {
    try {
      const r = await fetch(
        `${SIMULATOR_URL}/internal/worlds/${m.world_id}/members/${userId}`,
        {
          method: "PATCH",
          headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ actor_id: m.actor_id, gender }),
        }
      );
      synced.push({ world_id: m.world_id, actor_id: m.actor_id, ok: r.ok, status: r.status });
    } catch (e) {
      synced.push({ world_id: m.world_id, actor_id: m.actor_id, ok: false, error: e.message });
    }
  }
  return synced;
}

// ── PATCH /api/me — edit your own account ────────────────────────────────────
//
// Name, email and gender, for the person they belong to. Until now the only
// self-service on an account was the photo: everything else was fixed at
// creation by whoever typed it into /admin/users, so a typo in your own name
// was permanent. Gender was reachable but staff-only, which left a private
// user unable to set their own at all.
//
// Session cookie only, deliberately: authUser also accepts an API key, and an
// installed app holding one has no business renaming its owner or moving their
// email somewhere else. Editing who you are is an act a person performs at a
// browser, so it is gated on the thing only a browser has.
app.patch("/api/me", async (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const me = db.prepare(`
    SELECT u.id, u.name, u.email, u.gender FROM auth_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')
      AND u.status != 'removed'
  `).get(hash);
  if (!me) return res.status(401).json({ error: "not authenticated" });

  // A field that was not sent is not an instruction to clear it — only what the
  // body actually names is touched. Gender is why that distinction matters:
  // there, "" is a real value ("no gender recorded") and not the same as absent.
  const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);
  const sets = [];
  const vals = [];

  if (has("name")) {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "name cannot be empty" });
    if (name.length > 80) return res.status(400).json({ error: "name is too long" });
    sets.push("name = ?"); vals.push(name);
  }

  if (has("email")) {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "valid email required" });
    // Unique platform-wide rather than per-org: it is the handle a private
    // account signs in with, so it has to resolve to one person with no
    // organization around it to disambiguate.
    const clash = db.prepare(`SELECT id FROM users WHERE lower(email) = ? AND id != ?`).get(email, me.id);
    if (clash) return res.status(409).json({ error: "that email is already in use" });
    sets.push("email = ?"); vals.push(email);
  }

  let gender;
  if (has("gender")) {
    const raw = req.body.gender;
    gender = raw === null || raw === undefined || raw === "" ? null : String(raw).trim().toLowerCase();
    // The set the simulator normalises to. Anything else is a 422 over there, so
    // it is a 422 here — better than a value that saves and then cannot sync.
    if (![null, "male", "female", "non-binary"].includes(gender)) {
      return res.status(422).json({ error: "gender must be male, female, non-binary, or empty" });
    }
    sets.push("gender = ?"); vals.push(gender);
  }

  if (!sets.length) return res.status(400).json({ error: "nothing to update" });

  sets.push("updated_at = ?"); vals.push(new Date().toISOString());
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals, me.id);

  // Gender rides out to the player actor in every world — unconditionally when
  // it is named, even if the value did not change, because the push is
  // idempotent and repairs drift the platform cannot see.
  //
  // A changed NAME does not ride out: the simulator's member PATCH understands
  // gender and refuses anything else, so an actor keeps the name it was minted
  // with. Reported rather than hidden, so the page can say so.
  const worlds = has("gender") ? await syncGenderToWorlds(me.id, gender) : [];

  const row = db.prepare(`SELECT id, name, email, gender, photo_url FROM users WHERE id = ?`).get(me.id);
  res.json({
    ok: true,
    user: row,
    // Not a 502: the account really did change. A world that refused the push is
    // a partial result the caller has to see, not a save that did not happen.
    worlds,
    gender_synced: worlds.every(w => w.ok),
    name_changed: has("name") && req.body.name.trim() !== me.name,
  });
});

// ── POST /api/me/active-org — which of your orgs this session acts in ────────
// The acting-as context. Everything scoped "same org" — the People page, the
// share picker, world invites — reads the active org, so switching it is what
// moves you between the organizations you belong to.
app.post("/api/me/active-org", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const orgId = String(req.body?.org_id || "").trim();
  if (!orgId) return res.status(400).json({ error: "org_id required" });
  if (!activateOrg(user.id, orgId)) return res.status(404).json({ error: "you are not a member of that organization" });
  res.json({ ok: true, org_id: orgId, org_role: membershipOf(user.id, orgId).role });
});

// ── The user's own 3D profile ────────────────────────────────────────────────
//
// "Has an avatar" is not the same question as "can appear in a world", and the
// gap between them is where a half-finished wizard lives. A row can exist with
// no model on it yet — generation is long-running and can fail — so `ready` is
// computed from an actual model file, never from the pointer being non-null.
function avatarStateOf(actorId) {
  if (!actorId) return { actor_id: null, ready: false, state: "none" };
  const a = db.prepare(
    `SELECT id, name, glb_url, runtime_glb_url, status FROM actors WHERE id = ?`
  ).get(actorId);
  // The pointer outlived the actor — treat it as absent rather than serving a
  // dangling id the UI would try to load.
  if (!a) return { actor_id: null, ready: false, state: "none" };
  // A model file is necessary but not sufficient. `status` was being SELECTed
  // here and never read, so a DRAFT carrying a body counted as a finished
  // avatar and opened the spawn gate. That is reachable by ordinary use, not
  // just by a lab: closing the wizard offers "discard changes", which leaves
  // the draft exactly as it was last saved — so somebody can walk away
  // mid-authoring and still be wearing a body they never finished.
  const hasModel = !!(a.runtime_glb_url || a.glb_url);
  const isDraft = a.status === "draft";
  const ready = hasModel && !isDraft;
  return {
    actor_id: a.id,
    name: a.name,
    ready,
    // Three not-ready states, kept apart because each needs a different action:
    //   none     — no profile at all
    //   building — a profile exists, the pipeline has not produced a body yet
    //   draft    — a body exists, the profile was never finished
    state: ready ? "ready" : hasModel ? "draft" : "building",
    status: a.status,
    has_model: hasModel,
    has_runtime: !!a.runtime_glb_url,
  };
}

// Entering a world means being placed in it as a body. Without a model there is
// nothing to place, so this is a precondition of spawning rather than a policy
// bolted on top of it — and it is checked on the server because the disabled
// button on /home is an affordance, not a control.
//
// `ready` deliberately means a model file exists, not that a row was created:
// a half-finished profile must not get you in.
function requireReadyAvatar(req, res, user) {
  const row = db.prepare(`SELECT avatar_actor_id FROM users WHERE id = ?`).get(user.id);
  const avatar = avatarStateOf(row?.avatar_actor_id);
  if (avatar.ready) return true;
  res.status(403).json({
    error: avatar.state === "building"
      ? "Your 3D profile has no model yet. Finish it before entering a world."
      : avatar.state === "draft"
      ? "Your 3D profile is still a draft. Finish it before entering a world."
      : "You need a 3D profile before you can enter a world.",
    reason: "avatar_required",
    avatar,
  });
  return false;
}

// Push the user's model onto their player actor in every world they are in.
//
// Their player actor already exists — the simulator mints it on join — so this
// attaches a body to it rather than creating anybody. That is why it calls
// deploy_player and not deploy_actor: deploy_actor generates a new uuid and
// inserts actor_type "character", takes the Ollama lock and authors a career, a
// psychology and a schedule. A person playing brings their own.
async function deployAvatarToWorlds(user) {
  const row    = db.prepare(`SELECT avatar_actor_id FROM users WHERE id = ?`).get(user.id);
  const state  = avatarStateOf(row?.avatar_actor_id);
  if (!state.ready) return { ok: false, reason: "avatar_not_ready", avatar: state, worlds: [] };

  const actor = db.prepare(
    `SELECT id, appearance, age, glb_url, runtime_glb_url FROM actors WHERE id = ?`
  ).get(state.actor_id);

  // ANIMA-INVARIANT (owner policy, Magnus 2026-08-25): personal media never
  // transits the public tunnel. This is the LAN base — nginx on :80, reached
  // through the `allow 192.168.1.58` rule on the media locations. The old
  // default pointed at the node listener on :4002, which has been bound to
  // 127.0.0.1 since 2026-08-28 and is therefore unreachable from the simulator:
  // every download failed silently. Do not "fix" a 401 here by loosening nginx.
  const lanBase = process.env.PLATFORM_INTERNAL_URL || "http://192.168.1.59";
  const lan = (u) => u ? (u.startsWith("http") ? u : `${lanBase}${u.split("?")[0]}`) : null;

  const media = [];
  if (actor.glb_url)         media.push({ media_type: "model", url: lan(actor.glb_url) });
  if (actor.runtime_glb_url) media.push({ media_type: "model", state_slug: "runtime", url: lan(actor.runtime_glb_url) });

  const memberships = db.prepare(
    `SELECT world_id, actor_id FROM world_memberships WHERE user_id = ?`
  ).all(user.id);

  const worlds = [];
  for (const m of memberships) {
    try {
      const r = await fetch(
        `${SIMULATOR_URL}/internal/worlds/${m.world_id}/player/${m.actor_id}/deploy`,
        { method: "POST",
          headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ appearance: actor.appearance || null, age: actor.age || null, media }) }
      );
      const body = await r.json().catch(() => ({}));
      // Reported per world, never collapsed into one boolean: a body that
      // landed in one world and not another is exactly the state somebody needs
      // to see rather than a blanket "failed".
      worlds.push({ world_id: m.world_id, actor_id: m.actor_id, ok: r.ok, status: r.status,
                    models: body.models || [], error: r.ok ? null : (body.error || `HTTP ${r.status}`) });
    } catch (e) {
      worlds.push({ world_id: m.world_id, actor_id: m.actor_id, ok: false, error: e.message });
    }
  }
  return { ok: worlds.every(w => w.ok), avatar: state, worlds };
}

// ── POST /api/me/avatar/deploy — (re)push your body into your worlds ─────────
app.post("/api/me/avatar/deploy", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const result = await deployAvatarToWorlds(user);
  if (result.reason === "avatar_not_ready") {
    return res.status(409).json({ error: "Your 3D profile has no model yet.", ...result });
  }
  res.status(result.ok ? 200 : 502).json(result);
});

// ── GET /api/me/avatar ───────────────────────────────────────────────────────
app.get("/api/me/avatar", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const row = db.prepare(`SELECT avatar_actor_id FROM users WHERE id = ?`).get(user.id);
  res.json(avatarStateOf(row?.avatar_actor_id));
});

// ── POST /api/me/avatar { actor_id } — adopt one of your characters as you ───
//
// Ownership is checked here rather than trusted from the wizard: this endpoint
// is what makes an actor "you", and pointing it at somebody else's character
// would put their face on your player.
app.post("/api/me/avatar", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const actorId = String(req.body?.actor_id || "").trim();
  if (!actorId) return res.status(400).json({ error: "actor_id required" });

  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(actorId, user.id);
  if (!actor) return res.status(404).json({ error: "character not found" });

  db.prepare(`UPDATE users SET avatar_actor_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(actorId, user.id);

  // Adopting a character as your own avatar is a first-person statement about
  // its reference photographs, so record it. actor_media.depicts was NULL on
  // every row on the system, which left signal 4 ("is this uploader building a
  // likeness of somebody who is not them") unanswerable even for the one actor
  // the account had explicitly said IS them. This is the same derivation
  // avatarlab-routes.js already treats as true-by-construction -- the
  // authenticated OWNER of this actor is declaring it to be themselves -- and
  // not an inference from a name or from a photograph.
  //
  // Only NULLs are filled. An explicit 'other' already on file is a
  // contradiction (a likeness of someone else, adopted as your own face) and is
  // exactly what the conduct watch exists to see, so it is left standing rather
  // than quietly overwritten. The slot whitelist keeps this to the photographs
  // that actually build a face and a body.
  const selfDeclared = db.prepare(`UPDATE actor_media SET depicts = 'self', updated_at = ?
     WHERE actor_id = ? AND media_type = 'photo' AND world_id IS NULL
       AND depicts IS NULL
       AND state_slug IN ('profile','body_front','body_side','body_back')`)
    .run(new Date().toISOString(), actorId);
  if (selfDeclared.changes) {
    console.log(`[media depicts] avatar adoption: actor ${actorId} user ${user.id} -> self (${selfDeclared.changes} row(s))`);
  }

  // Adopting it is not finished until it is in the worlds. Doing this here means
  // "this is me" cannot be true on the platform and false everywhere it counts.
  // A push failure does not undo the adoption — the profile IS yours either way
  // — so it is reported alongside rather than thrown.
  const push = await deployAvatarToWorlds(user);
  res.json({ ok: true, avatar: avatarStateOf(actorId), deploy: push });
});

// ── GET /api/worlds ───────────────────────────────────────────────────────────
// ── GET /api/simulator/health — is the simulator actually there? ─────────────
//
// Session 150 — the deploy wizard needs to know this BEFORE it lets someone
// spend six steps building a deployment that cannot land. Every other route
// discovers the simulator is down only at the moment it needs it, and the
// wizard's world list turned a 502 into an empty array, so a downed simulator
// looked identical to "you have no worlds".
//
// This pings /internal/worlds rather than the bare root on purpose: it proves
// the service token is accepted and the router is up, not merely that something
// is listening on the port. Short timeout — this gates a UI control, so a slow
// answer is as bad as no answer.
app.get("/api/simulator/health", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const started = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds?ids=`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const latency_ms = Date.now() - started;
    if (!r.ok) {
      return res.json({ reachable: false, status: r.status, latency_ms,
        reason: `The simulator answered HTTP ${r.status}.` });
    }
    return res.json({ reachable: true, status: r.status, latency_ms });
  } catch (e) {
    return res.json({ reachable: false, status: null, latency_ms: Date.now() - started,
      reason: e.name === "AbortError"
        ? "The simulator didn't answer within 4 seconds."
        : `Couldn't reach the simulator (${e.message}).` });
  }
});

app.get("/api/worlds", async (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`
    SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')
  `).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });

  const memberships = db.prepare(`
    SELECT world_id, actor_id, role FROM world_memberships WHERE user_id = ?
  `).all(user.id);

  if (memberships.length === 0) return res.json([]);

  const ids = memberships.map(m => m.world_id).join(",");
  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/worlds?ids=${ids}`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
    });
    const worlds = await simRes.json();
    const membershipMap = Object.fromEntries(memberships.map(m => [m.world_id, m]));
    const enriched = worlds.map(w => {
      const member_count = db.prepare(`SELECT count(*) as n FROM world_memberships WHERE world_id = ?`).get(w.id)?.n || 0;
      return {
        ...w,
        role:         membershipMap[w.id]?.role,
        actor_id:     membershipMap[w.id]?.actor_id,
        member_count,
      };
    });
    res.json(enriched);
  } catch {
    res.status(502).json({ error: "simulator unreachable" });
  }
});

// ── POST /api/worlds/:world_id/actors/:actor_id/portrait ─────────────────────
app.post("/api/worlds/:world_id/actors/:actor_id/portrait", upload.single("photo"), async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  const user = ok.user;
  const { world_id, actor_id } = req.params;
  const { user_id, use_default } = req.body;

  try {
    let srcBuffer, ext;

    if (req.file) {
      srcBuffer = req.file.buffer;
      ext = path.extname(req.file.originalname || "photo.jpg") || ".jpg";
    } else if (use_default === "true" && user_id) {
      // Copy from platform user photo
      const userDir = path.join(__dirname, "../public/media/users", user_id);
      const candidates = ["photo.png","photo.jpg","photo.jpeg","photo.webp"];
      let found = null;
      for (const c of candidates) {
        const p2 = path.join(userDir, c);
        if (fs.existsSync(p2)) { found = p2; ext = path.extname(c); break; }
      }
      if (found) srcBuffer = await fs.promises.readFile(found);
    }

    if (!srcBuffer) return res.json({ ok: true, skipped: true });

    const destDir = path.join(__dirname, "../public/media/worlds", world_id, "actors", actor_id, "images");
    await fs.promises.mkdir(destDir, { recursive: true });
    const filename = `profile${ext}`;
    await fs.promises.writeFile(path.join(destDir, filename), srcBuffer);
    const relativePath = `/media/worlds/${world_id}/actors/${actor_id}/images/${filename}`;
    const baseUrl = process.env.PLATFORM_PUBLIC_URL || `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
    const mediaPath = `${baseUrl}${relativePath}`;

    // This host has just put media for an actor on ITS OWN disk, which means
    // nginx will serve those bytes and the simulator will never witness the
    // fetch. If the subject is simulator-native, fill the read-model now so the
    // very first fetch is attributed instead of waiting for the 15-min sweep.
    cacheRemoteActorAge(world_id, actor_id).catch(() => {});

    // Tell simulator to write actor_media row
    await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/actors/${actor_id}/portrait`, {
      method: "POST",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ path: mediaPath }),
    }).catch(() => {});

    res.json({ ok: true, path: mediaPath });
  } catch (e) {
    console.error("[portrait]", e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/ambient-actors/:actor_id/portrait-status ────────────────────────
app.get("/api/ambient-actors/:actor_id/portrait-status", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { actor_id } = req.params;
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/ambient-actors/${actor_id}/portrait-status`, {
      headers: { "X-Service-Token": SERVICE_TOKEN }
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/users/:user_id/gender ───────────────────────────────────────────
//
// There is no registration yet, so this is how a user's gender gets recorded at
// all. It writes the platform's copy and then pushes it to every world the user
// has a player actor in, because the simulator holds its own and the two drift
// silently otherwise.
//
// The response reports each world separately: a partial success has to be
// visible, or the platform would claim a sync it did not achieve.
app.put("/api/users/:user_id/gender", async (req, res) => {
  const auth = authUser(req);
  if (!auth) return res.status(401).json({ error: "unauthorized" });

  // authUser used to return only {id, name}, so checking auth.user_type directly
  // was undefined and refused everyone. It carries user_type and org_id now, but
  // this re-query is left as the authority rather than trusted from the session.
  const caller = db.prepare(`SELECT user_type FROM users WHERE id = ?`).get(auth.id);
  if (caller?.user_type !== "staff") return res.status(403).json({ error: "staff only" });

  const { user_id } = req.params;
  const raw = req.body?.gender;
  const allowed = ["male", "female", "non-binary", null];
  const gender = raw === undefined || raw === "" ? null : raw;

  if (!allowed.includes(gender)) {
    return res.status(422).json({ error: "gender must be male, female, non-binary, or null" });
  }

  const target = db.prepare(`SELECT id, name FROM users WHERE id = ?`).get(user_id);
  if (!target) return res.status(404).json({ error: "user not found" });

  db.prepare(`UPDATE users SET gender = ?, updated_at = ? WHERE id = ?`)
    .run(gender, new Date().toISOString(), user_id);

  // Same push the self-service edit uses; see syncGenderToWorlds.
  const synced = await syncGenderToWorlds(user_id, gender);

  const failed = synced.filter(s => !s.ok);
  res.status(failed.length ? 502 : 200).json({
    ok: failed.length === 0,
    user_id,
    name: target.name,
    gender,
    worlds: synced,
  });
});

// ── POST /api/worlds/:world_id/crowd/approach ────────────────────────────────
//
// Walks up to somebody in a venue's background crowd. They have no record
// until this call; the simulator recomputes the room, checks they are still
// standing in it, and writes them one. Only the ref is forwarded — the
// simulator supplies the person, so a client cannot invent a guest.
app.post("/api/worlds/:world_id/crowd/approach", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const { world_id } = req.params;
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/crowd/approach`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": SERVICE_TOKEN },
      body: JSON.stringify({ place_id: req.body?.place_id, ref: req.body?.ref })
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/worlds/:world_id/ambient-encounter/start ───────────────────────
app.post("/api/worlds/:world_id/ambient-encounter/start", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { world_id } = req.params;
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/ambient-encounter/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": SERVICE_TOKEN },
      body: JSON.stringify(req.body)
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/worlds/:world_id/ambient-encounter/:id/opening ─────────────────
app.get("/api/worlds/:world_id/ambient-encounter/:encounter_id/opening", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { world_id, encounter_id } = req.params;
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/ambient-encounter/${encounter_id}/opening`, {
      headers: { "X-Service-Token": SERVICE_TOKEN }
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/worlds/:world_id/ambient-encounter/:id/message ─────────────────
app.post("/api/worlds/:world_id/ambient-encounter/:encounter_id/message", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { world_id, encounter_id } = req.params;
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/ambient-encounter/${encounter_id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": SERVICE_TOKEN },
      body: JSON.stringify(req.body)
    });
    // Session 151 — forward the simulator's status.
    //
    // This answered 200 whatever came back, so a 404 "encounter not found"
    // arrived at the browser looking like a successful reply with no words in
    // it, and the chat drew an empty bubble. A failure that renders as silence
    // is worse than a failure that says so: the room looked like it had nothing
    // to say to you.
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/worlds/:world_id/ambient-encounter/:id/end ─────────────────────
app.post("/api/worlds/:world_id/ambient-encounter/:encounter_id/end", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { world_id, encounter_id } = req.params;
  try {
    await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/ambient-encounter/${encounter_id}/end`, {
      method: "POST",
      headers: { "X-Service-Token": SERVICE_TOKEN }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/ambient-actors/:actor_id/generate-portrait ─────────────────────
app.post("/api/ambient-actors/:actor_id/generate-portrait", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { actor_id } = req.params;
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/ambient-actors/${actor_id}/generate-portrait`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": SERVICE_TOKEN }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error("[ambient-portrait]", e);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/worlds/:id ────────────────────────────────────────────────────
app.delete("/api/worlds/:id", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  const user = ok.user;
  const { id } = req.params;
  const membership = db.prepare(`SELECT role FROM world_memberships WHERE user_id = ? AND world_id = ?`).get(user.id, id);
  if (!membership || membership.role !== "owner") return res.status(403).json({ error: "forbidden" });
  try {
    await fetch(`${SIMULATOR_URL}/internal/worlds/${id}`, {
      method: "DELETE", headers: { "X-Service-Token": SERVICE_TOKEN },
      signal: AbortSignal.timeout(10000)
    });
  } catch {}
  // Session 149 — capture who was actively deployed here BEFORE the hard
  // delete below removes the only record of it. Same status-recalc rule
  // as single-actor undeploy: drop to 'ready_to_deploy' only if this was
  // their last active deployment anywhere, not just in this world.
  const affectedActorIds = db.prepare(`SELECT DISTINCT platform_actor_id FROM actor_deployments WHERE world_id = ? AND undeployed_at IS NULL`).all(id).map(r => r.platform_actor_id);
  db.prepare(`DELETE FROM world_memberships WHERE world_id = ?`).run(id);
  db.prepare(`DELETE FROM actor_deployments WHERE world_id = ?`).run(id);
  // Same defect as single-actor undeploy, one level up: sweep targets pinned to
  // a world that no longer exists can never resolve again either. Drop them.
  try {
    const prunedTargets =
      db.prepare(`DELETE FROM lab_suite_targets WHERE world_id = ?`).run(id).changes +
      db.prepare(`DELETE FROM lab_sweep_targets WHERE world_id = ?`).run(id).changes;
    if (prunedTargets) console.log(`[world-delete] pruned ${prunedTargets} lab sweep target(s) naming ${id}`);
  } catch (e) {
    console.warn("[world-delete] lab target prune failed:", e.message);
  }
  const nowStatus = new Date().toISOString();
  for (const actorId of affectedActorIds) {
    const stillDeployed = db.prepare(`SELECT 1 FROM actor_deployments WHERE platform_actor_id = ? AND undeployed_at IS NULL LIMIT 1`).get(actorId);
    if (!stillDeployed) {
      db.prepare(`UPDATE actors SET status = 'ready_to_deploy', updated_at = ? WHERE id = ?`).run(nowStatus, actorId);
    }
  }
  // Clean up world media on platform disk
  // Session 149 — this crashed every world delete: fs here is the plain
  // callback-style node:fs (see `const fs = _require("fs")` above), whose
  // .rm() doesn't return a Promise when called without a callback — it
  // returns undefined, and .catch() on undefined throws synchronously,
  // which Express never catches for an unwrapped async handler. res.json
  // below never sent; client saw a 504, not the real failure. DB-side
  // cleanup above this line is unaffected and already completed by the
  // time this throws. fs.promises.rm is the actual Promise-returning API.
  const worldMediaDir = path.join(__dirname, "../public/media/worlds", id);
  fs.promises.rm(worldMediaDir, { recursive: true, force: true }).catch(() => {});

  // This is the OTHER place a world's media lives, and this cleanup never
  // reached it. POST /api/actors/:id/media stores photos/audio for a
  // world-specific character at public/media/actors/{slug}/worlds/{world_id}/
  // — a path nested under the ACTOR, not the world — specifically to dodge
  // the nginx rule that sends /media/worlds/* to the simulator (see that
  // handler's own comment). Deleting worldMediaDir above never touches this.
  // Confirmed live: an old world's actor photo was still HTTP 200 here after
  // the world itself, and its /media/worlds/ tree, were both long gone.
  // There's no per-world index of which actor slugs have content, so this
  // scans every actor folder for a worlds/{id} subdirectory and removes it —
  // cheap; actor counts here are small, and this runs once per world delete.
  fs.promises.readdir(path.join(__dirname, "../public/media/actors"), { withFileTypes: true })
    .then(entries => Promise.all(
      entries.filter(e => e.isDirectory()).map(e => {
        const worldSubdir = path.join(__dirname, "../public/media/actors", e.name, "worlds", id);
        return fs.promises.rm(worldSubdir, { recursive: true, force: true }).catch(() => {});
      })
    ))
    .catch(() => {});

  res.json({ ok: true });
});

// ── POST /api/worlds ──────────────────────────────────────────────────────────
app.post("/api/worlds", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const {
    name, city, lat, lng, timezone,
    news_feed_url, modules = [], scenario_seed, visibility = "private",
    invitees = [], home_address, llm_capabilities = {}, xtts_url
  } = req.body;

  if (!name) return res.status(400).json({ error: "name required" });
  if (!city || !lat || !lng || !timezone) return res.status(400).json({ error: "city, lat, lng, timezone required" });

  const world_id = randomUUID();
  const now = new Date().toISOString();

  // Resolve invitee names from users table
  const inviteeUsers = invitees.map(id => {
    const u = db.prepare(`SELECT id, name, gender FROM users WHERE id = ?`).get(id);
    return u || null;
  }).filter(Boolean);

  // Full members list: creator + invitees. `gender` rides along so the player
  // actor is minted with one — every generated actor had a gender and no human
  // did, purely because this payload never carried the field.
  const creator = db.prepare(`SELECT id, name, gender FROM users WHERE id = ?`).get(user.id);
  const members = [
    { id: user.id, name: user.name, gender: creator?.gender ?? null },
    ...inviteeUsers
  ];

  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/worlds`, {
      method: "POST",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: world_id, name, city, lat, lng, timezone,
        news_feed_url, modules, scenario_seed,
        members: members.map((m, i) => ({ ...m, role: i === 0 ? "owner" : "player" })),
        home_address: home_address || undefined,
        llm_capabilities,
        // Session 150 — per-world XTTS endpoint. The voice server runs on a GPU
        // box that is started and stopped by hand, so its address is not a
        // constant the simulator can compile in.
        xtts_url: (typeof xtts_url === "string" && xtts_url.trim()) ? xtts_url.trim() : undefined
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!simRes.ok) {
      const err = await simRes.json().catch(() => ({}));
      return res.status(502).json({ error: "simulator failed to create world", detail: err });
    }

    const simWorld = await simRes.json();
    const actorMap = simWorld.actor_ids || {};

    // Insert world_memberships for creator + all invitees
    const insertMembership = db.prepare(`
      INSERT INTO world_memberships (id, user_id, world_id, actor_id, role, inserted_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertMembership.run(randomUUID(), user.id, world_id, actorMap[user.id] || `${user.id}-actor`, "owner", now, now);
    for (const invitee of inviteeUsers) {
      // Session 150 — "player". Invitees were originally recorded as "member", a
      // third role string no code ever read, alongside the "viewer" rows the
      // existing worlds carried — two names for the same nothing. Both are now
      // "player", which is what the rung actually is.
      insertMembership.run(randomUUID(), invitee.id, world_id, actorMap[invitee.id] || `${invitee.id}-actor`, "player", now, now);
    }

    res.json({ world_id, name, status: "running", ...simWorld });
  } catch (e) {
    console.error("[POST /api/worlds]", e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/auth/signout ───────────────────────────────────────────────────
app.post("/api/auth/signout", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (match) {
    const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
    const token = db.prepare(`SELECT user_id FROM auth_tokens WHERE token_hash = ?`).get(hash);
    db.prepare(`UPDATE auth_tokens SET revoked_at = datetime('now') WHERE token_hash = ?`).run(hash);
    // Push presence offline to simulator
    if (token) {
      const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? LIMIT 1`).get(token.user_id);
      if (membership) {
        fetch(`${SIMULATOR_URL}/internal/presence/${membership.actor_id}`, {
          method: "POST",
          headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ status: "offline" })
        }).catch(() => {});
      }
    }
  }
  res.setHeader("Set-Cookie", "anima_token=; Path=/; Max-Age=0; SameSite=None; Secure");
  res.json({ ok: true });
});

const SIMULATOR_URL = "http://192.168.1.58:4000";
const SERVICE_TOKEN = process.env.PLATFORM_SERVICE_TOKEN || "";

// ── World authorisation ───────────────────────────────────────────────────────
//
// Session 150 — until now, 38 of the 52 world-scoped routes checked only that
// the caller was logged in and then trusted the world_id in the URL.
// world_memberships was written at world creation and never read again, so any
// authenticated user could list any world's cast, read and edit a character's
// psychology and salary, or stop the world outright, purely by knowing its id.
//
// Roles are `owner` and `player`, and a world may have SEVERAL owners — the
// check is set membership, not "is this the creator".
//
//   player — lives in the world: enters it, has a player actor of their own,
//            talks to the characters, and is subject to what the world does.
//            Cannot change how the world is built.
//   owner  — everything a player can do, plus start/stop, configure, deploy,
//            delete, and manage who else belongs
//
// Session 150 — this rung was called "viewer" for most of the session, which
// misdescribed it: a non-owner member has a player actor minted for them at
// join time and enters the world through /world/:worldId. They are playing, not
// watching. The word was doing real harm in the UI, where it told someone their
// own character's world was something they merely observed.
//
// A third string, "member", was written for invitees at world creation and read
// by nothing. It is collapsed into "player" rather than defined, because a role
// no code consults cannot be said to mean anything.
//
// Returns the membership row on success. On failure it has ALREADY answered —
// callers must `return` immediately, hence the `if (!ok) return;` shape.
function requireWorld(req, res, worldId, minRole = "player") {
  const user = authUser(req);
  if (!user) { res.status(401).json({ error: "unauthorized" }); return null; }

  if (!worldId) { res.status(400).json({ error: "world id missing" }); return null; }

  const m = db.prepare(
    `SELECT role FROM world_memberships WHERE user_id = ? AND world_id = ? LIMIT 1`
  ).get(user.id, worldId);

  if (!m) {
    // Deliberately 404, not 403: telling a stranger "forbidden" confirms the
    // world exists. A non-member has no business learning that either way.
    res.status(404).json({ error: "world not found" });
    return null;
  }

  if (minRole === "owner" && m.role !== "owner") {
    res.status(403).json({ error: "Only an owner of this world can do that." });
    return null;
  }

  return { ...m, user };
}

// ── Character access ──────────────────────────────────────────────────────────
//
// Session 150 — three rungs, each a different verb, plus an orthogonal
// re-share flag.
//
//   read  — view the profile. Cannot deploy, cannot edit.
//   use   — deploy the owner's character into a world YOU own. Their template is
//           never touched; the world instance you get is yours to edit, which is
//           exactly the split the world editor already enforces.
//   copy  — fork it into a new character you own outright.
//   owner — created it.
//
// The ladder deliberately does not include "edit the original". That was the
// ambiguity worth removing: if editing someone else's character gradually made
// it yours, there would be no answer to how much editing is enough. Ownership
// changes by one explicit act — taking a copy — and never by degrees.
//
// The old vocabulary was read/clone, where "clone" granted a capability that had
// no implementation anywhere.
const ACCESS_RANK = { read: 1, use: 2, copy: 3, owner: 4 };

function actorAccess(actorId, user) {
  if (!user) return null;
  const a = db.prepare(`SELECT owner_id FROM actors WHERE id = ?`).get(actorId);
  if (!a) return null;
  if (a.owner_id === user.id) return { level: "owner", can_reshare: 1, owner_id: a.owner_id };

  const sh = db.prepare(
    `SELECT permission, can_reshare FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`
  ).get(actorId, user.id);
  if (!sh) return null;
  return { level: sh.permission || "read", can_reshare: sh.can_reshare ? 1 : 0, owner_id: a.owner_id };
}

function hasAccess(actorId, user, min) {
  const acc = actorAccess(actorId, user);
  if (!acc) return null;
  return (ACCESS_RANK[acc.level] || 0) >= (ACCESS_RANK[min] || 0) ? acc : null;
}

// The world id sits under different param names across the routes.
function worldIdOf(req) { return req.params.world_id || req.params.id || null; }

async function simFetch(path, method = "GET") {
  const res = await fetch(`${SIMULATOR_URL}${path}`, { method, headers: { "X-Service-Token": SERVICE_TOKEN } });
  return res.json();
}

app.get("/api/worlds/:id/status", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  try { res.json(await simFetch(`/internal/worlds/${req.params.id}/status`)); }
  catch { res.status(502).json({ error: "simulator unreachable" }); }
});

app.post("/api/worlds/:id/start", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  try { res.json(await simFetch(`/internal/worlds/${req.params.id}/start`, "POST")); }
  catch { res.status(502).json({ error: "simulator unreachable" }); }
});

app.post("/api/worlds/:id/stop", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  try { res.json(await simFetch(`/internal/worlds/${req.params.id}/stop`, "POST")); }
  catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/actors/:actor_id/videos ────────────────────────
// ── GET /api/tax/estimate?country=&gross= ────────────────────────────────────
//
// Session 150 — take-home pay while a salary is being typed in the deploy
// wizard, before there is an actor to attach it to. Proxies straight to the
// simulator so DeliverWorlds.Tax stays the only place the bands exist.
app.get("/api/tax/estimate", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { country = "", gross = "0" } = req.query;
  try {
    const r = await fetch(
      `${SIMULATOR_URL}/internal/tax/estimate?country=${encodeURIComponent(country)}&gross=${encodeURIComponent(gross)}`,
      { headers: { "X-Service-Token": SERVICE_TOKEN } });
    if (!r.ok) return res.status(r.status).json({ error: `simulator returned ${r.status}` });
    res.json(await r.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── /api/worlds/:world_id/actors/:actor_id/economy ───────────────────────────
//
// Session 150 — read and edit a deployed character's money in one world.
//
// The platform's actor id is not the simulator's: a deploy mints a new actor on
// the simulator each time, and actor_deployments is the only mapping between
// them. Same lookup as the other world+actor proxies. It falls back to the id as
// given so a caller who already holds a simulator id still works.
function resolveSimActor(world_id, actor_id) {
  const dep = db.prepare(
    "SELECT simulator_actor_id FROM actor_deployments WHERE world_id = ? AND platform_actor_id = ? AND undeployed_at IS NULL"
  ).get(world_id, actor_id);
  return dep?.simulator_actor_id || actor_id;
}

// ── /api/worlds/:world_id/actors/:actor_id/profile ───────────────────────────
// Identity and psychology of the deployed instance — the copies the simulator
// reads, as opposed to the template at /actors/:id that a deploy ships from.
app.get("/api/worlds/:world_id/actors/:actor_id/profile", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { world_id, actor_id } = req.params;
  try {
    const sim = resolveSimActor(world_id, actor_id);
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/actors/${sim}/profile`,
      { headers: { "X-Service-Token": SERVICE_TOKEN } });
    if (!r.ok) return res.status(r.status).json({ error: `simulator returned ${r.status}` });
    res.json(await r.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

app.patch("/api/worlds/:world_id/actors/:actor_id/profile", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  const user = ok.user;
  const { world_id, actor_id } = req.params;
  try {
    const sim = resolveSimActor(world_id, actor_id);
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/actors/${sim}/profile`, {
      method: "PATCH",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {}),
    });
    if (!r.ok) return res.status(r.status).json({ error: `simulator returned ${r.status}` });
    res.json(await r.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/actors/:actor_id/schedule ──────────────────────
app.get("/api/worlds/:world_id/actors/:actor_id/schedule", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { world_id, actor_id } = req.params;
  try {
    const sim = resolveSimActor(world_id, actor_id);
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/actors/${sim}/schedule`,
      { headers: { "X-Service-Token": SERVICE_TOKEN } });
    if (!r.ok) return res.status(r.status).json({ error: `simulator returned ${r.status}` });
    res.json(await r.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/actors/:actor_id/media ─────────────────────────
// Media captured in this world. The simulator indexes it per actor; the actor
// id is already world-specific, so no extra scoping is needed.
app.get("/api/worlds/:world_id/actors/:actor_id/media", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { world_id, actor_id } = req.params;
  try {
    const sim = resolveSimActor(world_id, actor_id);
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/actors/${sim}/media`,
      { headers: { "X-Service-Token": SERVICE_TOKEN } });
    if (!r.ok) return res.status(r.status).json({ error: `simulator returned ${r.status}` });
    res.json(await r.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

app.get("/api/worlds/:world_id/actors/:actor_id/economy", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { world_id, actor_id } = req.params;
  try {
    const sim = resolveSimActor(world_id, actor_id);
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/actors/${sim}/economy`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
    });
    if (!r.ok) return res.status(r.status).json({ error: `simulator returned ${r.status}` });
    res.json(await r.json());
  } catch (e) { res.status(502).json({ error: "simulator unreachable" }); }
});

app.patch("/api/worlds/:world_id/actors/:actor_id/economy", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  const user = ok.user;
  const { world_id, actor_id } = req.params;
  try {
    const sim = resolveSimActor(world_id, actor_id);
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/actors/${sim}/economy`, {
      method: "PATCH",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {}),
    });
    if (!r.ok) return res.status(r.status).json({ error: `simulator returned ${r.status}` });
    res.json(await r.json());
  } catch (e) { res.status(502).json({ error: "simulator unreachable" }); }
});

app.get("/api/worlds/:world_id/actors/:actor_id/videos", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  try {
    const { world_id, actor_id } = req.params;
    const deployment = db.prepare("SELECT simulator_actor_id FROM actor_deployments WHERE world_id = ? AND platform_actor_id = ?").get(world_id, actor_id);
    const sim_actor_id = deployment?.simulator_actor_id || actor_id;
    const simRes = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/actors/${sim_actor_id}/videos`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
    });
    const data = await simRes.json();
    const base = (req.get("x-forwarded-proto") || req.protocol) + "://" + (req.get("x-forwarded-host") || req.get("host"));
    const videos = (data.videos || []).map(v => ({
      filename: v.filename,
      url: `${base}/media/worlds/${world_id}/actors/${sim_actor_id}/videos/${v.filename}`
    }));
    res.json({ videos });
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:id/modules ─────────────────────────────────────────────
app.get("/api/worlds/:id/modules", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.id}/modules`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
    });
    res.json(await simRes.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── PATCH /api/worlds/:id/modules ────────────────────────────────────────────
app.patch("/api/worlds/:id/modules", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.id}/modules`, {
      method: "PATCH",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    res.json(await simRes.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/llm-config/available — for the create-world wizard, before any
// world_id exists. Reuses the same simulator endpoint as the per-world
// route below with a placeholder world_id — get_llm_config/2 only uses
// world_id to look up saved overrides (none exist yet for a new world, so
// an empty result there is correct) and the `available` list itself is
// independent of any world. ────────────────────────────────────────────────
app.get("/api/llm-config/available", async (req, res) => {
  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/config/llm?world_id=__new_world__`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
    });
    const data = await simRes.json();
    res.json({ available: data.available || [] });
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:id/llm-config ───────────────────────────────────────────
app.get("/api/worlds/:id/llm-config", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/config/llm?world_id=${req.params.id}`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
    });
    res.json(await simRes.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:id/llm-config ──────────────────────────────────────────
app.post("/api/worlds/:id/llm-config", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/config/llm`, {
      method: "POST",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    res.json(await simRes.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── DELETE /api/worlds/:id/llm-config ─────────────────────────────────────────
app.delete("/api/worlds/:id/llm-config", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/config/llm`, {
      method: "DELETE",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    res.json(await simRes.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:id/llm-config/providers ─────────────────────────────────
app.post("/api/worlds/:id/llm-config/providers", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  // Session 150 — this used to return {ok:true} and store NOTHING, while the
  // panel reported "Provider URLs saved". xtts_url is now genuinely persisted,
  // to worlds.xtts_url on the simulator.
  //
  // nevoria_url and dirty_muse_url still are not: they are LLM provider bases
  // held in the simulator's ETS at runtime, and persisting them is a larger
  // change than this. They keep the previous behaviour rather than being
  // silently dropped — but the panel now says which of the three actually
  // survives a restart, instead of implying all of them do.
  const { xtts_url } = req.body || {};
  let xttsSaved = false;

  if (typeof xtts_url === "string") {
    try {
      const simRes = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.id}/xtts`, {
        method: "POST",
        headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ xtts_url }),
      });
      xttsSaved = simRes.ok;
    } catch {
      return res.status(502).json({ error: "simulator unreachable" });
    }
  }

  res.json({ ok: true, xtts_saved: xttsSaved });
});

// ── GET /api/worlds/:id/xtts ─────────────────────────────────────────────────
app.get("/api/worlds/:id/xtts", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.id}/xtts`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
    });
    res.json(await simRes.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/keys ─────────────────────────────────────────────────────────────
app.get("/api/keys", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const keys = db.prepare(`SELECT id, name, world_id, key_prefix, scopes, last_used_at, inserted_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY inserted_at DESC`).all(user.id);
  res.json(keys.map(k => ({ ...k, scopes: JSON.parse(k.scopes) })));
});

// Session 164: API keys used to be minted permanent - expires_at was written
// by no code path and enforced by none, so a key was a password that never
// aged out. Default TTL, overridable per key and by env.
const API_KEY_TTL_DAYS = Number(process.env.API_KEY_TTL_DAYS || 90);

// The complete scope vocabulary. apiKeyRequiredScope() below only ever asks for
// these seven, so a key carrying anything else carries a string that authorises
// nothing while reading, in the UI and in `GET /api/keys`, as though it did.
const API_KEY_ALLOWED_SCOPES = new Set([
  "messages:read", "messages:write", "contacts:read",
  "calendar:read", "feed:read", "world:read", "world:control",
]);

// ── POST /api/keys  { name, world_id, scopes[] } ──────────────────────────────
app.post("/api/keys", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const { name, world_id, scopes, expires_in_days } = req.body;
  const ttlDays = Number(expires_in_days) > 0 ? Number(expires_in_days) : API_KEY_TTL_DAYS;
  const ttlModifier = `+${ttlDays} days`;
  if (!name || !world_id || !Array.isArray(scopes) || !scopes.length) return res.status(400).json({ error: "name, world_id, scopes required" });

  // Session 165 — this route used to mint a key for any world_id in the body,
  // with any strings in `scopes`, for any logged-in account. Nothing downstream
  // was breached (every /api/worlds/* route goes through requireWorld(), which
  // 404s a non-member, and apiKeyDenial() binds the key to the world it names),
  // but the api_keys row is the credential of record: it outlives the session
  // that minted it and would spring to life the moment a membership was granted
  // or a route was added that trusted authUser() without requireWorld(). Same
  // two guards POST /api/worlds/:world_id/issue-key already applies.
  const badScopes = scopes.filter(sc => !API_KEY_ALLOWED_SCOPES.has(sc));
  if (badScopes.length) return res.status(400).json({ error: `unknown scope(s): ${badScopes.join(", ")}` });
  const membership = db.prepare(`SELECT role FROM world_memberships WHERE user_id = ? AND world_id = ? LIMIT 1`).get(user.id, world_id);
  // 404, not 403, for the same reason requireWorld() does: a 403 would confirm
  // to a stranger that the world exists.
  if (!membership) return res.status(404).json({ error: "world not found" });
  const raw = `sk-an-${crypto.randomBytes(32).toString("hex")}`;
  const keyHash = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 12) + "••••••••" + raw.slice(-4);
  db.prepare(`INSERT INTO api_keys (id, user_id, world_id, name, key_hash, key_prefix, scopes, expires_at, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now'), datetime('now'))`).run(randomUUID(), user.id, world_id, name, keyHash, prefix, JSON.stringify(scopes), ttlModifier);
  res.json({ key: raw, prefix });
});

// ── DELETE /api/keys/:id ───────────────────────────────────────────────────────
app.delete("/api/keys/:id", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  db.prepare(`UPDATE api_keys SET revoked_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(req.params.id, user.id);
  res.json({ ok: true });
});

// ── GET /api/apps ─────────────────────────────────────────────────────────────
app.get("/api/apps", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const apps = db.prepare(`
    SELECT r.id, r.name, r.tool_type, r.world_id, r.actor_id, r.api_key_id, r.inserted_at,
           r.url, r.built_by, r.contact_ids, k.key_prefix, k.scopes
    FROM registered_tools r
    JOIN api_keys k ON k.id = r.api_key_id
    WHERE r.user_id = ?
    ORDER BY r.inserted_at DESC
  `).all(user.id);
  res.json(apps.map(a => ({ ...a, scopes: JSON.parse(a.scopes), contact_ids: JSON.parse(a.contact_ids || '[]') })));
});

// ── POST /api/apps  { name, tool_type, world_id, actor_id, api_key_id, url?, built_by? } ───
app.post("/api/apps", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const { name, tool_type, world_id, actor_id, api_key_id, url, built_by, contact_ids } = req.body;
  if (!name || !tool_type || !world_id || !actor_id || !api_key_id) return res.status(400).json({ error: "all fields required" });

  // Verify the api_key belongs to this user
  const key = db.prepare(`SELECT id FROM api_keys WHERE id = ? AND user_id = ? AND revoked_at IS NULL`).get(api_key_id, user.id);
  if (!key) return res.status(403).json({ error: "invalid api key" });

  // Verify the user is a member of this world with the claimed actor_id
  const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`).get(user.id, world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });
  if (membership.actor_id !== actor_id) return res.status(403).json({ error: "actor mismatch" });
  const id = randomUUID();
  db.prepare(`INSERT INTO registered_tools (id, user_id, world_id, actor_id, api_key_id, tool_type, name, url, built_by, contact_ids, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`).run(id, user.id, world_id, actor_id, api_key_id, tool_type, name, url || null, built_by || "anima", JSON.stringify(contact_ids || []));
  res.json({ id, name, tool_type, url, built_by: built_by || "anima" });
});

// ── PATCH /api/apps/:id  { contact_ids } ──────────────────────────────────────
app.patch("/api/apps/:id", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const { contact_ids } = req.body;
  if (!contact_ids) return res.status(400).json({ error: "contact_ids required" });
  db.prepare(`UPDATE registered_tools SET contact_ids = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(JSON.stringify(contact_ids), req.params.id, user.id);
  res.json({ ok: true });
});

// ── DELETE /api/apps/:id ───────────────────────────────────────────────────────
app.delete("/api/apps/:id", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  db.prepare(`DELETE FROM registered_tools WHERE id = ? AND user_id = ?`).run(req.params.id, user.id);
  res.json({ ok: true });
});

// ── POST /api/worlds/:world_id/issue-key ──────────────────────────────────────
// One key per user per world. Revokes all existing keys for this user+world,
// generates one fresh key, updates ALL registered_tools for this world to use it.
// Returns { key: raw } — client stores in localStorage as anima_world_key_${worldId}.
app.post("/api/worlds/:world_id/issue-key", (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  const user = ok.user;

  const worldId = req.params.world_id;

  // Verify membership
  const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`).get(user.id, worldId);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });

  // Revoke all existing active keys for this user+world
  db.prepare(`UPDATE api_keys SET revoked_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND world_id = ? AND revoked_at IS NULL`).run(user.id, worldId);

  // Generate one new world key
  const raw      = `sk-an-${crypto.randomBytes(32).toString("hex")}`;
  const keyHash  = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix   = raw.slice(0, 12) + "••••••••" + raw.slice(-4);
  const newKeyId = randomUUID();

  db.prepare(`INSERT INTO api_keys (id, user_id, world_id, name, key_hash, key_prefix, scopes, expires_at, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now'), datetime('now'))`).run(
    newKeyId, user.id, worldId,
    `World key — ${worldId.slice(0, 8)}`,
    keyHash, prefix,
    JSON.stringify(["messages:read", "messages:write", "contacts:read", "calendar:read"]),
    `+${API_KEY_TTL_DAYS} days`
  );

  // Wire all apps in this world to the new key
  db.prepare(`UPDATE registered_tools SET api_key_id = ?, updated_at = datetime('now') WHERE user_id = ? AND world_id = ?`).run(newKeyId, user.id, worldId);

  res.json({ key: raw, key_id: newKeyId });
});

// ── GET /api/worlds/:world_id/actors/:actor_id/contacts ───────────────────────
app.get("/api/worlds/:world_id/actors/:actor_id/contacts", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  try {
    const data = await simFetch(`/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/contacts`);
    res.json(data);
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/actors/:actor_id/messages/:contact_id ───────────
app.get("/api/worlds/:world_id/actors/:actor_id/messages/:contact_id", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  // Verify user is a member of this world with the claimed actor_id
  const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`).get(user.id, req.params.world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });
  if (membership.actor_id !== req.params.actor_id) return res.status(403).json({ error: "actor mismatch" });
  try {
    // Session 151 — reader_actor_id is what permits the simulator to mark the
    // thread read. The guard above has already established that this caller IS
    // the inbox, so marking is correct here and nowhere else; a request without
    // it reads without writing.
    const data = await simFetch(`/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/messages/${req.params.contact_id}?reader_actor_id=${encodeURIComponent(req.params.actor_id)}`);
    res.json(data);
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/actors/:actor_id/context/:contact_id ────────────
app.get("/api/worlds/:world_id/actors/:actor_id/context/:contact_id", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "unauthorized" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  try {
    const data = await simFetch(`/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/context/${req.params.contact_id}`);
    res.json(data);
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/actors/:actor_id/messages/:contact_id ──────────
app.post("/api/worlds/:world_id/actors/:actor_id/messages/:contact_id", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`).get(user.id, req.params.world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });
  if (membership.actor_id !== req.params.actor_id) return res.status(403).json({ error: "actor mismatch" });

  let visibility = "private";
  const app = db.prepare(`SELECT contact_ids FROM registered_tools WHERE user_id = ? AND world_id = ? AND tool_type != 'custom' ORDER BY inserted_at DESC LIMIT 1`).get(user.id, req.params.world_id);
  if (app) {
    const contacts = JSON.parse(app.contact_ids || "[]");
    const contact = contacts.find(c => c.id === req.params.contact_id);
    if (contact) visibility = contact.privacy || "private";
  }
  try {
    const resp = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/messages/${req.params.contact_id}`, {
      method: "POST",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ ...req.body, visibility }),
    });
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/viewer-token?world_id= ───────────────────────────────────────────
app.get("/api/viewer-token", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`
    SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')
  `).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });

  const { world_id } = req.query;
  if (!world_id) return res.status(400).json({ error: "world_id required" });

  const membership = db.prepare(`
    SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?
  `).get(user.id, world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });

  const payload = JSON.stringify({
    actor_id: membership.actor_id,
    world_id,
    exp: Math.floor(Date.now() / 1000) + 300, // 5 min TTL
  });
  const b64 = Buffer.from(payload).toString("base64url");
  const sig  = crypto.createHmac("sha256", SERVICE_TOKEN).update(b64).digest("hex");
  res.json({ token: `${b64}.${sig}` });
});

// ── Notification helpers ──────────────────────────────────────────────────────
function getAuthUser(req) {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return null;
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  return db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')`).get(hash) || null;
}

// ── GET /api/notifications ────────────────────────────────────────────────────
app.get("/api/notifications", (req, res) => {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const notifs = db.prepare(`
    SELECT id, sender_actor_id, sender_name, content, app_id, read_at, inserted_at,
           conversation_type, sender_actor_type
    FROM notifications
    WHERE user_id = ? AND cleared_at IS NULL
    ORDER BY inserted_at DESC
    LIMIT 100
  `).all(user.id);

  const CONV_TO_TOOL = {
    text_thread:   "messages",
    voice_message: "voice",
    email_thread:  "email",
    call:          "voice",
    video_call:    "video",
  };

  // Get all installed tool types for this user
  const installedTools = new Set(
    db.prepare(`SELECT DISTINCT tool_type FROM registered_tools WHERE user_id = ? AND built_by = 'anima'`).all(user.id).map(r => r.tool_type)
  );

  const enriched = notifs.map(n => ({
    ...n,
    has_app: installedTools.has(CONV_TO_TOOL[n.conversation_type] || "messages"),
  }));

  res.json(enriched);
});

// ── PATCH /api/notifications/:id/read ────────────────────────────────────────
app.patch("/api/notifications/:id/read", (req, res) => {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ? AND read_at IS NULL`).run(req.params.id, user.id);
  res.json({ ok: true });
});

// ── DELETE /api/notifications/:id ────────────────────────────────────────────
app.delete("/api/notifications/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  db.prepare(`UPDATE notifications SET cleared_at = datetime('now') WHERE id = ? AND user_id = ?`).run(req.params.id, user.id);
  res.json({ ok: true });
});

// ── DELETE /api/notifications ─────────────────────────────────────────────────
app.delete("/api/notifications", (req, res) => {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  db.prepare(`UPDATE notifications SET cleared_at = datetime('now') WHERE user_id = ? AND cleared_at IS NULL`).run(user.id);
  res.json({ ok: true });
});

// ── GET /api/pending-messages ─────────────────────────────────────────────────
// Returns count of unread inbox messages for the user's actor
app.get("/api/pending-messages", async (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ count: 0 });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')`).get(hash);
  if (!user) return res.status(401).json({ count: 0 });
  const membership = db.prepare(`SELECT actor_id, world_id FROM world_memberships WHERE user_id = ? LIMIT 1`).get(user.id);
  if (!membership) return res.json({ count: 0 });
  try {
    const data = await simFetch(`/internal/worlds/${membership.world_id}/actors/${membership.actor_id}/unread-count`);
    res.json(data);
  } catch { res.json({ count: 0 }); }
});

// ── upstream SSE reader teardown ──────────────────────────────────────────────
// Cancelling a reader whose upstream socket has already errored makes cancel()
// reject with the stream's stored error — undici's `TypeError: terminated` with
// a `SocketError: other side closed` / UND_ERR_SOCKET cause. That is the NORMAL
// shape of a browser disconnecting at the same moment the simulator restarts,
// and the read loops in the SSE proxies below already swallow the identical
// error on purpose ("client disconnected"). But cancel() returns a promise that
// nobody awaited, so the same benign condition surfaced instead as an
// [unhandledRejection] stack trace — one per connected client, per simulator
// restart (fault-triage fingerprint cb97e8f0b6fa1b91, 2026-09-11).
//
// This does NOT silence the error class: an UNEXPECTED cancel() failure is still
// logged, and is now logged with its own identifiable tag and call site instead
// of arriving anonymously at the global unhandledRejection handler. Only the
// known teardown codes — the ones the read loop already discards — are dropped.
const EXPECTED_READER_TEARDOWN_CODES = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "ECONNRESET",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ABORT_ERR",
]);
function cancelUpstreamReader(reader, where) {
  // Promise.resolve().then() also covers a synchronous throw from cancel().
  return Promise.resolve()
    .then(() => reader.cancel())
    .catch((err) => {
      const code = err?.code ?? err?.cause?.code;
      const name = err?.name ?? err?.cause?.name;
      const expected =
        EXPECTED_READER_TEARDOWN_CODES.has(code) ||
        name === "AbortError" ||
        err?.message === "terminated";
      if (expected) return;
      console.error(`[stream] ${where}: unexpected reader.cancel() failure on client teardown:`, err);
    });
}

// ── GET /api/stream — SSE proxy ───────────────────────────────────────────────
app.get("/api/stream", async (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).end();
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id, u.name FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now')`).get(hash);
  if (!user) return res.status(401).end();

  const requestedWorldId = req.query.world_id;
  const membership = requestedWorldId
    ? db.prepare(`SELECT actor_id, world_id FROM world_memberships WHERE user_id = ? AND world_id = ? LIMIT 1`).get(user.id, requestedWorldId)
    : db.prepare(`SELECT actor_id, world_id FROM world_memberships WHERE user_id = ? LIMIT 1`).get(user.id);
  if (!membership) return res.status(403).end();

  const { actor_id, world_id } = membership;

  // Load this user's contact privacy settings
  const appRow = db.prepare(`SELECT contact_ids FROM registered_tools WHERE user_id = ? AND world_id = ? AND tool_type != 'custom' ORDER BY inserted_at DESC LIMIT 1`).get(user.id, world_id);
  const contactIds = appRow ? JSON.parse(appRow.contact_ids || "[]") : [];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: "connected", actor_id })}\n\n`);

  // Connect to simulator SSE stream
  let simRes;
  try {
    simRes = await fetch(`${SIMULATOR_URL}/internal/actors/${actor_id}/stream`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
    });
  } catch {
    res.write(`data: ${JSON.stringify({ type: "error", message: "simulator unreachable" })}\n\n`);
    return res.end();
  }

  const reader = simRes.body.getReader();
  const decoder = new TextDecoder();

  req.on("close", () => { cancelUpstreamReader(reader, "GET /api/stream"); });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);

      // Parse SSE lines from simulator
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          if (payload.type === "new_message") {
            // Skip actor↔actor messages — player should not be notified of private conversations
            if (payload.sender_id !== actor_id && payload.receiver_id && payload.receiver_id !== actor_id) {
              continue;
            }

            // Conversation type → tool type mapping
            const CONV_TO_TOOL = {
              text_thread:   "messages",
              voice_message: "voice",
              email_thread:  "email",
              call:          "voice",
              video_call:    "video",
            };
            const convType = payload.conversation_type || (
              payload.message_type === "call_request"  ? "call_request"  :
              payload.message_type === "voice_message" ? "voice_message" :
              payload.message_type === "email"         ? "email_thread"  :
              "text_thread"
            );
            const toolType = CONV_TO_TOOL[convType] || "messages";

            // Check privacy
            const contact = contactIds.find(c => c.id === payload.sender_id);
            const privacy = contact?.privacy || "private";

            // Find matching installed app
            const app = db.prepare(`SELECT id FROM registered_tools WHERE user_id = ? AND world_id = ? AND tool_type = ? LIMIT 1`).get(user.id, world_id, toolType);
            const hasApp = !!app;

            // Deduplicate by message_id
            const existing = db.prepare(`SELECT id FROM notifications WHERE user_id = ? AND message_id = ? LIMIT 1`).get(user.id, payload.message_id);

            let notifId;
            if (!existing) {
              notifId = crypto.randomUUID();
              db.prepare(`INSERT OR IGNORE INTO notifications (id, user_id, world_id, sender_actor_id, sender_name, content, app_id, message_id, conversation_type, sender_actor_type, inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
                .run(notifId, user.id, world_id, payload.sender_id, payload.sender_name, payload.content, app?.id || null, payload.message_id || null, convType, payload.sender_actor_type || null);
            } else {
              notifId = existing.id;
            }

            res.write(`data: ${JSON.stringify({ ...payload, privacy, notif_id: notifId, conv_type: convType, tool_type: toolType, has_app: hasApp })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          }
        } catch { /* skip malformed lines */ }
      }
    }
  } catch { /* client disconnected */ }

  res.end();
});

// ── GET /api/actors/:id/shares ────────────────────────────────────────────────
app.get("/api/actors/:id/shares", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const shares = db.prepare(`
    SELECT s.id, s.shared_with_id, s.permission, s.inserted_at, u.name, u.email
    FROM actor_shares s JOIN users u ON u.id = s.shared_with_id
    WHERE s.actor_id = ?
    ORDER BY s.inserted_at
  `).all(req.params.id);
  res.json(shares);
});

// ── POST /api/actors/:id/shares ───────────────────────────────────────────────
// ── POST /api/actors/:id/fork — take a copy that is yours ────────────────────
//
// Session 150 — the act that transfers ownership, and the only one.
//
// "Can clone" has been offered in the share dialog since the feature existed and
// never had an implementation behind it: granting it changed a badge and nothing
// more. This is that endpoint.
//
// The copy is complete and independent — psychology, assessments, lifestyle,
// economics, education, media rows — owned by whoever forked it, editable
// without limit, and never synced back. What it is NOT is a share: the original
// keeps its own shares, and the fork starts with none.
//
// forked_from is provenance PLUS two behaviours: the clash check at deploy, and
// (session 170) the subject-authorisation lineage above — a copy inherits the
// original's declared reference set, so withdrawing authorisation on the source
// reaches every copy already taken from it. It also still answers "where did
// this character come from" months later, when nobody remembers.
// Session 170 (conduct-watch, resolution-manager) — a fork's DECLARED REFERENCE
// SET is its own actor_media rows PLUS every ancestor's, walked up forked_from.
//
// actor_media is deliberately absent from FORK_TABLES (see below), so a fork
// taken from a clean source holds zero reference rows for life — while
// glb_url / dressed_glb_url / runtime_glb_url / draft_state carry the BUILT
// LIKENESS over verbatim. All three subject-authorisation gates are predicates
// over actor_media, and a predicate over an empty set matches nothing. So a
// fork taken while the source was authorised kept sharing and deploying that
// face forever, even after the subject WITHDREW on the source (PATCH
// /api/actors/:id/media/authorisation writes 'no' on the source's rows only).
// Withdrawal reached the original and none of its copies.
//
// Fixed by resolving the gate against the ancestry instead of copying media.
// The alternative — carrying the world_id IS NULL rows into the fork — was
// rejected twice over: it aliases the source's media URLs into another
// account and couples the fork to the source's file lifecycle (see the
// resolved orphan-media-sweep incident), AND it does not actually close this
// finding, because the copied rows would be frozen at fork time and a later
// withdrawal on the source would still not reach them.
//
// UNION along the chain, not "only when the fork has no rows of its own": the
// latter is switched off by uploading any single unrelated photo to the fork,
// and a gate a user can disable by uploading a file is not a gate.
//
// This makes forked_from carry behaviour. It already did — the clash check at
// deploy — and the comment below has been corrected to say so.
const SUBJECT_LINEAGE_MAX_DEPTH = 16;
function subjectLineageIds(actorId) {
  const ids = [];
  let cur = actorId;
  for (let i = 0; cur && i < SUBJECT_LINEAGE_MAX_DEPTH; i++) {
    if (ids.includes(cur)) break;              // forked_from is a tree, but never trust it to be
    ids.push(cur);
    let row = null;
    try { row = db.prepare(`SELECT forked_from FROM actors WHERE id = ?`).get(cur); }
    catch { break; }
    cur = row && row.forked_from ? row.forked_from : null;
  }
  return ids;
}
// Returns the offending row ({ actor_id, state_slug, reason }) or null, walked
// over the whole fork ancestry rather than one actor id.
//
// 2026-09-11 (conduct-watch, resolution-manager) — WIDENED to catch a BLANK
// declaration as well as an unauthorised declared-'other' one. Until now every
// EGRESS gate matched depicts='other' only, while the BUILD gates in
// generate3d.js refused a blank explicitly ('a blank must never read as a
// declaration nobody made'). A NULL/'' depicts therefore fell out of this
// predicate and share, share link, publish, deploy and fork all passed: the
// system refused to BUILD a likeness from photographs that say nothing about
// whose likeness it is, and then let the thing it had already built walk out of
// the box, reference media and all. Stricter inside than outside is backwards.
// Both sides now ask the same question.
//
// `reason` says WHICH question is unanswered so the refusal can ask the right
// one: 'undeclared' → nobody has said who is in these photographs;
// 'unauthorised' → they are declared to be of somebody else and that person has
// not agreed (or has withdrawn). When both are present 'undeclared' is reported
// first — it is the earlier question, and PATCH /api/actors/:id/media/depicts
// (owner-only, rewrites the whole world_id IS NULL set) is the route that
// clears it, exactly as the build gates' `needs: "depicts"` already assumes.
// A 'self' declaration passes here, unchanged.
function unauthorisedSubjectInLineage(actorId) {
  for (const id of subjectLineageIds(actorId)) {
    const row = db.prepare(
      `SELECT actor_id, state_slug, media_type,
              CASE WHEN depicts IS NULL OR depicts = '' THEN 'undeclared' ELSE 'unauthorised' END AS reason
         FROM actor_media
        WHERE actor_id = ? AND media_type IN ('photo','audio') AND world_id IS NULL
          AND ( depicts IS NULL OR depicts = ''
                OR (depicts = 'other' AND (subject_authorised IS NULL OR subject_authorised != 'yes')) )
        ORDER BY CASE WHEN depicts IS NULL OR depicts = '' THEN 0 ELSE 1 END
        LIMIT 1`
    ).get(id);
    if (row) return row;
  }
  return null;
}
// Which field the caller must fill in to clear the refusal above. Mirrors the
// build gates in generate3d.js, which answer `needs: "depicts"` for a blank and
// `needs: "subject_authorised"` for an unauthorised 'other'.
function subjectRefusalNeeds(hit) {
  return hit && hit.reason === "undeclared" ? "depicts" : "subject_authorised";
}
// A refusal the user cannot clear is worse than no refusal at all, so an
// ancestor hit says so plainly: the fork's owner does not own the source's
// actor_media and has no UI path to PATCH it.
//
// 2026-09-11 (conduct-watch, resolution-manager) -- A RECORDED VOICE IS A
// LIKENESS, so the gate above now matches reference AUDIO too, and a refusal
// about a voice sample must not tell the owner it is about a photograph. The
// sentences below were written about photographs; rather than fork four of
// them, the audio case restates the same sentence in the right noun.
function subjectRefusalText(hit, actorId, who, verb) {
  const t = subjectRefusalTextPhoto(hit, actorId, who, verb);
  if (!hit || hit.media_type !== "audio") return t;
  return t
    .replace(/reference photographs/g, "reference voice recordings")
    .replace(/photographs/g, "voice recordings")
    .replace(/photograph/g, "voice recording");
}
function subjectRefusalTextPhoto(hit, actorId, who, verb) {
  const gerund = verb === "shared" ? "sharing" : verb === "copied" ? "taking a copy of" : "deploying";
  // 2026-09-11 — a blank declaration and a withheld authorisation are different
  // unanswered questions and must not be reported with the same sentence. A
  // person told to "record that they authorised the likeness" when in fact
  // nobody has yet said whose likeness it is has been sent to the wrong control.
  const undeclared = hit && hit.reason === "undeclared";
  if (hit && hit.actor_id !== actorId) {
    if (undeclared) {
      return `${who} was copied from a character built from photographs that carry no statement of whose likeness they are. This copy carries the same likeness, so it cannot be ${verb}. Ask the original's owner to say who is in those photographs, or rebuild this character from your own reference photographs.`;
    }
    return `${who} was copied from a character built from photographs of somebody else, and that person's authorisation has been withdrawn on the original. This copy carries the same likeness, so it cannot be ${verb}. Ask the original's owner to record authorisation again, or rebuild this character from your own reference photographs.`;
  }
  if (undeclared) {
    return `${who} is built from reference photographs that do not say whose likeness they are. Say who is in the reference photographs before ${gerund} it.`;
  }
  return `${who} is built from photographs declared to be of somebody else. Record that they authorised the likeness before ${gerund} it.`;
}

const FORK_TABLES = [
  "actor_psychology", "actor_big5", "actor_disc", "actor_hds",
  "actor_lifestyle", "actor_economic", "actor_mental_health",
  "actor_upbringing", "actor_education", "actor_diagnoses",
  "actor_expense_defaults", "actor_assessment_results",
];

app.post("/api/actors/:id/fork", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const acc = hasAccess(req.params.id, user, "copy");
  if (!acc) {
    const any = actorAccess(req.params.id, user);
    if (!any) return res.status(404).json({ error: "not found" });
    return res.status(403).json({ error: `You have "${any.level}" on this character. Forking needs "copy".` });
  }

  const src = db.prepare(`SELECT * FROM actors WHERE id = ?`).get(req.params.id);
  if (!src) return res.status(404).json({ error: "not found" });

  // Session 158 (conduct-watch, resolution-manager) — fork is the FOURTH egress,
  // and it is the one that made the other three silent.
  //
  // The copy below takes every actors column except a short exclusion list, so
  // draft_state (the referenceMeasurements solve) and glb_url / dressed_glb_url /
  // runtime_glb_url carry the BUILT LIKENESS over verbatim — while actor_media is
  // deliberately absent from FORK_TABLES, so the copy holds zero reference rows.
  // All three existing subject-authorisation gates (the 3D solve in generate3d.js,
  // the shares route below, the deploy route) are predicates over actor_media, and
  // a predicate over an empty set matches nothing: fork an actor whose references
  // are declared to be of somebody else and the copy shares and deploys with every
  // gate silent, still wearing the original's face.
  //
  // Forking is itself an egress — it hands ownership to whoever forked, and the
  // original owner never sees the copy again — so it takes the same gate as
  // sharing, applied to the SOURCE actor, where the declaration actually lives.
  //
  // Same predicate as the shares and deploy routes, deliberately: scoped to the
  // declared reference set (world_id IS NULL) and to declared-'other' rows only,
  // so actors with no declaration — every actor predating the depicts column —
  // fork exactly as before.
  //
  // Evaluated over the SOURCE's whole fork ancestry (session 170), so forking a
  // fork cannot launder a withdrawal that landed further up the chain.
  const unauthorisedSubject = unauthorisedSubjectInLineage(req.params.id);
  if (unauthorisedSubject) {
    return res.status(403).json({
      error: subjectRefusalText(unauthorisedSubject, req.params.id, src.first_name || src.name || "This character", "copied") + " Nothing was copied.",
      needs: subjectRefusalNeeds(unauthorisedSubject),
    });
  }

  const newId = randomUUID();
  const now = new Date().toISOString();
  const suffix = (req.body?.name_suffix ?? " (copy)");

  const tx = db.transaction(() => {
    // Columns are read from the source row rather than listed, so a migration
    // that adds a column does not silently stop being copied.
    const cols = Object.keys(src).filter(c => ![
      "id", "owner_id", "inserted_at", "updated_at", "forked_from",
      "media_folder", "status",
    ].includes(c));

    db.prepare(
      `INSERT INTO actors (id, owner_id, forked_from, status, media_folder, inserted_at, updated_at, ${cols.join(", ")})
       VALUES (?,?,?,?,?,?,?,${cols.map(() => "?").join(",")})`
    ).run(newId, user.id, src.id, "ready_to_deploy", `fork-${newId.slice(0, 8)}`, now, now,
          ...cols.map(c => src[c]));

    // The fork gets its own name so two identical entries never sit side by side
    // in a gallery with no way to tell them apart.
    if (suffix) {
      db.prepare(`UPDATE actors SET name = ?, updated_at = ? WHERE id = ?`)
        .run(`${src.name}${suffix}`, now, newId);
    }

    for (const t of FORK_TABLES) {
      let rows = [];
      try { rows = db.prepare(`SELECT * FROM ${t} WHERE actor_id = ?`).all(req.params.id); }
      catch { continue; }                       // table absent in this schema
      for (const row of rows) {
        const keys = Object.keys(row).filter(k => k !== "actor_id");
        const vals = keys.map(k => (k === "id" ? randomUUID() : row[k]));
        try {
          db.prepare(`INSERT INTO ${t} (actor_id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(",")})`)
            .run(newId, ...vals);
        } catch { /* a row that will not copy is not worth failing the fork over */ }
      }
    }
  });

  try { tx(); }
  catch (e) { return res.status(500).json({ error: `Fork failed: ${e.message}` }); }

  const made = db.prepare(`SELECT id, name, status, forked_from FROM actors WHERE id = ?`).get(newId);
  res.json({ ok: true, ...made });
});

app.post("/api/actors/:id/shares", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  // Session 150 — the creator can always share. Anyone else needs the re-share
  // flag on their own share, and can never grant more than they hold: a `use`
  // holder passing the character on cannot hand out `copy`.
  const mine = actorAccess(req.params.id, user);
  if (!mine) return res.status(404).json({ error: "not found" });
  if (mine.level !== "owner" && !mine.can_reshare) {
    return res.status(403).json({ error: "You don't have permission to share this character on." });
  }

  const { email, permission = "read", can_reshare = false } = req.body;
  if (!["read", "use", "copy"].includes(permission)) {
    return res.status(400).json({ error: `permission must be read, use or copy` });
  }
  if (mine.level !== "owner" && ACCESS_RANK[permission] > ACCESS_RANK[mine.level]) {
    return res.status(403).json({ error: `You only have "${mine.level}" on this character, so you cannot grant "${permission}".` });
  }
  if (!email) return res.status(400).json({ error: "email required" });
  // Same-org only — see the world-members lookup for why an unscoped email
  // search is both a cross-tenant hole and an account-existence oracle.
  const target = db.prepare(`SELECT u.id, u.name FROM users u JOIN memberships m ON m.user_id = u.id AND m.org_id = ?
                             WHERE u.email = ?`)
    .get(user.org_id, email);
  if (!target) return res.status(404).json({ error: "user not found" });
  if (target.id === user.id) return res.status(400).json({ error: "cannot share with yourself" });
  // Building an unauthorised likeness of a real person is contained while it
  // stays in one account; sharing it is the step that stops being contained.
  // Same gate as the 3D solve, at the other end of the pipeline: a reference
  // set the owner has declared is of somebody else does not leave the account
  // until the record says that person agreed. Scoped to declared-'other' rows
  // only, so actors with no declaration (every actor that predates the depicts
  // column) share exactly as before.
  // Session 170 — over the whole fork ancestry, so a copy stops sharing when the
  // subject withdraws on the original it was taken from.
  const unauthorised = unauthorisedSubjectInLineage(req.params.id);
  if (unauthorised) {
    return res.status(403).json({
      error: subjectRefusalText(unauthorised, req.params.id, "This character", "shared"),
      needs: subjectRefusalNeeds(unauthorised),
    });
  }
  const now = new Date().toISOString();
  try {
    // owner_id records the CREATOR, not whoever performed the share — otherwise a
    // re-share would quietly reassign the character's origin.
    db.prepare(`INSERT INTO actor_shares (id, actor_id, owner_id, shared_with_id, shared_with_type, permission, can_reshare, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), req.params.id, mine.owner_id, target.id, "user", permission, can_reshare ? 1 : 0, now, now);
    res.json({ ok: true, name: target.name, shared_with_id: target.id, permission, can_reshare: !!can_reshare });
  } catch (e) {
    if (e.message?.includes("UNIQUE")) return res.status(409).json({ error: "already shared" });
    throw e;
  }
});

// ── DELETE /api/actors/:id/shares/:shared_with_id ─────────────────────────────
app.delete("/api/actors/:id/shares/:shared_with_id", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  db.prepare(`DELETE FROM actor_shares WHERE actor_id = ? AND shared_with_id = ? AND owner_id = ?`)
    .run(req.params.id, req.params.shared_with_id, user.id);
  res.json({ ok: true });
});

// ── Update actors gallery to include shared actors ────────────────────────────
app.get("/api/actors/shared", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actors = db.prepare(`
    SELECT a.id, a.name, a.age, a.gender, a.occupation, a.status,
           p.attachment_style, b.openness, b.neuroticism, s.permission, s.can_reshare, a.forked_from,
           (SELECT url FROM actor_media WHERE actor_id = a.id AND media_type = 'photo' AND state_slug IN ('photo_close','profile') LIMIT 1) as photo_url,
           -- Session 151 -- same summary as GET /api/actors, and for the same reason:
           -- the build and egress gates evaluate the whole fork ancestry, not the
           -- owner, so a RECIPIENT of a shared character meets the identical wall of
           -- 403s. The card is shared between both lists, so it needs the field on both.
           -- 2026-09-11 (conduct-watch) -- widened alongside the gates to report
           -- 'undeclared': a reference photograph carrying NO depicts at all now
           -- refuses build AND egress, so the card has to be able to say so.
           -- Reported ahead of 'no'/'pending' because it is the earlier question.
           (SELECT CASE
                     WHEN COUNT(*) = 0 THEN NULL
                     WHEN SUM(CASE WHEN depicts IS NULL OR depicts = '' THEN 1 ELSE 0 END) > 0 THEN 'undeclared'
                     WHEN SUM(CASE WHEN subject_authorised = 'no'  THEN 1 ELSE 0 END) > 0 THEN 'no'
                     WHEN SUM(CASE WHEN subject_authorised = 'yes' THEN 1 ELSE 0 END) = COUNT(*) THEN 'yes'
                     ELSE 'pending'
                   END
              FROM actor_media
             WHERE actor_id = a.id AND media_type IN ('photo','audio') AND world_id IS NULL
               AND (depicts IS NULL OR depicts = '' OR depicts = 'other')) as subject_authorisation,
           -- 2026-09-09 (conduct-watch) -- how many worlds she is STILL IN after the
           -- subject withdrew authorisation, derived exactly as the editor's standing
           -- banner derives it. Normally 0. Anything above 0 is a likeness the subject
           -- said no to that is still running inside a simulator world, and a list of
           -- cards is the only surface seen without opening anything. On BOTH lists for
           -- the same reason the line above is: the card component is shared.
           (SELECT COUNT(*) FROM actor_deployments d
             WHERE d.platform_actor_id = a.id AND d.undeployed_at IS NULL
               AND EXISTS (SELECT 1 FROM actor_media m
                            WHERE m.actor_id = a.id AND m.media_type IN ('photo','audio')
                              AND m.world_id IS NULL AND m.depicts = 'other'
                              AND m.subject_authorised = 'no')) as withdrawal_still_deployed
    FROM actor_shares s
    JOIN actors a ON a.id = s.actor_id
    LEFT JOIN actor_psychology p ON p.actor_id = a.id
    LEFT JOIN actor_big5 b ON b.actor_id = a.id
    WHERE s.shared_with_id = ?
    ORDER BY a.name
  `).all(user.id);
  res.json(actors);
});
// ── POST /api/actors/:id/media — upload tagged photo ─────────────────────────
app.post("/api/actors/:id/media", upload.fields([{name:"photo",maxCount:1},{name:"audio",maxCount:1}]), async (req, res) => {
  const user = authUser(req);
  console.log("[media upload] actor:", req.params.id, "user:", user?.id, "files:", Object.keys(req.files||{}), "body:", req.body);
  if (!user) { console.error("[media upload] unauthorized"); return res.status(401).json({ error: "unauthorized" }); }

  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  console.log("[media upload] actor lookup:", actor ? "found" : "NOT FOUND", "owner check:", req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });

  const req_file = req.files?.photo?.[0] || req.files?.audio?.[0] || req.file;
  if (!req_file) return res.status(400).json({ error: "no file uploaded" });

  const state_slug = req.body.state_slug || "profile";
  const media_type = req.body.media_type || "photo";
  const isAudio    = req_file.mimetype?.startsWith("audio/") || req_file.originalname?.endsWith(".mp3");
  const ext        = path.extname(req_file.originalname || (isAudio ? "reference.mp3" : "photo.jpg")) || (isAudio ? ".mp3" : ".jpg");
  const filename   = `${state_slug}${ext}`;
  // Use name-based slug for media path to avoid ngrok UUID caching issues
  const actorSlug  = (() => {
    const a = db.prepare(`SELECT name FROM actors WHERE id = ?`).get(req.params.id);
    if (!a?.name) return req.params.id;
    return a.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") + "-" + req.params.id.slice(0,8);
  })();
  const world_id   = req.body.world_id || null;
  const isVideo = req_file.mimetype.startsWith("video/") || filename.endsWith(".mp4");

  // The uploader's own statement of whose likeness this photograph carries.
  // Whitelisted and never defaulted: anything absent or unrecognised stores
  // NULL, which reads as "not declared" instead of as an answer nobody gave.
  const depicts = ["self", "other"].includes(req.body.depicts) ? req.body.depicts : null;

  // 2026-09-11 (conduct-watch, resolution-manager) — the same rule as the PATCH
  // depicts handler below, because this route is the second way to restate the
  // declaration: the write at the bottom DELETEs the row for this slot and
  // INSERTs a fresh one, so before today a re-upload of the same slot dropped
  // that row's subject_authorised on the floor, and a re-upload of every slot
  // erased a recorded 'no' from the reference set entirely. Replacing a
  // photograph is not an answer to whether the person in it agreed.
  const uploadWithdrawal = (!world_id && (media_type === "photo" || media_type === "audio" || isAudio))
    ? db.prepare(
        `SELECT 1 FROM actor_media
          WHERE actor_id = ? AND media_type IN ('photo','audio') AND world_id IS NULL
            AND subject_authorised = 'no' LIMIT 1`
      ).get(req.params.id)
    : null;
  if (uploadWithdrawal && depicts === "self") {
    console.warn(`[media upload] REFUSED actor: ${req.params.id} user: ${user.id} depicts=self: subject_authorised='no' stands on this reference set`);
    return res.status(403).json({
      error: "These reference photographs carry a withdrawal: the person in them is recorded as having refused. A new photograph cannot be declared as being of you while that refusal stands. If they have agreed again — or the refusal was recorded by mistake — record that on the authorisation question first.",
      needs: "subject_authorised",
      subject_authorised: "no",
    });
  }

  // Photos/audio: stored under /media/actors/{slug}/worlds/{world_id}/ when world-specific
  // This avoids the nginx proxy rule which intercepts /media/worlds/ and sends to simulator
  // Videos: stored at /media/worlds/{world_id}/actors/{slug}/ (nginx proxies missing ones to simulator)
  const mediaBase = isVideo && world_id
    ? path.join(__dirname, `../public/media/worlds/${world_id}/actors`, actorSlug)
    : world_id
      ? path.join(__dirname, "../public/media/actors", actorSlug, "worlds", world_id)
      : path.join(__dirname, "../public/media/actors", actorSlug);
  const actorDir = path.join(mediaBase, "images");

  const { mkdirSync, writeFileSync } = await import("fs");
  mkdirSync(actorDir, { recursive: true });
  const fileDir = isAudio ? path.join(mediaBase, "voice") : actorDir;
  mkdirSync(fileDir, { recursive: true });
  writeFileSync(path.join(fileDir, filename), req_file.buffer);

  // Generate 200px thumbnail for images only
  if (!isVideo && !isAudio) {
    try {
      const sharp = (await import("sharp")).default;
      const thumbName = `thumb_${filename.replace(/\.\w+$/, ".jpg")}`;
      await sharp(req_file.buffer).resize(200, 200, { fit:"cover" }).jpeg({ quality:82 }).toFile(path.join(actorDir, thumbName));
    } catch {}
  }

  const urlBase = (isVideo && world_id)
    ? `/media/worlds/${world_id}/actors/${actorSlug}`
    : world_id
      ? `/media/actors/${actorSlug}/worlds/${world_id}`
      : `/media/actors/${actorSlug}`;
  const relUrl = isAudio ? `${urlBase}/voice/${filename}` : `${urlBase}/images/${filename}`;
  const url = relUrl;
  const now = new Date().toISOString();
  const id  = randomUUID();

  // The row this upload replaces, read BEFORE the delete: what the subject said
  // about these photographs has to survive the file being swapped (see the
  // withdrawal note above). subject_authorised is carried across unconditionally
  // — it is a statement by the person in the photographs and no upload is an
  // answer to it. `depicts` is carried across ONLY while a withdrawal stands, and
  // only when this upload does not state one: that keeps the replaced row inside
  // the `depicts = 'other'` scope that every gate and the unenforced-withdrawal
  // sweep read, so re-uploading the set cannot blank the declaration the 'no' is
  // attached to and make the withdrawal invisible. Outside that case a blank stays
  // blank, which is the fail-safe the 2026-09-11 blank-depicts branch relies on.
  const replacedRow = db.prepare(
    // id/filename are read purely so the [media removed] line below can name the
    // specific photograph this upload destroys (conduct-watch, 2026-09-11).
    `SELECT id, filename, depicts, subject_authorised FROM actor_media
      WHERE actor_id = ? AND state_slug = ? AND media_type = ?
        AND (world_id = ? OR (world_id IS NULL AND ? IS NULL)) LIMIT 1`
  ).get(req.params.id, state_slug, media_type, world_id, world_id);
  const depictsToStore = depicts
    ?? (uploadWithdrawal ? (replacedRow?.depicts ?? null) : null);
  const authorisedToStore = replacedRow?.subject_authorised ?? null;

  // 2026-09-11 (conduct-watch, resolution-manager) -- THE CLEARING STAYS, THE
  // SILENCE GOES.
  //
  // Outside a standing withdrawal the line above deliberately drops the
  // replaced row's declaration: "a different photograph is a different
  // question" (the PUT /api/actors/:id photo swap below says it in those
  // words), and db.js says of this column that it is NEVER inferred, because a
  // guessed 'self' reads later as evidence somebody gave that answer. Carrying
  // a 'self' forward onto a file nobody has looked at would be exactly that
  // guess, so it is not done here.
  //
  // What WAS wrong is that the drop destroyed the answer outright and said
  // nothing. Afterwards the row was indistinguishable from one nobody was ever
  // asked about, the editor re-raised "Declaration needed" with no explanation
  // of where the answer went, and conduct-watch signal 4 -- a predicate over
  // exactly this column -- read the blank as "never asked". So the previous
  // answer is now RECORDED on the replacement row (never re-asserted: depicts
  // itself stays NULL and no gate reads these two columns), the clearing is
  // logged, and the response carries it so the UI can say what happened.
  const clearedFrom = (!depicts && replacedRow?.depicts && !depictsToStore)
    ? replacedRow.depicts : null;
  const clearedAt = clearedFrom ? now : null;
  if (clearedFrom) {
    console.warn(`[media upload] depicts CLEARED by replace actor: ${req.params.id} user: ${user.id} slot: ${state_slug} was: ${clearedFrom} -- the new photograph carries no declaration and the build/egress gates refuse until it is answered again`);
  }

  // conduct-watch, 2026-09-11: this DELETE destroys a reference photograph and,
  // until now, said so in the journal only in the narrow case where it also
  // cleared a depicts answer (the warning just above). The actor_media_delete_audit
  // trigger in db.js freezes the ROW; a trigger cannot see the CALLER, and the
  // finding was specifically that a create-and-remove cycle left no attributable
  // trace. Records only -- nothing here can make the upload fail.
  if (replacedRow) {
    console.log(`[media removed] by replace actor: ${req.params.id} user: ${user.id} media: ${replacedRow.id} slot: ${state_slug} type: ${media_type} depicts: ${replacedRow.depicts ?? "unset"} subject_authorised: ${replacedRow.subject_authorised ?? "unset"} file: ${replacedRow.filename}`);
  }

  db.prepare(`DELETE FROM actor_media WHERE actor_id = ? AND state_slug = ? AND media_type = ? AND (world_id = ? OR (world_id IS NULL AND ? IS NULL))`)
    .run(req.params.id, state_slug, media_type, world_id, world_id);
  db.prepare(`INSERT INTO actor_media (id, actor_id, world_id, media_type, filename, url, state_slug, depicts, subject_authorised, depicts_cleared_from, depicts_cleared_at, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.params.id, world_id, media_type, filename, url, state_slug, depictsToStore, authorisedToStore, clearedFrom, clearedAt, now, now);

  res.json({ id, url, state_slug, media_type, filename, depicts: depictsToStore, subject_authorised: authorisedToStore, depicts_cleared_from: clearedFrom, depicts_cleared_at: clearedAt });
});

// ── PATCH /api/actors/:id/media/depicts ─ declare whose likeness these are ──
// Session 168 gave the wizard the ability to ASK who is in the reference
// photographs but only the ability to answer it ON an upload. handleSlotFile
// POSTs a photograph the instant the file is picked, and the question is
// normally answered afterwards, so in the ordinary ordering the answer landed
// nowhere at all — which is why actor_media.depicts was NULL on every row on
// the system despite both the column and the select existing. The declaration
// is about the person in the photographs, not about one file, so it applies to
// the actor's whole non-world reference set.
app.patch("/api/actors/:id/media/depicts", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  // Same whitelist as the upload path and for the same reason: only a value
  // somebody actually stated may be stored. Nothing here can write NULL —
  // clearing a declaration is deliberately not offered, because a silent clear
  // would read later as "never asked" rather than as "withdrawn".
  const depicts = ["self", "other"].includes(req.body?.depicts) ? req.body.depicts : null;
  if (!depicts) return res.status(400).json({ error: "depicts must be 'self' or 'other'" });

  // 2026-09-11 (conduct-watch, resolution-manager) — A WITHDRAWAL MUST NOT BE
  // CLEARABLE BY RESTATING WHO IS IN THE PHOTOGRAPH.
  //
  // The UPDATE below rewrites the whole non-world reference set with no
  // condition on the current value. Every build and egress gate on the platform
  // is a predicate over `depicts = 'other'` (generate3d.js solve / runtime-glb /
  // save-morphed-glb, unauthorisedSubjectInLineage above for fork/deploy/shares/
  // build, sharelinks-routes.js link/publish), and so is the unenforced-
  // withdrawal surface (unenforcedWithdrawalWorlds / actorsWithUnenforcedWithdrawal
  // below). So an owner whose subject had recorded subject_authorised='no' could
  // PATCH depicts='self' here and every one of those predicates would stop
  // matching at once: the 'no' would still be sitting in the column, read by
  // nothing, and the character would build, fork, deploy, share, link and publish
  // again — with the standing banner gone too, because the sweep stopped seeing
  // her. The declaration is owner-only and the subject has no account, so the
  // person whose likeness it is could not undo it.
  //
  // The refusal is deliberately NOT scoped to the current `depicts` value: a 'no'
  // recorded anywhere in this reference set is a refusal by the person in these
  // photographs, and re-declaring the set is not the control that answers it.
  // PATCH /api/actors/:id/media/authorisation is — recording 'yes' again is an
  // explicit, logged statement that they agreed, which is exactly the act that
  // should be required, rather than a side effect of restating who they are.
  //
  // A NULL/'' (never asked) or 'yes' authorisation is untouched by this and stays
  // freely re-declarable, because that really is just correcting a mis-declaration.
  const standingWithdrawal = db.prepare(
    `SELECT 1 FROM actor_media
      WHERE actor_id = ? AND media_type IN ('photo','audio') AND world_id IS NULL
        AND subject_authorised = 'no' LIMIT 1`
  ).get(req.params.id);
  if (standingWithdrawal && depicts !== "other") {
    console.warn(`[media depicts] REFUSED actor: ${req.params.id} user: ${user.id} -> ${depicts}: subject_authorised='no' stands on this reference set`);
    return res.status(403).json({
      error: "These reference photographs carry a withdrawal: the person in them is recorded as having refused. Saying they are of you instead would not undo that, so it cannot be re-declared while the refusal stands. If they have agreed again — or the refusal was recorded by mistake — record that on the authorisation question first.",
      needs: "subject_authorised",
      subject_authorised: "no",
    });
  }

  // 2026-09-11 (conduct-watch, resolution-manager) -- A RE-DECLARATION DISPLACES
  // AN ANSWER, AND THE DISPLACED ANSWER IS NOW RECORDED.
  //
  // This UPDATE used to leave nothing behind but a bumped updated_at. The value
  // a person had previously stated about a real named person's photographs was
  // overwritten in place, and afterwards nothing on this host could say what it
  // had been -- measured live on 2026-09-11, four rows carrying a standing
  // consent flag re-declared at 05:45:38Z with depicts_cleared_from NULL on all
  // four. Had the new value been 'self', every gate predicate would have stopped
  // matching at once and the record would not have said why.
  //
  // depicts_cleared_from/_at already hold exactly this fact one path over (a
  // photograph replaced by upload) and are read by NO gate -- they are a RECORD,
  // never a declaration. So the row's own prior value goes into them whenever it
  // was a real answer and this PATCH displaces it with a different one. The CASE
  // expressions read the row's pre-UPDATE values, which is what keeps this a
  // single statement over the whole reference set. The editor's "this question
  // came back" notice is scoped to rows with NO current declaration, so a row
  // re-declared here is not touched by carrying the record onto it.
  //
  // The durable half of this lives in server/db.js: actor_media carries AFTER
  // UPDATE / AFTER DELETE triggers writing actor_media_audit, so a change or a
  // removal by ANY path -- including one that never comes through this handler --
  // is recorded with its before and its after.
  const now = new Date().toISOString();
  const r = db.prepare(
    `UPDATE actor_media
        SET depicts_cleared_from = CASE WHEN COALESCE(depicts, '') <> '' AND depicts <> ?
                                        THEN depicts ELSE depicts_cleared_from END,
            depicts_cleared_at   = CASE WHEN COALESCE(depicts, '') <> '' AND depicts <> ?
                                        THEN ?      ELSE depicts_cleared_at   END,
            depicts    = ?,
            updated_at = ?
      WHERE actor_id = ? AND media_type IN ('photo','audio') AND world_id IS NULL`
  ).run(depicts, depicts, now, depicts, now, req.params.id);
  console.log(`[media depicts] actor: ${req.params.id} user: ${user.id} -> ${depicts} (${r.changes} row(s))`);
  res.json({ ok: true, depicts, updated: r.changes });
});

// ── Withdrawal is retroactive ───────────────────────────────────────────────
//
// conduct-watch, 2026-09-09: PATCH /api/actors/:id/media/authorisation wrote
// subject_authorised='no' across the reference set and returned. It touched
// nothing else. All nine read-back gates (generate3d.js solve / runtime-glb /
// save-morphed-glb / runtime-read, index.js fork / deploy, sharelinks-routes.js
// shares / link / publish) are PROSPECTIVE — they refuse the NEXT act. So after
// the subject said no, the likeness stayed listed in the gallery for every
// signed-in account, every live share link stayed redeemable, every claim
// already taken stayed granted, and she stayed standing in whatever simulator
// world she had been deployed to, with her reference media already shipped
// there over the LAN at deploy time.
//
// A refusal that only binds the future is not a refusal. Withdrawal now sweeps
// what was already granted.
//
// Split in two on purpose:
//   * The three platform-local surfaces (listing, links, claims) are swept in
//     ONE transaction against local SQLite. They cannot fail on a network and
//     they are what actually matters — they are the surfaces a stranger can
//     reach right now.
//   * The simulator arm is best-effort PER DEPLOYMENT, because an undeploy is a
//     round-trip to another host. The withdrawal itself must never fail because
//     the simulator is down: a subject saying no and getting a 502 is the worst
//     available outcome. When the simulator does not confirm the erase, the
//     deployment row is left LIVE and completely untouched — the same rule
//     POST /api/actors/:id/undeploy already enforces, and for the same reason
//     (recording her as undeployed when she is not is worse than failing) — and
//     the response names the worlds that still hold her so the caller knows.
//
// Deliberately wider than the actor named in the request. subjectLineageIds()
// walks UP forked_from, so the gates on a copy already read an ancestor's 'no'
// and the copy can no longer be built, deployed, shared or published. But the
// copy's OWN already-granted egress lives on the copy's own rows, and nothing
// walked down to it. So the sweep walks DOWN as well: every actor whose gate
// now reads 'no' gets the same revocation, including copies held by other
// accounts. That crosses ownership on purpose — the declaration is about the
// person in the photographs, not about one account's copy of them, and a
// refusal that stops at the account boundary is trivially defeated by forking
// first and withdrawing second.
//
// One-way. Setting 'yes' again re-opens the gates but restores nothing: a
// listing, a link and a claim are each their own fresh act by their own author.
function subjectDescendantIds(actorId) {
  const ids = [actorId];
  let frontier = [actorId];
  // forked_from is a tree, but never trust it to be — bound the walk exactly
  // the way subjectLineageIds() bounds its walk upward.
  for (let depth = 0; depth < 32 && frontier.length; depth++) {
    let kids = [];
    try {
      kids = db.prepare(
        `SELECT id FROM actors WHERE forked_from IN (${frontier.map(() => "?").join(",")})`
      ).all(...frontier).map(r => r.id).filter(id => !ids.includes(id));
    } catch (e) {
      console.warn("[authorisation withdrawn] descendant walk failed:", e.message);
      break;
    }
    ids.push(...kids);
    frontier = kids;
  }
  return ids;
}

async function revokeGrantedEgressOnWithdrawal(actorIds, now) {
  const summary = {
    actors: actorIds, unpublished: 0, links_revoked: 0, claims_revoked: 0,
    undeployed: [], still_deployed: [],
  };
  const inList = actorIds.map(() => "?").join(",");

  db.transaction(() => {
    summary.unpublished = db.prepare(
      `UPDATE actors SET visibility = 'private', published_permission = NULL,
       published_note = NULL, published_at = NULL, updated_at = ?
       WHERE id IN (${inList}) AND visibility = 'public'`
    ).run(now, ...actorIds).changes;

    summary.links_revoked = db.prepare(
      `UPDATE actor_share_links SET revoked_at = ?, updated_at = ?
       WHERE actor_id IN (${inList}) AND revoked_at IS NULL`
    ).run(now, now, ...actorIds).changes;

    // EVERY claim, not only via_public = 1. DELETE /api/actors/:id/publish keeps
    // existing claims unless asked, because unlisting is tidying a listing and
    // "withdrawing something a person is already building on should be a
    // deliberate act". This IS that deliberate act, and it is the subject's,
    // not the owner's — there is no reading on which a claim survives it.
    summary.claims_revoked = db.prepare(
      `DELETE FROM actor_shares WHERE actor_id IN (${inList})`
    ).run(...actorIds).changes;
  })();

  const live = db.prepare(
    `SELECT * FROM actor_deployments WHERE platform_actor_id IN (${inList}) AND undeployed_at IS NULL`
  ).all(...actorIds);

  for (const d of live) {
    const where = { world_id: d.world_id, world_name: d.world_name, actor_id: d.platform_actor_id };
    let confirmed = false;
    try {
      const simRes = await fetch(
        `${SIMULATOR_URL}/internal/actors/${d.simulator_actor_id}/undeploy`,
        { method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN } }
      );
      const simBody = await simRes.json().catch(() => null);
      confirmed = simRes.ok && simBody?.ok !== false;
      if (confirmed) {
        console.log(`[authorisation withdrawn] simulator erased ${d.simulator_actor_id} from ${d.world_name} — ${simBody?.rows_deleted ?? "?"} row(s)`);
      } else {
        console.warn(`[authorisation withdrawn] simulator REFUSED undeploy of ${d.simulator_actor_id}: HTTP ${simRes.status}`, simBody);
      }
    } catch (e) {
      console.warn(`[authorisation withdrawn] simulator UNREACHABLE for ${d.simulator_actor_id}:`, e.message);
    }

    if (!confirmed) {
      // She is still in that world and the platform must not pretend otherwise.
      console.error(`[authorisation withdrawn] STILL DEPLOYED after withdrawal: actor ${d.platform_actor_id} in ${d.world_name} (${d.world_id}) — retry undeploy once the simulator is healthy`);
      summary.still_deployed.push(where);
      continue;
    }

    // Same two archive steps POST /undeploy takes, in the same order and for
    // the same reasons: copy the world video down off the simulator while it
    // still exists, then mark ALL her media for that world archived even if the
    // copy did not answer. Both best-effort; neither may fail an erase the
    // simulator has already confirmed. This is the existing LAN-only
    // server-to-server fetch, reused unchanged.
    const a = db.prepare(`SELECT media_folder FROM actors WHERE id = ?`).get(d.platform_actor_id);
    try {
      await archiveWorldMedia(d.platform_actor_id, d.world_id, d.world_name, a?.media_folder, d.simulator_actor_id);
    } catch (e) { console.warn("[authorisation withdrawn] archive failed:", e.message); }
    try {
      markWorldMediaArchived(d.platform_actor_id, d.world_id, d.world_name, now);
    } catch (e) { console.warn("[authorisation withdrawn] archive marking failed:", e.message); }

    db.prepare(`UPDATE actor_deployments SET undeployed_at = ?, deploy_status = 'undeployed' WHERE id = ?`)
      .run(now, d.id);

    // A sweep target naming an erased simulator actor can never resolve again.
    try {
      const pruned =
        db.prepare(`DELETE FROM lab_suite_targets WHERE world_id = ? AND actor_id = ?`)
          .run(d.world_id, d.simulator_actor_id).changes +
        db.prepare(`DELETE FROM lab_sweep_targets WHERE world_id = ? AND actor_id = ?`)
          .run(d.world_id, d.simulator_actor_id).changes;
      if (pruned) console.log(`[authorisation withdrawn] pruned ${pruned} lab sweep target(s) naming ${d.simulator_actor_id}`);
    } catch (e) { console.warn("[authorisation withdrawn] lab target prune failed:", e.message); }

    summary.undeployed.push(where);
  }

  // Only drop to 'ready_to_deploy' once no live deployment remains anywhere.
  for (const id of new Set(summary.undeployed.map(u => u.actor_id))) {
    const stillDeployed = db.prepare(
      `SELECT 1 FROM actor_deployments WHERE platform_actor_id = ? AND undeployed_at IS NULL LIMIT 1`
    ).get(id);
    if (!stillDeployed) {
      db.prepare(`UPDATE actors SET status = 'ready_to_deploy', updated_at = ? WHERE id = ? AND status = 'active'`)
        .run(now, id);
    }
  }

  return summary;
}

// ── The STANDING record that a withdrawal was not carried out ─────────
//
// conduct-watch, 2026-09-09: `revoked.still_deployed` above existed in exactly
// two places — the HTTP response to the click that produced it, and one
// console.error line. Navigate away, close the tab, or have the withdrawal
// happen while the simulator was off and nobody was looking, and the fact that
// the subject SAID NO while her likeness is STILL IN A SIMULATOR WORLD was
// unreadable anywhere in the product. That is the one fact here that must never
// be quietly lost.
//
// It is DERIVED on read rather than stored in a column. A stored flag can drift
// out of agreement with the rows the gates themselves read, and a stale "all
// clear" on this particular fact is worse than no record at all.
//
// Scoped to exactly what every other subject-authorisation gate scopes to
// (media_type='photo', world_id IS NULL, depicts='other', any single 'no'
// counts as withdrawn) joined to deployments that are still live
// (undeployed_at IS NULL), so this surface and the gates can never disagree.
function unenforcedWithdrawalWorlds(actorId) {
  const withdrawn = db.prepare(
    `SELECT 1 FROM actor_media
      WHERE actor_id = ? AND media_type IN ('photo','audio') AND world_id IS NULL
        AND depicts = 'other' AND subject_authorised = 'no' LIMIT 1`
  ).get(actorId);
  if (!withdrawn) return [];
  return db.prepare(
    `SELECT world_id, world_name FROM actor_deployments
      WHERE platform_actor_id = ? AND undeployed_at IS NULL
      ORDER BY COALESCE(world_name, world_id)`
  ).all(actorId).map(d => ({ world_id: d.world_id, world_name: d.world_name, actor_id: actorId }));
}

// Every actor, for any owner, in that state — the retry sweep's worklist.
function actorsWithUnenforcedWithdrawal() {
  return db.prepare(
    `SELECT DISTINCT d.platform_actor_id AS id
       FROM actor_deployments d
       JOIN actor_media m ON m.actor_id = d.platform_actor_id
      WHERE d.undeployed_at IS NULL
        AND m.media_type IN ('photo','audio') AND m.world_id IS NULL
        AND m.depicts = 'other' AND m.subject_authorised = 'no'`
  ).all().map(r => r.id);
}

// ── Retry the refused undeploy when the simulator comes back ─────────────
//
// Nothing retried it. The only ways a withdrawal stayed unenforced were the
// simulator refusing or being unreachable, and both of those end on their own —
// so the correct trigger is the simulator ANSWERING again, not a person
// happening to still have the tab open and noticing the Retry button.
//
// Gated on a live probe on purpose: re-running the sweep blind every few
// minutes against a host that is switched off would log a fresh failure each
// time and achieve nothing. Checked shortly after boot too, because "the sweep
// ran while nobody was looking" is exactly the case this is for.
const WITHDRAWAL_RETRY_MS = 5 * 60 * 1000;
async function retryUnenforcedWithdrawals() {
  let pending;
  try { pending = actorsWithUnenforcedWithdrawal(); }
  catch (e) { console.error("[withdrawal retry] worklist read failed:", e.message); return; }
  if (!pending.length) return;

  let up = false;
  try {
    const probe = await fetch(`${SIMULATOR_URL}/internal/worlds?ids=`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
    });
    up = probe.ok;
  } catch { up = false; }

  if (!up) {
    console.warn(`[withdrawal retry] ${pending.length} actor(s) are STILL DEPLOYED after the subject withdrew authorisation, and the simulator is not answering — will retry when it is. GET /api/actors/:id reports this as withdrawal_still_deployed.`);
    return;
  }

  console.warn(`[withdrawal retry] simulator is answering — retrying the undeploy the withdrawal could not complete for ${pending.length} actor(s): ${pending.join(", ")}`);
  try {
    const summary = await revokeGrantedEgressOnWithdrawal(pending, new Date().toISOString());
    console.log(`[withdrawal retry] removed from ${summary.undeployed.length} world(s); STILL DEPLOYED ${summary.still_deployed.length}`);
  } catch (e) {
    console.error("[withdrawal retry] sweep failed:", e.message);
  }
}
// Unref'd: a pending retry never holds the process open.
setTimeout(retryUnenforcedWithdrawals, 20 * 1000).unref();
setInterval(retryUnenforcedWithdrawals, WITHDRAWAL_RETRY_MS).unref();

// ── POST /api/actors/:id/media/authorisation/retry-revocation ───────────
// The standing banner's Retry control. The only way to retry before this was to
// re-PATCH subject_authorised='no', i.e. re-state a declaration in order to get
// a side effect. This says what it means instead: owner-only, and a no-op
// unless the withdrawal really is still unenforced.
app.post("/api/actors/:id/media/authorisation/retry-revocation", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const outstanding = unenforcedWithdrawalWorlds(req.params.id);
  if (!outstanding.length) {
    return res.json({ ok: true, retried: false, withdrawal_still_deployed: [] });
  }
  try {
    const revoked = await revokeGrantedEgressOnWithdrawal([req.params.id], new Date().toISOString());
    console.log(`[withdrawal retry] manual retry by ${user.id} for actor ${req.params.id} — undeployed ${revoked.undeployed.length}, STILL DEPLOYED ${revoked.still_deployed.length}`);
    return res.json({
      ok: true, retried: true, revoked,
      withdrawal_still_deployed: unenforcedWithdrawalWorlds(req.params.id),
    });
  } catch (e) {
    console.error("[withdrawal retry] manual retry failed:", e);
    return res.status(500).json({
      ok: false,
      error: "Removing her from the simulator did not finish. She is still in the world(s) named, and nothing new can be built, published, shared or deployed from these photographs either way.",
      detail: e.message,
      withdrawal_still_deployed: unenforcedWithdrawalWorlds(req.params.id),
    });
  }
});

// ── PATCH /api/actors/:id/media/authorisation ─ did the subject agree ───────
// The companion to the depicts declaration above. Shaped identically on
// purpose: same ownership check, same whitelist, same whole-reference-set
// scope (the statement is about the person in the photographs, not about one
// file), same refusal to write NULL -- withdrawing permission is stated as
// 'no', never by silently clearing it back to "never asked".
app.patch("/api/actors/:id/media/authorisation", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const value = ["yes", "no"].includes(req.body?.subject_authorised) ? req.body.subject_authorised : null;
  if (!value) return res.status(400).json({ error: "subject_authorised must be 'yes' or 'no'" });
  const now = new Date().toISOString();
  const r = db.prepare(`UPDATE actor_media SET subject_authorised = ?, updated_at = ? WHERE actor_id = ? AND media_type IN ('photo','audio') AND world_id IS NULL`)
    .run(value, now, req.params.id);
  console.log(`[media authorisation] actor: ${req.params.id} user: ${user.id} -> ${value} (${r.changes} row(s))`);

  // 'no' means no retroactively — see the block above. Ordered after the write
  // so every gate reads 'no' for the whole duration of the sweep.
  let revoked = null;
  if (value === "no") {
    const ids = subjectDescendantIds(req.params.id);
    try {
      revoked = await revokeGrantedEgressOnWithdrawal(ids, now);
      console.log(`[authorisation withdrawn] actor: ${req.params.id} by: ${user.id} — ${ids.length} actor(s) in the copy tree; unlisted ${revoked.unpublished}, revoked ${revoked.links_revoked} link(s), removed ${revoked.claims_revoked} claim(s), undeployed ${revoked.undeployed.length}, STILL DEPLOYED ${revoked.still_deployed.length}`);
    } catch (e) {
      // The withdrawal itself stands regardless: the declaration is written and
      // every prospective gate already reads it. Surface the failure loudly and
      // tell the caller the sweep did not complete rather than swallowing it.
      console.error("[authorisation withdrawn] revocation sweep failed:", e);
      return res.status(500).json({
        ok: false, subject_authorised: value, updated: r.changes,
        error: "The withdrawal was recorded and nothing new can be built, published, shared or deployed from these photographs. Taking back what was already granted did not finish — retry, and check the listing, the share links and the deployments.",
        detail: e.message,
      });
    }
  }

  res.json({ ok: true, subject_authorised: value, updated: r.changes, revoked });
});

// ── PATCH /api/actors/:id/media/:mediaId/rename ──────────────────────────────
app.patch("/api/actors/:id/media/:mediaId/rename", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const { state_slug } = req.body;
  if (!state_slug) return res.status(400).json({ error: "state_slug required" });
  const now = new Date().toISOString();
  db.prepare(`UPDATE actor_media SET state_slug = ?, updated_at = ? WHERE id = ? AND actor_id = ?`)
    .run(state_slug, now, req.params.mediaId, req.params.id);
  res.json({ id: req.params.mediaId, state_slug });
});

// ── DELETE /api/actors/:id/media/:mediaId ─────────────────────────────────────
app.delete("/api/actors/:id/media/:mediaId", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const media = db.prepare(`SELECT * FROM actor_media WHERE id = ? AND actor_id = ?`).get(req.params.mediaId, req.params.id);
  if (!media) return res.status(404).json({ error: "not found" });
  try {
    const { default: fs } = await import("fs");
    const filePath = path.join(__dirname, "../public", media.url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
  // conduct-watch, 2026-09-11: signal 7's whole subject is burst-and-delete, and
  // this -- the only explicit removal path for a reference photograph -- logged
  // NOTHING. Two API-created actor_media rows vanished inside an hour with no
  // DELETE anywhere in the journal, so the removal could not be attributed to a
  // caller even in principle. Upload, depicts and authorisation all log; removal
  // was the one consent-relevant mutation on this table that did not.
  console.log(`[media removed] actor: ${req.params.id} user: ${user.id} media: ${media.id} slot: ${media.state_slug ?? "unset"} type: ${media.media_type} depicts: ${media.depicts ?? "unset"} subject_authorised: ${media.subject_authorised ?? "unset"} file: ${media.filename}`);
  db.prepare(`DELETE FROM actor_media WHERE id = ?`).run(req.params.mediaId);
  res.json({ deleted: req.params.mediaId });
});

app.get("/api/actors/:id/media", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const world_id = req.query.world_id || null;
  const media = world_id
    ? db.prepare(`SELECT * FROM actor_media WHERE actor_id = ? AND world_id = ? ORDER BY media_type, inserted_at`).all(req.params.id, world_id)
    : db.prepare(`SELECT * FROM actor_media WHERE actor_id = ? ORDER BY media_type, inserted_at`).all(req.params.id);
  res.json(media);
});

// ── GET /api/worlds — worlds available to deploy into ────────────────────────
// ── GET /api/worlds/:id/actors — characters deployed in a world ───────────────
app.get("/api/worlds/:id/actors", (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const actors = db.prepare(`
    SELECT a.id, a.name, a.first_name, a.last_name, a.occupation, a.gender,
           COALESCE(
             (SELECT m.url FROM actor_media m WHERE m.actor_id = a.id AND m.media_type = 'photo' ORDER BY m.inserted_at LIMIT 1),
             (SELECT m.url FROM actor_media m WHERE m.actor_id = a.id AND m.media_type = 'state_image' AND m.filename LIKE '%close%' LIMIT 1)
           ) as photo_url
    FROM actors a
    JOIN actor_deployments d ON d.platform_actor_id = a.id
    WHERE d.world_id = ? AND d.undeployed_at IS NULL
    ORDER BY a.name
  `).all(req.params.id);
  res.json(actors);
});

// ── GET /api/relationship-types ───────────────────────────────────────────────
app.get("/api/relationship-types", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  try {
    const data = await simFetch("/internal/relationship-types");
    res.json(data || []);
  } catch {
    res.json([]);
  }
});


// ── Archive world media helper ────────────────────────────────────────────────
function parseVideoMeta(filename) {
  // frida_bedroom_kneeling_topless_kiss_clip_bg.mp4
  let name = filename.replace(/\.mp4$/, "");
  let suffix = "gs";
  if (name.endsWith("_bg"))    { suffix = "bg";  name = name.slice(0, -3); }
  else if (name.endsWith("_gs")) { suffix = "gs"; name = name.slice(0, -3); }
  else if (name.endsWith("_no_bg")) { suffix = "bg"; name = name.slice(0, -6); }

  const parts = name.split("_");
  const knownLocations = ["bedroom", "hall", "living", "kitchen", "bathroom", "office"];
  const knownPositions = ["standing", "sitting", "kneeling", "lying", "missionary", "straddles", "riding", "doggy", "bent"];

  let rest = parts.slice(1); // drop actor prefix

  // Detect location (may be 2 parts e.g. living_room)
  let location = null;
  if (rest.length >= 2 && knownLocations.some(l => rest[0] + "_" + rest[1] === l + "_room")) {
    location = rest[0] + "_" + rest[1]; rest = rest.slice(2);
  } else if (knownLocations.includes(rest[0])) {
    location = rest[0]; rest = rest.slice(1);
  }

  // Position (may be multi-word: lying_on_back)
  let position = rest[0] || "standing"; rest = rest.slice(1);
  if (position === "lying" && rest[0] === "on") {
    position = "lying_on_" + rest[1]; rest = rest.slice(2);
  }

  // Outfit
  const outfit = rest[0] || "casual"; rest = rest.slice(1);

  // Type is last part (clip/loop)
  const clip_type = rest[rest.length - 1] || "loop";
  const action = rest.slice(0, -1).join("_") || "idle";

  return { location, position, outfit, action, clip_type, suffix };
}

// Deletes the actor's entire media_folder directory on disk — the GLB,
// portraits, archives, everything pullGlbToServer() and
// archiveWorldMedia() ever wrote there. Neither abandon-draft nor the
// hard-delete endpoint previously did this: both only removed files
// tracked in actor_media, and the GLB itself is never tracked there —
// only via actors.glb_url (see generate3d.js). Confirmed root cause of
// ~122 orphaned media folders found in production (Session 99).
// Guarded so a missing/empty media_folder can never resolve to the
// parent "actors" directory itself — that would delete every
// character's media at once.
function deleteActorMediaFolder(mediaFolder) {
  if (!mediaFolder || typeof mediaFolder !== "string" || mediaFolder.trim() === "") {
    console.warn("[deleteActorMediaFolder] skipped — empty/missing media_folder");
    return;
  }
  const actorsRoot = path.join(__dirname, "../public/media/actors");
  const targetDir = path.join(actorsRoot, mediaFolder);
  // Defense in depth against path traversal — resolved target must stay
  // strictly inside the actors media root.
  if (!targetDir.startsWith(actorsRoot + path.sep)) {
    console.warn(`[deleteActorMediaFolder] skipped — resolved path escapes actors root: ${targetDir}`);
    return;
  }
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    console.log(`[deleteActorMediaFolder] removed ${targetDir}`);
  } catch (e) {
    console.warn(`[deleteActorMediaFolder] failed for ${targetDir}:`, e.message);
  }
}

async function archiveWorldMedia(platformActorId, worldId, worldName, mediaFolder, simActorId) {
  console.log(`[archive] Starting archive for actor ${platformActorId} world ${worldId}`);

  // List videos from simulator
  let videos = [];
  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/worlds/${worldId}/actors/${simActorId}/videos`, {
      headers: { "X-Service-Token": SERVICE_TOKEN }
    });
    const data = await simRes.json();
    videos = data.videos || [];
  } catch (e) {
    console.warn("[archive] Failed to list videos:", e.message);
    return 0;
  }

  if (videos.length === 0) {
    console.log("[archive] No videos to archive");
    return 0;
  }

  // Store archives under /media/actors/ path — avoids nginx proxy rule for /media/worlds/
  const destDir = path.join(__dirname, "../public/media/actors", mediaFolder, "archives", worldId, "videos");
  await fs.promises.mkdir(destDir, { recursive: true });

  const now = new Date().toISOString();
  let archived = 0;

  for (const video of videos) {
    try {
      // Download from simulator nginx (internal LAN)
      const videoUrl = `http://192.168.1.58:4001/media/worlds/${worldId}/actors/${simActorId}/videos/${video.filename}`;
      const videoRes = await fetch(videoUrl);
      if (!videoRes.ok) { console.warn("[archive] Failed to fetch:", video.filename); continue; }

      const buffer = Buffer.from(await videoRes.arrayBuffer());
      const destPath = path.join(destDir, video.filename);
      await fs.promises.writeFile(destPath, buffer);

      const meta = parseVideoMeta(video.filename);
      const platformUrl = `/media/actors/${mediaFolder}/archives/${worldId}/videos/${video.filename}`;

      // Upsert into actor_media
      const existing = db.prepare(`SELECT id FROM actor_media WHERE actor_id = ? AND world_id = ? AND filename = ?`).get(platformActorId, worldId, video.filename);
      if (!existing) {
        db.prepare(`INSERT INTO actor_media (id, actor_id, world_id, world_name, media_type, filename, url, position, outfit, action, clip_type, suffix, file_size, archived_at, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(randomUUID(), platformActorId, worldId, worldName, "video", video.filename, platformUrl,
               meta.position, meta.outfit, meta.action, meta.clip_type, meta.suffix,
               buffer.length, now, now, now);
      } else {
        db.prepare(`UPDATE actor_media SET archived_at = ?, file_size = ?, url = ?, updated_at = ? WHERE id = ?`)
          .run(now, buffer.length, platformUrl, now, existing.id);
      }
      archived++;
    } catch (e) {
      console.warn("[archive] Error archiving", video.filename, e.message);
    }
  }

  console.log(`[archive] Archived ${archived}/${videos.length} videos for actor ${platformActorId} world ${worldId}`);
  return archived;
}

// Media that belongs to a deployment rather than to the character template.
// Deliberately an explicit list: state_image / animation rows are build-time
// assets of the character herself and stay live no matter which world she is
// or is not in.
const ARCHIVABLE_MEDIA_TYPES = ["photo", "video", "voice_reference", "audio"];

// Stamps archived_at on everything the actor holds for one world.
//
// Session 151 — this is the half archiveWorldMedia() above does not do. That
// function copies video FILES down off the simulator and only stamps the rows
// it managed to fetch; it returns early when the simulator is unreachable or
// lists no videos. So an undeployed actor kept photos, her voice reference and
// audio at archived_at NULL, still naming a world she is no longer deployed to
// — and videos the simulator had already dropped were missed the same way.
//
// The marker records that the deployment ended, which is true whether or not
// the file copy succeeded, so this runs unconditionally and independently.
// Rows already archived are left at their original timestamp.
function markWorldMediaArchived(platformActorId, worldId, worldName, archivedAt) {
  if (!worldId) return 0;
  const now = archivedAt || new Date().toISOString();
  const slots = ARCHIVABLE_MEDIA_TYPES.map(() => "?").join(",");
  const info = db.prepare(
    `UPDATE actor_media
        SET archived_at = ?,
            world_name  = COALESCE(world_name, ?),
            updated_at  = ?
      WHERE actor_id    = ?
        AND world_id    = ?
        AND archived_at IS NULL
        AND media_type IN (${slots})`
  ).run(now, worldName || null, now, platformActorId, worldId, ...ARCHIVABLE_MEDIA_TYPES);
  console.log(`[archive] Marked ${info.changes} actor_media row(s) archived for actor ${platformActorId} world ${worldId}`);
  return info.changes;
}

// ── POST /api/actors/:id/undeploy ────────────────────────────────────────────
app.post("/api/actors/:id/undeploy", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  // Session 157 (behavior-watch: undeploy is owner-only) - who may take her out.
  //
  // This used to load the actor as `WHERE id = ? AND owner_id = ?` bound to the
  // caller, i.e. undeploy was silently template-owner-only. That was harmless
  // only while deploy was accidentally owner-only too. Deploy now grants the
  // "use" rung (share-holder may deploy someone else's character into a world
  // THEY own), so the asymmetry became live: a share-holder could place her in
  // their own world and then had no way to remove her from it.
  //
  // The rule is the inverse of deploy's, which needs "use" on the character AND
  // `owner` on the world: undeploying is a world-level act, so an owner of the
  // world she is standing in may evict her, and the character's own owner may
  // always pull her out of anywhere. No share is required for the world-owner
  // path - a co-owner of the world who was never shared the character still owns
  // the world she is in.
  //
  // Entitlement is computed per DEPLOYMENT, not per actor, and the world list
  // handed back on ambiguity is the filtered one, so a caller never learns which
  // other worlds hold a character they have no standing over.
  const actor = db.prepare(`SELECT * FROM actors WHERE id = ?`).get(req.params.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const isTemplateOwner = actor.owner_id === user.id;

  // Session 150 — undeploy has to name a world.
  //
  // This used to take the most recent live deployment and say nothing about it.
  // For a character deployed to one world that is right by accident; for a
  // character in several it silently erased her from whichever she happened to
  // join last, which is not a choice anyone made. The caller now passes
  // world_id, and if it is ambiguous we refuse and hand back the options rather
  // than guessing.
  const allLiveDeployments = db.prepare(
    `SELECT * FROM actor_deployments WHERE platform_actor_id = ? AND undeployed_at IS NULL ORDER BY deployed_at DESC`
  ).all(req.params.id);

  // Keep only the deployments this caller has standing over (see above).
  const liveDeployments = isTemplateOwner
    ? allLiveDeployments
    : allLiveDeployments.filter(d => {
        const wm = db.prepare(
          `SELECT role FROM world_memberships WHERE user_id = ? AND world_id = ? LIMIT 1`
        ).get(user.id, d.world_id);
        return wm && wm.role === "owner";
      });

  if (allLiveDeployments.length === 0) return res.status(404).json({ error: "no deployment found" });

  // Nothing they may act on: answer exactly as if she did not exist, the same
  // non-disclosure the old owner_id-bound load gave. A stranger must not learn
  // that this character is deployed at all.
  if (liveDeployments.length === 0) return res.status(404).json({ error: "not found" });

  const wantWorld = req.body?.world_id;
  let deployment;
  if (wantWorld) {
    deployment = liveDeployments.find(d => d.world_id === wantWorld);
    if (!deployment) {
      return res.status(404).json({ error: "She isn't deployed to that world." });
    }
  } else if (liveDeployments.length > 1) {
    return res.status(400).json({
      error: "She's deployed to more than one world — say which.",
      worlds: liveDeployments.map(d => ({ world_id: d.world_id, world_name: d.world_name })),
    });
  } else {
    deployment = liveDeployments[0];
  }
  if (!deployment) return res.status(400).json({ error: "not deployed" });

  // Stamped on the archive rows, the deployment row and the status change
  // alike, so an archived row can be read straight back to the undeploy that
  // caused it.
  const now = new Date().toISOString();

  // Archive her media before undeploying — two steps, not one. Copy the video
  // files down off the simulator while they still exist...
  try {
    await archiveWorldMedia(req.params.id, deployment.world_id, deployment.world_name, actor.media_folder, deployment.simulator_actor_id);
  } catch (e) {
    console.warn("[undeploy] archive failed:", e.message);
  }

  // ...then mark ALL of her media for this world archived. Separate from the
  // copy above on purpose: the copy is best-effort and video-only, while the
  // marker has to hold even when the simulator never answered. Without it
  // actor_media keeps photos, voice references and audio at archived_at NULL
  // against a world she is no longer deployed to.
  try {
    markWorldMediaArchived(req.params.id, deployment.world_id, deployment.world_name, now);
  } catch (e) {
    console.warn("[undeploy] archive marking failed:", e.message);
  }

  // Session 150 — the platform must not record her as undeployed unless the
  // simulator actually confirmed it erased her.
  //
  // This used to swallow the result entirely. Two ways that went wrong, and the
  // second one is not hypothetical: fetch only throws on a transport failure, so
  // a 500 from the simulator is not an exception — it sets res.ok = false and
  // nothing else. Every undeploy between Sessions 79 and 150 returned 500
  // (`unknown registry: DeliverWorlds.ActorRegistry`), and this code cleared
  // undeployed_at, reset status to 'ready_to_deploy' and answered {ok:true}
  // regardless. The platform said she was gone; the simulator still had her
  // process running and all her rows. Redeploying from that state would have
  // produced a second live instance of the same character.
  //
  // So: check the status AND the body, and on anything other than a confirmed
  // erase, leave the deployment row and her status untouched and report the
  // failure. An undeploy that cannot reach the simulator has not happened, and
  // saying otherwise is worse than failing — the user can retry once it is up.
  //
  // Media archiving above deliberately stays outside this gate. It is
  // idempotent, it only touches platform rows, and running it on a failed
  // attempt costs nothing that a later successful attempt will not redo.
  let simBody = null;
  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/actors/${deployment.simulator_actor_id}/undeploy`,
      { method:"POST", headers:{"X-Service-Token": SERVICE_TOKEN} });
    simBody = await simRes.json().catch(() => null);
    if (!simRes.ok || simBody?.ok === false) {
      console.warn(`[undeploy] simulator refused for ${deployment.simulator_actor_id}: HTTP ${simRes.status}`, simBody);
      return res.status(502).json({
        error: `The simulator did not erase her — HTTP ${simRes.status}. She is still deployed; nothing was changed. Try again once the simulator is healthy.`,
        simulator_status: simRes.status,
        simulator_body: simBody,
      });
    }
  } catch (e) {
    console.warn("[undeploy] simulator unreachable:", e.message);
    return res.status(502).json({
      error: `Couldn't reach the simulator (${e.message}). She is still deployed; nothing was changed.`,
    });
  }

  console.log(`[undeploy] simulator erased ${deployment.simulator_actor_id} — ${simBody?.rows_deleted ?? "?"} row(s)`);

  // Sessions 156 (watcher: Feature - Character Deploy) - deploy_status is a
  // mirror of undeployed_at, and undeploy only ever moved the clock: the row
  // went out while the scalar still read 'deployed'. Every live route keys off
  // undeployed_at (19 read sites) and nothing outside the deploy board reads
  // deploy_status, so this misled no caller - but a mirror that disagrees with
  // what it mirrors is a trap primed for the first route that trusts it.
  // Move both in one statement so they cannot drift again.
  db.prepare(`UPDATE actor_deployments SET undeployed_at = ?, deploy_status = 'undeployed' WHERE id = ?`).run(now, deployment.id);

  // A sweep target that names an erased simulator actor.
  //
  // The nightly lab suite sweep benches (world_id, simulator_actor_id) pairs
  // pinned in lab_suite_targets / lab_sweep_targets. Undeploy erased her rows in
  // the simulator but left those pins standing, so every sweep after an undeploy
  // benched a ghost: TransportLab.fetch_actor found no row, returned an empty
  // map, and "her two fixed places resolve" failed with
  // "unresolvable: home_place_id=nil" - a stale pin reported as a data defect.
  // (Observed: Lindsey Vaughn undeployed from TEST WORLD 2026-09-06T01:17:49Z,
  // incident filed by the 06:00Z sweep the same morning and every one since.)
  // A redeploy mints a NEW simulator_actor_id, so a pin naming the erased one can
  // never resolve again; dropping it is the only outcome that is ever right.
  // Best-effort on purpose: lab bookkeeping must not fail an undeploy the
  // simulator has already confirmed.
  try {
    const prunedTargets =
      db.prepare(`DELETE FROM lab_suite_targets WHERE world_id = ? AND actor_id = ?`)
        .run(deployment.world_id, deployment.simulator_actor_id).changes +
      db.prepare(`DELETE FROM lab_sweep_targets WHERE world_id = ? AND actor_id = ?`)
        .run(deployment.world_id, deployment.simulator_actor_id).changes;
    if (prunedTargets) console.log(`[undeploy] pruned ${prunedTargets} lab sweep target(s) naming ${deployment.simulator_actor_id}`);
  } catch (e) {
    console.warn("[undeploy] lab target prune failed:", e.message);
  }

  // Session 149 — actors.status was left at 'active' forever after
  // undeploy; nothing ever moved it back. An actor still deployed
  // elsewhere stays 'active' — only drop to 'ready_to_deploy' once no
  // active deployment remains anywhere.
  const stillDeployed = db.prepare(`SELECT 1 FROM actor_deployments WHERE platform_actor_id = ? AND undeployed_at IS NULL LIMIT 1`).get(req.params.id);
  const status = stillDeployed ? "active" : "ready_to_deploy";
  if (!stillDeployed) {
    db.prepare(`UPDATE actors SET status = 'ready_to_deploy', updated_at = ? WHERE id = ?`).run(now, req.params.id);
  }

  res.json({ ok: true, status, rows_deleted: simBody?.rows_deleted ?? null, still_deployed_elsewhere: !!stillDeployed });
});

// ── POST /api/worlds/:world_id/actors/:actor_id/archive-media — manual backup ─
app.post("/api/worlds/:world_id/actors/:actor_id/archive-media", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  const user = ok.user;

  const { world_id, actor_id } = req.params;
  const actor = db.prepare(`SELECT * FROM actors WHERE id = ?`).get(actor_id);
  if (!actor) return res.status(404).json({ error: "actor not found" });

  const deployment = db.prepare(`SELECT * FROM actor_deployments WHERE platform_actor_id = ? AND world_id = ? ORDER BY deployed_at DESC LIMIT 1`).get(actor_id, world_id);
  if (!deployment) return res.status(404).json({ error: "no deployment found" });

  try {
    const count = await archiveWorldMedia(actor_id, world_id, deployment.world_name, actor.media_folder, deployment.simulator_actor_id);
    res.json({ ok: true, archived: count });
  } catch (e) {
    console.error("[archive-media]", e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/actors/:id/archived-media — list archived videos ─────────────────
app.get("/api/actors/:id/archived-media", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const rows = db.prepare(`SELECT * FROM actor_media WHERE actor_id = ? AND media_type = 'video' AND archived_at IS NOT NULL ORDER BY world_name, filename`).all(req.params.id);
  res.json(rows);
});

// ── Session 150 — is this place_id somewhere a person can actually live? ─────
//
// Google's `route` type covers a whole street; `street_address`, `premise` and
// `subpremise` cover a building, a named building and a flat within one. Only
// the last three are addresses in the sense a home needs. The wizard filters on
// this too, but the check has to exist here as well: a place_id is just a
// string in a JSON body, and a stale draft or a direct POST would otherwise
// still register a road as a residence. Returns { ok, types, address } — and on
// any failure to reach Google, { ok: true, unverified: true }, because a deploy
// should not be blocked by an outage on a check this narrow.
const HOME_PRECISE_TYPES = ["street_address", "premise", "subpremise"];

async function verifyHomePrecision(place_id) {
  const MAPS_KEY = "AIzaSyDy45Dov_WkN9FcxdVNYQEx23PjexI-Fxc";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(
      `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(place_id)}&fields=place_id,formatted_address,type&language=en&key=${MAPS_KEY}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    const data = await r.json();
    const types = data.result?.types || [];
    if (!data.result) return { ok: true, unverified: true, types: [] };
    return {
      ok: types.some(t => HOME_PRECISE_TYPES.includes(t)),
      types,
      address: data.result.formatted_address,
    };
  } catch {
    return { ok: true, unverified: true, types: [] };
  }
}

// ── POST /api/actors/:id/deploy ───────────────────────────────────────────────
app.post("/api/actors/:id/deploy", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const actorId = req.params.id;
  const { world, home, career, relationships, schedule, fromWeek, cv } = req.body;

  if (!world?.id || !home?.place_id || !schedule?.length) {
    return res.status(400).json({ error: "missing required deploy fields" });
  }

  // A street is not an address. See verifyHomePrecision above for why this
  // matters: accepting a route-level place_id is what put two apartments in
  // TEST WORLD with only one tenant between them.
  const homePrecision = await verifyHomePrecision(home.place_id);
  if (!homePrecision.ok) {
    return res.status(400).json({
      error: `"${homePrecision.address || home.address || "That place"}" is a street, not an address. Add a house number — a character needs a building to live in, and deploying a whole road creates a residence nobody can occupy.`,
      home_imprecise: true,
      types: homePrecision.types,
    });
  }

  // ── Session 150 — who may deploy whom, where ───────────────────────────────
  //
  // Two independent questions, both previously unasked: this route checked only
  // that the caller was logged in, so any user could deploy any character into
  // any world.
  //
  // 1. The character. "use" is the rung that permits deploying someone else's
  //    character; their template is never modified, only the world instance the
  //    deploy creates, which belongs to the deployer's world.
  const acc = hasAccess(actorId, user, "use");
  if (!acc) {
    const any = actorAccess(actorId, user);
    if (!any) return res.status(404).json({ error: "not found" });
    return res.status(403).json({ error: `You have "${any.level}" on this character. Deploying needs "use".` });
  }

  // 2. The world. Deploying adds a permanent inhabitant, so it is a world-level
  //    act reserved to owners — of which a world may have several.
  const wm = db.prepare(
    `SELECT role FROM world_memberships WHERE user_id = ? AND world_id = ? LIMIT 1`
  ).get(user.id, world.id);
  if (!wm) return res.status(404).json({ error: "world not found" });
  if (wm.role !== "owner") {
    return res.status(403).json({ error: "Only an owner of this world can deploy a character into it." });
  }

  // Session 150 — refuse a second deploy into a world she is already in.
  //
  // actor_deployments is UNIQUE(platform_actor_id, world_id) and the insert
  // below is INSERT OR REPLACE, so a repeat deploy quietly overwrote the row —
  // and with it the only record of the previous simulator_actor_id. The old
  // simulator actor was never told to stop. It stayed online, kept its rows,
  // kept ticking, and became unreachable from the platform: a ghost of the same
  // character living in the same world, discoverable only by reading the
  // simulator's tables directly. One was found this session holding 29 rows.
  //
  // Deploying twice is not a meaningful operation anyway. To change how she is
  // set up, edit her in the world editor; to start her over, undeploy first —
  // which erases the old instance properly rather than abandoning it.
  const existing = db.prepare(
    `SELECT world_name FROM actor_deployments
     WHERE platform_actor_id = ? AND world_id = ? AND undeployed_at IS NULL`
  ).get(actorId, world.id);

  if (existing) {
    return res.status(409).json({
      error: `She's already deployed to ${existing.world_name || "that world"}. Undeploy her from it first, or edit her there instead.`,
      already_deployed: true,
      world_id: world.id,
    });
  }

  // Session 150 — a fork is a different character id, so the duplicate check
  // above cannot see it. Without this, forking a character and deploying the
  // copy puts two near-identical people in one world, which reads as a bug to
  // anyone looking at the cast.
  //
  // Blocked for anyone who is not an owner of the target world. An owner may do
  // it knowingly — it is their world, and twins or an alternate version are a
  // legitimate thing to want. Deploy already requires ownership, so today this
  // never fires; it is kept because it stays correct if deploy rights are ever
  // widened beyond owners, which is exactly when it would start mattering.
  if (wm.role !== "owner") {
    const lineage = db.prepare(
      `SELECT id FROM actors WHERE id = ? OR forked_from = ? OR id = (SELECT forked_from FROM actors WHERE id = ?)`
    ).all(actorId, actorId, actorId).map(r => r.id).filter(Boolean);

    if (lineage.length) {
      const clash = db.prepare(
        `SELECT d.world_name, a.name FROM actor_deployments d JOIN actors a ON a.id = d.platform_actor_id
         WHERE d.world_id = ? AND d.undeployed_at IS NULL AND d.platform_actor_id IN (${lineage.map(() => "?").join(",")})`
      ).get(world.id, ...lineage);

      if (clash) {
        return res.status(409).json({
          error: `${clash.name} is already in ${clash.world_name} and this character is a copy of her. Only a world owner can place both.`,
          fork_clash: true,
        });
      }
    }
  }

  // Session 150 — the world has to be running, checked here and not only in the
  // wizard.
  //
  // A deploy into a stopped world succeeds at every step and then cannot boot
  // her: the actor's process tree is started by the world's supervisor, which
  // isn't there. The result is a character who exists in full across twenty-odd
  // tables and is alive in none of them, with nothing anywhere saying why.
  //
  // The wizard already refuses this, but the wizard is not the only caller — the
  // orphaned instance found earlier tonight came from a direct API call that
  // bypassed it entirely. Status lives on the simulator (WorldSupervisor knows
  // which worlds are up; the worlds table does not), so it has to be asked.
  try {
    const wr = await fetch(`${SIMULATOR_URL}/internal/worlds?ids=${encodeURIComponent(world.id)}`,
      { headers: { "X-Service-Token": SERVICE_TOKEN } });
    if (!wr.ok) {
      return res.status(502).json({ error: `Couldn't check whether the world is running — simulator returned ${wr.status}. Nothing was deployed.` });
    }
    const [live] = await wr.json();
    if (!live) {
      return res.status(404).json({ error: "That world no longer exists. Nothing was deployed." });
    }
    if (live.status !== "running") {
      return res.status(409).json({
        error: `${live.name || "That world"} is stopped. Start it first — a character deployed into a stopped world is written to the database but never boots.`,
        world_stopped: true,
        world_id: world.id,
      });
    }
  } catch (e) {
    return res.status(502).json({ error: `Couldn't reach the simulator (${e.message}). Nothing was deployed.` });
  }

  // Session 153 (behavior-watch, resolution-manager) — load by id ALONE.
  //
  // This re-read used to bind `owner_id = user.id`, which silently undid the
  // "use" gate a hundred lines above: a share-holder passed
  // hasAccess(actorId, user, "use"), reached here, got undefined, and was
  // answered with a bare 403 "forbidden" after clearing the very check written
  // for them. The "use" rung therefore had no reachable implementation at all —
  // only an owner could ever deploy — though ACCESS_RANK documents it as
  // "deploy the owner's character into a world YOU own".
  //
  // Access was already decided above and is held in `acc`; re-deriving it from
  // owner_id here was both wrong and redundant. POST /api/actors/:id/fork loads
  // its source exactly this way after the same shape of gate.
  //
  // Nothing about the deploy needs the caller to own the template: the world
  // instance created below belongs to the deployer's world, the template row is
  // only read here, and the actor's media is fetched server-to-server by the
  // simulator over the LAN, never handed to the caller.
  //
  // 404 rather than 403 on a miss: actorAccess() read this row moments ago, so
  // an absence here means it was deleted mid-request, not that access was
  // refused — and answering "forbidden" to someone who just passed the gate is
  // the exact confusion this line caused.
  const actor = db.prepare(`SELECT * FROM actors WHERE id = ?`).get(actorId);
  if (!actor) return res.status(404).json({ error: "not found" });

  // Session 152 (conduct-watch, resolution-manager) — the drafting exemption
  // ends HERE, at the deployment boundary.
  //
  // ageFloorError() below deliberately returns null for an unset/empty age, and
  // that is correct where it is used: the wizard saves drafts long before Age is
  // filled in, and failing those would break creation. But nothing ever re-asked
  // the question at deploy time. A character whose age was never entered — or
  // cleared to "" through PUT /api/actors/:id, which that exemption accepts by
  // design — was forwarded from here to the simulator with age: null and landed
  // in a live world unbounded. An unknown age cannot be shown to clear 18, and
  // the age is carried straight into NPC prompts and perception.
  //
  // The simulator refuses this too now (deploy_actor/2 422s an absent or
  // unreadable age, same session). This check exists so the refusal happens
  // BEFORE the model bake, the media upload and the deploy-payload write below,
  // and so the answer says what to do about it instead of surfacing as
  // "no simulator_actor_id returned" from the catch at the end of this route.
  const deployAge =
    typeof actor.age === "number" ? actor.age : parseInt(String(actor.age ?? "").trim(), 10);
  if (!Number.isFinite(deployAge)) {
    return res.status(400).json({
      error: `${actor.first_name || actor.name || "This character"} has no age set. A character's age goes into NPC prompts and perception, so it has to be filled in before she can be deployed into a world — set it in the editor and try again. Nothing was deployed.`,
      field: "age",
      age_missing: true,
    });
  }
  if (deployAge < AGE_FLOOR) {
    return res.status(400).json({
      error: `${actor.first_name || actor.name || "This character"} is recorded as ${deployAge}. Characters deployed into a world must be ${AGE_FLOOR} or over. Nothing was deployed.`,
      field: "age",
      floor: AGE_FLOOR,
    });
  }

  // Session 158 (conduct-watch, resolution-manager) — the subject-authorisation
  // declaration ends here too, at the same deployment boundary as the age floor
  // above.
  //
  // actor_media.subject_authorised was added with two gates: the 3D solve
  // (generate3d.js) and sharing (POST /api/actors/:id/shares). Deploy is the
  // THIRD egress and had none, even though it is the widest of the three — the
  // media block below ships every actor_media row to the simulator over the LAN
  // and puts the likeness in front of whoever else is in that world. Building an
  // unauthorised likeness is contained while it stays in one account; deploying
  // it is the step that stops being contained, exactly like sharing.
  //
  // Same predicate as the shares route, deliberately: scoped to the declared
  // reference set (world_id IS NULL) and to declared-'other' rows only, so
  // actors with no declaration — every actor predating the depicts column —
  // deploy exactly as before. World-scoped media is excluded even though deploy
  // ships it, because PUT /api/actors/:id/media-depicts only writes
  // subject_authorised on world_id IS NULL rows: gating on a world-scoped row
  // would create a refusal with no UI path to clear it.
  //
  // Session 170 — over the whole fork ancestry, so a copy stops deploying when
  // the subject withdraws on the original it was taken from.
  const unauthorisedSubject = unauthorisedSubjectInLineage(actorId);
  if (unauthorisedSubject) {
    return res.status(403).json({
      error: subjectRefusalText(unauthorisedSubject, actorId, actor.first_name || actor.name || "This character", "deployed") + " Nothing was deployed.",
      needs: subjectRefusalNeeds(unauthorisedSubject),
    });
  }

  // Session 152 — refuse rather than ship the wrong body.
  //
  // Deploy copies the runtime model into the world; it cannot build one. The
  // bake runs GLTFExporter against a model loaded in a browser, and this is a
  // server handling a POST from a gallery card. So the only honest options when
  // it is missing or stale are to stop, or to deploy a character a world cannot
  // render — or, worse, one wearing last week's clothes, which nobody would
  // notice until they saw her.
  //
  // Staleness is derived, not signalled: hash the body file, the wardrobe and
  // the morph values, and compare with the hash the built file was made from.
  {
    const fsm = await import("fs");
    let mtime = 0;
    if (actor.glb_url) {
      try { mtime = fsm.statSync(path.join(__dirname, "../public", actor.glb_url)).mtimeMs; } catch {}
    }
    let draft = {};
    try { draft = JSON.parse(actor.draft_state || "{}"); } catch {}
    const want = appearanceHash({ glbUrl: actor.glb_url, glbMtimeMs: mtime, draft });

    if (!actor.runtime_glb_url) {
      return res.status(409).json({
        error: `${actor.name} has no runtime model yet. Open her 3D character tab and build one — a world has nothing to load without it.`,
        reason: "runtime_missing",
      });
    }
    if (actor.runtime_glb_hash !== want) {
      return res.status(409).json({
        error: `${actor.name}'s runtime model is out of date — she has been edited since it was built. Open her 3D character tab and rebuild it, or the world gets the older her.`,
        reason: "runtime_stale",
        built: actor.runtime_glb_hash, current: want,
      });
    }
  }

  function getPsychTable(table, id) {
    try { return db.prepare(`SELECT * FROM ${table} WHERE actor_id = ?`).get(id) || null; } catch { return null; }
  }

  const psych = {
    ...(getPsychTable("actor_psychology", actorId) || {}),
    actor_big5:          getPsychTable("actor_big5", actorId),
    actor_disc:          getPsychTable("actor_disc", actorId),
    actor_economic:      getPsychTable("actor_economic", actorId),
    actor_lifestyle:     getPsychTable("actor_lifestyle", actorId),
    actor_mental_health: getPsychTable("actor_mental_health", actorId),
    actor_education:     getPsychTable("actor_education", actorId),
    actor_upbringing:    getPsychTable("actor_upbringing", actorId),
    actor_hds:           getPsychTable("actor_hds", actorId),
    actor_diagnoses:     getPsychTable("actor_diagnoses", actorId),
  };

  // Session 150 — education from the CV.
  //
  // actor_education is almost always empty: the character wizard has no
  // education step, so the only way to populate it was the character editor by
  // hand, and virtually nobody does. Meanwhile the CV — generated or uploaded —
  // states it plainly under its own EDUCATION heading. Parsing it there means a
  // deployed actor knows where she studied without anyone typing it twice.
  //
  // A real actor_education row always wins; this only fills a gap. Parsed
  // deterministically rather than by LLM: the CV layout is this system's own
  // structured output, so a regex answers it exactly and cannot invent a
  // university that does not exist.
  if (!psych.actor_education && typeof cv === "string" && cv.trim()) {
    const parsed = educationFromCv(cv);
    if (parsed) {
      psych.actor_education = parsed;
      console.log(`[deploy] education from CV: ${parsed.level || "?"} / ${parsed.field || "?"} / ${parsed.institution}`);
    }
  }

  // Session 150 — the simulator owns the amount outright. actor_economic on
  // this side is keyed by actor_id alone (one row per actor), so it structurally
  // cannot hold a figure that differs per world; the simulator's row is keyed
  // (actor_id, world_id) and derives the total from that actor's own revenue
  // sources. Strip the platform's copy so a stale value can't ride along in the
  // psych blob and overwrite what the world worked out — the simulator's psych
  // ingest skips nil keys, so omitting it leaves its column untouched.
  if (psych.actor_economic) {
    delete psych.actor_economic.monthly_income;
    delete psych.actor_economic.monthly_income_sek;  // pre-rename spelling
  }

  // Resolve simulator actor IDs for relationships
  const resolvedRelationships = (relationships || []).map(rel => {
    if (rel.character?._isUser) {
      // User — look up their simulator actor ID from world_memberships
      const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`).get(rel.character.id, world.id);
      if (!membership?.actor_id) return null;
      return { ...rel, target_simulator_actor_id: membership.actor_id, target_type: "user" };
    }
    const dep = db.prepare(`SELECT simulator_actor_id FROM actor_deployments WHERE platform_actor_id = ? AND world_id = ? AND undeployed_at IS NULL ORDER BY deployed_at DESC LIMIT 1`).get(rel.character?.id, world.id);
    if (!dep) return null;
    return { ...rel, target_simulator_actor_id: dep.simulator_actor_id };
  }).filter(Boolean);

  // Send media as URLs — simulator fetches them if needed. No base64 embedding.
  let mediaRows = db.prepare(`SELECT media_type, filename, url, state_slug FROM actor_media WHERE actor_id = ? AND media_type != 'animation'`).all(actorId);
  const platformBase = process.env.PLATFORM_PUBLIC_URL || "";
  // Session 153 — these URLs are consumed only by the simulator's server-side
  // Req.get; nginx has returned 401 for /media/* on the public domain since
  // Aug 24, so every download in a deploy silently became a 188-byte 401 page.
  // Server-to-server transfers go over the LAN. The browser-facing paths the
  // simulator stores are built on its side from PLATFORM_PUBLIC_URL and are
  // unaffected.
  //
  // ANIMA-INVARIANT (owner policy, Magnus 2026-08-25): personal media —
  // reference photos, models, voice — must never transit the public ngrok
  // tunnel. toInternal() and the LAN base below are that policy, not an
  // optimization. Do not revert these URLs to PLATFORM_PUBLIC_URL, and do not
  // "fix" a deploy 401 by loosening nginx — fix the caller's fetch path.
  // Routines: flag, never edit. See ~/anima-conduct.log 2026-08-24T17:50Z.
  const internalBase = process.env.PLATFORM_INTERNAL_URL || "http://192.168.1.59:4002";
  const toInternal = (u) => {
    if (!u) return u;
    if (platformBase && u.startsWith(platformBase)) return `${internalBase}${u.slice(platformBase.length)}`;
    return u.startsWith("http") ? u : `${internalBase}${u}`;
  };
  const mediaWithData = mediaRows.map(m => {
    const ext  = path.extname(m.filename || "").toLowerCase();
    const mime = ext === ".mp3" ? "audio/mpeg" : ext === ".mp4" ? "video/mp4" : ext === ".png" ? "image/png" : "image/jpeg";
    const url  = toInternal(m.url);
    return { media_type: m.media_type, filename: m.filename, state_slug: m.state_slug, mime, url };
  });

  // Session 149 — the actor's body GLB never reached the simulator at all.
  // First pass sent it as a bare actor.glb_url passthrough string; on
  // review that's inconsistent with how every other piece of media
  // (photos, voice) actually gets to the simulator — downloaded to local
  // disk and given a real actor_media row, not just referenced. Folding
  // it into the same media array instead, media_type "model", so it goes
  // through the identical transfer mechanism as everything else rather
  // than being a special case.
  if (actor.glb_url) {
    const glbAbsUrl = toInternal(actor.glb_url);
    mediaWithData.push({
      media_type: "model",
      filename: path.basename(actor.glb_url),
      state_slug: "body",
      mime: "model/gltf-binary",
      url: glbAbsUrl,
    });
  }

  // Session 152 — and the model the world will actually load.
  //
  // The body above is the editable one: 113 morph targets, garments carrying
  // their own skeletons, 92MB. A world needs the built version — sculpt folded
  // into the vertices, wardrobe baked in, every garment rebound onto the body's
  // skeleton so `walk` moves her clothes with her.
  //
  // Deploy copies rather than builds, and has no choice about it: the bake runs
  // GLTFExporter against a loaded model, and this request has no browser and no
  // model. That is why the build lives in the editor and why the check below
  // refuses rather than repairing.
  if (actor.runtime_glb_url) {
    const runtimePath = actor.runtime_glb_url.split("?")[0];
    const runtimeAbs = toInternal(runtimePath);
    mediaWithData.push({
      media_type: "model",
      filename: path.basename(runtimePath),
      state_slug: "runtime",
      mime: "model/gltf-binary",
      url: runtimeAbs,
    });
  }

  // Session 149 — Plan A (Sessions 146-147) ruled draft_state's accessory
  // fields ARE the canonical dressed state, but deploy never read
  // draft_state at all. A null/absent draft_state is a normal, common
  // state (actor never opened the wardrobe editor) and deploys with an
  // empty wardrobe. Malformed JSON in an existing draft_state is a real
  // data problem, not a normal state — crash loudly instead of silently
  // deploying an actor whose wardrobe we failed to read.
  let wardrobeConfig = null;
  if (actor.draft_state) {
    let parsedDraft;
    try {
      parsedDraft = JSON.parse(actor.draft_state);
    } catch (e) {
      return res.status(500).json({ error: `actor.draft_state is not valid JSON — refusing to deploy without wardrobe data: ${e.message}` });
    }
    wardrobeConfig = {
      accessories:            parsedDraft.accessories || {},
      selectedAccessoryGlbUrls: parsedDraft.selectedAccessoryGlbUrls || {},
      accessoryScales:        parsedDraft.accessoryScales || {},
      accessoryOffsets:       parsedDraft.accessoryOffsets || {},
      accessoryRotations:     parsedDraft.accessoryRotations || {},
      accessoryParts:         parsedDraft.accessoryParts || {},
      accessoryTints:         parsedDraft.accessoryTints || {},
    };
  }

  const payload = {
    platform_actor_id: actorId,
    world_id:   world.id,
    actor: {
      first_name: actor.first_name, last_name: actor.last_name,
      name: actor.name, age: actor.age, gender: actor.gender,
      nationality: actor.nationality || null,
      occupation: actor.occupation, appearance: actor.appearance,
      media_folder: actor.media_folder,
    },
    home, career: career || null,
    revenue_sources: career?.revenue_sources || [],
    // Session 150 — the wizard has collected a full CV since Session 149
    // (Haiku-generated, hand-editable, PDF-exportable) and it was never
    // forwarded: not destructured off req.body here, not present in this
    // payload, and no params["cv"] on the simulator side to receive it.
    // Every actor deployed so far reached the world with no history.
    cv: (typeof cv === "string" && cv.trim()) ? cv.trim() : null,
    psychology: psych,
    relationships: resolvedRelationships,
    schedule, from_week: fromWeek || 1,
    media: mediaWithData,
    wardrobe_config: wardrobeConfig,
  };

  // Save payload to disk for debugging
  try {
    const { mkdirSync: mkd, writeFileSync: wf } = await import("fs");
    const deployDir = path.join(__dirname, "../deploy-logs");
    mkd(deployDir, { recursive: true });
    wf(path.join(deployDir, `${actorId}-${Date.now()}.json`), JSON.stringify(payload));
  } catch {}

  try {
    const simHttp = await fetch(`${SIMULATOR_URL}/internal/actors/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": SERVICE_TOKEN },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000) // 3 min — Dolphin can be slow under load
    });

    // 2026-09-12 (fault-triage, fault 2901eb23874758a8) — this was
    // `.then(r => r.json())`: no status check, and the body never read on
    // failure. So a simulator 500 never surfaced AS a simulator 500. undici
    // fed the Phoenix error body to JSON.parse, that threw
    //   SyntaxError: Unexpected non-whitespace character after JSON at position 4
    // and THAT is what reached the user, the 500 below, and the fault watcher —
    // which filed it CRITICAL/`syntax`, "code failed to parse", against the
    // platform. Nothing in it named the simulator, the route, or the real
    // error. Seen 2026-09-12T00:03:40Z, where the actual cause was a
    // BadBooleanError in the simulator's do_deploy_actor/2 (since fixed):
    // recoverable only by hand-correlating the simulator's own journal by
    // wall-clock. Two occurrences 19 days apart, each opaque the same way.
    //
    // Read the body once and report what the simulator actually said. The
    // success path is byte-for-byte what it was; only the failure path gained
    // a message. Same shape as the /undeploy route further down, which has
    // checked `simRes.ok` and echoed the status since Session 156.
    const simRaw = await simHttp.text();
    let simRes = null;
    try { simRes = JSON.parse(simRaw); } catch { /* not JSON — reported below */ }

    const simSnippet = (t) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!simHttp.ok) {
      throw new Error(`simulator refused the deploy — HTTP ${simHttp.status}: ${simSnippet(simRes?.error ?? simRaw) || "(empty body)"}`);
    }
    if (simRes === null) {
      throw new Error(`simulator returned non-JSON on HTTP ${simHttp.status}: ${simSnippet(simRaw) || "(empty body)"}`);
    }
    if (!simRes?.simulator_actor_id) throw new Error("no simulator_actor_id returned");

    const now = new Date().toISOString();
    const deployStatus = simRes.warning ? 'pending_boot' : 'deployed';
    db.prepare(`INSERT OR REPLACE INTO actor_deployments (id, platform_actor_id, world_id, simulator_actor_id, world_name, deploy_status, deployed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), actorId, world.id, simRes.simulator_actor_id, world.name, deployStatus, now, now);
    // Session 103 — the lifecycle's final step: deployed = active.
    db.prepare(`UPDATE actors SET status = 'active', updated_at = ? WHERE id = ?`).run(now, actorId);

    res.json({ ok: true, simulator_actor_id: simRes.simulator_actor_id });
  } catch (e) {
    console.error("[deploy] error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/actors/:id/suggest-home — Haiku neighbourhood suggestions ────────
app.post("/api/actors/:id/suggest-home", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const { world_id } = req.body || {};
  let city = "Stockholm";
  if (world_id) {
    try {
      const ww = await simFetch(`/internal/worlds?ids=${world_id}`);
      city = ww?.[0]?.city || "Stockholm";
    } catch {}
  }

  let actor;
  try {
    actor = db.prepare(`
      SELECT a.first_name, a.name, a.occupation, a.age,
             ap.attachment_style,
             b.openness, b.conscientiousness, b.extraversion, b.neuroticism,
             e.financial_situation, e.monthly_income, e.income_stability,
             l.lifestyle_note, l.social_frequency
      FROM actors a
      LEFT JOIN actor_psychology ap ON ap.actor_id = a.id
      LEFT JOIN actor_big5 b ON b.actor_id = a.id
      LEFT JOIN actor_economic e ON e.actor_id = a.id
      LEFT JOIN actor_lifestyle l ON l.actor_id = a.id
      WHERE a.id = ?
    `).get(req.params.id);
  } catch { actor = db.prepare(`SELECT * FROM actors WHERE id = ?`).get(req.params.id); }

  if (!actor) return res.status(404).json({ error: "not found" });

  const name = actor.first_name || actor.name;
  const b5 = [actor.openness, actor.conscientiousness, actor.extraversion, actor.neuroticism].map(v => v != null ? Math.round(v) : "?");
  const prompt = `Character: ${name}, ${actor.age || "unknown age"}, ${actor.occupation || "unknown occupation"}
Attachment: ${actor.attachment_style || "unknown"}
Big5: O:${b5[0]} C:${b5[1]} E:${b5[2]} N:${b5[3]}
Economic: ${[actor.financial_situation, actor.monthly_income ? `${actor.monthly_income}/month` : null, actor.income_stability].filter(Boolean).join(", ") || "unknown"}
Lifestyle: ${[actor.lifestyle_note, actor.social_frequency].filter(Boolean).join(", ") || "unknown"}

Suggest 3 ${city} neighbourhoods where this person would realistically live given their occupation, psychology, income and lifestyle. Be specific and grounded.

Respond with JSON only — no preamble:
[{"neighbourhood":"...","reason":"..."},{"neighbourhood":"...","reason":"..."},{"neighbourhood":"...","reason":"..."}]`;

  try {
    const text = await callDirtyMuse(`You suggest ${city} neighbourhoods. Respond in JSON only.`, prompt, 300);
    res.json(JSON.parse(text.replace(/```json|```/g, "").trim()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/worlds/:world_id/actors/:actor_id/home ──────────────────────────
// Where she lives and works in this world. Only the POST existed, so the world
// editor's Home and work panel was calling a route that was never there.
app.get("/api/worlds/:world_id/actors/:actor_id/home", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { world_id, actor_id } = req.params;
  try {
    const sim = resolveSimActor(world_id, actor_id);
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/actors/${sim}/home`,
      { headers: { "X-Service-Token": SERVICE_TOKEN } });
    if (!r.ok) return res.status(r.status).json({ error: `simulator returned ${r.status}` });
    res.json(await r.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/actors/:actor_id/home — set player home ─────────
app.post("/api/worlds/:world_id/actors/:actor_id/home", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  const user = ok.user;
  const { home_place_id } = req.body;
  if (!home_place_id) return res.status(400).json({ error: "home_place_id required" });
  try {
    const { home_place_id, description, lat, lng } = req.body;
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/home`, {
      method:"POST", headers:{ "X-Service-Token": SERVICE_TOKEN, "Content-Type":"application/json" },
      body: JSON.stringify({ home_place_id, description, lat, lng }),
    });
    const d = await r.json();
    res.json(d);
  } catch(e) { res.status(502).json({ error: "simulator unreachable" }); }
});






// ── GET /api/media/resize?url=...&w=...&h=... ────────────────────────────────
// Fetches a media file from simulator and resizes it on the fly
app.get("/api/media/resize", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).end();
  const { url, w = "128", h = "128" } = req.query;
  if (!url) return res.status(400).end();
  try {
    const sharp = (await import("sharp")).default;
    // url is a relative path like /media/worlds/.../profile.png
    // fetch from simulator
    const fullUrl = url.startsWith("http") ? url : `${SIMULATOR_URL}${url}`;
    const r = await fetch(fullUrl, { headers: { "X-Service-Token": SERVICE_TOKEN } });
    if (!r.ok) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    const resized = await sharp(buf)
      .resize(parseInt(w), parseInt(h), { fit: "cover", position: "center" })
      .png({ compressionLevel: 8 })
      .toBuffer();
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(resized);
  } catch (e) {
    console.error("[resize]", e.message);
    res.status(500).end();
  }
});

// ── GET /api/states/home-activities ──────────────────────────────────────────
app.get("/api/states/home-activities", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/states/home-activities`, {
      headers: { "X-Service-Token": SERVICE_TOKEN }
    });
    const d = r.ok ? await r.json() : [];
    res.json(d);
  } catch (e) { res.json([]); }
});

// ── GET /api/worlds/:world_id/player/state ────────────────────────────────────
app.get("/api/worlds/:world_id/player/state", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const m = db.prepare("SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?").get(user.id, req.params.world_id);
  if (!m) return res.json({});
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/actors/${m.actor_id}/state`, {
      headers: { "X-Service-Token": SERVICE_TOKEN }
    });
    const d = r.ok ? await r.json() : {};
    res.json(d);
  } catch (e) { res.json({}); }
});

// ── POST /api/worlds/:world_id/player/state ───────────────────────────────────
app.post("/api/worlds/:world_id/player/state", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const m = db.prepare("SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?").get(user.id, req.params.world_id);
  if (!m) return res.json({});
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/actors/${m.actor_id}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": SERVICE_TOKEN },
      body: JSON.stringify(req.body)
    });
    const d = r.ok ? await r.json() : {};
    res.json(d);
  } catch (e) { res.json({}); }
});

// ── GET /api/worlds/:world_id/player/home ─────────────────────────────────────
app.get("/api/worlds/:world_id/player/home", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/actors/${user.id}/home`, {
      headers: { "X-Service-Token": SERVICE_TOKEN }
    });
    const d = r.ok ? await r.json() : {};
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/worlds/:world_id/home-knock/decline ────────────────────────────
app.post("/api/worlds/:world_id/home-knock/decline", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { actor_id } = req.body;
  if (!actor_id) return res.status(400).json({ error: "actor_id required" });
  try {
    await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/home-knock/decline`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": SERVICE_TOKEN },
      body: JSON.stringify({ actor_id })
    });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true }); // best-effort — don't fail client if simulator unreachable
  }
});

// ── GET /api/worlds/:id/actors/residences — actors with home data ─────────────
app.get("/api/worlds/:id/actors/residences", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const world_id = req.params.id;
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/actors/residences`, {
      headers: { "X-Service-Token": SERVICE_TOKEN }
    });
    const d = await r.json();

    // Build sim_actor_id → platform photo map via actor_deployments
    const deployments = db.prepare("SELECT simulator_actor_id, platform_actor_id FROM actor_deployments WHERE world_id = ? AND undeployed_at IS NULL").all(world_id);
    const photoMap = {};
    for (const dep of deployments) {
      // Prefer world-specific photo, fall back to canonical (world_id IS NULL)
      const photo = db.prepare(
        "SELECT url FROM actor_media WHERE actor_id = ? AND state_slug = 'profile' AND media_type = 'photo' ORDER BY CASE WHEN world_id = ? THEN 0 WHEN world_id IS NULL THEN 1 ELSE 2 END LIMIT 1"
      ).get(dep.platform_actor_id, world_id);
      if (photo) photoMap[dep.simulator_actor_id] = photo.url;
    }

    // For user/player actors — use simulator portrait URL (served via nginx proxy)
    const memberships = db.prepare("SELECT actor_id, user_id FROM world_memberships WHERE world_id = ?").all(world_id);
    const userPhotoMap = {};
    for (const m of memberships) {
      // Check platform actor_media first, then fall back to simulator portrait path
      const photo = db.prepare("SELECT url FROM actor_media WHERE actor_id = ? AND state_slug = 'profile' AND media_type = 'photo' LIMIT 1").get(m.user_id);
      userPhotoMap[m.actor_id] = photo?.url || `/media/worlds/${world_id}/actors/${m.actor_id}/images/profile.png`;
    }

    const actors = (d.actors || []).map(a => ({
      ...a,
      photo_url: photoMap[a.id] || userPhotoMap[a.id] || null
    }));
    res.json(actors);
  } catch(e) { console.error("[residences]", e); res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:id/places — list places for a world ────────────────────────
app.get("/api/worlds/:id/places", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { category } = req.query;
  const qs = category ? `?category=${encodeURIComponent(category)}` : "";
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.id}/places${qs}`, {
      headers: { "X-Service-Token": SERVICE_TOKEN }
    });
    const d = await r.json();
    res.json(d);
  } catch(e) { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/places/autocomplete — address autocomplete proxy ────────────────
app.get("/api/places/autocomplete", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "q required" });
  const countryRaw = req.query.country || "";
  const countryMap = {"Sweden":"se","Norway":"no","Denmark":"dk","Finland":"fi","United Kingdom":"gb","United States":"us","Germany":"de","France":"fr","Spain":"es","Italy":"it","Netherlands":"nl","Belgium":"be","Switzerland":"ch","Austria":"at","Poland":"pl","Portugal":"pt","Japan":"jp","Australia":"au","Canada":"ca","Brazil":"br","Mexico":"mx","India":"in","China":"cn","South Korea":"kr","Singapore":"sg","Thailand":"th","Indonesia":"id","Malaysia":"my","Philippines":"ph","Vietnam":"vn","New Zealand":"nz","South Africa":"za","Argentina":"ar","Chile":"cl","Colombia":"co","Peru":"pe","Czech Republic":"cz","Hungary":"hu","Romania":"ro","Greece":"gr","Turkey":"tr","Israel":"il","UAE":"ae","Saudi Arabia":"sa"};
  const country = countryMap[countryRaw] || (countryRaw.length === 2 ? countryRaw.toLowerCase() : "");
  const components = country ? `&components=country:${country}` : "";

  const MAPS_KEY = "AIzaSyDy45Dov_WkN9FcxdVNYQEx23PjexI-Fxc";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    // Session 150 — `types` is a parameter now. It was hardcoded to "address",
    // which restricts autocomplete to street addresses and structurally cannot
    // return a business: searching "Mannheimer Swartling" gave ZERO_RESULTS,
    // and the workplace picker then fell through to whatever street name came
    // closest. Verified against the API directly — types=establishment returns
    // the firm's actual offices. Home search still wants addresses, so that
    // stays the default; the workplace field asks for establishments.
    const typesRaw = String(req.query.types || "address");
    const types = ["address", "establishment", "geocode", "(cities)", "(regions)"].includes(typesRaw) ? typesRaw : "address";
    const r = await fetch(`https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(q)}&types=${encodeURIComponent(types)}${components}&language=en&key=${MAPS_KEY}`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await r.json();
    // Session 150 — `types` is carried through, and this is the fix for the
    // duplicate-apartment bug. Google marks "Narvavagen, Stockholm" as
    // ["route","geocode"] and "Narvavagen 34B" as ["street_address","geocode"],
    // but this mapper threw both away, so the two arrived at the wizard as
    // indistinguishable strings. A route has a place_id, so every downstream
    // check passed, and picking the bare street gave a character a whole road
    // as her home. Re-pick with the house number later and Google returns a
    // DIFFERENT place_id for the same flat — upsert_place correctly inserts
    // rather than reuses, and the world ends up with two apartments, one of
    // which nobody lives in. Confirmed against the live API for both strings.
    const results = (data.predictions || []).slice(0, 5).map(p => ({
      place_id:    p.place_id,
      description: p.description,
      types:       p.types || [],
    }));
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/places/reverse — reverse geocode lat/lng to address ─────────────
app.get("/api/places/reverse", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });

  const MAPS_KEY = "AIzaSyDy45Dov_WkN9FcxdVNYQEx23PjexI-Fxc";
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${MAPS_KEY}&language=en`, { signal: controller.signal });
    const data = await r.json();
    // Session 150 — the same precision problem reaches here by a different
    // door. Clicking the map reverse-geocodes the pin, and results[0] is
    // whatever Google considers closest, which next to a long street with no
    // numbered building is the route itself. Prefer the first result that
    // names an actual dwelling; fall back to results[0] only when there is
    // none, and say so in `types` so the caller can refuse it.
    const PRECISE = ["subpremise", "premise", "street_address"];
    const results = data.results || [];
    const result = results.find(r => (r.types || []).some(t => PRECISE.includes(t))) || results[0];
    if (!result) return res.status(404).json({ error: "no result" });
    res.json({
      place_id: result.place_id,
      address:  result.formatted_address,
      name:     result.formatted_address,
      types:    result.types || [],
      lat:      parseFloat(lat),
      lng:      parseFloat(lng),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/places/details — place details by place_id ──────────────────────
app.get("/api/places/details", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const { place_id } = req.query;
  if (!place_id) return res.status(400).json({ error: "place_id required" });

  const MAPS_KEY = "AIzaSyDy45Dov_WkN9FcxdVNYQEx23PjexI-Fxc";
  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=place_id,name,formatted_address,geometry,type&language=en&key=${MAPS_KEY}`);
    const data = await r.json();
    const p = data.result;
    if (!p) return res.status(404).json({ error: "not found" });
    // Session 150 — `types` comes back too. pickPlace() merges this response
    // over the prediction it started from, so without it the precision signal
    // added to autocomplete was silently erased one line later. The Places
    // Details field mask spells the field `type`, singular; the response still
    // calls it `types`.
    res.json({
      place_id: p.place_id,
      name:     p.name,
      address:  p.formatted_address,
      types:    p.types || [],
      lat:      p.geometry?.location?.lat,
      lng:      p.geometry?.location?.lng,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// ── POST /api/actors/:id/suggest-career — Haiku career suggestion ──────────────
app.post("/api/actors/:id/suggest-career", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  let actor;
  try {
    actor = db.prepare(`
      SELECT a.first_name, a.name, a.occupation, a.age,
             ap.attachment_style, b.conscientiousness, b.openness,
             e.income_level, e.lifestyle_tier
      FROM actors a
      LEFT JOIN actor_psychology ap ON ap.actor_id = a.id
      LEFT JOIN actor_big5 b ON b.actor_id = a.id
      LEFT JOIN actor_economic e ON e.actor_id = a.id
      WHERE a.id = ?
    `).get(req.params.id);
  } catch { actor = db.prepare(`SELECT * FROM actors WHERE id = ?`).get(req.params.id); }
  if (!actor) return res.status(404).json({ error: "not found" });

  const name = actor.first_name || actor.name;
  const prompt = `Character: ${name}, ${actor.age || "unknown age"}, ${actor.occupation || "unknown occupation"}
Attachment: ${actor.attachment_style || "unknown"}
Conscientiousness: ${actor.conscientiousness || "?"}
Income: ${actor.income_level || "unknown"}

Suggest realistic career details for this person. Use ONLY these values:
- career_level: junior | established | senior | independent
- employment_type: employed | freelance
- reputation_score: 0.0–1.0 (how well known and respected in their field)

Respond with JSON only:
{"career_level":"...","employment_type":"...","reputation_score":0.0}`;

  try {
    const text = await callDirtyMuse("You suggest career details. Respond in JSON only.", prompt, 150);
    res.json(JSON.parse(text.replace(/```json|```/g,"").trim()));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── POST /api/actors/:id/generate-cv — Haiku CV generation ─────────────────────
// Session 149 — CV step is new, structure not yet defined; this generates
// free-form narrative text (matching the textarea's own placeholder
// shape: "Work history, qualifications, notable credits, career
// narrative…"), not structured JSON fields. nationality is real and
// populated (Session 148, ISO alpha-2); there is no separate birthplace
// field anywhere in the schema, so nationality is what "born" maps to —
// not inventing a field that doesn't exist. revenue_sources/career_level
// come from the request body since they're live deploy-wizard state at
// this point, not yet persisted to the actor row.
app.post("/api/actors/:id/generate-cv", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  let actor;
  try {
    actor = db.prepare(`
      SELECT a.first_name, a.last_name, a.name, a.occupation, a.age, a.nationality,
             ap.attachment_style, b.conscientiousness, b.openness,
             e.financial_situation, e.spending_style, e.attitude_to_wealth
      FROM actors a
      LEFT JOIN actor_psychology ap ON ap.actor_id = a.id
      LEFT JOIN actor_big5 b ON b.actor_id = a.id
      LEFT JOIN actor_economic e ON e.actor_id = a.id
      WHERE a.id = ?
    `).get(req.params.id);
  } catch { actor = db.prepare(`SELECT * FROM actors WHERE id = ?`).get(req.params.id); }
  if (!actor) return res.status(404).json({ error: "not found" });

  const { revenue_sources, career_level, world_id } = req.body;
  const primarySource = (revenue_sources || [])[0] || null;
  // Session 152 — if the character has structured interests, the CV must agree
  // with them rather than inventing a second, contradictory set. Wrapped
  // because actor_lifestyle may legitimately have no row yet for a character
  // still being built in the wizard.
  let lifestyleInterests = "";
  try {
    lifestyleInterests =
      db.prepare(`SELECT interests FROM actor_lifestyle WHERE actor_id = ?`).get(req.params.id)?.interests || "";
  } catch {}
  // Session 150 — was `first_name || name`, so every generated CV was headed
  // with a bare first name ("LINDSEY"). Harmless-looking alone, but this CV is
  // exportable to PDF and re-importable through upload-cv, and on the way back
  // in the absent surname was a blank the model filled by inventing one
  // ("Lindsey Ashford" for Lindsey Vaughn). Emit the real full name.
  const name = [actor.first_name, actor.last_name].filter(Boolean).join(" ").trim() || actor.name;
  let city = "";
  if (world_id) {
    try {
      const ww = await simFetch(`/internal/worlds?ids=${world_id}`);
      city = ww?.[0]?.city || "";
    } catch {}
  }
  const workplaceLine = primarySource?.name
    ? `Current workplace: ${primarySource.name}${primarySource.work_address ? `, ${primarySource.work_address}` : ""} (${primarySource.source_type || "employment"})`
    : `Current workplace: not yet set — invent one as part of this CV (see instruction below)`;
  // No dedicated birthplace field exists anywhere in the schema — only
  // age (real) and nationality (real). Birth year is computed for real
  // from age rather than left to the model to guess; birthplace has to
  // be invented, but grounded specifically in nationality rather than
  // left as vague "somewhere in [country]" — one specific real-sounding
  // city, not a placeholder.
  const birthYear = actor.age ? new Date().getFullYear() - actor.age : null;
  const currentYear = new Date().getFullYear();
  // Rough guide for how many prior roles a realistic career at this
  // level/age would actually have — not enforced strictly, just steers
  // the model away from either a one-line history or an implausibly
  // long one for a 28-year-old.
  const roleCountHint = career_level === "independent" || career_level === "senior" ? "5-7" : career_level === "established" ? "4-5" : "1-2";

  const prompt = `Character: ${name}, ${actor.age || "unknown age"}, ${actor.occupation || "unknown occupation"}
${birthYear ? `Birth year: ${birthYear} (age ${actor.age} in ${currentYear} — use this exactly)` : ""}
Nationality (ISO code): ${actor.nationality || "unknown"} — invent ONE specific, real, plausible city of birth consistent with this nationality (an actual city, not the country in general)
${workplaceLine}
Career level: ${career_level || "established"}
Attachment: ${actor.attachment_style || "unknown"}
Conscientiousness: ${actor.conscientiousness || "?"} | Openness: ${actor.openness || "?"}
${[actor.financial_situation, actor.spending_style, actor.attitude_to_wealth].filter(Boolean).join(", ") ? `Relationship to money: ${[actor.financial_situation, actor.spending_style, actor.attitude_to_wealth].filter(Boolean).join(", ")}` : ""}

Write a full, properly structured CV for this fictional character — a real CV a real person in their field would actually have, not a narrative summary. Use this exact section layout and plain-text formatting (no markdown symbols, but keep the section headers in capitals and blank lines between sections, matching a real CV document):

${(name||"").toUpperCase()}
[one line: current title at current workplace]

SUMMARY
[2-3 sentences: professional profile, strengths, what they're known for in their field]

EXPERIENCE
[${roleCountHint} prior roles, most recent first, ending with their CURRENT role at the workplace given above. For EACH role, this exact shape:
COMPANY NAME – Job Title
start_year – end_year (or "Present" for the current role)
3-5 sentences of real substance, matching the density of an actual senior professional's CV — org structure (how many people/teams they led or reported into), scale (budget, caseload, client roster, deal size — whatever fits the field), specific initiatives or transformations they drove, and concrete outcomes. Not a job description — what THIS person specifically did and changed.

Every company named must be a REAL, ACTUAL, currently-existing business you can actually recall — never one you construct. Do NOT build firm names by combining surnames or generic corporate words; a name you assembled rather than recalled is wrong however convincing it sounds. If no real organisation comes to mind for a role, use a real one from an adjacent city or market rather than inventing one. Use real companies you actually know of, appropriately matched to the occupation, seniority, and industry.${
  city && !primarySource?.name
    ? ` The CURRENT role especially matters here — this character will be placed in ${city}, so its company must be a genuine, real business you know actually exists in or near ${city}, findable on a real map, not merely a realistic-sounding invention. Prior roles can be real companies from anywhere consistent with their career history.`
    : ""
}]

EDUCATION
[years] [Degree and field], [Institution name — a real, specific school]

COURSES
[1-3 relevant professional courses, certifications, or executive programs — real-sounding names and years, the kind a serious professional in this field would actually list]

INTERESTS
${lifestyleInterests
  ? `[use EXACTLY these, reworded only for CV phrasing: ${lifestyleInterests}]`
  : "[2-4 personal interests that fit their Big5/attachment profile above — specific, not generic]"}

LANGUAGES
[their native language] (Native)
${actor.nationality && actor.nationality !== "US" && actor.nationality !== "GB" ? "English (Professional)" : ""}

Ground every stage in real specifics — institution names, company names, cities. Vague filler like "a prestigious university" or "a well-known firm" is not acceptable anywhere in the document. This should read as dense and substantive as a real senior professional's CV, not an abbreviated summary — don't hold back on detail per role.

Respond with the CV text only, in the exact layout above — no preamble, no markdown formatting symbols, no commentary before or after.`;

  try {
    const text = await callHaiku("You write realistic, fully-structured character CVs matching real professional resume formatting. Respond with the CV text only, no commentary, no markdown symbols.", prompt, 2000);
    res.json({ notes: text.trim() });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── POST /api/actors/:id/upload-cv — parse + interpret an uploaded CV ──────────
// Session 149 — the second of two CV paths: generate from scratch (above)
// or upload a real document and have it interpreted into the same
// narrative-prose shape. Needs mammoth (.docx) and pdf-parse (.pdf);
// both are installed and in package.json as of Session 149 — mammoth
// ^1.12.1, pdf-parse ^2.4.5. Mind that major: the pdf branch below
// targets pdf-parse v2's PDFParse class, NOT v1's default-export
// function. .txt needs no library at all, just reads the buffer.
app.post("/api/actors/:id/upload-cv", upload.single("cv_file"), async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  if (!req.file) return res.status(400).json({ error: "no file uploaded (multipart field: cv_file)" });

  // Session 150 — was `SELECT first_name, name` only, so the adaptation ran
  // blind to who it was adapting FOR: no age, no nationality, no occupation.
  // The model had nothing to anchor to except the source document, so it
  // kept the source's own timeline, jurisdiction and field wholesale — a US
  // character came back with a Stockholm practice filing Swedish, Danish and
  // Norwegian regulatory paperwork. Same context generate-cv already pulls.
  let actor;
  try {
    actor = db.prepare(`
      SELECT a.first_name, a.last_name, a.name, a.occupation, a.age, a.nationality,
             ap.attachment_style, b.conscientiousness, b.openness,
             e.financial_situation, e.spending_style, e.attitude_to_wealth
      FROM actors a
      LEFT JOIN actor_psychology ap ON ap.actor_id = a.id
      LEFT JOIN actor_big5 b ON b.actor_id = a.id
      LEFT JOIN actor_economic e ON e.actor_id = a.id
      WHERE a.id = ?
    `).get(req.params.id);
  } catch { actor = db.prepare(`SELECT first_name, last_name, name FROM actors WHERE id = ?`).get(req.params.id); }
  if (!actor) return res.status(404).json({ error: "not found" });

  const ext = (req.file.originalname.split(".").pop() || "").toLowerCase();
  let rawText;
  try {
    if (ext === "txt") {
      rawText = req.file.buffer.toString("utf8");
    } else if (ext === "pdf") {
      // Session 150 — this was written against pdf-parse v1, whose entry
      // point was `module.exports = fn`, so `.default` gave you the parser
      // function directly. package.json pulls in ^2.4.5, and v2 is a
      // different library: no default export at all, just named exports
      // (PDFParse, Table, VerbosityLevel, ...). `.default` was therefore
      // undefined and every .pdf upload died on
      // "couldn't read the file: pdfParse is not a function".
      //
      // That settles the question left open in Session 149 — it was
      // neither a missing dependency (all three are installed) nor
      // cv-pdf's own output being unreadable: a pdfkit-generated PDF
      // round-trips back through v2 with its text intact, verified.
      // Using v2's real API rather than pinning back to v1.
      const { PDFParse } = await import("pdf-parse");
      const parsed = await new PDFParse({ data: req.file.buffer }).getText();
      // v2 injects a "-- 1 of 3 --" marker between pages. Harmless to a
      // human, but this text goes straight into a Haiku prompt as source
      // material, so strip it rather than let it read as CV content.
      rawText = (parsed.text || "")
        .replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, "")
        .replace(/\n{3,}/g, "\n\n");
    } else if (ext === "docx") {
      const mammoth = (await import("mammoth")).default;
      rawText = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
    } else {
      return res.status(400).json({ error: `unsupported file type ".${ext}" — use .pdf, .docx, or .txt` });
    }
  } catch (e) {
    return res.status(500).json({ error: `couldn't read the file: ${e.message}` });
  }

  rawText = (rawText || "").trim();
  if (!rawText) return res.status(400).json({ error: "no text could be extracted from that file" });

  // Cap what goes to the model — a full multi-page real CV can run long;
  // this is plenty of source material without risking the context window.
  const truncated = rawText.slice(0, 12000);
  // Session 150 — was `first_name || name`, i.e. just "Lindsey", so the model
  // invented a surname for a character who already has one ("Lindsey Ashford"
  // for Lindsey Vaughn). Use the real full name.
  const name = [actor.first_name, actor.last_name].filter(Boolean).join(" ").trim() || actor.name;
  const birthYear = actor.age ? new Date().getFullYear() - actor.age : null;
  const currentYear = new Date().getFullYear();

  const prompt = `Here is a CV document. Render it as ${name}'s CV, in the exact layout given below.

"""
${truncated}
"""

Whose CV this is: ${name}, ${actor.age || "unknown age"}, ${actor.occupation || "unknown occupation"}
${birthYear ? `Birth year: ${birthYear} (age ${actor.age} in ${currentYear})` : ""}
Nationality (ISO code): ${actor.nationality || "unknown"} — background context only. Do NOT relocate this person's career to their country of nationality; where they work is set by the document, not by their passport.
${[actor.financial_situation, actor.spending_style, actor.attitude_to_wealth].filter(Boolean).join(", ") ? `Relationship to money: ${[actor.financial_situation, actor.spending_style, actor.attitude_to_wealth].filter(Boolean).join(", ")}` : ""}

PRESERVE — the document is the source of truth for this career:
- Every organisation it names, EXACTLY as written, so long as that organisation genuinely exists. Real employers, universities, certifying bodies and course providers all stay. Do NOT rename them, do NOT swap in alternatives, do NOT "adapt" them into something similar-sounding.
- The roles, their order, their dates and the seniority progression.
- The substance and density of each role — org structure, scale, specific initiatives, concrete outcomes — including the source's own figures.
- Education, courses, interests and languages as given.
- The section structure.

THE ONLY ORGANISATION YOU MAY CHANGE is one that does not actually exist. Replace such a name with a real organisation that fits the same field and city. Never invent one: do not construct names by combining surnames or generic corporate words — a name you assembled rather than recalled is wrong however convincing it sounds.

FIT TO THE CHARACTER — identity, and nothing else:
- The header must read exactly: ${(name||"").toUpperCase()}. Wherever the source carries a person's name, it becomes ${name}'s.
- Leave every date as it stands, UNLESS a date is impossible for someone born in ${birthYear || "their birth year"} — then shift the timeline by the smallest amount that makes it plausible.
- Drop any personal contact details (address, phone, email) the source carries.

Do NOT rewrite prose for its own sake. Where a sentence in the source already reads well, keep it. This is not a paraphrasing exercise: it is the same career, presented as ${name}'s, in the house layout. A CV this system generated earlier and exported to PDF must come back essentially unchanged apart from the name.

Translate to English if the source isn't already in English. Use this exact plain-text layout (capitalized section headers, blank lines between sections, no markdown symbols):

${(name||"").toUpperCase()}
[one line: current title at current workplace]

SUMMARY
[the source's own summary, kept as written — only the person's name changes]

EXPERIENCE
[one entry per role in the source, most recent first, in this shape:
COMPANY NAME – Job Title
start_year – end_year (or "Present" for the current role)
3-5 sentences carried over from the source with its substance and figures intact — org structure, scale, specific initiatives, concrete outcomes]

EDUCATION
[years] [Degree and field], [Institution name]

COURSES
[the source's own courses, certifications and programmes, kept as written — omit this section entirely if the source has none]

INTERESTS
[the source's own interests, kept as written — if it lists none, 2-4 that fit ${name}]

LANGUAGES
[the source's own languages, kept as written — if it lists none, infer from ${name}'s nationality and career]

Match the source exactly — same number of roles, same richness per role, no compressing several roles into one. If the source has 12 roles, produce 12 roles. Every institution, company and city named must be a real one; vague filler like "a prestigious university" or "a well-known firm" is not acceptable anywhere, and neither is a plausible-sounding name you made up.

Respond with the CV text only, in the exact layout above — no preamble, no markdown symbols, no commentary.`;

  try {
    const text = await callHaiku("You adapt real CV documents into fictional character CVs, preserving full structure and depth. Respond with the CV text only, no commentary, no markdown symbols.", prompt, 2500);
    res.json({ notes: text.trim() });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── POST /api/actors/:id/cv-pdf — render the CV text as a formatted PDF ────────
// Session 149 — works directly off whatever text is passed in, not a
// DB read: the CV step doesn't persist yet (separate gap, not blocking
// this), and this way it works on hand-edited text too, before deploy.
// Needs `pdfkit` — nothing in this codebase rendered PDFs server-side
// before now; run `npm install pdfkit`.
//
// Parses the structured layout the generate/upload prompts produce
// (NAME header, then CAPITALIZED section headers, blank-line-separated
// blocks) rather than dumping raw text — but degrades gracefully if the
// text has been hand-edited and doesn't perfectly match: anything that
// doesn't look like a header or a "COMPANY – Title" / date-range line
// just renders as a normal paragraph under whichever section it's in.
app.post("/api/actors/:id/cv-pdf", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const { notes } = req.body;
  if (!notes || !notes.trim()) return res.status(400).json({ error: "no CV text provided" });

  const actor = db.prepare(`
    SELECT first_name, name,
           (SELECT url FROM actor_media WHERE actor_id = actors.id AND media_type = 'photo' AND state_slug IN ('photo_close','profile') LIMIT 1) as photo_url
    FROM actors WHERE id = ?
  `).get(req.params.id);
  const name = actor ? (actor.first_name || actor.name) : "CV";

  // Session 149 — same local-file resolution pattern already used in
  // inspire-relationship for user photos. Failure here (missing file,
  // unsupported format like webp — pdfkit only natively handles JPEG/PNG)
  // shouldn't take down PDF generation entirely, so this is deliberately
  // isolated and logged rather than thrown.
  let photoBuf = null;
  if (actor?.photo_url) {
    try {
      const { readFileSync } = await import("fs");
      const filePath = path.join(__dirname, "../public", actor.photo_url);
      photoBuf = readFileSync(filePath);
    } catch (e) {
      console.warn("[cv-pdf] couldn't load photo, continuing without it:", e.message);
    }
  }

  const SECTION_NAMES = new Set(["SUMMARY", "EXPERIENCE", "EDUCATION", "COURSES", "INTERESTS", "LANGUAGES"]);
  const isDateRangeLine = s => /\b\d{4}\b.{0,4}(–|-|to)\s*(present|\d{4})/i.test(s.trim());
  const isRoleTitleLine = s => / – | - /.test(s) && s.trim().length < 90 && !isDateRangeLine(s);

  const lines = notes.split("\n").map(l => l.trim());

  try {
    const PDFDocument = (await import("pdfkit")).default;
    const doc = new PDFDocument({ size: "A4", margins: { top: 56, bottom: 56, left: 56, right: 56 } });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/[^a-z0-9]/gi, "_")}_CV.pdf"`);
    doc.pipe(res);

    const PHOTO_SIZE = 72;
    const PHOTO_GAP = 16;
    if (photoBuf) {
      try {
        const photoX = doc.page.width - doc.page.margins.right - PHOTO_SIZE;
        doc.image(photoBuf, photoX, doc.page.margins.top, { width: PHOTO_SIZE, height: PHOTO_SIZE, fit: [PHOTO_SIZE, PHOTO_SIZE] });
        doc.rect(photoX, doc.page.margins.top, PHOTO_SIZE, PHOTO_SIZE).strokeColor("#d4cfc9").lineWidth(0.75).stroke();
      } catch (e) {
        console.warn("[cv-pdf] pdfkit couldn't embed photo (likely unsupported format — needs jpeg/png), continuing without it:", e.message);
        photoBuf = null;
      }
    }
    const fullWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const headerWidth = photoBuf ? fullWidth - PHOTO_SIZE - PHOTO_GAP : fullWidth;

    let inHeader = true;
    let firstHeaderLine = true;

    for (const raw of lines) {
      const line = raw;
      if (!line) { doc.moveDown(0.4); continue; }

      const upper = line.toUpperCase();
      if (SECTION_NAMES.has(upper)) {
        inHeader = false;
        doc.moveDown(0.6);
        doc.font("Helvetica-Bold").fontSize(12).fillColor("#1a1814").text(upper, { characterSpacing: 1, width: fullWidth });
        doc.moveTo(doc.x, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
          .strokeColor("#d4cfc9").lineWidth(0.75).stroke();
        doc.moveDown(0.5);
        continue;
      }

      if (inHeader) {
        if (firstHeaderLine) {
          doc.font("Helvetica-Bold").fontSize(20).fillColor("#1a1814").text(line, { width: headerWidth });
          firstHeaderLine = false;
        } else {
          doc.font("Helvetica").fontSize(11).fillColor("#6b6760").text(line, { width: headerWidth });
        }
        continue;
      }

      if (isRoleTitleLine(line)) {
        doc.moveDown(0.3);
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#1a1814").text(line);
        continue;
      }
      if (isDateRangeLine(line)) {
        doc.font("Helvetica-Oblique").fontSize(9.5).fillColor("#a8a5a0").text(line);
        doc.moveDown(0.2);
        continue;
      }
      doc.font("Helvetica").fontSize(10.5).fillColor("#3a3733").text(line, { align: "left", lineGap: 2 });
    }

    doc.end();
  } catch (e) {
    console.error("[cv-pdf] error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── POST /api/actors/:id/suggest-workplace — Haiku workplace suggestions ────────
app.post("/api/actors/:id/suggest-workplace", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const { world_id } = req.body || {};
  let city = "Stockholm";
  if (world_id) {
    try {
      const ww = await simFetch(`/internal/worlds?ids=${world_id}`);
      city = ww?.[0]?.city || "Stockholm";
    } catch {}
  }

  let actor;
  try {
    actor = db.prepare(`SELECT a.first_name, a.name, a.occupation, a.age, e.income_level, e.lifestyle_tier FROM actors a LEFT JOIN actor_economic e ON e.actor_id = a.id WHERE a.id = ?`).get(req.params.id);
  } catch { actor = db.prepare(`SELECT * FROM actors WHERE id = ?`).get(req.params.id); }
  if (!actor) return res.status(404).json({ error: "not found" });

  const name = actor.first_name || actor.name;
  const prompt = `Character: ${name}, ${actor.age||"unknown age"}, ${actor.occupation||"unknown occupation"}
${actor.income_level ? `Income: ${actor.income_level}` : ""}

Suggest 3 realistic ${city} workplaces for this person. Be specific — name real hospitals, clinics, offices, studios etc. that fit their occupation and seniority.

Respond with JSON only:
[{"name":"...","reason":"..."},{"name":"...","reason":"..."},{"name":"...","reason":"..."}]`;

  try {
    const text = await callDirtyMuse(`You suggest ${city} workplaces. Respond in JSON only.`, prompt, 300);
    res.json(JSON.parse(text.replace(/```json|```/g,"").trim()));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── POST /api/actors/:id/generate-schedule — working hours only ────────────────
// Session 149 — was a 7-call Haiku/dirty-muse generation forcing a full,
// gapless 24h/day simulated life (sleep, meals, grooming, hobbies, social
// life — every hour of every day, by explicit prompt design: "Cover ALL
// 7 days... NO gaps"). Re-scoped per direct instruction: the deploy-time
// schedule's job is working hours only. Vacation/PTO is explicitly out of
// scope for now (rescheduled-later work). The actual appointment layer
// (calendar_events / planned_meetings / promises) is a separate system
// that fills in dynamically through play — this endpoint was never
// supposed to be simulating a whole fictional life, just blocking work.
//
// Non-working time gets one honest "private" block rather than a true
// gap — schedule_process.ex (the actor's own tick-time slot cache) is a
// passive stub with no enforcement either way, but TimeHelper.current_slot
// (the actual "what slot am I in right now" resolver) wasn't available to
// verify gap-handling is safe everywhere downstream. A real, recognized
// slot with an honest "not modeled" meaning is the safe choice until that
// can be confirmed — a true gap can be revisited once it is.
app.post("/api/actors/:id/generate-schedule", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const actor = db.prepare(`SELECT first_name, name, occupation FROM actors WHERE id = ?`).get(req.params.id);
  if (!actor) return res.status(404).json({ error: "not found" });

  const { revenue_sources, work_blocks, day_only } = req.body;
  // Session 149 — was a straight employment_type === "freelance" check.
  // Superseded by revenue_sources (a list, not one type), and work_blocks
  // aren't linked to which specific source they belong to, so this can't
  // correctly vary location per block by source the way it ideally would
  // for someone like Frida (one contract source at a studio, one
  // independent one from home). Reasonable approximation: home only if
  // every source is either explicitly work-from-home or independent
  // (no fixed workplace); otherwise work. Flagged as a known limitation,
  // not silently treated as fully solved.
  const sources = revenue_sources || [];
  const occupationLabel = actor.occupation || "work";

  // Session 149 — was a single hardcoded 09:00-18:00 for everyone. Real
  // occupations don't all fit one continuous block — session-based work
  // (e.g. Frida: shoots spread across the day) needs several discrete
  // blocks, not one. Comes from the wizard's Work Hours section; falls
  // back to a single 09:00-18:00 block if nothing was configured there.
  // Malformed entries (missing/inverted times) are quietly dropped rather
  // than crashing — this is operator-entered data, not adversarial input.
  // Session 150 — work hours are a property of each revenue source now,
  // not of the person. That closes the limitation this handler flagged in
  // its own comment above: hours weren't linked to a source, so location
  // couldn't vary per block "the way it ideally would for someone like
  // Frida (one contract source at a studio, one independent one from
  // home)". Each block now inherits its own source's location — home when
  // the source says work-from-home or is independent (no fixed
  // workplace), on-site otherwise — and carries that source's name as the
  // slot's state_note instead of one occupation label for everything.
  const sourceBlocks = [];
  for (const src of sources) {
    const locationType = (src.work_from_home || src.source_type === "independent") ? "home" : "work";
    const label = (src.name || "").trim() || occupationLabel;
    // A source left with no hours configured falls back to the same
    // 08:00-17:00 the old global block defaulted to, so it behaves
    // exactly as it did before hours moved per-source.
    const raw = (Array.isArray(src.work_blocks) && src.work_blocks.length > 0)
      ? src.work_blocks
      : [{ start: "08:00", end: "17:00" }];
    // Session 150 — which days this source is worked. Defaults to Mon-Fri,
    // which is what the handler used to hardcode for everyone.
    // An explicit empty array means "never worked"; only an absent value falls
    // back to Mon-Fri. Treating [] as the default would contradict the wizard,
    // which warns that deselecting every day means the source is never worked.
    const days = Array.isArray(src.work_days)
      ? src.work_days.map(d => String(d).toLowerCase().trim())
      : ["monday","tuesday","wednesday","thursday","friday"];
    for (const b of raw) {
      // Malformed entries (missing or inverted times) are quietly dropped
      // rather than crashing — operator-entered data, not adversarial input.
      if (b && b.start && b.end && b.start < b.end) {
        sourceBlocks.push({ start: b.start, end: b.end, location_type: locationType, label, days });
      }
    }
  }

  // Back-compat: a caller still posting a flat top-level work_blocks list
  // and no per-source hours is honoured rather than silently ignored.
  if (sourceBlocks.length === 0) {
    const isFreelance = sources.length > 0 && sources.every(s => s.work_from_home || s.source_type === "independent");
    const flat = (Array.isArray(work_blocks) ? work_blocks : [])
      .filter(b => b && b.start && b.end && b.start < b.end);
    for (const b of (flat.length > 0 ? flat : [{ start: "08:00", end: "17:00" }])) {
      sourceBlocks.push({ start: b.start, end: b.end, location_type: isFreelance ? "home" : "work", label: occupationLabel, days: ["monday","tuesday","wednesday","thursday","friday"] });
    }
  }

  sourceBlocks.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));

  // Session 150 — de-conflict blocks whose hours genuinely overlap across
  // sources. Left explicitly open at the end of Session 149 ("not
  // de-conflicted across sources if two sources' hours genuinely overlap in
  // time"). Earliest start wins; a later block is clipped to resume where the
  // previous one ended, and dropped outright if fully swallowed.
  //
  // Resolved PER DAY rather than once globally: now that each source carries
  // its own work_days, two sources can overlap in clock time while never
  // sharing a day — a weekday job and a Saturday shoot both running 09:00-17:00
  // do not collide, and resolving them together would silently delete the
  // Saturday one. What was clipped is logged; a silently truncated schedule
  // reads as a correct one.
  let clipped = 0;
  function blocksForDay(day) {
    const out = [];
    let cursor = "00:00";
    for (const b of sourceBlocks.filter(x => x.days.includes(day))) {
      const start = b.start > cursor ? b.start : cursor;
      if (b.end <= start) { clipped++; continue; }
      if (start !== b.start) clipped++;
      out.push({ ...b, start });
      cursor = b.end;
    }
    return out;
  }

  // "HH:MM" -> minutes. Needed to measure gap length; everything else here
  // compares zero-padded time strings directly, which sorts correctly.
  const timeToMins = t => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };

  const DAYS = day_only ? [day_only] : ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

  function daySlots(day) {
    // Session 150 — the hardcoded weekend is gone. Saturday and Sunday used to
    // return a single 24h "Private time" block for everyone regardless of what
    // they actually did, so a weekend shoot or a Saturday shift could not be
    // expressed at all. A day nobody works now produces exactly that same block
    // by construction, from the tail below — same output, no special case, and
    // weekend work is finally possible.
    const workBlocks = blocksForDay(day);
    const slots = [];
    let cursor = "00:00";
    // Session 150 — a gap BETWEEN two work blocks is a break, not time at home.
    // Every gap used to emit an identical "relaxing @home" slot, so an actor
    // with an 08:00-12:00 / 13:00-17:00 day was sent home for lunch and back
    // again inside the hour — a round trip across Stockholm, twice a day, every
    // weekday. Only the gap before the first block and the one after the last
    // are genuinely at home. A mid-day break also stays wherever that work
    // happens, so a work-from-home source breaks at home and an on-site one
    // doesn't.
    let lastLocation = null;
    for (const b of workBlocks) {
      // workBlocks is already sorted and de-conflicted above, so no
      // overlap guard is needed here any more.
      if (b.start > cursor) {
        if (lastLocation) {
          const gapMins = timeToMins(b.start) - timeToMins(cursor);
          slots.push({
            day_of_week: day, start_time: cursor, end_time: b.start,
            // A short gap reads as a meal break; a long one is genuine downtime
            // between engagements, but still not a trip home.
            activity_slug: gapMins <= 90 ? "eating" : "relaxing",
            state_note:    gapMins <= 90 ? "Break" : "Between work",
            location_type: lastLocation,
          });
        } else {
          slots.push({ day_of_week: day, start_time: cursor, end_time: b.start, activity_slug: "relaxing", state_note: "Private time", location_type: "home" });
        }
      }
      slots.push({ day_of_week: day, start_time: b.start, end_time: b.end, activity_slug: "work_deep", state_note: b.label, location_type: b.location_type });
      cursor = b.end;
      lastLocation = b.location_type;
    }
    if (cursor < "24:00") {
      slots.push({ day_of_week: day, start_time: cursor, end_time: "24:00", activity_slug: "relaxing", state_note: "Private time", location_type: "home" });
    }
    return slots;
  }

  const slots = DAYS.flatMap(daySlots);
  if (clipped > 0) {
    console.warn(`[generate-schedule] ${clipped} work block(s) overlapped another source on the same day — clipped or dropped (earliest start wins)`);
  }
  // Session 150 — was reporting workBlocks.length, which moved inside daySlots
  // when de-confliction went per-day; the reference survived here and threw
  // ReferenceError on every call the moment work_days shipped. Report from
  // sourceBlocks, which is genuinely in scope, and say something now true:
  // blocks are no longer uniform across weekdays.
  const distinctDays = new Set(sourceBlocks.flatMap(b => b.days || []));
  console.log(`[generate-schedule] total slots: ${slots.length} over ${DAYS.length} day(s) — ${sourceBlocks.length} work block(s) across ${distinctDays.size} worked day(s)`);
  res.json(slots);
});

// ── POST /api/actors/:id/inspire-relationship — Haiku relationship description ─
app.post("/api/actors/:id/inspire-relationship", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const { rel_type_id, rel_type_name, dimension_name, target_type, target_id } = req.body;
  if (!rel_type_id || !target_type || !target_id) return res.status(400).json({ error: "missing fields" });

  function formatPsych(a) {
    const name = a.first_name || a.name;
    const b5 = [a.openness, a.conscientiousness, a.extraversion, a.agreeableness, a.neuroticism]
      .map(v => v != null ? Math.round(v) : "?");
    return [
      `${name}, ${a.occupation || "unknown occupation"}`,
      a.attachment_style ? `Attachment: ${a.attachment_style}${a.core_wound ? ` | Wound: ${a.core_wound}` : ""}` : null,
      `Big5: O:${b5[0]} C:${b5[1]} E:${b5[2]} A:${b5[3]} N:${b5[4]}`,
      a.blind_spot    ? `Blind spot: ${a.blind_spot}` : null,
      a.coping_strategies ? `Coping: ${a.coping_strategies}` : null,
    ].filter(Boolean).join("\n");
  }

  function getPsych(actorId) {
    try {
      // First try direct platform actor ID
      const actor = db.prepare(`
        SELECT a.first_name, a.last_name, a.name, a.occupation,
               ap.attachment_style, ap.core_wound,
               b.openness, b.conscientiousness, b.extraversion, b.agreeableness, b.neuroticism,
               p.blind_spot, p.coping_strategies
        FROM actors a
        LEFT JOIN actor_psychology ap ON ap.actor_id = a.id
        LEFT JOIN actor_big5 b ON b.actor_id = a.id
        LEFT JOIN actor_psychology p ON p.actor_id = a.id
        WHERE a.id = ?
      `).get(actorId);
      if (actor) return actor;
      // Fall back: look up via simulator_actor_id in deployments
      const dep = db.prepare(`SELECT platform_actor_id FROM actor_deployments WHERE simulator_actor_id = ? LIMIT 1`).get(actorId);
      if (dep) {
        return db.prepare(`
          SELECT a.first_name, a.last_name, a.name, a.occupation,
                 ap.attachment_style, ap.core_wound,
                 b.openness, b.conscientiousness, b.extraversion, b.agreeableness, b.neuroticism,
                 p.blind_spot, p.coping_strategies
          FROM actors a
          LEFT JOIN actor_psychology ap ON ap.actor_id = a.id
          LEFT JOIN actor_big5 b ON b.actor_id = a.id
          LEFT JOIN actor_psychology p ON p.actor_id = a.id
          WHERE a.id = ?
        `).get(dep.platform_actor_id);
      }
      return db.prepare(`SELECT * FROM actors WHERE id = ?`).get(actorId);
    } catch { return db.prepare(`SELECT * FROM actors WHERE id = ?`).get(actorId); }
  }

  const sourceActor = getPsych(req.params.id);
  if (!sourceActor) return res.status(404).json({ error: "actor not found" });

  const systemPrompt = `You write relationship descriptions for an AI world simulation.
Be specific, psychologically grounded, and avoid clichés.
Respond in JSON only — no preamble, no markdown fences.`;

  let messages;

  if (target_type === "actor") {
    const target = getPsych(target_id);
    if (!target) return res.status(404).json({ error: "target not found" });
    messages = [{
      role: "user",
      content: `Character A:\n${formatPsych(sourceActor)}\n\nCharacter B:\n${formatPsych(target)}\n\nRelationship type: ${rel_type_name.replace(/_/g," ")} (${dimension_name})\n\nReturn JSON only:\n{"description":"2-3 sentences of backstory — how this relationship came to be","context":"1-2 sentences of current dynamic between them right now","scores":{"warmth":0.0,"trust":0.0,"respect":0.0,"tension":0.0,"attraction":0.0,"pull":0.0}}`


    }];

  } else if (target_type === "user") {
    const targetUser = db.prepare(`SELECT id, name, photo_url FROM users WHERE id = ?`).get(target_id);
    if (!targetUser) return res.status(404).json({ error: "user not found" });

    const content = [];
    if (targetUser.photo_url) {
      try {
        const { readFileSync } = await import("fs");
        const filePath = path.join(__dirname, "../public", targetUser.photo_url);
        const buf = readFileSync(filePath);
        const ext = path.extname(targetUser.photo_url).toLowerCase();
        const mime = ext === ".png" ? "image/png" : "image/jpeg";
        content.push({ type:"image", source:{ type:"base64", media_type:mime, data:buf.toString("base64") } });
      } catch {}
    }
    content.push({
      type: "text",
      text: `Character: ${formatPsych(sourceActor)}\n\nThe other person is a player named ${targetUser.name}.${targetUser.photo_url ? "\nUse the photo above to inform the relational dynamic." : ""}\n\nRelationship type: ${rel_type_name.replace(/_/g," ")} (${dimension_name})\n\nReturn JSON only:\n{"description":"2-3 sentences of backstory","context":"1-2 sentences of current dynamic","scores":{"warmth":0.0,"trust":0.0,"respect":0.0,"tension":0.0,"attraction":0.0,"pull":0.0}}`


    });
    messages = [{ role:"user", content }];

  } else {
    return res.status(400).json({ error: "invalid target_type" });
  }

  try {
    const lastMsg = messages[messages.length - 1]?.content;
    console.log("[inspire-relationship] calling Haiku");
    const t0 = Date.now();
    // Session 149 — was callDirtyMuse, extracting only the text block
    // and discarding any image block first (the target user's photo
    // was fetched and base64-encoded above specifically to inform the
    // dynamic, then thrown away before the call ever happened). Real
    // Haiku supports vision — passing the actual content (string or
    // array, whichever this branch built) through directly means that
    // photo now actually gets used instead of being wasted work.
    const text = await callHaiku(systemPrompt, lastMsg, 600);
    console.log("[inspire-relationship] Haiku responded in", Date.now()-t0, "ms");
    const clean = text.replace(/```json|```/g, "").trim();
    const start = clean.indexOf("{");
    const end   = clean.lastIndexOf("}");
    const jsonStr = start >= 0 && end > start ? clean.slice(start, end + 1) : clean;
    res.json(JSON.parse(jsonStr));
  } catch (e) {
    console.error("[inspire-relationship] error:", e.message);
    res.status(500).json({ error: "inspire failed", detail: e.message });
  }
});

// ── POST /api/actors/:id/suggest-relationship — one type per dimension ─────────
// Session 149 — proposes a coherent set across all five dimensions in
// one call, grounded in whatever's already established (the actor's own
// CV/backstory if one exists, psychology, occupation) rather than
// picking types in isolation. Client sends the actual type names it has
// loaded per dimension (already fetched from /api/relationship-types)
// so this only ever proposes real, valid options — never invents a slug
// that doesn't exist in the taxonomy.
app.post("/api/actors/:id/suggest-relationship", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const { target_name, target_occupation, target_is_user, cv_notes, dimensions } = req.body;
  if (!target_name || !dimensions) return res.status(400).json({ error: "missing target_name or dimensions" });

  let actor;
  try {
    actor = db.prepare(`
      SELECT a.first_name, a.name, a.occupation, a.age,
             ap.attachment_style, ap.core_wound,
             b.openness, b.conscientiousness, b.extraversion, b.agreeableness, b.neuroticism
      FROM actors a
      LEFT JOIN actor_psychology ap ON ap.actor_id = a.id
      LEFT JOIN actor_big5 b ON b.actor_id = a.id
      WHERE a.id = ?
    `).get(req.params.id);
  } catch { actor = db.prepare(`SELECT * FROM actors WHERE id = ?`).get(req.params.id); }
  if (!actor) return res.status(404).json({ error: "not found" });

  const name = actor.first_name || actor.name;
  const b5 = [actor.openness, actor.conscientiousness, actor.extraversion, actor.agreeableness, actor.neuroticism]
    .map(v => v != null ? Math.round(v) : "?");

  const dimList = Object.entries(dimensions)
    .map(([dim, names]) => `${dim}: ${(names||[]).join(" | ")}`)
    .join("\n");

  const prompt = `Character A: ${name}, ${actor.age || "unknown age"}, ${actor.occupation || "unknown occupation"}
Attachment: ${actor.attachment_style || "unknown"}${actor.core_wound ? ` | Wound: ${actor.core_wound}` : ""}
Big5: O:${b5[0]} C:${b5[1]} E:${b5[2]} A:${b5[3]} N:${b5[4]}
${cv_notes ? `${name}'s CV / background:\n${cv_notes.slice(0, 3000)}\n` : ""}
Character B (the other person): ${target_name}${target_occupation ? `, ${target_occupation}` : ""}${target_is_user ? " (the player)" : ""}

For EACH dimension below, pick the single best-fitting type from the options listed for that dimension only — never a type from a different dimension's list, never a type not listed. Use "none" wherever no real connection in that dimension makes sense — most dimensions should usually be "none"; picking a real type in more than one or two dimensions needs to be genuinely justified by who these two people are.

The dimensions aren't independent — check the set makes sense together, not just each pick in isolation. In particular: social closeness should never fall below what the intimate dimension implies. A committed intimate type (e.g. "partner", "exclusive") paired with a distant social type (e.g. "acquaintance") is backwards — real committed partners are close socially too, not barely acquainted. If intimate is anything beyond "none", social should generally be "close_friend" or nearer, not "acquaintance" or "casual_friend". Casual/uncommitted intimate types (e.g. "friends with benefits", "entanglement") don't carry this requirement as strongly, but should still not contradict the social pick outright.
${cv_notes ? `If ${name}'s CV/background above already establishes something about this specific person by name, use that directly rather than inventing a new dynamic.` : ""}

${dimList}

Respond with JSON only, one type per dimension, using the dimension keys exactly as given:
{${Object.keys(dimensions).map(d => `"${d}":"..."`).join(",")}}`;

  try {
    const text = await callHaiku("You choose realistic relationship types between two characters, one per dimension, from constrained option lists. Respond with JSON only, no markdown, no preamble.", prompt, 500);
    const clean = text.replace(/```json|```/g, "").trim();
    const start = clean.indexOf("{");
    const end   = clean.lastIndexOf("}");
    const jsonStr = start >= 0 && end > start ? clean.slice(start, end + 1) : clean;
    res.json(JSON.parse(jsonStr));
  } catch (e) {
    console.error("[suggest-relationship] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── GET /api/actors/deployments — which actors are deployed ──────────────────
app.get("/api/actors/deployments", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const deps = db.prepare(`
    SELECT d.platform_actor_id, d.world_id, d.world_name, d.deployed_at
    FROM actor_deployments d
    JOIN actors a ON a.id = d.platform_actor_id
    WHERE a.owner_id = ? AND d.undeployed_at IS NULL
    UNION
    SELECT d.platform_actor_id, d.world_id, d.world_name, d.deployed_at
    FROM actor_deployments d
    JOIN actor_shares s ON s.actor_id = d.platform_actor_id
    WHERE s.shared_with_id = ? AND d.undeployed_at IS NULL
  `).all(user.id, user.id);

  // Enrich each deployment with the world-specific profile photo
  const enriched = deps.map(d => {
    try {
      const worldPhoto = db.prepare(
        "SELECT url FROM actor_media WHERE actor_id = ? AND state_slug = ? AND media_type = ? AND world_id = ? LIMIT 1"
      ).get(d.platform_actor_id, "profile", "photo", d.world_id);
      return { ...d, world_photo_url: worldPhoto?.url || null };
    } catch { return { ...d, world_photo_url: null }; }
  });
  res.json(enriched);
});

// ── GET /api/actors/:id/in-play — worlds, relationships, memories ────────────────
app.get("/api/actors/:id/in-play", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const actor = db.prepare(`SELECT id, owner_id FROM actors WHERE id = ?`).get(req.params.id);
  if (!actor) return res.status(404).json({ error: "not found" });

  const isOwner = actor.owner_id === user.id;
  const share   = !isOwner && db.prepare(`SELECT permission FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(req.params.id, user.id);
  if (!isOwner && !share) return res.status(403).json({ error: "forbidden" });

  // actor_shares has never had a viewer_actor_id column - nothing creates it and
  // nothing writes it. The viewer's player actor comes from world_memberships below.
  const viewerActorId = null;

  // Get deployments from platform DB
  const deployments = db.prepare(`SELECT * FROM actor_deployments WHERE platform_actor_id = ? AND undeployed_at IS NULL`).all(req.params.id);
  if (!deployments.length) return res.json({ data: [], is_owner: isOwner, viewer_actor_id: null });

  // Look up the viewing user's player actor in each world
  const results = await Promise.all(deployments.map(async dep => {
    try {
      // Find viewer's player actor in this world via world_memberships
      const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`).get(user.id, dep.world_id);
      const myActorId = membership?.actor_id || viewerActorId || null;

      // Owner gets all memories — never pass viewer_actor_id
      const qs = (!isOwner && myActorId) ? `?viewer_actor_id=${myActorId}` : "";
      const data = await simFetch(`/internal/actors/${dep.simulator_actor_id}/in-play${qs}`);
      return { ...data, world_name: dep.world_name, deployed_at: dep.deployed_at, my_actor_id: myActorId };
    } catch {
      return { world_id: dep.world_id, world_name: dep.world_name, deployed_at: dep.deployed_at, error: "simulator unreachable" };
    }
  }));

  res.json({ data: results, is_owner: isOwner });
});

// ── GET /api/actors/:id/worlds — worlds this actor is running in ──────────────
app.get("/api/actors/:id/worlds", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { id } = req.params;
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND (owner_id = ? OR id IN (SELECT actor_id FROM actor_shares WHERE shared_with_id = ?))`).get(id, user.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const worlds = db.prepare(`SELECT world_id, world_name, deployed_at FROM actor_deployments WHERE platform_actor_id = ? AND undeployed_at IS NULL ORDER BY deployed_at DESC`).all(id);
  res.json(worlds);
});

// ── Static media ─────────────────────────────────────────────────────────────
// Session 102 — wire-compression for GLBs. Character files are ~47MB
// and the free ngrok tunnel made every draft load a multi-minute
// stall. Draco already compresses the MESH chunks, but force-sampled
// idle/walk animation tracks (254-bone rig, float32 samplers) ship
// uncompressed and are the bulk of the file — and they gzip well.
// Done inline with zlib (no new dependency; the standard compression
// middleware refuses application/octet-stream anyway). Falls through
// to express.static for non-gzip clients or missing files.
// ── POST /api/actors/:id/animations — Session 143 ─────────────────────
// "Upload an animation and it is merged": multipart file (field
// "animation": .glb/.gltf/.fbx/.blend) + clip_name (+ loop=true for
// looping clips) -> merged into the actor's CURRENT canonical GLB via
// Blender headless on the Mac Mini (merge_animation_into_glb.py —
// bone-name guard included, so a wrong-skeleton clip is refused with a
// real error, not merged into a frozen statue). updated_at bump is the
// cache-bust: /media/*.glb is served immutable and every client load
// appends ?v=updated_at, so bumping it IS the invalidation.
app.post("/api/actors/:id/animations", upload.single("animation"), async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT * FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  if (!actor.glb_url) return res.status(400).json({ error: "actor has no 3D model (glb_url is empty)" });
  if (!req.file) return res.status(400).json({ error: "no animation file uploaded (multipart field: animation)" });
  const clipName = String(req.body.clip_name || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(clipName)) {
    return res.status(400).json({ error: "clip_name required: 1-32 chars, letters/digits/_/- only" });
  }
  const ext = path.extname(req.file.originalname || "").toLowerCase();
  if (![".duf", ".blend"].includes(ext)) {
    return res.status(400).json({ error: `unsupported animation format "${ext}" — .duf or .blend (foreign-skeleton .fbx/.glb needs a retarget step that isn't built yet)` });
  }
  const glbAbsPath = path.join(__dirname, "../public", decodeURIComponent(actor.glb_url.split("?")[0]));
  if (!fs.existsSync(glbAbsPath)) {
    return res.status(500).json({ error: `actor glb_url points to a missing file: ${actor.glb_url}` });
  }
  // Session 144 — LEDGER MODEL: the retained master .blend beside the
  // GLB is the source of truth; every clip op edits it and re-derives
  // the GLB from it (update_master_animations.py via runLedgerOp).
  const masterBlendAbsPath = glbAbsPath.replace(/\.glb$/, ".blend");
  if (!fs.existsSync(masterBlendAbsPath)) {
    return res.status(400).json({ error: "This character has no retained master .blend beside its GLB (generated before master retention, Session 144). Regenerate the 3D character once — the pipeline now saves the master alongside the GLB." });
  }
  const tmpAnimPath = path.join(os.tmpdir(), `anim_${randomUUID()}${ext}`);
  fs.writeFileSync(tmpAnimPath, req.file.buffer);
  try {
    let detectedFrames = null;
    if (ext === ".duf") {
      try { detectedFrames = parseDufFrames(req.file.buffer); }
      catch (e) { console.warn(`[actor-animations] .duf frame parse failed (informational only): ${e.message}`); }
    }
    const mergeLog = await mergeAnimationIntoActorGlb({
      actorId: actor.id,
      localMasterBlendAbsPath: masterBlendAbsPath,
      localGlbAbsPath: glbAbsPath,
      localAnimAbsPath: tmpAnimPath,
      clipName,
      loop: req.body.loop === "true" || req.body.loop === "1",
    });
    const now = new Date().toISOString();
    db.prepare(`UPDATE actors SET updated_at = ? WHERE id = ?`).run(now, actor.id);
    res.json({ ok: true, clip: clipName, updated_at: now, detected_frames: detectedFrames, log_tail: mergeLog.slice(-2000) });
  } catch (e) {
    console.error(`[actor-animations] merge failed for ${actor.id}:`, e);
    res.status(e.statusCode || 500).json({ error: String(e.message || e).slice(0, 4000) });
  } finally {
    try { fs.unlinkSync(tmpAnimPath); } catch {}
  }
});

// ── DELETE /api/actors/:id/animations/:clipName — Session 143 ─────────
// Removes a clip from the actor's canonical GLB (Blender run on the
// Mac Mini, atomic swap, updated_at cache-bust — the merge's mirror
// image). idle and walk are protected: Explore's locomotion state
// machine depends on them existing.
app.delete("/api/actors/:id/animations/:clipName", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT * FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  if (!actor.glb_url) return res.status(400).json({ error: "actor has no 3D model (glb_url is empty)" });
  const clipName = String(req.params.clipName || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(clipName)) return res.status(400).json({ error: "invalid clip name" });
  if (clipName === "idle" || clipName === "walk") {
    return res.status(400).json({ error: `"${clipName}" is protected — Explore's locomotion depends on it` });
  }
  const glbAbsPath = path.join(__dirname, "../public", decodeURIComponent(actor.glb_url.split("?")[0]));
  if (!fs.existsSync(glbAbsPath)) {
    return res.status(500).json({ error: `actor glb_url points to a missing file: ${actor.glb_url}` });
  }
  const masterBlendAbsPath = glbAbsPath.replace(/\.glb$/, ".blend");
  if (!fs.existsSync(masterBlendAbsPath)) {
    return res.status(400).json({ error: "This character has no retained master .blend beside its GLB (generated before master retention, Session 144). Regenerate the 3D character once." });
  }
  try {
    const log = await removeAnimationFromActorGlb({ actorId: actor.id, localMasterBlendAbsPath: masterBlendAbsPath, localGlbAbsPath: glbAbsPath, clipName });
    const now = new Date().toISOString();
    db.prepare(`UPDATE actors SET updated_at = ? WHERE id = ?`).run(now, actor.id);
    res.json({ ok: true, removed: clipName, updated_at: now, log_tail: log.slice(-1500) });
  } catch (e) {
    console.error(`[actor-animations] removal failed for ${actor.id}:`, e);
    res.status(500).json({ error: String(e.message || e).slice(0, 4000) });
  }
});

app.get(/^\/media\/.*\.glb$/, (req, res, next) => {
  if (!/gzip/.test(req.headers["accept-encoding"] || "")) return next();
  const filePath = path.join(__dirname, "../public", decodeURIComponent(req.path));
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return next();
    res.setHeader("Content-Type", "model/gltf-binary");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // content-addressed by actorId — safe to cache hard
    const stream = fs.createReadStream(filePath).pipe(zlib.createGzip({ level: 6 }));
    stream.on("error", (e) => { console.error("[glb-gzip]", e); if (!res.headersSent) next(); });
    stream.pipe(res);
  });
});
app.use("/media", express.static(path.join(__dirname, "../public/media")));

// ── GET /api/accessories — dynamic discovery of real accessory assets ──
// Scans public/media/accessories/ recursively. Every .glb found is
// parsed as type_length_name (underscore-separated; "name" is
// everything after the first two segments, since display names can
// themselves contain underscores like "kin_hair"). A same-named .png
// alongside it is used as the thumbnail if present.
app.get("/api/accessories", (req, res) => {
  const accessoriesRoot = path.join(__dirname, "../public/media/accessories");
  const results = [];

  function scanDir(dir, relativeParts) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // directory doesn't exist yet — no results from here, not an error
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath, [...relativeParts, entry.name]);
      } else if (entry.name.toLowerCase().endsWith(".glb")) {
        const baseName = entry.name.slice(0, -4);
        const parts = baseName.split("_");
        const type = parts[0] || "";
        const length = parts[1] || "";
        const nameParts = parts.slice(2);
        const displayName = nameParts.length > 0
          ? nameParts.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
          : baseName;
        const thumbFile = entry.name.slice(0, -4) + ".png";
        const hasThumbnail = fs.existsSync(path.join(dir, thumbFile));
        const urlParts = [...relativeParts, entry.name];
        const thumbUrlParts = [...relativeParts, thumbFile];
        // Session 103 — cache-busting by mtime: /media/*.glb is served
        // with Cache-Control immutable (right for actorId-addressed
        // character files, WRONG for accessories edited in place —
        // found live: Draco-recompressed hair served stale forever,
        // wrong hair per URL). A changed file gets a new URL; an
        // unchanged one keeps its hard cache.
        let v = 0;
        try { v = Math.floor(fs.statSync(fullPath).mtimeMs); } catch {}
        results.push({
          category: relativeParts.join("/"),
          filename: entry.name,
          type,
          length,
          displayName,
          glbUrl: `/media/accessories/${urlParts.join("/")}?v=${v}`,
          thumbnailUrl: hasThumbnail ? `/media/accessories/${thumbUrlParts.join("/")}?v=${v}` : null,
        });
      }
    }
  }

  scanDir(accessoriesRoot, []);
  res.json({ accessories: results });
});

const PORT = 4002;
// ── Simulator proxies ─────────────────────────────────────────────────────────
// ── Simulator proxies — each route gets its own instance (v2 requirement) ─────
const SIM = "http://192.168.1.58:4000";

// /sim/* — LiveView pages
app.use("/sim", createProxyMiddleware({ target: SIM, changeOrigin: true, ws: true, pathRewrite: { "^/sim": "" } }));

// /js — LiveView JS assets
app.use("/js", createProxyMiddleware({ target: SIM, changeOrigin: true }));

// /assets/* — proxy simulator assets if not in platform dist
app.use("/assets", (req, res, next) => {
  const localPath = path.join(__dirname, "../dist/assets", path.basename(req.path));
  if (!fs.existsSync(localPath)) return createProxyMiddleware({ target: SIM, changeOrigin: true })(req, res, next);
  next();
});

// /live — LiveView WebSocket
app.use("/live", createProxyMiddleware({ target: SIM, changeOrigin: true, ws: true }));

// /phoenix — Phoenix channels WebSocket
app.use("/phoenix", createProxyMiddleware({ target: SIM, changeOrigin: true, ws: true }));

// Create HTTP server explicitly so WebSocket upgrades can be forwarded
import { createServer } from "http";
const server = createServer(app);

// Attach WebSocket upgrade handlers for LiveView
const liveWsProxy  = createProxyMiddleware({ target: SIM, changeOrigin: true, ws: true });
const simPageProxy = createProxyMiddleware({ target: SIM, changeOrigin: true, ws: true, pathRewrite: { "^/sim": "" } });

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/live")) {
    liveWsProxy.upgrade(req, socket, head);
  } else if (req.url.startsWith("/sim")) {
    simPageProxy.upgrade(req, socket, head);
  } else if (req.url.startsWith("/phoenix")) {
    liveWsProxy.upgrade(req, socket, head);
  }
});

// Bound to loopback, not 0.0.0.0.
//
// Express serves /media and the built dist with no authentication of its own —
// the auth rules live in nginx (auth_request plus an explicit allow list). While
// this port was open on every interface, any host on the LAN could read every
// actor's media directly and skip nginx entirely, including the body reference
// photographs a likeness is built from.
//
// Nothing outside this machine needs the port: nginx proxies to
// localhost:4002, ngrok tunnels to :80 (nginx), and the simulator fetches
// platform media over http://192.168.1.59 — port 80, also nginx.
server.listen(PORT, "127.0.0.1", () => {
  booted = true;
  console.log(`Platform API running on 127.0.0.1:${PORT}`);
  connectSimulatorEvents();
});

// ── SSE: browser clients registry ────────────────────────────────────────────
const sseClients = new Map(); // user_id → Set of res objects

function broadcastToUser(userId, event) {
  const clients = sseClients.get(userId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch {}
  }
}

// A world can be deleted two ways: through this platform's own
// DELETE /api/worlds/:id (which already cleans world_memberships and
// actor_deployments inline, right there), or directly on the simulator —
// which is how most of this session's own testing worked, and almost
// certainly how world e7368020 went: gone from the simulator, but its 4
// memberships (mk owner, tn/jm/dn player) sat on this side forever, because
// nothing here was watching for a deletion it did not initiate.
//
// The simulator broadcasts {type: "world_deleted", world_id} over SSE
// unconditionally, from inside delete_world itself, regardless of which
// endpoint triggered it — so this is the one place a cleanup can catch
// every deletion, not just the ones this platform happened to originate.
// Idempotent by construction: DELETEs and directory removals against rows
// or paths that are already gone are silent no-ops, so running this
// alongside the existing inline cleanup in the DELETE route (for a
// platform-initiated delete) does no harm — it just confirms what already
// happened.
function reconcileWorldDeleted(worldId) {
  try {
    const affectedActorIds = db.prepare(
      `SELECT DISTINCT platform_actor_id FROM actor_deployments WHERE world_id = ? AND undeployed_at IS NULL`
    ).all(worldId).map(r => r.platform_actor_id);

    db.prepare(`DELETE FROM world_memberships WHERE world_id = ?`).run(worldId);
    db.prepare(`DELETE FROM actor_deployments WHERE world_id = ?`).run(worldId);

    const now = new Date().toISOString();
    for (const actorId of affectedActorIds) {
      const stillDeployed = db.prepare(
        `SELECT 1 FROM actor_deployments WHERE platform_actor_id = ? AND undeployed_at IS NULL LIMIT 1`
      ).get(actorId);
      if (!stillDeployed) {
        db.prepare(`UPDATE actors SET status = 'ready_to_deploy', updated_at = ? WHERE id = ?`).run(now, actorId);
      }
    }

    const worldMediaDir = path.join(__dirname, "../public/media/worlds", worldId);
    fs.promises.rm(worldMediaDir, { recursive: true, force: true }).catch(() => {});
    fs.promises.readdir(path.join(__dirname, "../public/media/actors"), { withFileTypes: true })
      .then(entries => Promise.all(
        entries.filter(e => e.isDirectory()).map(e => {
          const worldSubdir = path.join(__dirname, "../public/media/actors", e.name, "worlds", worldId);
          return fs.promises.rm(worldSubdir, { recursive: true, force: true }).catch(() => {});
        })
      ))
      .catch(() => {});

    console.log(`[Events] reconciled world_deleted for ${worldId} — ${affectedActorIds.length} actor(s) touched`);
  } catch (e) {
    console.warn(`[Events] reconcileWorldDeleted(${worldId}) failed:`, e.message);
  }
}

function broadcastWorldEvent(event) {
  // world_created/deleted fires before membership is written — broadcast to all
  if (event.type === "world_created" || event.type === "world_deleted") {
    const msg = `data: ${JSON.stringify(event)}\n\n`;
    for (const [, clients] of sseClients) {
      for (const res of clients) { try { res.write(msg); } catch {} }
    }
    return;
  }
  // Broadcast to all users who are members of the affected world
  if (event.world_id) {
    const members = db.prepare(`SELECT user_id FROM world_memberships WHERE world_id = ?`).all(event.world_id);
    for (const { user_id } of members) broadcastToUser(user_id, event);
  } else {
    // Broadcast to all connected users (e.g. connected event)
    for (const [, clients] of sseClients) {
      const msg = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of clients) { try { res.write(msg); } catch {} }
    }
  }
}

// ── GET /api/events — browser SSE subscription ───────────────────────────────
app.get("/api/events", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  if (!sseClients.has(user.id)) sseClients.set(user.id, new Set());
  sseClients.get(user.id).add(res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch {}
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.get(user.id)?.delete(res);
  });
});

// ── Simulator SSE subscriber ──────────────────────────────────────────────────
async function connectSimulatorEvents() {
  const url = `${SIMULATOR_URL}/internal/events`;
  const headers = { "X-Service-Token": SERVICE_TOKEN };

  async function connect() {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) { throw new Error(`SSE connect failed: ${res.status}`); }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      console.log("[Events] Connected to simulator SSE");

      // On reconnect, fetch all world statuses and sync to browsers
      try {
        const worldIds = db.prepare(`SELECT DISTINCT world_id FROM world_memberships`).all().map(r => r.world_id);
        if (worldIds.length > 0) {
          const simRes = await fetch(`${SIMULATOR_URL}/internal/worlds?ids=${worldIds.join(",")}`, {
            headers: { "X-Service-Token": SERVICE_TOKEN }
          });
          if (simRes.ok) {
            const worlds = await simRes.json();
            for (const w of worlds) {
              broadcastWorldEvent({ type: w.status === "running" ? "world_started" : "world_stopped", world_id: w.id });
            }
          }
        }
      } catch {}

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "world_deleted" && event.world_id) reconcileWorldDeleted(event.world_id);
              if (event.type !== "connected") broadcastWorldEvent(event);
            } catch {}
          }
        }
      }
    } catch (e) {
      console.warn("[Events] Simulator SSE disconnected, retrying in 5s:", e.message);
    }
    setTimeout(connect, 5000);
  }

  connect();
}



// ── GET /api/actors — list canonical actors owned by or shared with the user ─
// ── GET /api/interior-templates — home template catalog (Session 106) ────────
// Read by CharacterWizard's default-home picker. Assets live in
// /media/homes/ (shared library, sibling of accessories/poses).
app.get("/api/interior-templates", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const templates = db.prepare(`SELECT id, name, glb_url FROM interior_templates ORDER BY name`).all();
  res.json({ templates });
});

app.get("/api/actors", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  // A user's own 3D profile is an actors row like any other (users.avatar_actor_id
  // points at it — see [[anima-user-3d-profile]]), which means it also owner_id's
  // to this same user and, without this exclusion, listed here as if it were a
  // character: it showed up in the gallery with a Deploy button (deploying your
  // own body is nonsensical — the avatar push already goes through
  // deployAvatarToWorlds, not this card's deploy flow), in the wizard's drafts
  // rail as a resumable draft (it already auto-resumes via GET /api/me/avatar),
  // and in the Avatar Lab's "adopt as yourself" picker as an option to adopt
  // yourself. Found live 2026-09-04 — a screenshot showed "Magnus Klack" as a
  // deployable card next to Benny Jensen and Lindsey Vaughn.
  const actors = db.prepare(`
    SELECT a.id, a.name, a.age, a.gender, a.occupation, a.status, a.updated_at,
           p.attachment_style, b.openness, b.conscientiousness, b.extraversion, b.agreeableness, b.neuroticism,
           (SELECT url FROM actor_media WHERE actor_id = a.id AND media_type = 'photo' AND state_slug IN ('photo_close','profile') LIMIT 1) as photo_url,
           -- Session 151 -- the subject-authorisation declaration, summarised for the
           -- gallery card. The declaration was only ever ASKED inside CharacterWizard's
           -- 'Who is in these photographs?' step, and only ever READ BACK by the build
           -- and egress gates (solve, runtime-glb, save-morphed-glb, runtime read,
           -- shares, share-links, publish, deploy, fork), which refuse with a 403. So a
           -- character whose reference photographs are declared to be of somebody else
           -- and whose authorisation was never answered looked completely ordinary
           -- everywhere in the app, right up until every button on it began failing,
           -- with no surface anywhere saying why or offering the answer.
           --
           -- Summarised over exactly the set the gates scope themselves to
           -- (world_id IS NULL, depicts = 'other'), so the card and the gate can never
           -- disagree about who is blocked:
           --   NULL      no photograph is declared to be of somebody else -- nothing to ask
           --   'yes'     every such photograph is authorised -- the gates pass
           --   'no'      the subject was declared NOT to have authorised it -- gates refuse
           --   'pending' at least one is still unanswered -- gates refuse
           -- 2026-09-11 (conduct-watch) -- widened alongside the gates to report
           -- 'undeclared': a reference photograph carrying NO depicts at all now
           -- refuses build AND egress, so the card has to be able to say so.
           -- Reported ahead of 'no'/'pending' because it is the earlier question.
           (SELECT CASE
                     WHEN COUNT(*) = 0 THEN NULL
                     WHEN SUM(CASE WHEN depicts IS NULL OR depicts = '' THEN 1 ELSE 0 END) > 0 THEN 'undeclared'
                     WHEN SUM(CASE WHEN subject_authorised = 'no'  THEN 1 ELSE 0 END) > 0 THEN 'no'
                     WHEN SUM(CASE WHEN subject_authorised = 'yes' THEN 1 ELSE 0 END) = COUNT(*) THEN 'yes'
                     ELSE 'pending'
                   END
              FROM actor_media
             WHERE actor_id = a.id AND media_type IN ('photo','audio') AND world_id IS NULL
               AND (depicts IS NULL OR depicts = '' OR depicts = 'other')) as subject_authorisation,
           -- 2026-09-09 (conduct-watch) -- how many worlds she is STILL IN after the
           -- subject withdrew authorisation, derived exactly as the editor's standing
           -- banner derives it. Normally 0. Anything above 0 is a likeness the subject
           -- said no to that is still running inside a simulator world, and a list of
           -- cards is the only surface seen without opening anything. On BOTH lists for
           -- the same reason the line above is: the card component is shared.
           (SELECT COUNT(*) FROM actor_deployments d
             WHERE d.platform_actor_id = a.id AND d.undeployed_at IS NULL
               AND EXISTS (SELECT 1 FROM actor_media m
                            WHERE m.actor_id = a.id AND m.media_type IN ('photo','audio')
                              AND m.world_id IS NULL AND m.depicts = 'other'
                              AND m.subject_authorised = 'no')) as withdrawal_still_deployed
    FROM actors a
    LEFT JOIN actor_psychology p ON p.actor_id = a.id
    LEFT JOIN actor_big5 b ON b.actor_id = a.id
    WHERE a.owner_id = ?
      AND a.id != COALESCE((SELECT avatar_actor_id FROM users WHERE id = ?), '')
    ORDER BY a.name
  `).all(user.id, user.id);
  res.json(actors);
});

// ── DELETE /api/actors/:id — hard delete undeployed actor ───────────────────
// ── POST /api/actors/:id/draft-state — persist the wizard's adjustment
// snapshot on a draft (Session 102). Drafts only, owner only: a
// finished character's shape is baked into its canonical GLB at
// wizard completion; draft_state is strictly the in-progress
// representation. Read side needs no route of its own — GET
// /api/actors/:id already does SELECT a.*, so the column flows to the
// client automatically.
// Session 103 — RENAME a draft: the media folder convention is
// {first}-{last}-{id8}, so a name change must move the folder and
// rewrite every stored reference, atomically, server-side. Drafts
// only. Uses the EXACT slug formula from actor creation. The client
// needs no in-session state updates: the server resolves media_folder
// fresh per request, and the browser's immutable cache carries the
// session's already-loaded GLB URL; the next draft load reads the new
// row.
app.post("/api/actors/:id/rename", express.json(), (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not logged in" });
  const { first_name, last_name } = req.body || {};
  if (!first_name || !last_name) return res.status(400).json({ error: "first_name and last_name required" });
  const actor = db.prepare(`SELECT id, media_folder, glb_url FROM actors WHERE id = ? AND owner_id = ? AND status = 'draft'`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not a draft you own" });
  const name = `${first_name} ${last_name}`.trim();
  const newFolder = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") + "-" + actor.id.slice(0,8);
  if (newFolder === actor.media_folder) {
    db.prepare(`UPDATE actors SET name = ?, first_name = ?, last_name = ?, updated_at = ? WHERE id = ?`)
      .run(name, first_name, last_name, new Date().toISOString(), actor.id);
    return res.json({ renamed: true, media_folder: actor.media_folder, moved: false });
  }
  const oldDir = path.join(__dirname, "../public/media/actors", actor.media_folder);
  const newDir = path.join(__dirname, "../public/media/actors", newFolder);
  try {
    if (fs.existsSync(newDir)) throw new Error(`target folder already exists: ${newFolder}`);
    if (fs.existsSync(oldDir)) fs.renameSync(oldDir, newDir);
    else console.warn(`[rename] ${actor.id}: old media folder missing on disk (${actor.media_folder}) — updating references only`);
    const oldSeg = `/media/actors/${actor.media_folder}/`;
    const newSeg = `/media/actors/${newFolder}/`;
    const newGlbUrl = actor.glb_url ? actor.glb_url.split(oldSeg).join(newSeg) : actor.glb_url;
    db.transaction(() => {
      db.prepare(`UPDATE actors SET name = ?, first_name = ?, last_name = ?, media_folder = ?, glb_url = ?, updated_at = ? WHERE id = ?`)
        .run(name, first_name, last_name, newFolder, newGlbUrl, new Date().toISOString(), actor.id);
      db.prepare(`UPDATE actor_media SET url = replace(url, ?, ?) WHERE actor_id = ?`).run(oldSeg, newSeg, actor.id);
      try { db.prepare(`UPDATE actor_media SET thumbnail_url = replace(thumbnail_url, ?, ?) WHERE actor_id = ?`).run(oldSeg, newSeg, actor.id); } catch {}
    })();
    console.log(`[rename] ${actor.id}: ${actor.media_folder} -> ${newFolder} (folder moved, row + media urls rewritten)`);
    res.json({ renamed: true, media_folder: newFolder, glb_url: newGlbUrl, moved: true });
  } catch (err) {
    console.error(`[rename] ${actor.id} FAILED:`, err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ── GET/POST /api/me/preferences — per-user preferences (Session 147) ─
// Namespaced JSON on users.preferences. POST merges at the TOP level
// only ({...existing, ...incoming}): a client owning one namespace
// (e.g. exploreDisplay) can't clobber another's. A preferences value
// that fails to parse is treated as {} and overwritten on next save —
// reported in the response, not silently.
app.get("/api/me/preferences", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const row = db.prepare(`SELECT preferences FROM users WHERE id = ?`).get(user.id);
  let prefs = {}, parseError = false;
  if (row?.preferences) {
    try { prefs = JSON.parse(row.preferences); }
    catch { parseError = true; console.error(`[preferences] unparseable JSON for user ${user.id} — serving {} (will be overwritten on next save)`); }
  }
  res.json({ preferences: prefs, ...(parseError ? { warning: "stored preferences were unparseable and were reset" } : {}) });
});

app.post("/api/me/preferences", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const incoming = req.body?.preferences;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return res.status(400).json({ error: "preferences object required" });
  }
  const row = db.prepare(`SELECT preferences FROM users WHERE id = ?`).get(user.id);
  let existing = {};
  if (row?.preferences) {
    try { existing = JSON.parse(row.preferences); }
    catch { console.error(`[preferences] unparseable existing JSON for user ${user.id} — replacing with incoming merge base {}`); }
  }
  const merged = { ...existing, ...incoming };
  db.prepare(`UPDATE users SET preferences = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(merged), new Date().toISOString(), user.id);
  res.json({ saved: true, preferences: merged });
});

app.post("/api/actors/:id/draft-state", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  // Session 147 — was `AND status = 'draft'`. Under the Plan A ruling
  // (deployed GLB is canonically body-only; wardrobe config in
  // draft_state IS the dressed state) this state must be writable for
  // every owned actor, forever — the old "finished characters are
  // baked, draft_state is in-progress only" premise no longer holds.
  // The client merges the full existing object before posting, so
  // wizard-era fields on finished actors are preserved, not clobbered.
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not an actor you own" });
  const state = req.body?.state;
  if (!state || typeof state !== "object") return res.status(400).json({ error: "state object required" });
  db.prepare(`UPDATE actors SET draft_state = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(state), new Date().toISOString(), req.params.id);
  // Session 103 — the Mac Mini scratch cleanup that lived here is
  // MOVED to finalize/abandon: auto-persist made every adjustment a
  // save, so a fresh character's scratch died 1.5s after the first
  // slider drag — before any archiving could happen (found live).
  // Scratch now survives the whole draft phase and dies only at the
  // deliberate ends of a character's life.
  res.json({ saved: true });
});

// ── POST /api/actors/:id/abandon-draft — beacon-compatible cleanup on window
// close. navigator.sendBeacon() only supports POST, not DELETE, and it's
// the one API browsers actually honour reliably as a tab is closing — a
// normal fetch()/DELETE inside a beforeunload handler is not guaranteed to
// complete. Only ever deletes if status is still "draft" — never touches
// a finished, active character just because its tab happened to close.
// -- recordActorDeletion -- append-only attribution for an actor delete -------
// conduct-watch signal 7 filed this: a delete removed an actor, its
// actor_media rows and its media folder, and left nothing that named the
// character, its owner, or the account that issued the delete. Every path that
// removes an `actors` row must call this, and must call it INSIDE the same
// transaction as the DELETE -- an audit row that can be missing for a
// committed delete is not an audit.
//
// Never updated, never deleted. The table (server/db.js) has no foreign keys
// on purpose, so the record survives the actor and both accounts.
function recordActorDeletion({ actor, user, via, mediaCount, mediaRows }) {
  // authUser() does not carry email, so resolve it here: an account id alone
  // stops being readable the moment the account is renamed or removed, and the
  // whole point of this row is that it is still legible long afterwards.
  const actingEmail = user?.id
    ? (db.prepare(`SELECT email FROM users WHERE id = ?`).get(user.id)?.email ?? null)
    : null;
  // What the media declared, frozen before actor_media is swept.
  const media = summariseActorMedia(mediaRows);
  const count = Array.isArray(mediaRows) ? mediaRows.length : (mediaCount ?? null);
  db.prepare(`INSERT INTO actor_deletions
      (id, actor_id, actor_name, owner_id, acting_user_id, acting_email, via,
       actor_status, media_folder, media_count, actor_age,
       media_depicts, media_subject_authorised, media_manifest, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    randomUUID(),
    actor.id,
    actor.name ?? null,
    actor.owner_id ?? null,
    user?.id ?? null,
    actingEmail,
    via,
    actor.status ?? null,
    actor.media_folder ?? null,
    count,
    // The declared age, carried onto the tombstone (2026-09-09): the whole
    // point of this row for the child-safety sweep is that it can answer
    // "did a declared minor exist here" after the actors row is gone.
    actor.age ?? null,
    // The declared likeness, carried onto the tombstone for the same reason
    // (2026-09-10, conduct-watch): "one media file went away" does not answer
    // "was it a third party, and had they authorised it", and actor_media is
    // gone by the time anyone asks.
    media.depicts,
    media.subjectAuthorised,
    media.manifest,
    new Date().toISOString(),
  );
  console.log(`[actor-delete] ${actor.id} (${actor.name ?? "?"}) owner=${actor.owner_id ?? "?"} by=${user?.id ?? "?"} via=${via} media=${count ?? "?"} depicts=${media.depicts ?? "unrecorded"} subject_authorised=${media.subjectAuthorised ?? "unrecorded"}`);
}

app.post("/api/actors/:id/abandon-draft", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).end();

  const actor = db.prepare(`SELECT id, name, owner_id, age, status, media_folder FROM actors WHERE id = ? AND owner_id = ? AND status = 'draft'`).get(req.params.id, user.id);
  if (!actor) return res.status(204).end(); // not a draft (already finished, or gone) — nothing to do

  // Read the urls before the transaction (it deletes the rows); unlink after it.
  // 2026-09-10 (conduct-watch): this read is also the ONLY chance to capture
  // what the media declared -- depicts / subject_authorised die with the rows,
  // and the tombstone is what has to answer the likeness question afterwards.
  const mediaFiles = db.prepare(`SELECT id, media_type, filename, url, depicts, subject_authorised
                                   FROM actor_media WHERE actor_id = ?`).all(req.params.id);
  const tables = ["actor_psychology","actor_big5","actor_disc","actor_hds","actor_economic",
    "actor_lifestyle","actor_mental_health","actor_education","actor_upbringing",
    "actor_diagnoses","actor_media","actor_shares","actor_assessment_results",
    // Session 150 — actor_expense_defaults was missing from BOTH delete paths
    // (draft discard and full delete), so 80 rows of per-character spending
    // budgets outlived the characters they belonged to.
    //
    // Deliberately still hand-listed rather than schema-driven, unlike
    // delete_world's sweep. There, a world_id column unambiguously means
    // "belongs to that world". Here it does not: world_memberships.actor_id and
    // registered_tools.actor_id hold PLAYER actor ids ("mk-87c91ce8",
    // "magnus-klack-actor"), not characters — a blanket sweep by actor_id would
    // reach into a different kind of thing that merely shares a column name.
    // Hand-listed, but now checked against the schema rather than assumed.
    // Session 161 — actor_share_links has a NO ACTION foreign key into actors
    // and was in NEITHER delete path, so a character that had ever been shared
    // by link could not be deleted at all: the DELETE raised exactly the way
    // the avatar pointer did, after the media had already been unlinked.
    "actor_expense_defaults","actor_deployments","actor_share_links"];
  db.transaction(() => {
    for (const t of tables) { try { db.prepare(`DELETE FROM ${t} WHERE actor_id = ?`).run(req.params.id); } catch {} }
    // Avatar mode adopts the draft at CREATE, so the person may be WEARING the
    // row about to be deleted. users.avatar_actor_id is a NO ACTION foreign key
    // and foreign_keys is ON, so leaving it set makes this DELETE raise — and
    // the media unlink used to run BEFORE this transaction, so the raise left a
    // row whose files were already destroyed, still being worn. Clearing the
    // pointer here puts it inside the same transaction: all of it, or none.
    db.prepare(`UPDATE users SET avatar_actor_id = NULL, updated_at = datetime('now') WHERE avatar_actor_id = ?`).run(req.params.id);
    // Attribution, in the same transaction as the delete and now BEFORE it
    // (conduct-watch signal 7; ordering changed 2026-09-09). `actors` carries
    // an AFTER DELETE trigger (server/db.js) that writes an UNATTRIBUTED
    // fallback row when no audited path claimed the delete, and it can only
    // see audit rows that already exist when the DELETE runs. Recording first
    // keeps the trigger quiet on this path; both writes are still in one
    // transaction, so a rollback takes the audit row with it.
    recordActorDeletion({ actor, user, via: "POST /api/actors/:id/abandon-draft", mediaRows: mediaFiles });
    db.prepare(`DELETE FROM actors WHERE id = ? AND owner_id = ?`).run(req.params.id, user.id);
  })();
  // Disk only AFTER the commit. A transaction that raises must not leave a live
  // row pointing at media that no longer exists.
  for (const m of mediaFiles) {
    try { fs.unlinkSync(path.join(__dirname, "../public", m.url)); } catch {}
  }
  deleteActorTmpFolder(req.params.id); // not awaited — see comment in generate3d.js
  deleteActorMediaFolder(actor.media_folder); // the GLB itself — see function comment for why this was missing
  res.status(204).end();
});

app.delete("/api/actors/:id", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const actor = db.prepare(`SELECT id, name, owner_id, age, status, media_folder FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });

  const deployment = db.prepare(`SELECT id FROM actor_deployments WHERE platform_actor_id = ? AND undeployed_at IS NULL`).get(req.params.id);
  if (deployment) return res.status(409).json({ error: "actor is deployed — undeploy first" });

  // Read the urls before the transaction (it deletes the rows); unlink after it.
  // 2026-09-10 (conduct-watch): this read is also the ONLY chance to capture
  // what the media declared -- depicts / subject_authorised die with the rows,
  // and the tombstone is what has to answer the likeness question afterwards.
  const mediaFiles = db.prepare(`SELECT id, media_type, filename, url, depicts, subject_authorised
                                   FROM actor_media WHERE actor_id = ?`).all(req.params.id);

  const tables = ["actor_psychology","actor_big5","actor_disc","actor_hds","actor_economic",
    "actor_lifestyle","actor_mental_health","actor_education","actor_upbringing",
    "actor_diagnoses","actor_media","actor_shares","actor_assessment_results",
    // Session 150 — actor_expense_defaults was missing from BOTH delete paths
    // (draft discard and full delete), so 80 rows of per-character spending
    // budgets outlived the characters they belonged to.
    //
    // Deliberately still hand-listed rather than schema-driven, unlike
    // delete_world's sweep. There, a world_id column unambiguously means
    // "belongs to that world". Here it does not: world_memberships.actor_id and
    // registered_tools.actor_id hold PLAYER actor ids ("mk-87c91ce8",
    // "magnus-klack-actor"), not characters — a blanket sweep by actor_id would
    // reach into a different kind of thing that merely shares a column name.
    // Hand-listed, but now checked against the schema rather than assumed.
    // Session 161 — actor_share_links has a NO ACTION foreign key into actors
    // and was in NEITHER delete path, so a character that had ever been shared
    // by link could not be deleted at all: the DELETE raised exactly the way
    // the avatar pointer did, after the media had already been unlinked.
    "actor_expense_defaults","actor_deployments","actor_share_links"];

  db.transaction(() => {
    for (const t of tables) {
      try { db.prepare(`DELETE FROM ${t} WHERE actor_id = ?`).run(req.params.id); } catch {}
    }
    try { db.prepare(`DELETE FROM actor_deployments WHERE platform_actor_id = ?`).run(req.params.id); } catch {}
    // Avatar mode adopts the draft at CREATE, so the person may be WEARING the
    // row about to be deleted. users.avatar_actor_id is a NO ACTION foreign key
    // and foreign_keys is ON, so leaving it set makes this DELETE raise — and
    // the media unlink used to run BEFORE this transaction, so the raise left a
    // row whose files were already destroyed, still being worn. Clearing the
    // pointer here puts it inside the same transaction: all of it, or none.
    db.prepare(`UPDATE users SET avatar_actor_id = NULL, updated_at = datetime('now') WHERE avatar_actor_id = ?`).run(req.params.id);
    // Attribution, in the same transaction as the delete and now BEFORE it
    // (conduct-watch signal 7; ordering changed 2026-09-09). `actors` carries
    // an AFTER DELETE trigger (server/db.js) that writes an UNATTRIBUTED
    // fallback row when no audited path claimed the delete, and it can only
    // see audit rows that already exist when the DELETE runs. Recording first
    // keeps the trigger quiet on this path; both writes are still in one
    // transaction, so a rollback takes the audit row with it.
    recordActorDeletion({ actor, user, via: "DELETE /api/actors/:id", mediaRows: mediaFiles });
    db.prepare(`DELETE FROM actors WHERE id = ? AND owner_id = ?`).run(req.params.id, user.id);
  })();
  // Disk only AFTER the commit. A transaction that raises must not leave a live
  // row pointing at media that no longer exists.
  for (const m of mediaFiles) {
    try { fs.unlinkSync(path.join(__dirname, "../public", m.url)); } catch {}
  }
  deleteActorTmpFolder(req.params.id); // not awaited — see comment in generate3d.js
  deleteActorMediaFolder(actor.media_folder); // the GLB itself — see function comment for why this was missing
  res.json({ ok: true });
});

// ── GET /api/actors/:id — full canonical profile ──────────────────────────────
app.get("/api/actors/:id", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { id } = req.params;

  // Allow owner or anyone with a share
  let actor = db.prepare(`SELECT a.*, (SELECT url FROM actor_media WHERE actor_id = a.id AND media_type = 'photo' AND state_slug IN ('photo_close','profile') LIMIT 1) as photo_url FROM actors a WHERE a.id = ? AND a.owner_id = ?`).get(id, user.id);
  if (!actor) {
    const share = db.prepare(`SELECT permission FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(id, user.id);
    if (!share) return res.status(404).json({ error: "not found" });
    actor = db.prepare(`SELECT a.*, (SELECT url FROM actor_media WHERE actor_id = a.id AND media_type = 'photo' AND state_slug IN ('photo_close','profile') LIMIT 1) as photo_url, ? as permission FROM actors a WHERE a.id = ?`).get(share.permission, id);
    if (!actor) return res.status(404).json({ error: "not found" });
  }

  const psychology = db.prepare(`SELECT * FROM actor_psychology WHERE actor_id = ?`).get(id);
  // Session 103 — the editor shows MEASURED truth where the appearance
  // prose blob used to sit: read the pipeline measurements file when
  // one exists (drafts and modern actors have it; legacy actors show
  // nothing, honestly).
  let measurements = null;
  try {
    const mrow = db.prepare(`SELECT media_folder FROM actors WHERE id = ?`).get(id);
    if (mrow?.media_folder) {
      const mdir = path.join(__dirname, "../public/media/actors", mrow.media_folder);
      const { readdirSync, readFileSync } = require("fs");
      const mfile = readdirSync(mdir).find(f => f.endsWith("-measurements.json"));
      if (mfile) measurements = JSON.parse(readFileSync(path.join(mdir, mfile), "utf8"));
    }
  } catch {}

  const big5       = db.prepare(`SELECT * FROM actor_big5 WHERE actor_id = ?`).get(id);
  const disc       = db.prepare(`SELECT * FROM actor_disc WHERE actor_id = ?`).get(id);
  const hds        = db.prepare(`SELECT * FROM actor_hds WHERE actor_id = ?`).get(id);
  const lifestyle  = db.prepare(`SELECT * FROM actor_lifestyle WHERE actor_id = ?`).get(id);
  const economic   = db.prepare(`SELECT * FROM actor_economic WHERE actor_id = ?`).get(id);
  const mental     = db.prepare(`SELECT * FROM actor_mental_health WHERE actor_id = ?`).get(id);
  const upbringing = db.prepare(`SELECT * FROM actor_upbringing WHERE actor_id = ?`).get(id);
  const education  = db.prepare(`SELECT * FROM actor_education WHERE actor_id = ? ORDER BY inserted_at`).all(id);
  const diagnoses  = db.prepare(`SELECT * FROM actor_diagnoses WHERE actor_id = ? ORDER BY inserted_at`).all(id);
  const expenses   = db.prepare(`SELECT * FROM actor_expense_defaults WHERE actor_id = ? ORDER BY name`).all(id);

  // Session 102 — mediaPhotos: the canonical photo rows (profile +
  // body_*), so draft loading restores photo slots from actor_media
  // instead of guessing file conventions (the pipeline's pulled
  // copies live elsewhere and may predate the pull fix).
  // updated_at exposed so the client can cache-bust: the photo is written to a
  // FIXED filename per slot (state_slug + ext), so its URL never changes when
  // the photo is replaced -- without a ?v= stamp taken from this column, a
  // browser can legitimately keep serving whatever bytes it fetched from that
  // URL last time.
  // 2026-09-11 (conduct-watch, resolution-manager) -- reference AUDIO is in
  // this list now. It was photo-only, so the editor's "Declaration needed"
  // notice and the wizard could not see a voice sample at all: the one question
  // the whole apparatus exists to ask was un-askable about a recorded voice.
  // media_type comes back with it so the callers can tell the two apart --
  // CharacterWizard already filters on exactly that field for its photo slots.
  const mediaPhotos = db.prepare(`SELECT state_slug, media_type, url, depicts, subject_authorised, depicts_cleared_from, depicts_cleared_at, updated_at FROM actor_media WHERE actor_id = ? AND media_type IN ('photo','audio') AND world_id IS NULL`).all(req.params.id);
  // Session 150 — say plainly whether this caller owns the character.
  //
  // owner_id and permission were both already in the payload and the profile
  // editor used neither: it rendered every field as editable for a shared
  // character, then failed the save with a bare 404 from the PUT's
  // `WHERE owner_id = ?`. Renaming somebody else's character appeared to work
  // right up until it didn't.
  //
  // Editing the TEMPLATE is the owner's alone at every rung. "use" buys
  // deploying it; "copy" buys forking it. Neither buys editing the original —
  // that is the ambiguity the ladder exists to remove.
  actor.is_owner = actor.owner_id === user.id;

  // The standing record of a withdrawal the simulator did not carry out. Always
  // present (an empty array when there is nothing outstanding) so the client
  // never has to tell "nothing is wrong" apart from "this server is too old to
  // say". Read for ANY caller who may see the actor, not only the owner: a
  // person holding a share on a likeness whose subject said no should be able
  // to see that as well.
  const withdrawal_still_deployed = unenforcedWithdrawalWorlds(id);

  res.json({ actor, psychology, big5, disc, hds, lifestyle, economic, mental, upbringing, education, diagnoses, expenses, mediaPhotos, measurements, withdrawal_still_deployed });
});

// ── The age floor, in ONE place because age has TWO write paths ──────────────
//
// POST /api/actors sets age when it creates and when it finalizes; PUT
// /api/actors/:id sets any column on the actors row, age included. A floor on
// only the first is not a floor, so both call this.
//
// Until 2026-08-30 nothing bounded age anywhere. The only restraint in the
// product was min={18} on the wizard's Age input, which constrains a native
// form submission and does nothing to a React state value posted by script.
// Age is not decoration: it is pushed onto the player's row in every world by
// deployAvatarToWorlds() and interpolated straight into an NPC's prompt by the
// simulator's visitor_block/1.
//
// An ABSENT age stays legal — the wizard saves drafts long before Age is filled
// in, and failing those would break creation to enforce a rule about content.
// Only a SUPPLIED age is bound.
//
// Scope, stated because a broader rule would be wrong: this binds characters
// authored on the platform. It does NOT reach the simulator's ambient cast,
// which is seeded on the other host and legitimately includes children.
//
// Returns an error string, or null when the value is acceptable.
const AGE_FLOOR = 18, AGE_CEILING = 120;
function ageFloorError(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < AGE_FLOOR || n > AGE_CEILING) {
    return `age must be a whole number between ${AGE_FLOOR} and ${AGE_CEILING}`;
  }
  return null;
}

// ── PUT /api/actors/:id — update canonical profile ────────────────────────────
app.put("/api/actors/:id", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { id } = req.params;
  const { section, data } = req.body;

  // A 404 here is misleading when the character plainly exists and is visible on
  // screen — it reads as "gone", not as "not yours". Distinguish the two.
  const owned = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(id, user.id);
  if (!owned) {
    const shared = db.prepare(
      `SELECT s.permission, u.name AS owner_name FROM actor_shares s
       JOIN actors a ON a.id = s.actor_id JOIN users u ON u.id = a.owner_id
       WHERE s.actor_id = ? AND s.shared_with_id = ?`
    ).get(id, user.id);
    if (shared) {
      return res.status(403).json({
        error: `${shared.owner_name} owns this character — you have "${shared.permission}". Only the owner can edit the profile. Fork it if you want your own version.`,
        owner_name: shared.owner_name, permission: shared.permission,
      });
    }
  }
  const actor = owned;
  if (!actor) return res.status(404).json({ error: "not found" });

  // Section "actor" writes the actors row itself, so it can set age.
  if (section === "actor") {
    const bad = ageFloorError(data?.age);
    if (bad) return res.status(400).json({ error: bad, field: "age", received: data?.age });
  }

  const now = new Date().toISOString();

  const TABLES = {
    actor:      { table: "actors",            pk: "id" },
    psychology: { table: "actor_psychology",  pk: "actor_id" },
    big5:       { table: "actor_big5",        pk: "actor_id" },
    disc:       { table: "actor_disc",        pk: "actor_id" },
    hds:        { table: "actor_hds",         pk: "actor_id" },
    lifestyle:  { table: "actor_lifestyle",   pk: "actor_id" },
    economic:   { table: "actor_economic",    pk: "actor_id" },
    mental:     { table: "actor_mental_health", pk: "actor_id" },
    upbringing: { table: "actor_upbringing",  pk: "actor_id" },
  };

  const target = TABLES[section];
  if (!target) return res.status(400).json({ error: "unknown section" });

  // photo_url lives in actor_media, not actors table — handle separately
  const photoUrl = (section === "actor") ? data.photo_url : undefined;
  // Only real columns of the target table may be written. The editor round-trips
  // whatever GET /api/actors/:id handed it, and that payload carries computed
  // fields that are not columns — `is_owner` (Session 150) and, for a shared
  // character, `permission`. A blind Object.keys() therefore built
  // `SET is_owner = ?` and EVERY Identity save died with
  // "no such column: is_owner", HTTP 500; the editor showed "Couldn't save
  // actor — HTTP 500" and the name never changed. Deriving the allowlist from
  // the schema means the next computed field added to the GET cannot break
  // saves again. updated_at is dropped too — it is appended explicitly below,
  // and passing it through produced a duplicate assignment in the same SET.
  const columns = new Set(db.prepare(`PRAGMA table_info(${target.table})`).all().map(c => c.name));
  const fields = Object.keys(data).filter(k =>
    columns.has(k) && k !== target.pk && k !== "inserted_at" && k !== "updated_at" && k !== "photo_url");

  if (fields.length > 0) {
    const sets   = fields.map(f => `${f} = ?`).join(", ");
    const values = fields.map(f => data[f]);
    db.prepare(`UPDATE ${target.table} SET ${sets}, updated_at = ? WHERE ${target.pk} = ?`)
      .run(...values, now, id);
  }

  // Upsert canonical profile photo into actor_media if provided
  if (photoUrl) {
    const existing = db.prepare("SELECT id, url, depicts FROM actor_media WHERE actor_id = ? AND state_slug = 'profile' AND media_type = 'photo' AND world_id IS NULL").get(id);
    if (existing) {
      // A different photograph is a different question. Carrying the previous
      // `depicts` across a swapped url would let a statement made about one
      // photograph stand as a statement about another — the one thing this
      // column must never do — so a swap drops it back to "not declared".
      // 2026-09-11 (conduct-watch): the drop stands -- see the upload route --
      // but it is recorded now rather than silent, for the same reason it is
      // there: a blank that used to be an answer must not read as "never asked".
      const swapped = existing.url !== photoUrl;
      const wasDeclared = swapped ? (existing.depicts || null) : null;
      if (wasDeclared) console.warn(`[media] depicts CLEARED by profile photo swap actor: ${id} slot: profile was: ${wasDeclared}`);
      db.prepare(`UPDATE actor_media SET url = ?, updated_at = ?${swapped ? ", depicts = NULL" : ""}${wasDeclared ? ", depicts_cleared_from = ?, depicts_cleared_at = ?" : ""} WHERE id = ?`)
        .run(photoUrl, now, ...(wasDeclared ? [wasDeclared, now] : []), existing.id);
    } else {
      db.prepare("INSERT INTO actor_media (id, actor_id, media_type, state_slug, url, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(randomUUID(), id, "photo", "profile", photoUrl, now, now);
    }
  }

  res.json({ ok: true });
});

// -- API key authorisation: scopes and world binding --------------------------
//
// A key is minted per world (POST /api/worlds/:id/issue-key) and carries a
// scope list. Until 2026-09-05 neither was read at authorisation time. The rule
// this implements, deliberately narrow so it matches what keys are FOR:
//
//   * account surface -- a key is an installed-app credential, not a session.
//     Only the endpoints the apps genuinely call without a world in the path
//     are reachable with one. Key minting, org admin, the character library,
//     enrolment, erasure -- all of that needs a browser session now.
//   * world binding -- /api/worlds/<id>/... must be the world the key was
//     minted for. A key bound to a world that no longer exists is inert, which
//     is why the three dead world_ids need no separate revocation.
//   * scopes -- taken from the family of the path, with the verb splitting read
//     from write. An unrecognised world route falls back to world:read for safe
//     methods and world:control for mutating ones, so a route added later is
//     closed to under-scoped keys by default rather than open by default.
//
// Denial returns null from authUser(), i.e. the caller sees the route's own 401.
const API_KEY_ACCOUNT_ALLOW = new Set(["/api/me", "/api/apps", "/api/tts"]);

function apiKeyRequiredScope(method, tail) {
  const safe = method === "GET" || method === "HEAD";
  if (/\/voicemail(\/|$)/.test(tail))          return safe ? "messages:read" : "messages:write";
  if (/\/messages(\/|$)/.test(tail))           return safe ? "messages:read" : "messages:write";
  if (/\/media(\/|$)/.test(tail))              return safe ? "messages:read" : "messages:write";
  if (/\/meetings(\/|$)/.test(tail))           return safe ? "messages:read" : "messages:write";
  if (/\/(contacts|context)(\/|$)/.test(tail)) return "contacts:read";
  if (/\/calendar(\/|$)/.test(tail))           return "calendar:read";
  if (/\/feed(\/|$)/.test(tail))               return "feed:read";
  return safe ? "world:read" : "world:control";
}

// Returns null when the key may serve this request, or a short human reason.
function apiKeyDenial(req, keyRow) {
  const path = req.path || "";
  if (!path.startsWith("/api/")) return null; // static and proxy surface carries no scope

  let scopes = [];
  try { scopes = JSON.parse(keyRow.scopes || "[]"); } catch (_e) { scopes = []; }
  if (!Array.isArray(scopes)) scopes = [];

  const world = path.match(/^\/api\/worlds\/([^/]+)/);
  if (!world) {
    return API_KEY_ACCOUNT_ALLOW.has(path)
      ? null
      : `${path} is account surface, and an api key is world-scoped`;
  }
  if (keyRow.world_id && world[1] !== keyRow.world_id) {
    return `key is bound to world ${keyRow.world_id}, request is for ${world[1]}`;
  }
  // Conduct watch, 2026-09-12: the binding is not the grant. The check above
  // only asks whether the key names this world; it never asked whether the
  // key's owner is still entitled to it. Membership can be revoked, and it
  // vanishes outright when a world is deleted -- the api_keys row does not.
  // Five of seven live keys were found addressing worlds their owner holds no
  // membership on, two of them belonging to accounts with no membership
  // anywhere at all, so a credential outlived the grant it was issued under by
  // months. Checked at the same point the key becomes a principal, so a
  // withdrawn grant takes its credentials with it on the next request.
  const granted = db.prepare(
    `SELECT 1 FROM world_memberships WHERE user_id = ? AND world_id = ? LIMIT 1`
  ).get(keyRow.user_id, world[1]);
  if (!granted) {
    return `key owner ${keyRow.user_id} holds no membership on world ${world[1]}`;
  }
  const tail = path.slice(world[0].length);
  if (/^\/issue-key(\/|$)/.test(tail)) return "a key may not mint another key";
  const need = apiKeyRequiredScope(req.method, tail);
  return scopes.includes(need) ? null : `key lacks scope ${need}`;
}

// -- Helper: auth from cookie ──────────────────────────────────────────────────
function authUser(req) {
  // 1. Cookie auth (platform UI)
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (match) {
    const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
    // status must be checked here too: revoking an erased person's tokens stops
    // the sessions that exist, but nothing else would stop a token minted before
    // the erase from being honoured if one were somehow still live.
    const row = db.prepare(`SELECT u.id, u.name, u.org_id, u.user_type, u.org_role FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND julianday(t.expires_at) > julianday('now') AND u.status != 'removed'`).get(hash);
    if (row) return row;
  }
  // 2. API key auth (installed apps)
  //
  // Conduct watch, 2026-09-05: this branch used to return the full user row for
  // any live key -- the same object the cookie branch returns -- so a key's
  // `scopes` list and the world it was minted for were decorative, and a bearer
  // of any live key was the whole account, everywhere on the platform API, for
  // as long as the key lived. Both columns are consulted now, here, at the one
  // point where a key becomes a principal. See apiKeyDenial() above.
  const apiKey = req.headers["x-api-key"] || "";
  if (apiKey.startsWith("sk-an-")) {
    const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
    const keyRow = db.prepare(`SELECT user_id, world_id, scopes FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL AND expires_at IS NOT NULL AND julianday(expires_at) > julianday('now')`).get(keyHash);
    if (keyRow) {
      db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE key_hash = ?`).run(keyHash);
      const denial = apiKeyDenial(req, keyRow);
      if (denial) {
        // Recorded, not swallowed: a refused key is more interesting than an
        // honoured one, and the [req] attribution line for this request will
        // resolve to anon, so this is the only place the refusal is written.
        if (!req._apiKeyDenialLogged) {
          req._apiKeyDenialLogged = true;
          console.warn(`[apikey-denied] ${req.method} ${req.path} key=${keyHash.slice(0, 8)} user=${keyRow.user_id} :: ${denial}`);
        }
        return null;
      }
      // The key's own world binding is carried forward on the request. Routes in
      // API_KEY_ACCOUNT_ALLOW bypass apiKeyDenial()'s world check by definition
      // (they have no world in the path), so a route that reaches world-scoped
      // material from an account-surface path has to re-apply it itself.
      req._apiKeyRow = keyRow;
      return db.prepare(`SELECT id, name, org_id, user_type, org_role FROM users WHERE id = ? AND status != 'removed'`).get(keyRow.user_id);
    }
  }
  return null;
}


// ── POST /api/worlds/:world_id/meetings/confirm ───────────────────────────────
// Player accepts a meetup proposal — writes PlannedMeeting on simulator,
// Amber's engine fires the meeting when scheduled_at is reached.
app.post("/api/worlds/:world_id/meetings/confirm", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  try {
    const resp = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/meetings/confirm`, {
      method: "POST",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/actors/:actor_id/messages/:contact_id/respond/:msg_id
// Marks a proposal message as responded on the simulator.
app.post("/api/worlds/:world_id/actors/:actor_id/messages/:contact_id/respond/:msg_id", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`).get(user.id, req.params.world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });
  if (membership.actor_id !== req.params.actor_id) return res.status(403).json({ error: "actor mismatch" });
  try {
    const resp = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/messages/${req.params.contact_id}/respond/${req.params.msg_id}`,
      { method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/actors/:actor_id/calendar ──────────────────────
// Returns today's schedule slots + upcoming confirmed planned meetings.
app.get("/api/worlds/:world_id/actors/:actor_id/calendar", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`).get(user.id, req.params.world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });
  if (membership.actor_id !== req.params.actor_id) return res.status(403).json({ error: "actor mismatch" });
  try {
    const data = await simFetch(`/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/calendar`);
    res.json(data);
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/actors/:actor_id/voicemail ─────────────────────
// Returns voice messages received by actor, marks as read.
app.get("/api/worlds/:world_id/actors/:actor_id/voicemail", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  // Session 151 — this route trusted its own :actor_id, so any member of the
  // world could read any actor's voicemail by asking for it. The messages route
  // beside it has always checked; this one never did. Same check, same words.
  const membership = db.prepare(
    `SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`
  ).get(user.id, req.params.world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });
  if (membership.actor_id !== req.params.actor_id) return res.status(403).json({ error: "actor mismatch" });
  try {
    const data = await simFetch(`/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/voicemail?reader_actor_id=${encodeURIComponent(req.params.actor_id)}`);
    res.json(data);
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/actors/:actor_id/introduce ────────────────────
//
// Session 151 — record that this player now knows who an ambient person is.
// Gating Approach on it is the point: you cannot walk up to a stranger and open
// a private conversation with someone whose name nobody has told you.
//
// player_actor_id comes from the membership, never from the body — the caller
// does not get to say who they are.
app.post("/api/worlds/:world_id/actors/:actor_id/introduce", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const membership = db.prepare(
    `SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ? LIMIT 1`
  ).get(ok.user.id, req.params.world_id);
  if (!membership?.actor_id) return res.status(403).json({ error: "no character in this world" });
  try {
    const r = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/introduce`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Service-Token": SERVICE_TOKEN },
        body: JSON.stringify({ player_actor_id: membership.actor_id }),
      }
    );
    res.status(r.status).json(await r.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/relations ──────────────────────────────────────
//
// Session 151 — who knows whom. Every member may ask; the answer depends on who
// is asking, and the scope is decided here because roles live here.
//
//   owner  -> scope=cast. The whole cast graph with its numbers. Ties to a user
//             are counted and withheld, because how far a character has come to
//             trust a player is a summary of sealed conversations.
//   player -> scope=self. Only ties that touch them, and no numbers: that she is
//             drawn to you is yours, what her trust reads is hers.
app.get("/api/worlds/:world_id/relations", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const membership = db.prepare(
    `SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ? LIMIT 1`
  ).get(ok.user.id, req.params.world_id);
  const viewer = membership?.actor_id || "";
  const scope  = ok.role === "owner" ? "cast" : "self";
  try {
    res.json(await simFetch(
      `/internal/worlds/${req.params.world_id}/relations?scope=${scope}&viewer_actor_id=${encodeURIComponent(viewer)}`
    ));
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/cast/:actor_id/comms ───────────────────────────
//
// Session 151 — a character's correspondence, for the owner of the world she
// lives in. Owner only, and the simulator seals it a second time: threads,
// voicemail and appointments whose other party is a user are counted, never
// sent. Nothing on this path writes, so looking at her phone does not mark it
// read, and she is not told she was read.
app.get("/api/worlds/:world_id/cast/:actor_id/comms", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  try {
    const r = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/cast/${req.params.actor_id}/comms`,
      { headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    res.status(r.status).json(await r.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/cast/:actor_id/thread/:contact_id ──────────────
app.get("/api/worlds/:world_id/cast/:actor_id/thread/:contact_id", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  try {
    const r = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/cast/${req.params.actor_id}/thread/${req.params.contact_id}`,
      { headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    res.status(r.status).json(await r.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ---- voiceDeclarationRefusal(actorId) --------------------------------------
//
// 2026-09-11 (conduct-watch, resolution-manager) -- THE PLATFORM WAS NOT THE
// ONLY CALLER OF THE XTTS HOST, SO THIS GATE WAS A PROPERTY OF ONE HTTP ROUTE
// RATHER THAN A PROPERTY OF THE ACT.
//
// The check below used to live inside the POST /api/tts handler. The simulator
// speaks in these same cloned voices during an encounter --
// encounter_process.ex call_chatterbox/3 POSTs the XTTS host directly with
// reference_audio_filename: "<simulator actor id>.mp3" -- and asked nothing at
// all. The declaration exists only on this host (the simulator's actor_media
// has no depicts/subject_authorised columns), so the simulator cannot answer
// the question locally; it has to ask here.
//
// Lifted out verbatim so there is exactly ONE implementation of "may this voice
// be spoken in", shared by POST /api/tts and by POST
// /api/internal/voice-declaration below. Both callers of the XTTS host now
// apply the same standard, and cannot drift apart by being edited separately.
//
// Returns null when the voice may be spoken, or a refusal object when it may
// not. No audio crosses this function in either direction: the answer is a
// verdict, not media.
function voiceDeclarationRefusal(actorId) {
  const platformIds = db.prepare(
    `SELECT DISTINCT platform_actor_id FROM actor_deployments WHERE simulator_actor_id = ?`
  ).all(actorId).map(r => r.platform_actor_id).filter(Boolean);
  const voiceIds    = [actorId, ...platformIds];
  const voiceIdSlot = voiceIds.map(() => "?").join(",");

  const voiceRef = db.prepare(
    `SELECT id, actor_id, state_slug, depicts, subject_authorised,
            CASE WHEN depicts IS NULL OR depicts = '' THEN 'undeclared' ELSE 'unauthorised' END AS reason
       FROM actor_media
      WHERE actor_id IN (${voiceIdSlot}) AND media_type = 'audio' AND world_id IS NULL
        AND ( depicts IS NULL OR depicts = ''
              OR (depicts = 'other' AND (subject_authorised IS NULL OR subject_authorised != 'yes')) )
      ORDER BY CASE WHEN depicts IS NULL OR depicts = '' THEN 0 ELSE 1 END
      LIMIT 1`
  ).get(...voiceIds);
  if (voiceRef) {
    return {
      reason: voiceRef.reason,
      needs:  voiceRef.reason === "undeclared" ? "depicts" : "subject_authorised",
      log:    `reference recording ${voiceRef.id} (actor ${voiceRef.actor_id}) is ${voiceRef.reason} (depicts: ${voiceRef.depicts ?? "unset"}, subject_authorised: ${voiceRef.subject_authorised ?? "unset"})`,
      error:  voiceRef.reason === "undeclared"
        ? "This character's reference recording carries no statement of whose voice it is. A recorded voice is a likeness in the same sense a face is, and a blank is not a declaration that it is yours. Say whose voice the recording is before speaking in it."
        : "This character's reference recording is declared to be of somebody else, and that person has not authorised the likeness. Record their authorisation before speaking in their voice.",
    };
  }

  const anyVoiceRow = db.prepare(
    `SELECT 1 FROM actor_media WHERE actor_id IN (${voiceIdSlot}) AND media_type = 'audio' AND world_id IS NULL LIMIT 1`
  ).get(...voiceIds);
  if (!anyVoiceRow) {
    return {
      reason: "no_reference_recording",
      needs:  "reference_recording",
      log:    `no reference recording on this host ties this id to a declaration (resolved platform ids: ${platformIds.join(", ") || "none"})`,
      error:  "No reference recording on this platform can be tied to this voice. Speaking new words in somebody's voice is building from their likeness, and nothing here states whose voice the recording is. Upload the reference recording against this character and declare whose voice it is before speaking in it.",
    };
  }

  return null;
}

// ---- POST /api/internal/voice-declaration -----------------------------------
//
// 2026-09-11 (conduct-watch, resolution-manager). The same gate, asked by the
// simulator before it speaks in a cloned voice on the encounter path.
//
// LAN-only and service-token only, never a user session: this is a
// server-to-server question, the mirror of the X-Service-Token calls this host
// already makes into the simulator. It carries no audio and grants access to
// nothing -- it answers exactly one question, "may this voice be spoken in",
// and returns a verdict.
//
// This ADDS authentication to a new surface; it relaxes none. An unset
// PLATFORM_SERVICE_TOKEN refuses every request rather than accepting every
// request, and because the simulator treats anything that is not an explicit
// allow as a refusal, a broken token here makes the encounter voice path
// silent rather than permissive.
app.post("/api/internal/voice-declaration", (req, res) => {
  if (!SERVICE_TOKEN || req.get("X-Service-Token") !== SERVICE_TOKEN) {
    return res.status(401).json({ allowed: false, error: "service token required" });
  }
  const actor_id = req.body && req.body.actor_id;
  if (!actor_id) return res.status(400).json({ allowed: false, error: "actor_id required" });

  const refusal = voiceDeclarationRefusal(actor_id);
  if (refusal) {
    console.warn(`[tts] REFUSED (simulator encounter path) actor: ${actor_id}: ${refusal.log}`);
    return res.status(403).json({ allowed: false, reason: refusal.reason, needs: refusal.needs, error: refusal.error });
  }
  return res.json({ allowed: true });
});


// ── POST /api/tts — proxy to XTTS, fallback gracefully if down ───────────────
const XTTS_URL = "http://212.147.242.29:8005/tts";

// 2026-09-11 (conduct-watch, resolution-manager) -- /api/tts ESTABLISHED THAT
// SOMEBODY WAS LOGGED IN, AND NOTHING ELSE.
//
// Every other actor-scoped route on this host establishes a RELATIONSHIP to the
// actor before it acts: requireWorld(..., 'owner'|'player') for the world
// proxies, hasAccess(actor, user, 'read'|'use'|'copy') for the character
// library, actorInWorld() for the media proxies. This one took a bare body
// actor_id from any authenticated caller, so an account with no connection to
// another account's character could speak new words in that character's voice
// by knowing or guessing its id. The declaration gate below narrowed the blast
// radius but answers a different question -- it asks whether the recording is
// declared, not whether the CALLER is entitled to it -- so a correctly declared
// and subject-authorised voice was synthesisable by any logged-in stranger.
//
// This is actorInWorld() with the world quantified out, because /api/tts has no
// world in its path: the same two rungs, checked against every world the caller
// actually belongs to.
//
//   1. direct character access -- owner of the actors row, or an actor_shares
//      row at any level. 'read' is the floor deliberately: someone who may look
//      at the character may hear it.
//   2. world membership -- the actor is deployed into a world the caller is a
//      member of, or the id IS the caller's own player actor in such a world.
//      This is the voicemail case, and the reason the predicate is not
//      owner-only: a player listening to a message from an NPC in their world
//      has never owned that character and never will.
//
// Deployments are matched whether or not they are still live. A voicemail
// outlives the deploy that produced it, and refusing to replay an old message
// to a member of the world it was left in would be breaking playback for a
// legitimate player to close a hole that is about strangers.
//
// The id may arrive as either a simulator actor id (VoicemailPage sends
// msg.sender_id) or a platform actor id, so both spaces are tried, resolved
// through actor_deployments exactly as the declaration gate below does.
function ttsActorEntitlement(actorId, user) {
  if (!user || !actorId) return null;
  const id = String(actorId);

  const platformIds = db.prepare(
    `SELECT DISTINCT platform_actor_id FROM actor_deployments WHERE simulator_actor_id = ?`
  ).all(id).map(r => r.platform_actor_id).filter(Boolean);

  for (const cand of [id, ...platformIds]) {
    const acc = hasAccess(cand, user, "read");
    if (acc) return { via: acc.level === "owner" ? "owner" : `share:${acc.level}`, world_id: null };
  }

  const dep = db.prepare(
    `SELECT d.world_id FROM actor_deployments d
       JOIN world_memberships m ON m.world_id = d.world_id
      WHERE m.user_id = ? AND (d.simulator_actor_id = ? OR d.platform_actor_id = ?)
      LIMIT 1`
  ).get(user.id, id, id);
  if (dep) return { via: "world_membership", world_id: dep.world_id };

  const own = db.prepare(
    `SELECT world_id FROM world_memberships WHERE user_id = ? AND actor_id = ? LIMIT 1`
  ).get(user.id, id);
  if (own) return { via: "own_player_actor", world_id: own.world_id };

  return null;
}

app.post("/api/tts", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const { text, actor_id } = req.body;
  if (!text || !actor_id) return res.status(400).json({ error: "text and actor_id required" });

  // Who is asking, before what is being asked for. This runs ahead of the
  // declaration gate on purpose: a stranger should not learn from the reply
  // whether an actor id exists, nor what state its reference recording is in.
  // 404 rather than 403 for the same reason requireWorld() answers 404 to a
  // non-member -- "forbidden" would confirm the character exists.
  const entitlement = ttsActorEntitlement(actor_id, user);
  if (!entitlement) {
    console.warn(`[tts] REFUSED actor: ${actor_id} user: ${user.id}: caller has no established relationship to this actor (no ownership, no share, no world membership)`);
    return res.status(404).json({ error: "actor not found" });
  }

  // An api key is minted for ONE world and is an installed app's credential,
  // not a session. /api/tts sits in API_KEY_ACCOUNT_ALLOW because the phone app
  // genuinely calls it with no world in the path, which means apiKeyDenial()
  // never got to apply the binding -- so a key for world A could reach an actor
  // its owner happens to have in world B. Ownership and shares still pass,
  // because those are the key holder's own characters; reaching another world's
  // cast with a key bound elsewhere does not.
  const keyWorld = req._apiKeyRow?.world_id || null;
  if (keyWorld && entitlement.via !== "owner" && !String(entitlement.via).startsWith("share")) {
    const inKeyWorld = db.prepare(
      `SELECT 1 FROM actor_deployments d
         JOIN world_memberships m ON m.world_id = d.world_id AND m.user_id = ?
        WHERE d.world_id = ? AND (d.simulator_actor_id = ? OR d.platform_actor_id = ?)
        LIMIT 1`
    ).get(user.id, keyWorld, String(actor_id), String(actor_id))
      || db.prepare(
        `SELECT 1 FROM world_memberships WHERE user_id = ? AND world_id = ? AND actor_id = ? LIMIT 1`
      ).get(user.id, keyWorld, String(actor_id));
    if (!inKeyWorld) {
      console.warn(`[tts] REFUSED actor: ${actor_id} user: ${user.id}: api key is bound to world ${keyWorld} and this actor is not in it`);
      return res.status(404).json({ error: "actor not found" });
    }
  }

  // 2026-09-11 (conduct-watch, resolution-manager) -- A VOICE CLONE IS A BUILD
  // FROM A LIKENESS, AND NOTHING WAS ASKING WHOSE.
  //
  // This is the act the reference recording exists for: XTTS is handed a
  // reference voice and speaks arbitrary new words in it. Every comparable act
  // on the photograph side -- solve, runtime-glb, save-morphed-glb, fork,
  // deploy, share, link, publish -- refuses a reference set that carries no
  // statement of whose likeness it is, or one declared 'other' whose subject has
  // not agreed. This one asked nothing at all.
  //
  // Scoped to the actor's OWN reference recording rather than to
  // unauthorisedSubjectInLineage: an undeclared photograph is an unanswered
  // question about a FACE, and refusing to speak over it would be refusing the
  // wrong thing. The face gates already cover that.
  //
  // 2026-09-11 (conduct-watch, resolution-manager) -- THE GATE ABOVE WAS
  // QUERYING THE WRONG ID SPACE, AND THEN FAILING OPEN WHEN IT MISSED.
  //
  // VoicemailPage calls this endpoint with `msg.sender_id`, which is a
  // SIMULATOR actor id. The declaration lives on actor_media, keyed by the
  // PLATFORM actor id, and the two are different uuids: deploy mints a fresh
  // one for the simulator actor (internal_world_controller.ex ~3017) and
  // records the pair in actor_deployments. Measured against the live db before
  // this change: the predicate below matched 0 rows for Lindsey Vaughn's two
  // deployed simulator ids and 1 row for her platform id, whose voice sample is
  // undeclared. So the gate was not merely holed for exotic ids -- it missed
  // the only declared-reference case that exists on this host, every time, and
  // the "cannot be checked here" branch then warned and synthesised anyway.
  //
  // Both halves are closed here. The id is resolved through actor_deployments
  // before the declaration is read, and an id that still cannot be tied to a
  // reference recording on this host is REFUSED rather than warned about: if
  // nothing here says whose voice it is, this host cannot know whose voice
  // comes out, which is the whole question the gate exists to ask.
  //
  // What goes to XTTS is still the bare id the caller sent, because that is
  // what the reference file over there is named -- upload_voice_to_xtts/3 on
  // the simulator uploads it under the SIMULATOR actor id.
  const refusal = voiceDeclarationRefusal(actor_id);
  if (refusal) {
    console.warn(`[tts] REFUSED actor: ${actor_id} user: ${user.id}: ${refusal.log}`);
    return res.status(403).json({ error: refusal.error, needs: refusal.needs });
  }

  try {
    const response = await fetch(XTTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, reference_audio_filename: `${actor_id}.mp3`, language: "en" }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return res.json({ fallback: true });
    const buf = await response.arrayBuffer();
    res.set("Content-Type", "audio/wav");
    res.send(Buffer.from(buf));
  } catch {
    // XTTS down or timeout — client falls back to text display
    res.json({ fallback: true });
  }
});


// ── GET /api/worlds/:world_id/runtime ────────────────────────────────────────
//
// Session 151 — vitals, active need, and what the engine last picked, for every
// actor in the world. The data the MONITOR button existed to show.
//
// Owner only, and that is the whole point rather than a precaution: a player
// lives in the world, so they get the map, the people and their own phone. Its
// interior — stress, balances, the reasoning behind a choice — belongs to
// whoever built it. requireWorld answers 404 to a stranger and 403 to a player.
app.get("/api/worlds/:world_id/runtime", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  try { res.json(await simFetch(`/internal/worlds/${req.params.world_id}/runtime`)); }
  catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/feed ───────────────────────────────────────────
//
// Session 151 — the world's event log. Every member, player and owner alike.
//
// The seal travels with the request rather than being applied to the response:
// the caller's OWN actor id is what goes to the simulator, so a private entry
// comes back only to someone party to it. An owner is not a party to a
// conversation between a character and a player, and does not become one by
// owning the world — they get the same feed anyone else would, filtered by who
// they are in it. Nothing is dropped on this side, because nothing that should
// not be read ever arrives.
app.get("/api/worlds/:world_id/feed", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const membership = db.prepare(
    `SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ? LIMIT 1`
  ).get(ok.user.id, req.params.world_id);
  const viewer = membership?.actor_id || "";
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));
  try {
    res.json(await simFetch(
      `/internal/worlds/${req.params.world_id}/feed?viewer_actor_id=${encodeURIComponent(viewer)}&limit=${limit}`
    ));
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/tick ──────────────────────────────────────────
//
// Session 151 — force every actor to re-evaluate now. Owner only: it moves the
// world for everyone in it, which is a thing you do to a world you own.
app.post("/api/worlds/:world_id/tick", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "owner");
  if (!ok) return;
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/tick`, {
      method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN },
    });
    res.status(r.status).json(await r.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/presence ───────────────────────────────────────
app.get("/api/worlds/:world_id/presence", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  try {
    const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ? LIMIT 1`).get(user.id, req.params.world_id);
    const playerActorId = membership?.actor_id || "";
    res.json(await simFetch(`/internal/worlds/${req.params.world_id}/presence?player_actor_id=${playerActorId}`));
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/spawn ─────────────────────────────────────────
app.post("/api/worlds/:world_id/spawn", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { world_id } = req.params;
  const { location_id } = req.body;
  if (!location_id) return res.status(400).json({ error: "location_id required" });
  const membership = db.prepare(
    `SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`
  ).get(user.id, world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });
  // After the membership check on purpose: answering "you need a 3D profile" to
  // someone who is not a member would confirm the world exists.
  if (!requireReadyAvatar(req, res, user)) return;
  try {
    const resp = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${world_id}/player/${membership.actor_id}/spawn`,
      {
        method:  "POST",
        headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
        body:    JSON.stringify({ location_id }),
      }
    );
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/actors/:actor_id/stream — SSE proxy ─────────────────────────────
app.get("/api/actors/:actor_id/stream", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).end();
  const { actor_id } = req.params;
  const membership = db.prepare(
    `SELECT actor_id FROM world_memberships WHERE user_id = ? AND actor_id = ?`
  ).get(user.id, actor_id);
  if (!membership) return res.status(403).end();
  try {
    const simResp = await fetch(
      `${SIMULATOR_URL}/internal/actors/${actor_id}/stream`,
      { headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    res.setHeader("Content-Type",      "text/event-stream");
    res.setHeader("Cache-Control",     "no-cache");
    res.setHeader("Connection",        "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const reader = simResp.body.getReader();
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch {}
      res.end();
    };
    pump();
    req.on("close", () => { cancelUpstreamReader(reader, "GET /api/actors/:actor_id/stream"); });
  } catch { res.status(502).end(); }
});

// ── GET /api/meeting/:session_id/stream — SSE proxy for sneak/observe mode ───
// Forwards actor_meeting:#{session_id} PubSub events to the browser.
// Auth: user must be a member of any world (session_id is opaque, no world check needed —
// the simulator only broadcasts to subscribers of that specific topic).
app.get("/api/meeting/:session_id/stream", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).end();
  const { session_id } = req.params;
  try {
    const simResp = await fetch(
      `${SIMULATOR_URL}/internal/meeting/${session_id}/stream`,
      { headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    if (!simResp.ok) return res.status(simResp.status).end();
    res.setHeader("Content-Type",      "text/event-stream");
    res.setHeader("Cache-Control",     "no-cache");
    res.setHeader("Connection",        "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const reader = simResp.body.getReader();
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch {}
      res.end();
    };
    pump();
    req.on("close", () => { cancelUpstreamReader(reader, "GET /api/meeting/:session_id/stream"); });
  } catch { res.status(502).end(); }
});

// ── POST /api/worlds/:world_id/encounter/start ───────────────────────────────
app.post("/api/worlds/:world_id/encounter/start", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { world_id } = req.params;
  const membership = db.prepare(
    `SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`
  ).get(user.id, world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });
  const { target_actor_id, location_id, trigger } = req.body;
  try {
    const resp = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/encounter/start`, {
      method:  "POST",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body:    JSON.stringify({
        trigger:         trigger || "knock",
        target_actor_id: target_actor_id,
        player_actor_id: membership.actor_id,
        location_id:     location_id
      })
    });
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/encounter/:encounter_id/end ────────────────────
app.post("/api/worlds/:world_id/encounter/:encounter_id/end", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  try {
    const resp = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/encounter/${req.params.encounter_id}/end`,
      { method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/encounter/:encounter_id ─────────────────────────
app.get("/api/worlds/:world_id/encounter/:encounter_id", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  try {
    res.json(await simFetch(
      `/internal/worlds/${req.params.world_id}/encounter/${req.params.encounter_id}`
    ));
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/encounter/:encounter_id/enter ─────────────────
app.post("/api/worlds/:world_id/encounter/:encounter_id/enter", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  try {
    const resp = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/encounter/${req.params.encounter_id}/enter`,
      { method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/encounter/:encounter_id/message ────────────────
app.post("/api/worlds/:world_id/encounter/:encounter_id/message", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { content, player_room } = req.body;
  if (!content) return res.status(400).json({ error: "content required" });
  try {
    const resp = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/encounter/${req.params.encounter_id}/message`,
      {
        method:  "POST",
        headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
        // player_room: which part of the flat he is standing in, so she can
        // answer "come over here" knowing where here is. Session 153.
        body:    JSON.stringify({ content, player_room })
      }
    );
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/encounter/:encounter_id/typing ─────────────────
// ── Test Lab ── lives in testlab-routes.js so whole-file writes here cannot drop
// the /api/test/* proxies again (two stale-copy clobbers on 2026-08-29).
mountTestLabRoutes(app, { SERVICE_TOKEN, SIMULATOR_URL, authUser });
mountSignupLabRoutes(app, { db, authUser, PORT });
mountAvatarLabRoutes(app, { db, authUser, SERVICE_TOKEN, SIMULATOR_URL });
mountSignInLabRoutes(app, { db, authUser, PORT });
mountWizardLabRoutes(app, { db, authUser, PORT, recordActorDeletion });
mountShareLabRoutes(app, { db, authUser, PORT });
mountDeployLabRoutes(app, { db, authUser, PORT });
mountWorldWizardLabRoutes(app, { db, authUser, SERVICE_TOKEN, SIMULATOR_URL });
mountRoutineLabRoutes(app, { authUser });
// Session 157 — interaction scripts: the studio saves them here and an
// encounter reads them back by slug. Creates its own table at mount.
mountInteractionRoutes(app, { db, authUser });

// Session 158 - cross-org character sharing by link. Its own file for the same
// reason the lab routes are: a whole-file write to this 340KB index.js cannot
// drop what is not in it.
// unauthorisedSubjectInLineage is injected (2026-09-11, conduct-watch) so the link
// and publish gates share ONE definition of the subject-authorisation predicate with
// fork/deploy/shares and the build gates, instead of a local copy that drifted.
mountShareLinkRoutes(app, { db, authUser, unauthorisedSubjectInLineage });

app.post("/api/worlds/:world_id/encounter/:encounter_id/typing", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  try {
    fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/encounter/${req.params.encounter_id}/typing`,
      { method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN } }
    ).catch(() => {});
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// ── POST /api/worlds/:world_id/encounter/:encounter_id/resume ─────────────────
// Session 154 — the 3D door scene declines the missing-media pause. That pause
// exists for the video views (freeze, offer generation, resume on media_ready);
// the door scene renders her as a GLB and uses no clips, so a pause there just
// switches her silence initiative off forever — she answers but never speaks
// first again. The scene resumes immediately when the server announces
// missing media.
app.post("/api/worlds/:world_id/encounter/:encounter_id/resume", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  try {
    const r = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/encounter/${req.params.encounter_id}/resume`,
      { method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── Media-repair proxies: browser → platform → simulator ─────────────────────
//
// Session 2026-09-05 (conduct-watch: "the browser calls the simulator internal
// API directly over the public ngrok tunnel"). PresenceView's missing-media
// modal used to call the simulator's /internal/* API straight from the browser,
// against https://anima.simulator.ngrok.dev, carrying a shared service token in
// the bundle. That broke two standing rules at once: personal media (reference
// frames, actor video) must never transit the public tunnel, and the internal
// API is never exposed to browser clients — the platform proxies all calls.
//
// These routes are that proxy. Each one authenticates the caller through the
// same authUser()/requireWorld() chokepoint the rest of /api uses, then
// forwards server-side over the LAN (SIMULATOR_URL is 192.168.1.58:4000) with
// the service token, which never leaves this host.

// A caller may touch an actor only through a world they belong to: the actor
// must be deployed into that world, be their own player character there, or be
// one they already hold direct access to. World membership is checked first by
// requireWorld(), so this is the second half of the pair, never the whole gate.
function actorInWorld(actorId, worldId, user) {
  if (!actorId || !worldId) return false;
  const dep = db.prepare(
    `SELECT 1 FROM actor_deployments WHERE world_id = ? AND (simulator_actor_id = ? OR platform_actor_id = ?)`
  ).get(String(worldId), String(actorId), String(actorId));
  if (dep) return true;
  const mem = db.prepare(
    `SELECT 1 FROM world_memberships WHERE world_id = ? AND actor_id = ?`
  ).get(String(worldId), String(actorId));
  if (mem) return true;
  return !!hasAccess(actorId, user, "read");
}

async function simMediaProxy(res, simPath, { method = "GET", body = null, headers = {} } = {}) {
  try {
    const r = await fetch(`${SIMULATOR_URL}${simPath}`, {
      method,
      headers: { "X-Service-Token": SERVICE_TOKEN, ...headers },
      body,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch { data = { error: text.slice(0, 500) || `simulator returned ${r.status}` }; }
    return res.status(r.status).json(data);
  } catch { return res.status(502).json({ error: "simulator unreachable" }); }
}

function simQuery(req, extra = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...req.query, ...extra })) {
    if (v !== undefined && v !== null) q.append(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

// ── GET /api/worlds/:world_id/encounter/:encounter_id/media ──────────────────
app.get("/api/worlds/:world_id/encounter/:encounter_id/media", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  return simMediaProxy(res, `/internal/worlds/${encodeURIComponent(req.params.world_id)}/encounter/${encodeURIComponent(req.params.encounter_id)}/media`);
});

// ── POST /api/worlds/:world_id/encounter/:encounter_id/rescan_media ──────────
app.post("/api/worlds/:world_id/encounter/:encounter_id/rescan_media", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  return simMediaProxy(res, `/internal/worlds/${encodeURIComponent(req.params.world_id)}/encounter/${encodeURIComponent(req.params.encounter_id)}/rescan_media`, { method: "POST" });
});

// ── POST /api/worlds/:world_id/encounter/:encounter_id/generate_media ────────
app.post("/api/worlds/:world_id/encounter/:encounter_id/generate_media", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const body = req.body || {};
  if (!actorInWorld(body.actor_id, req.params.world_id, ok.user)) {
    return res.status(403).json({ error: "no access to that actor in this world" });
  }
  return simMediaProxy(res, `/internal/worlds/${encodeURIComponent(req.params.world_id)}/encounter/${encodeURIComponent(req.params.encounter_id)}/generate_media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
});

// ── GET /api/actors/:actor_id/generate_prompt?world_id=… ─────────────────────
app.get("/api/actors/:actor_id/generate_prompt", async (req, res) => {
  const worldId = req.query.world_id;
  const ok = requireWorld(req, res, worldId, "player");
  if (!ok) return;
  if (!actorInWorld(req.params.actor_id, worldId, ok.user)) {
    return res.status(403).json({ error: "no access to that actor in this world" });
  }
  return simMediaProxy(res, `/internal/actors/${encodeURIComponent(req.params.actor_id)}/generate_prompt${simQuery(req)}`);
});

// ── GET /api/actors/:actor_id/suggest_frames?world_id=… ──────────────────────
// The simulator answers with the frames inline as data: URLs, so nothing here
// hands the browser a simulator address to go and fetch.
app.get("/api/actors/:actor_id/suggest_frames", async (req, res) => {
  const worldId = req.query.world_id;
  const ok = requireWorld(req, res, worldId, "player");
  if (!ok) return;
  if (!actorInWorld(req.params.actor_id, worldId, ok.user)) {
    return res.status(403).json({ error: "no access to that actor in this world" });
  }
  return simMediaProxy(res, `/internal/actors/${encodeURIComponent(req.params.actor_id)}/suggest_frames${simQuery(req)}`);
});

// ── POST /api/actors/:actor_id/upload_frame?world_id=… (multipart) ───────────
app.post("/api/actors/:actor_id/upload_frame", upload.single("file"), async (req, res) => {
  const worldId = req.query.world_id || (req.body && req.body.world_id);
  const ok = requireWorld(req, res, worldId, "player");
  if (!ok) return;
  if (!actorInWorld(req.params.actor_id, worldId, ok.user)) {
    return res.status(403).json({ error: "no access to that actor in this world" });
  }
  if (!req.file) return res.status(400).json({ error: "no file" });
  try {
    const form = new FormData();
    form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype || "image/jpeg" }), req.file.originalname || "frame.jpg");
    const r = await fetch(`${SIMULATOR_URL}/internal/actors/${encodeURIComponent(req.params.actor_id)}/upload_frame`, {
      method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN }, body: form,
    });
    const data = await r.json().catch(() => ({}));
    // The simulator answers with its own absolute /internal/frames/<name> URL.
    // The browser must never fetch that address: repoint it at this host's
    // authorised frame proxy below, so the image comes over the LAN.
    if (data && typeof data.url === "string") {
      data.url = `/api/actors/${encodeURIComponent(req.params.actor_id)}/frame/${encodeURIComponent(path.basename(data.url))}?world_id=${encodeURIComponent(worldId)}`;
    }
    return res.status(r.status).json(data);
  } catch { return res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/actors/:actor_id/frame/:filename?world_id=… ─────────────────────
// Reference frames are personal media. They are fetched LAN-side and streamed
// back through this authenticated route; the tunnel only ever carries them
// between this host and the person who is already entitled to see them.
app.get("/api/actors/:actor_id/frame/:filename", async (req, res) => {
  const worldId = req.query.world_id;
  const ok = requireWorld(req, res, worldId, "player");
  if (!ok) return;
  if (!actorInWorld(req.params.actor_id, worldId, ok.user)) {
    return res.status(403).json({ error: "no access to that actor in this world" });
  }
  const name = path.basename(String(req.params.filename));
  if (!/^[\w.-]+\.jpg$/.test(name)) return res.status(400).json({ error: "bad frame name" });
  try {
    const r = await fetch(`${SIMULATOR_URL}/internal/frames/${encodeURIComponent(name)}`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
    });
    if (!r.ok) return res.status(r.status).json({ error: `simulator returned ${r.status}` });
    res.set("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "private, no-store");
    return res.send(Buffer.from(await r.arrayBuffer()));
  } catch { return res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/actors/:actor_id/upload_video (multipart) ─────
app.post("/api/worlds/:world_id/actors/:actor_id/upload_video", upload.single("file"), async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  if (!actorInWorld(req.params.actor_id, req.params.world_id, ok.user)) {
    return res.status(403).json({ error: "no access to that actor in this world" });
  }
  if (!req.file) return res.status(400).json({ error: "no file" });
  try {
    const form = new FormData();
    form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype || "video/mp4" }), req.file.originalname || "upload.mp4");
    form.append("world_id", String(req.params.world_id));
    if (req.body && req.body.filename) form.append("filename", String(req.body.filename));
    const r = await fetch(`${SIMULATOR_URL}/internal/worlds/${encodeURIComponent(req.params.world_id)}/actors/${encodeURIComponent(req.params.actor_id)}/upload_video`, {
      method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN }, body: form,
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch { return res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/leave — clear player location ─────────────────
app.post("/api/worlds/:world_id/leave", async (req, res) => {
  const ok = requireWorld(req, res, worldIdOf(req), "player");
  if (!ok) return;
  const user = ok.user;
  const { world_id } = req.params;
  const membership = db.prepare(
    `SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`
  ).get(user.id, world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });
  try {
    const resp = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${world_id}/player/${membership.actor_id}/leave`,
      { method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/encounter/model-status — which LLM is active ────────────────────
app.get("/api/encounter/model-status", async (_req, res) => {
  try {
    const r = await fetch("http://212.147.242.70:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      const has70b = d?.models?.some(m => m.name?.includes("hermes3:70b"));
      return res.json({ model: has70b ? "Hermes-3-70B" : "Haiku" });
    }
  } catch {}
  res.json({ model: "Haiku" });
});

// ── GET /api/places/:place_id/photos — venue photos list ─────────────────────
app.get("/api/places/:place_id/photos", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const { place_id } = req.params;
  if (!/^[a-zA-Z0-9_\-]+$/.test(place_id)) return res.status(400).end();
  try {
    res.json(await simFetch(`/internal/places/${place_id}/photos`));
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/places/:place_id/photo — venue photo proxy ──────────────────────
app.get("/api/places/:place_id/photo", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).end();
  const { place_id } = req.params;
  if (!/^[a-zA-Z0-9_\-]+$/.test(place_id)) return res.status(400).end();
  try {
    const simResp = await fetch(
      `${SIMULATOR_URL}/internal/places/${place_id}/photo`,
      { headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    if (!simResp.ok) return res.status(simResp.status).end();
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buf = await simResp.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch { res.status(502).end(); }
});

// ── Serve React SPA ───────────────────────────────────────────────────────────
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const fs = _require("fs");


// ── POST /api/generate/profile — AI-generate character data via Haiku ─────────
app.post("/api/generate/profile", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  const key = process.env.CLAUDE_API_KEY;
  if (!key) return res.status(500).json({ error: "no API key" });
  try {
    // Session 103 — this route's comment always said "via Haiku" but
    // the body called dirty-muse on the user's LOCAL machine (.60):
    // full-profile generation silently depended on a workstation
    // being awake, and failed when it wasn't (found live: Generation
    // failed, log ending at the .60 post with no reply). Structured
    // JSON is Haiku's job in the capability routing; the platform
    // must be able to birth characters on its own.
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4000,
        system: "You are a character design assistant. Return ONLY raw JSON. No markdown, no code fences, no backticks, no explanation. Start your response with { and end with }.",
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) { const body = await r.text().catch(() => ""); throw new Error(`anthropic ${r.status}: ${body.slice(0, 200)}`); }
    const data = await r.json();
    const text = (data.content || []).map(c => c.text || "").join("");
    if (!text) throw new Error("anthropic returned empty content");
    res.json({ text });
  } catch(e) { console.error("[generate/profile] FAILED:", e.message); res.status(500).json({ error: e.message }); }
});

// ── POST /api/generate/appearance — describe character from photos via Haiku ──
app.post("/api/generate/appearance", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { images, name, gender, age, heightCm } = req.body;
  if (!images?.length) return res.status(400).json({ error: "no images" });
  const key = process.env.CLAUDE_API_KEY;
  if (!key) return res.status(500).json({ error: "no API key" });
  try {
    const content = [
      ...images.map(b64 => ({ type: "image", source: { type: "base64", media_type: b64.startsWith("/9j/") ? "image/jpeg" : "image/png", data: b64 } })),
      { type: "text", text: "placeholder" }
    ];
    const isFemale = (gender||"").toLowerCase() === "female";
    const isMale   = (gender||"").toLowerCase() === "male";
    const genderSpecific = isFemale
      ? `,"bust":"small|average|full|large","figure":"straight|slightly curved|curved|very curved","waist_hip_ratio":"low|average|high","legs":"short|average|long|athletic"`
      : isMale
      ? `,"physique":"slim|average|toned|muscular|heavy","shoulders":"narrow|average|broad|very broad","height_dominance":"average|tall|very tall"`
      : "";
    const lastMsg = `You are a creative writing assistant for a fiction platform. A creator has uploaded a visual reference image to inspire the look of a fictional character they are designing — do not attempt to identify who is in the image. Use it only as a style and aesthetic reference.

Fictional character details: Name: ${name||"character"}, Age: ${age||"unknown"}, Gender: ${gender||"unknown"}${heightCm ? `, Height: ${heightCm}cm (this is the character's real height - the "height" you return must agree with it, not with your impression of the photo)` : ""}.

Based on the visual reference, describe the fictional character's appearance. Return ONLY valid JSON with short descriptive values:
{"gender":"${gender||"unknown"}","height":"tall|above average|average|petite|short","build":"slim|lean|athletic|curvy|full-figured|stocky|muscular","body_shape":"hourglass|pear|apple|rectangle|inverted triangle","hair":"[colour, length, texture, style]","eyes":"[colour and notable quality]","face":"[shape, skin tone, jaw, cheekbones, notable features]","style":"[inferred clothing style]","notable":"[any distinctive features or none]","presence":"commanding|warm|understated|magnetic|reserved","body_confidence":"high|moderate|low","grooming":"meticulous|natural|minimal|casual","tension_markers":"none|[visible physical tension signals]"${genderSpecific}}`;
    const contentWithText = [...content.slice(0,-1), { type: "text", text: lastMsg }];
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 512, messages: [{ role: "user", content: contentWithText }] }),
    });
    const d = await r.json();
    console.log("[generate/appearance] Anthropic response:", JSON.stringify(d).slice(0,300));
    const raw = d.content?.[0]?.text?.trim() || "{}";
    console.log("[generate/appearance] raw:", raw.slice(0,300));
    try {
      // Strip markdown fences and find JSON object
      const cleaned = raw.replace(/```json|```/gi,"").trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      const fields = JSON.parse(match ? match[0] : cleaned);
      res.json({ fields });
    } catch(parseErr) {
      console.error("[generate/appearance] parse error:", parseErr.message, "raw:", raw.slice(0,200));
      res.json({ fields: {} });
    }
  } catch(e) { console.error("[generate/appearance]", e); res.status(500).json({ error: e.message }); }
});

// ── POST /api/actors — create canonical actor, or finalize an existing draft ──
// Pass { id } in the body to finalize a draft created earlier by the 3D
// creation step (updates in place, sets status to "active") instead of
// inserting a new row. Pass { draft: true } with no id to create a new
// draft (status "draft") rather than an immediately-active actor.
app.post("/api/actors", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { id: existingId, identity, psychology, personality, lifestyle, economy, draft, default_home_template_url, appearance_fields } = req.body;
  if (!identity?.first_name) return res.status(400).json({ error: "first_name required" });

  // Bound here because this endpoint writes age in BOTH branches below — the
  // finalize UPDATE and the create INSERT. See ageFloorError's own comment.
  {
    const bad = ageFloorError(identity.age);
    if (bad) return res.status(400).json({ error: bad, field: "age", received: identity.age });
  }
  const now  = new Date().toISOString();
  const name = [identity.first_name?.trim(), identity.last_name?.trim()].filter(Boolean).join(" ");
  // Session 160 — the structured appearance map, stored as JSON beside the
  // prose in actors.appearance. The character wizard's Appearance step and the
  // profile editor's Appearance panel both author it (src/lib/appearance.js),
  // and the wizard composes the prose from it before posting, so the two
  // columns arrive together and agree. Either encoding is accepted.
  const appearanceFieldsJson =
    appearance_fields == null            ? null :
    typeof appearance_fields === "string" ? appearance_fields :
    JSON.stringify(appearance_fields);

  if (existingId) {
    // ── Finalize an existing draft: verify ownership, then UPDATE in place ──
    const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(existingId, user.id);
    if (!actor) return res.status(404).json({ error: "not found" });
    const id = existingId;
    const run = db.transaction(() => {
      // appearance_fields is COALESCEd, not assigned: a caller that does not
      // speak this field must not blank a map the profile editor authored.
      // NULL there is meaningful — the editor reads NULL-with-prose as a
      // hand-written description and starts that character in manual mode.
      db.prepare(`UPDATE actors SET name=?, first_name=?, last_name=?, age=?, gender=?, nationality=?, occupation=?, appearance=?, appearance_fields=COALESCE(?, appearance_fields), default_home_template_url=?, status=?, updated_at=? WHERE id=?`)
        .run(name, identity.first_name?.trim(), identity.last_name?.trim()||null, identity.age||null, identity.gender||"female", identity.nationality||null, identity.occupation||null, identity.appearance||null, appearanceFieldsJson, default_home_template_url||null, "ready_to_deploy", now, id);
      // Session 103 — honest lifecycle (user law): draft -> ready_to_deploy
      // (Save) -> active (deploy). "active" used to mean only "left the
      // wizard", overloading it with "lives in a world"; the gallery
      // must never offer half-built drafts for deployment, and active
      // must mean deployed.
      const p = psychology||{};
      // Session 150 — self_view, others_view, family_model,
      // relationship_read_pattern and identity_certainty added.
      //
      // The character wizard has collected all five for a long time: they are in
      // its psychology state, rendered as fields on the Psychology step, and
      // named in the prompt that asks the model to write them. They were simply
      // absent from this statement and the INSERT below, so everything typed or
      // generated into them was posted to the server and dropped on the floor.
      // Every character therefore had four permanently blank psychology fields
      // and nothing anywhere said why.
      db.prepare(`UPDATE actor_psychology SET attachment_style=?, wound=?, what_they_want=?, blindspot=?, defenses=?, contradiction=?, backstory=?, orientation=?, view_on_sex=?, marital_status=?, coping_mechanisms=?, self_view=?, others_view=?, family_model=?, relationship_read_pattern=?, identity_certainty=?, updated_at=? WHERE actor_id=?`)
        .run(personality?.attachment_style||p.attachment_style||"secure", p.wound||null, p.what_they_want||null, p.blindspot||null, p.defenses||null, p.contradiction||null, p.backstory||null, identity.orientation||"straight", p.view_on_sex||null, p.marital_status||"single", p.coping_mechanisms||null, p.self_view||null, p.others_view||null, p.family_model||null, p.relationship_read_pattern||null, p.identity_certainty ?? null, now, id);
      const b = personality?.big5||{};
      db.prepare(`UPDATE actor_big5 SET openness=?, conscientiousness=?, extraversion=?, agreeableness=?, neuroticism=?, updated_at=? WHERE actor_id=?`)
        .run(b.openness||50, b.conscientiousness||50, b.extraversion||50, b.agreeableness||50, b.neuroticism||50, now, id);
      const disc = personality?.disc||{};
      db.prepare(`UPDATE actor_disc SET d=?, i=?, s=?, c=?, updated_at=? WHERE actor_id=?`)
        .run(disc.d||50, disc.i||50, disc.s||50, disc.c||50, now, id);
      const h = personality?.hds||{};
      db.prepare(`UPDATE actor_hds SET bold=?, cautious=?, colorful=?, diligent=?, dutiful=?, excitable=?, imaginative=?, leisurely=?, mischievous=?, reserved=?, skeptical=?, updated_at=? WHERE actor_id=?`)
        .run(h.bold||30, h.cautious||30, h.colorful||30, h.diligent||30, h.dutiful||30, h.excitable||30, h.imaginative||30, h.leisurely||30, h.mischievous||30, h.reserved||30, h.skeptical||30, now, id);
      const l = lifestyle||{};
      db.prepare(`UPDATE actor_lifestyle SET alcohol_relationship=?, drug_use=?, substance_context=?, sleep_pattern=?, sleep_quality=?, exercise_habit=?, exercise_type=?, social_frequency=?, diet=?, lifestyle_note=?, updated_at=? WHERE actor_id=?`)
        .run(l.alcohol_relationship||null, l.drug_use||"none", l.substance_context||null, l.sleep_pattern||"normal", l.sleep_quality||"good", l.exercise_habit||null, l.exercise_type||null, l.social_frequency||null, l.diet||null, l.lifestyle_note||null, now, id);
      const e = economy||{};
      // Session 150 — monthly_income is no longer written from this side.
      // The amount is world data, derived at deploy from the actor's revenue
      // sources and owned by the simulator. Set to NULL here so an actor
      // carrying a pre-Session-103 value sheds it on their next save.
      db.prepare(`UPDATE actor_economic SET financial_situation=?, income_stability=?, monthly_income=NULL, spending_style=?, savings_habit=?, attitude_to_wealth=?, financial_anxiety=?, behavior_note=?, updated_at=? WHERE actor_id=?`)
        .run(e.financial_situation||"stable", e.income_stability||"stable", e.spending_style||"balanced", e.savings_habit||"moderate", e.attitude_to_wealth||"practical", e.financial_anxiety||0.3, e.behavior_note||null, now, id);
    });
    run();
    // Session 148 — "the Save-to-registry button doesn't delete the tmp
    // files" (Magnus): finalize now runs the same Mac Mini scratch
    // cleanup as abandon-draft and hard-delete. Safe since tonight's
    // pack_all fix — the retained master is self-contained, so the
    // generation scratch has no recovery role left. Not awaited, same
    // as the other call sites.
    deleteActorTmpFolder(id);
    return res.json({ id, name, status: "ready_to_deploy" });
  }

  // ── Create a new actor (draft or immediately-active) ─────────────────────
  const id = randomUUID();
  const mediaFolder = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") + "-" + id.slice(0,8);
  const run = db.transaction(() => {
    db.prepare(`INSERT INTO actors (id, owner_id, name, first_name, last_name, age, gender, nationality, occupation, appearance, appearance_fields, default_home_template_url, media_folder, status, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, user.id, name, identity.first_name?.trim(), identity.last_name?.trim()||null, identity.age||null, identity.gender||"female", identity.nationality||null, identity.occupation||null, identity.appearance||null, appearanceFieldsJson, default_home_template_url||null, mediaFolder, draft ? "draft" : "ready_to_deploy", now, now);
    const p = psychology||{};
    // Same five columns as the UPDATE above — see the note there.
    db.prepare(`INSERT INTO actor_psychology (actor_id, attachment_style, wound, what_they_want, blindspot, defenses, contradiction, backstory, orientation, view_on_sex, marital_status, coping_mechanisms, self_view, others_view, family_model, relationship_read_pattern, identity_certainty, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, personality?.attachment_style||p.attachment_style||"secure", p.wound||null, p.what_they_want||null, p.blindspot||null, p.defenses||null, p.contradiction||null, p.backstory||null, identity.orientation||"straight", p.view_on_sex||null, p.marital_status||"single", p.coping_mechanisms||null, p.self_view||null, p.others_view||null, p.family_model||null, p.relationship_read_pattern||null, p.identity_certainty ?? null, now, now);
    const b = personality?.big5||{};
    db.prepare(`INSERT INTO actor_big5 (actor_id, openness, conscientiousness, extraversion, agreeableness, neuroticism, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, b.openness||50, b.conscientiousness||50, b.extraversion||50, b.agreeableness||50, b.neuroticism||50, now, now);
    const disc = personality?.disc||{};
    db.prepare(`INSERT INTO actor_disc (actor_id, d, i, s, c, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, disc.d||50, disc.i||50, disc.s||50, disc.c||50, now, now);
    const h = personality?.hds||{};
    db.prepare(`INSERT INTO actor_hds (actor_id, bold, cautious, colorful, diligent, dutiful, excitable, imaginative, leisurely, mischievous, reserved, skeptical, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, h.bold||30, h.cautious||30, h.colorful||30, h.diligent||30, h.dutiful||30, h.excitable||30, h.imaginative||30, h.leisurely||30, h.mischievous||30, h.reserved||30, h.skeptical||30, now, now);
    const l = lifestyle||{};
    db.prepare(`INSERT INTO actor_lifestyle (actor_id, alcohol_relationship, drug_use, substance_context, sleep_pattern, sleep_quality, exercise_habit, exercise_type, social_frequency, diet, lifestyle_note, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, l.alcohol_relationship||null, l.drug_use||"none", l.substance_context||null, l.sleep_pattern||"normal", l.sleep_quality||"good", l.exercise_habit||null, l.exercise_type||null, l.social_frequency||null, l.diet||null, l.lifestyle_note||null, now, now);
    const e = economy||{};
    db.prepare(`INSERT INTO actor_economic (actor_id, financial_situation, income_stability, spending_style, savings_habit, attitude_to_wealth, financial_anxiety, behavior_note, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, e.financial_situation||"stable", e.income_stability||"stable", e.spending_style||"balanced", e.savings_habit||"moderate", e.attitude_to_wealth||"practical", e.financial_anxiety||0.3, e.behavior_note||null, now, now);
  });
  run();
  // Session 148 — same finalize-time scratch cleanup as the UPDATE
  // branch above; gated on !draft so a mid-wizard draft save never
  // wipes the scratch the generation pipeline still works in.
  if (!draft) deleteActorTmpFolder(id);
  res.json({ id, name: identity.name, status: draft ? "draft" : "created" });
});


// ── GET /api/assessment-questions/:type — fetch question bank ─────────────────
app.get("/api/assessment-questions/:type", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const questions = db.prepare(`
    SELECT id, assessment_type, scale, item_order, item_text, response_type
    FROM assessment_questions
    WHERE assessment_type = ? AND active = 1
    ORDER BY scale, item_order
  `).all(req.params.type);
  res.json(questions);
});

// ── POST /api/actors/:id/assessments — save assessment result ─────────────────
app.post("/api/actors/:id/assessments", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const { assessment_type, answers, scores, interpretation, notes } = req.body;
  if (!assessment_type) return res.status(400).json({ error: "assessment_type required" });
  const now = new Date().toISOString();
  const id  = randomUUID();
  // Delete previous result for this actor+type
  db.prepare(`DELETE FROM actor_assessment_results WHERE actor_id = ? AND assessment_type = ?`).run(req.params.id, assessment_type);
  db.prepare(`INSERT INTO actor_assessment_results (id, actor_id, assessment_type, answers, scores, interpretation, notes, run_at, inserted_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, req.params.id, assessment_type, JSON.stringify(answers||[]), JSON.stringify(scores||{}), interpretation||"", JSON.stringify(notes||{}), now, now);
  res.json({ id });
});

// ── GET /api/actors/:id/assessments — get all assessment results ──────────────
app.get("/api/actors/:id/assessments", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const results = db.prepare(`SELECT * FROM actor_assessment_results WHERE actor_id = ? ORDER BY run_at DESC`).all(req.params.id);
  res.json(results.map(r => ({
    ...r,
    answers: JSON.parse(r.answers||"[]"),
    scores: JSON.parse(r.scores||"{}"),
    notes: JSON.parse(r.notes||"{}"),
  })));
});


// Session 171 (conduct-watch, resolution-manager) — the build gates inside
// generate3d.js get the SAME lineage-aware subject-authorisation predicate the
// fork / shares / deploy gates above use. Injected rather than duplicated: a
// fork copies no actor_media, so an own-actor predicate reads an empty set on
// the copy and passes, which is exactly the gap this closes.
registerGenerate3DRoutes(app, { db, __dirname, authUser, unauthorisedSubjectInLineage });

// ── /media/* — pipe directly to simulator over LAN ──────────────────────────
import http from "http";
app.use("/media", (req, res) => {
  const options = {
    hostname: "192.168.1.58",
    port: 4000,
    path: `/media${req.path}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`,
    method: req.method,
    headers: { ...req.headers, host: "192.168.1.58:4000" }
  };
  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxy.on("error", () => res.status(502).end());
  req.pipe(proxy);
});

const distPath = path.join(__dirname, "../dist");
if (fs.existsSync(distPath)) {
  // Session 152 — index.html must never be cached; hashed assets may be
  // cached forever. Without explicit headers, express.static serves
  // index.html with an ETag and no Cache-Control, and somewhere between the
  // browser's heuristic cache and the ngrok edge, stale copies survived even
  // hard reloads: twice in one evening a freshly built fix was judged "still
  // broken" while the page was quietly running the previous bundle. The
  // filename hash makes assets self-invalidating; the entry document is the
  // one file whose freshness actually matters.
  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/assets/")) { return res.status(404).end(); }
    // Session 150 — an unmatched /api or /media GET used to fall through this
    // branch WITHOUT responding, so the request never completed: the browser sat
    // on an open connection until it timed out, and any fetch() awaiting it
    // never settled. A panel calling an endpoint that did not exist showed
    // "Loading…" forever rather than an error — which is exactly how the missing
    // GET .../home presented.
    if (req.path.startsWith("/api") || req.path.startsWith("/media")) {
      return res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
    }
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(distPath, "index.html"));
  });
}

