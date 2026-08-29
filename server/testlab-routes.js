// Extracted from index.js (2026-08-29): these routes live in their own file so
// concurrent whole-file writes to the 340KB index.js can no longer drop them.
// Mounted once from index.js; keep new /api/test/* routes in here.

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

  // Transport bench — /lab/transport/actor
  app.get ("/api/test/transport/context", (req, res) => testLabProxy(req, res, "transport/context"));
  app.get ("/api/test/transport/checks",  (req, res) => testLabProxy(req, res, "transport/checks"));
  app.get ("/api/test/encounter/checks",  (req, res) => testLabProxy(req, res, "encounter/checks"));
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
}
