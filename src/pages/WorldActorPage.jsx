import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";

// ── WorldActorPage ────────────────────────────────────────────────────────────
//
// Session 150 — the deployed character, at /my-worlds/:worldId/actors/:actorId.
//
// This is the INSTANCE, not the template. /actors/:id edits the character that a
// deploy ships; this edits the copy the simulator actually runs. The two diverge
// the moment you change anything here, and that is the point: she can be a
// different person in a different world.
//
// Scope note — this first pass is built strictly on endpoints that already
// exist, so it ships without touching the simulator:
//   Runtime  GET /api/actors/:id/in-play   relationships, memories
//   Home     GET /api/worlds/:wid/actors/:aid/home
// Economy, schedule and the profile sections have no read or write route yet —
// the simulator only ever inserts those at deploy and deletes them at teardown.
// They are listed here as pending rather than hidden, so the shape of the page
// is honest about what is not wired up.

const F     = { fontFamily:"'DM Sans',system-ui,sans-serif" };
const serif = { fontFamily:"'Cormorant Garamond',Georgia,serif" };

function ini(n) { return (n || "?").split(" ").map(w => w[0]).slice(0,2).join("").toUpperCase(); }

function NavSection({ label }) {
  return <div style={{ ...F, fontSize:9, letterSpacing:".18em", textTransform:"uppercase", color:"#a8a5a0", padding:"10px 20px 4px" }}>{label}</div>;
}

function NavItem({ label, active, pending, onClick }) {
  return (
    <div onClick={pending ? undefined : onClick} style={{
      display:"flex", alignItems:"center", gap:8, padding:"8px 20px", ...F, fontSize:12,
      cursor: pending ? "default" : "pointer",
      color: pending ? "#c4c1bb" : active ? "#1a1814" : "#6b6760",
      background: active ? "rgba(255,255,255,.5)" : "transparent",
      borderLeft: active ? "2px solid #b05c08" : "2px solid transparent",
      fontWeight: active ? 500 : 400,
    }}>
      <div style={{ width:6, height:6, borderRadius:"50%", flexShrink:0,
        background: pending ? "rgba(0,0,0,.06)" : "#34c759" }} />
      {label}
      {pending && <span style={{ marginLeft:"auto", fontSize:9, letterSpacing:".06em", textTransform:"uppercase", color:"#c4c1bb" }}>soon</span>}
    </div>
  );
}

function Pending({ what }) {
  return (
    <div style={{ maxWidth:520, padding:"16px 18px", background:"rgba(0,0,0,.02)",
      border:"1px dashed rgba(0,0,0,.1)", borderRadius:10 }}>
      <p style={{ ...F, fontSize:13, color:"#6b6760", margin:0, lineHeight:1.7 }}>
        {what} isn't editable yet. The simulator writes it once during deploy and deletes
        it on undeploy — there's no read or update route for it, so this panel has nothing
        to talk to until those are added.
      </p>
    </div>
  );
}

function RuntimePanel({ actorId, worldId }) {
  const [block, setBlock] = useState(undefined);

  useEffect(() => {
    fetch(`/api/actors/${actorId}/in-play`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setBlock((d?.data || []).find(w => w.world_id === worldId) || null))
      .catch(() => setBlock(null));
  }, [actorId, worldId]);

  if (block === undefined) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>Loading…</p>;
  if (!block) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>No runtime state in this world yet.</p>;

  const rels = Object.values((block.relationships || []).reduce((acc, r) => {
    if (!acc[r.target_id] || (r.warmth || 0) > (acc[r.target_id].warmth || 0)) acc[r.target_id] = r;
    return acc;
  }, {}));
  const mems = [...(block.memories || [])].sort((a,b) => (b.inserted_at || "").localeCompare(a.inserted_at || ""));

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:22, maxWidth:620 }}>
      {block.current_activity && (
        <div style={{ ...F, fontSize:13, color:"#6b6760" }}>
          Right now — <span style={{ color:"#1a1814" }}>{block.current_activity}</span>
        </div>
      )}

      <div>
        <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:8 }}>
          Relationships — {rels.length}
        </div>
        {rels.length === 0 && <p style={{ ...F, fontSize:13, color:"#a8a5a0", margin:0 }}>None formed yet.</p>}
        {rels.map(r => (
          <div key={r.target_id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:"1px solid rgba(0,0,0,.05)" }}>
            <span style={{ ...F, fontSize:13, color:"#1a1814", flex:1 }}>{r.target_name || r.other_name || "—"}</span>
            {r.rel_type && <span style={{ ...F, fontSize:10, padding:"2px 8px", borderRadius:5, background:"rgba(0,0,0,.04)", color:"#6b6760" }}>{r.rel_type}</span>}
            {r.warmth != null && <span style={{ fontFamily:"'DM Mono',monospace", fontSize:11, color:"#a8a5a0" }}>warmth {Number(r.warmth).toFixed(2)}</span>}
          </div>
        ))}
      </div>

      <div>
        <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:8 }}>
          Memories — {mems.length}
        </div>
        {mems.length === 0 && <p style={{ ...F, fontSize:13, color:"#a8a5a0", margin:0 }}>Nothing remembered yet.</p>}
        {mems.slice(0,25).map(m => (
          <div key={m.id} style={{ padding:"8px 0", borderBottom:"1px solid rgba(0,0,0,.05)" }}>
            <p style={{ ...F, fontSize:13, color:"#1a1814", margin:"0 0 2px", lineHeight:1.6 }}>{m.summary || m.content}</p>
            <span style={{ ...F, fontSize:10, color:"#a8a5a0" }}>
              {[m.memory_type, m.emotional_tag, (m.inserted_at || "").slice(0,10)].filter(Boolean).join(" · ")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HomePanel({ actorId, worldId }) {
  const [home, setHome] = useState(undefined);
  useEffect(() => {
    fetch(`/api/worlds/${worldId}/actors/${actorId}/home`)
      .then(r => r.ok ? r.json() : null).then(setHome).catch(() => setHome(null));
  }, [actorId, worldId]);

  if (home === undefined) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>Loading…</p>;
  const h = home?.home || home;
  if (!h || (!h.address && !h.formatted_address)) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>No home set in this world.</p>;

  return (
    <div style={{ maxWidth:520, padding:"14px 16px", background:"rgba(0,0,0,.02)", border:"1px solid rgba(0,0,0,.06)", borderRadius:10 }}>
      <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:6 }}>Home</div>
      <p style={{ ...F, fontSize:14, color:"#1a1814", margin:"0 0 4px" }}>{h.name || "—"}</p>
      <p style={{ ...F, fontSize:12, color:"#6b6760", margin:0 }}>{h.formatted_address || h.address}</p>
      <p style={{ ...F, fontSize:11, color:"#a8a5a0", margin:"10px 0 0" }}>
        Move her on the world's Residences map.
      </p>
    </div>
  );
}

export default function WorldActorPage() {
  const { worldId, actorId } = useParams();
  const navigate = useNavigate();
  const [actor, setActor] = useState(null);
  const [world, setWorld] = useState(null);
  const [tab, setTab]     = useState("runtime");

  useEffect(() => {
    fetch(`/api/worlds/${worldId}/actors`)
      .then(r => r.ok ? r.json() : [])
      .then(list => {
        const a = (Array.isArray(list) ? list : []).find(x => x.id === actorId) || null;
        setActor(a);
        if (a) document.title = `Anima — ${a.name}`;
      }).catch(() => {});
    fetch("/api/worlds")
      .then(r => r.ok ? r.json() : [])
      .then(ws => setWorld(ws.find(w => w.id === worldId) || null)).catch(() => {});
  }, [worldId, actorId]);

  const LABELS = {
    economy:"Economy", homework:"Home and work", schedule:"Schedule",
    identity:"Identity", psych:"Psychology", media:"Media", runtime:"Runtime",
  };

  const panels = {
    runtime:  <RuntimePanel actorId={actorId} worldId={worldId} />,
    homework: <HomePanel actorId={actorId} worldId={worldId} />,
    economy:  <Pending what="Her economy in this world — revenue sources, balance, expenses —" />,
    schedule: <Pending what="Her schedule in this world" />,
    identity: <Pending what="Her identity on the deployed instance" />,
    psych:    <Pending what="Her psychology on the deployed instance" />,
    media:    <Pending what="Media captured in this world" />,
  };

  return (
    <div style={{ background:"#eeecea", minHeight:"100vh", position:"relative" }}>
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:0, background:"radial-gradient(ellipse at 12% 18%, rgba(230,180,100,.22) 0%, transparent 45%), radial-gradient(ellipse at 88% 78%, rgba(160,185,230,.18) 0%, transparent 45%), #eeecea" }} />
      <div style={{ position:"relative", zIndex:1, display:"grid", gridTemplateColumns:"240px 1fr", minHeight:"100vh" }}>

        <div style={{ background:"rgba(255,255,255,.55)", backdropFilter:"blur(40px)", WebkitBackdropFilter:"blur(40px)", borderRight:"1px solid rgba(255,255,255,.9)", display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"20px 20px 16px", borderBottom:"1px solid rgba(0,0,0,.06)" }}>
            <a onClick={() => navigate(`/my-worlds/${worldId}`)} style={{ ...F, fontSize:11, letterSpacing:".08em", textTransform:"uppercase", color:"#a8a5a0", cursor:"pointer", display:"block", marginBottom:16 }}>
              ← {world?.name || "World"}
            </a>
            {actor?.photo_url
              ? <img src={actor.photo_url} alt="" style={{ width:52, height:52, borderRadius:"50%", objectFit:"cover", marginBottom:12 }} />
              : <div style={{ width:52, height:52, borderRadius:"50%", background:"rgba(0,0,0,.07)", display:"flex", alignItems:"center", justifyContent:"center", ...F, fontSize:17, color:"#6b6760", marginBottom:12 }}>{ini(actor?.name)}</div>}
            <div style={{ ...serif, fontSize:20, fontWeight:500, color:"#1a1814", lineHeight:1.1 }}>{actor?.name || "…"}</div>
            <div style={{ ...F, fontSize:11, color:"#a8a5a0", marginTop:3 }}>{actor?.occupation || ""}</div>
            <a onClick={() => navigate(`/actors/${actorId}`)}
              style={{ ...F, fontSize:11, color:"#b05c08", cursor:"pointer", display:"block", marginTop:10 }}>
              View basic profile →
            </a>
          </div>

          <div style={{ flex:1, overflowY:"auto", paddingBottom:8 }}>
            <NavSection label="In this world" />
            <NavItem label={LABELS.economy}  active={tab==="economy"}  pending onClick={() => setTab("economy")} />
            <NavItem label={LABELS.homework} active={tab==="homework"} onClick={() => setTab("homework")} />
            <NavItem label={LABELS.schedule} active={tab==="schedule"} pending onClick={() => setTab("schedule")} />
            <NavSection label="Profile" />
            <NavItem label={LABELS.identity} active={tab==="identity"} pending onClick={() => setTab("identity")} />
            <NavItem label={LABELS.psych}    active={tab==="psych"}    pending onClick={() => setTab("psych")} />
            <NavItem label={LABELS.media}    active={tab==="media"}    pending onClick={() => setTab("media")} />
            <NavSection label="Runtime" />
            <NavItem label={LABELS.runtime}  active={tab==="runtime"}  onClick={() => setTab("runtime")} />
          </div>
        </div>

        <div style={{ display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"20px 28px 16px", borderBottom:"1px solid rgba(0,0,0,.06)", background:"rgba(255,255,255,.3)", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)" }}>
            <div style={{ ...F, fontSize:11, color:"#a8a5a0", marginBottom:2 }}>
              <span onClick={() => navigate("/my-worlds")} style={{ cursor:"pointer", color:"#b05c08" }}>My worlds</span>
              {" › "}
              <span onClick={() => navigate(`/my-worlds/${worldId}`)} style={{ cursor:"pointer", color:"#b05c08" }}>{world?.name || "World"}</span>
              {" › "}{actor?.name || "…"}
            </div>
            <div style={{ ...serif, fontSize:26, fontWeight:400, color:"#1a1814" }}>{LABELS[tab]}</div>
          </div>
          <div style={{ flex:1, overflowY:"auto", padding:"24px 28px" }}>
            {panels[tab] || null}
          </div>
        </div>

      </div>
    </div>
  );
}
