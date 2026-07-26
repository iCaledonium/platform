import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import VenueScene from "./VenueScene.jsx";

/**
 * Standalone full-page venue encounter route.
 * world, user, location all come from sessionStorage — no API needed.
 * Route: /encounter/venue/:worldId/:locationId
 */
export default function VenueEncounterPage() {
  const { worldId, locationId } = useParams();
  const navigate = useNavigate();

  const [ready,    setReady]    = useState(false);
  const [world,    setWorld]    = useState(null);
  const [user,     setUser]     = useState(null);
  const [location, setLocation] = useState(null);

  useEffect(() => {
    const raw = sessionStorage.getItem("venueContext");
    const ctx = raw ? JSON.parse(raw) : null;

    if (!ctx?.world || !ctx?.user || !ctx?.location) {
      console.warn("[VenueEncounterPage] Missing context:", ctx);
      navigate("/home", { replace: true });
      return;
    }

    setWorld(ctx.world);
    setUser(ctx.user);
    setLocation(ctx.location);
    setReady(true);
  }, [worldId, locationId]);

  function handleLeave() {
    sessionStorage.removeItem("venueContext");
    navigate("/home", { replace: true });
  }

  if (!ready) {
    return (
      <div style={{
        position: "fixed", inset: 0, background: "#0d0c0a",
        display: "flex", alignItems: "center", justifyContent: "center"
      }}>
        <div style={{ color: "rgba(201,151,58,.4)", fontSize: 11, letterSpacing: ".15em", textTransform: "uppercase" }}>
          Entering venue…
        </div>
      </div>
    );
  }

  return (
    <VenueScene
      world={world}
      user={user}
      location={location}
      onLeave={handleLeave}
    />
  );
}
