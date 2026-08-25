import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import WorldEnterOverlay from "./WorldEnterOverlay.jsx";
import WorldInstruments from "./WorldInstruments.jsx";

// ── WorldPage ─────────────────────────────────────────────────────────────────
//
// Session 150 — being *inside* a world is now a place you can be, at
// /world/:worldId, rather than an overlay stacked on /home.
//
// WorldEnterOverlay was mounted from HomePage state, so the thing you were
// looking at had no address: it could not be linked, could not be reloaded into,
// could not be reached from a notification, and browser Back left the world
// instead of stepping within it. Same problem the world editor had before it
// became /my-worlds/:worldId, and the same fix.
//
// The component itself is unchanged — 972 lines of map, presence and SSE that
// work. It is hosted rather than rewritten; only its chrome moved from fixed
// overlay to page flow, and onClose now means "go back to home" rather than
// "unmount me".
export default function WorldPage() {
  const { worldId } = useParams();
  const navigate    = useNavigate();

  const [world, setWorld] = useState(undefined);
  const [user, setUser]   = useState(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    // /api/worlds is already scoped to worlds this user belongs to, so a world
    // that is missing here is one they may not enter — no separate check needed.
    fetch("/api/worlds", { credentials: "include" })
      .then(r => r.ok ? r.json() : [])
      .then(ws => {
        const w = ws.find(x => x.id === worldId) || null;
        setWorld(w);
        if (w) document.title = `Anima — ${w.name}`;
      })
      .catch(() => setWorld(null));

    fetch("/api/me", { credentials: "include" })
      .then(r => r.ok ? r.json() : null).then(setUser).catch(() => {});
  }, [worldId]);

  // Session 151 — a world can stop while you are standing in it.
  //
  // The owner stops it from another tab, the simulator restarts, the engine
  // dies. Nothing here noticed any of that: /api/worlds was read once on mount
  // and never again, so the page went on rendering a live world — pins frozen
  // where their actors last were, Enter buttons that would spawn you into
  // nothing. The stopped screen below existed and was only ever reached by
  // arriving at an already-stopped world.
  //
  // /api/worlds/:id/status asks the simulator whether the world is in its
  // supervisor, which is the same question the stopped screen answers. Polled
  // both ways, so a world started from anywhere puts you back on the map
  // without a reload.
  useEffect(() => {
    if (!worldId) return;
    const check = () => {
      fetch(`/api/worlds/${worldId}/status`, { credentials: "include" })
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (!d?.status) return;
          setWorld(prev => (prev && prev.status !== d.status ? { ...prev, status: d.status } : prev));
        })
        .catch(() => {});
    };
    const t = setInterval(check, 10000);
    return () => clearInterval(t);
  }, [worldId]);

  if (world === undefined) return (
    <div style={{ minHeight:"100vh", background:"#eeecea", display:"flex", alignItems:"center", justifyContent:"center",
      fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0" }}>
      Entering…
    </div>
  );

  if (!world) return (
    <div style={{ minHeight:"100vh", background:"#eeecea", display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"center", gap:12, fontFamily:"'DM Sans',system-ui,sans-serif" }}>
      <p style={{ fontSize:13, color:"#a8a5a0", margin:0 }}>That world doesn't exist, or you're not a member of it.</p>
      <a onClick={() => navigate("/home")} style={{ fontSize:12, color:"#b05c08", cursor:"pointer" }}>← Back to home</a>
    </div>
  );

  // A stopped world has no running actors to show. Entering one would render an
  // empty map with no explanation of why it is empty.
  if (world.status !== "running") return (
    <div style={{ minHeight:"100vh", background:"#eeecea", display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"center", gap:14, fontFamily:"'DM Sans',system-ui,sans-serif", padding:24, textAlign:"center" }}>
      <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:24, color:"#1a1814" }}>{world.name} is stopped</div>
      <p style={{ fontSize:13, color:"#6b6760", margin:0, maxWidth:380, lineHeight:1.6 }}>
        Nobody is awake in there. Start the world and its characters boot; until then there is nothing to enter.
      </p>
      <div style={{ display:"flex", gap:8, marginTop:4 }}>
        <button onClick={() => navigate("/home")}
          style={{ fontSize:12, letterSpacing:".06em", textTransform:"uppercase", padding:"9px 18px", borderRadius:9,
            border:"1px solid rgba(0,0,0,.12)", background:"none", color:"#6b6760", cursor:"pointer" }}>← Home</button>
        {world.role === "owner" && (
          <button onClick={async () => {
              setStarting(true);
              await fetch(`/api/worlds/${worldId}/start`, { method:"POST", credentials:"include" });
              // Booting a world brings its actors up one at a time, and /start
              // answers before the supervisor has it. A single re-read after
              // the POST usually still said "stopped", so the button appeared
              // to do nothing. Ask until it is true, then give up rather than
              // spin forever.
              for (let i = 0; i < 12; i++) {
                await new Promise(r => setTimeout(r, 1500));
                const d = await fetch(`/api/worlds/${worldId}/status`, { credentials:"include" })
                  .then(r => r.ok ? r.json() : null).catch(() => null);
                if (d?.status === "running") {
                  setWorld(prev => prev ? { ...prev, status: "running" } : prev);
                  break;
                }
              }
              setStarting(false);
            }}
            disabled={starting}
            style={{ fontSize:12, letterSpacing:".06em", textTransform:"uppercase", padding:"9px 18px", borderRadius:9,
              border:"none", background:"#1a1814", color:"#faf8f4",
              cursor: starting ? "default" : "pointer", opacity: starting ? .5 : 1 }}>
            {starting ? "Starting…" : "Start world"}</button>
        )}
      </div>
    </div>
  );

  // Session 151 — the map stays the ground; instruments float over it.
  //
  // WorldEnterOverlay is untouched again. It already does the map, the presence
  // pins and the location panel well, and the instruments are additive: a rail
  // and a set of panels layered above, gated on role. What MONITOR was for now
  // happens here, on a surface that knows who is looking.
  return (
    <>
      <WorldEnterOverlay world={world} user={user} onClose={() => navigate("/home")} />
      <WorldInstruments world={world} />
    </>
  );
}
