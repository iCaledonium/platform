import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

// ── World Behaviour Lab ──────────────────────────────────────────────────────
//
// The autonomous layer is the one thing this lab cannot author. Every other
// bench writes a past and then watches the production path; here there is no
// past to write — the loop either reaches an actor or it does not.
//
// So the instrument is a WATCH WINDOW: sample the census, wait, sample again,
// and show what moved. One sample cannot tell a spinning loop from a frozen
// one; two samples with a clock between them can, and that distinction is the
// whole reason this page exists.

const GOLD = "rgba(201,151,58,";
const VERDICT_COLOR = { pass: "rgba(150,210,150,.85)", fail: "rgba(226,120,110,.95)", skip: "rgba(255,255,255,.35)" };

export default function BehaviorLabPage() {
  const navigate = useNavigate();

  const [worlds, setWorlds] = useState([]);
  const [worldId, setWorldId] = useState("");
  const [pulse, setPulse] = useState(null);
  const [before, setBefore] = useState(null);
  const [watching, setWatching] = useState(0);      // seconds remaining
  const [windowSecs, setWindowSecs] = useState(120);
  const [checks, setChecks] = useState(null);
  const [error, setError] = useState(null);

  const label = { fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "rgba(255,255,255,.42)" };
  const section = { display: "flex", flexDirection: "column", gap: 12, padding: "18px 20px",
    background: "rgba(255,255,255,.025)", border: "0.5px solid rgba(255,255,255,.08)", borderRadius: 6 };
  const field = { padding: "10px 12px", background: "rgba(255,255,255,.04)",
    border: "0.5px solid rgba(255,255,255,.12)", borderRadius: 6, color: "rgba(255,255,255,.85)",
    fontSize: 13, fontFamily: "'DM Sans',sans-serif" };
  const chip = (on) => ({ padding: "8px 14px", borderRadius: 4, cursor: "pointer",
    fontFamily: "'DM Sans',sans-serif", fontSize: 11, letterSpacing: ".08em",
    background: on ? GOLD + ".16)" : "transparent",
    border: `0.5px solid ${on ? GOLD + ".5)" : "rgba(255,255,255,.14)"}`,
    color: on ? GOLD + ".95)" : "rgba(255,255,255,.6)" });

  useEffect(() => {
    (async () => {
      try {
        const ws = await fetch("/api/worlds", { credentials: "include" }).then(r => r.json());
        setWorlds(ws || []);
        let stored = null; try { stored = localStorage.getItem("labWorldId"); } catch {}
        const w = (ws || []).find(x => x.id === stored) || (ws || []).find(x => x.status === "running") || (ws || [])[0];
        if (w) setWorldId(w.id);
      } catch (e) { setError(String(e)); }
    })();
  }, []);

  async function refresh() {
    if (!worldId) return;
    try {
      const [p, c] = await Promise.all([
        fetch(`/api/test/behavior/pulse?world_id=${encodeURIComponent(worldId)}`, { credentials: "include" }).then(r => r.json()),
        fetch(`/api/test/behavior/checks?world_id=${encodeURIComponent(worldId)}`, { credentials: "include" }).then(r => r.json()),
      ]);
      if (p?.ok) setPulse(p);
      if (c?.ok) setChecks(c);
    } catch { /* the panels show their own hints */ }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [worldId]);

  // The watch window: keep the current sample as `before`, count down, then
  // take the second sample. Nothing is forced in between — that is the point.
  function startWatch() {
    if (!pulse) return;
    setBefore(pulse);
    setWatching(windowSecs);
    const started = Date.now();
    const tick = setInterval(() => {
      const left = windowSecs - Math.round((Date.now() - started) / 1000);
      if (left <= 0) { clearInterval(tick); setWatching(0); refresh(); }
      else setWatching(left);
    }, 1000);
  }

  const failing = (checks?.checks || []).filter(c => c.verdict === "fail").length;
  const beforeById = Object.fromEntries((before?.actors || []).map(a => [a.actor_id, a]));
  const elapsed = before && pulse && before.sampled_at !== pulse.sampled_at
    ? Math.round((new Date(pulse.sampled_at) - new Date(before.sampled_at)) / 1000) : null;

  const moved = (now, was, keys) => was ? keys.filter(k => String(now[k]) !== String(was[k])) : [];

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: "rgba(255,255,255,.92)" }}>Test Lab</span>
          <span style={{ ...label, color: GOLD + ".65)" }}>world · behaviour</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {worldId && (
            <button onClick={() => navigate(`/world/${worldId}?lab=behavior`)} style={chip(false)}
              title="The behaviour surface — the live map, lab-stamped so the watcher rides along">
              World map →
            </button>
          )}
          <button onClick={() => navigate("/lab/home")} style={chip(false)}>← All tests</button>
        </div>
      </div>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "24px 24px 60px",
        display: "flex", flexDirection: "column", gap: 24 }}>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={label}>World</span>
          <select value={worldId}
            onChange={e => { setWorldId(e.target.value); try { localStorage.setItem("labWorldId", e.target.value); } catch {} }}
            style={field}>
            {worlds.map(w => <option key={w.id} value={w.id}>{w.name}{w.status === "running" ? "" : " (stopped)"}</option>)}
          </select>
        </div>

        {/* the watch window */}
        <div style={section}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={label}>Watch window — two samples and the clock between them</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {[60, 120, 300].map(s => (
                <button key={s} onClick={() => setWindowSecs(s)} style={{ ...chip(windowSecs === s), padding: "5px 12px" }}>
                  {s < 300 ? `${s}s` : "5 min"}
                </button>
              ))}
              <button onClick={startWatch} disabled={!pulse || watching > 0} style={{ ...chip(true), padding: "5px 14px" }}>
                {watching > 0 ? `watching… ${watching}s` : "Watch"}
              </button>
              <button onClick={refresh} style={{ ...chip(false), padding: "5px 12px" }}>Sample now</button>
            </div>
          </div>
          <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)", lineHeight: 1.6 }}>
            Nothing here forces a tick. One sample cannot tell a loop that spins from a loop that is frozen —
            both look still. Two samples can: a healthy actor's tick age resets, its needs and vitals drift,
            and the action it last picked changes.
          </span>

          {!pulse && <span style={{ fontSize: 11, color: "rgba(255,255,255,.35)" }}>No census yet — the simulator did not answer.</span>}

          {/* A window shorter than the longest next-tick interval CANNOT
              observe a tick, so "no tick in window" would be the instrument
              lying, not the loop failing. Say so before it is armed. */}
          {pulse && pulse.actors.length > 0 && (() => {
            const longest = Math.max(...pulse.actors.map(a => a.next_tick_ms || 0));
            return longest > windowSecs * 1000 ? (
              <span style={{ fontSize: 10.5, color: "rgba(226,180,120,.9)", lineHeight: 1.6 }}>
                Caution: the longest next-tick interval here is {Math.round(longest / 1000)}s, longer than this
                {" "}{windowSecs}s window — an actor can be perfectly healthy and still show "no tick in window".
                Choose a window longer than the interval before reading anything into a still actor.
              </span>
            ) : null;
          })()}

          {pulse && (
            <>
              <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.4)" }}>
                sampled {new Date(pulse.sampled_at).toLocaleTimeString()}
                {elapsed != null && ` · ${elapsed}s after the first sample`}
                {" · "}{pulse.conversations_active} active conversation(s) of {pulse.conversations_total}
                {" · "}{pulse.ambient_cast} ambient in the cast
              </div>
              {pulse.actors.length === 0 && (
                <span style={{ fontSize: 11, color: "rgba(226,120,110,.9)" }}>
                  No character actors present — a stopped world reads exactly like a frozen one here. Start it first.
                </span>
              )}
              {pulse.actors.map(a => {
                const was = beforeById[a.actor_id];
                const changed = moved(a, was, ["last_ticked_at", "last_picked_action", "doing", "activity", "energy", "hunger", "mood", "loneliness", "needs", "thoughts", "location"]);
                const ticking = was && a.last_ticked_at !== was.last_ticked_at;
                return (
                  <div key={a.actor_id} style={{ display: "flex", flexDirection: "column", gap: 4,
                    padding: "10px 12px", background: "rgba(255,255,255,.02)",
                    border: "0.5px solid rgba(255,255,255,.08)", borderRadius: 6 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                      <span style={{ fontSize: 12.5, color: GOLD + ".9)" }}>{a.name}</span>
                      <span style={{ fontSize: 10.5, color: a.tick_age_seconds > 900 ? "rgba(226,120,110,.95)" : "rgba(255,255,255,.45)" }}>
                        ticked {a.tick_age_seconds == null ? "never" : `${a.tick_age_seconds}s ago`}
                        {a.next_tick_ms ? ` · next in ${Math.round(a.next_tick_ms / 1000)}s` : " · no next-tick"}
                      </span>
                      {was && (
                        <span style={{ ...label, fontSize: 9, color: ticking ? "rgba(150,210,150,.85)" : "rgba(226,120,110,.95)" }}>
                          {ticking ? "ticked in window" : "no tick in window"}
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,.6)" }}>
                      {a.doing || "—"}{a.activity ? ` · ${a.activity}` : ""}{a.in_transit ? " · in transit" : ""}
                      {a.is_sleeping ? " · flagged asleep" : ""}{a.sleep_started_at && !a.is_sleeping ? " · sleep clock running, flag says awake" : ""}
                    </span>
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,.35)", fontFamily: "ui-monospace,monospace" }}>
                      energy {a.energy} · hunger {a.hunger} · mood {a.mood} · lonely {a.loneliness} · {a.needs} need(s) · {a.thoughts} thought(s)
                      {a.last_picked_action ? ` · last picked ${a.last_picked_action}` : ""}
                    </span>
                    {was && (
                      <span style={{ fontSize: 10, color: changed.length ? "rgba(150,210,150,.7)" : "rgba(226,120,110,.8)" }}>
                        {changed.length ? `moved: ${changed.join(", ")}` : "nothing moved in the window"}
                      </span>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>

        {error && (
          <div style={{ padding: "10px 14px", borderRadius: 6, background: "rgba(222,140,130,.08)",
            fontSize: 11, color: "rgba(222,140,130,.95)" }}>{error}</div>
        )}

        {/* scorecard */}
        <div style={section}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={label}>Scorecard — assertions against live state</span>
            <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{ ...label, color: failing ? "rgba(226,120,110,.95)" : "rgba(150,210,150,.85)" }}>
                {checks ? (failing ? `${failing} failing` : "no failures") : "…"}
              </span>
              <button onClick={refresh} style={{ ...chip(false), padding: "5px 12px" }}>Recheck</button>
            </span>
          </div>
          <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)", lineHeight: 1.6 }}>
            A board that cannot go red is not evidence. The sleep flag, the inert thoughts and the
            conversations that never close are known defects and are expected to fail here until they are fixed.
          </div>
          <div>
            {(checks?.checks || []).map((c, i) => (
              <div key={i} style={{ display: "flex", gap: 10, padding: "7px 0", borderTop: i ? "0.5px solid rgba(255,255,255,.06)" : "none" }}>
                <span style={{ ...label, fontSize: 9, minWidth: 34, color: VERDICT_COLOR[c.verdict] }}>{c.verdict}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.75)" }}>{c.name}</div>
                  <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.4)", lineHeight: 1.6, marginTop: 2 }}>{c.detail}</div>
                </div>
                {c.verdict === "fail" && (
                  <button
                    title="Hand this failure to the watcher: diagnose, fix within its charter, re-run the check"
                    onClick={() => window.dispatchEvent(new CustomEvent("watcher:ask", { detail: { text:
                      `Developer pressed FIX on the failing world-behaviour check "${c.name}". Its detail: ${c.detail} — ` +
                      "Diagnose the root cause and FIX it within your charter: snapshot first if anything state-destroying, " +
                      "state writes only through the test endpoints, code changes compile-proofed (staged if a restart is " +
                      "needed — do not restart just for this; say so instead). Remember the autonomous loop cannot be forced: " +
                      "prove your fix with a watch window, not a single sample. When done, re-run " +
                      "GET /internal/test/behavior/checks and report whether it went green, or exactly why it must stay red." } }))}
                    style={{ alignSelf: "flex-start", flex: "none", padding: "4px 10px", borderRadius: 5,
                      cursor: "pointer", background: "rgba(201,151,58,.12)",
                      border: "0.5px solid rgba(201,151,58,.4)", color: "rgba(201,151,58,.9)",
                      fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase",
                      fontFamily: "'DM Sans',system-ui,sans-serif" }}>
                    Fix
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
