import { useState, useEffect, useRef, useCallback } from "react";
import styles from "./Scene.module.css";
import PresenceView from "./PresenceView.jsx";

const SIMULATOR_URL = "https://anima.simulator.ngrok.dev";

// ── Chroma key constants ──────────────────────────────────────────────────────
const KEY_R = 0, KEY_G = 177, KEY_B = 64;  // #00b140
const TOLERANCE = 120, SOFTNESS = 30, SPILL = 60;

function chromaKey(pixels) {
  const d = pixels.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    const dist = Math.sqrt((r-KEY_R)**2 + (g-KEY_G)**2 + (b-KEY_B)**2);
    if (dist < TOLERANCE) {
      d[i+3] = 0;
    } else if (dist < TOLERANCE + SOFTNESS) {
      const a = (dist - TOLERANCE) / SOFTNESS;
      d[i+3] = Math.round(255 * a);
      if (KEY_G > KEY_R && KEY_G > KEY_B) {
        const sf = SPILL / 100;
        d[i+1] = Math.round(g - (g - Math.max(r,b)) * sf * (1 - a));
      }
    } else if (SPILL > 0 && KEY_G > KEY_R && KEY_G > KEY_B) {
      const sf = (SPILL / 100) * Math.max(0, 1 - (dist - TOLERANCE - SOFTNESS) / 60);
      if (sf > 0) d[i+1] = Math.round(g - (g - Math.max(r,b)) * sf * 0.3);
    }
  }
}

// ── Green screen compositor hook ─────────────────────────────────────────────
function useGreenScreen(canvasRef, videoRef, bgRef) {
  const offRef  = useRef(null);
  const frameRef = useRef(null);

  const renderLoop = useCallback(() => {
    const canvas = canvasRef.current;
    const video  = videoRef.current;
    if (!canvas || !video || video.readyState < 2) {
      frameRef.current = requestAnimationFrame(renderLoop);
      return;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const W = canvas.width, H = canvas.height;

    // Draw background
    const bg = bgRef.current;
    if (bg && bg.complete && bg.naturalWidth) {
      ctx.drawImage(bg, 0, 0, W, H);
    } else {
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "#1a1008");
      grad.addColorStop(0.5, "#2d1f0e");
      grad.addColorStop(1, "#1a1008");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    // Composite character with chroma key
    const off = offRef.current;
    if (!off) { frameRef.current = requestAnimationFrame(renderLoop); return; }
    const vW = video.videoWidth || W;
    const vH = video.videoHeight || H;
    off.width  = vW;
    off.height = vH;
    const offCtx = off.getContext("2d", { willReadFrequently: true });
    offCtx.clearRect(0, 0, vW, vH);
    offCtx.drawImage(video, 0, 0, vW, vH);

    const pixels = offCtx.getImageData(0, 0, vW, vH);
    chromaKey(pixels);
    offCtx.putImageData(pixels, 0, 0);

    // Fit character — maintain aspect ratio
    const aspect = vW / vH;
    const fitH   = H;
    const fitW   = fitH * aspect;
    const dX     = (W - fitW) / 2;
    ctx.drawImage(off, 0, 0, vW, vH, dX, 0, fitW, fitH);

    frameRef.current = requestAnimationFrame(renderLoop);
  }, [canvasRef, videoRef, bgRef]);

  useEffect(() => {
    offRef.current = document.createElement("canvas");
    frameRef.current = requestAnimationFrame(renderLoop);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [renderLoop]);
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Scene({ world, user, sceneData, onLeave }) {
  const { location, encounter_id, trigger } = sceneData;

  const playerActorId = user?.worlds?.find(w => w.world_id === world.id)?.actor_id;
  const primaryActor  = location.actors && location.actors.find(a => a.actor_id !== playerActorId);

  const [phase,        setPhase]        = useState(encounter_id ? "loading" : "empty");
  const [actorName,    setActorName]    = useState(primaryActor?.name || "");
  const [actorPhoto,   setActorPhoto]   = useState(
    primaryActor?.photo_url ? (primaryActor.photo_url.startsWith('http') ? primaryActor.photo_url : `${SIMULATOR_URL}${primaryActor.photo_url}`) : null
  );
  const [narrative,    setNarrative]    = useState("");
  const [displayed,    setDisplayed]    = useState("");
  const [decision,     setDecision]     = useState(null);
  const [statusText,   setStatusText]   = useState(phaseStatus("loading", trigger));
  const [isWarming,    setIsWarming]    = useState(false);
  const [chatInput,    setChatInput]    = useState("");
  const [messages,     setMessages]     = useState([]);
  const [sending,      setSending]      = useState(false);
  const [responding,   setResponding]   = useState(false);
  const [liveResponse, setLiveResponse] = useState("");
  const [showEnterBtn, setShowEnterBtn] = useState(false);
  const [showPresence, setShowPresence] = useState(false);
  const [videoReady,   setVideoReady]   = useState(false);

  const liveResponseRef  = useRef("");
  const responseWordsRef = useRef([]);
  const responseIdxRef   = useRef(0);
  const responseTimerRef = useRef(null);
  const onNarrativeDone  = useRef(null);
  const esRef            = useRef(null);
  const revealTimer      = useRef(null);
  const wordsRef         = useRef([]);
  const wordIdx          = useRef(0);

  // ── Green screen refs ───────────────────────────────────────────────────────
  const canvasRef  = useRef(null);
  const idleRef    = useRef(null);
  const talkRef    = useRef(null);
  const activeRef  = useRef(null);  // currently playing video element
  const bgImgRef   = useRef(null);

  // Build video base URL from primaryActor
  const videoBase = primaryActor?.actor_id
    ? `${SIMULATOR_URL}/media/worlds/${world.id}/actors/${primaryActor.actor_id}/videos`
    : null;

  // ── Load videos ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!videoBase) return;

    const idle = document.createElement("video");
    idle.crossOrigin = 'anonymous';
    idle.src         = `${videoBase}/frida_standing_casual_idle_loop.mp4`;
    idle.loop        = true;
    idle.muted       = true;
    idle.playsInline = true;
    idle.autoplay    = true;
    idle.addEventListener("loadeddata", () => {
      idle.play().catch(() => {});
      setVideoReady(true);
    });
    idleRef.current  = idle;
    activeRef.current = idle;

    const talk = document.createElement("video");
    talk.crossOrigin = 'anonymous';
    talk.src         = `${videoBase}/frida_standing_casual_talking_loop.mp4`;
    talk.loop        = true;
    talk.muted       = true;
    talk.playsInline = true;
    talkRef.current  = talk;
    // Preload
    talk.load();

    return () => {
      idle.pause(); idle.src = "";
      talk.pause(); talk.src = "";
    };
  }, [videoBase]);

  // ── Switch between idle and talking ─────────────────────────────────────────
  useEffect(() => {
    if (!idleRef.current || !talkRef.current) return;
    if (responding) {
      idleRef.current.pause();
      talkRef.current.currentTime = 0;
      talkRef.current.play().catch(() => {});
      activeRef.current = talkRef.current;
    } else {
      talkRef.current.pause();
      idleRef.current.play().catch(() => {});
      activeRef.current = idleRef.current;
    }
  }, [responding]);

  // Pass active video to compositor via a ref that updates
  const videoRef = useRef(null);
  useEffect(() => {
    videoRef.current = activeRef.current;
  });

  // Sync videoRef when active changes
  const liveVideoRef = {
    get current() { return activeRef.current; }
  };

  // ── Green screen compositor ──────────────────────────────────────────────────
  useGreenScreen(canvasRef, liveVideoRef, bgImgRef);

  // ── Canvas sizing ────────────────────────────────────────────────────────────
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width  = w;
        canvas.height = h;
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // ── Poll on mount ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!encounter_id) return;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const r = await fetch(`/api/worlds/${world.id}/encounter/${encounter_id}`);
        const data = await r.json();
        if (data.decision && data.narrative && !displayed && !narrative) {
          stopped = true;
          setPhase(data.phase || data.decision);
          setDecision(data.decision);
          if (data.actor_name) setActorName(data.actor_name);
          setTimeout(() => {
            const onDone = data.decision === "open_door" ? () => setShowEnterBtn(true) : null;
            startTypewriter(data.narrative, onDone);
          }, 100);
        }
      } catch {}
    };
    const timers = [];
    for (let i = 1; i <= 60; i++) timers.push(setTimeout(poll, i * 5000));
    return () => { stopped = true; timers.forEach(clearTimeout); };
  }, [encounter_id]);

  // ── SSE ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playerActorId || !encounter_id) return;
    const es = new EventSource(`/api/actors/${playerActorId}/stream`);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "encounter_event" && data.encounter_id === encounter_id) {
          handleEncounterEvent(data);
        }
      } catch {}
    };
    es.onerror = () => {};
    return () => {
      es.close();
      if (revealTimer.current) clearTimeout(revealTimer.current);
    };
  }, [playerActorId, encounter_id]);

  function handleEncounterEvent(data) {
    const payload = data.data || data;
    switch (payload.type) {
      case "encounter_heartbeat":
        if (!decision) setStatusText(payload.message || "Still deciding…");
        break;
      case "encounter_warming":
        setIsWarming(true);
        setStatusText("Warming up the engine…");
        break;
      case "encounter_started":
        setPhase("loading");
        if (!isWarming) setStatusText(phaseStatus("loading", trigger));
        break;
      case "encounter_phase":
        setPhase("perceiving");
        if (isWarming) {
          setStatusText(phaseStatus("loading", trigger));
          setTimeout(() => setStatusText(phaseStatus("perceiving", trigger, payload.actor_name)), 1500);
        } else {
          setStatusText(phaseStatus("perceiving", trigger, payload.actor_name));
        }
        setIsWarming(false);
        if (payload.actor_name)  setActorName(payload.actor_name);
        if (payload.actor_photo) setActorPhoto(payload.actor_photo.startsWith('http') ? payload.actor_photo : `${SIMULATOR_URL}${payload.actor_photo}`);
        break;
      case "encounter_response":
        setResponding(false);
        startResponseTypewriter(payload.text, payload.speaker || actorName);
        break;
      case "encounter_narrative":
        setPhase(payload.decision || "narrative");
        setDecision(payload.decision);
        if (payload.text && !narrative) {
          setNarrative(payload.text);
          const onDone = payload.decision === "open_door" ? () => setShowEnterBtn(true) : null;
          startTypewriter(payload.text, onDone);
        }
        break;
      case "encounter_ended":
        setPhase("ended");
        break;
      case "encounter_error":
        setPhase("error");
        setStatusText(data.text || "Something went wrong.");
        break;
      default:
        break;
    }
  }

  // ── Typewriter ───────────────────────────────────────────────────────────────
  function startTypewriter(text, onDone) {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    wordsRef.current = text.split(" ");
    wordIdx.current  = 0;
    onNarrativeDone.current = onDone || null;
    revealWord();
  }

  function revealWord() {
    if (wordIdx.current >= wordsRef.current.length) {
      if (onNarrativeDone.current) onNarrativeDone.current();
      return;
    }
    const word = wordsRef.current[wordIdx.current];
    wordIdx.current++;
    setDisplayed(prev => prev ? prev + " " + word : word);
    const delay = word.endsWith(".") || word.endsWith("…") ? 180 : 65;
    revealTimer.current = setTimeout(revealWord, delay);
  }

  function startResponseTypewriter(text, speaker) {
    setResponding(true);
    if (responseTimerRef.current) clearInterval(responseTimerRef.current);
    responseWordsRef.current = text.split(" ");
    responseIdxRef.current   = 0;
    liveResponseRef.current  = "";
    setLiveResponse("");
    setMessages(prev => [...prev, { from: "them", text: "", speaker, _live: true }]);

    responseTimerRef.current = setInterval(() => {
      if (responseIdxRef.current >= responseWordsRef.current.length) {
        clearInterval(responseTimerRef.current);
        const final = liveResponseRef.current.trim();
        setMessages(prev => prev.map((m, i) => i === prev.length-1 && m._live ? { from:"them", text: final, speaker } : m));
        setLiveResponse("");
        setResponding(false);
        return;
      }
      const word = responseWordsRef.current[responseIdxRef.current++];
      liveResponseRef.current += (liveResponseRef.current ? " " : "") + word;
      setLiveResponse(liveResponseRef.current);
      setMessages(prev => prev.map((m, i) => i === prev.length-1 && m._live ? { ...m, text: liveResponseRef.current } : m));
    }, 60);
  }

  // ── Send message ─────────────────────────────────────────────────────────────
  async function sendMessage() {
    if (!chatInput.trim() || sending || !encounter_id) return;
    const content = chatInput.trim();
    setChatInput("");
    setSending(true);
    setResponding(true);
    setMessages(prev => [...prev, { from: "me", text: content }]);
    try {
      await fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ content })
      });
    } catch {}
    setSending(false);
  }

  // ── Leave ────────────────────────────────────────────────────────────────────
  async function leave() {
    if (encounter_id) fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/end`, { method: "POST" }).catch(() => {});
    fetch(`/api/worlds/${world.id}/leave`, { method: "POST" }).catch(() => {});
    onLeave();
  }

  const timeStr = new Date().toLocaleTimeString("sv-SE", {
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm"
  });

  const isOpen       = decision === "open_door";
  const isRejected   = decision === "ignore" || decision === "pretend_away";
  const isSentText   = decision === "send_text";
  const isLoading    = phase === "loading" || phase === "perceiving";
  const hasNarrative = displayed.length > 0;
  const hasVideos    = !!videoBase;

  if (showPresence) {
    return (
      <PresenceView
        world={world} user={user} sceneData={sceneData}
        actorName={actorName} actorPhoto={actorPhoto}
        encounter_id={encounter_id} onLeave={leave}
      />
    );
  }

  return (
    <div className={styles.scene}>

      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.locationName}>{location.name}</span>
          {location.area && <span className={styles.locationArea}>{location.area}</span>}
        </div>
        <div className={styles.headerRight}>
          <span className={styles.time}>{timeStr}</span>
          <button className={styles.leaveBtn} onClick={leave}>Leave</button>
        </div>
      </div>

      {/* ── Stage ── */}
      <div className={styles.stage}>

        {/* Portrait — canvas compositor if videos available, else static photo */}
        {(hasVideos || actorPhoto) && (
          <div className={`${styles.portrait} ${isLoading ? styles.portraitMuted : ""}`}>
            {hasVideos ? (
              <canvas ref={canvasRef} className={styles.portraitCanvas} />
            ) : (
              <img src={actorPhoto} alt={actorName} className={styles.portraitImg} />
            )}
            {actorName && <span className={styles.actorName}>{actorName}</span>}
          </div>
        )}

        {/* Loading spinner */}
        {isLoading && (
          <div className={styles.spinnerWrap}>
            <div className={styles.spinner} />
            <p className={styles.spinnerText}>{statusText}</p>
          </div>
        )}

        {/* Narrative */}
        {(hasNarrative || (decision && narrative)) && (
          <div className={styles.narrativeWrap}>
            <p className={styles.narrative}>{displayed || narrative}</p>
          </div>
        )}

        {/* Chat messages */}
        {messages.length > 0 && (
          <div className={styles.chatWrap}>
            <div className={styles.messages}>
              {messages.map((m, i) => (
                <div key={i} className={`${styles.msg} ${m.from === "me" ? styles.msgMe : styles.msgThem}`}>
                  {m.text}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Chat input — show once encounter is active */}
        {encounter_id && !isLoading && !decision && (
          <div className={styles.chatRow}>
            <input
              className={styles.chatInput}
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && sendMessage()}
              placeholder="Say something…"
              disabled={sending || responding}
            />
            <button className={styles.sendBtn} onClick={sendMessage} disabled={sending || responding || !chatInput.trim()}>
              →
            </button>
          </div>
        )}

        {/* Outcome actions */}
        {decision && (hasNarrative || narrative) && (
          <div className={styles.actions}>
            {isOpen && showEnterBtn && (
              <div className={styles.enterWrap}>
                <button className={styles.enterBtn} onClick={() => setShowPresence(true)}>Enter →</button>
              </div>
            )}
            {isRejected && (
              <div className={styles.rejectedWrap}>
                <button className={styles.leaveSceneBtn} onClick={leave}>Walk away</button>
              </div>
            )}
            {isSentText && (
              <div className={styles.rejectedWrap}>
                <p className={styles.sentTextNote}>Check your messages for their reply.</p>
                <button className={styles.leaveSceneBtn} onClick={leave}>Walk away</button>
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {phase === "error" && (
          <div className={styles.errorWrap}>
            <p className={styles.errorText}>{statusText}</p>
            <button className={styles.leaveSceneBtn} onClick={leave}>Leave</button>
          </div>
        )}

        {/* Empty */}
        {!encounter_id && !isLoading && (
          <div className={styles.emptyLocation}>
            <p className={styles.emptyText}>Nobody here right now.</p>
            <button className={styles.leaveSceneBtn} onClick={leave}>Leave</button>
          </div>
        )}

      </div>
    </div>
  );
}

function phaseStatus(phase, trigger, actorName) {
  switch (phase) {
    case "loading":    return trigger === "knock" ? "Knocking at the door…" : "Entering…";
    case "perceiving": return actorName ? `${actorName} hears you…` : "Someone stirs inside…";
    default:           return "…";
  }
}
