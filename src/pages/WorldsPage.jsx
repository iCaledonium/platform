import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import WorldWizard from "./WorldWizard.jsx";

const F = { fontFamily:"'DM Sans',system-ui,sans-serif" };
const serif = { fontFamily:"'Cormorant Garamond',Georgia,serif" };

// ── WorldConfigModal ──────────────────────────────────────────────────────────
function WorldConfigModal({ world, onClose, onDeleted }) {
  const [name, setName]       = useState(world.name);
  const [saving, setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function save() {
    setSaving(true);
    // stub — wire PATCH /api/worlds/:id when needed
    setSaving(false);
    onClose();
  }

  async function deleteWorld() {
    if (!window.confirm(`Delete "${world.name}"? This cannot be undone. All world data will be permanently removed.`)) return;
    setDeleting(true);
    try {
      await fetch(`/api/worlds/${world.id}`, { method:"DELETE" });
      onDeleted(world.id);
    } catch {}
    setDeleting(false);
  }

  return (
    <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.5)",
      display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}>
      <div style={{background:"#faf8f4",borderRadius:16,width:"100%",maxWidth:480,
        boxShadow:"0 24px 64px rgba(0,0,0,0.2)",overflow:"hidden",...F}}>
        <div style={{padding:"20px 24px 0"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
            <h2 style={{...serif,fontSize:22,fontWeight:500,margin:0,color:"#1a1814"}}>Configure world</h2>
            <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",
              color:"#a8a5a0",fontSize:18,lineHeight:1,padding:4}}>✕</button>
          </div>
        </div>
        <div style={{padding:"0 24px 20px",display:"flex",flexDirection:"column",gap:14}}>
          <div>
            <label style={{fontSize:11,color:"#a8a5a0",display:"block",marginBottom:5}}>World name</label>
            <input value={name} onChange={e=>setName(e.target.value)}
              style={{width:"100%",boxSizing:"border-box",border:"1px solid rgba(0,0,0,0.12)",
                borderRadius:8,padding:"9px 12px",fontSize:13,color:"#1a1814",background:"#fff",outline:"none"}}/>
          </div>
          <div style={{padding:"12px 14px",background:"rgba(0,0,0,0.02)",
            border:"1px solid rgba(0,0,0,0.06)",borderRadius:10}}>
            <p style={{fontSize:11,color:"#a8a5a0",margin:"0 0 6px",letterSpacing:".06em",textTransform:"uppercase"}}>Info</p>
            {[["City", world.city||"—"],["Timezone",world.timezone||"—"],["Status",world.status],
              ["Characters",world.actor_count??0],["Members",world.member_count??0]
            ].map(([k,v]) => (
              <div key={k} style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                <span style={{fontSize:12,color:"#a8a5a0"}}>{k}</span>
                <span style={{fontSize:12,color:"#1a1814"}}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{padding:"12px 14px",background:"rgba(192,57,43,0.04)",
            border:"1px solid rgba(192,57,43,0.12)",borderRadius:10}}>
            <p style={{fontSize:11,color:"#993c1d",margin:"0 0 8px",letterSpacing:".06em",textTransform:"uppercase"}}>Danger zone</p>
            <p style={{fontSize:12,color:"#a8a5a0",margin:"0 0 10px"}}>Permanently deletes all world data including actors, memories, and relationships. Cannot be undone.</p>
            <button onClick={deleteWorld} disabled={deleting}
              style={{fontSize:11,letterSpacing:".05em",textTransform:"uppercase",padding:"7px 16px",
                borderRadius:8,background:"rgba(192,57,43,0.08)",color:"#993c1d",
                border:"1px solid rgba(192,57,43,0.2)",cursor:"pointer"}}>
              {deleting ? "Deleting..." : `Delete "${world.name}"`}
            </button>
          </div>
        </div>
        <div style={{padding:"12px 24px",borderTop:"1px solid rgba(0,0,0,0.07)",
          display:"flex",justifyContent:"flex-end",gap:8}}>
          <button onClick={onClose}
            style={{background:"transparent",color:"#6b6760",border:"1px solid rgba(0,0,0,0.12)",
              borderRadius:8,padding:"8px 18px",fontSize:12,letterSpacing:".05em",
              textTransform:"uppercase",cursor:"pointer"}}>Cancel</button>
          <button onClick={save} disabled={saving}
            style={{background:"#1a1814",color:"#faf8f4",border:"none",borderRadius:8,
              padding:"8px 20px",fontSize:12,letterSpacing:".05em",
              textTransform:"uppercase",cursor:"pointer"}}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── WorldCard ─────────────────────────────────────────────────────────────────
function WorldCard({ world, onConfigure, onDeleted }) {
  const [toggling, setToggling] = useState(false);
  const [status, setStatus]     = useState(world.status);
  const running = status === "running";

  async function toggle() {
    if (toggling) return;
    setToggling(true);
    const action = running ? "stop" : "start";
    try {
      const r = await fetch(`/api/worlds/${world.id}/${action}`, { method:"POST" });
      const d = await r.json();
      setStatus(d.status);
    } catch {}
    setToggling(false);
  }

  async function openMonitor() {
    try {
      const r = await fetch(`/api/viewer-token?world_id=${world.id}`);
      const d = await r.json();
      window.open(`https://anima.simulator.ngrok.dev/worlds/${world.id}?viewer=${d.token}`, "_blank");
    } catch {
      window.open(`https://anima.simulator.ngrok.dev/worlds/${world.id}`, "_blank");
    }
  }

  return (
    <div style={{background:"rgba(255,255,255,0.72)",backdropFilter:"blur(40px) saturate(200%)",
      border:"1px solid rgba(255,255,255,0.95)",
      boxShadow:"0 2px 32px rgba(0,0,0,0.06)",
      borderRadius:20,overflow:"hidden",...F}}>
      <div style={{padding:"18px 20px 14px"}}>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:10}}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
              <div style={{width:8,height:8,borderRadius:"50%",flexShrink:0,
                background: running ? "#34c759" : "#d1cfca",
                boxShadow: running ? "0 0 0 3px rgba(52,199,89,0.18)" : "none"}}/>
              <span style={{fontSize:11,color: running ? "#1a7a35" : "#a8a5a0",letterSpacing:".04em"}}>
                {running ? "Running" : "Stopped"}
              </span>
            </div>
            <p style={{...serif,fontSize:22,fontWeight:400,margin:0,color:"#1a1814",lineHeight:1.1}}>{world.name}</p>
            {world.city && <p style={{fontSize:11,color:"#a8a5a0",margin:"4px 0 0"}}>{world.city}</p>}
          </div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={() => onConfigure(world)}
              style={{fontSize:10,letterSpacing:".06em",textTransform:"uppercase",padding:"5px 10px",
                borderRadius:7,background:"transparent",color:"#6b6760",
                border:"1px solid rgba(0,0,0,0.1)",cursor:"pointer"}}>Configure</button>
          </div>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
          <div style={{background:"rgba(0,0,0,0.03)",borderRadius:8,padding:"8px 10px"}}>
            <p style={{fontSize:10,color:"#a8a5a0",margin:"0 0 2px",letterSpacing:".06em",textTransform:"uppercase"}}>Characters</p>
            <p style={{...serif,fontSize:22,fontWeight:400,color:"#1a1814",margin:0}}>{world.actor_count ?? "—"}</p>
          </div>
          <div style={{background:"rgba(0,0,0,0.03)",borderRadius:8,padding:"8px 10px"}}>
            <p style={{fontSize:10,color:"#a8a5a0",margin:"0 0 2px",letterSpacing:".06em",textTransform:"uppercase"}}>Members</p>
            <p style={{...serif,fontSize:22,fontWeight:400,color:"#1a1814",margin:0}}>{world.member_count ?? "—"}</p>
          </div>
        </div>
      </div>

      <div style={{borderTop:"1px solid rgba(0,0,0,0.06)",padding:"10px 14px",display:"flex",gap:8}}>
        <button onClick={toggle} disabled={toggling}
          style={{flex:1,fontSize:11,letterSpacing:".05em",textTransform:"uppercase",padding:"8px 0",borderRadius:8,
            cursor:"pointer",
            background: running ? "rgba(192,57,43,0.06)" : "rgba(52,199,89,0.08)",
            color: running ? "#993c1d" : "#1a7a35",
            border: `1px solid ${running ? "rgba(192,57,43,0.2)" : "rgba(52,199,89,0.2)"}`,
          }}>
          {toggling ? "..." : running ? "Stop" : "Start"}
        </button>
        <button onClick={openMonitor} disabled={!running}
          style={{flex:1,fontSize:11,letterSpacing:".05em",textTransform:"uppercase",padding:"8px 0",borderRadius:8,
            background:"transparent",color:running?"#6b6760":"#c8c6c0",
            border:`1px solid ${running?"rgba(0,0,0,0.1)":"rgba(0,0,0,0.06)"}`,cursor:running?"pointer":"default"}}>
          Monitor →
        </button>
        <button disabled={!running}
          style={{flex:1,fontSize:11,letterSpacing:".05em",textTransform:"uppercase",padding:"8px 0",borderRadius:8,
            background:running?"#1a1814":"rgba(0,0,0,0.08)",
            color:running?"#faf8f4":"#a8a5a0",border:"none",cursor:running?"pointer":"default"}}>
          Enter →
        </button>
      </div>
    </div>
  );
}

// ── WorldsPage ────────────────────────────────────────────────────────────────
export default function WorldsPage() {
  const [worlds, setWorlds]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [configWorld, setConfigWorld] = useState(null);
  const navigate = useNavigate();

  function fetchWorlds() {
    fetch("/api/worlds")
      .then(r => r.ok ? r.json() : [])
      .then(d => { setWorlds(d); setLoading(false); })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    document.title = "Anima — Worlds";
    fetchWorlds();

    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "world_started") {
          setWorlds(p => p.map(w => w.id === event.world_id ? {...w, status: "running"} : w));
        } else if (event.type === "world_stopped") {
          setWorlds(p => p.map(w => w.id === event.world_id ? {...w, status: "stopped"} : w));
        } else if (event.type === "world_created" || event.type === "world_deleted") {
          fetchWorlds();
        }
      } catch {}
    };
    es.onerror = () => {};
    return () => es.close();
  }, []);

  return (
    <div style={{background:"#eeecea",minHeight:"100vh",position:"relative"}}>
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,
        background:"radial-gradient(ellipse at 12% 18%, rgba(230,180,100,.22) 0%, transparent 45%), radial-gradient(ellipse at 88% 78%, rgba(160,185,230,.18) 0%, transparent 45%), #eeecea"}}/>
      <div style={{position:"relative",zIndex:1,maxWidth:900,margin:"0 auto",padding:"2rem 1.5rem 4rem"}}>

        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"2.5rem"}}>
          <div style={{display:"flex",alignItems:"center",gap:14}}>
            <a href="/home" style={{...F,fontSize:11,letterSpacing:".08em",textTransform:"uppercase",
              color:"#a8a5a0",textDecoration:"none"}}>← Home</a>
            <span style={{color:"#d1cfca",fontSize:14}}>/</span>
            <span style={{...serif,fontSize:24,fontWeight:500,letterSpacing:".22em",
              textTransform:"uppercase",color:"#1a1814"}}>Worlds</span>
          </div>
          <button onClick={() => setShowWizard(true)}
            style={{...F,fontSize:12,letterSpacing:".06em",textTransform:"uppercase",
              padding:"10px 22px",borderRadius:10,background:"#1a1814",
              color:"#faf8f4",border:"none",cursor:"pointer"}}>
            New world +
          </button>
        </div>

        {loading && <p style={{...F,fontSize:13,color:"#a8a5a0"}}>Loading worlds...</p>}

        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:16}}>
          {worlds.map(w => (
            <WorldCard key={w.id} world={w}
              onConfigure={setConfigWorld}
              onDeleted={id => setWorlds(p => p.filter(x => x.id !== id))}
            />
          ))}

          <div onClick={() => setShowWizard(true)}
            style={{background:"transparent",borderRadius:20,
              border:"1px dashed rgba(0,0,0,0.15)",minHeight:200,
              display:"flex",flexDirection:"column",alignItems:"center",
              justifyContent:"center",gap:8,cursor:"pointer"}}>
            <div style={{width:32,height:32,borderRadius:"50%",
              border:"1px solid rgba(0,0,0,0.15)",display:"flex",
              alignItems:"center",justifyContent:"center",fontSize:18,color:"#a8a5a0"}}>+</div>
            <p style={{...F,fontSize:12,color:"#a8a5a0",letterSpacing:".06em",
              textTransform:"uppercase",margin:0}}>New world</p>
          </div>
        </div>
      </div>

      {showWizard && (
        <WorldWizard
          onClose={() => setShowWizard(false)}
          onCreated={w => {
            setShowWizard(false);
            fetch("/api/worlds").then(r=>r.ok?r.json():[]).then(setWorlds).catch(()=>{});
          }}
        />
      )}

      {configWorld && (
        <WorldConfigModal
          world={configWorld}
          onClose={() => setConfigWorld(null)}
          onDeleted={id => { setConfigWorld(null); setWorlds(p => p.filter(x => x.id !== id)); }}
        />
      )}
    </div>
  );
}
