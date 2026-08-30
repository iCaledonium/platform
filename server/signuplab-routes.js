// Signup Lab — assertions against live state for the invite → enroll → org
// pipeline. Platform-local (this is the service that owns signup), mounted
// from index.js the same way as testlab-routes: a module, so whole-file
// writes to index.js cannot silently drop it.
//
// Same board philosophy as the other labs: a board that cannot go red is not
// evidence. Known defects (the TOTP orphan, the unenforced world:control
// scopes) are expected to fail here until actually fixed.
//
// Session 157 — tenancy is memberships now (a person in many orgs, one of them
// their own). The checks below assert the new invariants; the "reachable
// admin" exemption that briefly lived here is superseded: a personal org has
// its owner as admin by construction, so no exemption is needed.

// The sweep (server/lab-incidents.js, driven from /lab/home/testmanager)
// needs this board as a value, not as an HTTP route it would have to
// authenticate to itself. Bound at mount so it closes over db and PORT.
let boundChecks = null;
export async function signupChecks() {
  if (!boundChecks) throw new Error("the signup board is not mounted");
  return boundChecks();
}

export function mount(app, { db, authUser, PORT }) {
  const pass = (name, detail) => ({ verdict: "pass", name, detail });
  const fail = (name, detail) => ({ verdict: "fail", name, detail });
  const skip = (name, detail) => ({ verdict: "skip", name, detail });

  async function probe(path, init) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
      return r.status;
    } catch { return 0; }
  }

  async function computeChecks() {
    const checks = [];
    const guarded = (name, fn) => { try { fn(); } catch (e) { checks.push(fail(name, "query failed: " + e.message)); } };

    // Tenancy 1: everyone owns exactly one personal org and administers it.
    guarded("every user owns a personal org and is its admin", () => {
      const n = db.prepare(
        `SELECT COUNT(*) c FROM users u
          LEFT JOIN orgs o        ON o.id = u.personal_org_id AND o.kind = 'personal'
          LEFT JOIN memberships m ON m.user_id = u.id AND m.org_id = u.personal_org_id AND m.role = 'admin'
          WHERE u.status != 'removed' AND (o.id IS NULL OR m.user_id IS NULL)`).get().c;
      checks.push(n === 0
        ? pass("every user owns a personal org and is its admin", "no account without a personal org, or without the admin role in it")
        : fail("every user owns a personal org and is its admin", `${n} account(s) lack a personal org or the admin role in it — the boot migration did not cover them`));
    });

    // Tenancy 2: the active org is one the user actually belongs to, with the
    // mirrored role matching the membership. users.org_id is a mirror; a mirror
    // that disagrees with memberships is a stale scalar every route would trust.
    guarded("the active org is a real membership", () => {
      const n = db.prepare(
        `SELECT COUNT(*) c FROM users u
          LEFT JOIN memberships m ON m.user_id = u.id AND m.org_id = u.org_id
          WHERE u.status != 'removed' AND (u.org_id IS NULL OR m.user_id IS NULL OR m.role != u.org_role)`).get().c;
      checks.push(n === 0
        ? pass("the active org is a real membership", "every account acts in an org it belongs to, with the role it holds there")
        : fail("the active org is a real membership", `${n} account(s) act in an org they do not belong to, or with a role that disagrees with their membership`));
    });

    // Tenancy 3: no membership points at a ghost.
    guarded("no membership points at a ghost", () => {
      const n = db.prepare(
        `SELECT COUNT(*) c FROM memberships m
          LEFT JOIN users u ON u.id = m.user_id LEFT JOIN orgs o ON o.id = m.org_id
          WHERE u.id IS NULL OR o.id IS NULL`).get().c;
      checks.push(n === 0
        ? pass("no membership points at a ghost", "every membership joins a living user to a real org")
        : fail("no membership points at a ghost", `${n} membership(s) reference a user or org that does not exist`));
    });

    // The hole that was closed on 2026-08-2x must STAY closed: enrolment
    // without an invite token or session gets nothing.
    {
      const st = await probe("/api/enroll/start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      checks.push(st === 401
        ? pass("the enrolment door demands proof", "POST /api/enroll/start with no token and no session is refused (401)")
        : fail("the enrolment door demands proof", `expected 401, got ${st} — the door that once let anyone enrol any account is ajar again`));
    }
    // ...and a body user_id is not a proof either. The old hole was exactly
    // this shape: a bare id, no token, no session.
    {
      const victim = db.prepare(`SELECT id FROM users WHERE status != 'removed' LIMIT 1`).get();
      const st = victim ? await probe("/api/enroll/start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: victim.id }) }) : 401;
      checks.push(st === 401
        ? pass("a body user_id proves nothing", "POST /api/enroll/start with only { user_id } is refused (401)")
        : fail("a body user_id proves nothing", `expected 401, got ${st} — enrolment accepted an unproven user_id`));
    }

    // An invented invite token opens nothing.
    {
      const st = await probe("/api/invite/not-a-real-token-000000");
      checks.push(st === 401
        ? pass("a bad invite opens nothing", "an invented token is refused (401)")
        : fail("a bad invite opens nothing", `expected 401, got ${st}`));
    }

    // A deleted user must not leave a second factor behind for whoever
    // inherits the id. (One such orphan is known to exist.)
    guarded("no TOTP secret outlives its user", () => {
      const n = db.prepare(
        `SELECT COUNT(*) c FROM user_totp_secrets s LEFT JOIN users u ON u.id = s.user_id
         WHERE u.id IS NULL`).get().c;
      checks.push(n === 0
        ? pass("no TOTP secret outlives its user", "every stored second factor belongs to a living account")
        : fail("no TOTP secret outlives its user", `${n} orphaned TOTP secret(s) — a reissued user id would inherit a stranger's second factor`));
    });

    // Every ORGANIZATION keeps an active admin, or nobody can invite or erase
    // there again. Personal orgs are covered by the ownership check above.
    guarded("every organization has an admin", () => {
      const n = db.prepare(
        `SELECT COUNT(*) c FROM orgs o WHERE o.kind = 'organization' AND o.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
                           WHERE m.org_id = o.id AND m.role = 'admin' AND u.status = 'active')`).get().c;
      checks.push(n === 0
        ? pass("every organization has an admin", "every active organization has at least one active admin")
        : fail("every organization has an admin", `${n} organization(s) have no active admin — invites and erasure are impossible there`));
    });

    // api_keys.scopes is enforced nowhere, so an unrevoked key claiming
    // world:control is a standing grant nothing checks. Red until revoked.
    guarded("no unrevoked key carries the unenforced world:control scope", () => {
      const rows = db.prepare(
        `SELECT name FROM api_keys WHERE revoked_at IS NULL AND scopes LIKE '%world:control%'`).all();
      checks.push(rows.length === 0
        ? pass("no unrevoked key carries the unenforced world:control scope", "nothing holds a control scope that no code checks")
        : fail("no unrevoked key carries the unenforced world:control scope",
            `${rows.length} unrevoked key(s) claim world:control (${rows.map(r => r.name).join(", ")}) — the scope is enforced nowhere, so these are standing grants`));
    });

    // A personal org IS one person; two memberships in one is a tenancy breach,
    // zero is a leak of the org row past its owner's erasure.
    guarded("a personal org holds exactly one person", () => {
      const total = db.prepare(`SELECT COUNT(*) c FROM orgs WHERE kind = 'personal'`).get().c;
      if (total === 0) {
        checks.push(skip("a personal org holds exactly one person", "no personal orgs exist — the boot migration should have made one per user"));
      } else {
        const n = db.prepare(
          `SELECT COUNT(*) c FROM orgs o WHERE o.kind = 'personal'
           AND (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) != 1`).get().c;
        checks.push(n === 0
          ? pass("a personal org holds exactly one person", `${total} personal org(s), each with exactly one membership`)
          : fail("a personal org holds exactly one person", `${n} of ${total} personal org(s) have a membership count other than one`));
      }
    });

    // An invite that was accepted must not still open the profile door.
    guarded("accepted invites on record", () => {
      const n = db.prepare(
        `SELECT COUNT(*) c FROM user_invites WHERE accepted_at IS NOT NULL
         AND expires_at > datetime('now')`).get().c;
      checks.push(pass("accepted invites on record", `${n} accepted and unexpired — informational; reuse is refused by userForInvite`));
    });

    return checks;
  }

  boundChecks = computeChecks;

  app.get("/api/test/signup/checks", async (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    res.json({ ok: true, checked_at: new Date().toISOString(), checks: await computeChecks() });
  });
}
