import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

// ── Sign-In Lab ──────────────────────────────────────────────────────────────
//
// The door: a code, a session, a desktop handoff, a sign-out.
//
// The constraint that shapes this bench: /api/auth/verify answers with a
// Set-Cookie for anima_token. A test login run from THIS page would overwrite
// the session of the person running the test and sign them out of their own
// lab mid-run. So every login here is performed server-side against a
// throwaway @lab.local account that is deleted when the sequence ends; the
// page only ever reads the report.

const GOLD = "rgba(201,151,58,";
const VERDICT_COLOR = { pass: "rgba(150,210,150,.85)", fail: "rgba(226,120,110,.95)", skip: "rgba(255,255,255,.35)" };

export default function SignInLabPage() {
  const navigate = useNavigate();
  const [checks, setChecks] = useState(null);
  const [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

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
      const r = await fetch("/api/test/signin/checks", { credentials: "include" });
      const j = await r.json().catch(() => null);
      if (j?.ok) setChecks(j);
    } catch (e) { setError(String(e)); }
  }
  useEffect(() => { refresh(); }, []);

  async function runProbe() {
    setBusy(true); setError(null); setProbe(null);
    try {
      const r = await fetch("/api/test/signin/probe", { method: "POST", credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setProbe(j);
      refresh();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const failing = (checks?.checks || []).filter(c => c.verdict === "fail").length;
  const stepsFailed = (probe?.steps || []).filter(s => !s.ok).length;

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: "rgba(255,255,255,.92)" }}>Test Lab</span>
          <span style={{ ...label, color: GOLD + ".65)" }}>user · sign in</span>
        </div>
        <button onClick={() => navigate("/lab/home")} style={chip(false)}>← All tests</button>
      </div>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "24px 24px 60px",
        display: "flex", flexDirection: "column", gap: 24 }}>

        {/* the sequence */}
        <div style={section}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={label}>The sequence — a real sign-in, walked end to end</span>
            <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {probe && (
                <span style={{ ...label, color: stepsFailed ? "rgba(226,120,110,.95)" : "rgba(150,210,150,.85)" }}>
                  {stepsFailed ? `${stepsFailed} failing` : "all held"}
                </span>
              )}
              <button onClick={runProbe} disabled={busy} style={{ ...chip(true), padding: "6px 16px" }}>
                {busy ? "running…" : "Run the sequence"}
              </button>
            </span>
          </div>
          <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)", lineHeight: 1.6 }}>
            Runs server-side against a throwaway <span style={{ fontFamily: "ui-monospace,monospace" }}>@lab.local</span> account
            with a real enrolled second factor, then deletes it. It is never run in this browser: a login here answers with a
            Set-Cookie for <span style={{ fontFamily: "ui-monospace,monospace" }}>anima_token</span>, so testing the door from
            the page would sign <em>you</em> out of your own lab halfway through the test.
          </span>
          {probe && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {probe.steps.map((s, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                  <span style={{ ...label, fontSize: 9, minWidth: 30, color: s.ok ? VERDICT_COLOR.pass : VERDICT_COLOR.fail }}>
                    {s.ok ? "held" : "broke"}
                  </span>
                  <span style={{ fontSize: 11.5, color: "rgba(255,255,255,.75)", flex: 1 }}>{s.name}</span>
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,.4)", maxWidth: 380, textAlign: "right" }}>{s.detail}</span>
                </div>
              ))}
              <span style={{ fontSize: 10, color: "rgba(255,255,255,.3)" }}>
                ran {new Date(probe.ran_at).toLocaleTimeString()} · test account {probe.account}
              </span>
            </div>
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
            A board that cannot go red is not evidence. Four properties — replay, ticket reuse, redirect,
            revocation — cannot be read off the database at all; they are the sequence's job, and the board says so
            rather than implying it covers them.
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
                      `Developer pressed FIX on the failing sign-in scorecard check "${c.name}". Its detail: ${c.detail} — ` +
                      "Diagnose the root cause and FIX it within your charter. Your beat is the PLATFORM's auth path " +
                      "(mac-mini-ubuntu:~/platform/server/index.js — /api/auth/verify, /api/auth/handoff/*, /api/auth/signout, " +
                      "auth_tokens, auth_handoff_tickets, user_totp_secrets). DB is ~/platform_dev.db and it is WAL, so back up " +
                      "with sqlite3 .backup, never a file copy. NEVER test a fix by signing in from the browser — verify writes " +
                      "a session cookie and would sign the developer out; use the bench's server-side probe instead. " +
                      "node --check plus the restart-flag protocol for platform-api. When done re-run GET /api/test/signin/checks " +
                      "and the probe, and report whether it went green or exactly why it must stay red." } }))}
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
