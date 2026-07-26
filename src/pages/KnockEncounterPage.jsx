import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import KnockingDoorScene from "./KnockingDoorScene.jsx";
import VisitorPresenceView from "./VisitorPresenceView.jsx";

const SIMULATOR_URL = "https://anima.simulator.ngrok.dev";

/**
 * Standalone full-page knock encounter route.
 * world, user, sceneData all come from sessionStorage — no API needed.
 * Route: /encounter/knock/:encounterId
 *
 * trigger === "knock_user_door" (actor knocked on the player) or
 * "actor_approach" (player approaches an actor already present in the same
 * home) both render VisitorPresenceView directly — neither has a
 * door-decision/Enter step, so the richer "already in the scene" view is
 * the correct starting point rather than KnockingDoorScene's simpler chat UI.
 * trigger === "knock" (player knocked on an actor's own door) is unchanged.
 */
export default function KnockEncounterPage() {
  const { encounterId } = useParams();
  const navigate = useNavigate();

  const [ready,     setReady]     = useState(false);
  const [world,     setWorld]     = useState(null);
  const [user,      setUser]      = useState(null);
  const [sceneData, setSceneData] = useState(null);

  useEffect(() => {
    const raw = sessionStorage.getItem("encounterContext");
    const ctx = raw ? JSON.parse(raw) : null;

    if (!ctx?.world || !ctx?.user || !ctx?.sceneData) {
      console.warn("[KnockEncounterPage] Missing context:", ctx);
      navigate("/home", { replace: true });
      return;
    }

    // Patch encounter_id from URL in case it wasn't set yet
    const sd = { ...ctx.sceneData, encounter_id: ctx.sceneData.encounter_id || encounterId };

    setWorld(ctx.world);
    setUser(ctx.user);
    setSceneData(sd);
    setReady(true);
  }, [encounterId]);

  function handleLeave() {
    if ((sceneData?.trigger === "knock_user_door" || sceneData?.trigger === "actor_approach") && sceneData?.location) {
      sessionStorage.setItem("pendingHomeScene", JSON.stringify({ location: sceneData.location, world }));
    }
    sessionStorage.removeItem("encounterContext");
    navigate("/home", { replace: true });
  }

  if (!ready) {
    return (
      <div style={{
        position: "fixed", inset: 0, background: "#0d0c0a",
        display: "flex", alignItems: "center", justifyContent: "center"
      }}>
        <div style={{ color: "rgba(201,151,58,.4)", fontSize: 11, letterSpacing: ".15em", textTransform: "uppercase" }}>
          Opening door…
        </div>
      </div>
    );
  }

  if (sceneData.trigger === "knock_user_door" || sceneData.trigger === "actor_approach") {
    const playerActorId = user?.worlds?.find(w => w.world_id === world.id)?.actor_id;
    const primaryActor  = sceneData.location?.actors?.find(a => a.actor_id !== playerActorId);
    const actorPhoto    = primaryActor?.photo_url
      ? (primaryActor.photo_url.startsWith("http") ? primaryActor.photo_url : `${SIMULATOR_URL}${primaryActor.photo_url}`)
      : null;

    return (
      <VisitorPresenceView
        world={world}
        user={user}
        sceneData={sceneData}
        actorName={primaryActor?.name || ""}
        actorPhoto={actorPhoto}
        actorId={primaryActor?.actor_id}
        encounter_id={sceneData.encounter_id}
        onLeave={handleLeave}
      />
    );
  }

  return (
    <KnockingDoorScene
      world={world}
      user={user}
      sceneData={sceneData}
      onLeave={handleLeave}
    />
  );
}
