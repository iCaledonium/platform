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
  const [relShift,    setRelShift]    = useState(null);
  const [modelName,   setModelName]   = useState("…");
  const [vitalToasts, setVitalToasts] = useState([]);
  const [ttsMode,     setTtsMode]     = useState("narrative"); // "conversational" | "narrative"
  const [tsMuted,     setTsMuted]     = useState(false);
  const [firstWordsDone, setFirstWordsDone] = useState(false);
  const tsMutedRef    = useRef(false);
  const ttsModeRef    = useRef("narrative");
  const prevVitalsRef = useRef(null);

  useEffect(() => {
    fetch("/api/encounter/model-status")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.model) setModelName(d.model); })
      .catch(() => setModelName("Haiku"));
  }, []);

  const esRef        = useRef(null);
  const enteredRef   = useRef(false);
  const waveTimer    = useRef(null);
  const waveRef      = useRef(null);
  const revealTimer  = useRef(null);
  const wordsRef     = useRef([]);
  const wordIdx      = useRef(0);
  const tlogRef      = useRef(null);
  const liveTextRef  = useRef("");
  const currentSpeakerRef = useRef("");

  // ── TTS audio queue ───────────────────────────────────────────────────────
  const ttsQueueRef      = useRef({});   // { [index]: HTMLAudioElement }
  const ttsExpectedRef   = useRef(-1);    // total sentences expected (-1 = unknown)
  const waveTimeoutRef   = useRef(null);   // safety timeout to stop wave
  const streamingTextRef = useRef("");   // raw token stream accumulator
  const ttsNextIdx    = useRef(0);
  const currentResponseId = useRef(null);
  const ttsPlaying    = useRef(false);

  const timeStr = new Date().toLocaleTimeString("sv-SE", {
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm"
  });

  // ── On mount: signal entry, open SSE ─────────────────────────────────────
  useEffect(() => {
    if (!playerActorId || !encounter_id) return;

    // Signal player has entered — triggers optional opening words + vitals broadcast
    // Fallback: unblock input after 30s even if first_words never arrives
    const firstWordsTimeout = setTimeout(() => setFirstWordsDone(true), 30000);

    if (!enteredRef.current) {
      enteredRef.current = true;
      fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/enter`, { method: "POST" })
        .catch(() => {});
    }

    const es = new EventSource(`/api/actors/${playerActorId}/stream`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "encounter_event" && data.encounter_id === encounter_id) {
          handleEvent(data);
        } else if (data.type === "encounter_tts" && data.encounter_id === encounter_id) {
          handleEvent(data);
        } else if (data.type === "encounter_token" && data.encounter_id === encounter_id) {
          handleEvent(data);
        } else if (data.type === "encounter_response_id" && data.encounter_id === encounter_id) {
          handleEvent(data);
        } else if (data.type === "encounter_tts_reset" && data.encounter_id === encounter_id) {
          handleEvent(data);
        }
      } catch {}
    };

    return () => {
      clearTimeout(firstWordsTimeout);
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
        if (Math.abs(delta) >= 0.01) {
          const dir    = delta > 0 ? "↑" : "↓";
          const from   = (prev[k] || 0).toFixed(2);
          const to     = (newVitals[k] || 0).toFixed(2);
          const toastId = crypto.randomUUID();
          const toast  = { id: toastId, label: labels[k], dir, from, to, up: delta > 0 };
          setVitalToasts(prev => [...prev.slice(-3), toast]);
          setTimeout(() => setVitalToasts(prev => prev.filter(t => t.id !== toastId)), 8000);
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
        setSending(false);
        setFirstWordsDone(true);
        if (payload.text) {
          setGlow("speaking");
          setOstText("Speaking");
          startWave();
          currentSpeakerRef.current = actorName;
          startTypewriter(displayText(payload.text), () => {
            finaliseResponse(displayText(payload.text));
            stopWave();
            setGlow("idle");
            setOstText("Idle");
          });
        }
        break;

      case "encounter_response":
        setLiveText("");
        setSending(false);
        // Start wave if tokens didn't already start it
        if (streamingTextRef.current === "") {
          setGlow("speaking");
          setOstText("Speaking");
          startWave();
          if (waveTimeoutRef.current) clearTimeout(waveTimeoutRef.current);
          waveTimeoutRef.current = setTimeout(() => {
            setGlow("idle");
            setOstText("Idle");
            stopWave();
          }, 30000);
        }
        if (payload.model)        setModelName(payload.model);
        if (payload.vitals)       updateVitals(payload.vitals);
        if (payload.need)         setNeed(payload.need);
        if (payload.relationship) updateRelationship(payload.relationship);
        if (payload.arc_signal && payload.arc_signal !== "neutral") {
          setArcSignal(payload.arc_signal);
          setTimeout(() => setArcSignal(null), 6000);
        }
        currentSpeakerRef.current = actorName;
        { // Finalise using streamed tokens, fall back to payload.text
          const streamedRaw = streamingTextRef.current.split("DELTAS:")[0].trim();
          const finalRaw = streamedRaw || payload.text;
          finaliseResponse(displayText(finalRaw), finalRaw);
          streamingTextRef.current = "";
          setLiveText("");
          // Count expected TTS sentences
          const sentenceCount = (finalRaw.match(/[^.!?…]+[.!?…]+/g) || [finalRaw]).length;
          ttsExpectedRef.current = sentenceCount;
        }
        break;

      case "encounter_vitals":
        if (payload.vitals) updateVitals(payload.vitals);
        break;

      case "encounter_rel_shift":
        if (payload.transitions && payload.transitions.length > 0) {
          setRelShift(payload.transitions);
          setTimeout(() => setRelShift(null), 6000);
        }
        break;

      case "encounter_heartbeat":
        if (!sending) setOstText(payload.message || "Still thinking…");
        break;

      case "encounter_warming":
        setOstText("Warming up the engine…");
        break;

      case "encounter_token": {
        // Skip DELTAS tokens
        if (payload.token) {
          const current = streamingTextRef.current;
          // Start wave on first token
          if (current === "") {
            setSending(false);
            setGlow("speaking");
            setOstText("Speaking");
            startWave();
            // Safety timeout — stop wave after 30s max
            if (waveTimeoutRef.current) clearTimeout(waveTimeoutRef.current);
            waveTimeoutRef.current = setTimeout(() => {
              setGlow("idle");
              setOstText("Idle");
              stopWave();
            }, 30000);
          }
          // Stop appending once DELTAS marker appears
          if (!current.includes("DELTAS:")) {
            streamingTextRef.current = current + payload.token;
            const displayStr = streamingTextRef.current.split("DELTAS:")[0];
            setLiveText(displayText(displayStr));
            scrollLog();
          }
        }
        break;
      }

      case "encounter_response_id":
        console.log('[TTS] new response_id=', payload.response_id);
        currentResponseId.current = payload.response_id;
        resetTtsQueue();
        break;

      case "encounter_tts_reset":
        if (!ttsPlaying.current) resetTtsQueue();
        break;

      case "encounter_tts": {
        console.log("[TTS] chunk received index=", payload.index, "response_id=", payload.response_id);
        if (!payload.wav_b64) { console.warn("[TTS] missing wav_b64"); break; }
        // Discard stale TTS from previous responses
        if (payload.response_id && currentResponseId.current && payload.response_id !== currentResponseId.current) {
          console.log("[TTS] discarding stale chunk response_id=", payload.response_id, "current=", currentResponseId.current);
          break;
        }
        const bytes = Uint8Array.from(atob(payload.wav_b64), c => c.charCodeAt(0));
        const blob  = new Blob([bytes], { type: "audio/wav" });
        const url   = URL.createObjectURL(blob);
        const audio = new Audio(url);
        ttsQueueRef.current[payload.index] = audio;
        playNextTtsChunk();
        break;
      }

      case "encounter_ended":
        setGlow("idle");
        setOstText("Gone");
        stopWave();
        resetTtsQueue();
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

  function finaliseResponse(text, rawText) {
    setMessages(prev => [...prev, { from: "them", text: rawText || text, speaker: actorName }]);
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

  function stripActions(text) {
    return text
      .replace(/\nDELTAS:[\s\S]*/g, "")  // strip DELTAS and everything after
      .replace(/DELTAS:[\s\S]*/g, "")
      .replace(/\*[^*]*\*/g, "")
      .replace(/\[laugh\]|\[chuckle\]|\[sigh\]|\[gasp\]|\[groan\]|\[moan\]|\[whisper\]/g, "")
      .replace(/[\u201c\u201d]/g, "\"")  // curly quotes → straight
      .replace(/^[\s"]+|[\s"]+$/g, "")   // trim leading/trailing quotes
      .replace(/\s+/g, " ")
      .trim();
  }

  function displayText(text) {
    const noTags = text
      .replace(/\[laugh\]|\[chuckle\]|\[sigh\]|\[gasp\]|\[groan\]|\[moan\]|\[whisper\]/gi, "")
      .replace(/\nDELTAS:[\s\S]*/g, "")
      .replace(/DELTAS:[\s\S]*/g, "")
      .replace(/\s+/g, " ").trim();
    return ttsModeRef.current === "conversational" ? stripActions(noTags) : noTags;
  }

  // ── TTS playback ─────────────────────────────────────────────────────────
  function resetTtsQueue() {
    ttsQueueRef.current  = {};
    ttsNextIdx.current   = 0;
    ttsPlaying.current   = false;
    ttsExpectedRef.current = -1;
    if (waveTimeoutRef.current) clearTimeout(waveTimeoutRef.current);
  }

  function playNextTtsChunk() {
    if (ttsPlaying.current) return;
    const audio = ttsQueueRef.current[ttsNextIdx.current];
    if (!audio) {
      // No chunk ready — silence gap, stop wave until next chunk arrives
      stopWave();
      return;
    }
    if (tsMutedRef.current) {
      // Skip all queued audio silently
      URL.revokeObjectURL(audio.src);
      delete ttsQueueRef.current[ttsNextIdx.current];
      ttsNextIdx.current++;
      playNextTtsChunk();
      return;
    }
    ttsPlaying.current = true;
    // Start wave only when audio actually plays
    startWave();
    setGlow("speaking");
    setOstText("Speaking");
    audio.onended = () => {
      URL.revokeObjectURL(audio.src);
      delete ttsQueueRef.current[ttsNextIdx.current];
      ttsNextIdx.current++;
      ttsPlaying.current = false;
      // All expected sentences done — stop wave
      if (ttsExpectedRef.current >= 0 && ttsNextIdx.current >= ttsExpectedRef.current) {
        ttsExpectedRef.current = -1;
        if (waveTimeoutRef.current) clearTimeout(waveTimeoutRef.current);
        setGlow("idle");
        setOstText("Idle");
        stopWave();
      } else {
        // Pause wave between chunks until next one arrives
        stopWave();
      }
      playNextTtsChunk();
    };
    audio.play().catch(() => {
      ttsPlaying.current = false;
      stopWave();
    });
  }

  // ── Send message ──────────────────────────────────────────────────────────
  async function sendMessage() {
    if (!chatInput.trim() || sending || !encounter_id) return;
    const content = chatInput.trim();
    setChatInput("");
    resetTtsQueue();
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
                {(relationship || need || arcSignal || relShift) && (
                  <div className={styles.relRow}>
                    {relShift ? (
                      <span className={styles.relShift}>
                        {relShift.map((t, i) => (
                          <span key={i}>
                            <span className={styles.relShiftDim}>{t.dimension}</span>
                            {" "}
                            <span className={styles.relShiftFrom}>{t.from.replace(/_/g, " ")}</span>
                            {" → "}
                            <span className={styles.relShiftTo}>{t.to.replace(/_/g, " ")}</span>
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className={`${styles.relStatus} ${statusFlash === "up" ? styles.relUp : statusFlash === "down" ? styles.relDown : ""}`}>
                        {relationship?.status?.replace(/_/g, " ")}
                      </span>
                    )}
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
                  {m.from === "them" ? displayText(m.text) : m.text}
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
              <textarea
                className={styles.ci}
                placeholder="Say something…"
                value={chatInput}
                disabled={sending || !firstWordsDone}
                rows={1}
                onChange={e => {
                  setChatInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
                  if (e.target.value.length > 0) {
                    fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/typing`, { method: "POST" }).catch(() => {});
                    if (ttsPlaying.current) {
                      resetTtsQueue();
                      stopWave();
                      setGlow("idle");
                      setOstText("Idle");
                    }
                  }
                }}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                    e.target.style.height = "auto";
                  }
                }}
                autoFocus
              />
              <div className={styles.inputActions}>
                <button
                  className={styles.iconBtn}
                  onClick={() => { const next = ttsMode === "conversational" ? "narrative" : "conversational"; setTtsMode(next); ttsModeRef.current = next; }}
                  title={ttsMode === "conversational" ? "Conversational" : "Narrative"}
                >{ttsMode === "conversational" ? "💬" : "📖"}</button>
                <button
                  className={styles.iconBtn}
                  onClick={() => { const next = !tsMuted; setTsMuted(next); tsMutedRef.current = next; }}
                  title={tsMuted ? "Unmute" : "Mute"}
                >{tsMuted ? "🔇" : "🔊"}</button>
                <button className={styles.sendBtn} onClick={sendMessage} disabled={sending || !firstWordsDone}>↑</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
