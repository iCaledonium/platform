import { useState, useEffect, useRef } from "react";
import PresenceView from "./PresenceView.jsx";
import VenueChatBubbles from "./VenueChatBubbles.jsx";

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
  const [clock,   setClock]   = useState(worldTime(world?.timezone));
  const [encounter,      setEncounter]      = useState(null); // { actor, encounter_id }
  const [approaching,    setApproaching]    = useState(null); // { actor_id, actor_name, photo_url, narrative, location_id }
  const [encounterLoading, setEncounterLoading] = useState(false);
  const [encounterStatus,  setEncounterStatus]  = useState("Connecting…");
  const [selectedAmbient, setSelectedAmbient] = useState(null);
  const [ambientGenerating, setAmbientGenerating] = useState(false);
  const [crowd, setCrowd] = useState([]);
  // Not to be confused with `approaching` above, which is somebody walking up
  // to the player. This is the player walking over to someone.
  const [walkingOver, setWalkingOver] = useState(null);
  const [chats, setChats]     = useState([]); // [{id, is_venue, name, portrait_url, messages, open, loading, ended, encounter_id}]
  const [deltas, setDeltas]   = useState([]);
  const [weather, setWeather] = useState(null);

  // Session 151 — asking who somebody is, is a thing that happens in the world.
  //
  // It used to only open a card over data the client already held. Now it is
  // written down: the person is someone this player has been introduced to, and
  // Approach unlocks because of it. Optimistic locally so the button appears at
  // once rather than on the next presence poll.
  async function introduce(actor) {
    if (!actor?.actor_id || actor.knows_player) return;
    setActors(prev => prev.map(a => a.actor_id === actor.actor_id ? { ...a, knows_player: true } : a));
    setSelectedAmbient(prev => prev?.actor_id === actor.actor_id ? { ...prev, knows_player: true } : prev);
    try {
      await fetch(`/api/worlds/${world.id}/actors/${actor.actor_id}/introduce`, { method: "POST" });
    } catch { /* the next presence poll carries the truth either way */ }
  }

  function handleAmbientPortraitReady(actorId, url) {
    setActors(prev => prev.map(a => a.actor_id === actorId ? {...a, generated_portrait_url: url} : a));
    setSelectedAmbient(prev => prev?.actor_id === actorId ? {...prev, generated_portrait_url: url} : prev);
    setAmbientGenerating(false);
  }
  const encounterRef = useRef(null);
  const leftEncounterAt               = useRef(null);   // timestamp — suppress approaches for 5min after leaving
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
    const timer = setInterval(() => setClock(worldTime(world?.timezone)), 10000);
    return () => clearInterval(timer);
  }, []);

  // Dwell
  useEffect(() => {
    const timer = setInterval(() => {
      dwellRef.current++;
      const mins = Math.floor(dwellRef.current / 60);
      const secs = dwellRef.current % 60;
      setDwell(`${mins}:${String(secs).padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Someone in the background crowd exists only as arithmetic until now. The
  // simulator re-checks they are still in the room and writes them a record;
  // after that they are an ordinary ambient and the normal card opens on them.
  const approachCrowd = async (person) => {
    if (walkingOver) return;
    setWalkingOver(person.ref);
    try {
      const r = await fetch(`/api/worlds/${world.id}/crowd/approach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ place_id: location.place_id || location.id, ref: person.ref }),
      });
      const d = await r.json().catch(() => null);

      if (!r.ok || !d?.actor_id) {
        // 410 means they finished up and left while the panel still showed them.
        setCrowd(prev => prev.filter(p => p.ref !== person.ref));
        return;
      }

      const pres = await fetch(`/api/worlds/${world.id}/presence`).then(x => (x.ok ? x.json() : null));
      const loc = (pres?.locations || []).find(l => l.id === location.id || l.place_id === location.place_id);
      if (loc) {
        setActors(loc.actors || []);
        setCrowd(loc.crowd || []);
      }

      const actor = (loc?.actors || []).find(a => a.actor_id === d.actor_id);
      if (actor) {
        setSelectedAmbient(actor);
        setAmbientGenerating(!actor.generated_portrait_url);
      }
    } catch {
      /* leave the crowd as it was; the next poll will correct it */
    } finally {
      setWalkingOver(null);
    }
  };

  // Presence poll — first fetch sets baseline, subsequent diffs detect arrivals
  const knownActorIdsRef = useRef(null); // null = not yet initialised

  useEffect(() => {
    const poll = () => {
      fetch(`/api/worlds/${world.id}/presence`)
        .then(r => r.ok ? r.json() : [])
        .then(data => {
          const locs = data.locations || data;
          if (data.weather && !weather) setWeather(data.weather);
          const loc = locs.find(l => l.id === location.id || l.place_id === location.place_id);
          if (!loc) { console.log('[VenueScene] loc not found, looking for:', location.id, location.place_id, 'in', locs.map(l=>l.place_id)); return; }
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
                setToasts(prev => {
                  if (prev.some(t => t.actor_id === a.actor_id)) return prev;
                  return [...prev, { ...a, toastId }];
                });
                setTimeout(() => setToasts(prev => prev.filter(t => t.toastId !== toastId)), 12000);
              }
            });
            knownActorIdsRef.current = currentIds;
          }
          setActors(current);
          setCrowd(loc.crowd || []);
        })
        .catch(() => {});
    };
    // First poll immediately on mount to set baseline
    poll();
    const timer = setInterval(poll, 15000);
    return () => clearInterval(timer);
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
        if (data.type === "weather_update") {
          setWeather(data.data);
        }
        if (data.type === "relationship_delta") {
          const d = data.data || data;
          const id = crypto.randomUUID();
          setDeltas(prev => [...prev, { id, warmth: d.warmth, trust: d.trust, tension: d.tension }]);
          setTimeout(() => setDeltas(prev => prev.filter(x => x.id !== id)), 3000);
        }
        if (data.type === "venue_event" && data.data?.type === "actor_arrived") {
          const arrival = data.data;
          if (arrival.actor_id === playerActorId) return;
          if (actors.some(a => a.actor_id === arrival.actor_id)) return;
          const toastId = crypto.randomUUID();
          if (knownActorIdsRef.current) {
            knownActorIdsRef.current = new Set([...knownActorIdsRef.current, arrival.actor_id]);
          }
          setToasts(prev => {
            if (prev.some(t => t.actor_id === arrival.actor_id)) return prev;
            return [...prev, { ...arrival, toastId }];
          });
          setTimeout(() => setToasts(prev => prev.filter(t => t.toastId !== toastId)), 12000);
        }
        if (data.type === "venue_event" && data.data?.type === "actor_approaching") {
          const cooldownMs = 5 * 60 * 1000;
          const sinceLeft = leftEncounterAt.current ? Date.now() - leftEncounterAt.current : Infinity;
          if (!encounter && sinceLeft > cooldownMs) setApproaching(data.data);
        }
        // Encounter events — update loading overlay, dismiss only when actual content arrives
        if (data.type === "encounter_event" && data.encounter_id === encounterRef.current?.encounter_id) {
          const payload = data.data || data;
          if (payload.type === "encounter_warming") {
            setEncounterStatus("Warming up the engine…");
          } else if (payload.type === "encounter_response" || payload.type === "encounter_narrative") {
            setEncounterLoading(false);
          }
        }
      } catch {}
    };
    return () => { if (esRef.current) { esRef.current.close(); esRef.current = null; } };
  }, []);

  function dismissToast(toastId) {
    setToasts(prev => prev.filter(t => t.toastId !== toastId));
  }

  async function handleAcceptApproach() {
    if (!approaching) return;
    try {
      const resp = await fetch(`/api/worlds/${world.id}/encounter/start`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          target_actor_id: approaching.actor_id,
          location_id:     approaching.location_id || location.place_id || location.id,
          trigger:         "actor_approach"
        })
      });
      const data = await resp.json();
      const actor = { actor_id: approaching.actor_id, name: approaching.actor_name, photo_url: approaching.photo_url };
      setApproaching(null);
      setEncounterStatus("Connecting…");
      setEncounterLoading(true);
      encounterRef.current = { actor, encounter_id: data.encounter_id };
      setEncounter({ actor, encounter_id: data.encounter_id });
    } catch (e) {
      console.error("Accept approach failed", e);
    }
  }

  async function handleReachOut(actor) {
    if (actor.is_ambient) {
      handleApproachAmbient(actor);
      return;
    }
    try {
      const resp = await fetch(`/api/worlds/${world.id}/encounter/start`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          target_actor_id: actor.actor_id,
          location_id:     location.place_id || location.id,
          trigger:         "venue_approach"
        })
      });
      const data = await resp.json();
      setEncounterStatus("Connecting…");
      setEncounterLoading(true);
      encounterRef.current = { actor, encounter_id: data.encounter_id };
      setEncounter({ actor, encounter_id: data.encounter_id });
    } catch (e) {
      console.error("Reach out failed", e);
    }
  }

  // Auto-start venue chat on mount
  useEffect(() => {
    const playerActorId = user?.worlds?.find(w => w.world_id === world.id)?.actor_id;
    if (!playerActorId) return;
    setChats([{
      id: "venue",
      is_venue: true,
      name: location.name,
      portrait_url: null,
      messages: [],
      open: true,
      loading: true,
      ended: false,
      encounter_id: null
    }]);
    fetch(`/api/worlds/${world.id}/ambient-encounter/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player_actor_id: playerActorId, ambient_actor_id: null, venue: true,
        location_id: location.place_id || location.id, weather: weather?.weather || null })
    }).then(r => r.ok ? r.json() : null).then(data => {
      if (data?.ok) {
        setChats(prev => prev.map(c => c.id === "venue"
          ? { ...c, encounter_id: data.encounter_id,
              messages: data.opening ? [{ role: "assistant", content: data.opening, speaker: data.speaker }] : [],
              loading: false }
          : c));
      } else {
        setChats(prev => prev.map(c => c.id === "venue" ? { ...c, loading: false } : c));
      }
    }).catch(() => setChats(prev => prev.map(c => c.id === "venue" ? { ...c, loading: false } : c)));
  }, []);

  async function handleApproachAmbient(actor) {
    const playerActorId = user?.worlds?.find(w => w.world_id === world.id)?.actor_id;
    // If already open, just focus it
    if (chats.find(c => c.id === actor.actor_id)) {
      setChats(prev => prev.map(c => c.id === actor.actor_id ? { ...c, open: true } : c));
      return;
    }
    const newChat = { id: actor.actor_id, is_venue: false, name: actor.name,
      subtitle: actor.occupation || null,
      portrait_url: actor.generated_portrait_url || null,
      messages: [], open: true, loading: true, ended: false, encounter_id: null };
    setChats(prev => [...prev, newChat]);
    try {
      const resp = await fetch(`/api/worlds/${world.id}/ambient-encounter/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_actor_id: playerActorId, ambient_actor_id: actor.actor_id, weather: weather?.weather || null })
      });
      const data = await resp.json();
      if (data.ok) {
        const encId = data.encounter_id;
        setChats(prev => prev.map(c => c.id === actor.actor_id
          ? { ...c, encounter_id: encId, loading: true }
          : c));
        const pollOpen = setInterval(async () => {
          const r = await fetch(`/api/worlds/${world.id}/ambient-encounter/${encId}/opening`).then(r=>r.ok?r.json():null);
          if (r?.ready) {
            clearInterval(pollOpen);
            setChats(prev => prev.map(c => c.id === actor.actor_id
              ? { ...c, loading: false, messages: r.opening ? [{ role: "assistant", content: r.opening, speaker: r.speaker }] : [] }
              : c));
          }
        }, 2000);
        setTimeout(() => clearInterval(pollOpen), 30000);
      }
    } catch { setChats(prev => prev.map(c => c.id === actor.actor_id ? { ...c, loading: false } : c)); }
  }

  async function handleChatSend(chatId, content) {
    const chat = chats.find(c => c.id === chatId);
    if (!chat?.encounter_id || chat.loading) return;
    setChats(prev => prev.map(c => c.id === chatId
      ? { ...c, messages: [...c.messages, { role: "user", content }], loading: true, typing: false }
      : c));
    try {
      const resp = await fetch(`/api/worlds/${world.id}/ambient-encounter/${chat.encounter_id}/message`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, venue: chat.is_venue })
      });
      const data = await resp.json().catch(() => null);

      if (data?.ended) {
        setChats(prev => prev.map(c => c.id === chatId ? { ...c, loading: false, ended: true } : c));
        return;
      }

      // Session 151 — `data.reply || ""` used to append a message no matter
      // what, so a failed request drew a bubble with nothing in it. Build only
      // from lines that actually carry words; anything else is a failure and
      // gets said out loud rather than mimed.
      const newMsgs = (
        Array.isArray(data?.lines)
          ? data.lines.map(([speaker, text]) => ({ role: "assistant", content: text, speaker }))
          : [{ role: "assistant", content: data?.reply, speaker: data?.speaker }]
      ).filter(m => typeof m.content === "string" && m.content.trim() !== "");

      setChats(prev => prev.map(c => c.id === chatId
        ? { ...c, loading: false,
            messages: [...c.messages, ...newMsgs],
            note: (resp.ok && newMsgs.length) ? null
                : !resp.ok ? "Nobody could answer just now."
                : "Nobody answers." }
        : c));
    } catch {
      setChats(prev => prev.map(c => c.id === chatId
        ? { ...c, loading: false, note: "Nobody could answer just now." } : c));
    }
  }

  function handleChatClose(chatId) {
    const chat = chats.find(c => c.id === chatId);
    if (chat?.encounter_id) {
      fetch(`/api/worlds/${world.id}/ambient-encounter/${chat.encounter_id}/end`, { method: "POST" }).catch(() => {});
    }
    setChats(prev => prev.filter(c => c.id !== chatId));
  }

  function handleChatToggle(chatId) {
    setChats(prev => prev.map(c => c.id === chatId ? { ...c, open: !c.open } : c));
  }

  async function leave() {
    if (leaving) return;
    setLeaving(true);
    const playerActorId = user?.worlds?.find(w => w.world_id === world.id)?.actor_id;
    try { await fetch(`/api/worlds/${world.id}/leave`, { method: "POST" }); } catch {}
    onLeave();
  }

  const glass     = { background: "rgba(238,236,234,0.82)", backdropFilter: "blur(28px)", WebkitBackdropFilter: "blur(28px)", border: "1px solid rgba(255,255,255,0.7)" };
  const glassDark = { background: "rgba(20,18,16,0.62)",   backdropFilter: "blur(28px)", WebkitBackdropFilter: "blur(28px)", border: "1px solid rgba(255,255,255,0.1)" };

  if (encounter) {
    const photoUrl = encounter.actor.photo_url ? (encounter.actor.photo_url.startsWith("http") ? encounter.actor.photo_url : `${SIMULATOR_URL}${encounter.actor.photo_url}`) : null;

    if (encounterLoading) {
      return (
        <div style={{ fontFamily: "'DM Sans',system-ui,sans-serif", position: "fixed", inset: 0, zIndex: 1000, background: "#1a1814", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          {photoUrl && (
            <div style={{ width: 72, height: 72, borderRadius: "50%", overflow: "hidden", border: "2px solid rgba(255,255,255,0.15)", marginBottom: 4 }}>
              <img src={photoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="" />
            </div>
          )}
          <p style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 22, color: "rgba(255,255,255,0.85)", letterSpacing: ".02em", margin: 0 }}>
            {encounter.actor.name}
          </p>
          <div style={{ width: 28, height: 28, border: "2px solid rgba(255,255,255,0.12)", borderTopColor: "#c9973a", borderRadius: "50%", animation: "spin .8s linear infinite" }} />
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", letterSpacing: ".08em", margin: 0 }}>
            {encounterStatus}
          </p>
        </div>
      );
    }

    return (
      <PresenceView
        world={world}
        user={user}
        sceneData={{ location }}
        actorName={encounter.actor.name}
        actorPhoto={photoUrl}
        encounter_id={encounter.encounter_id}
        onLeave={() => { leftEncounterAt.current = Date.now(); setEncounter(null); setApproaching(null); setEncounterLoading(false); }}
      />
    );
  }

  if (approaching) {
    const photoUrl = approaching.photo_url ? (approaching.photo_url.startsWith("http") ? approaching.photo_url : `${SIMULATOR_URL}${approaching.photo_url}`) : null;
    return (
      <div style={{ fontFamily: "'DM Sans',system-ui,sans-serif", position: "fixed", inset: 0, zIndex: 1000, background: "#1a1814", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, gap: 24 }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap');`}</style>
        {photoUrl && (
          <div style={{ width: 72, height: 72, borderRadius: "50%", overflow: "hidden", border: "2px solid rgba(255,255,255,0.2)" }}>
            <img src={photoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="" />
          </div>
        )}
        <p style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 20, color: "rgba(255,255,255,0.9)", textAlign: "center", maxWidth: 480, lineHeight: 1.6, margin: 0 }}>
          {approaching.narrative}
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <button onClick={handleAcceptApproach} style={{ background: "rgba(255,255,255,0.92)", border: "none", borderRadius: 20, padding: "10px 28px", fontSize: 13, fontWeight: 500, color: "#1a1814", cursor: "pointer", fontFamily: "inherit" }}>
            {approaching.actor_name} approaches →
          </button>
          <button onClick={() => setApproaching(null)} style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 20, padding: "10px 20px", fontSize: 13, color: "rgba(255,255,255,0.5)", cursor: "pointer", fontFamily: "inherit" }}>
            Look away
          </button>
        </div>
      </div>
    );
  }

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
    <>
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
          {actors.length === 0 && crowd.length === 0
            ? <p style={{ fontSize: 11, color: "#a8a5a0", padding: "16px 14px", margin: 0 }}>Nobody here right now</p>
            : actors.map(a => <ActorRow key={a.actor_id} actor={a} playerActorId={user?.worlds?.find(w => w.world_id === world.id)?.actor_id} onReachOut={handleReachOut} onAmbientClick={(a) => { introduce(a); setSelectedAmbient(a); setAmbientGenerating(!a.generated_portrait_url); }} />)
          }

          {crowd.length > 0 && (
            <>
              <div style={{ padding: "10px 14px 4px", marginTop: 4, borderTop: "1px solid rgba(0,0,0,0.07)" }}>
                <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: ".1em", color: "#a8a5a0", textTransform: "uppercase" }}>
                  Also here
                </span>
              </div>
              {crowd.slice(0, 12).map(p => (
                <CrowdRow key={p.ref} person={p} busy={walkingOver === p.ref} disabled={!!walkingOver} onApproach={approachCrowd} />
              ))}
              {crowd.length > 12 && (
                <p style={{ fontSize: 10, color: "#c2bfba", padding: "4px 14px 10px", margin: 0 }}>
                  and {crowd.length - 12} more
                </p>
              )}
            </>
          )}
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
            <button onClick={() => handleReachOut(toast)} style={{ background: "#1a1814", border: "none", borderRadius: 12, padding: "5px 12px", fontSize: 11, fontWeight: 500, color: "#fff", cursor: "pointer", fontFamily: "inherit" }}>
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

    {/* Ambient NPC info bubble */}
    {selectedAmbient && (
      <div onClick={() => !ambientGenerating && setSelectedAmbient(null)}
        style={{position:"fixed",inset:0,zIndex:1100,display:"flex",alignItems:"center",justifyContent:"center",padding:24,background:"rgba(0,0,0,.5)"}}>
        <div onClick={e => e.stopPropagation()}
          style={{background:"#fff",borderRadius:16,overflow:"hidden",maxWidth:320,width:"100%",boxShadow:"0 16px 48px rgba(0,0,0,.2)",fontFamily:"'DM Sans',system-ui,sans-serif"}}>

          {/* Portrait area — 9:16 */}
          <AmbientPortrait actor={selectedAmbient}
            onPortraitReady={(id, url) => { handleAmbientPortraitReady(id, url); setAmbientGenerating(false); }}
          />

          {/* Info */}
          <div style={{padding:"16px 20px 20px"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:15,fontWeight:500,color:"#1a1814"}}>{selectedAmbient.name}{selectedAmbient.age ? `, ${selectedAmbient.age}` : ""}</div>
                <div style={{fontSize:12,color:"#a8a5a0",marginTop:2}}>{selectedAmbient.occupation}</div>
              </div>
              <span style={{fontSize:10,padding:"3px 8px",borderRadius:20,background:selectedAmbient.is_staff?"#f0ece4":"#f5f5f5",color:selectedAmbient.is_staff?"#8a7a60":"#aaa",fontWeight:500}}>
                {selectedAmbient.is_staff ? "Works here" : "Regular"}
              </span>
            </div>
            {selectedAmbient.psychology && (
              <div style={{borderTop:"1px solid #f0ece4",paddingTop:12,display:"flex",flexDirection:"column",gap:6}}>
                {selectedAmbient.psychology.social_style && (
                  <p style={{margin:0,fontSize:13,color:"#4a4744",lineHeight:1.5}}>{selectedAmbient.psychology.social_style}</p>
                )}
                {selectedAmbient.psychology.note && (
                  <p style={{margin:0,fontSize:12,color:"#a8a5a0",lineHeight:1.5,fontStyle:"italic"}}>{selectedAmbient.psychology.note}</p>
                )}
              </div>
            )}
            <button onClick={() => setSelectedAmbient(null)} disabled={ambientGenerating}
              style={{marginTop:16,width:"100%",padding:"9px 0",borderRadius:10,border:"1px solid #ede9e3",background:"none",fontSize:12,color: ambientGenerating ? "#ccc" : "#a8a5a0",cursor: ambientGenerating ? "default" : "pointer",fontFamily:"inherit"}}>
              {ambientGenerating ? "Generating portrait…" : "Close"}
            </button>
          </div>
        </div>
      </div>
    )}

    <VenueChatBubbles
      chats={chats}
      deltas={deltas}
      onSend={handleChatSend}
      onClose={handleChatClose}
      onToggle={handleChatToggle}
    />
    </>
  );
}

function AmbientPortrait({ actor, onPortraitReady }) {
  const [portraitUrl, setPortraitUrl] = useState(actor.generated_portrait_url || null);
  const [generating, setGenerating]   = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    if (portraitUrl) return;

    setGenerating(true);
    fetch(`/api/ambient-actors/${actor.actor_id}/generate-portrait`, { method: "POST" })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.portrait_url) {
          setPortraitUrl(data.portrait_url);
          setGenerating(false);
          onPortraitReady && onPortraitReady(actor.actor_id, data.portrait_url);
        } else if (data?.generating) {
          pollRef.current = setInterval(() => {
            fetch(`/api/ambient-actors/${actor.actor_id}/portrait-status`)
              .then(r => r.ok ? r.json() : null)
              .then(d => {
                if (d?.portrait_url) {
                  setPortraitUrl(d.portrait_url);
                  setGenerating(false);
                  onPortraitReady && onPortraitReady(actor.actor_id, d.portrait_url);
                  clearInterval(pollRef.current);
                }
              });
          }, 5000);
        }
      })
      .catch(() => setGenerating(false));

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  return generating && !portraitUrl ? (
    <div style={{ width:"100%", aspectRatio:"9/16", background:"#f0ece4", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:12 }}>
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="12" stroke="#d4cfc8" strokeWidth="2" strokeDasharray="8 4">
          <animateTransform attributeName="transform" type="rotate" from="0 16 16" to="360 16 16" dur="1.2s" repeatCount="indefinite"/>
        </circle>
      </svg>
      <span style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#b0aca6" }}>Generating portrait…</span>
    </div>
  ) : portraitUrl ? (
    <div style={{ width:"100%", aspectRatio:"9/16", overflow:"hidden" }}>
      <img src={portraitUrl} alt={actor.name} style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} />
    </div>
  ) : null;
}

function ActorRow({ actor, onReachOut, onAmbientClick, playerActorId }) {
  const [hover, setHover] = useState(false);
  const photoUrl = actor.is_ambient
    ? (actor.generated_portrait_url || null)
    : (actor.photo_url ? (actor.photo_url.startsWith("http") ? actor.photo_url : `${SIMULATOR_URL}${actor.photo_url}`) : null);
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
      <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
        <p style={{ fontSize: 12, fontWeight: 500, color: "#1a1814", lineHeight: 1.3, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{actor.name}</p>
        {hover && actor.actor_id !== playerActorId
          ? actor.is_ambient
            ? <div style={{display:"flex", gap:5, marginTop:3}}>
                <button onClick={() => { if(onAmbientClick) { onAmbientClick(actor); } }}
                  style={{background:"#1a1814", border:"none", borderRadius:8, padding:"3px 8px", fontSize:10, fontWeight:500, color:"#fff", cursor:"pointer", fontFamily:"inherit"}}>ℹ Who?</button>
                {/* Approach only once you have been introduced — either you
                    asked who they were, or they answered you in the room and
                    said their name. knows_player is that fact. */}
                {actor.knows_player && (
                  <button onClick={() => onReachOut && onReachOut(actor)}
                    style={{background:"#1a1814", border:"none", borderRadius:8, padding:"3px 8px", fontSize:10, fontWeight:500, color:"#fff", cursor:"pointer", fontFamily:"inherit"}}>Approach</button>
                )}
              </div>
            : <div style={{marginTop:3}}>
                <button onClick={() => onReachOut && onReachOut(actor)}
                  style={{background:"#1a1814", border:"none", borderRadius:8, padding:"3px 8px", fontSize:10, fontWeight:500, color:"#fff", cursor:"pointer", fontFamily:"inherit", letterSpacing:".02em"}}>Reach out</button>
              </div>
          : <p style={{ fontSize: 10, color: "#a8a5a0", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {actor.in_transit ? "in transit" : actor.activity_slug?.replace(/_/g, " ") || actor.occupation || "—"}
            </p>
        }
      </div>
    </div>
  );
}

// A face in the crowd. Same shape as ActorRow but with no portrait to show and
// a single action, because until they are approached there is no record of them
// to open.
function CrowdRow({ person, busy, disabled, onApproach }) {
  const [hover, setHover] = useState(false);

  return (
    <div
      className="venue-actor-row"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 14px", transition: "background .12s", opacity: busy ? .55 : 1 }}
    >
      <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: "50%", overflow: "hidden", border: "1.5px dashed rgba(0,0,0,0.14)", background: "rgba(0,0,0,0.04)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: "#a8a5a0" }}>{person.name?.[0] || "?"}</span>
      </div>
      <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
        <p style={{ fontSize: 12, fontWeight: 500, color: "#6b6760", lineHeight: 1.3, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {person.name}
        </p>
        {hover && !disabled && !person.minor ? (
          <div style={{ marginTop: 3 }}>
            <button onClick={() => onApproach && onApproach(person)}
              style={{ background: "#1a1814", border: "none", borderRadius: 8, padding: "3px 8px", fontSize: 10, fontWeight: 500, color: "#fff", cursor: "pointer", fontFamily: "inherit" }}>
              ℹ Who?
            </button>
          </div>
        ) : (
          <p style={{ fontSize: 10, color: "#c2bfba", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {busy
              ? "walking over…"
              : person.minor
                ? `${person.age} · with family`
                : `${person.age} · ${person.gender === "male" ? "man" : "woman"}`}
          </p>
        )}
      </div>
    </div>
  );
}

function worldTime(timezone) {
  return new Date().toLocaleTimeString("sv-SE", {
    hour: "2-digit", minute: "2-digit", timeZone: timezone || "Europe/Stockholm"
  });
}
