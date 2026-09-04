import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

// ── Test Lab · Resolution manager ────────────────────────────────────────────
//
// A status window onto the always-alive daemon that runs on the local Mac
// (anima-watcher-bridge/resolution-manager.mjs) — this page does not run
// anything itself, it only polls what the daemon last pushed over ssh via
// resolution-manager-cli.mjs into the `resolution_manager` table. There is
// exactly one of these, so there is exactly one status row.
//
// idle    — no incident currently being worked.
// active  — up to MAX_CONCURRENT (6, 2026-09-04) incidents worked at once,
//           full fault-triage authority (real code edits, service restarts
//           under the broker protocol — never a git commit).
// Six concurrent workers against two real repos means several can land on
// the same repo at once — a deliberate tradeoff (Magnus, 2026-09-04:
// throughput over the safer default of one worker per host) — so a
// clobbered edit or a false compile/restart verification from a
// same-repo collision is a real possibility here, not a hypothetical.
//
// On success a worker closes its incident itself over the incidents CLI.
// When it cannot safely finish one alone, it sets that incident to "needs
// acknowledgement" with a note explaining what it needs, and moves on.

const GOLD = "rgba(201,151,58,";

const ago = (iso) => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso + (iso.endsWith("Z") ? "" : "Z")).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export default function ResolutionManagerPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/test/resolution-manager/status", { credentials: "include" });
      if (r.status === 401) throw new Error("not signed in on this origin — the API answered 401");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setStatus(j.status);
      setError("");
    } catch (e) {
      setError(String(e.message || e));
    } finally { setBusy(false); }
  }, []);

  // The daemon pushes its status once per worker start/finish, not
  // continuously — a person watching this page wants to see "it just
  // picked something up" within a few seconds, so poll rather than wait
  // for a manual refresh.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const label = { fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase",
    color: "rgba(255,255,255,.4)" };

  const btn = (color) => ({
    padding: "4px 9px", borderRadius: 3, cursor: "pointer", background: "transparent",
    border: `0.5px solid ${color || "rgba(255,255,255,.16)"}`,
    fontFamily: "'DM Sans',sans-serif", fontSize: 10,
    color: color || "rgba(255,255,255,.55)",
  });

  const workers = status?.active_workers || [];
  const active = workers.length > 0;
  const stateColor = active ? "#d9a441" : "#7fc08a";
  // Staleness matters more here than on the incidents board: a daemon that
  // crashed leaves its last row saying "active" forever. No update in well
  // over an hour, while claiming active, reads as stuck rather than working.
  const staleMs = status?.updated_at
    ? Date.now() - new Date(status.updated_at + (status.updated_at.endsWith("Z") ? "" : "Z")).getTime()
    : null;
  const stale = staleMs != null && staleMs > 60 * 60 * 1000;

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span onClick={() => navigate("/lab/home")} style={{ cursor: "pointer",
            fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: "rgba(255,255,255,.92)" }}>Test Lab</span>
          <span style={{ ...label, color: GOLD + ".65)" }}>resolution manager</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => navigate("/lab/home/incidents")} style={btn(GOLD + ".7)")}>Incidents</button>
          <button onClick={load} style={btn()}>{busy ? "Loading…" : "Refresh"}</button>
          <button onClick={() => navigate("/lab/home")} style={btn()}>Close</button>
        </div>
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 24px 80px",
        display: "flex", flexDirection: "column", gap: 20 }}>

        {error && (
          <div style={{ padding: "10px 14px", borderRadius: 4, fontSize: 11.5,
            background: "rgba(224,115,107,.1)", border: "0.5px solid rgba(224,115,107,.35)", color: "#e0736b" }}>
            The status could not be read — {error}.
          </div>
        )}

        {status && (
          <>
            <div style={{ padding: "18px 20px", borderRadius: 6,
              background: "rgba(255,255,255,.022)", border: "0.5px solid rgba(255,255,255,.09)",
              borderLeft: `2px solid ${stale ? "#e0736b" : stateColor}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 22, fontFamily: "'Cormorant Garamond',Georgia,serif",
                  color: stale ? "#e0736b" : stateColor, textTransform: "uppercase", letterSpacing: ".08em" }}>
                  {stale ? "not responding" : active ? `active · ${workers.length}/6` : "idle"}
                </span>
                <span style={{ ...label, fontSize: 9 }}>last update {ago(status.updated_at)}</span>
              </div>

              {active && !stale && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  {workers.map((w, i) => (
                    <div key={`${w.bench}:${w.check_name}:${i}`}
                      style={{ fontSize: 12.5, color: "rgba(255,255,255,.8)" }}>
                      Working <strong>{w.check_name}</strong>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", marginTop: 2 }}>
                        {w.bench} · started {ago(w.started_at)}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!active && !stale && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: "rgba(255,255,255,.45)" }}>
                  Nothing to do right now — watching the incidents board for the next open one.
                </div>
              )}

              {stale && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: "rgba(255,255,255,.5)" }}>
                  No status pushed in over an hour. Check it is still running:{" "}
                  <code style={{ color: "rgba(255,255,255,.4)" }}>
                    launchctl print gui/501/com.anima.resolution-manager
                  </code>{" "}on the local Mac.
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontSize: 20, color: "#7fc08a",
                  fontFamily: "'Cormorant Garamond',Georgia,serif" }}>{status.resolved_count ?? 0}</span>
                <span style={{ ...label, fontSize: 9 }}>resolved</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontSize: 20, color: "#d9a441",
                  fontFamily: "'Cormorant Garamond',Georgia,serif" }}>{status.flagged_count ?? 0}</span>
                <span style={{ ...label, fontSize: 9 }}>flagged</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontSize: 13, color: "rgba(255,255,255,.6)",
                  fontFamily: "'Cormorant Garamond',Georgia,serif" }}>{ago(status.last_run_at)}</span>
                <span style={{ ...label, fontSize: 9 }}>last run</span>
              </div>
            </div>

            {(status.recent || []).length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={label}>Recent activity</span>
                {status.recent.map((r, i) => {
                  const needsAck = r.status === "acknowledged";
                  return (
                    <div key={`${r.fingerprint || r.check_name}:${i}`}
                      style={{ padding: "10px 12px", borderRadius: 4,
                        background: needsAck ? GOLD + ".04)" : "rgba(255,255,255,.02)",
                        border: `0.5px solid ${needsAck ? GOLD + ".3)" : "rgba(255,255,255,.08)"}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.75)" }}>{r.check_name}</div>
                          <div style={{ fontSize: 9.5, color: "rgba(255,255,255,.4)", marginTop: 2 }}>
                            {r.bench} · {needsAck ? "needs acknowledgement" : "resolved"} · {ago(r.finished_at)}
                          </div>
                        </div>
                        {needsAck ? (
                          <button
                            onClick={() => navigate(`/lab/home/incidents?status=acknowledged&bench=${encodeURIComponent(r.bench)}`)}
                            style={{ ...btn(GOLD + ".9)"), background: GOLD + ".14)", flexShrink: 0 }}>
                            Needs you
                          </button>
                        ) : (
                          <button
                            onClick={() => navigate(`/lab/home/incidents?status=resolved&bench=${encodeURIComponent(r.bench)}`)}
                            style={{ ...btn(), flexShrink: 0 }}>
                            View
                          </button>
                        )}
                      </div>
                      {/* The whole point of this row: WHY it needs a human, right
                          here — not a click through to Incidents and an expand
                          toggle to find out. Every flag carries a note (the
                          worker's own diagnosis, or the daemon's safety-net text
                          when a turn ended without one); this is the one place
                          it always shows without another click. */}
                      {r.note && (
                        <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.6,
                          color: needsAck ? "rgba(255,255,255,.8)" : "rgba(255,255,255,.5)",
                          borderTop: `0.5px solid ${needsAck ? GOLD + ".18)" : "rgba(255,255,255,.06)"}`,
                          paddingTop: 7 }}>
                          {r.note}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        <div style={{ fontSize: 10.5, lineHeight: 1.8, color: "rgba(255,255,255,.32)",
          borderTop: "0.5px solid rgba(255,255,255,.07)", paddingTop: 14 }}>
          Same authority and guardrails as the <em>fault-triage</em> routine — real code edits and
          service restarts under the restart-flag broker protocol, never a git commit (both repos
          carry other sessions' uncommitted work — a person reviews and commits afterwards), never
          past an ANIMA-INVARIANT line, never a fix it did not verify. Up to <strong>6</strong>{" "}
          incidents at once (Magnus, 2026-09-04) — with only two real repos behind them, several
          workers can land on the same one at the same time, so a clobbered edit or a false
          compile/restart verification from a same-repo collision is a real possibility, not a
          hypothetical. When a worker cannot finish one safely alone it sets that incident to{" "}
          <em>needs acknowledgement</em> with a note explaining what it needs, and moves on to the
          next one rather than blocking on it. Nothing here decides what counts as "safely" —
          that is still the fault-triage playbook's own judgment, unattended, exactly as it works
          today.
        </div>
      </div>
    </div>
  );
}
