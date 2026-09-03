import { Fragment, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { MeshBVH, StaticGeometryGenerator } from "three-mesh-bvh";
import { buildLanding } from "./Landing.js";
import { loadDisplay, applyDisplay, DISPLAY_DEFAULTS, sunPosition } from "./exploreDisplay.js";
import styles from "./Scene.module.css";
import { attachKtx2 } from "../lib/gltfKtx2.js";

// ── DoorScene3D ──────────────────────────────────────────────────────────────
//
// Session 152 — you are outside, in a stairwell, at a door.
//
// The scene this replaces opened on a 140px circular photograph of the person
// behind the closed door, with "Knocking at the door…" underneath. The one face
// unavailable to you while you stand outside knocking is hers, and showing it
// gave away the answer before the question had been asked. Her four possible
// answers — open, ignore, pretend to be out, text you instead — all looked the
// same: the same portrait, a different caption.
//
// Here the door carries them. It opens, or the light goes out, or your phone
// goes. Her face arrives once, in the gap, and only if she lets you in.

const SIM = "https://anima.simulator.ngrok.dev";

// Session 152 kept her out of the doorway because glb_url was a bare body —
// no clothes, no hair — and "flip this to true when deploy exports a dressed
// model" was the condition. Session 153: it does. Deploy now ships
// runtime_<worldActorId>.glb — wardrobe baked in, morphs folded into the
// vertices, garments rebound to her skeleton, idle+walk clips — and
// KnockActorDoor passes it as glbUrl (editable glb_url remains the fallback
// for actors deployed before runtime models existed).
const SHOW_AVATAR = true;

// Session 153 — stepping inside.
//
// The door opening was always meant to hand over rather than end: "Enter
// button is not needed you just hand over to FPV walks around". These are the
// Explore-mode numbers from ActorModelPanel, copied rather than imported —
// that panel is a 3800-line component and this scene needs five constants and
// two functions out of it, not a dependency on it.
const EYE_HEIGHT     = 1.65;
const PLAYER_SPEED   = 1.5;   // m/s
const CAPSULE_RADIUS = 0.22;  // rough body radius

// Third-person rig (opt-in with ?cam=third). The first-person path is the
// default and is left exactly as it was: camera.position IS the player there,
// and a dozen unrelated things read it that way (door-vs-landing at z>-0.05,
// eye-to-eye, the dolly, distance-to-her). Rather than redefine that for
// everyone, third-person introduces a separate BODY position and derives the
// camera from it each frame, so every existing reader keeps meaning what it
// meant — it just now reads a point that is behind and above the body.
const CAM_BACK     = 2.45;   // metres behind the body
const CAM_UP       = 1.62;   // camera height above the floor
const CAM_SHOULDER = 0.42;   // right-shoulder offset, GTA/TLOU style
const CAM_MIN_BACK = 0.55;   // hard floor when a wall crowds the camera in
const CAPSULE_BOTTOM = 0.25;  // above floor — MUST be >= CAPSULE_RADIUS
const CAPSULE_TOP    = 1.5;
// Is the keyboard currently the chat's? Asked of the document every time,
// because any cached answer to this eventually goes stale in the wrong
// direction and silently disables walking.
// Media belongs to whatever host served this page, never to a host baked into
// the database.
//
// actors.glb_url / runtime_glb_url are stored ABSOLUTE, pointing at the public
// ngrok domain. Loaded from anywhere else — the LAN address, a second tunnel,
// localhost — that is a cross-origin fetch of an auth-gated file, and it does
// not fail politely: measured live 2026-09-03 from http://192.168.1.59 the
// fetch threw `TypeError: Failed to fetch` outright, loadHer set herFailed,
// openDoor opened onto the gap by design, and Lindsey simply was not in her
// own flat. The same file requested same-origin answered 200 with all
// 26,748,152 bytes of her.
//
// So keep the PATH and drop the host. /media/* is served by every host that
// serves this app, which is the whole point of it being a path.
function sameOriginMedia(u) {
  if (!u || typeof u !== "string") return u;
  const i = u.indexOf("/media/");
  return i > 0 ? u.slice(i) : u;   // i === 0 is already a bare path
}

function isTyping() {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

// Session 154 — Test Lab fixture mode.
//
// The lab builds an encounter that BEGINS at a chosen stage and sends you here
// with ?lab=<stage>&her=<room>&you=<room>. Only the arrival changes: at
// "inside" the door is already open and both of you are placed, because the
// run's authored past says you were let in. Everything after — her walking,
// her deciding, the conversation — is the same code any ordinary knock runs.
// Read at CALL time, never at module load: the lab navigates here with React
// Router, so the bundle was evaluated back on /lab where the query string was
// empty. A module-level const captured null and the fixture silently did
// nothing — the door opened by the ordinary path, in the ordinary place.
const readLab = () => {
  try {
    const q = new URLSearchParams(window.location.search);
    const stage = q.get("lab");
    if (!stage) return null;
    return { stage, her: q.get("her"), you: q.get("you") };
  } catch { return null; }
};

const UP = new THREE.Vector3(0, 1, 0);
// Scratch ray for the third-person wall clamp — allocated once, like the
// capsule scratch objects, because this runs every frame.
const _camRay = new THREE.Ray();
const _camTarget = new THREE.Vector3();
// Scratch for the dynamic door-leaf collision — per frame, allocated once.
const _leafH   = new THREE.Vector3();
const _leafQ   = new THREE.Quaternion();
const _leafDir = new THREE.Vector3();
// The door shot is framed at 50° (a 2.07m door, 2.8m back). Walking around
// wants a tighter lens: at 50 the flat — genuinely 3.9 x 11m — reads bigger
// than it is, because a wide lens shrinks whatever is far away. 45 is the
// editor's own "correct proportions" lens (FOV_ORBIT), so a room walked
// through here is the room seen there.
const FOV_DOOR = 50;
const FOV_FPV  = 45;

// Session 153 — ultrawide.
//
// three.js FOV is VERTICAL, so a wider window keeps the vertical angle and
// widens horizontally ("Hor+"), which is the right instinct: on 21:9 you
// simply see more of her flat. But it does not stop, and on 32:9 (3840×1080)
// 45° vertical becomes ~112° horizontal (and 5120×1440 is the same 3.56 —
// a better cable buys pixels, not geometry). Past about 100° rectilinear
// projection shears: straight lines bow and a person standing off-centre is
// visibly wrong.
//
// So each shot caps its own horizontal angle and lets the vertical give way
// past it, rather than letting the width run away.
// Two caps, because the two shots want opposite things:
//
// One cap, and it applies to walking only — see lensFor for why her door
// cannot have one. On 16:9 it is slack and nothing changes; on 21:9 it is
// still slack, so an ultrawide keeps the whole Hor+ benefit it paid for.
const MAX_H_WALK = 100;

function fovFor(baseVertical, aspect, maxHorizontal) {
  const capV = 2 * Math.atan(Math.tan((maxHorizontal * Math.PI) / 360) / aspect) * (180 / Math.PI);
  return Math.min(baseVertical, capV);
}

// Which shot is this? Position answers it honestly: past the threshold you are
// in her flat. Deliberately NOT walkMode — right-clicking to type would then
// push the lens in and out on every message, and the same test already decides
// whether the landing is drawn.
function lensFor(camera, maxHWalk = MAX_H_WALK) {
  // At her door: a composed shot, and it is framed by VERTICAL coverage. A
  // 2.07m door from 2.82m back needs ~50 degrees of it, and on 32:9 a
  // horizontal cap takes the vertical down with it — at 80 the frame holds
  // 1.33m and the top of her door is simply gone. Every cap at or under 100
  // does this, so there is no value that tightens the width AND keeps the
  // door: this shot keeps its lens and spends the extra width on landing
  // wall. Shear costs nothing where there is no subject, and here the
  // subject is dead centre.
  if (camera.position.z > -0.05) return FOV_DOOR;
  // Inside her flat you are the one moving and she is rarely centred. That is
  // where 112 degrees actually hurt, and so that is where the cap belongs.
  return fovFor(FOV_FPV, camera.aspect, maxHWalk);
}

// One row of the Display tab. Label left, current value right in gold, the
// control under it, and a line of consequence under that — a slider that does
// not say what it costs is a slider nobody dares move.
function Row({ label, value, hint, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase",
                       color: "rgba(255,255,255,.42)" }}>{label}</span>
        <span style={{ fontSize: 11, color: "rgba(201,151,58,.85)",
                       fontVariantNumeric: "tabular-nums" }}>{value}</span>
      </div>
      {children}
      {hint && <span style={{ fontSize: 9, color: "rgba(255,255,255,.24)",
                              lineHeight: 1.55 }}>{hint}</span>}
    </div>
  );
}

// Session 153 — a line is a line however it arrives.
//
// Her reply reaches this page twice by design: the SSE stream delivers it the
// moment she speaks, and the 3s reconcile re-reads conversation_log so a
// missed event still shows up. Both deduped on the EXACT string — and the two
// sources do not agree on the string. The stream carries what she said with
// its *stage directions* intact; the log has them stripped. Same sentence,
// different characters, two bubbles, one of them visibly amputated ("...this
// sort of… ." with the gesture cut out of the middle).
//
// So dedupe on what the line MEANS: drop the directions, the quotes and the
// punctuation, and compare that. Display keeps the richer version, because
// the asterisks are the half worth reading.
const canonical = (t) => (t || "")
  .replace(/\*[^*]*\*/g, " ")
  // the server also strips UNPAIRED *tails from the log copy; without this a
  // reply ending in an unclosed direction can never match its claim
  .replace(/\*[^*\n]*/g, " ")
  .replace(/["\u201c\u201d]/g, "")
  .replace(/[\s.,\u2026]+/g, " ")
  .trim()
  .toLowerCase();

// The bubble IS the quotation mark. A model that wraps its dialogue in quotes
// as well — inconsistently, line to line — is just adding furniture, and it
// looks like she is quoting someone else.
const unwrapQuotes = (s) => {
  let v = (s || "").trim();
  for (let i = 0; i < 2; i++) {
    if (v.length > 1 && /^["\u201c]/.test(v) && /["\u201d]$/.test(v)) v = v.slice(1, -1).trim();
    else break;
  }
  return v;
};

// The model sometimes echoes the prompt's own scaffolding back as dialogue —
// a leading [REQUIRED]-style label, a "Lindsey Vaughn:" speaker tag, or both.
// The server parser strips these too now, but lines already in the log from
// before the fix, and any path that misses the parser, land here.
const stripScaffold = (t) => (t || "")
  .replace(/^\s*(?:\[[^\]\n]{1,60}\]\s*)+/, "")
  .replace(/^\s*[A-Z][\p{L}'-]+(?: [A-Z][\p{L}'-]+){1,2}\s*:\s+/u, "")
  // ...and TRAILING labels: observed live as a reply ending in "[REQUIRED]" —
  // the format scaffold echoed at the tail instead of the head. TTS tags like
  // [laugh] are lowercase; only ALL-CAPS labels are stripped here.
  .replace(/\s*(?:\[[A-Z][A-Z _-]{1,40}\]\s*)+$/, "");

const stripWrappingQuotes = (t) => unwrapQuotes(stripScaffold(t))
  // A line that mixes *stage directions* with speech only quotes the SPEECH,
  // so unwrap each spoken run BETWEEN the directions as well as the whole
  // line. Splitting on the directions and not on spaces matters: it is what
  // keeps a genuine nested quotation — He said "no" and left — intact, while
  // still unwrapping *Smooths down her skirt* "You're awfully casual."
  .split(/(\*[^*]*\*)/)
  .map(part => (part.startsWith("*") ? part : unwrapQuotes(part)))
  .join(" ")
  .replace(/\s+/g, " ")
  .replace(/\s+([.,!?;:\u2026])/g, "$1")
  .trim();

// Session 153 — the conversation log is not all conversation.
//
// It also carries scaffolding written FOR the model — "[Player interrupted —
// your previous response was cut off. Acknowledge naturally if appropriate.]"
// arrives as from:"system". The reconcile treated anything that was not the
// player as HER, so she appeared in her own chat panel reading the stage
// management aloud. Roles first, and a bracket guard for the cases that
// arrive with no role to mark them.
const MACHINERY_ROLES = new Set(["system", "tool", "meta", "note", "developer"]);
const isMachinery = (from, text) =>
  MACHINERY_ROLES.has((from || "").toLowerCase()) || /^\[[^\]]*\]$/.test((text || "").trim());

const SETTING_KEYS = { scale: "anima.door.renderScale", cap: "anima.door.fovCap",
                       aspect: "anima.door.maxAspect" };

// Session 153 — an aspect ceiling, because a maximised window is not the
// display it is maximised on.
//
// On a 32:9 panel the desktop is 2560x720 points, but a maximised window only
// gets 2560x616 of it: the menu bar and title bar take height and no width, so
// the frame comes out at 4.16 — WIDER than the monitor. Holding the 100°
// horizontal cap there costs a 32° vertical slit. Fullscreen is exactly 3.556
// and has no such problem, but nobody should have to know that.
//
// 0 means "use the whole window", which stays the default: on any ordinary
// screen the window is never wide enough for this to engage.
// Session 153 — the character tab's own controls, same keys, same ranges.
//
// Copied rather than imported for the same reason exploreDisplay copies the
// contract: this scene has no editing in it and should not drag the editor in
// behind a slider. Both write users.preferences.exploreDisplay, so a change
// made standing in her kitchen is the change the editor opens with.
const DISPLAY_CONTROLS = [
  { key: "exposure",         label: "Exposure",      min: 0.2, max: 2,   step: 0.05 },
  { key: "envIntensity",     label: "Environment",   min: 0,   max: 2,   step: 0.05 },
  { key: "keyIntensity",     label: "Key light",     min: 0,   max: 2,   step: 0.05 },
  { key: "sunAzimuth",       label: "Sun direction", min: 0,   max: 360, step: 1, deg: true },
  { key: "sunElevation",     label: "Sun height",    min: 10,  max: 80,  step: 1, deg: true },
  { key: "ambientIntensity", label: "Ambient",       min: 0,   max: 1,   step: 0.05 },
  { key: "rimIntensity",     label: "Rim light",     min: 0,   max: 1,   step: 0.05 },
];

// Session 153 — the five rooms she can name, and where they are in this flat.
//
// The simulator's SCENE block constrains her to exactly these:
//   location: hall | living_room | bedroom | kitchen | bathroom
// with an explicit rule that if she beckons or leads you somewhere, location
// is the DESTINATION. So her own words already say where she is going; the
// scene simply was not listening. She stood where a script had put her.
//
// Anchors measured from the flat's own geometry rather than guessed: the
// studio runs z 0 (her front door) to -8.9 (far wall), with the bathroom door
// at z -1.03, the kitchen counter at -2.5..-3.1, the sofa spanning -5.1..-8.0
// and the armchair at -8.1. She stands in the room, not inside the furniture.
//
// bathroom is the door, not the room: it is a sealed box in this model and
// walking her into it would put her through a wall.
// Measured against the COLLIDER, not read off furniture. The first version of
// this table was derived from where the sofa and the kitchen counter sit, and
// three of the five landed inside walls — the hall anchor had 4cm of clearance,
// which put her head through the plasterboard and looked, from the doorway,
// exactly like a rendering bug. The open corridor of this flat runs at x~0.0
// down to z -3.4 and then swings to x~1.0; the furniture does not tell you that.
const ROOM_ANCHORS = {
  hall:        { x: 0.0, z: -0.60 },   // 0.86m clear
  bathroom:    { x: 0.0, z: -1.20 },   // 0.81m — at the door; the room is sealed
  kitchen:     { x: 0.0, z: -2.80 },   // 0.87m
  living_room: { x: 1.0, z: -5.40 },   // 0.93m
  bedroom:     { x: 1.0, z: -7.80 },   // 0.88m
};

// She does not always use the five words the prompt gave her. Observed live:
// "location":"apartment" — not a room in this flat, so walkHerTo found no
// anchor and returned SILENTLY, which is how the whole thing stayed invisible.
// Take what she means, and say so out loud when she names somewhere that
// does not exist.
const ROOM_ALIASES = {
  apartment: "living_room", flat: "living_room", inside: "living_room",
  home: "living_room", lounge: "living_room", living: "living_room",
  living_room: "living_room", livingroom: "living_room", sitting_room: "living_room",
  sofa: "living_room", couch: "living_room", front_room: "living_room",
  hall: "hall", hallway: "hall", entrance: "hall", entry: "hall",
  doorway: "hall", door: "hall", corridor: "hall",
  kitchen: "kitchen", galley: "kitchen", kitchenette: "kitchen",
  bedroom: "bedroom", bed: "bedroom",
  bathroom: "bathroom", bath: "bathroom", toilet: "bathroom", washroom: "bathroom",
};

// Which part of the flat a point is in — nearest anchor wins. Used to tell
// her where the player is standing, so "come over here" has a "here" in it.
const roomOfPoint = (x, z) => {
  let best = "hall", bd = Infinity;
  for (const [k, a] of Object.entries(ROOM_ANCHORS)) {
    const d = Math.hypot(a.x - x, a.z - z);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
};

const normaliseRoom = (raw) => {
  const k = (raw || "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  return ROOM_ANCHORS[k] ? k : (ROOM_ALIASES[k] || null);
};

// She narrates movement the location field does not carry: "steps into her
// apartment, gesturing for Magnus to follow" arrived with location "hall",
// which is where she already stood. The words are the truth of the scene, so
// read them when the field says nothing changed.
const MOVES_INSIDE = /\b(?:steps?|step(?:ping|ped)|walks?|walk(?:ing|ed)|heads?|head(?:ing|ed)|moves?|mov(?:ing|ed))\s+(?:in|inside|into|through)\b|\b(?:talk|talking|chat|chatting|sit|sitting|settle|go|going)\s+inside\b|\bcome\s+(?:on\s+)?in\b|\bfollow\s+me\b|\blet'?s\s+go\s+(?:in|inside)\b|\bgestur\w*\s+for\s+\w+\s+to\s+follow\b|\bletting\s+\w+\s+follow\b/i;

// How much room she needs around her before a spot counts as standing room.
const HER_CLEARANCE = 0.45;
// How close she will stand to you unasked. HER_CLEARANCE is about walls;
// this is about people, and the two are not the same number.
const PERSONAL_SPACE = 0.85;

const ASPECT_CHOICES = [["Native", 0], ["32:9", 32 / 9], ["21:9", 21 / 9], ["16:9", 16 / 9]];
const readSetting = (key, fallback) => {
  const v = parseFloat(localStorage.getItem(key));
  return Number.isFinite(v) ? v : fallback;
};
const _capSegment = new THREE.Line3();
const _capBox     = new THREE.Box3();
const _triPoint   = new THREE.Vector3();
const _capPoint   = new THREE.Vector3();
const _pushDir    = new THREE.Vector3();
const _steerEuler = new THREE.Euler(0, 0, 0, "YXZ");
const _eyeMatrix  = new THREE.Matrix4();
const _eyeQuat    = new THREE.Quaternion();

// ?cam=third turns the over-the-shoulder rig on. Absent, nothing below runs
// and the scene behaves exactly as it did in first person.
const THIRD_PERSON = (() => {
  try { return new URLSearchParams(window.location.search).get("cam") === "third"; }
  catch { return false; }
})();

export default function DoorScene3D({ world, user, sceneData, actorName, actorId, glbUrl, playerGlbUrl, onLeave }) {
  const routerNavigate = useNavigate();
  const { location, encounter_id, rejoined } = sceneData;

  const host      = useRef(null);
  const sceneRoot = useRef(null);
  const api       = useRef({});      // three objects, kept out of React state
  const [phase,     setPhase]     = useState(encounter_id ? "knocking" : "empty");
  const [decision,  setDecision]  = useState(null);
  const [narrative, setNarrative] = useState("");
  const [loadPct,   setLoadPct]   = useState(null);
  const [ready,     setReady]    = useState(false);   // everything is on screen
  // Full-bleed spinner until the flat, her avatar, and (third person
  // only) the player body have all actually landed — "the scene is
  // loaded before the user character is positioned and loaded". The
  // canvas has painted from the first frame all along; this only gates
  // what covers it.
  const [sceneVisible, setSceneVisible] = useState(false);
  // An encounter whose process is gone (world restarted under a live
  // scene) answers 404 to every message and every poll. Both used to be
  // swallowed silently — the typing dots span forever and the scene was
  // indistinguishable from a hung model with no voice. Measured live
  // 2026-09-03: knocked 20:42:53, a peer restart killed the process at
  // 20:43:41, and three messages 404'd over the next five minutes with
  // nothing on screen ever saying so.
  const [encounterGone, setEncounterGone] = useState(false);
  const goneRef      = useRef(0);      // consecutive 404s; one is a blip
  const goneShownRef = useRef(false);  // say it once, not every poll

  // ── stepping inside, and talking once you are ───────────────────────────
  const [inside,    setInside]    = useState(false);  // pointer lock held
  const [narrativeGone, setNarrativeGone] = useState(false);
  const [panelHidden, setPanelHidden] = useState(false);
  const panelHiddenRef = useRef(false);
  const [lockError, setLockError] = useState(null);
  const [chatOpen,  setChatOpen]  = useState(false);
  // Session 153 — the right dock holds two things now, so it has tabs.
  const [tab, setTab] = useState("chat");
  const [renderScale, setRenderScale] = useState(() => readSetting(SETTING_KEYS.scale, 1));
  const [fovCap,      setFovCap]      = useState(() => readSetting(SETTING_KEYS.cap, MAX_H_WALK));
  const [maxAspect,   setMaxAspect]   = useState(() => readSetting(SETTING_KEYS.aspect, 0));
  const [stats, setStats] = useState({ fps: 0, w: 0, h: 0 });
  const [display, setDisplay] = useState(null);   // the saved lighting, live
  // Session 153 — her vitals, back on screen. The old presence view carried
  // these and the deltas were the most legible thing in it: you could watch a
  // sentence land. energy/mood/desire/sobriety are what the engine sends.
  const [eyeToEye, setEyeToEyeUI] = useState(false);
  const [vitals, setVitals] = useState(null);
  const [changedVitals, setChangedVitals] = useState({});
  const [vitalToasts, setVitalToasts] = useState([]);
  const prevVitalsRef = useRef(null);
  const displaySettledRef = useRef(false);        // the first value IS the saved one
  const [chatInput, setChatInput] = useState("");
  const [messages,  setMessages]  = useState([]);
  const [sending,   setSending]   = useState(false);
  const [responding, setResponding] = useState(false);

  const chatInputRef = useRef(null);
  const messagesEndRef = useRef(null);
  const replyTimerRef = useRef(null);
  const enteredRef = useRef(false);
  const lastReplyRef = useRef(null);
  const seenRef = useRef(new Set());          // SSE-duplicate guard only, no longer the log dedupe
  // Session 153 — the log is rendered by POSITION, not by content.
  //
  // Content-dedupe swallowed a legitimate repeat: interrupted mid-greeting,
  // she answered by saying the same sentence again — entry 3 of the log,
  // canonical-equal to entry 1 — and the client threw it away as a duplicate
  // while the typing dots ran forever. People repeat themselves; an ordered
  // log needs an ordered cursor, and dedupe belongs only where the actual
  // server bug lives: the SAME line written twice in ADJACENT entries.
  const logCursorRef = useRef(0);
  // Debug tap, same convention as window.__door: the chat pipeline was
  // failing invisibly (poll running, log populated, panel empty) and every
  // theory needed a rebuild to test. Now it can be asked directly.
  if (typeof window !== "undefined") {
    window.__chat = window.__chat || {};
    window.__chat.cursor = logCursorRef;
    window.__chat.trace = window.__chat.trace || [];
  }
  const streamedRef  = useRef([]);   // canonical(actor lines already shown via SSE/stream)
  const localMineRef = useRef([]);   // canonical(my lines already shown locally on send)
  const typingPingRef = useRef(0);   // last time we told her he is typing
  // Session 153 — the live token stream, as the old presence view had it.
  const streamRef = useRef({ text: "", live: false });
  // Session 154 — her voice. The server has broadcast encounter_tts wavs all
  // along; this scene dropped them at the door (see the onmessage guard).
  const ttsQueueRef = useRef({});   // { [index]: HTMLAudioElement }
  const ttsNextIdx  = useRef(0);
  const ttsPlaying  = useRef(false);
  const ttsWatchdog = useRef(null);
  // Session 154 — her bubbles keep pace with her voice, the way the old chat
  // did. Tokens buffer per SENTENCE; a sentence's text reveals word-by-word
  // across the duration of its own audio clip, starting when the clip starts.
  // If no clip shows up within 2.5s the sentence flushes plain — a dead TTS
  // host must never hold her words hostage. Sentence indexes mirror the
  // server's: it strips *actions* BEFORE splitting, so we do too; the final
  // settle restores the raw text, actions included.
  const syncRef = useRef({ raw: "", sentences: [], timers: {}, revealTimer: null, inflight: null, pendingFinal: null, finalGuard: null });
  const sendMessageRef = useRef(null);

  // Her words arrive whole over SSE and are revealed a word at a time — the
  // same shape KnockingDoorScene used, kept so the two scenes feel identical.
  const playerActorId = user?.worlds?.find(w => w.world_id === world?.id)?.actor_id
                     || sceneData?.player_actor_id || null;

  // With the encounter model on a host that is currently down, a real knock can
  // only ever time out — so the scene can be driven by hand to look at it.
  // ?rehearse=open | ignore | text | error
  const rehearse = new URLSearchParams(window.location.search).get("rehearse");

  // ── the room ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070605);
    scene.fog = new THREE.Fog(0x070605, 7, 15);

    // A 2.07m door needs about 2.9m of frame to breathe, and at 50 degrees
    // vertical that means standing 2.8m back. The first pass used 42 degrees at
    // 1.6m, which is close enough to touch the handle: the leaf filled the frame
    // top to bottom with no floor, no mat and no hall, and a dark paint read as
    // a black rectangle because there was nothing else in shot to judge it by.
    const camera = new THREE.PerspectiveCamera(
      FOV_DOOR,
      el.clientWidth / el.clientHeight, 0.05, 60);
    // Eye height, and a touch off-centre — standing square to a door is a lift,
    // not a person.
    camera.position.set(0.2, 1.62, 2.82);
    camera.lookAt(0, 1.14, 0);
    // The body starts where the eye is. From here on, in third person, the
    // body is the thing that walks and the camera is derived from it.
    const body = camera.position.clone();
    // ...except on the landing, which is a 3.7m box. First person put the eye
    // at z=2.82 to knock, leaving 0.9m to the back wall — no room at all for a
    // camera 2.45m behind. Standing him nearer the door is both what the rig
    // needs and what a person actually does at a door: close enough to reach
    // the handle. Only in third person; first person keeps its framing.
    if (THIRD_PERSON) body.z = 1.15;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    // Capped at 2 so a Retina panel does not quietly quadruple the fill, then
    // scaled by the saved preference — this is the render-scale knob, and it is
    // the one thing left that still means what "change the resolution" meant.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * readSetting(SETTING_KEYS.scale, 1));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = DISPLAY_DEFAULTS.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Session 153 — she was dark in here and lit on the character tab, with
    // the same saved numbers in both. This is why: PBR expects an environment
    // to reflect, and this scene had none. The editor builds a neutral studio
    // box at runtime (RoomEnvironment through PMREM, no asset to ship) and
    // notes that with the environment carrying most of the load the direct
    // lights only SHAPE. Three lights and nothing to reflect is not the same
    // room lit differently — it is a different renderer.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    pmrem.dispose();
    // Absolutely centred, so when the aspect ceiling makes the canvas
    // narrower than the window the leftover becomes an even bar either side
    // rather than a shove to one corner.
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.left = "50%";
    renderer.domElement.style.top = "50%";
    renderer.domElement.style.transform = "translate(-50%, -50%)";
    // Session 153 — and UNDER the overlays, explicitly.
    //
    // Making the canvas absolute (for the aspect-ratio centring) moved it into
    // the positioned stacking order, where DOM order decides — and the canvas
    // is appended LAST. From that moment it painted over every overlay in the
    // host that lacked a z-index: the refusal caption, the Walk away button,
    // the load percentage. The vitals HUD survived only because it happened to
    // carry zIndex 12. A refusal therefore rendered as a bare door — the text
    // was in the DOM, measured present, and painted underneath the scene.
    // -1 keeps it above the host's own black (the aspect bars) and below
    // everything React draws.
    renderer.domElement.style.zIndex = "-1";
    el.appendChild(renderer.domElement);

    // The three lights the 3D character tab configures. Created at its defaults
    // and then set from whatever the user saved, so the flat behind this door
    // is lit exactly like the flat on that tab.
    // Session 153 — the same hex as the editor, not a warmer one chosen by eye.
    // A hemisphere light's second colour is the bounce from below; 0x3a352c is
    // a warm brown and 0x444455 is the cool grey ActorModelPanel uses, so the
    // identical saved settings were lighting her flat two different colours in
    // the two places you can stand in it. Same for the rim: 0xaaccff there.
    const ambient = new THREE.HemisphereLight(0xffffff, 0x444455, DISPLAY_DEFAULTS.ambientIntensity);
    const key = new THREE.DirectionalLight(0xffffff, DISPLAY_DEFAULTS.keyIntensity);
    // Session 153 — your shadow settings were read and then thrown away.
    //
    // applyDisplay honours `shadows` by flipping renderer.shadowMap.enabled,
    // and it was flipping ON — but the key light itself was never told to cast,
    // so the flat rendered shadowless with the setting reading true. These are
    // the editor's numbers verbatim (ActorModelPanel key.shadow.*), because
    // that panel lights this same flat and the whole point of exploreDisplay
    // is that the same settings mean the same light in both places.
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 12;
    key.shadow.camera.left = -4;
    key.shadow.camera.right = 4;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -4;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.03;
    const rim = new THREE.DirectionalLight(0xaaccff, DISPLAY_DEFAULTS.rimIntensity);
    rim.position.set(-2.6, 2.2, -3.4);
    // Session 153 — the shadow box has to travel with her.
    //
    // A directional light's shadow camera is ±4m around its target, and the
    // editor's target is the origin because the editor frames one person at
    // the origin. This flat is 11m deep: past about four metres in, her shadow
    // would simply stop. So the light aims at a target that follows her, and
    // is repositioned to keep the sun's DIRECTION fixed while it does.
    const sunTarget = new THREE.Object3D();
    scene.add(sunTarget);
    key.target = sunTarget;
    scene.add(ambient, key, rim);

    const landing = buildLanding(scene, {
      placeId: location?.place_id || location?.id || "",
      surname: (actorName || "").split(" ").slice(-1)[0],
    });
    console.log("[door]", landing.paint, "·", landing.panels, "panels ·",
                landing.brass ? "brass" : "steel");

    // Session 153 — the controls that take over once you step inside. Created
    // with the scene but inert until lock() is called: a browser only grants
    // pointer lock inside a real user gesture, so the handover is one click on
    // the open doorway, never automatic.
    const fpv = new PointerLockControls(camera, renderer.domElement);
    const keys = new Set();
    const onKeyDown = (e) => {
      // While the chat has focus the keyboard belongs to the chat, not to the
      // feet — otherwise typing "was" walks you into the sofa. Session 153:
      // asked of the DOM rather than read off a flag. The flag version got
      // stuck true whenever blur did not fire, and every key after that was
      // swallowed in silence — which is exactly what "WASD is not working"
      // looks like from the outside.
      if (isTyping()) return;
      keys.add(e.code);
      // Says, once, why a movement key did nothing. Costs one line and turns
      // "WASD is not working" into a fact instead of a hypothesis.
      if (!api.current.movedOnce && !api.current.canWalk &&
          /^(KeyW|KeyA|KeyS|KeyD|Arrow)/.test(e.code) && !api.current.warnedNoWalk) {
        api.current.warnedNoWalk = true;
        console.warn("[door] movement key before the door is open — nothing to walk into yet.");
      }
      if (e.code.startsWith("Arrow")) e.preventDefault();
    };
    const onKeyUp = (e) => keys.delete(e.code);
    const onBlur  = () => keys.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    api.current = { scene, camera, renderer, landing, el, clock: new THREE.Clock(), timer: new THREE.Timer(),
                    abort: new AbortController(), ambient, key, rim, fpv, keys, sunTarget,
                    maxHWalk: readSetting(SETTING_KEYS.cap, MAX_H_WALK),
                    maxAspect: readSetting(SETTING_KEYS.aspect, 0) };

    // Taking the mouse ends the scripted camera move — from here you are
    // driving. Releasing it (Esc) hands nothing back; you keep where you stand.
    // Session 153 — walk mode is a MODE, entered and left deliberately.
    //
    // Left-click the room to take it: the cursor goes, the mouse looks, WASD
    // walks. Right-click gives it back. Pointer lock is requested because it
    // is the better implementation when the browser grants it — the pointer
    // genuinely cannot leave the window — but the mode does not depend on it,
    // so a refused lock costs you nothing but the pointer staying put.
    // Session 153 — an encounter is fullscreen by default.
    //
    // Knocking on someone's door is not a panel in a page, so the scene takes
    // Session 153 — the scene does NOT take the screen any more.
    //
    // Clicking the room used to call requestFullscreen, on the reasoning that
    // an encounter deserves the whole display. In the desktop shell that was
    // a trap: macOS will not let a fullscreen window be moved or resized, and
    // it hides the traffic lights, so one click into her flat left the window
    // stuck with no way back out except Esc. Walk mode never needed it —
    // pointer lock works perfectly well in a windowed page, which is measured
    // and not assumed.
    //
    // Window size is the OS's business. The green button, the menu's Toggle
    // Full Screen, and the edges of the window all still work; they just work
    // when YOU ask, not when you look at her hallway.

    const enterWalk = () => {
      const a = api.current;
      if (a.walkMode || !a.canWalk) return;
      a.walkMode = true;
      a.dolly = null;
      a.keys.clear();
      if (isTyping()) document.activeElement.blur();
      setChatOpen(false);
      // Exclusive: the cursor goes everywhere, not just over the canvas.
      // Hiding it on the canvas alone meant it reappeared the moment you moved
      // over the chat panel, and the panel stayed clickable underneath it.
      // the .anima-walking class does the hiding — see the cursor effect
      // The lens is not set here — it follows the shot, and tick eases it.
      setInside(true);
      requestLock();
    };

    // Ask for the pointer ourselves rather than through controls.lock().
    //
    // three's lock() calls requestPointerLock({unadjustedMovement}) and drops
    // the promise on the floor: a rejection surfaces only as "Uncaught (in
    // promise)" in the console, and a browser that refuses the OPTIONS form
    // gets no second try without them. unadjustedMovement only disables mouse
    // acceleration, which nothing here needs, so the plain call is both more
    // compatible and the one to fall back to.
    //
    // three still notices success on its own — it listens for pointerlockchange
    // on the document — so isLocked stays correct either way.
    // Session 153 — ask the permissions policy before asking for the pointer.
    //
    // Measured in the Claude desktop app: allowsFeature('pointer-lock') is
    // false while fullscreen is true. Requesting anyway produces a SecurityError
    // that looks like a bug in the page, and dragging the user into fullscreen
    // to retry a thing that is categorically forbidden is worse than useless.
    const lockAllowed = (() => {
      try {
        const fp = document.featurePolicy || document.permissionsPolicy;
        return fp?.allowsFeature ? fp.allowsFeature("pointer-lock") : true;
      } catch { return true; }
    })();
    if (!lockAllowed) {
      api.current.lockBlocked = true;
      console.warn("[door] pointer lock is disallowed by this surface's permissions policy " +
        "— mouse-look falls back to edge steering. A normal browser window will capture properly.");
    }

    const requestLock = () => {
      if (!lockAllowed) { api.current.lockError = "blocked"; setLockError("blocked"); return; }
      const el = renderer.domElement;
      const host = el.parentElement || el;

      // Session 153 — trapping the pointer for real.
      //
      // A bare requestPointerLock is refused when the document is not focused
      // or its frame tree is not the primary one (measured here: hasFocus()
      // false on a perfectly visible page). Fullscreen fixes both — it forces
      // focus and promotes the element — which is why every browser game asks
      // for the two together. Both calls are made INSIDE the click gesture,
      // because a promise continuation is no longer a user activation and the
      // second request would be refused on that ground instead.

      const fail = (err) => {
        const name = err?.name || String(err || "unknown");
        api.current.lockError = name;
        setLockError(name);
        console.warn("[door] pointer lock refused:", name,
          window.self !== window.top
            ? "— page is in an iframe; it needs allow=\"pointer-lock\" or a normal browser window"
            : "");
      };
      try {
        // Pointer lock is refused outright unless the document has focus —
        // measured here as hasFocus() === false while the page was perfectly
        // visible, which is what produced "the root document of this element
        // is not valid for pointer lock". Claim focus first; it costs nothing
        // when we already have it.
        if (!document.hasFocus()) { window.focus(); el.focus?.({ preventScroll: true }); }
        const p = el.requestPointerLock();
        if (p && typeof p.catch === "function") {
          p.then(() => { api.current.lockError = null; setLockError(null); }).catch(fail);
        }
      } catch (err) {
        fail(err);
      }
    };

    // The transition finishes after the gesture, so try again here: by now the
    // document is focused and the element is the fullscreen one, which is
    // exactly the state a refused lock was missing.
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) {
        // Left fullscreen (Esc) — leave walk mode with it, rather than
        // stranding a hidden cursor in a windowed page.
        if (api.current.walkMode) exitWalk();
        return;
      }
      if (api.current.walkMode && !fpv.isLocked) requestLock();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);

    const exitWalk = () => {
      const a = api.current;
      if (!a.walkMode) return;
      a.walkMode = false;
      a.keys.clear();                   // no key left held down on the way out
      renderer.domElement.style.cursor = "";
      document.body.style.cursor = "";
      setInside(false);
      if (fpv.isLocked) fpv.unlock();
      // Deliberately NOT leaving fullscreen. Walk mode and fullscreen are
      // different things now that the encounter is fullscreen by default:
      // right-clicking to type in the chat should hand back the cursor, not
      // collapse the whole scene back into a page. Esc leaves fullscreen (the
      // browser's own gesture) and the handler below releases the look with it.
    };

    api.current.enterWalk = enterWalk;
    api.current.exitWalk = exitWalk;

    // Esc is the browser's own way out of pointer lock and cannot be
    // intercepted, so leaving the lock must leave the mode with it.
    fpv.addEventListener("lock", () => {
      api.current.lockError = null;
      setLockError(null);
      if (!api.current.walkMode) enterWalk();
    });
    fpv.addEventListener("unlock", () => exitWalk());

    // Right-click leaves, the way it does in a game. Esc leaves too and always
    // will — releasing pointer lock on Esc is enforced by the browser and
    // cannot be intercepted — so this is a second way out, not the only one.
    // Look around by dragging, for every case where pointer lock is refused —
    // an iframe without allow="pointer-lock", a browser that declines the
    // gesture, a lock silently dropped. PointerLockControls drives the camera
    // when it IS locked; this takes over only when it is not, so the two can
    // never fight over the same rotation.
    const look = new THREE.Euler(0, 0, 0, "YXZ");
    // Left button takes the mode. (When pointer lock is granted the browser
    // fires 'lock' too; enterWalk is idempotent so it only runs once.)
    const onDown = (e) => {
      if (e.button !== 0) return;
      if (!api.current.canWalk) return;
      // Session 153 — a click while ALREADY in walk mode retries the lock.
      //
      // This is the gap that left the pointer loose in fullscreen. The first
      // click asks for the lock while the page is still windowed; if that is
      // refused we go fullscreen, but the retry fires from the
      // fullscreenchange handler, which is NOT a user activation and is
      // refused on that ground. enterWalk() then early-returned on every
      // later click, so no trusted gesture ever asked again — with fullscreen
      // active, focus held, and the answer likely yes.
      if (api.current.walkMode) {
        if (!fpv.isLocked && !document.pointerLockElement) requestLock();
        return;
      }
      enterWalk();
    };
    const onUp = () => {};
    // In walk mode the mouse looks — no button held. When pointer lock IS
    // active PointerLockControls is already doing this, so stand aside.
    const onMove = (e) => {
      if (!api.current.walkMode) return;
      const r = renderer.domElement.getBoundingClientRect();
      api.current.pointer = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
      api.current.pointerOutside = false;
      if (fpv.isLocked) return;
      look.setFromQuaternion(camera.quaternion);
      look.y -= (e.movementX || 0) * 0.0022;
      look.x -= (e.movementY || 0) * 0.0022;
      const lim = Math.PI / 2 - 0.02;
      look.x = Math.max(-lim, Math.min(lim, look.x));
      camera.quaternion.setFromEuler(look);
    };
    // The pointer leaving the document, or the window losing focus, both mean
    // "stop steering" — and re-entering means resume.
    // Session 153 — the pointer leaving the window ends walk mode outright.
    //
    // Freezing the steering was the timid version: the cursor was gone to the
    // OS, but the scene still believed it had you — hidden pointer, keys live,
    // nothing moving. Handing the mode back is honest about what just
    // happened, gives the cursor back, and one click puts you straight back
    // in. (With pointer lock held this can never fire, because the pointer
    // cannot leave.)
    const onPointerGone = () => {
      api.current.pointerOutside = true;
      if (api.current.walkMode) exitWalk();
    };
    const onPointerBack = () => { api.current.pointerOutside = false; };
    document.addEventListener("mouseleave", onPointerGone);
    document.addEventListener("mouseenter", onPointerBack);
    window.addEventListener("blur", onPointerGone);
    window.addEventListener("focus", onPointerBack);

    renderer.domElement.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointermove", onMove);

    // Right-click leaves walk mode and gives the cursor back — the game
    // gesture, and it works whether or not pointer lock was ever granted.
    const onContext = (e) => {
      if (!api.current.walkMode) return;
      e.preventDefault();
      exitWalk();
    };
    renderer.domElement.addEventListener("contextmenu", onContext);
    // Reaching into a running scene beats guessing at it from a screenshot.
    // stepPlayer is hung on here deliberately, same reason __checkRuntimeWalk
    // and __skinDebug exist: requestAnimationFrame does not run in a hidden
    // tab, so walking can only be verified by driving frames by hand —
    //   const a = window.__door; a.fpv.isLocked = true; a.keys.add("KeyW");
    //   for (let i = 0; i < 180; i++) a.stepPlayer(1/60, a.camera);
    window.__door = api.current;
    api.current.stepPlayer = stepPlayer;
    api.current.stepHer = stepHer;
    api.current.steerLook = steerLook;
    api.current.body = body;             // third person: the thing that walks
    api.current.thirdPerson = THIRD_PERSON;
    api.current.walkHerTo = walkHerTo;   // drive her from the console: __door.walkHerTo('kitchen')
    api.current.walkHerToMe = walkHerToMe;
    api.current.setEyeToEye = setEyeToEye;   // __door.setEyeToEye(true)
    api.current.roomAnchors = ROOM_ANCHORS;

    // Session 152 — knocking and loading happen at the same time.
    //
    // The flat used to wait for her answer, which meant the interesting case
    // paid for it twice: she opens, and only then does ten megabytes start
    // moving. A knock takes seconds of dead time either way, so it buys the
    // load. If she does not open, the download is cancelled and thrown away
    // — the cheap outcome should cost nothing.
    loadFlat();
    // Session 153 — her download starts with the knock, not with the open.
    // At 92MB waiting for the decision was the right trade; at 26.7MB the
    // ghost it produced (a door swinging open onto an empty gap while she
    // streamed in) is worse than the bytes a refusal throws away. abandon()
    // cancels this fetch the same as the flat's if she doesn't open.
    loadHer();
    loadMe();
    loadDisplay({ signal: api.current.abort.signal }).then(d => {
      const a = api.current;
      if (!a.scene) return;
      a.display = d;
      applyDisplay(d, { renderer: a.renderer, scene: a.scene,
                        key: a.key, ambient: a.ambient, rim: a.rim });
      // applyDisplay places the key absolutely; keep that vector as the offset
      // so the light can follow a target without changing the sun's angle.
      a.sunOffset = new THREE.Vector3(...sunPosition(d));
      aimSun();
      setDisplay(d);          // hand it to the sliders
      console.log("[door] lighting from your saved settings:", d);
    });

    const onResize = () => {
      if (!el.clientWidth) return;
      let cw = el.clientWidth, ch = el.clientHeight;
      const maxA = api.current.maxAspect || 0;
      // Only ever narrows. A window that is already the right shape, or
      // taller than the ceiling, is left completely alone.
      if (maxA > 0 && cw / ch > maxA) cw = Math.round(ch * maxA);
      camera.aspect = cw / ch;
      camera.fov = lensFor(camera, api.current.maxHWalk);
      camera.updateProjectionMatrix();
      applyEyeAperture();
      renderer.setSize(cw, ch);
    };
    api.current.resize = onResize;
    window.addEventListener("resize", onResize);

    let raf, t = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      // Session 153 — clamp the step, or one slow frame skips the whole scene.
      //
      // This is why her door was "never visible swinging": openDoor fires the
      // instant her 26MB GLB finishes parsing, which blocks the main thread
      // hard, so the very next getDelta() came back with hundreds of
      // milliseconds. The swing lerps by min(1, dt * 2.2) — at dt > 0.45 that
      // factor IS 1, and the door went from shut to fully open inside a single
      // frame. Nothing was broken about the animation; it simply ran to
      // completion before anything was drawn.
      //
      // Raw time still drives the frame counter, because a stall is exactly
      // what a frame counter is supposed to report.
      api.current.timer.update();
      const rawDt = api.current.timer.getDelta();
      const dt = Math.min(rawDt, 0.05);
      t += dt;

      // Frame rate, averaged over half a second. Cheap, and it turns "will
      // 5120x1440 be fast enough" into something you can read off the panel.
      {
        const a = api.current;
        a.fpsFrames = (a.fpsFrames || 0) + 1;
        a.fpsAccum  = (a.fpsAccum  || 0) + rawDt;
        if (a.fpsAccum >= 0.5) { a.fps = a.fpsFrames / a.fpsAccum; a.fpsFrames = 0; a.fpsAccum = 0; }
      }

      // The doorway lamp fades as you go in, handing her flat back to the
      // lighting you set on the character tab.
      if (api.current.warm) {
        const w = api.current.warm;
        const want = camera.position.z > -0.05 ? 16 : 0;
        w.intensity += (want - w.intensity) * Math.min(1, dt * 2);
        w.visible = w.intensity > 0.05;
      }

      // Ease the lens between the two shots as you cross her threshold.
      // Snapping would read as a cut, and this is meant to be one long take.
      {
        const want = lensFor(camera, api.current.maxHWalk);
        if (Math.abs(camera.fov - want) > 0.01) {
          camera.fov += (want - camera.fov) * Math.min(1, dt * 5);
          if (Math.abs(camera.fov - want) < 0.02) camera.fov = want;
          camera.updateProjectionMatrix();
        }
      }

      // The bulb is old and the wiring is worse.
      const b = landing.bulb;
      if (b) b.intensity = 30 + Math.sin(t * 11) * 0.7 + Math.sin(t * 3.1) * 0.45;

      const s = api.current.swing;
      if (s && s.pivot) {
        s.now += (s.to - s.now) * Math.min(1, dt * 2.2);
        s.pivot.rotation.y = s.dir * s.now;
      }
      api.current.mixer?.update(dt);
      api.current.meMixer?.update(dt);
      // Session 153 — the scripted step to the threshold ENDS.
      //
      // Clearing this was wired to the pointer-lock event, so when the browser
      // did not grant lock it ran forever: every frame it lerped the camera
      // back and re-aimed it at a point below eye level, which looks exactly
      // like "pressing W tilts the camera forward" — you moved, and it pulled
      // you back and pitched you down. It now retires on arrival, and any
      // input retires it immediately.
      const c = api.current.dolly;
      if (c) {
        camera.position.lerp(c.pos, Math.min(1, dt * 1.1));
        camera.lookAt(c.at);
        if (camera.position.distanceTo(c.pos) < 0.02) api.current.dolly = null;
      }
      stepHer(dt);
      idleHer(dt);
      applyEyeToEye(dt, camera);
      steerLook(dt);
      stepPlayer(dt, camera);
      placeThirdPersonCamera(dt);

      // Session 153 — the landing is scenery for the OUTSIDE of the door.
      //
      // Its plaster wraps the doorway (the reveal at z=0) and the flat brings
      // its own wall to the same place, so from inside you saw a beige slab
      // pushed through her white one. Rather than pick a moment to retire it,
      // tie it to which side of her threshold you are standing on: it exists
      // while you are on the landing and stops existing once you are in her
      // flat — which also covers walking back out again.
      const lg = api.current.landing?.group;
      if (lg) {
        const onLanding = camera.position.z > -0.05;
        if (lg.visible !== onLanding) lg.visible = onLanding;
      }
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) [].concat(o.material).forEach(m => {
          Object.values(m).forEach(v => v?.isTexture && v.dispose());
          m.dispose();
        });
      });
      document.body.style.cursor = "";
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      renderer.domElement.removeEventListener("contextmenu", onContext);
      document.removeEventListener("mouseleave", onPointerGone);
      document.removeEventListener("mouseenter", onPointerBack);
      window.removeEventListener("blur", onPointerGone);
      window.removeEventListener("focus", onPointerBack);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      el.removeChild(renderer.domElement);
    };
  }, [location?.place_id, actorName]);

  // ── knock, and wait ───────────────────────────────────────────────────────
  useEffect(() => {
    if (rehearse) {
      const map = { open: "open_door", ignore: "ignore", text: "send_text" };
      const t = setTimeout(() => {
        if (rehearse === "error") { setPhase("error"); return; }
        setNarrative({
          open:   "The lock turns. A face appears, then the gap widens.",
          ignore: "The light under the door goes out.",
          text:   "Nothing. Then your phone goes off in your pocket.",
        }[rehearse] || "");
        setDecision(map[rehearse] || null);
        setPhase("answered");
      }, 2600);
      return () => clearTimeout(t);
    }

    if (!encounter_id) return;
    let dead = false;
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/worlds/${world.id}/encounter/${encounter_id}`, { credentials: "include" });
        if (!r.ok) return;
        const d = await r.json();
        if (dead) return;
        if (d.narrative) setNarrative(d.narrative);
        if (d.decision) { setDecision(d.decision); setPhase("answered"); clearInterval(poll); }
        else if (d.phase === "ended") {
          // Ended with nothing decided is not her being rude — it is the world
          // failing to think. Those are different pictures.
          setPhase("error"); clearInterval(poll);
        } else if (d.phase === "perceiving") setPhase("heard");
      } catch { /* keep waiting */ }
    }, 1400);
    return () => { dead = true; clearInterval(poll); };
  }, [encounter_id, world?.id, rehearse]);

  // ── talking to her ────────────────────────────────────────────────────────
  //
  // Same transport the room and the old knock scene use, deliberately: her
  // reply arrives WHOLE on the actor's SSE stream as one encounter_response,
  // and the client reveals it a word at a time. Nothing is streamed token by
  // token — the "delta" is a local reveal, and matching that keeps her cadence
  // identical to every other place she speaks.
  function syncReset() {
    const sy = syncRef.current;
    Object.values(sy.timers).forEach(clearTimeout);
    if (sy.revealTimer) clearInterval(sy.revealTimer);
    if (sy.finalGuard) clearTimeout(sy.finalGuard);
    syncRef.current = { raw: "", sentences: [], timers: {}, revealTimer: null, inflight: null, pendingFinal: null, finalGuard: null };
  }

  function bufferToken(tok) {
    const sy = syncRef.current;
    if (DELTAS_MARK.test(sy.raw)) return;
    sy.raw += tok;
    // The dots keep going until she actually STARTS — a buffered token the
    // player cannot see yet is not "responding has ended".
    const beforeDeltas = sy.raw.split(DELTAS_MARK)[0];
    // An unclosed *direction* means narration is still streaming in - capture
    // now and half of it leaks into a bubble verbatim ("*Magnus stands inche"
    // opened the session, seen live). Wait for the closing asterisk.
    const stars = (beforeDeltas.match(/\*/g) || []).length;
    if (stars % 2 === 1) return;
    const clean = beforeDeltas.replace(/\*[^*]*\*/g, " ");
    const parts = clean.match(/[^.!?…]*[.!?…]+["']?/g) || [];
    for (let i = sy.sentences.length; i < parts.length; i++) {
      const text = parts[i].trim();
      if (!text) continue;
      sy.sentences[i] = { text, revealed: false, done: false };
      // Sentence 0 gets a longer grace: its wav takes 2-6s to synthesize, and
      // flushing at 2.5s put the text out moments before the voice began —
      // the exact desync this exists to remove.
      sy.timers[i] = setTimeout(() => revealSentence(i, 0), i === 0 ? 4500 : 2500);
    }
  }

  // Flush whatever an in-progress paced reveal still holds, instantly.
  // Without this, starting sentence N's pacing killed sentence N-1's interval
  // and its unshown words simply vanished until the final settle.
  function flushInflight() {
    const sy = syncRef.current;
    if (sy.revealTimer) { clearInterval(sy.revealTimer); sy.revealTimer = null; }
    if (sy.inflight) {
      const { words, at, i } = sy.inflight;
      for (let k = at; k < words.length; k++) pushToken(words[k] + " ", actorName);
      if (sy.sentences[i]) sy.sentences[i].done = true;
      sy.inflight = null;
    }
  }

  function revealSentence(i, durMs) {
    const sy = syncRef.current;
    const sent = sy.sentences[i];
    if (!sent || sent.revealed) return;
    for (let j = 0; j < i; j++) revealSentence(j, 0);
    flushInflight();
    sent.revealed = true;
    setResponding(false);
    if (sy.timers[i]) { clearTimeout(sy.timers[i]); delete sy.timers[i]; }
    const words = sent.text.split(/\s+/).filter(Boolean);
    if (!durMs || durMs < 300 || words.length === 0) {
      pushToken(sent.text + " ", actorName);
      sent.done = true;
      maybeSettle();
      return;
    }
    const step = Math.min(350, Math.max(40, (durMs * 0.85) / words.length));
    sy.inflight = { words, at: 0, i };
    sy.revealTimer = setInterval(() => {
      const inf = sy.inflight;
      if (!inf || inf.at >= inf.words.length) {
        clearInterval(sy.revealTimer); sy.revealTimer = null;
        if (inf && sy.sentences[inf.i]) sy.sentences[inf.i].done = true;
        sy.inflight = null;
        maybeSettle();
        return;
      }
      pushToken(inf.words[inf.at] + " ", actorName);
      inf.at++;
    }, step);
  }

  // The final text settles only after her voice has finished saying it.
  // encounter_response lands seconds after generation — long before the audio
  // has played through — and settling there snapped the full text in at once,
  // which unmade the sync at the exact moment it mattered.
  function maybeSettle() {
    const sy = syncRef.current;
    if (!sy.pendingFinal) return;
    const audioBusy = ttsPlaying.current || Object.keys(ttsQueueRef.current).length > 0;
    const unrevealed = sy.sentences.some(x => x && !x.done);
    if (audioBusy || unrevealed || sy.inflight) return;
    const { text, speaker, claimed } = sy.pendingFinal;
    sy.pendingFinal = null;
    settleStream(text, speaker, claimed);
  }

  // Every exit from a sentence goes through here, and a watchdog guarantees
  // there IS an exit. ttsPlaying used to be cleared in exactly two places —
  // onended and play()'s catch — so an element that resolved play() and then
  // stalled (never ending, never erroring) latched the flag true forever.
  // playNextTts then bailed on its first line for every later wav. Measured
  // live 2026-08-29 with the audio pipeline otherwise healthy: four wavs
  // arrived over SSE, four Audio elements were built, play() was called zero
  // times, and the scene was silent from that point on. The 3s gap-jumper
  // could not rescue it either — it is guarded by the same flag.
  function advanceTts(audio) {
    if (ttsWatchdog.current) { clearTimeout(ttsWatchdog.current); ttsWatchdog.current = null; }
    try { if (audio) URL.revokeObjectURL(audio.src); } catch {}
    delete ttsQueueRef.current[ttsNextIdx.current];
    ttsNextIdx.current++;
    ttsPlaying.current = false;
  }

  // One context for all of her speech, resumed on demand.
  function ttsAudioCtx() {
    const a = api.current || {};
    if (!a._ttsCtx || a._ttsCtx.state === "closed") {
      const C = window.AudioContext || window.webkitAudioContext;
      a._ttsCtx = new C();
    }
    if (a._ttsCtx.state === "suspended") {
      a._ttsCtx.resume().catch(() => {});
      // resume() without fresh user activation can leave the context suspended
      // — measured 2026-09-03: her line decoded, start() ran, state stayed
      // "suspended", silence. Unlike the old <audio> path this is DETECTABLE,
      // so heal it: the next real gesture anywhere on the page resumes the
      // context, and everything queued since simply plays from there.
      if (!a._ttsResumeHooked) {
        a._ttsResumeHooked = true;   // armed once, never torn down: the context
                                     // can be re-suspended any number of times
        // Any real gesture resumes the context and drains whatever is held.
        // This listener is NOT removed: focus can be lost and regained many
        // times in a session, and each loss re-suspends the context.
        const kick = () => {
          const ctx = a._ttsCtx;
          if (!ctx) return;
          ctx.resume().then(() => playNextTts()).catch(() => {});
        };
        document.addEventListener("pointerdown", kick, true);
        document.addEventListener("keydown", kick, true);
      }
    }
    return a._ttsCtx;
  }

  function playNextTts() {
    if (ttsPlaying.current) return;
    const buf = ttsQueueRef.current[ttsNextIdx.current];
    if (!buf) return;                        // gap — resumes when it arrives
    ttsPlaying.current = true;
    const idx = ttsNextIdx.current;

    const armWatchdog = (ms) => {
      if (ttsWatchdog.current) clearTimeout(ttsWatchdog.current);
      ttsWatchdog.current = setTimeout(() => {
        console.warn("[door] tts watchdog fired on sentence", idx, "— unjamming queue");
        advanceTts(null);
        playNextTts();
      }, ms);
    };

    const ctx = ttsAudioCtx();

    // A suspended context still accepts start() — the buffer plays into
    // nothing, onended fires, the queue advances, and the line is GONE.
    // Chromium suspends whenever the window loses focus, so every wav that
    // landed while you were elsewhere was destroyed rather than waited on.
    // Measured 2026-09-03: ctx flipped running -> suspended between two turns
    // and the audio vanished with it. Hold the queue instead; the persistent
    // gesture listener below calls back in once the context is live.
    if (ctx.state !== "running") {
      ttsPlaying.current = false;
      ctx.resume().then(() => { if (ctx.state === "running") playNextTts(); }).catch(() => {});
      return;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const durMs = buf.duration * 1000;
    revealSentence(idx, durMs);
    armWatchdog(durMs + 3000);
    src.onended = () => {
      advanceTts(null);
      playNextTts();
      maybeSettle();
    };
    try {
      src.start();
    } catch (e) {
      console.warn("[door] tts source start failed on sentence", idx, e && e.name);
      advanceTts(null);
      playNextTts();
    }
  }

  useEffect(() => {
    if (!playerActorId || !encounter_id) return;
    const es = new EventSource(`/api/actors/${playerActorId}/stream`);
    es.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      // Session 154 — tokens and voice arrive with TOP-LEVEL types (see the
      // SSE controller), and this guard silently dropped both. That single
      // line was simultaneously "she takes forever to say something" (her
      // words streamed and nobody rendered them) and "no sound" (her wavs
      // arrived and nobody played them). PresenceView always handled these;
      // this scene never did.
      if (data.type === "encounter_response_id" && data.encounter_id === encounter_id) {
        // A new turn is starting. Close the previous one out FIRST, whatever
        // state it is in — without this separator, a quick follow-up turn
        // (reply, then silence-initiative seconds later) appended its tokens
        // into the previous turn's still-live bubble: two log entries fused
        // into one bubble, claimed as one concatenated string that matched
        // neither, so one entry rendered twice and the other not at all.
        if (syncRef.current.pendingFinal) {
          const pf = syncRef.current.pendingFinal;
          syncRef.current.pendingFinal = null;
          settleStream(pf.text, pf.speaker, pf.claimed);
        } else if (streamRef.current.live || syncRef.current.raw) {
          settleStream(syncRef.current.raw || streamRef.current.text, actorName);
        } else {
          syncReset();
        }
        return;
      }
      if (data.type === "encounter_token" && data.encounter_id === encounter_id) {
        if (data.token) bufferToken(data.token);
        return;
      }
      if (data.type === "encounter_tts" && data.encounter_id === encounter_id) {
        if (!data.wav_b64) return;
        try {
          const bytes = Uint8Array.from(atob(data.wav_b64), c => c.charCodeAt(0));
          // WebAudio, not an <audio> element. Measured in this shell on
          // 2026-09-03: a 5.75s wav in an HTMLAudioElement resolved play(),
          // fired ended — and produced NO sound, while an AudioContext
          // oscillator was audible in the same document moments earlier.
          // The element path "works" by every observable and is silent; the
          // context path is the one that provably reaches the speakers.
          ttsAudioCtx().decodeAudioData(bytes.buffer.slice(0)).then(buf => {
            ttsQueueRef.current[data.index] = buf;
            playNextTts();
          }).catch(e => console.warn("[door] tts decode failed", e));
          // The server skips action-only sentences AFTER consuming their
          // index, so the wav sequence has holes. A queue waiting politely at
          // a hole waits forever: if nothing occupies the next slot shortly
          // after a later wav arrived, jump to the earliest one that exists.
          setTimeout(() => {
            if (!ttsPlaying.current && !ttsQueueRef.current[ttsNextIdx.current]) {
              const have = Object.keys(ttsQueueRef.current).map(Number);
              if (have.length) { ttsNextIdx.current = Math.min(...have); playNextTts(); }
            }
          }, 3000);
        } catch {}
        return;
      }
      if (data.type !== "encounter_event" || data.encounter_id !== encounter_id) return;
      const payload = data.data || data;
      switch (payload.type) {
        // Session 153 — she types in front of you again.
        //
        // The old presence view listened for encounter_token and grew the
        // sentence as it arrived. This scene never subscribed at all: it waited
        // for the finished encounter_response and then FAKED a reveal, one word
        // every 60ms, which is a different thing wearing the same coat — the
        // pause before she starts is dead air, and the pace is a constant that
        // has nothing to do with her.
        case "encounter_token":
          if (payload.token) bufferToken(payload.token);
          break;
        case "encounter_response_id":
          // wrapped form of the turn separator (the silence path emits it
          // inside encounter_event; the top-level handler above catches the
          // stream path's form)
          if (syncRef.current.pendingFinal) {
            const pf = syncRef.current.pendingFinal;
            syncRef.current.pendingFinal = null;
            settleStream(pf.text, pf.speaker, pf.claimed);
          } else if (streamRef.current.live || syncRef.current.raw) {
            settleStream(syncRef.current.raw || streamRef.current.text, actorName);
          } else {
            syncReset();
          }
          break;
        case "encounter_warming":
          setResponding(true);
          break;
        case "encounter_response":
          // Streamed already — or STREAMING-IN-WAITING? With voice sync the
          // tokens sit in the sentence buffer until their audio starts, so
          // when this event beats the first clip (it usually does — the wav
          // takes 2-6s to synthesize) streamRef.live is still false and the
          // old test fell into revealReply, which printed the whole reply as
          // its own bubble... and then the paced reveal printed it AGAIN.
          // That was the adjacent-duplicate. The buffer counts as streaming.
          if (streamRef.current.live || syncRef.current.raw || syncRef.current.sentences.length) {
            finishStream(payload.text, payload.speaker || actorName);
          } else {
            revealReply(payload.text, payload.speaker || actorName);
          }
          // The same event carries where she has moved to, and how she is.
          if (payload.location) walkHerTo(payload.location);
          // She decided to cross to you rather than to a room. Her words are
          // already in the panel; this is her feet agreeing with them.
          if (payload.move_to === "player") walkHerToMe();
          // Her own way in: "standing close" is a position the engine already
          // lets her report. But it must agree with the geometry — she can say
          // "standing close" from across a room, and a mode that seizes the
          // camera on a word rather than on a fact is a mode that grabs you by
          // surprise. She has to actually BE close.
          if (/\bclose\b/i.test(payload.position || "") && api.current?.her && api.current?.camera) {
            const her = api.current.her.position, cam = api.current.camera.position;
            if (Math.hypot(her.x - cam.x, her.z - cam.z) < 1.4) setEyeToEye(true);
          }
          // ...and if the field did not move her but her own words did, follow
          // the words. Standing in the doorway saying "steps into apartment"
          // is the single most common beat here, and it was doing nothing.
          if (api.current?.herRoom === "hall" &&
              MOVES_INSIDE.test(`${payload.scene_description || ""} ${payload.text || ""}`)) {
            console.log("[door] she says she is going in — following her words, not the field");
            walkHerTo("living_room");
          }
          if (payload.vitals) updateVitals(payload.vitals);
          break;
        case "missing_media":
          // The video views freeze here and offer clip generation. This scene
          // has no clips — she is a GLB — so a pause only turns her silence
          // initiative off forever. Decline it: resume at once.
          console.log("[door] missing media — resuming, the 3D scene declines the pause");
          fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/resume`,
                { method: "POST", credentials: "include" }).catch(() => {});
          break;
        case "encounter_ended":
          setResponding(false);
          break;
        case "encounter_error":
          setResponding(false);
          setMessages(prev => [...prev, { from: "sys", text: payload.text || "No answer.", at: Date.now() }]);
          break;
        default: break;
      }
    };
    es.onerror = () => {};
    return () => { es.close(); if (replyTimerRef.current) clearInterval(replyTimerRef.current); };
  }, [playerActorId, encounter_id, actorName]);

  // Once she has opened and you can see her, tell the simulator you are in the
  // scene — that is what makes her speak first rather than stand there waiting
  // to be spoken to (EncounterProcess :player_entered → first_words).
  useEffect(() => {
    if (decision !== "open_door" || !ready) return;
    const t = setTimeout(() => setNarrativeGone(true), 9000);
    return () => clearTimeout(t);
  }, [decision, ready]);

  useEffect(() => {
    if (decision !== "open_door" || !ready || enteredRef.current || !encounter_id) return;
    enteredRef.current = true;
    setResponding(true);
    fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/enter`, {
      method: "POST", credentials: "include",
    }).catch(() => setResponding(false));
  }, [decision, ready, encounter_id, world?.id]);

  // Session 153 — the conversation is reconciled against the server, not
  // assumed from the stream.
  //
  // Her opening line was generated, stored, and never shown: the SSE event
  // carrying it did not reach the panel, and nothing else was watching. An
  // encounter that has already said something is not allowed to look silent,
  // so the encounter is polled while it is live and anything in its
  // conversation_log that has not been rendered is rendered. SSE stays the
  // fast path; this is the floor under it.
  useEffect(() => {
    if (decision !== "open_door" || !encounter_id) return;
    let stopped = false;
    const sync = async () => {
      // Mid-stream: the bubble on screen is being written right now, and the
      // log's copy of it would land beside it as a second one. The buffer
      // counts as streaming: tokens waiting for their wav (sentence 0 waits up
      // to 4.5s) have not touched streamRef yet, and the server commits the
      // log seconds BEFORE it broadcasts the response — proven live: the poll
      // rendered "That wasn't funny Magnus." from the log while its reveal
      // was still waiting on audio, and the reveal then rendered it again.
      if (streamRef.current.live || syncRef.current.raw ||
          syncRef.current.sentences.length || syncRef.current.pendingFinal) return;
      try {
        const r = await fetch(`/api/worlds/${world.id}/encounter/${encounter_id}`, { credentials: "include" });
        if (stopped) return;
        if (r.status === 404) {
          // Two in a row: a restart's own boot window can 404 once before the
          // service is listening again, and that is not a dead encounter.
          if (++goneRef.current >= 2) declareEncounterGone();
          return;
        }
        goneRef.current = 0;
        if (!r.ok) return;
        const d = await r.json();
        const log = d.conversation_log || [];
        for (let i = logCursorRef.current; i < log.length; i++) {
          logCursorRef.current = i + 1;
          const entry = log[i];
          window.__chat?.trace.push(["entry", i, entry.from, (entry.text || "").slice(0, 40)]);
          if (isMachinery(entry.from, entry.text)) continue;
          const mine = entry.from === "player" || entry.from === "user" || entry.from === "me";
          const text = stripWrappingQuotes(entry.text);
          if (!text) continue;
          const c = canonical(text);
          if (mine) {
            // Already on screen from the moment it was sent.
            const q = localMineRef.current;
            const at = q.indexOf(c);
            if (at !== -1) { q.splice(at, 1); continue; }
            setMessages(prev => [...prev, { from: "me", text }]);
          } else {
            // Already on screen from the stream or the SSE event.
            const q = streamedRef.current;
            const at = q.indexOf(c);
            if (at !== -1) { q.splice(at, 1); continue; }
            // The server's double-write: the same line, twice, ADJACENT.
            const prevEntry = log[i - 1];
            if (prevEntry && !isMachinery(prevEntry.from, prevEntry.text) &&
                prevEntry.from === entry.from &&
                canonical(stripWrappingQuotes(prevEntry.text)) === c) continue;
            lastReplyRef.current = text;
            setResponding(false);
            window.__chat?.trace.push(["render-them", i, text.slice(0, 40)]);
            setMessages(prev => [...prev, { from: "them", speaker: actorName, text }]);
          }
        }
      } catch (err) {
        // A silent catch here cost a debugging hour: any error in the loop
        // above ate the whole reconcile with no trace. Swallow network
        // errors, but say so.
        window.__chat?.trace.push(["sync-error", String(err).slice(0, 200)]);
      }
    };
    sync();
    const id = setInterval(sync, 3000);
    return () => { stopped = true; clearInterval(id); };
  }, [decision, encounter_id, world?.id, actorName]);

  // Session 153 — she moves because she said she would.
  //
  // Her reply carries a SCENE block naming the room she is in at the END of
  // it. Walking her there is the difference between a character and a prop:
  // "let me put the kettle on" now takes her to the kitchen, and following her
  // is something you do rather than something you are told about.
  // An anchor is a claim about the flat, so check it before believing it.
  // If the named spot is occupied, take the clearest one near it rather than
  // walking her into a wall — which is what a hardcoded table earns you the
  // day the flat model changes.
  function clearSpot(x, z) {
    const bt = api.current.collider?.boundsTree;
    if (!bt) return { x, z };
    const t = {};
    const clearance = (px, pz) => {
      bt.closestPointToPoint(new THREE.Vector3(px, 1.0, pz), t);
      return t.distance;
    };
    let best = { x, z, c: clearance(x, z) };
    if (best.c >= HER_CLEARANCE) return { x, z };
    for (let r = 0.3; r <= 1.5; r += 0.3) {
      for (let i = 0; i < 16; i++) {
        const th = (i / 16) * Math.PI * 2;
        const px = x + Math.cos(th) * r, pz = z + Math.sin(th) * r;
        const c = clearance(px, pz);
        if (c > best.c) best = { x: px, z: pz, c };
      }
      if (best.c >= HER_CLEARANCE + 0.05) break;
    }
    console.warn(`[door] anchor (${x}, ${z}) had only ${best.c.toFixed(2)}m of room — standing her at (${best.x.toFixed(2)}, ${best.z.toFixed(2)}) instead`);
    return { x: best.x, z: best.z };
  }

  // Session 153 — "come here" had nowhere to send her.
  //
  // walkHerTo can only reach the five room anchors, so the most natural thing
  // anyone says to someone standing across a room did nothing at all. You are
  // not a room; you are a moving point, so aim at a conversational distance
  // from wherever you are standing, keeping the side she is already on so she
  // does not walk a semicircle around you to arrive.
  // Session 153 — eye to eye.
  //
  // An explicit mode, not a camera that creeps in on its own. Either of you
  // can call it: you from the panel, or she can, by reporting a position that
  // says she has closed the distance. It parks the camera on her eye line,
  // close enough that her face fills the frame, and takes away the feet and
  // the look — there is nothing to do in this mode but listen to her.
  //
  // The framing is fixed rather than negotiated because this is where visemes
  // will live, and lip sync is only worth rendering if you can see the lips.
  function eyeToEyeFraming() {
    const a = api.current;
    const her = a.her;
    if (!her) return null;
    if (a.herEyeY == null) {
      const b = new THREE.Box3().setFromObject(her);
      a.herEyeY = b.max.y - 0.11;          // crown to eye line on a Genesis head
    }
    const fx = Math.sin(her.rotation.y), fz = Math.cos(her.rotation.y);
    return {
      pos:  new THREE.Vector3(her.position.x + fx * 0.62, a.herEyeY, her.position.z + fz * 0.62),
      look: new THREE.Vector3(her.position.x, a.herEyeY, her.position.z),
    };
  }

  function applyEyeToEye(delta, camera) {
    const a = api.current;
    if (a.eyeToEye) {
      const f = eyeToEyeFraming();
      if (!f) return;
      camera.position.lerp(f.pos, Math.min(1, delta * 2.6));
      _eyeMatrix.lookAt(camera.position, f.look, UP);
      _eyeQuat.setFromRotationMatrix(_eyeMatrix);
      camera.quaternion.slerp(_eyeQuat, Math.min(1, delta * 2.6));
      return;
    }
    // Leaving eases back to where you were standing, rather than cutting.
    if (a.eyeRestore) {
      camera.position.lerp(a.eyeRestore.pos, Math.min(1, delta * 2.4));
      camera.quaternion.slerp(a.eyeRestore.quat, Math.min(1, delta * 2.4));
      if (camera.position.distanceTo(a.eyeRestore.pos) < 0.02) a.eyeRestore = null;
    }
  }

  // Belt and braces: whatever happens, a fresh scene starts standing up.
  useEffect(() => () => { if (api.current) { api.current.eyeToEye = false; api.current.eyeRestore = null; } }, []);

  function setEyeToEye(on) {
    const a = api.current;
    if (!a.her || !a.camera) return;
    if (on) {
      if (a.eyeToEye) return;
      a.eyeRestore = null;
      a.eyeReturn = { pos: a.camera.position.clone(), quat: a.camera.quaternion.clone() };
      a.eyeToEye = true;
      applyEyeAperture();
      a.exitWalk?.();                       // the feet are not yours in here
      // She looks at you. That is the entire content of the mode.
      const fx = a.camera.position.x - a.her.position.x;
      const fz = a.camera.position.z - a.her.position.z;
      if (Math.hypot(fx, fz) > 0.15) {
        a.herFacing = Math.atan2(fx, fz);
        a.idleTurn  = a.herFacing;
      }
    } else {
      if (!a.eyeToEye) return;
      a.eyeToEye = false;
      if (a.camera?.view?.enabled) a.camera.clearViewOffset();
      a.eyeRestore = a.eyeReturn || null;
    }
    setEyeToEyeUI(on);
  }

  // Session 154 — eye to eye has to compose for what you can SEE.
  //
  // The camera centres her in the canvas and the canvas is the whole window,
  // but the conversation dock covers its right edge: measured, she sat at
  // x=450 of 900 while the uncovered strip ran 0–527, so a face-to-face shot
  // put her at the far edge of it with half her face behind the panel.
  //
  // Panning the camera would fix the picture and break the mode. She looks
  // down the LENS, and a lens that has been turned is a lens she is no longer
  // looking into — the eye contact is the entire content of this mode.
  // setViewOffset shears the projection instead: the camera does not move and
  // does not rotate, so her gaze still meets yours, and she lands in the
  // middle of the part of the frame you can actually see.
  function applyEyeAperture() {
    const a = api.current;
    const cam = a?.camera, el = host.current;
    if (!cam || !el) return;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;

    if (!a.eyeToEye || panelHiddenRef.current) {
      if (cam.view?.enabled) cam.clearViewOffset();
      return;
    }

    // The dock is 400 wide (capped at 92vw) and its left 38% is a gradient,
    // so the picture does not end where the element does. Take the middle of
    // the fade as the practical edge.
    const panelW   = Math.min(400, w * 0.92);
    const occluded = panelW * 0.75;
    cam.setViewOffset(w, h, occluded / 2, 0, w, h);
  }

  // Hiding the dock gives the frame back, so the shift has to come off with it.
  useEffect(() => {
    panelHiddenRef.current = panelHidden;
    applyEyeAperture();
  }, [panelHidden]);

  // Put her where the fixture says she is, without walking her there — the
  // walk already happened, in the past the run authored.
  function placeHerForLab() {
    const a = api.current;
    const lab = readLab();
    if (!a.her || !lab || !lab.her) return;
    const key = normaliseRoom(lab.her);
    const anchor = key && ROOM_ANCHORS[key];
    if (!anchor) return;
    const spot = clearSpot(anchor.x, anchor.z);
    a.her.position.set(spot.x, a.her.position.y, spot.z);
    a.herRoom = key;
    a.herWalk = null;
    // Facing whoever just came in, if he is anywhere near.
    const fx = a.camera.position.x - spot.x, fz = a.camera.position.z - spot.z;
    if (Math.hypot(fx, fz) > 0.25) {
      a.her.rotation.y = Math.atan2(fx, fz);
      a.herFacing = a.her.rotation.y;
      a.idleTurn  = a.herFacing;
    }
    aimSun();
  }

  // Session 154 — a destination is not just a place, it is a place with you
  // possibly standing in it.
  //
  // walkHerTo aims at a room's ANCHOR, and the Test Lab stands you on an
  // anchor by design, so "come over here" in the living room sent her to the
  // exact coordinates of your feet: measured, she finished 7cm away, which
  // reads as a clipping bug rather than as a person. Nobody walks to a spot
  // someone else is occupying — they stop a conversation short of it.
  //
  // clearSpot stays purely about geometry, because the camera is placed with
  // it too and a camera that avoided itself would be nonsense. This wraps it.
  function herSpot(x, z) {
    const a = api.current;
    const first = clearSpot(x, z);
    const cam = a?.camera?.position;
    if (!cam) return first;

    let dx = first.x - cam.x, dz = first.z - cam.z;
    const d = Math.hypot(dx, dz);
    if (d >= PERSONAL_SPACE) return first;

    if (d < 1e-3) {
      // Dead on top of you: back her out the way she came in, so she does not
      // pick an arbitrary side and walk through you to reach it.
      const hx = a.her ? a.her.position.x - cam.x : 0;
      const hz = a.her ? a.her.position.z - cam.z : 1;
      const hd = Math.hypot(hx, hz) || 1;
      dx = hx / hd; dz = hz / hd;
    } else {
      dx /= d; dz /= d;
    }
    return clearSpot(cam.x + dx * PERSONAL_SPACE, cam.z + dz * PERSONAL_SPACE);
  }

  function walkHerToMe() {
    const a = api.current;
    if (!a.her || !a.camera) return;
    const cam = a.camera.position;
    let dx = a.her.position.x - cam.x, dz = a.her.position.z - cam.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.9) return;                    // already close enough to talk
    dx /= d; dz /= d;
    const spot = herSpot(cam.x + dx * 0.95, cam.z + dz * 0.95);
    a.herRoom = null;                       // she is with you, not in a room
    a.herWalk = { state: "waiting", startAt: performance.now(),
                  to: new THREE.Vector3(spot.x, 0, spot.z) };
    console.log("[door] she is coming to you");
  }

  function walkHerTo(room) {
    const a = api.current;
    if (!a.her) return;
    const key = normaliseRoom(room);
    if (!key) {
      // Loud, because silence here cost an evening: she said "apartment", the
      // lookup missed, and she simply never moved with no sign of why.
      console.warn(`[door] she named a place this flat has no anchor for: "${room}"`);
      return;
    }
    const anchor = ROOM_ANCHORS[key];
    if (!anchor) return;
    const to = herSpot(anchor.x, anchor.z);
    if (a.herRoom === key) return;                 // already there, or on her way
    a.herRoom = key;
    const here = a.her.position;
    if (Math.hypot(to.x - here.x, to.z - here.z) < 0.3) return;
    // state "waiting" with a startAt already past: the next frame promotes it
    // to walking and crossfades idle into the walk clip, which is the only
    // place that transition is made.
    a.herWalk = { state: "waiting", startAt: performance.now(),
                  to: new THREE.Vector3(to.x, 0, to.z) };
    console.log(`[door] she is walking to the ${key}`);
  }

  const VITAL_LABELS = { energy: "Energy", mood: "Mood", desire: "Desire", sobriety: "Sobriety" };

  function updateVitals(next) {
    if (!next) return;
    const prev = prevVitalsRef.current;
    if (prev) {
      const changed = {};
      Object.keys(VITAL_LABELS).forEach(k => {
        const delta = (next[k] || 0) - (prev[k] || 0);
        if (Math.abs(delta) < 0.01) return;
        changed[k] = delta > 0 ? "up" : "down";
        const id = `${k}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
        const toast = { id, label: VITAL_LABELS[k], up: delta > 0,
                        from: (prev[k] || 0).toFixed(2), to: (next[k] || 0).toFixed(2) };
        setVitalToasts(t => [...t.slice(-3), toast]);
        setTimeout(() => setVitalToasts(t => t.filter(x => x.id !== id)), 8000);
      });
      if (Object.keys(changed).length) {
        setChangedVitals(changed);
        setTimeout(() => setChangedVitals({}), 2500);
      }
    }
    prevVitalsRef.current = next;
    setVitals(next);
  }

  // Everything after DELTAS: is structured state for the engine, not speech —
  // warmth, trust, position, action. The old view split on it and so does this.
  // Tolerant of her near-miss markers — "DEBTAS:" seen live rode a whole
  // state JSON into a bubble because everything split on the literal.
  const DELTAS_MARK = /\bDE[LB]TAS?\s*:/;
  const spokenPart = (t) => (t || "").split(DELTAS_MARK)[0];

  function pushToken(tok, speaker) {
    const st = streamRef.current;
    window.__chat?.trace.push(["token", (tok || "").slice(0, 20)]);
    st.lastTokenAt = performance.now();
    if (DELTAS_MARK.test(st.text)) return;   // she has stopped talking to you
    st.text += tok;
    const shown = stripWrappingQuotes(spokenPart(st.text));
    if (!st.live) {
      st.live = true;
      setResponding(false);
      setMessages(prev => [
        ...prev.map(m => (m.live ? { ...m, live: false } : m)).filter(m => m.text),
        { from: "them", speaker, text: shown, live: true, at: Date.now() },
      ]);
    } else {
      setMessages(prev => prev.map((m, n) =>
        n === prev.length - 1 && m.live ? { ...m, text: shown } : m));
    }
  }

  // A stream that stops arriving is finalised with what it has, so the dots
  // and the half-written bubble can never wedge on a dropped connection.
  useEffect(() => {
    const id = setInterval(() => {
      const st = streamRef.current;
      if (st.live && st.lastTokenAt && performance.now() - st.lastTokenAt > 20000) {
        // Settle DIRECTLY. finishStream can defer forever on a jammed audio
        // queue, and a live bubble that never settles is a wedge: new turns
        // append into it (two replies fused into one bubble, seen live), the
        // reconcile stays gated, and later log entries never render at all.
        console.warn("[door] stream stalled 20s — force-settling what arrived");
        const pf = syncRef.current.pendingFinal;
        if (pf) { syncRef.current.pendingFinal = null; settleStream(pf.text, pf.speaker, pf.claimed); }
        else settleStream(syncRef.current.raw || st.text, actorName);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [actorName]);

  function finishStream(fullText, speaker) {
    const sy = syncRef.current;
    const audioBusy = ttsPlaying.current || Object.keys(ttsQueueRef.current).length > 0;
    const unrevealed = sy.sentences.some(x => x && !x.done);
    if (audioBusy || unrevealed || sy.inflight) {
      // The claim CANNOT wait for the settle. The log reconcile polls every
      // few seconds and the conversation_log already holds this line; during
      // the deferral window it rendered her reply a second time under the
      // live bubble that was still pacing the first. Claim now, settle later
      // — and tell settleStream not to claim again, or a later genuine
      // repeat of the same words would be silently eaten.
      // Claim ONCE. The 20s ticker used to re-enter here every 5s during a
      // jammed deferral, banking identical claim tokens (each one later eats a
      // genuine repeat) and overwriting pendingFinal.text with the partial
      // stream text — losing the tail of her reply.
      if (!sy.pendingFinal) {
        const claimText = stripWrappingQuotes(spokenPart(fullText || streamRef.current.text));
        if (claimText) { streamedRef.current.push(canonical(claimText)); lastReplyRef.current = claimText; }
        sy.pendingFinal = { text: fullText || streamRef.current.text, speaker, claimed: true };
      } else if (fullText && fullText.length > (sy.pendingFinal.text || "").length) {
        sy.pendingFinal.text = fullText;
      }
      // Never wedge: whatever happens to the audio, the text lands within 30s.
      if (sy.finalGuard) clearTimeout(sy.finalGuard);
      sy.finalGuard = setTimeout(() => {
        const pf = syncRef.current.pendingFinal;
        if (pf) { syncRef.current.pendingFinal = null; settleStream(pf.text, pf.speaker, pf.claimed); }
      }, 30000);
      return;
    }
    settleStream(fullText, speaker);
  }

  function settleStream(fullText, speaker, alreadyClaimed) {
    window.__chat?.trace.push(["finish", (fullText || "").slice(0, 60)]);
    const st = streamRef.current;
    const text = stripWrappingQuotes(spokenPart(fullText || st.text));
    streamRef.current = { text: "", live: false };
    syncReset();
    setResponding(false);
    if (!text) { setMessages(prev => prev.filter(m => m.text)); return; }
    // Claim THIS turn before the reconcile reads the same line out of the log
    // — one token, consumed once, so a genuine repeat later still renders.
    // A deferred settle claimed at defer time instead; claiming twice would
    // bank a token that later eats a genuine repeat.
    if (!alreadyClaimed) {
      streamedRef.current.push(canonical(text));
      lastReplyRef.current = text;
    }
    // A settle must never be able to LOSE the turn.
    //
    // This was a bare map over `live`: if no live bubble existed — the token
    // stream never opened for this turn, so bufferToken never created one —
    // the map matched nothing and the text was silently discarded. Measured
    // 2026-09-03: "It's great to finally have some time together" reached
    // chatterbox, logged a RAW_RESPONSE, and never appeared in the panel at
    // all, while the NEXT turn rendered normally above it. Spoken, logged,
    // and gone. If there is no slot to settle into, make one.
    setMessages(prev => {
      if (prev.some(m => m.live)) {
        return prev.map(m => (m.live ? { ...m, from: "them", speaker, text, live: false } : m));
      }
      return [...prev, { from: "them", speaker, text, live: false, at: Date.now() }];
    });
  }

  // Wall-clock stamp per bubble. Captured at creation (not at render) so a
  // paced reveal or a late settle cannot re-date a line that was said
  // earlier — the two settle paths below rebuild the message object, so they
  // spread the original rather than replacing it. Date is shown only when the
  // line falls on a different day from the one before it, which keeps a long
  // scene readable while still marking the moment it crossed midnight.
  function stampOf(ms) {
    if (!ms) return "";
    try {
      // Clock only — 24h, no AM/PM, no date. A scene is one evening; a date
      // separator is noise in a conversation you can read end to end.
      return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    } catch { return ""; }
  }

  function revealReply(rawText, speaker) {
    if (isMachinery(null, rawText)) return;   // never speak the stage management
    const text = stripWrappingQuotes(rawText);
    if (!text) return;
    // The stream can deliver the same response twice (two events, or a
    // reconnect replaying one). Revealing it twice left the first copy
    // stranded half-written — observed live as an orphan '"So,' bubble above
    // the complete sentence. Ignore a repeat of what we are already showing.
    // A duplicate EVENT (the same turn delivered twice by the stream) is
    // dropped — but the dots stop regardless. This early-return used to keep
    // responding=true forever when her reply repeated an earlier line.
    if (canonical(lastReplyRef.current) === canonical(text)) { setResponding(false); return; }
    lastReplyRef.current = text;
    streamedRef.current.push(canonical(text));

    if (replyTimerRef.current) clearInterval(replyTimerRef.current);
    setResponding(false);
    const words = text.split(" ");
    let i = 0, sofar = "";
    // Finalise anything still mid-reveal before starting the next one, so a
    // partial bubble can never be left behind.
    setMessages(prev => [
      ...prev.map(m => (m.live ? { ...m, live: false } : m)).filter(m => m.text),
      { from: "them", speaker, text: "", live: true, at: Date.now() },
    ]);
    replyTimerRef.current = setInterval(() => {
      if (i >= words.length) {
        clearInterval(replyTimerRef.current);
        setMessages(prev => prev.map((m, n) =>
          n === prev.length - 1 && m.live ? { ...m, from: "them", speaker, text: sofar.trim(), live: false } : m));
        return;
      }
      sofar += (sofar ? " " : "") + words[i++];
      setMessages(prev => prev.map((m, n) =>
        n === prev.length - 1 && m.live ? { ...m, text: sofar } : m));
    }, 60);
  }

  useEffect(() => { sendMessageRef.current = sendMessage; });

  // The encounter is gone and is not coming back — a restart takes its
  // GenServer with it and the id in this tab now refers to nothing. Say so
  // plainly and stop pretending a reply is on its way.
  function declareEncounterGone() {
    if (goneShownRef.current) return;
    goneShownRef.current = true;
    setEncounterGone(true);
    setResponding(false);
    setSending(false);
    setMessages(prev => [...prev, { from: "sys", at: Date.now(),
      text: "This conversation ended \u2014 the world restarted under it. Nothing you say here reaches her. Knock again to start over." }]);
  }

  async function sendMessage() {
    const content = chatInput.trim();
    if (!content || sending || !encounter_id) return;
    setChatInput("");
    setSending(true);
    setResponding(true);
    // Interrupting her mid-reveal used to hard-reset streamRef and leave the
    // live bubble stranded: the reveal's next word re-created it (head shown
    // twice) and the settle rewrote the second copy with the full text. Close
    // her turn out first, THEN reset.
    if (syncRef.current.pendingFinal) {
      const pf = syncRef.current.pendingFinal;
      syncRef.current.pendingFinal = null;
      settleStream(pf.text, pf.speaker, pf.claimed);
    } else if (streamRef.current.live || syncRef.current.raw) {
      settleStream(syncRef.current.raw || streamRef.current.text, actorName);
    } else {
      syncReset();
    }
    streamRef.current = { text: "", live: false };
    localMineRef.current.push(canonical(content));
    setMessages(prev => [...prev, { from: "me", text: content, at: Date.now() }]);
    try {
      const r = await fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        // Session 153 — she is told where he is standing, every message.
        // The simulator knows which ENCOUNTER he is in; only the scene knows
        // which room. Without it "come over here" is a sentence she can
        // answer but never act on.
        body: JSON.stringify({
          content,
          player_room: api.current?.camera
            ? roomOfPoint(api.current.camera.position.x, api.current.camera.position.z)
            : undefined,
        }),
      });
      // fetch resolves on 404 as happily as on 200 — the status is the only
      // place the failure is written down.
      if (r.status === 404) { declareEncounterGone(); return; }
      if (!r.ok) {
        setResponding(false);
        setMessages(prev => [...prev, { from: "sys", at: Date.now(),
          text: `That didn't get through (HTTP ${r.status}).` }]);
      }
    } catch {
      setResponding(false);
      setMessages(prev => [...prev, { from: "sys", text: "That didn't get through.", at: Date.now() }]);
    }
    setSending(false);
  }

  // Enter opens the chat and releases the mouse; Esc puts you back on your
  // feet. The standard arrangement, because it is the one people already know.
  useEffect(() => {
    const onKey = (e) => {
      // Enter while the input has focus sends. This lives here as well as on
      // the input because the input's own handler proved unreliable to reach
      // once the scene has a window-level key capture in front of it.
      if ((e.key === "Enter" || e.code === "NumpadEnter") && isTyping()) {
        e.preventDefault();
        sendMessageRef.current?.();
        return;
      }
      if (e.code === "KeyM" && !isTyping() && decision === "open_door") {
        setPanelHidden(h => !h);
        return;
      }
      if (e.code === "Enter" && !chatOpen && decision === "open_door" && ready) {
        setPanelHidden(false);
        e.preventDefault();
        setChatOpen(true);
        // Leave walk mode outright — unlock() alone did nothing when pointer
        // lock was never granted, which left the cursor hidden and the panel
        // untouchable with the caret supposedly in it.
        api.current.exitWalk?.();
        setTimeout(() => chatInputRef.current?.focus(), 30);
      } else if (e.code === "Escape" && api.current?.eyeToEye) {
        setEyeToEye(false);
      } else if (e.code === "Escape" && chatOpen) {
        setChatOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatOpen, decision, ready]);

  // Session 153 — the Display tab, wired straight to the renderer.
  useEffect(() => {
    localStorage.setItem(SETTING_KEYS.scale, String(renderScale));
    const a = api.current;
    if (!a?.renderer || !a.el?.clientWidth) return;
    a.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * renderScale);
    a.renderer.setSize(a.el.clientWidth, a.el.clientHeight);
  }, [renderScale]);

  useEffect(() => {
    localStorage.setItem(SETTING_KEYS.cap, String(fovCap));
    if (api.current) api.current.maxHWalk = fovCap;
  }, [fovCap]);

  useEffect(() => {
    localStorage.setItem(SETTING_KEYS.aspect, String(maxAspect));
    if (!api.current) return;
    api.current.maxAspect = maxAspect;
    api.current.resize?.();
  }, [maxAspect]);

  // Session 153 — the Display tab drives the same lighting the editor does.
  //
  // Applied to the live scene immediately, then written back debounced to both
  // stores the editor uses: localStorage for this browser and the account's
  // preferences for everywhere else. The first value is skipped deliberately —
  // it came FROM those stores, and saving it back would be a write for nothing.
  useEffect(() => {
    if (!display) return;
    const a = api.current;
    if (a?.scene) {
      applyDisplay(display, { renderer: a.renderer, scene: a.scene,
                              key: a.key, ambient: a.ambient, rim: a.rim });
      a.sunOffset = new THREE.Vector3(...sunPosition(display));
      a.display = display;
      aimSun();
    }
    if (!displaySettledRef.current) { displaySettledRef.current = true; return; }
    const t = setTimeout(() => {
      try { localStorage.setItem("anima_explore_display", JSON.stringify(display)); }
      catch { /* a browser with no storage still gets a lit room */ }
      fetch("/api/me/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ preferences: { exploreDisplay: display } }),
      }).catch(e => console.warn("[door] display prefs not saved to the account:", e?.message || e));
    }, 800);
    return () => clearTimeout(t);
  }, [display]);

  // Sampled only while the tab is open. A readout nobody is looking at has no
  // business re-rendering the panel twice a second.
  useEffect(() => {
    if (tab !== "display") return;
    const read = () => {
      const a = api.current;
      if (!a?.renderer) return;
      const c = a.renderer.domElement;
      setStats({ fps: Math.round(a.fps || 0), w: c.width, h: c.height });
    };
    read();
    const id = setInterval(read, 500);
    return () => clearInterval(id);
  }, [tab]);

  // Session 153 — one authority for the cursor.
  //
  // enterWalk hid it imperatively and then openDoor, re-running on a later
  // render, set it straight back to a crosshair: walk mode was on with the
  // pointer plainly visible. Deriving it from state instead means every
  // render re-asserts the correct answer, whoever else has been writing to
  // the style.
  useEffect(() => {
    // A class on <html> with !important, rather than inline styles on two
    // elements. Setting body and canvas alone left every element carrying its
    // own cursor rule — buttons, the chat panel, the header — free to show a
    // pointer the moment you crossed onto one, which is why it reappeared at
    // the edges of the window.
    const ID = "anima-walk-cursor";
    if (!document.getElementById(ID)) {
      const tag = document.createElement("style");
      tag.id = ID;
      tag.textContent = "html.anima-walking, html.anima-walking * { cursor: none !important; }";
      document.head.appendChild(tag);
    }
    document.documentElement.classList.toggle("anima-walking", !!inside);
    const cv = api.current.renderer?.domElement;
    if (cv) cv.style.cursor = "";      // the class decides; no inline override
    return () => document.documentElement.classList.remove("anima-walking");
  });

  // New bubbles must be visible without scrolling for them.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  // ── what the door does about it ───────────────────────────────────────────
  useEffect(() => {
    const a = api.current;
    if (!a.landing) return;
    const { landing } = a;

    if (phase === "heard") {
      landing.under.material.opacity = 0.85;   // she's up
    }

    if (phase === "error") {
      landing.under.material.opacity = 0;
      abandon();
    }

    if (phase === "answered") {
      if (decision === "open_door") {
        openDoor();
      } else if (decision === "ignore" || decision === "pretend_away") {
        // The worst outcome gets the least motion. Nothing opens; the light
        // just stops — and whatever is still coming down the wire stops too.
        abandon();
        setTimeout(() => { landing.under.material.opacity = 0; }, 1100);
      } else if (decision === "send_text") {
        landing.under.material.opacity = 0.5;
      }
    }
  }, [phase, decision]);

  function gltfLoader() {
    const draco = new DRACOLoader();
    draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    attachKtx2(loader);   // runtime GLBs carry KTX2 textures — see lib/gltfKtx2.js
    return loader;
  }

  // ── the flat, and the door it came with ───────────────────────────────────
  //
  // Loaded while she decides. Ten megabytes and a knock takes seconds, so the
  // dead time pays for itself — and it has to be here rather than on open,
  // because the door you are standing in front of is the one out of this file.
  // Any of the three loaders can finish in any order (or not apply at
  // all — no avatar configured, not in third person); this only flips once
  // ALL that apply have.
  function checkSceneReady() {
    const a = api.current;
    const flatOk = !!a.flatReady;
    const herOk  = !(SHOW_AVATAR && glbUrl) || a.herReady || a.herFailed;
    const meOk   = !a.thirdPerson || a.me != null;
    if (flatOk && herOk && meOk) setSceneVisible(true);
  }

  function loadFlat() {
    const a = api.current;
    if (!a.scene || a.flatLoading) return;
    a.flatLoading = true;
    const loader = gltfLoader();

    // The flat, hung on the doorway by its own front door.
    //
    // Centring it by bounding box put the doorway wherever the middle of the
    // model happened to fall — for the studio that is the window wall, so the
    // door opened onto the balcony end and you stood looking the length of the
    // flat from the wrong side. Where the front door is cannot be worked out
    // from the file (see homes.json), so it is declared, and this code reads the
    // declaration rather than the mesh.
    const HOME = "studio_apartment";
    Promise.all([
      fetch("/media/homes/homes.json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
      new Promise((ok, no) => loader.load(`/media/homes/${HOME}.glb`, ok, undefined, no)),
    ]).then(([manifest, gltf]) => {
      const home = gltf.scene;
      const spec = manifest?.[HOME];

      // Session 153 — the flat could not receive a shadow, and that was not a
      // lighting setting.
      //
      // Archviz home GLBs ship every material as KHR_materials_unlit
      // (studio_apartment.glb: 59/59, confirmed by JSON-chunk inspection in
      // Session 147), which three imports as MeshBasicMaterial: ignores
      // lights, ignores the environment, and CANNOT receive shadows. So her
      // shadow had nowhere to land and the room ignored every Display slider
      // — while the character tab, which rebuilds these on load, showed both
      // working. Same flat, same settings, two different answers.
      //
      // Ported from ActorModelPanel verbatim: rebuild each unlit material as
      // MeshStandardMaterial carrying the baked texture and colour forward.
      // Lit materials pass straight through, and shared materials stay shared.
      let convertedMats = 0;
      const matCache = new Map();
      const toLit = (m) => {
        if (!m || !m.isMeshBasicMaterial) return m;
        if (matCache.has(m)) return matCache.get(m);
        const std = new THREE.MeshStandardMaterial({
          name: m.name, map: m.map ?? null, color: m.color.clone(),
          roughness: 1, metalness: 0,
          transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest,
          side: m.side, depthWrite: m.depthWrite,
        });
        matCache.set(m, std);
        convertedMats++;
        return std;
      };
      home.traverse(o => {
        if (!o.isMesh) return;
        o.material = Array.isArray(o.material) ? o.material.map(toLit) : toLit(o.material);
        // The room casts as well as receives — a wall between the sun and the
        // floor beyond it has to block, or her shadow falls through it.
        o.castShadow = true;
        o.receiveShadow = true;
      });
      console.log(`[door] flat materials: ${convertedMats} unlit converted to lit — shadows and Display lighting now reach the room.`);

      if (spec?.door && spec?.facing) {
        // Turn the flat until its door faces out at you, then slide it so that
        // door sits in this doorway.
        const f = new THREE.Vector3(...spec.facing).setY(0).normalize();
        home.rotation.y = -Math.atan2(f.x, f.z);
        home.position.set(0, 0, 0);
        home.updateMatrixWorld(true);

        const d = new THREE.Vector3(...spec.door)
          .applyEuler(new THREE.Euler(0, home.rotation.y, 0));
        // Level with the door's own threshold, not with the lowest point in the
        // file. Using the shell minimum lifted the flat 22cm — the balcony lip
        // sits below floor level — and left her front door hanging above our
        // landing with daylight under it.
        home.position.set(-d.x, -d.y, -d.z);
        // Box3.setFromObject refreshes an object and its descendants but not its
        // ancestors, so measuring the leaf now without this would measure it
        // against the flat's previous position — which is how the first attempt
        // hung her door five metres behind the camera and left the doorway
        // showing an empty black rectangle.
        home.updateMatrixWorld(true);

        // Their door leaf now occupies our doorway — ours is the one that
        // swings, so theirs goes. Matched on the declared name rather than
        // guessed, because guessing is what put a refrigerator in the running
        // last time.
        for (const name of spec.hide || []) {
          home.traverse(o => {
            if (o.name && o.name.toLowerCase().startsWith(name.toLowerCase())) o.visible = false;
          });
        }
      } else {
        // No entry for this mesh. Centre it and say so — looking into a flat
        // from the wrong end still looks like a flat, and it beats not opening.
        console.warn(`[door] no door declared for ${HOME} — centring the flat instead`);
        const bb = new THREE.Box3().setFromObject(home);
        const c = bb.getCenter(new THREE.Vector3());
        home.position.set(-c.x, -bb.min.y, -c.z - 1.9);
      }

      a.scene.add(home);
      a.home = home;

      // Adopt her door. Object3D.attach keeps the leaf exactly where it is
      // while changing who moves it, so a pivot dropped on the hinge edge turns
      // a modelled door into a working one without touching its geometry.
      const leaf = spec?.leaf && home.getObjectByName(spec.leaf);
      if (leaf) {
        const lb = new THREE.Box3().setFromObject(leaf);
        // Session 153 — the doorway you actually walk through.
        //
        // walls_clear carries ONE invisible quad sealing the opening: back-face
        // culled so you see straight into the hall, solid to a capsule so you
        // could not step through it. Rather than declare another box in
        // homes.json, take the leaf's own footprint — the volume a door
        // occupies IS the aperture, by definition — and carve the collider
        // with it below. Derived from data already declared, not hardcoded.
        a.aperture = lb.clone().expandByScalar(0.06);
        const left = spec.hinge !== "right";
        const pivot = new THREE.Group();
        pivot.position.set(left ? lb.min.x : lb.max.x, lb.min.y, (lb.min.z + lb.max.z) / 2);
        a.scene.add(pivot);
        pivot.attach(leaf);
        a.leafPivot = pivot;
        a.leafWidth = Math.max(0.3, lb.max.x - lb.min.x);
        a.leafDir = left ? -1 : 1;

        // Her leaf swings; the hall side of it is ours.
        //
        // The outward face renders black, and it took three wrong theories to
        // find out why. Not the lighting: it is KHR_materials_unlit, so no lamp
        // was ever going to touch it, and rehanging the texture on a lit
        // material made it worse. Not the texture: its pixels measure
        // [216, 213, 208], almost white. Not the placement: strip the map and
        // the same geometry renders pure white, in the doorway, at the right
        // height.
        //
        // The UVs on that one face point at an unpainted corner of the atlas —
        // because this is an interior model and the outside of the front door
        // is a surface nobody standing in the flat can see. It was never
        // painted, and no home mesh bought off a shelf will have painted it.
        //
        // So the built door earns its keep after all, as a skin: hung a
        // centimetre proud on the hall side of her leaf and parented to the
        // same pivot, so it carries the paint, the panels, the handle and her
        // nameplate while everything behind it — the swing, the inside face,
        // the frame — is the flat's own.
        leaf.traverse(o => { if (o.isMesh) o.castShadow = false; });

        const skin = a.landing.hinge;
        skin.visible = true;
        skin.position.set(pivot.position.x, pivot.position.y, pivot.position.z + 0.062);
        pivot.attach(skin);
        console.log(`[door] swinging ${spec.leaf} from the ${left ? "left" : "right"}`);
      } else {
        // No door in the file at all. Ours does the whole job.
        a.landing.hinge.visible = true;
        a.leafPivot = a.landing.hinge;
        a.leafDir = -1;
        console.log("[door] no leaf in the mesh — using the built door");
      }
      a.landing.blank.visible = false;
      buildCollider(home);
      if (a.pendingOpen) openDoor();

      // Light from inside, past her, into the hall.
      // The warm lamp that sells the moment the door opens — light from a
      // lived-in flat falling onto a cold landing. It has no business lighting
      // the flat itself, which is the editor's job, so its reach is short and
      // tick fades it out the moment you step over the threshold.
      const warm = new THREE.PointLight(0xffcf9a, 16, 4, 2);
      warm.position.set(0, 1.95, -2.4);
      warm.visible = false;
      a.scene.add(warm);
      a.warm = warm;
      a.flatReady = true;
      checkSceneReady();
    }).catch(e => {
      console.warn("[door] flat failed", e);
      // Still a door to knock on, just nothing behind it.
      a.landing.hinge.visible = true;
      a.landing.blank.visible = false;
      a.leafPivot = a.landing.hinge;
      a.leafDir = -1;
      if (a.pendingOpen) openDoor();
      a.flatReady = true;
      checkSceneReady();
    });

    void 0;
  }

  // Her. Fetched in parallel with the knock decision (both fire on mount) and
  // reported honestly while it comes. The runtime model is ~26 MB and carries
  // her real solved height plus idle/walk clips. Fetched by hand rather than
  // through loader.load so a refusal can abort it mid-stream — GLTFLoader has
  // no cancel of its own.
  async function loadHer() {
    const a = api.current;
    if (!SHOW_AVATAR || !glbUrl || a.herLoading) return;
    a.herLoading = true;
    a.herAbort = new AbortController();
    setLoadPct(0);
    try {
      const res = await fetch(sameOriginMedia(glbUrl), { credentials: "include", signal: a.herAbort.signal });
      if (!res.ok) throw new Error(`avatar fetch ${res.status}`);
      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
      const chunks = []; let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.byteLength;
        if (total) setLoadPct(Math.round((got / total) * 100));
      }
      const buf = new Uint8Array(got);
      { let off = 0; for (const c of chunks) { buf.set(c, off); off += c.byteLength; } }
      if (a.abandoned) return;   // she said no while the bytes were coming
      const gltf = await new Promise((ok, no) => gltfLoader().parse(buf.buffer, "", ok, no));
      if (a.abandoned) return;
      setLoadPct(null);
      const her = gltf.scene;
      const bb = new THREE.Box3().setFromObject(her);
      const h = bb.max.y - bb.min.y;
      // The runtime model is built at her real height — rescale only if the
      // asset is in obviously wrong units, not to normalize a person.
      if (h > 0.1 && (h < 1.2 || h > 2.2)) her.scale.setScalar(1.68 / h);
      const bb2 = new THREE.Box3().setFromObject(her);
      const c2 = bb2.getCenter(new THREE.Vector3());
      // In the gap, a pace inside, turned slightly towards you. Added now,
      // behind the still-closed leaf, so the door only ever opens onto her.
      her.position.set(0.1 - c2.x, -bb2.min.y, -0.55 - c2.z);
      her.rotation.y = -0.28;   // towards the hall, not away from it
      // Session 153 — Genesis 9 ships two transmissive slivers on the eyes:
      // "EyeMoisture" and a tear mesh. A few hundred triangles nobody can see
      // past arm's length, and they were costing HALF the frame rate — three
      // renders the whole opaque scene into a second framebuffer every frame
      // if ANY material has transmission > 0, so the glass has something to
      // refract. Measured on her runtime GLB at 3200x1280: 12 fps with them,
      // 24 without. Two tear ducts, one entire extra scene pass.
      //
      // A wet eye is worth keeping, so refraction becomes ordinary alpha:
      // near-identical at conversation distance, one blended draw instead.
      let demoted = 0;
      her.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(m => {
          if (!m || !(m.transmission > 0)) return;
          m.transmission = 0;
          m.transparent  = true;
          m.opacity      = Math.min(m.opacity ?? 1, 0.15);
          m.depthWrite   = false;   // a film ON the eye, not a thing in front of it
          m.needsUpdate  = true;
          demoted++;
        });
      });
      if (demoted) console.log(`[door] ${demoted} transmissive material(s) demoted to alpha — no second scene pass`);
      a.scene.add(her);
      a.her = her;
      // She stands in the gap, breathing — the runtime clips are idle + walk.
      const clips = gltf.animations || [];
      const idle = clips.find(c => c.name === "idle") || clips[0];
      const walk = clips.find(c => c.name === "walk");
      if (idle) {
        a.mixer = new THREE.AnimationMixer(her);
        a.actions = { idle: a.mixer.clipAction(idle), walk: walk ? a.mixer.clipAction(walk) : null };
        a.actions.idle.play();
      }
      // Session 153 — she holds the doorway now.
      //
      // This used to start a scripted walk 2.2s after she opened: a beat to
      // look at you, then she turned and went in, on the reasoning that the
      // turn WAS the invitation. In practice you opened her door and got her
      // back — she was already halfway down the hall by the time she said
      // hello, and the greeting happened to nobody.
      //
      // And it was a timer, not a decision: she left on a stopwatch whatever
      // she had just said, which is the opposite of the thing her SCENE block
      // is for. She stays where she opened. Where she goes next comes from her
      // own words — see walkHerTo — so "come in, I'll put the kettle on" takes
      // her to the kitchen, and nothing else moves her at all.
      a.herRoom = "hall";
      a.herReady = true;
      checkSceneReady();
      if (readLab()?.stage === "inside" && a.doorOpen) placeHerForLab();
      aimSun();
      if (a.pendingOpen) openDoor();
      if (a.doorOpen) setReady(true);
    } catch (e) {
      setLoadPct(null);
      if (e?.name !== "AbortError") {
        console.warn("[door] avatar failed", e);
        // The door still opens — onto the gap, honestly — rather than never.
        a.herFailed = true;
        checkSceneReady();
        if (a.pendingOpen) openDoor();
      }
    }
  }

  // ── walking in ────────────────────────────────────────────────────────────
  //
  // One merged BVH over the flat's static meshes, and a capsule pushed out of
  // whatever it intersects. Copied from ActorModelPanel's Explore mode rather
  // than imported (see the constants above): the same approach, the same
  // numbers, none of the coupling. Her mesh is skinned and is excluded — you
  // walk around furniture, not through her, and she is handled separately.
  // Is this object inside any of these subtrees?
  function isUnderAny(obj, roots) {
    for (const r of roots) {
      if (!r) continue;
      for (let n = obj; n; n = n.parent) if (n === r) return true;
    }
    return false;
  }

  function buildCollider(home) {
    const a = api.current;
    const meshes = [];
    const box = new THREE.Box3();

    // The LANDING is solid too.
    //
    // This walked only the flat, so everything outside her threshold — the
    // landing floor, its side walls, the wall behind you, and the door itself —
    // had no collision at all. In first person you rarely noticed: you stood
    // still and knocked. In third person you walk around out here, and you walk
    // straight into the door and through the plaster. Measured 2026-09-03.
    //
    // The swinging leaf is deliberately NOT included: a BVH is static, so a
    // leaf baked at its closed position would wall off a doorway that is
    // visibly open. It is skipped by name, and by the existing !visible test.
    const roots = [home];
    if (a.landing?.group) roots.push(a.landing.group);

    for (const root of roots) root.traverse(o => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      if (o.isSkinnedMesh || o.morphTargetInfluences?.length || o.isInstancedMesh) return;
      if (!o.visible) return;                       // the hidden leaf, the balcony lip
      // The doors move; they cannot be static collision. There are TWO — her
      // flat's adopted leaf (a.leafPivot) and the landing's own (landing.hinge)
      // — and both swing, so a BVH baked while either is closed would wall off
      // a doorway you can see standing open. Walk the whole ancestor chain:
      // the leaf is a descendant, not a direct child, of its pivot.
      if (isUnderAny(o, [a.leafPivot, a.landing?.hinge])) return;
      box.setFromObject(o);
      const size = box.getSize(new THREE.Vector3());
      if (Math.max(size.x, size.z) < 0.15) return;  // too small to walk into
      meshes.push(o);
    });
    if (!meshes.length) { console.warn("[door] no collision meshes — FPV would walk through walls"); return; }
    try {
      const gen = new StaticGeometryGenerator(meshes);
      gen.attributes = ["position"];
      let merged = gen.generate();
      merged = carveAperture(merged, a.aperture);
      merged.boundsTree = new MeshBVH(merged);
      a.collider = merged;
      const shell = new THREE.Box3().setFromObject(home);
      a.floorY = 0;                                  // the flat is hung on our threshold
      a.bounds = { minX: shell.min.x + 0.35, maxX: shell.max.x - 0.35,
                   minZ: shell.min.z + 0.35, maxZ: shell.max.z + 1.6 };
      sizeShadowToRoom(shell);
      console.log(`[door] collision: ${meshes.length} meshes, ${(merged.index ? merged.index.count / 3 : 0).toFixed(0)} triangles`);
    } catch (e) {
      // Loudly, not silently — no collider means walking through the walls.
      a.collider = null;
      console.error("[door] FAILED to build collision BVH — FPV has no collision:", e);
    }
  }

  // Drop the triangles that seal the doorway, so the one thing you are meant
  // to walk through is the one thing you can. Everything else — walls, floor,
  // furniture — is untouched.
  function carveAperture(geo, aperture) {
    if (!aperture) return geo;
    const pos = geo.attributes.position;
    const idx = geo.index;
    const count = idx ? idx.count : pos.count;
    const keep = [];
    const a1 = new THREE.Vector3(), b1 = new THREE.Vector3(), c1 = new THREE.Vector3();
    const mid = new THREE.Vector3();
    let dropped = 0;
    for (let i = 0; i < count; i += 3) {
      const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
      a1.fromBufferAttribute(pos, ia); b1.fromBufferAttribute(pos, ib); c1.fromBufferAttribute(pos, ic);
      mid.copy(a1).add(b1).add(c1).multiplyScalar(1 / 3);
      if (aperture.containsPoint(mid)) { dropped++; continue; }
      keep.push(a1.x, a1.y, a1.z, b1.x, b1.y, b1.z, c1.x, c1.y, c1.z);
    }
    if (!dropped) return geo;
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(new Float32Array(keep), 3));
    console.log(`[door] carved ${dropped} triangle(s) out of the doorway aperture`);
    return out;
  }

  // The doors are deliberately NOT in the static BVH — they swing, and a BVH
  // baked with a closed leaf walls off an open doorway. The price was that the
  // leaf itself became intangible: measured 2026-09-03, the player stood
  // INSIDE the open leaf. So the leaf collides dynamically instead: a segment
  // from the hinge to the free edge at its CURRENT angle, and the capsule is
  // pushed out of it — the same treatment her body gets, shaped like a door.
  function pushOutOfLeaf(pos, pivotObj, width) {
    if (!pivotObj || !width) return;
    pivotObj.updateWorldMatrix(true, false);
    _leafH.setFromMatrixPosition(pivotObj.matrixWorld);
    pivotObj.getWorldQuaternion(_leafQ);
    _leafDir.set(1, 0, 0).applyQuaternion(_leafQ);
    _leafDir.y = 0;
    if (_leafDir.lengthSq() < 1e-6) return;
    _leafDir.normalize();
    const px = pos.x - _leafH.x, pz = pos.z - _leafH.z;
    let t = px * _leafDir.x + pz * _leafDir.z;
    t = Math.max(0, Math.min(width, t));
    const cx = _leafH.x + _leafDir.x * t, cz = _leafH.z + _leafDir.z * t;
    const dx = pos.x - cx, dz = pos.z - cz;
    const d = Math.hypot(dx, dz);
    const MIN = CAPSULE_RADIUS + 0.06;
    if (d > 1e-4) {
      if (d < MIN) { pos.x = cx + (dx / d) * MIN; pos.z = cz + (dz / d) * MIN; }
    } else {
      // Dead centre of the leaf plane: eject perpendicular to it.
      pos.x = cx + _leafDir.z * MIN;
      pos.z = cz - _leafDir.x * MIN;
    }
  }

  function resolveCapsule(position) {
    const a = api.current;
    if (!a.collider) return;
    const seg = _capSegment, box = _capBox;
    seg.start.set(position.x, a.floorY + CAPSULE_BOTTOM, position.z);
    seg.end.set(position.x, a.floorY + CAPSULE_TOP, position.z);
    box.makeEmpty();
    box.expandByPoint(seg.start); box.expandByPoint(seg.end);
    box.min.addScalar(-CAPSULE_RADIUS); box.max.addScalar(CAPSULE_RADIUS);
    a.collider.boundsTree.shapecast({
      intersectsBounds: (b) => b.intersectsBox(box),
      intersectsTriangle: (tri) => {
        const dist = tri.closestPointToSegment(seg, _triPoint, _capPoint);
        if (dist < CAPSULE_RADIUS) {
          const depth = CAPSULE_RADIUS - dist;
          _pushDir.copy(_capPoint).sub(_triPoint);
          if (_pushDir.lengthSq() < 1e-10) return false;
          _pushDir.normalize();
          seg.start.addScaledVector(_pushDir, depth);
          seg.end.addScaledVector(_pushDir, depth);
        }
        return false;
      },
    });
    position.x = seg.start.x;
    position.z = seg.start.z;
  }

  // Session 153 — ported from ActorModelPanel, which hit this first.
  //
  // The shadow camera was a fixed ±4m box aimed at HER, travelling as she
  // walked. Geometry outside a shadow camera cannot occlude anything, so the
  // far walls of an 11m flat were never drawn into the map and the light went
  // straight through them — the same reason her shadow fell through the
  // bathroom wall in the editor. Size the box to the flat it is lighting, aim
  // it at the middle of that flat, and buy back the sharpness the bigger box
  // costs rather than trading one bug for a mushier shadow.
  function sizeShadowToRoom(shell) {
    const a = api.current;
    const kl = a.key;
    if (!kl?.shadow || !shell) return;
    const halfX = Math.max(4, (shell.max.x - shell.min.x) / 2 + 1);
    const halfZ = Math.max(4, (shell.max.z - shell.min.z) / 2 + 1);
    const half  = Math.max(halfX, halfZ);
    kl.shadow.camera.left   = -half;
    kl.shadow.camera.right  =  half;
    kl.shadow.camera.top    =  half;
    kl.shadow.camera.bottom = -half;
    kl.shadow.camera.far    = Math.max(12, half * 3);
    const px = half > 6 ? 2048 : 1024;
    if (kl.shadow.mapSize.x !== px) {
      kl.shadow.mapSize.set(px, px);
      kl.shadow.map?.dispose();
      kl.shadow.map = null;
    }
    a.roomCentre = new THREE.Vector3((shell.min.x + shell.max.x) / 2, 0,
                                     (shell.min.z + shell.max.z) / 2);
    kl.shadow.camera.updateProjectionMatrix();
    console.log(`[door] shadow frustum sized to the flat: ±${half.toFixed(1)}m, ${px}px map.`);
    aimSun();
  }

  // Point the shadow box at the flat once it has been measured; at the doorway
  // before that, which is all there is to light.
  function aimSun() {
    const a = api.current;
    if (!a.key || !a.sunTarget) return;
    const at = a.roomCentre || (a.her ? a.her.position : new THREE.Vector3(0, 0, -1));
    a.sunTarget.position.set(at.x, 0, at.z);
    a.sunTarget.updateMatrixWorld();
    if (a.sunOffset) a.key.position.copy(a.sunTarget.position).add(a.sunOffset);
  }

  // Look-around when the pointer is NOT captured.
  //
  // Raw movement deltas alone stall at the screen edge: the cursor runs out of
  // desk, movementX becomes 0, and a 360 is impossible without lifting the
  // mouse and dragging again — the two faults reported. So near an edge the
  // camera keeps turning on its own, at a rate that grows as the pointer gets
  // closer to it. In the middle of the screen nothing changes: deltas drive it
  // 1:1 and it feels like an ordinary mouse-look.
  //
  // None of this runs when pointer lock is held — there the pointer is
  // infinite and deltas are all you need.
  function steerLook(delta) {
    const a = api.current;
    if (!a.walkMode || a.eyeToEye || a.fpv?.isLocked || document.pointerLockElement) return;
    const p = a.pointer;
    // Left the window, or the window lost focus: freeze. Without this the last
    // known position stays pinned at the edge and the world spins on for as
    // long as the pointer is away — which is exactly what happens when you
    // push past the window border.
    if (!p || a.pointerOutside) return;
    // Full rate is reached BEFORE the border, not at it, so turning never
    // requires shoving the pointer out of the window in the first place.
    // Session 153 — the edge zone is a FRACTION of the window, not 240px.
    //
    // These were absolute, picked when the window was about 1000px tall. The
    // desktop shell now opens ~540px tall on a 2560x720 desktop, where a 240px
    // band at the top and another at the bottom leaves a dead zone 58 pixels
    // high — rest the pointer almost anywhere and the camera pitches for as
    // long as you leave it there, with no input at all. Horizontally, at
    // 1600px wide, nothing was ever wrong, which is exactly why it presented
    // as "up and down drifts on its own".
    //
    // Proportional now, capped at the old numbers: a large window behaves
    // precisely as it did, and a short one keeps a dead zone worth the name.
    const RATE = 2.2;          // rad/s
    const zone = (size) => ({ edge: Math.min(240, size * 0.18),
                              full: Math.min(100, size * 0.07) });
    const zx = zone(p.w), zy = zone(p.h);
    const ramp = (d, z) => {
      if (d <= z.full) return 1;
      if (d >= z.edge) return 0;
      const t = (z.edge - d) / (z.edge - z.full);
      return t * t;            // gentle near the deadzone, firm approaching the edge
    };
    const yawRate   = (ramp(p.w - p.x, zx) - ramp(p.x, zx)) * RATE;
    const pitchRate = (ramp(p.h - p.y, zy) - ramp(p.y, zy)) * RATE;
    if (!yawRate && !pitchRate) return;
    const e = _steerEuler;
    e.setFromQuaternion(a.camera.quaternion);
    e.y -= yawRate * delta;
    e.x -= pitchRate * delta;
    const lim = Math.PI / 2 - 0.02;
    e.x = Math.max(-lim, Math.min(lim, e.x));
    a.camera.quaternion.setFromEuler(e);
  }

  // Her way in. Scripted rather than simulated — she has one thing to do here,
  // and a wander loop would be answering a question nobody has asked yet.
  // Session 153 — she is a person standing, not a prop placed.
  //
  // With the scripted walk-in gone she holds the doorway, which is right — but
  // perfectly still, on a looping idle, she reads as furniture the moment you
  // look at her for more than a few seconds. This is not wandering: no delta,
  // no destination, nothing that takes her out of the room her own words put
  // her in. A shift of weight, a glance around her own hallway, and now and
  // then half a step — the things a person does while deciding what to say.
  function idleHer(delta) {
    const a = api.current;
    const her = a.her;
    if (!her || !a.doorOpen) return;
    if (a.herWalk && a.herWalk.state !== "done") return;    // going somewhere wins
    const now = performance.now();
    if (!a.idleNext) { a.idleNext = now + 5000 + Math.random() * 7000; return; }

    // Ease toward whatever the last beat chose, every frame in between.
    if (a.idleTurn != null) {
      let d = a.idleTurn - her.rotation.y;
      while (d >  Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      her.rotation.y += d * Math.min(1, delta * 1.1);
    }
    if (now < a.idleNext) return;
    a.idleNext = now + 6000 + Math.random() * 9000;

    // A glance, anchored to where she is actually facing you.
    //
    // The first version was `rotation.y + random()`, which is a random WALK:
    // every glance compounds on the last, and measured live she had wandered
    // to -1.82 rad — 104 degrees, most of the way to showing you her back
    // while answering the door. A glance returns. Anchor it to her settled
    // facing and clamp the deviation, so she looks away and comes back.
    if (a.herFacing == null) a.herFacing = her.rotation.y;
    a.idleTurn = a.herFacing + (Math.random() - 0.5) * 0.5;

    // In the doorway she stays put. The frame is barely wider than she is, so
    // even 20cm sideways hides half of her behind it — and the doorway is the
    // one place in this flat where being seen is the whole point.
    if (a.herRoom === "hall") return;

    // Elsewhere, occasionally half a step, but only onto ground that was
    // ALREADY clear: clearSpot returning something different means the spot
    // was occupied, and a shuffle is not worth walking her into a wall for.
    if (Math.random() < 0.3) {
      const ang = Math.random() * Math.PI * 2;
      const r   = 0.18 + Math.random() * 0.2;
      const nx  = her.position.x + Math.cos(ang) * r;
      const nz  = her.position.z + Math.sin(ang) * r;
      const spot = clearSpot(nx, nz);
      if (Math.hypot(spot.x - nx, spot.z - nz) < 0.01) {
        a.herWalk = { state: "waiting", startAt: now,
                      to: new THREE.Vector3(spot.x, 0, spot.z) };
      }
    }
  }

  function stepHer(delta) {
    const a = api.current;
    const w = a.herWalk, her = a.her;
    if (!w || !her || w.state === "done") return;
    if (w.state === "waiting") {
      if (performance.now() < w.startAt) return;
      w.state = "walking";
      if (a.actions?.walk) {
        a.actions.walk.reset().play();
        a.actions.idle.crossFadeTo(a.actions.walk, 0.35, false);
      }
    }
    const dx = w.to.x - her.position.x, dz = w.to.z - her.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.06) {
      w.state = "done";
      // Session 153 — she turns to you when she gets there.
      //
      // She used to stop facing whatever direction she had been walking, so
      // after leading you in you got her back, and standing nose to nose in
      // the kitchen was luck rather than attention. Arriving somewhere near
      // you means looking at you; only if you are across the room does she
      // keep her travelling facing.
      const cam = api.current.camera;
      const fx = cam.position.x - her.position.x;
      const fz = cam.position.z - her.position.z;
      api.current.herFacing = Math.hypot(fx, fz) > 0.25
        ? Math.atan2(fx, fz)
        : her.rotation.y;
      api.current.idleTurn = api.current.herFacing;   // idle eases her round
      aimSun();
      if (a.actions?.walk) {
        a.actions.idle.reset().play();
        a.actions.walk.crossFadeTo(a.actions.idle, 0.4, false);
      }
      return;
    }
    const step = Math.min(dist, 0.95 * delta);           // her walking pace
    her.position.x += (dx / dist) * step;
    her.position.z += (dz / dist) * step;
    aimSun();
    // Face where she is going, turning into it rather than snapping to it.
    const want = Math.atan2(dx, dz);
    let d = want - her.rotation.y;
    while (d >  Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    her.rotation.y += d * Math.min(1, delta * 4);
  }

  // Direction comes from where you are looking, so it behaves like any
  // first-person control. Inert unless the pointer is actually locked.
  function stepPlayer(delta, camera) {
    const a = api.current;
    // Session 153 — gated on walk MODE, and never on pointer LOCK.
    //
    // The difference between those two cost an evening. Pointer lock is a flag
    // three separate things can falsify: PointerLockControls tracks isLocked
    // from a handler bound to the canvas it was built with, and the browser can
    // refuse or silently drop the lock for reasons the page never sees. Gating
    // the feet on it left the mouse looking around while the keys did nothing,
    // with nothing on screen to explain why.
    //
    // Walk mode is ours. You take it by clicking the room and give it back by
    // right-clicking, and it is the very same flag that hides the cursor. So
    // gating here makes the rule one you can SEE rather than one you have to
    // know: if the pointer is visible, you are not walking — the keys belong to
    // the page, where you might be typing to her.
    if (!a.canWalk || !a.walkMode || a.eyeToEye) return;
    const keys = a.keys;
    let forward = 0, strafe = 0;
    // You are driving now — the scripted move does not get to argue.
    if (a.dolly && (keys.size > 0)) a.dolly = null;
    if (keys.has("KeyW") || keys.has("ArrowUp"))    forward += 1;
    if (keys.has("KeyS") || keys.has("ArrowDown"))  forward -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) strafe  += 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft"))  strafe  -= 1;
    if (!forward && !strafe) {
      // Standing still: hand the animator back to idle.
      if (a.thirdPerson && a.moving) { a.moving = false; setPlayerClip("idle"); }
      return;
    }

    const look = new THREE.Vector3();
    camera.getWorldDirection(look);
    look.y = 0;
    if (look.lengthSq() < 1e-6) return;
    look.normalize();
    const right = new THREE.Vector3().crossVectors(look, UP).normalize();
    const move = look.multiplyScalar(forward).add(right.multiplyScalar(strafe));
    if (move.lengthSq() < 1e-6) return;

    // GTA-style: he turns to face the way he is GOING. The camera keeps its own
    // aim, so strafing swings him around rather than side-stepping — which is
    // exactly how both reference games read.
    if (a.thirdPerson) {
      a.moveDir = { x: move.x, z: move.z };
      if (!a.moving) { a.moving = true; setPlayerClip("walk"); }
    }
    if (!a.movedOnce) {
      a.movedOnce = true;
      console.log("[door] walking — pointer lock held, keys reaching the scene.");
    }
    const running = keys.has("ShiftLeft") || keys.has("ShiftRight");
    move.normalize().multiplyScalar(PLAYER_SPEED * (running ? 2 : 1) * delta);
    // In third person the BODY walks; the camera is placed from it afterwards
    // by placeThirdPersonCamera/1. In first person these are the same object,
    // so this is a no-op rename.
    const walker = (THIRD_PERSON && a.body) ? a.body : camera.position;
    walker.add(move);
    resolveCapsule(walker);
    // Only a CLOSED door is a barrier. Pushing the player off an OPEN leaf
    // walled off the very doorway that had just opened — "I can't walk into
    // the apartment", 2026-09-03. Collide her door only while it is shut; the
    // landing's outer door is scenery you already passed to knock, so it is
    // not collided at all.
    if (a.leafPivot && !a.doorOpen) pushOutOfLeaf(walker, a.leafPivot, a.leafWidth);
    // And she is solid. Her mesh is skinned, so it is deliberately not in the
    // static BVH — a person who moves is a standing cylinder you cannot walk
    // into, which is both cheaper and correct while she is walking.
    const her = a.her;
    if (her) {
      const hx = walker.x - her.position.x;
      const hz = walker.z - her.position.z;
      const hd = Math.hypot(hx, hz);
      const MIN = CAPSULE_RADIUS + 0.24;
      if (hd > 1e-4 && hd < MIN) {
        walker.x = her.position.x + (hx / hd) * MIN;
        walker.z = her.position.z + (hz / hd) * MIN;
      }
    }
    const b = a.bounds;
    if (b) {
      walker.x = Math.max(b.minX, Math.min(b.maxX, walker.x));
      walker.z = Math.max(b.minZ, Math.min(b.maxZ, walker.z));
    }
    walker.y = (a.floorY ?? 0) + EYE_HEIGHT;
  }

  // idle <-> walk, crossfaded rather than cut. 0.18s is short enough to feel
  // responsive on a key press and long enough not to pop.
  function setPlayerClip(name) {
    const a = api.current;
    if (!a || !a.meActions || a.meState === name) return;
    const next = a.meActions[name];
    const prev = a.meActions[a.meState];
    if (!next) return;
    next.reset().setEffectiveWeight(1).fadeIn(0.18).play();
    if (prev && prev !== next) prev.fadeOut(0.18);
    a.meState = name;
  }

  // Over-the-shoulder. Runs after every mover has had its say (walk, dolly,
  // eye-to-eye), so whatever moved the "player" this frame, the camera lands
  // in one consistent place relative to the body.
  //
  // The camera keeps its own orientation — PointerLockControls rotates it and
  // that is still what steers — so this only ever writes position. The body is
  // then yawed to match, which is what makes him turn on the spot when you
  // look around, the way both reference games do it.
  function placeThirdPersonCamera(dt = 1 / 60) {
    const a = api.current;
    if (!a || !a.thirdPerson || !a.body) return;
    const cam = a.camera;
    if (!cam) return;

    const look = new THREE.Vector3();
    cam.getWorldDirection(look);
    look.y = 0;
    if (look.lengthSq() < 1e-6) return;
    look.normalize();

    const floorY = a.floorY ?? 0;
    const right  = new THREE.Vector3().crossVectors(look, UP).normalize();

    // How far back we can actually sit. A wall behind you must not put the
    // camera inside it — pull in instead, which is what every third-person
    // game does in a corridor, and this flat is mostly corridor.
    let backTarget = CAM_BACK;
    const bt = a.collider?.boundsTree;
    if (bt) {
      _camRay.origin.set(a.body.x, floorY + CAM_UP, a.body.z);
      _camRay.direction.copy(look).negate();
      _camRay.far = CAM_BACK + 0.2;
      const hit = bt.raycastFirst(_camRay, THREE.DoubleSide);
      if (hit && hit.distance < backTarget) backTarget = Math.max(CAM_MIN_BACK, hit.distance - 0.18);
    }
    // The raycast flickers on/off across wall edges and mouse micro-movement,
    // snapping `back` between the clamped hit and full range every frame — a
    // hard position.set on that value is the camera SHAKE reported 2026-09-03.
    // Ease the distance toward its target instead of jumping to it.
    const kBack = 1 - Math.exp(-10 * dt);
    a.camBack = (a.camBack == null) ? backTarget : a.camBack + (backTarget - a.camBack) * kBack;
    const back = a.camBack;

    // The shoulder offset has to scale with how far back we actually got. A
    // wall can crush `back` to a fraction of CAM_BACK, and a full-width offset
    // against a short distance swings the body far off-axis — measured on the
    // landing: back collapsed to 0.63m, shoulder stayed 0.42m, and he sat ~60°
    // out of a 45° frame. Visible in the scene graph, invisible on screen.
    const shoulder = CAM_SHOULDER * Math.min(1, back / CAM_BACK);

    _camTarget.set(
      a.body.x - look.x * back + right.x * shoulder,
      floorY + CAM_UP,
      a.body.z - look.z * back + right.z * shoulder
    );

    // The landing is a CLOSED BOX, not open air: 3.7m deep with a plaster wall
    // across the back (Landing.js builds it). You stand at z≈2.82 to knock, so
    // a camera 2.45m behind you sits at z≈5.2 — through that wall, and the shot
    // is the grey outside face of it. The collider raycast above cannot catch
    // this because it tests the FLAT's BVH; the landing was never in it.
    //
    // Measured from the group rather than hard-coding 3.7, so this follows
    // Landing.js if its dimensions ever change.
    if (a.landing?.group) {
      if (!a.landingBox) a.landingBox = new THREE.Box3().setFromObject(a.landing.group);
      const lb = a.landingBox;
      // Only while the BODY is on the landing side of her threshold. Inside the
      // flat the collider raycast is the right authority and this must not fight it.
      if (a.body.z > -0.05 && isFinite(lb.max.z)) {
        const pad = 0.28;
        _camTarget.z = Math.min(_camTarget.z, lb.max.z - pad);
        _camTarget.x = Math.max(lb.min.x + pad, Math.min(lb.max.x - pad, _camTarget.x));
      }
    }

    // One smoothed commit. Everything above shaped a TARGET; the camera eases
    // to it so nothing above can jitter the actual view.
    cam.position.lerp(_camTarget, 1 - Math.exp(-14 * dt));

    // He faces where the camera is looking. Yaw only — a body that pitches
    // with the camera looks like a hinge, not a person.
    if (a.me) {
      a.me.position.set(a.body.x, floorY, a.body.z);
      // Facing: where he WALKS while moving, where the camera looks when still.
      // Turned toward the target rather than snapped — a body that changes
      // heading in one frame reads as a sprite, not a person.
      const want = (a.moving && a.moveDir)
        ? Math.atan2(a.moveDir.x, a.moveDir.z)
        : Math.atan2(look.x, look.z);
      let d = want - a.me.rotation.y;
      while (d >  Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      a.me.rotation.y += d * (1 - Math.exp(-9 * dt));
    }
  }

  // The player's own body.
  //
  // Deliberately RUNTIME-ONLY. The raw export for this player is 93 MB against
  // her 26 MB runtime build, and a fetch of it from the page failed outright on
  // 2026-09-02 while the same file served fine on the box — the tunnel will not
  // carry it. Loading it per scene would trade a working door for a body. If
  // there is no runtime model, say so once and run the rig without him rather
  // than hanging the scene.
  async function loadMe() {
    const a = api.current;
    if (!a || !a.thirdPerson || a.meLoading) return;
    if (!playerGlbUrl) {
      // No runtime body yet. A third-person camera with nothing in frame is
      // impossible to judge — you cannot tell a good shoulder distance from a
      // bad one against empty air — so stand a plain proxy at the body while
      // the real model is missing. Deliberately crude: nobody should mistake
      // this for the avatar, and it costs nothing to load.
      console.warn("[door] third person: no runtime model for the player — " +
                   "standing a proxy body. Push a runtime_glb_url through the avatar " +
                   "pipeline (the raw glb_url is ~93 MB and will not cross the tunnel).");
      const proxy = new THREE.Group();
      const mat   = new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: .85, metalness: .05 });
      const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.20, 0.72, 4, 12), mat);
      torso.position.y = 1.06;
      const head  = new THREE.Mesh(new THREE.SphereGeometry(0.125, 16, 12), mat);
      head.position.y = 1.62;
      // A nose, so which way he faces is readable at a glance — without it a
      // capsule gives you no way to see that the body yaws with the camera.
      const nose  = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.14, 8), mat);
      nose.rotation.x = Math.PI / 2;
      nose.position.set(0, 1.62, 0.12);
      proxy.add(torso, head, nose);
      proxy.traverse(o => { if (o.isMesh) o.castShadow = true; });
      proxy.position.set(a.body.x, a.floorY ?? 0, a.body.z);
      a.scene.add(proxy);
      a.me = proxy;
      a.meIsProxy = true;
      checkSceneReady();
      return;
    }
    a.meLoading = true;
    try {
      const res = await fetch(sameOriginMedia(playerGlbUrl), { credentials: "include" });
      if (!res.ok) throw new Error(`player avatar fetch ${res.status}`);
      const buf = await res.arrayBuffer();
      if (a.abandoned) return;
      const gltf = await new Promise((ok, no) => gltfLoader().parse(buf, "", ok, no));
      if (a.abandoned) return;
      const me = gltf.scene;
      // He is never rendered from his own eyes, so nothing here needs to hide
      // his head — but he DOES cast into the shot, which is most of the point.
      me.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
      me.position.set(a.body.x, a.floorY ?? 0, a.body.z);
      a.scene.add(me);
      a.me = me;
      a.meLoading = false;   // cleared on success, not just on failure

      // Same two clips hers carries. Without a mixer he loads in bind pose —
      // arms straight out — which is what the first third-person shot showed.
      const clips = gltf.animations || [];
      const idle  = clips.find(c => c.name === "idle") || clips[0];
      const walk  = clips.find(c => c.name === "walk");
      if (idle) {
        a.meMixer = new THREE.AnimationMixer(me);
        a.meActions = {
          idle: a.meMixer.clipAction(idle),
          walk: walk ? a.meMixer.clipAction(walk) : null,
        };
        a.meActions.idle.play();
        a.meState = "idle";
      }
      console.log("[door] player body in the scene —",
                  clips.map(c => c.name).join(", ") || "no clips");
      checkSceneReady();
    } catch (e) {
      console.warn("[door] player avatar failed", e);
      // No body loaded and none coming — a stuck spinner over a broken third
      // person rig would be worse than showing the empty rig, same as the
      // flat's own failure path above.
      a.meLoading = false;
      checkSceneReady();
    }
  }

  // Nobody is coming. Cancel what is in flight and drop what already arrived —
  // there is no second act to keep it for, and it is the largest thing on the
  // page.
  function abandon() {
    const a = api.current;
    if (!a || a.abandoned) return;
    a.abandoned = true;
    a.abort?.abort();
    a.herAbort?.abort();
    if (a.her) {
      a.mixer = null;
      a.scene.remove(a.her);
      a.her.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) [].concat(o.material).forEach(m => {
          Object.values(m).forEach(v => v?.isTexture && v.dispose());
          m.dispose();
        });
      });
      a.her = null;
    }
    if (a.home) {
      a.scene.remove(a.home);
      a.home.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) [].concat(o.material).forEach(m => {
          Object.values(m).forEach(v => v?.isTexture && v.dispose());
          m.dispose();
        });
      });
      a.home = null;
    }
    setReady(false);
    console.log("[door] she isn't opening — load abandoned");
  }

  function openDoor() {
    const a = api.current;
    if (!a.landing) return;
    if (!a.leafPivot) { a.pendingOpen = true; return; }   // the flat is still coming
    // Session 153 — and she has to be standing in it before it swings. Her
    // download started with the knock; if the decision beat the bytes, hold
    // the door and let the UI report the honest wait. A failed avatar load
    // sets herFailed and the door opens onto the gap rather than never.
    if (a.doorOpen) return;            // already open — re-running it reset the cursor
    const herExpected = SHOW_AVATAR && glbUrl;
    if (herExpected && !a.herReady && !a.herFailed) { a.pendingOpen = true; return; }
    a.pendingOpen = false;
    a.doorOpen = true;
    a.canWalk = true;
    // Walking is live from here. The pointer keeps its ordinary shape until
    // you take walk mode, and then disappears entirely.
    if (a.renderer) a.renderer.domElement.style.cursor = "";
    a.landing.under.material.opacity = 0;                 // the gap is the light now
    if (a.warm) a.warm.visible = true;
    const lab = readLab();
    if (lab && lab.stage === "inside") {
      // The past this run begins after already contains the door opening, so
      // there is nothing to watch: the leaf starts wide, and you start where
      // the fixture put you rather than dollying in from the landing.
      a.swing = { now: 1.16, to: 1.16, pivot: a.leafPivot, dir: a.leafDir };
      a.dolly = null;
      const you = ROOM_ANCHORS[normaliseRoom(lab.you) || "living_room"] || ROOM_ANCHORS.living_room;
      const spot = clearSpot(you.x, you.z);
      a.camera.position.set(spot.x, EYE_HEIGHT, spot.z);
      // Look at her, if the fixture says where she is. Facing a wall on entry
      // is disorienting and wastes the first seconds of every run; facing the
      // person you came to talk to is what someone standing there would do.
      const herKey = normaliseRoom(lab.her);
      const herAnchor = herKey && ROOM_ANCHORS[herKey];
      if (herAnchor && Math.hypot(herAnchor.x - spot.x, herAnchor.z - spot.z) > 0.4) {
        a.camera.lookAt(herAnchor.x, EYE_HEIGHT - 0.05, herAnchor.z);
      } else {
        a.camera.lookAt(spot.x, EYE_HEIGHT, spot.z + 2.5);
      }
      if (a.her) placeHerForLab();
      console.log(`[door] LAB inside — you in ${lab.you}, her in ${lab.her}`);
    } else {
      a.swing = { now: 0, to: 1.16, pivot: a.leafPivot, dir: a.leafDir };   // ~66°
      // Step to the threshold. Not through it — she has not asked you in yet.
      a.dolly = { pos: new THREE.Vector3(0.06, 1.62, 1.24), at: new THREE.Vector3(0, 1.2, -0.8) };
    }
    setReady(true);
  }

  // Session 153 — she is told he is typing.
  //
  // The simulator's silence initiative fires when nothing has been said for a
  // while, and cancels itself on a player_typing cast — plumbing that existed
  // end to end (route, proxy, GenServer cast) and that this scene simply never
  // called. So she "broke the silence" straight into a reply he was halfway
  // through writing, his message was classed as an interruption, and the
  // whole zombie-queue chain followed. One throttled ping while he types is
  // the difference between a conversation and a collision.
  const pingTyping = () => {
    const now = Date.now();
    if (now - typingPingRef.current < 4000) return;
    typingPingRef.current = now;
    if (!encounter_id || !world?.id) return;
    fetch(`/api/worlds/${world.id}/encounter/${encounter_id}/typing`,
          { method: "POST", credentials: "include" }).catch(() => {});
  };

  const timeStr = new Date().toLocaleTimeString("sv-SE",
    { hour: "2-digit", minute: "2-digit", timeZone: world?.timezone || "Europe/Stockholm" });

  // Session 153 — a refusal has to SAY it refused.
  //
  // This fell through to `narrative`, and when the narrative did not arrive it
  // fell through to "". So a knock she declined rendered as a closed door, no
  // text, and a small button off to one side — indistinguishable from the
  // scene being broken, which is exactly how it was reported. Three of her
  // four possible answers are silences of one kind or another; the scene has
  // to narrate the silence, because she is not going to.
  const firstName = (actorName || "They").split(" ")[0];
  const said = {
    knocking: rejoined ? `You are already at ${firstName}'s door.` : "You knock.",
    heard:    "A light goes on under the door.",
    error:    "The world isn't answering. Nothing to do with this character.",
    empty:    "Nobody lives here.",
  }[phase] || narrative || {
    send_text:    `${firstName} doesn't open the door. Your phone goes instead.`,
    ignore:       "Nothing comes. The light under the door stays exactly where it is.",
    pretend_away: `A sound inside, and then a careful quiet. ${firstName} would rather you thought nobody was home.`,
  }[decision] || "";

  return (
    <div className={styles.scene} ref={sceneRoot}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.locationName}>{location?.name}</span>
          {location?.area && <span className={styles.locationArea}>{location.area}</span>}
        </div>
        <div className={styles.headerRight}>
          <span className={styles.time}>{timeStr}</span>
          {/* A lab-built run offers the road back to its settings page; a real
              knock never shows this. Navigating does not end the encounter —
              rebuilding from the lab evicts it properly anyway. */}
          {new URLSearchParams(window.location.search).has("lab") && (
            <button className={styles.leaveBtn}
              onClick={() => routerNavigate("/lab/actor/apartment/encounter")}>
              Lab
            </button>
          )}
          <button className={styles.leaveBtn} onClick={onLeave}>Leave</button>
        </div>
      </div>

      <div ref={host} style={{ flex: 1, minHeight: 0, position: "relative",
                               background: "#0d0c0a", overflow: "hidden",
                               // A stacking context, explicitly. position:relative alone
                               // does not make one, so the canvas's z -1 escaped the host
                               // and painted BEHIND its black background — the whole scene
                               // vanished. isolate contains it: canvas above this
                               // background, below every overlay.
                               isolation: "isolate" }}>
        {/* Spinner until the flat, her avatar, and (third person) the
            player body have all actually landed. Opaque, so nothing behind
            it can pop or flash into view first; fades rather than snaps once
            everything is ready. */}
        {!sceneVisible && (
          <div style={{ position: "absolute", inset: 0, zIndex: 50,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        background: "#0d0c0a", transition: "opacity .5s ease" }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%",
                          border: "2px solid rgba(255,255,255,.12)",
                          borderTopColor: "rgba(201,151,58,.85)",
                          animation: "doorSceneSpin 0.9s linear infinite" }} />
            <style>{"@keyframes doorSceneSpin { to { transform: rotate(360deg); } }"}</style>
          </div>
        )}
        {/* Session 153 — her vitals, top left, as the old presence view had
            them. Never interactive: this is something you read while she is
            talking, not something you click, and in walk mode the pointer is
            gone anyway. */}
        {vitals && decision === "open_door" && (
          <div style={{ position: "absolute", top: 14, left: 16, zIndex: 12,
                        pointerEvents: "none", display: "flex", flexDirection: "column",
                        gap: 7, width: 170 }}>
            {Object.entries(VITAL_LABELS).map(([k, label]) => {
              const v  = Math.max(0, Math.min(1, vitals[k] ?? 0));
              const ch = changedVitals[k];
              const tint = ch === "up" ? "rgba(150,210,150,.95)"
                         : ch === "down" ? "rgba(222,140,130,.95)" : null;
              return (
                <div key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 8.5, letterSpacing: ".16em", textTransform: "uppercase",
                                   color: "rgba(255,255,255,.42)" }}>{label}</span>
                    <span style={{ fontSize: 9.5, fontVariantNumeric: "tabular-nums",
                                   color: tint || "rgba(255,255,255,.52)" }}>{v.toFixed(2)}</span>
                  </div>
                  <div style={{ height: 3, borderRadius: 2, background: "rgba(255,255,255,.10)" }}>
                    <div style={{ height: "100%", width: `${v * 100}%`, borderRadius: 2,
                                  transition: "width .7s cubic-bezier(.4,0,.2,1), background .35s",
                                  background: tint || "rgba(201,151,58,.75)" }} />
                  </div>
                </div>
              );
            })}
            {vitalToasts.length > 0 && (
              <div style={{ marginTop: 5, display: "flex", flexDirection: "column", gap: 3 }}>
                {vitalToasts.map(t => (
                  <span key={t.id} style={{ fontSize: 9, letterSpacing: ".03em",
                        color: t.up ? "rgba(150,210,150,.85)" : "rgba(222,140,130,.85)" }}>
                    {t.up ? "▲" : "▼"} {t.label} {t.from} → {t.to}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <div style={{
          position: "absolute", left: 0, right: 0, bottom: 0, padding: "26px 24px 24px",
          // White italic on whatever the renderer happens to show was fine
          // when the landing was near-black; the lighting rework made it a
          // lit hallway, and the words drowned. The scrim guarantees them.
          background: "linear-gradient(to top, rgba(8,7,6,.78), rgba(8,7,6,.35) 55%, rgba(8,7,6,0))",
          background: "linear-gradient(transparent, rgba(6,5,4,.92) 46%)", pointerEvents: "none",
          opacity: (inside || narrativeGone) ? 0 : 1, transition: "opacity 1.6s ease",
          pointerEvents: "none",
        }}>
          <p style={{
            fontFamily: "'Cormorant Garamond',serif", fontStyle: "italic", fontSize: 16,
            color: "rgba(255,255,255,.74)", margin: "0 auto", maxWidth: 520, textAlign: "center",
            lineHeight: 1.5, minHeight: 24,
          }}>{said}</p>

          <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 18, pointerEvents: "auto" }}>
            {/* Session 152 — no Enter button.
                A door that has already swung open, with the room lit behind it
                and her standing in it, does not need a second confirmation that
                you would like to go in. Once everything is on screen the scene
                hands over: the camera walks. Until then it says what it is
                waiting for rather than offering a button that is not ready. */}
            {decision === "open_door" && !ready && (
              <p style={{ textAlign: "center", fontSize: 10, letterSpacing: ".14em",
                textTransform: "uppercase", color: "rgba(255,255,255,.3)", margin: 0 }}>
                {loadPct !== null ? `${actorName} · ${loadPct}%` : "…"}
              </p>
            )}
            {/* Session 153 — every refusal offers the way out. send_text only
                offered "Read it", so declining to read the message left you
                stranded at a door with no exit but the header. Reading the
                text and walking away are both reasonable answers to a door
                that did not open; offer both. */}
            {(phase === "error" || decision === "ignore" || decision === "pretend_away" ||
              decision === "send_text") && (
              <button onClick={onLeave}
                style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 11, letterSpacing: ".1em",
                         textTransform: "uppercase", color: "rgba(255,255,255,.85)",
                         background: "rgba(8,7,6,.55)", border: "0.5px solid rgba(255,255,255,.35)",
                         borderRadius: 6, padding: "9px 20px", cursor: "pointer" }}>
                Walk away
              </button>
            )}
            {decision === "send_text" && (
              <button className={styles.enterBtn}
                onClick={() => (window.location.href = `/messages?actor=${actorId}`)}>Read it</button>
            )}
          </div>
        </div>

        {/* Session 153 — the handover, unannounced.
            A browser only grants pointer lock from a real user gesture, so the
            click itself cannot go; the sign telling you to click can, and has.
            She opens, she walks in, you follow — clicking the room is how you
            take the camera, and the chat panel already says so in one line. */}
        {decision === "open_door" && ready && !inside && (
          <div
            onClick={() => api.current.enterWalk?.()}
            style={{ position: "absolute", inset: 0, cursor: "pointer" }} />
        )}

        {/* The pointer cannot be trapped without pointer lock, and no amount of
            CSS substitutes for it. Say why rather than let it look broken. */}
        {inside && lockError && (
          <div style={{ position: "absolute", left: "50%", bottom: 22, transform: "translateX(-50%)",
                        fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase",
                        color: "rgba(255,255,255,.34)", background: "rgba(6,5,4,.55)",
                        border: "0.5px solid rgba(255,255,255,.1)", borderRadius: 999,
                        padding: "6px 14px", pointerEvents: "none", whiteSpace: "nowrap" }}>
            Mouse capture blocked here · steer by pushing to the edges
          </div>
        )}

        {/* The chat widget. It floats over the flat rather than sitting under
            it in a bar, because once you are inside the room is the scene and
            the conversation happens in it, not beneath it. */}
        {/* Once she has opened, talking is always available — the panel is part
            of the scene, not something that appears only after she happens to
            speak first. Hide it with the › tab or M if you want the room. */}
        {decision === "open_door" && (
          <div style={{
            // Docked to the right edge, full height, opening leftward — the
            // room is the scene now, and the conversation runs down the side
            // of it rather than sitting in a box on top of it.
            position: "absolute", top: 0, right: 0, bottom: 0, width: 400,
            maxWidth: "min(92vw, 400px)",
            transform: panelHidden ? "translateX(100%)" : "translateX(0)",
            transition: "transform .35s cubic-bezier(.4,0,.2,1)",
            // In walk mode the panel is scenery: it cannot take the pointer,
            // cannot be hovered into showing a cursor, and cannot steal focus.
            // Enter leaves the mode and hands it back.
            cursor: inside ? "none" : undefined,
            background: "linear-gradient(to left, rgba(8,7,6,.90) 62%, rgba(8,7,6,.62) 88%, rgba(8,7,6,0))",
            backdropFilter: "blur(12px)",
            borderLeft: "0.5px solid rgba(255,255,255,.08)",
            padding: "18px 18px 18px 26px",
            display: "flex", flexDirection: "column", gap: 10,
            pointerEvents: inside ? "none" : "auto",
          }}>
            {/* Session 153 — tabs live at the TOP of the dock, hard right.
                They were sitting just above the messages, which put them
                two-thirds of the way down a full-height panel: a tab strip
                reads as the thing you switch with, and that belongs where the
                eye starts, not buried next to the text it controls. */}
            <div style={{ display: "flex", justifyContent: "flex-end",
                          alignItems: "center", gap: 14 }}>
              {responding && (
                <span style={{ fontSize: 10, letterSpacing: ".1em", color: "rgba(201,151,58,.65)" }}>…</span>
              )}
              {[["chat", actorName || "Chat"], ["display", "Display"]].map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)}
                  style={{ background: "none", border: "none", padding: "0 0 3px",
                           cursor: inside ? "none" : "pointer",
                           fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase",
                           color: tab === id ? "rgba(201,151,58,.85)" : "rgba(255,255,255,.30)",
                           borderBottom: tab === id
                             ? "1px solid rgba(201,151,58,.45)" : "1px solid transparent" }}>
                  {label}
                </button>
              ))}
              <button onClick={() => setPanelHidden(true)} title="Hide (M)"
                style={{ background: "none", border: "none", cursor: inside ? "none" : "pointer",
                         padding: 0, fontSize: 15, lineHeight: 1,
                         color: "rgba(255,255,255,.32)" }}>›</button>
            </div>

            {/* Everything the tabs switch between still hangs from the bottom,
                so her words sit at eye level rather than under the title. */}
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
                          justifyContent: "flex-end", gap: 10 }}>

            {tab === "chat" && (<>
            <div className={styles.messages}
                 style={{ maxHeight: "none", flex: "0 1 auto", overflowY: "auto",
                          justifyContent: "flex-end", gap: 10 }}>
              {messages.map((m, i) => {
                return (
                <Fragment key={i}>
                  <div
                    className={`${styles.msg} ${m.from === "me" ? styles.msgMe : styles.msgThem}`}
                    style={m.from === "sys"
                      ? { alignSelf: "center", background: "none", border: "none",
                          color: "rgba(255,255,255,.35)", fontSize: 12, fontStyle: "italic" }
                      : { maxWidth: "92%" }}>
                    {m.text}
                    {m.at && m.from !== "sys" && (
                      <span style={{ display: "block", marginTop: 4, fontSize: 10,
                                     opacity: .38, textAlign: m.from === "me" ? "right" : "left" }}>
                        {stampOf(m.at)}
                      </span>
                    )}
                  </div>
                </Fragment>
                );
              })}
              {/* Session 153 — she is about to say something. The reply can take
                  seconds, and a panel that shows nothing in the meantime reads
                  as a panel that has stopped working. */}
              {responding && (
                <div className={`${styles.msg} ${styles.msgThem}`}
                     style={{ maxWidth: 74, padding: "10px 14px" }}>
                  <span className={styles.typing}>
                    <span className={styles.typingDot} />
                    <span className={styles.typingDot} />
                    <span className={styles.typingDot} />
                  </span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className={styles.chatRow}>
              <input
                ref={chatInputRef}
                className={styles.chatInput}
                value={chatInput}
                placeholder={encounterGone
                  ? "This conversation has ended \u2014 knock again"
                  : `Say something to ${(actorName || "").split(" ")[0]}…`}
                disabled={encounterGone}
                onFocus={() => setChatOpen(true)}
                onChange={(e) => { setChatInput(e.target.value); pingTyping(); }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") { e.preventDefault(); sendMessage(); }
                  if (e.key === "Escape") { e.currentTarget.blur(); setChatOpen(false); }
                }}
              />
              <button className={styles.sendBtn} onClick={sendMessage}
                disabled={sending || encounterGone || !chatInput.trim()}>↑</button>
            </div>

            {/* Session 153 — either of you can call eye contact. */}
            {ready && (
              <button onClick={() => setEyeToEye(!eyeToEye)}
                style={{ alignSelf: "flex-start", background: eyeToEye ? "rgba(201,151,58,.16)" : "transparent",
                         border: `0.5px solid ${eyeToEye ? "rgba(201,151,58,.45)" : "rgba(255,255,255,.13)"}`,
                         borderRadius: 4, padding: "5px 11px", cursor: inside ? "none" : "pointer",
                         fontSize: 9.5, letterSpacing: ".13em", textTransform: "uppercase",
                         color: eyeToEye ? "rgba(201,151,58,.9)" : "rgba(255,255,255,.4)" }}>
                {eyeToEye ? "Step back" : "Eye to eye"}
              </button>
            )}
            <span style={{ fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase",
                           color: "rgba(255,255,255,.2)" }}>
              {eyeToEye ? "Eye to eye · Esc steps back"
                        : inside ? "WASD to move · Esc releases the mouse"
                                 : "Enter to talk · click the room to walk"}
            </span>
            </>)}

            {tab === "display" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 20, overflowY: "auto",
                            // The scrollbar overlays the right edge and was
                            // sitting on top of every value. Give it its own lane.
                            paddingRight: 14 }}>
                <Row label="Render scale" value={`${Math.round(renderScale * 100)}%`}
                     hint={stats.w
                       ? `Drawing ${((stats.w * stats.h) / 1e6).toFixed(1)}M pixels. Below 100% only the room softens — this panel and the dialogue stay sharp.`
                       : "Only the 3D view is affected, never the text over it."}>
                  <input type="range" min={50} max={100} step={5}
                         value={Math.round(renderScale * 100)}
                         onChange={(e) => setRenderScale(Number(e.target.value) / 100)}
                         style={{ width: "100%", accentColor: "#c9973a" }} />
                </Row>

                <Row label="Look width" value={`${fovCap}°`}
                     hint="How wide the lens opens once you are inside the flat. Past about 100° a 32:9 screen shears whatever is not in the middle of it. The front door is framed separately and ignores this.">
                  <input type="range" min={80} max={120} step={5}
                         value={fovCap}
                         onChange={(e) => setFovCap(Number(e.target.value))}
                         style={{ width: "100%", accentColor: "#c9973a" }} />
                </Row>

                <Row label="Aspect"
                     hint={stats.w
                       ? `Frame is ${(stats.w / stats.h).toFixed(2)}:1. A maximised window is wider than this monitor — the menu and title bars take height and no width — so a ceiling here trades the excess for bars instead of stretch. Fullscreen needs none of it.`
                       : "Caps how wide the rendered frame may get, bars either side beyond that."}>
                  <div style={{ display: "flex", gap: 6 }}>
                    {ASPECT_CHOICES.map(([label, v]) => (
                      <button key={label} onClick={() => setMaxAspect(v)}
                        style={{ flex: 1, padding: "5px 0", fontSize: 10, letterSpacing: ".08em",
                                 cursor: inside ? "none" : "pointer", borderRadius: 4,
                                 background: maxAspect === v ? "rgba(201,151,58,.16)" : "transparent",
                                 border: `0.5px solid ${maxAspect === v
                                   ? "rgba(201,151,58,.45)" : "rgba(255,255,255,.12)"}`,
                                 color: maxAspect === v
                                   ? "rgba(201,151,58,.9)" : "rgba(255,255,255,.4)" }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </Row>

                {display && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16,
                                borderTop: "0.5px solid rgba(255,255,255,.08)", paddingTop: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between",
                                  alignItems: "center" }}>
                      <span style={{ fontSize: 10, letterSpacing: ".14em",
                                     textTransform: "uppercase",
                                     color: "rgba(255,255,255,.42)" }}>Shadows</span>
                      <input type="checkbox" checked={!!display.shadows}
                             onChange={(e) => setDisplay(d => ({ ...d, shadows: e.target.checked }))}
                             style={{ accentColor: "#c9973a", width: 15, height: 15,
                                      cursor: inside ? "none" : "pointer" }} />
                    </div>
                    {DISPLAY_CONTROLS.map(({ key: k, label, min, max, step, deg }) => (
                      <Row key={k} label={label}
                           value={deg ? `${Math.round(display[k])}°`
                                      : Number(display[k]).toFixed(2)}>
                        <input type="range" min={min} max={max} step={step}
                               value={display[k]}
                               onChange={(e) => setDisplay(d => ({ ...d, [k]: Number(e.target.value) }))}
                               style={{ width: "100%", accentColor: "#c9973a" }} />
                      </Row>
                    ))}
                    <span style={{ fontSize: 9, color: "rgba(255,255,255,.24)", lineHeight: 1.55 }}>
                      The same settings the character tab writes. Change them here and
                      they are changed there — one flat, one lighting.
                    </span>
                  </div>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: 6,
                              borderTop: "0.5px solid rgba(255,255,255,.08)", paddingTop: 14 }}>
                  {[["Frame rate", stats.fps ? `${stats.fps} fps` : "—"],
                    ["Drawing",    stats.w ? `${stats.w} × ${stats.h}` : "—"],
                    ["Display",    `${Math.round(window.screen.width * window.devicePixelRatio)} × ${Math.round(window.screen.height * window.devicePixelRatio)}`]]
                    .map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase",
                                     color: "rgba(255,255,255,.28)" }}>{k}</span>
                      <span style={{ fontSize: 10, color: "rgba(255,255,255,.5)",
                                     fontVariantNumeric: "tabular-nums" }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            </div>
          </div>
        )}
        {/* Session 153 — the way back to a hidden panel. Deliberately small and
            on the edge she is not standing on, so it never competes with the
            room for attention. */}
        {decision === "open_door" && panelHidden && (
          <button onClick={() => setPanelHidden(false)} title="Show the conversation (M)"
            style={{ position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)",
                     background: "rgba(8,7,6,.7)", backdropFilter: "blur(8px)",
                     border: "0.5px solid rgba(255,255,255,.1)", borderRight: "none",
                     borderRadius: "10px 0 0 10px", color: "rgba(255,255,255,.45)",
                     cursor: inside ? "none" : "pointer", padding: "16px 7px",
                     fontSize: 15, lineHeight: 1,
                     pointerEvents: inside ? "none" : "auto" }}>‹</button>
        )}
      </div>
    </div>
  );
}
