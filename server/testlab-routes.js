// Extracted from index.js (2026-08-29): these routes live in their own file so
// concurrent whole-file writes to the 340KB index.js can no longer drop them.
// Mounted once from index.js; keep new /api/test/* routes in here.

// ESM only in here — server/package.json is "type": "module" and a require()
// at module scope is a runtime ReferenceError that node --check will pass.
import * as labIncidents from "./lab-incidents.js";
import { signupChecks } from "./signuplab-routes.js";
import { wizardChecks } from "./wizardlab-routes.js";
import { avatarChecks } from "./avatarlab-routes.js";
import { shareChecks } from "./sharelab-routes.js";
import { deployChecks } from "./deploylab-routes.js";
import * as cases from "./lab-cases.js";

export function mount(app, { SERVICE_TOKEN, SIMULATOR_URL, authUser }) {
  // ── Test Lab ─────────────────────────────────────────────────────────────────
  //
  // Session 154. Thin proxies to the simulator's /internal/test/* back doors, so
  // the lab page can reach them with the owner's ordinary session instead of a
  // service token in the browser. Every one of these can set an actor's state or
  // author her past — which is why the simulator side stays LAN-only and these
  // require a logged-in user. Same family as the media invariant: capability
  // this sharp does not get a public route.       ANIMA-INVARIANT
  const TEST_LAB_ROUTES = {
    "scenarios":       { method: "GET",  path: () => `/internal/test/scenarios` },
    "snapshots":       { method: "GET",  path: () => `/internal/test/snapshots` },
    "actor/snapshot":  { method: "POST", path: () => `/internal/test/actor/snapshot` },
    "actor/restore":   { method: "POST", path: () => `/internal/test/actor/restore` },
    "actor/snapshot/label":  { method: "POST", path: () => `/internal/test/actor/snapshot/label` },
    "actor/snapshot/delete": { method: "POST", path: () => `/internal/test/actor/snapshot/delete` },
    "actor/prepare":   { method: "POST", path: () => `/internal/test/actor/prepare` },
    "fixture":         { method: "POST", path: () => `/internal/test/fixture` },
    "llm/canned":      { method: "POST", path: () => `/internal/test/llm/canned` },
    "llm/canned/clear":{ method: "POST", path: () => `/internal/test/llm/canned/clear` },

    // The transport bench. The two GETs carry world_id/actor_id as query params
    // rather than a body, so they forward the query string verbatim.
    "transport/context": { method: "GET",  path: (req) => `/internal/test/transport/context?world_id=${encodeURIComponent(req.query.world_id || "")}&actor_id=${encodeURIComponent(req.query.actor_id || "")}` },
    "transport/checks":  { method: "GET",  path: (req) => `/internal/test/transport/checks?world_id=${encodeURIComponent(req.query.world_id || "")}&actor_id=${encodeURIComponent(req.query.actor_id || "")}` },
    "encounter/checks":  { method: "GET",  path: (req) => `/internal/test/encounter/checks?world_id=${encodeURIComponent(req.query.world_id || "")}&actor_id=${encodeURIComponent(req.query.actor_id || "")}` },
    "behavior/pulse":    { method: "GET",  path: (req) => `/internal/test/behavior/pulse?world_id=${encodeURIComponent(req.query.world_id || "")}` },
    "behavior/checks":   { method: "GET",  path: (req) => `/internal/test/behavior/checks?world_id=${encodeURIComponent(req.query.world_id || "")}` },
    "transport/garage":  { method: "POST", path: () => `/internal/test/transport/garage` },
    "transport/arm":     { method: "POST", path: () => `/internal/test/transport/arm` },
    "transport/disarm":  { method: "POST", path: () => `/internal/test/transport/disarm` },
    "transport/mode":    { method: "POST", path: () => `/internal/test/transport/mode` },
    "transport/route":   { method: "POST", path: () => `/internal/test/transport/route` },
    "transport/depart":  { method: "POST", path: () => `/internal/test/transport/depart` },
    "transport/advance": { method: "POST", path: () => `/internal/test/transport/advance` },
    "transport/clear":   { method: "POST", path: () => `/internal/test/transport/clear` },
  };

  async function testLabProxy(req, res, key) {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const route = TEST_LAB_ROUTES[key];
    if (!route) return res.status(404).json({ error: "unknown test route" });
    try {
      const init = {
        method: route.method,
        headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      };
      if (route.method === "POST") init.body = JSON.stringify(req.body || {});
      const r = await fetch(`${SIMULATOR_URL}${route.path(req)}`, init);
      res.status(r.status).json(await r.json());
    } catch (e) {
      res.status(502).json({ error: "simulator unreachable", detail: String(e).slice(0, 200) });
    }
  }

  app.get("/api/test/scenarios",        (req, res) => testLabProxy(req, res, "scenarios"));
  app.get("/api/test/snapshots",        (req, res) => testLabProxy(req, res, "snapshots"));
  app.post("/api/test/actor/snapshot",  (req, res) => testLabProxy(req, res, "actor/snapshot"));
  app.post("/api/test/actor/restore",   (req, res) => testLabProxy(req, res, "actor/restore"));
  app.post("/api/test/actor/snapshot/label",  (req, res) => testLabProxy(req, res, "actor/snapshot/label"));
  app.post("/api/test/actor/snapshot/delete", (req, res) => testLabProxy(req, res, "actor/snapshot/delete"));
  app.post("/api/test/actor/prepare",   (req, res) => testLabProxy(req, res, "actor/prepare"));
  app.post("/api/test/fixture",         (req, res) => testLabProxy(req, res, "fixture"));
  app.post("/api/test/llm/canned",      (req, res) => testLabProxy(req, res, "llm/canned"));
  app.post("/api/test/llm/canned/clear",(req, res) => testLabProxy(req, res, "llm/canned/clear"));

  // Transport bench — /lab/world/transport/actor
  app.get ("/api/test/transport/context", (req, res) => testLabProxy(req, res, "transport/context"));
  app.get ("/api/test/transport/checks",  (req, res) => testLabProxy(req, res, "transport/checks"));
  app.get ("/api/test/encounter/checks",  (req, res) => testLabProxy(req, res, "encounter/checks"));
  app.get ("/api/test/behavior/pulse",    (req, res) => testLabProxy(req, res, "behavior/pulse"));
  app.get ("/api/test/behavior/checks",   (req, res) => testLabProxy(req, res, "behavior/checks"));
  app.post("/api/test/transport/garage",  (req, res) => testLabProxy(req, res, "transport/garage"));
  app.post("/api/test/transport/arm",     (req, res) => testLabProxy(req, res, "transport/arm"));
  app.post("/api/test/transport/disarm",  (req, res) => testLabProxy(req, res, "transport/disarm"));
  app.post("/api/test/transport/mode",    (req, res) => testLabProxy(req, res, "transport/mode"));
  app.post("/api/test/transport/route",   (req, res) => testLabProxy(req, res, "transport/route"));
  app.post("/api/test/transport/depart",  (req, res) => testLabProxy(req, res, "transport/depart"));
  app.post("/api/test/transport/advance", (req, res) => testLabProxy(req, res, "transport/advance"));
  app.post("/api/test/transport/clear",   (req, res) => testLabProxy(req, res, "transport/clear"));

  // The monitor: per-turn provenance for one encounter.
  app.get("/api/test/worlds/:world_id/encounter/:encounter_id/trace", async (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    try {
      const r = await fetch(
        `${SIMULATOR_URL}/internal/test/worlds/${req.params.world_id}/encounter/${req.params.encounter_id}/trace`,
        { headers: { "X-Service-Token": SERVICE_TOKEN } });
      res.status(r.status).json(await r.json());
    } catch {
      res.status(502).json({ error: "simulator unreachable" });
    }
  });

  // ── Incidents + the test manager ─────────────────────────────────────────
  //
  // Every bench files what it found into one store, and the manager is the
  // thing that walks all four boards and files for them. The store lives in
  // server/lab-incidents.js; these routes are the session-authed door onto it.
  // The machine-facing door is server/lab-incidents-cli.mjs over ssh — see the
  // header there for why that is not an HTTP route.

  let sweepInFlight = null;

  app.get("/api/test/benches", (req, res) => {
    if (!authUser(req)) return res.status(401).json({ error: "not authenticated" });
    res.json({ ok: true,
      // Read from the LIVE route table, not from the catalogue: a bench another
      // session adds shows up here as unwired instead of going unmeasured in
      // silence, which is how the avatar and wizard boards were missed.
      coverage: labIncidents.boardCoverage(app),
      benches: Object.entries(labIncidents.BENCHES).map(([key, b]) => ({
        key, label: b.label, page: b.page, watcher: b.watcher,
        side: b.side, scoped: !!b.scoped, needs_actor: !!b.needsActor })) });
  });

  app.get("/api/test/incidents", (req, res) => {
    if (!authUser(req)) return res.status(401).json({ error: "not authenticated" });
    try {
      res.json({ ok: true,
        counts: labIncidents.counts(),
        incidents: labIncidents.listIncidents({
          status: req.query.status || "unresolved",
          bench: req.query.bench || "all",
          limit: req.query.limit }) });
    } catch (e) {
      res.status(500).json({ error: "incident store failed", detail: String(e.message || e).slice(0, 200) });
    }
  });

  // Filing by hand — a bench's per-row Fix button, or a person recording
  // something a board cannot see.
  app.post("/api/test/incidents", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const b = req.body || {};
    if (!b.check_name) return res.status(400).json({ error: "check_name is required" });
    try {
      const r = labIncidents.report({
        bench: b.bench || "manual", bench_label: b.bench_label, check_name: b.check_name,
        world_id: b.world_id, actor_id: b.actor_id, scope_label: b.scope_label,
        severity: b.severity || "fail", detail: b.detail,
        source: b.source || `manual:${user.name || user.id}`,
      });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ error: "could not file", detail: String(e.message || e).slice(0, 200) });
    }
  });

  app.post("/api/test/incidents/:id/status", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    try {
      const ok = labIncidents.setStatus(req.params.id, (req.body || {}).status,
        user.name || user.id, (req.body || {}).note);
      if (!ok) return res.status(404).json({ error: "no such incident" });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e).slice(0, 200) });
    }
  });

  app.get("/api/test/sweep/targets", (req, res) => {
    if (!authUser(req)) return res.status(401).json({ error: "not authenticated" });
    res.json({ ok: true, targets: labIncidents.listTargets() });
  });

  app.post("/api/test/sweep/targets", (req, res) => {
    if (!authUser(req)) return res.status(401).json({ error: "not authenticated" });
    try {
      res.json({ ok: true, targets: labIncidents.addTarget(req.body || {}) });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e).slice(0, 200) });
    }
  });

  app.post("/api/test/sweep/targets/:id/delete", (req, res) => {
    if (!authUser(req)) return res.status(401).json({ error: "not authenticated" });
    labIncidents.removeTarget(req.params.id);
    res.json({ ok: true, targets: labIncidents.listTargets() });
  });

  app.post("/api/test/sweep/targets/:id/enabled", (req, res) => {
    if (!authUser(req)) return res.status(401).json({ error: "not authenticated" });
    labIncidents.setTargetEnabled(req.params.id, !!(req.body || {}).enabled);
    res.json({ ok: true, targets: labIncidents.listTargets() });
  });

  app.get("/api/test/sweep/runs", (req, res) => {
    if (!authUser(req)) return res.status(401).json({ error: "not authenticated" });
    res.json({ ok: true, runs: labIncidents.listRuns(req.query.limit) });
  });

  // The manager's one button. Serialised: two sweeps at once would file the
  // same board twice and race each other's auto-resolve pass.
  app.post("/api/test/sweep/run", async (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    if (sweepInFlight) return res.status(409).json({ error: "a sweep is already running" });
    const source = (req.body || {}).source || `manual:${user.name || user.id}`;
    sweepInFlight = labIncidents.runSweep({
      source, SIMULATOR_URL, SERVICE_TOKEN, signupChecks, wizardChecks, avatarChecks,
      shareChecks, deployChecks,
      authoredChecks: () => cases.runAuthored({ PORT: 4002 }),
    });
    try {
      const out = await sweepInFlight;
      res.json({ ok: true, coverage: labIncidents.boardCoverage(app), ...out });
    } catch (e) {
      res.status(500).json({ error: "the sweep failed", detail: String(e.message || e).slice(0, 300) });
    } finally {
      sweepInFlight = null;
    }
  });

  // ── Test-case administration ─────────────────────────────────────────────
  //
  // A TEST CASE is one assertion; a SOURCE is where a built-in one comes from;
  // a BOARD is a named set you compose. Boards are VIEWS — the same case in
  // five boards is still one case with one incident, because the fingerprint
  // is (source, check_name, world, actor) and a board is not part of it.

  const admin = (req, res) => {
    const u = authUser(req);
    if (!u) { res.status(401).json({ error: "not authenticated" }); return null; }
    return u;
  };

  app.get("/api/test/cases", (req, res) => {
    if (!admin(req, res)) return;
    try {
      res.json({ ok: true, cases: cases.catalogue(), severities: cases.SEVERITIES });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 200) }); }
  });

  app.post("/api/test/cases/settings", (req, res) => {
    if (!admin(req, res)) return;
    const b = req.body || {};
    if (!b.source || !b.check_name) return res.status(400).json({ error: "source and check_name are required" });
    try {
      cases.setCaseSettings(b);
      res.json({ ok: true, cases: cases.catalogue() });
    } catch (e) { res.status(400).json({ error: String(e.message || e).slice(0, 200) }); }
  });

  // Authored cases. The SQL kind is prepared on a READ-ONLY SQLite connection,
  // so a statement that writes is refused by the engine at save time — not by
  // this route trying to out-think it with a keyword list.
  app.get("/api/test/cases/authored", (req, res) => {
    if (!admin(req, res)) return;
    res.json({ ok: true, authored: cases.listAuthored() });
  });

  app.post("/api/test/cases/authored", (req, res) => {
    if (!admin(req, res)) return;
    try {
      const id = cases.saveAuthored(req.body || {});
      res.json({ ok: true, id, authored: cases.listAuthored() });
    } catch (e) { res.status(400).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.post("/api/test/cases/authored/:id/delete", (req, res) => {
    if (!admin(req, res)) return;
    const ok = cases.deleteAuthored(req.params.id);
    if (!ok) return res.status(404).json({ error: "no such test case" });
    res.json({ ok: true, authored: cases.listAuthored() });
  });

  // Dry-run one authored case without saving it, so the form can say whether
  // what you just typed actually answers before it joins the sweep.
  app.post("/api/test/cases/authored/try", async (req, res) => {
    if (!admin(req, res)) return;
    try {
      const result = await cases.tryAuthored(req.body || {}, { PORT: 4002 });
      res.json({ ok: true, result });
    } catch (e) { res.status(400).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.get("/api/test/boards", (req, res) => {
    if (!admin(req, res)) return;
    res.json({ ok: true, boards: cases.listBoards() });
  });

  app.post("/api/test/boards", (req, res) => {
    if (!admin(req, res)) return;
    try {
      const id = cases.saveBoard(req.body || {});
      res.json({ ok: true, id, boards: cases.listBoards() });
    } catch (e) { res.status(400).json({ error: String(e.message || e).slice(0, 200) }); }
  });

  app.post("/api/test/boards/:id/delete", (req, res) => {
    if (!admin(req, res)) return;
    cases.deleteBoard(req.params.id);
    res.json({ ok: true, boards: cases.listBoards() });
  });

  app.post("/api/test/boards/:id/members", (req, res) => {
    if (!admin(req, res)) return;
    try {
      const board = cases.setBoardMembers(req.params.id, (req.body || {}).members);
      res.json({ ok: true, board, boards: cases.listBoards() });
    } catch (e) { res.status(400).json({ error: String(e.message || e).slice(0, 200) }); }
  });
}
