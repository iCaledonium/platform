import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import styles from "./WorldEnterOverlay.module.css";
import PlayerHomeScene from "./PlayerHomeScene.jsx";
import SneakScene from "./SneakScene.jsx";

const SIMULATOR_URL = "https://anima.simulator.ngrok.dev";

function resizedPhoto(photoSrc, size = 64) {
  if (!photoSrc) return null;
  const photoPath = photoSrc.startsWith(SIMULATOR_URL) ? photoSrc.replace(SIMULATOR_URL, "") : (photoSrc.startsWith("http") ? null : photoSrc);
  if (!photoPath) return photoSrc;
  return `/api/media/resize?url=${encodeURIComponent(photoPath)}&w=${size}&h=${size}`;
}

function parseHours(operating_hours) {
  // operating_hours format: "09:00-17:00" or null
  if (!operating_hours) return null;
  const parts = operating_hours.split("-");
  if (parts.length !== 2) return null;
  const toMins = t => { const [h,m] = t.split(":").map(Number); return h*60+(m||0); };
  return { open: toMins(parts[0]), close: toMins(parts[1]) };
}

function isVenueOpen(operating_hours) {
  const h = parseHours(operating_hours);
  if (!h) return null; // unknown
  const now = new Date();
  const mins = now.getHours()*60 + now.getMinutes();
  // Handle overnight (e.g. 22:00-04:00)
  if (h.close < h.open) return mins >= h.open || mins < h.close;
  return mins >= h.open && mins < h.close;
}

function formatHours(operating_hours) {
  if (!operating_hours) return null;
  return operating_hours;
}

function decodePolyline(encoded) {
  if (!encoded) return [];
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  const decodeNext = () => {
    let shift = 0, result = 0, byte = 0;
    while (true) {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (byte < 0x20) break;
    }
    return (result & 1) ? ~(result >> 1) : (result >> 1);
  };
  while (index < encoded.length) {
    lat += decodeNext();
    lng += decodeNext();
    coords.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return coords;
}

function interpolatePosition(coords, fraction) {
  if (!coords || coords.length === 0) return null;
  if (fraction <= 0) return coords[0];
  if (fraction >= 1) return coords[coords.length - 1];
  // Calculate total distance
  let totalDist = 0;
  const dists = [];
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot(coords[i].lat - coords[i-1].lat, coords[i].lng - coords[i-1].lng);
    dists.push(d);
    totalDist += d;
  }
  let target = fraction * totalDist;
  for (let i = 0; i < dists.length; i++) {
    if (target <= dists[i]) {
      const t = dists[i] > 0 ? target / dists[i] : 0;
      return {
        lat: coords[i].lat + t * (coords[i+1].lat - coords[i].lat),
        lng: coords[i].lng + t * (coords[i+1].lng - coords[i].lng)
      };
    }
    target -= dists[i];
  }
  return coords[coords.length - 1];
}

function getActorPosition(actor, placesCoords) {
  if (!actor.in_transit || !actor.transit_polyline) return null;
  const coords = decodePolyline(actor.transit_polyline);
  if (coords.length === 0) return null;
  const started = actor.transit_started_at ? new Date(actor.transit_started_at.endsWith('Z') ? actor.transit_started_at : actor.transit_started_at + 'Z').getTime() : null;
  const duration = actor.transit_duration_minutes ? actor.transit_duration_minutes * 60000 : null;
  if (!started || !duration) return null;
  const elapsed = Date.now() - started;
  const fraction = Math.min(1, Math.max(0, elapsed / duration));
  return interpolatePosition(coords, fraction);
}
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
  const navigate = useNavigate();
  const mapRef        = useRef(null);
  const mapInstance   = useRef(null);
  const markers        = useRef([]);
  const transitMarkers = useRef([]);
  const transitTimer   = useRef(null);
  const selectedRef   = useRef(null);

  const spawnLock = useRef(false);

  const [locations, setLocations] = useState([]);
  const locationsRef   = useRef([]);
  const [weather,   setWeather]   = useState(null);
  const [selected,  setSelected]  = useState(null);
  const [mapReady,  setMapReady]  = useState(false);
  const [spawning,  setSpawning]  = useState(false);
  const [loading,   setLoading]   = useState(true);
  const [sceneData, setSceneData] = useState(null);
  const [sneakData, setSneakData] = useState(null); // {sessionId, location, participants}
  const [selectedActor, setSelectedActor] = useState(null); // for transit panel
  const [selectedAmbient, setSelectedAmbient] = useState(null); // ambient NPC bubble
  const [mapKey,    setMapKey]    = useState(0);

  // ── Auto-enter player home — set by VisitorPresenceView on exit, since
  // for knock_user_door the player never actually left home to begin with.
  // Skips the map selection view entirely and drops straight into the
  // same PlayerHomeScene render path used when clicking "Enter your home".
  useEffect(() => {
    const raw = sessionStorage.getItem("pendingHomeScene");
    if (!raw) return;
    sessionStorage.removeItem("pendingHomeScene");
    try {
      const { location } = JSON.parse(raw);
      if (location) setSceneData({ location, mode: "player_home" });
    } catch {}
  }, []);

  // Fetch presence + refresh every 30s
  const loadPresenceRef = useRef(null);
  useEffect(() => {
    const load = () => {
      fetch(`/api/worlds/${world.id}/presence`)
        .then(r => {
          if (!r.ok) throw new Error(`presence ${r.status}`);
          return r.json();
        })
        .then(data => {
          const locs = data.locations || data;
          if (!Array.isArray(locs)) return; // guard against unexpected response shape
          if (data.weather) setWeather(data.weather);
          setLocations(locs);
          setLoading(false);
          // Keep selected panel in sync
          setSelected(prev => {
            if (!prev) return prev;
            const updated = locs.find(l => l.id === prev.id);
            return updated || prev;
          });
        })
        .catch(() => setLoading(false));
    };
    loadPresenceRef.current = load;
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [world.id]);

  // SSE — thought bubbles and transit arrivals
  const [thoughtBubbles, setThoughtBubbles] = useState({});
  useEffect(() => {
    const playerActorId = user?.worlds?.find(w => w.world_id === world.id)?.actor_id;
    if (!playerActorId) return;
    const es = new EventSource(`/api/actors/${playerActorId}/stream`);
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === "thought_bubble") {
          const { actor_id, reason, emotion, intensity, actor_name, target_actor_id, target_name } = payload.data;
          const resolvedName = actor_name ||
            locationsRef.current.flatMap(l => l.actors || []).find(a => a.actor_id === actor_id)?.name ||
            null;
          setThoughtBubbles(prev => {
            const existing = prev[actor_id];
            // Don't replace if current bubble is less than 12 seconds old
            // BUT allow replacement if new intensity is higher (more meaningful action)
            if (existing && Date.now() - existing.ts < 12000 && intensity <= (existing.intensity || 0)) return prev;
            return { ...prev, [actor_id]: { reason, emotion, intensity, ts: Date.now(), actor_name: resolvedName, target_actor_id, target_name } };
          });
          // Auto-clear after 20 seconds
          setTimeout(() => setThoughtBubbles(prev => {
            const next = { ...prev };
            if (next[actor_id]?.ts === prev[actor_id]?.ts) delete next[actor_id];
            return next;
          }), 20000);
        }
        if (payload.type === "transit_arrived") {
          // Force immediate presence reload to snap marker
          if (loadPresenceRef.current) loadPresenceRef.current();
        }
      } catch {}
    };
    es.onerror = () => {};
    return () => es.close();
  }, [world.id, user]);

  const thoughtBubblesRef = useRef({});
  thoughtBubblesRef.current = thoughtBubbles;

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
      center:           { lat: world.lat || 59.334, lng: world.lng || 18.065 },
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
        const label = loc.name.length > 18 ? loc.name.slice(0, 17) + "…" : loc.name;
        const actors = (loc.actors || []).filter(a => !a.in_transit);
        const shown = actors.slice(0, 3);
        const stackedPhotos = shown.map((a, i) => {
          const pinPhoto = a.generated_portrait_url || (a.photo_url ? resizedPhoto(a.photo_url, 48) : null);
          return pinPhoto
            ? `<img src="${pinPhoto}" style="width:22px;height:22px;border-radius:50%;object-fit:cover;border:1.5px solid rgba(255,255,255,.8);margin-left:${i===0?0:-8}px;z-index:${shown.length-i};position:relative;" onerror="this.style.display='none'" />`
            : `<div style="width:22px;height:22px;border-radius:50%;background:rgba(181,148,90,.3);border:1.5px solid rgba(255,255,255,.8);display:inline-flex;align-items:center;justify-content:center;font-size:9px;color:#1a1814;margin-left:${i===0?0:-8}px;z-index:${shown.length-i};position:relative;">${a.name[0]}</div>`;
        }).join("");
        div.innerHTML = `
          <div class="anima-pin" style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;">
            <div class="anima-pin-bubble" style="display:flex;flex-direction:row;align-items:center;gap:5px;">
              ${hasActors ? `<div style="display:flex;align-items:center;">${stackedPhotos}</div>` : ""}
              <span class="anima-pin-label">${label}</span>
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

  // Keep locationsRef current so transit effect can read latest without re-running
  locationsRef.current = locations;
  useEffect(() => {
    if (!mapReady || !mapInstance.current) return;
    if (transitTimer.current) clearInterval(transitTimer.current);

    const getLocations = () => locationsRef.current;
    const placesCoords = {};
    getLocations().forEach(l => {
      if (l.lat && l.lng) {
        placesCoords[l.place_id] = { lat: Number(l.lat), lng: Number(l.lng) };
        placesCoords[l.id] = { lat: Number(l.lat), lng: Number(l.lng) };
      }
    });

    const transitActors = getLocations().flatMap(l => l.actors || []).filter(a => a.in_transit && a.transit_polyline);

    // Create route lines and dots once, then just update dot positions
    const routeLines = [];
    const dots = [];

    transitActors.forEach(actor => {
      // Route line — static, created once
      const coords = decodePolyline(actor.transit_polyline);
      if (coords.length >= 2) {
        const polylinePath = coords.map(c => new window.google.maps.LatLng(c.lat, c.lng));
        const routeLine = new window.google.maps.Polyline({
          path: polylinePath, geodesic: false,
          strokeColor: "#E05252", strokeOpacity: 0.85, strokeWeight: 2.5,
          map: mapInstance.current,
          icons: [{ icon: { path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 2, fillColor: "#E05252", fillOpacity: 1, strokeWeight: 0 }, offset: "100%" }]
        });
        routeLines.push(routeLine);
        transitMarkers.current.push({ setMap: (m) => routeLine.setMap(m) });
      }

      // Transit dot — created once, position updated in-place
      const photoUrl = actor.generated_portrait_url || (actor.photo_url ? resizedPhoto(actor.photo_url, 48) : null);

      // Use factory instead of class to avoid esbuild hoisting issues
      const createTransitDot = () => {
        const overlay = new window.google.maps.OverlayView();
        overlay._pos = null;
        overlay._div = null;
        overlay.onAdd = function() {
          const div = document.createElement("div");
          div.style.cssText = "position:absolute;pointer-events:auto;cursor:pointer;";
          div.innerHTML = `<div style="transform:translate(-50%,-50%);width:32px;height:32px;border-radius:50%;overflow:hidden;border:2px solid rgba(181,148,90,.8);box-shadow:0 0 8px rgba(181,148,90,.4);">
            ${photoUrl
              ? `<img src="${photoUrl}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'" />`
              : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:rgba(181,148,90,.3);font-size:12px;color:white;">${actor.name[0]}</div>`
            }
          </div>`;
          div.addEventListener("click", (e) => {
            e.stopPropagation();
            window.__selectTransitActor && window.__selectTransitActor(actor);
          });
          this._div = div;
          this.getPanes().overlayMouseTarget.appendChild(div);
        };
        overlay.draw = function() {
          const proj = this.getProjection();
          if (!proj || !this._div || !this._pos) return;
          const pt = proj.fromLatLngToDivPixel(new window.google.maps.LatLng(this._pos.lat, this._pos.lng));
          if (pt) { this._div.style.left = pt.x + "px"; this._div.style.top = pt.y + "px"; }
        };
        overlay.updatePos = function(pos) { this._pos = pos; this.draw(); };
        overlay.updateBubble = function(bubble) {
          if (!this._div) return;
          let bub = this._div.querySelector(".thought-bub");
          if (!bubble) { if (bub) bub.remove(); this._lastBubbleTs = null; return; }
          const age = Date.now() - bubble.ts;
          const opacity = age < 16000 ? 1 : Math.max(0, 1 - (age - 16000) / 4000);
          // Only rebuild innerHTML when bubble content changes
          if (!bub || this._lastBubbleTs !== bubble.ts) {
            if (!bub) {
              bub = document.createElement("div");
              bub.className = "thought-bub";
              bub.style.cssText = "position:absolute;bottom:38px;left:50%;transform:translateX(-50%);pointer-events:none;transition:opacity 0.5s;";
              this._div.appendChild(bub);
            }
            this._lastBubbleTs = bubble.ts;
            const isA2A       = !!bubble.target_name;
            const headerLabel = isA2A
              ? `${(bubble.actor_name || '').toUpperCase()} → ${bubble.target_name.toUpperCase()}`
              : bubble.actor_name ? bubble.actor_name.toUpperCase() : null;
            const bg     = isA2A ? 'rgba(8,18,30,0.94)'   : 'rgba(15,12,8,0.92)';
            const border = isA2A ? 'rgba(74,127,165,0.6)'  : 'rgba(181,148,90,0.4)';
            const dot    = isA2A ? 'rgba(74,127,165,0.4)'  : 'rgba(181,148,90,0.3)';
            const emCol  = isA2A ? 'rgba(74,127,165,0.9)'  : 'rgba(181,148,90,0.8)';
            const maxW   = isA2A ? '340px' : '220px';
            bub.innerHTML = `
              <div style="position:relative;background:${bg};border:1px solid ${border};border-radius:12px;padding:6px 10px;max-width:${maxW};min-width:120px;font-family:'DM Sans',sans-serif;font-size:10px;color:rgba(255,255,255,0.9);line-height:1.4;white-space:normal;text-align:left;box-shadow:0 2px 12px rgba(0,0,0,0.4);">
                ${headerLabel ? `<div style="color:#fff;font-size:9px;font-weight:600;margin-bottom:3px;letter-spacing:0.8px;">${headerLabel}</div>` : ''}
                ${!isA2A ? `<div style="color:${emCol};font-size:9px;margin-bottom:2px;text-transform:capitalize;letter-spacing:0.5px;">${bubble.emotion}</div>` : ''}
                <div style="color:rgba(255,255,255,${isA2A ? '0.88' : '0.9'});">${bubble.reason}</div>
                <div style="position:absolute;bottom:-10px;left:50%;transform:translateX(-50%);display:flex;gap:2px;">
                  <div style="width:5px;height:5px;border-radius:50%;background:${bg};border:1px solid ${dot};"></div>
                  <div style="width:3px;height:3px;border-radius:50%;background:${bg};border:1px solid ${dot};margin-top:3px;"></div>
                </div>
              </div>`;
          }
          bub.style.opacity = opacity;
        };
        overlay.onRemove = function() { if (this._div?.parentNode) this._div.parentNode.removeChild(this._div); this._div = null; };
        return overlay;
      };

      const dot = createTransitDot();
      const initialPos = getActorPosition(actor, placesCoords);
      if (initialPos) { dot._pos = initialPos; }
      dot.setMap(mapInstance.current);
      dots.push({ dot, actor });
      transitMarkers.current.push(dot);
    });

    const updatePositions = () => {
      dots.forEach(({ dot, actor }) => {
        const pos = getActorPosition(actor, placesCoords);
        if (pos) dot.updatePos(pos);
        const bubble = thoughtBubblesRef.current[actor.actor_id] || null;
        dot.updateBubble(bubble);
      });
    };

    if (transitActors.length > 0) {
      transitTimer.current = setInterval(updatePositions, 1000);
    }

    return () => {
      if (transitTimer.current) { clearInterval(transitTimer.current); transitTimer.current = null; }
      transitMarkers.current.forEach(m => { try { m.setMap(null); } catch(e) {} });
      transitMarkers.current = [];
    };
  }, [mapReady, locations, mapKey]);

  // Update thought bubbles on static markers whenever thoughtBubbles state changes
  useEffect(() => {
    markers.current.forEach(pin => {
      if (!pin.div || !pin.loc) return;
      const actors = (pin.loc.actors || []).filter(a => !a.in_transit);
      const bubble = actors.reduce((found, a) => found || thoughtBubbles[a.actor_id] || null, null);
      let bub = pin.div.querySelector(".thought-bub-static");
      if (!bubble) { if (bub) bub.remove(); pin._lastBubbleTs = null; return; }
      const age = Date.now() - bubble.ts;
      const opacity = age < 16000 ? 1 : Math.max(0, 1 - (age - 16000) / 4000);
      // Only rebuild when content changes
      if (!bub || pin._lastBubbleTs !== bubble.ts) {
        if (!bub) {
          bub = document.createElement("div");
          bub.className = "thought-bub-static";
          bub.style.cssText = "position:absolute;bottom:calc(100% + 4px);left:50%;transform:translateX(-50%);pointer-events:none;z-index:10;transition:opacity 0.5s;";
          pin.div.querySelector(".anima-pin")?.appendChild(bub);
        }
        pin._lastBubbleTs = bubble.ts;
        const isA2A       = !!bubble.target_name;
        const headerLabel = isA2A
          ? `${(bubble.actor_name || '').toUpperCase()} → ${bubble.target_name.toUpperCase()}`
          : bubble.actor_name ? bubble.actor_name.toUpperCase() : null;
        const bg     = isA2A ? 'rgba(8,18,30,0.94)'   : 'rgba(15,12,8,0.92)';
        const border = isA2A ? 'rgba(74,127,165,0.6)'  : 'rgba(181,148,90,0.4)';
        const dot    = isA2A ? 'rgba(74,127,165,0.4)'  : 'rgba(181,148,90,0.3)';
        const emCol  = isA2A ? 'rgba(74,127,165,0.9)'  : 'rgba(181,148,90,0.8)';
        const maxW   = isA2A ? '340px' : '220px';
        bub.innerHTML = `
          <div style="position:relative;background:${bg};border:1px solid ${border};border-radius:12px;padding:6px 10px;max-width:${maxW};min-width:120px;font-family:'DM Sans',sans-serif;font-size:10px;color:rgba(255,255,255,0.9);line-height:1.4;white-space:normal;text-align:left;box-shadow:0 2px 12px rgba(0,0,0,0.4);">
            ${headerLabel ? `<div style="color:#fff;font-size:9px;font-weight:600;margin-bottom:3px;letter-spacing:0.8px;">${headerLabel}</div>` : ''}
            ${!isA2A ? `<div style="color:${emCol};font-size:9px;margin-bottom:2px;text-transform:capitalize;letter-spacing:0.5px;">${bubble.emotion}</div>` : ''}
            <div style="color:rgba(255,255,255,${isA2A ? '0.88' : '0.9'});">${bubble.reason}</div>
            <div style="position:absolute;bottom:-10px;left:50%;transform:translateX(-50%);display:flex;gap:2px;">
              <div style="width:5px;height:5px;border-radius:50%;background:${bg};border:1px solid ${dot};"></div>
              <div style="width:3px;height:3px;border-radius:50%;background:${bg};border:1px solid ${dot};margin-top:3px;"></div>
            </div>
          </div>`;
      }
      bub.style.opacity = opacity;
    });
  }, [thoughtBubbles]);

  // Wire transit actor click to React state
  useEffect(() => {
    window.__selectTransitActor = (actor) => setSelectedActor(actor);
    return () => { delete window.__selectTransitActor; };
  }, []);

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
    if (!selected || spawning || spawnLock.current) return;
    spawnLock.current = true;
    setSpawning(true);
    try {
      const playerActorId = user?.worlds?.find(w => w.world_id === world.id)?.actor_id;

      await fetch(`/api/worlds/${world.id}/spawn`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ location_id: selected.place_id || selected.id }),
      });

      // Check if this is the player's own home
      // Route to PlayerHomeScene if residential_home and player is present (or no one is — it's their home)
      console.log("[home check] category:", selected.category, "actors:", selected.actors?.map(a=>a.actor_id), "playerActorId:", playerActorId);
      const isPlayerHome = selected.category === "residential_home" &&
        (selected.actors?.length === 0 || selected.actors?.some(a => a.actor_id === playerActorId));
      if (isPlayerHome) {
        setSceneData({ location: selected, mode: "player_home" });
        setSpawning(false);
        spawnLock.current = false;
        return;
      }

      if (selected.category === "residential") {
        await new Promise(r => setTimeout(r, 1200));
        let encounter_id = null;

        // Find the target actor — never the player themselves
        const locationId = selected.place_id || selected.id;
        const targetActor = selected.actors && (
          selected.actors.find(a => a.actor_id !== playerActorId && a.home_location === locationId) ||
          selected.actors.find(a => a.actor_id !== playerActorId)
        );

        if (targetActor) {
          const encResp = await fetch(`/api/worlds/${world.id}/encounter/start`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
              target_actor_id: targetActor.actor_id,
              player_actor_id: playerActorId,
              location_id:     selected.place_id || selected.id,
              trigger:         "knock"
            })
          });
          const encData = await encResp.json();
          encounter_id = encData.encounter_id;
        }
        // Store everything in sessionStorage — no API needed in encounter page
        sessionStorage.setItem("encounterContext", JSON.stringify({
          world:      world,
          user:       user,
          sceneData:  { location: selected, encounter_id, trigger: "knock", mode: "scene" }
        }));
        navigate(`/encounter/knock/${encounter_id || "pending"}`);
        onClose();
      } else {
        sessionStorage.setItem("venueContext", JSON.stringify({
          world:    world,
          user:     user,
          location: selected
        }));
        navigate(`/encounter/venue/${world.id}/${selected.place_id || selected.id}`);
        onClose();
      }
    } catch (e) {
      console.error("Spawn failed", e);
    } finally {
      setSpawning(false);
      spawnLock.current = false;
    }
  }

  // Sneak mode — observing an actor↔actor meeting
  if (sneakData) {
    return (
      <SneakScene
        world={world}
        user={user}
        location={sneakData.location}
        sessionId={sneakData.sessionId}
        participants={sneakData.participants}
        onLeave={() => {
          setSneakData(null);
          mapInstance.current = null;
          setMapKey(k => k + 1);
          if (loadPresenceRef.current) loadPresenceRef.current();
        }}
      />
    );
  }

  // If scene is active render it instead of map (player_home only)
  // knock and venue scenes now have their own routes → /encounter/knock/:id and /encounter/venue/:wid/:lid
  if (sceneData && sceneData.mode === "player_home") {
    const onLeave = () => {
      mapInstance.current = null;
      setSceneData(null);
      setMapKey(k => k + 1);
      if (loadPresenceRef.current) loadPresenceRef.current();
    };
    return (
      <PlayerHomeScene
        world={world}
        user={user}
        location={sceneData.location}
        onLeave={onLeave}
      />
    );
  }

  const worldTime = new Date().toLocaleTimeString("sv-SE", {
    hour: "2-digit", minute: "2-digit", timeZone: world?.timezone || "Europe/Stockholm",
  });

  return (
    <>
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

        <div key={mapKey} className={styles.mapWrap} style={{position:"relative"}}>
          {loading && (
            <div className={styles.mapLoading}>
              <span className={styles.mapLoadingText}>Loading world…</span>
            </div>
          )}
          <div ref={mapRef} className={styles.map} />
          {weather && weather !== "weather disabled" && (
            <div style={{
              position:"absolute", top:12, left:12, zIndex:10,
              background:"rgba(255,255,255,0.92)", backdropFilter:"blur(8px)",
              borderRadius:10, padding:"6px 12px",
              fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12,
              color:"#4a4744", boxShadow:"0 2px 8px rgba(0,0,0,.12)",
              display:"flex", alignItems:"center", gap:6
            }}>
              {weather !== "fetching…" && (
                <span style={{fontSize:14}}>
                  {weather.includes("Rain") || weather.includes("Drizzle") ? "🌧" :
                   weather.includes("Cloud") ? "☁️" :
                   weather.includes("Snow") ? "❄️" :
                   weather.includes("Thunder") ? "⛈" : "☀️"}
                </span>
              )}
              <span style={{
                color: weather === "fetching…" ? "#a8a5a0" : "#4a4744",
                fontStyle: weather === "fetching…" ? "italic" : "normal"
              }}>{weather}</span>
            </div>
          )}
        </div>

        <div className={`${styles.panel} ${selected || selectedActor ? styles.panelVisible : ""}`}>
          {selectedActor && (
            <div className={styles.panelInner}>
              <button className={styles.panelClose} onClick={() => setSelectedActor(null)}>✕</button>
              <div className={styles.panelMeta}>
                <span className={styles.panelType}>In transit</span>
              </div>
              <h2 className={styles.panelName}>{selectedActor.name}</h2>
              <p className={styles.panelAddress}>{selectedActor.occupation}</p>
              <div className={styles.divider} />
              <p className={styles.sectionLabel}>Heading to</p>
              <p className={styles.actorName}>
                {(() => {
                  const dest = locationsRef.current.find(l => l.place_id === selectedActor.transit_destination || l.id === selectedActor.transit_destination);
                  return dest ? dest.name : selectedActor.transit_destination || "—";
                })()}
              </p>
              <p className={styles.sectionLabel}>Vehicle</p>
              <p className={styles.actorName}>
                {selectedActor.vehicle
                  ? `${selectedActor.vehicle.color || ""} ${selectedActor.vehicle.make || ""} ${selectedActor.vehicle.model || ""}`.trim()
                  : "No vehicle data"}
              </p>
              {selectedActor.transit_duration_minutes && selectedActor.transit_started_at && (() => {
                const started = new Date((selectedActor.transit_started_at.endsWith("Z") ? selectedActor.transit_started_at : selectedActor.transit_started_at + "Z")).getTime();
                const elapsed = Math.floor((Date.now() - started) / 60000);
                const remaining = Math.max(0, selectedActor.transit_duration_minutes - elapsed);
                return <p className={styles.actorStatus}>{remaining} min remaining</p>;
              })()}
            </div>
          )}
          {!selectedActor && selected && (
            <>
              <div className={styles.panelInner}>
                <div className={styles.panelMeta}>
                  <span className={styles.panelType}>{selected.category}</span>
                  {selected.area && <span className={styles.panelArea}>{selected.area}</span>}
                </div>
                <h2 className={styles.panelName}>{selected.name}</h2>

                {/* Open/closed + hours — server-filtered ambient staff = open */}
                {!["residential","residential_home"].includes(selected.category) && (() => {
                  const hasStaff = selected.actors.some(a => a.is_ambient && a.is_staff); // staff specifically
                  const venueOpen = selected.actors.some(a => a.is_ambient) || !selected.operating_hours;
                  const hours = formatHours(selected.operating_hours);
                  const showBadge = selected.operating_hours != null;
                  return (
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                      {showBadge && (
                        <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,fontWeight:500,
                          color: venueOpen ? "#4caf87" : "#e07070",
                          background: venueOpen ? "rgba(76,175,135,.12)" : "rgba(224,112,112,.12)",
                          padding:"2px 8px",borderRadius:20}}>
                          {venueOpen ? "Open" : "Closed"}
                        </span>
                      )}
                      {hours && <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"rgba(255,255,255,.35)"}}>{hours}</span>}
                    </div>
                  );
                })()}

                {selected.formatted_address && (
                  <p className={styles.panelAddress}>{selected.formatted_address}</p>
                )}

                <div className={styles.divider} />

                {/* Staff section — ambient actors at this venue */}
                {(() => {
                  const venueOpen2 = selected.actors.some(a => a.is_ambient) || !selected.operating_hours;
                  const staff = selected.actors.filter(a => a.is_ambient && a.is_staff);
                  // Only show ambient visitors when open — real actors always shown
                  const visitors = selected.actors.filter(a => {
                    if (!a.is_ambient) return true;
                    if (a.is_staff) return false;
                    return venueOpen2;
                  });
                  const isResidential = ["residential","residential_home"].includes(selected.category);

                  return (<>
                    {!isResidential && staff.length > 0 && venueOpen2 && (
                      <>
                        <p className={styles.sectionLabel}>Staff</p>
                        <div className={styles.actorList}>
                        {staff.map(a => (
                            <div key={a.actor_id} className={styles.actorRow}
                              onClick={() => a.is_ambient ? setSelectedAmbient(a) : null}
                              style={a.is_ambient ? {cursor:"pointer"} : {}}>
                              <div className={styles.actorAvWrap}>
                                {a.generated_portrait_url
                                  ? <img src={a.generated_portrait_url} className={styles.actorPhoto} alt={a.name}
                                      onError={e => { e.target.style.display = "none"; e.target.nextSibling.style.display = "flex"; }} />
                                  : null}
                                <div className={styles.actorInitial} style={{ display: a.generated_portrait_url ? "none" : "flex" }}>{a.name[0]}</div>
                              </div>
                              <div className={styles.actorInfo}>
                                <p className={styles.actorName}>{a.name}</p>
                                <p className={styles.actorStatus}>{a.occupation || "—"}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                        {visitors.length > 0 && <div className={styles.divider} />}
                      </>
                    )}

                    <p className={styles.sectionLabel}>Here now</p>
                    {visitors.length === 0 ? (
                      <p className={styles.emptyState}>
                        {!venueOpen2 && selected.operating_hours ? "Closed right now" : "Nobody here right now"}
                      </p>
                    ) : (
                      <div className={styles.actorList}>
                        {visitors.map(a => (
                          <div key={a.actor_id} className={styles.actorRow}
                            onClick={() => a.is_ambient ? setSelectedAmbient(a) : null}
                            style={a.is_ambient ? {cursor:"pointer"} : {}}>
                            <div className={styles.actorAvWrap}>
                              {(a.generated_portrait_url || a.photo_url)
                                ? <img
                                    src={a.generated_portrait_url || resizedPhoto(a.photo_url, 64)}
                                    className={styles.actorPhoto}
                                    onError={e => { e.target.style.display = "none"; e.target.nextSibling.style.display = "flex"; }}
                                  />
                                : null}
                              <div className={styles.actorInitial} style={{ display: (a.generated_portrait_url || a.photo_url) ? "none" : "flex" }}>
                                {a.name[0]}
                              </div>
                            </div>
                            <div className={styles.actorInfo}>
                              <p className={styles.actorName}>{a.actor_id === user?.worlds?.find(w => w.world_id === world.id)?.actor_id ? "You" : a.name}</p>
                              <p className={styles.actorStatus}>
                                {a.in_transit ? "In transit" : a.activity_slug ? a.activity_slug.replace(/_/g, " ") : a.occupation || "—"}
                              </p>
                            </div>
                            {a.is_ambient && (
                              <span style={{fontSize:10, color:"#bbb", marginLeft:"auto", paddingLeft:6, flexShrink:0}}>ℹ</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </>);
                })()}
              </div>

              <div className={styles.panelFooter}>
                {selected.meeting_session_id && (
                  <button
                    className={styles.spawnBtn}
                    style={{ marginBottom: 8, background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.6)", border: "0.5px solid rgba(255,255,255,0.15)" }}
                    onClick={() => {
                      const ACTOR_COLORS = ["#c98a74", "#7aa4cc", "#8fbb8f", "#b89acc", "#c4b97a"];
                      const participants = (selected.actors || [])
                        .filter(a => !a.is_ambient)
                        .map((a, i) => ({
                          name:      a.name,
                          initials:  a.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase(),
                          color:     ACTOR_COLORS[i % ACTOR_COLORS.length],
                          photo_url: a.generated_portrait_url || (a.photo_url ? resizedPhoto(a.photo_url, 64) : null),
                        }));
                      setSneakData({
                        sessionId:    selected.meeting_session_id,
                        location:     selected,
                        participants,
                      });
                    }}
                  >
                    Observe →
                  </button>
                )}
                {selected.category === "residential" && selected.actors.length > 0 && !selected.actors.some(a => a.knows_player) ? (
                  <p className={styles.emptyState}>You don't know anyone here</p>
                ) : (
                  <button
                    className={styles.spawnBtn}
                    onClick={handleSpawn}
                    disabled={spawning}
                  >
                    {spawning
                      ? (selected.category === "residential_home" ? "Entering…" : selected.category === "residential" ? "Knocking…" : "Entering…")
                      : (selected.category === "residential_home" ? "Enter your home →" : selected.category === "residential" ? "Knock on door →" : "Enter this location →")}
                  </button>
                )}
              </div>
            </>
          )}
        </div>

      </div>
    </div>

    {/* Ambient NPC info bubble */}
    {selectedAmbient && (
      <div onClick={() => setSelectedAmbient(null)}
        style={{position:"fixed",inset:0,zIndex:1100,display:"flex",alignItems:"center",justifyContent:"center",padding:24,background:"rgba(0,0,0,.4)"}}>
        <div onClick={e => e.stopPropagation()}
          style={{background:"#fff",borderRadius:16,padding:24,maxWidth:320,width:"100%",boxShadow:"0 16px 48px rgba(0,0,0,.18)",fontFamily:"'DM Sans',system-ui,sans-serif"}}>

          {/* Header */}
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
            <div style={{width:44,height:44,borderRadius:"50%",background:"#f0ece4",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:600,color:"#8a7a60",flexShrink:0}}>
              {selectedAmbient.name[0]}
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:15,fontWeight:500,color:"#1a1814"}}>{selectedAmbient.name}{selectedAmbient.age ? `, ${selectedAmbient.age}` : ""}</div>
              <div style={{fontSize:12,color:"#a8a5a0",marginTop:2}}>{selectedAmbient.occupation}</div>
            </div>
            <span style={{fontSize:10,padding:"3px 8px",borderRadius:20,background: selectedAmbient.is_staff ? "#f0ece4" : "#f5f5f5",color: selectedAmbient.is_staff ? "#8a7a60" : "#aaa",fontWeight:500}}>
              {selectedAmbient.is_staff ? "Works here" : "Regular"}
            </span>
          </div>

          {/* Psychology */}
          {selectedAmbient.psychology && (
            <div style={{borderTop:"1px solid #f0ece4",paddingTop:14,display:"flex",flexDirection:"column",gap:8}}>
              {selectedAmbient.psychology.social_style && (
                <p style={{margin:0,fontSize:13,color:"#4a4744",lineHeight:1.5}}>
                  {selectedAmbient.psychology.social_style}
                </p>
              )}
              {selectedAmbient.psychology.note && (
                <p style={{margin:0,fontSize:12,color:"#a8a5a0",lineHeight:1.5,fontStyle:"italic"}}>
                  {selectedAmbient.psychology.note}
                </p>
              )}
            </div>
          )}

          <button onClick={() => setSelectedAmbient(null)}
            style={{marginTop:18,width:"100%",padding:"9px 0",borderRadius:10,border:"1px solid #ede9e3",background:"none",fontSize:12,color:"#a8a5a0",cursor:"pointer",fontFamily:"'DM Sans',system-ui,sans-serif"}}>
            Close
          </button>
        </div>
      </div>
    )}
    </>
  );
}
