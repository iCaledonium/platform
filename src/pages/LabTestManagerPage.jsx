import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import LabCaseAdmin from "../components/LabCaseAdmin.jsx";

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
  const [runs, setRuns] = useState([]);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [openBoards, setOpenBoards] = useState({});
  const [error, setError] = useState("");
  const [authed, setAuthed] = useState(true);

  const [bench, setBench] = useState("encounter");
  const [worldId, setWorldId] = useState("");
  const [actorId, setActorId] = useState("");

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
    loadRuns();
  }, [loadRuns]);

  // Same ambient filter the other benches use: the ambient cast populates
  // venues, has no home and no schedule, and was never knock-on-able.

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
Test cases live in categories. Build SUITES from individual cases or whole
          categories, then run a suite here or give it a schedule. Everything a suite runs is
          READ-ONLY — nothing authors a past, wipes a memory or moves an actor — so a suite is
          safe against a world somebody is working in, and safe unattended.
          The fixture-driven runs stay on their own category pages, where you can see what you
          are about to overwrite.
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

        {/* ── Administration ───────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={label}>Test cases</span>
          <LabCaseAdmin onChanged={() => {}} />
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
          {" "}— that runs the same sweep as the button above, over every board, by asking the
          platform-api process to do it rather than duplicating it out of process.
        </div>
      </div>
    </div>
  );
}
