import { useState, useEffect, useRef } from "react";

const SIMULATOR_URL   = "https://anima.simulator.ngrok.dev";
const ROTATION_MS     = 8000;
const TRANSITION_MS   = 2000;

export default function VenueScene({ world, user, location, onLeave }) {
  const [photos,  setPhotos]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState(0);
  const [entered,  setEntered]  = useState(false);
  const [actors,  setActors]  = useState(location.actors || []);
  const [leaving, setLeaving] = useState(false);
  const [toasts,  setToasts]  = useState([]);
  const [clock,   setClock]   = useState(stockholmTime());
  const dwellRef              = useRef(0);
  const [dwell,   setDwell]   = useState("0:00");
  const rotateRef             = useRef(null);
  const esRef                 = useRef(null);

  // Fetch + preload all photos
  useEffect(() => {
    fetch(`/api/places/${location.place_id || location.id}/photos`)
      .then(r => r.ok ? r.json() : { photos: [] })
      .then(data => {
        const list = data.photos || [];
        setPhotos(list);
        setLoading(false);
        setTimeout(() => setEntered(true), 50);
        if (list.length > 1) {
          let loaded = 0;
          list.forEach(p => {
            const img = new Image();
            img.onload = img.onerror = () => {
              loaded++;
              if (loaded === list.length) startRotation(list.length);
            };
            img.src = SIMULATOR_URL + p;
          });
        }
      })
      .catch(() => setLoading(false));

    function startRotation(total) {
      rotateRef.current = setInterval(() => {
        setCurrent(c => (c + 1) % total);
      }, ROTATION_MS);
    }

    return () => clearInterval(rotateRef.current);
  }, [location.place_id, location.id]);

  // Clock
  useEffect(() => {
    const t = setInterval(() => setClock(stockholmTime()), 10000);
    return () => clearInterval(t);
  }, []);

  // Dwell
  useEffect(() => {
    const t = setInterval(() => {
      dwellRef.current++;
      const m = Math.floor(dwellRef.current / 60);
      const s = dwellRef.current % 60;
      setDwell(`${m}:${String(s).padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Presence poll — first fetch sets baseline, subsequent diffs detect arrivals
  const knownActorIdsRef = useRef(null); // null = not yet initialised

  useEffect(() => {
    const poll = () => {
      fetch(`/api/worlds/${world.id}/presence`)
        .then(r => r.ok ? r.json() : [])
        .then(data => {
          const loc = data.find(l => l.id === location.id || l.place_id === location.place_id);
          if (!loc) { console.log('[VenueScene] loc not found, looking for:', location.id, location.place_id, 'in', data.map(l=>l.place_id)); return; }
          const current = loc.actors || [];
          const currentIds = new Set(current.map(a => a.actor_id));

          console.log("[VenueScene] poll loc found:", loc?.name, "actors:", current.map(a=>a.actor_id), "known:", knownActorIdsRef.current === null ? "null" : [...knownActorIdsRef.current]);
          if (knownActorIdsRef.current === null) {
            console.log("[VenueScene] baseline set:", [...currentIds]);
            knownActorIdsRef.current = currentIds;
          } else {
            // Subsequent polls — diff for arrivals
            current.forEach(a => {
              if (!knownActorIdsRef.current.has(a.actor_id)) {
                console.log("[VenueScene] NEW ARRIVAL:", a.actor_id, a.name);
                const toastId = crypto.randomUUID();
                setToasts(prev => [...prev, { ...a, toastId }]);
                setTimeout(() => setToasts(prev => prev.filter(t => t.toastId !== toastId)), 12000);
              }
            });
            knownActorIdsRef.current = currentIds;
          }
          setActors(current);
        })
        .catch(() => {});
    };
    // First poll immediately on mount to set baseline
    poll();
    const t = setInterval(poll, 15000);
    return () => clearInterval(t);
  }, [world.id, location.id, location.place_id]);

  // SSE — open once on mount, never close/reopen on re-render
  useEffect(() => {
    const playerActorId = user?.worlds?.find(w => w.world_id === world.id)?.actor_id;
    if (!playerActorId || esRef.current) return;
    const es = new EventSource(`/api/actors/${playerActorId}/stream`);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "venue_event" && data.data?.type === "actor_arrived") {
          const arrival = data.data;
          const toastId = crypto.randomUUID();
          setToasts(prev => [...prev, { ...arrival, toastId }]);
          setTimeout(() => setToasts(prev => prev.filter(t => t.toastId !== toastId)), 12000);
        }
      } catch {}
    };
    return () => { if (esRef.current) { esRef.current.close(); esRef.current = null; } };
  }, []);

  function dismissToast(toastId) {
    setToasts(prev => prev.filter(t => t.toastId !== toastId));
  }

  async function leave() {
    if (leaving) return;
    setLeaving(true);
    try { await fetch(`/api/worlds/${world.id}/leave`, { method: "POST" }); } catch {}
    onLeave();
  }

  const glass     = { background: "rgba(238,236,234,0.82)", backdropFilter: "blur(28px)", WebkitBackdropFilter: "blur(28px)", border: "1px solid rgba(255,255,255,0.7)" };
  const glassDark = { background: "rgba(20,18,16,0.62)",   backdropFilter: "blur(28px)", WebkitBackdropFilter: "blur(28px)", border: "1px solid rgba(255,255,255,0.1)" };

  if (loading) {
    return (
      <div style={{ fontFamily: "'DM Sans',system-ui,sans-serif", position: "fixed", inset: 0, zIndex: 1000, background: "#1a1814", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <div style={{ width: 28, height: 28, border: "2px solid rgba(255,255,255,0.15)", borderTopColor: "#c9973a", borderRadius: "50%", animation: "spin .8s linear infinite" }} />
        <p style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 22, color: "rgba(255,255,255,0.8)", letterSpacing: ".02em", margin: 0 }}>
          Entering {location.name}
        </p>
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", letterSpacing: ".08em", margin: 0 }}>fetching photos…</p>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'DM Sans',system-ui,sans-serif", position: "fixed", inset: 0, zIndex: 1000, overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap');
        .venue-actor-row:hover { background: rgba(255,255,255,0.15) !important; }
        .venue-leave-btn:hover { background: rgba(255,255,255,0.08) !important; }
      `}</style>

      {/* ── Always-opaque base ── */}
      <div style={{ position: "absolute", inset: 0, background: "#1a1814", zIndex: 0 }} />

      {/* ── All photos stacked — CSS opacity crossfade ── */}
      {photos.map((p, i) => (
        <img
          key={p}
          src={SIMULATOR_URL + p}
          style={{
            position: "absolute", inset: 0,
            width: "100%", height: "100%",
            objectFit: "cover", objectPosition: "center",
            opacity: i === current ? (entered ? 1 : 0) : 0,
            transition: `opacity ${TRANSITION_MS}ms ease-in-out`,
            zIndex: i === current ? 2 : 1,
          }}
          alt=""
        />
      ))}

      {/* ── Top bar ── */}
      <div style={{ ...glass, position: "absolute", top: 0, left: 0, right: 0, height: 52, zIndex: 10, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px", borderLeft: "none", borderRight: "none", borderTop: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>

          <span style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 20, fontWeight: 500, color: "#1a1814", letterSpacing: ".01em" }}>{location.name}</span>
          {location.area && <span style={{ fontSize: 11, color: "#a8a5a0", letterSpacing: ".03em", marginTop: 2 }}>{location.area}</span>}
        </div>
        <span style={{ fontSize: 13, fontWeight: 500, color: "#1a1814", letterSpacing: ".05em", fontVariantNumeric: "tabular-nums" }}>{clock}</span>
      </div>

      {/* ── Right panel ── */}
      <div style={{ ...glass, position: "absolute", top: 64, right: 16, bottom: 68, width: 200, zIndex: 10, borderRadius: 12, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "12px 14px 8px", borderBottom: "1px solid rgba(0,0,0,0.07)" }}>
          <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: ".1em", color: "#a8a5a0", textTransform: "uppercase" }}>Here now</span>
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {actors.length === 0
            ? <p style={{ fontSize: 11, color: "#a8a5a0", padding: "16px 14px", margin: 0 }}>Nobody here right now</p>
            : actors.map(a => <ActorRow key={a.actor_id} actor={a} playerActorId={user?.worlds?.find(w => w.world_id === world.id)?.actor_id} onReachOut={(a) => alert("Reach out to " + a.name + " — encounter flow coming next")} />)
          }
        </div>
        {photos.length > 1 && (
          <div style={{ padding: "8px 14px", borderTop: "1px solid rgba(0,0,0,0.07)", display: "flex", gap: 4 }}>
            {photos.map((_, i) => (
              <div key={i} style={{ flex: 1, height: 2, borderRadius: 1, background: i === current ? "#b05c08" : "rgba(0,0,0,0.12)", transition: "background .4s" }} />
            ))}
          </div>
        )}
      </div>

      {/* ── Arrival toasts ── */}
      {toasts.map((toast, i) => (
        <div key={toast.toastId} style={{
          position: "absolute", top: 64 + i * 76, left: "50%",
          transform: "translateX(-50%)",
          zIndex: 20,
          background: "rgba(238,236,234,0.92)",
          backdropFilter: "blur(28px)", WebkitBackdropFilter: "blur(28px)",
          border: "1px solid rgba(255,255,255,0.8)",
          borderRadius: 20, padding: "10px 16px 10px 12px",
          display: "flex", alignItems: "center", gap: 10,
          whiteSpace: "nowrap",
        }}>
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: "rgba(0,0,0,0.1)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden", border: "1.5px solid rgba(0,0,0,0.08)" }}>
            {toast.photo_url
              ? <img src={SIMULATOR_URL + toast.photo_url} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="" />
              : <span style={{ fontSize: 12, fontWeight: 500, color: "#1a1814" }}>{toast.name?.[0]}</span>
            }
          </div>
          <span style={{ fontSize: 12, fontWeight: 500, color: "#1a1814" }}>{toast.name} just arrived</span>
          <div style={{ display: "flex", gap: 6, marginLeft: 8 }}>
            <button onClick={() => alert("Reach out to " + toast.name + " — encounter flow coming next")} style={{ background: "#1a1814", border: "none", borderRadius: 12, padding: "5px 12px", fontSize: 11, fontWeight: 500, color: "#fff", cursor: "pointer", fontFamily: "inherit" }}>
              Reach out
            </button>
            <button onClick={() => dismissToast(toast.toastId)} style={{ background: "rgba(0,0,0,0.06)", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 12, padding: "5px 12px", fontSize: 11, color: "#6b6760", cursor: "pointer", fontFamily: "inherit" }}>
              Ignore
            </button>
          </div>
        </div>
      ))}

      {/* ── Bottom strip ── */}
      <div style={{ ...glassDark, position: "absolute", bottom: 0, left: 0, right: 0, height: 60, zIndex: 10, display: "flex", alignItems: "center", borderLeft: "none", borderRight: "none", borderBottom: "none", borderRadius: 0 }}>

        <button className="venue-leave-btn" onClick={leave} disabled={leaving} style={{ flexShrink: 0, height: "100%", padding: "0 20px", background: "none", border: "none", borderRight: "1px solid rgba(255,255,255,0.08)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "rgba(255,255,255,0.65)", fontFamily: "inherit", fontSize: 12, letterSpacing: ".04em", transition: "background .15s" }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2H12V12H9M6 4.5L3 7L6 9.5M3 7H10" stroke="rgba(255,255,255,0.65)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          {leaving ? "Leaving…" : "Leave"}
        </button>
        <div style={{ flex: 1, padding: "0 18px" }}>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", fontStyle: "italic", margin: 0 }}>
            {actors.length > 0
              ? `${actors[0].name} is ${actors[0].activity_slug?.replace(/_/g, " ") || "here"}`
              : "The venue is quiet"}
          </p>
        </div>
        <div style={{ flexShrink: 0, padding: "0 20px", borderLeft: "1px solid rgba(255,255,255,0.08)", textAlign: "center" }}>
          <p style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", letterSpacing: ".08em", textTransform: "uppercase", margin: "0 0 2px" }}>At venue</p>
          <p style={{ fontSize: 13, fontWeight: 500, color: "rgba(255,255,255,0.7)", fontVariantNumeric: "tabular-nums", margin: 0 }}>{dwell}</p>
        </div>
      </div>

    </div>
  );
}

function ActorRow({ actor, onReachOut, playerActorId }) {
  const [hover, setHover] = useState(false);
  const photoUrl = actor.photo_url ? `${SIMULATOR_URL}${actor.photo_url}` : null;
  return (
    <div
      className="venue-actor-row"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 14px", transition: "background .12s", position: "relative" }}
    >
      <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: "50%", overflow: "hidden", border: "1.5px solid rgba(255,255,255,0.4)", background: "rgba(0,0,0,0.1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {photoUrl
          ? <img src={photoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="" />
          : <span style={{ fontSize: 11, fontWeight: 500, color: "#1a1814" }}>{actor.name?.[0] || "?"}</span>
        }
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <p style={{ fontSize: 12, fontWeight: 500, color: "#1a1814", lineHeight: 1.3, margin: 0 }}>{actor.name}</p>
        <p style={{ fontSize: 10, color: "#a8a5a0", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {actor.in_transit ? "in transit" : actor.activity_slug?.replace(/_/g, " ") || actor.occupation || "—"}
        </p>
      </div>
      {hover && actor.actor_id !== playerActorId && (
        <button
          onClick={() => onReachOut && onReachOut(actor)}
          style={{ flexShrink: 0, background: "#1a1814", border: "none", borderRadius: 10, padding: "4px 9px", fontSize: 10, fontWeight: 500, color: "#fff", cursor: "pointer", fontFamily: "inherit", letterSpacing: ".02em" }}
        >
          Reach out
        </button>
      )}
    </div>
  );
}

function stockholmTime() {
  return new Date().toLocaleTimeString("sv-SE", {
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm"
  });
}
