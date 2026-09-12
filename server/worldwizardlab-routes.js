// World Wizard Lab — the world-creation flow: WorldWizard.jsx's 4 steps
// (Identity, Location, Modules, LLM), submitted as POST /api/worlds, which
// calls the simulator's create/2 synchronously and inserts world_memberships.
//
// New bench (2026-09-13). Named in "Feature - World Creation Wizard"'s own
// dossier as having no scorecard at all — this closes that.
//
// Scope: platform-mounted, global (no target — it walks every world that has
// ever had a member created through the wizard). Read-only: creating a world
// is a heavy production mutation (a live simulator world, an LLM call,
// portrait uploads) and the dossier explicitly flagged that as something to
// ask the developer about rather than do unasked — this board asserts the
// OUTCOME of past creations instead, the same posture deploylab-routes.js
// takes for the same reason.
//
// World identity: enumerated from the PLATFORM's own `world_memberships`
// (not a simulator listing endpoint — none exists that returns every world,
// only one that batches specific ids) — every world the wizard has ever
// created put at least one row there, so this is a complete and correct list
// for what this bench cares about.

let boundChecks = null;
export async function worldwizardChecks() {
  if (!boundChecks) throw new Error("the world wizard board is not mounted");
  return boundChecks();
}

export function mount(app, { db, authUser, SERVICE_TOKEN, SIMULATOR_URL }) {
  const pass = (name, detail) => ({ verdict: "pass", name, detail });
  const fail = (name, detail) => ({ verdict: "fail", name, detail });
  const skip = (name, detail) => ({ verdict: "skip", name, detail });

  const simGet = async (path) => {
    const r = await fetch(`${SIMULATOR_URL}${path}`, { headers: { "X-Service-Token": SERVICE_TOKEN } });
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
    return r.json();
  };

  const knownWorldIds = () => db.prepare(
    `SELECT DISTINCT world_id FROM world_memberships ORDER BY world_id`
  ).all().map(r => r.world_id);

  async function computeChecks() {
    const checks = [];
    const guarded = async (name, fn) => {
      try { await fn(); } catch (e) { checks.push(fail(name, "query failed: " + e.message)); }
    };

    const worldIds = knownWorldIds();

    // ── Every member's home, the thing this bench exists to watch ───────────
    //
    // create/2 backfills home_place_id for every member on creation (fixed
    // 2026-09-04, per the Feature - User Avatar dossier) but that fix "has
    // never run" against a real creation as of this bench's first session —
    // both existing worlds got their homes from a hand-run data repair, not
    // from create/2 itself. This is the check that would notice if the fix
    // regresses or never actually fires on the next real creation.
    await guarded("every world member resolves a home", async () => {
      if (worldIds.length === 0) {
        checks.push(skip("every world member resolves a home", "no world has ever gained a member through the wizard"));
        return;
      }
      const missing = [];
      let total = 0;
      for (const wid of worldIds) {
        const { actors } = await simGet(`/internal/worlds/${encodeURIComponent(wid)}/actors/residences`);
        for (const a of actors || []) {
          if (a.actor_type !== "user") continue;
          total++;
          if (!a.home_place_id) missing.push(`${a.name || a.id} in ${wid.slice(0, 8)}`);
        }
      }
      if (total === 0) {
        checks.push(skip("every world member resolves a home", "no player-type actor exists in any known world"));
      } else if (missing.length === 0) {
        checks.push(pass("every world member resolves a home", `${total} member(s) across ${worldIds.length} world(s), every one with a home_place_id`));
      } else {
        checks.push(fail("every world member resolves a home",
          `${missing.join("; ")} — a member with no home is the exact regression the 2026-09-04 create/2 backfill fix was for`));
      }
    });

    // A home_place_id that resolves to nothing is the LEFT JOIN trap already
    // paid for once (p.id = a.home_place_id never matched — home_place_id
    // holds Google's id, not the internal places.id — fixed 2026-09-04 in
    // actor_residences itself). Asserting the address came back is what would
    // notice if that join broke again, from either side.
    await guarded("a resolved home joins to a real place", async () => {
      if (worldIds.length === 0) {
        checks.push(skip("a resolved home joins to a real place", "no world has ever gained a member through the wizard"));
        return;
      }
      const unresolved = [];
      let withHome = 0;
      for (const wid of worldIds) {
        const { actors } = await simGet(`/internal/worlds/${encodeURIComponent(wid)}/actors/residences`);
        for (const a of actors || []) {
          if (a.actor_type !== "user" || !a.home_place_id) continue;
          withHome++;
          if (!a.home_address) unresolved.push(`${a.name || a.id} in ${wid.slice(0, 8)} (home_place_id ${a.home_place_id})`);
        }
      }
      if (withHome === 0) {
        checks.push(skip("a resolved home joins to a real place", "no member carries a home_place_id yet"));
      } else if (unresolved.length === 0) {
        checks.push(pass("a resolved home joins to a real place", `${withHome} home(s), every home_place_id joining to a real address`));
      } else {
        checks.push(fail("a resolved home joins to a real place",
          `${unresolved.join("; ")} — a home_place_id with no address behind it is invisible to anything that reads the place, not just the home`));
      }
    });

    // The duplicate-places-row defect this bench's own dossier named: a
    // reused address creating a second `places` row instead of reusing the
    // first. Grouped on Google's own place_id, which is the true identity —
    // two internal rows sharing it are the same address, twice.
    await guarded("no reused address creates a duplicate places row", async () => {
      if (worldIds.length === 0) {
        checks.push(skip("no reused address creates a duplicate places row", "no world has ever gained a member through the wizard"));
        return;
      }
      const dupes = [];
      let total = 0;
      for (const wid of worldIds) {
        const { places } = await simGet(`/internal/worlds/${encodeURIComponent(wid)}/places`);
        total += (places || []).length;
        const byGoogleId = new Map();
        for (const p of places || []) {
          if (!p.place_id) continue;
          if (!byGoogleId.has(p.place_id)) byGoogleId.set(p.place_id, []);
          byGoogleId.get(p.place_id).push(p);
        }
        for (const [gid, rows] of byGoogleId) {
          if (rows.length > 1) dupes.push(`${gid} appears as ${rows.length} rows in ${wid.slice(0, 8)} (${rows.map(r => r.id).join(", ")})`);
        }
      }
      if (total === 0) {
        checks.push(skip("no reused address creates a duplicate places row", "no world has any place rows yet"));
      } else if (dupes.length === 0) {
        checks.push(pass("no reused address creates a duplicate places row", `${total} place row(s) across ${worldIds.length} world(s), no Google place_id duplicated`));
      } else {
        checks.push(fail("no reused address creates a duplicate places row", dupes.join("; ")));
      }
    });

    // ── The LLM step ─────────────────────────────────────────────────────────
    //
    // Never exercised against a live create as of this bench's first session
    // (dossier, "not yet checked"). Two independent things can go wrong: the
    // wizard's selections not reaching every capability (a partial round
    // trip), or a capability landing on an llm_id the config no longer knows
    // about (the "stale compiled-in default" the Session 150 xtts comment
    // warns about, same failure family for a different field).
    let llmByWorld = null;
    await guarded("every world carries the same LLM capability set", async () => {
      if (worldIds.length < 2) {
        checks.push(skip("every world carries the same LLM capability set", `only ${worldIds.length} world(s) known — nothing to compare against`));
        return;
      }
      llmByWorld = new Map();
      for (const wid of worldIds) {
        const { capabilities } = await simGet(`/internal/config/llm?world_id=${encodeURIComponent(wid)}`);
        llmByWorld.set(wid, capabilities || {});
      }
      const sets = [...llmByWorld.entries()].map(([wid, caps]) => [wid, Object.keys(caps).sort()]);
      const [firstWid, firstKeys] = sets[0];
      const mismatched = sets.slice(1).filter(([, keys]) => JSON.stringify(keys) !== JSON.stringify(firstKeys));
      if (mismatched.length === 0) {
        checks.push(pass("every world carries the same LLM capability set",
          `${worldIds.length} world(s), all carrying the same ${firstKeys.length} capabilities`));
      } else {
        checks.push(fail("every world carries the same LLM capability set",
          `${firstWid.slice(0, 8)} has ${firstKeys.length} capabilities; ` +
          mismatched.map(([wid, keys]) => `${wid.slice(0, 8)} has ${keys.length} (missing: ${firstKeys.filter(k => !keys.includes(k)).join(", ") || "none"}, extra: ${keys.filter(k => !firstKeys.includes(k)).join(", ") || "none"})`).join("; ") +
          " — a world missing capabilities its siblings have is exactly what an incomplete LLM-step round trip would produce"));
      }
    });

    await guarded("no LLM capability points at a dead model", async () => {
      // Reuse the fetch above when available; otherwise fetch fresh (the
      // sibling check above may have skipped without populating llmByWorld).
      const map = llmByWorld || new Map();
      if (map.size === 0) {
        for (const wid of worldIds) {
          const { capabilities } = await simGet(`/internal/config/llm?world_id=${encodeURIComponent(wid)}`);
          map.set(wid, capabilities || {});
        }
      }
      const dead = [];
      let total = 0;
      for (const [wid, caps] of map) {
        for (const [cap, info] of Object.entries(caps)) {
          total++;
          // get_llm_config falls back to the raw llm_id as `name`/`alias`
          // when nothing in `available` matches it — the exact "stale
          // default" shape, surfaced here instead of only in the UI.
          if (info.name === info.llm_id && info.alias === info.llm_id) {
            dead.push(`${cap} in ${wid.slice(0, 8)} -> ${info.llm_id}`);
          }
        }
      }
      if (worldIds.length === 0 || total === 0) {
        checks.push(skip("no LLM capability points at a dead model", "no world has any LLM capability configured yet"));
      } else if (dead.length === 0) {
        checks.push(pass("no LLM capability points at a dead model", `${total} capability assignment(s) across ${map.size} world(s), every llm_id known`));
      } else {
        checks.push(fail("no LLM capability points at a dead model", dead.join("; ")));
      }
    });

    // ── The door ─────────────────────────────────────────────────────────────
    {
      const n = "creating a world demands an account";
      try {
        const r = await fetch(`http://127.0.0.1:${process.env.PORT || 4002}/api/worlds`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        });
        checks.push(r.status === 401
          ? pass(n, "POST /api/worlds with no session is refused (401)")
          : fail(n, `expected 401, got ${r.status} — creating a live world is not something a stranger may ask for`));
      } catch (e) {
        checks.push(fail(n, "probe failed: " + e.message));
      }
    }

    return checks;
  }

  boundChecks = computeChecks;

  app.get("/api/test/worldwizard/checks", async (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    try {
      res.json({ ok: true, checked_at: new Date().toISOString(), checks: await computeChecks() });
    } catch (e) {
      res.status(500).json({ error: "world wizard board failed", detail: String(e.message || e).slice(0, 200) });
    }
  });
}
