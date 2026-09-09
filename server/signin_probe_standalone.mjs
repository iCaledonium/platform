// Runs the sign-in bench's sequence standalone, server-side, exactly as the
// mounted probe will. Lives in ~/platform/server so it resolves otpauth and
// better-sqlite3 from that node_modules.
import Database from "better-sqlite3";
import * as OTPAuth from "otpauth";
import crypto from "node:crypto";

const db = new Database("/home/magnus/platform_dev.db");
const base = "http://127.0.0.1:4002";
const post = (p, body, headers = {}) => fetch(base + p, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body), redirect: "manual" });

const suffix = crypto.randomBytes(3).toString("hex");
const id = `lab-signin-${suffix}`;
const email = `signin-${suffix}@lab.local`;
const org = db.prepare(`SELECT org_id FROM users WHERE org_role='admin' LIMIT 1`).get()?.org_id;

const steps = [];
const step = (name, ok, detail) => { steps.push({name, ok, detail});
  console.log((ok ? "held  " : "BROKE "), name.padEnd(46), detail); };

try {
  db.prepare(`INSERT INTO users (id,name,email,status,user_type,org_id,org_role,inserted_at,updated_at)
              VALUES (?,?,?,'active','staff',?,'member',datetime('now'),datetime('now'))`)
    .run(id, `Sign-in Probe ${suffix}`, email, org);
  const t = new OTPAuth.TOTP({ issuer:"Anima", label:email, algorithm:"SHA1", digits:6, period:30 });
  const secret = t.secret.base32;
  db.prepare(`INSERT INTO user_totp_secrets (id,user_id,secret,enrolled_at,inserted_at,updated_at)
              VALUES (?,?,?,datetime('now'),datetime('now'),datetime('now'))`)
    .run(crypto.randomUUID(), id, secret);
  const codeFor = (off=0) => new OTPAuth.TOTP({ issuer:"Anima", algorithm:"SHA1", digits:6, period:30,
    secret: OTPAuth.Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + off*1000 });

  const bad = await post("/api/auth/verify", { email, code: "000000" });
  step("a wrong code is refused", bad.status === 401, `HTTP ${bad.status}`);

  const code = codeFor();
  const good = await post("/api/auth/verify", { email, code });
  const sc = good.headers.get("set-cookie") || "";
  const body = await good.json().catch(()=>({}));
  step("the right code signs in", good.status === 200, `HTTP ${good.status}`);
  step("the cookie is HttpOnly, Secure, SameSite",
    /HttpOnly/i.test(sc) && /Secure/i.test(sc) && /SameSite=None/i.test(sc),
    sc.replace(/anima_token=[a-f0-9]+/, "anima_token=…").slice(0,90) || "no Set-Cookie");
  const raw = (sc.match(/anima_token=([a-f0-9]+)/)||[])[1];
  const cookie = raw ? `anima_token=${raw}` : "";

  const replay = await post("/api/auth/verify", { email, code });
  step("a used code cannot be replayed", replay.status !== 200,
    replay.status === 200 ? "SAME code minted a SECOND session" : `HTTP ${replay.status}`);

  const ticket = (body.handoff || "").split("ticket=")[1] || null;
  if (ticket) {
    const a = await fetch(`${base}/api/auth/handoff/redeem?ticket=${ticket}`, {redirect:"manual"});
    const b = await fetch(`${base}/api/auth/handoff/redeem?ticket=${ticket}`, {redirect:"manual"});
    step("the handoff ticket is single-use", a.status===302 && b.status===401, `first ${a.status}, second ${b.status}`);
  } else step("the handoff ticket is single-use", false, "no ticket returned");

  const fresh = cookie
    ? await post("/api/auth/handoff/ticket", {}, { Cookie: cookie }).then(r => r.json()).catch(() => ({}))
    : {};
  if (fresh.ticket) {
    const ev = await fetch(`${base}/api/auth/handoff/redeem?ticket=${fresh.ticket}&next=${encodeURIComponent("//evil.example/steal")}`, {redirect:"manual"});
    const dest = ev.headers.get("location") || "";
    step("redeem cannot be aimed off this host", dest === "/home", `Location: ${dest||"(none)"}`);
  } else step("redeem cannot be aimed off this host", false, "could not mint a ticket to test with");

  if (cookie) {
    const out = await post("/api/auth/signout", {}, { Cookie: cookie });
    const after = await fetch(`${base}/api/auth/check`, { headers: { Cookie: cookie } });
    step("sign-out revokes the session", out.status < 400 && after.status === 401,
      `signout ${out.status}, then check ${after.status}`);
  }
} catch (e) {
  console.log("PROBE ERROR:", e.message);
} finally {
  db.prepare(`DELETE FROM auth_tokens WHERE user_id=?`).run(id);
  db.prepare(`DELETE FROM auth_handoff_tickets WHERE user_id=?`).run(id);
  db.prepare(`DELETE FROM user_totp_secrets WHERE user_id=?`).run(id);
  const gone = db.prepare(`DELETE FROM users WHERE id=? AND email LIKE '%@lab.local'`).run(id);
  console.log("\ncleanup: test account removed =", gone.changes === 1);
}
