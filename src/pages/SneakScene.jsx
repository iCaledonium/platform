import { useState, useEffect, useRef } from "react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAction(speech) {
  // Split "*action text*" from spoken words
  const parts = [];
  const re = /\*([^*]+)\*/g;
  let last = 0, m;
  while ((m = re.exec(speech)) !== null) {
    if (m.index > last) parts.push({ type: "speech", text: speech.slice(last, m.index).trim() });
    parts.push({ type: "action", text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < speech.length) {
    const tail = speech.slice(last).trim();
    if (tail) parts.push({ type: "speech", text: tail });
  }
  return parts;
}

function getColor(name, participants) {
  return participants.find(p => p.name === name)?.color || "#aaa";
}

// ── Components ────────────────────────────────────────────────────────────────

function TurnBubble({ turn, participants, visible }) {
  const parts    = parseAction(turn.speech);
  const p        = participants.find(p => p.name === turn.speaker);
  const color    = p?.color || "#aaa";
  const initials = p?.initials || turn.speaker[0];
  const photo    = p?.photo_url || null;

  return (
    <div style={{
      display: "flex",
      gap: 10,
      opacity: visible ? 1 : 0,
      transform: visible ? "translateY(0)" : "translateY(12px)",
      transition: "opacity 0.4s ease, transform 0.4s ease",
      marginBottom: 18,
    }}>
      {/* Avatar */}
      <div style={{
        width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
        background: `${color}22`, border: `1.5px solid ${color}55`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 9, fontWeight: 600, color, marginTop: 2,
        fontFamily: "'DM Sans', sans-serif", letterSpacing: "0.03em",
        overflow: "hidden",
      }}>
        {photo
          ? <img src={photo} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
              onError={e => { e.target.style.display = "none"; e.target.nextSibling.style.display = "flex"; }} alt="" />
          : null}
        <span style={{ display: photo ? "none" : "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%" }}>
          {initials}
        </span>
      </div>

      <div style={{ flex: 1 }}>
        {/* Speaker name */}
        <div style={{
          fontSize: 9, fontWeight: 600, color,
          letterSpacing: "0.7px", marginBottom: 4,
          fontFamily: "'DM Sans', sans-serif",
          textTransform: "uppercase"
        }}>
          {turn.speaker}
        </div>

        {/* Message parts */}
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {parts.map((p, i) => p.type === "action" ? (
            <span key={i} style={{
              fontSize: 12, color: "rgba(255,255,255,0.38)",
              fontStyle: "italic", fontFamily: "'Cormorant Garamond', serif",
              lineHeight: 1.5
            }}>
              {p.text}
            </span>
          ) : (
            <span key={i} style={{
              fontSize: 13.5, color: "rgba(255,255,255,0.88)",
              fontFamily: "'DM Sans', sans-serif", lineHeight: 1.55,
            }}>
              {p.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function LivePill() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn(v => !v), 900);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      background: "rgba(255,255,255,0.06)", borderRadius: 20,
      padding: "4px 10px",
      fontFamily: "'DM Sans', sans-serif", fontSize: 10,
      color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em"
    }}>
      <div style={{
        width: 6, height: 6, borderRadius: "50%",
        background: on ? "#e05252" : "transparent",
        border: "1.5px solid #e05252",
        transition: "background 0.3s"
      }} />
      LIVE
    </div>
  );
}

function ParticipantPill({ p }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 7,
      background: "rgba(255,255,255,0.05)", borderRadius: 20,
      padding: "4px 10px 4px 6px",
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <div style={{
        width: 20, height: 20, borderRadius: "50%",
        background: `${p.color}22`, border: `1.5px solid ${p.color}55`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 8, fontWeight: 600, color: p.color,
        overflow: "hidden", flexShrink: 0,
      }}>
        {p.photo_url
          ? <img src={p.photo_url} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
              onError={e => { e.target.style.display = "none"; e.target.nextSibling.style.display = "flex"; }} alt="" />
          : null}
        <span style={{ display: p.photo_url ? "none" : "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%" }}>
          {p.initials}
        </span>
      </div>
      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", letterSpacing: "0.02em" }}>
        {p.name}
      </span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SneakScene({
  world,
  user,
  location,
  sessionId,
  participants = [],
  onLeave
}) {
  const [turns,       setTurns]       = useState([]);
  const [visibleIds,  setVisibleIds]  = useState(new Set());
  const [scene, setScene] = useState(location?.name || "");
  const [bars, setBars] = useState({ warmth: null, tension: null, trust: null });
  const feedRef  = useRef(null);

  // ── Live SSE feed from simulator ─────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/meeting/${sessionId}/stream`);
    let turnId = 0;

    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);

        if (payload.type === "meeting_turn") {
          const { speaker_name, speech, action, scene_description, deltas } = payload;
          if (!speech && !action) return;

          const parts = [];
          if (action) parts.push(`*${action}*`);
          if (speech) parts.push(speech);
          const fullText = parts.join(" ");

          turnId++;
          const id = turnId;
          setTurns(prev => [...prev, { id, speaker: speaker_name, speech: fullText, ts: Date.now() }]);
          setTimeout(() => {
            setVisibleIds(prev => new Set([...prev, id]));
          }, 80);

          if (scene_description) setScene(scene_description);

          if (deltas) {
            setBars(prev => ({
              warmth:  deltas.warmth  !== undefined ? deltas.warmth  : prev.warmth,
              tension: deltas.tension !== undefined ? deltas.tension : prev.tension,
              trust:   deltas.trust   !== undefined ? deltas.trust   : prev.trust,
            }));
          }
        }

        if (payload.type === "meeting_ended") {
          turnId++;
          const id = turnId;
          setTurns(prev => [...prev, {
            id, speaker: "—", speech: "*The meeting has ended.*", ts: Date.now()
          }]);
          setTimeout(() => {
            setVisibleIds(prev => new Set([...prev, id]));
          }, 80);
        }
      } catch {}
    };

    es.onerror = () => {};
    return () => es.close();
  }, [sessionId]);

  // Auto-scroll feed
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [turns.length]);

  const locationName = location?.name || "Frida's apartment";
  const locationSub  = location?.formatted_address || "West Hollywood, Los Angeles";

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 2000,
      background: "#080a0e",
      display: "flex", flexDirection: "column",
      fontFamily: "'DM Sans', sans-serif",
    }}>

      {/* ── Top bar ── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 20px",
        borderBottom: "0.5px solid rgba(255,255,255,0.07)",
        flexShrink: 0,
      }}>
        {/* Left — location */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div>
            <div style={{
              fontFamily: "'Cormorant Garamond', serif",
              fontSize: 17, fontWeight: 500, color: "rgba(255,255,255,0.88)",
              lineHeight: 1.2
            }}>
              {locationName}
            </div>
            <div style={{
              fontSize: 10, color: "rgba(255,255,255,0.3)",
              letterSpacing: "0.06em", marginTop: 1,
              textTransform: "uppercase"
            }}>
              {locationSub}
            </div>
          </div>
        </div>

        {/* Right — participants + live + close */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {participants.map(p => <ParticipantPill key={p.name} p={p} />)}
          <LivePill />
          <button
            onClick={onLeave}
            style={{
              marginLeft: 4,
              background: "rgba(255,255,255,0.06)",
              border: "0.5px solid rgba(255,255,255,0.12)",
              borderRadius: 8, padding: "6px 14px",
              color: "rgba(255,255,255,0.45)",
              fontSize: 11, cursor: "pointer",
              fontFamily: "'DM Sans', sans-serif",
              transition: "background 0.15s, color 0.15s",
            }}
            onMouseEnter={e => { e.target.style.background = "rgba(255,255,255,0.1)"; e.target.style.color = "rgba(255,255,255,0.8)"; }}
            onMouseLeave={e => { e.target.style.background = "rgba(255,255,255,0.06)"; e.target.style.color = "rgba(255,255,255,0.45)"; }}
          >
            ✕ Leave
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* ── Scene image panel (left, 40%) ── */}
        <div style={{
          width: "40%", flexShrink: 0,
          position: "relative", overflow: "hidden",
          borderRight: "0.5px solid rgba(255,255,255,0.06)",
          display: "flex", flexDirection: "column",
        }}>
          {/* Scene description area */}
          <div style={{
            flex: 1,
            background: "linear-gradient(160deg, #12181f 0%, #0a0c10 60%, #080a0e 100%)",
            display: "flex", alignItems: "flex-end",
            position: "relative", overflow: "hidden",
          }}>
            {/* Subtle ambient shape */}
            <div style={{
              position: "absolute", inset: 0,
              background: "radial-gradient(ellipse at 50% 35%, rgba(255,255,255,0.025) 0%, transparent 65%)",
              pointerEvents: "none",
            }} />
            <div style={{ padding: "0 20px 20px", position: "relative", zIndex: 1 }}>
              <div style={{
                fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase",
                color: "rgba(255,255,255,0.2)", marginBottom: 8,
                fontFamily: "'DM Sans', sans-serif",
              }}>Scene</div>
              <div style={{
                fontFamily: "'Cormorant Garamond', serif",
                fontSize: 15, color: "rgba(255,255,255,0.52)",
                fontStyle: "italic", lineHeight: 1.65,
              }}>
                {scene}
              </div>
            </div>
          </div>

          {/* Relationship bars */}
          {(bars.warmth !== null || bars.tension !== null || bars.trust !== null) && (
            <div style={{
              padding: "12px 18px 14px",
              borderTop: "0.5px solid rgba(255,255,255,0.06)",
              display: "flex", flexDirection: "column", gap: 8,
            }}>
              {[
                { key: "warmth",  label: "Warmth",  color: "rgba(180,120,90,0.65)"  },
                { key: "tension", label: "Tension",  color: "rgba(180,60,60,0.65)"   },
                { key: "trust",   label: "Trust",    color: "rgba(90,140,200,0.65)"  },
              ].map(({ key, label, color }) => bars[key] !== null && (
                <div key={key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{
                    fontSize: 9, letterSpacing: "0.09em", textTransform: "uppercase",
                    color: "rgba(255,255,255,0.2)", width: 46, flexShrink: 0,
                    fontFamily: "'DM Sans', sans-serif",
                  }}>{label}</div>
                  <div style={{
                    flex: 1, height: 2,
                    background: "rgba(255,255,255,0.07)", borderRadius: 2, overflow: "hidden",
                  }}>
                    <div style={{
                      height: "100%", borderRadius: 2, background: color,
                      width: `${Math.round(bars[key] * 100)}%`,
                      transition: "width 1.2s ease",
                    }} />
                  </div>
                  <div style={{
                    fontSize: 9, color: "rgba(255,255,255,0.22)",
                    width: 28, textAlign: "right", flexShrink: 0,
                    fontFamily: "'DM Sans', sans-serif",
                  }}>{bars[key].toFixed(2)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Conversation feed (right, 60%) ── */}
        <div style={{
          flex: 1, display: "flex", flexDirection: "column", overflow: "hidden",
        }}>

          {/* Feed header */}
          <div style={{
            padding: "10px 24px 8px",
            borderBottom: "0.5px solid rgba(255,255,255,0.05)",
            display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
          }}>
            <div style={{ flex: 1, height: "0.5px", background: "rgba(255,255,255,0.05)" }} />
            <span style={{
              fontSize: 10, color: "rgba(255,255,255,0.15)",
              fontStyle: "italic", fontFamily: "'Cormorant Garamond', serif"
            }}>
              Observing
            </span>
          </div>

          {/* Messages */}
          <div
            ref={feedRef}
            style={{
              flex: 1, overflowY: "auto", padding: "24px 24px 32px",
              scrollbarWidth: "none",
            }}
          >
            {turns.length === 0 && (
              <div style={{
                color: "rgba(255,255,255,0.15)", fontSize: 13,
                fontStyle: "italic", fontFamily: "'Cormorant Garamond', serif",
                textAlign: "center", marginTop: 60
              }}>
                Waiting for the scene to begin…
              </div>
            )}
            {turns.map(turn => (
              <TurnBubble
                key={turn.id}
                turn={turn}
                participants={participants}
                visible={visibleIds.has(turn.id)}
              />
            ))}
          </div>

          {/* Discretion notice */}
          <div style={{
            padding: "10px 24px",
            borderTop: "0.5px solid rgba(255,255,255,0.05)",
            flexShrink: 0,
          }}>
            <p style={{
              margin: 0, fontSize: 10,
              color: "rgba(255,255,255,0.12)",
              fontStyle: "italic", textAlign: "center",
              fontFamily: "'Cormorant Garamond', serif",
              letterSpacing: "0.03em"
            }}>
              They don't know you're watching.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
