import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

// ── A bench page for a GLOBAL board ──────────────────────────────────────────
//
// The three world-scoped benches each need their own instrument (a fixture, a
// garage, a watch window). A global board needs none of that — it asserts over
// platform state that is the same whichever world you are looking at — so the
// page is the scorecard and nothing else.
//
// One component, two exports, because two copies of this would drift.

const GOLD = "rgba(201,151,58,";

const VERDICT = {
  pass: { color: "#7fc08a" },
  fail: { color: "#e0736b" },
  skip: { color: "rgba(255,255,255,.4)" },
};

function BoardPage({ endpoint, title, kicker, blurb, watcher }) {
  const navigate = useNavigate();
  const [checks, setChecks] = useState(null);
  const [checkedAt, setCheckedAt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const label = { fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase",
    color: "rgba(255,255,255,.4)" };

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(endpoint, { credentials: "include" });
      if (r.status === 401) throw new Error("not signed in on this origin — the API answered 401");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setChecks(Array.isArray(j.checks) ? j.checks : []);
      setCheckedAt(j.checked_at || "");
      setError("");
    } catch (e) {
      // A failed refresh must not leave the previous board on screen looking
      // current — that is the whole reason this page exists.
      setChecks(null);
      setError(String(e.message || e));
    } finally { setBusy(false); }
  }, [endpoint]);

  useEffect(() => { load(); }, [load]);

  const tally = (checks || []).reduce((a, c) => {
    a[c.verdict] = (a[c.verdict] || 0) + 1; return a;
  }, {});

  const btn = (color) => ({
    padding: "7px 14px", borderRadius: 4, cursor: "pointer", background: "transparent",
    border: `0.5px solid ${color || "rgba(255,255,255,.16)"}`,
    fontFamily: "'DM Sans',sans-serif", fontSize: 11, color: color || "rgba(255,255,255,.6)",
  });

  function handToWatcher(c) {
    window.dispatchEvent(new CustomEvent("watcher:ask", { detail: { text:
      `Failing check on the ${title} board — ${watcher}\n\n` +
      `Check: ${c.name}\nDetail: ${c.detail || "(none)"}\n\n` +
      `Diagnose this. Read-only first, and confirm the finding is real before proposing anything: ` +
      `a count or a grep returning 0 indicts the query before it indicts the code, so run a positive ` +
      `control through the same path.` } }));
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span onClick={() => navigate("/lab/home")} style={{ cursor: "pointer",
            fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: "rgba(255,255,255,.92)" }}>Test Lab</span>
          <span style={{ ...label, color: GOLD + ".65)" }}>{kicker}</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => navigate("/lab/home/incidents")} style={btn()}>Incidents</button>
          <button onClick={load} style={btn()}>{busy ? "Checking…" : "Recheck"}</button>
          <button onClick={() => navigate("/lab/home")} style={btn()}>Close</button>
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 24px 80px",
        display: "flex", flexDirection: "column", gap: 18 }}>

        <div style={{ padding: "14px 16px", borderRadius: 5, background: "rgba(255,255,255,.02)",
          border: "0.5px solid rgba(255,255,255,.08)", fontSize: 11.5, lineHeight: 1.75,
          color: "rgba(255,255,255,.5)" }}>{blurb}</div>

        {error && (
          <div style={{ padding: "10px 14px", borderRadius: 4, fontSize: 11.5,
            background: "rgba(224,115,107,.1)", border: "0.5px solid rgba(224,115,107,.35)", color: "#e0736b" }}>
            The board could not be read — {error}. Nothing below is current.
          </div>
        )}

        {checks && (
          <div style={{ display: "flex", gap: 18, alignItems: "baseline" }}>
            {["pass", "fail", "skip"].map(v => (
              <div key={v} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 20,
                  color: VERDICT[v].color }}>{tally[v] || 0}</span>
                <span style={{ ...label, fontSize: 9 }}>{v}</span>
              </div>
            ))}
            {checkedAt && <span style={{ ...label, fontSize: 9, marginLeft: "auto" }}>
              checked {checkedAt.replace("T", " ").slice(0, 19)}
            </span>}
          </div>
        )}

        {checks === null && !error && <span style={label}>Checking…</span>}

        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {(checks || []).map((c, i) => {
            const v = VERDICT[c.verdict] || { color: "#d9a441" };
            return (
              <div key={i} style={{ padding: "11px 14px", borderRadius: 5,
                background: "rgba(255,255,255,.022)", border: "0.5px solid rgba(255,255,255,.09)",
                borderLeftWidth: 2, borderLeftStyle: "solid", borderLeftColor: v.color }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                  <span style={{ fontSize: 12.5, color: "rgba(255,255,255,.88)" }}>{c.name}</span>
                  <span style={{ ...label, fontSize: 9, color: v.color, flexShrink: 0 }}>{c.verdict}</span>
                </div>
                {c.detail && <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.65,
                  color: "rgba(255,255,255,.5)" }}>{c.detail}</div>}
                {c.verdict === "fail" && (
                  <button onClick={() => handToWatcher(c)}
                    style={{ ...btn(GOLD + ".8)"), marginTop: 9, padding: "4px 10px", fontSize: 10 }}>
                    Hand to watcher
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function ShareLabPage() {
  return <BoardPage
    endpoint="/api/test/share/checks"
    kicker="character · sharing · link"
    title="Character · Sharing · Link"
    watcher="Feature - Character Sharing"
    blurb={"The two ways a character leaves its org: a share LINK aimed at whoever holds the URL, " +
      "and the public GALLERY aimed at every signed-in account. Neither may carry “copy” — " +
      "ownership only ever crosses by an act aimed at a known person. Most of this board is probes " +
      "rather than row counts, because a refusal is an invariant that holds at zero rows, and a rule " +
      "asserted only over rows that do not exist yet is not evidence of anything."} />;
}

export function DeployLabPage() {
  return <BoardPage
    endpoint="/api/test/deploy/checks"
    kicker="character · deploy · world"
    title="Character · Deploy · World"
    watcher="Feature - Character Deploy"
    blurb={"Putting a character into a world, asserted over the actor_deployments spine. Read-only " +
      "by design: there is no probe that attempts a deploy, because a deploy that SUCCEEDED would be " +
      "this board putting a body into a live world on a schedule — and the invariant it cares most " +
      "about is that the body is not a minor. It asserts the outcome instead: what is standing in a " +
      "world right now. The player-avatar deploy path stays on the avatar board, which scopes it to " +
      "the people actually wearing one."} />;
}
