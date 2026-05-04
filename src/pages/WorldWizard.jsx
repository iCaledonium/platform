import { useState, useEffect, useRef } from "react";

const CITIES = [
  {n:"Stockholm",    lat:59.33, lng:18.07,  tz:"Europe/Stockholm",               x:528,y:85},
  {n:"Oslo",         lat:59.91, lng:10.75,  tz:"Europe/Oslo",                    x:509,y:84},
  {n:"Copenhagen",   lat:55.68, lng:12.57,  tz:"Europe/Copenhagen",              x:514,y:95},
  {n:"Helsinki",     lat:60.17, lng:24.93,  tz:"Europe/Helsinki",                x:546,y:83},
  {n:"London",       lat:51.51, lng:-0.13,  tz:"Europe/London",                  x:480,y:107},
  {n:"Paris",        lat:48.85, lng:2.35,   tz:"Europe/Paris",                   x:486,y:114},
  {n:"Berlin",       lat:52.52, lng:13.40,  tz:"Europe/Berlin",                  x:516,y:104},
  {n:"Madrid",       lat:40.42, lng:-3.70,  tz:"Europe/Madrid",                  x:470,y:138},
  {n:"Rome",         lat:41.90, lng:12.50,  tz:"Europe/Rome",                    x:513,y:134},
  {n:"Amsterdam",    lat:52.37, lng:4.90,   tz:"Europe/Amsterdam",               x:493,y:105},
  {n:"Vienna",       lat:48.21, lng:16.37,  tz:"Europe/Vienna",                  x:524,y:116},
  {n:"Athens",       lat:37.98, lng:23.73,  tz:"Europe/Athens",                  x:543,y:145},
  {n:"Moscow",       lat:55.75, lng:37.62,  tz:"Europe/Moscow",                  x:580,y:95},
  {n:"Istanbul",     lat:41.01, lng:28.95,  tz:"Europe/Istanbul",                x:557,y:136},
  {n:"Reykjavik",    lat:64.13, lng:-21.82, tz:"Atlantic/Reykjavik",             x:422,y:72},
  {n:"New York",     lat:40.71, lng:-74.01, tz:"America/New_York",               x:283,y:137},
  {n:"Los Angeles",  lat:34.05, lng:-118.24,tz:"America/Los_Angeles",            x:165,y:155},
  {n:"Chicago",      lat:41.88, lng:-87.63, tz:"America/Chicago",                x:246,y:134},
  {n:"Miami",        lat:25.77, lng:-80.19, tz:"America/New_York",               x:266,y:178},
  {n:"Toronto",      lat:43.65, lng:-79.38, tz:"America/Toronto",                x:268,y:129},
  {n:"Vancouver",    lat:49.28, lng:-123.12,tz:"America/Vancouver",              x:152,y:113},
  {n:"San Francisco",lat:37.77, lng:-122.42,tz:"America/Los_Angeles",            x:154,y:145},
  {n:"Mexico City",  lat:19.43, lng:-99.13, tz:"America/Mexico_City",            x:216,y:196},
  {n:"São Paulo",    lat:-23.55,lng:-46.63, tz:"America/Sao_Paulo",              x:356,y:315},
  {n:"Buenos Aires", lat:-34.60,lng:-58.38, tz:"America/Argentina/Buenos_Aires", x:324,y:346},
  {n:"Bogotá",       lat:4.71,  lng:-74.07, tz:"America/Bogota",                 x:282,y:237},
  {n:"Lima",         lat:-12.05,lng:-77.04, tz:"America/Lima",                   x:275,y:283},
  {n:"Dubai",        lat:25.20, lng:55.27,  tz:"Asia/Dubai",                     x:627,y:180},
  {n:"Tokyo",        lat:35.68, lng:139.69, tz:"Asia/Tokyo",                     x:853,y:151},
  {n:"Singapore",    lat:1.35,  lng:103.82, tz:"Asia/Singapore",                 x:757,y:246},
  {n:"Mumbai",       lat:19.08, lng:72.88,  tz:"Asia/Kolkata",                   x:674,y:197},
  {n:"Bangkok",      lat:13.75, lng:100.52, tz:"Asia/Bangkok",                   x:748,y:212},
  {n:"Seoul",        lat:37.57, lng:126.98, tz:"Asia/Seoul",                     x:819,y:146},
  {n:"Shanghai",     lat:31.23, lng:121.47, tz:"Asia/Shanghai",                  x:804,y:163},
  {n:"Beijing",      lat:39.91, lng:116.39, tz:"Asia/Shanghai",                  x:790,y:139},
  {n:"Kuala Lumpur", lat:3.14,  lng:101.69, tz:"Asia/Kuala_Lumpur",              x:751,y:241},
  {n:"Jakarta",      lat:-6.21, lng:106.85, tz:"Asia/Jakarta",                   x:765,y:267},
  {n:"Manila",       lat:14.60, lng:120.98, tz:"Asia/Manila",                    x:803,y:209},
  {n:"Cairo",        lat:30.04, lng:31.24,  tz:"Africa/Cairo",                   x:563,y:167},
  {n:"Lagos",        lat:6.52,  lng:3.38,   tz:"Africa/Lagos",                   x:489,y:232},
  {n:"Nairobi",      lat:-1.29, lng:36.82,  tz:"Africa/Nairobi",                 x:578,y:254},
  {n:"Cape Town",    lat:-33.93,lng:18.42,  tz:"Africa/Johannesburg",            x:529,y:344},
  {n:"Casablanca",   lat:33.59, lng:-7.62,  tz:"Africa/Casablanca",              x:460,y:157},
  {n:"Johannesburg", lat:-26.20,lng:28.04,  tz:"Africa/Johannesburg",            x:555,y:323},
  {n:"Sydney",       lat:-33.87,lng:151.21, tz:"Australia/Sydney",               x:883,y:344},
  {n:"Auckland",     lat:-36.85,lng:174.76, tz:"Pacific/Auckland",               x:946,y:352},
];

const FEED_MAP = {
  "Stockholm":"https://www.svt.se/rss.xml","Oslo":"https://www.svt.se/rss.xml",
  "Copenhagen":"https://feeds.bbci.co.uk/news/rss.xml","Helsinki":"https://feeds.bbci.co.uk/news/rss.xml",
  "London":"https://feeds.bbci.co.uk/news/rss.xml","Reykjavik":"https://feeds.bbci.co.uk/news/rss.xml",
  "Amsterdam":"https://feeds.bbci.co.uk/news/rss.xml",
  "Berlin":"https://rss.dw.com/rdf/rss-en-all","Vienna":"https://rss.dw.com/rdf/rss-en-all",
  "Paris":"https://www.lemonde.fr/rss/une.xml",
  "Madrid":"https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada",
  "Tokyo":"https://www3.nhk.or.jp/rss/news/cat0.xml","Seoul":"https://www3.nhk.or.jp/rss/news/cat0.xml",
  "Beijing":"https://www3.nhk.or.jp/rss/news/cat0.xml","Shanghai":"https://www3.nhk.or.jp/rss/news/cat0.xml",
  "Mumbai":"https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
  "Singapore":"https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml",
  "Kuala Lumpur":"https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml",
  "Bangkok":"https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml",
  "Jakarta":"https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml",
  "Manila":"https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml",
  "Dubai":"https://www.arabnews.com/rss.xml","Cairo":"https://www.arabnews.com/rss.xml",
  "Sydney":"https://www.abc.net.au/news/feed/51120/rss.xml","Auckland":"https://www.abc.net.au/news/feed/51120/rss.xml",
  "New York":"https://feeds.npr.org/1001/rss.xml","Los Angeles":"https://feeds.npr.org/1001/rss.xml",
  "Chicago":"https://feeds.npr.org/1001/rss.xml","Miami":"https://feeds.npr.org/1001/rss.xml",
  "Toronto":"https://feeds.npr.org/1001/rss.xml","Vancouver":"https://feeds.npr.org/1001/rss.xml",
  "San Francisco":"https://feeds.npr.org/1001/rss.xml","Mexico City":"https://feeds.npr.org/1001/rss.xml",
};
const DEFAULT_FEED = "https://feeds.skynews.com/feeds/rss/world.xml";

const MODULES_DEF = [
  { key:"encounters",   label:"Encounters",      desc:"In-person real-time scenes via Hermes 70B",    on:true  },
  { key:"sms",          label:"SMS & messaging", desc:"Actor-to-actor and player text threads",       on:true  },
  { key:"meetings",     label:"Meetings",        desc:"Actor↔actor conversations via MeetingRunner", on:true  },
  { key:"work_economy", label:"Work economy",    desc:"WorkOfferGenerator, salaries, freelance jobs", on:false },
  { key:"news",         label:"News feed",       desc:"Local RSS news injected into actor context",   on:false },
];

function WorldMap({ selected, onSelect }) {
  const mapRef = useRef(null);
  const leafletRef = useRef(null);
  const markersRef = useRef({});

  useEffect(() => {
    if (leafletRef.current) return;

    function initMap(L) {
      const map = L.map(mapRef.current, {
        center: [20, 10], zoom: 2, minZoom: 2, maxZoom: 6,
        zoomControl: true, attributionControl: false,
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
      }).addTo(map);

      CITIES.forEach(city => {
        const isSelected = selected?.n === city.n;
        const marker = L.circleMarker([city.lat, city.lng], {
          radius: isSelected ? 9 : 6,
          fillColor: isSelected ? "#1a7f4e" : "#1a1814",
          color: "#faf8f4",
          weight: 1.5,
          fillOpacity: isSelected ? 1 : 0.75,
        }).addTo(map);

        marker.bindTooltip(city.n, { permanent: false, direction: "top", offset: [0, -4] });
        marker.on("click", () => onSelect(city));
        markersRef.current[city.n] = marker;
      });

      leafletRef.current = map;
    }

    if (window.L) { initMap(window.L); return; }

    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    script.onload = () => initMap(window.L);
    document.head.appendChild(script);

    return () => { if (leafletRef.current) { leafletRef.current.remove(); leafletRef.current = null; } };
  }, []);

  useEffect(() => {
    if (!leafletRef.current) return;
    Object.entries(markersRef.current).forEach(([name, marker]) => {
      const isSelected = selected?.n === name;
      marker.setStyle({
        fillColor: isSelected ? "#1a7f4e" : "#1a1814",
        fillOpacity: isSelected ? 1 : 0.75,
        radius: isSelected ? 9 : 6,
      });
    });
  }, [selected]);

  return <div ref={mapRef} style={{ width:"100%", height:320, borderRadius:10, border:"1px solid rgba(0,0,0,0.08)", overflow:"hidden" }} />;
}

export default function WorldWizard({ onClose, onCreated }) {
  const [step, setStep]       = useState(0);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState(null);
  const [name, setName]       = useState("");
  const [tagline, setTagline] = useState("");
  const [visibility, setVis]  = useState("private");
  const [invitees, setInvitees] = useState([]);
  const [users, setUsers]     = useState([]);
  const [portraits, setPortraits] = useState({}); // userId → { file, preview } | null
  const [city, setCity]       = useState(null);
  const [modules, setModules] = useState(() => Object.fromEntries(MODULES_DEF.map(m => [m.key, m.on])));

  const canNext = [name.trim().length > 0, city !== null, true];
  const TITLES = ["Identity","Location","Modules"];

  useEffect(() => {
    Promise.all([
      fetch("/api/users").then(r => r.ok ? r.json() : []),
      fetch("/api/me").then(r => r.ok ? r.json() : null),
    ]).then(([all, me]) => {
      setUsers(all.map(u => me && u.id === me.id ? {...u, _isMe: true} : u));
    }).catch(() => {});
  }, []);

  async function submit() {
    setSaving(true); setError(null);
    try {
      const enabledModules = Object.entries(modules).filter(([,v])=>v).map(([k])=>k);
      const allMembers = [{ id: null, ...users.find(u => u.id === null) }, ...invitees]; // creator resolved server-side
      const r = await fetch("/api/worlds", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          name: name.trim(), tagline: tagline.trim() || undefined, visibility,
          city: city.n, lat: city.lat, lng: city.lng, timezone: city.tz,
          news_feed_url: FEED_MAP[city.n] || DEFAULT_FEED,
          modules: enabledModules,
          invitees: invitees.map(u => u.id),
        }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "Failed to create world"); setSaving(false); return; }

      // Upload portraits — custom overrides or signal to use platform default
      const actorIds = d.actor_ids || {};
      const memberIds = Object.keys(actorIds);
      await Promise.all(memberIds.map(async userId => {
        const actorId = actorIds[userId];
        const override = portraits[userId];
        const fd = new FormData();
        fd.append("user_id", userId);
        if (override?.file) {
          fd.append("photo", override.file);
        } else {
          fd.append("use_default", "true");
        }
        await fetch(`/api/worlds/${d.world_id}/actors/${actorId}/portrait`, {
          method: "POST", body: fd,
        }).catch(() => {});
      }));

      onCreated && onCreated(d);
    } catch(e) { setError(e.message); setSaving(false); }
  }

  const F = { fontFamily:"'DM Sans',system-ui,sans-serif" };
  const serif = { fontFamily:"'Cormorant Garamond',Georgia,serif" };

  return (
    <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.55)",
      display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}>
      <div style={{background:"#faf8f4",borderRadius:16,width:"100%",maxWidth:800,
        boxShadow:"0 24px 64px rgba(0,0,0,0.2)",overflow:"hidden",...F}}>

        <div style={{padding:"22px 24px 0"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
            <div>
              <p style={{fontSize:11,color:"#a8a5a0",margin:"0 0 3px",letterSpacing:".06em",textTransform:"uppercase"}}>New world · Step {step+1} of 3</p>
              <h2 style={{...serif,fontSize:26,fontWeight:500,margin:0,color:"#1a1814"}}>{TITLES[step]}</h2>
            </div>
            <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",
              color:"#a8a5a0",fontSize:18,lineHeight:1,padding:4,marginTop:4}}>✕</button>
          </div>
          <div style={{display:"flex",gap:5,marginBottom:20}}>
            {[0,1,2].map(i => (
              <div key={i} style={{height:2,flex:1,borderRadius:2,
                background: i<=step ? "#1a1814" : "rgba(0,0,0,0.1)"}}/>
            ))}
          </div>
        </div>

        <div style={{padding:"0 24px 24px",minHeight:360}}>

          {step===0 && (
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div>
                <label style={{fontSize:11,color:"#a8a5a0",display:"block",marginBottom:5}}>World name *</label>
                <input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Anima — Stockholm"
                  style={{width:"100%",boxSizing:"border-box",border:"1px solid rgba(0,0,0,0.12)",
                    borderRadius:8,padding:"9px 12px",fontSize:13,color:"#1a1814",background:"#fff",outline:"none"}}/>
              </div>
              <div>
                <label style={{fontSize:11,color:"#a8a5a0",display:"block",marginBottom:5}}>Tagline</label>
                <input value={tagline} onChange={e=>setTagline(e.target.value)} placeholder="e.g. A city that never stops"
                  style={{width:"100%",boxSizing:"border-box",border:"1px solid rgba(0,0,0,0.12)",
                    borderRadius:8,padding:"9px 12px",fontSize:13,color:"#1a1814",background:"#fff",outline:"none"}}/>
              </div>
              <div>
                <label style={{fontSize:11,color:"#a8a5a0",display:"block",marginBottom:8}}>Visibility</label>
                <div style={{display:"flex",gap:8}}>
                  {[["private","Private","Only you"],["shared","Shared","Invite members"],["org","Organisation","All members"]].map(([v,l,d]) => (
                    <div key={v} onClick={()=>setVis(v)} style={{flex:1,padding:"9px 12px",cursor:"pointer",
                      border:`1px solid ${visibility===v?"rgba(176,92,8,0.4)":"rgba(0,0,0,0.1)"}`,
                      borderRadius:10,background:visibility===v?"rgba(176,92,8,0.06)":"transparent"}}>
                      <p style={{fontSize:13,fontWeight:500,margin:0,color:visibility===v?"#854f0b":"#1a1814"}}>{l}</p>
                      <p style={{fontSize:11,margin:"2px 0 0",color:visibility===v?"#b05c08":"#a8a5a0"}}>{d}</p>
                    </div>
                  ))}
                </div>
              </div>
              {visibility==="shared" && (
                <div>
                  <label style={{fontSize:11,color:"#a8a5a0",display:"block",marginBottom:8}}>Invite members</label>
                  <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
                    {invitees.map(u => (
                      <div key={u.id} style={{display:"flex",alignItems:"center",gap:6,
                        padding:"4px 10px",background:"rgba(0,0,0,0.06)",borderRadius:20}}>
                        <span style={{fontSize:12,color:"#1a1814"}}>{u.name||u.email}</span>
                        <button onClick={()=>setInvitees(p=>p.filter(x=>x.id!==u.id))}
                          style={{background:"none",border:"none",cursor:"pointer",color:"#a8a5a0",fontSize:12,padding:0}}>✕</button>
                      </div>
                    ))}
                  </div>
                  <div style={{maxHeight:130,overflowY:"auto",border:"1px solid rgba(0,0,0,0.1)",borderRadius:8,background:"#fff"}}>
                    {users.filter(u=>!invitees.find(i=>i.id===u.id)).map(u => (
                      <div key={u.id} onClick={()=>setInvitees(p=>[...p,u])}
                        style={{padding:"9px 12px",cursor:"pointer",fontSize:13,color:"#1a1814",
                          borderBottom:"1px solid rgba(0,0,0,0.05)"}}
                        onMouseEnter={e=>e.currentTarget.style.background="rgba(0,0,0,0.03)"}
                        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                        {u.name||u.email}
                      </div>
                    ))}
                    {users.filter(u=>!invitees.find(i=>i.id===u.id)).length===0 && (
                      <p style={{fontSize:12,color:"#a8a5a0",padding:"10px 12px",margin:0}}>No more members to invite</p>
                    )}
                  </div>
                </div>
              )}

              {/* Portraits */}
              <div>
                <label style={{fontSize:11,color:"#a8a5a0",display:"block",marginBottom:8}}>World portraits</label>
                <div style={{display:"flex",flexWrap:"wrap",gap:12}}>
                  {[...users.filter(u=>u._isMe), ...invitees].map(u => {
                    const override = portraits[u.id];
                    const src = override?.preview || u.photo_url || `/media/users/${u.id}/photo.png`;
                    return (
                      <div key={u.id} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:5}}>
                        <div style={{position:"relative",width:56,height:56}}>
                          <img src={src} onError={e=>{e.target.style.display="none"}}
                            style={{width:56,height:56,borderRadius:"50%",objectFit:"cover",
                              objectPosition:"top center",border:"1.5px solid rgba(0,0,0,0.1)",
                              background:"rgba(0,0,0,0.05)"}}/>
                          <label style={{position:"absolute",bottom:0,right:0,width:18,height:18,
                            borderRadius:"50%",background:"#1a1814",display:"flex",
                            alignItems:"center",justifyContent:"center",cursor:"pointer",
                            border:"2px solid #faf8f4"}}>
                            <span style={{color:"#faf8f4",fontSize:10,lineHeight:1}}>+</span>
                            <input type="file" accept="image/*" style={{display:"none"}}
                              onChange={e => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                const preview = URL.createObjectURL(file);
                                setPortraits(p => ({...p, [u.id]: {file, preview}}));
                              }}/>
                          </label>
                        </div>
                        <span style={{fontSize:10,color:"#a8a5a0",maxWidth:60,textAlign:"center",
                          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                          {u.name?.split(" ")[0] || u.email}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {step===1 && (
            <div>
              <div style={{marginBottom:10}}>
                <WorldMap selected={city} onSelect={setCity}/>
              </div>
              {city ? (
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                  padding:"10px 14px",background:"rgba(26,127,78,0.07)",
                  border:"1px solid rgba(26,127,78,0.2)",borderRadius:10}}>
                  <div>
                    <p style={{fontSize:14,fontWeight:500,margin:0,color:"#1a7f4e"}}>{city.n}</p>
                    <p style={{fontSize:11,margin:"2px 0 0",color:"rgba(26,127,78,0.7)"}}>{city.tz}</p>
                  </div>
                  <div style={{fontSize:11,color:"rgba(26,127,78,0.6)"}}>
                    {city.lat.toFixed(2)}°, {city.lng.toFixed(2)}°
                  </div>
                </div>
              ) : (
                <p style={{fontSize:12,color:"#a8a5a0",margin:0}}>Click a city to select it</p>
              )}
            </div>
          )}

          {step===2 && (
            <div style={{display:"flex",flexDirection:"column",gap:16}}>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {MODULES_DEF.map(m => (
                  <div key={m.key} onClick={()=>setModules(p=>({...p,[m.key]:!p[m.key]}))}
                    style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                      padding:"10px 14px",border:"1px solid rgba(0,0,0,0.08)",borderRadius:10,cursor:"pointer",
                      background:modules[m.key]?"rgba(26,20,14,0.03)":"transparent"}}>
                    <div>
                      <p style={{fontSize:13,fontWeight:500,margin:0,color:"#1a1814"}}>{m.label}</p>
                      <p style={{fontSize:11,margin:"2px 0 0",color:"#a8a5a0"}}>{m.desc}</p>
                    </div>
                    <div style={{width:36,height:20,borderRadius:10,flexShrink:0,position:"relative",
                      background:modules[m.key]?"#1a1814":"rgba(0,0,0,0.15)"}}>
                      <div style={{position:"absolute",top:3,width:14,height:14,borderRadius:"50%",
                        background:"#faf8f4",left:modules[m.key]?19:3,transition:"left 0.12s"}}/>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{padding:"12px 14px",background:"rgba(0,0,0,0.03)",
                border:"1px solid rgba(0,0,0,0.07)",borderRadius:10}}>
                <p style={{fontSize:10,color:"#a8a5a0",margin:"0 0 8px",letterSpacing:".06em",textTransform:"uppercase"}}>Review</p>
                {[["Name",name],["City",city?.n||"—"],["Timezone",city?.tz||"—"],["Visibility",visibility],
                  ["Modules",Object.entries(modules).filter(([,v])=>v).map(([k])=>MODULES_DEF.find(m=>m.key===k)?.label).join(", ")||"none"],
                ].map(([k,v])=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",gap:12,marginBottom:3}}>
                    <span style={{fontSize:12,color:"#a8a5a0"}}>{k}</span>
                    <span style={{fontSize:12,color:"#1a1814",textAlign:"right"}}>{v}</span>
                  </div>
                ))}
              </div>
              {error && <p style={{fontSize:12,color:"#c0392b",margin:0}}>{error}</p>}
            </div>
          )}
        </div>

        <div style={{padding:"14px 24px",borderTop:"1px solid rgba(0,0,0,0.07)",
          display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <button onClick={step===0?onClose:()=>setStep(s=>s-1)}
            style={{background:"transparent",color:"#6b6760",border:"1px solid rgba(0,0,0,0.12)",
              borderRadius:8,padding:"9px 18px",fontSize:12,letterSpacing:".05em",
              textTransform:"uppercase",cursor:"pointer"}}>
            {step===0?"Cancel":"← Back"}
          </button>
          <button onClick={step<2?()=>setStep(s=>s+1):submit}
            disabled={!canNext[step]||saving}
            style={{background:canNext[step]&&!saving?"#1a1814":"rgba(0,0,0,0.15)",
              color:canNext[step]&&!saving?"#faf8f4":"#a8a5a0",border:"none",
              borderRadius:8,padding:"9px 22px",fontSize:12,letterSpacing:".05em",
              textTransform:"uppercase",cursor:canNext[step]&&!saving?"pointer":"not-allowed"}}>
            {saving?"Creating...":step<2?"Next →":"Create world"}
          </button>
        </div>
      </div>
    </div>
  );
}
