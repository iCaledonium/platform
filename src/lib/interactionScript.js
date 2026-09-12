// ── The interaction script ───────────────────────────────────────────────────
//
// Session 157 — what two people DO to each other, written down.
//
// An encounter already knows how to make her talk. What it has never had is a
// vocabulary for the rest of it: she crosses the room, she turns to face you,
// she waits a beat before she answers. Every one of those existed as a
// hand-written special case inside DoorScene3D — walkHerTo, the 2.2s greeting
// timer that got deleted, the crossfade pair around a walk — and none of it
// could be authored, saved, or replayed.
//
// This file is the vocabulary and the interpreter, and NOTHING else. It knows
// no three.js, no React and no DOM: it is handed a `rig` — an object that can
// actually move bodies — and it walks the steps in order. That is deliberate,
// because there are two rigs. The Interaction Studio's rig drives two figures
// in an empty room while you author. The encounter's rig drives her, in her
// flat, in front of a player.
//
// ── how far the portability claim actually goes ──────────────────────────────
//
// Narrowly: A SCRIPT DESCRIBES MOVEMENT THAT RUNS UNCHANGED. That is the claim,
// and it is worth having — DoorScene3D already carries four hand-written
// versions of these verbs (payload.location, payload.move_to === "player", a
// /close/i regex on position, MOVES_INSIDE against her own scene_description),
// so a rig consolidates something that is duplicated four ways already.
//
// It does NOT extend to two things, and reading it wider than this is how the
// studio ends up shipping a bug into somebody's flat (Chief Architect's ruling,
// 2026-09-06):
//
//   1. A ROLE IS NOT ALWAYS A PUPPET. In the studio both roles are figures the
//      rig owns. In an encounter, role "b" is the PLAYER — first person, and
//      pointer-locked, which is the entire reason the desktop shell exists.
//      Driving that role does not degrade gracefully; it takes a human's camera
//      away mid-scene. So a rig now DECLARES which roles it may drive (`drives`)
//      and the runner refuses the rest loudly instead of quietly no-opping.
//   2. A SCRIPT NEVER OWNS THE MOUTH. `say` raises an event; it does not speak.
//      speakable_part/1 on the simulator is the single authority on what reaches
//      TTS (DIRECTOR'S NOTE 8a/8d exist because narration was being read aloud).
//      A script that could hand her a line would be a second authority with
//      nothing arbitrating between them.
//
// ── the shape of a script ────────────────────────────────────────────────────
//
//   { name, description, cast: [{ role, label }], steps: [ … ] }
//
// A role is a slot, not a person: "a" and "b". The studio binds them to two
// runtime models you picked; an encounter binds "a" to the actor whose door it
// is and "b" to the player. Steps name roles, never actors — an interaction
// that only works for Lindsey is a cutscene, not an interaction.

// ── how a step is SEEN ───────────────────────────────────────────────────────
//
// Every step may carry a camera. Not a step type of its own: framing is not
// something the two of them DO, it is how the thing they do is watched, and
// making it a separate step meant the sequence interleaved actions with
// instructions about looking at them.
//
// A step with no camera keeps whatever framing is already in force, so a shot
// set once carries across the beats it was set for. That inheritance is what
// makes "a camera on every step" bearable rather than six repetitions of the
// same shot.
//
// A shot is named RELATIVE TO THE CAST — "over b's shoulder onto a" — never as
// a world position. Same argument as rotations-not-positions in bodyActions.js:
// a hard xyz is correct exactly once, for the staging it was set in, and
// silently wrong after anyone moves a mark or swaps a body.
export const SHOTS = ["wide", "two_shot", "over_shoulder", "close"];

export function describeCamera(cam) {
  if (!cam) return null;
  if (cam.shot === "wide") return "wide";
  if (cam.shot === "two_shot") return "both of them";
  if (cam.shot === "over_shoulder") return `over ${cam.from || "?"}'s shoulder onto ${cam.of || "?"}`;
  if (cam.shot === "close") return `close on ${cam.of || "?"}`;
  return cam.shot || "?";
}

function normalizeCamera(raw, errors, at) {
  if (!raw) return undefined;
  const out = { shot: SHOTS.includes(String(raw.shot)) ? String(raw.shot) : "two_shot" };
  if (out.shot !== "wide") {
    const o = String(raw.of || "");
    out.of = ROLES.includes(o) ? o : "a";
  }
  if (out.shot === "over_shoulder") {
    const f = String(raw.from || "");
    out.from = ROLES.includes(f) ? f : (out.of === "a" ? "b" : "a");
    if (out.from === out.of) errors.push(`${at}: camera cannot shoot over their own shoulder`);
  }
  // 0 means "whatever suits this shot" — the sensible default per shot lives
  // with the rig, which is the only thing that knows the room.
  out.distance = num(raw.distance, 0, 0, 12);
  out.height = num(raw.height, 0, 0, 3);
  return out;
}

// Which camera is in force at step `index` — this step's own, or the most
// recent one before it.
// Cameras are their OWN track, not a field on a step. As a step property a cut
// could only ever land on a step boundary — you could not cut to a close-up
// halfway through a four-second walk, or on the windup of a slap. Framing is
// not something the two of them do, and it does not share their clock.
//
// A cut is anchored to a STEP PLUS AN OFFSET rather than to an absolute second,
// because every duration here is an estimate: a walk ends when the feet arrive.
// An absolute time drifts out of sync the moment that walk gets longer;
// "0.2s into step 3" stays true however long step 3 turns out to be.
export function normalizeCameras(raw, stepCount, errors = []) {
  const out = [];
  const list = Array.isArray(raw) ? raw : [];
  list.forEach((c, i) => {
    if (!c || typeof c !== "object") return;
    const at = `camera ${i + 1}`;
    const cam = normalizeCamera(c, errors, at);
    if (!cam) return;
    const step = Math.max(0, Math.min(stepCount - 1, Math.round(Number(c.step) || 0)));
    if (stepCount === 0) { errors.push(`${at}: nothing to anchor to`); return; }
    out.push({ ...cam, id: safeId(c.id), step, offset: num(c.offset, 0, 0, 30) });
  });
  return out.sort((a, b) => (a.step - b.step) || (a.offset - b.offset));
}

// Which shot is in force when step `index` begins — the last cut anchored at or
// before it. A step with no cut of its own keeps whatever is running.
export function cameraAt(cameras, index) {
  let found = null;
  for (const c of cameras || []) {
    if (c.step <= index) found = c; else break;
  }
  return found;
}

// Steps used to carry their own `camera`. Hoist those onto the track so scripts
// saved under the old shape keep their framing instead of losing it silently —
// the same mistake that emptied a saved slap earlier today.
export function hoistLegacyCameras(steps, cameras) {
  const out = [...(cameras || [])];
  (steps || []).forEach((s, i) => {
    if (!s?.camera) return;
    if (out.some(c => c.step === i && c.offset === 0)) return;
    out.push({ ...s.camera, step: i, offset: 0, id: `legacy-${i}` });
  });
  return out.sort((a, b) => (a.step - b.step) || (a.offset - b.offset));
}

// Every step type, its parameters, and what it means to the rig. This table is
// the contract: the server validates against it, the studio's editor renders
// from it, and the runner dispatches on it. One place, so a new verb cannot be
// half-added.
export const STEP_TYPES = {
  clip: {
    label: "Play clip",
    // Which body, which animation. `loop` holds it until something else takes
    // over; a non-looping clip with wait:true blocks for its own duration.
    fields: ["role", "clip", "loop", "fade"],
    describe: (s) => `${s.role || "?"} plays “${s.clip || "…"}”${s.loop ? " (looping)" : ""}`,
  },
  walk_to: {
    label: "Walk to point",
    fields: ["role", "x", "z", "speed"],
    describe: (s) => `${s.role || "?"} walks to ${fmt(s.x)}, ${fmt(s.z)}`,
  },
  walk_to_prop: {
    label: "Walk to a prop",
    // Named, not measured. "Go to the table" keeps meaning something when the
    // table is somewhere else — in a real room, in a room rearranged since the
    // rehearsal — where "walk to 1.2, -0.4" quietly becomes a walk to nowhere.
    // The prop reference is the durable half of this step; the distance is just
    // how close is close enough.
    fields: ["role", "prop", "distance", "speed"],
    describe: (s) => `${s.role || "?"} walks to the ${s.prop || "?"}`,
  },
  pull_prop: {
    label: "Pull out a prop",
    // Furniture has STATES. A chair tucked under a table offers no seat —
    // sitting on it starts with pulling it out, the way it does in a kitchen.
    // The step names the prop for the same reason walk_to_prop does, and the
    // distance is how far out it comes.
    fields: ["role", "prop", "distance"],
    describe: (s) => `${s.role || "?"} pulls out the ${s.prop || "?"}`,
  },
  sit_on: {
    label: "Sit on a prop",
    // Named furniture again, for the same reason walk_to_prop names it: "sit on
    // the chair" survives the chair being somewhere else, or being a different
    // chair in a real room. Where she ends up is the room's business.
    fields: ["role", "prop"],
    describe: (s) => `${s.role || "?"} sits on the ${s.prop || "?"}`,
  },
  stand_up: {
    label: "Stand up",
    fields: ["role"],
    describe: (s) => `${s.role || "?"} stands up`,
  },
  approach: {
    label: "Approach the other",
    // Stops at `distance` metres rather than walking into them. 0.7 is
    // conversation distance; under about 0.45 two runtime models intersect.
    fields: ["role", "target", "distance", "speed"],
    describe: (s) => `${s.role || "?"} approaches ${s.target || "?"} to ${fmt(s.distance)}m`,
  },
  turn_to: {
    label: "Turn to face",
    fields: ["role", "target"],
    describe: (s) => `${s.role || "?"} turns to ${s.target || "?"}`,
  },
  say: {
    label: "Say a line",
    // The runner does not synthesize anything. It raises the line as an event
    // and the HOST decides what that means: a bubble in the studio, her real
    // voice in an encounter. A script must never assume it owns the mouth.
    fields: ["role", "text"],
    describe: (s) => `${s.role || "?"}: “${(s.text || "").slice(0, 40)}”`,
  },
  interaction: {
    label: "Body interaction",
    // The one verb that is AUTHORED rather than coded. `action` names a saved
    // body interaction — an action posed on the actor, a contact instant, and a
    // reaction posed on the target — and the rig resolves it. Adding a slap, a
    // shove or a hand on an arm after this touches no source at all, which is
    // the entire point: STEP_TYPES stays closed while the vocabulary grows.
    //
    // Positioning and dialogue are deliberately NOT part of it. Where they
    // stand is `approach`, what they say is `say`; both already work, and
    // folding them in here would give two authorities over the same thing.
    fields: ["role", "target", "action"],
    describe: (s) => `${s.role || "?"} ${s.action || "…"} ${s.target || "?"}`,
  },
  reaction: {
    label: "React",
    // The other half of a contact, as its OWN step — because the same slap can
    // be met with a flinch, a laugh, or nothing at all, and binding one
    // reaction permanently to one action makes that unsayable.
    //
    // It drives the body that REACTS, and nothing else. That is what makes a
    // slap portable: the action alone touches only the actor, so an encounter
    // (where the other role is a living player) can play the action and leave
    // the reaction out, or answer it with a camera shake instead of a pose.
    //
    // `delay` is measured from when this step starts, and exists because a
    // reaction lands on the beat of the contact, not on the beat of the step
    // list. Compose it with the action step's "finish before next" unchecked,
    // and set delay to the action's contact time.
    // `on` is how it is TIMED, and it defaults to the only answer that stays
    // true when anything is retimed: the contact the action itself raises.
    // A hand-tuned delay is a guess about someone else's timing, and it goes
    // stale the moment the action's windup is changed by a tenth of a second.
    // `delay` survives as an offset FROM that instant — a beat before the head
    // turns — not as a substitute for knowing when the blow lands.
    fields: ["role", "action", "on", "delay"],
    describe: (s) => `${s.role || "?"} reacts: ${s.action || "…"}` +
      (s.on === "delay" ? ` after ${fmt(s.delay)}s`
        : ` on contact${s.delay ? ` +${fmt(s.delay)}s` : ""}`),
  },
  space: {
    label: "Personal space",
    // Proxemics — Hall's zones. Intimate is under about 0.45m, personal runs to
    // 1.2m, social to 3.6m. This is how close THIS role lets the other come
    // before backing away, and it is a property of the person and the
    // relationship rather than of the room: she lets him closer in the fourth
    // scene than the first, and that change is the story.
    //
    // It is NOT collision. Bodies are kept from interpenetrating whatever this
    // says — that floor is physics and is not authorable. This is the distance
    // at which someone becomes uncomfortable, which is a different thing and
    // can legitimately be set to zero.
    fields: ["role", "distance"],
    describe: (s) => `${s.role || "?"} keeps ${fmt(s.distance)}m of space`,
  },
  wait: {
    label: "Wait",
    fields: ["seconds"],
    describe: (s) => `wait ${fmt(s.seconds)}s`,
  },
};

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2).replace(/\.00$/, "") : "?");

export const ROLES = ["a", "b"];

// Which roles does this script actually take hold of? Not "which roles are
// mentioned" — being approached or turned towards costs you nothing, and a
// script where "a" walks over to "b" is perfectly playable with a live person
// standing in "b". Only the roles that are ACTED AS count, because those are
// the bodies the rig has to own.
//
// `say` counts. In an encounter the mouth on role "b" belongs to a human being,
// and a script cannot put words in it.
export function drivenRoles(script) {
  const { steps } = normalizeSteps(script?.steps || []);
  const out = new Set();
  // Every verb now drives its OWN role and nothing else — including
  // `interaction`, which swings the actor's arm and does not touch the body it
  // is aimed at. Being approached, turned towards, or even struck costs the
  // other role nothing HERE, because what it does to them is a separate
  // `reaction` step naming them as its own role.
  //
  // This used to carry a special case adding an interaction's TARGET, back when
  // one step owned both halves. Splitting the reaction out removed the need for
  // it, and with it the reason a slap could never play in an encounter: the
  // action drives only the actor, so her door can run it and answer the contact
  // however it likes.
  for (const s of steps) if (s.role) out.add(s.role);
  return [...out].sort();
}

// Can this script play on a rig that only owns `available`? Returns the roles
// it would need and cannot have — empty means it travels.
export function rolesNotAvailable(script, available) {
  const own = new Set(available || []);
  return drivenRoles(script).filter(r => !own.has(r));
}

// A step that does not block is one the next step starts on top of — which is
// how "start walking AND start talking" is expressed without a parallel
// construct. Defaults per type, because the sensible answer differs: a looping
// clip you want to continue under everything after it, a walk you almost
// always want to finish.
const DEFAULT_WAIT = { clip: false, walk_to: true, approach: true, turn_to: true, say: true, walk_to_prop: true, pull_prop: true, sit_on: true, stand_up: true, interaction: true, reaction: true, space: true, wait: true };

export function defaultStep(type, role = "a") {
  const base = { id: stepId(), type, wait: DEFAULT_WAIT[type] ?? true };
  switch (type) {
    case "clip":     return { ...base, role, clip: "idle", loop: true, fade: 0.35 };
    case "walk_to":  return { ...base, role, x: 0, z: 0, speed: 0.95 };
    case "walk_to_prop": return { ...base, role, prop: "", distance: 0.55, speed: 0.95 };
    case "pull_prop": return { ...base, role, prop: "", distance: 0.6 };
    case "sit_on":   return { ...base, role, prop: "" };
    case "stand_up": return { ...base, role };
    case "approach": return { ...base, role, target: role === "a" ? "b" : "a", distance: 0.7, speed: 0.95 };
    case "turn_to":  return { ...base, role, target: role === "a" ? "b" : "a" };
    case "say":      return { ...base, role, text: "" };
    case "interaction": return { ...base, role, target: role === "a" ? "b" : "a", action: "" };
    case "reaction": return { ...base, role, action: "", on: "contact", delay: 0 };
    case "space":    return { ...base, role, distance: 0.6 };
    case "wait":     return { ...base, seconds: 1 };
    default:         return base;
  }
}

export function stepId() {
  return Math.random().toString(36).slice(2, 10);
}

// ── validation ───────────────────────────────────────────────────────────────
//
// Runs on the client for the editor's benefit and on the SERVER for real: a
// stored script is executed later by code that will not re-check it, so the
// row has to be trustworthy on its own. Returns { steps, errors } — the steps
// coerced to their proper types, never the caller's object.
export function normalizeSteps(raw) {
  const errors = [];
  const steps = [];
  if (!Array.isArray(raw)) return { steps, errors: ["steps must be a list"] };
  if (raw.length > 200) return { steps, errors: ["a script is capped at 200 steps"] };

  raw.forEach((s, i) => {
    const at = `step ${i + 1}`;
    if (!s || typeof s !== "object") { errors.push(`${at}: not an object`); return; }
    const type = String(s.type || "");
    if (!STEP_TYPES[type]) { errors.push(`${at}: unknown type "${type}"`); return; }

    const out = { id: safeId(s.id), type, wait: s.wait === undefined ? (DEFAULT_WAIT[type] ?? true) : !!s.wait };
    const role = () => {
      const r = String(s.role || "");
      if (!ROLES.includes(r)) { errors.push(`${at}: role must be one of ${ROLES.join(", ")}`); return null; }
      return r;
    };
    const target = () => {
      const t = String(s.target || "");
      if (!ROLES.includes(t)) { errors.push(`${at}: target must be one of ${ROLES.join(", ")}`); return null; }
      return t;
    };

    if (type === "clip") {
      out.role = role();
      out.clip = String(s.clip || "").trim().slice(0, 64);
      if (!out.clip) errors.push(`${at}: a clip name is required`);
      out.loop = !!s.loop;
      out.fade = num(s.fade, 0.35, 0, 4);
    } else if (type === "walk_to") {
      out.role = role();
      // The room is 6m square; ±8 leaves room for a bigger one without letting
      // a typo send somebody to the horizon.
      out.x = num(s.x, 0, -8, 8);
      out.z = num(s.z, 0, -8, 8);
      out.speed = num(s.speed, 0.95, 0.1, 3);
    } else if (type === "walk_to_prop") {
      out.role = role();
      out.prop = String(s.prop || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
      if (!out.prop) errors.push(`${at}: no prop chosen`);
      // How close to stand to its EDGE, not its centre — a bed and a stool are
      // not approached to the same coordinate.
      out.distance = num(s.distance, 0.55, 0.1, 4);
      out.speed = num(s.speed, 0.95, 0.1, 3);
    } else if (type === "pull_prop") {
      out.role = role();
      out.prop = String(s.prop || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
      if (!out.prop) errors.push(`${at}: nothing to pull`);
      out.distance = num(s.distance, 0.6, 0.2, 1.5);
    } else if (type === "sit_on") {
      out.role = role();
      out.prop = String(s.prop || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
      if (!out.prop) errors.push(`${at}: nothing to sit on`);
    } else if (type === "stand_up") {
      out.role = role();
    } else if (type === "approach") {
      out.role = role();
      out.target = target();
      if (out.role && out.target && out.role === out.target) errors.push(`${at}: cannot approach themselves`);
      out.distance = num(s.distance, 0.7, 0.4, 6);
      out.speed = num(s.speed, 0.95, 0.1, 3);
    } else if (type === "turn_to") {
      out.role = role();
      out.target = target();
      if (out.role && out.target && out.role === out.target) errors.push(`${at}: cannot turn to themselves`);
    } else if (type === "say") {
      out.role = role();
      out.text = String(s.text || "").slice(0, 600);
      if (!out.text.trim()) errors.push(`${at}: a line with no words`);
    } else if (type === "interaction") {
      out.role = role();
      out.target = target();
      if (out.role && out.target && out.role === out.target) errors.push(`${at}: cannot do that to themselves`);
      // A slug, not a payload. The tracks live in one row that the editor owns
      // and the server validates on its own terms; a script that carried its
      // own copy of the motion would fork the moment the action was edited.
      out.action = String(s.action || "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 64);
      if (!out.action) errors.push(`${at}: no body interaction chosen`);
    } else if (type === "reaction") {
      out.role = role();
      out.action = String(s.action || "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 64);
      if (!out.action) errors.push(`${at}: no reaction chosen`);
      out.on = s.on === "delay" ? "delay" : "contact";
      out.delay = num(s.delay, 0, 0, 10);
    } else if (type === "space") {
      out.role = role();
      // 0 is allowed and means "no discomfort at any distance" — an embrace has
      // to be sayable. The ceiling is the far edge of Hall's social zone.
      out.distance = num(s.distance, 0.6, 0, 3.6);
    } else if (type === "wait") {
      // A 60s cap so a stray zero cannot hang a run for an hour.
      out.seconds = num(s.seconds, 1, 0, 60);
    }
    const cam = normalizeCamera(s.camera, errors, at);
    if (cam) out.camera = cam;
    steps.push(out);
  });

  return { steps, errors };
}

function num(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function safeId(v) {
  const s = String(v || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
  return s || stepId();
}

// ── the runner ───────────────────────────────────────────────────────────────
//
// Sequential, cancellable, and honest about what it cannot do: a rig that has
// no performer for a role reports it as an event and the run carries on rather
// than throwing, because half a rehearsal still tells you something.
//
// `rig` MUST declare:
//   drives: ["a"]        the roles this rig is allowed to take hold of.
//
// Required, not optional, and the studio declares ["a","b"] explicitly even
// though it owns both figures. An earlier cut made it optional and treated
// omission as "drives everything" — which put the entire guard at the mercy of
// whoever wires the encounter rig remembering to add one field. Forget it and
// the refusal silently stops existing, with nothing to notice. That is this
// codebase's recurring failure shape, not a hypothetical: `is_staff`, a column
// the presence queries read and nothing ever populated; `@max_polls`, read
// before it was defined so the compare was always false. (Caught in review by
// the Chief Architect, 2026-09-06.)
//
// So a rig with no `drives` is REFUSED rather than trusted. The safe behaviour
// does not depend on anyone's memory.
//
// Role "b" in an encounter is a living player, first person and pointer-locked;
// a step driving them is refused, never performed.
//
// `rig` must provide:
//   performer(role) -> null | {
//     clip(name, { loop, fade }) -> Promise (resolves when a non-looping clip ends)
//     walkTo(x, z, { speed })    -> Promise
//     approach(otherPerformer, distance, { speed }) -> Promise
//     turnTo(otherPerformer)     -> Promise
//   }
//     interact(otherPerformer, actionSlug, { onContact }) -> Promise
//                                (optional — a rig without it skips the step
//                                 loudly rather than pretending it performed)
//   say(role, text)  (optional — the host may prefer to handle the event)
//
// Returns a handle: { done, cancel() }. Everything the caller wants to draw —
// which step is live, what was said — arrives through onEvent.
export function runScript(script, rig, { onEvent = () => {} } = {}) {
  let cancelled = false;
  const timers = new Set();

  const sleep = (ms) => new Promise((resolve) => {
    if (cancelled || ms <= 0) return resolve();
    const t = setTimeout(() => { timers.delete(t); resolve(); }, ms);
    timers.add(t);
  });

  const cancel = () => {
    cancelled = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    try { rig.stopAll?.(); } catch {}
    onEvent({ type: "cancelled" });
  };

  const done = (async () => {
    const { steps, errors } = normalizeSteps(script?.steps || []);
    const cameras = hoistLegacyCameras(
      script?.steps || [],
      normalizeCameras(script?.cameras, steps.length, errors),
    );
    if (errors.length) onEvent({ type: "warning", text: errors.join("; ") });

    // Refused BEFORE the first step, not discovered at step nine. A rig that
    // does not own a role the script drives cannot play this script honestly,
    // and playing the rest of it would be a performance nobody authored.
    //
    // An absent declaration is refused too — see the contract above. A guard
    // that switches itself off when a field is forgotten is not a guard.
    if (!Array.isArray(rig?.drives)) {
      onEvent({ type: "refused", roles: [],
                text: "this rig does not declare which roles it may drive — refusing rather than assuming it owns them" });
      onEvent({ type: "done", refused: true });
      return false;
    }
    const missing = rolesNotAvailable({ steps }, rig.drives);
    if (missing.length) {
      onEvent({ type: "refused", roles: missing,
                text: `this script drives ${missing.join(" and ")}, which this rig does not own — ` +
                      `in an encounter that role is the player` });
      onEvent({ type: "done", refused: true });
      return false;
    }

    onEvent({ type: "start", steps: steps.length });

    // What the steps know about each other while a run is in flight. Only one
    // thing lives here: when the most recent contact happens, so a reaction can
    // land on it instead of on a stopwatch.
    // Cuts anchored to this step, fired when its motion begins rather than when
    // it is dispatched — for a contact-timed reaction those are half a second
    // apart, and cutting at dispatch shows the flinch before the blow lands.
    const ctx = {
      contact: null,
      cutsFor: (index) => cameras.filter(c => c.step === index),
      cut: (cam) => { try { rig.camera?.(cam); } catch {} },
    };

    // Steps started with wait:false are still RUNNING when the next one
    // begins. They are collected here so the end of the script can be an
    // honest end: a run that reports "done" while she is still walking is a
    // report about the interpreter, not about the scene.
    const background = [];

    for (let i = 0; i < steps.length; i++) {
      if (cancelled) break;
      const step = steps[i];
      // The step needs to know its own index so its cuts can be found.
      step._index = i;
      onEvent({ type: "step", index: i, step });
      const p = perform(step, rig, sleep, onEvent, ctx).catch((e) => {
        onEvent({ type: "error", index: i, text: String(e?.message || e) });
      });
      if (step.wait) await p; else background.push(p);
    }

    if (!cancelled) await Promise.all(background);
    onEvent({ type: cancelled ? "cancelled" : "done" });
    return !cancelled;
  })();

  return { done, cancel };
}

async function perform(step, rig, sleep, onEvent, ctx = {}) {
  // Framing applies when the step's motion actually BEGINS — which for most
  // steps is now, and for a reaction waiting on contact is half a second from
  // now. Applying it at dispatch time instead looked like the camera was
  // ignoring shots entirely: an action must not block if a reaction is to hear
  // its contact, so the reaction step starts IMMEDIATELY after it and its
  // framing overwrote the action's within a frame. The shot was applied,
  // correctly, and then replaced before anyone could see it.
  const frame = () => {
    for (const cam of ctx.cutsFor?.(step._index ?? -1) || []) {
      if (cam.offset > 0) sleep(cam.offset * 1000).then(() => ctx.cut(cam));
      else ctx.cut(cam);
    }
  };
  if (step.type !== "reaction") frame();

  if (step.type === "wait") return sleep(step.seconds * 1000);

  if (step.type === "say") {
    onEvent({ type: "say", role: step.role, text: step.text });
    if (rig.say) return rig.say(step.role, step.text);
    // No mouth on this rig: hold for a readable beat so a rehearsal has the
    // rhythm of a conversation rather than firing every line at once.
    return sleep(Math.min(6000, 700 + step.text.length * 45));
  }

  // BEFORE the two-body lookups below, because a reaction has no target — it
  // is one body answering something that already happened to it. Dispatching it
  // after `step.target` was resolved meant every React step died on
  // "no body cast as undefined" without ever reaching this branch.
  if (step.type === "space") {
    if (!rig.setSpace) { onEvent({ type: "warning", text: "this rig has no personal space — skipping" }); return; }
    return rig.setSpace(step.role, step.distance);
  }

  if (step.type === "reaction") {
    const me = rig.performer?.(step.role);
    if (!me) { onEvent({ type: "warning", text: `no body cast as “${step.role}” — skipping` }); return; }
    if (!me.react) {
      onEvent({ type: "warning", text: `this rig cannot perform reactions — skipping “${step.action}”` });
      return;
    }
    // Wait for the blow to actually land. The action raises contact from its
    // own timeline, so this stays in step however the windup is retimed — and
    // if the action was authored to strike at 0.45s and later moves to 0.6s,
    // nothing here needs editing.
    //
    // The race is a guard, not a timeout worth tuning: if the action never
    // raises contact (it was skipped, or the rig cannot perform it) the
    // reaction still happens rather than hanging the run at step four.
    if (step.on !== "delay" && ctx.contact) {
      await Promise.race([ctx.contact, sleep(5000)]);
    }
    if (step.delay) await sleep(step.delay * 1000);
    // NOW — the blow has landed and the flinch is about to start.
    frame();
    return me.react(step.action);
  }

  const who = rig.performer?.(step.role);
  if (!who) { onEvent({ type: "warning", text: `no body cast as “${step.role}” — skipping` }); return; }

  if (step.type === "pull_prop") {
    if (!who.pullProp) { onEvent({ type: "warning", text: "this rig cannot move furniture — skipping" }); return; }
    return who.pullProp(step.prop, step.distance);
  }

  if (step.type === "sit_on") {
    if (!who.sitOn) { onEvent({ type: "warning", text: "this rig cannot sit anyone down — skipping" }); return; }
    return who.sitOn(step.prop);
  }

  if (step.type === "stand_up") {
    if (!who.standUp) { onEvent({ type: "warning", text: "this rig cannot stand anyone up — skipping" }); return; }
    return who.standUp();
  }

  if (step.type === "walk_to_prop") {
    if (!who.walkToProp) {
      onEvent({ type: "warning", text: "this rig has no furniture — skipping" });
      return;
    }
    return who.walkToProp(step.prop, step.distance, { speed: step.speed });
  }

  if (step.type === "clip")     return who.clip(step.clip, { loop: step.loop, fade: step.fade });
  if (step.type === "walk_to")  return who.walkTo(step.x, step.z, { speed: step.speed });

  const other = rig.performer?.(step.target);
  if (!other) { onEvent({ type: "warning", text: `no body cast as “${step.target}” — skipping` }); return; }
  if (step.type === "approach") return who.approach(other, step.distance, { speed: step.speed });
  if (step.type === "turn_to")  return who.turnTo(other);

  if (step.type === "interaction") {
    if (!who.interact) {
      onEvent({ type: "warning", text: `this rig cannot perform body interactions — skipping “${step.action}”` });
      return;
    }
    // The rig raises contact; the runner only forwards it. What contact MEANS
    // — a sound, a camera shake, something told to the simulator — is the
    // host's decision, exactly as `say` never owns the mouth.
    // Published for any reaction step that follows. Set BEFORE the motion
    // starts, because a non-blocking action means the next step begins while
    // this one is still swinging — and that next step is usually the one
    // waiting to hear about it.
    let landed;
    ctx.contact = new Promise((r) => { landed = r; });
    return who.interact(other, step.action, {
      onContact: () => {
        onEvent({ type: "contact", role: step.role, target: step.target, action: step.action });
        landed?.();
      },
    });
  }
}

// ── timing problems a single step cannot see ─────────────────────────────────
//
// normalizeSteps validates each step ALONE, which is right — a step has to be
// trustworthy on its own. But a reaction timed "on contact" depends on the step
// BEFORE it still running when it starts, and nothing about either step in
// isolation is wrong. The result is the worst kind of bug: everything valid,
// nothing complained, and the flinch arrives after the arm is back at rest.
//
// So the pairing is checked at the script level and reported as a WARNING, not
// an error. It is a legitimate thing to author — you may want a delayed,
// deliberate reaction — and rewriting someone's script because it looked odd is
// how an editor loses trust.
export function timingWarnings(script) {
  const { steps } = normalizeSteps(script?.steps || []);
  const out = [];
  steps.forEach((step, i) => {
    if (step.type !== "reaction" || step.on === "delay") return;
    let prior = null;
    for (let j = i - 1; j >= 0; j--) {
      if (steps[j].type === "interaction") { prior = { step: steps[j], index: j }; break; }
    }
    if (!prior) {
      out.push({ index: i, fix: null,
        text: "nothing before this raises a contact, so it plays as soon as it is reached" });
      return;
    }
    if (prior.step.wait) {
      out.push({ index: i, fix: { index: prior.index, patch: { wait: false } },
        text: `step ${prior.index + 1} finishes before this one starts, so the contact has already passed — ` +
              "the reaction will play late" });
    }
  });
  return out;
}

// A script's steps as one readable block — used by the studio's summary, and by
// anything that wants to hand a script to Claude without inventing a format.
export function describeScript(script) {
  const { steps } = normalizeSteps(script?.steps || []);
  return steps
    .map((s, i) => `${String(i + 1).padStart(2, " ")}. ${STEP_TYPES[s.type].describe(s)}${s.wait ? "" : "  (does not block)"}`)
    .join("\n");
}


// ── where the script is at time t ────────────────────────────────────────────
//
// The steps ARE the sequence, so a scrubber over them needs to know when each
// one starts and how long it lasts. None of that is stored — a walk takes as
// long as the walk takes — so it is SIMULATED forward from where the bodies
// begin, using the same arithmetic the rig will use at play time.
//
// This is an ESTIMATE and is labelled one everywhere it surfaces. The real run
// resolves a walk when the feet arrive, not when a stopwatch says so; a body
// that has to round a table takes longer than this predicts. It is close enough
// to lay out a timeline and wrong enough that nothing should depend on it.
//
// Kept beside the interpreter because it must not drift from it: the blocking
// rule (`wait`) and the say-beat formula are the runner's, and if either
// changes here without changing there the timeline lies about the run.

const TURN_SECONDS = 0.35;
const CLIP_SECONDS = 1.0;   // a one-shot clip of unknown length

export function estimateTimeline(script, { marks, actionDuration, contactAt, propAt } = {}) {
  const { steps } = normalizeSteps(script?.steps || []);
  // Position AND facing, carried forward step by step. This is the part that
  // makes a timeline more than a ruler: selecting step 7 has to be able to put
  // the bodies where step 7 would find them. Editing a slap while they stand at
  // their opening marks, a metre and a half apart, is authoring against a lie —
  // the pose looks wrong, you correct it, and the correction is what is wrong.
  const at = {
    a: { x: marks?.a?.x ?? -0.75, z: marks?.a?.z ?? 0, facing: marks?.a?.facing ?? Math.PI / 2 },
    b: { x: marks?.b?.x ?? 0.75, z: marks?.b?.z ?? 0, facing: marks?.b?.facing ?? -Math.PI / 2 },
  };
  const snapshot = () => ({ a: { ...at.a }, b: { ...at.b } });
  const face = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);

  let clock = 0;
  const out = [];
  const unmeasured = [];

  for (const step of steps) {
    const before = snapshot();
    let dur = 0;
    const who = step.role && at[step.role];
    const other = step.target && at[step.target];

    if (step.type === "wait") {
      dur = step.seconds;
    } else if (step.type === "say") {
      // The runner's own beat when the host has no voice. Same formula, on
      // purpose — see above.
      dur = Math.min(6, 0.7 + (step.text?.length || 0) * 0.045);
    } else if (step.type === "walk_to" && who) {
      dur = Math.hypot(step.x - who.x, step.z - who.z) / (step.speed || 0.95);
      who.facing = face(who, { x: step.x, z: step.z });
      who.x = step.x; who.z = step.z;
    } else if (step.type === "walk_to_prop" && who) {
      // Needs to know where the furniture is, which this module has no business
      // knowing — so the caller resolves it, exactly as it does for action
      // durations. Without this the step estimated at ZERO and drew as a sliver
      // with no width, which is how a whole step vanishes from the strip.
      const pr = propAt?.(step.prop);
      if (pr) {
        const dx = who.x - pr.x, dz = who.z - pr.z;
        const d = Math.hypot(dx, dz) || 1;
        const ux = dx / d, uz = dz / d;
        // The same arithmetic the rig walks: clear the footprint along the
        // approach direction, then the body, then however close it asked.
        const reach = Math.abs(ux) * (pr.hw || 0.4) + Math.abs(uz) * (pr.hd || 0.4)
                    + 0.28 + (step.distance || 0.55);
        const tx = pr.x + ux * reach, tz = pr.z + uz * reach;
        dur = Math.hypot(tx - who.x, tz - who.z) / (step.speed || 0.95) + TURN_SECONDS;
        who.facing = face(who, { x: tx, z: tz });
        who.x = tx; who.z = tz;
        who.facing = face(who, pr);
      } else {
        // Named a prop that is not in the room. It will warn and skip at run
        // time; give it a visible sliver rather than nothing so the step can
        // still be selected and corrected.
        dur = 0.2;
      }
    } else if (step.type === "pull_prop" && who) {
      const pr = propAt?.(step.prop);
      if (pr) {
        // Walk behind the backrest, take hold, step back with the chair.
        const f = (pr.yaw ?? 0) + (pr.seatFacing ?? 0);
        const gx = pr.x - Math.sin(f) * 0.75, gz = pr.z - Math.cos(f) * 0.75;
        dur = Math.hypot(gx - who.x, gz - who.z) / 0.95 + TURN_SECONDS + 1.1;
        who.x = gx - Math.sin(f) * (step.distance || 0.6);
        who.z = gz - Math.cos(f) * (step.distance || 0.6);
        who.facing = face(who, pr);
      } else {
        dur = 0.3;
      }
    } else if (step.type === "sit_on" && who) {
      const pr = propAt?.(step.prop);
      if (pr) {
        // Walk to the front of the seat, turn around, then the sit itself.
        const seatFace = pr.seatFacing ?? 0;
        const f = (pr.yaw ?? 0) + seatFace;
        const tx = pr.x + Math.sin(f) * 0.55, tz = pr.z + Math.cos(f) * 0.55;
        // The sit itself plus the scoot-in toward whatever he sits at.
        dur = Math.hypot(tx - who.x, tz - who.z) / 0.95 + TURN_SECONDS + 1.2;
        who.x = pr.x; who.z = pr.z; who.facing = f;
      } else {
        dur = 0.55;
      }
    } else if (step.type === "stand_up") {
      // Scoot back from the table, then the rise itself.
      dur = 1.6;
    } else if (step.type === "approach" && who && other) {
      const d = Math.hypot(other.x - who.x, other.z - who.z);
      const travel = Math.max(0, d - step.distance);
      dur = travel / (step.speed || 0.95) + TURN_SECONDS;
      if (d > 0) { who.x += ((other.x - who.x) / d) * travel; who.z += ((other.z - who.z) / d) * travel; }
      // approach ends by turning to them — the rig does it, so the estimate must
      who.facing = face(who, other);
    } else if (step.type === "turn_to") {
      dur = TURN_SECONDS;
      if (who && other) who.facing = face(who, other);
    } else if (step.type === "clip") {
      dur = step.loop ? 0 : CLIP_SECONDS;
    } else if (step.type === "interaction") {
      // The action's own length, which the caller supplies because this module
      // deliberately knows nothing about the action library.
      dur = actionDuration?.(step.action) ?? 1;
    } else if (step.type === "reaction") {
      // A reaction has a length like anything else. Leaving it at zero drew it
      // as a sliver hidden behind the next step, which is how a whole step
      // came to be invisible on the timeline.
      dur = actionDuration?.(step.action) ?? 0.8;
    }

    // A step type this function has never heard of gets a visible sliver and
    // SAYS SO. Four verbs have now been added to STEP_TYPES — which validates
    // and dispatches them — while this switch silently gave them zero duration,
    // so each drew as a hairline hidden under its neighbour and looked like a
    // rendering bug. STEP_TYPES is the contract for what a step IS; nothing
    // forced this to keep up, so it now complains instead of lying.
    if (dur === 0 && !["clip", "wait", "space"].includes(step.type)) {
      unmeasured.push(step.type);
      dur = 0.25;
    }

    // A non-blocking step starts the next one immediately; it still OCCUPIES
    // time on the strip, because you want to see that she is still walking
    // while the next line is spoken.
    // A contact-timed reaction does not begin when it is DISPATCHED — it waits
    // for the blow. Drawing it at dispatch put it under the step before it and
    // claimed things happened simultaneously that are half a second apart.
    let start = clock;
    if (step.type === "reaction" && step.on !== "delay") {
      for (let j = out.length - 1; j >= 0; j--) {
        if (out[j].type === "interaction") {
          start = out[j].start + (contactAt?.(out[j].step.action) ?? 0);
          break;
        }
      }
    }
    start += step.type === "reaction" ? (step.delay || 0) : 0;

    out.push({ id: step.id, type: step.type, step, start, duration: dur,
               blocking: step.wait, before, after: snapshot() });
    if (step.wait) clock += dur;
  }

  const total = out.reduce((m, b) => Math.max(m, b.start + b.duration), 0);
  if (unmeasured.length && typeof console !== "undefined") {
    console.warn("[estimateTimeline] no duration rule for:", [...new Set(unmeasured)].join(", "),
                 "— drawn as a placeholder. Add a case, or the strip lies about when things happen.");
  }
  return { blocks: out, total, estimated: true, unmeasured: [...new Set(unmeasured)] };
}

// Which step is live at time t, and how far into it. Returns null before the
// first step and after the last — a scrubber past the end is not editing
// anything, and pretending otherwise puts edits into the wrong step.
// Where both bodies stand when step `index` BEGINS. Everything before it has
// been played; nothing of it has. That is the state you want to author against.
export function positionsBefore(timeline, index) {
  const b = timeline?.blocks?.[index];
  if (!b) return null;
  return b.before;
}

export function stepAt(timeline, t) {
  const hit = (timeline?.blocks || []).filter(b => t >= b.start && t < b.start + b.duration);
  if (!hit.length) return null;
  // The LAST match wins: with non-blocking steps several overlap, and the one
  // you mean is the one that started most recently.
  const b = hit[hit.length - 1];
  return { ...b, local: t - b.start };
}
