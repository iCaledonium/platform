import { useState, useEffect, useRef, useMemo } from "react";
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

// The map opens at 13 — the whole city, which is the right first question.
// Picking a specific person or venue out of a panel is a different question,
// so that goes to 16: the block they are on, with enough streets around it to
// place them. Anything closer stops being a map and starts being a rooftop.
const FOCUS_ZOOM = 16;

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

  /* Session 151 — the quiet tier.
     The city used to hold four places, so every one of them could afford a
     black label. Seeded properly it holds eighty-six, and eighty-six labels
     is not a map — it is a wall of names with a street plan somewhere behind
     it. A place with nobody in it is a dot; it says its name when you point
     at it. What has people in it keeps the label, which means the labels on
     screen are exactly the places worth looking at. */
  .anima-pin-quiet { position:relative; }
  /* Empty room: hollow. Somebody in it, ambient or not: filled. */
  .anima-pin-quiet .anima-pin-dot-base {
    width:9px; height:9px; background:rgba(255,255,255,.92);
    border:1.5px solid #9c948a;
    box-shadow:0 1px 3px rgba(0,0,0,.18);
  }
  .anima-pin-quiet.lively .anima-pin-dot-base {
    background:#6f665c; border-color:rgba(255,255,255,.92);
    box-shadow:0 1px 3px rgba(0,0,0,.28);
  }
  .anima-pin-quiet:hover .anima-pin-dot-base { transform:scale(1.35); background:#c9973a; }
  .anima-pin-name {
    position:absolute; bottom:15px; left:50%; transform:translateX(-50%);
    background:#1a1a1a; color:#fff; font-family:'DM Sans',sans-serif;
    font-size:10px; letter-spacing:.02em; padding:3px 8px; border-radius:12px;
    white-space:nowrap; opacity:0; pointer-events:none; transition:opacity .12s;
    border:1.5px solid rgba(255,255,255,0.12);
  }
  .anima-pin-quiet:hover .anima-pin-name { opacity:1; }
  .anima-pin.sel .anima-pin-dot-base { background:#c9973a; transform:scale(1.35); }
  .anima-pin.sel .anima-pin-name { opacity:1; background:#c9973a; }
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
  const [worldTime, setWorldTime] = useState(null);
  const [selected,  setSelected]  = useState(null);
  const [mapReady,  setMapReady]  = useState(false);
  const [spawning,  setSpawning]  = useState(false);
  const [loading,   setLoading]   = useState(true);
  const [sceneData, setSceneData] = useState(null);
  const [sneakData, setSneakData] = useState(null); // {sessionId, location, participants}
  const [selectedActor, setSelectedActor] = useState(null); // for transit panel
  const [selectedAmbient, setSelectedAmbient] = useState(null); // ambient NPC bubble
  const [mapKey,    setMapKey]    = useState(0);

  // ── Session 151 — anchoring the place card to its pin ──────────────────────
  // A bare OverlayView exists purely to borrow the map's projection; it draws
  // nothing. fromLatLngToContainerPixel is the only honest way to turn a
  // lat/lng into a screen position — deriving it from bounds is linear in
  // latitude and Mercator is not, so the card would drift off the pin.
  const projRef  = useRef(null);
  const panelRef = useRef(null);
  const [anchor, setAnchor] = useState(null);
  const [panelH, setPanelH] = useState(320);

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
          if (data.world_time) setWorldTime(data.world_time);
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

  // Session 151 — what the pins actually draw, as a string.
  //
  // Presence polls every 30s and hands back a fresh array every time, so the
  // markers effect below re-ran on identity rather than on change: it tore down
  // every pin and built new ones. OverlayView.setMap() does not run onAdd
  // immediately — it waits for the map's next redraw — so on an idle map every
  // label on the map blinked out for several seconds, twice a minute, and the
  // selected pin lost its highlight while its card stayed open.
  //
  // Compare what is drawn instead of what was allocated. Identical poll, no
  // work at all.
  const locSig = useMemo(() => JSON.stringify(
    locations.map(l => [
      l.id, l.name, l.lat, l.lng, l.category, l.meeting_session_id,
      (l.actors || []).map(a => `${a.actor_id}${a.in_transit ? "t" : ""}`).join(","),
    ])
  ), [locations]);

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
        // Session 151 — a label is for people you would cross the city to see.
        //
        // hasActors counted everyone in the room, and once the world had run for
        // a few hours the ambient cast had filled sixty-one of eighty-six venues
        // with staff and regulars — so every venue earned a label again and the
        // map went back to being a wall of names. Ambient people are what makes
        // a room feel inhabited; they are not news. Cast and players are.
        const cast = (loc.actors || []).filter(a => !a.is_ambient && !a.in_transit);
        const hasActors = cast.length > 0;
        // Somebody is in there, even if it is only the barista: a filled dot
        // rather than a hollow one. Open rooms and empty ones stop looking alike
        // without either of them shouting.
        const lively = (loc.actors || []).length > 0 || (loc.crowd_size || 0) > 0;
        const div = document.createElement("div");
        div.style.cssText = "position:absolute;cursor:pointer;";
        const label = loc.name.length > 18 ? loc.name.slice(0, 17) + "…" : loc.name;
        const shown = cast.slice(0, 3);
        const stackedPhotos = shown.map((a, i) => {
          const pinPhoto = a.generated_portrait_url || (a.photo_url ? resizedPhoto(a.photo_url, 48) : null);
          return pinPhoto
            ? `<img src="${pinPhoto}" style="width:22px;height:22px;border-radius:50%;object-fit:cover;border:1.5px solid rgba(255,255,255,.8);margin-left:${i===0?0:-8}px;z-index:${shown.length-i};position:relative;" onerror="this.style.display='none'" />`
            : `<div style="width:22px;height:22px;border-radius:50%;background:rgba(181,148,90,.3);border:1.5px solid rgba(255,255,255,.8);display:inline-flex;align-items:center;justify-content:center;font-size:9px;color:#1a1814;margin-left:${i===0?0:-8}px;z-index:${shown.length-i};position:relative;">${a.name[0]}</div>`;
        }).join("");
        // Your own front door stays labelled whether or not anyone is home —
        // it is the one address on the map you navigate by.
        const isHome = loc.category === "residential_home";
        div.innerHTML = hasActors || isHome
          ? `
          <div class="anima-pin" style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;">
            <div class="anima-pin-bubble" style="display:flex;flex-direction:row;align-items:center;gap:5px;">
              ${hasActors ? `<div style="display:flex;align-items:center;">${stackedPhotos}</div>` : ""}
              <span class="anima-pin-label">${label}</span>
            </div>
            <div class="anima-pin-stem"></div>
          </div>`
          : `
          <div class="anima-pin anima-pin-quiet${lively ? " lively" : ""}" style="transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;">
            <div class="anima-pin-dot-base"></div>
            <div class="anima-pin-name">${label}</div>
          </div>`;
        div.addEventListener("click", () => this.onSelect(this.loc));
        this.div = div;
        this.getPanes().overlayMouseTarget.appendChild(div);
        if (this._selected) this.setSelected(true);
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
        // Session 151 — the flag lives on the instance, not only on the DOM.
        // setMap() schedules onAdd for the map's next redraw rather than running
        // it now, so a pin rebuilt by a presence refresh has no div yet when the
        // selection is re-applied; onAdd picks the flag up instead.
        this._selected = sel;
        if (!this.div) return;
        // A quiet pin has no bubble to turn gold, so the root carries the state
        // and the dot and its name respond to that instead.
        this.div.querySelector(".anima-pin")?.classList.toggle("sel", sel);
        this.div.querySelector(".anima-pin-bubble")?.classList.toggle("selected", sel);
        this.div.querySelector(".anima-pin-stem")?.classList.toggle("selected", sel);
      }
    }

    locations.forEach(loc => {
      if (!loc.lat || !loc.lng) return;
      const pin = new AnimaPin(loc, selectLocation);
      pin._locId = loc.id;
      // Presence refreshes every 30s, `locations` gets a new identity, and this
      // effect rebuilds every pin from scratch. The gold highlight lived on the
      // old DOM node, so the selected pin quietly went grey while its card
      // stayed open — and once the card is anchored to a pin, losing which pin
      // is worse than it used to be.
      if (selectedRef.current && selectedRef.current.id === loc.id) pin._selected = true;
      pin.setMap(mapInstance.current);
      markers.current.push(pin);
    });
  // locSig, not locations: rebuild when the pins would look different, not
  // every time the poll returns a new array. `locations` is still read inside —
  // when the signature is unchanged the closure's copy is equivalent by
  // definition.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, locSig, mapKey]);

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

  // A projection-only overlay. onAdd/draw are required to exist and are
  // deliberately empty — adding it to the map is what makes getProjection()
  // return something.
  useEffect(() => {
    if (!mapReady || !mapInstance.current || !window.google) return;
    const ov = new window.google.maps.OverlayView();
    ov.onAdd = function () {};
    ov.draw = function () {};
    ov.onRemove = function () {};
    ov.setMap(mapInstance.current);
    projRef.current = ov;
    return () => { try { ov.setMap(null); } catch {} projRef.current = null; };
  }, [mapReady, mapKey]);

  // Recompute the anchor whenever the map moves or the selection changes. A
  // transit actor is anchored to their interpolated position, so the card
  // follows someone walking across town rather than sitting still while they
  // leave it behind.
  useEffect(() => {
    const map = mapInstance.current;
    if (!mapReady || !map || !window.google) return;

    const update = () => {
      const target = selected
        ? { lat: Number(selected.lat), lng: Number(selected.lng) }
        : selectedActor ? getActorPosition(selectedActor) : null;
      const proj = projRef.current?.getProjection();
      if (!target || !proj || !mapRef.current || target.lat == null) { setAnchor(null); return; }
      const pt = proj.fromLatLngToContainerPixel(
        new window.google.maps.LatLng(Number(target.lat), Number(target.lng))
      );
      if (!pt) { setAnchor(null); return; }
      const r = mapRef.current.getBoundingClientRect();
      setAnchor({ x: r.left + pt.x, y: r.top + pt.y });
    };

    update();
    const evs = ["bounds_changed", "center_changed", "zoom_changed", "idle", "drag"];
    const ls = evs.map(e => map.addListener(e, update));
    window.addEventListener("resize", update);
    // Someone in transit keeps moving between map events.
    const t = selectedActor ? setInterval(update, 1000) : null;
    return () => {
      ls.forEach(l => { try { window.google.maps.event.removeListener(l); } catch {} });
      window.removeEventListener("resize", update);
      if (t) clearInterval(t);
    };
  }, [selected, selectedActor, mapReady, mapKey]);

  // Measured, not guessed: the card centres on the pin, and where it cannot
  // (near the top or bottom of the window) the arrow slides to keep pointing.
  useEffect(() => {
    if (panelRef.current) setPanelH(panelRef.current.offsetHeight || 320);
  }, [selected, selectedActor, anchor]);

  // Wire transit actor click to React state
  useEffect(() => {
    window.__selectTransitActor = (actor) => setSelectedActor(actor);
    return () => { delete window.__selectTransitActor; };
  }, []);

  // Session 151 — the same bridge, for the Places instrument.
  //
  // The instrument layer is a sibling of this component, not a child, so it
  // cannot reach selectLocation directly. A window handle is how the transit
  // dots already talk to React here; searching for a venue lands on the same
  // path a click on its pin takes — select the pin, pan to it, open its card —
  // so the two ways of finding a place end in exactly the same state.
  useEffect(() => {
    window.__animaSelectLocation = (loc, opts) => selectLocation(loc, opts);

    // Session 153 — and the same bridge for People.
    //
    // Places could already say "go here"; People had no way to say "go to
    // them", so picking a name lit up the panels and left the map where it
    // was. Where someone is depends on whether they are moving: a walker is a
    // live point on a polyline and has no pin of their own, so the map goes to
    // the interpolated position and their transit card opens. Anyone else is
    // wherever they are standing, which is a place — so that resolves to the
    // ordinary place selection and ends in the same state as clicking its pin,
    // card and all.
    window.__animaFocusActor = (actorId) => {
      if (!actorId) return false;
      for (const l of (locationsRef.current || [])) {
        for (const a of (l.actors || [])) {
          if ((a.actor_id || a.id) !== actorId) continue;
          if (a.in_transit) {
            const pos = getActorPosition(a);
            if (pos) { setSelectedActor(a); focusMap(pos); return true; }
          }
          selectLocation(l, { focus: true });
          return true;
        }
      }
      return false;   // not somewhere the viewer can see — leave the map alone
    };

    return () => {
      delete window.__animaSelectLocation;
      delete window.__animaFocusActor;
    };
  }, []);

  // Session 151 — closing the card is three things, not one: drop the React
  // state, drop the ref the map effects read, and release the pin. Leaving the
  // pin gold with no card attached to it was the failure mode to avoid.
  function closePlace() {
    if (selectedRef.current) {
      markers.current.find(m => m._locId === selectedRef.current.id)?.setSelected(false);
      selectedRef.current = null;
    }
    setSelected(null);
    setSelectedActor(null);
  }

  // Session 153 — centring, and going in close.
  //
  // Panning alone answers "which direction" and not "where": at the city zoom
  // the map opens on, a pin arriving in the middle of the frame is still one
  // dot among eighty-five. Picking a name out of a list is a request to look at
  // something, so the map goes to street level with it.
  //
  // Only ever zooms IN. Someone who has already pushed past this level was
  // reading detail we should not throw away, and a click that yanked them back
  // out would be the map arguing with them.
  function focusMap(pos, zoom = FOCUS_ZOOM) {
    const map = mapInstance.current;
    if (!map || !pos || pos.lat == null || pos.lng == null) return;
    const p = { lat: Number(pos.lat), lng: Number(pos.lng) };
    if (Number.isNaN(p.lat) || Number.isNaN(p.lng)) return;

    const now = map.getZoom() ?? 0;
    const target = Math.max(now, zoom);
    if (target !== now) {
      // Centre and zoom in one move. Done as panTo-then-setZoom they are two
      // animations racing each other across the city: the glide is still in
      // flight when the zoom re-anchors it, and the map crawls to its final
      // position over about five seconds, showing intermediate frames that
      // look like it landed in the wrong place. setOptions applies both at
      // once, so the answer to "where are they" arrives immediately.
      map.setOptions({ center: p, zoom: target });
    } else {
      // Already this close or closer — nothing to zoom, so keep the glide.
      map.panTo(p);
    }
  }

  function selectLocation(loc, opts) {
    if (selectedRef.current) {
      markers.current.find(m => m._locId === selectedRef.current.id)?.setSelected(false);
    }
    markers.current.find(m => m._locId === loc.id)?.setSelected(true);
    selectedRef.current = loc;
    setSelected(loc);
    // A pin click keeps the zoom it had — you are already looking where you
    // clicked. A name picked out of an instrument panel is the case that needs
    // taking there.
    if (opts?.focus) focusMap({ lat: loc.lat, lng: loc.lng });
    else mapInstance.current?.panTo({ lat: Number(loc.lat), lng: Number(loc.lng) });
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

        // Session 152 — find whose door this is, not who happens to be behind it.
        //
        // This asked `a.home_location === locationId` against presence, which
        // has never sent a home_location, so the test could not match and it
        // always fell through to "anyone standing here who isn't me". Fine
        // while Lindsey is home; wrong when a guest is in her flat, and no help
        // at all when she is out — you could not knock on an empty flat because
        // the owner was not standing in it to be found.
        //
        // presence now carries home_place_id, so the search is over everyone in
        // the world rather than everyone in the room, and an empty flat still
        // has an owner. Knocking when she is out is a real thing to do; nobody
        // answering is the answer.
        const locationId = selected.place_id || selected.id;
        const everyone = locations.flatMap(l => l.actors || []);

        const targetActor =
          everyone.find(a => a.actor_id !== playerActorId && a.home_place_id === locationId) ||
          (selected.actors || []).find(a => a.actor_id !== playerActorId);

        if (!targetActor) {
          console.warn("[knock] nobody lives at", locationId);
          return;
        }
        // Session 151 — no onClose() after a navigate.
        //
        // Session 150 redefined onClose from "unmount me" to "go back to home",
        // which is right for the ✕ in the header and wrong here: these two lines
        // ran back to back, so knocking navigated to the encounter and was
        // immediately redirected to /home by the next statement. Both doors in
        // this world have been shut since. Navigating away already leaves the
        // map; there is nothing left to close.
        // The page starts the encounter itself, keyed on whose door it is, so
        // the address survives a reload instead of pointing at an encounter id
        // that expired — or, when the start call failed, at the string
        // "pending".
        navigate(`/world/${world.id}/knock/${targetActor.actor_id}/door`);
      } else {
        sessionStorage.setItem("venueContext", JSON.stringify({
          world:    world,
          user:     user,
          location: selected
        }));
        navigate(`/world/${world.id}/venue/${selected.place_id || selected.id}`);
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

  // Right of the pin by default; left of it when the window edge is closer than
  // the card is wide. With no anchor yet — map still loading — it parks where
  // the column used to be, so nothing jumps on first paint.
  const place = (() => {
    const W = 300, GAP = 22, EDGE = 16, TOP_SAFE = 74;
    if (!anchor || typeof window === "undefined") {
      return { style: { right: EDGE, top: 96 }, flip: true, arrowTop: 40 };
    }
    let left = anchor.x + GAP;
    let flip = false;
    if (left + W > window.innerWidth - EDGE) { left = anchor.x - GAP - W; flip = true; }
    if (left < EDGE) { left = EDGE; }

    const h = Math.min(panelH, window.innerHeight - 140);
    let top = anchor.y - h / 2;
    top = Math.max(TOP_SAFE, Math.min(top, window.innerHeight - h - EDGE));

    return {
      style: { left, top },
      flip,
      arrowTop: Math.max(24, Math.min(anchor.y - top, h - 24)),
    };
  })();

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

        <div
          ref={panelRef}
          className={`${styles.panel} ${selected || selectedActor ? styles.panelVisible : ""}`}
          style={place.style}
        >
          {anchor && (selected || selectedActor) && (
            <span
              className={`${styles.panelArrow} ${place.flip ? styles.panelArrowRight : styles.panelArrowLeft}`}
              style={{ top: place.arrowTop }}
            />
          )}
          {(selected || selectedActor) && (
            <button className={styles.panelClose} onClick={closePlace} aria-label="Close">✕</button>
          )}
          {selectedActor && (
            <div className={styles.panelInner}>
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

                {/* Open/closed. `is_open` is decided by the simulator against
                    the city's clock; null means the venue records no usable
                    hours, and an absent badge is the honest answer there. */}
                {!["residential","residential_home"].includes(selected.category)
                  && selected.is_open != null && (
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,flexWrap:"wrap"}}>
                    <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,fontWeight:500,
                      color: selected.is_open ? "#4caf87" : "#e07070",
                      background: selected.is_open ? "rgba(76,175,135,.12)" : "rgba(224,112,112,.12)",
                      padding:"2px 8px",borderRadius:20}}>
                      {selected.is_open ? "Open" : "Closed"}
                    </span>
                    {selected.hours_today && (
                      <span className={styles.venueHours}>{selected.hours_today}</span>
                    )}
                    {selected.hours_note && (
                      <span className={styles.venueNote}>{selected.hours_note}</span>
                    )}
                  </div>
                )}

                {selected.formatted_address && (
                  <p className={styles.panelAddress}>{selected.formatted_address}</p>
                )}

                <div className={styles.divider} />

                {/* Staff section — ambient actors at this venue */}
                {(() => {
                  const venueOpen2 = selected.is_open !== false;
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

                    {/* Session 151 — order follows the population model: staff hold
                        the room, then the people you can actually walk up to, then
                        the computed crowd. The crowd used to sit above the named
                        visitors, so the one person in the room with a face and a
                        name was listed below five who have neither.

                        The named ambient layer is labelled "Regulars" rather than
                        "Here now", because that is what they are — someone whose
                        being here is a standing arrangement. Once you have actually
                        met one, the label becomes "Acquaintance": the word is
                        earned by the relationship rather than asserted by the UI. */}
                    {visitors.length === 0 ? (
                      <>
                      <p className={styles.sectionLabel}>Here now</p>
                      <p className={styles.emptyState}>
                        {selected.is_open === false
                          ? "Closed right now"
                          : selected.crowd_size > 0
                            ? "Nobody you can approach"
                            : "Nobody here right now"}
                      </p>
                      </>
                    ) : ([
                      { key: "cast",     people: visitors.filter(a => !a.is_ambient) },
                      { key: "regulars", people: visitors.filter(a =>  a.is_ambient) },
                    ]).filter(g => g.people.length > 0).map(g => (
                      <div key={g.key}>
                        <p className={styles.sectionLabel}>
                          {g.key === "cast"
                            ? "Here now"
                            : g.people.every(a => a.knows_player)
                              ? (g.people.length === 1 ? "Acquaintance" : "Acquaintances")
                              : "Regulars"}
                        </p>
                      <div className={styles.actorList}>
                        {g.people.map(a => (
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
                                {a.knows_player && a.is_ambient ? " · you've met" : ""}
                              </p>
                            </div>
                            {a.is_ambient && (
                              <span style={{fontSize:10, color:"#bbb", marginLeft:"auto", paddingLeft:6, flexShrink:0}}>ℹ</span>
                            )}
                          </div>
                        ))}
                      </div>
                      </div>
                    ))}
                    {/* The rule belongs to the crowd block, not to the space
                        above it: a restaurant between lunch and dinner has no
                        crowd at all, and the divider was still drawing — a line
                        under the last person with nothing beneath it. */}
                    {selected.crowd && selected.crowd.length > 0 && (
                      <div className={styles.divider} />
                    )}
                    {selected.crowd && selected.crowd.length > 0 && (() => {
                      const parties = selected.crowd.reduce((groups, person) => {
                        groups[person.party] = groups[person.party] || [];
                        groups[person.party].push(person);
                        return groups;
                      }, {});

                      // Gröna Lund holds ninety-odd people on a Monday
                      // afternoon, which is right for the place and useless as
                      // a list. Show a few groups and count the rest.
                      const keys = Object.keys(parties);
                      const shown = keys.slice(0, 6);
                      const restCount = keys
                        .slice(6)
                        .reduce((n, key) => n + parties[key].length, 0);

                      return (
                        <>
                          <p className={styles.sectionLabel}>
                            Also here · {selected.crowd_size} {selected.crowd_size === 1 ? "person" : "people"}
                          </p>
                          <div className={styles.crowdList}>
                            {shown.map(key => (
                              <p key={key} className={styles.crowdParty}>
                                {parties[key].map(p => `${p.name} (${p.age})`).join(", ")}
                              </p>
                            ))}
                            {restCount > 0 && (
                              <p className={styles.crowdParty} style={{ opacity: .7 }}>
                                and {restCount} more
                              </p>
                            )}
                          </div>
                          <div className={styles.divider} />
                        </>
                      );
                    })()}

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
