import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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
  const [noBg,            setNoBg]            = useState(false);
  const noBgRef = useRef(false);
  const [videoReady,      setVideoReady]      = useState(false);
  const currentOutfitRef  = useRef("casual");
  const [rawAction,       setRawAction]       = useState("idle");
  const [videoFading,     setVideoFading]     = useState(false);
  const [mediaList,      setMediaList]        = useState([]);
  const [mediaPanelOpen, setMediaPanelOpen]   = useState(true);
  const [outfitOpen,     setOutfitOpen]       = useState({});
  const [posOpen,        setPosOpen]          = useState({});
  const [locOpen,        setLocOpen]          = useState({});
  const [missingMedia,   setMissingMedia]     = useState(null);

  const mediaTree = useMemo(() => {
    const tree = {};
    mediaList.forEach(m => {
      const outfit   = m.outfit   || "unknown";
      const position = m.position || "unknown";
      const location = m.location || "any location";
      if (!tree[outfit]) tree[outfit] = {};
      if (!tree[outfit][position]) tree[outfit][position] = {};
      if (!tree[outfit][position][location]) tree[outfit][position][location] = [];
      tree[outfit][position][location].push(m);
    });
    Object.values(tree).forEach(positions =>
      Object.values(positions).forEach(locations =>
        Object.values(locations).forEach(items =>
          items.sort((a, b) => {
            if (a.type !== b.type) return a.type === "loop" ? -1 : 1;
            return a.action.localeCompare(b.action);
          })
        )
      )
    );
    return tree;
  }, [mediaList]);

  // ── Green screen compositor ───────────────────────────────────────────────
  const canvasRef   = useRef(null);
  const idleRef     = useRef(null);
  const clipPlayingRef = useRef(false);
  const talkRef     = useRef(null);
  const activeRef   = useRef(null);
  const bgImgRef    = useRef(null);
  const animFrameRef = useRef(null);
  const stopRenderRef = useRef(false);
  const offRef      = useRef(null);

  const KEY_R = 0, KEY_G = 177, KEY_B = 64;
  const TOLERANCE = 80, SOFTNESS = 20, SPILL = 40;

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
          const ts = payload.fired_at ? new Date(payload.fired_at) : new Date();
          finaliseResponse(displayText(payload.text), payload.text, ts);
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
        if (payload.outfit)   { setCurrentOutfit(payload.outfit); currentOutfitRef.current = payload.outfit; }
        if (payload.position) { setCurrentPosition(payload.position); }
        if (payload.action)   { setCurrentAction(payload.action); setRawAction(payload.action); playActionClip(payload.action); }
        if (payload.location) {
          const newLoc = payload.location;
          setCurrentLocation(prev => {
            if (prev !== newLoc) {
              const switchLocation = () => {
                if (bgBase) {
                  const preload = new Image();
                  preload.crossOrigin = "anonymous";
                  preload.src = `${bgBase}/location_home_${newLoc}_${currentPosition}.png`;
                  preload.onload = () => { bgImgRef.current = preload; setCurrentLocation(newLoc); };
                  preload.onerror = () => setCurrentLocation(newLoc);
                } else {
                  setCurrentLocation(newLoc);
                }
              };
              // Play beckon clip first, then switch location after clip ends
              playActionClip("beckons");
              const deadline = Date.now() + 5000; // max 5s wait
              const waitForClip = () => {
                if (clipPlayingRef.current && Date.now() < deadline) {
                  setTimeout(waitForClip, 200);
                } else {
                  switchLocation();
                }
              };
              setTimeout(waitForClip, 800); // give clip time to start
              return prev;
            }
            return newLoc;
          });
        }
        if (payload.arc_signal && payload.arc_signal !== "neutral") {
          setArcSignal(payload.arc_signal);
          setTimeout(() => setArcSignal(null), 6000);
        }
        currentSpeakerRef.current = actorName;
        if (payload.text) {
          const ts = payload.fired_at ? new Date(payload.fired_at) : new Date();
          finaliseResponse(displayText(payload.text), payload.text, ts);
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

      case "missing_media":
        if (true) {
          // Capture key frame from canvas for reference
          const keyImage = canvasRef.current ? canvasRef.current.toDataURL("image/jpeg", 0.92) : null;
          setMissingMedia({
            action:        payload.action,
            position:      payload.position,
            outfit:        payload.outfit,
            location:      payload.location,
            base_filename: payload.base_filename,
            forced_bg:     payload.forced_bg,
            actor_id:      payload.actor_id,
            world_id:      payload.world_id,
          });
        }
        break;

      case "media_generation_started":
        if (payload.encounter_id === encounter_id) {
          // Update missingMedia state with gen_id so modal can show it
          setMissingMedia(prev => prev ? { ...prev, gen_id: payload.gen_id } : prev);
        }
        break;

      case "media_ready":
        if (payload.encounter_id === encounter_id) {
          setMissingMedia(null);
          // Refresh media list
          fetch(`${SIMULATOR_URL}/internal/worlds/${worldId}/encounter/${encounter_id}/media`, {
            headers: { "x-service-token": SERVICE_TOKEN }
          }).then(r => r.ok ? r.json() : null).then(d => { if (d?.media) setMediaList(d.media); }).catch(() => {});
        }
        break;

      case "media_generation_error":
        if (payload.encounter_id === encounter_id) {
          console.error("[Hedra] Generation error:", payload.error);
        }
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

  function finaliseResponse(text, rawText, ts) {
    if (!text || text.trim() === "") return;
    setMessages(prev => [...prev, { from: "them", text: rawText || text, speaker: actorName, ts: ts || new Date() }]);
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
      .replace(/\s*(ACTION|LOCATION|POSITION|OUTFIT|DELTAS):[\s\S]*/g, "")
      .replace(/\[Player interrupted[^\]]*\]/gi, "")
      .replace(/\s*\{["\s]*(?:warmth|trust|attraction|tension|arc_signal|scene_description|action|location|position|outfit)[\s\S]*/gi, "")
      .replace(/\s*DELTAs?:[\s\S]*/gi, "")
      .replace(/\bsystem\b/gi, "")
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
  const videoBase = actorId ? `/media/worlds/${worldId}/actors/${actorId}/videos` : null;
  const bgBase    = actorId ? `/media/worlds/${worldId}/actors/${actorId}/backgrounds` : null;

  // Fetch available media for the sidebar
  useEffect(() => {
    if (!worldId || !actorId || !encounter_id) return;
    fetch(`${SIMULATOR_URL}/internal/worlds/${worldId}/encounter/${encounter_id}/media`, {
        headers: { "x-service-token": "d1ea19ea6e778fb309358333b7a74d72378cbd076e3a47f6489db003e6a454b7" }
      })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.media) setMediaList(d.media); })
      .catch(() => {});
  }, [worldId, actorId, encounter_id]);

  // Load background image — only for standing position (_gs videos need a background)
  useEffect(() => {
    if (!bgBase || currentPosition !== "standing") {
      if (currentPosition !== "standing") bgImgRef.current = null;
      return;
    }
    const url = `${bgBase}/location_home_${currentLocation}_${currentPosition}.png`;
    console.log("[BG] loading:", url);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    img.onload = () => { console.log("[BG] loaded ok"); bgImgRef.current = img; };
    img.onerror = (e) => { console.log("[BG] error loading bg:", e); };
  }, [bgBase, currentLocation, currentPosition]);

  useEffect(() => {
    console.log("[VIDEO] effect triggered - videoBase:", !!videoBase, "encounter_id:", !!encounter_id);
    if (!videoBase || !encounter_id) return;
    offRef.current = document.createElement("canvas");
    setVideoReady(false);

    // Build URL directly — no mediaList dependency
    const actorPrefix = actorName?.toLowerCase().split(" ")[0] || "frida";
    const suffix   = currentPosition === "standing" ? "gs" : "bg";
    const loc      = currentLocation || "hall";
    const locPart  = currentPosition !== "standing" ? `${loc}_` : "";
    const buildSrc = (action, type) =>
      `${videoBase}/${actorPrefix}_${locPart}${currentPosition}_${currentOutfit}_${action}_${type}_${suffix}.mp4`;

    const idleSrc = buildSrc("idle", "loop");
    const talkSrc = buildSrc("talking", "loop");
    console.log("[VIDEO] loading idle:", idleSrc);

    const idle = document.createElement("video");
    idle.src = idleSrc;
    idle.loop = true; idle.muted = true; idle.playsInline = true;
    idle.addEventListener("loadeddata", () => {
      console.log("[VIDEO] loadeddata - readyState:", idle.readyState, idle.videoWidth, "x", idle.videoHeight);
      setNoBg(idleSrc.includes("_bg")); noBgRef.current = idleSrc.includes("_bg");
      setVideoReady(true);
      idleRef.current = idle; activeRef.current = idle;
      idle.play().catch(() => {});
      if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
      startRenderLoop();
    }, { once: true });
    idle.addEventListener("error", (e) => {
      console.error("[VIDEO] error:", idle.error?.code, idle.error?.message, idleSrc);
      setVideoReady(false);
    }, { once: true });
    idleRef.current = idle; activeRef.current = idle;

    const talk = document.createElement("video");
    talk.src = talkSrc || idleSrc;
    talk.loop = true; talk.muted = true; talk.playsInline = true;
    talk.load();
    talkRef.current = talk;

    return () => {
      stopRenderRef.current = true;
      idle.pause(); idle.src = "";
      talk.pause(); talk.src = "";
      if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
    };
  }, [videoBase, currentPosition, currentOutfit, encounter_id]);

  function startRenderLoop() {
    stopRenderRef.current = false;
    if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
    function render() {
      if (stopRenderRef.current) { animFrameRef.current = null; return; }
      const canvas = canvasRef.current;
      const video = activeRef.current;
      if (!canvas || !video || video.readyState < 2) { animFrameRef.current = requestAnimationFrame(render); return; }
      if (video.paused) { video.play().catch(() => {}); }
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const W = canvas.width, H = canvas.height;
      const off = offRef.current;
      const vW = video.videoWidth||W, vH = video.videoHeight||H;
      ctx.fillStyle = "#0d0c0a";
      ctx.fillRect(0,0,W,H);
      if (!noBgRef.current && bgImgRef.current && bgImgRef.current.complete && bgImgRef.current.naturalWidth) {
        const bgFitH = H, bgFitW = bgFitH * (vW/vH), bgDX = (W-bgFitW)/2;
        ctx.drawImage(bgImgRef.current, bgDX, 0, bgFitW, bgFitH);
      }
      const aspect = vW/vH, fitH = H, fitW = fitH*aspect, dX = (W-fitW)/2;
      if (!noBgRef.current) {
        off.width = vW; off.height = vH;
        const offCtx = off.getContext("2d", { willReadFrequently: true });
        offCtx.clearRect(0,0,vW,vH); offCtx.drawImage(video,0,0,vW,vH);
        try {
          const px = offCtx.getImageData(0,0,vW,vH);
          chromaKeyPixels(px); offCtx.putImageData(px,0,0);
          ctx.drawImage(off,0,0,vW,vH,dX,0,fitW,fitH);
        } catch(e) {
          ctx.drawImage(video,0,0,vW,vH,dX,0,fitW,fitH);
        }
      } else {
        ctx.drawImage(video,0,0,vW,vH,dX,0,fitW,fitH);
      }
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

    const actorPrefix = actorName?.toLowerCase().split(" ")[0] || "frida";
    const normalizeAct = (a) => ({
      "talk":         "talking",
      "talks":        "talking",
      "think":        "thinking",
      "thinks":       "thinking",
      "lean":         "leans_in",
      "leans":        "leans_in",
      "nod":          "nods",
      "laugh":        "laughs",
      "chuckle":      "laughs",
      "smile":        "smile_warm",
      "beckon":       "beckons",
      "look_away":    "looks_away",
      "pull_back":    "pulls_back",
      "touch_hair":   "touches_hair",
      "pour":         "pours",
      "kiss_me":      "kiss",
    }[a] || a);
    const normalizedAction = normalizeAct(action);
    const m = mediaList.find(x =>
      x.position === currentPosition &&
      x.outfit   === currentOutfitRef.current &&
      x.action   === normalizedAction &&
      String(x.type) === "clip"
    );
    const clipSrc = m
      ? `${videoBase}/${m.filename}`
      : (() => {
          const fallbackSuffix = currentPosition === "standing" ? "gs" : "bg";
          const fallbackLocation = currentPosition !== "standing" ? `${currentLocation}_` : "";
          return `${videoBase}/${actorPrefix}_${fallbackLocation}${currentPosition}_${currentOutfitRef.current}_${normalizedAction}_clip_${fallbackSuffix}.mp4`;
        })();
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
        clipPlayingRef.current = true;
        clip.play().catch(()=>{});
        setVideoFading(false);
        clip.onended = () => {
          clipPlayingRef.current = false;
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
    // Wait for any clip to finish before switching to talking
    if (clipPlayingRef.current) {
      const waitAndSwitch = () => {
        if (clipPlayingRef.current) { setTimeout(waitAndSwitch, 100); return; }
        switchToVideo("talking");
      };
      setTimeout(waitAndSwitch, 100);
    } else {
      switchToVideo("talking");
    }
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
    // But wait for any clip to finish before switching to idle
    resetTtsQueue();
    if (!clipPlayingRef.current) {
      switchToVideo("idle");
    } else {
      const waitAndIdle = () => {
        if (clipPlayingRef.current) { setTimeout(waitAndIdle, 100); return; }
        switchToVideo("idle");
      };
      setTimeout(waitAndIdle, 100);
    }
    setGlow("listening");
    setOstText("Listening");

    setMessages(prev => [...prev, { from: "me", text: content, ts: new Date() }]);
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
    <>
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
            {videoBase && encounter_id
              ? <canvas ref={canvasRef}
                  className={`${styles.photoCanvas} ${videoFading ? styles.photoFading : ""}`}
                  width={720} height={1280} />
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
                <span>ACTION: {rawAction}</span>
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
                {m.ts && <div style={{fontSize:"9px",color:"rgba(255,255,255,.18)",textAlign:m.from==="me"?"right":"left",marginTop:"2px",letterSpacing:".03em",fontFamily:"'DM Sans',sans-serif"}}>{m.ts.toTimeString().slice(0,8)}</div>}
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
        {/* Media sidebar */}
        <div style={{
          width: mediaPanelOpen ? 220 : 28,
          minWidth: mediaPanelOpen ? 220 : 28,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid rgba(255,255,255,0.07)",
          background: "rgba(255,255,255,0.02)",
          transition: "width 0.2s ease, min-width 0.2s ease",
          overflow: "hidden",
          flexShrink: 0,
        }}>
          {/* Header */}
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: mediaPanelOpen ? "space-between" : "center",
            padding: mediaPanelOpen ? "10px 10px 10px 12px" : "10px 0",
            borderBottom: "1px solid rgba(255,255,255,0.07)",
            flexShrink: 0,
          }}>
            {mediaPanelOpen && (
              <span style={{
                fontFamily: "'DM Sans',system-ui,sans-serif",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,0.4)",
              }}>Media</span>
            )}
            <button
              onClick={() => setMediaPanelOpen(p => !p)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: "rgba(255,255,255,0.35)", fontSize: 13,
                padding: 0, lineHeight: 1,
              }}
              title={mediaPanelOpen ? "Hide" : "Show media"}
            >{mediaPanelOpen ? "›" : "‹"}</button>
          </div>

          {/* Tree */}
          {mediaPanelOpen && (
            <div style={{ overflowY: "auto", flex: 1, padding: "6px 0" }}>
              {Object.keys(mediaTree).length === 0 ? (
                <div style={{
                  padding: "12px",
                  fontFamily: "'DM Sans',system-ui,sans-serif",
                  fontSize: 11,
                  color: "rgba(255,255,255,0.2)",
                  textAlign: "center",
                }}>No media</div>
              ) : Object.entries(mediaTree).map(([outfit, positions]) => {
                const oOpen = outfitOpen[outfit] !== false;
                return (
                  <div key={outfit}>
                    {/* Outfit node */}
                    <div onClick={() => setOutfitOpen(s => ({ ...s, [outfit]: !oOpen }))} style={{
                      display: "flex", alignItems: "center", gap: 5,
                      padding: "5px 10px 4px", cursor: "pointer",
                      fontFamily: "'DM Sans',system-ui,sans-serif",
                      fontSize: 11, fontWeight: 600,
                      letterSpacing: ".06em", textTransform: "uppercase",
                      color: "rgba(255,255,255,0.55)", userSelect: "none",
                    }}>
                      <span style={{ fontSize: 9, opacity: 0.5 }}>{oOpen ? "▾" : "▸"}</span>
                      {outfit}
                    </div>

                    {oOpen && Object.entries(positions).map(([position, locations]) => {
                      const pKey  = `${outfit}·${position}`;
                      const pOpen = posOpen[pKey] !== false;
                      return (
                        <div key={pKey}>
                          {/* Position node */}
                          <div onClick={() => setPosOpen(s => ({ ...s, [pKey]: !pOpen }))} style={{
                            display: "flex", alignItems: "center", gap: 5,
                            padding: "3px 10px 3px 20px", cursor: "pointer",
                            fontFamily: "'DM Sans',system-ui,sans-serif",
                            fontSize: 10, color: "rgba(255,255,255,0.35)", userSelect: "none",
                          }}>
                            <span style={{ fontSize: 8, opacity: 0.5 }}>{pOpen ? "▾" : "▸"}</span>
                            {position.replace(/_/g, " ")}
                          </div>

                          {pOpen && Object.entries(locations).map(([location, items]) => {
                            const lKey   = `${pKey}·${location}`;
                            const lOpen  = locOpen[lKey] !== false;
                            const isAny  = location === "any location";
                            return (
                              <div key={lKey}>
                                {/* Location node */}
                                <div onClick={() => setLocOpen(s => ({ ...s, [lKey]: !lOpen }))} style={{
                                  display: "flex", alignItems: "center", gap: 4,
                                  padding: "2px 10px 2px 30px", cursor: "pointer",
                                  fontFamily: "'DM Sans',system-ui,sans-serif",
                                  fontSize: 10, userSelect: "none",
                                  color: isAny ? "rgba(255,255,255,0.22)" : "rgba(100,180,255,0.55)",
                                }}>
                                  <span style={{ fontSize: 7, opacity: 0.5 }}>{lOpen ? "▾" : "▸"}</span>
                                  {isAny ? "· any location" : location.replace(/_/g, " ")}
                                  <span style={{
                                    marginLeft: "auto", fontSize: 9,
                                    color: isAny ? "rgba(0,200,120,0.4)" : "rgba(100,180,255,0.4)",
                                  }}>{isAny ? "gs" : "bg"}</span>
                                </div>

                                {lOpen && items.map((m, i) => (
                                  <div key={i} style={{
                                    display: "flex", alignItems: "center",
                                    justifyContent: "space-between",
                                    padding: "2px 10px 2px 40px",
                                    fontFamily: "'DM Sans',system-ui,sans-serif",
                                    fontSize: 11, color: "rgba(255,255,255,0.4)",
                                  }}>
                                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      {m.action.replace(/_/g, " ")}
                                    </span>
                                    <span style={{
                                      fontSize: 9, letterSpacing: ".05em", textTransform: "uppercase",
                                      color: m.type === "loop" ? "rgba(0,200,120,0.55)" : "rgba(180,140,255,0.55)",
                                      marginLeft: 5, flexShrink: 0,
                                    }}>{m.type}</span>
                                  </div>
                                ))}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>

    {/* ── Missing media modal ────────────────────────────────────────────── */}
    {missingMedia && (
      <MissingMediaModal
        missingMedia={missingMedia}
        actorId={missingMedia.actor_id || actorId}
        worldId={missingMedia.world_id || worldId}
        encounter_id={encounter_id}
        SIMULATOR_URL={SIMULATOR_URL}
        SERVICE_TOKEN="d1ea19ea6e778fb309358333b7a74d72378cbd076e3a47f6489db003e6a454b7"
        currentLocation={missingMedia.location || currentLocation}
        onUploaded={() => {
          setMissingMedia(null);
          // Refresh media list
          fetch(`${SIMULATOR_URL}/internal/worlds/${worldId}/encounter/${encounter_id}/media`, {
            headers: { "x-service-token": "d1ea19ea6e778fb309358333b7a74d72378cbd076e3a47f6489db003e6a454b7" }
          }).then(r => r.ok ? r.json() : null).then(d => { if (d?.media) setMediaList(d.media); }).catch(() => {});
          // Resume encounter
          fetch(`${SIMULATOR_URL}/internal/worlds/${worldId}/encounter/${encounter_id}/resume`, {
            method: "POST",
            headers: { "x-service-token": "d1ea19ea6e778fb309358333b7a74d72378cbd076e3a47f6489db003e6a454b7" }
          }).catch(() => {});
        }}
        onDismiss={() => {
          setMissingMedia(null);
          // Resume encounter even if dismissed
          fetch(`${SIMULATOR_URL}/internal/worlds/${worldId}/encounter/${encounter_id}/resume`, {
            method: "POST",
            headers: { "x-service-token": "d1ea19ea6e778fb309358333b7a74d72378cbd076e3a47f6489db003e6a454b7" }
          }).catch(() => {});
        }}
      />
    )}
    </>
  );
}

function MissingMediaModal({ missingMedia, actorId, worldId, encounter_id, SIMULATOR_URL, SERVICE_TOKEN, currentLocation, onUploaded, onDismiss }) {
  const [dragging,      setDragging]      = useState(false);
  const [uploading,     setUploading]     = useState(false);
  const [generating,    setGenerating]    = useState(false);
  const [genStatus,     setGenStatus]     = useState(null);
  const [error,         setError]         = useState(null);
  const [suffix,        setSuffix]        = useState(missingMedia.forced_bg ? "bg" : "gs");
  const [location,      setLocation]      = useState(missingMedia.location || currentLocation || "");
  const [prompt,        setPrompt]        = useState("");
  const [promptLoaded,  setPromptLoaded]  = useState(false);
  const [startUrl,      setStartUrl]      = useState(null);
  const [endUrl,        setEndUrl]        = useState(null);
  const [startPath,     setStartPath]     = useState(null);
  const [endPath,       setEndPath]       = useState(null);
  const [framesLoaded,  setFramesLoaded]  = useState(false);
  const startFileRef = useRef(null);
  const endFileRef   = useRef(null);
  const fileRef      = useRef(null);

  const font = "'DM Sans',system-ui,sans-serif";
  const dim  = "rgba(255,255,255,0.35)";

  // Build filename
  const finalFilename = suffix === "bg" && location
    ? (() => {
        const parts = missingMedia.base_filename.split("_");
        const actor = parts[0];
        const rest  = parts.slice(1).join("_");
        return `${actor}_${location}_${rest}_bg.mp4`;
      })()
    : `${missingMedia.base_filename}_gs.mp4`;

  // Fetch suggested prompt + frames on mount / when suffix changes
  useEffect(() => {
    setPromptLoaded(false); setFramesLoaded(false);

    fetch(`${SIMULATOR_URL}/internal/actors/${actorId}/generate_prompt?position=${missingMedia.position}&outfit=${missingMedia.outfit}&action=${missingMedia.action}&suffix=${suffix}`, {
      headers: { "x-service-token": SERVICE_TOKEN }
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.prompt) setPrompt(d.prompt); setPromptLoaded(true); })
      .catch(() => setPromptLoaded(true));

    fetch(`${SIMULATOR_URL}/internal/actors/${actorId}/suggest_frames?world_id=${worldId}&position=${missingMedia.position}&outfit=${missingMedia.outfit}&suffix=${suffix}&location=${location}`, {
      headers: { "x-service-token": SERVICE_TOKEN }
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.start_url) { setStartUrl(d.start_url); setStartPath(d.start_path); }
        if (d?.end_url)   { setEndUrl(d.end_url);     setEndPath(d.end_path); }
        setFramesLoaded(true);
      })
      .catch(() => setFramesLoaded(true));
  }, [suffix]);

  const uploadFrame = async (file, role) => {
    if (!file) return;
    const form = new FormData();
    form.append("file", file, `${role}_frame.jpg`);
    try {
      const res = await fetch(`${SIMULATOR_URL}/internal/actors/${actorId}/upload_frame`, {
        method: "POST",
        headers: { "x-service-token": SERVICE_TOKEN },
        body: form,
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const data = await res.json();
      if (role === "start") { setStartUrl(data.url); setStartPath(data.path); }
      else                  { setEndUrl(data.url);   setEndPath(data.path); }
    } catch (e) { setError(e.message); }
  };

  const upload = async (file) => {
    if (!file) return;
    setUploading(true); setError(null);
    try {
      const form = new FormData();
      form.append("file", file, finalFilename);
      const res = await fetch(`${SIMULATOR_URL}/internal/actors/${actorId}/media`, {
        method: "POST",
        headers: { "x-service-token": SERVICE_TOKEN },
        body: form,
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      onUploaded();
    } catch (e) { setError(e.message); setUploading(false); }
  };

  const generate = async () => {
    if (!prompt.trim()) { setError("Prompt required"); return; }
    setGenerating(true); setGenStatus("pending"); setError(null);
    try {
      const res = await fetch(`${SIMULATOR_URL}/internal/worlds/${worldId}/encounter/${encounter_id}/generate_media`, {
        method: "POST",
        headers: { "x-service-token": SERVICE_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({
          actor_id:   actorId,
          position:   missingMedia.position,
          outfit:     missingMedia.outfit,
          action:     missingMedia.action,
          suffix,
          location,
          filename:   finalFilename,
          prompt:     prompt.trim(),
          start_path: startPath,
          end_path:   endPath,
        }),
      });
      if (!res.ok) throw new Error(`Generate failed: ${res.status}`);
    } catch (e) { setError(e.message); setGenerating(false); setGenStatus("error"); }
  };

  const onDrop = (e) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) upload(file);
  };

  const FrameBox = ({ label, url, fileRef, role }) => (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 9, color: dim, marginBottom: 5, letterSpacing: ".08em", textTransform: "uppercase" }}>{label}</div>
      <div
        onClick={() => fileRef.current?.click()}
        style={{
          width: "100%", aspectRatio: "9/16", maxHeight: 140, overflow: "hidden",
          background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          position: "relative",
        }}
      >
        {url
          ? <img src={url} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 6 }} />
          : <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>{framesLoaded ? "No frame" : "Loading…"}</span>
        }
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          background: "rgba(0,0,0,0.5)", padding: "4px 6px", fontSize: 9,
          color: "rgba(255,255,255,0.5)", textAlign: "center", borderRadius: "0 0 6px 6px"
        }}>Click to replace</div>
      </div>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png" style={{ display: "none" }}
        onChange={e => { const f = e.target.files[0]; if (f) uploadFrame(f, role); }} />
    </div>
  );

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.75)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: "#111", border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 12, padding: "28px 32px", width: 500, maxWidth: "92vw",
        fontFamily: font, maxHeight: "90vh", overflowY: "auto",
      }}>
        {/* Header */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.85)", marginBottom: 4 }}>Missing media</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>The encounter requested a clip that doesn't exist yet.</div>
        </div>

        {/* Meta pills */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {[["position", missingMedia.position], ["outfit", missingMedia.outfit], ["action", missingMedia.action]].map(([k, v]) => (
            <div key={k} style={{
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 4, padding: "3px 8px", fontSize: 10, color: "rgba(255,255,255,0.45)",
            }}>
              <span style={{ color: "rgba(255,255,255,0.25)", marginRight: 4 }}>{k}</span>{v}
            </div>
          ))}
        </div>

        {/* Type toggle */}
        {!missingMedia.forced_bg ? (
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            {[["gs", "Green screen"], ["bg", "Baked background"]].map(([s, label]) => (
              <button key={s} onClick={() => setSuffix(s)} style={{
                flex: 1, padding: "7px 0", borderRadius: 6, cursor: "pointer",
                fontFamily: font, fontSize: 11,
                background: suffix === s ? "rgba(255,255,255,0.08)" : "transparent",
                border: `1px solid ${suffix === s ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.07)"}`,
                color: suffix === s ? "rgba(255,255,255,0.8)" : dim,
              }}>{label}</button>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 10, color: "rgba(255,200,80,0.6)", marginBottom: 14 }}>⚠ Position requires baked background</div>
        )}

        {/* Location */}
        {(suffix === "bg" || missingMedia.forced_bg) && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: dim, marginBottom: 4, letterSpacing: ".06em", textTransform: "uppercase" }}>Location</div>
            <input value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. bedroom"
              style={{ width: "100%", boxSizing: "border-box", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "7px 10px", color: "rgba(255,255,255,0.8)", fontSize: 12, fontFamily: font, outline: "none" }} />
          </div>
        )}

        {/* Filename */}
        <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "7px 10px", marginBottom: 18, fontSize: 11, color: "rgba(180,140,255,0.85)", fontFamily: "monospace", wordBreak: "break-all" }}>
          {finalFilename}
        </div>

        {/* Generate with Kling */}
        <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 16, marginBottom: 14, background: "rgba(255,255,255,0.02)" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.6)", marginBottom: 12, letterSpacing: ".06em", textTransform: "uppercase" }}>Generate with Kling</div>

          {/* Start + End frames */}
          <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
            <FrameBox label="Start frame" url={startUrl} fileRef={startFileRef} role="start" />
            <FrameBox label="End frame"   url={endUrl}   fileRef={endFileRef}   role="end" />
          </div>

          {/* Prompt */}
          <div style={{ fontSize: 10, color: dim, marginBottom: 4, letterSpacing: ".06em", textTransform: "uppercase" }}>Prompt</div>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
            placeholder={promptLoaded ? "Enter generation prompt…" : "Loading…"}
            rows={3}
            style={{ width: "100%", boxSizing: "border-box", resize: "vertical", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "8px 10px", color: "rgba(255,255,255,0.8)", fontSize: 11, fontFamily: font, outline: "none", lineHeight: 1.5 }} />

          <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={generate} disabled={generating || !prompt.trim()} style={{
              padding: "8px 18px", borderRadius: 6, cursor: generating ? "default" : "pointer",
              fontFamily: font, fontSize: 11, fontWeight: 600,
              background: generating ? "rgba(255,255,255,0.05)" : "rgba(120,80,255,0.2)",
              border: `1px solid ${generating ? "rgba(255,255,255,0.08)" : "rgba(120,80,255,0.4)"}`,
              color: generating ? dim : "rgba(180,140,255,0.9)",
            }}>
              {genStatus === "pending" ? "⏳ Generating…" : "✦ Generate"}
            </button>
            {genStatus === "pending" && (
              <div>
                <div style={{ fontSize: 10, color: dim }}>Encounter resumes automatically when done.</div>
                {missingMedia.gen_id && (
                  <div style={{ fontSize: 10, fontFamily: "monospace", color: "rgba(255,255,255,0.2)", marginTop: 3 }}>
                    Job: {missingMedia.gen_id}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Upload manually */}
        <div onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
          style={{
            border: `2px dashed ${dragging ? "rgba(180,140,255,0.6)" : "rgba(255,255,255,0.08)"}`,
            borderRadius: 8, padding: 14, textAlign: "center", cursor: "pointer",
            background: dragging ? "rgba(180,140,255,0.05)" : "transparent",
            transition: "all 0.15s ease", marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)" }}>
            {uploading ? "Uploading…" : "Or drop .mp4 here to upload manually"}
          </div>
          <input ref={fileRef} type="file" accept=".mp4,video/mp4" style={{ display: "none" }}
            onChange={e => { const f = e.target.files[0]; if (f) upload(f); }} />
        </div>

        {error && <div style={{ fontSize: 11, color: "rgba(255,80,80,0.8)", marginBottom: 10 }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onDismiss} style={{ background: "none", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, padding: "6px 16px", cursor: "pointer", color: dim, fontSize: 12, fontFamily: font }}>Skip</button>
        </div>
      </div>
    </div>
  );
}
