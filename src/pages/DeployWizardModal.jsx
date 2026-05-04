import { useState, useEffect, useRef } from "react";

const S = {
  overlay: { position:"fixed",inset:0,zIndex:1000,background:"rgba(238,236,234,0.72)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",display:"flex",alignItems:"center",justifyContent:"center",padding:"1.5rem" },
  modal:   { background:"rgba(255,255,255,0.92)",backdropFilter:"blur(40px) saturate(200%)",WebkitBackdropFilter:"blur(40px) saturate(200%)",border:"1px solid rgba(255,255,255,0.95)",boxShadow:"0 8px 64px rgba(0,0,0,0.12),0 1px 0 rgba(255,255,255,1) inset",borderRadius:24,width:"100%",maxWidth:900,maxHeight:"92vh",display:"flex",flexDirection:"column",overflow:"hidden" },
  serif:   { fontFamily:"'Cormorant Garamond',Georgia,serif" },
  sans:    { fontFamily:"'DM Sans',system-ui,sans-serif" },
  mono:    { fontFamily:"'DM Mono',monospace" },
  label:   { fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0" },
};

const STEPS = ["World", "Relationships", "Schedule", "Media", "Deploy"];

// ── Step bar ──────────────────────────────────────────────────────────────────
function StepBar({ current }) {
  return (
    <div style={{ display:"flex", alignItems:"center", padding:"1rem 1.5rem 0" }}>
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done   = n < current;
        const active = n === current;
        return (
          <div key={label} style={{ display:"flex", alignItems:"center", flex: i < STEPS.length-1 ? 1 : "none" }}>
            <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
              <div style={{ width:24, height:24, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:500, flexShrink:0, background: done?"rgba(29,158,117,.12)":active?"#1a1814":"rgba(0,0,0,.06)", color: done?"#0f6e56":active?"#faf8f4":"#a8a5a0" }}>
                {done ? "✓" : n}
              </div>
              <span style={{ ...S.sans, fontSize:11, color: active?"#1a1814":"#a8a5a0", fontWeight: active?500:400 }}>{label}</span>
            </div>
            {i < STEPS.length-1 && <div style={{ flex:1, height:.5, background:"rgba(0,0,0,.1)", margin:"0 8px" }} />}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: World + Home ─────────────────────────────────────────────────────
const MAPS_KEY = "AIzaSyDy45Dov_WkN9FcxdVNYQEx23PjexI-Fxc";

function StepWorld({ actor, state, setState }) {
  const [worlds,        setWorlds]        = useState([]);
  const [suggestions,   setSuggestions]   = useState([]);
  const [workSuggestions, setWorkSuggestions] = useState([]);
  const [careerSuggesting, setCareerSuggesting] = useState(false);
  const [workSuggesting,  setWorkSuggesting]  = useState(false);
  const [workQuery,       setWorkQuery]       = useState("");
  const [workResults,     setWorkResults]     = useState([]);
  const [workSearching,   setWorkSearching]   = useState(false);
  const workTimer = useRef(null);
  const [suggesting,    setSuggesting]    = useState(false);
  const [searchQuery,   setSearchQuery]   = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching,     setSearching]     = useState(false);
  const searchTimer = useRef(null);
  const mapRef      = useRef(null);
  const mapInst     = useRef(null);
  const markerRef   = useRef(null);
  const workMapRef  = useRef(null);
  const workMapInst = useRef(null);
  const workMarker  = useRef(null);
  const [mapReady,  setMapReady]  = useState(false);

  useEffect(() => {
    fetch("/api/worlds", { credentials: "include" }).then(r=>r.ok?r.json():[]).then(setWorlds).catch(()=>{});
  }, []);

  // Load Google Maps
  useEffect(() => {
    if (window.google?.maps) { setMapReady(true); return; }
    if (document.getElementById("gmaps-script")) {
      const t = setInterval(() => { if (window.google?.maps) { setMapReady(true); clearInterval(t); } }, 200);
      return;
    }
    const s = document.createElement("script");
    s.id  = "gmaps-script";
    s.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}`;
    s.onload = () => setMapReady(true);
    document.head.appendChild(s);
  }, []);

  // Init map
  useEffect(() => {
    if (!mapReady || !state.world) return;
    const timer = setTimeout(() => {
      if (!mapRef.current || mapInst.current) return;
      mapInst.current = new window.google.maps.Map(mapRef.current, {
      center: { lat: state.world?.lat || 59.3293, lng: state.world?.lng || 18.0686 },
      zoom: 12,
      disableDefaultUI: true,
      zoomControl: true,
      styles: [{ featureType:"poi", stylers:[{ visibility:"off" }] }],
    });
    setTimeout(() => window.google.maps.event.trigger(mapInst.current, "resize"), 100);
    mapInst.current.addListener("click", async (e) => {
      const lat = e.latLng.lat();
      const lng = e.latLng.lng();
      placeMarker(lat, lng);
      try {
        const r = await fetch(`/api/places/reverse?lat=${lat}&lng=${lng}`);
        if (r.ok) {
          const d = await r.json();
          setState(prev => ({...prev, home: { ...d, home_type: prev.home?.home_type }}));
          setSearchQuery(d.address);
        }
      } catch {}
    });
    }, 100);
    return () => clearTimeout(timer);
  }, [mapReady, state.world]);

  // Reset maps when world changes so they reinitialize centered on new city
  useEffect(() => {
    if (!state.world?.id) return;
    if (mapInst.current) { mapInst.current = null; }
    if (workMapInst.current) { workMapInst.current = null; }
  }, [state.world?.id]);

  // Update marker when home changes
  useEffect(() => {
    if (!mapInst.current || !state.home?.lat || !state.home?.lng) return;
    placeMarker(state.home.lat, state.home.lng);
    mapInst.current.panTo({ lat: state.home.lat, lng: state.home.lng });
    mapInst.current.setZoom(15);
  }, [state.home?.lat, state.home?.lng]);

  function placeMarker(lat, lng) {
    if (markerRef.current) markerRef.current.setMap(null);
    markerRef.current = new window.google.maps.Marker({
      position: { lat, lng },
      map: mapInst.current,
      icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 10, fillColor:"#1a1814", fillOpacity:1, strokeColor:"#fff", strokeWeight:2 },
    });
  }

  async function suggestNeighbourhood() {
    setSuggesting(true); setSuggestions([]);
    try {
      const r = await fetch(`/api/actors/${actor.id}/suggest-home`, { method:"POST", headers:{"Content-Type":"application/json"} });
      if (r.ok) setSuggestions(await r.json());
    } catch {}
    setSuggesting(false);
  }

  async function suggestCareer() {
    setCareerSuggesting(true);
    try {
      const r = await fetch(`/api/actors/${actor.id}/suggest-career`, { method:"POST", headers:{"Content-Type":"application/json"} });
      if (r.ok) {
        const d = await r.json();
        setState(prev => ({...prev, career: { career_level: d.career_level, career_ladder: d.career_ladder, employment_type: d.employment_type, reputation_score: d.reputation_score ?? 0.5 }}));
      }
    } catch {}
    setCareerSuggesting(false);
  }

  async function suggestWorkplace() {
    setWorkSuggesting(true); setWorkSuggestions([]);
    try {
      const r = await fetch(`/api/actors/${actor.id}/suggest-workplace`, { method:"POST", headers:{"Content-Type":"application/json"} });
      if (r.ok) setWorkSuggestions(await r.json());
    } catch {}
    setWorkSuggesting(false);
  }

  function searchWork(q) {
    setWorkQuery(q);
    if (!q || q.length < 3) { setWorkResults([]); return; }
    if (workTimer.current) clearTimeout(workTimer.current);
    workTimer.current = setTimeout(async () => {
      setWorkSearching(true);
      try {
        const country = state.world?.country || '';
        const r = await fetch(`/api/places/autocomplete?q=${encodeURIComponent(q)}${country ? '&country='+country : ''}`, { credentials: 'include' });
        if (r.ok) { const d = await r.json(); setWorkResults(Array.isArray(d) ? d : []); }
      } catch {}
      setWorkSearching(false);
    }, 400);
  }

  async function pickWorkPlace(p) {
    setWorkResults([]);
    setWorkQuery(p.description);
    setState(prev => ({...prev, workplace: { place_id: p.place_id, address: p.description, name: p.description }}));
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);
      const r = await fetch(`/api/places/details?place_id=${p.place_id}`, { signal: controller.signal });
      if (r.ok) {
        const d = await r.json();
        setState(prev => ({...prev, workplace: { ...prev.workplace, ...d }}));
        setWorkQuery(d.name + " — " + d.address);
      }
    } catch {}
  }

  // Init work map
  useEffect(() => {
    if (!mapReady || !state.world) return;
    const timer = setTimeout(() => {
      if (!workMapRef.current || workMapInst.current) return;
      workMapInst.current = new window.google.maps.Map(workMapRef.current, {
        center: { lat: state.world?.lat || 59.3293, lng: state.world?.lng || 18.0686 },
        zoom: 12,
        disableDefaultUI: true,
        zoomControl: true,
        styles: [{ featureType:"poi", stylers:[{ visibility:"off" }] }],
      });
      setTimeout(() => window.google.maps.event.trigger(workMapInst.current, "resize"), 100);
      workMapInst.current.addListener("click", async (e) => {
        const lat = e.latLng.lat();
        const lng = e.latLng.lng();
        try {
          const r = await fetch(`/api/places/reverse?lat=${lat}&lng=${lng}`);
          if (r.ok) {
            const d = await r.json();
            setState(prev => ({...prev, workplace: { ...d }}));
            setWorkQuery(d.address);
          }
        } catch {}
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [mapReady, state.world]);

  // Update work marker
  useEffect(() => {
    if (!workMapInst.current || !state.workplace?.lat || !state.workplace?.lng) return;
    if (workMarker.current) workMarker.current.setMap(null);
    workMarker.current = new window.google.maps.Marker({
      position: { lat: state.workplace.lat, lng: state.workplace.lng },
      map: workMapInst.current,
      icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 10, fillColor:"#1a1814", fillOpacity:1, strokeColor:"#fff", strokeWeight:2 },
    });
    workMapInst.current.panTo({ lat: state.workplace.lat, lng: state.workplace.lng });
    workMapInst.current.setZoom(15);
  }, [state.workplace?.lat, state.workplace?.lng]);

  function searchPlaces(q) {
    setSearchQuery(q);
    if (!q || q.length < 3) { setSearchResults([]); return; }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const country = state.world?.country || '';
        const url = `/api/places/autocomplete?q=${encodeURIComponent(q)}${country ? '&country='+country : ''}`;
        console.log('[searchPlaces] fetching', url);
        const r = await fetch(url, { credentials: 'include' });
        console.log('[searchPlaces] status', r.status);
        if (r.ok) { const d = await r.json(); console.log('[searchPlaces] results', d.length); setSearchResults(Array.isArray(d) ? d : []); }
      } catch(e) { console.error('[searchPlaces] error', e); }
      setSearching(false);
    }, 400);
  }

  function pickSuggestion(s) {
    const city = state.world?.city || "Stockholm";
    const q = s.neighbourhood + " " + city;
    setSearchQuery(q); searchPlaces(q);
  }

  async function pickPlace(p) {
    setSearchResults([]);
    setSearchQuery(p.description);
    setState(prev => ({...prev, home: { place_id: p.place_id, address: p.description, name: p.description, home_type: prev.home?.home_type }}));
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);
      const r = await fetch(`/api/places/details?place_id=${p.place_id}`, { signal: controller.signal });
      if (r.ok) {
        const d = await r.json();
        setState(prev => ({...prev, home: { ...prev.home, ...d }}));
        setSearchQuery(d.address);
      }
    } catch {}
  }

  return (
    <div>
      {/* World selector */}
      <div style={{ ...S.label, marginBottom:8 }}>World</div>
      {worlds.length === 0 && <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0" }}>Loading…</p>}
      {worlds.map(w => {
        const running = w.status === "running";
        return (
          <div key={w.id} onClick={() => running && setState(p => ({...p, world:w}))}
            style={{ padding:"10px 14px", borderRadius:12, border:`1.5px solid ${state.world?.id===w.id?"#1a1814":"rgba(0,0,0,.08)"}`, background:state.world?.id===w.id?"rgba(26,24,20,.04)":running?"rgba(255,255,255,.5)":"rgba(0,0,0,.02)", cursor:running?"pointer":"not-allowed", marginBottom:8, display:"flex", justifyContent:"space-between", alignItems:"center", opacity:running?1:0.5 }}>
            <div>
              <div style={{ ...S.sans, fontSize:13, fontWeight:500, color:running?"#1a1814":"#a8a5a0" }}>{w.name}</div>
              <div style={{ ...S.sans, fontSize:11, color:running?"#5CA87A":"#c0392b", marginTop:1 }}>{running ? "● running" : "● stopped"}</div>
            </div>
            {state.world?.id===w.id && <span style={{ color:"#1a1814" }}>✓</span>}
          </div>
        );
      })}

      {/* Home section */}
      {state.world && (
        <>
        <div style={{ marginTop:20 }}>
          <div style={{ ...S.label, marginBottom:10 }}>Home</div>
          <div style={{ display:"flex", gap:16 }}>

            {/* Left: search + suggestions + picker */}
            <div style={{ flex:"0 0 320px", display:"flex", flexDirection:"column", gap:8 }}>
              <div style={{ display:"flex", justifyContent:"flex-end" }}>
                <button onClick={suggestNeighbourhood} disabled={suggesting} style={{ ...S.sans, fontSize:11, padding:"3px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:suggesting?"default":"pointer", opacity:suggesting?0.5:1 }}>
                  {suggesting ? "Thinking…" : "✨ Suggest"}
                </button>
              </div>

              {suggestions.length > 0 && suggestions.map((s,i) => (
                <div key={i} onClick={() => pickSuggestion(s)} style={{ padding:"8px 10px", borderRadius:9, border:"1px solid rgba(0,0,0,.07)", background:"rgba(255,255,255,.6)", cursor:"pointer" }}
                  onMouseEnter={e=>e.currentTarget.style.background="#f5f2ef"}
                  onMouseLeave={e=>e.currentTarget.style.background="rgba(255,255,255,.6)"}>
                  <div style={{ ...S.sans, fontSize:12, fontWeight:500, color:"#1a1814" }}>{s.neighbourhood}</div>
                  <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0", marginTop:2, lineHeight:1.4 }}>{s.reason}</div>
                </div>
              ))}

              <div style={{ position:"relative" }}>
                <input value={searchQuery} onChange={e=>searchPlaces(e.target.value)}
                  placeholder="Search address…"
                  style={{ width:"100%", fontSize:13, padding:"8px 10px", borderRadius:9, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", boxSizing:"border-box" }} />
                {searching && <span style={{ ...S.sans, position:"absolute", right:8, top:9, fontSize:11, color:"#a8a5a0" }}>…</span>}
                {searchResults.length > 0 && (
                  <div style={{ position:"absolute", top:"calc(100% + 4px)", left:0, right:0, background:"#fff", border:"1px solid rgba(0,0,0,.1)", borderRadius:9, zIndex:20, overflow:"hidden", boxShadow:"0 4px 20px rgba(0,0,0,.1)" }}>
                    {searchResults.map(p => (
                      <div key={p.place_id} onClick={() => pickPlace(p)} style={{ padding:"8px 10px", cursor:"pointer", fontSize:12 }}
                        onMouseEnter={e=>e.currentTarget.style.background="#f5f2ef"}
                        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                        <div style={{ ...S.sans, color:"#1a1814" }}>{p.description}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {state.home?.place_id && (
                <>
                  <div style={{ padding:"8px 10px", borderRadius:9, border:"1.5px solid #1a1814", background:"rgba(26,24,20,.03)" }}>
                    <div style={{ ...S.sans, fontSize:12, fontWeight:500, color:"#1a1814" }}>{state.home.address}</div>
                    {state.home.lat && <div style={{ ...S.sans, fontSize:10, color:"#a8a5a0", marginTop:2 }}>{state.home.lat?.toFixed(5)}, {state.home.lng?.toFixed(5)}</div>}
                  </div>
                  <div style={{ display:"flex", gap:6 }}>
                    {["apartment","house"].map(t => (
                      <div key={t} onClick={() => setState(p => ({...p, home:{...p.home, home_type:t}}))}
                        style={{ flex:1, padding:"8px", borderRadius:9, border:`1.5px solid ${state.home.home_type===t?"#1a1814":"rgba(0,0,0,.08)"}`, background:state.home.home_type===t?"rgba(26,24,20,.04)":"rgba(255,255,255,.5)", cursor:"pointer", textAlign:"center" }}>
                        <span style={{ ...S.sans, fontSize:12, fontWeight:state.home.home_type===t?500:400, color:state.home.home_type===t?"#1a1814":"#6b6760" }}>
                          {t === "apartment" ? "🏢 Apartment" : "🏠 House"}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Right: map */}
            <div style={{ flex:1, borderRadius:12, overflow:"hidden", border:"1px solid rgba(0,0,0,.08)", height:320, background:"#f0ede8", position:"relative" }}>
              <div ref={mapRef} style={{ width:"100%", height:320 }} />
              {!mapReady && <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", ...S.sans, fontSize:12, color:"#a8a5a0" }}>Loading map…</div>}
              <div style={{ position:"absolute", bottom:8, left:8, ...S.sans, fontSize:10, color:"rgba(0,0,0,.4)", background:"rgba(255,255,255,.7)", padding:"3px 6px", borderRadius:4 }}>Click to pin exact location</div>
            </div>

          </div>
        </div>

        {/* Career section */}
        <div style={{ marginTop:20 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
            <div style={{ ...S.label }}>Career</div>
            <button onClick={suggestCareer} disabled={careerSuggesting} style={{ ...S.sans, fontSize:11, padding:"3px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:careerSuggesting?"default":"pointer", opacity:careerSuggesting?0.5:1 }}>
              {careerSuggesting ? "Thinking…" : "✨ Suggest"}
            </button>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            {[["career_level","Career level",["junior","established","senior","independent"]],
              ["employment_type","Employment",["employed","freelance"]]].map(([key,label,opts]) => (
              <div key={key}>
                <div style={{ ...S.label, marginBottom:4 }}>{label}</div>
                <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                  {opts.map(o => (
                    <span key={o} onClick={() => setState(p => ({...p, career:{...(p.career||{}), [key]:o}}))}
                      style={{ padding:"4px 10px", borderRadius:20, fontSize:12, cursor:"pointer", border:`1px solid ${state.career?.[key]===o?"#1a1814":"rgba(0,0,0,.1)"}`, background:state.career?.[key]===o?"#1a1814":"rgba(255,255,255,.5)", color:state.career?.[key]===o?"#faf8f4":"#6b6760" }}>
                      {o}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            <div>
              <div style={{ ...S.label, marginBottom:4 }}>Career ladder</div>
              <input value={state.career?.career_ladder||""} onChange={e=>setState(p=>({...p,career:{...(p.career||{}),career_ladder:e.target.value}}))}
                placeholder="e.g. medical_specialist" style={{ width:"100%", fontSize:12, padding:"6px 8px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", boxSizing:"border-box" }} />
            </div>
            <div>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                <div style={{ ...S.label }}>Reputation</div>
                <span style={{ ...S.mono, fontSize:11, color:"#6b6760" }}>{((state.career?.reputation_score||0.5)*100).toFixed(0)}%</span>
              </div>
              <input type="range" min={0} max={1} step={0.01} value={state.career?.reputation_score||0.5}
                onChange={e=>setState(p=>({...p,career:{...(p.career||{}),reputation_score:parseFloat(e.target.value)}}))}
                style={{ width:"100%", accentColor:"#1a1814" }} />
            </div>
          </div>
        </div>

        {/* Workplace section */}
        <div style={{ marginTop:20 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
            <div style={{ ...S.label }}>Workplace</div>
            <button onClick={suggestWorkplace} disabled={workSuggesting} style={{ ...S.sans, fontSize:11, padding:"3px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:workSuggesting?"default":"pointer", opacity:workSuggesting?0.5:1 }}>
              {workSuggesting ? "Thinking…" : "✨ Suggest"}
            </button>
          </div>
          <div style={{ display:"flex", gap:16 }}>
            <div style={{ flex:"0 0 320px", display:"flex", flexDirection:"column", gap:8 }}>
              {workSuggestions.length > 0 && workSuggestions.map((s,i) => (
                <div key={i} onClick={() => { setWorkQuery(s.name + " Stockholm"); searchWork(s.name + " Stockholm"); }}
                  style={{ padding:"8px 10px", borderRadius:9, border:"1px solid rgba(0,0,0,.07)", background:"rgba(255,255,255,.6)", cursor:"pointer" }}
                  onMouseEnter={e=>e.currentTarget.style.background="#f5f2ef"}
                  onMouseLeave={e=>e.currentTarget.style.background="rgba(255,255,255,.6)"}>
                  <div style={{ ...S.sans, fontSize:12, fontWeight:500, color:"#1a1814" }}>{s.name}</div>
                  <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0", marginTop:2 }}>{s.reason}</div>
                </div>
              ))}
              <div style={{ position:"relative" }}>
                <input value={workQuery} onChange={e=>searchWork(e.target.value)} placeholder="Search hospital, clinic, office…"
                  style={{ width:"100%", fontSize:13, padding:"8px 10px", borderRadius:9, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", boxSizing:"border-box" }} />
                {workSearching && <span style={{ ...S.sans, position:"absolute", right:8, top:9, fontSize:11, color:"#a8a5a0" }}>…</span>}
                {workResults.length > 0 && (
                  <div style={{ position:"absolute", top:"calc(100% + 4px)", left:0, right:0, background:"#fff", border:"1px solid rgba(0,0,0,.1)", borderRadius:9, zIndex:20, overflow:"hidden", boxShadow:"0 4px 20px rgba(0,0,0,.1)" }}>
                    {workResults.map(p => (
                      <div key={p.place_id} onClick={() => pickWorkPlace(p)} style={{ padding:"8px 10px", cursor:"pointer", fontSize:12 }}
                        onMouseEnter={e=>e.currentTarget.style.background="#f5f2ef"}
                        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                        <div style={{ ...S.sans, color:"#1a1814" }}>{p.description}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {state.workplace?.place_id && (
                <div style={{ padding:"8px 10px", borderRadius:9, border:"1.5px solid #1a1814", background:"rgba(26,24,20,.03)" }}>
                  <div style={{ ...S.sans, fontSize:12, fontWeight:500, color:"#1a1814" }}>{state.workplace.name}</div>
                  <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>{state.workplace.address}</div>
                </div>
              )}
            </div>
            <div style={{ flex:1, borderRadius:12, overflow:"hidden", border:"1px solid rgba(0,0,0,.08)", height:240, background:"#f0ede8", position:"relative" }}>
              <div ref={workMapRef} style={{ width:"100%", height:240 }} />
              {!mapReady && <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", ...S.sans, fontSize:12, color:"#a8a5a0" }}>Loading map…</div>}
              <div style={{ position:"absolute", bottom:8, left:8, ...S.sans, fontSize:10, color:"rgba(0,0,0,.4)", background:"rgba(255,255,255,.7)", padding:"3px 6px", borderRadius:4 }}>Click map to pin location</div>
            </div>
          </div>
        </div>
        </>
      )}
    </div>
  );
}


// ── Step 2: Relationships ─────────────────────────────────────────────────────
function StepRelationships({ actor, state, setState }) {
  const [characters,  setCharacters]  = useState([]);
  const [users,       setUsers]       = useState([]);
  const [relTypes,    setRelTypes]    = useState([]);
  const [picked,      setPicked]      = useState(null);
  const [dropOpen,    setDropOpen]    = useState(false);
  const [selType,     setSelType]     = useState(null);
  const [description, setDescription] = useState("");
  const [context,     setContext]     = useState("");
  const [scores,      setScores]      = useState({ warmth:0.5, trust:0.5, respect:0.5, tension:0.1, attraction:0.0, pull:0.4 });
  const [inspiring,   setInspiring]   = useState(false);
  const [editingIdx,  setEditingIdx]  = useState(null);
  const [customInputs, setCustomInputs] = useState({ "dim-family":"", "dim-professional":"", "dim-social":"", "dim-intimate":"", "dim-legal":"" });
  const [customTypes,  setCustomTypes]  = useState({ "dim-family":[], "dim-professional":[], "dim-social":[], "dim-intimate":[], "dim-legal":[] });

  const dimConfig = {
    "dim-family":       { label:"Family",       bg:"#FEF9EC", color:"#92400E", selBg:"#92400E", selColor:"#FEF9EC", border:"#F59E0B" },
    "dim-professional": { label:"Professional", bg:"#EFF6FF", color:"#1E40AF", selBg:"#1E40AF", selColor:"#EFF6FF", border:"#93C5FD" },
    "dim-social":       { label:"Social",       bg:"#E1F5EE", color:"#0F6E56", selBg:"#0F6E56", selColor:"#E1F5EE", border:"#5DCAA5" },
    "dim-intimate":     { label:"Intimate",     bg:"#FBEAF0", color:"#993556", selBg:"#993556", selColor:"#FBEAF0", border:"#ED93B1" },
    "dim-legal":        { label:"Legal",        bg:"#F5F3FF", color:"#5B21B6", selBg:"#5B21B6", selColor:"#F5F3FF", border:"#A78BFA" },
  };
  const defaultScores = {
    "dim-family":       { warmth:0.70, trust:0.70, respect:0.70, tension:0.05, attraction:0.00, pull:0.60 },
    "dim-professional": { warmth:0.45, trust:0.50, respect:0.65, tension:0.05, attraction:0.00, pull:0.35 },
    "dim-social":       { warmth:0.60, trust:0.55, respect:0.60, tension:0.00, attraction:0.00, pull:0.45 },
    "dim-intimate":     { warmth:0.70, trust:0.60, respect:0.60, tension:0.10, attraction:0.60, pull:0.65 },
    "dim-legal":        { warmth:0.50, trust:0.55, respect:0.55, tension:0.10, attraction:0.00, pull:0.30 },
  };
  const dimOrder = ["dim-family","dim-professional","dim-social","dim-intimate","dim-legal"];
  const SCORE_FIELDS = [["warmth","Warmth"],["trust","Trust"],["respect","Respect"],["tension","Tension"],["attraction","Attraction"],["pull","Pull"]];

  useEffect(() => {
    if (!state.world) return;
    fetch(`/api/worlds/${state.world.id}/actors`).then(r=>r.ok?r.json():[]).then(d=>setCharacters(d.filter(c=>c.id!==actor?.id))).catch(()=>{});
    fetch(`/api/worlds/${state.world.id}/members`).then(r=>r.ok?r.json():[]).then(d=>setUsers(Array.isArray(d)?d:[])).catch(()=>{});
    fetch(`/api/relationship-types`).then(r=>r.ok?r.json():null).then(data=>{
      if (!Array.isArray(data)) return;
      setRelTypes(data.filter(t => t.id.startsWith("rt-") || t.id.startsWith("custom-")));
    }).catch(()=>{});
  }, [state.world]);

  const grouped = relTypes.reduce((acc,t)=>{ (acc[t.dimension_id]||(acc[t.dimension_id]=[])).push(t); return acc; }, {});
  const initials = name => (name||"").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();

  function selectType(t) {
    if (selType?.id === t.id) { setSelType(null); return; }
    const dimName = dimConfig[t.dimension_id]?.label?.toLowerCase() || t.dimension_id.replace("dim-","");
    setSelType({...t, dimension_name: dimName});
    setScores(defaultScores[t.dimension_id] || defaultScores["dim-social"]);
  }

  function addCustomType(dim) {
    const val = customInputs[dim].trim();
    if (!val) return;
    const t = { id:`custom-${dim}-${val.replace(/\s+/g,"-").toLowerCase()}`, name:val.replace(/\s+/g,"_"), dimension_id:dim, dimension_name:dimConfig[dim]?.label?.toLowerCase()||dim.replace("dim-",""), _custom:true };
    setCustomTypes(p => ({...p, [dim]:[...p[dim], t]}));
    setCustomInputs(p => ({...p, [dim]:""}));
    selectType(t);
  }

  async function inspire() {
    if (!picked || !selType) return;
    setInspiring(true);
    try {
      const r = await fetch(`/api/actors/${actor.id}/inspire-relationship`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          rel_type_id:   selType.id,
          rel_type_name: selType.name,
          dimension_name: selType.dimension_name,
          target_type:   picked._isUser ? "user" : "actor",
          target_id:     picked.id,
        })
      });
      if (r.ok) {
        const data = await r.json();
        if (data.description) setDescription(data.description);
        if (data.context)     setContext(data.context);
        if (data.scores)      setScores(p => ({...p, ...data.scores}));
      }
    } catch {}
    setInspiring(false);
  }

  function clearForm() { setPicked(null); setSelType(null); setDescription(""); setContext(""); setScores({ warmth:0.5, trust:0.5, respect:0.5, tension:0.1, attraction:0.0, pull:0.4 }); setEditingIdx(null); }

  function addOrUpdate() {
    if (!picked || !selType) return;
    const rel = { character:picked, rel_type_id:selType.id, rel_type_name:selType.name, dimension_id:selType.dimension_id, dimension_name:selType.dimension_name, description, context, scores:{...scores} };
    if (editingIdx !== null) {
      setState(p => { const r=[...(p.relationships||[])]; r[editingIdx]=rel; return {...p,relationships:r}; });
    } else {
      setState(p => ({...p, relationships:[...(p.relationships||[]), rel]}));
    }
    clearForm();
  }

  function removeRel(i) {
    setState(p => ({...p, relationships:(p.relationships||[]).filter((_,j)=>j!==i)}));
    if (editingIdx===i) clearForm();
  }

  function editRel(i) {
    const r = (state.relationships||[])[i];
    setPicked(r.character);
    setSelType({ id:r.rel_type_id, name:r.rel_type_name, dimension_id:r.dimension_id, dimension_name:r.dimension_name });
    setDescription(r.description||"");
    setContext(r.context||"");
    setScores(r.scores || defaultScores[r.dimension_id] || defaultScores["dim-social"]);
    setEditingIdx(i);
  }

  const canAdd  = picked && selType;
  const dimCfg  = selType ? (dimConfig[selType.dimension_id] || dimConfig["dim-social"]) : null;

  return (
    <div>
      <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0", marginBottom:16 }}>Define who {actor?.first_name||actor?.name} already knows</p>

      {/* ── Dropdown ─────────────────────────────────────────────────── */}
      <div style={{ ...S.label, marginBottom:6 }}>Character or user</div>
      <div style={{ position:"relative", marginBottom:16 }}>
        <div onClick={() => setDropOpen(p=>!p)} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 12px", border:"1px solid rgba(0,0,0,.1)", borderRadius:10, background:"rgba(255,255,255,.7)", cursor:"pointer" }}>
          {picked ? (
            <>
              {picked.photo_url
                ? <img src={picked.photo_url} style={{ width:30, height:30, borderRadius:"50%", objectFit:"cover", flexShrink:0 }} />
                : <div style={{ width:30, height:30, borderRadius:"50%", background:picked._isUser?"rgba(55,138,221,.12)":"rgba(0,0,0,.06)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:500, color:picked._isUser?"#185FA5":"#6b6760", flexShrink:0 }}>{initials(picked.name)}</div>}
              <div>
                <div style={{ ...S.sans, fontSize:13, fontWeight:500, color:"#1a1814" }}>{picked.first_name||picked.name}</div>
                <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>{picked._isUser ? "Player" : picked.occupation}</div>
              </div>
            </>
          ) : <span style={{ ...S.sans, fontSize:13, color:"#a8a5a0" }}>Select character or user…</span>}
          <span style={{ marginLeft:"auto", fontSize:10, color:"#a8a5a0" }}>▼</span>
        </div>
        {dropOpen && (
          <div style={{ position:"absolute", top:"calc(100% + 4px)", left:0, right:0, background:"#fff", border:"1px solid rgba(0,0,0,.1)", borderRadius:10, zIndex:20, overflow:"hidden", boxShadow:"0 4px 20px rgba(0,0,0,.1)", maxHeight:240, overflowY:"auto" }}>
            {characters.length > 0 && <div style={{ ...S.label, padding:"8px 12px 4px", background:"rgba(0,0,0,.02)" }}>Characters</div>}
            {characters.map(c => (
              <div key={c.id} onClick={() => { setPicked(c); setDropOpen(false); }} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", cursor:"pointer" }} onMouseEnter={e=>e.currentTarget.style.background="#f5f2ef"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                {c.photo_url ? <img src={c.photo_url} style={{ width:30, height:30, borderRadius:"50%", objectFit:"cover", flexShrink:0 }} /> : <div style={{ width:30, height:30, borderRadius:"50%", background:"rgba(0,0,0,.06)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:500, color:"#6b6760", flexShrink:0 }}>{initials(c.name)}</div>}
                <div><div style={{ ...S.sans, fontSize:13, fontWeight:500, color:"#1a1814" }}>{c.first_name||c.name}</div><div style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>{c.occupation}</div></div>
              </div>
            ))}
            {users.length > 0 && <div style={{ ...S.label, padding:"8px 12px 4px", background:"rgba(0,0,0,.02)", borderTop:"1px solid rgba(0,0,0,.06)" }}>Users</div>}
            {users.map(u => (
              <div key={u.id} onClick={() => { setPicked({...u, _isUser:true}); setDropOpen(false); }} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", cursor:"pointer" }} onMouseEnter={e=>e.currentTarget.style.background="#f5f2ef"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                {u.photo_url ? <img src={u.photo_url} style={{ width:30, height:30, borderRadius:"50%", objectFit:"cover", flexShrink:0 }} /> : <div style={{ width:30, height:30, borderRadius:"50%", background:"rgba(55,138,221,.12)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:500, color:"#185FA5", flexShrink:0 }}>{initials(u.name)}</div>}
                <div><div style={{ ...S.sans, fontSize:13, fontWeight:500, color:"#1a1814" }}>{u.name}</div><div style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>Player</div></div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Relationship type chips ───────────────────────────────────── */}
      <div style={{ ...S.label, marginBottom:8 }}>Relationship type</div>
      {relTypes.length === 0 && <p style={{ ...S.sans, fontSize:12, color:"#a8a5a0", marginBottom:12 }}>Loading…</p>}
      {dimOrder.map(dim => {
        const cfg = dimConfig[dim];
        const allTypes = [...(grouped[dim]||[]), ...(customTypes[dim]||[])];
        if (allTypes.length === 0 && relTypes.length > 0) return null;
        return (
          <div key={dim} style={{ marginBottom:12 }}>
            <div style={{ ...S.label, color:cfg.color, marginBottom:5 }}>{cfg.label}</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginBottom:6 }}>
              {allTypes.map(t => {
                const sel = selType?.id === t.id;
                return <span key={t.id} onClick={() => selectType(t)} style={{ padding:"4px 10px", borderRadius:20, fontSize:12, cursor:"pointer", border:`1px solid ${sel?cfg.selBg:cfg.border}`, background:sel?cfg.selBg:cfg.bg, color:sel?cfg.selColor:cfg.color }}>{t.name.replace(/_/g," ")}</span>;
              })}
            </div>
            <div style={{ display:"flex", gap:6 }}>
              <input value={customInputs[dim]} onChange={e=>setCustomInputs(p=>({...p,[dim]:e.target.value}))} onKeyDown={e=>e.key==="Enter"&&addCustomType(dim)} placeholder={`New ${cfg.label.toLowerCase()} type…`} style={{ flex:1, fontSize:12, padding:"4px 8px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)" }} />
              <button onClick={()=>addCustomType(dim)} style={{ ...S.sans, fontSize:11, padding:"4px 10px", borderRadius:7, border:`1px solid ${cfg.border}`, background:cfg.bg, color:cfg.color, cursor:"pointer" }}>+ Add</button>
            </div>
          </div>
        );
      })}

      {/* ── Score sliders ─────────────────────────────────────────────── */}
      {selType && (
        <div style={{ marginBottom:14, padding:"12px 14px", background:dimCfg.bg, borderRadius:12, border:`1px solid ${dimCfg.border}` }}>
          <div style={{ ...S.label, color:dimCfg.color, marginBottom:10 }}>Initial scores</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px 20px" }}>
            {SCORE_FIELDS.map(([key,label]) => (
              <div key={key}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                  <span style={{ ...S.sans, fontSize:11, color:"#6b6760" }}>{label}</span>
                  <span style={{ ...S.mono, fontSize:11, color:dimCfg.color }}>{(scores[key]||0).toFixed(2)}</span>
                </div>
                <input type="range" min={0} max={1} step={0.01} value={scores[key]||0}
                  onChange={e => setScores(p => ({...p, [key]:parseFloat(e.target.value)}))}
                  style={{ width:"100%", accentColor:dimCfg.selBg }} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Description + Inspire me ─────────────────────────────────── */}
      <div style={{ marginBottom:14 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
          <div style={{ ...S.label }}>Describe the relationship</div>
          {canAdd && (
            <button onClick={inspire} disabled={inspiring} style={{ ...S.sans, fontSize:11, padding:"3px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor: inspiring?"default":"pointer", opacity:inspiring?0.5:1 }}>
              {inspiring ? "Thinking…" : "✨ Inspire me"}
            </button>
          )}
        </div>
        <textarea value={description} onChange={e=>setDescription(e.target.value)} placeholder="Backstory — how this relationship came to be…" style={{ width:"100%", minHeight:56, fontSize:13, padding:"8px 10px", borderRadius:10, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", resize:"vertical", boxSizing:"border-box", marginBottom:8 }} />
        <div style={{ ...S.label, marginBottom:6 }}>Current dynamic</div>
        <textarea value={context} onChange={e=>setContext(e.target.value)} placeholder="Context — what is happening between them right now…" style={{ width:"100%", minHeight:48, fontSize:13, padding:"8px 10px", borderRadius:10, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", resize:"vertical", boxSizing:"border-box" }} />
      </div>

      <button onClick={addOrUpdate} disabled={!canAdd} style={{ ...S.sans, fontSize:12, padding:"6px 14px", borderRadius:8, border:"1px solid rgba(0,0,0,.12)", background:canAdd?"#1a1814":"none", color:canAdd?"#faf8f4":"#c8c5c0", cursor:canAdd?"pointer":"default", marginBottom:16 }}>
        {editingIdx !== null ? "Update relationship" : "+ Add relationship"}
      </button>

      {/* ── Added list ───────────────────────────────────────────────── */}
      {(state.relationships||[]).length > 0 && (
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          <div style={{ ...S.label, marginBottom:2 }}>Added</div>
          {(state.relationships||[]).map((r,i) => {
            const cfg = dimConfig[r.dimension_id] || dimConfig["dim-social"];
            const isEditing = editingIdx === i;
            return (
              <div key={i} onClick={() => editRel(i)} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 10px", borderRadius:10, border:`1px solid ${isEditing?"#1a1814":"rgba(0,0,0,.07)"}`, background:isEditing?"rgba(26,24,20,.03)":"rgba(255,255,255,.5)", cursor:"pointer" }}>
                {r.character.photo_url
                  ? <img src={r.character.photo_url} style={{ width:28, height:28, borderRadius:"50%", objectFit:"cover", flexShrink:0 }} />
                  : <div style={{ width:28, height:28, borderRadius:"50%", background:"rgba(0,0,0,.06)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:500, color:"#6b6760", flexShrink:0 }}>{initials(r.character.name)}</div>}
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ ...S.sans, fontSize:13, fontWeight:500, color:"#1a1814" }}>{r.character.first_name||r.character.name}</div>
                  {r.description && <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{r.description}</div>}
                </div>
                <span style={{ ...S.sans, fontSize:11, padding:"2px 8px", borderRadius:20, background:cfg.bg, color:cfg.color, border:`1px solid ${cfg.border}`, flexShrink:0 }}>{(r.rel_type_name||"").replace(/_/g," ")}</span>
                <button onClick={e=>{ e.stopPropagation(); removeRel(i); }} style={{ background:"none", border:"none", cursor:"pointer", color:"#c8c5c0", fontSize:14, padding:"0 2px", lineHeight:1 }}>×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


// ── Step 3: Schedule ──────────────────────────────────────────────────────────
function StepSchedule({ actor, state, setState }) {
  const [generating,  setGenerating]  = useState(false);
  const [error,       setError]       = useState("");
  const currentWeek = Math.ceil((new Date() - new Date(new Date().getFullYear(),0,1)) / 604800000);
  const [fromWeek,   setFromWeek]    = useState(currentWeek);

  useEffect(() => { setState(p => ({...p, fromWeek})); }, [fromWeek]);

  const DAY_ORDER = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
  const DAY_LABEL = { monday:"Mon", tuesday:"Tue", wednesday:"Wed", thursday:"Thu", friday:"Fri", saturday:"Sat", sunday:"Sun" };

  // Color by activity type
  function slotColor(slug) {
    if (!slug) return "#e8e4df";
    if (["sleeping","napping"].includes(slug))                              return { bg:"#E8EEF7", border:"#9BB5D6", text:"#3B5A82" };
    if (slug.startsWith("work_") || ["admin","planning","pitching","negotiating","script_reading","rehearsing","filming","editing","recording","composing","storyboarding","studying","coaching"].includes(slug)) return { bg:"#FEF3C7", border:"#F59E0B", text:"#92400E" };
    if (["exercise","running","cycling","yoga","stretching","swimming","hiking","sport","foam_rolling"].includes(slug)) return { bg:"#DCFCE7", border:"#4ADE80", text:"#166534" };
    if (["social_dinner","social_bar","social_cafe","social_drinks","social_late_night","party","networking","dining","brunch","coffee"].includes(slug)) return { bg:"#E1F5EE", border:"#5DCAA5", text:"#0F6E56" };
    if (["eating","cooking","meal_prep","snacking","drinking_coffee","drinking_wine","drinking_alcohol"].includes(slug)) return { bg:"#FEF9EC", border:"#F59E0B", text:"#78350F" };
    if (["morning_routine","waking","bath","skincare","grooming","laundry","cleaning","errands","shopping","medical","therapy","childcare"].includes(slug)) return { bg:"#F5F3FF", border:"#A78BFA", text:"#5B21B6" };
    if (["relaxing","decompressing","reading","watching_tv","scrolling","gaming","listening","daydreaming","meditating","journaling","reflection","creative","writing","sketching","painting","withdrawing"].includes(slug)) return { bg:"#FFF7ED", border:"#FB923C", text:"#9A3412" };
    if (["transit","taxi","travel","walking","waiting"].includes(slug))     return { bg:"#F1F5F9", border:"#94A3B8", text:"#475569" };
    return { bg:"#F5F2EF", border:"#D4CFC9", text:"#6B6760" };
  }

  function timeToMins(t) {
    if (!t) return 0;
    const [h, m] = t.split(":").map(Number);
    return h * 60 + (m || 0);
  }

  async function generate() {
    setGenerating(true); setError("");
    try {
      const r = await fetch(`/api/actors/${actor.id}/generate-schedule`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          home_address: state.home?.address,
          employment_type: state.career?.employment_type,
          career_level: state.career?.career_level,
          world_id: state.world?.id,
        })
      });
      if (r.ok) {
        const slots = await r.json();
        setState(p => ({...p, schedule: slots, fromWeek}));
      } else {
        setError("Generation failed — try again.");
      }
    } catch (e) {
      setError(e.message);
    }
    setGenerating(false);
  }

  const grouped = (state.schedule || []).reduce((acc, s) => {
    (acc[s.day_of_week] || (acc[s.day_of_week] = [])).push(s);
    return acc;
  }, {});

  const TOTAL_MINS = 24 * 60;

  return (
    <div>
      <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0", marginBottom:16 }}>Generate a weekly schedule from psychology and occupation</p>

      {!state.schedule ? (
        <div style={{ textAlign:"center", padding:"2rem 0" }}>
          <button onClick={generate} disabled={generating} style={{ ...S.sans, fontSize:13, padding:"10px 28px", borderRadius:10, border:"none", background:"#1a1814", color:"#faf8f4", cursor:"pointer", opacity:generating?0.6:1 }}>
            {generating ? "Generating…" : "✨ Generate schedule"}
          </button>
          {error && <p style={{ ...S.sans, fontSize:12, color:"#c0392b", marginTop:12 }}>{error}</p>}
        </div>
      ) : (
        <>
          {/* Day timeline grid */}
          <div style={{ display:"flex", gap:4, marginBottom:16, overflowX:"auto" }}>
            {/* Time axis */}
            <div style={{ width:28, flexShrink:0, height:360, position:"relative", marginTop:22 }}>
              {[0,6,12,18,24].map(h => (
                <div key={h} style={{ position:"absolute", top:(h/24)*360, right:2, transform:"translateY(-50%)", ...S.mono, fontSize:8, color:"#a8a5a0", lineHeight:1 }}>{String(h).padStart(2,"0")}</div>
              ))}
            </div>
            {DAY_ORDER.map(day => {
              const slots = (grouped[day] || []).sort((a,b) => timeToMins(a.start_time) - timeToMins(b.start_time));
              return (
                <div key={day} style={{ flex:1, minWidth:90 }}>
                  <div style={{ ...S.label, marginBottom:5, textAlign:"center" }}>{DAY_LABEL[day]}</div>
                  <div style={{ height:360, position:"relative", borderRadius:8, overflow:"hidden", border:"1px solid rgba(0,0,0,.06)", background:"rgba(0,0,0,.02)" }}>
                    {slots.map((s,i) => {
                      const startM = timeToMins(s.start_time);
                      const endM   = Math.min(timeToMins(s.end_time === "24:00" ? "24:00" : s.end_time), TOTAL_MINS);
                      const top    = (startM / TOTAL_MINS) * 360;
                      const height = Math.max(((endM - startM) / TOTAL_MINS) * 360, 4);
                      const c      = slotColor(s.activity_slug);
                      return (
                        <div key={i} title={`${s.start_time}–${s.end_time} ${s.activity_slug}${s.state_note ? ` · ${s.state_note}` : ""}`}
                          style={{ position:"absolute", left:0, right:0, top, height, background:c.bg, borderTop:`1.5px solid ${c.border}`, overflow:"hidden", display:"flex", alignItems:"center", padding:"0 4px" }}>
                          {height > 18 && <span style={{ ...S.sans, fontSize:9, color:c.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", lineHeight:1.2 }}>
                            {s.activity_slug.replace(/_/g," ")}
                          </span>}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ ...S.mono, fontSize:8, color:"#a8a5a0", textAlign:"center", marginTop:3 }}>{slots.length} slots</div>
                </div>
              );
            })}
          </div>



          {/* Controls */}
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <div>
              <div style={{ ...S.label, marginBottom:5 }}>Roll out from week</div>
              <select value={fromWeek} onChange={e=>setFromWeek(Number(e.target.value))} style={{ fontSize:13, padding:"6px 10px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)" }}>
                {Array.from({length:52-currentWeek+1},(_,i)=>currentWeek+i).map(w=>(
                  <option key={w} value={w}>Week {w}{w===currentWeek?" (now)":""} → 52</option>
                ))}
              </select>
            </div>
            <button onClick={generate} disabled={generating} style={{ ...S.sans, fontSize:12, padding:"6px 12px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer", marginTop:18, opacity:generating?0.5:1 }}>
              {generating ? "Generating…" : "Regenerate"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Step 4: Media ─────────────────────────────────────────────────────────────
function StepMedia({ actor, state, setState }) {
  const [photos,    setPhotos]    = useState([]);
  const [slots,     setSlots]     = useState([]);
  const [voiceFile, setVoiceFile] = useState(null);
  const [voiceUploading, setVoiceUploading] = useState(false);
  const [voiceDone, setVoiceDone] = useState(false);

  useEffect(() => {
    fetch(`/api/actors/${actor.id}/media`).then(r=>r.ok?r.json():[]).then(d => {
      setPhotos(d.filter(m=>m.media_type==="photo"));
    }).catch(()=>{});
  }, [actor.id]);

  useEffect(() => {
    if (!state.schedule?.length) return;
    const SKIP = new Set(["sleeping","napping","morning_routine","waking","transit","taxi","waiting","errands","laundry","cleaning"]);
    const seen = new Set();
    const unique = [];
    for (const s of state.schedule) {
      const slug = s.activity_slug;
      if (!slug || SKIP.has(slug) || seen.has(slug)) continue;
      seen.add(slug);
      unique.push({ slug, label: slug.replace(/_/g," ") });
    }
    setSlots(unique);
  }, [state.schedule]);

  useEffect(() => {
    fetch(`/api/actors/${actor.id}/media`).then(r=>r.ok?r.json():[]).then(d => {
      if (d.some(m=>m.media_type==="voice_reference")) setVoiceDone(true);
    }).catch(()=>{});
  }, [actor.id]);

  async function uploadVoice(file) {
    setVoiceUploading(true);
    const fd = new FormData();
    fd.append("audio", file);
    fd.append("media_type", "voice_reference");
    fd.append("state_slug", "voice_reference");
    try {
      const r = await fetch(`/api/actors/${actor.id}/media`, { method:"POST", body:fd });
      if (r.ok) setVoiceDone(true);
    } catch {}
    setVoiceUploading(false);
  }

  return (
    <div>
      <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0", marginBottom:16 }}>Transfer portraits and generate state images + animations</p>

      {/* Voice reference */}
      <div style={{ ...S.label, marginBottom:8 }}>Voice reference</div>
      <div style={{ padding:"12px 14px", borderRadius:10, border:`1px ${voiceDone?"solid":"dashed"} ${voiceDone?"rgba(29,158,117,.3)":"rgba(0,0,0,.1)"}`, background:voiceDone?"rgba(29,158,117,.05)":"rgba(0,0,0,.02)", marginBottom:20, display:"flex", alignItems:"center", gap:12 }}>
        {voiceDone ? (
          <>
            <span style={{ fontSize:18 }}>🎙️</span>
            <div style={{ flex:1 }}>
              <div style={{ ...S.sans, fontSize:13, fontWeight:500, color:"#0f6e56" }}>Voice reference uploaded</div>
              <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>Used by XTTS/COCQIA for voice synthesis</div>
            </div>
            <label style={{ ...S.sans, fontSize:11, padding:"4px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer" }}>
              Replace <input type="file" accept="audio/mp3,audio/mpeg,.mp3" style={{ display:"none" }} onChange={e=>{ if(e.target.files[0]) { setVoiceFile(e.target.files[0]); uploadVoice(e.target.files[0]); }}} />
            </label>
          </>
        ) : (
          <>
            <span style={{ fontSize:18 }}>🎙️</span>
            <div style={{ flex:1 }}>
              <div style={{ ...S.sans, fontSize:13, color:"#1a1814" }}>Upload a voice reference MP3</div>
              <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>10–30 seconds of clear speech, no background noise</div>
            </div>
            <label style={{ ...S.sans, fontSize:11, padding:"4px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.12)", background:"#1a1814", color:"#faf8f4", cursor:"pointer", opacity:voiceUploading?0.6:1 }}>
              {voiceUploading ? "Uploading…" : "Upload MP3"}
              <input type="file" accept="audio/mp3,audio/mpeg,.mp3" style={{ display:"none" }} onChange={e=>{ if(e.target.files[0]) { setVoiceFile(e.target.files[0]); uploadVoice(e.target.files[0]); }}} disabled={voiceUploading} />
            </label>
          </>
        )}
      </div>

      <div style={{ ...S.label, marginBottom:8 }}>Portraits · {photos.length} / 8</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(8,1fr)", gap:5, marginBottom:20 }}>
        {Array.from({length:8}).map((_,i) => {
          const p = photos[i];
          return (
            <div key={i} style={{ aspectRatio:"1", borderRadius:7, border:`1px ${p?"solid":"dashed"} ${p?"rgba(29,158,117,.3)":"rgba(0,0,0,.1)"}`, background:p?"rgba(29,158,117,.08)":"rgba(0,0,0,.03)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, color:p?"#0f6e56":"#c8c5c0", overflow:"hidden", position:"relative" }}>
              {p ? <img src={p.url} style={{ width:"100%", height:"100%", objectFit:"cover", borderRadius:7 }} /> : "+"}
            </div>
          );
        })}
      </div>

      <div style={{ ...S.label, marginBottom:8 }}>State images & animations</div>
      <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
        {slots.map(si => (
          <div key={si.slug} style={{ border:"1px solid rgba(0,0,0,.07)", borderRadius:10, overflow:"hidden" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"8px 12px", background:"rgba(0,0,0,.02)" }}>
              <span style={{ ...S.sans, fontSize:13, fontWeight:500, color:"#1a1814" }}>{si.label}</span>
              <div style={{ display:"flex", gap:5 }}>
                <button style={{ ...S.sans, fontSize:11, padding:"3px 9px", borderRadius:6, border:"1px solid rgba(55,138,221,.3)", background:"rgba(55,138,221,.07)", color:"#185FA5", cursor:"pointer" }}>Generate</button>
                <button style={{ ...S.sans, fontSize:11, padding:"3px 9px", borderRadius:6, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer" }}>Upload</button>
              </div>
            </div>
            {["Idle","Active"].map(anim => (
              <div key={anim} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"6px 12px 6px 22px", borderTop:"1px solid rgba(0,0,0,.04)" }}>
                <span style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>↳ {anim} animation</span>
                <div style={{ display:"flex", gap:5 }}>
                  <button style={{ ...S.sans, fontSize:11, padding:"3px 9px", borderRadius:6, border:"1px solid rgba(55,138,221,.3)", background:"rgba(55,138,221,.07)", color:"#185FA5", cursor:"pointer" }}>Generate from image</button>
                  <button style={{ ...S.sans, fontSize:11, padding:"3px 9px", borderRadius:6, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer" }}>Upload</button>
                </div>
              </div>
            ))}
          </div>
        ))}
        {slots.length===0 && <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0" }}>Complete the schedule step first.</p>}
      </div>
    </div>
  );
}

// ── Step 5: Review ────────────────────────────────────────────────────────────
function StepDeploy({ actor, state }) {
  const rows = [
    ["Character",    actor?.name],
    ["World",        state.world?.name],
    ["Relationships",(state.relationships||[]).map(r=>`${r.character.first_name||r.character.name} · ${(r.rel_type_name||r.label||"").replace(/_/g," ")}`).join(", ")||"None"],
    ["Schedule",     state.schedule?`${state.schedule.length} blocks · week ${state.fromWeek} → 52`:"Not set"],
    ["Starting location","Home"],
  ];
  return (
    <div>
      <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0", marginBottom:16 }}>{actor?.first_name||actor?.name} will be spawned into {state.world?.name}</p>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid rgba(0,0,0,.05)" }}>
          <span style={{ ...S.sans, fontSize:13, color:"#a8a5a0" }}>{label}</span>
          <span style={{ ...S.sans, fontSize:13, color:"#1a1814", fontWeight:500, textAlign:"right", maxWidth:340 }}>{value||"—"}</span>
        </div>
      ))}
      <div style={{ marginTop:16, padding:"11px 13px", background:"rgba(0,0,0,.03)", borderRadius:10 }}>
        <p style={{ ...S.sans, fontSize:12, color:"#a8a5a0", margin:0 }}>
          Once deployed, {actor?.first_name||actor?.name} will begin her schedule immediately. Seeded relationships allow the world engine to generate natural encounters.
        </p>
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────
export default function DeployWizardModal({ actor, onClose, onDeployed }) {
  const [step, setStep]   = useState(1);
  const [state, setState] = useState({ world:null, relationships:[], schedule:null, fromWeek:1, stateImages:[] });
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  function canNext() {
    if (step===1) return !!state.world && !!state.home?.place_id && !!state.home?.home_type;
    if (step===3) return !!state.schedule;
    return true;
  }

  async function handleDeploy() {
    setDeploying(true);
    setError("");
    try {
      const payload = {
        world:         state.world,
        home:          state.home,
        workplace:     state.workplace || null,
        career:        state.career || null,
        relationships: state.relationships || [],
        schedule:      state.schedule || [],
        fromWeek:      state.fromWeek || 1,
      };
      const res = await fetch(`/api/actors/${actor.id}/deploy`, {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        onDeployed({ platform_actor_id: actor.id, world_id: state.world.id, world_name: state.world.name, simulator_actor_id: data.simulator_actor_id });
      } else {
        setError(data.error || "Deploy failed.");
        setDeploying(false);
      }
    } catch(e) { setError("Network error: " + e.message); setDeploying(false); }
  }

  const nextLabels = ["","Next →","Next →","Next →","Next →","Deploy"];

  return (
    <div style={S.overlay}>
      <div style={{...S.modal, position:"relative"}} onClick={e=>e.stopPropagation()}>
        {/* Loading spinner overlay */}
        {deploying && (
          <div style={{ position:"absolute", inset:0, zIndex:10, borderRadius:24, background:"rgba(255,255,255,0.85)", backdropFilter:"blur(8px)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16 }}>
            <div style={{ width:40, height:40, border:"3px solid rgba(0,0,0,0.08)", borderTop:"3px solid #1a1814", borderRadius:"50%", animation:"spin 0.9s linear infinite" }} />
            <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#1a1814", fontWeight:500 }}>Deploying character…</div>
            <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0" }}>This may take a minute — Dolphin is thinking</div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"1.25rem 1.5rem .75rem", borderBottom:"1px solid rgba(0,0,0,.06)", flexShrink:0 }}>
          <div>
            <div style={{ ...S.serif, fontSize:21, fontWeight:500, color:"#1a1814" }}>Deploy {actor?.first_name||actor?.name}</div>
            <div style={{ ...S.sans, fontSize:12, color:"#a8a5a0", marginTop:2 }}>Step {step} of {STEPS.length} — {STEPS[step-1]}</div>
          </div>
          <button onClick={()=>{ if(window.confirm("Close? Progress will be lost.")) onClose(); }} style={{ background:"none", border:"1px solid rgba(0,0,0,.08)", borderRadius:8, padding:"6px 12px", cursor:"pointer", ...S.sans, fontSize:12, color:"#a8a5a0" }}>✕</button>
        </div>

        <StepBar current={step} />

        {/* Body */}
        <div style={{ flex:1, overflowY:"auto", padding:"1.25rem 1.5rem" }}>
          {step===1 && <StepWorld actor={actor} state={state} setState={setState} />}
          {step===2 && <StepRelationships actor={actor} state={state} setState={setState} />}
          {step===3 && <StepSchedule    actor={actor} state={state} setState={setState} />}
          {step===4 && <StepMedia       actor={actor} state={state} setState={setState} />}
          {step===5 && <StepDeploy      actor={actor} state={state} />}
          {error && <p style={{ ...S.sans, fontSize:12, color:"#c0392b", marginTop:12 }}>{error}</p>}
        </div>

        {/* Footer */}
        <div style={{ display:"flex", justifyContent:"space-between", padding:"1rem 1.5rem", borderTop:"1px solid rgba(0,0,0,.06)", flexShrink:0 }}>
          <button onClick={()=>setStep(p=>Math.max(1,p-1))} disabled={step===1} style={{ ...S.sans, fontSize:13, padding:"8px 18px", borderRadius:9, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer", opacity:step===1?.4:1 }}>← Back</button>
          <button onClick={()=>{ if(!canNext()) return; if(step===5) handleDeploy(); else setStep(p=>p+1); }} disabled={deploying||!canNext()} style={{ ...S.sans, fontSize:13, padding:"8px 24px", borderRadius:9, border:"none", background:"#1a1814", color:"#faf8f4", cursor:"pointer", opacity:(!canNext()||deploying)?.5:1 }}>
            {deploying?"Deploying…":nextLabels[step]}
          </button>
        </div>
      </div>
    </div>
  );
}
