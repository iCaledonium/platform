import { useNavigate } from "react-router-dom";

// ── Test Lab · Home ──────────────────────────────────────────────────────────
//
// The index of every test case the lab offers. Each case is a page under
// /lab/<subject>/<place>/<situation>; adding one is a single entry here plus
// its route in App.jsx — nginx serves the whole /lab prefix already.

const GOLD = "rgba(201,151,58,";

const CASES = [
  {
    path: "/lab/actor/apartment/encounter",
    subject: "Actor",
    place: "Apartment",
    situation: "Encounter",
    blurb: "The door pipeline — begin at knock, threshold, or inside. " +
      "Fixtures author her past; everything after the chosen stage is the production path.",
    live: true,
  },
  {
    path: "/lab/transport/actor",
    subject: "Transport",
    place: "—",
    situation: "Actor",
    blurb: "Moving an actor from A to B — departure, mode, route, arrival. " +
      "Author the contract and the garage; never the journey. Carries its own scorecard.",
    live: true,
  },
];

export default function LabHomePage() {
  const navigate = useNavigate();

  const label = { fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase",
    color: "rgba(255,255,255,.4)" };

  const card = (live) => ({
    display: "flex", flexDirection: "column", gap: 8, padding: "16px 18px",
    background: live ? "rgba(255,255,255,.025)" : "rgba(255,255,255,.012)",
    border: `0.5px solid ${live ? "rgba(255,255,255,.1)" : "rgba(255,255,255,.05)"}`,
    borderRadius: 6, cursor: live ? "pointer" : "default",
  });

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: "rgba(255,255,255,.92)" }}>Test Lab</span>
          <span style={{ ...label, color: GOLD + ".65)" }}>owner's tool</span>
        </div>
        <button onClick={() => navigate("/home")}
          style={{ padding: "8px 16px", background: "transparent", border: "0.5px solid rgba(255,255,255,.14)",
            borderRadius: 4, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
            fontSize: 11, color: "rgba(255,255,255,.6)" }}>Close</button>
      </div>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "24px 24px 60px",
        display: "flex", flexDirection: "column", gap: 24 }}>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={label}>Test cases</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {CASES.map(c => (
              <div key={c.path} onClick={() => c.live && navigate(c.path)} style={card(c.live)}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
                  <span style={{ fontSize: 13.5, color: c.live ? GOLD + ".95)" : "rgba(255,255,255,.3)" }}>
                    {c.subject} · {c.place} · {c.situation}
                  </span>
                  <span style={{ ...label, fontSize: 9,
                    color: c.live ? "rgba(150,210,150,.75)" : "rgba(255,255,255,.25)" }}>
                    {c.live ? "live" : "planned"}
                  </span>
                </div>
                <span style={{ fontSize: 11, lineHeight: 1.6,
                  color: c.live ? "rgba(255,255,255,.45)" : "rgba(255,255,255,.22)" }}>{c.blurb}</span>
                <span style={{ fontSize: 9.5, fontFamily: "ui-monospace,monospace",
                  color: c.live ? "rgba(255,255,255,.3)" : "rgba(255,255,255,.15)" }}>{c.path}</span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
