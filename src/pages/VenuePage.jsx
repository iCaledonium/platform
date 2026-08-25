import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import VenueScene from "./VenueScene.jsx";

// ── VenuePage ────────────────────────────────────────────────────────────────
//
// Session 151 — being inside a venue is a place inside a world, and the address
// now says so: /world/:worldId/venue/:venueId.
//
// It used to be /encounter/venue/:worldId/:locationId, which put the world id in
// the path but not in the hierarchy, and the page then refused to render from
// it: world, user and location all came out of sessionStorage, so the ids in the
// URL were decoration. Reload inside a café and you were thrown to /home. The
// same fault the world page had before Session 150, one level deeper.
//
// Now the URL is the source of truth. sessionStorage survives only as a fast
// path — walking in from the map already holds everything, and using it avoids
// a blank frame while three requests land — but nothing depends on it.
//
// Leaving goes back to /world/:worldId, not /home. Stepping out of a café puts
// you on the street you walked in from; it does not eject you from the world.
export default function VenuePage() {
  const { worldId, venueId } = useParams();
  const navigate = useNavigate();

  const [ctx, setCtx]         = useState(null);      // { world, user, location }
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let dead = false;
    setMissing(false);

    const cached = (() => {
      try {
        const c = JSON.parse(sessionStorage.getItem("venueContext") || "null");
        const hit = c?.world?.id === worldId &&
          (c?.location?.place_id === venueId || c?.location?.id === venueId);
        return hit ? c : null;
      } catch { return null; }
    })();
    if (cached) setCtx(cached);

    Promise.all([
      fetch("/api/worlds", { credentials: "include" }).then(r => (r.ok ? r.json() : [])),
      fetch("/api/me",     { credentials: "include" }).then(r => (r.ok ? r.json() : null)),
      fetch(`/api/worlds/${worldId}/presence`, { credentials: "include" })
        .then(r => (r.ok ? r.json() : null)),
    ])
      .then(([worlds, user, presence]) => {
        if (dead) return;
        const world = (worlds || []).find(w => w.id === worldId) || null;
        const location = (presence?.locations || [])
          .find(l => l.place_id === venueId || l.id === venueId) || null;
        // /api/worlds is already scoped to worlds this user belongs to, so a
        // world that is missing here is one they may not enter.
        if (world && location) setCtx({ world, user, location });
        else if (!cached) setMissing(true);
      })
      .catch(() => { if (!dead && !cached) setMissing(true); });

    return () => { dead = true; };
  }, [worldId, venueId]);

  function handleLeave() {
    sessionStorage.removeItem("venueContext");
    navigate(`/world/${worldId}`);
  }

  if (missing) return (
    <div style={{ minHeight:"100vh", background:"#eeecea", display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"center", gap:12, fontFamily:"'DM Sans',system-ui,sans-serif" }}>
      <p style={{ fontSize:13, color:"#a8a5a0", margin:0 }}>
        That place isn't in this world, or you're not a member of it.
      </p>
      <a onClick={() => navigate(`/world/${worldId}`)}
         style={{ fontSize:12, color:"#b05c08", cursor:"pointer" }}>← Back to the map</a>
    </div>
  );

  if (!ctx) return (
    <div style={{ position:"fixed", inset:0, background:"#0d0c0a",
      display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ color:"rgba(201,151,58,.4)", fontSize:11, letterSpacing:".15em",
        textTransform:"uppercase", fontFamily:"'DM Sans',system-ui,sans-serif" }}>
        Entering venue…
      </div>
    </div>
  );

  return (
    <VenueScene
      world={ctx.world}
      user={ctx.user}
      location={ctx.location}
      onLeave={handleLeave}
    />
  );
}
