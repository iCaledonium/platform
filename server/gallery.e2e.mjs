// ── e2e: the public character gallery (Session 159) ───────────────────────────
//
// Run on the platform host:  node server/gallery.e2e.mjs
//
// Same harness as sharelinks.e2e.mjs: mints auth_tokens rows directly (the
// cookie regex is /anima_token=([a-f0-9]+)/, so tokens must be hex) and seeds a
// real second org, because "public" here means platform-wide and the whole
// question is whether it crosses the tenant boundary.
//
// Publication state lives on the actors rows this DB already has, so the suite
// records each actor's visibility up front and restores it in the finally block
// — a failed run must not leave somebody's character listed.

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

const OUT_ORG = "t159-outside", OUT_USER = "t159-out";
const OWNER = "mk", INSIDE = "tn";
const tokens = {};
const savedVisibility = new Map();

function mintToken(userId) {
  const raw = crypto.randomBytes(24).toString("hex");
  db.prepare(`INSERT INTO auth_tokens (id, user_id, token_hash, expires_at, inserted_at)
              VALUES (?,?,?,datetime('now','+1 day'),?)`)
    .run(`t159-${userId}`, userId, sha(raw), now());
  tokens[userId] = raw;
}

async function api(method, url, { user, body } = {}) {
  const headers = {};
  if (user) headers.cookie = `anima_token=${tokens[user]}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: json };
}

function cleanup() {
  db.transaction(() => {
    for (const [id, v] of savedVisibility) {
      db.prepare(`UPDATE actors SET visibility = ?, published_permission = NULL,
                  published_note = NULL, published_at = NULL WHERE id = ?`).run(v ?? "private", id);
    }
    db.prepare(`DELETE FROM actor_shares WHERE shared_with_id IN (?,?)`).run(OUT_USER, INSIDE);
    db.prepare(`DELETE FROM auth_tokens WHERE id LIKE 't159-%'`).run();
    db.prepare(`DELETE FROM memberships WHERE user_id = ?`).run(OUT_USER);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(OUT_USER);
    db.prepare(`DELETE FROM orgs WHERE id = ?`).run(OUT_ORG);
  })();
}

async function main() {
  for (const a of db.prepare(`SELECT id, visibility FROM actors`).all()) savedVisibility.set(a.id, a.visibility);

  db.prepare(`INSERT INTO orgs (id, name, kind, status, inserted_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run(OUT_ORG, "Outside Co", "organization", "active", now(), now());
  db.prepare(`INSERT INTO users (id, name, email, status, user_type, org_id, org_role, inserted_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(OUT_USER, "Outsider Person", "outsider@t159.example", "active", "staff", OUT_ORG, "member", now(), now());
  db.prepare(`INSERT INTO memberships (user_id, org_id, role, inserted_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(OUT_USER, OUT_ORG, "member", now(), now());
  mintToken(OWNER); mintToken(OUT_USER); mintToken(INSIDE);

  const finished = db.prepare(`SELECT id, name FROM actors WHERE owner_id = ? AND status != 'draft' LIMIT 1`).get(OWNER);
  const draft    = db.prepare(`SELECT id, name FROM actors WHERE owner_id = ? AND status = 'draft' LIMIT 1`).get(OWNER);
  if (!finished) throw new Error("no finished actor owned by mk to publish");
  const A = finished.id;

  // ── 1. the gallery starts empty and needs a session ────────────────────────
  let r = await api("GET", "/api/gallery");
  check("the gallery 401s without a session", r.status === 401, `got ${r.status}`);

  r = await api("GET", "/api/gallery", { user: OUT_USER });
  check("an empty gallery is an empty list, not an error", r.status === 200 && Array.isArray(r.body), `got ${r.status}`);
  check("...and nothing is listed before anyone publishes", (r.body || []).every(x => x.id !== A));

  // ── 2. only the owner may publish ──────────────────────────────────────────
  r = await api("PUT", `/api/actors/${A}/publish`, { user: OUT_USER, body: { permission: "read" } });
  check("a stranger cannot publish somebody else's character", r.status === 404, `got ${r.status}`);

  // ── 3. the cap holds here too ──────────────────────────────────────────────
  r = await api("PUT", `/api/actors/${A}/publish`, { user: OWNER, body: { permission: "copy" } });
  check("the gallery refuses to offer copy", r.status === 400, `got ${r.status}`);
  check("...naming the same rule the link refusal names",
        /ownership only ever crosses/i.test(r.body?.error || ""), r.body?.error);

  // ── 4. a draft is not publishable ──────────────────────────────────────────
  if (draft) {
    r = await api("PUT", `/api/actors/${draft.id}/publish`, { user: OWNER, body: { permission: "read" } });
    check("a draft cannot be published", r.status === 400 && /draft/i.test(r.body?.error || ""), `${r.status} ${r.body?.error}`);
    r = await api("GET", `/api/actors/${draft.id}/publish`, { user: OWNER });
    check("...and the control is told so before the click", r.body?.publishable === false, JSON.stringify(r.body));
  } else {
    results.push("  --   (no draft actor present to test the draft refusal)");
  }

  // ── 5. publish ─────────────────────────────────────────────────────────────
  r = await api("PUT", `/api/actors/${A}/publish`, { user: OWNER, body: { permission: "read", note: "A test listing." } });
  check("owner publishes at read", r.status === 200 && r.body?.visibility === "public", JSON.stringify(r.body));

  r = await api("GET", `/api/actors/${A}/publish`, { user: OWNER });
  check("the owner can read back the listing state", r.body?.visibility === "public" && r.body?.permission === "read");
  check("...with nobody having adopted yet", (r.body?.adopters || []).length === 0);

  // ── 6. THE CROSS-ORG CASE ──────────────────────────────────────────────────
  r = await api("GET", "/api/gallery", { user: OUT_USER });
  const seen = (r.body || []).find(x => x.id === A);
  check("someone in ANOTHER ORG sees the listing", !!seen, `${(r.body||[]).length} rows`);
  check("...told what it offers", seen?.permission === "read", seen?.permission);
  check("...told who made her", !!seen?.owner_name, seen?.owner_name);
  check("...and that they hold nothing yet", seen?.already_have === null && seen?.is_mine === false);

  // Publication alone must grant nothing — actor_shares is the single answer to
  // "who has access", and browsing is not having.
  let row = db.prepare(`SELECT 1 FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(A, OUT_USER);
  check("listing alone grants NOTHING until adopted", !row);

  r = await api("GET", "/api/gallery", { user: OWNER });
  check("the owner sees her own listing flagged as hers", (r.body || []).find(x => x.id === A)?.is_mine === true);

  // ── 7. adopt ───────────────────────────────────────────────────────────────
  r = await api("POST", `/api/gallery/${A}/adopt`, { user: OUT_USER });
  check("the outsider adopts across the tenant boundary", r.status === 200 && r.body?.ok === true, JSON.stringify(r.body));

  row = db.prepare(`SELECT * FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(A, OUT_USER);
  check("a share row exists at read", row?.permission === "read", row?.permission);
  check("...with can_reshare = 0", row?.can_reshare === 0, String(row?.can_reshare));
  check("...tagged via_public, not as a link claim", row?.via_public === 1 && row?.via_link_id === null,
        `via_public=${row?.via_public} via_link_id=${row?.via_link_id}`);
  check("...crediting the CREATOR as owner", row?.owner_id === OWNER, row?.owner_id);

  r = await api("GET", `/api/actors/shared`, { user: OUT_USER });
  check("she appears in the outsider's own gallery", (r.body || []).some(a => a.id === A));

  r = await api("POST", `/api/gallery/${A}/adopt`, { user: OUT_USER });
  check("adopting twice is a no-op", r.status === 200 && r.body?.already_had === true, JSON.stringify(r.body));

  r = await api("GET", "/api/gallery", { user: OUT_USER });
  check("the card now reports what they hold", (r.body || []).find(x => x.id === A)?.already_have === "read");

  r = await api("POST", `/api/gallery/${A}/adopt`, { user: OWNER });
  check("the owner cannot adopt their own character", r.status === 400, `got ${r.status}`);

  // ── 8. the offered rung can be raised, and never lowers a held grant ───────
  await api("PUT", `/api/actors/${A}/publish`, { user: OWNER, body: { permission: "use" } });
  r = await api("POST", `/api/gallery/${A}/adopt`, { user: OUT_USER });
  check("raising the offer upgrades an existing adopter", r.status === 200 && r.body?.upgraded === true, JSON.stringify(r.body));
  row = db.prepare(`SELECT permission, can_reshare FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(A, OUT_USER);
  check("...to use, still never re-shareable", row?.permission === "use" && row?.can_reshare === 0, JSON.stringify(row));

  r = await api("POST", `/api/actors/${A}/fork`, { user: OUT_USER, body: {} });
  check("an adopter CANNOT fork — ownership never crossed", r.status === 403, `got ${r.status}`);

  // A by-name copy grant must survive contact with a read listing.
  await api("POST", `/api/actors/${A}/shares`, {
    user: OWNER, body: { email: "tommy.norberg@anima.se", permission: "copy", can_reshare: true },
  });
  await api("PUT", `/api/actors/${A}/publish`, { user: OWNER, body: { permission: "read" } });
  await api("POST", `/api/gallery/${A}/adopt`, { user: INSIDE });
  const tn = db.prepare(`SELECT permission, can_reshare FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(A, INSIDE);
  check("adopting never downgrades a grant made by name", tn?.permission === "copy", tn?.permission);
  check("...and leaves can_reshare as the owner set it", tn?.can_reshare === 1, String(tn?.can_reshare));

  // ── 9. unpublish ───────────────────────────────────────────────────────────
  r = await api("DELETE", `/api/actors/${A}/publish`, { user: OWNER });
  check("unpublishing reports her private again", r.status === 200 && r.body?.visibility === "private", JSON.stringify(r.body));

  r = await api("GET", "/api/gallery", { user: OUT_USER });
  check("...she is gone from the gallery", !(r.body || []).some(x => x.id === A));

  r = await api("POST", `/api/gallery/${A}/adopt`, { user: OUT_USER });
  check("...and can no longer be adopted", r.status === 404, `got ${r.status}`);

  row = db.prepare(`SELECT permission FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(A, OUT_USER);
  check("but a plain unpublish does NOT withdraw what was already taken", row?.permission === "use", row?.permission);

  // ── 10. unpublish + withdraw ───────────────────────────────────────────────
  await api("PUT", `/api/actors/${A}/publish`, { user: OWNER, body: { permission: "read" } });
  r = await api("DELETE", `/api/actors/${A}/publish?revoke_claims=1`, { user: OWNER });
  check("revoke_claims=1 withdraws the adoptions", r.status === 200 && r.body?.revoked_claims === 1, JSON.stringify(r.body));
  row = db.prepare(`SELECT 1 FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(A, OUT_USER);
  check("...so the adopter's access is actually gone", !row);

  const tnAfter = db.prepare(`SELECT permission FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(A, INSIDE);
  check("...while a by-name grant is untouched — publication only undoes its own",
        tnAfter?.permission === "copy", tnAfter?.permission);

  // ── 11. search ─────────────────────────────────────────────────────────────
  await api("PUT", `/api/actors/${A}/publish`, { user: OWNER, body: { permission: "read", note: "zzqqx marker" } });
  r = await api("GET", "/api/gallery?q=zzqqx", { user: OUT_USER });
  check("search matches the note", (r.body || []).some(x => x.id === A), `${(r.body||[]).length} rows`);
  r = await api("GET", "/api/gallery?q=nothingmatchesthis", { user: OUT_USER });
  check("search that matches nothing returns nothing", (r.body || []).length === 0);
  r = await api("GET", "/api/gallery?q=%25", { user: OUT_USER });
  check("a bare % is a literal, not a wildcard", (r.body || []).length === 0, `${(r.body||[]).length} rows`);
}

try { await main(); }
catch (e) { fail++; results.push(`  FAIL threw — ${e.stack}`); }
finally { cleanup(); }

console.log("\n── public character gallery ──────────────────────────────────");
console.log(results.join("\n"));
console.log(`\n${pass}/${pass + fail} passed${fail ? `  (${fail} FAILED)` : ""}\n`);
process.exit(fail ? 1 : 0);
