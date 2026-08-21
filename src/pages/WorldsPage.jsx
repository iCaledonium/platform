import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import WorldWizard from "./WorldWizard.jsx";

const F = { fontFamily:"'DM Sans',system-ui,sans-serif" };
const serif = { fontFamily:"'Cormorant Garamond',Georgia,serif" };

const MODULES_DEF = [
  { key:"encounters",    label:"Encounters",      desc:"In-person real-time scenes via Hermes 70B"           },
  { key:"sms_messaging", label:"SMS & messaging", desc:"Actor-to-actor and player text threads"              },
  { key:"meetings",      label:"Meetings",        desc:"Actor↔actor conversations via MeetingRunner"         },
  { key:"work_economy",  label:"Work economy",    desc:"WorkOfferGenerator, salaries, freelance jobs"        },
  { key:"news_feed",     label:"News feed",       desc:"Local RSS news injected into actor context"          },
  { key:"weather",       label:"Weather",         desc:"Real-time weather fetched and injected into context" },
  { key:"schedule",          label:"Schedule",          desc:"Actors follow daily schedules for activities and locations" },
  { key:"user_residential",  label:"User residential",  desc:"Players have home addresses actors can visit" },
];

// ── WorldCard ─────────────────────────────────────────────────────────────────
function WorldCard({ world, onConfigure, onDeleted }) {
  const isRunning = world.status === "running";

  return (
    <div style={{background:"rgba(255,255,255,0.7)",borderRadius:20,overflow:"hidden",
      border:"1px solid rgba(0,0,0,0.07)",boxShadow:"0 2px 12px rgba(0,0,0,0.06)",
      display:"flex",flexDirection:"column",cursor:"pointer",transition:"box-shadow .15s"}}
      onClick={() => onConfigure(world)}
      onMouseEnter={e=>e.currentTarget.style.boxShadow="0 4px 24px rgba(0,0,0,.1)"}
      onMouseLeave={e=>e.currentTarget.style.boxShadow="0 2px 12px rgba(0,0,0,.06)"}>
      <div style={{padding:"20px 20px 14px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
          <div style={{display:"flex",alignItems:"center",gap:7}}>
            <div style={{width:8,height:8,borderRadius:"50%",flexShrink:0,
              background: isRunning ? "#1D9E75" : "#c8c5c0"}}/>
            <span style={{...F,fontSize:10,letterSpacing:".08em",textTransform:"uppercase",
              color: isRunning ? "#1D9E75" : "#a8a5a0"}}>{world.status}</span>
          </div>
          <button onClick={e=>{e.stopPropagation();onConfigure(world)}}
            style={{...F,fontSize:10,letterSpacing:".06em",textTransform:"uppercase",
              padding:"4px 10px",borderRadius:6,border:"1px solid rgba(0,0,0,0.1)",
              background:"transparent",color:"#6b6760",cursor:"pointer"}}>
            Configure
          </button>
        </div>
        <h3 style={{...serif,fontSize:22,fontWeight:500,margin:"0 0 3px",color:"#1a1814"}}>{world.name}</h3>
        <p style={{...F,fontSize:12,color:"#a8a5a0",margin:0}}>{world.city || "—"}</p>
      </div>
      <div style={{padding:"10px 20px 16px",borderTop:"1px solid rgba(0,0,0,0.05)",
        display:"flex",gap:16,marginTop:"auto"}}>
        {[["Characters", world.actor_count??0],["Members", world.member_count??0]].map(([k,v]) => (
          <div key={k}>
            <div style={{...F,fontSize:18,fontWeight:500,color:"#1a1814"}}>{v}</div>
            <div style={{...F,fontSize:10,color:"#a8a5a0",letterSpacing:".06em",textTransform:"uppercase"}}>{k}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── ResidencesTab ─────────────────────────────────────────────────────────────
function ResidencesTab({ world }) {
  const mapRef      = useRef(null);
  // Load Leaflet if not already present
  useEffect(() => {
    if (window.L) return;
    const css = document.createElement("link"); css.rel = "stylesheet";
    css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(css);
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    document.head.appendChild(script);
  }, []);
  const leafletRef  = useRef(null);
  const markersRef  = useRef({});
  const [actors,    setActors]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [assignModal, setAssignModal] = useState(null); // {lat,lng,address,place_id}
  const [assignActor, setAssignActor] = useState(null);
  const [saving,    setSaving]    = useState(false);
  const [selectedHome, setSelectedHome] = useState(null); // {place_id, description, lat, lng}
  const [homeName, setHomeName] = useState(""); // custom display name
  const [homeQuery, setHomeQuery] = useState("");
  const [homeSuggs, setHomeSuggs] = useState([]);
  const [changeTarget, setChangeTarget] = useState(null); // actor being moved

  useEffect(() => {
    fetch(`/api/worlds/${world.id}/actors/residences`)
      .then(r => r.ok ? r.json() : [])
      .then(d => { setActors(Array.isArray(d) ? d : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [world.id]);

  // Init map
  useEffect(() => {
    if (!mapRef.current || leafletRef.current) return;
    const L = window.L;
    if (!L) return;
    const map = L.map(mapRef.current, { center: [world.lat || 34.05, world.lng || -118.24], zoom: 12, zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map);
    leafletRef.current = map;

    map.on("dblclick", async e => {
      const { lat, lng } = e.latlng;
      // Show modal immediately with coords, then update with real address
      setAssignModal({ lat, lng, address: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, place_id: null, loading: true });
      const resp = await fetch(`/api/places/reverse?lat=${lat}&lng=${lng}`).then(r=>r.ok?r.json():null);
      if (resp?.address) {
        setAssignModal({ lat, lng, address: resp.address, place_id: resp.place_id, loading: false });
      } else {
        setAssignModal(prev => prev ? { ...prev, loading: false } : null);
      }
    });

    return () => { if (leafletRef.current) { leafletRef.current.remove(); leafletRef.current = null; } };
  }, [mapRef.current]);

  // Update markers when actors change
  useEffect(() => {
    const L = window.L; const map = leafletRef.current;
    if (!L || !map) return;
    Object.values(markersRef.current).forEach(m => m.remove());
    markersRef.current = {};

    // Group by home_place_id
    const byPlace = {};
    actors.filter(a => a.home_lat && a.home_lng).forEach(a => {
      const key = `${a.home_lat},${a.home_lng}`;
      if (!byPlace[key]) byPlace[key] = [];
      byPlace[key].push(a);
    });

    Object.entries(byPlace).forEach(([key, group]) => {
      const [lat, lng] = key.split(",").map(Number);
      const photoUrl = group[0].photo_url;
      const icon = L.divIcon({
        className: "",
        html: `<div style="display:flex;gap:2px">${group.map(a => `<img src="${a.photo_url||""}" style="width:32px;height:32px;border-radius:50%;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.3);object-fit:cover;background:#e0d8cf" onerror="this.style.background='#e0d8cf'" />`).join("")}</div>`,
        iconAnchor: [16 * group.length, 16],
      });
      const marker = L.marker([lat, lng], { icon }).addTo(map);
      marker.bindTooltip(group.map(a => a.name).join(", "), { direction: "top" });
      markersRef.current[key] = marker;
    });
  }, [actors]);

  async function setHome(actorId, homePlaceId, description, lat, lng) {
    setSaving(true);
    const actor = actors.find(a => a.id === actorId);
    if (!actor) { setSaving(false); return; }
    await fetch(`/api/worlds/${world.id}/actors/${actor.simulator_actor_id}/home`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ home_place_id: homePlaceId, description, lat, lng }),
    });
    setActors(prev => prev.map(a => a.id === actorId
      ? { ...a, home_place_id: homePlaceId, home_address: description, home_lat: lat, home_lng: lng }
      : a
    ));
    setSaving(false);
    setAssignModal(null); setAssignActor(null); setChangeTarget(null); setHomeQuery(""); setHomeSuggs([]); setSelectedHome(null);
  }

  const withHome    = actors.filter(a => a.home_lat);
  const withoutHome = actors.filter(a => !a.home_lat);

  return (
    <div style={{display:"flex",gap:0,height:520}}>
      {/* Map */}
      <div style={{flex:1,position:"relative"}}>
        <div ref={mapRef} style={{width:"100%",height:"100%"}} />
        <div style={{position:"absolute",bottom:8,left:8,zIndex:500,fontSize:10,
          color:"#6b6760",background:"rgba(250,248,244,.85)",padding:"4px 8px",borderRadius:6}}>
          Double-click map to assign a home
        </div>
      </div>

      {/* Sidebar */}
      <div style={{width:260,borderLeft:"1px solid rgba(0,0,0,.07)",overflowY:"auto",padding:"12px 0"}}>
        {loading && <p style={{fontSize:12,color:"#a8a5a0",padding:"0 14px"}}>Loading…</p>}

        {withHome.length > 0 && (
          <div>
            <p style={{fontSize:10,color:"#a8a5a0",letterSpacing:".1em",textTransform:"uppercase",margin:"0 0 8px",padding:"0 14px"}}>With home · {withHome.length}</p>
            {withHome.map(a => (
              <div key={a.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 14px",borderBottom:"1px solid rgba(0,0,0,.04)"}}>
                <img src={a.photo_url} style={{width:32,height:32,borderRadius:"50%",objectFit:"cover",background:"#e0d8cf",flexShrink:0}} onError={e=>e.target.style.background="#e0d8cf"} />
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:500,color:"#1a1814",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{a.name}</div>
                  <div style={{fontSize:10,color:"#a8a5a0",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{a.home_address || "—"}</div>
                </div>
                <button onClick={() => setChangeTarget(a)} style={{fontSize:9,letterSpacing:".06em",textTransform:"uppercase",padding:"3px 7px",borderRadius:5,border:"1px solid rgba(0,0,0,.12)",background:"transparent",color:"#6b6760",cursor:"pointer",flexShrink:0}}>Move</button>
              </div>
            ))}
          </div>
        )}

        {withoutHome.length > 0 && (
          <div style={{marginTop: withHome.length ? 12 : 0}}>
            <p style={{fontSize:10,color:"#a8a5a0",letterSpacing:".1em",textTransform:"uppercase",margin:"0 0 8px",padding:"0 14px"}}>No home · {withoutHome.length}</p>
            {withoutHome.map(a => (
              <div key={a.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 14px",borderBottom:"1px solid rgba(0,0,0,.04)"}}>
                <img src={a.photo_url} style={{width:32,height:32,borderRadius:"50%",objectFit:"cover",background:"#e0d8cf",flexShrink:0}} onError={e=>e.target.style.background="#e0d8cf"} />
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:500,color:"#1a1814"}}>{a.name}</div>
                  <div style={{fontSize:10,color:"#a8a5a0"}}>No home assigned</div>
                </div>
                <button onClick={() => setChangeTarget(a)} style={{fontSize:9,letterSpacing:".06em",textTransform:"uppercase",padding:"3px 7px",borderRadius:5,border:"1px solid rgba(29,158,117,.3)",background:"rgba(29,158,117,.06)",color:"#1D9E75",cursor:"pointer",flexShrink:0}}>Move in</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Assign modal — double-click on map */}
      {assignModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"#faf8f4",borderRadius:14,padding:28,width:400,boxShadow:"0 16px 48px rgba(0,0,0,.2)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <div style={{fontSize:16,fontWeight:500,color:"#1a1814",...{fontFamily:"'Cormorant Garamond',Georgia,serif"}}}>Assign home</div>
              <button onClick={() => setAssignModal(null)} style={{background:"none",border:"none",cursor:"pointer",color:"#a8a5a0",fontSize:18,lineHeight:1,padding:4}}>✕</button>
            </div>
            <div style={{fontSize:12,color:"#6b6760",marginBottom:16,padding:"8px 12px",background:"rgba(0,0,0,.03)",borderRadius:8}}>{assignModal.loading ? "Looking up address…" : assignModal.address}</div>
            <div style={{fontSize:11,color:"#a8a5a0",letterSpacing:".08em",textTransform:"uppercase",marginBottom:8}}>Select actor</div>
            <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:200,overflowY:"auto",marginBottom:16}}>
              {actors.map(a => (
                <div key={a.id} onClick={() => setAssignActor(a.id)}
                  style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:8,cursor:"pointer",
                    border:`1px solid ${assignActor===a.id?"rgba(29,158,117,.4)":"rgba(0,0,0,.08)"}`,
                    background:assignActor===a.id?"rgba(29,158,117,.06)":"transparent"}}>
                  <img src={a.photo_url} style={{width:28,height:28,borderRadius:"50%",objectFit:"cover",background:"#e0d8cf"}} onError={e=>e.target.style.background="#e0d8cf"} />
                  <div style={{fontSize:13,color:"#1a1814"}}>{a.name}</div>
                  {assignActor===a.id && <span style={{marginLeft:"auto",color:"#1D9E75"}}>✓</span>}
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button onClick={() => setAssignModal(null)} style={{fontSize:12,padding:"7px 16px",borderRadius:8,border:"1px solid rgba(0,0,0,.12)",background:"transparent",color:"#6b6760",cursor:"pointer"}}>Cancel</button>
              <button disabled={!assignActor||saving} onClick={() => setHome(assignActor, assignModal.place_id, assignModal.address, assignModal.lat, assignModal.lng)}
                style={{fontSize:12,padding:"7px 16px",borderRadius:8,border:"none",background:assignActor&&!saving?"#1a1814":"rgba(0,0,0,.15)",color:assignActor&&!saving?"#faf8f4":"#a8a5a0",cursor:assignActor&&!saving?"pointer":"not-allowed"}}>
                {saving?"Saving…":"Assign"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Change/Move-in modal — from sidebar */}
      {changeTarget && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"#faf8f4",borderRadius:14,padding:28,width:420,boxShadow:"0 16px 48px rgba(0,0,0,.2)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <div style={{fontSize:16,fontWeight:500,color:"#1a1814",...{fontFamily:"'Cormorant Garamond',Georgia,serif"}}}>
                {changeTarget.home_lat ? "Change home" : "Move in"} — {changeTarget.name}
              </div>
              <button onClick={() => { setChangeTarget(null); setHomeQuery(""); setHomeSuggs([]); setSelectedHome(null); setHomeName(""); }} style={{background:"none",border:"none",cursor:"pointer",color:"#a8a5a0",fontSize:18,lineHeight:1,padding:4}}>✕</button>
            </div>
            {changeTarget.home_address && (
              <div style={{fontSize:11,color:"#a8a5a0",marginBottom:14}}>Current: {changeTarget.home_address}</div>
            )}
            <div style={{position:"relative",marginBottom:12}}>
              <input value={homeQuery} onChange={async e => {
                const query = e.target.value; setHomeQuery(q);
                if (q.length < 3) { setHomeSuggs([]); return; }
                const resp = await fetch(`/api/places/autocomplete?q=${encodeURIComponent(q)}`).then(r=>r.ok?r.json():[]);
                setHomeSuggs(Array.isArray(resp)?resp:[]);
              }} placeholder={`Search address in ${world.city||"city"}…`}
                style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",borderRadius:9,border:"1px solid rgba(0,0,0,.12)",fontSize:13,outline:"none"}}
              />
              {homeSuggs.length > 0 && (
                <div style={{position:"absolute",top:"100%",left:0,right:0,background:"#fff",border:"1px solid rgba(0,0,0,.1)",borderRadius:9,zIndex:100,boxShadow:"0 8px 24px rgba(0,0,0,.1)",overflow:"hidden",marginTop:4}}>
                  {homeSuggs.map(s => (
                    <div key={s.place_id} onClick={async (e) => {
                      e.stopPropagation();
                      setHomeQuery(s.description); setHomeSuggs([]);
                      const det = await fetch(`/api/places/details?place_id=${s.place_id}`).then(r=>r.ok?r.json():null);
                      console.log("[place details]", s.place_id, det);
                      setSelectedHome({ place_id: s.place_id, description: s.description, lat: det?.lat, lng: det?.lng });
                    }} style={{padding:"10px 14px",fontSize:13,cursor:"pointer",borderBottom:"1px solid rgba(0,0,0,.05)"}}
                      onMouseEnter={e=>e.currentTarget.style.background="rgba(0,0,0,.03)"}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      {s.description}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {selectedHome && (
              <div style={{padding:"8px 12px",background:"rgba(29,158,117,.06)",border:"1px solid rgba(29,158,117,.3)",borderRadius:8,fontSize:12,color:"#1D9E75",marginBottom:12}}>
                ✓ {selectedHome.description}
              </div>
            )}
            <div style={{marginBottom:12}}>
              <div style={{fontSize:11,color:"#a8a5a0",marginBottom:4,letterSpacing:".04em"}}>DISPLAY NAME (optional)</div>
              <input value={homeName} onChange={e => setHomeName(e.target.value)}
                placeholder={`e.g. ${changeTarget?.name?.split(" ")[0]}s apartment`}
                style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",borderRadius:9,border:"1px solid rgba(0,0,0,.12)",fontSize:13,outline:"none"}}
              />
            </div>
            <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
              <button onClick={() => { setChangeTarget(null); setHomeQuery(""); setHomeSuggs([]); setSelectedHome(null); setHomeName(""); }} style={{fontSize:12,padding:"7px 16px",borderRadius:8,border:"1px solid rgba(0,0,0,.12)",background:"transparent",color:"#6b6760",cursor:"pointer"}}>Cancel</button>
              <button disabled={!selectedHome||saving} onClick={() => setHome(changeTarget.id, selectedHome.place_id, homeName.trim() || selectedHome.description, selectedHome.lat, selectedHome.lng)}
                style={{fontSize:12,padding:"7px 16px",borderRadius:8,border:"none",
                  background:selectedHome&&!saving?"#1a1814":"rgba(0,0,0,.15)",
                  color:selectedHome&&!saving?"#faf8f4":"#a8a5a0",cursor:selectedHome&&!saving?"pointer":"not-allowed"}}>
                {saving ? "Saving…" : changeTarget?.home_lat ? "Change home" : "Move in"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── LlmTab ───────────────────────────────────────────────────────────────────
const CAPABILITIES = [
  { key:"encounter",          label:"Encounter",          group:"Output",   desc:"Real-time in-person scene generation" },
  { key:"synthesis",          label:"Synthesis",          group:"Output",   desc:"ThoughtEngine full psychology synthesis" },
  { key:"knock",              label:"Knock",              group:"Output",   desc:"Door knock decision" },
  { key:"door_narrative",     label:"Door narrative",     group:"Output",   desc:"Knock arrival narrative" },
  { key:"message_content",    label:"Message content",    group:"Output",   desc:"SMS content generation" },
  { key:"ambient_chat",       label:"Ambient chat",       group:"Output",   desc:"Ambient NPC chat generation" },
  { key:"social_process",     label:"Social process",     group:"Wave",     desc:"Wave 2 — relationship graph reasoning" },
  { key:"memory_process",     label:"Memory process",     group:"Wave",     desc:"Wave 2 — trigger matching & summarization" },
  { key:"affect_process",     label:"Affect process",     group:"Wave",     desc:"Wave 3 — emotion delta generation" },
  { key:"drive_process",      label:"Drive process",      group:"Wave",     desc:"Wave 3 — impulse generation" },
  { key:"decisions",          label:"Decisions",          group:"Planning", desc:"AgentLoop pool decisions" },
  { key:"thoughts",           label:"Thoughts",           group:"Planning", desc:"Internal actor reflection" },
  { key:"memory",             label:"Memory",             group:"Planning", desc:"Memory summarization" },
  { key:"planning",           label:"Planning",           group:"Planning", desc:"Schedule & objective generation" },
  { key:"relationship_score", label:"Rel scoring",        group:"Planning", desc:"Warmth/trust/tension scoring" },
  { key:"media_prompt",       label:"Media prompt",       group:"Planning", desc:"Kling/Hedra prompt generation" },
];

const MODEL_OPTIONS = [
  { value:"nevoria",    label:"Nevoria 70B (UpCloud)" },
  { value:"dirty-muse", label:"dirty-muse 9B (M4)" },
  { value:"haiku",      label:"Claude Haiku (API)" },
];

const PROVIDER_DEFAULTS = {
  nevoria_url:    "http://212.147.242.70:11434",
  dirty_muse_url: "http://192.168.1.60:11434",
};

function LlmTab({ world }) {
  const [config, setConfig]         = useState({});
  const [available, setAvailable]   = useState([]);
  const [providers, setProviders]   = useState({ nevoria_url: PROVIDER_DEFAULTS.nevoria_url, dirty_muse_url: PROVIDER_DEFAULTS.dirty_muse_url });
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(null); // capability being saved
  const [savingProviders, setSavingProviders] = useState(false);
  const [status, setStatus]         = useState(null);

  useEffect(() => {
    fetch(`/api/worlds/${world.id}/llm-config`)
      .then(r => r.ok ? r.json() : {})
      .then(data => {
        // capabilities: { encounter: { llm_id, name, alias }, ... }
        // available: [{ id, name, alias, url, model_tag, provider }, ...]
        const caps = {};
        Object.entries(data.capabilities || {}).forEach(([cap, v]) => {
          caps[cap] = v.llm_id || v.alias || "dirty-muse";
        });
        setConfig(caps);
        setAvailable(data.available || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [world.id]);

  async function setCapability(capability, llm_id) {
    setSaving(capability);
    setConfig(prev => ({ ...prev, [capability]: llm_id }));
    try {
      await fetch(`/api/worlds/${world.id}/llm-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world_id: world.id, capability, llm_id }),
      });
      const llm = available.find(l => l.id === llm_id);
      setStatus({ ok: true, msg: `${capability} → ${llm?.name || llm_id}` });
      setTimeout(() => setStatus(null), 2000);
    } catch {
      setStatus({ ok: false, msg: "Save failed" });
    }
    setSaving(null);
  }

  async function saveProviders() {
    setSavingProviders(true);
    try {
      await fetch(`/api/worlds/${world.id}/llm-config/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(providers),
      });
      setStatus({ ok: true, msg: "Provider URLs saved" });
      setTimeout(() => setStatus(null), 2000);
    } catch {
      setStatus({ ok: false, msg: "Save failed" });
    }
    setSavingProviders(false);
  }

  if (loading) return <p style={{fontSize:12,color:"#a8a5a0",padding:8}}>Loading…</p>;

  return (
    <div style={{display:"flex",gap:20}}>
      {/* Capabilities */}
      <div style={{flex:1}}>
        <p style={{fontSize:10,color:"#a8a5a0",letterSpacing:".1em",textTransform:"uppercase",margin:"0 0 10px"}}>Capabilities</p>
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {["Output","Wave","Planning"].map(group => (
            <div key={group}>
              <p style={{fontSize:10,color:"#a8a5a0",letterSpacing:".1em",textTransform:"uppercase",margin:"0 0 6px"}}>{group}</p>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {CAPABILITIES.filter(c => c.group === group).map(cap => (
                  <div key={cap.key} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                    padding:"8px 12px",background:"rgba(0,0,0,0.02)",border:"1px solid rgba(0,0,0,0.06)",borderRadius:7}}>
                    <div>
                      <div style={{fontSize:12,fontWeight:500,color:"#1a1814"}}>{cap.label}</div>
                      <div style={{fontSize:10,color:"#a8a5a0"}}>{cap.desc}</div>
                    </div>
                    <select
                      value={config[cap.key] || ""}
                      onChange={e => setCapability(cap.key, e.target.value)}
                      disabled={saving === cap.key}
                      style={{fontSize:11,padding:"4px 7px",borderRadius:6,border:"1px solid rgba(0,0,0,0.12)",
                        background:"#fff",color:"#1a1814",cursor:"pointer",minWidth:170}}>
                      <option value="">— default —</option>
                      {available.map(llm => (
                        <option key={llm.id} value={llm.id}>{llm.name}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Providers */}
      <div style={{width:260,flexShrink:0}}>
        <p style={{fontSize:10,color:"#a8a5a0",letterSpacing:".1em",textTransform:"uppercase",margin:"0 0 10px"}}>Provider URLs</p>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {[
            { key:"nevoria_url", label:"Nevoria (UpCloud)" },
            { key:"dirty_muse_url", label:"dirty-muse (M4)" },
          ].map(p => (
            <div key={p.key}>
              <label style={{fontSize:11,color:"#a8a5a0",display:"block",marginBottom:4}}>{p.label}</label>
              <input
                value={providers[p.key] || ""}
                onChange={e => setProviders(prev => ({ ...prev, [p.key]: e.target.value }))}
                style={{width:"100%",boxSizing:"border-box",padding:"8px 10px",borderRadius:7,
                  border:"1px solid rgba(0,0,0,0.12)",fontSize:12,color:"#1a1814",outline:"none"}}
              />
            </div>
          ))}
          <button onClick={saveProviders} disabled={savingProviders}
            style={{fontSize:11,letterSpacing:".06em",textTransform:"uppercase",padding:"8px 14px",
              borderRadius:7,background:"#1a1814",color:"#faf8f4",border:"none",cursor:"pointer",marginTop:4}}>
            {savingProviders ? "Saving…" : "Save URLs"}
          </button>
        </div>

        {status && (
          <div style={{marginTop:12,padding:"8px 12px",borderRadius:7,fontSize:12,
            background: status.ok ? "rgba(29,158,117,0.08)" : "rgba(192,57,43,0.08)",
            border: `1px solid ${status.ok ? "rgba(29,158,117,0.3)" : "rgba(192,57,43,0.3)"}`,
            color: status.ok ? "#1D9E75" : "#993c1d"}}>
            {status.ok ? "✓" : "✕"} {status.msg}
          </div>
        )}
      </div>
    </div>
  );
}

// ── WorldConfigModal ──────────────────────────────────────────────────────────
function WorldConfigModal({ world, onClose, onDeleted }) {
  const [activeTab, setActiveTab] = useState("modules");
  const [name, setName]         = useState(world.name);
  const [saving, setSaving]     = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [modules, setModules]   = useState(null);

  useEffect(() => {
    fetch(`/api/worlds/${world.id}/modules`)
      .then(r => r.ok ? r.json() : {})
      .then(data => setModules(data))
      .catch(() => setModules({}));
  }, [world.id]);

  function toggleModule(key) { setModules(prev => ({ ...prev, [key]: !prev[key] })); }

  async function save() {
    setSaving(true);
    try {
      await fetch(`/api/worlds/${world.id}/modules`, {
        method:"PATCH", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ modules }),
      });
    } catch {}
    setSaving(false);
    onClose();
  }

  async function deleteWorld() {
    if (!window.confirm(`Delete "${world.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try { await fetch(`/api/worlds/${world.id}`, { method:"DELETE" }); onDeleted(world.id); } catch {}
    setDeleting(false);
  }

  const TABS = [
    { key:"modules",    label:"Modules" },
    { key:"residences", label:"Residences" },
    { key:"llm",        label:"LLM" },
    { key:"info",       label:"Info" },
  ];

  return (
    <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.5)",
      display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}>
      <div style={{background:"#faf8f4",borderRadius:16,width:"100%",
        maxWidth: activeTab==="residences" || activeTab==="llm" ? 920 : 520,
        boxShadow:"0 24px 64px rgba(0,0,0,0.2)",overflow:"hidden",...F}}>
        <div style={{padding:"20px 24px 0"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <h2 style={{...serif,fontSize:22,fontWeight:500,margin:0,color:"#1a1814"}}>{world.name}</h2>
            <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",color:"#a8a5a0",fontSize:18,lineHeight:1,padding:4}}>✕</button>
          </div>
          {/* Tabs */}
          <div style={{display:"flex",gap:4,borderBottom:"1px solid rgba(0,0,0,.08)",marginBottom:0}}>
            {TABS.map(t => (
              <button key={t.key} onClick={() => setActiveTab(t.key)}
                style={{fontSize:12,letterSpacing:".05em",textTransform:"uppercase",padding:"8px 14px",
                  border:"none",background:"none",cursor:"pointer",
                  color: activeTab===t.key ? "#1a1814" : "#a8a5a0",
                  borderBottom: activeTab===t.key ? "2px solid #1a1814" : "2px solid transparent",
                  marginBottom:-1}}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Residences tab — full width map */}
        {activeTab==="residences" && (
          <div style={{height:520}}>
            <ResidencesTab world={world} />
          </div>
        )}

        {/* LLM tab */}
        {activeTab==="llm" && (
          <div style={{padding:"14px 24px 20px",height:520,overflowY:"auto"}}>
            <LlmTab world={world} />
          </div>
        )}

        {/* Modules tab */}
        {activeTab==="modules" && (
          <div style={{padding:"14px 24px 20px",display:"flex",flexDirection:"column",gap:14}}>
            <div>
              <label style={{fontSize:11,color:"#a8a5a0",display:"block",marginBottom:5}}>World name</label>
              <input value={name} onChange={e=>setName(e.target.value)}
                style={{width:"100%",boxSizing:"border-box",border:"1px solid rgba(0,0,0,0.12)",
                  borderRadius:8,padding:"9px 12px",fontSize:13,color:"#1a1814",background:"#fff",outline:"none"}}/>
            </div>
            <div style={{padding:"12px 14px",background:"rgba(0,0,0,0.02)",border:"1px solid rgba(0,0,0,0.06)",borderRadius:10}}>
              <p style={{fontSize:11,color:"#a8a5a0",margin:"0 0 10px",letterSpacing:".06em",textTransform:"uppercase"}}>Modules</p>
              {modules === null ? <p style={{fontSize:12,color:"#a8a5a0",margin:0}}>Loading...</p> : MODULES_DEF.map(m => (
                <div key={m.key} onClick={() => toggleModule(m.key)}
                  style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                    padding:"8px 0",cursor:"pointer",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>
                  <div>
                    <p style={{fontSize:13,color:"#1a1814",margin:"0 0 1px",fontWeight:500}}>{m.label}</p>
                    <p style={{fontSize:11,color:"#a8a5a0",margin:0}}>{m.desc}</p>
                  </div>
                  <div style={{width:36,height:20,borderRadius:10,flexShrink:0,marginLeft:12,
                    background:modules[m.key]?"#1a1814":"rgba(0,0,0,0.15)",position:"relative",transition:"background 0.15s"}}>
                    <div style={{position:"absolute",top:3,width:14,height:14,borderRadius:"50%",
                      background:"#faf8f4",left:modules[m.key]?19:3,transition:"left 0.12s"}}/>
                  </div>
                </div>
              ))}
            </div>
            <div style={{display:"flex",justifyContent:"flex-end",gap:8,paddingTop:4}}>
              <button onClick={onClose} style={{background:"transparent",color:"#6b6760",border:"1px solid rgba(0,0,0,0.12)",borderRadius:8,padding:"8px 18px",fontSize:12,cursor:"pointer"}}>Cancel</button>
              <button onClick={save} disabled={saving} style={{background:"#1a1814",color:"#faf8f4",border:"none",borderRadius:8,padding:"8px 18px",fontSize:12,cursor:"pointer"}}>{saving?"Saving…":"Save"}</button>
            </div>
          </div>
        )}

        {/* Info tab */}
        {activeTab==="info" && (
          <div style={{padding:"14px 24px 20px",display:"flex",flexDirection:"column",gap:14}}>
            <div style={{padding:"12px 14px",background:"rgba(0,0,0,0.02)",border:"1px solid rgba(0,0,0,0.06)",borderRadius:10}}>
              {[["City",world.city||"—"],["Timezone",world.timezone||"—"],["Status",world.status],["Characters",world.actor_count??0],["Members",world.member_count??0]].map(([k,v]) => (
                <div key={k} style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:12,color:"#a8a5a0"}}>{k}</span>
                  <span style={{fontSize:12,color:"#1a1814"}}>{v}</span>
                </div>
              ))}
            </div>
            <div style={{padding:"12px 14px",background:"rgba(192,57,43,0.04)",border:"1px solid rgba(192,57,43,0.12)",borderRadius:10}}>
              <p style={{fontSize:11,color:"#993c1d",margin:"0 0 8px",letterSpacing:".06em",textTransform:"uppercase"}}>Danger zone</p>
              <p style={{fontSize:12,color:"#a8a5a0",margin:"0 0 10px"}}>Permanently deletes all world data. Cannot be undone.</p>
              <button onClick={deleteWorld} disabled={deleting}
                style={{fontSize:11,letterSpacing:".05em",textTransform:"uppercase",padding:"7px 16px",
                  borderRadius:8,background:"rgba(192,57,43,0.08)",color:"#993c1d",border:"1px solid rgba(192,57,43,0.2)",cursor:"pointer"}}>
                {deleting ? "Deleting..." : `Delete "${world.name}"`}
              </button>
            </div>
          </div>
        )}
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
