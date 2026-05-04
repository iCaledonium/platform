import { useState, useEffect, useRef, useCallback } from "react";
import styles from "./PresenceView.module.css";

const SIMULATOR_URL = "https://anima.simulator.ngrok.dev";

export default function PresenceView({ world, user, sceneData, actorName, actorPhoto, actorId: actorIdProp, encounter_id, onLeave }) {
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
  const [modelName,   setModelName]   = useState("");
  const [vitalToasts, setVitalToasts] = useState([]);
  const [ttsMode,     setTtsMode]     = useState("conversational"); // "conversational" | "narrative"
  const [tsMuted,     setTsMuted]     = useState(false);
  const [audioReady,  setAudioReady]  = useState(false);
  const [currentAction,   setCurrentAction]   = useState("idle");
  const [currentLocation, setCurrentLocation] = useState("hall");
  const [currentPosition, setCurrentPosition] = useState("standing");
  const [currentOutfit,   setCurrentOutfit]   = useState("casual");
  const [videoFading,     setVideoFading]     = useState(false);

  // ── Green screen compositor ───────────────────────────────────────────────
  const canvasRef   = useRef(null);
  const idleRef     = useRef(null);
  const talkRef     = useRef(null);
  const activeRef   = useRef(null);
  const bgImgRef    = useRef(null);
  const animFrameRef = useRef(null);
  const offRef      = useRef(null);

  const KEY_R = 0, KEY_G = 177, KEY_B = 64;
  const TOLERANCE = 120, SOFTNESS = 30, SPILL = 60;

  function chromaKeyPixels(pixels) {
    const d = pixels.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i+1], b = d[i+2];
      const dist = Math.sqrt((r-KEY_R)**2 + (g-KEY_G)**2 + (b-KEY_B)**2);
      if (dist < TOLERANCE) { d[i+3] = 0; }
      else if (dist < TOLERANCE + SOFTNESS) {
        const a = (dist - TOLERANCE) / SOFTNESS; d[i+3] = Math.round(255 * a);
        if (KEY_G > KEY_R && KEY_G > KEY_B) { const sf = SPILL/100; d[i+1] = Math.round(g-(g-Math.max(r,b))*sf*(1-a)); }
      } else if (SPILL > 0 && KEY_G > KEY_R && KEY_G > KEY_B) {
        const sf = (SPILL/100)*Math.max(0,1-(dist-TOLERANCE-SOFTNESS)/60);
        if (sf > 0) d[i+1] = Math.round(g-(g-Math.max(r,b))*sf*0.3);
      }
    }
  }
  const [firstWordsDone, setFirstWordsDone] = useState(false);
  const tsMutedRef    = useRef(false);
  const ttsModeRef    = useRef("narrative");
  const prevVitalsRef = useRef(null);

  useEffect(() => {
    fetch("/api/encounter/model-status")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.model) setModelName(d.model); })
      .catch(() => setModelName(""));
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
          currentSpeakerRef.current = actorName;
          finaliseResponse(displayText(payload.text), payload.text);
        }
        break;

      case "encounter_response":
        // Ignore streaming tokens — show full text only when response is complete
        streamingTextRef.current = "";
        setLiveText("");
        setSending(false);
        if (payload.model)        setModelName(payload.model);
        if (payload.vitals)       updateVitals(payload.vitals);
        if (payload.need)         setNeed(payload.need);
        if (payload.relationship) updateRelationship(payload.relationship);
        if (payload.action)   { setCurrentAction(payload.action); playActionClip(payload.action); }
        if (payload.location) {
          const newLoc = payload.location;
          setCurrentLocation(prev => {
            if (prev !== newLoc) {
              // Pre-load the new background
              if (bgBase) {
                const preload = new Image();
                preload.crossOrigin = "anonymous";
                preload.src = `${bgBase}/location_home_${newLoc}_${currentPosition}.png`;
                preload.onload = () => {
                  // Play beckons first, swap background when clip ends
                  playActionClip("beckons");
                  setTimeout(() => {
                    bgImgRef.current = preload;
                    setCurrentLocation(newLoc);
                  }, 1200);
                };
                preload.onerror = () => {
                  playActionClip("beckons");
                  setTimeout(() => setCurrentLocation(newLoc), 1200);
                };
              } else {
                playActionClip("beckons");
                setTimeout(() => setCurrentLocation(newLoc), 1200);
              }
              return prev;
            }
            return newLoc;
          });
        }
        if (payload.position) { setCurrentPosition(payload.position); }
        if (payload.outfit)   { setCurrentOutfit(payload.outfit); }
        if (payload.arc_signal && payload.arc_signal !== "neutral") {
          setArcSignal(payload.arc_signal);
          setTimeout(() => setArcSignal(null), 6000);
        }
        currentSpeakerRef.current = actorName;
        if (payload.text) {
          finaliseResponse(displayText(payload.text), payload.text);
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
      .replace(/\nACTION:\s*\w+/g, "")
      .replace(/\nLOCATION:\s*\w+/g, "")
      .replace(/\nPOSITION:\s*\w+/g, "")
      .replace(/\nOUTFIT:\s*\w+/g, "")
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

  // ── Unlock audio on first interaction (browser autoplay policy) ─────────────
  const audioUnlocked = useRef(false);
  function unlockAudio() {
    if (audioUnlocked.current) return;
    audioUnlocked.current = true;
    setAudioReady(true);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().then(() => ctx.close()).catch(() => {});
    const silent = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA");
    silent.play().catch(() => {});
  }

  // ── Load green screen videos ─────────────────────────────────────────────
  const worldId = world?.id;
  // Extract actorId from photo URL as fallback: .../actors/{id}/images/...
  const actorIdFromPhoto = actorPhoto?.match(/\/actors\/([^/]+)\//)?.[1];
  const actorId = actorIdProp || sceneData?.location?.actors?.find(a => a.actor_id !== user?.worlds?.find(w => w.world_id === worldId)?.actor_id)?.actor_id || actorIdFromPhoto;
  const videoBase = actorId ? `https://anima.simulator.ngrok.dev/media/worlds/${worldId}/actors/${actorId}/videos` : null;
  const bgBase    = actorId ? `https://anima.simulator.ngrok.dev/media/worlds/${worldId}/actors/${actorId}/backgrounds` : null;

  // Load background image
  useEffect(() => {
    console.log("[BG] actorId=", actorId, "bgBase=", bgBase);
    if (!bgBase) return;
    const url = `${bgBase}/location_home_${currentLocation}_${currentPosition}.png`;
    console.log("[BG] loading:", url);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    img.onload = () => { console.log("[BG] loaded ok"); bgImgRef.current = img; };
    img.onerror = (e) => { console.log("[BG] error loading bg:", e); /* keep previous background */ };
  }, [bgBase, currentLocation, currentPosition]);

  useEffect(() => {
    if (!videoBase) return;
    offRef.current = document.createElement("canvas");

    const idle = document.createElement("video");
    idle.crossOrigin = "anonymous";
    idle.src = `${videoBase}/frida_${currentPosition}_${currentOutfit}_idle_loop.mp4`;
    idle.loop = true; idle.muted = true; idle.playsInline = true;
    idle.addEventListener("loadeddata", () => { idle.play().catch(()=>{}); startRenderLoop(); });
    idleRef.current = idle; activeRef.current = idle;

    const talk = document.createElement("video");
    talk.crossOrigin = "anonymous";
    talk.src = `${videoBase}/frida_${currentPosition}_${currentOutfit}_talking_loop.mp4`;
    talk.loop = true; talk.muted = true; talk.playsInline = true;
    talk.load();
    talkRef.current = talk;

    return () => {
      idle.pause(); idle.src = "";
      talk.pause(); talk.src = "";
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [videoBase]);

  function startRenderLoop() {
    if (animFrameRef.current) return;
    function render() {
      const canvas = canvasRef.current;
      const video = activeRef.current;
      if (!canvas || !video || video.readyState < 2) { animFrameRef.current = requestAnimationFrame(render); return; }
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const W = canvas.width, H = canvas.height;
      if (bgImgRef.current && bgImgRef.current.complete && bgImgRef.current.naturalWidth) {
        ctx.drawImage(bgImgRef.current, 0, 0, W, H);
      } else {
        ctx.fillStyle = "#0d0c0a";
        ctx.fillRect(0,0,W,H);
      }
      const off = offRef.current;
      const vW = video.videoWidth||W, vH = video.videoHeight||H;
      off.width = vW; off.height = vH;
      const offCtx = off.getContext("2d", { willReadFrequently: true });
      offCtx.clearRect(0,0,vW,vH); offCtx.drawImage(video,0,0,vW,vH);
      const px = offCtx.getImageData(0,0,vW,vH);
      chromaKeyPixels(px); offCtx.putImageData(px,0,0);
      const aspect = vW/vH, fitH = H, fitW = fitH*aspect, dX = (W-fitW)/2;
      ctx.drawImage(off,0,0,vW,vH,dX,0,fitW,fitH);
      animFrameRef.current = requestAnimationFrame(render);
    }
    animFrameRef.current = requestAnimationFrame(render);
  }

  function switchToVideo(action) {
    if (!idleRef.current || !talkRef.current) return;
    const target = action === "talking" ? talkRef.current : idleRef.current;
    if (activeRef.current === target) return;
    activeRef.current.pause();
    target.currentTime = 0;
    target.play().catch(()=>{});
    activeRef.current = target;
  }



  function playActionClip(action) {
    if (!action || action === "idle" || action === "talking") return;
    if (!videoBase) return;

    const clipSrc = `${videoBase}/frida_${currentPosition}_${currentOutfit}_${action}_clip.mp4`;
    const clip = document.createElement("video");
    clip.crossOrigin = "anonymous";
    clip.src = clipSrc;
    clip.muted = true; clip.playsInline = true;
    clip.preload = "auto";

    const doSwitch = () => {
      setVideoFading(true);
      setTimeout(() => {
        if (activeRef.current) activeRef.current.pause();
        activeRef.current = clip;
        clip.play().catch(()=>{});
        setVideoFading(false);
        clip.onended = () => {
          setVideoFading(true);
          setTimeout(() => {
            activeRef.current = idleRef.current;
            idleRef.current.currentTime = 0;
            idleRef.current.play().catch(()=>{});
            setVideoFading(false);
          }, 600);
        };
      }, 600);
    };

    clip.addEventListener("canplaythrough", doSwitch, { once: true });
    clip.addEventListener("loadeddata", doSwitch, { once: true });
    // Fallback — try after short delay
    setTimeout(() => {
      if (activeRef.current !== clip) doSwitch();
    }, 1500);
    clip.load();
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
      if (Object.keys(ttsQueueRef.current).length === 0) switchToVideo("idle");
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
    unlockAudio();
    switchToVideo("talking");
    audio.play().catch(() => {
      ttsPlaying.current = false;
      stopWave();
    });
  }

  // ── Send message ──────────────────────────────────────────────────────────
  async function sendMessage() {
    if (!chatInput.trim() || !encounter_id) return;
    const content = chatInput.trim();
    setChatInput("");

    // Interrupt TTS immediately — user is speaking
    resetTtsQueue();
    switchToVideo("idle");
    setGlow("listening");
    setOstText("Listening");

    setMessages(prev => [...prev, { from: "me", text: content }]);
    scrollLog();

    try {
      await fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/message`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ content, interrupted: true })
      });
      setGlow("thinking");
      setOstText("Thinking");
      scrollLog();
    } catch {
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
    <div className={styles.scene} onClick={!audioReady ? unlockAudio : undefined}>

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
      }}>◈ {modelName === "Hermes-3-70B" ? "Hermes" : modelName === "…" ? "" : modelName}</div>

      <div className={styles.body}>
        {/* Photo + vitals overlay */}
        <div className={styles.compCol}>
          <div className={styles.wrap}>
            {videoBase
              ? <canvas ref={canvasRef}
                  className={`${styles.photoCanvas} ${videoFading ? styles.photoFading : ""}`}
                  width={360} height={540} />
              : actorPhoto
                ? <img src={actorPhoto} className={styles.photo} alt={actorName} />
                : <div className={styles.photoPlaceholder}><span className={styles.initials}>{actorName[0]}</span></div>
            }
            {/* Frame */}
            {/* Vital change toasts */}
            {vitalToasts.map((t, i) => (
              <div key={t.id}
                   className={`${styles.vitalToast} ${t.up ? styles.vitalToastUp : styles.vitalToastDown}`}
                   style={{ top: 130 + i * 30 }}>
                {t.label} {t.dir} {t.from} → {t.to}
              </div>
            ))}
            {/* DEBUG overlay — yellow, over canvas */}
            {videoBase && (
              <div style={{
                position:"absolute", bottom:14, left:14, zIndex:25,
                fontFamily:"'DM Sans',system-ui,sans-serif",
                fontSize:12, letterSpacing:".08em", textTransform:"uppercase",
                color:"rgba(255,220,0,0.95)", pointerEvents:"none",
                display:"flex", flexDirection:"column", gap:4,
                textShadow:"0 1px 6px rgba(0,0,0,0.95)"
              }}>
                <span>ACTION: {currentAction}</span>
                <span>LOCATION: {currentLocation}</span>
                <span>POSITION: {currentPosition}</span>
                <span>OUTFIT: {currentOutfit}</span>
              </div>
            )}
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
                disabled={false}
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
                <button className={styles.sendBtn} onClick={sendMessage}>↑</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
