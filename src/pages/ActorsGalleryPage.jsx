import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

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

function ShareModal({ actor, onClose }) {
  const [shares, setShares]   = useState([]);
  const [users, setUsers]     = useState([]);
  const [selected, setSelected] = useState("");
  const [perm, setPerm]       = useState("read");
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
        body: JSON.stringify({ email: target.email, permission: perm }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); setSaving(false); return; }
      setShares(prev => [...prev, { shared_with_id: data.shared_with_id, name: data.name, email: target.email, permission: data.permission }]);
      setSelected("");
    } catch { setError("Something went wrong"); }
    setSaving(false);
  }

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
            <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0", marginTop:2 }}>Control who can view or clone this character</div>
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
                <option value="read">Read only</option>
                <option value="clone">Can clone</option>
              </select>
              <button onClick={addShare} disabled={saving||!selected} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, letterSpacing:".06em", textTransform:"uppercase", padding:"8px 16px", borderRadius:10, background:"#1a1814", color:"#faf8f4", border:"none", cursor:"pointer", opacity: (saving||!selected) ? .4 : 1 }}>
                {saving ? "..." : "Share"}
              </button>
            </>}
          </div>
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
                    <span style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, letterSpacing:".07em", padding:"3px 8px", borderRadius:5, background: s.permission==="clone" ? "rgba(99,153,34,.1)" : "rgba(136,135,128,.1)", color: s.permission==="clone" ? "#3b6d11" : "#5f5e5a", border: s.permission==="clone" ? "1px solid rgba(99,153,34,.2)" : "1px solid rgba(136,135,128,.2)" }}>
                      {s.permission==="clone" ? "can clone" : "read only"}
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
          <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, color:"#a8a5a0" }}>
            Read only — view profile &nbsp;·&nbsp; Can clone — copy to own registry and edit independently
          </div>
        </div>
      </div>
    </div>
  );
}

function ActorCard({ actor, shared, owned, onShare, onClick }) {
  const c = sc(actor.attachment_style);
  const dots = COMPLETION.map(s => s.check(actor));

  return (
    <div style={{ background:"rgba(255,255,255,.72)", backdropFilter:"blur(40px) saturate(200%)", WebkitBackdropFilter:"blur(40px) saturate(200%)", border:"1px solid rgba(255,255,255,.95)", boxShadow:"0 2px 32px rgba(0,0,0,.06), 0 1px 0 rgba(255,255,255,1) inset", borderRadius:18, padding:"1.4rem 1.2rem 1.2rem", cursor:"pointer", transition:"border-color .15s, box-shadow .15s", position:"relative" }}
      onClick={onClick}
      onMouseEnter={e => { e.currentTarget.style.borderColor="rgba(55,138,221,.25)"; e.currentTarget.style.boxShadow="0 4px 40px rgba(0,0,0,.09), 0 1px 0 rgba(255,255,255,1) inset"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor="rgba(255,255,255,.95)"; e.currentTarget.style.boxShadow="0 2px 32px rgba(0,0,0,.06), 0 1px 0 rgba(255,255,255,1) inset"; }}>

      {owned && (
        <div onClick={e => { e.stopPropagation(); onShare(actor); }}
          style={{ position:"absolute", top:10, right:10, width:26, height:26, borderRadius:"50%", background:"rgba(255,255,255,.8)", border:"1px solid rgba(0,0,0,.08)", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", zIndex:1 }}
          onMouseEnter={e => { e.currentTarget.style.background="#fff"; e.currentTarget.style.borderColor="rgba(0,0,0,.18)"; }}
          onMouseLeave={e => { e.currentTarget.style.background="rgba(255,255,255,.8)"; e.currentTarget.style.borderColor="rgba(0,0,0,.08)"; }}>
          <ShareIcon />
        </div>
      )}

      {shared && (
        <div style={{ position:"absolute", top:10, right:10, fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, letterSpacing:".1em", textTransform:"uppercase", color:"#a8a5a0", border:"1px solid rgba(0,0,0,.08)", borderRadius:5, padding:"2px 6px" }}>
          {actor.permission==="clone" ? "clone" : "read"}
        </div>
      )}

      {actor.photo_url
        ? <img src={actor.photo_url} alt={actor.name} style={{ width:44, height:44, borderRadius:"50%", objectFit:"cover", marginBottom:12, border:`1px solid ${c.border}` }} />
        : <div style={{ width:44, height:44, borderRadius:"50%", background:c.init, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:15, fontWeight:500, color:c.text, marginBottom:12 }}>{ini(actor.name)}</div>
      }

      <p style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:3, lineHeight:1.1 }}>{actor.name}</p>
      <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0", marginBottom:10, lineHeight:1.5 }}>{actor.occupation||"—"}</p>

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

function SectionLabel({ label, count }) {
  return <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, letterSpacing:".2em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:14 }}>{label}{count!=null?` · ${count}`:""}</p>;
}

export default function ActorsGalleryPage() {
  const [owned, setOwned]           = useState([]);
  const [shared, setShared]         = useState([]);
  const [shareActor, setShareActor] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    document.title = "Anima — Characters";
    fetch("/api/actors").then(r => r.ok ? r.json() : []).then(setOwned).catch(() => {});
    fetch("/api/actors/shared").then(r => r.ok ? r.json() : []).then(setShared).catch(() => {});
  }, []);

  return (
    <div style={{ background:"#eeecea", minHeight:"100vh", position:"relative" }}>
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:0, background:"radial-gradient(ellipse at 12% 18%, rgba(230,180,100,.22) 0%, transparent 45%), radial-gradient(ellipse at 88% 78%, rgba(160,185,230,.18) 0%, transparent 45%), #eeecea" }} />
      <div style={{ position:"relative", zIndex:1, maxWidth:900, margin:"0 auto", padding:"2rem 1.5rem 4rem" }}>

        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"2.5rem" }}>
          <div style={{ display:"flex", alignItems:"center", gap:14 }}>
            <a href="/home" style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, letterSpacing:".08em", textTransform:"uppercase", color:"#a8a5a0", textDecoration:"none" }}>← Home</a>
            <span style={{ color:"#d1cfca", fontSize:14 }}>/</span>
            <span style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:24, fontWeight:500, letterSpacing:".22em", textTransform:"uppercase", color:"#1a1814" }}>Characters</span>
          </div>
          {owned.length > 0 && (
            <button style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, letterSpacing:".06em", textTransform:"uppercase", padding:"10px 22px", borderRadius:10, background:"#1a1814", color:"#faf8f4", border:"none", cursor:"pointer" }}>New character +</button>
          )}
        </div>

        {owned.length > 0 && (
          <>
            <SectionLabel label="Your characters" count={owned.length} />
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(170px,1fr))", gap:12, marginBottom:"2.5rem" }}>
              {owned.map(a => <ActorCard key={a.id} actor={a} owned onShare={setShareActor} onClick={() => navigate(`/actors/${a.id}`)} />)}
            </div>
          </>
        )}

        {shared.length > 0 && (
          <>
            <SectionLabel label="Shared with you" count={shared.length} />
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(170px,1fr))", gap:12 }}>
              {shared.map(a => <ActorCard key={a.id} actor={a} shared onClick={() => navigate(`/actors/${a.id}`)} />)}
            </div>
          </>
        )}

        {owned.length===0 && shared.length===0 && (
          <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0" }}>No actors yet.</p>
        )}
      </div>

      {shareActor && <ShareModal actor={shareActor} onClose={() => setShareActor(null)} />}
    </div>
  );
}
