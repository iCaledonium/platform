import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import InteractionStudioScene, { MARKS, marksFor, colorFor, PROP_TYPES } from "./InteractionStudioScene.jsx";
import { listActions } from "../lib/bodyActions.js";
import InteractionActionEditor from "./InteractionActionEditor.jsx";
import InteractionTimeline from "./InteractionTimeline.jsx";
import { estimateTimeline, positionsBefore } from "../lib/interactionScript.js";
import { getAction, registerActions, paramsFor } from "../lib/bodyActions.js";
import {
  ENTRY_KINDS, defaultEntry, describeEntry, describeScript, normalizeEntries, runScript,
  drivenRoles, timingWarnings, castIds, entryId,
  SHOTS, describeCamera, cameraAt, normalizeCameras,
} from "../lib/interactionScript.js";

// What an ENCOUNTER's rig will own. Role "b" there is the player: first person,
// pointer-locked, a human being. The studio owns both figures because both are
// its own puppets, so a script can drive "b" here and rehearse beautifully and
// then be unplayable at her door. That is exactly the trap worth closing at
// AUTHOR time — the verdict is rendered next to the name, before it is saved,
// rather than discovered as somebody's camera being taken away mid-scene.
const ENCOUNTER_DRIVES = ["a"];

// The four things the library holds. Three are movements a character performs;
// the fourth is an arrangement of them. A drawn glyph per kind rather than a
// rendered thumbnail — it is always available, costs no capture and no storage,
// and the name carries the specifics.
const KIND_GLYPH = {
  action:   { mark: "▶", tint: "#b05c08", label: "Action" },
  reaction: { mark: "↩", tint: "#7f77dd", label: "Reaction" },
  pose:     { mark: "◆", tint: "#1d9e75", label: "Pose" },
  composition: { mark: "❏", tint: "#378add", label: "Composition" },
};

// Slot ids, handed out in order as characters are added.
const SLOT_IDS = ["a", "b", "c", "d", "e", "f", "g", "h"];

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
  // What the picker on the toolbar currently has selected, before Add.
  const [toAdd, setToAdd]       = useState("");
  // An ORDERED list of slots, and who stands in each. It used to be the literal
  // pair {a, b}, which is the reason nothing could rehearse three people.
  const [slots, setSlots]       = useState(["a", "b"]);
  const [cast, setCast]         = useState({});
  const [clips, setClips]       = useState({});

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
  // POSE ANIMATION EDITOR mode (Magnus, 2026-09-12: "too confusing to have
  // all on the same page"). Full-screen over the SAME canvas and rig - a
  // second scene would preview a different runtime than the one that plays
  // the script. null | { step } where step is a scratch reaction step never
  // added to the script.

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
        // No preloaded actors (Magnus, 2026-09-12): the studio opens as an
        // untitled scene with an EMPTY room — nobody in either role until a
        // script is loaded or a body is picked. (The earlier "a room with
        // people in it is a bench" default kept surprising him instead.)
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
              cast: slots.map(id => ({ id, role: id, actor_id: cast[id]?.id || null,
                                       label: cast[id]?.name || null, driven: true })) }),
    [name, description, steps, cameras, props, cast]
  );

  // Recomputed as you type, because a verdict that only appears on save is a
  // verdict that arrives after the thinking is done.
  const drives = useMemo(() => drivenRoles({ steps }), [steps]);
  const studioOnly = drives.filter(r => !ENCOUNTER_DRIVES.includes(r));

  // Click a library item to put it on the timeline. The entry arrives with the
  // library's own declared parameters at their defaults — this function knows
  // nothing about what any of them mean, which is what lets a new action be
  // authored without touching the page.
  function addEntry(ref) {
    const def = getAction(ref);
    if (!def) { say(`“${ref}” is not in the library`, "warn"); return; }
    const role = slots.find(id => cast[id]) || slots[0] || "a";
    const entry = defaultEntry(ref, role);
    // An entry that aims needs somebody to aim at; default to the next slot
    // that has a body in it rather than leaving it blank.
    if (entry.params && "target" in entry.params) {
      entry.params.target = slots.find(id => id !== role && cast[id]) || slots.find(id => id !== role) || role;
    }
    setSteps(s => [...s, entry]);
    setDirty(true);
    setSelected(steps.length);
  }

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
    const { errors } = normalizeEntries(scriptToRun.steps, { cast: slots });
    if (errors.length) { say(errors.join("; "), "warn"); return; }

    setLog([]);
    setRunning(true);
    // A whole script starts from the marks: it is the scene from the top.
    // A PREVIEW does not — it answers "what does this look like from here",
    // and resetting first would send them back across the room and answer a
    // different question than the one asked. You selected step 3 to stand them
    // where step 3 finds them; playing the step must not undo that.
    if (scriptToRun.resetMarks !== false) {
      rig.reset();
      // The scene from the top includes the FURNITURE: a pull_prop moved the
      // chair on the rig's map last run, and without this the next run
      // starts from the moved room instead of the authored one.
      rig.setObstacles?.(props);
    }
    const handle = runScript(scriptToRun, {
      // The studio owns both figures, and says so. An encounter's rig will
      // declare ["a"] and the runner will refuse anything that drives the
      // player rather than performing three quarters of it.
      // The studio owns every body in the room and says so explicitly.
      drives: slots,
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
        if (e.type === "step") { setLiveStep(e.index); say(`${e.index + 1}. ${describeEntry(e.step, id => cast[id]?.name || id)}`); }
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
    const { errors } = normalizeEntries(steps, { cast: slots });
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
    setCameras(row.cameras || []);
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
    (row.cast || []).map(c => c.id || c.role).filter(Boolean).forEach(r => {
      // A slot is identified by `id`. It was `role` before the cast became a
      // list, and stored rows carry either — matching on only one of them
      // silently emptied every slot on load.
      const c = (row.cast || []).find(x => (x.id || x.role) === r);
      // A script can outlive its cast's eligibility: the body was castable when
      // the script was saved and is draft again now. Leaving the role empty is
      // right, but doing it silently would look like the script lost its cast,
      // so the run log says which body was dropped and why.
      const p = c?.actor_id ? byId[c.actor_id] : null;
      if (p && p.unavailable) dropped.push(`${p.name} (${p.unavailable})`);
      next[r] = p && !p.unavailable ? p : null;
    });
    setCast(next);
    // The composition carries its own slot list, so opening one with three
    // characters puts three slots on the toolbar. Without this the cast map
    // gained a third body that no control could reach.
    const ids = (row.cast || []).map(c => c.id || c.role).filter(Boolean);
    setSlots(ids.length ? ids : ["a", "b"]);
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
  const addStep = (type, role) => {
    // Which body performs it is decided by WHERE it was added — the + on a
    // character's own row — rather than defaulting to the first slot and
    // waiting to be corrected.
    const step = defaultEntry(type, role || slots[0] || "a");
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
    setSteps(s => [...s, { ...defaultEntry("walk-to", role), params: { x: p.x, z: p.z, speed: 0.95 } }]);
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
      skinInfo: (role) => rigRef.current?.skinInfo?.(role),
      morphs: (role) => rigRef.current?.morphs?.(role),
      setMorph: (role, name, v) => rigRef.current?.setMorph?.(role, name, v),
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
    const cuts = (cameras || [])
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
              Bodies in an empty room, lit as the encounter lights them. Script what they do, save it, run it.
            </p>
          </div>
          <a onClick={() => navigate("/home")} style={{ fontSize: 12, color: "#b05c08", cursor: "pointer" }}>← Home</a>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0,1fr) 260px", gap: 14, alignItems: "start" }}>

          {/* ── left: the library ────────────────────────────────────────── */}
          {/*
              Four kinds and nothing else. Actions, Reactions and Poses are
              things ONE character does — click one to put it on the timeline.
              Compositions are arrangements of those across the cast; click one
              to open it. This replaces the old "Saved scripts" list, which was
              the only library surface the studio had: authored motions were
              reachable only as <option>s buried inside a step.
          */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <p style={labelStyle}>Library</p>
              </div>

              {["action", "reaction", "pose"].map(kind => {
                const items = listActions(kind);
                return (
                  <div key={kind} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <p style={{ ...labelStyle, margin: "0 0 5px", color: KIND_GLYPH[kind].tint }}>
                        {KIND_GLYPH[kind].label}{items.length ? ` · ${items.length}` : ""}
                      </p>
                      {/* Authoring one of these is the Animation Editor's whole
                          job, so new hands over to it with the kind already
                          chosen. Choosing it here rather than there is the
                          point: a kind picked on purpose is how the Reaction
                          library stops filling with things nobody reacts to. */}
                      <a onClick={() => {
                           // Only an action can be anchored to furniture. A pose
                           // is a shape and a reaction happens to a body wherever
                           // that body is standing, so neither is asked.
                           if (kind !== "action") return navigate(`/lab/studio/animation?kind=${kind}`);
                           const room = window.confirm(
                             "Is this a ROOM action?\n\n" +
                             "OK — it happens at a piece of furniture: leaning on a table, perching on a sofa arm. " +
                             "The room puts them in front of it.\n\n" +
                             "Cancel — it is a human action: body motion that happens wherever they stand.");
                           navigate(`/lab/studio/animation?kind=action${room ? "&room=1" : ""}`);
                         }}
                         title={`Author a new ${KIND_GLYPH[kind].label.toLowerCase()}`}
                         style={{ fontSize: 10.5, color: "#b05c08", cursor: "pointer" }}>+ new</a>
                    </div>
                    {items.length === 0 && (
                      <p style={{ fontSize: 11, color: "#a8a5a0", margin: 0 }}>none yet</p>
                    )}
                    {items.map(it => (
                      <div key={it.slug}
                           title={it.source === "engine"
                             ? "Built into the room — walking, sitting, speaking"
                             : "Authored from bone tracks"}
                           onClick={() => addEntry(it.slug)}
                           style={{ display: "flex", alignItems: "center", gap: 7, padding: "3px 0",
                                    cursor: "pointer" }}>
                        <span style={{ color: KIND_GLYPH[kind].tint, fontSize: 11, width: 12 }}>
                          {KIND_GLYPH[kind].mark}
                        </span>
                        <span style={{ fontSize: 12, color: "#2f2c28", overflow: "hidden",
                                       textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {it.name}
                        </span>
                        {it.room && (
                          <span style={{ fontSize: 9, color: "#c0bdb8" }}>room</span>
                        )}
                        {it.source === "engine" ? (
                          <span style={{ fontSize: 9, color: "#c0bdb8", marginLeft: "auto" }} />
                        ) : (
                          // Engine entries have no pencil because there are no
                          // bones to move: walking and sitting are room
                          // geometry, not an authored motion.
                          <a title={`Edit ${it.name} in the Animation editor`}
                             onClick={(ev) => {
                               ev.stopPropagation();
                               navigate(`/lab/studio/animation?ref=${encodeURIComponent(it.slug)}&kind=${kind}`);
                             }}
                             style={{ fontSize: 10, color: "#c0bdb8", cursor: "pointer", marginLeft: "auto" }}>✎</a>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <p style={{ ...labelStyle, margin: "0 0 5px", color: KIND_GLYPH.composition.tint }}>
                    {KIND_GLYPH.composition.label}{scripts.length ? ` · ${scripts.length}` : ""}
                  </p>
                  {/* A composition is arranged HERE, so this one stays on the
                      page: it clears the timeline rather than navigating. */}
                  <a onClick={newScript} title="Start an empty composition"
                     style={{ fontSize: 10.5, color: "#b05c08", cursor: "pointer" }}>+ new</a>
                </div>
                {scripts.length === 0 && (
                  <p style={{ fontSize: 11, color: "#a8a5a0", margin: 0 }}>none yet</p>
                )}
                {scripts.map(row => (
                  <div key={row.id}
                       style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                                gap: 6, padding: "3px 0" }}>
                    <div style={{ minWidth: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 7 }}
                         onClick={() => open(row)}>
                      <span style={{ color: KIND_GLYPH.composition.tint, fontSize: 11, width: 12 }}>
                        {KIND_GLYPH.composition.mark}
                      </span>
                      <span style={{ fontSize: 12, color: scriptId === row.id ? "#b05c08" : "#2f2c28",
                                     overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.name}
                      </span>
                      {/* `drives` is computed server-side from the entries, so
                          the shelf can say which of these an encounter could
                          actually play without opening each one. */}
                      {(row.drives || []).some(r => !ENCOUNTER_DRIVES.includes(r)) && (
                        <span style={{ fontSize: 9, color: "#b05c08" }}>studio only</span>
                      )}
                    </div>
                    <a onClick={() => remove(row)}
                       style={{ fontSize: 11, color: "#c0bdb8", cursor: "pointer" }}>×</a>
                  </div>
                ))}
              </div>
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
                <button style={btn()} onClick={() => { rigRef.current?.reset?.(); rigRef.current?.setObstacles?.(props); }}>Reset marks</button>
                {/* Adding a character is one picker and one button, the same
                    shape as adding a prop. Who is actually in the room is shown
                    in "The room" on the right — a row of selects on the toolbar
                    was the cast list and the cast control at once, and did
                    neither job well. */}
                <select value={toAdd} style={{ ...btn(), width: 150 }}
                        title="Choose a character to put in the room"
                        onChange={e => setToAdd(e.target.value)}>
                  <option value="">— character —</option>
                  {castList.map(x => (
                    <option key={x.id} value={x.id} disabled={!!x.unavailable}>
                      {x.name}{x.kind === "you" ? " (you)" : ""}{x.unavailable ? ` — ${x.unavailable}` : ""}
                    </option>
                  ))}
                </select>
                <button style={btn(toAdd ? "primary" : "plain")}
                        disabled={!toAdd || slots.length >= SLOT_IDS.length}
                        title="Put them in the room"
                        onClick={() => {
                          const who = castList.find(x => x.id === toAdd);
                          if (!who) return;
                          // Reuse an empty slot before opening a new one, so
                          // adding after a removal does not walk the alphabet.
                          const free = slots.find(id => !cast[id]) ||
                                       SLOT_IDS.find(id => !slots.includes(id));
                          if (!free) return;
                          if (!slots.includes(free)) setSlots(s => [...s, free]);
                          setCast(c => ({ ...c, [free]: who }));
                          setToAdd("");
                          setDirty(true);
                          say(`${who.name} is in the room`);
                        }}>+ Add</button>
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
                <button style={btn()} title="Empty the room and start over: props, actors, timeline, script name"
                        onClick={() => {
                          // Clear scene = back to the studio's default state
                          // (Magnus, 2026-09-12): empty timeline, untitled
                          // script, no props, both roles nobody — not just a
                          // prop sweep.
                          rigRef.current?.clearProps?.();
                          setProps([]);
                          setPlacing(null);
                          setSelectedProp(null);
                          setSlots(["a", "b"]);
                          setCast({});
                          setSteps([]);
                          setSelected(-1);
                          setSelectedCam(-1);
                          setScriptId(null);
                          setName("Untitled interaction");
                          setDescription("");
                          setDirty(false);
                          say("scene cleared — untitled, empty room");
                        }}>Clear scene</button>
              </div>
            </div>

            {/* Always rendered. The add buttons are ON the tracks, so gating this
                on steps.length meant an empty script had no way to gain one. */}
            {/* Who has a row, in cast order, with the colour their ring wears in
                the room — so a bar on the timeline and a body on the floor are
                recognisably the same person. An empty slot still gets a row:
                that is where you put their first entry. */}
            <InteractionTimeline
                steps={steps}
                cast={slots}
                roster={slots.map((id, i) => ({
                  id,
                  name: cast[id]?.name || `slot ${id}`,
                  color: `#${colorFor(id, i).toString(16).padStart(6, "0")}`,
                }))}
                selected={selected}
                liveStep={liveStep}
                running={running}
                onPlay={() => (running ? stop() : run())}
                onAddStep={(type) => addStep(type)}
                onAddTo={(ref, role) => addStep(ref, role)}
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
                      {slots.map(r => <option key={r} value={r}>on {r}</option>)}
                    </select>
                  )}
                  {cameras[selectedCam].shot === "over_shoulder" && (
                    <select value={cameras[selectedCam].from || "b"} style={inputStyle}
                            onChange={e => editCam(selectedCam, { from: e.target.value })}>
                      {slots.map(r => <option key={r} value={r}>over {r}</option>)}
                    </select>
                  )}
                  <label style={{ fontSize: 11, color: "#8b8781" }}>at step
                    <select value={cameras[selectedCam].step} style={{ ...inputStyle, marginLeft: 4 }}
                            onChange={e => editCam(selectedCam, { step: Number(e.target.value) })}>
                      {steps.map((st, i) => <option key={i} value={i}>{i + 1}. {getAction(st.ref)?.name || st.ref}</option>)}
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
                <StepRow slots={slots} cast={cast} step={steps[selected]} index={selected} live={liveStep === selected}
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
                         onMove={d => moveStep(selected, d)}
                         onOpenPoseLab={(st) => navigate(`/lab/studio/animation?ref=${encodeURIComponent(st?.ref || "")}&kind=${encodeURIComponent(st?.kind || "pose")}`)} />
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

              {/* The cast, where you can see it while you author. Each one is a
                  SLOT — the composition refers to "a", and an encounter casts
                  whoever it likes into it. */}
              {slots.filter(id => cast[id]).length === 0 && (
                <p style={{ fontSize: 11.5, color: "#a8a5a0", margin: "0 0 9px" }}>
                  Nobody in it yet. Pick a character above and press Add.
                </p>
              )}
              {slots.filter(id => cast[id]).map((id, i) => (
                <div key={id} style={{ display: "flex", alignItems: "center", gap: 7,
                                       padding: "4px 0", borderBottom: "1px solid rgba(0,0,0,.05)" }}>
                  <span style={{ width: 9, height: 9, borderRadius: 9, flex: "0 0 auto",
                                 background: `#${colorFor(id, slots.indexOf(id)).toString(16).padStart(6, "0")}` }} />
                  <span style={{ fontSize: 12.5, color: "#2f2c28", flex: 1, overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {cast[id].name}
                  </span>
                  <span style={{ fontSize: 10, color: "#a8a5a0", letterSpacing: ".1em" }}>slot {id}</span>
                  <a title="Take them out of the room"
                     onClick={() => {
                       setSlots(s => s.filter(x => x !== id));
                       setCast(c => { const n = { ...c }; delete n[id]; return n; });
                       // Entries that acted as this slot have nobody to act them.
                       setSteps(st => st.filter(e => e.role !== id && e.params?.target !== id));
                       setDirty(true);
                       say(`${cast[id].name} left the room`);
                     }}
                     style={{ fontSize: 11, color: "#c0bdb8", cursor: "pointer" }}>×</a>
                </div>
              ))}
              {slots.filter(id => cast[id]).length > 0 && (
                <p style={{ fontSize: 10.5, color: "#a8a5a0", margin: "8px 0 10px", lineHeight: 1.5 }}>
                  A slot is a place someone stands, not a person. An encounter casts its own
                  actor into one and the player into another.
                </p>
              )}
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

// One entry on the timeline, edited. Every control here is generated from the
// parameters the LIBRARY entry declares — there is no table of fields per verb
// any more, because there are no verbs any more. Authoring a new action makes
// its controls appear here without this file changing.
function StepRow({ step, index, live, selected, onSelect, warning, onFix, clips, propList, onPickPoint,
                   onEdit, onRemove, onMove, onOpenPoseLab, slots = ["a", "b"], cast = {} }) {
  const def = getAction(step?.ref);
  const params = paramsFor(def);
  const cell = { fontSize: 11.5, padding: "3px 6px", borderRadius: 5,
                 border: "1px solid rgba(0,0,0,.12)", color: "#2f2c28", background: "#fff" };
  const who = (id) => cast[id]?.name || `slot ${id}`;
  const setParam = (key, v) => onEdit({ params: { ...(step.params || {}), [key]: v } });

  if (!def) {
    return (
      <div style={{ border: "1px solid rgba(216,90,48,.4)", background: "rgba(216,90,48,.06)",
                    borderRadius: 8, padding: "8px 9px", marginBottom: 6, fontSize: 11.5, color: "#d85a30" }}>
        {index + 1}. “{step?.ref}” is not in the library.
      </div>
    );
  }

  return (
    <div onClick={onSelect}
         style={{ border: `1px solid ${live ? "rgba(201,151,58,.55)" : selected ? "rgba(0,0,0,.22)" : "rgba(0,0,0,.07)"}`,
                  background: live ? "rgba(201,151,58,.06)" : "#fdfcfb",
                  borderRadius: 8, padding: "8px 9px", marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 10.5, color: "#8b8781" }}>
          {index + 1}. {KIND_GLYPH[step.kind]?.mark} {def.name}
          {def.source === "engine" && <span style={{ color: "#c0bdb8" }}> · room</span>}
        </span>
        <span style={{ display: "flex", gap: 6 }}>
          {def.source !== "engine" && (
            <a onClick={(e) => { e.stopPropagation(); onOpenPoseLab?.(step); }}
               style={{ cursor: "pointer", color: "#b05c08", fontSize: 10.5 }}>edit</a>
          )}
          <a onClick={(e) => { e.stopPropagation(); onMove(-1); }} style={{ cursor: "pointer", color: "#c0bdb8", fontSize: 11 }}>↑</a>
          <a onClick={(e) => { e.stopPropagation(); onMove(1); }}  style={{ cursor: "pointer", color: "#c0bdb8", fontSize: 11 }}>↓</a>
          <a onClick={(e) => { e.stopPropagation(); onRemove(); }} style={{ cursor: "pointer", color: "#c0bdb8", fontSize: 11 }}>×</a>
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {/* who performs it — always, for every kind */}
        <select value={step.role || slots[0]} style={cell}
                onChange={e => onEdit({ role: e.target.value })}>
          {slots.map(r => <option key={r} value={r}>{who(r)}</option>)}
        </select>

        {params.map(prm => {
          const v = step.params?.[prm.key];
          if (prm.type === "role") return (
            <select key={prm.key} value={v || ""} style={cell} title={prm.label}
                    onChange={e => setParam(prm.key, e.target.value)}>
              <option value="">— {prm.label} —</option>
              {slots.filter(r => r !== step.role).map(r => <option key={r} value={r}>{who(r)}</option>)}
            </select>
          );
          if (prm.type === "prop") return (
            <select key={prm.key} value={v || ""} style={cell} title={prm.label}
                    onChange={e => setParam(prm.key, e.target.value)}>
              <option value="">— prop —</option>
              {(propList || []).map(pr => <option key={pr.id} value={pr.id}>{pr.label || pr.type}</option>)}
            </select>
          );
          if (prm.type === "clip") return (
            <select key={prm.key} value={v || ""} style={cell} title={prm.label}
                    onChange={e => setParam(prm.key, e.target.value)}>
              {!(clips || []).includes(v) && <option value={v || ""}>{v || "—"}</option>}
              {(clips || []).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          );
          if (prm.type === "bool") return (
            <label key={prm.key} style={{ fontSize: 11, color: "#8b8781", display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={!!v} onChange={e => setParam(prm.key, e.target.checked)} />
              {prm.label}
            </label>
          );
          if (prm.type === "text") return (
            <input key={prm.key} value={v || ""} placeholder={prm.label} style={{ ...cell, flex: "1 1 160px", minWidth: 120 }}
                   onChange={e => setParam(prm.key, e.target.value)} />
          );
          return (
            <label key={prm.key} style={{ fontSize: 10.5, color: "#8b8781", display: "flex", gap: 3, alignItems: "center" }}>
              {prm.label}
              <input type="number" step={prm.step || 0.05} value={v ?? 0} style={{ ...cell, width: 62 }}
                     onChange={e => setParam(prm.key, Number(e.target.value))} />
            </label>
          );
        })}

        {/* a reaction is timed against a contact, not a clock */}
        {step.kind === "reaction" && (
          <>
            <select value={step.on || "contact"} style={cell}
                    onChange={e => onEdit({ on: e.target.value })}>
              <option value="contact">on contact</option>
              <option value="delay">after a delay</option>
            </select>
            <label style={{ fontSize: 10.5, color: "#8b8781", display: "flex", gap: 3, alignItems: "center" }}>
              {step.on === "delay" ? "seconds" : "+s"}
              <input type="number" step="0.05" value={step.delay ?? 0} style={{ ...cell, width: 56 }}
                     onChange={e => onEdit({ delay: Number(e.target.value) })} />
            </label>
          </>
        )}

        <label style={{ fontSize: 10.5, color: "#8b8781", display: "flex", gap: 3, alignItems: "center" }}
               title="Seconds of nothing before this entry begins — what a Wait step used to be.">
          gap
          <input type="number" step="0.1" value={step.gap ?? 0} style={{ ...cell, width: 52 }}
                 onChange={e => onEdit({ gap: Number(e.target.value) })} />
        </label>

        <label style={{ fontSize: 10.5, color: "#8b8781", display: "flex", gap: 4, alignItems: "center" }}
               title="Unticked, the next entry starts on top of this one — which is how a contact action and the reaction answering it are paired.">
          <input type="checkbox" checked={step.wait !== false} onChange={e => onEdit({ wait: e.target.checked })} />
          finish before next
        </label>
      </div>

      {warning && (
        <p style={{ margin: "6px 0 0", fontSize: 10.5, color: "#d85a30" }}>
          {warning}{onFix && <a onClick={onFix} style={{ marginLeft: 6, cursor: "pointer" }}>fix</a>}
        </p>
      )}
    </div>
  );
}
