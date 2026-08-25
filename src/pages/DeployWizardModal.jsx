import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { fmtAmount, fmtSigned, fmtMoney } from "../lib/money.js";
import AmountInput from "../lib/AmountInput.jsx";
import { isPreciseHome, IMPRECISE_HOME_HINT } from "../lib/placePrecision.js";

const S = {
  overlay: { position:"fixed",inset:0,zIndex:1000,background:"rgba(238,236,234,0.72)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",display:"flex",alignItems:"center",justifyContent:"center",padding:"1.5rem" },
  modal:   { background:"rgba(255,255,255,0.92)",backdropFilter:"blur(40px) saturate(200%)",WebkitBackdropFilter:"blur(40px) saturate(200%)",border:"1px solid rgba(255,255,255,0.95)",boxShadow:"0 8px 64px rgba(0,0,0,0.12),0 1px 0 rgba(255,255,255,1) inset",borderRadius:24,width:"100%",maxWidth:900,maxHeight:"92vh",display:"flex",flexDirection:"column",overflow:"hidden" },
  serif:   { fontFamily:"'Cormorant Garamond',Georgia,serif" },
  sans:    { fontFamily:"'DM Sans',system-ui,sans-serif" },
  mono:    { fontFamily:"'DM Mono',monospace" },
  label:   { fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0" },
};

const STEPS = ["World", "Relationships", "CV & Employment", "Schedule", "Media", "Deploy"];

// ── Step bar ──────────────────────────────────────────────────────────────────
function StepBar({ current }) {
  return (
    <div style={{ display:"flex", alignItems:"center", padding:"1rem 1.5rem 0" }}>
      {STEPS.map((label, i) => {
        const next = i + 1;
        const done   = next < current;
        const active = next === current;
        return (
          <div key={label} style={{ display:"flex", alignItems:"center", flex: i < STEPS.length-1 ? 1 : "none" }}>
            <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
              <div style={{ width:24, height:24, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:500, flexShrink:0, background: done?"rgba(29,158,117,.12)":active?"#1a1814":"rgba(0,0,0,.06)", color: done?"#0f6e56":active?"#faf8f4":"#a8a5a0" }}>
                {done ? "✓" : next}
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
  const [suggesting,    setSuggesting]    = useState(false);
  const [searchQuery,   setSearchQuery]   = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching,     setSearching]     = useState(false);
  const searchTimer = useRef(null);
  const mapRef      = useRef(null);
  const mapInst     = useRef(null);
  const markerRef   = useRef(null);
  const [mapReady,  setMapReady]  = useState(false);

  const [worldsError, setWorldsError] = useState("");
  const [startingWorld, setStartingWorld] = useState(false);

  // Session 150 — worlds she is already deployed to cannot be chosen again.
  // The server refuses the duplicate with a 409 regardless, but discovering that
  // at step 6 after filling in a CV and generating a schedule is a poor way to
  // learn it.
  const [alreadyIn, setAlreadyIn] = useState({});   // world_id -> world_name
  useEffect(() => {
    if (!actor?.id) return;
    fetch(`/api/actors/deployments`, { credentials: "include" })
      .then(r => r.ok ? r.json() : [])
      .then(ds => {
        const map = Object.fromEntries(
          ds.filter(d => d.platform_actor_id === actor.id).map(d => [d.world_id, d.world_name]));
        setAlreadyIn(map);
        // A restored draft can hold a world she has been deployed to since the
        // draft was saved. Clear it, so step 1's gate fails honestly on "no world
        // chosen" rather than waving through a selection the server will refuse.
        setState(p => p.world && map[p.world.id] ? { ...p, world: null } : p);
      })
      .catch(() => {});
  }, [actor?.id]);

  function loadWorlds() {
    return fetch("/api/worlds", { credentials: "include" })
      .then(async r => {
        if (!r.ok) throw new Error(r.status === 502 ? "The simulator isn't reachable." : `HTTP ${r.status}`);
        return r.json();
      })
      .then(ws => {
        setWorlds(ws);
        setWorldsError(ws.length ? "" : "You don't have any worlds yet — create one before deploying.");
        // Keep the selected world's status fresh. It is stored in wizard state
        // and would otherwise stay whatever it was when the wizard opened, which
        // is exactly how a stopped world reads as running.
        setState(p => p.world ? { ...p, world: ws.find(w => w.id === p.world.id) || p.world } : p);
        return ws;
      })
      .catch(e => { setWorldsError(e.message); return []; });
  }

  useEffect(() => { loadWorlds(); }, []);

  // Session 150 — a world has to be running to deploy into, so offer to start it
  // here rather than sending someone to /my-worlds and back.
  async function startWorld(w) {
    setStartingWorld(true);
    try {
      await fetch(`/api/worlds/${w.id}/start`, { method:"POST", credentials:"include" });
      await new Promise(r => setTimeout(r, 1200));
      await loadWorlds();
    } catch {}
    setStartingWorld(false);
  }

  // Load Google Maps
  useEffect(() => {
    if (window.google?.maps) { setMapReady(true); return; }
    if (document.getElementById("gmaps-script")) {
      const timer = setInterval(() => { if (window.google?.maps) { setMapReady(true); clearInterval(timer); } }, 200);
      return;
    }
    const script = document.createElement("script");
    script.id  = "gmaps-script";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}`;
    script.onload = () => setMapReady(true);
    document.head.appendChild(script);
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
          const data = await r.json();
          setState(prev => ({...prev, home: { ...data, home_type: prev.home?.home_type }}));
          setSearchQuery(data.address);
        }
      } catch {}
    });
    }, 100);
    return () => clearTimeout(timer);
  }, [mapReady, state.world]);

  // Reset map when world changes so it reinitializes centered on new city
  useEffect(() => {
    if (!state.world?.id) return;
    if (mapInst.current) { mapInst.current = null; }
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
      // Session 150 — this posted no body at all, so the handler's
      // `const { world_id } = req.body || {}` always resolved undefined
      // and fell straight through to its `city = "Stockholm"` default.
      // Every neighbourhood suggestion was a Stockholm one regardless of
      // which world was selected — confirmed by reading the handler in
      // server/index.js, not inferred from the output.
      const r = await fetch(`/api/actors/${actor.id}/suggest-home`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ world_id: state.world?.id }),
      });
      if (r.ok) setSuggestions(await r.json());
    } catch {}
    setSuggesting(false);
  }

  function searchPlaces(q) {
    setSearchQuery(q);
    if (!q || q.length < 3) { setSearchResults([]); return; }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const country = state.world?.country || '';
        const url = `/api/places/autocomplete?q=${encodeURIComponent(q)}${country ? '&country='+country : ''}`;
        const r = await fetch(url, { credentials: 'include' });
        if (r.ok) { const data = await r.json(); setSearchResults(Array.isArray(data) ? data : []); }
      } catch(e) { console.error('[searchPlaces] error', e); }
      setSearching(false);
    }, 400);
  }

  function pickSuggestion(s) {
    const city = state.world?.city || "Stockholm";
    const query = s.neighbourhood + " " + city;
    setSearchQuery(query); searchPlaces(query);
  }

  async function pickPlace(p) {
    setSearchResults([]);
    setSearchQuery(p.description);
    setState(prev => ({...prev, home: { place_id: p.place_id, address: p.description, name: p.description, types: p.types, home_type: prev.home?.home_type }}));
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);
      const r = await fetch(`/api/places/details?place_id=${p.place_id}`, { signal: controller.signal });
      if (r.ok) {
        const data = await r.json();
        setState(prev => ({...prev, home: { ...prev.home, ...data }}));
        setSearchQuery(data.address);
      }
    } catch {}
  }

  return (
    <div>
      {/* World selector */}
      <div style={{ ...S.label, marginBottom:8 }}>World</div>
      {worlds.length === 0 && (
        <p style={{ ...S.sans, fontSize:13, color: worldsError ? "#993c1d" : "#a8a5a0" }}>
          {worldsError || "Loading…"}
        </p>
      )}
      {worlds.map(w => {
        const running = w.status === "running";
        const taken   = !!alreadyIn[w.id];
        return (
          <div key={w.id} onClick={() => { if (!taken) setState(p => ({...p, world:w})); }}
            title={taken ? `${actor?.first_name || "She"} is already deployed to ${w.name}` : undefined}
            style={{ padding:"10px 14px", borderRadius:12,
              border:`1.5px solid ${state.world?.id===w.id?"#1a1814":"rgba(0,0,0,.08)"}`,
              background: taken ? "rgba(0,0,0,.025)" : state.world?.id===w.id?"rgba(26,24,20,.04)":"rgba(255,255,255,.5)",
              cursor: taken ? "default" : "pointer", opacity: taken ? .6 : 1,
              marginBottom:8, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ minWidth:0 }}>
              <div style={{ ...S.sans, fontSize:13, fontWeight:500, color:"#1a1814" }}>{w.name}</div>
              <div style={{ ...S.sans, fontSize:11, color: taken ? "#a8a5a0" : running?"#5CA87A":"#c0392b", marginTop:1 }}>
                {taken ? "already deployed here" : running ? "● running" : "● stopped"}
              </div>
            </div>
            {taken
              ? <span style={{ ...S.sans, fontSize:9, letterSpacing:".08em", textTransform:"uppercase",
                  padding:"3px 8px", borderRadius:5, background:"rgba(29,158,117,.1)", color:"#0F6E56",
                  border:"1px solid rgba(29,158,117,.22)", flexShrink:0 }}>in play</span>
              : state.world?.id===w.id && <span style={{ color:"#1a1814" }}>✓</span>}
          </div>
        );
      })}

      {worlds.length > 0 && worlds.every(w => alreadyIn[w.id]) && (
        <div style={{ ...S.sans, fontSize:12, color:"#6b6760", padding:"10px 12px", marginTop:2,
          background:"rgba(0,0,0,.02)", border:"1px solid rgba(0,0,0,.07)", borderRadius:10 }}>
          {actor?.first_name || "She"} is already in every world you have. To change how she works in one,
          edit her there instead of deploying again.
        </div>
      )}

      {/* Session 150 — a stopped world cannot receive a deploy, so say so at the
          point of choice and offer the fix inline. The wizard's Next is gated on
          the same condition, but a disabled button with no explanation is how
          people end up staring at a screen. */}
      {state.world && state.world.status !== "running" && (
        <div style={{ display:"flex", alignItems:"center", gap:11, padding:"11px 13px", marginTop:2, marginBottom:4,
          background:"rgba(192,57,43,.05)", border:"1px solid rgba(192,57,43,.18)", borderRadius:10 }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ ...S.sans, fontSize:12.5, color:"#993c1d", fontWeight:500 }}>
              {state.world.name} is stopped
            </div>
            <div style={{ ...S.sans, fontSize:11.5, color:"#6b6760", marginTop:1, lineHeight:1.5 }}>
              She can't be deployed into a world that isn't running.
            </div>
          </div>
          <button onClick={() => startWorld(state.world)} disabled={startingWorld}
            style={{ ...S.sans, fontSize:11, letterSpacing:".05em", textTransform:"uppercase", padding:"6px 13px",
              borderRadius:7, border:"none", background:"#1a1814", color:"#faf8f4",
              cursor: startingWorld ? "default" : "pointer", flexShrink:0, opacity: startingWorld ? .55 : 1 }}>
            {startingWorld ? "Starting…" : "Start world"}
          </button>
        </div>
      )}

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
                    {searchResults.map(p => {
                      const precise = isPreciseHome(p.types);
                      return (
                      <div key={p.place_id} onClick={() => pickPlace(p)} style={{ padding:"8px 10px", cursor:"pointer", fontSize:12 }}
                        onMouseEnter={e=>e.currentTarget.style.background="#f5f2ef"}
                        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                        <div style={{ ...S.sans, color: precise ? "#1a1814" : "#a8a5a0" }}>{p.description}</div>
                        {!precise && (
                          <div style={{ ...S.sans, fontSize:10, color:"#b8763a", marginTop:2 }}>
                            {IMPRECISE_HOME_HINT}
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {state.home?.place_id && (
                <>
                  <div style={{ padding:"8px 10px", borderRadius:9,
                    border:`1.5px solid ${isPreciseHome(state.home.types) ? "#1a1814" : "#b8763a"}`,
                    background: isPreciseHome(state.home.types) ? "rgba(26,24,20,.03)" : "rgba(184,118,58,.06)" }}>
                    <div style={{ ...S.sans, fontSize:12, fontWeight:500, color:"#1a1814" }}>{state.home.address}</div>
                    {state.home.lat && <div style={{ ...S.sans, fontSize:10, color:"#a8a5a0", marginTop:2 }}>{state.home.lat?.toFixed(5)}, {state.home.lng?.toFixed(5)}</div>}
                    {!isPreciseHome(state.home.types) && (
                      <div style={{ ...S.sans, fontSize:11, color:"#8a5624", marginTop:5, lineHeight:1.45 }}>
                        That is the whole street. Search again with a house number — she needs a
                        building to live in, not a road.
                      </div>
                    )}
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
        </>
      )}
    </div>
  );
}

// ── Step: Employment ─────────────────────────────────────────────────────────
// Session 150 — the fallback shape for a source with no hours configured.
// Matches what the old global Work Hours block defaulted to, and what
// generate-schedule still falls back to server-side, so a source left
// untouched behaves exactly as it did before hours moved per-source.
const DEFAULT_BLOCK = { start:"08:00", end:"17:00" };

// Session 150 — which days a source is worked. Lowercase names match the
// day_of_week vocabulary schedule slots already use, and the Mon-Fri default is
// exactly what generate-schedule assumed for everyone before days existed — so
// a source left untouched behaves as it always did.
const WEEK = [
  { key:"monday",    short:"M" }, { key:"tuesday",   short:"T" },
  { key:"wednesday", short:"W" }, { key:"thursday",  short:"T" },
  { key:"friday",    short:"F" }, { key:"saturday",  short:"S" },
  { key:"sunday",    short:"S" },
];
const DEFAULT_WORK_DAYS = ["monday","tuesday","wednesday","thursday","friday"];
// Session 150 — paid leave ENTITLEMENT, not booked dates. How much a job grants
// is a term of employment; whether it gets taken is the world's decision.
// 25 is the Swedish statutory minimum and is shown as an editable starting
// value, never applied silently — jurisdictions differ sharply and the US has
// no federal minimum at all. Contract and independent work grant none by
// default: there is nobody to ask.
function leaveDaysOf(src) {
  if (src.leave_days_per_year !== undefined && src.leave_days_per_year !== null) return src.leave_days_per_year;
  return src.source_type === "employment" ? 25 : 0;
}
// Same fallback StepEmployment renders from, hoisted so the deploy payload can
// resolve it too rather than sending whatever happens to be stored.
function blocksOfSource(src) {
  const b = src.work_blocks;
  return Array.isArray(b) && b.length > 0 ? b : [{...DEFAULT_BLOCK}];
}
function daysOf(src) {
  // An explicit empty array means "never worked" and is NOT the same as unset.
  // Collapsing the two would make the UI lie: deselecting every day warns the
  // source will never be worked, while the schedule quietly ran it Mon-Fri.
  return Array.isArray(src.work_days) ? src.work_days : DEFAULT_WORK_DAYS;
}

// Loose name comparison, shared by the CV-employer staleness check and the
// workplace auto-pick. The CV writes an employer as bare prose while Google
// Places returns a fuller description of the same business.
const normName = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Session 150 — career level and reputation moved onto each revenue source
// too. They aren't properties of a person: someone can be senior in the
// field one source belongs to and junior in another's, and the simulator's
// own reputation model is career reputation (it drives work-offer fee bands
// and international eligibility), which is inherently field-specific rather
// than general social regard.
//
// The two can't be split from each other — the simulator promotes career
// level when reputation crosses a threshold band, so a reputation per source
// implies a level per source by construction. Both move together or neither.
//
// Ordered low → high. Must stay in sync with WorkOfferGenerator's
// @standard_levels on the simulator, which indexes this exact list to pick
// fee bands (junior 5–20k, established 15–50k, senior 40–100k,
// independent 80–250k SEK).
// Session 150 — how each source type pays. The three types exist precisely
// because they pay differently: employment pays for your TIME (same figure
// monthly), contract pays for a JOB (one sum, once, on completion), and
// independent is the MARKET paying for OUTPUT (monthly, moving with demand).
// Mirrors default_basis/1 in ScheduledPaymentProcess on the simulator.
// Session 150 — the effective pay day, resolved in ONE place.
//
// The fallback used to be written out at every use site: the input rendered
// `src.pay_day ?? 25`, the review line printed `s.pay_day ?? 25`, and the deploy
// sent `s.pay_day ?? 25` — but the step-3 gate tested the raw `s.pay_day`. So a
// source that had never had the field touched showed 25 on screen, would have
// deployed as 25, and still blocked Next with "Set a pay day", because only the
// gate saw the undefined the other three were papering over.
//
// per_contract has no pay day at all: it is paid on completion, so there is no
// day of the month for it to land on.
function srcPayDay(src) {
  if (srcBasis(src) === "per_contract") return null;
  const n = Number(src?.pay_day);
  return Number.isFinite(n) && n >= 1 && n <= 28 ? n : 25;
}

function srcBasis(src) {
  if (src.amount_basis) return src.amount_basis;
  if (src.source_type === "contract")    return "per_contract";
  if (src.source_type === "independent") return "variable";
  return "monthly";
}
function incomeLabel(src) {
  const b = srcBasis(src);
  return b === "per_contract" ? "Contract fee" : b === "variable" ? "Expected income" : "Salary";
}

// Session 150 — the only cadences payment_due_today? recognises. Anything else
// lands in its `_ -> false` branch: the row would sit in the table looking
// configured and never once be charged.
const EXPENSE_CADENCES = ["monthly", "quarterly", "annual"];
const EXPENSE_CATEGORIES = ["rent", "utilities", "transit", "food", "phone", "insurance", "subscription", "leisure", "childcare", "debt", "other"];

// A starting point scaled to what she earns, not a fixed price list — 12,000 rent
// is ordinary for an 80k lawyer and impossible for a 20k barista. Applied only
// when the button is pressed, and every line stays editable afterwards.
function suggestExpenses(monthlyIncome) {
  const r = (frac, min) => Math.max(min, Math.round((monthlyIncome * frac) / 100) * 100);
  return [
    { name: "Rent",      category: "rent",         amount: r(0.30, 4000), cadence: "monthly", debit_day: 1  },
    { name: "Utilities", category: "utilities",    amount: r(0.02, 400),  cadence: "monthly", debit_day: 5  },
    { name: "Transit",   category: "transit",      amount: r(0.01, 300),  cadence: "monthly", debit_day: 1  },
    { name: "Groceries", category: "food",         amount: r(0.08, 2000), cadence: "monthly", debit_day: 3  },
    { name: "Phone",     category: "phone",        amount: r(0.005, 200), cadence: "monthly", debit_day: 20 },
    { name: "Leisure",   category: "leisure",      amount: r(0.05, 500),  cadence: "monthly", debit_day: 10 },
  ];
}

const CAREER_LEVELS = ["junior","established","senior","independent"];

// Session 150 — career level is DERIVED from reputation, never set by hand.
// ReputationEngine already owns this relationship: it promotes and demotes as
// reputation crosses a band, so anything the operator typed here would be
// overruled the first time reputation moved. One input, one derived output.
//
// Bands collapse the engine's five ladder thresholds onto the four-tier
// standard scale WorkOfferGenerator actually indexes. If the simulator's
// bands are retuned, retune these to match — a starting level that disagrees
// with what the engine computes would show up as an immediate,
// unexplained promotion or demotion on the actor's first reputation change.
const LEVEL_BANDS = [
  { min: 0.82, level: "independent" },
  { min: 0.60, level: "senior"      },
  { min: 0.35, level: "established" },
  { min: 0.00, level: "junior"      },
];
function levelFromReputation(score) {
  // null and undefined both mean "not set" and must land on the same 0.5 the
  // slider displays for them. Number(null) is 0, not NaN — left to coerce, a
  // null would show as 50% in the UI and deploy as junior.
  const n = (score === null || score === undefined) ? NaN : Number(score);
  const s = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
  return (LEVEL_BANDS.find(b => s >= b.min) || LEVEL_BANDS[LEVEL_BANDS.length - 1]).level;
}

// The simulator's actors table still carries one career_level and one
// reputation_score, read by ReputationEngine, WorkOfferGenerator and the
// LiveView career tab. Roll the per-source values up to a single figure for
// those: MAX, not mean. Being well-regarded in one field makes a person
// well-regarded; a modest side hustle shouldn't drag that down.
function rollupCareerLevel(sources) {
  // Derived from the rolled-up reputation, so the actor row's level and score
  // can never disagree with each other or with the engine's own bands.
  if (!sources || sources.length === 0) return null;
  return levelFromReputation(rollupReputation(sources));
}
function rollupReputation(sources) {
  const scores = (sources || [])
    .map(s => Number(s.reputation_score))
    .filter(n => Number.isFinite(n));
  return scores.length > 0 ? Math.max(...scores) : 0.5;
}

function StepEmployment({ actor, state, setState }) {
  // Session 149 — was a single workQuery/workResults/workplace keyed off
  // one global workplace. Now keyed by source id, since each revenue
  // source can have its own optional workplace search. Dropped the
  // interactive click-to-pin map from this rewrite — genuinely complex
  // to run N independent map instances well, and the search box was
  // always the primary way this got used anyway. Flagged clearly, not
  // silently dropped.
  const [queries,   setQueries]   = useState({});
  const [results,   setResults]   = useState({});
  const [searching, setSearching] = useState({});
  const timers = useRef({});

  const sources = state.career?.revenue_sources || [];
  // Currency comes from the world's own city (cities.currency on the simulator,
  // surfaced through /internal/worlds). Labelling amounts in the world's money
  // is the point — the SAD's "85,000 SEK incident" was a figure produced with
  // no currency context at all.
  const worldCurrency = state.world?.currency || "";
  // Recurring income only — a one-off contract fee is not monthly runway.
  const monthlyTotal = sources
    .filter(x => srcBasis(x) !== "per_contract")
    .reduce((sum, x) => sum + (Number(x.monthly_amount) || 0), 0);

  // Session 150 — salaries here are GROSS, and payday deducts tax from them.
  //
  // Asked of the server rather than computed here on purpose. The bands are
  // approximations that get corrected as they are found wrong, and a second copy
  // in JavaScript would drift from DeliverWorlds.Tax silently — the wizard would
  // keep quoting a rate the simulator had stopped using.
  //
  // Employment only, matching what payday actually taxes: freelance and business
  // income take other code paths and are assessed differently everywhere.
  const grossEmployment = sources
    .filter(x => x.source_type === "employment" && srcBasis(x) !== "per_contract")
    .reduce((sum, x) => sum + (Number(x.monthly_amount) || 0), 0);

  const [tax, setTax] = useState(null);
  const taxTimer = useRef(null);

  useEffect(() => {
    const country = state.world?.country;
    if (!country || !(grossEmployment > 0)) { setTax(null); return; }
    clearTimeout(taxTimer.current);
    taxTimer.current = setTimeout(() => {
      fetch(`/api/tax/estimate?country=${encodeURIComponent(country)}&gross=${grossEmployment}`,
            { credentials: "include" })
        .then(r => r.ok ? r.json() : null)
        .then(setTax)
        .catch(() => setTax(null));
    }, 400);
    return () => clearTimeout(taxTimer.current);
  }, [state.world?.country, grossEmployment]);

  // What she actually lives on: take-home plus any non-employment income, which
  // this model does not tax.
  const netTotal = tax ? (monthlyTotal - grossEmployment) + tax.net_monthly : monthlyTotal;

  function addSource() {
    const id = `rs-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    setState(p => ({...p, career: {...(p.career||{}), revenue_sources: [...(p.career?.revenue_sources||[]), { id, source_type:"employment", name:"", reputation_score:0.5, work_blocks:[{...DEFAULT_BLOCK}] }]}}));
  }

  // Session 150 — work hours are per-source now. A source that predates
  // this (restored draft, or the CV auto-create below) may have none, so
  // reads go through blocksOf rather than touching src.work_blocks raw.
  function blocksOf(src) {
    const b = src.work_blocks;
    return Array.isArray(b) && b.length > 0 ? b : [{...DEFAULT_BLOCK}];
  }
  function updateBlock(src, i, patch) {
    const next = blocksOf(src).map((b, idx) => idx === i ? {...b, ...patch} : b);
    updateSource(src.id, { work_blocks: next });
  }
  function addBlock(src) {
    updateSource(src.id, { work_blocks: [...blocksOf(src), { start:"09:00", end:"12:00" }] });
  }
  function toggleDay(src, dayKey) {
    const cur = daysOf(src);
    const next = cur.includes(dayKey) ? cur.filter(d => d !== dayKey) : [...cur, dayKey];
    // Ordered by the week, not by click order, so the stored value reads
    // sensibly and the schedule generator sees a predictable list.
    updateSource(src.id, { work_days: WEEK.map(w => w.key).filter(k => next.includes(k)) });
  }

  function removeBlock(src, i) {
    const next = blocksOf(src).filter((_, idx) => idx !== i);
    updateSource(src.id, { work_blocks: next.length > 0 ? next : [{...DEFAULT_BLOCK}] });
  }
  function updateSource(id, patch) {
    setState(p => ({...p, career: {...(p.career||{}), revenue_sources: (p.career?.revenue_sources||[]).map(s => s.id===id ? {...s, ...patch} : s)}}));
  }
  function removeSource(id) {
    setState(p => ({...p, career: {...(p.career||{}), revenue_sources: (p.career?.revenue_sources||[]).filter(s => s.id!==id)}}));
    setQueries(p => { const n={...p}; delete n[id]; return n; });
    setResults(p => { const n={...p}; delete n[id]; return n; });
  }

  // Session 150 — opts.autoPick resolves the top match without waiting for a
  // click. Typing here is a person browsing, so it stays manual; but when the
  // employer arrives from the CV the search was only ever kicked off and then
  // abandoned — nothing selected a result, so work_place_id/work_address were
  // never set, and the box was showing transient query text that vanished the
  // moment this step unmounted. The actor then deployed with a named employer
  // and no actual location.
  function searchFor(id, q, opts = {}) {
    setQueries(p => ({...p, [id]: q}));
    if (!q || q.length < 3) { setResults(p => ({...p, [id]: []})); return; }
    if (timers.current[id]) clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(async () => {
      setSearching(p => ({...p, [id]: true}));
      try {
        const country = state.world?.country || '';
        // Session 150 — types=establishment. The endpoint defaults to "address",
        // which cannot match a company name at all: "Mannheimer Swartling" came
        // back ZERO_RESULTS and the picker settled for the nearest street.
        // A workplace is a business, so ask for businesses.
        const r = await fetch(`/api/places/autocomplete?q=${encodeURIComponent(q)}&types=establishment${country ? '&country='+country : ''}`, { credentials:'include' });
        if (r.ok) {
          const data = await r.json();
          const list = Array.isArray(data) ? data : [];
          setResults(p => ({...p, [id]: list}));
          if (opts.autoPick && list.length > 0) {
            // Prefer a result that actually carries the employer's name over
            // whatever Places ranked first — a bare top result can be a
            // street or district that merely sits near the query.
            // Among results that actually carry the employer's name, prefer the
            // SHORTEST description. Google returns "Mannheimer Swartling New
            // York AdvokatAB, Kaptensgatan…" above "Mannheimer Swartling AB,
            // Norrlandsgatan…", and taking its first match would seat her at
            // the New York desk. Extra qualifiers mean a satellite; the plain
            // name is the main office.
            // Narrow in order: results carrying the employer's name, then those
            // in the world's own city, then the shortest of what remains.
            // City has to come before length — Google returns "Mannheimer
            // Swartling AB, Gothenburg" (shorter) alongside "…AB,
            // Norrlandsgatan, Stockholm", so shortest-wins alone seats a
            // Stockholm lawyer in the Gothenburg office. Among offices in the
            // right city, extra qualifiers still mean a satellite: the plain
            // name is the main one, so shortest breaks that tie correctly.
            const want = normName(q);
            const city = normName(state.world?.city);
            const shortest = xs => xs.reduce((a, b) => (b.description.length < a.description.length ? b : a));

            const named   = list.filter(x => { const d = normName(x.description); return d && want && d.includes(want); });
            const inCity  = city ? named.filter(x => normName(x.description).includes(city)) : [];
            const best    = inCity.length ? shortest(inCity)
                          : named.length  ? shortest(named)
                          : list[0];
            await pickPlace(id, best);
          }
        }
      } catch {}
      setSearching(p => ({...p, [id]: false}));
    }, 400);
  }

  async function pickPlace(id, p) {
    setResults(prev => ({...prev, [id]: []}));
    setQueries(prev => ({...prev, [id]: p.description}));
    updateSource(id, { work_place_id: p.place_id, work_address: p.description });
    try {
      const controller = new AbortController();
      setTimeout(()=>controller.abort(), 5000);
      const r = await fetch(`/api/places/details?place_id=${p.place_id}`, { signal: controller.signal });
      if (r.ok) {
        const data = await r.json();
        updateSource(id, { work_place_id: p.place_id, work_address: data.address, work_lat: data.lat, work_lng: data.lng });
        setQueries(prev => ({...prev, [id]: data.name + " — " + data.address}));
      }
    } catch {}
  }

  // Session 149 — CV comes before Employment in the wizard order and
  // already names a specific current employer. If no revenue source
  // exists yet, auto-create one (employment type) from the CV's own
  // structured format (COMPANY – Title, followed by a "...Present"
  // line) and kick off its search — still requires picking the real
  // Google Places match. Only fires once, never overrides anything
  // already there.
  // Session 150 — the parse is shared now: the auto-create below uses it, and
  // so does the staleness check further down.
  const cvEmployer = (() => {
    if (!state.cv?.notes) return null;
    const lines = state.cv.notes.split("\n").map(l => l.trim());
    for (let i = 0; i < lines.length - 1; i++) {
      if (/ – | - /.test(lines[i]) && lines[i].length < 90 && /present/i.test(lines[i+1] || "")) {
        return lines[i].split(/ – | - /)[0].trim();
      }
    }
    return null;
  })();

  useEffect(() => {
    if (!cvEmployer || sources.length > 0) return;
    const id = `rs-${Date.now()}-cv`;
    setState(p => ({...p, career: {...(p.career||{}), revenue_sources: [{ id, source_type:"employment", name: cvEmployer, reputation_score:0.5, work_blocks:[{...DEFAULT_BLOCK}] }]}}));
    setQueries(p => ({...p, [id]: cvEmployer}));
    searchFor(id, cvEmployer, { autoPick: true });
  }, [cvEmployer]);

  // Session 150 — the auto-create above fires only while no source exists, so
  // once one did, the CV could be regenerated or re-uploaded freely and this
  // step quietly stopped tracking it. A source created from an early draft
  // stayed pinned to that draft's employer while the CV moved on — and the
  // stale name is what got deployed and searched against Google Places, so an
  // actor could end up employed by a company that appears nowhere in their own
  // CV. Still never overwritten silently (the name may have been edited by
  // hand on purpose); the mismatch is surfaced for a one-click apply instead.
  // Compared loosely: the CV writes the employer as prose, while the field may
  // hold a fuller Google Places description of the same company.
  const cvEmployerMatched = !cvEmployer || sources.some(s => {
    const a = normName(s.name), b = normName(cvEmployer);
    return a && b && (a.includes(b) || b.includes(a));
  });

  function applyCvEmployer() {
    if (!cvEmployer) return;
    const target = sources.find(s => s.source_type === "employment") || sources[0];
    if (!target) return;
    // Drop the resolved workplace along with the name — it belongs to the
    // company being replaced, and a work_place_id pointing at the wrong
    // business is worse than none at all.
    updateSource(target.id, { name: cvEmployer, work_place_id: null, work_address: null, work_lat: null, work_lng: null });
    setQueries(p => ({...p, [target.id]: cvEmployer}));
    searchFor(target.id, cvEmployer, { autoPick: true });
  }

  return (
    <div>

      {/* Revenue sources — one or more, each its own type/name/workplace/hours */}
      <div style={{ marginTop:20 }}>
        <div style={{ ...S.label, marginBottom:6 }}>Revenue sources</div>
        {/* Session 150 — work hours moved here from a single global block
            under Career. They were never a property of the person: a day
            job runs 09:00–17:00 at an office while a freelance source runs
            two evening sessions from home, and one shared list couldn't
            express that. generate-schedule said as much in its own comment
            — it couldn't vary location per block "the way it ideally would
            for someone like Frida" precisely because hours weren't tied to
            a source. Now they are, and each block inherits its own
            source's location. */}
        <p style={{ ...S.sans, fontSize:11, color:"#a8a5a0", marginBottom:10 }}>
          Each source carries its own hours — one block for regular work (e.g. 08:00–17:00), or several for session-based work spread across the day.
        </p>

        {/* CV names an employer no source matches — offer it rather than
            overwrite, since the field may have been edited deliberately. */}
        {cvEmployer && !cvEmployerMatched && sources.length > 0 && (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, marginBottom:10, padding:"8px 11px", borderRadius:9, background:"rgba(176,92,8,.06)", border:"1px solid rgba(176,92,8,.25)" }}>
            <span style={{ ...S.sans, fontSize:11.5, color:"#b05c08", lineHeight:1.5 }}>
              The CV gives the current employer as <strong>{cvEmployer}</strong>, which no revenue source below matches.
            </span>
            <button onClick={applyCvEmployer} style={{ ...S.sans, fontSize:11, padding:"4px 10px", borderRadius:7, border:"1px solid rgba(176,92,8,.35)", background:"none", color:"#b05c08", cursor:"pointer", flexShrink:0, whiteSpace:"nowrap" }}>
              Use it
            </button>
          </div>
        )}
        {sources.length === 0 && (
          <p style={{ ...S.sans, fontSize:12, color:"#a8a5a0", marginBottom:10 }}>No revenue sources yet — add at least one.</p>
        )}
        {/* Session 150 — this step is now gated, so say why Next is
            disabled rather than leaving a dead button. The name is
            written straight into actor_revenue_sources.name on the
            simulator; a blank one is useless once it's over there. */}
        {sources.length > 0 && sources.some(s => !(s.name || "").trim()) && (
          <p style={{ ...S.sans, fontSize:12, color:"#b05c08", marginBottom:10 }}>
            Every revenue source needs a name before you can continue.
          </p>
        )}
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {sources.map(src => (
            <div key={src.id} style={{ padding:"12px 14px", borderRadius:12, border:"1px solid rgba(0,0,0,.08)", background:"rgba(255,255,255,.5)" }}>
              <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:8 }}>
                <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                  {["employment","contract","independent"].map(t => (
                    <span key={t} onClick={() => updateSource(src.id, { source_type:t })}
                      style={{ padding:"4px 10px", borderRadius:20, fontSize:12, cursor:"pointer", border:`1px solid ${src.source_type===t?"#1a1814":"rgba(0,0,0,.1)"}`, background:src.source_type===t?"#1a1814":"rgba(255,255,255,.6)", color:src.source_type===t?"#faf8f4":"#6b6760" }}>
                      {t}
                    </span>
                  ))}
                </div>
                <button onClick={()=>removeSource(src.id)} style={{ background:"none", border:"none", cursor:"pointer", color:"#a8a5a0", fontSize:16, padding:"0 4px" }}>×</button>
              </div>
              <input value={src.name||""} onChange={e=>updateSource(src.id, {name:e.target.value})} placeholder="Name — company, platform, client…"
                style={{ width:"100%", fontSize:13, padding:"7px 10px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", boxSizing:"border-box", marginBottom:8 }} />
              <label style={{ display:"flex", alignItems:"center", gap:5, cursor:"pointer", marginBottom:8 }}>
                <input type="checkbox" checked={src.work_from_home||false}
                  onChange={e => {
                    const wfh = e.target.checked;
                    const home = state.home || {};
                    updateSource(src.id, wfh
                      ? { work_from_home:true, work_place_id: home.place_id, work_address: home.address, work_lat: home.lat, work_lng: home.lng }
                      : { work_from_home:false });
                  }}
                  style={{ accentColor:"#1a1814" }} />
                <span style={{ ...S.sans, fontSize:11, color:"#6b6760" }}>Work from home</span>
              </label>
              {!src.work_from_home && (
                <div style={{ position:"relative" }}>
                  <input value={queries[src.id] ?? src.work_address ?? ""} onChange={e=>searchFor(src.id, e.target.value)} placeholder="Search workplace address (optional)…"
                    style={{ width:"100%", fontSize:13, padding:"7px 10px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", boxSizing:"border-box" }} />
                  {searching[src.id] && <span style={{ ...S.sans, position:"absolute", right:8, top:8, fontSize:11, color:"#a8a5a0" }}>…</span>}
                  {(results[src.id]||[]).length > 0 && (
                    <div style={{ position:"absolute", top:"calc(100% + 4px)", left:0, right:0, background:"#fff", border:"1px solid rgba(0,0,0,.1)", borderRadius:9, zIndex:20, overflow:"hidden", boxShadow:"0 4px 20px rgba(0,0,0,.1)" }}>
                      {results[src.id].map(p => (
                        <div key={p.place_id} onClick={() => pickPlace(src.id, p)} style={{ padding:"8px 10px", cursor:"pointer", fontSize:12 }}
                          onMouseEnter={e=>e.currentTarget.style.background="#f5f2ef"}
                          onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                          <div style={{ ...S.sans, color:"#1a1814" }}>{p.description}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Session 150 — nothing previously distinguished "typed
                      some text into the search box" from "resolved to a real
                      place". Only a work_place_id makes this a location the
                      simulator can actually put someone at; without one the
                      source deploys with a name and nowhere to be. */}
                  {src.work_place_id ? (
                    <div style={{ ...S.sans, fontSize:10.5, color:"#0f6e56", marginTop:4, lineHeight:1.4 }}>
                      ✓ {src.work_address || "matched"}
                      {src.work_lat != null && src.work_lng != null && (
                        <span style={{ ...S.mono, color:"#a8a5a0" }}> · {Number(src.work_lat).toFixed(5)}, {Number(src.work_lng).toFixed(5)}</span>
                      )}
                    </div>
                  ) : (
                    <div style={{ ...S.sans, fontSize:10.5, color:"#a8a5a0", marginTop:4 }}>
                      No location matched yet — pick one from the list to place {src.name ? src.name : "this source"} on the map.
                    </div>
                  )}
                </div>
              )}

              {/* Standing in THIS source's field.
                  Session 150 — the career-level pills were removed from here.
                  Career level was never independent data: ReputationEngine
                  derives it, promoting and demoting as reputation crosses a
                  threshold band. Offering both invited a contradiction the
                  engine would silently overrule — "junior" set by hand
                  alongside 90% reputation. Reputation is now the single input
                  and the level is computed from it, by the same bands the
                  engine uses, so the starting value already agrees with what
                  the world would work out for itself. */}
              <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid rgba(0,0,0,.06)" }}>
                <div>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                    <div style={{ ...S.label }}>Starting reputation</div>
                    <span style={{ ...S.mono, fontSize:11, color:"#6b6760" }}>{(((src.reputation_score ?? 0.5))*100).toFixed(0)}%</span>
                  </div>
                  <input type="range" min={0} max={1} step={0.01} value={src.reputation_score ?? 0.5}
                    onChange={e => updateSource(src.id, { reputation_score: parseFloat(e.target.value) })}
                    style={{ width:"100%", accentColor:"#1a1814" }} />
                  <div style={{ ...S.sans, fontSize:10, color:"#a8a5a0", marginTop:2 }}>Starting point — the world moves it from here</div>
                </div>
              </div>

              {/* Income — shaped by how THIS source actually pays.
                  Session 150 — feeds the simulator's existing ledger
                  (bank_accounts + financial_transactions). ScheduledPaymentProcess
                  reads these terms each tick and credits the actor on the right
                  day, so a figure entered here becomes money the character can
                  actually spend, and its absence means the source simply doesn't
                  pay — not that it pays zero. */}
              <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid rgba(0,0,0,.06)" }}>
                <div style={{ ...S.label, marginBottom:6 }}>{incomeLabel(src)}</div>

                {srcBasis(src) === "per_contract" ? (
                  /* A contract pays once, when the engagement completes. */
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                    <div>
                      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                        <input type="number" min={0} step={1000}
                          value={src.gross_amount ?? ""}
                          onChange={e => updateSource(src.id, { gross_amount: e.target.value === "" ? null : parseInt(e.target.value, 10) })}
                          placeholder="Total fee"
                          style={{ flex:1, minWidth:0, fontSize:13, padding:"7px 10px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", boxSizing:"border-box" }} />
                        <span style={{ ...S.mono, fontSize:12, color:"#6b6760", flexShrink:0 }}>{worldCurrency}</span>
                      </div>
                      <div style={{ ...S.sans, fontSize:10, color:"#a8a5a0", marginTop:2 }}>Paid in full on completion</div>
                    </div>
                    <div>
                      <input type="date"
                        value={src.ends_on ?? ""}
                        onChange={e => updateSource(src.id, { ends_on: e.target.value || null })}
                        style={{ width:"100%", fontSize:13, padding:"6px 10px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", boxSizing:"border-box" }} />
                      <div style={{ ...S.sans, fontSize:10, color:"#a8a5a0", marginTop:2 }}>Completion date</div>
                    </div>
                  </div>
                ) : (
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                    <div>
                      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                        <AmountInput
                          value={src.monthly_amount ?? ""}
                          onCommit={v => updateSource(src.id, { monthly_amount: v })}
                          placeholder={srcBasis(src) === "variable" ? "Typical month" : "Per month"}
                          style={{ flex:1, minWidth:0, fontSize:13, padding:"7px 10px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", boxSizing:"border-box" }} />
                        <span style={{ ...S.mono, fontSize:12, color:"#6b6760", flexShrink:0 }}>{worldCurrency}</span>
                      </div>
                      <div style={{ ...S.sans, fontSize:10, color:"#a8a5a0", marginTop:2 }}>
                        {src.source_type === "employment"
                          ? (srcBasis(src) === "variable" ? "Before tax — what a normal month brings in" : "Before tax — same figure every month")
                          : (srcBasis(src) === "variable" ? "What a normal month brings in" : "Same figure every month")}
                      </div>
                    </div>
                    {srcBasis(src) === "variable" ? (
                      /* Independent income moves with demand — a fixed monthly
                         figure would make it indistinguishable from a salary. */
                      <div>
                        <div style={{ display:"flex", justifyContent:"space-between" }}>
                          <span style={{ ...S.sans, fontSize:11, color:"#6b6760" }}>Swing</span>
                          <span style={{ ...S.mono, fontSize:11, color:"#6b6760" }}>±{Math.round((src.variability ?? 0.25)*100)}%</span>
                        </div>
                        <input type="range" min={0} max={1} step={0.05}
                          value={src.variability ?? 0.25}
                          onChange={e => updateSource(src.id, { variability: parseFloat(e.target.value) })}
                          style={{ width:"100%", accentColor:"#1a1814" }} />
                        <div style={{ ...S.sans, fontSize:10, color:"#a8a5a0", marginTop:2 }}>
                          {src.monthly_amount
                            ? `Ranges ${Math.round(src.monthly_amount * (1 - (src.variability ?? 0.25)))}–${Math.round(src.monthly_amount * (1 + (src.variability ?? 0.25)))}`
                            : "How much month to month varies"}
                        </div>
                      </div>
                    ) : (
                      <div>
                        <input type="number" min={1} max={28}
                          value={srcPayDay(src) ?? ""}
                          onChange={e => updateSource(src.id, { pay_day: Math.max(1, Math.min(28, parseInt(e.target.value, 10) || 25)) })}
                          style={{ width:"100%", fontSize:13, padding:"7px 10px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", boxSizing:"border-box" }} />
                        <div style={{ ...S.sans, fontSize:10, color:"#a8a5a0", marginTop:2 }}>Pay day — capped at 28 so it lands every month</div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Work days for THIS source */}
              <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid rgba(0,0,0,.06)" }}>
                <div style={{ ...S.label, marginBottom:6 }}>Work days</div>
                <div style={{ display:"flex", gap:4 }}>
                  {WEEK.map((w, i) => {
                    const on = daysOf(src).includes(w.key);
                    return (
                      <span key={w.key} onClick={() => toggleDay(src, w.key)} title={w.key}
                        style={{ width:26, height:26, borderRadius:"50%", display:"inline-flex", alignItems:"center", justifyContent:"center",
                          fontSize:11, cursor:"pointer", userSelect:"none",
                          border:`1px solid ${on ? "#1a1814" : "rgba(0,0,0,.12)"}`,
                          background: on ? "#1a1814" : "rgba(255,255,255,.6)",
                          color: on ? "#faf8f4" : (i >= 5 ? "#c8c5c0" : "#6b6760") }}>
                        {w.short}
                      </span>
                    );
                  })}
                </div>
                {daysOf(src).length === 0 && (
                  <div style={{ ...S.sans, fontSize:10, color:"#b05c08", marginTop:3 }}>No days selected — this source will never be worked.</div>
                )}

                <div style={{ marginTop:10, display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{ ...S.label, whiteSpace:"nowrap" }}>Paid leave</div>
                  <input type="number" min={0} max={365}
                    value={leaveDaysOf(src)}
                    onChange={e => updateSource(src.id, { leave_days_per_year: e.target.value === "" ? null : Math.max(0, Math.min(365, parseInt(e.target.value, 10) || 0)) })}
                    style={{ width:64, fontSize:13, padding:"5px 8px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)" }} />
                  <span style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>
                    days/year — what this job grants. Taking it is {actor?.first_name || "her"} decision, made in the world.
                  </span>
                </div>
              </div>

              {/* Work hours for THIS source */}
              <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid rgba(0,0,0,.06)" }}>
                <div style={{ ...S.label, marginBottom:6 }}>Work hours</div>
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {blocksOf(src).map((wb, i) => (
                    <div key={i} style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <input type="time" value={wb.start}
                        onChange={e => updateBlock(src, i, { start: e.target.value })}
                        style={{ fontSize:12, padding:"5px 8px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)" }} />
                      <span style={{ ...S.sans, fontSize:12, color:"#a8a5a0" }}>to</span>
                      <input type="time" value={wb.end}
                        onChange={e => updateBlock(src, i, { end: e.target.value })}
                        style={{ fontSize:12, padding:"5px 8px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)" }} />
                      {wb.start >= wb.end && (
                        <span style={{ ...S.sans, fontSize:11, color:"#b05c08" }}>end must be after start</span>
                      )}
                      {blocksOf(src).length > 1 && (
                        <button onClick={() => removeBlock(src, i)} style={{ background:"none", border:"none", cursor:"pointer", color:"#a8a5a0", fontSize:16, padding:"0 4px" }}>×</button>
                      )}
                    </div>
                  ))}
                  <button onClick={() => addBlock(src)} style={{ ...S.sans, fontSize:11, padding:"5px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer", alignSelf:"flex-start" }}>
                    + Add work block
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
        <button onClick={addSource} style={{ ...S.sans, fontSize:11, padding:"5px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer", marginTop:10 }}>
          + Add revenue source
        </button>
      </div>

      {/* ── Fixed expenses ────────────────────────────────────────────────────
          Session 150 — what leaves her account each month.

          ScheduledPaymentProcess has debited these on their debit_day since it
          was written, and FinancialEngine divides balance by their monthly total
          to get financial_runway_months. Nothing had ever created a row, so
          every character deployed until now had income and no outgoings: a
          balance that only grew, and a runway that fell through to its
          "else 99.0" branch because the sum was always zero.

          The starter set below is a suggestion, not a default — it is only
          applied when you press it, and every line is editable or removable.
          Rent is scaled off her income rather than fixed, since a number that is
          right for an 80k lawyer is absurd for a 20k barista. */}
      <div style={{ marginTop:20 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
          <div style={{ ...S.label }}>Fixed expenses</div>
          <div style={{ display:"flex", gap:6 }}>
            {(state.career?.fixed_expenses || []).length === 0 && monthlyTotal > 0 && (
              <span onClick={() => setState(p => ({...p, career: {...(p.career||{}), fixed_expenses: suggestExpenses(monthlyTotal)}}))}
                style={{ ...S.sans, fontSize:11, padding:"4px 10px", borderRadius:20, cursor:"pointer",
                  border:"1px solid rgba(0,0,0,.12)", background:"rgba(255,255,255,.6)", color:"#6b6760" }}>
                ✨ Suggest
              </span>
            )}
            <span onClick={() => setState(p => ({...p, career: {...(p.career||{}),
                fixed_expenses: [...(p.career?.fixed_expenses || []), { name:"", category:"other", amount:0, cadence:"monthly", debit_day:1 }]}}))}
              style={{ ...S.sans, fontSize:11, padding:"4px 10px", borderRadius:20, cursor:"pointer",
                border:"1px solid rgba(0,0,0,.12)", background:"rgba(255,255,255,.6)", color:"#6b6760" }}>
              + Add
            </span>
          </div>
        </div>

        {(state.career?.fixed_expenses || []).length === 0 && (
          <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>
            Nothing leaves her account. Her balance will only ever grow, and financial runway can't be computed.
          </div>
        )}

        {(state.career?.fixed_expenses || []).map((exp, i) => {
          const upd = patch => setState(p => ({...p, career: {...(p.career||{}),
            fixed_expenses: (p.career?.fixed_expenses || []).map((x, j) => j === i ? { ...x, ...patch } : x)}}));
          const drop = () => setState(p => ({...p, career: {...(p.career||{}),
            fixed_expenses: (p.career?.fixed_expenses || []).filter((_, j) => j !== i)}}));
          return (
            <div key={i} style={{ display:"grid", gridTemplateColumns:"1.5fr 1fr 1fr .9fr .8fr auto", gap:6, alignItems:"center", marginBottom:6 }}>
              <input value={exp.name || ""} onChange={e => upd({ name: e.target.value })} placeholder="Rent"
                style={{ ...S.sans, fontSize:12, padding:"6px 9px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", minWidth:0 }} />
              <select value={exp.category || "other"} onChange={e => upd({ category: e.target.value })}
                style={{ ...S.sans, fontSize:12, padding:"6px 9px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", minWidth:0 }}>
                {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <AmountInput value={exp.amount ?? 0} onCommit={v => upd({ amount: Math.max(0, v || 0) })}
                style={{ ...S.mono, fontSize:12, padding:"6px 9px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", minWidth:0 }} />
              <select value={exp.cadence || "monthly"} onChange={e => upd({ cadence: e.target.value })}
                style={{ ...S.sans, fontSize:12, padding:"6px 9px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", minWidth:0 }}>
                {EXPENSE_CADENCES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <input type="number" min={1} max={28} value={exp.debit_day ?? 1} onChange={e => upd({ debit_day: Math.min(28, Math.max(1, parseInt(e.target.value, 10) || 1)) })}
                title="Day of the month it is charged"
                style={{ ...S.mono, fontSize:12, padding:"6px 9px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", minWidth:0 }} />
              <span onClick={drop} title="Remove" style={{ ...S.sans, fontSize:13, color:"#c0392b", cursor:"pointer", padding:"0 4px" }}>✕</span>
            </div>
          );
        })}

        {(state.career?.fixed_expenses || []).length > 0 && (
          <div style={{ ...S.sans, fontSize:10, color:"#a8a5a0", marginTop:4 }}>
            {(() => {
              const per = { monthly: 1, quarterly: 1/3, annual: 1/12 };
              const m = (state.career?.fixed_expenses || [])
                .reduce((t, e) => t + (Number(e.amount) || 0) * (per[e.cadence || "monthly"] || 1), 0);
              // Session 150 — subtract from TAKE-HOME, not gross.
              //
              // This line used to read `monthlyTotal - m`, which measured her
              // expenses against money she never receives. With 80.000 gross,
              // 37.200 of costs and 39,2% Swedish tax it reported +42.800 when
              // the real figure is +11.450 — overstating her monthly margin
              // almost fourfold, on the exact number someone would use to judge
              // whether the rent is plausible.
              const spendable = netTotal;
              const net = spendable - m;
              return `${fmtAmount(m)} ${worldCurrency}/month out` +
                (spendable > 0
                  ? ` · ${fmtSigned(net)} ${worldCurrency} left${net < 0 ? " — she loses money every month" : ""}`
                  : "");
            })()}
          </div>
        )}
      </div>

      {/* Opening balance — per ACTOR, not per source, so it sits outside the
          sources list. Session 150: deploy now creates a bank_accounts row, and
          it opened at zero. That is not neutral — rent debits on the 1st while
          salary credits on the 25th, so a character starting at zero goes
          overdrawn before her first payday, and financial_anxiety recomputes
          from live balance, which makes it real stress rather than a rounding
          detail. What she has in the bank on day one is a fact about the
          character, so it is set here rather than guessed at. */}
      {/* Session 150 — take-home, stated plainly. Every judgement made further
          down this step — whether the rent is plausible, whether the opening
          balance covers a month — is a judgement against this number, not
          against the gross figure above. */}
      {tax && tax.monthly_tax > 0 && (
        <div style={{ marginTop:14, padding:"10px 12px", background:"rgba(0,0,0,.025)",
          border:"1px solid rgba(0,0,0,.06)", borderRadius:10, display:"flex",
          alignItems:"baseline", gap:10, flexWrap:"wrap" }}>
          <span style={{ ...S.mono, fontSize:14, color:"#1a1814" }}>
            {fmtAmount(tax.net_monthly)} {worldCurrency}
          </span>
          <span style={{ ...S.sans, fontSize:11.5, color:"#6b6760" }}>
            take-home, after {(tax.effective_rate * 100).toFixed(1).replace(".", ",")}% tax
            {tax.country ? ` in ${tax.country}` : ""}
            {tax.known === false ? " (estimated — no rates on file for this country)" : ""}
          </span>
        </div>
      )}

      <div style={{ marginTop:20 }}>
        <div style={{ ...S.label, marginBottom:6 }}>Opening balance</div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <AmountInput
            value={state.career?.opening_balance ?? ""}
            onCommit={v => setState(p => ({...p, career: {...(p.career||{}), opening_balance: v == null ? null : Math.max(0, v)}}))}
            placeholder="0"
            style={{ width:160, fontSize:13, padding:"7px 10px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)" }} />
          <span style={{ ...S.mono, fontSize:12, color:"#6b6760" }}>{worldCurrency}</span>
          {monthlyTotal > 0 && (
            <div style={{ display:"flex", gap:5 }}>
              {[1, 3, 6].map(m => (
                <span key={m} onClick={() => setState(p => ({...p, career: {...(p.career||{}), opening_balance: Math.round(netTotal * m)}}))}
                  style={{ ...S.sans, fontSize:11, padding:"4px 9px", borderRadius:20, cursor:"pointer",
                    border:"1px solid rgba(0,0,0,.12)", background:"rgba(255,255,255,.6)", color:"#6b6760" }}>
                  {m} mo
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{ ...S.sans, fontSize:10, color:"#a8a5a0", marginTop:3 }}>
          {monthlyTotal > 0
            ? `What she has in the bank on day one. ${fmtAmount(netTotal)} ${worldCurrency}/month take-home — the shortcuts set that many months of runway.`
            : "What she has in the bank on day one. Rent is debited before the first salary lands, so zero means starting overdrawn."}
        </div>
      </div>
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
  const [selTypes,    setSelTypes]    = useState([]);
  // Session 149 — was single shared description/context/scores across
  // the whole batch being added, so "Professional: competitor" and
  // "Social: acquaintance" for the same person got identical text even
  // though actor_relationships stores description/context/scores per
  // ROW, one per dimension. Keyed by type id so each selected dimension
  // gets its own actual data, matching what's actually stored.
  const [perTypeData, setPerTypeData] = useState({});
  const [inspiring,   setInspiring]   = useState(false);
  const [suggestingRel, setSuggestingRel] = useState(false);
  const [editingIdx,  setEditingIdx]  = useState(null);
  const [error,       setError]       = useState("");
  // Session 150 — kept separate from `error` (which is form-validation
  // feedback, cleared on every add). This one describes the step being
  // unable to trust its own data and has to survive until reload.
  const [rosterError, setRosterError] = useState("");
  // Session 149 — removed the custom-type "+Add" state entirely. Any
  // type added that way lived only in this component's React state,
  // never in the relationship_types table — selecting and deploying it
  // would write a rel_type_id pointing at a row that doesn't exist
  // anywhere, and RelationshipEngine's joins against relationship_types
  // would silently find nothing for it. No safe handling existed for
  // that path, so removing the ability to create it rather than leave
  // a trap that looks like it works.

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
  // "none" means no real connection in that dimension — sharing the same
  // mid-range defaults as an actual relationship type (e.g. legal's
  // 0.50 warmth, same as domestic_partner would start at) implied more
  // closeness than "no relationship" should. Low across the board,
  // zero tension/attraction/pull — there's nothing here to have
  // friction or draw in.
  const NONE_SCORES = { warmth:0.15, trust:0.15, respect:0.20, tension:0.0, attraction:0.0, pull:0.05 };
  function scoresFor(t) { return t.name === "none" ? NONE_SCORES : (defaultScores[t.dimension_id] || defaultScores["dim-social"]); }
  const dimOrder = ["dim-legal","dim-family","dim-professional","dim-social","dim-intimate"];
  // Session 149 — the one relationship-type combination that's always
  // nonsensical regardless of how dark/complex the fiction gets: a
  // current-or-former spouse cannot also be a parent/child/grandparent
  // to the same person. Deliberately narrow — this platform models
  // plenty of other complicated, uncomfortable, or taboo dynamics on
  // purpose (see "entanglement", "on-off fuck friend" already in the
  // taxonomy), so nothing broader than this one biologically/logically
  // absolute pair gets blocked.
  const MARITAL_LEGAL = new Set(["spouse","ex_spouse","ex_husband","ex_wife","domestic_partner","engaged"]);
  const GENERATIONAL_FAMILY = new Set(["child","parent","grandparent"]);
  // "entanglement" and custom intimate types deliberately excluded —
  // those imply something undefined/casual, not real commitment, so
  // they don't carry the "should be close socially too" expectation.
  const INTIMATE_COMMITTED = new Set(["partner","exclusive","lover","open_relationship"]);
  // Session 149 — was just acquaintance/casual_friend (merely distant).
  // Missed the actively-adversarial branch entirely (frenemy/rival/cold/
  // distant/hostile/estranged) — same problem, just a wider one: none of
  // these fit alongside a committed intimate connection either, matching
  // the deterioration branch RelationshipEngine's own @rel_adjacency
  // models (acquaintance -> cold -> distant/hostile -> estranged,
  // frenemy -> rival/hostile). Not exhaustive forever, but covers the
  // real adversarial/distant spectrum now instead of one narrow slice.
  const SOCIAL_DISTANT = new Set(["acquaintance","casual_friend","cold","distant","hostile","estranged","frenemy","rival"]);
  const SCORE_FIELDS = [["warmth","Warmth"],["trust","Trust"],["respect","Respect"],["tension","Tension"],["attraction","Attraction"],["pull","Pull"]];

  useEffect(() => {
    if (!state.world) return;
    let cancelled = false;
    setRosterError("");
    setState(p => ({...p, worldRosterLoaded: false}));

    // Session 150 — these were two independent fetches, each mapping a
    // non-ok response to `[]` and each swallowing network failure in a
    // bare .catch. Either way the parent's missingRelationships() saw an
    // empty roster, concluded nobody needed covering, and let Next
    // through — a failed load was indistinguishable from a genuinely
    // empty world, so the gate silently didn't run at exactly the moment
    // it mattered. Now the roster only counts as loaded when both calls
    // actually succeed, and the failure is shown rather than absorbed.
    Promise.all([
      fetch(`/api/worlds/${state.world.id}/actors`).then(r => { if (!r.ok) throw new Error(`actors ${r.status}`); return r.json(); }),
      fetch(`/api/worlds/${state.world.id}/members`).then(r => { if (!r.ok) throw new Error(`members ${r.status}`); return r.json(); }),
    ]).then(([chars, members]) => {
      if (cancelled) return;
      const filtered = (Array.isArray(chars) ? chars : []).filter(c => c.id !== actor?.id);
      const arr = Array.isArray(members) ? members : [];
      setCharacters(filtered);
      setUsers(arr);
      setState(p => ({...p, worldCharacters: filtered, worldUsers: arr, worldRosterLoaded: true}));
    }).catch(e => {
      if (cancelled) return;
      setRosterError(`Couldn't load who's already in this world (${e.message}) — relationships can't be checked against the real cast. Fix the connection and reopen this step before deploying.`);
      setState(p => ({...p, worldRosterLoaded: false}));
    });

    fetch(`/api/relationship-types`).then(r=>r.ok?r.json():null).then(data=>{
      if (!Array.isArray(data)) return;
      // Session 149 — was filtering by id PREFIX ("rt-"/"custom-"),
      // which silently dropped any legitimately-seeded type whose id
      // happened to be a raw hash instead of that convention (confirmed
      // live: cold/distant/estranged/frenemy/hostile/rival all real,
      // real names, real dimension_id — just excluded by this check).
      // The actual requirement is just that the row is well-formed
      // enough to render and be selected, not what shape its id is.
      setRelTypes(data.filter(t => t.id && t.name && t.dimension_id));
    }).catch(()=>{});

    return () => { cancelled = true; };
  }, [state.world]);

  const grouped = relTypes.reduce((acc,t)=>{ (acc[t.dimension_id]||(acc[t.dimension_id]=[])).push(t); return acc; }, {});
  const initials = name => (name||"").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();

  function selectType(t) {
    // Session 149 — was a single global selType, so selecting a pill in
    // a different dimension silently dropped whatever was selected
    // before it. Confirmed as a real bug, not intended behavior: several
    // dimensions should be selectable together and added as one batch,
    // sharing the same description/context/scores. Still exclusive
    // WITHIN a dimension — can't be both sibling and parent to the same
    // person at once — but selecting a new dimension no longer clears
    // any other dimension's selection.
    setSelTypes(prev => {
      if (prev.some(st => st.id === t.id)) {
        setPerTypeData(pd => { const next = {...pd}; delete next[t.id]; return next; });
        return prev.filter(st => st.id !== t.id);
      }
      const dimName = dimConfig[t.dimension_id]?.label?.toLowerCase() || t.dimension_id.replace("dim-","");
      const replaced = prev.find(st => st.dimension_id === t.dimension_id);
      const withoutSameDim = prev.filter(st => st.dimension_id !== t.dimension_id);
      setPerTypeData(pd => {
        const next = {...pd};
        if (replaced) delete next[replaced.id];
        next[t.id] = next[t.id] || { description:"", context:"", scores: scoresFor(t) };
        return next;
      });
      return [...withoutSameDim, {...t, dimension_name: dimName}];
    });
  }

  async function suggestRelationship() {
    if (!picked) return;
    setSuggestingRel(true); setError("");
    try {
      const dimensionsPayload = {};
      dimOrder.forEach(dim => {
        const names = (grouped[dim]||[]).map(t => t.name);
        if (names.length > 0) dimensionsPayload[dim] = names;
      });
      const r = await fetch(`/api/actors/${actor.id}/suggest-relationship`, {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          target_name: picked.first_name || picked.name,
          target_occupation: picked._isUser ? null : picked.occupation,
          target_is_user: !!picked._isUser,
          cv_notes: state.cv?.notes || null,
          dimensions: dimensionsPayload,
        })
      });
      if (r.ok) {
        const data = await r.json();
        const resolved = [];
        for (const dim of dimOrder) {
          const suggestedName = data[dim];
          if (!suggestedName) continue;
          const allTypes = (grouped[dim]||[]);
          const match = allTypes.find(t => t.name === suggestedName);
          if (match) {
            const dimName = dimConfig[dim]?.label?.toLowerCase() || dim.replace("dim-","");
            resolved.push({...match, dimension_name: dimName});
          }
        }
        if (resolved.length > 0) {
          setSelTypes(resolved);
          const initData = {};
          resolved.forEach(t => {
            initData[t.id] = { description:"", context:"", scores: scoresFor(t) };
          });
          setPerTypeData(initData);
        } else {
          setError("Suggestion didn't match any known types — try again.");
        }
      } else {
        setError("Suggestion failed — try again.");
      }
    } catch (e) {
      setError(e.message);
    }
    setSuggestingRel(false);
  }

  async function inspire(typeId) {
    const target = selTypes.find(st => st.id === typeId);
    if (!picked || !target) return;
    setInspiring(typeId);
    try {
      const r = await fetch(`/api/actors/${actor.id}/inspire-relationship`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          rel_type_id:   target.id,
          rel_type_name: target.name,
          dimension_name: target.dimension_name,
          target_type:   picked._isUser ? "user" : "actor",
          target_id:     picked.id,
        })
      });
      if (r.ok) {
        const data = await r.json();
        setPerTypeData(pd => ({...pd, [typeId]: {
          description: data.description || pd[typeId]?.description || "",
          context: data.context || pd[typeId]?.context || "",
          scores: data.scores ? {...(pd[typeId]?.scores||{}), ...data.scores} : (pd[typeId]?.scores || {}),
        }}));
      }
    } catch {}
    setInspiring(false);
  }

  // Session 149 — this used to reset `picked` too, meaning every
  // successful add wiped the selected target along with the type/scores.
  // Adding a second relationship dimension to the SAME person (the
  // obvious next action, not an edge case) required re-picking them
  // first — "+ Add relationship" stays disabled with no target selected,
  // so subsequent adds silently did nothing until that happened. Keeping
  // the target selected lets several dimensions get added to one person
  // in a row, which is what "add relationship" actually means here.
  function clearForm() { setSelTypes([]); setPerTypeData({}); setEditingIdx(null); }

  function addOrUpdate() {
    if (!picked || selTypes.length === 0) return;
    setError("");
    // Session 149 — narrower than the earlier version, which blocked
    // even a single standalone "none" (e.g. just "Professional: none"
    // alone) and caused real friction. A partial set is fine. The only
    // genuinely meaningless case is all five dimensions recorded AND
    // every one of them "none" — that's identical to no relationship
    // existing at all, and is the one thing worth blocking, clearly.
    const ALL_DIMS = ["dim-family","dim-professional","dim-social","dim-intimate","dim-legal"];

    if (editingIdx !== null) {
      // Editing an existing single entry — selTypes holds exactly the
      // one type being edited (set by editRel below).
      const t = selTypes[0];
      if (!t) return;
      const others = (state.relationships||[]).filter((r, i) => r.character.id === picked.id && i !== editingIdx);
      const withNew = [...others, { dimension_id: t.dimension_id, rel_type_name: t.name }];
      if (t.name === "none") {
        const coversAllDims = ALL_DIMS.every(d => withNew.some(r => r.dimension_id === d));
        const allNone = withNew.every(r => r.rel_type_name === "none");
        if (coversAllDims && allNone) {
          setError("Every dimension can't be \"none\" — that's the same as having no relationship with this person at all.");
          return;
        }
      }
      const data = perTypeData[t.id] || { description:"", context:"", scores: scoresFor(t) };
      const rel = { character:picked, rel_type_id:t.id, rel_type_name:t.name, dimension_id:t.dimension_id, dimension_name:t.dimension_name, description: data.description, context: data.context, scores:{...data.scores} };
      setState(p => { const r=[...(p.relationships||[])]; r[editingIdx]=rel; return {...p,relationships:r}; });
      clearForm();
      return;
    }

    // Adding fresh — one entry per selected dimension, each pulling its
    // own description/context/scores from perTypeData.
    const others = (state.relationships||[]).filter(r => r.character.id === picked.id);
    const withNew = [...others, ...selTypes.map(t => ({ dimension_id: t.dimension_id, rel_type_name: t.name }))];
    const coversAllDims = ALL_DIMS.every(d => withNew.some(r => r.dimension_id === d));
    const allNone = withNew.every(r => r.rel_type_name === "none");
    if (coversAllDims && allNone) {
      setError("Every dimension can't be \"none\" — that's the same as having no relationship with this person at all.");
      return;
    }

    const newRels = selTypes.map(t => {
      const data = perTypeData[t.id] || { description:"", context:"", scores: scoresFor(t) };
      return { character:picked, rel_type_id:t.id, rel_type_name:t.name, dimension_id:t.dimension_id, dimension_name:t.dimension_name, description: data.description, context: data.context, scores:{...data.scores} };
    });
    setState(p => ({...p, relationships:[...(p.relationships||[]), ...newRels]}));
    clearForm();
  }

  function removeRel(i) {
    setState(p => ({...p, relationships:(p.relationships||[]).filter((_,j)=>j!==i)}));
    if (editingIdx===i) clearForm();
  }

  function editRel(i) {
    const rel = (state.relationships||[])[i];
    setPicked(rel.character);
    const t = { id:rel.rel_type_id, name:rel.rel_type_name, dimension_id:rel.dimension_id, dimension_name:rel.dimension_name };
    setSelTypes([t]);
    setPerTypeData({ [t.id]: {
      description: rel.description||"",
      context: rel.context||"",
      scores: rel.scores || scoresFor(t),
    }});
    setEditingIdx(i);
  }

  const canAdd  = picked && selTypes.length > 0;

  const missing = [...characters, ...users.map(u => ({...u, _isUser:true}))]
    .filter(p => !(state.relationships||[]).some(r => r.character.id === p.id));

  return (
    <div>
      <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0", marginBottom:16 }}>Define who {actor?.first_name||actor?.name} already knows</p>
      {rosterError && (
        <p style={{ ...S.sans, fontSize:12, color:"#c0392b", marginTop:-10, marginBottom:16, lineHeight:1.5 }}>{rosterError}</p>
      )}
      {missing.length > 0 && (
        <p style={{ ...S.sans, fontSize:12, color:"#b05c08", marginTop:-10, marginBottom:16 }}>
          Still need a relationship for: {missing.map(p => p.first_name||p.name).join(", ")}
        </p>
      )}

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
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
        <div style={{ ...S.label }}>Relationship type</div>
        <button onClick={suggestRelationship} disabled={!picked || suggestingRel} style={{ ...S.sans, fontSize:11, padding:"3px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color: !picked ? "#c8c5c0" : "#6b6760", cursor:(!picked||suggestingRel)?"default":"pointer", opacity:suggestingRel?0.5:1 }}>
          {suggestingRel ? "Thinking…" : "✨ Suggest"}
        </button>
      </div>
      {!picked ? (
        <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0" }}>Pick a character or user above first.</p>
      ) : (
      <>
      {relTypes.length === 0 && <p style={{ ...S.sans, fontSize:12, color:"#a8a5a0", marginBottom:12 }}>Loading…</p>}
      {(() => {
        // Session 149 — pills only ever reflected selType, the single
        // in-progress selection. Once a relationship was added and the
        // form cleared, its pill reverted to plain default with zero
        // trace it had been added — looked like clicking a pill "didn't
        // stick" when moving to another dimension, even though the add
        // itself had genuinely succeeded. This tracks which types are
        // already saved for whichever person is currently picked, kept
        // separate from selType's own highlight (which still means
        // "currently being edited/previewed", not "already added").
        const addedTypeIds = new Set(
          (state.relationships||[]).filter(r => picked && r.character.id === picked.id).map(r => r.rel_type_id)
        );
        const addedTypeNames = new Set(
          (state.relationships||[]).filter(r => picked && r.character.id === picked.id).map(r => r.rel_type_name)
        );
        // Session 149 — these used to only check already-saved entries,
        // never the batch currently mid-selection. Barely mattered
        // before multi-select existed (only one thing could ever be
        // "in progress" at once); now that several dimensions can be
        // selected together before a single Add, checking only saved
        // entries misses the exact same-batch case this exists to
        // catch — e.g. Intimate:partner and Social:acquaintance picked
        // together, neither saved yet. Combine both scopes.
        const activeTypeNames = new Set([...addedTypeNames, ...selTypes.map(st => st.name)]);
        const hasMarital = [...activeTypeNames].some(n => MARITAL_LEGAL.has(n));
        const hasGenerational = [...activeTypeNames].some(n => GENERATIONAL_FAMILY.has(n));
        // Committed intimate types imply real closeness — pairing one
        // with a distant social pick reads backwards (a real "partner"
        // isn't merely a social "acquaintance"). Casual/undefined
        // intimate types (entanglement, custom ones) don't carry this.
        const hasCommittedIntimate = [...activeTypeNames].some(n => INTIMATE_COMMITTED.has(n));
        const hasDistantSocial = [...activeTypeNames].some(n => SOCIAL_DISTANT.has(n));
        return dimOrder.map(dim => {
        const cfg = dimConfig[dim];
        const allTypes = (grouped[dim]||[]).slice().sort((a,b) => (a.name==="none"?-1:0) - (b.name==="none"?-1:0));
        if (allTypes.length === 0 && relTypes.length > 0) return null;
        const selectedInDim = selTypes.find(st => st.dimension_id === dim);
        return (
          <div key={dim} style={{ marginBottom:16, padding:"12px 14px", background:cfg.bg, borderRadius:12, border:`1px solid ${cfg.border}` }}>
            <div style={{ ...S.label, color:cfg.color, marginBottom:5 }}>{cfg.label}</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginBottom:6 }}>
              {allTypes.map(t => {
                const sel = selTypes.some(st => st.id === t.id);
                const added = !sel && addedTypeIds.has(t.id);
                const blocked = !added && !sel && (
                  (MARITAL_LEGAL.has(t.name) && hasGenerational) || (GENERATIONAL_FAMILY.has(t.name) && hasMarital) ||
                  (SOCIAL_DISTANT.has(t.name) && t.dimension_id === "dim-social" && hasCommittedIntimate) ||
                  (INTIMATE_COMMITTED.has(t.name) && t.dimension_id === "dim-intimate" && hasDistantSocial)
                );
                const blockReason = (MARITAL_LEGAL.has(t.name) && hasGenerational) || (GENERATIONAL_FAMILY.has(t.name) && hasMarital)
                  ? "Already has a spouse/parent-child relationship set with this person — the two can't coexist"
                  : ((SOCIAL_DISTANT.has(t.name) && t.dimension_id === "dim-social" && hasCommittedIntimate) || (INTIMATE_COMMITTED.has(t.name) && t.dimension_id === "dim-intimate" && hasDistantSocial))
                  ? "A committed intimate relationship (partner/exclusive/lover/open relationship) doesn't fit with a distant or adversarial social dynamic — the two can't coexist"
                  : undefined;
                return <span key={t.id} onClick={() => { if (!blocked) selectType(t); }}
                  title={blockReason}
                  style={{ padding:"4px 10px", borderRadius:20, fontSize:12, cursor:blocked?"not-allowed":"pointer", display:"inline-flex", alignItems:"center", gap:4,
                    border:`1px solid ${sel?cfg.selBg:added?cfg.color:"rgba(255,255,255,.6)"}`,
                    background:sel?cfg.selBg:added?"rgba(255,255,255,.6)":"rgba(255,255,255,.5)",
                    color:sel?cfg.selColor:cfg.color,
                    opacity: blocked ? 0.35 : (added ? 1 : (sel ? 1 : 0.85)),
                    textDecoration: blocked ? "line-through" : "none",
                    boxShadow: added ? `inset 0 0 0 1px ${cfg.color}` : "none" }}>
                  {added && <span style={{ fontSize:10 }}>✓</span>}
                  {t.name.replace(/_/g," ")}
                </span>;
              })}
            </div>
            {selectedInDim && selectedInDim.name !== "none" && (() => {
              const t = selectedInDim;
              const data = perTypeData[t.id] || { description:"", context:"", scores: scoresFor(t) };
              return (
                <div style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${cfg.border}` }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                    <div style={{ ...S.label, color:cfg.color }}>{t.name.replace(/_/g," ")}</div>
                    {t.name !== "none" && (
                      <button onClick={()=>inspire(t.id)} disabled={inspiring===t.id} style={{ ...S.sans, fontSize:11, padding:"3px 10px", borderRadius:7, border:`1px solid ${cfg.border}`, background:"none", color:cfg.color, cursor:inspiring===t.id?"default":"pointer", opacity:inspiring===t.id?0.5:1 }}>
                        {inspiring===t.id ? "Thinking…" : "✨ Inspire me"}
                      </button>
                    )}
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px 20px", marginBottom:12 }}>
                    {SCORE_FIELDS.map(([key,label]) => (
                      <div key={key}>
                        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                          <span style={{ ...S.sans, fontSize:11, color:"#6b6760" }}>{label}</span>
                          <span style={{ ...S.mono, fontSize:11, color:cfg.color }}>{(data.scores[key]||0).toFixed(2)}</span>
                        </div>
                        <input type="range" min={0} max={1} step={0.01} value={data.scores[key]||0}
                          onChange={e => { const v = parseFloat(e.target.value); setPerTypeData(pd => ({...pd, [t.id]: {...data, scores:{...data.scores, [key]:v}}})); }}
                          style={{ width:"100%", accentColor:cfg.selBg }} />
                      </div>
                    ))}
                  </div>
                  <div style={{ ...S.label, marginBottom:6, color:cfg.color }}>Describe the relationship</div>
                  <textarea value={data.description} onChange={e => setPerTypeData(pd => ({...pd, [t.id]: {...data, description:e.target.value}}))} placeholder="Backstory — how this relationship came to be…" style={{ width:"100%", minHeight:56, fontSize:13, padding:"8px 10px", borderRadius:10, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", resize:"vertical", boxSizing:"border-box", marginBottom:8 }} />
                  <div style={{ ...S.label, marginBottom:6, color:cfg.color }}>Current dynamic</div>
                  <textarea value={data.context} onChange={e => setPerTypeData(pd => ({...pd, [t.id]: {...data, context:e.target.value}}))} placeholder="Context — what is happening between them right now…" style={{ width:"100%", minHeight:48, fontSize:13, padding:"8px 10px", borderRadius:10, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", resize:"vertical", boxSizing:"border-box" }} />
                </div>
              );
            })()}
          </div>
        );
        });
      })()}
      </>
      )}

      {picked && !canAdd && (
        <p style={{ ...S.sans, fontSize:12, color:"#c8c5c0", marginBottom:14 }}>Pick a relationship type above first</p>
      )}

      <button onClick={addOrUpdate} disabled={!canAdd} style={{ ...S.sans, fontSize:12, padding:"6px 14px", borderRadius:8, border:"1px solid rgba(0,0,0,.12)", background:canAdd?"#1a1814":"none", color:canAdd?"#faf8f4":"#c8c5c0", cursor:canAdd?"pointer":"default", marginBottom:16 }}>
        {editingIdx !== null ? "Update relationship" : selTypes.length > 1 ? `+ Add ${selTypes.length} relationships` : "+ Add relationship"}
      </button>
      {error && <p style={{ ...S.sans, fontSize:12, color:"#c0392b", marginTop:-10, marginBottom:16 }}>{error}</p>}

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
  // Session 150 — in the last days of December this expression lands on
  // 53, and the dropdown below builds `52 - currentWeek + 1` options,
  // i.e. zero: no week selectable at all, so a schedule generated then
  // could never be rolled out. Clamped so the final week is always
  // pickable. The week arithmetic itself is left as-is — it's an
  // approximation, but the roll-out semantics ("from week N through 52")
  // don't change.
  const rawWeek = Math.ceil((new Date() - new Date(new Date().getFullYear(),0,1)) / 604800000);
  const currentWeek = Math.min(Math.max(rawWeek, 1), 52);
  // Session 150 — was unconditionally `useState(currentWeek)`, which
  // overwrote a restored draft's saved week the moment this step
  // remounted. Honour the persisted value when it's still reachable.
  const [fromWeek,   setFromWeek]    = useState(() => {
    const saved = Number(state.fromWeek);
    return Number.isFinite(saved) && saved >= currentWeek && saved <= 52 ? saved : currentWeek;
  });

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
    // Session 150 — was bg #FEF9EC with border #F59E0B: a paler shade of the
    // work colour, sharing work's exact border. A lunch break between two work
    // blocks was a 15px band of near-identical colour, indistinguishable from
    // the work either side of it. Clay reads as food, and reads as NOT work.
    if (["eating","cooking","meal_prep","snacking","drinking_coffee","drinking_wine","drinking_alcohol"].includes(slug)) return { bg:"#F6E0D2", border:"#C2703F", text:"#7C3A16" };
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
          // Session 150 — each source now carries its own work_blocks, so
          // the server reads hours off the sources rather than off a
          // separate top-level list. The old global `work_blocks` field is
          // deliberately no longer sent: it no longer exists in state, and
          // sending a stale duplicate would silently win over the real
          // per-source hours in the handler's fallback.
          revenue_sources: state.career?.revenue_sources,
          world_id: state.world?.id,
        })
      });
      if (r.ok) {
        const slots = await r.json();
        const normalized = slots.map(s => ({...s, day_of_week: (s.day_of_week || "").toLowerCase().trim()}));
        setState(p => ({...p, schedule: normalized, fromWeek}));
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
                      // Display label only — activity_slug itself stays
                      // "relaxing" (unchanged data value, in case anything
                      // downstream validates against the existing slug
                      // taxonomy); "Free time" reads better to a person
                      // looking at the calendar than the raw slug does.
                      // Session 150 — state_note carries the real meaning for
                      // breaks ("Break", "Between work"), while the slug stays
                      // "eating" so nothing downstream that validates against the
                      // activity taxonomy breaks. Prefer the note when it says
                      // more than the slug does.
                      const isBreak = s.activity_slug === "eating" && /break|between work/i.test(s.state_note || "");
                      const label  = isBreak ? s.state_note.toLowerCase()
                                   : s.activity_slug === "relaxing" ? "free time"
                                   : s.activity_slug.replace(/_/g," ");
                      return (
                        <div key={i} title={`${s.start_time}–${s.end_time} ${label}${s.state_note ? ` · ${s.state_note}` : ""}`}
                          style={{ position:"absolute", left:0, right:0, top, height, background:c.bg, borderTop:`1.5px solid ${c.border}`, overflow:"hidden", display:"flex", alignItems:"center", padding:"0 4px" }}>
                          {/* Session 150 — threshold was 18px, but an hour on a
                              360px/24h grid is only 15px, so every one-hour slot
                              rendered with no text at all. A lunch break is
                              exactly one hour. 9px type at 1.2 line-height needs
                              ~11px, which fits. */}
                          {height > 11 && <span style={{ ...S.sans, fontSize:9, color:c.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", lineHeight:1.2 }}>
                            {label}
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

// ── Step 5: CV ────────────────────────────────────────────────────────────────
// Session 149 — structure still not fully defined beyond free-text
// narrative, but now genuinely generatable via Haiku using real data:
// nationality (real column) and the wizard's own live workplace/career
// state (not yet persisted at this point, so passed in the request body
// rather than queried from the actor row). Still not sent in the deploy
// payload yet — that's a separate step once the data shape is settled.
function StepCV({ actor, state, setState }) {
  const [generating, setGenerating] = useState(false);
  const [uploading,  setUploading]  = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error,      setError]      = useState("");

  async function generate() {
    setGenerating(true); setError("");
    try {
      const r = await fetch(`/api/actors/${actor.id}/generate-cv`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          revenue_sources: state.career?.revenue_sources || [],
          // Session 150 — career level lives per revenue source now. The CV
          // describes one person, so it takes the rolled-up figure (highest
          // across sources); the handler uses it only to size the number of
          // roles it writes.
          career_level: rollupCareerLevel(state.career?.revenue_sources),
          world_id: state.world?.id,
        })
      });
      if (r.ok) {
        const data = await r.json();
        setState(p => ({...p, cv: { ...(p.cv||{}), notes: data.notes }}));
      } else {
        setError("Generation failed — try again.");
      }
    } catch (e) {
      setError(e.message);
    }
    setGenerating(false);
  }

  async function uploadCV(file) {
    setUploading(true); setError("");
    try {
      const fd = new FormData();
      fd.append("cv_file", file);
      const r = await fetch(`/api/actors/${actor.id}/upload-cv`, { method:"POST", body:fd });
      const data = await r.json();
      if (r.ok) {
        setState(p => ({...p, cv: { ...(p.cv||{}), notes: data.notes }}));
      } else {
        setError(data.error || "Couldn't read that file — try .pdf, .docx, or .txt");
      }
    } catch (e) {
      setError(e.message);
    }
    setUploading(false);
  }

  async function downloadPDF() {
    setDownloading(true); setError("");
    try {
      const r = await fetch(`/api/actors/${actor.id}/cv-pdf`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ notes: state.cv?.notes || "" }),
      });
      if (!r.ok) { const data = await r.json().catch(()=>({})); throw new Error(data.error || "PDF generation failed"); }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(actor?.first_name||actor?.name||"CV").replace(/[^a-z0-9]/gi,"_")}_CV.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
    setDownloading(false);
  }

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
        <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0", margin:0 }}>
          Full CV — generate from scratch or upload a real document to adapt.
        </p>
        <div style={{ display:"flex", gap:8, flexShrink:0 }}>
          <label style={{ ...S.sans, fontSize:11, padding:"3px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:uploading?"default":"pointer", opacity:uploading?0.5:1 }}>
            {uploading ? "Reading…" : "📄 Upload CV"}
            <input type="file" accept=".pdf,.docx,.txt" style={{ display:"none" }} disabled={uploading}
              onChange={e => { if (e.target.files[0]) uploadCV(e.target.files[0]); e.target.value=""; }} />
          </label>
          <button onClick={generate} disabled={generating} style={{ ...S.sans, fontSize:11, padding:"3px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:generating?"default":"pointer", opacity:generating?0.5:1 }}>
            {generating ? "Thinking…" : "✨ Generate"}
          </button>
          <button onClick={downloadPDF} disabled={downloading || !state.cv?.notes} style={{ ...S.sans, fontSize:11, padding:"3px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color: !state.cv?.notes ? "#c8c5c0" : "#6b6760", cursor:(downloading||!state.cv?.notes)?"default":"pointer", opacity:downloading?0.5:1 }}>
            {downloading ? "Rendering…" : "⬇ Download PDF"}
          </button>
        </div>
      </div>
      <div style={{ display:"flex", gap:16, alignItems:"flex-start" }}>
        <textarea
          value={state.cv?.notes || ""}
          onChange={e => setState(p => ({...p, cv: { ...(p.cv||{}), notes: e.target.value }}))}
          placeholder={"SUMMARY\n\nEXPERIENCE\n\nEDUCATION\n\nCOURSES\n\nINTERESTS\n\nLANGUAGES"}
          style={{ flex:1, minWidth:0, minHeight:480, fontSize:13, lineHeight:1.6, padding:"10px 12px", borderRadius:9, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", boxSizing:"border-box", resize:"vertical", whiteSpace:"pre-wrap", ...S.sans }}
        />
        {actor?.photo_url ? (
          <img src={actor.photo_url} style={{ width:96, height:96, borderRadius:8, objectFit:"cover", flexShrink:0, border:"1px solid rgba(0,0,0,.1)" }} />
        ) : (
          <div style={{ width:96, height:96, borderRadius:8, background:"rgba(0,0,0,.06)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:24, fontWeight:500, color:"#a8a5a0", flexShrink:0 }}>
            {(actor?.first_name||actor?.name||"?")[0]}
          </div>
        )}
      </div>
      {error && <p style={{ ...S.sans, fontSize:12, color:"#c0392b", marginTop:8 }}>{error}</p>}
    </div>
  );
}

// ── Step 6: Media ────────────────────────────────────────────────────────────
function StepMedia({ actor, state, setState }) {
  const [profilePhoto, setProfilePhoto] = useState(null); // {url} existing
  const [uploading,    setUploading]    = useState(false);
  const [voiceFile,    setVoiceFile]    = useState(null);
  const [voiceUploading, setVoiceUploading] = useState(false);
  // Session 150 — was a bare boolean, which threw away the one thing needed to
  // play the file back. The media rows already carry a url; keep the row.
  const [voiceMedia,   setVoiceMedia]   = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    fetch(`/api/actors/${actor.id}/media`).then(r=>r.ok?r.json():[]).then(d => {
      const photo = d.find(m => m.media_type==="photo" && m.state_slug==="profile");
      if (photo) setProfilePhoto(photo);
      // Session 149 — CharacterWizard.jsx uploads the voice sample as
      // media_type:"audio", state_slug:"voice_sample" (established since
      // Session 103). This step only ever checked its own convention
      // (media_type==="voice_reference", used by uploadVoice below) — so
      // a voice set during character creation was always invisible here,
      // showing "Upload a voice reference MP3" even when one already
      // existed. Recognize both; don't change either upload path, both
      // are legitimately in use.
      const voice = d.find(m => m.media_type==="voice_reference" || (m.media_type==="audio" && m.state_slug==="voice_sample"));
      if (voice) setVoiceMedia(voice);
    }).catch(()=>{});
  }, [actor.id]);

  async function uploadPhoto(file) {
    setUploading(true);
    const fd = new FormData();
    fd.append("photo", file);
    fd.append("state_slug", "profile");
    fd.append("media_type", "photo");
    if (state.world?.id) fd.append("world_id", state.world.id);
    const r = await fetch(`/api/actors/${actor.id}/media`, { method:"POST", body:fd });
    if (r.ok) { const data = await r.json(); setProfilePhoto(data); }
    setUploading(false);
  }

  async function uploadVoice(file) {
    setVoiceUploading(true);
    const fd = new FormData();
    fd.append("audio", file);
    fd.append("media_type", "voice_reference");
    fd.append("state_slug", "voice_reference");
    const r = await fetch(`/api/actors/${actor.id}/media`, { method:"POST", body:fd });
    if (r.ok) { const data = await r.json(); setVoiceMedia(data); }
    setVoiceUploading(false);
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0", margin:0 }}>All sections are optional — you can manage media later from the character editor.</p>

      {/* Profile photo */}
      <div>
        <div style={{ ...S.label, marginBottom:8 }}>Profile photo</div>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ width:64, height:64, borderRadius:"50%", overflow:"hidden", border:"1px solid rgba(0,0,0,.1)", background:"#e0d8cf", flexShrink:0 }}>
            {profilePhoto ? <img src={profilePhoto.url} style={{ width:"100%", height:"100%", objectFit:"cover" }} /> : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center", color:"#a8a5a0", fontSize:20 }}>+</div>}
          </div>
          <div>
            <label style={{ ...S.sans, fontSize:12, padding:"6px 14px", borderRadius:8, border:"1px solid rgba(0,0,0,.12)", background:"#1a1814", color:"#faf8f4", cursor:"pointer", opacity:uploading?0.6:1 }}>
              {uploading ? "Uploading…" : profilePhoto ? "Replace" : "Upload photo"}
              <input ref={fileRef} type="file" accept="image/*" style={{ display:"none" }} onChange={e=>{ if(e.target.files[0]) uploadPhoto(e.target.files[0]); e.target.value=""; }} />
            </label>
            <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0", marginTop:4 }}>World-specific profile image</div>
          </div>
        </div>
      </div>

      {/* Voice reference */}
      <div>
        <div style={{ ...S.label, marginBottom:8 }}>Voice reference</div>
        <div style={{ padding:"12px 14px", borderRadius:10, border:`1px ${voiceMedia?"solid":"dashed"} ${voiceMedia?"rgba(29,158,117,.3)":"rgba(0,0,0,.1)"}`, background:voiceMedia?"rgba(29,158,117,.05)":"rgba(0,0,0,.02)" }}>
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <span style={{ fontSize:18 }}>🎙️</span>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ ...S.sans, fontSize:13, fontWeight:500, color:voiceMedia?"#0f6e56":"#1a1814" }}>{voiceMedia?"Voice reference uploaded":"Upload a voice reference MP3"}</div>
              <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                {voiceMedia?.filename || "10–30 seconds of clear speech, no background noise"}
              </div>
            </div>
            <label style={{ ...S.sans, fontSize:11, padding:"4px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.12)", background: voiceMedia?"none":"#1a1814", color:voiceMedia?"#6b6760":"#faf8f4", cursor:"pointer", opacity:voiceUploading?0.6:1, flexShrink:0 }}>
              {voiceUploading?"Uploading…":voiceMedia?"Replace":"Upload MP3"}
              <input type="file" accept="audio/mp3,audio/mpeg,.mp3" style={{ display:"none" }} onChange={e=>{ if(e.target.files[0]) uploadVoice(e.target.files[0]); e.target.value=""; }} disabled={voiceUploading} />
            </label>
          </div>

          {/* Session 150 — the file could be uploaded and replaced but never
              heard. This voice is what the character will sound like in every
              encounter; confirming it before deploy should not require digging
              the file out of actor_media by hand. `key` on the url so replacing
              the sample reloads the element instead of replaying the old one
              from cache. */}
          {voiceMedia?.url && (
            <audio key={voiceMedia.url} controls preload="none" src={voiceMedia.url}
              style={{ width:"100%", height:32, marginTop:10, display:"block" }} />
          )}
        </div>
      </div>
    </div>
  );
}


// ── Step 5: Review ────────────────────────────────────────────────────────────
function StepDeploy({ actor, state }) {
  function relLabel(r) {
    const raw = (r.rel_type_name || r.label || "").replace(/_/g, " ").trim();
    if (!raw || raw === "none") return "no relationship set";
    return raw;
  }
  // Session 150 — hours are per revenue source now, so this reports them
  // that way instead of as one figure for the whole person. Previously it
  // also asserted "Mon–Fri … weekends free" as though it had read the
  // schedule; it hadn't — it only ever saw the configured blocks. The
  // weekday/weekend split is generate-schedule's behaviour, so it's stated
  // once, plainly, rather than repeated per line as if derived.
  // Session 150 — compact day summary. Contiguous runs collapse ("Mon–Fri"),
  // scattered days list out ("Sat, Sun"), so weekend-only work is visible at a
  // glance rather than hidden behind a generic "work week" line.
  function daysLabel(src) {
    const keys = WEEK.map(w => w.key);
    const abbr = { monday:"Mon", tuesday:"Tue", wednesday:"Wed", thursday:"Thu", friday:"Fri", saturday:"Sat", sunday:"Sun" };
    const on = daysOf(src);
    if (on.length === 0) return "never";
    if (on.length === 7) return "every day";
    const idx = keys.map((k, i) => on.includes(k) ? i : -1).filter(i => i >= 0);
    const runs = [];
    for (const i of idx) {
      const last = runs[runs.length - 1];
      if (last && i === last[last.length - 1] + 1) last.push(i);
      else runs.push([i]);
    }
    return runs.map(r => r.length >= 3 ? `${abbr[keys[r[0]]]}–${abbr[keys[r[r.length-1]]]}` : r.map(i => abbr[keys[i]]).join(", ")).join(", ");
  }

  function workHoursLabel(state) {
    const sources = state.career?.revenue_sources || [];
    if (sources.length === 0) return "No revenue sources — 08:00–17:00 default";
    return sources.map(s => {
      const blocks = (Array.isArray(s.work_blocks) && s.work_blocks.length > 0)
        ? s.work_blocks : [{ start:"08:00", end:"17:00" }];
      const where = (s.work_from_home || s.source_type === "independent") ? "home" : "work";
      const hours = blocks.map(b => `${b.start}–${b.end}`).join(", ");
      const leave = leaveDaysOf(s);
      return `${s.name || "(unnamed)"}: ${daysLabel(s)} ${hours} (${where}), ${leave > 0 ? `${leave} days leave` : "no paid leave"}`;
    }).join(" · ");
  }
  // Session 150 — level and reputation are per source, so the review shows
  // them per source, plus the rolled-up figure the simulator's actor row
  // actually receives.
  function sourcesLabel(state) {
    const sources = state.career?.revenue_sources || [];
    if (sources.length === 0) return "None";
    const cur = state.world?.currency || "";
    const per = sources.map(s => {
      const b = srcBasis(s);
      // Session 150 — say what each source actually pays, or say plainly that
      // it pays nothing yet. An unpriced source deploys fine but the ledger
      // will never credit it, and that should be visible before deploying.
      const money =
        b === "per_contract"
          ? (s.gross_amount ? `${s.gross_amount} ${cur} on ${s.ends_on || "completion (no date set)"}` : "no fee set")
          : (s.monthly_amount
              ? `${s.monthly_amount} ${cur}/mo${b === "variable" ? ` ±${Math.round((s.variability ?? 0.25)*100)}%` : ` on the ${srcPayDay(s)}th`}`
              : "no income set");
      return `${s.name || "(unnamed)"} — ${s.source_type}, ${Math.round((s.reputation_score ?? 0.5)*100)}% (${levelFromReputation(s.reputation_score)}), ${money}`;
    }).join(" · ");
    return sources.length > 1
      ? `${per}  →  actor record: ${rollupCareerLevel(sources) || "junior"}, ${Math.round(rollupReputation(sources)*100)}%`
      : per;
  }
  // Read off the generated schedule itself rather than asserted. The old
  // label claimed "weekends free" unconditionally without ever looking.
  function workWeekLabel(state) {
    const slots = Array.isArray(state.schedule) ? state.schedule : [];
    if (slots.length === 0) return "—";
    const WEEKEND = new Set(["saturday","sunday"]);
    const worksWeekend = slots.some(s =>
      WEEKEND.has((s.day_of_week||"").toLowerCase()) && (s.activity_slug||"").startsWith("work_"));
    return worksWeekend ? "Mon–Sun, weekend work scheduled" : "Mon–Fri, weekends free";
  }
  const rows = [
    ["Character",    actor?.name],
    // Say plainly whether the world is up. The Deploy button re-checks this and
    // refuses if it isn't, so the review should not read as though it will work.
    ["World",        state.world ? `${state.world.name}${state.world.status === "running" ? "" : "  ·  STOPPED"}` : null],
    ["Relationships",(state.relationships||[]).map(r=>`${r.character.first_name||r.character.name} — ${relLabel(r)}`).join(", ")||"None seeded"],
    ["Revenue sources", sourcesLabel(state)],
    ["Opening balance", fmtMoney(state.career?.opening_balance || 0, state.world?.currency)],
    ["Fixed expenses", (() => {
      const per = { monthly: 1, quarterly: 1/3, annual: 1/12 };
      const list = (state.career?.fixed_expenses || []).filter(e => (e.name||"").trim() && Number(e.amount) > 0);
      if (!list.length) return "None — nothing leaves her account";
      const m = list.reduce((t, e) => t + (Number(e.amount)||0) * (per[e.cadence||"monthly"]||1), 0);
      return `${list.length} · ${fmtMoney(m, state.world?.currency)}/month`.trim();
    })()],
    ["Work hours",   state.schedule ? workHoursLabel(state) : "Not set"],
    ["Work week",    workWeekLabel(state)],
    ["Deploy starts", `Week ${state.fromWeek}`],
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

// ── Draft persistence ─────────────────────────────────────────────────────────
// Session 150 — the wizard held everything in memory only, so closing the
// modal or reloading the tab discarded the world/home pick, every
// relationship configured by hand, the generated CV and the generated
// schedule — several minutes of Haiku round-trips, gone, with only a
// "Progress will be lost" confirm as warning.
//
// Stored in localStorage rather than server-side on purpose: actor.draft_state
// is already the wardrobe's canonical store (Plan A, Sessions 146–147), and
// deploy deliberately REFUSES to run when that blob won't parse. Putting
// unrelated wizard state behind that contract would mean a stale or truncated
// draft could block deploying the actor entirely. This is operator-local
// convenience state; it has no business gating deploys.
// v3 (Session 150) — career_level and reputation_score joined work hours in
// moving onto each revenue source. As with v2, an older draft's single
// person-level value can't be attributed to any particular source after the
// fact, so those drafts are dropped on load rather than restored into a
// shape that would silently lose them.
const DRAFT_VERSION = 3;
const draftKey = actorId => `deploy-wizard-draft:${actorId}`;

function clampStep(n) {
  const s = Number(n);
  return Number.isFinite(s) && s >= 1 && s <= STEPS.length ? s : 1;
}

function loadDraft(actorId) {
  if (!actorId) return null;
  try {
    const raw = localStorage.getItem(draftKey(actorId));
    if (!raw) return null;
    const d = JSON.parse(raw);
    // A version bump means the shape changed — drop the old draft rather
    // than restoring fields the current wizard would misread.
    if (!d || d.v !== DRAFT_VERSION || !d.state) return null;
    return d;
  } catch { return null; }
}

function saveDraft(actorId, step, state) {
  if (!actorId) return;
  try {
    // worldCharacters / worldUsers / worldRosterLoaded are NOT persisted.
    // They're refetched from the world whenever step 2 mounts, and a
    // restored copy would let the relationship gate pass against a cast
    // list that no longer matches the world.
    const { worldCharacters, worldUsers, worldRosterLoaded, ...persistable } = state;
    localStorage.setItem(draftKey(actorId), JSON.stringify({ v: DRAFT_VERSION, step, state: persistable, savedAt: Date.now() }));
  } catch { /* quota or private mode — persistence is a convenience, never a requirement */ }
}

function clearDraft(actorId) {
  if (!actorId) return;
  try { localStorage.removeItem(draftKey(actorId)); } catch {}
}

function savedAgo(ts) {
  if (!ts) return "";
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1)   return "just now";
  if (mins < 60)  return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs} h ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

// ── Main modal ────────────────────────────────────────────────────────────────
export default function DeployWizardModal({ actor, onClose, onDeployed }) {
  const navigate = useNavigate();
  // Session 150 — restored draft, read once on mount. `stateImages` was
  // dropped from the initial shape: it was declared here and never read
  // or written anywhere in the file.
  const [draft] = useState(() => loadDraft(actor?.id));
  const [step, setStep]   = useState(() => clampStep(draft?.step));
  const [state, setState] = useState(() => draft?.state || { world:null, relationships:[], schedule:null, fromWeek:1 });
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState("");
  const [draftNotice, setDraftNotice] = useState(!!draft);

  // Session 150 — a deploy cannot land while the simulator is down, so the
  // wizard should say so instead of letting someone build six steps of work
  // that fails at the last button.
  //
  // Starts optimistic (reachable: true) on purpose: the first check has not
  // returned yet, and flashing a scary banner for 13ms on every open is worse
  // than the rare case of showing the controls a moment before disabling them.
  // Re-checked on an interval because the simulator can die mid-wizard — the
  // steps take minutes and involve LLM calls.
  const [sim, setSim] = useState({ reachable: true, checking: true });

  async function checkSim() {
    try {
      const r = await fetch("/api/simulator/health", { credentials: "include" });
      const d = await r.json();
      setSim({ ...d, checking: false });
      return d.reachable;
    } catch (e) {
      setSim({ reachable: false, checking: false, reason: "Couldn't reach the platform API." });
      return false;
    }
  }

  useEffect(() => {
    let alive = true;
    const run = () => { if (alive) checkSim(); };
    run();
    const t = setInterval(run, 20000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Session 150 — persist on every change. The roster fields are
  // deliberately excluded (see saveDraft) so a stale cast list can never
  // be restored into the step-2 gate.
  useEffect(() => { saveDraft(actor?.id, step, state); }, [actor?.id, step, state]);

  function startFresh() {
    if (!window.confirm("Discard the saved draft and start this wizard over?")) return;
    clearDraft(actor?.id);
    setState({ world:null, relationships:[], schedule:null, fromWeek:1 });
    setStep(1);
    setDraftNotice(false);
    setError("");
  }

  // Session 149 — everyone in the world (every deployed character, every
  // player) needs at least one relationship dimension defined before
  // moving on, not just whoever was picked and configured. Returns the
  // list of people still missing one, used both to gate Next and to
  // show who's still outstanding directly in the step.
  function missingRelationships() {
    const all = [...(state.worldCharacters||[]), ...(state.worldUsers||[]).map(u => ({...u, _isUser:true}))];
    const covered = new Set((state.relationships||[]).map(r => r.character.id));
    return all.filter(p => !covered.has(p.id));
  }

  // Session 150 — one function that decides whether the step is finished AND
  // says why it isn't.
  //
  // This was a bare boolean, so an incomplete step produced a greyed-out Next
  // and no explanation. Every reason below was already a rule; none of them were
  // visible. Returning the reason instead of `false` costs nothing and is the
  // difference between a blocked user and an informed one.
  function nextIssue() {
    if (!sim.reachable) return "The simulator is offline";

    if (step === 1) {
      if (!state.world) return "Choose a world";
      // A deploy into a stopped world writes every row and then cannot boot her:
      // the actor's process tree is started by the world's supervisor, which
      // isn't running.
      if (state.world.status !== "running") return `${state.world.name} is stopped — start it to continue`;
      if (!state.home?.place_id)  return "Set her home address";
      if (!isPreciseHome(state.home.types)) return "Add a house number — a street isn't an address";
      if (!state.home?.home_type) return "Choose apartment or house";
      return null;
    }

    if (step === 2) {
      // Without the roster check a failed fetch produced an empty missing-list
      // and waved the step through.
      if (!state.worldRosterLoaded) return "Loading the world's cast…";
      const missing = missingRelationships();
      if (missing.length) {
        const names = missing.map(m => m.first_name || m.name).filter(Boolean);
        return `Set a relationship for ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
      }
      return null;
    }

    if (step === 3) {
      const sources = state.career?.revenue_sources || [];
      if (!sources.length) return "Add at least one revenue source";

      const unnamed = sources.find(s => !(s.name || "").trim());
      if (unnamed) return "Every revenue source needs a name";

      // Written straight into actor_revenue_sources.monthly_amount and read by
      // ScheduledPaymentProcess — a source paying zero is not income.
      const unpaid = sources.find(s => !(Number(s.monthly_amount) > 0));
      if (unpaid) return `How much does ${unpaid.name.trim()} pay?`;

      // per_contract has no pay day by design; everything else needs one or the
      // payment process has no day to fire on.
      // srcPayDay always resolves to a usable day for anything that is paid on
      // one, so this can only fire on a source whose basis has no pay day —
      // which is per_contract, already excluded. Kept as a guard rather than
      // removed: it is the check that would catch a future basis that needs a
      // day and does not get one.
      const undated = sources.find(s => srcBasis(s) !== "per_contract" && srcPayDay(s) == null);
      if (undated) return `Set a pay day for ${undated.name.trim()}`;

      const expenses = state.career?.fixed_expenses || [];
      const badExp = expenses.find(e => !(e.name || "").trim() || !(Number(e.amount) > 0));
      if (badExp) return "Every expense needs a name and an amount — or remove the row";

      // 0 is a real answer here (she starts broke); blank is not an answer.
      if (state.career?.opening_balance === null || state.career?.opening_balance === undefined
          || state.career?.opening_balance === "") return "Set an opening balance — 0 is fine";

      return null;
    }

    // [] is truthy, so the old `!!state.schedule` let an empty generation walk
    // to Deploy and fail there against the server's own length check.
    if (step === 4) {
      if (!Array.isArray(state.schedule) || !state.schedule.length) return "Generate a schedule";
      return null;
    }

    // Step 5 (Media) is deliberately ungated. The voice reference and portraits
    // are genuinely optional — the XTTS server is frequently unreachable and the
    // upload is fire-and-forget — so requiring them would block deploys for an
    // outage that has nothing to do with the character.
    return null;
  }

  function canNext() { return !nextIssue(); }

  async function handleDeploy() {
    // The interval check can be up to 20s stale, and this is the one call that
    // must not be made hopefully. Confirm the simulator is there right now.
    setDeploying(true);
    if (!(await checkSim())) {
      setError("The simulator isn't reachable — nothing was deployed. It'll re-check automatically.");
      setDeploying(false);
      return;
    }

    // Session 150 — re-confirm the world is still running. Step 1 gates on this,
    // but the steps in between take minutes (CV parsing, schedule generation),
    // and the world can be stopped from /my-worlds in another tab meanwhile. The
    // status held in wizard state is only as fresh as when step 1 was passed.
    try {
      const ws = await fetch("/api/worlds", { credentials:"include" }).then(r => r.ok ? r.json() : []);
      const live = ws.find(w => w.id === state.world?.id);
      if (!live) {
        setError(`${state.world?.name || "That world"} no longer exists — nothing was deployed.`);
        setDeploying(false);
        return;
      }
      if (live.status !== "running") {
        setState(p => ({ ...p, world: live }));
        setError(`${live.name} was stopped — nothing was deployed. Start it on step 1, then deploy.`);
        setDeploying(false);
        return;
      }
    } catch (e) {
      setError("Couldn't confirm the world is running — nothing was deployed.");
      setDeploying(false);
      return;
    }
    setError("");
    try {
      // Session 150 — career level and reputation are per revenue source
      // now, but the simulator's actors row still carries one of each
      // (ReputationEngine, WorkOfferGenerator and the LiveView career tab
      // all read them there). Send the rolled-up figure alongside the
      // per-source values so both models stay populated and nothing that
      // reads the actor row starts seeing nulls.
      // Session 150 — career_level is derived at send time rather than stored
      // on the source. The reputation slider is the only thing the operator
      // sets; actor_revenue_sources.career_level exists for the simulator to
      // read, so it's computed here from that source's own reputation.
      const sourcesForDeploy = (state.career?.revenue_sources || []).map(s => ({
        ...s,
        career_level: levelFromReputation(s.reputation_score),
        // Session 150 — send the payout shape explicitly rather than leaving the
        // simulator to infer it from source_type. It infers the same thing by
        // default, but a source whose type is later edited without its terms
        // being revisited would otherwise silently change how it pays.
        amount_basis: srcBasis(s),
        currency:     s.currency || state.world?.currency || null,
        // Session 150 — resolved HERE, not left to a default on either side, so
        // what deploys is exactly what the operator saw. pay_day and work_days
        // were rendered from fallbacks (`src.pay_day ?? 25`, `daysOf(src)`) but
        // only WRITTEN when the control was actually touched — so a source left
        // at its displayed defaults deployed with both null. Lindsey's first
        // deploy landed with no pay day and no work days despite the wizard
        // showing 25 and Mon-Fri.
        leave_days_per_year: leaveDaysOf(s),
        pay_day:   srcPayDay(s),
        work_days: daysOf(s),
        work_blocks: blocksOfSource(s),
      }));
      const payload = {
        world:         state.world,
        home:          state.home,
        career:        {
          ...(state.career || {}),
          revenue_sources:  sourcesForDeploy,
          // Explicit 0 rather than null when unset — the simulator opens the
          // account at whatever arrives, and "not stated" and "nothing" are the
          // same thing for a starting balance.
          opening_balance:  Math.max(0, Number(state.career?.opening_balance) || 0),
          // Blank rows are dropped here rather than on the server: an expense
          // with no name or no amount is a half-filled row the user abandoned,
          // not an instruction to charge her nothing every month.
          fixed_expenses:   (state.career?.fixed_expenses || [])
            .filter(e => (e.name || "").trim() && Number(e.amount) > 0)
            .map(e => ({ name: (e.name || "").trim(), category: e.category || "other",
                         amount: Number(e.amount) || 0,
                         cadence: EXPENSE_CADENCES.includes(e.cadence) ? e.cadence : "monthly",
                         debit_day: Math.min(28, Math.max(1, Number(e.debit_day) || 1)) })),
          career_level:     rollupCareerLevel(sourcesForDeploy),
          reputation_score: rollupReputation(sourcesForDeploy),
        },
        relationships: state.relationships || [],
        schedule:      state.schedule || [],
        fromWeek:      state.fromWeek || 1,
        // Session 150 — the CV was collected here, generated by Haiku,
        // editable, and exportable as a PDF, then dropped on the floor:
        // it appeared nowhere in this payload, server/index.js never
        // forwarded one, and deploy_actor/2 on the simulator had no
        // params["cv"] to read. Every deployed actor carried an empty
        // history. Wired end to end this session.
        cv:            state.cv?.notes?.trim() || null,
      };
      const res = await fetch(`/api/actors/${actor.id}/deploy`, {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        // Deployed — the draft has served its purpose and would otherwise
        // be restored the next time this actor's wizard is opened.
        clearDraft(actor?.id);
        onDeployed({ platform_actor_id: actor.id, world_id: state.world.id, world_name: state.world.name, simulator_actor_id: data.simulator_actor_id });

        // Session 150 — land on her, in the world she just entered.
        //
        // The wizard used to close and drop you back wherever you started, with
        // no confirmation of any kind. Six steps of work ended in a modal
        // vanishing, and the only way to find out whether it had worked was to
        // go looking for her. Now it goes where the answer is: her world-scoped
        // page, which shows the income, expenses, schedule and psychology that
        // were just written.
        //
        // The banner is passed through router state rather than a query param so
        // it survives exactly one navigation and leaves no ?deployed=1 to be
        // re-shared, bookmarked, or shown again on reload.
        navigate(`/my-worlds/${state.world.id}/actors/${actor.id}`, {
          state: {
            justDeployed: {
              name: actor.first_name || actor.name,
              world: state.world.name,
              sources: (state.career?.revenue_sources || []).length,
              expenses: (state.career?.fixed_expenses || []).filter(e => (e.name||"").trim() && Number(e.amount) > 0).length,
              weeks: Array.isArray(state.schedule) ? 53 - (state.fromWeek || 1) : 0,
            },
          },
        });
      } else {
        setError(data.error || "Deploy failed.");
        setDeploying(false);
      }
    } catch(e) { setError("Network error: " + e.message); setDeploying(false); }
  }

  const nextLabels = ["","Next →","Next →","Next →","Next →","Next →","Deploy"];

  return (
    <div style={S.overlay}>
      <div style={{...S.modal, position:"relative"}} onClick={e=>e.stopPropagation()}>
        {/* Loading spinner overlay */}
        {deploying && (
          <div style={{ position:"absolute", inset:0, zIndex:10, borderRadius:24, background:"rgba(255,255,255,0.85)", backdropFilter:"blur(8px)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16 }}>
            <div style={{ width:40, height:40, border:"3px solid rgba(0,0,0,0.08)", borderTop:"3px solid #1a1814", borderRadius:"50%", animation:"spin 0.9s linear infinite" }} />
            <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#1a1814", fontWeight:500 }}>Deploying character…</div>
            {/* Session 150 — this used to say "Dolphin is thinking" for every
                deploy. Dolphin is only called to write reverse relationship
                descriptions for CHARACTER targets; deploy_actor skips it
                outright for relationships with users ("users — skip Dolphin,
                nil description is correct"). An actor whose only connections
                are players — which is the common case for the first character
                in a world — never touches it, so the message named a step that
                was not running. Say what is actually happening. */}
            <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0" }}>
              {(state.relationships || []).some(r => !r.character?._isUser)
                ? "Writing relationship context for each character — this can take a minute"
                : "Creating places, psychology, schedule and media"}
            </div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"1.25rem 1.5rem .75rem", borderBottom:"1px solid rgba(0,0,0,.06)", flexShrink:0 }}>
          <div>
            <div style={{ ...S.serif, fontSize:21, fontWeight:500, color:"#1a1814" }}>Deploy {actor?.first_name||actor?.name}</div>
            <div style={{ ...S.sans, fontSize:12, color:"#a8a5a0", marginTop:2 }}>Step {step} of {STEPS.length} — {STEPS[step-1]}</div>
          </div>
          {/* Session 150 — no longer warns that progress will be lost,
              because it isn't: everything is saved per-actor and restored
              on reopen. Discarding is now the explicit action, not the
              accidental one. */}
          <button onClick={onClose} title="Close — your progress is saved" style={{ background:"none", border:"1px solid rgba(0,0,0,.08)", borderRadius:8, padding:"6px 12px", cursor:"pointer", ...S.sans, fontSize:12, color:"#a8a5a0" }}>✕</button>
        </div>

        {/* Restored-draft notice */}
        {draftNotice && (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, margin:"0.75rem 1.5rem -0.25rem", padding:"7px 11px", borderRadius:9, background:"rgba(29,158,117,.07)", border:"1px solid rgba(29,158,117,.25)" }}>
            <span style={{ ...S.sans, fontSize:11.5, color:"#0f6e56" }}>
              Picked up where you left off — saved {savedAgo(draft?.savedAt)}.
            </span>
            <div style={{ display:"flex", gap:6, flexShrink:0 }}>
              <button onClick={startFresh} style={{ ...S.sans, fontSize:11, padding:"3px 9px", borderRadius:7, border:"1px solid rgba(29,158,117,.35)", background:"none", color:"#0f6e56", cursor:"pointer" }}>Start fresh</button>
              <button onClick={()=>setDraftNotice(false)} style={{ ...S.sans, fontSize:11, padding:"3px 7px", borderRadius:7, border:"none", background:"none", color:"#0f6e56", cursor:"pointer", opacity:.7 }}>✕</button>
            </div>
          </div>
        )}

        <StepBar current={step} />

        {/* Body */}
        <div style={{ flex:1, overflowY:"auto", padding:"1.25rem 1.5rem" }}>
          {!sim.reachable && (
            <div style={{ display:"flex", alignItems:"flex-start", gap:11, padding:"12px 14px", marginBottom:16,
              background:"rgba(192,57,43,.05)", border:"1px solid rgba(192,57,43,.18)", borderRadius:10 }}>
              <div style={{ width:8, height:8, borderRadius:"50%", background:"#c0392b", flexShrink:0, marginTop:5 }} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ ...S.sans, fontSize:13, color:"#993c1d", fontWeight:500, marginBottom:2 }}>
                  The simulator is offline — deploying is disabled
                </div>
                <div style={{ ...S.sans, fontSize:12, color:"#6b6760", lineHeight:1.6 }}>
                  {sim.reason || "The simulator isn't answering."}{" "}
                  Nothing you've filled in is lost — it's saved as a draft. Re-checking every 20 seconds.
                </div>
              </div>
              <button onClick={checkSim} disabled={sim.checking}
                style={{ ...S.sans, fontSize:11, letterSpacing:".05em", textTransform:"uppercase", padding:"6px 12px",
                  borderRadius:7, border:"1px solid rgba(192,57,43,.25)", background:"transparent",
                  color:"#993c1d", cursor: sim.checking ? "default" : "pointer", flexShrink:0, opacity: sim.checking ? .5 : 1 }}>
                {sim.checking ? "Checking…" : "Retry"}
              </button>
            </div>
          )}
          {step===1 && <StepWorld      actor={actor} state={state} setState={setState} />}
          {step===2 && <StepRelationships actor={actor} state={state} setState={setState} />}
          {step===3 && (
            <>
              <StepCV         actor={actor} state={state} setState={setState} />
              <div style={{ height:28, borderTop:"1px solid rgba(0,0,0,.06)", marginTop:20 }} />
              <StepEmployment actor={actor} state={state} setState={setState} />
            </>
          )}
          {step===4 && <StepSchedule   actor={actor} state={state} setState={setState} />}
          {step===5 && <StepMedia      actor={actor} state={state} setState={setState} />}
          {step===6 && <StepDeploy     actor={actor} state={state} />}
          {error && <p style={{ ...S.sans, fontSize:12, color:"#c0392b", marginTop:12 }}>{error}</p>}
        </div>

        {/* Footer */}
        <div style={{ display:"flex", alignItems:"center", gap:14, justifyContent:"space-between", padding:"1rem 1.5rem", borderTop:"1px solid rgba(0,0,0,.06)", flexShrink:0 }}>
          <button onClick={()=>setStep(p=>Math.max(1,p-1))} disabled={step===1} style={{ ...S.sans, fontSize:13, padding:"8px 18px", borderRadius:9, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer", opacity:step===1?.4:1 }}>← Back</button>
          {/* Session 150 — say what is missing. A disabled Next with no reason
              makes the user hunt the form for whichever field it means. */}
          {(() => {
            const issue = nextIssue();
            return issue && !deploying ? (
              <span style={{ ...S.sans, fontSize:12, color:"#a8a5a0", marginLeft:"auto", marginRight:4,
                textAlign:"right", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {issue}
              </span>
            ) : null;
          })()}
          <button onClick={()=>{ if(!canNext()) return; if(step===6) handleDeploy(); else setStep(p=>p+1); }} disabled={deploying||!canNext()} style={{ ...S.sans, fontSize:13, padding:"8px 24px", borderRadius:9, border:"none", background:"#1a1814", color:"#faf8f4", cursor:"pointer", opacity:(!canNext()||deploying)?.5:1 }}>
            {deploying?"Deploying…":nextLabels[step]}
          </button>
        </div>
      </div>
    </div>
  );
}
