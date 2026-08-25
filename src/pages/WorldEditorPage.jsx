import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import LlmConfigPanel from "./LlmConfigPanel.jsx";
import { isPreciseHome, IMPRECISE_HOME_HINT } from "../lib/placePrecision.js";

// ── WorldEditorPage ───────────────────────────────────────────────────────────
//
// Session 150 — the world used to be configured through an overlay launched from
// a card on /my-worlds. That put world-scoped settings and character-scoped
// settings on two different surfaces with no path between them, and it meant a
// world had no address of its own: you could not link to one, reload into one,
// or press back out of one.
//
// This is that overlay turned into a page at /my-worlds/:worldId, using the same
// sidebar shell as the character editor so the two read as siblings. Every panel
// the modal had is still here — modules, residences, LLM, info — plus the cast,
// which is the part that was missing: the characters deployed INTO this world,
// each linking to their world-scoped editor.
//
// The split this establishes: /actors/:id edits the character TEMPLATE, which is
// what a deploy ships. /my-worlds/:worldId/actors/:actorId edits the deployed
// INSTANCE, which is what the simulator actually runs.

const F     = { fontFamily:"'DM Sans',system-ui,sans-serif" };
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

function ini(n) { return (n || "?").split(" ").map(w => w[0]).slice(0,2).join("").toUpperCase(); }

function NavSection({ label }) {
  return <div style={{ ...F, fontSize:9, letterSpacing:".18em", textTransform:"uppercase", color:"#a8a5a0", padding:"10px 20px 4px" }}>{label}</div>;
}

function NavItem({ label, active, done, danger, onClick }) {
  return (
    <div onClick={onClick} style={{
      display:"flex", alignItems:"center", gap:8, padding:"8px 20px", cursor:"pointer", ...F, fontSize:12,
      color: danger ? "#993c1d" : active ? "#1a1814" : "#6b6760",
      background: active ? "rgba(255,255,255,.5)" : "transparent",
      borderLeft: active ? "2px solid #b05c08" : "2px solid transparent",
      fontWeight: active ? 500 : 400, transition:"all .15s",
    }}>
      <div style={{ width:6, height:6, borderRadius:"50%", flexShrink:0,
        background: danger ? "rgba(153,60,29,.35)" : done ? "#34c759" : "rgba(0,0,0,.12)" }} />
      {label}
    </div>
  );
}

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
                // Session 150 — this read `q`, which is declared nowhere in this
                // file. The handler threw ReferenceError on the first keystroke,
                // so "Move in / Change home" has never returned a suggestion.
                const query = e.target.value; setHomeQuery(query);
                if (query.length < 3) { setHomeSuggs([]); return; }
                const resp = await fetch(`/api/places/autocomplete?q=${encodeURIComponent(query)}`).then(r=>r.ok?r.json():[]);
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
                      setSelectedHome({ place_id: s.place_id, description: s.description, lat: det?.lat, lng: det?.lng, types: det?.types ?? s.types });
                    }} style={{padding:"10px 14px",fontSize:13,cursor:"pointer",borderBottom:"1px solid rgba(0,0,0,.05)",
                      color: isPreciseHome(s.types) ? "inherit" : "#a8a5a0"}}
                      onMouseEnter={e=>e.currentTarget.style.background="rgba(0,0,0,.03)"}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      {s.description}
                      {!isPreciseHome(s.types) && (
                        <div style={{fontSize:10,color:"#b8763a",marginTop:2}}>{IMPRECISE_HOME_HINT}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {selectedHome && (
              isPreciseHome(selectedHome.types) ? (
                <div style={{padding:"8px 12px",background:"rgba(29,158,117,.06)",border:"1px solid rgba(29,158,117,.3)",borderRadius:8,fontSize:12,color:"#1D9E75",marginBottom:12}}>
                  ✓ {selectedHome.description}
                </div>
              ) : (
                // Session 150 — moving someone into a street rather than a
                // building is what produced the second, tenantless Narvavägen
                // apartment. See lib/placePrecision.js.
                <div style={{padding:"8px 12px",background:"rgba(184,118,58,.07)",border:"1px solid rgba(184,118,58,.35)",borderRadius:8,fontSize:12,color:"#8a5624",marginBottom:12,lineHeight:1.45}}>
                  That is the whole street. Search again with a house number — she needs a
                  building to live in, not a road.
                </div>
              )
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
              {(() => { const homeOk = !!selectedHome && isPreciseHome(selectedHome.types) && !saving; return (
              <button disabled={!homeOk} onClick={() => setHome(changeTarget.id, selectedHome.place_id, homeName.trim() || selectedHome.description, selectedHome.lat, selectedHome.lng)}
                style={{fontSize:12,padding:"7px 16px",borderRadius:8,border:"none",
                  background:homeOk?"#1a1814":"rgba(0,0,0,.15)",
                  color:homeOk?"#faf8f4":"#a8a5a0",cursor:homeOk?"pointer":"not-allowed"}}>
                {saving ? "Saving…" : changeTarget?.home_lat ? "Change home" : "Move in"}
              </button>
              ); })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MembersPanel ──────────────────────────────────────────────────────────────
//
// Session 150 — who belongs to this world, and what they may do.
//
// Members could only ever be set when a world was created: there was no way to
// add anyone afterwards, promote a member, or remove one. A world's people were
// fixed at birth, which is a strange limit for a system whose premise is worlds
// you share.
//
// A world may have SEVERAL owners. The last one cannot be demoted or removed —
// the server refuses — because a world with no owner is a world nobody can
// configure, start, or delete.
const ROLE_HELP = {
  owner:  "Full control — start and stop, configure, deploy characters, manage members, delete the world.",
  player: "Lives in the world — enters it, has their own player character, and talks to the cast. Cannot change how the world is built.",
};

function MembersPanel({ worldId, isOwner }) {
  const [members, setMembers] = useState(undefined);
  const [users, setUsers]     = useState([]);
  const [pick, setPick]       = useState("");
  const [role, setRole]       = useState("player");
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);

  function load() {
    fetch(`/api/worlds/${worldId}/members`)
      .then(r => r.ok ? r.json() : []).then(setMembers).catch(() => setMembers([]));
  }
  useEffect(() => {
    load();
    fetch("/api/users").then(r => r.ok ? r.json() : []).then(setUsers).catch(() => {});
  }, [worldId]);

  if (members === undefined) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>Loading…</p>;

  const memberIds = new Set(members.map(m => m.id));
  const available = users.filter(u => !memberIds.has(u.id));
  const ownerCount = members.filter(m => m.role === "owner").length;

  async function call(method, path, body) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(path, body
        ? { method, headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) }
        : { method });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || `Failed — HTTP ${r.status}`); setBusy(false); return false; }
      load();
    } catch (e) { setError(e.message); }
    setBusy(false);
    return true;
  }

  const add     = () => { const u = users.find(x => x.id === pick); if (u) call("POST", `/api/worlds/${worldId}/members`, { email: u.email, role }).then(ok => ok && setPick("")); };
  const setRoleOf = (id, r) => call("PATCH", `/api/worlds/${worldId}/members/${id}`, { role: r });
  const remove  = (id)      => call("DELETE", `/api/worlds/${worldId}/members/${id}`);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:18, maxWidth:600 }}>
      {isOwner && (
        <div>
          <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:8 }}>Add someone</div>
          {available.length === 0 ? (
            <p style={{ ...F, fontSize:13, color:"#a8a5a0", margin:0 }}>Everyone already belongs to this world.</p>
          ) : (
            <>
              <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                <select value={pick} onChange={e => setPick(e.target.value)}
                  style={{ ...F, flex:1, minWidth:170, fontSize:13, padding:"8px 11px", borderRadius:9,
                    border:"1px solid rgba(0,0,0,.12)", background:"rgba(255,255,255,.8)", color: pick ? "#1a1814" : "#a8a5a0" }}>
                  <option value="">Select person…</option>
                  {available.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                <select value={role} onChange={e => setRole(e.target.value)}
                  style={{ ...F, fontSize:13, padding:"8px 11px", borderRadius:9, border:"1px solid rgba(0,0,0,.12)", background:"rgba(255,255,255,.8)" }}>
                  <option value="player">Player</option>
                  <option value="owner">Owner</option>
                </select>
                <button onClick={add} disabled={busy || !pick}
                  style={{ ...F, fontSize:11, letterSpacing:".06em", textTransform:"uppercase", padding:"9px 18px",
                    borderRadius:9, border:"none", background:"#1a1814", color:"#faf8f4",
                    cursor: (busy||!pick) ? "default" : "pointer", opacity: (busy||!pick) ? .4 : 1 }}>
                  {busy ? "…" : "Add"}
                </button>
              </div>
              <div style={{ ...F, fontSize:11, color:"#a8a5a0", marginTop:7, lineHeight:1.55 }}>
                <b style={{ fontWeight:500, color: role === "owner" ? "#0F6E56" : "#6b6760" }}>{role}</b> — {ROLE_HELP[role]}
              </div>
            </>
          )}
        </div>
      )}

      {error && <div style={{ ...F, fontSize:12, color:"#993c1d" }}>{error}</div>}

      <div>
        <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:8 }}>
          Members — {members.length}
        </div>
        {members.map(m => {
          const owner = m.role === "owner";
          const lastOwner = owner && ownerCount <= 1;
          return (
            <div key={m.id} style={{ display:"flex", alignItems:"center", gap:11, padding:"9px 0", borderBottom:"1px solid rgba(0,0,0,.05)" }}>
              {m.photo_url
                ? <img src={m.photo_url} alt="" style={{ width:30, height:30, borderRadius:"50%", objectFit:"cover", flexShrink:0 }} />
                : <div style={{ width:30, height:30, borderRadius:"50%", background:"rgba(0,0,0,.06)", display:"flex", alignItems:"center", justifyContent:"center", ...F, fontSize:11, color:"#6b6760", flexShrink:0 }}>{ini(m.name)}</div>}
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ ...F, fontSize:13, color:"#1a1814" }}>{m.name}</div>
                <div style={{ ...F, fontSize:11, color:"#a8a5a0", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{m.email}</div>
              </div>

              {isOwner ? (
                <select value={m.role || "player"} onChange={e => setRoleOf(m.id, e.target.value)}
                  disabled={busy || lastOwner}
                  title={lastOwner ? "The world's only owner — make someone else an owner first" : undefined}
                  style={{ ...F, fontSize:11.5, padding:"5px 9px", borderRadius:7, border:"1px solid rgba(0,0,0,.12)",
                    background: owner ? "rgba(29,158,117,.08)" : "rgba(255,255,255,.75)",
                    color: owner ? "#0F6E56" : "#6b6760", cursor: lastOwner ? "default" : "pointer", opacity: lastOwner ? .6 : 1 }}>
                  <option value="player">player</option>
                  <option value="owner">owner</option>
                </select>
              ) : (
                <span style={{ ...F, fontSize:9, letterSpacing:".08em", textTransform:"uppercase", padding:"3px 8px",
                  borderRadius:5, background: owner ? "rgba(29,158,117,.1)" : "rgba(0,0,0,.04)",
                  color: owner ? "#0F6E56" : "#6b6760" }}>{m.role || "player"}</span>
              )}

              {isOwner && (
                <span onClick={() => !lastOwner && !busy && remove(m.id)}
                  title={lastOwner ? "The world's only owner cannot be removed" : `Remove ${m.name}`}
                  style={{ ...F, fontSize:13, color: lastOwner ? "rgba(0,0,0,.15)" : "#c0392b",
                    cursor: lastOwner ? "default" : "pointer", padding:"0 3px", flexShrink:0 }}>✕</span>
              )}
            </div>
          );
        })}
      </div>

      {!isOwner && (
        <p style={{ ...F, fontSize:11.5, color:"#a8a5a0", margin:0, lineHeight:1.6 }}>
          Only an owner of this world can add, promote or remove members.
        </p>
      )}
    </div>
  );
}

// ── Panels ────────────────────────────────────────────────────────────────────
function OverviewPanel({ world, cast, onToggleRun, busy }) {
  const running = world.status === "running" || world.status === "active";
  const rows = [
    ["City",     world.city || "—"],
    ["Timezone", world.timezone || "—"],
    ["Currency", world.currency || "—"],
    ["Language", world.language || "—"],
    ["Domain",   world.domain_type || "—"],
    ["Rating",   world.content_rating || "—"],
    ["Persistence", world.persistence_mode || "—"],
    ["Time compression", world.time_compression ? `${world.time_compression}×` : "—"],
    ["Characters", cast.length],
    ["Members",  world.member_count ?? 0],
  ];
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16, maxWidth:560 }}>
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        <div style={{ width:8, height:8, borderRadius:"50%", background: running ? "#1D9E75" : "#c8c5c0" }} />
        <span style={{ ...F, fontSize:12, color: running ? "#1D9E75" : "#a8a5a0", letterSpacing:".06em", textTransform:"uppercase" }}>{world.status}</span>
        <button onClick={onToggleRun} disabled={busy}
          style={{ ...F, marginLeft:"auto", fontSize:11, letterSpacing:".06em", textTransform:"uppercase",
            padding:"7px 16px", borderRadius:8, cursor: busy ? "default" : "pointer",
            background: running ? "none" : "#1a1814", color: running ? "#6b6760" : "#faf8f4",
            border: running ? "1px solid rgba(0,0,0,.12)" : "none", opacity: busy ? .6 : 1 }}>
          {busy ? "Working…" : running ? "Stop world" : "Start world"}
        </button>
      </div>
      <div style={{ padding:"12px 14px", background:"rgba(0,0,0,0.02)", border:"1px solid rgba(0,0,0,0.06)", borderRadius:10 }}>
        {rows.map(([k,v]) => (
          <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"4px 0" }}>
            <span style={{ ...F, fontSize:12, color:"#a8a5a0" }}>{k}</span>
            <span style={{ ...F, fontSize:12, color:"#1a1814" }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModulesPanel({ worldId }) {
  const [modules, setModules] = useState(null);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);

  useEffect(() => {
    fetch(`/api/worlds/${worldId}/modules`)
      .then(r => r.ok ? r.json() : {}).then(setModules).catch(() => setModules({}));
  }, [worldId]);

  function toggle(key) { setSaved(false); setModules(p => ({ ...p, [key]: !p[key] })); }

  async function save() {
    setSaving(true);
    try {
      await fetch(`/api/worlds/${worldId}/modules`, {
        method:"PATCH", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ modules }),
      });
      setSaved(true);
    } catch {}
    setSaving(false);
  }

  if (modules === null) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>Loading…</p>;

  return (
    <div style={{ maxWidth:560 }}>
      <div style={{ padding:"12px 14px", background:"rgba(0,0,0,0.02)", border:"1px solid rgba(0,0,0,0.06)", borderRadius:10 }}>
        {MODULES_DEF.map(m => (
          <div key={m.key} onClick={() => toggle(m.key)}
            style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
              padding:"8px 0", cursor:"pointer", borderBottom:"1px solid rgba(0,0,0,0.05)" }}>
            <div>
              <p style={{ ...F, fontSize:13, color:"#1a1814", margin:"0 0 1px", fontWeight:500 }}>{m.label}</p>
              <p style={{ ...F, fontSize:11, color:"#a8a5a0", margin:0 }}>{m.desc}</p>
            </div>
            <div style={{ width:36, height:20, borderRadius:10, flexShrink:0, marginLeft:12,
              background: modules[m.key] ? "#1a1814" : "rgba(0,0,0,0.15)", position:"relative", transition:"background .15s" }}>
              <div style={{ position:"absolute", top:3, width:14, height:14, borderRadius:"50%",
                background:"#faf8f4", left: modules[m.key] ? 19 : 3, transition:"left .12s" }} />
            </div>
          </div>
        ))}
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:12, justifyContent:"flex-end", paddingTop:12 }}>
        {saved && <span style={{ ...F, fontSize:11, color:"#1D9E75" }}>Saved</span>}
        <button onClick={save} disabled={saving}
          style={{ ...F, background:"#1a1814", color:"#faf8f4", border:"none", borderRadius:8,
            padding:"8px 18px", fontSize:12, cursor:"pointer", opacity: saving ? .6 : 1 }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// Session 150 — window.confirm() is suppressed in embedded browser panes: it
// returns false without showing anything, so a confirm-gated button is simply
// inert. Deleting a world is the most destructive action in the app, so it gets
// a real in-page confirm rather than a dialog that may never appear.
function DangerPanel({ world, onDeleted }) {
  const [armed, setArmed]       = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError]       = useState(null);

  async function del() {
    setDeleting(true); setError(null);
    try {
      const r = await fetch(`/api/worlds/${world.id}`, { method:"DELETE" });
      if (!r.ok) { setError(`Delete failed — HTTP ${r.status}`); setDeleting(false); return; }
      onDeleted(world.id);
    } catch (e) { setError(`Delete failed — ${e.message}`); setDeleting(false); }
  }

  return (
    <div style={{ maxWidth:560, padding:"14px 16px", background:"rgba(192,57,43,0.04)",
      border:"1px solid rgba(192,57,43,0.12)", borderRadius:10 }}>
      <p style={{ ...F, fontSize:11, color:"#993c1d", margin:"0 0 8px", letterSpacing:".06em", textTransform:"uppercase" }}>Danger zone</p>
      <p style={{ ...F, fontSize:12, color:"#6b6760", margin:"0 0 12px", lineHeight:1.6 }}>
        Permanently deletes this world and everything in it — every deployed character's
        instance, their relationships, memories, schedules and bank accounts. The character
        templates on the Characters page are not affected. This cannot be undone.
      </p>
      {error && <p style={{ ...F, fontSize:12, color:"#993c1d", margin:"0 0 10px" }}>{error}</p>}
      {!armed ? (
        <button onClick={() => setArmed(true)}
          style={{ ...F, fontSize:11, letterSpacing:".05em", textTransform:"uppercase", padding:"7px 16px",
            borderRadius:8, background:"rgba(192,57,43,0.08)", color:"#993c1d",
            border:"1px solid rgba(192,57,43,0.2)", cursor:"pointer" }}>
          Delete "{world.name}"
        </button>
      ) : (
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ ...F, fontSize:12, color:"#993c1d" }}>Delete "{world.name}" for good?</span>
          <button onClick={() => setArmed(false)} disabled={deleting}
            style={{ ...F, fontSize:11, letterSpacing:".05em", textTransform:"uppercase", padding:"7px 14px",
              borderRadius:8, background:"none", color:"#6b6760", border:"1px solid rgba(0,0,0,.12)", cursor:"pointer" }}>
            Cancel
          </button>
          <button onClick={del} disabled={deleting}
            style={{ ...F, fontSize:11, letterSpacing:".05em", textTransform:"uppercase", padding:"7px 14px",
              borderRadius:8, background:"#993c1d", color:"#faf8f4", border:"none", cursor:"pointer", opacity: deleting ? .6 : 1 }}>
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function WorldEditorPage() {
  const { worldId } = useParams();
  const navigate    = useNavigate();
  const [world, setWorld] = useState(null);
  const [cast,  setCast]  = useState([]);
  // ?tab= lets a caller deep-link a panel — the world card's Members button
  // goes straight there rather than dropping you on Overview to hunt for it.
  const [params] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = params.get("tab");
    return ["overview","modules","residences","llm","members","danger"].includes(t) ? t : "overview";
  });
  const [busy,  setBusy]  = useState(false);
  const [missing, setMissing] = useState(false);

  // There is no GET /api/worlds/:id — the list endpoint is the only way in, and
  // it is already scoped to worlds this user is a member of, so resolving from
  // it also enforces access.
  function loadWorld() {
    return fetch("/api/worlds")
      .then(r => r.ok ? r.json() : [])
      .then(ws => {
        const w = ws.find(x => x.id === worldId);
        if (!w) { setMissing(true); return; }
        setWorld(w);
        document.title = `Anima — ${w.name}`;
      })
      .catch(() => setMissing(true));
  }

  useEffect(() => {
    loadWorld();
    fetch(`/api/worlds/${worldId}/actors`)
      .then(r => r.ok ? r.json() : []).then(d => setCast(Array.isArray(d) ? d : [])).catch(() => {});
  }, [worldId]);

  async function toggleRun() {
    if (!world) return;
    const running = world.status === "running" || world.status === "active";
    setBusy(true);
    try {
      await fetch(`/api/worlds/${worldId}/${running ? "stop" : "start"}`, { method:"POST" });
      await loadWorld();
    } catch {}
    setBusy(false);
  }

  if (missing) return (
    <div style={{ background:"#eeecea", minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:12 }}>
      <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>That world doesn't exist, or you're not a member of it.</p>
      <a onClick={() => navigate("/my-worlds")} style={{ ...F, fontSize:12, color:"#b05c08", cursor:"pointer" }}>← Back to worlds</a>
    </div>
  );

  if (!world) return (
    <div style={{ background:"#eeecea", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>Loading…</p>
    </div>
  );

  const running = world.status === "running" || world.status === "active";

  const panels = {
    overview:   <OverviewPanel world={world} cast={cast} onToggleRun={toggleRun} busy={busy} />,
    modules:    <ModulesPanel worldId={worldId} />,
    residences: <div style={{ height:560, margin:"-24px -28px" }}><ResidencesTab world={world} /></div>,
    llm:        <LlmConfigPanel world={world} />,
    members:    <MembersPanel worldId={worldId} isOwner={world.role === "owner"} />,
    danger:     <DangerPanel world={world} onDeleted={() => navigate("/my-worlds")} />,
  };

  const LABELS = { overview:"Overview", modules:"Modules", residences:"Residences", llm:"LLM and voice", members:"Members", danger:"Delete world" };

  return (
    <div style={{ background:"#eeecea", minHeight:"100vh", position:"relative" }}>
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:0, background:"radial-gradient(ellipse at 12% 18%, rgba(230,180,100,.22) 0%, transparent 45%), radial-gradient(ellipse at 88% 78%, rgba(160,185,230,.18) 0%, transparent 45%), #eeecea" }} />
      <div style={{ position:"relative", zIndex:1, display:"grid", gridTemplateColumns:"240px 1fr", minHeight:"100vh" }}>

        {/* Sidebar */}
        <div style={{ background:"rgba(255,255,255,.55)", backdropFilter:"blur(40px)", WebkitBackdropFilter:"blur(40px)", borderRight:"1px solid rgba(255,255,255,.9)", display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"20px 20px 16px", borderBottom:"1px solid rgba(0,0,0,.06)" }}>
            <a onClick={() => navigate("/my-worlds")} style={{ ...F, fontSize:11, letterSpacing:".08em", textTransform:"uppercase", color:"#a8a5a0", cursor:"pointer", display:"block", marginBottom:16 }}>← Worlds</a>
            <div style={{ ...serif, fontSize:20, fontWeight:500, color:"#1a1814", lineHeight:1.1 }}>{world.name}</div>
            <div style={{ ...F, fontSize:11, color:"#a8a5a0", marginTop:3 }}>
              {[world.city, world.currency].filter(Boolean).join(" · ")}
            </div>
            <span style={{ display:"inline-flex", alignItems:"center", gap:6, ...F, fontSize:9, letterSpacing:".08em",
              textTransform:"uppercase", padding:"3px 8px", borderRadius:5, marginTop:8,
              background: running ? "rgba(29,158,117,.1)" : "rgba(0,0,0,.05)",
              color: running ? "#0F6E56" : "#a8a5a0" }}>
              <span style={{ width:5, height:5, borderRadius:"50%", background: running ? "#1D9E75" : "#c8c5c0" }} />
              {world.status}
            </span>
          </div>

          <div style={{ flex:1, overflowY:"auto", paddingBottom:8 }}>
            <NavSection label="World" />
            {["overview","modules","residences","llm","members"].map(k => (
              <NavItem key={k} label={LABELS[k]} active={tab===k} done onClick={() => setTab(k)} />
            ))}

            <NavSection label={`Cast — ${cast.length}`} />
            {cast.length === 0 && (
              <div style={{ ...F, fontSize:11, color:"#a8a5a0", padding:"4px 20px 8px" }}>Nobody deployed yet.</div>
            )}
            {cast.map(a => (
              <div key={a.id} onClick={() => navigate(`/my-worlds/${worldId}/actors/${a.id}`)}
                style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 20px", cursor:"pointer", ...F, fontSize:12, color:"#6b6760" }}>
                {a.photo_url
                  ? <img src={a.photo_url} alt="" style={{ width:22, height:22, borderRadius:"50%", objectFit:"cover", flexShrink:0 }} />
                  : <div style={{ width:22, height:22, borderRadius:"50%", background:"rgba(0,0,0,.07)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, color:"#6b6760", flexShrink:0 }}>{ini(a.name)}</div>}
                <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{a.name}</span>
              </div>
            ))}
            <div onClick={() => navigate("/actors")}
              style={{ ...F, fontSize:12, color:"#b05c08", padding:"7px 20px", cursor:"pointer" }}>+ Deploy character</div>

            <NavSection label="Danger" />
            <NavItem label={LABELS.danger} active={tab==="danger"} danger onClick={() => setTab("danger")} />
          </div>
        </div>

        {/* Main */}
        <div style={{ display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"20px 28px 16px", borderBottom:"1px solid rgba(0,0,0,.06)", background:"rgba(255,255,255,.3)", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)" }}>
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
