import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

// ── Avatar Lab ───────────────────────────────────────────────────────────────
//
// The player's own body, end to end: build one from your own face, adopt it,
// push it into your worlds, then assert on what the pipeline left behind.
//
// The build reads its likeness from the profile picture on your account. That
// is the whole reason a real build can live here: the pipeline's one input
// used to be a file a human picked, so the bench could only ever adopt a body
// somebody had already made — which tests the pointer, not the making. Every
// step except sourcing that photo is a production endpoint, so a green run is
// evidence about the product rather than about the lab.
//
// Adoption has no undo in the product, so the lab carries the one it needs.

const GOLD = "rgba(201,151,58,";
const VERDICT_COLOR = { pass: "rgba(150,210,150,.85)", fail: "rgba(226,120,110,.95)", skip: "rgba(255,255,255,.35)" };

export default function AvatarLabPage() {
  const navigate = useNavigate();

  const [avatar, setAvatar] = useState(null);
  const [actors, setActors] = useState([]);
  const [pick, setPick] = useState("");
  const [push, setPush] = useState(null);
  const [checks, setChecks] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [me, setMe] = useState(null);
  const [age, setAge] = useState("");
  const [job, setJob] = useState(null);

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

  async function refresh() {
    try {
      const [a, list, c, m] = await Promise.all([
        fetch("/api/me/avatar", { credentials: "include" }).then(r => r.json()).catch(() => null),
        fetch("/api/actors", { credentials: "include" }).then(r => r.json()).catch(() => []),
        fetch("/api/test/avatar/checks", { credentials: "include" }).then(r => r.json()).catch(() => null),
        fetch("/api/me", { credentials: "include" }).then(r => r.json()).catch(() => null),
      ]);
      if (a) setAvatar(a);
      if (m?.id) setMe(m);
      const arr = Array.isArray(list) ? list : (list?.actors || []);
      setActors(arr);
      if (!pick && arr[0]) setPick(arr[0].id);
      if (c?.ok) setChecks(c);
    } catch (e) { setError(String(e)); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  // The one long-running action on the bench. Minutes, not seconds: DAZ runs
  // Face Transfer, Blender bakes, and the GLB comes back over the LAN. Only the
  // reference photo is lab-supplied — actor creation, the pipeline and the
  // adoption are all the endpoints the wizard calls.
  async function buildFromProfilePhoto() {
    if (!me?.photo_url) { setError("your account has no profile photo to build from"); return; }
    setBusy("build"); setError(null); setPush(null); setJob({ stage: "creating_actor" });
    try {
      const parts = String(me.name || "").trim().split(/\s+/).filter(Boolean);
      const created = await fetch("/api/actors", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: true, identity: {
          first_name: parts[0] || me.id,
          last_name: parts.slice(1).join(" ") || null,
          age: age === "" ? null : Number(age),
          gender: me.gender || "male",
        } }),
      }).then(r => r.json()).catch(() => ({}));
      if (!created?.id) throw new Error(created?.error || "could not create the actor row");
      const id = created.id;

      setJob({ stage: "attaching_profile_photo", actor_id: id });
      const att = await fetch("/api/test/avatar/use-profile-photo", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_id: id }),
      });
      const attached = await att.json().catch(() => ({}));
      if (!att.ok) throw new Error(attached.error || `attaching the photo failed — HTTP ${att.status}`);

      const started = await fetch(`/api/actors/${id}/generate-3d`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gender: me.gender || "male" }),
      });
      if (!started.ok) {
        const d = await started.json().catch(() => ({}));
        throw new Error(d.error || `generate-3d refused — HTTP ${started.status}`);
      }

      // Poll exactly what the wizard polls, so the bench sees the same stages.
      for (;;) {
        await new Promise(r => setTimeout(r, 5000));
        const s = await fetch(`/api/actors/${id}/generate-3d`, { credentials: "include" })
          .then(r => r.json()).catch(() => null);
        if (!s) continue;
        setJob({ ...s, actor_id: id });
        if (s.stage === "error") throw new Error(s.error || "the pipeline failed");
        if (s.stage === "ready") break;
      }

      // Finish the profile before wearing it. POST /api/actors with an id takes
      // the finalize branch, moving draft -> ready_to_deploy.
      //
      // This is not bookkeeping. A draft is deliberately NOT a ready avatar —
      // the wizard's own close dialog offers "discard changes" and leaves the
      // draft standing, so treating a draft as finished would let somebody who
      // walked away mid-authoring spawn in a body they never completed. This
      // bench built one and adopted it unfinished until Session 160, which is
      // how that hole was found.
      setJob({ stage: "finalising", actor_id: id });
      const finalised = await fetch("/api/actors", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, identity: {
          first_name: parts[0] || me.id,
          last_name: parts.slice(1).join(" ") || null,
          age: age === "" ? null : Number(age),
          gender: me.gender || "male",
        } }),
      });
      if (!finalised.ok) {
        const d = await finalised.json().catch(() => ({}));
        throw new Error(d.error || `could not finish the profile — HTTP ${finalised.status}`);
      }

      // Only now is there a finished body to wear. Adoption pushes on its own.
      const adopted = await fetch("/api/me/avatar", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_id: id }),
      }).then(r => r.json()).catch(() => ({}));
      if (adopted.deploy || adopted.worlds) setPush(adopted.deploy || adopted);
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function adopt() {
    if (!pick) return;
    setBusy("adopt"); setError(null); setPush(null);
    try {
      const r = await fetch("/api/me/avatar", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_id: pick }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      // Adoption pushes on its own — show what came back from it.
      if (d.worlds) setPush(d);
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function deploy() {
    setBusy("deploy"); setError(null);
    try {
      const r = await fetch("/api/me/avatar/deploy", { method: "POST", credentials: "include" });
      const d = await r.json().catch(() => ({}));
      setPush({ ...d, http: r.status });
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function clearAvatar() {
    setBusy("clear"); setError(null);
    try {
      const r = await fetch("/api/test/avatar/clear", { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPush(null);
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  const failing = (checks?.checks || []).filter(c => c.verdict === "fail").length;

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: "rgba(255,255,255,.92)" }}>Test Lab</span>
          <span style={{ ...label, color: GOLD + ".65)" }}>user · avatar</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => navigate("/lab/home")} style={chip(false)}>All tests</button>
          <button onClick={() => navigate("/home")} style={chip(false)}>Close</button>
        </div>
      </div>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "24px 24px 60px",
        display: "flex", flexDirection: "column", gap: 24 }}>

        {/* state */}
        <div style={section}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={label}>Your body, as the platform sees it</span>
            <span style={{ display: "flex", gap: 8 }}>
              {/* The bench reports a verdict; these are the two ways to act on it.
                  Open goes where a person fixes it by hand — a draft is finished in
                  the wizard, and nothing else on this page can finish one. */}
              <button onClick={() => navigate("/me/avatar?lab=avatar")} style={{ ...chip(true), padding: "5px 12px" }}
                title="Open your 3D profile in the wizard — where a draft gets finished">
                Open profile
              </button>
              <button style={{ ...chip(false), padding: "5px 12px" }}
                title="Hand the current state to the watcher: read it, say what it means, act within charter"
                onClick={() => window.dispatchEvent(new CustomEvent("watcher:ask", { detail: { text:
                  `Developer pressed OPEN WITH WATCHER on the Avatar Lab state panel. GET /api/me/avatar ` +
                  `currently reports: state=${avatar?.state ?? "no answer"}, ready=${avatar?.ready ?? "?"}, ` +
                  `status=${avatar?.status ?? "?"}, actor=${avatar?.actor_id ?? "none"}, ` +
                  `has_model=${avatar?.has_model ?? "?"}, has_runtime=${avatar?.has_runtime ?? "?"}. — ` +
                  "Say what that state MEANS for whether this person can enter a world, and what the next " +
                  "action is. avatarStateOf() in server/index.js is the oracle: ready requires a model file " +
                  "AND a status that is not draft, so a draft carrying a 46MB glb is deliberately NOT ready. " +
                  "Your beat spans BOTH hosts: the platform (mac-mini-ubuntu:~/platform, DB ~/platform_dev.db " +
                  "— WAL, so back up with sqlite3 .backup, never a file copy) and the simulator side of the " +
                  "push. Media lives under ~/platform/public/media, NOT ~/platform/media. Code changes via " +
                  "node --check and the restart-flag protocol. Re-run GET /api/test/avatar/checks when done." } }))}>
                Ask watcher
              </button>
              <button onClick={refresh} style={{ ...chip(false), padding: "5px 12px" }}>Refresh</button>
            </span>
          </div>
          {!avatar && <span style={{ fontSize: 11, color: "rgba(255,255,255,.35)" }}>no answer from /api/me/avatar</span>}
          {avatar && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "rgba(255,255,255,.75)" }}>
              <span>
                state <span style={{ color: avatar.state === "ready" ? "rgba(150,210,150,.9)" : avatar.state === "building" ? GOLD + ".9)" : "rgba(255,255,255,.4)" }}>
                  {avatar.state}</span>
                {avatar.name ? ` · ${avatar.name}` : ""}
                {avatar.actor_id ? ` · ${avatar.actor_id.slice(0, 8)}` : ""}
                {avatar.ready ? (avatar.has_runtime ? " · runtime model" : " · base model only") : ""}
              </span>
              <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)", lineHeight: 1.6 }}>
                Two honest middle states, and they need different actions: "building" means a profile exists
                and the pipeline has not produced a body yet — wait. "draft" means a body exists and the
                profile was never finished — open it and finish it. Neither is ready, because readiness is
                not "a file exists": a draft carrying a full model is deliberately refused, or walking away
                mid-wizard would leave somebody wearing a body they never completed. Spawning is gated on
                this server-side — the disabled button on /home is an affordance, not the control.
              </span>
            </div>
          )}
        </div>

        {/* build from the account's own photo */}
        <div style={section}>
          <span style={label}>Build a body from your profile photo — the real pipeline</span>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {me?.photo_url && (
              <img src={me.photo_url} alt="" style={{ width: 44, height: 44, borderRadius: 5,
                objectFit: "cover", border: "0.5px solid rgba(255,255,255,.14)" }} />
            )}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 12, color: "rgba(255,255,255,.75)" }}>
                {me ? (me.name || me.id) : "…"}{me?.gender ? ` · ${me.gender}` : ""}
              </span>
              <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)", fontFamily: "ui-monospace,monospace" }}>
                {me?.photo_url || "no profile photo on this account"}
              </span>
            </div>
            <input value={age} onChange={e => setAge(e.target.value)} placeholder="age"
              inputMode="numeric" style={{ ...field, width: 68 }} />
            <button onClick={buildFromProfilePhoto} disabled={!me?.photo_url || busy} style={chip(true)}>
              {busy === "build" ? "building…" : "Build from my photo"}
            </button>
          </div>
          <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)", lineHeight: 1.6 }}>
            Creates a draft through <span style={{ fontFamily: "ui-monospace,monospace" }}>POST /api/actors</span>, copies
            your account photo in as the <span style={{ fontFamily: "ui-monospace,monospace" }}>state_slug='profile'</span> reference,
            runs <span style={{ fontFamily: "ui-monospace,monospace" }}>generate-3d</span>, then adopts the result. Takes
            minutes — DAZ Face Transfer, a Blender bake and a GLB back over the LAN. Age is passed straight to the
            production endpoint, which does not bound it; the scorecard below is what actually reads it back.
          </span>
          {job && (
            <div style={{ padding: "10px 14px", border: "0.5px solid rgba(255,255,255,.12)", borderRadius: 6,
              display: "flex", flexDirection: "column", gap: 3, fontSize: 11.5, color: "rgba(255,255,255,.8)" }}>
              <span>stage <span style={{ color: job.stage === "ready" ? "rgba(150,210,150,.9)"
                : job.stage === "error" ? "rgba(226,120,110,.95)" : GOLD + ".9)" }}>{job.stage}</span>
                {job.actor_id ? ` · ${job.actor_id.slice(0, 8)}` : ""}</span>
              {job.error && <span style={{ color: "rgba(226,120,110,.95)" }}>{job.error}</span>}
            </div>
          )}
        </div>

        {/* adopt + push */}
        <div style={section}>
          <span style={label}>Adopt a character as yourself — the production path</span>
          <div style={{ display: "flex", gap: 10 }}>
            <select value={pick} onChange={e => setPick(e.target.value)} style={{ ...field, flex: 1 }}>
              {actors.map(a => <option key={a.id} value={a.id}>{a.name}{a.age ? ` · ${a.age}` : ""}</option>)}
            </select>
            <button onClick={adopt} disabled={!pick || busy} style={chip(true)}>
              {busy === "adopt" ? "…" : "Adopt as me"}
            </button>
            <button onClick={deploy} disabled={!avatar?.ready || busy} style={chip(false)}
              title="Re-push the adopted body into every world you belong to">
              {busy === "deploy" ? "…" : "Push to worlds"}
            </button>
            <button onClick={clearAvatar} disabled={!avatar?.actor_id || busy} style={chip(false)}
              title="Lab-only: put the pointer back to none. The product has no undo for adoption.">
              {busy === "clear" ? "…" : "Clear"}
            </button>
          </div>
          <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)", lineHeight: 1.6 }}>
            Adopting writes <span style={{ fontFamily: "ui-monospace,monospace" }}>users.avatar_actor_id</span> and pushes the
            body over the LAN into every world you are a member of — personal media never transits the public tunnel.
            Ownership is checked on the server, so this cannot put someone else's face on you.
          </span>
          {push && (
            <div style={{ padding: "12px 14px", border: `0.5px solid ${GOLD}.3)`, borderRadius: 6, background: GOLD + ".07)",
              display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, color: "rgba(255,255,255,.8)" }}>
              <span>{push.ok ? "pushed to every world" : "push incomplete"}{push.http ? ` · HTTP ${push.http}` : ""}</span>
              {(push.worlds || []).map(w => (
                <span key={w.world_id} style={{ fontSize: 11, color: w.ok ? "rgba(150,210,150,.85)" : "rgba(226,120,110,.95)" }}>
                  {w.world_id.slice(0, 8)} · {w.ok ? `ok · ${(w.models || []).length} model(s)` : w.error}
                </span>
              ))}
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
            A board that cannot go red is not evidence. Several rows here are SKIP until somebody is actually
            wearing a body — a green over nobody would prove nothing.
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
                      `Developer pressed FIX on the failing avatar scorecard check "${c.name}". Its detail: ${c.detail} — ` +
                      "Diagnose the root cause and FIX it within your charter. Your beat spans BOTH hosts here: the platform " +
                      "(mac-mini-ubuntu:~/platform, DB ~/platform_dev.db — WAL, so back up with sqlite3 .backup, never a file copy) " +
                      "and the simulator side of the push. Media lives under ~/platform/public/media, NOT ~/platform/media. " +
                      "Code changes via node --check and the restart-flag protocol. When done, re-run GET /api/test/avatar/checks " +
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
