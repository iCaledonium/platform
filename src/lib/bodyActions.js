// ── body interactions: an action, a contact, a reaction ──────────────────────
//
// What two bodies DO to each other, as data. The positioning verbs say where
// they stand and `say` says what they said; this says what happened between
// them. It is deliberately the only part of a script that is authored rather
// than coded, because the list of things one person can do to another has no
// end and a codebase that grows a verb per gesture is a codebase nobody can
// read.
//
// ── why rotations, and nothing else ──────────────────────────────────────────
//
// A track is a bone and a list of ROTATIONS over time. Never a position, never
// an IK target, never a world coordinate. A rotation is proportion-independent
// — a shoulder turned 40 degrees is 40 degrees on a tall body and a short one —
// so an action authored on one character plays on any character with the same
// rig. Store a position and the motion belongs forever to the body it was
// authored on.
//
// The cost of that choice, stated plainly: there is no contact DETECTION. Arm
// lengths differ, so the hand lands in a slightly different place on every
// body. Contact is therefore an AUTHORED INSTANT on the timeline — `contactAt`
// — not something the geometry discovers. Everything downstream (the sound, the
// recoil, whatever the simulator is told) hangs off that instant. This is the
// trade that buys the portability, and it is worth making knowingly.
//
// ── canonical bones ──────────────────────────────────────────────────────────
//
// Tracks name CANONICAL bones, not rig bones. Today every character in the
// world is Genesis 9 and the map below is nearly an identity, which is exactly
// why the indirection has to go in now: the first non-Genesis character
// otherwise invalidates every action ever authored, and by then there is a
// library of them. One map per rig, in one place.

export const RIGS = {
  genesis9: {
    right_shoulder: "r_shoulder", right_upper_arm: "r_upperarm",
    right_forearm:  "r_forearm",  right_hand:      "r_hand",
    left_shoulder:  "l_shoulder",  left_upper_arm: "l_upperarm",
    left_forearm:   "l_forearm",   left_hand:      "l_hand",
    head: "head", neck_upper: "neck2", neck_lower: "neck1",
    chest: "spine3", spine: "spine1", upper_chest: "spine4",
    hip: "hip", pelvis: "pelvis",
    left_thigh: "l_thigh", right_thigh: "r_thigh",
    left_shin: "l_shin", right_shin: "r_shin",
    left_foot: "l_foot", right_foot: "r_foot",
  },
};

export function boneFor(canonical, rig = "genesis9") {
  return RIGS[rig]?.[canonical] || null;
}

// Angles are DEGREES and are DELTAS from whatever the body is already doing —
// they compose onto the idle rather than replacing it, so she keeps breathing
// while her arm swings. Authored in degrees because that is what a person
// editing a pose can hold in their head.
export const ACTIONS = {
  // An entry poses ONE body: the one performing it. `kind` says which half of a
  // contact it is, and that is the whole difference — a reaction is not a
  // lesser thing bolted to an action, it is an action performed by the person
  // it happens to. Splitting them is what lets the same slap be met with a
  // flinch, a laugh, or nothing.
  "slap-face": {
    slug: "slap-face",
    name: "Slap the face",
    kind: "action",
    // Shorter than it was. The old 1.10s spent half a second drifting the arm
    // back to rest, which read as the body forgetting what it had just done.
    // A slap recovers fast; the beat afterwards belongs to the other person.
    duration: 0.85,
    contactAt: 0.42,
    contactDistance: 0.4,
    // Where it must LAND. Resolved on the other body at play time, so the same
    // slap finds the chin of whoever is standing there, at whatever height —
    // which is the difference between an action that plays and one that
    // connects. See solveArm in InteractionStudioScene.
    aim: { at: "chin", window: 0.18, weight: 1 },
    // Axis conventions MEASURED on Genesis 9, not assumed:
    //   upper arm  X = swing forward/up   Z- = raise out to the side
    //                                     Z+ = bring across the body
    //   forearm    X+ = BEND THE ELBOW (X− is hyperextension and does nothing —
    //              the first cut of this used −38 for the windup, which is why
    //              the elbow appeared not to move at all)
    //   head       X = nod   Y = turn away   Z = tilt
    tracks: [
      { bone: "right_upper_arm", keys: [ [0,[0,0,0]], [0.26,[35,0,-72]], [0.42,[135,-30,0]], [0.54,[120,-24,28]], [0.85,[0,0,0]] ] },
      // Cocked hard on the windup, whipping straight through contact, then
      // folding again on the follow-through. The elbow is most of what makes a
      // slap read as thrown rather than reached.
      { bone: "right_forearm",   keys: [ [0,[0,0,0]], [0.26,[62,0,0]],   [0.42,[6,0,0]],     [0.54,[34,0,0]],    [0.85,[0,0,0]] ] },
      { bone: "right_shoulder",  keys: [ [0,[0,0,0]], [0.26,[0,0,-12]],  [0.42,[8,0,6]],     [0.54,[4,0,4]],     [0.85,[0,0,0]] ] },
      { bone: "right_hand",      keys: [ [0,[0,0,0]], [0.26,[0,-14,0]],  [0.42,[0,6,0]],     [0.85,[0,0,0]] ] },
      { bone: "chest",           keys: [ [0,[0,0,0]], [0.26,[-7,0,0]],   [0.42,[3,0,0]],     [0.56,[9,0,0]],     [0.85,[0,0,0]] ] },
    ],
  },

  // A POSTURE rather than a gesture: it is held at its last keyframe until
  // something else moves her, where an action returns to rest on its own. That
  // is the whole difference between "she slaps him" and "she is sitting".
  //
  // Rotations only, as everything here is — so this bends the body into the
  // shape of sitting but cannot lower it onto the seat. The DROP is geometry
  // and belongs to the room: the rig reads the seat height off the prop and
  // puts her hips there. Style from the library, height from the furniture.
  "sit": {
    slug: "sit",
    name: "Sit",
    kind: "pose",
    duration: 0.55,
    hold: true,
    tracks: [
      // Thighs slope DOWN about 14cm from hip to knee, and that is correct
      // rather than sloppy: once she rests ON a 0.48m seat her hip joint is at
      // 0.55, and her lower leg is only ~0.42 long. Horizontal thighs put the
      // knees so high that her feet could not reach the floor by 21cm — the
      // geometry simply does not close. A seat this tall for a body this size
      // IS sat on with the thighs angled down.
      { bone: "right_thigh", keys: [ [0,[0,0,0]], [0.55,[-77,0,-4]] ] },
      { bone: "left_thigh",  keys: [ [0,[0,0,0]], [0.55,[-77,0,4]] ] },
      // 116, not the 90-ish a diagram would suggest: with the hips dropped to
      // the seat, anything less leaves the feet 11cm THROUGH the floor. Found
      // by probing the angle against the foot's measured height, which is the
      // only way to get this right — it depends on the thigh length and where
      // the root sits, neither of which is guessable.
      { bone: "right_shin",  keys: [ [0,[0,0,0]], [0.55,[79,0,0]] ] },
      { bone: "left_shin",   keys: [ [0,[0,0,0]], [0.55,[79,0,0]] ] },
      // A little forward at the hips and a straighter back — sitting bolt
      // upright from the pelvis reads as a mannequin on a chair.
      { bone: "hip",         keys: [ [0,[0,0,0]], [0.55,[6,0,0]] ] },
      { bone: "chest",       keys: [ [0,[0,0,0]], [0.55,[-4,0,0]] ] },
      { bone: "right_upper_arm", keys: [ [0,[0,0,0]], [0.55,[8,0,6]] ] },
      { bone: "left_upper_arm",  keys: [ [0,[0,0,0]], [0.55,[8,0,-6]] ] },
    ],
  },

  // A stance, not a gesture: crossed arms HOLD until something else moves
  // the body — dialogue happens over it, which is the point of the pose.
  // Registered as kind "reaction" because that is the studio's word for "one
  // body performs this on its own"; the Reaction step plays it with no
  // partner and no contact. Angles use the conventions measured for the
  // slap: upper arm X = swing forward, Z+ = across the body (mirrored for
  // the left), forearm X+ = bend the elbow. Right arm rides on top.
  "cross-arms": {
    slug: "cross-arms",
    name: "Cross the arms",
    kind: "reaction",
    duration: 0.9,
    hold: true,
    // The angles are a SHAPE; they cannot know how deep this torso is. On a
    // heavy body the same arc passes through the belly. wrapTorso makes the
    // rig measure the torso's front surface at hold time and swing both
    // upper arms forward until the forearms clear it — per body, measured.
    adapt: "wrapTorso",
    tracks: [
      // v1 read as PRAYER, not a cross: elbow flex is one axis, and folding
      // 104 degrees before the upper arm has come across the chest sends the
      // forearms straight UP. The cross lives mostly in the UPPER arm — hard
      // across the body with some internal twist — and the elbow only closes
      // enough to lay the forearm flat against the chest.
      // v2 held an invisible box: forearms horizontal but 33cm out in front.
      // The last piece is the ELBOW closing to bring the forearms back
      // against the chest — with a little more across so the wrists pass the
      // midline and actually cross.
      // Angles PROBED on the rig, not guessed (poseBone sweep, 2026-09-12):
      // upper-arm Y is the flexion PLANE, and positive Y opens the arm
      // outward — the cross needs NEGATIVE Y (internal rotation) on the
      // right, mirrored on the left. With [20,-30,68]+86 the right hand
      // lands exactly at the chest's front surface, 8cm past the midline,
      // level. Two blind guesses before this read as prayer and as carrying
      // an invisible box; one measured sweep ended it.
      // Matched against a photo (Magnus, 2026-09-12): real crossed arms sit
      // LOW — under the bust, not on the upper chest — and they WRAP: each
      // wrist reaches past the opposite elbow to the far flank of the torso,
      // forearms stacked tight. The probe sweep already contained the wrap:
      // [10,-55,70] lands the hand 19cm across the midline at the flank.
      // TWO BEATS, not one (Magnus: "first arms forward, you bend the arms
      // into the torso"). A single blend from hanging to crossed drags the
      // forearms diagonally through the body; the real motion reaches
      // FORWARD first, then folds in. The 0.4s key is that reach.
      // The ELBOWS stay wide; the FOREARMS do the crossing (Magnus: "you are
      // pushing the elbows too close to each other"). Probed under the -52
      // twist: Z does NOT sweep the arm across — it drags the ELBOW inboard
      // (Z=70 elbow -12cm, Z=25 elbow AT the shoulder line) while the hand
      // crosses 20cm either way, because the crossing comes from twist +
      // elbow bend. Euler axes composed after a twist do not mean what
      // their names say; measure, never reason, about the third axis.
      // END STATE AUTHORED BY MAGNUS ON THE SLIDERS (2026-09-12): read verbatim
      // off his editing panel and baked as the 0.9 keys. Asymmetric on purpose
      // — a real cross is. The 0.4 keys keep the two-beat approach (reach
      // forward, then fold in) so playback LANDS here instead of sweeping
      // through the torso.
      { bone: "right_upper_arm", keys: [ [0,[0,0,0]], [0.4,[55,0,10]],  [0.9,[34,-61,-10]] ] },
      // Forearm Y is PRONATION (probed: +60 turns the palm to the ceiling,
      // -60 turns it against the body). Without it the hands sat under the
      // cross palms-up, offering a tray.
      { bone: "right_forearm",   keys: [ [0,[0,0,0]], [0.4,[25,0,0]],   [0.9,[85,4,1]] ] },
            { bone: "left_shoulder",   keys: [ [0,[0,0,0]], [0.4,[-8,0,0]],   [0.9,[-15,0,0]] ] },
      { bone: "left_upper_arm",  keys: [ [0,[0,0,0]], [0.4,[52,0,-10]], [0.9,[65,36,10]] ] },
      // Same sign as the right, NOT the anatomical mirror — this rig's
      // twist axes do not flip across the body (the hand-basis lesson again:
      // measure the sign, never derive it).
      { bone: "left_forearm",    keys: [ [0,[0,0,0]], [0.4,[25,0,0]],   [0.9,[100,-11,-42]] ] },
                ],
  },

  // The way back down. Starts at exactly the crossed values, so playing it
  // over the held cross is seamless — playMotion swaps the pose and the
  // first frame matches the last one the hold was applying.
  "uncross-arms": {
    slug: "uncross-arms",
    name: "Uncross the arms",
    kind: "reaction",
    duration: 0.8,
    tracks: [
      // The same two beats backwards: unfold FORWARD off the torso, then
      // drop — never a diagonal sweep back through the body.
      { bone: "right_upper_arm", keys: [ [0,[34,-61,-10]], [0.4,[55,0,10]],  [0.8,[0,0,0]] ] },
      { bone: "right_forearm",   keys: [ [0,[85,4,1]],     [0.4,[25,0,0]],   [0.8,[0,0,0]] ] },
            { bone: "left_shoulder",   keys: [ [0,[-15,0,0]],    [0.4,[-8,0,0]],   [0.8,[0,0,0]] ] },
      { bone: "left_upper_arm",  keys: [ [0,[65,36,10]],   [0.4,[52,0,-10]], [0.8,[0,0,0]] ] },
      { bone: "left_forearm",    keys: [ [0,[100,-11,-42]],[0.4,[25,0,0]],   [0.8,[0,0,0]] ] },
                ],
  },

  "slap-recoil": {
    slug: "slap-recoil",
    name: "Recoil from a slap",
    kind: "reaction",
    duration: 0.90,
    // The whole upper body goes, not just the head. A head that snaps alone on
    // a still torso reads as a puppet: real impact travels DOWN the chain, each
    // segment starting a little later and moving a little less, because it is
    // being dragged by the one above it rather than deciding to move.
    //
    // Axis conventions measured on Genesis 9, not assumed:
    //   head/neck  X = nod   Y = turn away   Z = tilt
    //   chest/spine X = lean  Y = twist       Z = side bend
    //   (spine has roughly 40% more leverage on the head than chest does)
    tracks: [
      // Snap away fast, come back slow, with a small overshoot on the way back.
      // Equal timings in both directions is the single most common way an
      // impact reads as a head shake.
      { bone: "head",       keys: [ [0,[0,0,0]], [0.07,[11,-42,-19]], [0.30,[4,-16,-7]], [0.55,[-1,5,2]],  [0.90,[0,0,0]] ] },
      { bone: "neck_upper", keys: [ [0,[0,0,0]], [0.09,[5,-23,-11]],  [0.32,[2,-9,-4]],  [0.57,[0,3,1]],   [0.90,[0,0,0]] ] },
      { bone: "neck_lower", keys: [ [0,[0,0,0]], [0.11,[3,-14,-7]],   [0.34,[1,-5,-2]],  [0.90,[0,0,0]] ] },
      // The torso lags further and leans AWAY (X negative) as it is turned.
      { bone: "chest",      keys: [ [0,[0,0,0]], [0.14,[-5,-10,-6]],  [0.38,[-2,-4,-2]], [0.90,[0,0,0]] ] },
      { bone: "spine",      keys: [ [0,[0,0,0]], [0.18,[-3,-6,-4]],   [0.44,[-1,-2,-1]], [0.90,[0,0,0]] ] },
    ],
  },
};

// Actions authored in the editor and loaded from the server, merged over the
// built-in ones at runtime. The built-ins stay in source as a floor: a rig with
// no network still knows how to slap, and the editor has something to open and
// learn from on a fresh install.
//
// SAVED WINS over built-in on a slug clash, deliberately — otherwise editing a
// built-in would appear to save and then play the old motion, which is the most
// confusing failure an editor can have.
const SAVED = new Map();

// Rows saved before an action and a reaction became separate entries kept both
// halves in one document, with the tracks under .actor and .reaction. They are
// upgraded on the way in rather than being left to resolve to nothing.
//
// This matters more than it looks. A saved row WINS over a built-in, so an
// un-upgraded legacy row does not merely fail to load — it silently replaces a
// working built-in with an empty one, and the motion disappears with no error
// anywhere. A schema change that quietly empties work somebody already did is
// worse than the shape it was fixing.
function upgradeLegacy(a) {
  if (!a || Array.isArray(a.tracks)) return a;
  const actorTracks = a.actor?.tracks;
  const reactionTracks = a.reaction?.tracks;
  if (!actorTracks && !reactionTracks) return a;
  // The actor half keeps the slug; the reaction half was never separately
  // addressable in the old shape, so it becomes "<slug>-reaction".
  return { ...a, kind: a.kind || "action", tracks: actorTracks || reactionTracks || [] };
}

// The reaction half of a legacy row, as its own entry, so work authored before
// the split is not lost — only re-filed.
function legacyReaction(a) {
  const tracks = a?.reaction?.tracks;
  if (!tracks?.length || Array.isArray(a.tracks)) return null;
  return {
    slug: `${a.slug}-reaction`,
    name: `${a.name || a.slug} (reaction)`,
    kind: "reaction",
    duration: a.reaction?.duration || 0.8,
    tracks,
  };
}

export function registerActions(list) {
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw?.slug) continue;
    const half = legacyReaction(raw);
    if (half) SAVED.set(half.slug.toLowerCase(), half);
    const a = upgradeLegacy(raw);
    SAVED.set(String(a.slug).toLowerCase(), a);
  }
  return SAVED.size;
}

export function forgetAction(slug) {
  return SAVED.delete(String(slug || "").toLowerCase());
}

export function getAction(slug) {
  const key = String(slug || "").toLowerCase();
  return SAVED.get(key) || ACTIONS[key] || null;
}

export function listActions(kind) {
  const out = new Map();
  const add = (a, builtin) => out.set(a.slug, {
    slug: a.slug, name: a.name, duration: a.duration, kind: a.kind || "action", builtin,
  });
  for (const a of Object.values(ACTIONS)) add(a, true);
  for (const a of SAVED.values()) add(a, false);
  // An `interaction` step must not be offered a reaction, and vice versa —
  // choosing one would produce a step that validates and then poses nothing.
  return [...out.values()].filter(a => !kind || a.kind === kind);
}

// Sample one track at time t, in degrees, with linear interpolation and a
// smoothstep on each segment — a slap that moved linearly reads as a robot arm.
// Before the first key and after the last, it holds — so a track that does not
// cover the whole duration simply stops contributing rather than snapping.
export function sampleTrack(track, t) {
  const k = track.keys;
  if (!k?.length) return [0, 0, 0];
  if (t <= k[0][0]) return k[0][1];
  if (t >= k[k.length - 1][0]) return k[k.length - 1][1];
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i][0]) {
      const [t0, a] = k[i - 1], [t1, b] = k[i];
      const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      const e = u * u * (3 - 2 * u);
      return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e];
    }
  }
  return k[k.length - 1][1];
}

// Every bone this side of an action touches, already resolved to rig names, so
// a caller can look them up once instead of per frame.
export function resolveTracks(entry, rig = "genesis9") {
  return (entry?.tracks || [])
    .map(t => ({ ...t, rigBone: boneFor(t.bone, rig) }))
    .filter(t => t.rigBone);
}


// ── validation ───────────────────────────────────────────────────────────────
//
// Runs in the editor for the author's benefit and on the SERVER for real. An
// action is executed later by a rig that will not re-check it, and it drives
// bone rotations on a human-looking body, so a stored row has to be trustworthy
// on its own. Returns { action, errors } — the action COERCED, never the
// caller's object.
//
// The bone allowlist is the point of the canonical layer: an action can only
// name bones the vocabulary knows, so a saved row cannot reach into arbitrary
// parts of a skeleton it was never authored against.

const MAX_TRACKS = 24;
const MAX_KEYS = 48;

function clampNum(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function slugify(name) {
  return String(name || "").trim().toLowerCase()
    .replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 64);
}

function normalizeTracks(raw, duration, errors, rig) {
  const known = RIGS[rig] || RIGS.genesis9;
  const out = [];
  const label = "tracks";
  const tracks = Array.isArray(raw) ? raw : [];
  if (tracks.length > MAX_TRACKS) errors.push(`${label}: more than ${MAX_TRACKS} tracks`);
  for (const t of tracks.slice(0, MAX_TRACKS)) {
    const bone = String(t?.bone || "");
    if (!known[bone]) { errors.push(`${label}: unknown bone "${bone}"`); continue; }
    const keys = Array.isArray(t.keys) ? t.keys.slice(0, MAX_KEYS) : [];
    if (!keys.length) { errors.push(`${label}: track "${bone}" has no keys`); continue; }
    const clean = [];
    let last = -Infinity;
    for (const k of keys) {
      const time = clampNum(k?.[0], 0, 0, duration);
      const rot = Array.isArray(k?.[1]) ? k[1] : [];
      // Times must ASCEND. Out-of-order keys do not fail loudly at runtime —
      // the sampler simply reads the wrong segment — so they are rejected here
      // rather than producing a motion nobody authored.
      if (time < last) { errors.push(`${label}: track "${bone}" has keys out of order`); break; }
      last = time;
      clean.push([time, [clampNum(rot[0], 0, -180, 180),
                         clampNum(rot[1], 0, -180, 180),
                         clampNum(rot[2], 0, -180, 180)]]);
    }
    if (clean.length) out.push({ bone, keys: clean });
  }
  return out;
}

export function normalizeAction(raw, { rig = "genesis9" } = {}) {
  const errors = [];
  const name = String(raw?.name || "").trim().slice(0, 80);
  if (!name) errors.push("it needs a name");

  const kind = ["reaction", "pose"].includes(raw?.kind) ? raw.kind : "action";
  const duration = clampNum(raw?.duration, 1, 0.05, 10);
  const action = {
    slug: slugify(raw?.slug || name),
    name,
    kind,
    duration,
    rig: RIGS[rig] ? rig : "genesis9",
  };
  if (!action.slug) errors.push("it needs a slug");

  if (kind === "pose") {
    // Held at its last frame until something else moves her.
    action.hold = raw?.hold !== false;
  }

  if (kind === "action") {
    action.contactAt = clampNum(raw?.contactAt, duration / 2, 0, duration);
    // What separation it was authored at. There is no IK and no contact test —
    // see the head of this file — so the distance is part of the action, not a
    // detail of the day it was made. A reaction has no such number: it happens
    // to a body wherever that body is standing.
    action.contactDistance = clampNum(raw?.contactDistance, 0.5, 0.2, 3);

    // Where the hand should actually LAND, resolved on the other body at play
    // time. This is the one place an action is allowed to know about the person
    // it is aimed at, and it stays portable because it names a BONE, not a
    // position: "the chin" is the chin on whoever is standing there, at
    // whatever height they happen to be.
    //
    // Optional. Without it the action plays exactly as authored, which is
    // correct for anything that is not a contact — a gesture, a shrug.
    if (raw?.aim) {
      const at = String(raw.aim.at || "chin").replace(/[^a-z0-9_]/gi, "").slice(0, 32);
      action.aim = {
        at: at || "chin",
        // How long either side of contact the aim is blended in. Wider drags
        // the whole arm toward the face and flattens the throw into a reach.
        window: clampNum(raw.aim.window, 0.18, 0.02, 1),
        weight: clampNum(raw.aim.weight, 1, 0, 1),
      };
    }
  }

  action.tracks = normalizeTracks(raw?.tracks, duration, errors, action.rig);
  if (!action.tracks.length) errors.push("nothing moves — it needs at least one track");
  return { action, errors };
}
