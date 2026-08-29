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
  const ctxRef   = useRef(null);   // so the unload handler sees the live encounter id
  const endedRef = useRef(false);  // exactly one end per visit

  // Session 153 — this cache is now a convenience, not a guard.
  //
  // It used to be the only thing stopping a reload starting a second encounter
  // ("one knock per visit"), which was the right intent at the wrong layer:
  // sessionStorage is per-tab, so a second WINDOW sailed straight past it and
  // spawned a parallel conversation. The guard now lives in the simulator,
  // where EncounterProcess is registered per (player, target) and a duplicate
  // start rejoins the live one. All this keeps is the id, for leaving.
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

        // Session 153 — always ask the server; never infer from the tab.
        //
        // This used to read a cached encounter id out of sessionStorage and
        // treat its mere presence as "you are already here". A refresh then
        // claimed you were mid-encounter and never knocked — and if that
        // encounter had since died (a simulator restart is enough) you were
        // left staring at a closed door with nothing in flight.
        //
        // The server dedupes by (player, target) now, so asking is always
        // safe: a live encounter comes back with rejoined:true, and a dead one
        // is simply replaced by a fresh knock. That is a question only the
        // server can answer, so it is the server that answers it.
        let encounter_id = null;
        let rejoined = false;

        // Session 154 - the Test Lab hands us an encounter it already built,
        // with her decision authored into it. Starting our own would throw
        // that away and knock for real, which is the one thing the lab exists
        // to skip. Read the URL here, not at module scope: this is a
        // single-page app, so a module-level location.search is whatever page
        // the bundle first loaded on, not the one we navigated to.
        const labEid = new URLSearchParams(window.location.search).get("eid");
        if (labEid) {
          // Confirm it is still alive before committing the scene to it. A
          // fixture encounter can die between being built and being opened
          // (a model host that has gone away takes the process with it), and
          // an id we never check turns that into a doorway that is knocked on
          // forever with nothing behind it. A dead sandbox has to LOOK dead.
          const probe = await fetch(`/api/worlds/${worldId}/encounter/${labEid}`,
                                    { credentials: "include" });
          if (!probe.ok) { if (!dead) setProblem("world"); return; }
          encounter_id = labEid;
          rejoined = true;
          sessionStorage.setItem(cacheKey, labEid);
        }

        if (!encounter_id) {
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
          // Only the server's own answer counts as "already here".
          rejoined = data.rejoined === true;
          if (encounter_id) sessionStorage.setItem(cacheKey, encounter_id);
        }
        if (dead) return;

        ctxRef.current = { sceneData: { encounter_id } };
        setCtx({
          world,
          user,
          actor,
          sceneData: { location, encounter_id, trigger: "knock", mode: "scene", rejoined },
        });
      } catch {
        if (!dead) setProblem("world");
      }
    })();

    return () => { dead = true; };
  }, [worldId, actorId]);

  // Session 153 — leaving has to reach the simulator, not just the router.
  //
  // Walking away used to be a navigate() and nothing else, so the encounter
  // stayed live on the server with nobody in it. That is where her memories
  // were going: write_encounter_memories runs inside shutdown_encounter, and
  // an encounter that is never ended is never shut down. Ten knocks last
  // night produced one ending and zero memories of any of them — she has no
  // record of a single visit, while remembering every text she sent.
  const endEncounter = (beacon = false) => {
    const id = ctxRef.current?.sceneData?.encounter_id;
    if (!id || endedRef.current) return;
    endedRef.current = true;
    const url = `/api/worlds/${worldId}/encounter/${id}/end`;
    // On the way out of the page a normal fetch is cancelled mid-flight;
    // sendBeacon is the one request a browser promises to finish.
    if (beacon && navigator.sendBeacon) navigator.sendBeacon(url);
    else fetch(url, { method: "POST", credentials: "include", keepalive: true }).catch(() => {});
  };

  // Closing the window, quitting the app, or navigating away entirely.
  // pagehide fires where beforeunload is unreliable, including bfcache.
  useEffect(() => {
    const bye = () => endEncounter(true);
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      endEncounter();          // and for leaving via the router
    };
  }, [worldId]);

  function handleLeave() {
    endEncounter();
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
