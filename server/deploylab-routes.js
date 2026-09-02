// Deploy Lab — assertions against live state for putting a CHARACTER into a
// world: the `actor_deployments` spine, the age floor, and what the world got.
//
// Platform-local, global (no world target).
//
// Scope note, because it looks like an overlap and is not. The avatar board
// already asserts three deploy-shaped things — "no avatar is a minor", "the
// body reached the worlds", "a player stands somewhere the world can find" —
// and those are NOT moved here. They iterate `wearers()`: people wearing an
// avatar, the PLAYER deploy path, and they would lose that scoping if they were
// generalised. This board covers the other path — characters deployed through
// `actor_deployments` — which nothing was watching at all.
//
// Read-only. There is deliberately no probe that attempts a deploy: a deploy
// that SUCCEEDED would be the check putting a character into a live world on a
// nightly cron, and the one this board cares most about would be putting a
// MINOR into one. Assert the outcome instead — what is deployed right now.

let boundChecks = null;
export async function deployChecks() {
  if (!boundChecks) throw new Error("the deploy board is not mounted");
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

  // "Live" means deployed and not since undeployed. Both conditions matter:
  // undeployed_at was added later and deploy_status is a mirror of it, so the
  // two can disagree — which is itself one of the checks below.
  const LIVE = `d.undeployed_at IS NULL`;

  async function computeChecks() {
    const checks = [];
    const guarded = (name, fn) => {
      try { fn(); } catch (e) { checks.push(fail(name, "query failed: " + e.message)); }
    };

    const live = db.prepare(`SELECT COUNT(*) c FROM actor_deployments d WHERE ${LIVE}`).get().c;

    // ── The age floor, asserted where it lands ───────────────────────────────
    //
    // The platform holds a single floor (ageFloorError) over its own authoring
    // routes, and the simulator floors `deploy_player`. `deploy_actor` — the
    // character deploy — has no gate of its own, so this is the check that
    // would notice. It asserts the OUTCOME rather than the code path: whatever
    // any route does, no minor should be standing in a world.

    guarded("no deployed character is a minor", () => {
      if (live === 0) {
        checks.push(skip("no deployed character is a minor",
          "nothing is deployed — an empty deployment table cannot demonstrate the floor holds"));
        return;
      }
      const rows = db.prepare(
        `SELECT a.name, a.age, substr(d.world_id,1,8) w FROM actor_deployments d
           JOIN actors a ON a.id = d.platform_actor_id
          WHERE ${LIVE} AND a.age IS NOT NULL AND a.age < 18`).all();
      checks.push(rows.length === 0
        ? pass("no deployed character is a minor",
            `${live} live deployment(s), every one of age 18 or over`)
        : fail("no deployed character is a minor",
            `${rows.map(r => `${r.name} (${r.age}) in ${r.w}`).join("; ")} — a deployed body carries its age into NPC prompts, and the character deploy path has no floor of its own`));
    });

    // A NULL age is not a pass. The floor is `age < 18`, and NULL fails that
    // comparison silently, so an unrecorded age walks straight through every
    // gate written this way — including the check above.
    guarded("every deployed character has an age at all", () => {
      if (live === 0) {
        checks.push(skip("every deployed character has an age at all", "nothing is deployed"));
        return;
      }
      const rows = db.prepare(
        `SELECT a.name FROM actor_deployments d JOIN actors a ON a.id = d.platform_actor_id
          WHERE ${LIVE} AND a.age IS NULL`).all();
      checks.push(rows.length === 0
        ? pass("every deployed character has an age at all",
            `${live} live deployment(s), none with a NULL age`)
        : fail("every deployed character has an age at all",
            `${rows.length} deployed character(s) carry no age (${rows.map(r => r.name).join(", ")}) — NULL < 18 is never true, so an unrecorded age passes every floor written as a comparison`));
    });

    // ── The record itself ────────────────────────────────────────────────────

    guarded("no deployment points at a character that is gone", () => {
      const total = db.prepare(`SELECT COUNT(*) c FROM actor_deployments`).get().c;
      if (total === 0) {
        checks.push(skip("no deployment points at a character that is gone", "nothing has ever been deployed"));
        return;
      }
      const n = db.prepare(
        `SELECT COUNT(*) c FROM actor_deployments d
          LEFT JOIN actors a ON a.id = d.platform_actor_id WHERE a.id IS NULL`).get().c;
      checks.push(n === 0
        ? pass("no deployment points at a character that is gone",
            `${total} deployment record(s), each joining a character that still exists`)
        : fail("no deployment points at a character that is gone",
            `${n} of ${total} deployment(s) name a platform_actor_id with no row — the cascade should have taken these`));
    });

    guarded("every deployment names the body the world knows", () => {
      if (live === 0) {
        checks.push(skip("every deployment names the body the world knows", "nothing is deployed"));
        return;
      }
      const n = db.prepare(
        `SELECT COUNT(*) c FROM actor_deployments d
          WHERE ${LIVE} AND (d.simulator_actor_id IS NULL OR trim(d.simulator_actor_id) = '')`).get().c;
      checks.push(n === 0
        ? pass("every deployment names the body the world knows",
            `${live} live deployment(s), each carrying the simulator actor id it created`)
        : fail("every deployment names the body the world knows",
            `${n} live deployment(s) have no simulator_actor_id — the platform believes it deployed something it cannot point at, so undeploy has nothing to remove`));
    });

    // deploy_status is a mirror of undeployed_at, and a mirror that disagrees
    // with what it mirrors is a scalar every route would trust.
    guarded("the deploy status agrees with the undeploy clock", () => {
      const total = db.prepare(`SELECT COUNT(*) c FROM actor_deployments`).get().c;
      if (total === 0) {
        checks.push(skip("the deploy status agrees with the undeploy clock", "nothing has ever been deployed"));
        return;
      }
      const n = db.prepare(
        `SELECT COUNT(*) c FROM actor_deployments
          WHERE (undeployed_at IS NOT NULL AND deploy_status = 'deployed')
             OR (undeployed_at IS NULL AND deploy_status IS NOT NULL AND deploy_status != 'deployed')`).get().c;
      checks.push(n === 0
        ? pass("the deploy status agrees with the undeploy clock",
            `${total} record(s), status and undeployed_at telling the same story`)
        : fail("the deploy status agrees with the undeploy clock",
            `${n} of ${total} record(s) disagree — one says deployed while the other says it was taken out, and different routes read different ones`));
    });

    guarded("a character is deployed to a world at most once", () => {
      const total = db.prepare(`SELECT COUNT(*) c FROM actor_deployments d WHERE ${LIVE}`).get().c;
      if (total === 0) {
        checks.push(skip("a character is deployed to a world at most once", "nothing is deployed"));
        return;
      }
      const n = db.prepare(
        `SELECT COUNT(*) c FROM (
            SELECT platform_actor_id, world_id FROM actor_deployments d WHERE ${LIVE}
             GROUP BY platform_actor_id, world_id HAVING COUNT(*) > 1)`).get().c;
      checks.push(n === 0
        ? pass("a character is deployed to a world at most once",
            `${total} live deployment(s), no character standing twice in the same world`)
        : fail("a character is deployed to a world at most once",
            `${n} (character, world) pair(s) have more than one live deployment — the UNIQUE constraint covers the pair, so these got in around it`));
    });

    // ── The doors ────────────────────────────────────────────────────────────

    {
      const n = "deploying demands an account";
      const st = await probe("/api/actors/some-actor-id/deploy", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      checks.push(st === 401
        ? pass(n, "POST /api/actors/:id/deploy with no session is refused (401)")
        : fail(n, `expected 401, got ${st} — putting a body into a live world is not something a stranger may ask for`));
    }

    {
      const n = "undeploying demands an account";
      const st = await probe("/api/actors/some-actor-id/undeploy", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      checks.push(st === 401
        ? pass(n, "POST /api/actors/:id/undeploy with no session is refused (401)")
        : fail(n, `expected 401, got ${st} — a stranger could empty a world`));
    }

    return checks;
  }

  boundChecks = computeChecks;

  app.get("/api/test/deploy/checks", async (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    res.json({ ok: true, checked_at: new Date().toISOString(), checks: await computeChecks() });
  });
}
