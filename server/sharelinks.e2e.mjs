// ── e2e: cross-org character share links (Session 158) ────────────────────────
//
// Run on the platform host:  node server/sharelinks.e2e.mjs
//
// Drives the real service on 127.0.0.1:4002. Sessions cannot be created from the
// shell (TOTP), so the suite mints auth_tokens rows directly — the cookie regex
// in authUser is /anima_token=([a-f0-9]+)/, so the tokens must be hex.
//
// The whole point is the tenant boundary, so it seeds a SECOND org with a user
// in it and nothing else — the by-name share path cannot reach that person at
// all, which is what the link exists to solve. Everything seeded is torn down in
// the finally block, including on failure.

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

// ── seed ──────────────────────────────────────────────────────────────────────
const OUT_ORG = "t158-outside";
const OUT_USER = "t158-out";
const OWNER = "mk";                    // owns all three actors in this DB
const INSIDE = "tn";                   // same org as the owner
const tokens = {};

function mintToken(userId) {
  const raw = crypto.randomBytes(24).toString("hex");   // hex — the cookie regex demands it
  db.prepare(`INSERT INTO auth_tokens (id, user_id, token_hash, expires_at, inserted_at)
              VALUES (?,?,?,datetime('now','+1 day'),?)`)
    .run(`t158-${userId}`, userId, sha(raw), now());
  tokens[userId] = raw;
  return raw;
}

function as(userId) {
  return { cookie: `anima_token=${tokens[userId]}` };
}

async function api(method, url, { user, body } = {}) {
  const headers = {};
  if (user) headers.cookie = as(user).cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { /* empty body */ }
  return { status: r.status, body: json };
}

function cleanup() {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM actor_shares WHERE shared_with_id IN (?,?)`).run(OUT_USER, INSIDE);
    db.prepare(`DELETE FROM actor_share_links WHERE created_by = ?`).run(OWNER);
    db.prepare(`DELETE FROM auth_tokens WHERE id LIKE 't158-%'`).run();
    db.prepare(`DELETE FROM memberships WHERE user_id = ?`).run(OUT_USER);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(OUT_USER);
    db.prepare(`DELETE FROM orgs WHERE id = ?`).run(OUT_ORG);
  });
  tx();
}

async function main() {
  // A second tenant, containing exactly one person.
  db.prepare(`INSERT INTO orgs (id, name, kind, status, inserted_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run(OUT_ORG, "Outside Co", "organization", "active", now(), now());
  db.prepare(`INSERT INTO users (id, name, email, status, user_type, org_id, org_role, inserted_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(OUT_USER, "Outsider Person", "outsider@t158.example", "active", "staff", OUT_ORG, "member", now(), now());
  db.prepare(`INSERT INTO memberships (user_id, org_id, role, inserted_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(OUT_USER, OUT_ORG, "member", now(), now());

  mintToken(OWNER); mintToken(OUT_USER); mintToken(INSIDE);

  const actor = db.prepare(`SELECT id, name FROM actors WHERE owner_id = ? LIMIT 1`).get(OWNER);
  if (!actor) throw new Error("no actor owned by mk to test with");
  const A = actor.id;

  // ── 0. the premise: by-name sharing genuinely cannot reach the outsider ─────
  let r = await api("POST", `/api/actors/${A}/shares`, {
    user: OWNER, body: { email: "outsider@t158.example", permission: "read" },
  });
  check("by-name share cannot reach another org (the reason links exist)", r.status === 404, `got ${r.status}`);

  // ── 1. minting is the creator's alone ──────────────────────────────────────
  r = await api("POST", `/api/actors/${A}/share-links`, { user: OUT_USER, body: { permission: "read" } });
  check("outsider cannot mint a link (404, no existence leak)", r.status === 404, `got ${r.status}`);

  // ── 2. the cap: a link can never carry copy ────────────────────────────────
  r = await api("POST", `/api/actors/${A}/share-links`, { user: OWNER, body: { permission: "copy" } });
  check("mint refuses permission=copy", r.status === 400, `got ${r.status}`);
  check("...and says why, naming the rule", /ownership only ever crosses/i.test(r.body?.error || ""), r.body?.error);

  r = await api("POST", `/api/actors/${A}/share-links`, { user: OWNER, body: { permission: "owner" } });
  check("mint refuses an unknown permission", r.status === 400, `got ${r.status}`);

  // ── 3. validation ──────────────────────────────────────────────────────────
  r = await api("POST", `/api/actors/${A}/share-links`, { user: OWNER, body: { permission: "read", expires_in_days: 0 } });
  check("mint refuses expires_in_days = 0", r.status === 400, `got ${r.status}`);
  r = await api("POST", `/api/actors/${A}/share-links`, { user: OWNER, body: { permission: "read", expires_in_days: 900 } });
  check("mint refuses expires_in_days > 365", r.status === 400, `got ${r.status}`);
  r = await api("POST", `/api/actors/${A}/share-links`, { user: OWNER, body: { permission: "read", max_claims: 0 } });
  check("mint refuses max_claims = 0", r.status === 400, `got ${r.status}`);

  // ── 4. mint a read link ────────────────────────────────────────────────────
  r = await api("POST", `/api/actors/${A}/share-links`, { user: OWNER, body: { permission: "read", expires_in_days: 7 } });
  check("owner mints a read link", r.status === 200 && !!r.body?.token, `got ${r.status}`);
  const readToken = r.body?.token;
  const readLinkId = r.body?.id;
  check("mint returns a PATH, not an absolute URL (no http:// behind the tunnel)",
        r.body?.share_path?.startsWith("/share/") && !/^https?:/.test(r.body?.share_path || ""), r.body?.share_path);

  const stored = db.prepare(`SELECT token_hash FROM actor_share_links WHERE id = ?`).get(readLinkId);
  check("only the token's sha256 is stored, never the token", stored?.token_hash === sha(readToken) && stored?.token_hash !== readToken);

  // ── 5. preview requires a session ──────────────────────────────────────────
  r = await api("GET", `/api/share/${readToken}`);
  check("preview 401s without a session", r.status === 401, `got ${r.status}`);

  r = await api("GET", `/api/share/${"0".repeat(43)}`, { user: OUT_USER });
  check("preview 404s on a bogus token", r.status === 404, `got ${r.status}`);

  // ── 6. THE CROSS-ORG CASE ──────────────────────────────────────────────────
  r = await api("GET", `/api/share/${readToken}`, { user: OUT_USER });
  check("outsider in ANOTHER ORG can preview the link", r.status === 200, `got ${r.status}`);
  check("...sees the character", r.body?.actor?.id === A, JSON.stringify(r.body?.actor));
  check("...is told what it grants", r.body?.permission === "read", r.body?.permission);
  check("...is not the owner and holds nothing yet", r.body?.is_owner === false && r.body?.already_have === null);
  check("...is told who shared it", !!r.body?.shared_by, r.body?.shared_by);

  r = await api("POST", `/api/share/${readToken}/claim`, { user: OUT_USER });
  check("outsider CLAIMS across the tenant boundary", r.status === 200 && r.body?.ok === true, JSON.stringify(r.body));

  const row = db.prepare(`SELECT * FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(A, OUT_USER);
  check("a share row now exists for the outsider", !!row);
  check("...at read", row?.permission === "read", row?.permission);
  check("...with can_reshare = 0, never inherited", row?.can_reshare === 0, String(row?.can_reshare));
  check("...tagged with the link that admitted them", row?.via_link_id === readLinkId);
  check("...crediting the CREATOR as owner, not the claimant", row?.owner_id === OWNER, row?.owner_id);

  r = await api("GET", `/api/actors/shared`, { user: OUT_USER });
  check("the character appears in the outsider's gallery", (r.body || []).some(a => a.id === A));

  // ── 7. idempotence: opening it twice does not burn a second seat ───────────
  const before = db.prepare(`SELECT claims_used FROM actor_share_links WHERE id = ?`).get(readLinkId).claims_used;
  r = await api("POST", `/api/share/${readToken}/claim`, { user: OUT_USER });
  const after = db.prepare(`SELECT claims_used FROM actor_share_links WHERE id = ?`).get(readLinkId).claims_used;
  check("re-claiming is a no-op that reports already_had", r.status === 200 && r.body?.already_had === true, JSON.stringify(r.body));
  check("...and does not consume a second seat", before === after, `${before} → ${after}`);

  // ── 8. the owner's own link ────────────────────────────────────────────────
  r = await api("POST", `/api/share/${readToken}/claim`, { user: OWNER });
  check("the owner claiming their own link is refused", r.status === 400, `got ${r.status}`);

  // ── 9. a link never DOWNGRADES a grant made by name ────────────────────────
  await api("POST", `/api/actors/${A}/shares`, {
    user: OWNER, body: { email: "tommy.norberg@anima.se", permission: "copy", can_reshare: true },
  });
  r = await api("POST", `/api/share/${readToken}/claim`, { user: INSIDE });
  const tnRow = db.prepare(`SELECT * FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(A, INSIDE);
  check("a read link does not downgrade an existing copy grant", tnRow?.permission === "copy", tnRow?.permission);
  check("...and leaves can_reshare as the owner set it", tnRow?.can_reshare === 1, String(tnRow?.can_reshare));

  // ── 10. a use link, and the fork refusal that enforces the cap ─────────────
  r = await api("POST", `/api/actors/${A}/share-links`, { user: OWNER, body: { permission: "use", expires_in_days: 7 } });
  const useToken = r.body?.token, useLinkId = r.body?.id;
  r = await api("POST", `/api/share/${useToken}/claim`, { user: OUT_USER });
  check("a use link UPGRADES the outsider's read", r.status === 200 && r.body?.upgraded === true, JSON.stringify(r.body));
  const up = db.prepare(`SELECT permission, can_reshare FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(A, OUT_USER);
  check("...to use", up?.permission === "use", up?.permission);
  check("...still never re-shareable", up?.can_reshare === 0, String(up?.can_reshare));

  r = await api("POST", `/api/actors/${A}/fork`, { user: OUT_USER, body: {} });
  check("a link-claimed holder CANNOT fork — ownership never crossed", r.status === 403, `got ${r.status}`);
  check("...and is told the rung it would need", /copy/i.test(r.body?.error || ""), r.body?.error);

  // ── 11. seats, expiry, revocation ─────────────────────────────────────────
  r = await api("POST", `/api/actors/${A}/share-links`, { user: OWNER, body: { permission: "read", max_claims: 1 } });
  const seatToken = r.body?.token, seatLinkId = r.body?.id;
  db.prepare(`UPDATE actor_share_links SET claims_used = 1 WHERE id = ?`).run(seatLinkId);
  r = await api("POST", `/api/share/${seatToken}/claim`, { user: OUT_USER });
  check("an exhausted link is refused with 410", r.status === 410 && r.body?.state === "exhausted", `${r.status} ${r.body?.state}`);

  r = await api("POST", `/api/actors/${A}/share-links`, { user: OWNER, body: { permission: "read" } });
  const expToken = r.body?.token;
  db.prepare(`UPDATE actor_share_links SET expires_at = ? WHERE id = ?`).run("2020-01-01T00:00:00.000Z", r.body.id);
  r = await api("POST", `/api/share/${expToken}/claim`, { user: OUT_USER });
  check("an expired link is refused with 410", r.status === 410 && r.body?.state === "expired", `${r.status} ${r.body?.state}`);

  r = await api("POST", `/api/actors/${A}/share-links`, { user: OWNER, body: { permission: "read" } });
  const revToken = r.body?.token, revLinkId = r.body?.id;
  await api("DELETE", `/api/actors/${A}/share-links/${revLinkId}`, { user: OWNER });
  r = await api("POST", `/api/share/${revToken}/claim`, { user: OUT_USER });
  check("a revoked link is refused with 410", r.status === 410 && r.body?.state === "revoked", `${r.status} ${r.body?.state}`);

  // ── 12. listing ───────────────────────────────────────────────────────────
  r = await api("GET", `/api/actors/${A}/share-links`, { user: OWNER });
  check("owner lists their links", r.status === 200 && Array.isArray(r.body));
  check("the listing NEVER returns a token", !JSON.stringify(r.body).includes(readToken));
  // The outsider's row now points at the USE link — an upgrade re-tags which link
  // admitted them — so that is the one whose claimant list must name them.
  const listed = (r.body || []).find(l => l.id === useLinkId);
  check("...and names who came in through each one", (listed?.claimed_by || []).some(c => c.user_id === OUT_USER),
        JSON.stringify(listed?.claimed_by));
  r = await api("GET", `/api/actors/${A}/share-links`, { user: OUT_USER });
  check("a share holder cannot list the owner's links", r.status === 403, `got ${r.status}`);

  // ── 13. revoke + remove claims ────────────────────────────────────────────
  r = await api("DELETE", `/api/actors/${A}/share-links/${useLinkId}?revoke_claims=1`, { user: OWNER });
  check("revoke_claims=1 removes the shares it admitted", r.status === 200 && r.body?.revoked_claims === 1,
        JSON.stringify(r.body));
  const gone = db.prepare(`SELECT 1 FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(A, OUT_USER);
  check("...so the outsider's access is actually withdrawn", !gone);

  // Plain revoke is the other meaning of the word and must NOT touch standing
  // access — tn still holds copy, granted by name, through none of these links.
  const tnStill = db.prepare(`SELECT permission FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(A, INSIDE);
  check("a by-name grant survives link revocation entirely", tnStill?.permission === "copy", tnStill?.permission);
}

try {
  await main();
} catch (e) {
  fail++;
  results.push(`  FAIL threw — ${e.stack}`);
} finally {
  cleanup();
}

console.log("\n── cross-org share links ─────────────────────────────────────");
console.log(results.join("\n"));
console.log(`\n${pass}/${pass + fail} passed${fail ? `  (${fail} FAILED)` : ""}\n`);
process.exit(fail ? 1 : 0);
