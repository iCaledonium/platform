import { useState, useEffect, useRef } from "react";
import styles from "./PresenceView.module.css";

const SIMULATOR_URL = "https://anima.simulator.ngrok.dev";

export default function PresenceView({ world, user, sceneData, actorName, actorPhoto, encounter_id, onLeave }) {
  const { location } = sceneData;
  const playerActorId = user?.worlds?.find(w => w.world_id === world.id)?.actor_id;

  const [glow,        setGlow]        = useState("idle");
  const [ostText,     setOstText]     = useState("Idle");
  const [messages,    setMessages]    = useState([]);
  const [liveText,    setLiveText]    = useState("");
  const [chatInput,   setChatInput]   = useState("");
  const [sending,     setSending]     = useState(false);
  const [vitals,      setVitals]      = useState(null);
  const [changedVitals, setChangedVitals] = useState({});
  const [need,        setNeed]        = useState(null);
  const [relationship, setRelationship] = useState(null);
  const [arcSignal,   setArcSignal]   = useState(null);
  const [statusFlash, setStatusFlash] = useState(null);
  const [modelName,   setModelName]   = useState("…");
  const [vitalToasts, setVitalToasts] = useState([]);
  const prevVitalsRef = useRef(null);

  useEffect(() => {
    fetch("/api/encounter/model-status")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.model) setModelName(d.model); })
      .catch(() => setModelName("Haiku"));
  }, []);

  const esRef        = useRef(null);
  const waveTimer    = useRef(null);
  const waveRef      = useRef(null);
  const revealTimer  = useRef(null);
  const wordsRef     = useRef([]);
  const wordIdx      = useRef(0);
  const tlogRef      = useRef(null);
  const liveTextRef  = useRef("");
  const currentSpeakerRef = useRef("");

  const timeStr = new Date().toLocaleTimeString("sv-SE", {
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm"
  });

  // ── On mount: signal entry, open SSE ─────────────────────────────────────
  useEffect(() => {
    if (!playerActorId || !encounter_id) return;

    // Signal player has entered — triggers optional opening words + vitals broadcast
    fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/enter`, { method: "POST" })
      .catch(() => {});

    const es = new EventSource(`/api/actors/${playerActorId}/stream`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "encounter_event" && data.encounter_id === encounter_id) {
          handleEvent(data);
        }
      } catch {}
    };

    return () => {
      es.close();
      stopWave();
      if (revealTimer.current) clearTimeout(revealTimer.current);
    };
  }, [playerActorId, encounter_id]);

  function updateVitals(newVitals) {
    if (!newVitals) return;
    const prev = prevVitalsRef.current;
    if (prev) {
      const changed = {};
      const labels = { energy: "Energy", mood: "Mood", desire: "Desire", sobriety: "Sobriety" };
      ["energy","mood","desire","sobriety"].forEach(k => {
        const delta = (newVitals[k] || 0) - (prev[k] || 0);
        if (Math.abs(delta) > 0.01) changed[k] = delta > 0 ? "up" : "down";
        if (Math.abs(delta) >= 0.03) {
          const dir    = delta > 0 ? "↑" : "↓";
          const from   = (prev[k] || 0).toFixed(2);
          const to     = (newVitals[k] || 0).toFixed(2);
          const toastId = crypto.randomUUID();
          const toast  = { id: toastId, label: labels[k], dir, from, to, up: delta > 0 };
          setVitalToasts(prev => [...prev.slice(-3), toast]);
          setTimeout(() => setVitalToasts(prev => prev.filter(t => t.id !== toastId)), 4000);
        }
      });
      if (Object.keys(changed).length > 0) {
        setChangedVitals(changed);
        setTimeout(() => setChangedVitals({}), 2500);
      }
    }
    prevVitalsRef.current = newVitals;
    setVitals(newVitals);
  }

  function updateRelationship(rel) {
    if (!rel) return;
    setRelationship(prev => {
      if (prev && prev.status !== rel.status) {
        const flash = rel.status === "dating" || rel.status === "partner" ? "up" : "down";
        setStatusFlash(flash);
        setTimeout(() => setStatusFlash(null), 2000);
      }
      return rel;
    });
  }

  function handleEvent(data) {
    const payload = data.data || data;
    switch (payload.type) {
      case "encounter_prestate":
        if (payload.vitals)       updateVitals(payload.vitals);
        if (payload.need)         setNeed(payload.need);
        if (payload.relationship) updateRelationship(payload.relationship);
        break;

      case "encounter_first_words":
        if (payload.vitals) updateVitals(payload.vitals);
        if (payload.text) {
          setGlow("speaking");
          setOstText("Speaking");
          startWave();
          currentSpeakerRef.current = actorName;
          startTypewriter(payload.text, () => {
            finaliseResponse(payload.text);
            stopWave();
            setGlow("idle");
            setOstText("Idle");
          });
        }
        break;

      case "encounter_response":
        setGlow("speaking");
        setOstText("Speaking");
        startWave();
        setSending(false);
        if (payload.model)        setModelName(payload.model);
        if (payload.vitals)       updateVitals(payload.vitals);
        if (payload.need)         setNeed(payload.need);
        if (payload.relationship) updateRelationship(payload.relationship);
        if (payload.arc_signal && payload.arc_signal !== "neutral") {
          setArcSignal(payload.arc_signal);
          setTimeout(() => setArcSignal(null), 6000);
        }
        currentSpeakerRef.current = actorName;
        startTypewriter(payload.text, () => {
          finaliseResponse(payload.text);
          stopWave();
          setGlow("idle");
          setOstText("Idle");
        });
        break;

      case "encounter_vitals":
        if (payload.vitals) updateVitals(payload.vitals);
        break;

      case "encounter_heartbeat":
        if (!sending) setOstText(payload.message || "Still thinking…");
        break;

      case "encounter_warming":
        setOstText("Warming up the engine…");
        break;

      case "encounter_ended":
        setGlow("idle");
        setOstText("Gone");
        stopWave();
        break;

      default:
        break;
    }
  }

  // ── Typewriter ────────────────────────────────────────────────────────────
  function startTypewriter(text, onDone) {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    wordsRef.current = text.split(" ");
    wordIdx.current  = 0;
    liveTextRef.current = "";
    setLiveText("");
    scrollLog();
    revealWord(onDone);
  }

  function revealWord(onDone) {
    if (wordIdx.current >= wordsRef.current.length) {
      if (onDone) onDone();
      return;
    }
    const word = wordsRef.current[wordIdx.current];
    wordIdx.current++;
    liveTextRef.current = liveTextRef.current ? liveTextRef.current + " " + word : word;
    setLiveText(liveTextRef.current);
    const delay = word.endsWith(".") || word.endsWith("…") || word.endsWith(",") ? 160 : 60;
    revealTimer.current = setTimeout(() => revealWord(onDone), delay);
  }

  function finaliseResponse(text) {
    setMessages(prev => [...prev, { from: "them", text, speaker: actorName }]);
    setLiveText("");
    liveTextRef.current = "";
    scrollLog();
  }

  function scrollLog() {
    setTimeout(() => {
      if (tlogRef.current) tlogRef.current.scrollTop = tlogRef.current.scrollHeight;
    }, 50);
  }

  // ── Waveform ──────────────────────────────────────────────────────────────
  function startWave() {
    if (waveTimer.current) return;
    if (waveRef.current) waveRef.current.classList.add(styles.wvOn);
    waveTimer.current = setInterval(() => {
      document.querySelectorAll(`.${styles.wb}`).forEach(b => {
        b.style.height = Math.round(2 + Math.random() * 20) + "px";
      });
    }, 90);
  }

  function stopWave() {
    if (waveTimer.current) { clearInterval(waveTimer.current); waveTimer.current = null; }
    if (waveRef.current) waveRef.current.classList.remove(styles.wvOn);
  }

  // ── Send message ──────────────────────────────────────────────────────────
  async function sendMessage() {
    if (!chatInput.trim() || sending || !encounter_id) return;
    const content = chatInput.trim();
    setChatInput("");
    setSending(true);
    setGlow("listening");
    setOstText("Listening");
    setMessages(prev => [...prev, { from: "me", text: content }]);
    scrollLog();

    try {
      await fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/message`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ content })
      });
      setGlow("thinking");
      setOstText("Thinking");
      scrollLog();
    } catch {
      setSending(false);
      setGlow("idle");
      setOstText("Idle");
    }
  }

  async function leave() {
    if (encounter_id) {
      fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/end`, { method: "POST" })
        .catch(() => {});
    }
    fetch(`/api/worlds/${world.id}/leave`, { method: "POST" }).catch(() => {});
    onLeave();
  }

  const glowClass = `${styles.fglow} ${styles["fglow_" + glow] || ""}`;

  return (
    <div className={styles.scene}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.logo}>Anima</span>
        <span className={styles.loc}>{location.name} · {location.area} · {timeStr}</span>
        <button className={styles.leaveBtn} onClick={leave}>Leave</button>
      </div>

      {/* Model indicator */}
      <div style={{
        position: "absolute", bottom: 12, left: 14, zIndex: 20,
        fontFamily: "'DM Sans',system-ui,sans-serif", fontSize: 10,
        color: modelName === "Hermes-3-70B" ? "rgba(0,220,130,0.85)" : "rgba(220,220,220,0.6)",
        letterSpacing: "0.06em", pointerEvents: "none",
        textShadow: "0 1px 4px rgba(0,0,0,0.9)"
      }}>◈ {modelName}</div>

      <div className={styles.body}>
        {/* Photo + vitals overlay */}
        <div className={styles.compCol}>
          <div className={styles.wrap}>
            {actorPhoto
              ? <img src={actorPhoto} className={styles.photo} alt={actorName} />
              : <div className={styles.photoPlaceholder}><span className={styles.initials}>{actorName[0]}</span></div>
            }

            {/* Frame */}
            <div className={`${styles.fglow} ${styles["fglow_" + glow]}`} />
            <div className={`${styles.fc} ${styles.tl}`} />
            <div className={`${styles.fc} ${styles.tr}`} />
            <div className={`${styles.fc} ${styles.bl}`} />
            <div className={`${styles.fc} ${styles.br}`} />

            {/* Name + status */}
            <div className={styles.nameOv}>
              <div className={styles.nm}>{actorName}</div>
              <div className={`${styles.ost} ${styles["ost_" + glow]}`}>{ostText}</div>
            </div>

            {/* Waveform */}
            <div className={styles.wv} ref={waveRef}>
              {[3,6,10,16,20,16,10,6,3].map((h, i) => (
                <div key={i} className={styles.wb} style={{ height: h + "px" }} />
              ))}
            </div>

            {/* Vitals overlay */}
            {vitals && (
              <div className={styles.vitalsBox}>
                <div className={styles.vitalsTitle}>Vitals</div>
                {[
                  ["Energy",   vitals.energy,    vitals.energy > 0.4],
                  ["Mood",     vitals.mood,       vitals.mood > 0.4],
                  ["Desire",   vitals.desire,     true],
                  ["Sobriety", vitals.sobriety,   vitals.sobriety > 0.7],
                ].map(([label, val, healthy]) => {
                  const key = label.toLowerCase();
                  const flash = changedVitals[key];
                  return (
                    <div key={label} className={styles.vRow}>
                      <div className={styles.vLabel}>
                        <span>{label}</span>
                        <span className={`${styles.vVal} ${flash === "up" ? styles.vFlashUp : flash === "down" ? styles.vFlashDown : ""}`}>
                          {val?.toFixed(2)}
                        </span>
                      </div>
                      <div className={styles.vTrack}>
                        <div
                          className={`${styles.vFill} ${label === "Desire" ? styles.vDesire : healthy ? styles.vg : styles.vw} ${flash ? styles.vBarFlash : ""}`}
                          style={{ width: Math.round((val || 0) * 100) + "%" }}
                        />
                      </div>
                    </div>
                  );
                })}
                {/* Bottom row — relationship + need + arc signal */}
                {(relationship || need || arcSignal) && (
                  <div className={styles.relRow}>
                    <span className={`${styles.relStatus} ${statusFlash === "up" ? styles.relUp : statusFlash === "down" ? styles.relDown : ""}`}>
                      {relationship?.status?.replace(/_/g, " ")}
                    </span>
                    <span className={styles.bottomRight}>
                      {need && <span className={styles.needInline}>{need.label}</span>}
                      {arcSignal && <span className={styles.arcSignal}>◈ {arcSignal}</span>}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Vital change toasts */}
          {vitalToasts.map((t, i) => (
            <div key={t.id}
                 className={`${styles.vitalToast} ${t.up ? styles.vitalToastUp : styles.vitalToastDown}`}
                 style={{ top: 130 + i * 30 }}>
              {t.label} {t.dir} {t.from} → {t.to}
            </div>
          ))}
        </div>

        {/* Chat */}
        <div className={styles.chatCol}>
          <div className={styles.chatHdr}>In person</div>
          <div className={styles.tlog} ref={tlogRef}>
            {messages.map((m, i) => (
              <div key={i}>
                <div className={`${styles.tlLabel} ${m.from === "me" ? styles.tlYouLabel : styles.tlCompLabel}`}>
                  {m.from === "me" ? "You" : m.speaker || actorName}
                </div>
                <div className={`${styles.tlBubble} ${m.from === "me" ? styles.tlYou : styles.tlComp}`}>
                  {m.text}
                </div>
              </div>
            ))}

            {/* Live response text */}
            {liveText && (
              <div>
                <div className={styles.tlCompLabel}>{actorName}</div>
                <div className={`${styles.tlBubble} ${styles.tlComp}`}>{liveText}</div>
              </div>
            )}

            {/* Thinking dots */}
            {sending && !liveText && (
              <div className={styles.tlTyping}>
                <span/><span/><span/>
              </div>
            )}
          </div>

          <div className={styles.inputRow}>
            <div className={styles.inputShell}>
              <input
                className={styles.ci}
                placeholder="Say something…"
                value={chatInput}
                onChange={e => {
                  setChatInput(e.target.value);
                  if (e.target.value.length > 0) {
                    fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/typing`, { method: "POST" }).catch(() => {});
                  }
                }}
                onKeyDown={e => e.key === "Enter" && sendMessage()}
                autoFocus
              />
            </div>
            <button className={styles.sendBtn} onClick={sendMessage} disabled={sending}>→</button>
          </div>
        </div>
      </div>
    </div>
  );
}
