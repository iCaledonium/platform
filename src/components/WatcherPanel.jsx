import { useEffect, useRef, useState } from "react";

// ── Watcher panel ────────────────────────────────────────────────────────────
//
// Floating chat dock connecting to the anima-watcher-bridge on the DEVELOPER'S
// OWN machine (ws://127.0.0.1:8787). One open panel = one ephemeral Claude
// watcher session attached to the run; closing the panel kills it.
//
// On any machine without a local bridge the probe fails and this renders
// nothing, so the public page is unchanged. The bridge itself must never be
// exposed beyond loopback — the panel reaching it is what marks the developer.

const BRIDGE_URL = "ws://127.0.0.1:8787";
const TOKEN_KEY = "watcherBridgeToken";
const GOLD = "rgba(201,151,58,";

// Session 155 — the watcher FOLLOWS the run instead of following the URL.
//
// The overlay used to decide visibility from the route alone (/lab, or a
// ?lab=/?eid= query), which covered the lab and the door scene the lab builds.
// It did not cover where a run actually goes next: the world enter scene is
// plain /world/:id with NO query string, so the predicate went false, React
// unmounted this component, and an attached watcher died mid-run — silently,
// because a panel that is gone cannot report that it is gone.
//
// A route list can never be right here: the run can go to a venue, to messages,
// anywhere. So the panel states its own claim on the screen. While a session is
// open (including minimized to the pill) it writes this flag, and the overlay
// keeps rendering wherever the developer walks. Cleared only by ×, the gesture
// that already means "kill the watcher".
//
// sessionStorage, not localStorage, on purpose: per-tab, and gone when the tab
// closes, so a crashed panel cannot haunt every future page load.
export const FOLLOW_KEY = "watcherFollowRun";

export function watcherIsFollowing() {
  try { return sessionStorage.getItem(FOLLOW_KEY) === "1"; } catch { return false; }
}

const label = {
  fontSize: 9.5, letterSpacing: ".18em", textTransform: "uppercase",
  color: "rgba(255,255,255,.4)",
};

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

export default function WatcherPanel({ bound = null }) {
  const [reachable, setReachable] = useState(false);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState("idle"); // idle | token | connecting | pick | live | dead
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Attachments are STAGED, not fired: picking/dropping files only queues
  // them as chips; nothing reaches the watcher until → is pressed, so text
  // and files always travel together as one message.
  const [pending, setPending] = useState([]);
  // Model/effort for the NEXT attach (a session's brain is fixed at spawn;
  // change = re-attach). "default" = inherit the bridge's CLI default.
  const MODELS = ["default", "fable", "opus", "sonnet", "haiku"];
  const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];
  // Offer only what this model has. Haiku, for instance, reports none at all.
  const effortsForModel = (m) => {
    if (!modelCaps) return [...EFFORTS, "ultracode"];
    const hit = modelCaps.find((c) => (c.name || "").toLowerCase().startsWith((m || "default").toLowerCase()));
    if (!hit) return [...EFFORTS, "ultracode"];
    if (!hit.efforts || !hit.efforts.length) return ["default"];
    // "ultracode" is not a member of the SDK's EffortLevel union — it is an
    // ALIAS the CLI resolves (N={ultracode:"xhigh"}) which ALSO turns on
    // standing dynamic-workflow orchestration for the session. The SDK does no
    // runtime validation on effort (sdk.mjs passes --effort through verbatim),
    // so it reaches the CLI intact. Offer it wherever xhigh exists, since that
    // is what it resolves to. Verified empirically 2026-09-03.
    const base = ["default", ...hit.efforts];
    return hit.efforts.includes("xhigh") ? [...base, "ultracode"] : base;
  };
  const [model, setModel] = useState(() => { try { return localStorage.getItem("watcherModel") || "default"; } catch { return "default"; } });
  // Ordinary watching does not need the slowest setting: measured 2026-09-03,
  // every watcher was pinned to effort=high, which is the floor cost on every
  // turn including "what does your dossier say". Default to medium and let
  // high be a deliberate choice for a real diagnosis.
  const [effort, setEffort] = useState(() => { try { return localStorage.getItem("watcherEffort") || "medium"; } catch { return "medium"; } });
  const modelRef = useRef(model); modelRef.current = model;
  const effortRef = useRef(effort); effortRef.current = effort;
  const [applied, setApplied] = useState(null); // what the bridge actually spawned with
  const [menu, setMenu] = useState(null); // "model" | "effort" | null — composer-footer popover
  const [minimized, setMinimized] = useState(false);
  // The watcher's own notebook, fetched on demand. Readable BY YOU is the main
  // point: the only way to catch a specialist believing something wrong is to
  // be able to see what it believes.
  const [dossier, setDossier] = useState(null);
  // What each model ACTUALLY supports, straight from the SDK via the bridge.
  // Effort is per-model and an unsupported level is silently downgraded, so a
  // fixed list would show "max" while the run quietly used something else.
  const [modelCaps, setModelCaps] = useState(null);
  const [watchers, setWatchers] = useState([]);
  const [watcherName, setWatcherName] = useState("");
  const [newName, setNewName] = useState("");
  // Draggable position. null = the default corner (right/bottom 22). Once
  // dragged, {x,y} is the panel's top-left, remembered per browser — so the
  // watcher can always be moved off whatever it happens to cover (it shipped
  // sitting on top of "Build the run").
  const POS_KEY = "watcherPanelPos";
  const [pos, setPos] = useState(() => {
    try { return JSON.parse(localStorage.getItem(POS_KEY)) || null; } catch { return null; }
  });
  const dragRef = useRef(null);

  // Size, remembered like position. A long finding scrolls badly in a narrow
  // column, and a run you are only glancing at should be able to shrink out
  // of the way — so the panel is the developer's to shape, not a fixed slab.
  const SIZE_KEY = "watcherPanelSize";
  const MIN_W = 300, MIN_H = 220;
  const [size, setSize] = useState(() => {
    try { return JSON.parse(localStorage.getItem(SIZE_KEY)) || null; } catch { return null; }
  });
  const resizeRef = useRef(null);

  // `axis`: "x" | "y" | "xy" — the corner grip takes both, the edges take one.
  const startResize = (axis) => (e) => {
    e.preventDefault();
    e.stopPropagation();                      // never let the header's drag see this
    const el = e.currentTarget.closest("[data-watcher-root]");
    if (!el) return;
    const r = el.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    resizeRef.current = start;
    const onMove = (ev) => {
      const next = {
        w: axis.includes("x")
          ? Math.max(MIN_W, Math.min(start.w + (ev.clientX - start.x), window.innerWidth - 40))
          : start.w,
        h: axis.includes("y")
          ? Math.max(MIN_H, Math.min(start.h + (ev.clientY - start.y), window.innerHeight - 40))
          : start.h,
      };
      setSize(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      resizeRef.current = null;
      setSize((cur) => {
        try { localStorage.setItem(SIZE_KEY, JSON.stringify(cur)); } catch {}
        return cur;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const dragged = pos
    ? { left: Math.max(0, Math.min(pos.x, window.innerWidth - 60)),
        top:  Math.max(0, Math.min(pos.y, window.innerHeight - 40)) }
    : null;
  // Pills sit bottom-left; the open panel is a tall left column (the shape
  // Magnus asked for), unless the user has dragged it somewhere.
  const posStyle = dragged || { left: 22, bottom: 22 };
  const panelPosStyle = dragged || { left: 22, top: 90 };

  const startDrag = (e) => {
    if (e.target.closest("button") && e.currentTarget.tagName !== "BUTTON") return;
    const el = e.currentTarget.closest("[data-watcher-root]") || e.currentTarget;
    const r = el.getBoundingClientRect();
    const d = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    dragRef.current = d;
    const onMove = (ev) => {
      if (Math.abs(ev.clientX - (r.left + d.dx)) + Math.abs(ev.clientY - (r.top + d.dy)) > 4) d.moved = true;
      if (d.moved) setPos({ x: ev.clientX - d.dx, y: ev.clientY - d.dy });
    };
    const onUp = (ev) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (d.moved) {
        const v = { x: ev.clientX - d.dx, y: ev.clientY - d.dy };
        try { localStorage.setItem(POS_KEY, JSON.stringify(v)); } catch {}
      }
      setTimeout(() => { dragRef.current = null; }, 250);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const clickUnlessDragged = (fn) => () => { if (!dragRef.current?.moved) fn(); };
  const wsRef = useRef(null);
  const streamRef = useRef("");
  const scrollRef = useRef(null);

  // Probe once: is a local bridge listening? If not, render nothing at all.
  const autoAttachName = useRef(null);
  const autoTried = useRef(false);
  const pendingAsks = useRef([]);

  useEffect(() => {
    const onAsk = (e) => {
      const text = e?.detail?.text;
      if (!text) return;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && phaseRef.current === "live") {
        push({ kind: "me", text });
        ws.send(JSON.stringify({ type: "user", text }));
        setBusy(true);
      } else {
        pendingAsks.current.push(text);
        if (!openRef.current) openPanel();
      }
    };
    window.addEventListener("watcher:ask", onAsk);
    return () => window.removeEventListener("watcher:ask", onAsk);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // live-phase mirror refs so the event handler sees current state
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const openRef = useRef(open); openRef.current = open;

  // deliver queued asks the moment the session is live
  useEffect(() => {
    if (phase !== "live" || pendingAsks.current.length === 0) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const text of pendingAsks.current.splice(0)) {
      push({ kind: "me", text });
      ws.send(JSON.stringify({ type: "user", text }));
      setBusy(true);
    }
  }, [phase]);  // eslint-disable-line react-hooks/exhaustive-deps
  const boundRef = useRef(bound);
  boundRef.current = bound;

  // Crossing into a lab surface with a DIFFERENT bound conversation switches
  // the panel to it: kill this process (the conversation survives), reconnect,
  // attach the page's own watcher. Strict by Magnus's rule.
  useEffect(() => {
    if (!bound || !open) return;
    if (watcherName && watcherName !== bound) {
      killSession();
      const t = readToken();
      if (t) { autoAttachName.current = bound; startSession(t); }
    }
  }, [bound]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let ws;
    try { ws = new WebSocket(BRIDGE_URL); } catch { return; }
    ws.onopen = () => {
      setReachable(true); ws.close();
      // Watchers belong to TEST CASES (Magnus's rule, 2026-08-29): only a
      // page that BINDS a conversation may auto-attach it. Unbound surfaces
      // like /lab/home start as the pill and offer the picker on click —
      // there is no "last used" fallback, because which watcher you touched
      // most recently says nothing about the page you are on now.
      if (!autoTried.current) {
        autoTried.current = true;
        const t = readToken();
        if (t && boundRef.current) {
          autoAttachName.current = boundRef.current;
          setOpen(true); startSession(t);
        }
      }
    };
    ws.onerror = () => {};
    return () => { try { ws.close(); } catch {} };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);

  const push = (m) => setMessages((prev) => [...prev, m]);

  const finalizeStream = () => {
    streamRef.current = "";
  };

  const appendDelta = (text) => {
    streamRef.current += text;
    const buf = streamRef.current;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "watcher" && last.live) {
        return [...prev.slice(0, -1), { ...last, text: buf }];
      }
      return [...prev, { kind: "watcher", text: buf, live: true }];
    });
  };

  const settleBubble = (text) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "watcher" && last.live) {
        return [...prev.slice(0, -1), { kind: "watcher", text: last.text }];
      }
      return text ? [...prev, { kind: "watcher", text }] : prev;
    });
    finalizeStream();
  };

  const killSession = () => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "kill" })); } catch {}
      try { ws.close(); } catch {}
    }
    wsRef.current = null;
  };

  const startSession = (token) => {
    setMessages([]);
    setBusy(false);
    finalizeStream();
    setPhase("connecting");
    const ws = new WebSocket(BRIDGE_URL);
    wsRef.current = ws;
    ws.onopen = () => { if (wsRef.current === ws) ws.send(JSON.stringify({ type: "auth", token })); };
    ws.onmessage = (evt) => {
      // A switch (killSession then startSession) replaces wsRef.current with a
      // NEW socket while the OLD one is still closing — the server can keep
      // streaming to it for a moment. Without this guard the dying socket's
      // events fire on this closure's setters and stomp the new session's
      // state right after it's set (2026-09-04: a Character Wizard tool-call
      // delta landed after a User Avatar attach failed, leaving the header
      // reading "Character Wizard / WORKING" over the avatar page's error).
      if (wsRef.current !== ws) return;
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === "ready") {
        if (msg.models) setModelCaps(msg.models);
        setWatchers(msg.watchers || []);
        const auto = autoAttachName.current;
        autoAttachName.current = null;
        if (auto && (msg.watchers || []).some(w => w.name === auto)) {
          setWatcherName(auto); setPhase("connecting");
          ws.send(JSON.stringify(attachPayload(auto, true)));
        } else setPhase("pick");
      }
      else if (msg.type === "init") {
        setPhase("live"); setBusy(true);
        if (msg.watcher) setWatcherName(msg.watcher);
        setApplied(msg.model || msg.effort ? { model: msg.model, effort: msg.effort } : null);
      }
      else if (msg.type === "text") appendDelta(msg.text);
      else if (msg.type === "assistant") settleBubble(msg.text);
      else if (msg.type === "tool") {
        settleBubble("");
        push({ kind: "tool", text: `${msg.name} ${msg.input}` });
      } else if (msg.type === "uploaded") { /* path already travelling to the watcher */ }
      else if (msg.type === "dossier") setDossier(msg.text || "(nothing written yet)");
      else if (msg.type === "turn_done") { settleBubble(""); setBusy(false); }
      else if (msg.type === "error") {
        if (/already attached elsewhere/.test(msg.message || "")) { setPhase("pick"); setWatcherName(""); }
        push({ kind: "sys", text: `error: ${msg.message}` });
      }
    };
    ws.onclose = (evt) => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      if (evt.code === 4003) {
        try { localStorage.removeItem(TOKEN_KEY); } catch {}
        setPhase("token");
        push({ kind: "sys", text: "bad token — enter it again" });
      } else {
        setPhase("dead");
        setBusy(false);
      }
    };
    ws.onerror = () => {};
  };

  const attachPayload = (name, kickoff) => {
    const p = { type: "attach", name, kickoff };
    if (modelRef.current !== "default") p.model = modelRef.current;
    if (effortRef.current !== "default") p.effort = effortRef.current;
    return p;
  };

  const attachWatcher = (name) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setWatcherName(name);
    setPhase("connecting");
    ws.send(JSON.stringify(attachPayload(name, true)));
  };

  // Swap the session's brain: kill only the PROCESS (the conversation is
  // kept), reconnect, and re-attach the same watcher — attachPayload reads
  // the current model/effort selection, and the bridge persists it per
  // watcher, so the choice sticks to the test case's conversation.
  const reattach = () => {
    const name = watcherName;
    const t = readToken();
    if (!name || !t) return;
    killSession();
    autoAttachName.current = name;
    startSession(t);
  };

  // Claude-composer style: picking a different value applies it immediately
  // by respawning the same conversation on the chosen brain.
  const pickBrain = (kind, value) => {
    setMenu(null);
    const cur = kind === "model" ? model : effort;
    if (kind === "model") { setModel(value); modelRef.current = value; }
    else { setEffort(value); effortRef.current = value; }
    try { localStorage.setItem(kind === "model" ? "watcherModel" : "watcherEffort", value); } catch {}
    if (value !== cur && phase === "live" && watcherName) reattach();
  };

  const openPanel = () => {
    setOpen(true);
    setMinimized(false);
    const token = readToken();
    if (!token) { setPhase("token"); return; }
    if (boundRef.current) autoAttachName.current = boundRef.current;
    startSession(token);
  };

  const closePanel = () => {
    killSession();
    setOpen(false);
    setMinimized(false);
    setPhase("idle");
  };

  // Claim the screen for as long as the panel is open, and let go on ×. Written
  // from an effect rather than inside openPanel/closePanel so that it tracks the
  // state that actually decides whether a socket exists — including the pill,
  // which is minimized but very much alive.
  useEffect(() => {
    try {
      if (open) sessionStorage.setItem(FOLLOW_KEY, "1");
      else sessionStorage.removeItem(FOLLOW_KEY);
    } catch {}
  }, [open]);

  const send = async () => {
    const text = input.trim();
    const ws = wsRef.current;
    if ((!text && pending.length === 0) || !ws || ws.readyState !== WebSocket.OPEN) return;
    const files = pending;
    setPending([]);
    setInput("");
    // Uploads travel first (defer: the bridge parks them), then the text —
    // the bridge folds parked paths into this one user turn.
    for (const f of files) {
      const data = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1] || "");
        r.onerror = () => res(null);
        r.readAsDataURL(f);
      });
      if (data === null) { push({ kind: "sys", text: `${f.name}: read failed` }); continue; }
      ws.send(JSON.stringify({ type: "upload", defer: true, name: f.name, mime: f.type, data }));
    }
    const shown = files.length
      ? files.map((f) => `📎 ${f.name}`).join("  ") + (text ? "\n" + text : "")
      : text;
    push({ kind: "me", text: shown });
    ws.send(JSON.stringify({ type: "user", text: text || "(see attached file(s))" }));
    setBusy(true);
  };

  const fileRef = useRef(null);

  const stageFiles = (files) => {
    if (phase !== "live") return;
    const ok = [];
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) { push({ kind: "sys", text: `${f.name}: too large (25MB max)` }); continue; }
      ok.push(f);
    }
    if (ok.length) setPending((p) => [...p, ...ok]);
  };

  if (!reachable) return null;

  if (!open) {
    return (
      <button data-watcher-root onPointerDown={startDrag}
        onClick={clickUnlessDragged(openPanel)} title="Attach a watcher to this run — drag to move"
        style={{ position: "fixed", ...posStyle, zIndex: 100000,
          padding: "11px 18px", borderRadius: 999, cursor: "pointer",
          background: "#12100d", color: GOLD + ".9)",
          border: `0.5px solid ${GOLD}.45)`,
          fontSize: 10.5, letterSpacing: ".16em", textTransform: "uppercase",
          fontFamily: "'DM Sans',system-ui,sans-serif" }}>
        ◉ Watcher
      </button>
    );
  }

  const dot = phase === "live" ? (busy ? GOLD + ".95)" : "rgba(120,190,120,.9)")
    : phase === "dead" ? "rgba(200,90,80,.9)" : "rgba(255,255,255,.35)";

  const brainSelects = [["model", model, setModel, MODELS, "watcherModel"],
    ["effort", effort, setEffort, effortsForModel(model), "watcherEffort"]].map(([cap, val, set, opts, key]) => (
    <label key={cap} style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
      <span style={label}>{cap}</span>
      <select value={val}
        onChange={(e) => { set(e.target.value); try { localStorage.setItem(key, e.target.value); } catch {} }}
        style={{ background: "#080706", border: "0.5px solid rgba(255,255,255,.15)",
          borderRadius: 7, padding: "7px 9px", color: "rgba(255,255,255,.85)",
          fontSize: 11, outline: "none" }}>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  ));

  // Minimized: the panel folds back into the pill, but the session stays
  // alive — unlike ×, which kills the watcher. The dot keeps reporting.
  if (minimized) {
    return (
      <button data-watcher-root onPointerDown={startDrag}
        onClick={clickUnlessDragged(() => setMinimized(false))} title="Restore the watcher panel — drag to move"
        style={{ position: "fixed", ...posStyle, zIndex: 100000,
          display: "flex", alignItems: "center", gap: 8,
          padding: "11px 18px", borderRadius: 999, cursor: "pointer",
          background: "#12100d", color: GOLD + ".9)",
          border: `0.5px solid ${GOLD}.45)`,
          fontSize: 10.5, letterSpacing: ".16em", textTransform: "uppercase",
          fontFamily: "'DM Sans',system-ui,sans-serif" }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: dot }} />
        Watcher{phase === "live" && busy ? " · working" : ""}
      </button>
    );
  }

  return (
    <div data-watcher-root
      onDragOver={(e) => { e.preventDefault(); }}
      onDrop={(e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) stageFiles([...e.dataTransfer.files]); }}
      style={{ position: "fixed", ...panelPosStyle, zIndex: 100000,
      width: size ? Math.min(size.w, window.innerWidth - 40) : 400,
      height: size ? Math.min(size.h, window.innerHeight - 40) : "min(880px, calc(100vh - 130px))",
      overflow: "hidden",
      display: "flex", flexDirection: "column",
      background: "#0f0e0b", border: "0.5px solid rgba(255,255,255,.12)",
      borderRadius: 12, boxShadow: "0 18px 50px rgba(0,0,0,.6)",
      fontFamily: "'DM Sans',system-ui,sans-serif" }}>

      <div onPointerDown={startDrag} title="Drag to move"
        style={{ display: "flex", alignItems: "center", gap: 9, cursor: "grab",
        padding: "11px 14px", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: dot }} />
        <span style={{ ...label, color: GOLD + ".8)" }}>{watcherName || "Watcher"}</span>
        <span style={{ ...label, fontSize: 8.5 }}>
          {phase === "live" ? (busy ? "working" : "watching")
            : phase === "connecting" ? "attaching"
            : phase === "dead" ? "session ended" : ""}
        </span>
        <div style={{ flex: 1 }} />
        {phase === "live" && busy && (
          <button onClick={() => wsRef.current?.send(JSON.stringify({ type: "interrupt" }))}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: "rgba(255,255,255,.45)", fontSize: 10, letterSpacing: ".1em" }}>
            interrupt
          </button>
        )}
        {phase === "dead" && (
          <button onClick={() => { const t = readToken(); t ? startSession(t) : setPhase("token"); }}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: GOLD + ".8)", fontSize: 10, letterSpacing: ".1em" }}>
            new watcher
          </button>
        )}
        {phase === "live" && (
          <button title="This watcher's dossier — what it has established on this test case"
            onClick={() => {
              if (dossier !== null) { setDossier(null); return; }
              wsRef.current?.send(JSON.stringify({ type: "dossier" }));
            }}
            style={{ background: "none", border: "none", cursor: "pointer",
              color: dossier !== null ? GOLD + ".9)" : "rgba(255,255,255,.45)",
              fontSize: 10, letterSpacing: ".1em" }}>
            dossier
          </button>
        )}
        {phase === "live" && (
          <button disabled={busy}
            title={busy
              ? "Restart the whole scenario — available once the watcher finishes this turn"
              : "Restart the whole scenario — the watcher snapshots, rebuilds the fixture from the first stage, and posts the new scene link"}
            onClick={() => {
              const text = "Restart the WHOLE scenario from the beginning: take a labelled snapshot first, " +
                "then rebuild the fixture for the current pair at the scenario's first stage with the same " +
                "configuration, and reply with the new scene path (/world/...) so I can click straight into it.";
              push({ kind: "me", text: "⟳ restart the scenario" });
              wsRef.current?.send(JSON.stringify({ type: "user", text }));
              setBusy(true);
            }}
            style={{ background: "none", border: "none",
              cursor: busy ? "default" : "pointer",
              color: busy ? "rgba(255,255,255,.25)" : GOLD + ".8)",
              fontSize: 13, lineHeight: 1 }}>
            ⟳
          </button>
        )}
        <button onClick={() => setMinimized(true)} title="Minimize — the watcher keeps running"
          style={{ background: "none", border: "none", cursor: "pointer",
            color: "rgba(255,255,255,.5)", fontSize: 14, lineHeight: 1 }}>
          –
        </button>
        <button onClick={closePanel} title="Close panel — the process ends, the conversation is kept"
          style={{ background: "none", border: "none", cursor: "pointer",
            color: "rgba(255,255,255,.5)", fontSize: 14, lineHeight: 1 }}>
          ×
        </button>
      </div>

      {phase === "pick" ? (
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" }}>
          <div style={{ display: "flex", gap: 8 }}>{brainSelects}</div>
          <span style={label}>ongoing watchers — pick a conversation</span>
          {watchers.map(w => (
            <button key={w.name} onClick={() => !w.live && attachWatcher(w.name)} disabled={w.live}
              style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3,
                padding: "10px 12px", borderRadius: 7, cursor: w.live ? "default" : "pointer",
                background: "rgba(255,255,255,.03)", textAlign: "left",
                border: "0.5px solid rgba(255,255,255,.1)",
                color: "rgba(255,255,255,.85)", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
              <span style={{ fontSize: 12.5, color: w.live ? "rgba(255,255,255,.4)" : GOLD + ".9)" }}>{w.name}</span>
              <span style={{ fontSize: 9, color: "rgba(255,255,255,.35)" }}>
                {w.live ? "attached in another window" : w.lastUsed ? "last used " + new Date(w.lastUsed).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "never used"}
              </span>
            </button>
          ))}
          <input value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && newName.trim()) attachWatcher(newName.trim()); }}
            placeholder={watchers.length ? "new watcher — name it, press Enter" : "e.g. Feature — Actor Encounter, press Enter"}
            style={{ background: "#080706", border: "0.5px solid rgba(255,255,255,.15)",
              borderRadius: 7, padding: "9px 11px", color: "rgba(255,255,255,.85)",
              fontSize: 12, outline: "none" }} />
        </div>
      ) : phase === "token" ? (
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={label}>bridge token</span>
          <input type="password" autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.target.value.trim()) {
                try { localStorage.setItem(TOKEN_KEY, e.target.value.trim()); } catch {}
                // A fresh token should land you in the page's own watcher,
                // not the picker — same binding as every other entry path.
                if (boundRef.current) autoAttachName.current = boundRef.current;
                startSession(e.target.value.trim());
              }
            }}
            placeholder="paste ~/anima-watcher-bridge/token, press Enter"
            style={{ background: "#080706", border: "0.5px solid rgba(255,255,255,.15)",
              borderRadius: 7, padding: "9px 11px", color: "rgba(255,255,255,.85)",
              fontSize: 12, outline: "none" }} />
        </div>
      ) : (
        <>
          {dossier !== null && (
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "12px 14px",
              whiteSpace: "pre-wrap", fontSize: 11, lineHeight: 1.6,
              color: "rgba(255,255,255,.72)", fontFamily: "ui-monospace,monospace",
              borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
              {dossier}
            </div>
          )}
          <div ref={scrollRef} style={{ flex: dossier !== null ? "none" : 1, maxHeight: dossier !== null ? 170 : "none", overflowY: "auto", overflowX: "hidden",
            scrollbarWidth: "thin", padding: "12px 14px",
            display: "flex", flexDirection: "column", gap: 8 }}>
            {messages.map((m, i) =>
              m.kind === "tool" ? (
                <div key={i} style={{ fontSize: 9.5, color: "rgba(255,255,255,.28)",
                  fontFamily: "ui-monospace,monospace", whiteSpace: "nowrap",
                  overflow: "hidden", textOverflow: "ellipsis" }}>⚙ {m.text}</div>
              ) : m.kind === "sys" ? (
                <div key={i} style={{ fontSize: 10, color: "rgba(200,90,80,.85)" }}>{m.text}</div>
              ) : (
                <div key={i} style={{ alignSelf: m.kind === "me" ? "flex-end" : "flex-start",
                  maxWidth: "88%", padding: "8px 11px", borderRadius: 10,
                  whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word",
                  fontSize: 12, lineHeight: 1.55,
                  background: m.kind === "me" ? GOLD + ".14)" : "rgba(255,255,255,.05)",
                  border: `0.5px solid ${m.kind === "me" ? GOLD + ".3)" : "rgba(255,255,255,.08)"}`,
                  color: "rgba(255,255,255,.82)" }}>
                  {m.text.split(/(\/(?:world|lab)\/[^\s)`"']+)/g).map((part, j) =>
                    /^\/(?:world|lab)\//.test(part) ? (
                      <span key={j} onClick={() => { window.location.href = part; }}
                        style={{ color: GOLD + ".9)", textDecoration: "underline", cursor: "pointer" }}>
                        {part}
                      </span>
                    ) : part)}
                </div>
              )
            )}
            {(phase === "connecting" ||
              (phase === "live" && busy && !(messages[messages.length - 1]?.kind === "watcher" && messages[messages.length - 1]?.live))) && (
              <div style={{ alignSelf: "flex-start", padding: "10px 13px", borderRadius: 10,
                background: "rgba(255,255,255,.05)", border: "0.5px solid rgba(255,255,255,.08)",
                display: "flex", gap: 4 }}>
                {[0, 1, 2].map(k => (
                  <span key={k} style={{ width: 5, height: 5, borderRadius: 99,
                    background: "rgba(255,255,255,.55)",
                    animation: `watcherDot 1.2s ${k * 0.2}s infinite` }} />
                ))}
              </div>
            )}
            <style>{`@keyframes watcherDot { 0%, 60%, 100% { opacity: .25; } 30% { opacity: 1; } }`}</style>
          </div>

          {pending.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 12px 0" }}>
              {pending.map((f, i) => (
                <span key={i} style={{ display: "flex", alignItems: "center", gap: 5,
                  fontSize: 10, color: "rgba(255,255,255,.7)",
                  background: "rgba(255,255,255,.06)",
                  border: "0.5px solid rgba(255,255,255,.12)",
                  borderRadius: 999, padding: "3px 9px" }}>
                  📎 {f.name}
                  <span onClick={() => setPending((p) => p.filter((_, j) => j !== i))}
                    title="Remove attachment"
                    style={{ cursor: "pointer", color: "rgba(255,255,255,.45)" }}>×</span>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, padding: 12, alignItems: "flex-end",
            borderTop: "0.5px solid rgba(255,255,255,.08)" }}>
            <input ref={fileRef} type="file" multiple style={{ display: "none" }}
              onChange={(e) => { if (e.target.files?.length) stageFiles([...e.target.files]); e.target.value = ""; }} />
            <button onClick={() => fileRef.current?.click()} disabled={phase !== "live"}
              title="Attach a file — it is sent together with your text when you press →. Or drop files anywhere on the panel."
              style={{ background: "none", border: "none", cursor: "pointer",
                color: "rgba(255,255,255,.5)", fontSize: 15, lineHeight: 1, padding: "0 2px 9px" }}>
              📎
            </button>
            <textarea value={input} rows={2}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              disabled={phase !== "live"}
              placeholder={phase === "live" ? "ask the watcher…  (Shift+Enter = new line)" : ""}
              style={{ flex: 1, background: "#080706",
                border: "0.5px solid rgba(255,255,255,.15)", borderRadius: 7,
                padding: "9px 11px", color: "rgba(255,255,255,.85)", fontSize: 12,
                outline: "none", resize: "none", minHeight: 54, maxHeight: 140,
                lineHeight: 1.5, fontFamily: "inherit" }} />
            <button onClick={send} disabled={phase !== "live"}
              style={{ padding: "9px 14px", borderRadius: 7, cursor: "pointer",
                background: GOLD + ".16)", border: `0.5px solid ${GOLD}.4)`,
                color: GOLD + ".9)", fontSize: 11, marginBottom: 3 }}>
              →
            </button>
          </div>
          <div style={{ position: "relative", display: "flex", justifyContent: "flex-end",
            gap: 16, padding: "0 16px 9px" }}>
            {menu && (
              <div style={{ position: "absolute", bottom: 24, right: 12, zIndex: 10,
                background: "#12100d", border: "0.5px solid rgba(255,255,255,.18)",
                borderRadius: 8, padding: 4, boxShadow: "0 10px 30px rgba(0,0,0,.55)",
                display: "flex", flexDirection: "column", minWidth: 92 }}>
                {(menu === "model" ? MODELS : effortsForModel(model)).map((o) => (
                  <div key={o} onClick={() => pickBrain(menu, o)}
                    style={{ padding: "6px 10px", borderRadius: 5, cursor: "pointer", fontSize: 11,
                      color: o === (menu === "model" ? model : effort) ? GOLD + ".95)" : "rgba(255,255,255,.75)",
                      background: o === (menu === "model" ? model : effort) ? GOLD + ".12)" : "transparent" }}>
                    {o}
                  </div>
                ))}
              </div>
            )}
            {[["model", model], ["effort", effort]].map(([kind, val]) => (
              <span key={kind}
                onClick={() => phase === "live" && setMenu(menu === kind ? null : kind)}
                title={`${kind} — picking a different one re-attaches this watcher (conversation kept)`}
                style={{ ...label, fontSize: 9, cursor: phase === "live" ? "pointer" : "default",
                  color: GOLD + (phase === "live" ? ".65)" : ".35)") }}>
                {val === "default" ? kind : val}
              </span>
            ))}
          </div>
        </>
      )}

      {/* Resize grips. Pointer-events only on the strips themselves, so they
          never steal a click from the chat or the header's move-drag. */}
      <div onPointerDown={startResize("x")} title="Drag to resize width"
        style={{ position: "absolute", top: 0, right: 0, width: 6, height: "100%",
          cursor: "ew-resize", touchAction: "none" }} />
      <div onPointerDown={startResize("y")} title="Drag to resize height"
        style={{ position: "absolute", left: 0, bottom: 0, width: "100%", height: 6,
          cursor: "ns-resize", touchAction: "none" }} />
      <div onPointerDown={startResize("xy")} title="Drag to resize"
        style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16,
          cursor: "nwse-resize", touchAction: "none",
          background: "linear-gradient(135deg, transparent 55%, rgba(255,255,255,.22) 55%, rgba(255,255,255,.22) 70%, transparent 70%, transparent 80%, rgba(255,255,255,.22) 80%)" }} />
    </div>
  );
}
