import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

// ── Signup Lab ───────────────────────────────────────────────────────────────
//
// The invite → enroll → org pipeline, driven through the PRODUCTION endpoints
// with the admin session this page already has. Same rule as every lab: no
// side doors — a minted test user walks the same path a real invitee walks.
// Test users are branded @lab.local so cleanup can never sweep a real person.

const GOLD = "rgba(201,151,58,";
const VERDICT_COLOR = { pass: "rgba(150,210,150,.85)", fail: "rgba(226,120,110,.95)", skip: "rgba(255,255,255,.35)" };

export default function SignupLabPage() {
  const navigate = useNavigate();

  const [tier, setTier] = useState("staff");
  const [name, setName] = useState("");
  const [minted, setMinted] = useState(null);   // { user, invite_path, expires_at }
  const [inviteProbe, setInviteProbe] = useState(null);
  const [qr, setQr] = useState(null);
  const [code, setCode] = useState("");
  const [confirmResult, setConfirmResult] = useState(null);
  const [labUsers, setLabUsers] = useState([]);
  const [checks, setChecks] = useState(null);
  const [busy, setBusy] = useState(null);
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

  async function refreshLabUsers() {
    try {
      const d = await fetch("/api/admin/users", { credentials: "include" }).then(r => r.json());
      setLabUsers((d.users || d || []).filter(u => (u.email || "").endsWith("@lab.local")));
    } catch { /* non-admins simply see no list */ }
  }
  async function refreshChecks() {
    try {
      const r = await fetch("/api/test/signup/checks", { credentials: "include" });
      const j = await r.json().catch(() => null);
      if (j && j.ok) setChecks(j);
    } catch { /* board shows its own hint */ }
  }
  useEffect(() => { refreshLabUsers(); refreshChecks(); }, []);

  async function mint() {
    setBusy("mint"); setError(null); setMinted(null); setInviteProbe(null); setQr(null); setConfirmResult(null);
    try {
      const suffix = Math.random().toString(36).slice(2, 7);
      const testName = name.trim() || `Signup Test ${suffix}`;
      const r = await fetch("/api/admin/users", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: testName, email: `signup-${suffix}@lab.local`, tier }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setMinted(d);
      refreshLabUsers(); refreshChecks();
      // Walk step 1 immediately: does the minted token open the invite door?
      const token = d.invite_path.split("/").pop();
      const p = await fetch(`/api/invite/${token}`, { credentials: "include" });
      setInviteProbe({ status: p.status, body: await p.json().catch(() => null) });
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function startEnroll() {
    if (!minted) return;
    setBusy("enroll"); setError(null);
    try {
      const token = minted.invite_path.split("/").pop();
      const r = await fetch("/api/enroll/start", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setQr(d.qr);
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function confirmEnroll() {
    if (!minted || !code.trim()) return;
    setBusy("confirm"); setError(null);
    try {
      const token = minted.invite_path.split("/").pop();
      const r = await fetch("/api/enroll/confirm", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: code.trim() }),
      });
      const d = await r.json();
      setConfirmResult(r.ok ? { ok: true } : { ok: false, error: d.error || `HTTP ${r.status}` });
      if (r.ok) { refreshLabUsers(); refreshChecks(); }
    } catch (e) { setConfirmResult({ ok: false, error: e.message }); } finally { setBusy(null); }
  }

  async function eraseUser(id) {
    setBusy("erase"); setError(null);
    try {
      const r = await fetch(`/api/admin/users/${id}?purge=1`, { method: "DELETE", credentials: "include" });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
      refreshLabUsers(); refreshChecks();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  const failing = (checks?.checks || []).filter(c => c.verdict === "fail").length;

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: "rgba(255,255,255,.92)" }}>Test Lab</span>
          <span style={{ ...label, color: GOLD + ".65)" }}>user · signup · creation</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => navigate("/lab/home")} style={chip(false)}>All tests</button>
          <button onClick={() => navigate("/home")} style={chip(false)}>Close</button>
        </div>
      </div>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "24px 24px 60px",
        display: "flex", flexDirection: "column", gap: 24 }}>

        {/* mint */}
        <div style={section}>
          <span style={label}>Mint a test signup — the production path, a throwaway person</span>
          <div style={{ display: "flex", gap: 10 }}>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="name (auto if empty)"
              style={{ ...field, flex: 1 }} />
            <button onClick={() => setTier("staff")} style={chip(tier === "staff")}>staff</button>
            <button onClick={() => setTier("personal")} style={chip(tier === "personal")}
              title="Also births a personal org — the tenancy path worth testing">personal</button>
            <button onClick={mint} disabled={busy}
              style={{ ...chip(true), padding: "8px 22px" }}>{busy === "mint" ? "…" : "Create + invite"}</button>
          </div>
          <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)", lineHeight: 1.6 }}>
            Email is always <span style={{ fontFamily: "ui-monospace,monospace" }}>signup-*@lab.local</span> — cleanup below can never touch a real account.
            Every mint births a personal org the person administers; a staff mint also joins them to this org as a member.
          </span>
          {minted && (
            <div style={{ padding: "12px 14px", border: `0.5px solid ${GOLD}.3)`, borderRadius: 6, background: GOLD + ".07)",
              display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "rgba(255,255,255,.8)" }}>
              <span>{minted.user.name} · {minted.user.email} · {minted.user.tier} · acting in {minted.user.org_id}{minted.user.personal_org_id ? ` · owns ${minted.user.personal_org_id}` : ""}</span>
              <span>
                invite: <a onClick={() => navigate(minted.invite_path)}
                  style={{ color: GOLD + ".9)", textDecoration: "underline", cursor: "pointer", fontFamily: "ui-monospace,monospace", fontSize: 11 }}>
                  {minted.invite_path}</a> · expires {new Date(minted.expires_at).toLocaleString()}
              </span>
              {inviteProbe && (
                <span style={{ fontSize: 11, color: inviteProbe.status === 200 ? "rgba(150,210,150,.85)" : "rgba(226,120,110,.95)" }}>
                  invite door: HTTP {inviteProbe.status}{inviteProbe.body?.name ? ` — greets "${inviteProbe.body.name}"` : ""}
                </span>
              )}
            </div>
          )}
        </div>

        {/* walk the flow */}
        <div style={section}>
          <span style={label}>Walk the flow — TOTP enrolment, for real</span>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <button onClick={startEnroll} disabled={!minted || busy} style={chip(false)}>
              {busy === "enroll" ? "…" : "Start enrolment (QR)"}
            </button>
            {qr && (
              <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                <img src={qr} alt="TOTP QR" style={{ width: 140, height: 140, borderRadius: 6 }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,.5)", maxWidth: 300, lineHeight: 1.6 }}>
                    Scan with an authenticator, then confirm with the 6-digit code — the same
                    ceremony a real invitee performs. Nothing here fakes the second factor.
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input value={code} onChange={e => setCode(e.target.value)} placeholder="123456" maxLength={6}
                      style={{ ...field, width: 110, fontFamily: "ui-monospace,monospace" }} />
                    <button onClick={confirmEnroll} disabled={busy || code.trim().length !== 6} style={chip(true)}>
                      {busy === "confirm" ? "…" : "Confirm"}
                    </button>
                  </div>
                  {confirmResult && (
                    <span style={{ fontSize: 11, color: confirmResult.ok ? "rgba(150,210,150,.85)" : "rgba(226,120,110,.95)" }}>
                      {confirmResult.ok ? "enrolled — the account is live" : confirmResult.error}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* cleanup */}
        <div style={section}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={label}>Lab users — @lab.local only</span>
            <button onClick={refreshLabUsers} style={{ ...chip(false), padding: "5px 12px" }}>Refresh</button>
          </div>
          {labUsers.length === 0 && (
            <span style={{ fontSize: 11, color: "rgba(255,255,255,.35)" }}>none — every minted test user was cleaned up</span>
          )}
          {labUsers.map(u => (
            <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "rgba(255,255,255,.7)" }}>
              <span style={{ flex: 1 }}>{u.name} · {u.email} · {u.status}{u.user_type === "personal" ? " · personal org" : ""}</span>
              <button onClick={() => eraseUser(u.id)} disabled={busy}
                style={{ ...chip(false), padding: "4px 12px", borderColor: "rgba(222,140,130,.4)", color: "rgba(222,140,130,.9)" }}>
                Erase
              </button>
            </div>
          ))}
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
              <button onClick={refreshChecks} style={{ ...chip(false), padding: "5px 12px" }}>Recheck</button>
            </span>
          </div>
          <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)", lineHeight: 1.6 }}>
            A board that cannot go red is not evidence. The TOTP orphan and the unenforced world:control scopes are expected to fail until actually fixed.
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
                      `Developer pressed FIX on the failing signup scorecard check "${c.name}". Its detail: ${c.detail} — ` +
                      "Diagnose the root cause and FIX it within your charter. Your beat is the PLATFORM " +
                      "(mac-mini-ubuntu:~/platform, DB ~/platform_dev.db): DB corrections need a backup first " +
                      "(sqlite3 .backup — file copies are stale under WAL), code changes go through node --check " +
                      "and the restart-flag protocol for platform-api. When done, re-run GET /api/test/signup/checks " +
                      "and report whether it went green, or exactly why it must stay red." } }))}
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
