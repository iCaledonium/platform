// Sign-In Lab — the door itself: TOTP verification, the session it mints,
// the desktop handoff ticket, and sign-out.
//
// ONE DESIGN CONSTRAINT SHAPES EVERYTHING HERE: a sign-in test must never run
// in the developer's browser. `/api/auth/verify` answers with a Set-Cookie for
// `anima_token`, so a "test login" performed from the page would overwrite the
// admin session of the person running the test and sign them out of their own
// lab. Every login in this bench is therefore performed SERVER-SIDE by this
// module, against a throwaway @lab.local account, and the cookie it returns is
// read, asserted on, and discarded.

import crypto from "node:crypto";
import * as OTPAuth from "otpauth";

// The sweep calls this board as a VALUE rather than making the server
// authenticate an HTTP request to itself. Bound at mount so it closes over
// db and PORT, the same shape as the other platform-local categories.
let boundChecks = null;
export async function signinChecks() {
  if (!boundChecks) throw new Error("the sign-in board is not mounted");
  return boundChecks();
}

export function mount(app, { db, authUser, PORT }) {
  const pass = (name, detail) => ({ verdict: "pass", name, detail });
  const fail = (name, detail) => ({ verdict: "fail", name, detail });
  const skip = (name, detail) => ({ verdict: "skip", name, detail });

  const base = `http://127.0.0.1:${PORT}`;
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body), redirect: "manual",
  });

  // ── the fixture: a throwaway account with a real second factor ────────────
  // Built through the production endpoints, exactly like the signup bench, so
  // what is tested is the real door and not a stub of it.
  function mintEnrolledLabUser() {
    const suffix = crypto.randomBytes(3).toString("hex");
    const id = `lab-signin-${suffix}`;
    const email = `signin-${suffix}@lab.local`;
    const org = db.prepare(`SELECT org_id FROM users WHERE org_role = 'admin' LIMIT 1`).get()?.org_id;
    db.prepare(`INSERT INTO users (id, name, email, status, user_type, org_id, org_role, inserted_at, updated_at)
                VALUES (?, ?, ?, 'active', 'staff', ?, 'member', datetime('now'), datetime('now'))`)
      .run(id, `Sign-in Probe ${suffix}`, email, org);
    const totp = new OTPAuth.TOTP({ issuer: "Anima", label: email, algorithm: "SHA1", digits: 6, period: 30 });
    const secret = totp.secret.base32;
    db.prepare(`INSERT INTO user_totp_secrets (id, user_id, secret, enrolled_at, inserted_at, updated_at)
                VALUES (?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`)
      .run(crypto.randomUUID(), id, secret);
    return { id, email, secret };
  }

  function codeFor(secret, offsetSeconds = 0) {
    const totp = new OTPAuth.TOTP({ issuer: "Anima", algorithm: "SHA1", digits: 6, period: 30,
      secret: OTPAuth.Secret.fromBase32(secret) });
    return totp.generate({ timestamp: Date.now() + offsetSeconds * 1000 });
  }

  function removeLabUser(id) {
    db.prepare(`DELETE FROM auth_tokens WHERE user_id = ?`).run(id);
    db.prepare(`DELETE FROM auth_handoff_tickets WHERE user_id = ?`).run(id);
    db.prepare(`DELETE FROM user_totp_secrets WHERE user_id = ?`).run(id);
    db.prepare(`DELETE FROM users WHERE id = ? AND email LIKE '%@lab.local'`).run(id);
  }

  // ── the sequence: a real sign-in walked end to end, server-side ───────────
  app.post("/api/test/signin/probe", async (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });

    const lab = mintEnrolledLabUser();
    const steps = [];
    const step = (name, ok, detail) => steps.push({ name, ok, detail });

    try {
      // 1. The wrong code opens nothing.
      const bad = await post("/api/auth/verify", { email: lab.email, code: "000000" });
      step("a wrong code is refused", bad.status === 401, `HTTP ${bad.status}`);

      // 2. The right code opens the door and mints a session cookie.
      const code = codeFor(lab.secret);
      const good = await post("/api/auth/verify", { email: lab.email, code });
      const setCookie = good.headers.get("set-cookie") || "";
      const body = await good.json().catch(() => ({}));
      step("the right code signs in", good.status === 200, `HTTP ${good.status}`);
      step("the session cookie is HttpOnly, Secure and scoped",
        /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=None/i.test(setCookie),
        setCookie.replace(/anima_token=[a-f0-9]+/, "anima_token=…") || "no Set-Cookie");

      const raw = (setCookie.match(/anima_token=([a-f0-9]+)/) || [])[1];
      const cookie = raw ? `anima_token=${raw}` : "";

      // 3. THE REPLAY QUESTION. The same six digits, a second time. Nothing
      //    records a spent code, so this is expected to succeed — which is
      //    the finding, not the failure of the test.
      const replay = await post("/api/auth/verify", { email: lab.email, code });
      step("a used code cannot be replayed", replay.status !== 200,
        replay.status === 200
          ? "the same code minted a SECOND session — one-time codes are not one-time within their window"
          : `HTTP ${replay.status}`);

      // 4. The handoff ticket is single-use.
      const ticket = (body.handoff || "").split("ticket=")[1] || null;
      if (!ticket) {
        step("the desktop handoff ticket is single-use", false, "no handoff ticket came back with the login");
      } else {
        const first  = await fetch(`${base}/api/auth/handoff/redeem?ticket=${ticket}`, { redirect: "manual" });
        const second = await fetch(`${base}/api/auth/handoff/redeem?ticket=${ticket}`, { redirect: "manual" });
        step("the desktop handoff ticket is single-use",
          first.status === 302 && second.status === 401,
          `first ${first.status}, second ${second.status}`);
      }

      // 5. Redeem must not become an open redirect that also hands over a
      //    session. The ticket is minted from the session we already hold —
      //    a second LOGIN cannot be used here, because TOTP validates with
      //    window:1 (±30s) and a code generated a window ahead is refused.
      //    That mistake cost a false "no second ticket" on the first run.
      const fresh = cookie
        ? await post("/api/auth/handoff/ticket", {}, { Cookie: cookie }).then(r => r.json()).catch(() => ({}))
        : {};
      if (fresh.ticket) {
        const eviled = await fetch(
          `${base}/api/auth/handoff/redeem?ticket=${fresh.ticket}&next=${encodeURIComponent("//evil.example/steal")}`,
          { redirect: "manual" });
        const dest = eviled.headers.get("location") || "";
        step("redeem cannot be aimed off this host", dest === "/home", `redirected to ${dest || "(none)"}`);
      } else {
        step("redeem cannot be aimed off this host", false, "could not mint a ticket to test with");
      }

      // 6. Sign-out actually revokes the session it was given.
      if (cookie) {
        const out = await post("/api/auth/signout", {}, { Cookie: cookie });
        const after = await fetch(`${base}/api/auth/check`, { headers: { Cookie: cookie } });
        step("sign-out revokes the session", out.status < 400 && after.status === 401,
          `signout ${out.status}, then check ${after.status}`);
      } else {
        step("sign-out revokes the session", false, "no session cookie to revoke");
      }
    } catch (e) {
      step("the probe ran to completion", false, e.message);
    } finally {
      removeLabUser(lab.id);          // the account never outlives the probe
    }

    res.json({ ok: true, ran_at: new Date().toISOString(), account: "removed", steps });
  });

  // ── the board: what is true right now, without running anything ───────────
  async function computeChecks() {
    const checks = [];

    // The door must not say who exists. The email path answers with one
    // uniform sentence; the user_id path does not.
    try {
      const a = await post("/api/auth/verify", { user_id: "no-such-user-" + Date.now(), code: "000000" });
      const b = await post("/api/auth/verify", { email: `nobody-${Date.now()}@nowhere.test`, code: "000000" });
      const aBody = await a.json().catch(() => ({}));
      checks.push(a.status === b.status
        ? pass("the door does not say who exists", `both unknown-subject paths answer HTTP ${a.status}`)
        : fail("the door does not say who exists",
            `the user_id path answers ${a.status} "${aBody.error}" while the email path answers ${b.status} — ` +
            "so 403 vs 401 tells an attacker which ids are enrolled accounts, and ids here are short and guessable"));
    } catch (e) { checks.push(skip("the door does not say who exists", e.message)); }

    // Personal accounts must never be enumerable from the sign-in page.
    try {
      const listed = await fetch(`${base}/api/orgs`).then(r => r.json());
      const personal = db.prepare(`SELECT COUNT(*) c FROM orgs WHERE kind = 'personal' AND status = 'active'`).get().c;
      const leaked = (listed || []).filter(o =>
        db.prepare(`SELECT kind FROM orgs WHERE id = ?`).get(o.id)?.kind !== "organization");
      checks.push(leaked.length === 0
        ? pass("personal accounts are not enumerable",
            `${listed.length} company tile(s) offered; ${personal} personal org(s) correctly withheld`)
        : fail("personal accounts are not enumerable",
            `${leaked.length} personal org(s) appear on the public sign-in page — that publishes the existence of consumer accounts`));
    } catch (e) { checks.push(skip("personal accounts are not enumerable", e.message)); }

    // No session may live forever.
    try {
      const r = db.prepare(
        `SELECT COUNT(*) total,
                SUM(CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END) forever,
                MAX(CAST(julianday(expires_at) - julianday(inserted_at) AS INT)) longest
           FROM auth_tokens`).get();
      checks.push(r.forever === 0
        ? pass("no session token lives forever", `${r.total} token(s) on record, longest life ${r.longest} days`)
        : fail("no session token lives forever", `${r.forever} token(s) have no expiry at all`));
    } catch (e) { checks.push(skip("no session token lives forever", e.message)); }

    // Sessions accumulate: every sign-in mints one and nothing prunes.
    try {
      const rows = db.prepare(
        `SELECT user_id, COUNT(*) c FROM auth_tokens
          WHERE revoked_at IS NULL AND expires_at > datetime('now')
          GROUP BY user_id ORDER BY c DESC`).all();
      const worst = rows[0];
      checks.push(!worst || worst.c <= 10
        ? pass("nobody is hoarding live sessions", rows.length ? `most is ${worst.c} live session(s)` : "no live sessions")
        : fail("nobody is hoarding live sessions",
            `${worst.user_id} holds ${worst.c} live session(s) — each sign-in mints another and only the ` +
            "one you sign out of is revoked, so a lost laptop keeps a valid cookie for up to 30 days"));
    } catch (e) { checks.push(skip("nobody is hoarding live sessions", e.message)); }

    // Expired handoff tickets should not linger unburned.
    try {
      const stale = db.prepare(
        `SELECT COUNT(*) c FROM auth_handoff_tickets
          WHERE used_at IS NULL AND expires_at <= datetime('now')`).get().c;
      checks.push(stale === 0
        ? pass("no handoff ticket is left lying around", "every minted ticket was burned or has been cleaned up")
        : fail("no handoff ticket is left lying around",
            `${stale} expired ticket(s) still unburned — dead rows, but they are session-grants by design and nothing sweeps them`));
    } catch (e) { checks.push(skip("no handoff ticket is left lying around", e.message)); }

    // The probe covers what only a live sequence can: replay, single-use,
    // redirect, revocation. Say so rather than implying the board covers it.
    checks.push(skip("the live sequence (replay, ticket, redirect, sign-out)",
      "run the probe above — those four properties cannot be read off the database, only performed"));

    return checks;
  }

  boundChecks = computeChecks;

  app.get("/api/test/signin/checks", async (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    res.json({ ok: true, checked_at: new Date().toISOString(), checks: await computeChecks() });
  });
}
