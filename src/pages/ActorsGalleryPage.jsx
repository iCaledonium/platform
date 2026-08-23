import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import DeployWizardModal from "./DeployWizardModal.jsx";

const STYLE_COLOR = {
  fearful_avoidant:  { bg: "rgba(55,138,221,.10)",  border: "rgba(55,138,221,.2)",  text: "#185fa5", init: "rgba(55,138,221,.15)" },
  avoidant_secure:   { bg: "rgba(29,158,117,.10)",  border: "rgba(29,158,117,.2)",  text: "#0f6e56", init: "rgba(29,158,117,.15)" },
  avoidant:          { bg: "rgba(29,158,117,.10)",  border: "rgba(29,158,117,.2)",  text: "#0f6e56", init: "rgba(29,158,117,.15)" },
  secure_anxious:    { bg: "rgba(176,92,8,.10)",    border: "rgba(176,92,8,.2)",    text: "#854f0b", init: "rgba(176,92,8,.15)"   },
  anxious:           { bg: "rgba(212,83,126,.10)",  border: "rgba(212,83,126,.2)",  text: "#993556", init: "rgba(212,83,126,.15)" },
  secure:            { bg: "rgba(99,153,34,.10)",   border: "rgba(99,153,34,.2)",   text: "#3b6d11", init: "rgba(99,153,34,.15)"  },
  default:           { bg: "rgba(136,135,128,.10)", border: "rgba(136,135,128,.2)", text: "#5f5e5a", init: "rgba(136,135,128,.15)"},
};

function sc(s) { return STYLE_COLOR[s] || STYLE_COLOR.default; }
function ini(name) { return name?.split(" ").map(n=>n[0]).join("").slice(0,2).toUpperCase()||"?"; }

const COMPLETION = [
  { check: () => true },
  { check: a => !!a.wound },
  { check: a => a.openness != null },
  { check: () => false },
  { check: () => false },
  { check: a => !!a.alcohol_relationship },
  { check: a => !!a.financial_situation },
  { check: () => false },
];

function ShareIcon({ color="#6b6760" }) {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
      <circle cx="9.5" cy="2.5" r="1.5" stroke={color} strokeWidth="1"/>
      <circle cx="9.5" cy="9.5" r="1.5" stroke={color} strokeWidth="1"/>
      <circle cx="2.5" cy="6"   r="1.5" stroke={color} strokeWidth="1"/>
      <line x1="3.9" y1="5.25" x2="8.1" y2="3.25" stroke={color} strokeWidth="1"/>
      <line x1="3.9" y1="6.75" x2="8.1" y2="8.75" stroke={color} strokeWidth="1"/>
    </svg>
  );
}

const PERM_STYLE = {
  read: { bg:"rgba(136,135,128,.1)",  fg:"#5f5e5a", br:"rgba(136,135,128,.2)" },
  use:  { bg:"rgba(55,138,221,.1)",   fg:"#185FA5", br:"rgba(55,138,221,.22)" },
  copy: { bg:"rgba(99,153,34,.1)",    fg:"#3b6d11", br:"rgba(99,153,34,.2)"   },
};

function ShareModal({ actor, onClose }) {
  const [shares, setShares]   = useState([]);
  const [users, setUsers]     = useState([]);
  const [selected, setSelected] = useState("");
  const [perm, setPerm]       = useState("read");
  const [reshare, setReshare] = useState(false);
  const [error, setError]     = useState(null);
  const [saving, setSaving]   = useState(false);

  useEffect(() => {
    fetch(`/api/actors/${actor.id}/shares`)
      .then(r => r.ok ? r.json() : [])
      .then(setShares)
      .catch(() => {});
    fetch("/api/users")
      .then(r => r.ok ? r.json() : [])
      .then(setUsers)
      .catch(() => {});
  }, [actor.id]);

  const alreadySharedIds = new Set(shares.map(s => s.shared_with_id));
  const available = users.filter(u => !alreadySharedIds.has(u.id));

  async function addShare() {
    if (!selected) return;
    const target = users.find(u => u.id === selected);
    if (!target) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/actors/${actor.id}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: target.email, permission: perm, can_reshare: reshare }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); setSaving(false); return; }
      setShares(prev => [...prev, { shared_with_id: data.shared_with_id, name: data.name, email: target.email, permission: data.permission, can_reshare: data.can_reshare ? 1 : 0 }]);
      setSelected(""); setReshare(false);
    } catch { setError("Something went wrong"); }
    setSaving(false);
  }

  // Session 150 — the rungs, spelled out. "Can clone" used to be the only
  // alternative to read, and it granted a capability with no implementation.
  const PERM_HELP = {
    read: "Can open her profile. Cannot deploy or change anything.",
    use:  "Can deploy her into a world they own. Their world instance is theirs to edit; this profile is never touched.",
    copy: "Can take a full copy that becomes their own character, editable without limit and never synced back.",
  };

  async function removeShare(sharedWithId) {
    await fetch(`/api/actors/${actor.id}/shares/${sharedWithId}`, { method: "DELETE" });
    setShares(prev => prev.filter(s => s.shared_with_id !== sharedWithId));
  }

  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(26,24,20,.4)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:"20px" }}>
      <div onClick={e => e.stopPropagation()} style={{ background:"rgba(255,255,255,.97)", borderRadius:20, width:"100%", maxWidth:520, boxShadow:"0 8px 48px rgba(0,0,0,.18)" }}>

        <div style={{ padding:"18px 22px 14px", borderBottom:"1px solid rgba(0,0,0,.07)", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div>
            <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:22, fontWeight:400, color:"#1a1814" }}>Share · {actor.name}</div>
            <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0", marginTop:2 }}>Who can see, play or copy this character</div>
          </div>
          <button onClick={onClose} style={{ width:30, height:30, borderRadius:"50%", background:"rgba(0,0,0,.06)", border:"none", cursor:"pointer", fontSize:14, color:"#6b6760", display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
        </div>

        <div style={{ padding:"16px 22px" }}>
          <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, letterSpacing:".15em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:8 }}>Add person</div>
          <div style={{ display:"flex", gap:7, marginBottom: error ? 6 : 16 }}>
            {available.length === 0
              ? <div style={{ flex:1, fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, color:"#a8a5a0", padding:"8px 12px", borderRadius:10, border:"1px solid rgba(0,0,0,.07)", background:"rgba(0,0,0,.03)" }}>Everyone in your organisation has access</div>
              : <select value={selected} onChange={e => setSelected(e.target.value)}
                  style={{ flex:1, fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, padding:"8px 12px", borderRadius:10, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.8)", color: selected ? "#1a1814" : "#a8a5a0" }}>
                  <option value="">Select person...</option>
                  {available.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
            }
            {available.length > 0 && <>
              <select value={perm} onChange={e => setPerm(e.target.value)} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, padding:"8px 10px", borderRadius:10, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.8)", color:"#1a1814" }}>
                <option value="read">Read</option>
                <option value="use">Use</option>
                <option value="copy">Copy</option>
              </select>
              <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer", whiteSpace:"nowrap" }}>
                <input type="checkbox" checked={reshare} onChange={e => setReshare(e.target.checked)} />
                <span style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#6b6760" }}>may re-share</span>
              </label>
              <button onClick={addShare} disabled={saving||!selected} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, letterSpacing:".06em", textTransform:"uppercase", padding:"8px 16px", borderRadius:10, background:"#1a1814", color:"#faf8f4", border:"none", cursor:"pointer", opacity: (saving||!selected) ? .4 : 1 }}>
                {saving ? "..." : "Share"}
              </button>
            </>}
          </div>
          {/* Session 150 — say what the chosen rung actually permits. The old
              dialog offered "Read only / Can clone" with no explanation, and
              "clone" granted a capability that had no implementation. */}
          {available.length > 0 && (
            <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0", margin:"-4px 0 12px", lineHeight:1.55 }}>
              <b style={{ fontWeight:500, color: PERM_STYLE[perm].fg }}>{perm}</b> — {PERM_HELP[perm]}
            </div>
          )}
          {error && <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, color:"#c0392b", marginBottom:10 }}>{error}</div>}

          {shares.length > 0 ? (
            <>
              <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, letterSpacing:".15em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:8 }}>Shared with</div>
              {shares.map(s => (
                <div key={s.shared_with_id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"9px 0", borderBottom:"1px solid rgba(0,0,0,.05)" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ width:30, height:30, borderRadius:"50%", background:"rgba(176,92,8,.1)", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, fontWeight:500, color:"#854f0b", flexShrink:0 }}>{ini(s.name)}</div>
                    <div>
                      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#1a1814" }}>{s.name}</div>
                      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0" }}>{s.email}</div>
                    </div>
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, letterSpacing:".07em", padding:"3px 8px", borderRadius:5, background: PERM_STYLE[s.permission||"read"].bg, color: PERM_STYLE[s.permission||"read"].fg, border: `1px solid ${PERM_STYLE[s.permission||"read"].br}` }}>
                      {s.permission || "read"}{s.can_reshare ? " · can re-share" : ""}
                    </span>
                    <button onClick={() => removeShare(s.shared_with_id)} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#c0c0b8", background:"none", border:"none", cursor:"pointer", padding:0 }}>Remove</button>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0", paddingTop:4 }}>Not shared with anyone yet.</p>
          )}
        </div>

        <div style={{ padding:"10px 22px 20px", borderTop:"1px solid rgba(0,0,0,.05)" }}>
          
        </div>
      </div>
    </div>
  );
}

function ActorCard({ actor, shared, owned, onShare, onDelete, onDeploy, onUndeploy, deployed, worlds, onClick }) {
  const c = sc(actor.attachment_style);
  const dots = COMPLETION.map(s => s.check(actor));

  return (
    <div style={{ background:"rgba(255,255,255,.72)", backdropFilter:"blur(40px) saturate(200%)", WebkitBackdropFilter:"blur(40px) saturate(200%)", border:"1px solid rgba(255,255,255,.95)", boxShadow:"0 2px 32px rgba(0,0,0,.06), 0 1px 0 rgba(255,255,255,1) inset", borderRadius:18, padding:"1.4rem 1.2rem 1.2rem", cursor:"pointer", transition:"border-color .15s, box-shadow .15s", position:"relative" }}
      onClick={onClick}
      onMouseEnter={e => { e.currentTarget.style.borderColor="rgba(55,138,221,.25)"; e.currentTarget.style.boxShadow="0 4px 40px rgba(0,0,0,.09), 0 1px 0 rgba(255,255,255,1) inset"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor="rgba(255,255,255,.95)"; e.currentTarget.style.boxShadow="0 2px 32px rgba(0,0,0,.06), 0 1px 0 rgba(255,255,255,1) inset"; }}>

      {owned && (
        <>
          <div onClick={e => { e.stopPropagation(); onShare(actor); }}
            title={`Share ${actor.name}`}
            style={{ position:"absolute", top:10, right: deployed ? 10 : 40, width:26, height:26, borderRadius:"50%", background:"rgba(255,255,255,.8)", border:"1px solid rgba(0,0,0,.08)", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", zIndex:1 }}
            onMouseEnter={e => { e.currentTarget.style.background="#fff"; e.currentTarget.style.borderColor="rgba(0,0,0,.18)"; }}
            onMouseLeave={e => { e.currentTarget.style.background="rgba(255,255,255,.8)"; e.currentTarget.style.borderColor="rgba(0,0,0,.08)"; }}>
            <ShareIcon />
          </div>
          {!deployed && (
            <div onClick={e => { e.stopPropagation(); onDelete(actor); }}
              title={`Delete ${actor.name} permanently`}
              style={{ position:"absolute", top:10, right:10, width:26, height:26, borderRadius:"50%", background:"rgba(255,255,255,.8)", border:"1px solid rgba(0,0,0,.08)", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", zIndex:1, fontSize:12, color:"#c0392b" }}
              onMouseEnter={e => { e.currentTarget.style.background="#fff2f2"; e.currentTarget.style.borderColor="rgba(192,57,43,.3)"; }}
              onMouseLeave={e => { e.currentTarget.style.background="rgba(255,255,255,.8)"; e.currentTarget.style.borderColor="rgba(0,0,0,.08)"; }}>
              ✕
            </div>
          )}
          {onDeploy && (
            <div onClick={e => { e.stopPropagation(); onDeploy(actor.id); }}
              style={{ position:"absolute", bottom:10, right:10, padding:"4px 10px", borderRadius:8, background:"#1a1814", color:"#faf8f4", fontSize:10, fontFamily:"'DM Sans',system-ui,sans-serif", letterSpacing:".08em", textTransform:"uppercase", cursor:"pointer", zIndex:1 }}>
              Deploy →
            </div>
          )}

        </>
      )}

      {shared && (
        <div style={{ position:"absolute", top:10, right:10, fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, letterSpacing:".1em", textTransform:"uppercase", color:"#a8a5a0", border:"1px solid rgba(0,0,0,.08)", borderRadius:5, padding:"2px 6px" }}>
          {actor.permission || "read"}
        </div>
      )}

      {actor.photo_url
        ? <img src={actor.photo_url} alt={actor.name} style={{ width:44, height:44, borderRadius:"50%", objectFit:"cover", marginBottom:12, border:`1px solid ${c.border}` }} />
        : <div style={{ width:44, height:44, borderRadius:"50%", background:c.init, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:15, fontWeight:500, color:c.text, marginBottom:12 }}>{ini(actor.name)}</div>
      }

      <p style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:3, lineHeight:1.1 }}>{actor.name}</p>
      <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0", marginBottom:10, lineHeight:1.5 }}>{actor.occupation||"—"}</p>

      {/* Session 150 — the "In Play · <world>" sections are gone, so the card
          carries that fact itself.
          
          Each chip is also the control for its own world. Undeploy used to be a
          bare ↓ in the corner, which named neither the action nor which world it
          would act on — the worlds were listed elsewhere on the card entirely.
          Putting the × on the chip makes the target the thing you click. */}
      {worlds?.length > 0 && (
        <div style={{ marginBottom:10 }}>
          <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:8.5, letterSpacing:".16em",
            textTransform:"uppercase", color:"#a8a5a0", marginBottom:5 }}>In play</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
            {worlds.map(w => (
              <span key={w.id} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9.5, letterSpacing:".04em",
                padding:"3px 4px 3px 8px", borderRadius:5, background:"rgba(29,158,117,.1)", color:"#0F6E56",
                border:"1px solid rgba(29,158,117,.22)", display:"inline-flex", alignItems:"center", gap:6 }}>
                <span style={{ width:4, height:4, borderRadius:"50%", background:"#1D9E75", flexShrink:0 }} />
                {w.name}
                {onUndeploy && (
                  <span onClick={e => { e.stopPropagation(); onUndeploy(actor, w); }}
                    title={`Remove from ${w.name}`}
                    style={{ display:"inline-flex", alignItems:"center", justifyContent:"center",
                      width:14, height:14, borderRadius:4, fontSize:9, lineHeight:1,
                      color:"rgba(15,110,86,.5)", cursor:"pointer", flexShrink:0 }}
                    onMouseEnter={e => { e.currentTarget.style.background="rgba(192,57,43,.12)"; e.currentTarget.style.color="#993c1d"; }}
                    onMouseLeave={e => { e.currentTarget.style.background="transparent"; e.currentTarget.style.color="rgba(15,110,86,.5)"; }}>
                    ✕
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {actor.attachment_style && (
        <span style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, letterSpacing:".08em", padding:"3px 8px", borderRadius:5, background:c.bg, color:c.text, border:`1px solid ${c.border}`, display:"inline-block", marginBottom:10 }}>
          {actor.attachment_style.replace(/_/g," ")}
        </span>
      )}

      <div style={{ display:"flex", gap:4, paddingTop:6, borderTop:"1px solid rgba(0,0,0,.05)" }}>
        {dots.map((on,i) => <div key={i} style={{ width:5, height:5, borderRadius:"50%", background: on ? "#34c759" : "#d1cfca" }} />)}
      </div>
    </div>
  );
}

function SectionLabel({ label, count, children }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: open ? 0 : "2.5rem" }}>
      <div onClick={() => setOpen(p => !p)} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer", marginBottom: open ? 14 : 0, userSelect:"none" }}>
        <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, letterSpacing:".2em", textTransform:"uppercase", color:"#a8a5a0", margin:0 }}>{label}{count!=null?` · ${count}`:""}</p>
        <span style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, color:"#c8c5c0" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && children}
    </div>
  );
}

export default function ActorsGalleryPage() {
  const [owned, setOwned]             = useState([]);
  const [shared, setShared]           = useState([]);
  const [deployedIds, setDeployedIds] = useState(new Set());
  const [deployments, setDeployments] = useState([]);
  const [shareActor, setShareActor]   = useState(null);
  const [deployActor, setDeployActor] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    document.title = "Anima — Character profiles";
    fetch("/api/actors").then(r => r.ok ? r.json() : []).then(setOwned).catch(() => {});
    fetch("/api/actors/shared").then(r => r.ok ? r.json() : []).then(setShared).catch(() => {});
    fetch("/api/actors/deployments").then(r => r.ok ? r.json() : []).then(d => {
      setDeployments(d);
      setDeployedIds(new Set(d.map(x => x.platform_actor_id)));
    }).catch(() => {});
  }, []);

  const deleteActor = async (id) => {
    await fetch(`/api/actors/${id}`, { method: "DELETE" });
    setOwned(p => p.filter(a => a.id !== id));
  };

  // Session 150 — window.confirm() is SUPPRESSED in some embedded browser
  // contexts: it returns false without ever showing a dialog. Every control
  // gated on `if (confirm(...))` therefore did nothing at all when clicked, with
  // no error and no network request — which is exactly how the undeploy arrow
  // presented. alert() is unreliable in the same way, so failures were invisible
  // too. Both are replaced with in-page UI, which also works in every context.
  const [confirmAction, setConfirmAction] = useState(null);  // {title, body, label, danger, run}
  const [actionError,   setActionError]   = useState(null);

  const undeployActor = async (id, worldId) => {
    // Session 150 — this used to fire and update local state unconditionally,
    // never looking at the response. A failed undeploy therefore LOOKED like it
    // worked: the card vanished from "In play" and came back on the next
    // reload, because the actor was still deployed the whole time. Check the
    // result, and only drop her from the list if the server agrees.
    try {
      const res  = await fetch(`/api/actors/${id}/undeploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world_id: worldId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setActionError(`Undeploy failed: ${data.error || `HTTP ${res.status}`}`);
        return;
      }
      setActionError(null);

      // Session 150 — drop only the world she was actually removed from.
      //
      // These two lines used to clear her from deployedIds outright and filter
      // EVERY deployment she had, whichever world the undeploy targeted. For a
      // character in one world that is indistinguishable from correct. For a
      // character in two it was plainly wrong: undeploying her from one world
      // erased both chips and brought back the delete button — offering to
      // permanently delete a character who was still live somewhere, which the
      // deployed guard exists precisely to prevent.
      //
      // still_deployed_elsewhere comes from the server, which has just looked at
      // the deployment rows inside the same request. Deriving it from local
      // state instead would re-guess something the server already answered.
      setDeployments(p => p.filter(d => !(d.platform_actor_id === id && d.world_id === worldId)));
      if (!data.still_deployed_elsewhere) {
        setDeployedIds(p => { const next = new Set(p); next.delete(id); return next; });
      }
    } catch (e) {
      setActionError(`Undeploy failed: ${e.message}`);
    }
  };

  // Session 150 — a character can be deployed to several worlds, so "undeploy"
  // is not a single action. With one world we still name it, because "this
  // world" told you nothing about which one you were about to erase her from.
  const ERASE_NOTE = "Her instance in that world is erased — relationships, memories, schedule, bank account. The profile is kept and can be deployed again.";

  // Called from a world chip, so the world is normally already known — the
  // picker below is the fallback for any caller that has not named one.
  const askUndeploy = (actor, world) => {
    const ws = worldsByActor[actor.id] || [];
    const target = world || (ws.length === 1 ? ws[0] : null);

    if (!ws.length) {
      setActionError(`${actor.name} isn't deployed to any world.`);
      return;
    }
    if (target) {
      setConfirmAction({
        title: `Remove ${actor.name} from ${target.name}?`,
        body: ERASE_NOTE,
        label: `Remove from ${target.name}`,
        danger: false,
        run: () => undeployActor(actor.id, target.id),
      });
      return;
    }
    setConfirmAction({
      title: `Remove ${actor.name} from which world?`,
      body: `She's deployed to ${ws.length} worlds. Removing her from one leaves the others untouched. ${ERASE_NOTE}`,
      choices: ws.map(w => ({ label: w.name, run: () => undeployActor(actor.id, w.id) })),
    });
  };

  const askDelete = (actor) => setConfirmAction({
    title: `Permanently delete ${actor.name}?`,
    body: "This cannot be undone. The character and everything belonging to her are removed.",
    label: "Delete permanently",
    danger: true,
    run: () => deleteActor(actor.id),
  });

  // Session 150 — one shelf, not two.
  //
  // This page used to split into "In Play · <world>" sections plus a "Not in
  // play" remainder, which made it a view of DEPLOYMENTS wearing a character
  // gallery's clothes: the same character appeared under each world she was in,
  // and where a profile sat depended on world state rather than on the profile.
  // Worlds now have their own pages (/my-worlds/:worldId), and this is the
  // template shelf — every profile, in one place, whether or not it is live.
  //
  // Session 103 (user law) still holds: half-built drafts stay out. They live in
  // the wizard's drafts rail and nowhere else.
  const profiles = owned.filter(a => a.status !== "draft");

  // actorId -> the worlds she is currently deployed to. The card shows these,
  // because the sections that used to convey it are gone.
  const worldsByActor = deployments.reduce((acc, d) => {
    (acc[d.platform_actor_id] ||= []).push({ id: d.world_id, name: d.world_name || d.world_id });
    return acc;
  }, {});

  return (
    <div style={{ background:"#eeecea", minHeight:"100vh", position:"relative" }}>
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:0, background:"radial-gradient(ellipse at 12% 18%, rgba(230,180,100,.22) 0%, transparent 45%), radial-gradient(ellipse at 88% 78%, rgba(160,185,230,.18) 0%, transparent 45%), #eeecea" }} />
      <div style={{ position:"relative", zIndex:1, maxWidth:900, margin:"0 auto", padding:"2rem 1.5rem 4rem" }}>

        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"2.5rem" }}>
          <div style={{ display:"flex", alignItems:"center", gap:14 }}>
            <a href="/home" style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, letterSpacing:".08em", textTransform:"uppercase", color:"#a8a5a0", textDecoration:"none" }}>← Home</a>
            <span style={{ color:"#d1cfca", fontSize:14 }}>/</span>
            <span style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:24, fontWeight:500, letterSpacing:".22em", textTransform:"uppercase", color:"#1a1814" }}>Character profiles</span>
          </div>
          <button onClick={() => navigate("/actors/new")} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, letterSpacing:".06em", textTransform:"uppercase", padding:"10px 22px", borderRadius:10, background:"#1a1814", color:"#faf8f4", border:"none", cursor:"pointer" }}>New character +</button>
        </div>

        {profiles.length > 0 && (
          <SectionLabel label="Available character profiles" count={profiles.length}>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(170px,1fr))", gap:12, marginBottom:"2.5rem" }}>
              {profiles.map(a => {
                const isDeployed = deployedIds.has(a.id);
                return <ActorCard key={a.id} actor={a} owned deployed={isDeployed}
                  worlds={worldsByActor[a.id]}
                  onShare={setShareActor} onDelete={askDelete}
                  onDeploy={id => setDeployActor(owned.find(x => x.id === id))}
                  onUndeploy={askUndeploy}
                  onClick={() => navigate(`/actors/${a.id}`)} />;
              })}
            </div>
          </SectionLabel>
        )}

        {shared.length > 0 && (() => {
          // Same reasoning as above — shared profiles are profiles, not deployments.
          const sharedProfiles = shared.filter(a => a.status !== "draft");
          return (
            <>
              {sharedProfiles.length > 0 && (
                <SectionLabel label="Shared with you" count={sharedProfiles.length}>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(170px,1fr))", gap:12, marginBottom:"2.5rem" }}>
                    {sharedProfiles.map(a => <ActorCard key={a.id} actor={a} shared worlds={worldsByActor[a.id]} onClick={() => navigate(`/actors/${a.id}`)} />)}
                  </div>
                </SectionLabel>
              )}
            </>
          );
        })()}

        {owned.length===0 && shared.length===0 && (
          <div style={{ textAlign:"center", padding:"4rem 2rem" }}>
            <p style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:22, color:"#1a1814", marginBottom:8 }}>No characters yet</p>
            <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0", marginBottom:24 }}>Create your first character to get started.</p>
            <button onClick={() => navigate("/actors/new")} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, letterSpacing:".06em", textTransform:"uppercase", padding:"10px 22px", borderRadius:10, background:"#1a1814", color:"#faf8f4", border:"none", cursor:"pointer" }}>New character +</button>
          </div>
        )}
      </div>

      {shareActor && <ShareModal actor={shareActor} onClose={() => setShareActor(null)} />}

      {/* Session 150 — an in-page confirmation, replacing window.confirm(),
          which is silently suppressed in embedded browser contexts: it returns
          false without showing anything, so the control it gated simply did
          nothing when clicked. */}
      {confirmAction && (
        <div onClick={() => setConfirmAction(null)}
          style={{ position:"fixed", inset:0, zIndex:2000, background:"rgba(238,236,234,.72)",
            backdropFilter:"blur(10px)", WebkitBackdropFilter:"blur(10px)",
            display:"flex", alignItems:"center", justifyContent:"center", padding:"1.5rem" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:"rgba(255,255,255,.96)", border:"1px solid rgba(255,255,255,.95)",
              boxShadow:"0 8px 64px rgba(0,0,0,.14)", borderRadius:18, maxWidth:440, width:"100%", padding:"22px 24px" }}>
            <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:19, fontWeight:500, color:"#1a1814", marginBottom:8 }}>
              {confirmAction.title}
            </div>
            <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#6b6760", lineHeight:1.55, marginBottom:18 }}>
              {confirmAction.body}
            </div>
            {/* A choice, not a yes/no. Used when the action needs a target —
                undeploying a character who is in more than one world. */}
            {confirmAction.choices ? (
              <>
                <div style={{ display:"flex", flexDirection:"column", gap:7, marginBottom:16 }}>
                  {confirmAction.choices.map(ch => (
                    <button key={ch.label}
                      onClick={() => { const a = confirmAction; setConfirmAction(null); ch.run(); }}
                      style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, padding:"11px 14px", borderRadius:10,
                        border:"1px solid rgba(0,0,0,.12)", background:"rgba(255,255,255,.7)", color:"#1a1814",
                        cursor:"pointer", textAlign:"left", display:"flex", alignItems:"center", gap:9 }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor="rgba(0,0,0,.28)"; e.currentTarget.style.background="#fff"; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor="rgba(0,0,0,.12)"; e.currentTarget.style.background="rgba(255,255,255,.7)"; }}>
                      <span style={{ width:6, height:6, borderRadius:"50%", background:"#1D9E75", flexShrink:0 }} />
                      {ch.label}
                    </button>
                  ))}
                </div>
                <div style={{ display:"flex", justifyContent:"flex-end" }}>
                  <button onClick={() => setConfirmAction(null)}
                    style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, padding:"8px 16px", borderRadius:9,
                      border:"1px solid rgba(0,0,0,.12)", background:"none", color:"#6b6760", cursor:"pointer" }}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
                <button onClick={() => setConfirmAction(null)}
                  style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, padding:"8px 16px", borderRadius:9,
                    border:"1px solid rgba(0,0,0,.12)", background:"none", color:"#6b6760", cursor:"pointer" }}>
                  Cancel
                </button>
                <button onClick={() => { const a = confirmAction; setConfirmAction(null); a.run(); }}
                  style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, padding:"8px 16px", borderRadius:9,
                    border:"none", background: confirmAction.danger ? "#c0392b" : "#1a1814", color:"#faf8f4", cursor:"pointer" }}>
                  {confirmAction.label}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Failures were going to alert(), which is suppressed in the same
          contexts — so an undeploy that 500'd looked identical to one that
          worked. */}
      {actionError && (
        <div style={{ position:"fixed", bottom:20, left:"50%", transform:"translateX(-50%)", zIndex:2001,
          background:"rgba(255,255,255,.97)", border:"1px solid rgba(192,57,43,.35)", borderRadius:10,
          boxShadow:"0 4px 28px rgba(0,0,0,.12)", padding:"10px 14px", display:"flex", alignItems:"center", gap:12 }}>
          <span style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12.5, color:"#993c1d" }}>{actionError}</span>
          <span onClick={() => setActionError(null)}
            style={{ cursor:"pointer", color:"#a8a5a0", fontSize:14, lineHeight:1 }}>✕</span>
        </div>
      )}

      {deployActor && (
        <DeployWizardModal
          actor={deployActor}
          onClose={() => setDeployActor(null)}
          onDeployed={dep => {
            setDeployments(p => [...p, dep]);
            setDeployedIds(p => new Set([...p, dep.platform_actor_id]));
            setDeployActor(null);
          }}
        />
      )}
    </div>
  );
}
