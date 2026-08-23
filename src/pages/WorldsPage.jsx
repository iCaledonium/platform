import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import WorldWizard from "./WorldWizard.jsx";

// ── WorldsPage ────────────────────────────────────────────────────────────────
//
// Session 150 — the cards used to open a configure overlay. They now navigate to
// /my-worlds/:worldId, so a world has a real address. Everything the overlay held
// moved to WorldEditorPage; ResidencesTab and WorldConfigModal moved with it and
// are no longer defined here.
//
// The cards also show more. Every field below was already on the world row and
// simply never surfaced — domain, rating, persistence, currency, time
// compression — plus the faces of who is actually deployed, which is the thing
// you most want to know when picking a world to open.

const F     = { fontFamily:"'DM Sans',system-ui,sans-serif" };
const serif = { fontFamily:"'Cormorant Garamond',Georgia,serif" };

function ini(n) { return (n || "?").split(" ").map(w => w[0]).slice(0,2).join("").toUpperCase(); }

function Chip({ children }) {
  return (
    <span style={{ ...F, fontSize:10, letterSpacing:".04em", padding:"3px 8px", borderRadius:5,
      background:"rgba(0,0,0,.04)", color:"#6b6760", whiteSpace:"nowrap" }}>{children}</span>
  );
}

function WorldCard({ world, onOpen, onToggleRun, busy }) {
  const running = world.status === "running" || world.status === "active";
  const [cast, setCast] = useState([]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/worlds/${world.id}/actors`)
      .then(r => r.ok ? r.json() : [])
      .then(d => { if (alive) setCast(Array.isArray(d) ? d : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [world.id]);

  const chips = [
    world.domain_type,
    world.content_rating,
    world.persistence_mode,
    world.currency,
    world.time_compression && world.time_compression !== 1 ? `${world.time_compression}× time` : null,
  ].filter(Boolean);

  return (
    <div onClick={() => onOpen(world)}
      style={{ background:"rgba(255,255,255,0.7)", borderRadius:20, overflow:"hidden",
        border:"1px solid rgba(0,0,0,0.07)", boxShadow:"0 2px 12px rgba(0,0,0,0.06)",
        display:"flex", flexDirection:"column", cursor:"pointer", transition:"box-shadow .15s" }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 24px rgba(0,0,0,.1)"}
      onMouseLeave={e => e.currentTarget.style.boxShadow = "0 2px 12px rgba(0,0,0,.06)"}>

      <div style={{ padding:"20px 20px 14px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
          <div style={{ display:"flex", alignItems:"center", gap:7 }}>
            <div style={{ width:8, height:8, borderRadius:"50%", flexShrink:0, background: running ? "#1D9E75" : "#c8c5c0" }} />
            <span style={{ ...F, fontSize:10, letterSpacing:".08em", textTransform:"uppercase",
              color: running ? "#1D9E75" : "#a8a5a0" }}>{world.status}</span>
          </div>
        </div>

        <h3 style={{ ...serif, fontSize:22, fontWeight:500, margin:"0 0 3px", color:"#1a1814" }}>{world.name}</h3>
        <p style={{ ...F, fontSize:12, color:"#a8a5a0", margin:"0 0 12px" }}>
          {[world.city, world.timezone].filter(Boolean).join(" · ") || "—"}
        </p>

        {chips.length > 0 && (
          <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginBottom:12 }}>
            {chips.map(c => <Chip key={c}>{c}</Chip>)}
          </div>
        )}

        <div style={{ display:"flex", alignItems:"center", gap:9, minHeight:26 }}>
          {cast.length > 0 && (
            <div style={{ display:"flex" }}>
              {cast.slice(0,5).map((a,i) => (
                a.photo_url
                  ? <img key={a.id} src={a.photo_url} alt=""
                      style={{ width:26, height:26, borderRadius:"50%", objectFit:"cover",
                        border:"1.5px solid #fdfcfa", marginLeft: i ? -8 : 0 }} />
                  : <div key={a.id} style={{ width:26, height:26, borderRadius:"50%", background:"rgba(0,0,0,.07)",
                      display:"flex", alignItems:"center", justifyContent:"center", ...F, fontSize:9, color:"#6b6760",
                      border:"1.5px solid #fdfcfa", marginLeft: i ? -8 : 0 }}>{ini(a.name)}</div>
              ))}
            </div>
          )}
          <span style={{ ...F, fontSize:12, color:"#a8a5a0" }}>
            {cast.length > 0 ? `${cast.length} in play` : "nobody deployed"}
            {` · ${world.member_count ?? 0} member${(world.member_count ?? 0) === 1 ? "" : "s"}`}
            {world.role === "owner" ? "" : ` · you're a ${world.role || "viewer"}`}
          </span>
        </div>
      </div>

      <div style={{ padding:"10px 20px 16px", borderTop:"1px solid rgba(0,0,0,0.05)",
        display:"flex", gap:8, marginTop:"auto" }}>
        <button onClick={e => { e.stopPropagation(); onToggleRun(world); }} disabled={busy}
          style={{ ...F, fontSize:10, letterSpacing:".06em", textTransform:"uppercase",
            padding:"6px 14px", borderRadius:6, border:"1px solid rgba(0,0,0,0.1)",
            background:"transparent", color:"#6b6760", cursor: busy ? "default" : "pointer", opacity: busy ? .5 : 1 }}>
          {busy ? "…" : running ? "Stop" : "Start"}
        </button>
        {/* Session 150 — members were only settable when the world was created,
            so there was nowhere to add an owner or invite anyone afterwards.
            This goes straight to the world editor's Members panel. */}
        <button onClick={e => { e.stopPropagation(); onOpen(world, "members"); }}
          title="Members and owners"
          style={{ ...F, fontSize:10, letterSpacing:".06em", textTransform:"uppercase",
            padding:"6px 14px", borderRadius:6, border:"1px solid rgba(0,0,0,0.1)",
            background:"transparent", color:"#6b6760", cursor:"pointer" }}>
          Members
        </button>
        <button onClick={e => { e.stopPropagation(); onOpen(world); }}
          style={{ ...F, fontSize:10, letterSpacing:".06em", textTransform:"uppercase",
            padding:"6px 14px", borderRadius:6, border:"none",
            background:"#1a1814", color:"#faf8f4", cursor:"pointer" }}>
          Open world
        </button>
      </div>
    </div>
  );
}

export default function WorldsPage() {
  const [worlds, setWorlds]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [busyId, setBusyId]         = useState(null);
  const navigate = useNavigate();

  function fetchWorlds() {
    return fetch("/api/worlds")
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

  async function toggleRun(world) {
    const running = world.status === "running" || world.status === "active";
    setBusyId(world.id);
    try {
      await fetch(`/api/worlds/${world.id}/${running ? "stop" : "start"}`, { method:"POST" });
      await fetchWorlds();
    } catch {}
    setBusyId(null);
  }

  return (
    <div style={{ background:"#eeecea", minHeight:"100vh", position:"relative" }}>
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:0,
        background:"radial-gradient(ellipse at 12% 18%, rgba(230,180,100,.22) 0%, transparent 45%), radial-gradient(ellipse at 88% 78%, rgba(160,185,230,.18) 0%, transparent 45%), #eeecea" }} />
      <div style={{ position:"relative", zIndex:1, maxWidth:900, margin:"0 auto", padding:"2rem 1.5rem 4rem" }}>

        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"2.5rem" }}>
          <div style={{ display:"flex", alignItems:"center", gap:14 }}>
            <a href="/home" style={{ ...F, fontSize:11, letterSpacing:".08em", textTransform:"uppercase",
              color:"#a8a5a0", textDecoration:"none" }}>← Home</a>
            <span style={{ color:"#d1cfca", fontSize:14 }}>/</span>
            <span style={{ ...serif, fontSize:24, fontWeight:500, letterSpacing:".22em",
              textTransform:"uppercase", color:"#1a1814" }}>Worlds</span>
          </div>
          <button onClick={() => setShowWizard(true)}
            style={{ ...F, fontSize:12, letterSpacing:".06em", textTransform:"uppercase",
              padding:"10px 22px", borderRadius:10, background:"#1a1814",
              color:"#faf8f4", border:"none", cursor:"pointer" }}>
            New world +
          </button>
        </div>

        {loading && <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>Loading worlds...</p>}

        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:16 }}>
          {worlds.map(w => (
            <WorldCard key={w.id} world={w}
              onOpen={(world, tab) => navigate(`/my-worlds/${world.id}${tab ? `?tab=${tab}` : ""}`)}
              onToggleRun={toggleRun}
              busy={busyId === w.id}
            />
          ))}

          <div onClick={() => setShowWizard(true)}
            style={{ background:"transparent", borderRadius:20,
              border:"1px dashed rgba(0,0,0,0.15)", minHeight:200,
              display:"flex", flexDirection:"column", alignItems:"center",
              justifyContent:"center", gap:8, cursor:"pointer" }}>
            <div style={{ width:32, height:32, borderRadius:"50%",
              border:"1px solid rgba(0,0,0,0.15)", display:"flex",
              alignItems:"center", justifyContent:"center", fontSize:18, color:"#a8a5a0" }}>+</div>
            <p style={{ ...F, fontSize:12, color:"#a8a5a0", letterSpacing:".06em",
              textTransform:"uppercase", margin:0 }}>New world</p>
          </div>
        </div>
      </div>

      {showWizard && (
        <WorldWizard
          onClose={() => setShowWizard(false)}
          onCreated={() => { setShowWizard(false); fetchWorlds(); }}
        />
      )}
    </div>
  );
}
