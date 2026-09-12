import { getAction, paramsFor } from "./bodyActions.js";

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
    out.of = o || "a";
  }
  if (out.shot === "over_shoulder") {
    const f = String(raw.from || "");
    // Explicit and required. With a cast of one or of five, "the other one"
    // has no meaning — an over-the-shoulder has to name whose shoulder.
    out.from = f || "";
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
export function normalizeCameras(raw, entries = [], errors = []) {
  // Anchored to the ID of the entry it belongs to. It used to be a positional
  // index, and neither reordering nor deleting an entry ever touched the camera
  // list — so moving one silently dragged every cut onto different content, and
  // deleting one made this function re-clamp the out-of-range cuts onto the
  // LAST entry rather than dropping them. A save/load round trip could relocate
  // the framing of a whole composition with no warning anywhere.
  const ids = new Set((entries || []).map(e => e?.id).filter(Boolean));
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((c, i) => {
    const at = `camera ${i + 1}`;
    if (!c || typeof c !== "object") { errors.push(`${at}: not an object`); return; }
    const cam = normalizeCamera(c, errors, at);
    if (!cam) return;
    // Accept the old positional shape on the way in, once, so stored rows keep
    // their framing: an integer `step` names the entry at that position.
    const entry = ids.has(c.entry) ? c.entry
                : (Number.isInteger(c.step) && entries[c.step]?.id) || null;
    if (!entry) { errors.push(`${at}: nothing to anchor to`); return; }
    out.push({ ...cam, id: safeId(c.id), entry, offset: num(c.offset, 0, 0, 30) });
  });
  // Ordered by where their entries actually fall, so inheritance reads left to
  // right the way the timeline draws it.
  const pos = new Map((entries || []).map((e, i) => [e.id, i]));
  return out.sort((x, y) => (pos.get(x.entry) - pos.get(y.entry)) || (x.offset - y.offset));
}

export function cameraAt(cameras, entries, index) {
  // Framing is inherited: a cut holds until the next one. Walk the cuts in
  // entry order and keep the last one at or before this entry.
  const pos = new Map((entries || []).map((e, i) => [e.id, i]));
  let found = null;
  for (const c of cameras || []) {
    if ((pos.get(c.entry) ?? Infinity) <= index) found = c; else break;
  }
  return found;
}

// NOTE: `hoistLegacyCameras` used to live here, lifting a camera off a step
// into the cut list. It was called from four places and StepRow kept WRITING
// step.camera, so it never became a migration — it was a permanent second
// write path for one concept. Cuts are their own objects now, anchored by
// entry id, and the one-time acceptance of the old positional shape lives
// inside normalizeCameras where nobody has to remember to call it.

// ── what a composition is made of ────────────────────────────────────────────
//
// Three kinds, and nothing else. Each one is a REFERENCE to a library entry
// plus the values that entry declared it needs — never a thing with its own
// hardcoded verb. That is the whole point of the redesign: the vocabulary grows
// by authoring a library entry, and this file never learns a fourteenth noun.
//
// The kind on an entry must match the kind of the library item it names. They
// are stated twice on purpose: the timeline can draw and group entries without
// resolving every reference, and a reference that has gone missing shows up as
// a mismatch rather than as a silently skipped beat.
export const ENTRY_KINDS = {
  action: {
    label: "Action",
    // A movement performed by one character. May reach another — an action
    // with `aim` takes a target — and publishes a contact instant that
    // reactions can be timed against.
    glyph: "action",
  },
  reaction: {
    label: "Reaction",
    // A movement performed BECAUSE of someone else's contact. The distinction
    // from an action is not the motion, it is the timing: a reaction waits for
    // a contact rather than for a clock.
    glyph: "reaction",
  },
  pose: {
    label: "Pose",
    // A held configuration. It clamps at its last frame and keeps applying
    // until something replaces it. This is the kind the old model could not
    // say, which is why held shapes were filed as reactions.
    glyph: "pose",
  },
};

export const ENTRY_KIND_LIST = Object.keys(ENTRY_KINDS);

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2).replace(/\.00$/, "") : "?");

// One line of English for an entry, used by the timeline, the run log and
// anything handing a composition to Claude. Resolves the reference so it can
// say "Slap the face" rather than "slap-face".
export function describeEntry(entry, castOf = (r) => r) {
  if (!entry) return "";
  const def = getAction(entry.ref);
  const name = def?.name || entry.ref || "…";
  const who = castOf(entry.role) || entry.role || "?";
  const p = entry.params || {};
  if (def?.source === "engine") {
    switch (def.slug) {
      case "walk-to":      return `${who} walks to ${fmt(p.x)}, ${fmt(p.z)}`;
      case "approach":     return `${who} approaches ${castOf(p.target) || p.target || "?"}`;
      case "turn-to":      return `${who} turns to ${castOf(p.target) || p.target || "?"}`;
      case "walk-to-prop": return `${who} walks to the ${p.prop || "prop"}`;
      case "sit-on":       return `${who} sits on the ${p.prop || "prop"}`;
      case "stand-up":     return `${who} stands up`;
      case "pull-prop":    return `${who} pulls out the ${p.prop || "prop"}`;
      case "play-clip":    return `${who} plays “${p.clip || "…"}”`;
      case "say":          return `${who}: “${String(p.text || "").slice(0, 40)}”`;
      default:             return `${who} ${name}`;
    }
  }
  if (entry.kind === "pose")     return `${who} holds ${name.toLowerCase()}`;
  if (entry.kind === "reaction") return `${who} reacts: ${name}` +
    (entry.on === "delay" ? ` after ${fmt(entry.delay)}s`
                          : ` on contact${entry.delay ? ` +${fmt(entry.delay)}s` : ""}`);
  return `${who}: ${name}` + (p.target ? ` → ${castOf(p.target) || p.target}` : "");
}

// ── the cast ─────────────────────────────────────────────────────────────────
//
// A composition carries its own cast: an ordered list of slots, each a place a
// character stands rather than a character. It used to be the literal pair
// ["a","b"], which is why nothing could rehearse three people.
//
// `driven` is the guard that survives into an encounter: a slot the rig does
// not drive is a living player, and an entry that moves them is refused.
export const DEFAULT_SLOT_IDS = ["a", "b", "c", "d", "e", "f", "g", "h"];

export function castIds(script) {
  const cast = Array.isArray(script?.cast) ? script.cast : [];
  const ids = cast.map(c => String(c?.id ?? c?.role ?? "")).filter(Boolean);
  // A composition saved before the cast was a list still has entries naming
  // "a" and "b". Falling back to those keeps every stored row readable.
  return ids.length ? ids : ["a", "b"];
}

export function castLabel(script, id) {
  const hit = (script?.cast || []).find(c => String(c?.id ?? c?.role) === String(id));
  return hit?.label || hit?.name || null;
}

// Which slots does this composition take hold of? Being approached or turned
// towards costs nothing — only the slots that ACT are counted, because those
// are the bodies a rig has to own.
export function drivenRoles(script) {
  const { entries } = normalizeEntries(script?.entries || script?.steps || [], { cast: castIds(script) });
  const out = new Set();
  for (const e of entries) if (e.role) out.add(e.role);
  return [...out].sort();
}

export function rolesNotAvailable(script, available) {
  const own = new Set(available || []);
  return drivenRoles(script).filter(r => !own.has(r));
}

export function entryId() {
  return Math.random().toString(36).slice(2, 10);
}

// A new entry referencing a library item, with that item's declared parameters
// at their defaults. Nothing here knows what the parameters MEAN.
export function defaultEntry(ref, role = "a") {
  const def = getAction(ref);
  const params = {};
  for (const p of paramsFor(def)) params[p.key] = p.default ?? (p.type === "number" ? 0 : "");
  const entry = {
    id: entryId(),
    kind: def?.kind || "action",
    ref: def?.slug || String(ref || ""),
    role,
    params,
    // A pose holds and an action that is not a contact rarely needs the next
    // beat to wait for it. A contact action must NOT block, or the reaction
    // that answers it can never hear the contact.
    wait: def?.kind === "pose" ? false : !(def?.kind === "action" && def?.aim),
  };
  if (entry.kind === "reaction") { entry.on = "contact"; entry.delay = 0; }
  return entry;
}

// ── validation ───────────────────────────────────────────────────────────────
//
// Runs in the editor for the author's benefit and on the SERVER for real: a
// stored composition is played later by code that will not re-check it.
// Everything is rebuilt from the library's own declaration — an entry cannot
// carry a parameter the library never asked for.
export function normalizeEntries(raw, { cast = ["a", "b"] } = {}) {
  const errors = [];
  const entries = [];
  if (!Array.isArray(raw)) return { entries, errors: ["entries must be a list"] };
  if (raw.length > 200) return { entries, errors: ["a composition is capped at 200 entries"] };

  const slots = new Set(cast);

  raw.forEach((e, i) => {
    const at = `entry ${i + 1}`;
    if (!e || typeof e !== "object") { errors.push(`${at}: not an object`); return; }

    const ref = String(e.ref || e.action || "").trim();
    if (!ref) { errors.push(`${at}: names no library entry`); return; }
    const def = getAction(ref);
    if (!def) { errors.push(`${at}: “${ref}” is not in the library`); return; }

    const kind = ENTRY_KINDS[e.kind] ? e.kind : (def.kind || "action");
    if (def.kind && def.kind !== kind) {
      errors.push(`${at}: “${ref}” is a ${def.kind}, filed here as a ${kind}`);
      return;
    }

    const role = String(e.role || "");
    if (!slots.has(role)) { errors.push(`${at}: “${role || "nobody"}” is not in the cast`); return; }

    const out = { id: safeId(e.id), kind, ref: def.slug, role, params: {} };

    // Parameters, one at a time, from the library's declaration. Anything the
    // entry carries that the library did not declare is dropped rather than
    // passed through — the values reach a rig method.
    for (const p of paramsFor(def)) {
      const v = e.params?.[p.key];
      if (p.type === "number") out.params[p.key] = num(v, p.default ?? 0, p.min ?? -1e6, p.max ?? 1e6);
      else if (p.type === "bool") out.params[p.key] = v === undefined ? !!p.default : !!v;
      else if (p.type === "role") {
        const t = String(v || "");
        if (!slots.has(t)) errors.push(`${at}: “${ref}” needs someone to aim at`);
        else if (t === role) errors.push(`${at}: cannot ${def.name.toLowerCase()} themselves`);
        else out.params[p.key] = t;
      }
      else if (p.type === "text") out.params[p.key] = String(v ?? p.default ?? "").slice(0, 600);
      else out.params[p.key] = String(v ?? p.default ?? "").slice(0, 120);
    }

    // A pause before this entry begins — what the `wait` step type used to be,
    // expressed as a property rather than as a kind of its own so the timeline
    // holds only Actions, Reactions and Poses.
    out.gap = num(e.gap, 0, 0, 60);

    out.wait = e.wait === undefined
      ? (kind === "pose" ? false : !(kind === "action" && def.aim))
      : !!e.wait;

    if (kind === "reaction") {
      out.on = e.on === "delay" ? "delay" : "contact";
      out.delay = num(e.delay, 0, 0, 30);
    }

    entries.push(out);
  });

  return { entries, errors };
}

function num(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function safeId(v) {
  const s = String(v || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
  return s || entryId();
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
    const cast = castIds(script);
    const { entries, errors } = normalizeEntries(script?.entries || script?.steps || [], { cast });
    const cameras = normalizeCameras(script?.cameras, entries, errors);
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
    const missing = rolesNotAvailable({ entries, cast }, rig.drives);
    if (missing.length) {
      onEvent({ type: "refused", roles: missing,
                text: `this script drives ${missing.join(" and ")}, which this rig does not own — ` +
                      `in an encounter that role is the player` });
      onEvent({ type: "done", refused: true });
      return false;
    }

    onEvent({ type: "start", steps: entries.length });

    // What the steps know about each other while a run is in flight. Only one
    // thing lives here: when the most recent contact happens, so a reaction can
    // land on it instead of on a stopwatch.
    // Cuts anchored to this step, fired when its motion begins rather than when
    // it is dispatched — for a contact-timed reaction those are half a second
    // apart, and cutting at dispatch shows the flinch before the blow lands.
    const ctx = {
      // Keyed by the entry that raised it, so two overlapping contact actions
      // no longer overwrite one another — which is what a single mutable slot
      // did. `lastContact` is what an unqualified reaction answers.
      contacts: new Map(),
      lastContact: null,
      // Cuts are anchored to an entry's ID, not to its position. A positional
      // anchor silently relocated framing whenever a step was reordered or
      // removed, because neither path ever touched the camera list.
      cutsFor: (id) => cameras.filter(c => c.entry === id),
      cut: (cam) => { try { rig.camera?.(cam); } catch {} },
      performer: (role) => rig.performer?.(role),
      say: (role, text) => (rig.say ? rig.say(role, text) : null),
    };

    // Steps started with wait:false are still RUNNING when the next one
    // begins. They are collected here so the end of the script can be an
    // honest end: a run that reports "done" while she is still walking is a
    // report about the interpreter, not about the scene.
    const background = [];

    for (let i = 0; i < entries.length; i++) {
      if (cancelled) break;
      const entry = entries[i];
      onEvent({ type: "step", index: i, step: entry, entry });
      const p = perform(entry, rig, sleep, onEvent, ctx).catch((e) => {
        onEvent({ type: "error", index: i, text: String(e?.message || e) });
      });
      if (entry.wait) await p; else background.push(p);
    }

    if (!cancelled) await Promise.all(background);
    onEvent({ type: cancelled ? "cancelled" : "done" });
    return !cancelled;
  })();

  return { done, cancel };
}

// ── how an engine action is called ───────────────────────────────────────────
//
// One line per engine behaviour, and the only place in this file that knows a
// rig method's signature. The rig itself is untouched by the redesign: all the
// room geometry — the seat search, the chair scoot, the footprint-aware stop
// distance — stays exactly where it was and is reached through here.
//
// Adding a behaviour means a row in ENGINE_ACTIONS and a row here. Adding an
// AUTHORED action means neither: it is a library entry and arrives for free.
// Each line mirrors a real signature on the rig, and they are NOT uniform:
// walkToProp and pullProp take a distance as a positional NUMBER, walkTo and
// clip take an options object. Passing an object where a number was expected
// does not throw — it turns the arithmetic that consumes it into NaN, which is
// how `sit test` sent the body to an undefined position and left it walking
// there forever, invisible. Check against the scene before editing a line here.
const ENGINE_CALL = {
  walkTo:     (who, p) => who.walkTo(p.x, p.z, { speed: p.speed }),
  approach:   (who, p, c) => who.approach(c.performer(p.target), p.distance, { speed: p.speed }),
  turnTo:     (who, p, c) => who.turnTo(c.performer(p.target)),
  walkToProp: (who, p) => who.walkToProp(p.prop, p.distance, { speed: p.speed }),
  sitOn:      (who, p) => who.sitOn(p.prop),
  standUp:    (who) => who.standUp(),
  pullProp:   (who, p) => who.pullProp(p.prop, p.distance),
  clip:       (who, p) => who.clip(p.clip, { loop: p.loop, fade: p.fade }),
  // Rig-level, deliberately. A script raises a line; it never speaks it. The
  // studio captions it, an encounter hands it to her voice, and the simulator
  // stays the single authority on what reaches TTS.
  say:        (who, p, c, entry) => c.say(entry.role, p.text),
};

async function perform(entry, rig, sleep, onEvent, ctx = {}) {
  // Framing applies when the motion actually BEGINS — which for most entries is
  // now, and for a contact-timed reaction is half a second from now. Applying
  // it at dispatch instead looked like the camera was ignoring shots: a contact
  // action must not block if the reaction is to hear it, so the reaction starts
  // immediately after and its framing overwrote the action's within a frame.
  const frame = () => {
    for (const cam of ctx.cutsFor?.(entry.id) || []) ctx.cut?.(cam);
  };

  const def = getAction(entry.ref);
  if (!def) { onEvent({ type: "warning", text: `“${entry.ref}” is not in the library — skipped` }); return; }

  const who = rig.performer?.(entry.role);
  if (!who) { onEvent({ type: "warning", text: `nobody is cast as “${entry.role}” — skipped` }); return; }

  // ── a reaction waits for a contact, not for a clock ───────────────────────
  //
  // Which contact: the one it was told to answer, or failing that the most
  // recent one started. `ctx.contacts` is keyed by the entry that raised it,
  // so two overlapping contact actions no longer overwrite each other's
  // promise — which they did when this was a single mutable slot.
  if (entry.kind === "reaction") {
    if (entry.on !== "delay") {
      const waitFor = ctx.contacts?.get(entry.after) || ctx.lastContact;
      // The 5s ceiling is a liveness guard, not a tunable: if the action it
      // was meant to answer never fires, the reaction still happens rather
      // than the run hanging on a promise nobody will resolve.
      if (waitFor) await Promise.race([waitFor, sleep(5000)]);
    }
    if (entry.delay) await sleep(entry.delay * 1000);
    frame();
    return who.react(entry.ref);
  }

  frame();

  // ── engine-backed ─────────────────────────────────────────────────────────
  if (def.source === "engine") {
    const call = ENGINE_CALL[def.handler];
    if (!call) { onEvent({ type: "warning", text: `“${def.slug}” names no handler — skipped` }); return; }
    return call(who, entry.params || {}, ctx, entry);
  }

  // ── a room action: the furniture decides where this happens ──────────────
  //
  // Authored as bone tracks like any other, but it declared it needs a prop, so
  // the body is put in front of that prop first and the motion plays from
  // there. The arithmetic is the rig's own — the same footprint-aware stop
  // distance walk-to-prop uses — so a lean authored against one table works
  // against a wider one without being re-authored.
  if (def.source !== "engine" && def.needsProp && entry.params?.prop) {
    const placed = await who.walkToProp(entry.params.prop, { distance: def.standAt ?? 0.55 });
    // A prop that is not in this room is not a crash: the motion is skipped and
    // says so, because playing a lean on nothing reads as a bug in the motion.
    if (placed?.missing) {
      onEvent({ type: "warning", text: `“${def.name}” needs a ${entry.params.prop} and there is none — skipped` });
      return;
    }
  }

  // ── authored tracks ───────────────────────────────────────────────────────
  //
  // A pose and a non-contact action are the same call; the holding comes from
  // the library entry's own kind, read inside the rig. An action that aims is
  // the only one that needs the other body, and it publishes its contact.
  const targetId = entry.params?.target;
  if (entry.kind === "action" && def.aim && targetId) {
    const other = rig.performer?.(targetId);
    if (!other) { onEvent({ type: "warning", text: `nobody is cast as “${targetId}” — skipped` }); return; }

    let fire;
    const contact = new Promise((r) => { fire = r; });
    ctx.contacts?.set(entry.id, contact);
    ctx.lastContact = contact;

    return who.interact(other, entry.ref, {
      onContact: () => { onEvent({ type: "contact", id: entry.id, ref: entry.ref }); fire(); },
    });
  }

  return who.react(entry.ref);
}

export function timingWarnings(script) {
  const { entries } = normalizeEntries(script?.entries || script?.steps || [], { cast: castIds(script) });
  const out = [];
  // The scan below walks backwards from each reaction looking for the action it
  // answers, so it needs the list under the name its body uses.
  const steps = entries;
  steps.forEach((step, i) => {
    if (step.kind !== "reaction" || step.on === "delay") return;
    let prior = null;
    for (let j = i - 1; j >= 0; j--) {
      // The nearest preceding entry that actually publishes a contact — an
      // action that aims. "interaction" was the old step type for this.
      if (steps[j].kind === "action" && getAction(steps[j].ref)?.aim) { prior = { step: steps[j], index: j }; break; }
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
  const { entries } = normalizeEntries(script?.entries || script?.steps || [], { cast: castIds(script) });
  const label = (id) => castLabel(script, id) || id;
  return entries
    .map((e, i) => `${String(i + 1).padStart(2, " ")}. ${describeEntry(e, label)}${e.wait ? "" : "  (does not block)"}`)
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

// Where the bodies stand as a composition plays, entry by entry. This is what
// makes the timeline more than a ruler: selecting entry 7 has to put the bodies
// where entry 7 would find them. Editing a slap while they stand at their
// opening marks is authoring against a lie — the pose looks wrong, you correct
// it, and the correction is what is wrong.
//
// `marks` now carries one entry per cast slot rather than a hardcoded pair.
export function estimateTimeline(script, { marks, actionDuration, contactAt, propAt } = {}) {
  const cast = castIds(script);
  const { entries } = normalizeEntries(script?.entries || script?.steps || [], { cast });

  const at = {};
  cast.forEach((id, i) => {
    const m = marks?.[id];
    at[id] = {
      x: m?.x ?? (i % 2 === 0 ? -0.75 : 0.75),
      z: m?.z ?? 0,
      facing: m?.facing ?? (i % 2 === 0 ? Math.PI / 2 : -Math.PI / 2),
    };
  });
  const snapshot = () => Object.fromEntries(Object.entries(at).map(([k, v]) => [k, { ...v }]));
  const face = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);

  let clock = 0;
  const out = [];
  const unmeasured = [];

  for (const entry of entries) {
    const before = snapshot();
    const def = getAction(entry.ref);
    const p = entry.params || {};
    const who = entry.role && at[entry.role];
    const other = p.target && at[p.target];
    let dur = 0;

    // A pause before this entry, which is what `wait` used to be. Expressed as
    // a property of the entry rather than as a kind of its own, so the timeline
    // holds only Actions, Reactions and Poses.
    const gap = entry.gap || 0;
    clock += gap;

    const handler = def?.source === "engine" ? def.handler : null;

    if (handler === "say") {
      // The runner's own beat when the host has no voice. Same formula, on
      // purpose — if either changes without the other the timeline lies.
      dur = Math.min(6, 0.7 + (p.text?.length || 0) * 0.045);
    } else if (handler === "walkTo" && who) {
      dur = Math.hypot(p.x - who.x, p.z - who.z) / (p.speed || 0.95);
      who.facing = face(who, { x: p.x, z: p.z });
      who.x = p.x; who.z = p.z;
    } else if (handler === "walkToProp" && who) {
      // Needs to know where the furniture is, which this module has no business
      // knowing — so the caller resolves it. Without this it estimated at ZERO
      // and drew as a sliver, which is how a whole entry vanishes from the strip.
      const pr = propAt?.(p.prop);
      if (pr) {
        const dx = who.x - pr.x, dz = who.z - pr.z;
        const d = Math.hypot(dx, dz) || 1;
        const ux = dx / d, uz = dz / d;
        const reach = Math.abs(ux) * (pr.hw || 0.3) + Math.abs(uz) * (pr.hd || 0.3) + 0.22 + (p.distance || 0.55);
        const tx = pr.x + ux * reach, tz = pr.z + uz * reach;
        dur = Math.hypot(tx - who.x, tz - who.z) / (p.speed || 0.95);
        who.facing = face(who, { x: tx, z: tz });
        who.x = tx; who.z = tz;
      }
    } else if (handler === "pullProp" && who) {
      const pr = propAt?.(p.prop);
      if (pr) {
        dur = (Math.hypot(pr.x - who.x, pr.z - who.z) / 0.95) + 0.9;
        who.x = pr.x; who.z = pr.z;
      }
    } else if (handler === "sitOn" && who) {
      const pr = propAt?.(p.prop);
      dur = 1.4;
      if (pr) { who.x = pr.x; who.z = pr.z; }
    } else if (handler === "standUp") {
      dur = 1.2;
    } else if (handler === "approach" && who && other) {
      const d = Math.hypot(other.x - who.x, other.z - who.z);
      const stop = Math.max(0, d - (p.distance ?? 0.7));
      dur = stop / (p.speed || 0.95) + TURN_SECONDS;
      if (d > 0) { who.x += ((other.x - who.x) / d) * stop; who.z += ((other.z - who.z) / d) * stop; }
      who.facing = face(who, other);
    } else if (handler === "turnTo") {
      dur = TURN_SECONDS;
      if (who && other) who.facing = face(who, other);
    } else if (handler === "clip") {
      dur = p.loop ? 0 : CLIP_SECONDS;
    } else if (def) {
      // An authored entry knows its own length. The caller may override —
      // a saved row wins over a built-in and only the caller has the registry.
      dur = actionDuration?.(entry.ref) ?? def.duration ?? 0;
    }

    // An entry whose duration nobody can measure draws as a sliver and reads as
    // missing. Say so rather than rendering a lie.
    if (dur === 0 && !["clip"].includes(def?.slug) && entry.kind !== "pose") {
      unmeasured.push(entry.ref);
    }

    let start = clock;
    // A reaction does not start when the list reaches it — it starts when the
    // contact it answers lands.
    if (entry.kind === "reaction" && entry.on !== "delay") {
      const src = out.slice().reverse().find(b => b.entry.kind === "action" && getAction(b.entry.ref)?.aim);
      // The caller may resolve a live contact instant; failing that the library
      // entry knows its own. Falling through to zero drew the flinch as
      // starting WITH the blow rather than on it.
      if (src) start = src.start + (contactAt?.(src.entry.ref) ?? getAction(src.entry.ref)?.contactAt ?? 0);
    }
    start += entry.kind === "reaction" ? (entry.delay || 0) : 0;

    out.push({ id: entry.id, entry, step: entry, start, duration: dur,
               blocking: entry.wait, before, after: snapshot() });
    if (entry.wait) clock = Math.max(clock, start + dur);
  }

  const total = out.reduce((m, b) => Math.max(m, b.start + b.duration), 0);
  return { blocks: out, total, estimated: true, unmeasured };
}

// Where both bodies stand when entry `index` BEGINS. Everything before it has
// been played; nothing of it has. That is the state you author against.
export function positionsBefore(timeline, index) {
  const b = timeline?.blocks?.[index];
  if (!b) return null;
  return b.before;
}

export function stepAt(timeline, t) {
  const hit = (timeline?.blocks || []).filter(b => t >= b.start && t < b.start + b.duration);
  if (!hit.length) return null;
  // The LAST match wins: with non-blocking entries several overlap, and the one
  // you mean is the one that started most recently.
  const b = hit[hit.length - 1];
  return { ...b, local: t - b.start };
}
