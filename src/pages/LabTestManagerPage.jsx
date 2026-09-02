import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

// ── Test Lab · Test manager ──────────────────────────────────────────────────
//
// Runs every bench's board once and files what they say into /lab/home/incidents.
//
// This sweep is STRICTLY READ-ONLY. Every board it touches is a set of
// assertions against live state — none of them author anything. The fixture
// side of the lab (prepare, fixture, transport arm/depart) is deliberately NOT
// here: `prepare` wipes an actor's memories and evicts her live encounter, so a
// button that ran the full benches would destroy the state of whichever world
// somebody happened to be working in. Authored runs stay where a person can see
// what they are about to overwrite.
//
// Targets are PINNED rather than discovered. The same world/actor pairs every
// run is what makes the trend across runs mean anything; sweeping every world ×
// every actor would make the incident count a function of the cast size and
// bury the signal in dead worlds.

const GOLD = "rgba(201,151,58,";

export default function LabTestManagerPage() {
  const navigate = useNavigate();

  const [benches, setBenches] = useState([]);
  const [coverage, setCoverage] = useState(null);
  const [targets, setTargets] = useState([]);
  const [worlds, setWorlds] = useState([]);
  const [actors, setActors] = useState([]);
  const [runs, setRuns] = useState([]);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [openBoards, setOpenBoards] = useState({});
  const [error, setError] = useState("");
  const [authed, setAuthed] = useState(true);

  const [bench, setBench] = useState("encounter");
  const [worldId, setWorldId] = useState("");
  const [actorId, setActorId] = useState("");
  const [tLabel, setTLabel] = useState("");

  const label = { fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase",
    color: "rgba(255,255,255,.4)" };

  const btn = (color, disabled) => ({
    padding: "7px 14px", borderRadius: 4, cursor: disabled ? "default" : "pointer",
    background: "transparent", border: `0.5px solid ${color || "rgba(255,255,255,.16)"}`,
    fontFamily: "'DM Sans',sans-serif", fontSize: 11,
    color: disabled ? "rgba(255,255,255,.25)" : (color || "rgba(255,255,255,.6)"),
  });

  const input = {
    padding: "6px 9px", borderRadius: 3, background: "rgba(255,255,255,.04)",
    border: "0.5px solid rgba(255,255,255,.12)", color: "rgba(255,255,255,.8)",
    fontFamily: "'DM Sans',sans-serif", fontSize: 11, outline: "none",
  };

  const spec = benches.find(b => b.key === bench);

  const loadTargets = useCallback(async () => {
    try {
      const r = await fetch("/api/test/sweep/targets", { credentials: "include" });
      if (r.status === 401) { setAuthed(false); setTargets([]); return; }
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setTargets(Array.isArray(j.targets) ? j.targets : []);
    } catch (e) { setError(String(e.message || e)); }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const j = await fetch("/api/test/sweep/runs?limit=12", { credentials: "include" }).then(r => r.json());
      setRuns(Array.isArray(j.runs) ? j.runs : []);
    } catch { /* the history is a nicety; its absence is not a fault */ }
  }, []);

  useEffect(() => {
    fetch("/api/test/benches", { credentials: "include" })
      .then(r => { if (r.status === 401) setAuthed(false); return r.json(); })
      .then(j => { setBenches(Array.isArray(j.benches) ? j.benches : []); setCoverage(j.coverage || null); })
      .catch(e => setError(String(e.message || e)));
    (async () => {
      try {
        const r = await fetch("/api/worlds", { credentials: "include" });
        if (r.status === 401) { setAuthed(false); setWorlds([]); return; }
        const ws = await r.json();
        // Anything that is not an array is not a world list. Storing one
        // costs the whole app: there is no error boundary above this page.
        if (!Array.isArray(ws)) { setWorlds([]); setError("the world list came back in a shape this page cannot read"); return; }
        setWorlds(ws);
        const running = ws.find(w => w.status === "running") || ws[0];
        if (running) setWorldId(running.id);
      } catch (e) { setWorlds([]); setError(String(e.message || e)); }
    })();
    loadTargets();
    loadRuns();
  }, [loadTargets, loadRuns]);

  // Same ambient filter the other benches use: the ambient cast populates
  // venues, has no home and no schedule, and was never knock-on-able.
  useEffect(() => {
    if (!worldId) { setActors([]); return; }
    (async () => {
      try {
        const pr = await fetch(`/api/worlds/${worldId}/presence`, { credentials: "include" });
        if (pr.status === 401) { setAuthed(false); setActors([]); return; }
        const p = await pr.json();
        const list = (Array.isArray(p?.locations) ? p.locations : []).flatMap(l => (l.actors || [])
          .filter(a => !a.is_ambient && a.actor_type !== "ambient")
          .map(a => ({ id: a.actor_id, name: a.name })));
        const seen = new Set();
        const uniq = list.filter(a => !seen.has(a.id) && seen.add(a.id))
                         .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        setActors(uniq);
        if (uniq.length && !uniq.some(a => a.id === actorId)) setActorId(uniq[0].id);
      } catch { setActors([]); }
    })();
  }, [worldId]);

  async function post(url, body) {
    const r = await fetch(url, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  async function addTarget() {
    try {
      const w = worlds.find(x => x.id === worldId);
      const a = actors.find(x => x.id === actorId);
      const j = await post("/api/test/sweep/targets", {
        bench, world_id: worldId,
        actor_id: spec?.needs_actor ? actorId : null,
        label: tLabel || [w?.name, spec?.needs_actor ? a?.name : null].filter(Boolean).join(" · "),
      });
      setTargets(j.targets); setTLabel(""); setError("");
    } catch (e) { setError(String(e.message || e)); }
  }

  async function runSweep() {
    setRunning(true); setError(""); setResult(null);
    try {
      const j = await post("/api/test/sweep/run", {});
      setResult(j);
      setOpenBoards({});
      loadRuns();
    } catch (e) { setError(String(e.message || e)); }
    finally { setRunning(false); }
  }

  const globals = benches.filter(b => !b.scoped);
  const configured = new Set(targets.filter(t => t.enabled).map(t => t.bench));

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span onClick={() => navigate("/lab/home")} style={{ cursor: "pointer",
            fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: "rgba(255,255,255,.92)" }}>Test Lab</span>
          <span style={{ ...label, color: GOLD + ".65)" }}>test manager</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => navigate("/lab/home/incidents")} style={btn(GOLD + ".7)")}>Incidents</button>
          <button onClick={() => navigate("/lab/home")} style={btn()}>Close</button>
        </div>
      </div>

      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "24px 24px 80px",
        display: "flex", flexDirection: "column", gap: 26 }}>

        <div style={{ padding: "14px 16px", borderRadius: 5, background: "rgba(255,255,255,.02)",
          border: "0.5px solid rgba(255,255,255,.08)", fontSize: 11.5, lineHeight: 1.75,
          color: "rgba(255,255,255,.5)" }}>
          Runs every bench's scorecard once against the pinned targets below and files each
          failing row as an incident. <strong style={{ color: "rgba(255,255,255,.7)" }}>Read-only</strong> —
          nothing here authors a past, wipes a memory or moves an actor, so it is safe to run
          against a world somebody is working in, and safe on a schedule.
          The fixture-driven runs stay on their own bench pages, where you can see what you are
          about to overwrite.
        </div>

        {!authed && (
          <div style={{ padding: "10px 14px", borderRadius: 4, fontSize: 11.5, lineHeight: 1.7,
            background: "rgba(217,164,65,.1)", border: "0.5px solid rgba(217,164,65,.35)", color: "#d9a441" }}>
            Not signed in on this origin — the API answered 401. The pickers and the sweep
            will stay empty until you log in; an empty picker here is not evidence that a
            world has no actors.
          </div>
        )}

        {error && authed && (
          <div style={{ padding: "10px 14px", borderRadius: 4, fontSize: 11.5,
            background: "rgba(224,115,107,.1)", border: "0.5px solid rgba(224,115,107,.35)", color: "#e0736b" }}>
            {error}
          </div>
        )}

        {/* ── Run ─────────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={label}>Sweep</span>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={runSweep} disabled={running}
              style={{ ...btn(GOLD + ".85)", running), padding: "9px 20px", fontSize: 12 }}>
              {running ? "Sweeping…" : "Run all boards"}
            </button>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,.4)" }}>
              {targets.filter(t => t.enabled).length} pinned target(s) · {globals.length} global board(s)
            </span>
          </div>

          {/* A board with a live /api/test/<key>/checks route that the sweep
              knows nothing about. This is the failure that prompted the check:
              two benches were added by other sessions and the manager kept
              reporting a clean sweep while measuring a subset. */}
          {coverage?.unwired?.length > 0 && (
            <div style={{ fontSize: 11, lineHeight: 1.7, color: "#e0736b" }}>
              Boards this sweep does NOT cover: {coverage.unwired.join(", ")}.
              Each has a live scorecard route and no entry in the catalogue, so nothing
              here measures it — add it to BENCHES in server/lab-incidents.js.
            </div>
          )}

          {coverage?.missing?.length > 0 && (
            <div style={{ fontSize: 11, lineHeight: 1.7, color: "#c96fd0" }}>
              Catalogued but no longer served: {coverage.missing.join(", ")}.
              A renamed or removed board would otherwise show up only as one that
              mysteriously never fails.
            </div>
          )}

          {coverage && !coverage.unwired?.length && !coverage.missing?.length && (
            <div style={{ fontSize: 10.5, color: "rgba(150,210,150,.65)" }}>
              Every scorecard route on this server is in the sweep ({coverage.detected.length} boards).
            </div>
          )}

          {benches.filter(b => b.scoped && !configured.has(b.key)).length > 0 && (
            <div style={{ fontSize: 11, lineHeight: 1.7, color: "#d9a441" }}>
              Not measured by a sweep — no enabled target:{" "}
              {benches.filter(b => b.scoped && !configured.has(b.key)).map(b => b.label).join(", ")}.
              An unconfigured bench is not a green one.
            </div>
          )}

          {result && (
            <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 4 }}>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                {[["boards read", result.boards_ok, "#7fc08a"],
                  ["unreadable", result.boards_errored, "#c96fd0"],
                  ["checks", result.checks_total, "rgba(255,255,255,.7)"],
                  ["passed", result.passed, "#7fc08a"],
                  ["failed", result.failed, "#e0736b"],
                  ["skipped", result.skipped, "rgba(255,255,255,.4)"],
                  ["opened", result.opened, "#e0736b"],
                  ["reopened", result.reopened, "#d9a441"],
                  ["resolved", result.resolved, "#7fc08a"]].map(([k, v, c]) => (
                  <div key={k} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 19, color: c }}>{v}</span>
                    <span style={{ ...label, fontSize: 9 }}>{k}</span>
                  </div>
                ))}
              </div>

              {(result.boards || []).map((b, i) => {
                const rollable = b.state === "read" && Array.isArray(b.roll) && b.roll.length > 0;
                const isOpen = !!openBoards[i];
                const vc = { pass: "#7fc08a", fail: "#e0736b", skip: "rgba(255,255,255,.4)" };
                return (
                  <div key={i} style={{ borderRadius: 4, background: "rgba(255,255,255,.02)",
                    border: "0.5px solid rgba(255,255,255,.08)", fontSize: 11 }}>
                    <div onClick={() => rollable && setOpenBoards(o => ({ ...o, [i]: !isOpen }))}
                      style={{ display: "flex", justifyContent: "space-between", gap: 12,
                        padding: "9px 12px", cursor: rollable ? "pointer" : "default" }}>
                      <span style={{ color: "rgba(255,255,255,.75)" }}>
                        {rollable && <span style={{ color: "rgba(255,255,255,.3)", marginRight: 6 }}>{isOpen ? "\u25be" : "\u25b8"}</span>}
                        {b.label} <span style={{ color: "rgba(255,255,255,.35)" }}>\u00b7 {b.scope}</span>
                      </span>
                      <span style={{ color: b.state === "read" ? "rgba(255,255,255,.5)"
                        : b.state === "unreachable" ? "#c96fd0" : "#d9a441", textAlign: "right" }}>
                        {b.state === "read"
                          ? `${b.passed} pass \u00b7 ${b.failed} fail \u00b7 ${b.skipped} skip`
                          : `${b.state} \u2014 ${b.detail}`}
                      </span>
                    </div>

                    {/* Every assertion this board makes, passes included. The
                        incident page shows only what failed; this is the board. */}
                    {isOpen && (
                      <div style={{ borderTop: "0.5px solid rgba(255,255,255,.07)", padding: "4px 0" }}>
                        {b.roll.map((c, j) => (
                          <div key={j} style={{ display: "flex", gap: 10, padding: "6px 12px 6px 26px",
                            alignItems: "baseline" }}>
                            <span style={{ ...label, fontSize: 8.5, minWidth: 34, flexShrink: 0,
                              color: vc[c.verdict] || "#d9a441" }}>{c.verdict}</span>
                            <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                              <span style={{ color: "rgba(255,255,255,.72)", fontSize: 10.5 }}>{c.name}</span>
                              {c.detail && <span style={{ color: "rgba(255,255,255,.35)", fontSize: 9.5,
                                lineHeight: 1.55 }}>{c.detail}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              <button onClick={() => navigate("/lab/home/incidents")}
                style={{ ...btn(GOLD + ".8)"), alignSelf: "flex-start" }}>
                See the incidents
              </button>
            </div>
          )}
        </div>

        {/* ── Targets ─────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={label}>Pinned targets</span>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select value={bench} onChange={e => setBench(e.target.value)} style={input}>
              {benches.filter(b => b.scoped).map(b => (
                <option key={b.key} value={b.key} style={{ background: "#151310" }}>{b.label}</option>
              ))}
            </select>
            <select value={worldId} onChange={e => setWorldId(e.target.value)} style={input}>
              <option value="" style={{ background: "#151310" }}>— world —</option>
              {worlds.map(w => (
                <option key={w.id} value={w.id} style={{ background: "#151310" }}>
                  {w.name} {w.status === "running" ? "· running" : `· ${w.status}`}
                </option>
              ))}
            </select>
            {spec?.needs_actor && (
              <select value={actorId} onChange={e => setActorId(e.target.value)} style={input}>
                <option value="" style={{ background: "#151310" }}>— actor —</option>
                {actors.map(a => (
                  <option key={a.id} value={a.id} style={{ background: "#151310" }}>{a.name}</option>
                ))}
              </select>
            )}
            <input value={tLabel} onChange={e => setTLabel(e.target.value)}
              placeholder="label (optional)" style={{ ...input, width: 180 }} />
            <button onClick={addTarget} style={btn()}>Pin</button>
          </div>

          {targets.length === 0 && (
            <span style={{ fontSize: 11, color: "rgba(255,255,255,.35)" }}>
              Nothing pinned yet — the three world-scoped boards cannot run without a target.
            </span>
          )}

          {targets.map(t => (
            <div key={t.id} style={{ display: "flex", justifyContent: "space-between", gap: 12,
              alignItems: "center", padding: "9px 12px", borderRadius: 4,
              background: t.enabled ? "rgba(255,255,255,.022)" : "rgba(255,255,255,.008)",
              border: "0.5px solid rgba(255,255,255,.08)" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <span style={{ fontSize: 11.5, color: t.enabled ? "rgba(255,255,255,.8)" : "rgba(255,255,255,.35)" }}>
                  {benches.find(b => b.key === t.bench)?.label || t.bench}
                  {t.label ? <span style={{ color: "rgba(255,255,255,.45)" }}> · {t.label}</span> : null}
                </span>
                <span style={{ fontSize: 9.5, fontFamily: "ui-monospace,monospace", color: "rgba(255,255,255,.28)" }}>
                  world {t.world_id}{t.actor_id ? ` · actor ${t.actor_id}` : ""}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button style={{ ...btn(), padding: "4px 9px", fontSize: 10 }}
                  onClick={async () => {
                    try {
                      const j = await post(`/api/test/sweep/targets/${t.id}/enabled`, { enabled: !t.enabled });
                      setTargets(j.targets);
                    } catch (e) { setError(String(e.message || e)); }
                  }}>{t.enabled ? "Disable" : "Enable"}</button>
                <button style={{ ...btn(), padding: "4px 9px", fontSize: 10 }}
                  onClick={async () => {
                    try {
                      const j = await post(`/api/test/sweep/targets/${t.id}/delete`, {});
                      setTargets(j.targets);
                    } catch (e) { setError(String(e.message || e)); }
                  }}>Remove</button>
              </div>
            </div>
          ))}
        </div>

        {/* ── History ─────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={label}>Recent runs</span>
          {runs.length === 0 && <span style={{ fontSize: 11, color: "rgba(255,255,255,.35)" }}>No sweep has run yet.</span>}
          {runs.map(r => (
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 12,
              padding: "8px 12px", borderRadius: 4, background: "rgba(255,255,255,.018)",
              border: "0.5px solid rgba(255,255,255,.07)", fontSize: 10.5 }}>
              <span style={{ color: "rgba(255,255,255,.55)" }}>
                {r.started_at.replace("T", " ").slice(0, 19)}
                <span style={{ color: "rgba(255,255,255,.3)" }}> · {r.source}</span>
                {!r.finished_at && <span style={{ color: "#d9a441" }}> · did not finish</span>}
              </span>
              <span style={{ color: "rgba(255,255,255,.45)" }}>
                {r.boards_ok} board(s){r.boards_errored ? ` · ${r.boards_errored} unreadable` : ""} ·{" "}
                <span style={{ color: r.failed ? "#e0736b" : "#7fc08a" }}>{r.failed} fail</span> ·{" "}
                {r.passed} pass · {r.skipped} skip · {r.opened} new · {r.resolved} closed
              </span>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 10.5, lineHeight: 1.8, color: "rgba(255,255,255,.32)",
          borderTop: "0.5px solid rgba(255,255,255,.07)", paddingTop: 14 }}>
          On a schedule, from any host with ssh to the platform:{" "}
          <code style={{ color: "rgba(255,255,255,.45)" }}>
            ssh mac-mini-ubuntu 'node ~/platform/server/lab-incidents-cli.mjs sweep --source routine:nightly'
          </code>
          {" "}— that path covers the three simulator boards; the signup board lives inside the
          running platform-api process and is swept by the button above.
        </div>
      </div>
    </div>
  );
}
