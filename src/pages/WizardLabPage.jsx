import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

// ── Character Wizard Lab ─────────────────────────────────────────────────────
//
// The authoring surface, not the body it produces. Everything the wizard does
// to the server it does with a fetch whose failure path is a console.error —
// an autosave, a rename, a discard — so this bench is where those become
// visible. The scorecard reads live rows and the wizard's own source; the
// probes walk a throwaway character through the same production endpoints the
// wizard calls, and clean up after themselves.
//
// The probes write, so they are buttons and never part of the nightly sweep.

const GOLD = "rgba(201,151,58,";
const VERDICT_COLOR = { pass: "rgba(150,210,150,.85)", fail: "rgba(226,120,110,.95)", skip: "rgba(255,255,255,.35)" };

const PROBES = [
  {
    key: "lifecycle",
    path: "/api/test/wizard/probe/lifecycle",
    title: "Walk a draft's whole life",
    blurb: "Create → autosave → read back → rename → discard, through the endpoints the wizard calls. " +
      "The rename is run with a real file in the folder, because the interesting half is the folder move " +
      "and the url rewrite, not the row update. Creates one throwaway character and removes it.",
  },
  {
    key: "age-floor",
    path: "/api/test/wizard/probe/age-floor",
    title: "Push a minor through the age floor",
    blurb: "The wizard's Age input carries min={18}, which constrains a native form submission and nothing " +
      "else — what it posts is a React state value. Posts 7, 17, 0, -3, 200 and \"twelve\" straight at " +
      "POST /api/actors, then checks 18 is still accepted and a draft with no age yet still saves.",
  },
  {
    key: "discard-worn-draft",
    path: "/api/test/wizard/probe/discard-worn-draft",
    title: "Discard a draft you are wearing",
    blurb: "Avatar mode adopts the draft at CREATE, so \"finish it later\" is true — and discard then deletes " +
      "a row users.avatar_actor_id still points at. Runs both halves on a throwaway and puts your own " +
      "pointer back. Safe on a real account: a draft with no model is not ready, so adopting it pushes " +
      "nothing to any world.",
  },
];

export default function WizardLabPage() {
  const navigate = useNavigate();

  const [checks, setChecks] = useState(null);
  const [runs, setRuns] = useState({});     // probe key -> { ok, checks, ran_at }
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [drafts, setDrafts] = useState([]);

  const label = { fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "rgba(255,255,255,.42)" };
  const section = { display: "flex", flexDirection: "column", gap: 12, padding: "18px 20px",
    background: "rgba(255,255,255,.025)", border: "0.5px solid rgba(255,255,255,.08)", borderRadius: 6 };
  const chip = (on) => ({ padding: "8px 14px", borderRadius: 4, cursor: "pointer",
    fontFamily: "'DM Sans',sans-serif", fontSize: 11, letterSpacing: ".08em",
    background: on ? GOLD + ".16)" : "transparent",
    border: `0.5px solid ${on ? GOLD + ".5)" : "rgba(255,255,255,.14)"}`,
    color: on ? GOLD + ".95)" : "rgba(255,255,255,.6)" });

  async function refresh() {
    try {
      const [c, list] = await Promise.all([
        fetch("/api/test/wizard/checks", { credentials: "include" }).then(r => r.json()).catch(() => null),
        fetch("/api/actors", { credentials: "include" }).then(r => r.json()).catch(() => []),
      ]);
      if (c?.ok) setChecks(c);
      else if (c?.error) setError(c.error);
      const arr = Array.isArray(list) ? list : (list?.actors || []);
      setDrafts(arr.filter(a => a.status === "draft"));
    } catch (e) { setError(String(e)); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  async function runProbe(probe) {
    setBusy(probe.key); setError(null);
    try {
      const r = await fetch(probe.path, { method: "POST", credentials: "include" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && !d.checks) throw new Error(d.error || `HTTP ${r.status}`);
      setRuns(prev => ({ ...prev, [probe.key]: d }));
      await refresh();   // a probe that left residue must show up on the board
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  const failing = (checks?.checks || []).filter(c => c.verdict === "fail").length;

  const askWatcher = (name, detail) => window.dispatchEvent(new CustomEvent("watcher:ask", { detail: { text:
    `Developer pressed FIX on the failing Character Wizard check "${name}". Its detail: ${detail} — ` +
    "Diagnose the root cause and FIX it within your charter. This bench is platform-side: " +
    "mac-mini-ubuntu:~/platform (wizard at src/pages/CharacterWizard.jsx, its endpoints in server/index.js, " +
    "the board in server/wizardlab-routes.js), DB ~/platform_dev.db — WAL, so back up with sqlite3 .backup, " +
    "never a file copy. Media lives under ~/platform/public/media, NOT ~/platform/media. Edit files in place " +
    "rather than writing them whole, run node --check, and use the restart-flag protocol. When done, re-run " +
    "GET /api/test/wizard/checks and report whether it went green, or exactly why it must stay red." } }));

  const row = (c, i, onFix) => (
    <div key={i} style={{ display: "flex", gap: 10, padding: "7px 0",
      borderTop: i ? "0.5px solid rgba(255,255,255,.06)" : "none" }}>
      <span style={{ ...label, fontSize: 9, minWidth: 34, color: VERDICT_COLOR[c.verdict] }}>{c.verdict}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.75)" }}>{c.name}</div>
        <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.4)", lineHeight: 1.6, marginTop: 2 }}>{c.detail}</div>
      </div>
      {c.verdict === "fail" && onFix && (
        <button onClick={() => onFix(c)}
          title="Hand this failure to the watcher: diagnose, fix within its charter, re-run the check"
          style={{ alignSelf: "flex-start", flex: "none", padding: "4px 10px", borderRadius: 5,
            cursor: "pointer", background: "rgba(201,151,58,.12)",
            border: "0.5px solid rgba(201,151,58,.4)", color: "rgba(201,151,58,.9)",
            fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase",
            fontFamily: "'DM Sans',system-ui,sans-serif" }}>Fix</button>
      )}
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: "rgba(255,255,255,.92)" }}>
            Character · Wizard
          </span>
          <span style={{ ...label, color: GOLD + ".65)" }}>authoring</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => navigate("/actors/new")} style={chip(false)}>Open the wizard</button>
          <button onClick={() => navigate("/lab/home")} style={chip(false)}>Back to the lab</button>
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 24px 60px",
        display: "flex", flexDirection: "column", gap: 16 }}>

        <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.45)", lineHeight: 1.7 }}>
          The wizard is one component holding a seven-step form, an autosave, a server-side rename, a discard
          and a live viewer. Almost everything it asks the server for, it asks with a fetch whose failure path
          is a <span style={{ fontFamily: "ui-monospace,monospace" }}>console.error</span> nobody is reading —
          so a save that did not happen and a rename that half-applied both look, from inside the wizard,
          exactly like success. This bench is where they stop looking like it.
          {drafts.length > 0 && (
            <> Right now there {drafts.length === 1 ? "is" : "are"} <span style={{ color: GOLD + ".9)" }}>
              {drafts.length} draft{drafts.length === 1 ? "" : "s"}</span> the rail would offer for resume.</>
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
            Read-only, so the test manager can sweep it against whatever anybody is working on right now.
            Rows go SKIP when there is nothing to assert about — no drafts, no finished character with a
            snapshot — because a green over an empty table would prove nothing.
          </div>
          <div>{(checks?.checks || []).map((c, i) => row(c, i, (x) => askWatcher(x.name, x.detail)))}</div>
        </div>

        {/* probes */}
        <div style={section}>
          <span style={label}>Probes — these write, and are never swept</span>
          <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)", lineHeight: 1.6 }}>
            Each one drives the production endpoints over loopback carrying your own session, so a green here
            is evidence about the product rather than about the lab. Each creates a throwaway character named
            <span style={{ fontFamily: "ui-monospace,monospace" }}> Labcase …</span> and removes it again,
            including after its own failure.
          </div>
          {PROBES.map(p => {
            const r = runs[p.key];
            const bad = (r?.checks || []).filter(c => c.verdict === "fail").length;
            return (
              <div key={p.key} style={{ display: "flex", flexDirection: "column", gap: 8,
                padding: "12px 14px", border: "0.5px solid rgba(255,255,255,.1)", borderRadius: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 12.5, color: GOLD + ".95)" }}>{p.title}</span>
                  <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    {r && (
                      <span style={{ ...label, fontSize: 9,
                        color: bad ? "rgba(226,120,110,.95)" : "rgba(150,210,150,.85)" }}>
                        {bad ? `${bad} failing` : "all passed"}
                      </span>
                    )}
                    <button onClick={() => runProbe(p)} disabled={!!busy} style={chip(true)}>
                      {busy === p.key ? "running…" : "Run"}
                    </button>
                  </span>
                </div>
                <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.38)", lineHeight: 1.6 }}>{p.blurb}</span>
                {r && (
                  <div>{(r.checks || []).map((c, i) => row(c, i, (x) => askWatcher(x.name, x.detail)))}</div>
                )}
              </div>
            );
          })}
        </div>

      </div>
    </div>
  );
}
