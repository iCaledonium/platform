import { useState, useEffect, useRef } from "react";
import styles from "./WorldEnterOverlay.module.css";
import VenueScene from "./VenueScene.jsx";
import Scene from "./Scene.jsx";

const SIMULATOR_URL = "https://anima.simulator.ngrok.dev";
const MAPS_KEY = "AIzaSyDy45Dov_WkN9FcxdVNYQEx23PjexI-Fxc";

const PIN_STYLES = `
  .anima-pin { display:flex; flex-direction:column; align-items:center; cursor:pointer; }
  .anima-pin-bubble {
    background:#1a1a1a; border-radius:20px; padding:4px 8px 4px 6px;
    display:flex; align-items:center; gap:4px;
    border:1.5px solid rgba(255,255,255,0.12);
    transition:transform 0.15s, background 0.15s;
    white-space:nowrap;
  }
  .anima-pin-bubble:not(:has(.anima-pin-photo)):not(:has(.anima-pin-initial)) {
    background:#4a4a4a; padding:4px 8px;
  }
  .anima-pin-bubble:hover { transform:scale(1.06); }
  .anima-pin-bubble.selected { background:#c9973a; border-color:rgba(255,255,255,0.3); }
  .anima-pin-photo {
    width:20px; height:20px; border-radius:50%;
    object-fit:cover; border:1.5px solid rgba(255,255,255,0.3);
    flex-shrink:0;
  }
  .anima-pin-initial {
    width:20px; height:20px; border-radius:50%;
    background:rgba(255,255,255,0.15); display:flex; align-items:center;
    justify-content:center; font-size:9px; font-weight:500; color:#fff; flex-shrink:0;
  }
  .anima-pin-label {
    font-family:'DM Sans',sans-serif; font-size:10px; color:#fff;
    letter-spacing:0.02em; max-width:100px; overflow:hidden;
    text-overflow:ellipsis;
  }
  .anima-pin-extra {
    font-family:'DM Sans',sans-serif; font-size:9px;
    color:rgba(255,255,255,0.6); flex-shrink:0;
  }
  .anima-pin-stem { width:1.5px; height:7px; background:#1a1a1a; }
  .anima-pin-stem.selected { background:#c9973a; }
  .anima-pin-dot-base {
    width:7px; height:7px; border-radius:50%; background:#888;
    border:1.5px solid #fff; transition:transform 0.15s;
  }
  .anima-pin-dot-base:hover { transform:scale(1.3); }
`;

function injectPinStyles() {
  if (document.getElementById("anima-pin-styles")) return;
  const el = document.createElement("style");
  el.id = "anima-pin-styles";
  el.textContent = PIN_STYLES;
  document.head.appendChild(el);
}

export default function WorldEnterOverlay({ world, user, onClose }) {
  const mapRef        = useRef(null);
  const mapInstance   = useRef(null);
  const markers       = useRef([]);
  const selectedRef   = useRef(null);

  const [locations, setLocations] = useState([]);
  const [selected,  setSelected]  = useState(null);
  const [mapReady,  setMapReady]  = useState(false);
  const [spawning,  setSpawning]  = useState(false);
  const [loading,   setLoading]   = useState(true);
  const [sceneData, setSceneData] = useState(null);
  const [mapKey,    setMapKey]    = useState(0);

  // Fetch presence + refresh every 30s
  useEffect(() => {
    const load = () => {
      fetch(`/api/worlds/${world.id}/presence`)
        .then(r => r.json())
        .then(data => {
          setLocations(data);
          setLoading(false);
          // Keep selected panel in sync
          setSelected(prev => {
            if (!prev) return prev;
            const updated = data.find(l => l.id === prev.id);
            return updated || prev;
          });
        })
        .catch(() => setLoading(false));
    };
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [world.id]);

  // Load Google Maps
  useEffect(() => {
    injectPinStyles();
    if (window.google?.maps?.marker) { setMapReady(true); return; }
    if (document.getElementById("gmaps-script")) {
      const wait = setInterval(() => {
        if (window.google?.maps) { setMapReady(true); clearInterval(wait); }
      }, 100);
      return () => clearInterval(wait);
    }
    const script = document.createElement("script");
    script.id  = "gmaps-script";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}`;
    script.async = true;
    script.onload = () => setMapReady(true);
    document.head.appendChild(script);
  }, []);

  // Init map
  useEffect(() => {
    if (!mapReady || !mapRef.current || mapInstance.current) return;
    mapInstance.current = new window.google.maps.Map(mapRef.current, {
      center:           { lat: 59.334, lng: 18.065 },
      zoom:             13,
      disableDefaultUI: true,
      zoomControl:      true,
      zoomControlOptions: { position: window.google.maps.ControlPosition.RIGHT_BOTTOM },
      styles: [
        { featureType: "all",            stylers: [{ saturation: -40 }, { lightness: 8 }] },
        { featureType: "water",          stylers: [{ color: "#b8cfd8" }] },
        { featureType: "road",           elementType: "geometry", stylers: [{ color: "#e4e0da" }] },
        { featureType: "road",           elementType: "labels.icon", stylers: [{ visibility: "off" }] },
        { featureType: "poi",            stylers: [{ visibility: "off" }] },
        { featureType: "poi.park",       elementType: "geometry", stylers: [{ visibility: "on" }, { saturation: -60 }, { lightness: 20 }] },
        { featureType: "poi.park",       elementType: "labels", stylers: [{ visibility: "off" }] },
        { featureType: "transit",        stylers: [{ visibility: "off" }] },
        { featureType: "administrative", elementType: "labels.text", stylers: [{ visibility: "simplified" }, { lightness: 20 }] },
      ],
    });
  }, [mapReady, mapKey]);

  // Place markers
  useEffect(() => {
    if (!mapReady || !mapInstance.current || locations.length === 0) return;

    // Clear old overlays
    markers.current.forEach(m => { try { m.setMap(null); } catch {} });
    markers.current = [];

    class AnimaPin extends window.google.maps.OverlayView {
      constructor(loc, onSelect) {
        super();
        this.loc = loc;
        this.onSelect = onSelect;
        this.div = null;
      }
      onAdd() {
        const loc = this.loc;
        const hasActors = loc.actors && loc.actors.length > 0;
        const div = document.createElement("div");
        div.style.cssText = "position:absolute;cursor:pointer;";
        const first    = hasActors ? loc.actors[0] : null;
        const photoUrl = first?.photo_url ? `${SIMULATOR_URL}${first.photo_url}` : null;
        const extra    = hasActors && loc.actors.length > 1 ? loc.actors.length - 1 : 0;
        const label    = loc.name.length > 18 ? loc.name.slice(0, 17) + "…" : loc.name;
        div.innerHTML = `
          <div class="anima-pin" style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;">
            <div class="anima-pin-bubble">
              ${photoUrl ? `<img src="${photoUrl}" class="anima-pin-photo" onerror="this.style.display='none'" />` : hasActors ? `<div class="anima-pin-initial">${first.name[0]}</div>` : ""}
              <span class="anima-pin-label">${label}</span>
              ${extra > 0 ? `<span class="anima-pin-extra">+${extra}</span>` : ""}
            </div>
            <div class="anima-pin-stem"></div>
          </div>`;
        div.addEventListener("click", () => this.onSelect(this.loc));
        this.div = div;
        this.getPanes().overlayMouseTarget.appendChild(div);
      }
      draw() {
        const proj = this.getProjection();
        if (!proj || !this.div) return;
        const pt = proj.fromLatLngToDivPixel(
          new window.google.maps.LatLng(Number(this.loc.lat), Number(this.loc.lng))
        );
        if (pt) { this.div.style.left = pt.x + "px"; this.div.style.top = pt.y + "px"; }
      }
      onRemove() {
        if (this.div?.parentNode) this.div.parentNode.removeChild(this.div);
        this.div = null;
      }
      setSelected(sel) {
        if (!this.div) return;
        this.div.querySelector(".anima-pin-bubble")?.classList.toggle("selected", sel);
        this.div.querySelector(".anima-pin-stem")?.classList.toggle("selected", sel);
      }
    }

    locations.forEach(loc => {
      if (!loc.lat || !loc.lng) return;
      const pin = new AnimaPin(loc, selectLocation);
      pin.setMap(mapInstance.current);
      pin._locId = loc.id;
      markers.current.push(pin);
    });
  }, [mapReady, locations, mapKey]);

  function selectLocation(loc) {
    if (selectedRef.current) {
      markers.current.find(m => m._locId === selectedRef.current.id)?.setSelected(false);
    }
    markers.current.find(m => m._locId === loc.id)?.setSelected(true);
    selectedRef.current = loc;
    setSelected(loc);
    mapInstance.current?.panTo({ lat: Number(loc.lat), lng: Number(loc.lng) });
  }

  async function handleSpawn() {
    if (!selected || spawning) return;
    setSpawning(true);
    try {
      await fetch(`/api/worlds/${world.id}/spawn`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ location_id: selected.place_id || selected.id }),
      });

      if (selected.category === "residential") {
        // Knock flow — start encounter immediately, use Scene
        await new Promise(r => setTimeout(r, 1200));
        let encounter_id = null;
        if (selected.actors && selected.actors.length > 0) {
          const encResp = await fetch(`/api/worlds/${world.id}/encounter/start`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
              target_actor_id: selected.actors[0].actor_id,
              location_id:     selected.place_id || selected.id,
              trigger:         "knock"
            })
          });
          const encData = await encResp.json();
          encounter_id = encData.encounter_id;
        }
        setSceneData({ location: selected, encounter_id, trigger: "knock", mode: "scene" });
      } else {
        // Public venue — hang around in VenueScene
        setSceneData({ location: selected, mode: "venue" });
      }
    } catch (e) {
      console.error("Spawn failed", e);
    } finally {
      setSpawning(false);
    }
  }

  // If scene is active render it instead of map
  if (sceneData) {
    const onLeave = () => {
      mapInstance.current = null;
      setSceneData(null);
      setMapKey(k => k + 1);
    };
    if (sceneData.mode === "scene") {
      return (
        <Scene
          world={world}
          user={user}
          sceneData={sceneData}
          onLeave={onLeave}
        />
      );
    }
    return (
      <VenueScene
        world={world}
        user={user}
        location={sceneData.location}
        onLeave={onLeave}
      />
    );
  }

  const worldTime = new Date().toLocaleTimeString("sv-SE", {
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm",
  });

  return (
    <div className={styles.overlay}>

      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.worldDot} />
          <div>
            <span className={styles.worldName}>{world.name || "Anima — Stockholm"}</span>
            <span className={styles.worldSub}>Select a location to enter</span>
          </div>
        </div>
        <div className={styles.headerRight}>
          <span className={styles.worldTime}>{worldTime}</span>
          <button className={styles.closeBtn} onClick={onClose}>✕ Close</button>
        </div>
      </div>

      <div className={styles.body}>

        <div key={mapKey} className={styles.mapWrap}>
          {loading && (
            <div className={styles.mapLoading}>
              <span className={styles.mapLoadingText}>Loading world…</span>
            </div>
          )}
          <div ref={mapRef} className={styles.map} />
        </div>

        <div className={`${styles.panel} ${selected ? styles.panelVisible : ""}`}>
          {selected && (
            <>
              <div className={styles.panelInner}>
                <div className={styles.panelMeta}>
                  <span className={styles.panelType}>{selected.category}</span>
                  {selected.area && <span className={styles.panelArea}>{selected.area}</span>}
                </div>
                <h2 className={styles.panelName}>{selected.name}</h2>
                {selected.formatted_address && (
                  <p className={styles.panelAddress}>{selected.formatted_address}</p>
                )}

                <div className={styles.divider} />

                <p className={styles.sectionLabel}>Here now</p>
                {selected.actors.filter(a => a.actor_id !== user?.worlds?.find(w => w.world_id === world.id)?.actor_id).length === 0 ? (
                  <p className={styles.emptyState}>Nobody here right now</p>
                ) : (
                  <div className={styles.actorList}>
                    {selected.actors.filter(a => a.actor_id !== user?.worlds?.find(w => w.world_id === world.id)?.actor_id).map(a => (
                      <div key={a.actor_id} className={styles.actorRow}>
                        <div className={styles.actorAvWrap}>
                          {a.photo_url
                            ? <img
                                src={`${SIMULATOR_URL}${a.photo_url}`}
                                className={styles.actorPhoto}
                                onError={e => { e.target.style.display = "none"; e.target.nextSibling.style.display = "flex"; }}
                              />
                            : null}
                          <div className={styles.actorInitial} style={{ display: a.photo_url ? "none" : "flex" }}>
                            {a.name[0]}
                          </div>
                        </div>
                        <div className={styles.actorInfo}>
                          <p className={styles.actorName}>{a.name}</p>
                          <p className={styles.actorStatus}>
                            {a.in_transit
                              ? "In transit"
                              : a.activity_slug
                                ? a.activity_slug.replace(/_/g, " ")
                                : a.occupation || "—"}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className={styles.panelFooter}>
                {selected.category === "residential" && selected.actors.length > 0 && !selected.actors.some(a => a.knows_player) ? (
                  <p className={styles.emptyState}>You don't know anyone here</p>
                ) : (
                  <button
                    className={styles.spawnBtn}
                    onClick={handleSpawn}
                    disabled={spawning}
                  >
                    {spawning
                      ? (selected.category === "residential" ? "Knocking…" : "Entering…")
                      : (selected.category === "residential" ? "Knock on door →" : "Enter this location →")}
                  </button>
                )}
              </div>
            </>
          )}
        </div>

      </div>
    </div>
  );
}
