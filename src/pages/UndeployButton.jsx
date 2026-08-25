import { useState } from "react";

// ── Remove from world ────────────────────────────────────────────────────────
//
// Session 152 — the same action, wherever you are looking at the deployment.
//
// It existed in exactly one place: a 14px ✕ drawn at 50% opacity in green on a
// green chip, inside the card in the gallery list. Two people looking for it on
// the pages that actually show the deployment — the character's own In Play
// section, and the world's runtime page — found nothing and concluded there was
// no undeploy at all. A control that is only discoverable by hovering the right
// 14 pixels is not discoverable.
//
// The wording is copied from the gallery deliberately. The same destructive act
// should read identically in all three places, or the third one looks like it
// might do something else.
const ERASE_NOTE =
  "Her instance in that world is erased — relationships, memories, schedule, " +
  "bank account. The profile is kept and can be deployed again.";

const F = { fontFamily: "'DM Sans',system-ui,sans-serif" };

export default function UndeployButton({ actorId, worldId, worldName, name, onDone, subtle }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res  = await fetch(`/api/actors/${actorId}/undeploy`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world_id: worldId }),
      });
      const data = await res.json().catch(() => ({}));
      // Session 150's lesson, kept: a failed undeploy that updates the UI anyway
      // looks exactly like a successful one until the next reload.
      if (!res.ok || data.error) {
        setError(data.error || `HTTP ${res.status}`);
        setBusy(false);
        return;
      }
      setAsking(false);
      setBusy(false);
      onDone?.(data);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <>
      <span
        onClick={e => { e.stopPropagation(); setAsking(true); }}
        title={`Remove from ${worldName || "this world"}`}
        style={{
          ...F, fontSize: subtle ? 10 : 11, letterSpacing: ".04em",
          color: "#a8a5a0", cursor: "pointer", padding: subtle ? "2px 6px" : "5px 10px",
          border: subtle ? "none" : "1px solid rgba(0,0,0,.1)", borderRadius: 7,
          whiteSpace: "nowrap", display: "inline-block",
        }}
        onMouseEnter={e => { e.currentTarget.style.color = "#993c1d"; e.currentTarget.style.borderColor = "rgba(153,60,29,.35)"; }}
        onMouseLeave={e => { e.currentTarget.style.color = "#a8a5a0"; e.currentTarget.style.borderColor = "rgba(0,0,0,.1)"; }}>
        Remove from world
      </span>

      {asking && (
        <div onClick={e => { e.stopPropagation(); setAsking(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(20,18,15,.28)", backdropFilter: "blur(3px)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 4000, padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: "rgba(255,255,255,.96)", border: "1px solid rgba(255,255,255,.95)",
              boxShadow: "0 8px 64px rgba(0,0,0,.14)", borderRadius: 18, maxWidth: 440, width: "100%", padding: "22px 24px" }}>
            <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 19, fontWeight: 500, color: "#1a1814", marginBottom: 8 }}>
              Remove {name || "her"} from {worldName || "this world"}?
            </div>
            <div style={{ ...F, fontSize: 13, color: "#6b6760", lineHeight: 1.55, marginBottom: 18 }}>
              {ERASE_NOTE}
            </div>
            {error && (
              <div style={{ ...F, fontSize: 12, color: "#993c1d", marginBottom: 14 }}>
                Undeploy failed: {error}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setAsking(false)} disabled={busy}
                style={{ ...F, fontSize: 12, padding: "9px 16px", borderRadius: 9, border: "1px solid rgba(0,0,0,.12)",
                  background: "transparent", color: "#6b6760", cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={run} disabled={busy}
                style={{ ...F, fontSize: 12, padding: "9px 16px", borderRadius: 9, border: "none",
                  background: "#1a1814", color: "#faf8f4", cursor: busy ? "wait" : "pointer", opacity: busy ? .6 : 1 }}>
                {busy ? "Removing…" : `Remove from ${worldName || "world"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
