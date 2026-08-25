import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import DoorScene3D from "./DoorScene3D.jsx";

// ── KnockActorDoor ────────────────────────────────────────────────────────────
//
// Session 152 — knocking on someone's door is a place in a world, and the
// address says so: /world/:worldId/knock/:actorId/door.
//
// It used to be /encounter/knock/:encounterId, which named the wrong thing.
// An encounter id is created by the click that navigates and is gone the moment
// the conversation ends, so the URL could not be returned to, kept, or reloaded
// — and when the start call failed the overlay navigated to the literal string
// "pending". Worse, world, user and location all came out of sessionStorage, so
// a reload at Lindsey's door threw you to /home. The venue route had the same
// fault and was fixed the same way in Session 151.
//
// Whose door it is does not change. That is what belongs in the path.
//
// Note this route is only the player knocking. An actor knocking on YOUR door
// is not this address — it is your door, not theirs — and still arrives through
// the notification overlay in App.jsx.
export default function KnockActorDoor() {
  const { worldId, actorId } = useParams();
  const navigate = useNavigate();

  const [ctx, setCtx]         = useState(null);   // { world, user, sceneData }
  const [problem, setProblem] = useState(null);
  const starting              = useRef(false);

  // One knock per visit. Without this a reload would start a second encounter
  // with the same person at the same door, and the first would be left running
  // with nobody reading it.
  const cacheKey = `knock:${worldId}:${actorId}`;

  useEffect(() => {
    let dead = false;
    setProblem(null);

    (async () => {
      try {
        const [worlds, user, presence] = await Promise.all([
          fetch("/api/worlds", { credentials: "include" }).then(r => (r.ok ? r.json() : [])),
          fetch("/api/me",     { credentials: "include" }).then(r => (r.ok ? r.json() : null)),
          fetch(`/api/worlds/${worldId}/presence`, { credentials: "include" })
            .then(r => (r.ok ? r.json() : null)),
        ]);
        if (dead) return;

        // /api/worlds is already scoped to worlds this user belongs to, so a
        // world missing here is one they may not enter.
        const world = (worlds || []).find(w => w.id === worldId) || null;
        if (!world) { setProblem("world"); return; }

        const locations = presence?.locations || [];

        // Find them, and find their door. These are two different questions:
        // they may be at the door (home), or out — and you can knock either way.
        let actor = null;
        for (const l of locations) {
          const hit = (l.actors || []).find(a => a.actor_id === actorId);
          if (hit) { actor = hit; break; }
        }
        if (!actor) { setProblem("actor"); return; }

        const homeId = actor.home_place_id;
        const location =
          locations.find(l => homeId && (l.place_id === homeId || l.id === homeId)) ||
          // No home on record: fall back to the residence they are standing in,
          // which is the old behaviour and still right when they are home.
          locations.find(l =>
            l.category === "residential" && (l.actors || []).some(a => a.actor_id === actorId)) ||
          null;
        if (!location) { setProblem("door"); return; }

        const playerActorId = user?.worlds?.find(w => w.world_id === worldId)?.actor_id;

        let encounter_id = sessionStorage.getItem(cacheKey);
        if (!encounter_id && !starting.current) {
          starting.current = true;
          const r = await fetch(`/api/worlds/${worldId}/encounter/start`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              target_actor_id: actorId,
              player_actor_id: playerActorId,
              location_id:     location.place_id || location.id,
              trigger:         "knock",
            }),
          });
          const data = await r.json().catch(() => ({}));
          encounter_id = data.encounter_id || null;
          if (encounter_id) sessionStorage.setItem(cacheKey, encounter_id);
        }
        if (dead) return;

        setCtx({
          world,
          user,
          actor,
          sceneData: { location, encounter_id, trigger: "knock", mode: "scene" },
        });
      } catch {
        if (!dead) setProblem("world");
      }
    })();

    return () => { dead = true; };
  }, [worldId, actorId]);

  function handleLeave() {
    sessionStorage.removeItem(cacheKey);
    // Stepping back from a door puts you on the street outside it, not out of
    // the world entirely.
    navigate(`/world/${worldId}`);
  }

  if (problem) {
    const said = {
      world:  "That world isn't yours to enter.",
      actor:  "Nobody by that name is in this world.",
      door:   "There's no address on record for them.",
    }[problem];

    return (
      <div style={{ minHeight:"100vh", background:"#eeecea", display:"flex", flexDirection:"column",
        alignItems:"center", justifyContent:"center", gap:12, fontFamily:"'DM Sans',system-ui,sans-serif" }}>
        <p style={{ fontSize:13, color:"#a8a5a0", margin:0 }}>{said}</p>
        <a onClick={() => navigate(`/world/${worldId}`)}
           style={{ fontSize:12, color:"#b05c08", cursor:"pointer" }}>← Back to the map</a>
      </div>
    );
  }

  if (!ctx) {
    return (
      <div style={{
        position: "fixed", inset: 0, background: "#0d0c0a",
        display: "flex", alignItems: "center", justifyContent: "center"
      }}>
        <div style={{ color: "rgba(201,151,58,.4)", fontSize: 11, letterSpacing: ".15em", textTransform: "uppercase" }}>
          Knocking…
        </div>
      </div>
    );
  }

  // Session 153 — the runtime model is the dressed, baked one a world loads;
  // the editable glb_url is a bare body and stays a fallback only for actors
  // deployed before runtime models existed.
  return (
    <DoorScene3D
      world={ctx.world}
      user={ctx.user}
      sceneData={ctx.sceneData}
      actorName={ctx.actor?.name}
      actorId={ctx.actor?.actor_id}
      glbUrl={ctx.actor?.runtime_glb_url || ctx.actor?.glb_url}
      onLeave={handleLeave}
    />
  );
}
