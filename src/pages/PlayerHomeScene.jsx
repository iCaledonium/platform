import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

const font    = "'DM Sans', system-ui, sans-serif";
const serif   = "'Cormorant Garamond', Georgia, serif";
const dim     = "rgba(255,255,255,.35)";
const SIMULATOR_URL = "https://anima.simulator.ngrok.dev";

function worldLocalTime(tz) {
  return new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: tz || "UTC" });
}

export default function PlayerHomeScene({ world, user, location, onLeave, onEncounterStart }) {
  const navigate = useNavigate();
  const [activities,    setActivities]    = useState([]);
  const [currentState,  setCurrentState]  = useState(null); // active slug
  const [saving,        setSaving]        = useState(false);
  const [actors,        setActors]        = useState(location.actors || []);
  const [clock,         setClock]         = useState(worldLocalTime(world?.timezone));
  const [leaving,       setLeaving]       = useState(false);
  const [approaching,   setApproaching]   = useState(null);
  const [worldApps,     setWorldApps]     = useState([]);
  const [activeApp,     setActiveApp]     = useState(null);
  const esRef = useRef(null);

  // Clock
  useEffect(() => {
    const timer = setInterval(() => setClock(worldLocalTime(world?.timezone)), 30000);
    return () => clearInterval(timer);
  }, []);

  // Fetch home activities
  useEffect(() => {
    fetch(`/api/states/home-activities`)
      .then(r => { console.log("[home] activities status:", r.status); return r.ok ? r.json() : []; })
      .then(d => { console.log("[home] activities:", d); setActivities(Array.isArray(d) ? d : []); })
      .catch(e => console.error("[home] activities error:", e));
  }, []);

  // Fetch current player state
  useEffect(() => {
    fetch(`/api/worlds/${world.id}/player/state`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.activity_slug) setCurrentState(d.activity_slug); })
      .catch(() => {});
  }, [world.id]);

  // Fetch installed apps for this world
  useEffect(() => {
    fetch("/api/apps")
      .then(r => r.ok ? r.json() : [])
      .then(apps => setWorldApps(apps.filter(a => a.world_id === world.id)))
      .catch(() => {});
  }, [world.id]);

  // SSE for presence updates (actors arriving/leaving)
  useEffect(() => {
    if (esRef.current) esRef.current.close();
    const es = new EventSource("/api/stream");
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === "venue_event" && payload.location_id === (location.place_id || location.id)) {
          if (payload.data?.type === "actor_arrived") {
            setActors(prev => prev.find(a => a.actor_id === payload.data.actor_id)
              ? prev
              : [...prev, { actor_id: payload.data.actor_id, name: payload.data.actor_name, photo_url: payload.data.photo_url }]
            );
          } else if (payload.data?.type === "actor_left") {
            setActors(prev => prev.filter(a => a.actor_id !== payload.data.actor_id));
          }
        }
      } catch {}
    };
    es.onerror = () => { es.close(); };
    return () => es.close();
  }, [location]);

  async function selectState(slug) {
    setSaving(true);
    try {
      await fetch(`/api/worlds/${world.id}/player/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activity_slug: slug })
      });
      setCurrentState(slug);
    } catch(e) { console.error(e); }
    setSaving(false);
  }

  async function handleLeave() {
    setLeaving(true);
    await fetch(`/api/worlds/${world.id}/leave`, { method: "POST" }).catch(() => {});
    onLeave();
  }

  async function handleApproach(actor) {
    setApproaching(actor.actor_id);
    try {
      const resp = await fetch(`/api/worlds/${world.id}/encounter/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_actor_id: actor.actor_id,
          player_actor_id: playerActorId,
          location_id: location.place_id || location.id,
          trigger: "actor_approach"
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data.encounter_id) throw new Error("No encounter_id in response");

      sessionStorage.setItem("encounterContext", JSON.stringify({
        world, user,
        sceneData: {
          location,
          encounter_id: data.encounter_id,
          trigger: "actor_approach"
        }
      }));
      navigate(`/encounter/knock/${data.encounter_id}`);
    } catch(e) {
      console.error("Failed to start encounter", e);
      setApproaching(null);
    }
  }

  const playerActorId = user?.worlds?.find(w => w.world_id === world.id)?.actor_id;
  // Include player in HERE NOW — they are home
  const playerEntry = { actor_id: playerActorId, name: "You", photo_url: user?.photo_url || null, activity_slug: currentState };
  const hereNow = [playerEntry, ...actors.filter(a => a.actor_id !== playerActorId)];

  return (
    <>
    <div style={{ position:"fixed", inset:0, display:"flex", background:"#0e0d0b", color:"rgba(255,255,255,.85)", fontFamily:font, overflow:"hidden", zIndex:100 }}>

      {/* Left — home content */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", padding:"32px 40px", overflow:"auto" }}>

        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:32 }}>
          <div>
            <div style={{ fontSize:11, letterSpacing:".1em", textTransform:"uppercase", color:dim, marginBottom:6 }}>
              {location.category?.replace(/_/g," ") || "Home"}
            </div>
            <h1 style={{ fontFamily:serif, fontSize:32, fontWeight:400, color:"rgba(255,255,255,.9)", margin:0 }}>
              {location.name}
            </h1>
            {location.formatted_address && (
              <p style={{ fontSize:12, color:dim, margin:"6px 0 0" }}>{location.formatted_address}</p>
            )}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <span style={{ fontSize:12, color:dim }}>{clock}</span>
            <button
              onClick={handleLeave}
              disabled={leaving}
              style={{ fontFamily:font, fontSize:12, padding:"7px 16px", borderRadius:8, border:"1px solid rgba(255,255,255,.15)", background:"rgba(255,255,255,.06)", color:"rgba(255,255,255,.6)", cursor:"pointer" }}
            >{leaving ? "Leaving…" : "← Leave"}</button>
          </div>
        </div>

        {/* State selector */}
        <div style={{ marginBottom:40 }}>
          <div style={{ fontSize:11, letterSpacing:".08em", textTransform:"uppercase", color:dim, marginBottom:14 }}>
            What are you doing?
          </div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
            {activities.map(a => (
              <button
                key={a.slug}
                onClick={() => selectState(currentState === a.slug ? null : a.slug)}
                disabled={saving}
                style={{
                  fontFamily:font, fontSize:12, padding:"8px 16px", borderRadius:20,
                  border:`1px solid ${currentState === a.slug ? "rgba(181,148,90,.5)" : "rgba(255,255,255,.1)"}`,
                  background: currentState === a.slug ? "rgba(181,148,90,.15)" : "rgba(255,255,255,.04)",
                  color: currentState === a.slug ? "rgba(181,148,90,.9)" : "rgba(255,255,255,.6)",
                  cursor: saving ? "not-allowed" : "pointer",
                  transition: "all .15s"
                }}
              >{a.name}</button>
            ))}
          </div>
        </div>

        {/* Apps */}
        {worldApps.length > 0 && (
          <div style={{ borderTop:"1px solid rgba(255,255,255,.06)", paddingTop:24, marginBottom:24 }}>
            <div style={{ fontSize:11, letterSpacing:".08em", textTransform:"uppercase", color:dim, marginBottom:14 }}>
              Your apps
            </div>
            <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
              {worldApps.map(app => (
                <button key={app.id} onClick={() => setActiveApp(app)} style={{
                  fontFamily:font, fontSize:12, padding:"8px 16px", borderRadius:20,
                  border:"1px solid rgba(255,255,255,.12)", background:"rgba(255,255,255,.05)",
                  color:"rgba(255,255,255,.7)", cursor:"pointer", display:"flex", alignItems:"center", gap:7,
                  transition:"all .15s"
                }}>
                  <span style={{ fontSize:14 }}>{APP_ICON[app.tool_type] || "□"}</span>
                  {app.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Future: home images */}
        <div style={{ borderTop:"1px solid rgba(255,255,255,.06)", paddingTop:24 }}>
          <div style={{ fontSize:11, letterSpacing:".08em", textTransform:"uppercase", color:dim, marginBottom:12 }}>
            Home images
          </div>
          <div style={{ padding:"24px", border:"1px dashed rgba(255,255,255,.08)", borderRadius:10, textAlign:"center" }}>
            <p style={{ fontSize:12, color:"rgba(255,255,255,.2)", margin:0 }}>
              Upload home images for green screen backgrounds — coming soon
            </p>
          </div>
        </div>
      </div>

      {/* Right — presence panel */}
      <div style={{ width:260, borderLeft:"1px solid rgba(255,255,255,.06)", display:"flex", flexDirection:"column", padding:"24px 20px", background:"rgba(255,255,255,.02)" }}>
        <div style={{ fontSize:10, letterSpacing:".1em", textTransform:"uppercase", color:dim, marginBottom:16 }}>
          Here now
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            {hereNow.map(a => {
              const photoUrl = a.photo_url
                ? (a.photo_url.startsWith("/media/users") ? a.photo_url
                  : a.photo_url.startsWith(SIMULATOR_URL) ? `/api/media/resize?url=${encodeURIComponent(a.photo_url.replace(SIMULATOR_URL,""))}&w=64&h=64`
                  : a.photo_url)
                : null;
              return (
                <div key={a.actor_id} style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{ width:36, height:36, borderRadius:"50%", overflow:"hidden", background:"rgba(181,148,90,.2)", flexShrink:0 }}>
                    {photoUrl
                      ? <img src={photoUrl} style={{ width:"100%", height:"100%", objectFit:"cover" }} onError={e=>e.target.style.display="none"} />
                      : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, color:"rgba(181,148,90,.8)" }}>{a.name?.[0]}</div>
                    }
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:500, color:"rgba(255,255,255,.8)" }}>{a.name}</div>
                    <div style={{ fontSize:11, color:dim }}>{a.activity_slug?.replace(/_/g," ") || a.occupation || "—"}</div>
                  </div>
                  {a.actor_id !== playerActorId && (
                    <button
                      onClick={() => handleApproach(a)}
                      disabled={approaching === a.actor_id}
                      style={{
                        fontFamily:font, fontSize:11, padding:"5px 10px", borderRadius:8,
                        border:"1px solid rgba(181,148,90,.3)", background:"rgba(181,148,90,.08)",
                        color:"rgba(181,148,90,.8)", cursor:"pointer", flexShrink:0,
                        opacity: approaching === a.actor_id ? 0.5 : 1
                      }}
                    >{approaching === a.actor_id ? "…" : "Approach"}</button>
                  )}
                </div>
              );
            })}
        </div>
      </div>
    </div>

      {/* App modal overlay */}
      {activeApp && (
        <div style={{ position:"fixed", inset:0, zIndex:200, background:"rgba(0,0,0,.7)", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
          <div style={{ width:"100%", maxWidth:480, height:"80vh", background:"#faf8f5", borderRadius:16, overflow:"hidden", display:"flex", flexDirection:"column", boxShadow:"0 32px 80px rgba(0,0,0,.5)" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 16px", borderBottom:"1px solid #ede9e3", background:"#fff" }}>
              <span style={{ fontFamily:font, fontSize:13, fontWeight:500, color:"#1a1814" }}>{activeApp.name}</span>
              <button onClick={() => setActiveApp(null)} style={{ fontFamily:font, fontSize:12, padding:"5px 12px", borderRadius:8, border:"1px solid #ede9e3", background:"none", color:"#a8a5a0", cursor:"pointer" }}>✕ Close</button>
            </div>
            <iframe
              src={`${APP_URL[activeApp.tool_type] || "/"}?app=${activeApp.id}`}
              style={{ flex:1, border:"none", width:"100%" }}
              title={activeApp.name}
            />
          </div>
        </div>
      )}
    </>
  );
}

const APP_ICON = {
  messages:  "💬",
  calendar:  "📅",
  voicemail: "📩",
  custom:    "⚙️",
};

const APP_URL = {
  messages:  "/apps/messages",
  calendar:  "/apps/calendar",
  voicemail: "/apps/voicemail",
};
