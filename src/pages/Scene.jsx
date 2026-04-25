import { useState, useEffect, useRef } from "react";
import styles from "./Scene.module.css";
import PresenceView from "./PresenceView.jsx";

const SIMULATOR_URL = "https://anima.simulator.ngrok.dev";

export default function Scene({ world, user, sceneData, onLeave }) {
  const { location, encounter_id, trigger } = sceneData;

  const playerActorId = user?.worlds?.find(w => w.world_id === world.id)?.actor_id;
  const primaryActor  = location.actors && location.actors.find(a => a.actor_id !== playerActorId);

  const [phase,        setPhase]        = useState(encounter_id ? "loading" : "empty");
  const [actorName,    setActorName]    = useState(primaryActor?.name || "");
  const [actorPhoto,   setActorPhoto]   = useState(
    primaryActor?.photo_url ? `${SIMULATOR_URL}${primaryActor.photo_url}` : null
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
  const liveResponseRef   = useRef("");
  const responseWordsRef  = useRef([]);
  const responseIdxRef    = useRef(0);
  const responseTimerRef  = useRef(null);
  const onNarrativeDone   = useRef(null);

  const esRef       = useRef(null);
  const revealTimer = useRef(null);
  const wordsRef    = useRef([]);
  const wordIdx     = useRef(0);

  // Poll on mount — handle case where SSE connected after encounter already resolved
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
    // Poll every 5s for up to 5 minutes — Hermes cold start can take ~3min
    const timers = [];
    for (let i = 1; i <= 60; i++) {
      timers.push(setTimeout(poll, i * 5000));
    }
    return () => { stopped = true; timers.forEach(clearTimeout); };
  }, [encounter_id]);

  // ── SSE connection ──────────────────────────────────────────────────────────
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

    es.onerror = () => {
      // Reconnect handled by browser
    };

    return () => {
      es.close();
      if (revealTimer.current) clearTimeout(revealTimer.current);
    };
  }, [playerActorId, encounter_id]);

  function handleEncounterEvent(data) {
    const payload = data.data || data;
    switch (payload.type) {
      case "encounter_heartbeat":
        // Keep spinner alive — update status text if still waiting
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
        // After warming, show "Knocking…" as the next step
        if (isWarming) {
          setStatusText(phaseStatus("loading", trigger));
          setTimeout(() => {
            setStatusText(phaseStatus("perceiving", trigger, payload.actor_name));
          }, 1500);
        } else {
          setStatusText(phaseStatus("perceiving", trigger, payload.actor_name));
        }
        setIsWarming(false);
        if (payload.actor_name)  setActorName(payload.actor_name);
        if (payload.actor_photo) setActorPhoto(`${SIMULATOR_URL}${payload.actor_photo}`);
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

  // ── Typewriter ──────────────────────────────────────────────────────────────
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

  // ── Send in-person message ──────────────────────────────────────────────────
  async function sendMessage() {
    if (!chatInput.trim() || sending || !encounter_id) return;
    const content = chatInput.trim();
    setChatInput("");
    setSending(true);
    setMessages(prev => [...prev, { from: "me", text: content }]);

    try {
      await fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/message`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ content })
      });
    } catch {}
    setSending(false);
  }

  // ── Leave ───────────────────────────────────────────────────────────────────
  async function leave() {
    if (encounter_id) {
      fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/end`, { method: "POST" })
        .catch(() => {});
    }
    fetch(`/api/worlds/${world.id}/leave`, { method: "POST" }).catch(() => {});
    onLeave();
  }

  // ── Time ────────────────────────────────────────────────────────────────────
  const timeStr = new Date().toLocaleTimeString("sv-SE", {
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm"
  });

  const isOpen     = decision === "open_door";
  const isRejected = decision === "ignore" || decision === "pretend_away";
  const isSentText = decision === "send_text";
  const isLoading  = phase === "loading" || phase === "perceiving";
  const hasNarrative = displayed.length > 0;

  // Transition to PresenceView when player clicks Enter
  if (showPresence) {
    return (
      <PresenceView
        world={world}
        user={user}
        sceneData={sceneData}
        actorName={actorName}
        actorPhoto={actorPhoto}
        encounter_id={encounter_id}
        onLeave={leave}
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

      {/* Main stage */}
      <div className={styles.stage}>

        {/* Actor portrait */}
        {actorPhoto && (
          <div className={`${styles.portrait} ${isLoading ? styles.portraitMuted : ""}`}>
            <img src={actorPhoto} alt={actorName} className={styles.portraitImg} />
            {actorName && <span className={styles.actorName}>{actorName}</span>}
          </div>
        )}

        {/* Loading / perceiving spinner */}
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

        {/* Outcome actions */}
        {decision && (hasNarrative || narrative) && (
          <div className={styles.actions}>

            {/* Door opened — read narrative then enter */}
            {isOpen && showEnterBtn && (
              <div className={styles.enterWrap}>
                <button className={styles.enterBtn} onClick={() => setShowPresence(true)}>
                  Enter →
                </button>
              </div>
            )}

            {/* Ignored / pretend away */}
            {isRejected && (
              <div className={styles.rejectedWrap}>
                <button className={styles.leaveSceneBtn} onClick={leave}>Walk away</button>
              </div>
            )}

            {/* Sent a text */}
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

        {/* Empty location — no encounter */}
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
    case "loading":
      return trigger === "knock" ? "Knocking at the door…" : "Entering…";
    case "perceiving":
      return actorName ? `${actorName} hears you…` : "Someone stirs inside…";
    default:
      return "…";
  }
}
