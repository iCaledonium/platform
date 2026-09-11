import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import InteractionStudioScene, { MARKS, ROLE_COLOR, PROP_TYPES } from "./InteractionStudioScene.jsx";
import { listActions } from "../lib/bodyActions.js";
import InteractionActionEditor from "./InteractionActionEditor.jsx";
import InteractionTimeline from "./InteractionTimeline.jsx";
import { estimateTimeline, positionsBefore } from "../lib/interactionScript.js";
import { getAction, registerActions } from "../lib/bodyActions.js";
import {
  STEP_TYPES, ROLES, defaultStep, describeScript, normalizeSteps, runScript, drivenRoles, timingWarnings,
  SHOTS, describeCamera, cameraAt, normalizeCameras, hoistLegacyCameras,
} from "../lib/interactionScript.js";

// What an ENCOUNTER's rig will own. Role "b" there is the player: first person,
// pointer-locked, a human being. The studio owns both figures because both are
// its own puppets, so a script can drive "b" here and rehearse beautifully and
// then be unplayable at her door. That is exactly the trap worth closing at
// AUTHOR time — the verdict is rendered next to the name, before it is saved,
// rather than discovered as somebody's camera being taken away mid-scene.
const ENCOUNTER_DRIVES = ["a"];

// ── Interaction Studio ───────────────────────────────────────────────────────
//
// Session 157 — a bench for the half of an encounter that is not words.
//
// Two runtime bodies in an empty room, lit exactly as her flat is lit, and a
// list of things they do to each other that can be saved under a name and
// played back. The encounter's own scene stays untouched: it gains the ability
// to run these later by importing the same runner (lib/interactionScript.js),
// which is why nothing about the vocabulary lives in this file.
//
// It sits at /lab/studio/interaction rather than under /studio for one
// concrete reason: the Claude panel is bound to LAB TERRITORY by rule (see
// LabWatcherOverlay in App.jsx), and a bench without its watcher is a bench you
// have to describe over your shoulder. The way in is the card on /home.

const GOLD = "#c9973a";
const PAPER = "#eeecea";

const cardStyle = {
  background: "#fff", border: "1px solid rgba(0,0,0,.07)", borderRadius: 10,
  padding: "14px 16px",
};

const labelStyle = {
  fontSize: 9.5, letterSpacing: ".18em", textTransform: "uppercase",
  color: "#a8a5a0", margin: "0 0 8px",
};

// The same small control the step rows use, hoisted to module scope so the
// camera inspector can share it rather than growing a second look for the same
// kind of field.
const inputStyle = {
  fontSize: 11.5, padding: "3px 6px", borderRadius: 5,
  border: "1px solid rgba(0,0,0,.12)", color: "#2f2c28", background: "#fff",
};

const btn = (kind = "plain") => ({
  fontFamily: "'DM Sans',system-ui,sans-serif", fontSize: 12,
  padding: "6px 12px", borderRadius: 6, cursor: "pointer",
  border: kind === "primary" ? "1px solid rgba(176,92,8,.3)" : "1px solid rgba(0,0,0,.12)",
  background: kind === "primary" ? "rgba(176,92,8,.08)" : "#fff",
  color: kind === "primary" ? "#b05c08" : "#55524e",
});

// The one piece of furniture the studio can put in the room.
const THE_TABLE = { x: 0, z: 0, hw: 0.4, hd: 0.35, h: 0.72, label: "table" };

export default function InteractionStudioPage() {
  const navigate = useNavigate();

  const [castList, setCastList] = useState([]);
  const [cast, setCast]         = useState({ a: null, b: null });
  const [clips, setClips]       = useState({ a: [], b: [] });

  const [scripts, setScripts]   = useState([]);
  const [scriptId, setScriptId] = useState(null);   // null = unsaved draft
  const [name, setName]         = useState("Untitled interaction");
  const [description, setDescription] = useState("");
  const [steps, setSteps]       = useState([]);
  const [dirty, setDirty]       = useState(false);

  const [running, setRunning]   = useState(false);
  const [liveStep, setLiveStep] = useState(-1);
  const [log, setLog]           = useState([]);
  const [saveNote, setSaveNote] = useState(null);
  // A single piece of furniture, on or off. Not a furnishing tool — just
  // enough room for "is it in the way?" to have both answers. 0.8m across and
  // 0.7m deep: narrow enough that the two start marks are clear of it once the
  // planner has grown it by the body radius, deep enough that going round is
  // visibly a detour rather than a wobble.
  // Which prop is waiting to be put down, if any.
  const [placing, setPlacing] = useState(null);
  // The furniture this rehearsal is staged with. Saved with the script as a
  // STAND-IN: a real room later supplies the real pieces, and a prop's `slot`
  // is how one claims another. What the script depends on is that a table was
  // in the way, not that it stood at x=0.4.
  const [props, setProps] = useState([]);
  const [selectedProp, setSelectedProp] = useState(null);

  const applyProps = (next) => {
    setProps(next);
    rigRef.current?.setObstacles?.(next);
    setDirty(true);
  };
  const removeProp = (id) => {
    applyProps(props.filter(x => x.id !== id));
    setSelectedProp(s => (s === id ? null : s));
  };
  const DEG = Math.PI / 180;
  const yawOf = (pr) => (Number.isFinite(pr.yaw) ? pr.yaw : ((pr.rot || 0) * Math.PI) / 2);
  const turnProp = (id, radians) =>
    applyProps(props.map(x => (x.id === id
      ? { ...x, yaw: (yawOf(x) + radians + Math.PI * 2) % (Math.PI * 2), rot: undefined }
      : x)));
  const setYaw = (id, deg) =>
    applyProps(props.map(x => (x.id === id
      ? { ...x, yaw: ((deg * DEG) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2), rot: undefined }
      : x)));
  // The rig lands through a ref, and a ref does not re-render. The editor has
  // to be handed a live rig, so this flips when it arrives.
  const [rigReady, setRigReady] = useState(false);
  // Which step the detail editor below is editing. The steps ARE the sequence;
  // the editor is a view onto ONE of them, and which one has to be visible or
  // you are editing something you cannot see you selected.
  const [selected, setSelected] = useState(-1);
  // Cameras are their own track now, not a field on a step: a cut can land
  // partway through a step instead of only at its edges.
  const [cameras, setCameras] = useState([]);
  const [selectedCam, setSelectedCam] = useState(-1);

  const rigRef = useRef(null);
  const runRef = useRef(null);

  const say = useCallback((text, tone = "note") => {
    setLog(l => [...l.slice(-60), { text, tone, at: Date.now() }]);
  }, []);

  // ── who is available ───────────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/interaction-studio/cast", { credentials: "include" })
      .then(r => (r.ok ? r.json() : []))
      .then(list => {
        setCastList(list);
        // Open with two bodies already standing there. An empty room with two
        // empty dropdowns is a form; a room with people in it is a bench.
        const ready = list.filter(p => !p.unavailable);
        setCast(c => ({
          a: c.a || ready.find(p => p.kind === "character") || ready[0] || null,
          b: c.b || ready.find(p => p.kind === "you") || ready[1] || null,
        }));
      })
      .catch(() => {});
    loadScripts();
  }, []);

  function loadScripts() {
    fetch("/api/interaction-scripts", { credentials: "include" })
      .then(r => (r.ok ? r.json() : []))
      .then(setScripts)
      .catch(() => {});
  }

  const editCam = (i, patch) => {
    setCameras(cs => cs.map((c, n) => (n === i ? { ...c, ...patch } : c)));
    setDirty(true);
  };
  const removeCam = (i) => { setCameras(cs => cs.filter((_, n) => n !== i)); setSelectedCam(-1); setDirty(true); };

  const script = useMemo(
    () => ({ name, description, steps, cameras, props,
              cast: ROLES.map(r => ({ role: r, actor_id: cast[r]?.id || null, label: cast[r]?.name || null })) }),
    [name, description, steps, cameras, props, cast]
  );

  // Recomputed as you type, because a verdict that only appears on save is a
  // verdict that arrives after the thinking is done.
  const drives = useMemo(() => drivenRoles({ steps }), [steps]);
  const studioOnly = drives.filter(r => !ENCOUNTER_DRIVES.includes(r));

  // ── the run ────────────────────────────────────────────────────────────────
  // `run()` plays THIS script. run(someScript) plays a throwaway one — used by
  // the action editor's Play, which must never touch the steps you are
  // composing. It previously did exactly that, by calling setSteps with a
  // single preview step, and silently ate an unsaved sequence.
  //
  // The argument is type-checked rather than trusted because this is also wired
  // straight to an onClick, which would otherwise hand it a DOM event.
  function run(arg) {
    if (running) return;
    const scriptToRun = arg && Array.isArray(arg.steps) ? arg : script;
    const rig = rigRef.current;
    if (!rig) { say("no room yet — the models are still loading", "warn"); return; }
    const { errors } = normalizeSteps(scriptToRun.steps);
    if (errors.length) { say(errors.join("; "), "warn"); return; }

    setLog([]);
    setRunning(true);
    // A whole script starts from the marks: it is the scene from the top.
    // A PREVIEW does not — it answers "what does this look like from here",
    // and resetting first would send them back across the room and answer a
    // different question than the one asked. You selected step 3 to stand them
    // where step 3 finds them; playing the step must not undo that.
    if (scriptToRun.resetMarks !== false) rig.reset();
    const handle = runScript(scriptToRun, {
      // The studio owns both figures, and says so. An encounter's rig will
      // declare ["a"] and the runner will refuse anything that drives the
      // player rather than performing three quarters of it.
      drives: ROLES,
      performer: (role) => rig.performer(role),
      // The studio has no voice: a line becomes a caption in the log, and the
      // runner's own pacing (a beat per line) is what makes a rehearsal read
      // at conversation speed. In an encounter this same call is her TTS.
      // Framing. Omitted when the camera moved onto steps, so every shot in a
      // RUN was silently skipped while the same shots worked on selection —
      // because selection calls the rig directly and only the runner sees this
      // hand-assembled subset. Anything the rig gains has to be added here too.
      camera: (spec) => rig.camera?.(spec),
      // Proxemics. Same lesson as the camera: anything the rig gains has to be
      // added to this hand-assembled subset or the runner silently cannot do it.
      setSpace: (role, d) => rig.setSpace?.(role, d),
      say: null,
      // Stop has to reach the BODIES, not just the interpreter. Without this
      // the runner cancelled its own loop and left whoever was mid-stride
      // still walking to a destination nobody had asked for any more — the
      // run reads as stopped and the room disagrees.
      stopAll: () => rig.stopAll(),
    }, {
      onEvent: (e) => {
        if (e.type === "step") { setLiveStep(e.index); say(`${e.index + 1}. ${STEP_TYPES[e.step.type].describe(e.step)}`); }
        else if (e.type === "say") say(`${cast[e.role]?.name || e.role}: “${e.text}”`, "line");
        else if (e.type === "refused") say(e.text, "warn");
        else if (e.type === "warning") say(e.text, "warn");
        else if (e.type === "error") say(e.text, "warn");
        else if (e.type === "done") { say("done", "good"); setRunning(false); setLiveStep(-1); }
        else if (e.type === "cancelled") { setRunning(false); setLiveStep(-1); }
      },
    });
    runRef.current = handle;
  }

  function stop() {
    runRef.current?.cancel();
    runRef.current = null;
    setRunning(false);
    setLiveStep(-1);
    say("stopped", "warn");
  }

  // ── saving ─────────────────────────────────────────────────────────────────
  async function save({ asNew = false } = {}) {
    const { errors } = normalizeSteps(steps);
    if (errors.length) { setSaveNote({ bad: true, text: errors[0] }); return; }
    const body = JSON.stringify({ name, description, steps, cameras, props, cast: script.cast });
    const url = scriptId && !asNew ? `/api/interaction-scripts/${scriptId}` : "/api/interaction-scripts";
    const r = await fetch(url, {
      method: scriptId && !asNew ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { setSaveNote({ bad: true, text: data.error || `save failed (${r.status})` }); return; }
    setScriptId(data.id);
    setDirty(false);
    setSaveNote({ bad: false, text: `saved as “${data.name}”` });
    setTimeout(() => setSaveNote(null), 3500);
    loadScripts();
  }

  function open(row) {
    setScriptId(row.id);
    setName(row.name);
    setDescription(row.description || "");
    setSteps(row.steps || []);
    // Scripts written before cameras had a track of their own carry them on the
    // steps; hoist those rather than letting the framing vanish on load.
    setCameras(hoistLegacyCameras(row.steps || [], row.cameras || []));
    setProps(row.props || []);
    rigRef.current?.setObstacles?.(row.props || []);
    setSelected(-1);
    setSelectedCam(-1);
    setDirty(false);
    // Put the same bodies back in the room the script was written for — and
    // EMPTY the roles it left empty. Built fresh rather than merged over
    // whoever is currently cast: the old version only ever SET roles that had
    // an actor, so a script saved with nobody in role b could never clear the
    // person standing there, and "just her, alone" was unsayable on load.
    const byId = Object.fromEntries(castList.map(p => [p.id, p]));
    const next = {};
    const dropped = [];
    ROLES.forEach(r => {
      const c = (row.cast || []).find(x => x.role === r);
      // A script can outlive its cast's eligibility: the body was castable when
      // the script was saved and is draft again now. Leaving the role empty is
      // right, but doing it silently would look like the script lost its cast,
      // so the run log says which body was dropped and why.
      const p = c?.actor_id ? byId[c.actor_id] : null;
      if (p && p.unavailable) dropped.push(`${p.name} (${p.unavailable})`);
      next[r] = p && !p.unavailable ? p : null;
    });
    setCast(next);
    dropped.forEach(d => say(`${d} — left out of the cast`, "warn"));
  }

  async function remove(row) {
    if (!window.confirm(`Delete “${row.name}”?`)) return;
    const r = await fetch(`/api/interaction-scripts/${row.id}`, { method: "DELETE", credentials: "include" });
    if (r.ok) {
      if (scriptId === row.id) { setScriptId(null); setDirty(true); }
      loadScripts();
    }
  }

  function newScript() {
    setScriptId(null);
    setName("Untitled interaction");
    setDescription("");
    setSteps([]);
    setDirty(false);
  }

  // ── step editing ───────────────────────────────────────────────────────────
  const edit = (i, patch) => { setSteps(s => s.map((x, n) => (n === i ? { ...x, ...patch } : x))); setDirty(true); };
  const addStep = (type) => {
    const step = defaultStep(type, "a");
    // A step should be VALID the moment it is added. `interaction` is the one
    // verb whose parameter cannot have a sensible constant default in the lib —
    // the lib deliberately knows nothing about which actions exist — so the
    // page fills it from the library it can see. Without this the row is born
    // failing validation and says so on every keystroke.
    if (type === "interaction" && !step.action) step.action = listActions("action")[0]?.slug || "";
    if (type === "reaction" && !step.action) step.action = listActions("reaction")[0]?.slug || "";
    setSteps(s => {
      // A reaction waits for the contact of the action before it — but it can
      // only hear that contact if the action is still RUNNING when this step
      // starts. A blocking action finishes first, contact is long past, and the
      // flinch arrives after the arm is back at rest. So adding a reaction
      // releases the action ahead of it rather than leaving you to discover the
      // checkbox that made it look broken.
      if (type === "reaction") {
        for (let i = s.length - 1; i >= 0; i--) {
          if (s[i].type === "interaction") {
            if (s[i].wait) s = s.map((x, n) => (n === i ? { ...x, wait: false } : x));
            break;
          }
        }
      }
      setSelected(s.length);
      return [...s, step];
    });
    setDirty(true);
  };

  const removeStep = (i) => { setSteps(s => s.filter((_, n) => n !== i)); setDirty(true); };
  const moveStep = (i, d) => {
    setSteps(s => {
      const n = i + d;
      if (n < 0 || n >= s.length) return s;
      const copy = [...s];
      [copy[i], copy[n]] = [copy[n], copy[i]];
      return copy;
    });
    setDirty(true);
  };

  // Standing where they stand right now, as a walk_to step. Authoring
  // coordinates by typing numbers into a box is guesswork; dragging the camera
  // round until it looks right and then pressing this is not.
  function captureMark(role) {
    const p = rigRef.current?.performer(role)?.position?.();
    if (!p) { say(`nobody is cast as ${role}`, "warn"); return; }
    setSteps(s => [...s, { ...defaultStep("walk_to", role), x: p.x, z: p.z }]);
    setDirty(true);
  }

  // ── the watcher ────────────────────────────────────────────────────────────
  //
  // The panel itself is mounted by LabWatcherOverlay above the router and bound
  // to this bench's own conversation. These buttons hand it the thing it cannot
  // see: the script as written, and where the bodies actually are.
  const askClaude = (text) =>
    window.dispatchEvent(new CustomEvent("watcher:ask", { detail: { text } }));

  // The same handle the encounter scene exposes as window.__door: a run can be
  // inspected and driven from CDP without clicking anything, which is how the
  // watcher tests a script end to end on its own.
  useEffect(() => {
    window.__studio = {
      get script() { return script; },
      get cast() { return cast; },
      get clips() { return clips; },
      state: () => rigRef.current?.state?.() || null,
      scripts: () => scripts,
      setSteps: (s) => { setSteps(s); setDirty(true); },
      run, stop,
      reset: () => rigRef.current?.reset?.(),
      // Furniture, so the watcher can prove the claim that matters about
      // positioning: the SAME step routes around what is in the room, and
      // routes differently when it is taken away.
      obstacles: () => rigRef.current?.obstacles?.() || [],
      poseAt: (role, slug, t) => rigRef.current?.poseAt?.(role, slug, t),
      camera: (spec) => rigRef.current?.camera?.(spec),
      cameraNow: () => rigRef.current?.cameraNow?.(),
      pickPoint: (fn) => rigRef.current?.pickPoint?.(fn),
      footInfo: (role) => rigRef.current?.footInfo?.(role),
      sitRest: (role) => rigRef.current?.sitRest?.(role),
      rayTest: (role) => rigRef.current?.rayTest?.(role),
      limbTest: (role, bone) => rigRef.current?.limbTest?.(role, bone),
      // Proxemics, on the debug handle as well as in the runner. Two
      // hand-assembled subsets of the same rig is two places to forget, and
      // this file has now forgotten each of them once.
      setSpace: (role, d) => rigRef.current?.setSpace?.(role, d),
      spaceOf: () => rigRef.current?.spaceOf?.(),
      bonePos: (role, canonical) => rigRef.current?.bonePos?.(role, canonical),
      poseBone: (role, canonical, rot) => rigRef.current?.poseBone?.(role, canonical, rot),
      setObstacles: (list) => rigRef.current?.setObstacles?.(list) || [],
      addProp: (type) => rigRef.current?.addProp?.(type),
      props: () => rigRef.current?.props?.() || [],
      clearProps: () => rigRef.current?.clearProps?.(),
    };
    return () => { delete window.__studio; };
  });

  // ── standing them where the step finds them ───────────────────────────────
  //
  // Selecting a step means "show me this moment", and a moment includes where
  // the two of them are. The timeline is an ESTIMATE — a walk resolves when the
  // feet arrive, not when arithmetic says so — but it is right about the thing
  // that matters here: after an approach they are a stride apart, not at their
  // opening marks. Without this, every contact pose is authored against a gap
  // the script never actually has.
  // ── showing a moment ──────────────────────────────────────────────────────
  //
  // Everything before time t is treated as already played: the bodies stand
  // where the script would have left them, and the camera is whichever cut is
  // in force then. Driven by TIME rather than by step index, because a cut can
  // now land partway through a step — scrubbing inside one step has to change
  // the shot, and keying off the selected step meant it could not.
  const frameAt = useCallback((t) => {
    const rig = rigRef.current;
    if (!rig?.place) return;
    const tl = estimateTimeline({ steps }, {
      marks: { a: { ...MARKS.a, facing: Math.PI / 2 }, b: { ...MARKS.b, facing: -Math.PI / 2 } },
      actionDuration: (slug) => getAction(slug)?.duration ?? 1,
      contactAt: (slug) => getAction(slug)?.contactAt ?? 0,
      propAt: (ref) => {
        const key = String(ref || "").toLowerCase();
        return props.find(o => String(o.id).toLowerCase() === key)
            || props.find(o => String(o.slot || "").toLowerCase() === key)
            || props.find(o => String(o.type || "").toLowerCase() === key)
            || null;
      },
    });
    if (!tl.blocks.length) return;

    let i = 0;
    tl.blocks.forEach((b, n) => { if (b.start <= t + 1e-6) i = n; });
    const at = positionsBefore(tl, i);
    if (at) { rig.place("a", at.a); rig.place("b", at.b); }

    // The cut in force at t. Its time is the anchor step's start plus its
    // offset — the same arithmetic the runner uses, so what you scrub to is
    // what will play.
    const cuts = hoistLegacyCameras(steps, cameras)
      .map(c => ({ ...c, at: (tl.blocks[c.step]?.start ?? 0) + (c.offset || 0) }))
      .filter(c => c.at <= t + 1e-6)
      .sort((x, y) => x.at - y.at);
    const cut = cuts[cuts.length - 1];
    if (cut) rig.camera?.(cut);
  }, [steps, cameras, props, rigReady]);

  // Selecting a step shows the moment it begins. THE SAME estimate the strip
  // draws and the same one frameAt uses — three different measurements of the
  // same walk would put the head, the block and the bodies in three places.
  const timelineOf = useCallback(() => estimateTimeline({ steps }, {
    marks: { a: { ...MARKS.a, facing: Math.PI / 2 }, b: { ...MARKS.b, facing: -Math.PI / 2 } },
    actionDuration: (slug) => getAction(slug)?.duration ?? 1,
    contactAt: (slug) => getAction(slug)?.contactAt ?? 0,
    propAt: (ref) => {
      const key = String(ref || "").toLowerCase();
      return props.find(o => String(o.id).toLowerCase() === key)
          || props.find(o => String(o.slot || "").toLowerCase() === key)
          || props.find(o => String(o.type || "").toLowerCase() === key)
          || null;
    },
  }), [steps, props]);

  useEffect(() => {
    if (!rigReady || running || selected < 0) return;
    frameAt(timelineOf().blocks[selected]?.start ?? 0);
  }, [selected, steps, cameras, props, rigReady, running, frameAt, timelineOf]);

  // Cross-step timing problems. Each step is individually valid, which is why
  // nothing else catches these.
  const warnings = useMemo(() => timingWarnings({ steps }), [steps]);

  // The scene ends placement on Escape or on the drop; the button has to stop
  // looking armed when that happens, or it lies about the mode you are in.
  useEffect(() => {
    if (!placing) return undefined;
    const clear = () => setPlacing(null);
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") clear(); });
    const t = setInterval(() => { if (!rigRef.current?.placingType?.()) clear(); }, 400);
    return () => { clearInterval(t); window.removeEventListener("keydown", clear); };
  }, [placing]);

  // Saved motions are loaded HERE, not in the editor. They were fetched by the
  // editor component, which only mounts when an interaction step is selected —
  // so a script that named a saved action played the built-in fallback, or
  // nothing, depending on whether anyone had happened to open the editor first.
  useEffect(() => {
    let dead = false;
    fetch("/api/body-interactions", { credentials: "include" })
      .then(r => (r.ok ? r.json() : []))
      .then(list => { if (!dead) registerActions(list); })
      .catch(() => {});
    return () => { dead = true; };
  }, []);

  // Clicking a prop in the ROOM selects it, so you can point at the thing you
  // mean rather than matching a list entry to a box by its coordinates.
  useEffect(() => {
    if (!rigReady) return undefined;
    const cv = document.querySelector("canvas");
    if (!cv) return undefined;
    const onDown = (e) => {
      if (placing) return;                    // placing owns the click
      const id = rigRef.current?.propAt?.(e.clientX, e.clientY);
      if (id) setSelectedProp(id);
    };
    cv.addEventListener("pointerdown", onDown);
    return () => cv.removeEventListener("pointerdown", onDown);
  }, [rigReady, placing]);

  const onRig = useCallback((rig) => {
    rigRef.current = rig;
    // Placement happens by pointing at the floor, inside the scene — so the
    // scene is the one that knows when the furniture changed, and says so.
    rig.onProps?.((list) => { setProps((list || []).filter(x => x.type)); setDirty(true); });
    setRigReady(true);
  }, []);
  const onStatus = useCallback(({ role, ready, clips: names, error }) => {
    setClips(c => ({ ...c, [role]: ready ? names : [] }));
    if (!ready && error) say(`${role}: ${error}`, "warn");
  }, [say]);

  return (
    <div style={{ minHeight: "100vh", background: PAPER, fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ maxWidth: 1500, margin: "0 auto", padding: "22px 26px 40px" }}>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <h1 style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 24, margin: 0, color: "#2f2c28" }}>
              Interaction studio
            </h1>
            <p style={{ fontSize: 12.5, color: "#8b8781", margin: "5px 0 0" }}>
              Two bodies in an empty room, lit as the encounter lights them. Script what they do, save it, run it.
            </p>
          </div>
          <a onClick={() => navigate("/home")} style={{ fontSize: 12, color: "#b05c08", cursor: "pointer" }}>← Home</a>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0,1fr) 260px", gap: 14, alignItems: "start" }}>

          {/* ── left: cast and shelf ─────────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={cardStyle}>
              <p style={labelStyle}>The two of them</p>
              {ROLES.map(role => (
                <div key={role} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 9,
                                   background: `#${ROLE_COLOR[role].toString(16).padStart(6, "0")}` }} />
                    <span style={{ fontSize: 11, color: "#55524e", textTransform: "uppercase", letterSpacing: ".1em" }}>
                      role {role}
                    </span>
                  </div>
                  <select
                    value={cast[role]?.id || ""}
                    onChange={e => {
                      const p = castList.find(x => x.id === e.target.value) || null;
                      setCast(c => ({ ...c, [role]: p }));
                    }}
                    style={{ width: "100%", fontSize: 12.5, padding: "6px 8px", borderRadius: 6,
                             border: "1px solid rgba(0,0,0,.12)", background: "#fff", color: "#2f2c28" }}>
                    <option value="">— nobody —</option>
                    {castList.map(p => (
                      <option key={p.id} value={p.id} disabled={!!p.unavailable}>
                        {p.name}{p.kind === "you" ? " (you)" : ""}{p.unavailable ? ` — ${p.unavailable}` : ""}
                      </option>
                    ))}
                  </select>
                  {clips[role]?.length > 0 && (
                    <p style={{ fontSize: 10.5, color: "#a8a5a0", margin: "5px 0 0" }}>
                      clips: {clips[role].join(", ")}
                    </p>
                  )}
                </div>
              ))}
              <p style={{ fontSize: 10.5, color: "#a8a5a0", margin: "8px 0 0", lineHeight: 1.5 }}>
                A role is a slot, not a person. An encounter casts its own actor as A and the player as B —
                the script does not care who stands in them.
              </p>
            </div>

            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <p style={labelStyle}>Saved scripts</p>
                <a onClick={newScript} style={{ fontSize: 11, color: "#b05c08", cursor: "pointer" }}>+ new</a>
              </div>
              {scripts.length === 0 && (
                <p style={{ fontSize: 11.5, color: "#a8a5a0", margin: 0 }}>Nothing saved yet.</p>
              )}
              {scripts.map(row => (
                <div key={row.id}
                     style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6,
                              padding: "6px 0", borderTop: "1px solid rgba(0,0,0,.05)" }}>
                  <div style={{ minWidth: 0, cursor: "pointer" }} onClick={() => open(row)}>
                    <p style={{ margin: 0, fontSize: 12.5, color: scriptId === row.id ? "#b05c08" : "#2f2c28",
                                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.name}
                    </p>
                    {/* The server computes `drives` from the stored steps, so
                        the shelf can say which of these an encounter could
                        actually play without opening each one. */}
                    <p style={{ margin: 0, fontSize: 10, color: "#a8a5a0" }}>
                      {row.steps?.length || 0} steps · {row.slug}
                      {(row.drives || []).some(r => !ENCOUNTER_DRIVES.includes(r)) && (
                        <span style={{ color: "#b05c08" }}> · studio only</span>
                      )}
                    </p>
                  </div>
                  <a onClick={() => remove(row)} style={{ fontSize: 11, color: "#c0bdb8", cursor: "pointer" }}>×</a>
                </div>
              ))}
            </div>
          </div>

          {/* ── middle: the room ─────────────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ ...cardStyle, padding: 0, overflow: "hidden", height: 560, position: "relative" }}>
              <InteractionStudioScene cast={cast} onRig={onRig} onStatus={onStatus} />
              <div style={{ position: "absolute", right: 12, top: 12, display: "flex", gap: 8, zIndex: 4 }}>
                <button style={{ ...btn(running ? "plain" : "primary") }} onClick={running ? stop : run}>
                  {running ? "Stop" : "▶ Run script"}
                </button>
                <button style={btn()} onClick={() => rigRef.current?.reset?.()}>Reset marks</button>
                <select
                  value=""
                  style={{ ...btn(placing ? "primary" : "plain"), width: 108 }}
                  title="Pick a prop, then click the floor to place it. R turns it, Escape cancels."
                  onChange={(e) => {
                    const type = e.target.value;
                    if (!type) return;
                    rigRef.current?.addProp?.(type);
                    setPlacing(type);
                    say(`placing a ${type} — click the floor, R turns it, Esc cancels`);
                  }}>
                  <option value="">+ Add prop</option>
                  {Object.entries(PROP_TYPES).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
                <button style={btn()} title="Remove every prop from the room"
                        onClick={() => {
                          rigRef.current?.clearProps?.();
                          setProps([]);
                          setDirty(true);
                          setPlacing(null);
                          say("scene cleared");
                        }}>Clear scene</button>
              </div>
            </div>

            {/* Always rendered. The add buttons are ON the tracks, so gating this
                on steps.length meant an empty script had no way to gain one. */}
            {true && (
              <InteractionTimeline
                steps={steps}
                selected={selected}
                liveStep={liveStep}
                running={running}
                onPlay={() => (running ? stop() : run())}
                onAddStep={(type) => addStep(type)}
                cameras={cameras}
                selectedCam={selectedCam}
                onSelectCam={(i) => { setSelectedCam(i); setSelected(-1); }}
                propList={props}
                onScrub={(t) => { if (!running) frameAt(t); }}
                onRemoveStep={(i) => { removeStep(i); setSelected(-1); }}
                onRemoveCamera={(i) => removeCam(i)}
                onMoveCamera={(i, anchor) => {
                  // Re-anchored, then re-sorted, and the selection follows the
                  // cut rather than the index — otherwise dragging one cut past
                  // another silently starts editing a different one.
                  setCameras(cs => {
                    const moving = cs[i];
                    if (!moving) return cs;
                    const moved = { ...moving, ...anchor };
                    const next = cs.map((c, n) => (n === i ? moved : c))
                      .sort((x, y) => (x.step - y.step) || (x.offset - y.offset));
                    // Identity by OBJECT, not by id — a cut may have no id yet,
                    // and two cuts can share a step and offset mid-drag.
                    setSelectedCam(next.indexOf(moved));
                    return next;
                  });
                  setDirty(true);
                }}
                onAddCamera={(anchor) => {
                  // Anchored to a STEP plus an offset, never to an absolute
                  // second: every duration on this strip is an estimate, so an
                  // absolute time drifts the moment a walk gets longer.
                  if (!steps.length) return say("add a step first — a cut is anchored to one", "warn");
                  // From the click position when the track was clicked; from the
                  // selected step when the + was pressed.
                  const at = anchor && Number.isFinite(anchor.step)
                    ? anchor
                    : { step: selected >= 0 ? selected : Math.max(0, steps.length - 1), offset: 0 };
                  const id = Math.random().toString(36).slice(2, 10);
                  setCameras(cs => {
                    const next = [...cs, { shot: "two_shot", of: "a", from: "b", distance: 0, height: 0, id, ...at }]
                      .sort((x, y) => (x.step - y.step) || (x.offset - y.offset));
                    setSelectedCam(next.findIndex(c => c.id === id));
                    return next;
                  });
                  setSelected(-1);
                  setDirty(true);
                }}
                marks={{ a: { ...MARKS.a, facing: Math.PI / 2 }, b: { ...MARKS.b, facing: -Math.PI / 2 } }}
                onSelect={setSelected}
              />
            )}

            {/* The selected block's settings, directly under the timeline —
                clicking a bar is how you get here, so this is where the eye
                already is. It renders the SAME row the steps list used to, so
                there is one editor for a step, not two that can disagree. */}
            {selectedCam >= 0 && cameras[selectedCam] && (
              <div style={cardStyle}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 12.5 }}>Camera</strong>
                  <select value={cameras[selectedCam].shot} style={inputStyle}
                          onChange={e => editCam(selectedCam, { shot: e.target.value })}>
                    <option value="two_shot">both of them</option>
                    <option value="over_shoulder">over the shoulder</option>
                    <option value="close">close on</option>
                    <option value="wide">wide</option>
                  </select>
                  {cameras[selectedCam].shot !== "wide" && (
                    <select value={cameras[selectedCam].of || "a"} style={inputStyle}
                            onChange={e => editCam(selectedCam, { of: e.target.value })}>
                      {ROLES.map(r => <option key={r} value={r}>on {r}</option>)}
                    </select>
                  )}
                  {cameras[selectedCam].shot === "over_shoulder" && (
                    <select value={cameras[selectedCam].from || "b"} style={inputStyle}
                            onChange={e => editCam(selectedCam, { from: e.target.value })}>
                      {ROLES.map(r => <option key={r} value={r}>over {r}</option>)}
                    </select>
                  )}
                  <label style={{ fontSize: 11, color: "#8b8781" }}>at step
                    <select value={cameras[selectedCam].step} style={{ ...inputStyle, marginLeft: 4 }}
                            onChange={e => editCam(selectedCam, { step: Number(e.target.value) })}>
                      {steps.map((st, i) => <option key={i} value={i}>{i + 1}. {STEP_TYPES[st.type]?.label || st.type}</option>)}
                    </select>
                  </label>
                  <label style={{ fontSize: 11, color: "#8b8781" }}>+ seconds
                    <input type="number" step="0.05" min="0" style={{ ...inputStyle, width: 66, marginLeft: 4 }}
                           value={cameras[selectedCam].offset ?? 0}
                           onChange={e => editCam(selectedCam, { offset: Number(e.target.value) })} />
                  </label>
                  <span style={{ flex: 1 }} />
                  <button style={btn()} onClick={() => rigRef.current?.camera?.(cameras[selectedCam])}>Look through it</button>
                  <button style={btn()} onClick={() => removeCam(selectedCam)}>Remove</button>
                </div>
                <p style={{ margin: "6px 0 0", fontSize: 10.5, color: "#a8a5a0" }}>
                  Anchored to the step, not to a clock time — the estimate moves, this does not.
                </p>
              </div>
            )}

            {steps[selected] && (
              <div style={cardStyle}>
                <StepRow step={steps[selected]} index={selected} live={liveStep === selected}
                         selected
                         onSelect={() => {}}
                         warning={warnings.find(w => w.index === selected)}
                         onFix={() => { const w = warnings.find(x => x.index === selected); if (w?.fix) edit(w.fix.index, w.fix.patch); }}
                         clips={clips[steps[selected].role] || []}
                         propList={props}
                         onPickPoint={() => {
                           say("click the floor to set the destination");
                           rigRef.current?.pickPoint?.((pt) => {
                             edit(selected, { x: +pt.x.toFixed(2), z: +pt.z.toFixed(2) });
                             say(`destination set to ${pt.x.toFixed(2)}, ${pt.z.toFixed(2)}`);
                           });
                         }}
                         onEdit={patch => edit(selected, patch)}
                         onRemove={() => { removeStep(selected); setSelected(-1); }}
                         onMove={d => moveStep(selected, d)} />
              </div>
            )}

            {rigReady && ["interaction", "reaction"].includes(steps[selected]?.type) && (
              <InteractionActionEditor
                key={steps[selected].id}
                rig={rigRef.current}
                stepIndex={selected}
                step={steps[selected]}
                onStepChange={patch => edit(selected, patch)}
                onSay={say}
                onPlay={(slug, forStep) => {
                  if (!slug) return say("give it a name first", "warn");
                  // Played through the REAL runner on a real step of the SAME
                  // TYPE as the one being edited — an editor whose play button
                  // takes a different path to the runner is an editor that can
                  // lie — but on a THROWAWAY script, so the sequence you are
                  // composing is left exactly as it was, standing where it is.
                  const role = forStep?.role || "a";
                  const one = forStep?.type === "reaction"
                    ? { id: "preview", type: "reaction", role, action: slug, delay: 0, wait: true }
                    : { id: "preview", type: "interaction", role,
                        target: forStep?.target || (role === "a" ? "b" : "a"), action: slug, wait: true };
                  run({ name: "preview", resetMarks: false, steps: [one] });
                }}
              />
            )}

            {rigReady && !["interaction", "reaction"].includes(steps[selected]?.type)
              && steps.some(x => ["interaction", "reaction"].includes(x.type)) && (
              <div style={{ ...cardStyle, fontSize: 11.5, color: "#8b8781" }}>
                Select a <strong>Body interaction</strong> or <strong>React</strong> step on the right to edit what it does.
              </div>
            )}

            <div style={{ ...cardStyle, minHeight: 96, maxHeight: 150, overflowY: "auto" }}>
              <p style={labelStyle}>Run log</p>
              {log.length === 0 && <p style={{ fontSize: 11.5, color: "#a8a5a0", margin: 0 }}>
                Nothing run yet. ▶ plays the steps on the two bodies above.
              </p>}
              {log.map((l, i) => (
                <p key={i} style={{ margin: "0 0 3px", fontSize: 11.5, lineHeight: 1.5,
                                    color: l.tone === "warn" ? "#d85a30" : l.tone === "good" ? "#1d9e75"
                                         : l.tone === "line" ? "#2f2c28" : "#8b8781" }}>
                  {l.text}
                </p>
              ))}
            </div>
          </div>

          {/* ── right: the script ────────────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={cardStyle}>
              <p style={labelStyle}>This script</p>
              <input value={name} onChange={e => { setName(e.target.value); setDirty(true); }}
                     style={{ width: "100%", fontSize: 14, padding: "6px 8px", marginBottom: 6,
                              border: "1px solid rgba(0,0,0,.12)", borderRadius: 6, color: "#2f2c28" }} />
              <input value={description} placeholder="what it is for"
                     onChange={e => { setDescription(e.target.value); setDirty(true); }}
                     style={{ width: "100%", fontSize: 11.5, padding: "5px 8px",
                              border: "1px solid rgba(0,0,0,.12)", borderRadius: 6, color: "#55524e" }} />
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <button style={btn("primary")} onClick={() => save()}>
                  {scriptId ? "Save" : "Save script"}
                </button>
                {scriptId && <button style={btn()} onClick={() => save({ asNew: true })}>Save as new</button>}
                {dirty && <span style={{ fontSize: 10.5, color: "#a8a5a0", alignSelf: "center" }}>unsaved changes</span>}
              </div>
              {saveNote && (
                <p style={{ margin: "8px 0 0", fontSize: 11.5, color: saveNote.bad ? "#d85a30" : "#1d9e75" }}>
                  {saveNote.text}
                </p>
              )}

              {/* Where this script can actually play. An encounter's rig owns
                  her and nothing else — the other role is a living player in
                  first person — so a step acting AS "b" makes the script a
                  studio rehearsal and no longer something her door can run. */}
              {steps.length > 0 && (
                <div style={{ marginTop: 10, paddingTop: 9, borderTop: "1px solid rgba(0,0,0,.06)" }}>
                  <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5,
                              color: studioOnly.length ? "#b05c08" : "#1d9e75" }}>
                    {studioOnly.length
                      ? `Studio only — this drives role ${studioOnly.join(" and ")}.`
                      : "Plays in an encounter — it only drives role a."}
                  </p>
                  {studioOnly.length > 0 && (
                    <p style={{ margin: "3px 0 0", fontSize: 10.5, color: "#a8a5a0", lineHeight: 1.5 }}>
                      In an encounter that role is the player: first person, pointer-locked. Driving it would
                      take their camera away, so the runner refuses the whole script rather than performing
                      part of it. Rehearse it here; make it portable by acting only as a.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div style={cardStyle}>
              <p style={labelStyle}>The room</p>
              {props.length === 0 && (
                <p style={{ fontSize: 11.5, color: "#a8a5a0", margin: 0 }}>
                  Bare. Add a prop above, then click the floor to put it down — R turns it, Esc cancels.
                </p>
              )}
              {props.map((pr) => (
                <div key={pr.id}
                     onClick={() => { setSelectedProp(pr.id); rigRef.current?.highlightProp?.(pr.id); }}
                     style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 0",
                              borderTop: "1px solid rgba(0,0,0,.05)", cursor: "pointer",
                              color: selectedProp === pr.id ? "#b05c08" : "#2f2c28" }}>
                  <span style={{ fontSize: 12.5, flex: 1 }}>
                    {PROP_TYPES[pr.type]?.label || pr.type}
                    <span style={{ fontSize: 10.5, color: "#a8a5a0", marginLeft: 6 }}>
                      {pr.x.toFixed(1)}, {pr.z.toFixed(1)}
                    </span>
                  </span>
                  <a title="Turn it 15° (hold shift for a quarter)"
                     onClick={(e) => { e.stopPropagation(); turnProp(pr.id, e.shiftKey ? Math.PI / 2 : Math.PI / 12); }}
                     style={{ cursor: "pointer", color: "#c0bdb8", fontSize: 12 }}>&#8635;</a>
                  <a title="Remove it"
                     onClick={(e) => { e.stopPropagation(); removeProp(pr.id); }}
                     style={{ cursor: "pointer", color: "#c0bdb8", fontSize: 12 }}>&times;</a>
                </div>
              ))}
              {selectedProp && props.some(x => x.id === selectedProp) && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 6,
                              borderTop: "1px solid rgba(0,0,0,.05)" }}>
                  <span style={{ fontSize: 10.5, color: "#8b8781" }}>angle</span>
                  <input type="range" min={0} max={359} step={1} style={{ flex: 1 }}
                         value={Math.round(yawOf(props.find(x => x.id === selectedProp)) / DEG)}
                         onChange={(e) => setYaw(selectedProp, Number(e.target.value))} />
                  <span style={{ fontSize: 10.5, width: 32, textAlign: "right" }}>
                    {Math.round(yawOf(props.find(x => x.id === selectedProp)) / DEG)}°
                  </span>
                </div>
              )}
              <p style={{ margin: "8px 0 0", fontSize: 10.5, color: "#a8a5a0", lineHeight: 1.5 }}>
                Rehearsal furniture. Saved with the script as a stand-in — a real
                room supplies the real pieces later, and what the script depends
                on is that something was in the way, not where it stood.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// One step. Every type renders from the same row so the list reads as one
// thing — the fields change, the shape does not.
// Every field name the row below knows how to draw. Deliberately a LIST to
// maintain rather than something inferred from the JSX: a list you must update
// is a list that can be compared against, and the comparison is the point.
//
// STEP_TYPES promises that a verb cannot be half-added — the server validates
// from it, the runner dispatches from it, the palette renders from it. The one
// half that does NOT follow automatically is this row, because it is a
// hand-written chain and not generated. `interaction` was added to the table,
// got its palette button for free, and then could not be given an action at
// all: it validated as "no body interaction chosen" forever with nothing in the
// row to choose one. This catches that the moment a verb is added instead of
// four error messages later.
const RENDERABLE_FIELDS = new Set([
  "on",
  "role", "target", "clip", "loop", "action",
  "x", "z", "distance", "speed", "fade", "seconds", "delay", "height", "text", "prop",
]);

function StepRow({ step, index, live, selected, onSelect, warning, onFix, clips, propList, onPickPoint,
                   onEdit, onRemove, onMove }) {
  const def = STEP_TYPES[step.type];
  const fields = def?.fields || [];
  const unrendered = fields.filter(f => !RENDERABLE_FIELDS.has(f));
  const cell = { fontSize: 11.5, padding: "3px 6px", borderRadius: 5,
                 border: "1px solid rgba(0,0,0,.12)", color: "#2f2c28", background: "#fff" };

  return (
    <div onClick={onSelect}
         style={{ border: `1px solid ${live ? "rgba(201,151,58,.55)" : selected ? "#b45309" : "rgba(0,0,0,.07)"}`,
                  borderLeft: selected ? "3px solid #b45309" : undefined,
                  background: live ? "rgba(201,151,58,.06)" : selected ? "#fff8f0" : "#fdfcfb",
                  borderRadius: 8, padding: "8px 9px", marginBottom: 6, cursor: "pointer" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 10.5, color: selected ? "#b05c08" : "#8b8781", fontWeight: selected ? 600 : 400 }}>
          {index + 1}. {def?.label || step.type}{selected ? "  · editing" : ""}
        </span>
        <span style={{ display: "flex", gap: 6 }}>
          <a onClick={() => onMove(-1)} style={{ cursor: "pointer", color: "#c0bdb8", fontSize: 11 }}>↑</a>
          <a onClick={() => onMove(1)}  style={{ cursor: "pointer", color: "#c0bdb8", fontSize: 11 }}>↓</a>
          <a onClick={onRemove}         style={{ cursor: "pointer", color: "#c0bdb8", fontSize: 11 }}>×</a>
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {fields.includes("role") && (
          <select value={step.role || "a"} onChange={e => onEdit({ role: e.target.value })} style={cell}>
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
        {fields.includes("target") && (
          <select value={step.target || "b"} onChange={e => onEdit({ target: e.target.value })} style={cell}>
            {ROLES.map(r => <option key={r} value={r}>→ {r}</option>)}
          </select>
        )}
        {fields.includes("clip") && (
          clips.length > 0 ? (
            <select value={step.clip || ""} onChange={e => onEdit({ clip: e.target.value })} style={cell}>
              {!clips.includes(step.clip) && <option value={step.clip || ""}>{step.clip || "—"}</option>}
              {clips.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            // No body cast in that role yet, so no clip list to offer. A free
            // text box is right here rather than an empty dropdown: a script
            // can be written before the models are in the room.
            <input value={step.clip || ""} placeholder="clip"
                   onChange={e => onEdit({ clip: e.target.value })} style={{ ...cell, width: 90 }} />
          )
        )}
        {/* Framing, on every step. "keep previous" is the default because a
            shot usually holds across several beats — forcing a choice on each
            one produces six copies of the same answer and three that drifted. */}
        <span style={{ display: "flex", width: "100%", gap: 5, alignItems: "center",
                       marginTop: 6, paddingTop: 6, borderTop: "1px dashed rgba(0,0,0,.08)" }}>
          <span style={{ fontSize: 10, color: "#a8a5a0", textTransform: "uppercase", letterSpacing: ".05em" }}>camera</span>
          <select value={step.camera?.shot || ""} style={{ ...cell, fontSize: 11 }}
                  onClick={e => e.stopPropagation()}
                  onChange={e => {
                    const v = e.target.value;
                    if (!v) return onEdit({ camera: undefined });
                    onEdit({ camera: { shot: v, of: step.camera?.of || "a",
                                       from: step.camera?.from || "b",
                                       distance: step.camera?.distance || 0,
                                       height: step.camera?.height || 0 } });
                  }}>
            <option value="">keep previous</option>
            <option value="two_shot">both of them</option>
            <option value="over_shoulder">over the shoulder</option>
            <option value="close">close on</option>
            <option value="wide">wide</option>
          </select>
          {step.camera && step.camera.shot !== "wide" && (
            <select value={step.camera.of || "a"} style={{ ...cell, fontSize: 11 }}
                    onClick={e => e.stopPropagation()}
                    onChange={e => onEdit({ camera: { ...step.camera, of: e.target.value } })}>
              {ROLES.map(r => <option key={r} value={r}>on {r}</option>)}
            </select>
          )}
          {step.camera?.shot === "over_shoulder" && (
            <select value={step.camera.from || "b"} style={{ ...cell, fontSize: 11 }}
                    onClick={e => e.stopPropagation()}
                    onChange={e => onEdit({ camera: { ...step.camera, from: e.target.value } })}>
              {ROLES.map(r => <option key={r} value={r}>over {r}</option>)}
            </select>
          )}
        </span>
        {warning && (
          <span style={{ display: "block", width: "100%", fontSize: 10.5, color: "#b05c08",
                         marginTop: 5, lineHeight: 1.45 }}>
            ⚠ {warning.text}
            {warning.fix && (
              <a onClick={(e) => { e.stopPropagation(); onFix(); }}
                 style={{ marginLeft: 6, cursor: "pointer", textDecoration: "underline" }}>fix it</a>
            )}
          </span>
        )}
        {unrendered.length > 0 && (
          <span title="This step type declares a field this editor cannot draw, so the step can never be completed here. Add it to StepRow and to RENDERABLE_FIELDS."
                style={{ fontSize: 11, color: "#c2410c", background: "#fff3ed",
                         border: "1px solid #fdba74", borderRadius: 4, padding: "2px 6px" }}>
            ⚠ no editor for: {unrendered.join(", ")}
          </span>
        )}
        {fields.includes("action") && (
          // The palette button for this verb comes free from STEP_TYPES, so
          // WITHOUT this field the step could be added and never made valid —
          // it validated as "no body interaction chosen" forever with nothing
          // in the row to choose one. Shipped exactly that way once.
          <select value={step.action || ""} onChange={e => onEdit({ action: e.target.value })} style={cell}>
            <option value="">— pick one —</option>
            {/* Filtered by the step's own kind. An unfiltered list let a React
                step name an ACTION — which validates, plays, and poses nothing,
                because the tracks belong to a body that is not in this step. */}
            {listActions(step.type === "reaction" ? "reaction" : "action")
              .map(a => <option key={a.slug} value={a.slug}>{a.name}</option>)}
          </select>
        )}
        {fields.includes("on") && (
          <select value={step.on || "contact"} onChange={e => onEdit({ on: e.target.value })} style={cell}>
            <option value="contact">on contact</option>
            <option value="delay">after a delay</option>
          </select>
        )}
        {fields.includes("loop") && (
          <label style={{ fontSize: 11, color: "#8b8781", display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={!!step.loop} onChange={e => onEdit({ loop: e.target.checked })} />
            loop
          </label>
        )}
        {["x", "z", "distance", "speed", "fade", "seconds", "delay", "height"].filter(f => fields.includes(f)).map(f => (
          <label key={f} style={{ fontSize: 10.5, color: "#8b8781", display: "flex", gap: 3, alignItems: "center" }}>
            {f}
            <input type="number" step="0.05" value={step[f] ?? 0}
                   onChange={e => onEdit({ [f]: Number(e.target.value) })}
                   style={{ ...cell, width: 62 }} />
          </label>
        ))}
        {fields.includes("prop") && (
          <select value={step.prop || ""} onChange={e => onEdit({ prop: e.target.value })} style={cell}>
            <option value="">— which prop —</option>
            {(propList || []).map(pr => (
              <option key={pr.id} value={pr.id}>
                {PROP_TYPES[pr.type]?.label || pr.type} ({pr.x.toFixed(1)}, {pr.z.toFixed(1)})
              </option>
            ))}
            {/* By TYPE as well as by that particular one: "the table" survives a
                room being rearranged, or being a different room entirely. */}
            {Object.entries(PROP_TYPES).map(([k, v]) => (
              <option key={"type-" + k} value={k}>any {v.label.toLowerCase()}</option>
            ))}
          </select>
        )}
        {step.type === "walk_to" && (
          <a title="Point at the floor to set this"
             onClick={(e) => { e.stopPropagation(); onPickPoint?.(); }}
             style={{ fontSize: 10.5, color: "#b05c08", cursor: "pointer", textDecoration: "underline" }}>
            pick in room
          </a>
        )}
        {fields.includes("text") && (
          <input value={step.text || ""} placeholder="what they say"
                 onChange={e => onEdit({ text: e.target.value })}
                 style={{ ...cell, flex: "1 1 160px", minWidth: 120 }} />
        )}
        {step.type !== "wait" && (
          <label style={{ fontSize: 10.5, color: "#8b8781", display: "flex", gap: 4, alignItems: "center" }}
                 title="Unticked, the next step starts on top of this one — that is how a walk and a line happen together.">
            <input type="checkbox" checked={step.wait !== false} onChange={e => onEdit({ wait: e.target.checked })} />
            finish before next
          </label>
        )}
      </div>
    </div>
  );
}
