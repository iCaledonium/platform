// ── e2e: PATCH /api/me — self-service profile edit (Feature: User Edit) ───────
//
// Run on the platform host:  node server/profile.e2e.mjs
//
// Drives the real service on 127.0.0.1:4002. Sessions cannot be created from the
// shell (TOTP), so the suite mints auth_tokens rows directly — the cookie regex
// in the route is /anima_token=([a-f0-9]+)/, so the tokens must be hex.
//
// Everything it touches is seeded and torn down here; no existing account is
// mutated. `mk` is read once, for the email-collision case only.

import Database from "better-sqlite3";
import crypto from "crypto";
import os from "os";
import path from "path";

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

const ORG   = "tprof-org";
const USER  = "tprof-u";
const EMAIL = "tprof@example.test";
const BOGUS_WORLD = "tprof-nonexistent-world";
let cookie = null;
let apiKey = null;

const readUser = () => db.prepare(`SELECT name, email, gender FROM users WHERE id = ?`).get(USER);

async function api(method, url, { auth = "cookie", body } = {}) {
  const headers = {};
  if (auth === "cookie") headers.cookie = `anima_token=${cookie}`;
  if (auth === "apikey") headers["x-api-key"] = apiKey;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* empty body */ }
  return { status: r.status, body: json };
}

try {
  // ── seed ────────────────────────────────────────────────────────────────────
  db.prepare(`INSERT INTO orgs (id, name, kind, status, inserted_at, updated_at)
              VALUES (?,?,'organization','active',?,?)`).run(ORG, "Profile Test Org", now(), now());
  db.prepare(`INSERT INTO users (id, name, email, status, user_type, gender, org_id, org_role, inserted_at, updated_at)
              VALUES (?,?,?,'active','staff','male',?,'member',?,?)`)
    .run(USER, "Test Person", EMAIL, ORG, now(), now());
  db.prepare(`INSERT INTO memberships (user_id, org_id, role, inserted_at, updated_at)
              VALUES (?,?,'member',?,?)`).run(USER, ORG, now(), now());

  const raw = crypto.randomBytes(24).toString("hex");   // hex — the cookie regex demands it
  db.prepare(`INSERT INTO auth_tokens (id, user_id, token_hash, expires_at, inserted_at)
              VALUES (?,?,?,datetime('now','+1 day'),?)`).run(`tprof-tok`, USER, sha(raw), now());
  cookie = raw;

  apiKey = "sk-an-" + crypto.randomBytes(20).toString("hex");
  db.prepare(`INSERT INTO api_keys (id, user_id, world_id, name, key_hash, key_prefix, scopes, inserted_at, updated_at)
              VALUES (?,?,?,?,?,?,'[]',?,?)`)
    .run("tprof-key", USER, "none", "profile e2e", sha(apiKey), apiKey.slice(0, 12), now(), now());

  // ── the gate ────────────────────────────────────────────────────────────────
  let r = await api("PATCH", "/api/me", { auth: "none", body: { name: "Nobody" } });
  check("no cookie → 401", r.status === 401, `got ${r.status}`);

  // The deliberate one: authUser accepts an API key, this route does not. An
  // installed app holding a key must not be able to rename or re-email its owner.
  r = await api("PATCH", "/api/me", { auth: "apikey", body: { name: "Key Holder" } });
  check("API key alone → 401", r.status === 401, `got ${r.status}`);
  check("API key did not rename anyone", readUser().name === "Test Person", readUser().name);

  r = await api("PATCH", "/api/me", { body: {} });
  check("empty patch → 400", r.status === 400, `got ${r.status}`);

  // ── name ────────────────────────────────────────────────────────────────────
  r = await api("PATCH", "/api/me", { body: { name: "  Renamed Person  " } });
  check("name saves, trimmed", r.status === 200 && readUser().name === "Renamed Person",
        `${r.status} / ${readUser().name}`);
  check("name change is reported", r.body?.name_changed === true, JSON.stringify(r.body?.name_changed));
  check("no worlds → empty sync list", Array.isArray(r.body?.worlds) && r.body.worlds.length === 0);

  r = await api("PATCH", "/api/me", { body: { name: "   " } });
  check("blank name → 400", r.status === 400, `got ${r.status}`);
  check("blank name changed nothing", readUser().name === "Renamed Person", readUser().name);

  r = await api("PATCH", "/api/me", { body: { name: "x".repeat(81) } });
  check("81-char name → 400", r.status === 400, `got ${r.status}`);

  // ── email ───────────────────────────────────────────────────────────────────
  r = await api("PATCH", "/api/me", { body: { email: "not-an-email" } });
  check("malformed email → 400", r.status === 400, `got ${r.status}`);

  const mk = db.prepare(`SELECT email FROM users WHERE id = 'mk'`).get();
  r = await api("PATCH", "/api/me", { body: { email: mk.email.toUpperCase() } });
  check("email taken (case-insensitively) → 409", r.status === 409, `got ${r.status}`);
  check("collision changed nothing", readUser().email === EMAIL, readUser().email);

  r = await api("PATCH", "/api/me", { body: { email: "  TProf.New@Example.Test " } });
  check("email saves, trimmed + lowercased",
        r.status === 200 && readUser().email === "tprof.new@example.test",
        `${r.status} / ${readUser().email}`);

  // ── gender ──────────────────────────────────────────────────────────────────
  // "other" is what /admin/users offers in its create form; the simulator has
  // never accepted it. Refused here rather than saved and left unsyncable.
  r = await api("PATCH", "/api/me", { body: { gender: "other" } });
  check("gender 'other' → 422", r.status === 422, `got ${r.status}`);
  check("bad gender changed nothing", readUser().gender === "male", String(readUser().gender));

  r = await api("PATCH", "/api/me", { body: { gender: "NON-BINARY" } });
  check("gender normalises case", r.status === 200 && readUser().gender === "non-binary",
        `${r.status} / ${readUser().gender}`);

  r = await api("PATCH", "/api/me", { body: { gender: "" } });
  check("empty gender clears to NULL", r.status === 200 && readUser().gender === null,
        `${r.status} / ${String(readUser().gender)}`);

  // ── absence is not an instruction ───────────────────────────────────────────
  db.prepare(`UPDATE users SET gender = 'female' WHERE id = ?`).run(USER);
  r = await api("PATCH", "/api/me", { body: { name: "Only The Name" } });
  const after = readUser();
  check("a field not sent is not cleared",
        r.status === 200 && after.gender === "female" && after.email === "tprof.new@example.test",
        JSON.stringify(after));

  // ── the refactored admin path still works ───────────────────────────────────
  // PUT /api/users/:id/gender now calls the same helper; it must still write and
  // still report per world.
  r = await api("PUT", `/api/users/${USER}/gender`, { body: { gender: "male" } });
  check("PUT .../gender still writes", r.status === 200 && readUser().gender === "male",
        `${r.status} / ${readUser().gender}`);

  // ── a world that refuses the push is visible, not swallowed ─────────────────
  db.prepare(`INSERT INTO world_memberships (id, user_id, world_id, actor_id, role, inserted_at, updated_at)
              VALUES (?,?,?,?,'player',?,?)`)
    .run("tprof-wm", USER, BOGUS_WORLD, `${USER}-tprof`, now(), now());

  r = await api("PATCH", "/api/me", { body: { gender: "female" } });
  check("failed world push is still a 200", r.status === 200, `got ${r.status}`);
  check("the account really did change", readUser().gender === "female", String(readUser().gender));
  check("the failed world is reported", r.body?.worlds?.length === 1 && r.body.worlds[0].ok === false,
        JSON.stringify(r.body?.worlds));
  check("gender_synced says false", r.body?.gender_synced === false, String(r.body?.gender_synced));

  // ── an erased account's live token is refused ───────────────────────────────
  db.prepare(`UPDATE users SET status = 'removed' WHERE id = ?`).run(USER);
  r = await api("PATCH", "/api/me", { body: { name: "Ghost" } });
  check("removed account → 401", r.status === 401, `got ${r.status}`);
  check("removed account was not renamed", readUser().name === "Only The Name", readUser().name);
} finally {
  // ── teardown ────────────────────────────────────────────────────────────────
  db.prepare(`DELETE FROM world_memberships WHERE user_id = ?`).run(USER);
  db.prepare(`DELETE FROM api_keys          WHERE user_id = ?`).run(USER);
  db.prepare(`DELETE FROM auth_tokens       WHERE user_id = ?`).run(USER);
  db.prepare(`DELETE FROM memberships       WHERE user_id = ?`).run(USER);
  db.prepare(`DELETE FROM users             WHERE id = ?`).run(USER);
  db.prepare(`DELETE FROM orgs              WHERE id = ?`).run(ORG);

  console.log(results.join("\n"));
  console.log(`\n${pass} passed, ${fail} failed`);
  const left = db.prepare(`SELECT COUNT(*) n FROM users WHERE id = ?`).get(USER).n
             + db.prepare(`SELECT COUNT(*) n FROM orgs  WHERE id = ?`).get(ORG).n;
  console.log(left === 0 ? "teardown clean" : `TEARDOWN LEFT ${left} ROW(S)`);
  process.exit(fail ? 1 : 0);
}
