// ── e2e: the structured appearance survives POST /api/actors (Session 160) ────
//
// Run on the platform host:  node server/appearance.e2e.mjs
//
// The Appearance step of the character wizard now authors actors.appearance
// (the prose the simulator reads) and actors.appearance_fields (the structured
// map both it and the profile editor round-trip through). Neither reached the
// database before this session — the wizard never wrote the fields at all, and
// POST /api/actors did not carry the column. This asserts that it does now,
// through the real HTTP route rather than by reading the source.
//
// Same harness as sharelinks.e2e.mjs / gallery.e2e.mjs: mints an auth_tokens
// row directly (the cookie regex is /anima_token=([a-f0-9]+)/, so the token
// must be hex). It creates its OWN actor and deletes it in the finally block,
// so unlike the gallery suite it never touches anybody's real character.

import Database from "better-sqlite3";
import crypto from "crypto";
import os from "os";
import path from "path";
// The composer under test on the server side is the one the wizard ships, so
// it is the real module — if the two ever disagree, the prose column and the
// fields column stop describing each other.
import { composeAppearance } from "../src/lib/appearance.js";

const BASE = "http://127.0.0.1:4002";
const db = new Database(path.join(os.homedir(), "platform_dev.db"));
const now = () => new Date().toISOString();
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; results.push(`  ok   ${name}`); }
  else { fail++; results.push(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const OWNER = "mk";
const TOKEN_ID = "t160-mk";
let rawToken = null;
const createdActors = [];

async function api(method, url, body) {
  const headers = { cookie: `anima_token=${rawToken}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: json };
}

const row = id => db.prepare(`SELECT appearance, appearance_fields, status FROM actors WHERE id = ?`).get(id);

function cleanup() {
  db.transaction(() => {
    for (const id of createdActors) {
      for (const t of ["actor_psychology","actor_big5","actor_disc","actor_hds","actor_lifestyle","actor_economic"]) {
        db.prepare(`DELETE FROM ${t} WHERE actor_id = ?`).run(id);
      }
      db.prepare(`DELETE FROM actors WHERE id = ?`).run(id);
    }
    db.prepare(`DELETE FROM auth_tokens WHERE id = ?`).run(TOKEN_ID);
  })();
}

const FIELDS = {
  height:"above average", build:"athletic", body_shape:"hourglass",
  bust:"full", figure:"curved", waist_hip_ratio:"high", legs:"long",
  hair:"dark brown, shoulder-length, wavy", eyes:"green, sharp",
  face:"oval, olive skin, strong jaw", notable:"scar over the left eyebrow",
  style:"tailored casual", grooming:"meticulous",
  presence:"warm", body_confidence:"high", tension_markers:"none",
};

async function main() {
  rawToken = crypto.randomBytes(24).toString("hex");
  db.prepare(`INSERT INTO auth_tokens (id, user_id, token_hash, expires_at, inserted_at)
              VALUES (?,?,?,datetime('now','+1 day'),?)`)
    .run(TOKEN_ID, OWNER, sha(rawToken), now());

  // Positive control FIRST. Everything below reads a column through this route;
  // if the harness cannot even authenticate, every later assertion would read
  // as a clean pass against nothing.
  const auth = await api("GET", "/api/actors");
  check("harness is authenticated (control)", auth.status === 200, `got ${auth.status}`);
  if (auth.status !== 200) return;

  const prose = composeAppearance(FIELDS, "female");
  check("the composer produced prose to store (control)", prose.length > 60, `len ${prose.length}`);

  const identity = {
    first_name:"E2E", last_name:"Appearance160", age:31, gender:"female",
    occupation:"tester", orientation:"straight", appearance: prose,
  };

  // ── 1. create ──────────────────────────────────────────────────────────────
  const created = await api("POST", "/api/actors", {
    identity, psychology:{}, personality:{}, lifestyle:{}, economy:{},
    draft:true, appearance_fields: JSON.stringify(FIELDS),
  });
  check("create accepted", created.status === 200 && !!created.body?.id, JSON.stringify(created.body));
  if (!created.body?.id) return;
  const id = created.body.id;
  createdActors.push(id);

  let r = row(id);
  check("INSERT stored appearance_fields", r.appearance_fields === JSON.stringify(FIELDS),
    `got ${String(r.appearance_fields).slice(0,60)}`);
  check("INSERT stored the prose beside it", r.appearance === prose);
  // Guarded: when the column above came back NULL this must report a failure,
  // not throw and take the other twelve assertions down with it.
  const storedFields = (() => { try { return JSON.parse(r.appearance_fields) || null; } catch { return null; } })();
  check("the two columns describe each other",
    !!storedFields && composeAppearance(storedFields, "female") === r.appearance);

  // ── 2. finalize the draft — the UPDATE branch ─────────────────────────────
  const changed = { ...FIELDS, hair:"cropped platinum", voice:"low and unhurried" };
  const changedProse = composeAppearance(changed, "female");
  const finalized = await api("POST", "/api/actors", {
    id, identity:{ ...identity, appearance: changedProse },
    psychology:{}, personality:{}, lifestyle:{}, economy:{},
    draft:false, appearance_fields: JSON.stringify(changed),
  });
  check("finalize accepted", finalized.status === 200, JSON.stringify(finalized.body));
  r = row(id);
  check("UPDATE stored the new appearance_fields", r.appearance_fields === JSON.stringify(changed));
  check("UPDATE stored the new prose", r.appearance === changedProse);
  check("the manual-only voice field survived the round trip",
    (() => { try { return JSON.parse(r.appearance_fields).voice === "low and unhurried"; } catch { return false; } })());
  check("finalize still flips the lifecycle", r.status === "ready_to_deploy", `status ${r.status}`);

  // ── 3. a caller that does not speak the field must not blank it ───────────
  //
  // The real reason this is COALESCE and not a plain assignment: AvatarLabPage
  // and this wizard's own Generate Face POST both omit appearance_fields, and
  // a map the profile editor authored must survive them.
  const silent = await api("POST", "/api/actors", {
    id, identity:{ ...identity, appearance: changedProse },
    psychology:{}, personality:{}, lifestyle:{}, economy:{}, draft:false,
  });
  check("a POST omitting appearance_fields is accepted", silent.status === 200);
  r = row(id);
  check("omitting appearance_fields PRESERVES the stored map (COALESCE)",
    r.appearance_fields === JSON.stringify(changed),
    `got ${String(r.appearance_fields).slice(0,60)}`);

  // ── 4. the object encoding is accepted too ────────────────────────────────
  const asObject = { ...FIELDS, notable:"none" };
  await api("POST", "/api/actors", {
    id, identity:{ ...identity, appearance: composeAppearance(asObject,"female") },
    psychology:{}, personality:{}, lifestyle:{}, economy:{}, draft:false,
    appearance_fields: asObject,
  });
  r = row(id);
  let parsed = null;
  try { parsed = JSON.parse(r.appearance_fields); } catch { /* stays null */ }
  check("an object appearance_fields is stored as parseable JSON", parsed?.notable === "none",
    `got ${String(r.appearance_fields).slice(0,60)}`);

  // ── 5. the editor's manual-mode flag is not something the route mangles ───
  const manual = { ...FIELDS, _auto:false };
  await api("POST", "/api/actors", {
    id, identity:{ ...identity, appearance:"Hand-written, and it must stay hand-written." },
    psychology:{}, personality:{}, lifestyle:{}, economy:{}, draft:false,
    appearance_fields: JSON.stringify(manual),
  });
  r = row(id);
  check("_auto:false round-trips so the editor keeps manual mode",
    (() => { try { return JSON.parse(r.appearance_fields)._auto === false; } catch { return false; } })());
  check("a hand-written description is stored verbatim",
    r.appearance === "Hand-written, and it must stay hand-written.");

  // ── 6. GET /api/actors/:id exposes the column the wizard reloads from ─────
  const fetched = await api("GET", `/api/actors/${id}`);
  check("GET /api/actors/:id returns appearance_fields (the wizard's draft reload reads it)",
    fetched.body?.actor?.appearance_fields === JSON.stringify(manual),
    `got ${String(fetched.body?.actor?.appearance_fields).slice(0,60)}`);
}

try {
  await main();
} catch (e) {
  fail++; results.push(`  FAIL harness threw — ${e.stack || e.message}`);
} finally {
  cleanup();
}
console.log("\n── appearance persistence e2e ──");
console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
