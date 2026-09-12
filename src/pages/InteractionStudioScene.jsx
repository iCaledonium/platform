import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { loadDisplay, applyDisplay, DISPLAY_DEFAULTS } from "./exploreDisplay.js";
import { attachKtx2 } from "../lib/gltfKtx2.js";
import { planPath } from "../lib/roomPath.js";
import { getAction, resolveTracks, sampleTrack, boneFor } from "../lib/bodyActions.js";

// ── The studio room ──────────────────────────────────────────────────────────
//
// Session 157 — an empty room, two bodies, and nothing else in it.
//
// Everything about how this renders is taken from the encounter and not
// re-decided here: ACES tone mapping, sRGB output, a PMREM'd RoomEnvironment
// so PBR has something to reflect, and the user's own exploreDisplay numbers
// for exposure, key, ambient, rim and shadows. That is the whole point of
// rehearsing here — a gesture that reads well in the studio has to read the
// same way at her door, and it cannot if the two rooms are lit by different
// constants. See exploreDisplay.js for why those numbers live in one file.
//
// What is deliberately NOT copied: the flat, the landing, the door, the BVH
// collider, pointer lock, first/third person. A rehearsal room is bare on
// purpose — you are looking at two people, not at architecture, and a collider
// would silently veto blocking that the encounter's own room may well allow.

// Media is a PATH, never the host baked into the database — the same rule
// DoorScene3D documents at length: actors.runtime_glb_url is stored absolute
// against the public ngrok domain, and fetching that from any other origin is
// a cross-origin fetch of an auth-gated file which fails outright.
function sameOriginMedia(u) {
  if (!u || typeof u !== "string") return u;
  const i = u.indexOf("/media/");
  return i > 0 ? u.slice(i) : u;
}

// The room. 7 x 7 and 2.8 high: big enough that "walk across and stop in front
// of her" is a real walk, small enough that both bodies stay in one frame.
export const ROOM = { size: 7, height: 2.8 };

// What the path planner must keep clear of the furniture. A body is not the
// point its feet stand on, and planning for the point is how she clips the
// corner of every table she rounds. 0.28 is half the shoulder width of the
// runtime models — consistent with `approach` refusing to close below 0.45,
// which is where two of them start to intersect.
export const BODY_RADIUS = 0.28;

// The furniture the room can hold. Half-extents and height in metres, because
// everything else in this file is: a chair you can walk around has to be the
// size of a chair, not of a placeholder.
//
// Footprints are axis-aligned, so rotation is quarter-turns only and a turned
// prop simply swaps its half-extents. A freely-rotatable box would need the
// path planner to handle oriented rectangles, and a chair at 37 degrees is not
// worth that: the planner's whole speed comes from axis-aligned tests.
// Each prop is a few boxes rather than one, because a single box the height of
// the whole thing is wrong in the way that matters: a chair drawn 0.92m solid
// is a plinth, and you cannot tell whether someone could sit on it. The MASS
// belongs at seat height; the back is a thin plate above it.
//
// `parts` are in local metres: [width, height, depth, x, y, z], y measured from
// the floor to the part's CENTRE. `hw/hd` stay the footprint the planner and
// the collision use — a chair's back does not make it harder to walk around.
export const PROP_TYPES = {
  table: {
    label: "Table", hw: 0.60, hd: 0.40, h: 0.74, color: 0x6f5f4d,
    parts: [
      [1.20, 0.06, 0.80, 0, 0.71, 0],
      [0.08, 0.68, 0.08, -0.52, 0.34, -0.32], [0.08, 0.68, 0.08, 0.52, 0.34, -0.32],
      [0.08, 0.68, 0.08, -0.52, 0.34, 0.32], [0.08, 0.68, 0.08, 0.52, 0.34, 0.32],
    ],
  },
  chair: {
    label: "Chair", hw: 0.24, hd: 0.24, h: 0.90, color: 0x7d6b55,
    // Where a body's hips go, and which way it faces when seated. `seatFacing`
    // is the sitter's heading in the prop's LOCAL frame. The rig's forward is
    // +z and this chair's backrest is at local −z, so someone with their back
    // against it faces local +z — that is ZERO, not π. It was π, which sat her
    // facing into the backrest and put the approach behind the chair.
    // The SURFACE, not the slab's centre. The seat box is 0.06 thick centred
    // at 0.45, so its top is 0.48 — aligning a body to 0.45 sank it into the
    // furniture by half the plank.
    seat: 0.48, seatFacing: 0,
    parts: [
      [0.46, 0.06, 0.46, 0, 0.45, 0],                 // seat, at sitting height
      [0.46, 0.44, 0.06, 0, 0.70, -0.20],             // back, a plate not a block
      [0.06, 0.45, 0.06, -0.19, 0.22, -0.19], [0.06, 0.45, 0.06, 0.19, 0.22, -0.19],
      [0.06, 0.45, 0.06, -0.19, 0.22, 0.19], [0.06, 0.45, 0.06, 0.19, 0.22, 0.19],
    ],
  },
  stool: {
    label: "Stool", hw: 0.19, hd: 0.19, h: 0.46, color: 0x7d6b55,
    seat: 0.47, seatFacing: null,   // no back, so any direction will do
    parts: [
      [0.36, 0.06, 0.36, 0, 0.44, 0],
      [0.10, 0.44, 0.10, 0, 0.22, 0],
    ],
  },
  bed: {
    label: "Bed", hw: 1.00, hd: 0.70, h: 0.55, color: 0x6b6257,
    seat: 0.42, seatFacing: 0,   // mattress top
    parts: [
      [2.00, 0.28, 1.40, 0, 0.28, 0],                 // mattress
      [2.00, 0.14, 1.40, 0, 0.09, 0],                 // base, slightly inset in look
      [0.16, 0.50, 1.40, -1.00, 0.35, 0],             // headboard
    ],
  },
};

// Two runtime models start to interpenetrate at about this separation. It is
// the floor under everything — physics, not manners — and nothing authored can
// go beneath it. `approach` already refuses to close below 0.4 for the same
// reason; this is what enforces it when a body is pushed rather than walked.
export const TOUCH_DISTANCE = 0.42;

// Roughly half the thickness of a thigh. What a body actually rests ON is the
// underside of its legs, not the hip joint — and the hip BONE sits deep inside
// the pelvis, well above the part that meets a chair. Aligning the bone to the
// seat put her 19cm into it. There is no collision between bodies and props, so
// nothing catches that: sitting is arithmetic, and the arithmetic has to
// account for the body's own thickness.
const THIGH_RADIUS = 0.075;

// How fast someone gives ground when their space is invaded. Slower than a
// walk: backing off is a flinch of the feet, not a departure.
const RETREAT_SPEED = 0.85;

const DEG = Math.PI / 180;
// Scratch, reused every frame — a slap allocating a Euler and a Quaternion per
// bone per frame is 300 objects a second for no reason.
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();

// Where the two of them stand when a script has not moved them yet. Facing
// each other across conversation distance, because that is the pose every
// authoring session starts by adjusting.
export const MARKS = {
  a: { x: -0.75, z: 0 },
  b: { x: 0.75, z: 0 },
};

// Where an arbitrary cast stands before anything has moved them. Two face each
// other across conversation distance, which is the pose every authoring session
// starts from; three or more stand on an arc of the same radius so everyone is
// in frame and nobody is behind anyone. Deterministic, so a composition reopens
// with its bodies where it left them.
export function marksFor(ids = []) {
  const out = {};
  const n = ids.length;
  if (n <= 2) {
    ids.forEach((id, i) => { out[id] = { ...(i === 0 ? MARKS.a : MARKS.b) }; });
    return out;
  }
  const R = 0.75 + 0.18 * (n - 2);
  ids.forEach((id, i) => {
    const th = Math.PI * (0.5 + (i / (n - 1)) * 1.0);   // a half-circle facing the camera
    out[id] = { x: Math.cos(th) * R, z: Math.sin(th) * R * 0.6 };
  });
  return out;
}

function gltfLoader() {
  const draco = new DRACOLoader();
  draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  attachKtx2(loader);   // runtime GLBs carry KTX2 textures — see lib/gltfKtx2.js
  return loader;
}

// One metre of floor, as a texture rather than as line geometry.
//
// The grid used to be a GridHelper — real lines, one per metre. Line geometry
// has no mipmaps, so at the shallow angles this camera actually sits at, the
// far half of the floor aliased into broken horizontal streaks: the classic
// moiré you get when a regular pattern is sampled at less than one pixel per
// cell. No amount of depth offset fixes it, because it was never z-fighting.
//
// Drawn once into a canvas, it becomes a texture with a mipmap chain, so the
// distance simply blurs toward flat floor colour the way it should, and
// anisotropic filtering keeps the near lines sharp at grazing angles.
function gridTexture(renderer) {
  const N = 512;
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, N, N);
  // Multiplied against the floor colour, so "white" is untouched floor and the
  // line is a slight darkening — a grid you can read off but never look at.
  g.strokeStyle = "rgba(0,0,0,0.16)";
  g.lineWidth = 3;
  g.strokeRect(0, 0, N, N);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(ROOM.size, ROOM.size);
  tex.anisotropy = renderer?.capabilities?.getMaxAnisotropy?.() || 1;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildRoom(scene, renderer) {
  const group = new THREE.Group();
  const S = ROOM.size, H = ROOM.height;

  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x9c948a, roughness: 0.92, metalness: 0,
    map: gridTexture(renderer),
  });
  const wallMat  = new THREE.MeshStandardMaterial({ color: 0xcfc9c1, roughness: 1, metalness: 0, side: THREE.BackSide });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(S, S), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  // One inward-facing box for the walls and ceiling. BackSide means the camera
  // can sit outside it and still see in, which is what an orbit rig needs —
  // four separate planes would clip away one at a time as you swung round.
  const shell = new THREE.Mesh(new THREE.BoxGeometry(S, H, S), wallMat);
  // Lifted 4mm so the box's BOTTOM face is not coplanar with the floor plane.
  // Both sat at exactly y=0, and two surfaces at identical depth are the
  // textbook cause of z-fighting: the hard-edged grey slabs that were crawling
  // across the floor as the camera moved. It read as "the floor renders badly"
  // and looked like a shadow or texture problem, which is why it survived —
  // nothing was wrong with either surface, only with them being in the same
  // place. The gap is invisible: it is the thickness of the line where the
  // walls meet the floor.
  shell.position.y = H / 2 + 0.004;
  shell.receiveShadow = true;
  group.add(shell);

  // The metre grid is in the floor's own texture now — see gridTexture. Walk-to
  // steps are authored in metres and an invisible coordinate system makes that
  // guesswork, so the grid stays; it just stopped being geometry.

  // Kept so a placement raycast has something to hit. Without it, dropping a
  // prop would have to guess where the floor is.
  group.userData.floor = floor;
  scene.add(group);
  return group;
}

// A ring on the floor under each body, in that role's colour. Two identical
// figures in a bare room are genuinely hard to tell apart while you author —
// this is the label that says which one step 3 is going to move.
function buildMark(color) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.26, 0.31, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.004;
  return ring;
}

// The first two keep the colours the studio has always used; the rest come off
// a palette. Looked up by slot id with an index fallback so an unfamiliar id
// still gets a ring rather than an undefined one.
const ROLE_PALETTE = [0xc9973a, 0x378add, 0x1d9e75, 0xb05c08, 0x7f77dd, 0xd85a30, 0x8b8781, 0x2f2c28];
export const ROLE_COLOR = { a: ROLE_PALETTE[0], b: ROLE_PALETTE[1] };
export function colorFor(id, index = 0) {
  return ROLE_COLOR[id] ?? ROLE_PALETTE[index % ROLE_PALETTE.length];
}

// `still` — hold the idle on its first frame instead of playing it.
//
// The idle is COMPOSED UNDER an authored pose: applyPose multiplies its deltas
// onto whatever the mixer left on each bone that frame. That is right in the
// studio, where she should keep breathing through a slap. It is wrong in the
// animation editor, where the body is the thing being authored — the chest
// rises, the arms drift, and the shape you are setting is never quite the
// shape you are looking at.
//
// Frozen rather than stopped. Stopping it entirely drops the body to the GLB's
// bind pose, arms out at forty-five degrees, and every pose in the library was
// authored as a delta from the idle's own stance. Holding frame zero keeps that
// stance and takes away only the motion.
export default function InteractionStudioScene({ cast, onRig, onStatus, still = false }) {
  const host = useRef(null);
  const stillRef = useRef(still);
  stillRef.current = still;
  const api  = useRef({});
  const [loading, setLoading] = useState({});   // role -> percent | null
  const [failed,  setFailed]  = useState({});

  // ── the room, once ─────────────────────────────────────────────────────────
  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14120f);

    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.05, 60);
    camera.position.set(0, 1.75, 4.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = DISPLAY_DEFAULTS.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    // PBR with nothing to reflect renders a person dark and plastic — the
    // encounter learned this the expensive way (Session 153). Same neutral
    // studio box through PMREM, no asset to ship.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    pmrem.dispose();

    // The same three lights the 3D character tab configures, at the same
    // hexes. A warmer bounce or a different rim colour here would light a
    // rehearsal differently from the scene it is rehearsing for.
    const ambient = new THREE.HemisphereLight(0xffffff, 0x444455, DISPLAY_DEFAULTS.ambientIntensity);
    const key = new THREE.DirectionalLight(0xffffff, DISPLAY_DEFAULTS.keyIntensity);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 14;
    key.shadow.camera.left = -5;
    key.shadow.camera.right = 5;
    key.shadow.camera.top = 5;
    key.shadow.camera.bottom = -5;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.03;
    const rim = new THREE.DirectionalLight(0xaaccff, DISPLAY_DEFAULTS.rimIntensity);
    rim.position.set(-2.6, 2.2, -3.4);
    scene.add(ambient, key, rim);

    const room = buildRoom(scene, renderer);

    // ── the furniture ────────────────────────────────────────────────────────
    //
    // The room is still bare by DEFAULT — that part of Session 157 stands. What
    // it now has is the ability to be furnished, because "she crosses the room
    // to him" is only a real rehearsal if the room is allowed to be in the way.
    // Each piece is a footprint the planner reads and a box you can see, from
    // ONE list: a table you can see but cannot bump into would make every test
    // run here a lie about the encounter.
    const furniture = new THREE.Group();
    scene.add(furniture);
    // NOTE: assigned into the api.current literal below, NOT onto api.current
    // here — that object is rebuilt a few lines down and anything set on it
    // beforehand disappears without a word.
    // A prop is a TYPE plus a place and a quarter-turn, not raw half-extents:
    // "a chair, there, facing that way". Sizes come from PROP_TYPES so every
    // chair in every scene is the same chair.
    // Props turn freely now, but the path planner only knows axis-aligned
    // rectangles — that is where its speed comes from. So a turned prop is
    // planned against the BOUNDING BOX of its rotated footprint: conservative,
    // never smaller than the truth. She gives a table at 37 degrees a little
    // more room than it strictly needs, which is the safe direction to be wrong.
    const propFootprint = (prop) => {
      const t = PROP_TYPES[prop.type] || PROP_TYPES.table;
      // `rot` was quarter-turns before free rotation; read it as one if `yaw`
      // is absent, so props saved earlier keep facing the way they were put.
      const yaw = Number.isFinite(prop.yaw) ? prop.yaw : ((prop.rot || 0) * Math.PI) / 2;
      const c = Math.abs(Math.cos(yaw)), sn = Math.abs(Math.sin(yaw));
      return {
        ...prop,
        yaw,
        hw: t.hw * c + t.hd * sn,
        hd: t.hw * sn + t.hd * c,
        h: t.h,
        color: t.color,
      };
    };

    const setObstacles = (list) => {
      while (furniture.children.length) {
        const g = furniture.children.pop();
        g.traverse?.((m) => { m.geometry?.dispose?.(); m.material?.dispose?.(); });
        g.geometry?.dispose?.();
        g.material?.dispose?.();
        furniture.remove(g);
      }
      const clean = (Array.isArray(list) ? list : [])
        .filter((o) => o && Number.isFinite(+o.x) && Number.isFinite(+o.z))
        .map((o) => (o.type ? propFootprint(o) : o))
        .map((o) => ({
          id: o.id, type: o.type || null, rot: o.rot || 0, yaw: o.yaw ?? 0,
          x: +o.x, z: +o.z,
          hw: Math.max(0.05, +o.hw || 0.5),
          hd: Math.max(0.05, +o.hd || 0.3),
          h:  Math.max(0.05, +o.h  || 0.72),
          color: o.color,
          label: String(o.label || "table").slice(0, 24),
        }));
      for (const o of clean) {
        const t = PROP_TYPES[o.type];
        const mat = new THREE.MeshStandardMaterial({ color: o.color ?? 0x6f5f4d, roughness: 0.75, metalness: 0 });
        const group = new THREE.Group();
        const parts = t?.parts || [[o.hw * 2, o.h, o.hd * 2, 0, o.h / 2, 0]];
        for (const [w, h, d, px, py, pz] of parts) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
          m.position.set(px, py, pz);
          m.castShadow = true;
          m.receiveShadow = true;
          // So a click on any part of a chair selects the chair.
          m.userData.propId = o.id;
          group.add(m);
        }
        group.position.set(o.x, 0, o.z);
        group.rotation.y = o.yaw ?? ((Math.PI / 2) * (o.rot || 0));
        group.userData.propId = o.id;
        furniture.add(group);
      }
      api.current.obstacles = clean;
      return clean;
    };

    // ── placing a prop ────────────────────────────────────────────────────────
    //
    // The Sims answer: pick a thing, then put it somewhere. A ghost follows the
    // floor under the cursor, a click drops it, Escape cancels, R turns it a
    // quarter. The alternative — typing coordinates into a box — is guesswork
    // about a room you are looking straight at.
    const rayc = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const floorOf = () => room?.userData?.floor;

    const floorPoint = (ev) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      rayc.setFromCamera(ndc, camera);
      const hit = rayc.intersectObject(floorOf(), false)[0];
      return hit ? { x: hit.point.x, z: hit.point.z } : null;
    };

    // Where this footprint lands, and what that means.
    //
    // Overlapping another prop is ALLOWED. A chair tucked under a table is the
    // commonest arrangement furniture has, and refusing it would contradict the
    // rig, which already has a `direct` walk mode written for exactly this case:
    // "sitting into a chair at a table means entering space the planner rightly
    // calls illegal". The planner treats props as boxes, so an overlapping pair
    // simply means that floor is not walkable — which is true, and is the
    // author's business rather than this function's.
    //
    // Leaving the ROOM is refused, because a prop outside the walls is not a
    // choice anybody is making on purpose.
    const OUT = "out", OVER = "over", CLEAR = "clear";
    const footprintState = (type, x, z, yaw, ignoreId) => {
      const t = PROP_TYPES[type] || PROP_TYPES.table;
      const c = Math.abs(Math.cos(yaw)), sn = Math.abs(Math.sin(yaw));
      const hw = t.hw * c + t.hd * sn, hd = t.hw * sn + t.hd * c;
      const limit = ROOM.size / 2;
      if (Math.abs(x) + hw > limit || Math.abs(z) + hd > limit) return OUT;
      for (const o of api.current.obstacles || []) {
        if (!o.type || o.id === ignoreId) continue;
        if (Math.abs(o.x - x) < o.hw + hw && Math.abs(o.z - z) < o.hd + hd) return OVER;
      }
      return CLEAR;
    };

    const onPlaceMove = (ev) => {
      const a = api.current;
      if (!a.placing) return;
      const p = floorPoint(ev);
      if (!p) return;
      a.placing.at = p;
      a.placing.ghost.position.set(p.x, 0, p.z);
      a.placing.ghost.rotation.y = a.placing.yaw;

      // The square on the floor is the thing you are actually deciding about:
      // not where the model's silhouette falls, but how much floor it takes
      // away from everyone who has to walk past it.
      const state = footprintState(a.placing.type, p.x, p.z, a.placing.yaw, a.placing.replaceId);
      a.placing.fits = state !== OUT;
      // Green clear, amber sharing the floor with something, red outside the
      // room. Only the red one refuses — amber is information, not a veto.
      const tint = state === OUT ? 0xd85a30 : state === OVER ? 0xc9973a : 0x1d9e75;
      if (a.placing.pad) {
        a.placing.pad.material.color.setHex(tint);
        a.placing.pad.material.opacity = state === CLEAR ? 0.26 : 0.34;
      }
      if (a.placing.edge) a.placing.edge.material.color.setHex(tint);
    };

    const onPlaceClick = (ev) => {
      const a = api.current;
      // Left button only. Every pointerdown used to drop the prop, so the
      // right-click that now turns it would have put it down instead — and a
      // middle-click always could.
      if (ev.button !== undefined && ev.button !== 0) return;
      if (a.picking) {
        const p = floorPoint(ev);
        if (p) { ev.preventDefault(); ev.stopPropagation(); a.picking(p); }
        return;
      }
      if (!a.placing) return;
      ev.preventDefault();
      ev.stopPropagation();
      const p = a.placing.at;
      if (!p) return;
      // The only refusal is a prop outside the walls. The square has been red
      // under the cursor the whole time, so this confirms what it already said.
      if (a.placing.fits === false) return;
      const keep = a.placing.replaceId;
      const prop = { id: keep || Math.random().toString(36).slice(2, 9), type: a.placing.type,
                     x: +p.x.toFixed(3), z: +p.z.toFixed(3), yaw: +a.placing.yaw.toFixed(4) };
      // Moving keeps the id, so every entry that names this prop still names it.
      const rest = (a.obstacles || []).filter(o => o.id !== keep);
      a.setObstacles([...rest, prop]);
      a.endPlacing?.();
      a.onProps?.(a.obstacles);
    };

    // Turning, wherever the instruction comes from. Fine by default, quarter
    // turns with shift — you usually want a chair askew by a little, and square
    // to the room occasionally.
    const turnPlacing = (coarse) => {
      const a = api.current;
      if (!a.placing) return;
      const step = coarse ? Math.PI / 2 : Math.PI / 12;
      a.placing.yaw = (a.placing.yaw + step) % (Math.PI * 2);
      a.placing.ghost.rotation.y = a.placing.yaw;
      // Re-run the move so the footprint re-tests against the room: a chair
      // that fits lengthwise in a gap does not fit across it, and the square
      // has to say so as it turns.
      onPlaceMove({ clientX: a.placing.lastX, clientY: a.placing.lastY });
    };

    const onPlaceKey = (ev) => {
      const a = api.current;
      if (!a.placing) return;
      if (ev.key === "Escape") a.endPlacing?.();
      if (ev.key.toLowerCase() === "r") turnPlacing(ev.shiftKey);
    };

    renderer.domElement.addEventListener("pointermove", (e) => {
      const a = api.current;
      if (a.placing) { a.placing.lastX = e.clientX; a.placing.lastY = e.clientY; }
      onPlaceMove(e);
    });
    renderer.domElement.addEventListener("pointerdown", onPlaceClick, true);
    // Right-click turns whatever you are holding, so a prop can be placed and
    // squared up without the hand leaving the mouse. Only while placing: the
    // rest of the time the browser's own menu is nobody's to take away.
    renderer.domElement.addEventListener("contextmenu", (ev) => {
      if (!api.current.placing) return;
      ev.preventDefault();
      ev.stopPropagation();
      turnPlacing(ev.shiftKey);
    }, true);
    window.addEventListener("keydown", onPlaceKey);

    const controls = new OrbitControls(camera, renderer.domElement);
    // Touching the mouse takes the camera back. No mode to leave and nothing
    // fighting you for it — a scripted shot that kept snapping the view out of
    // your hands would be worse than no scripted shot at all.
    controls.addEventListener("start", () => { if (api.current) api.current.activeShot = null; });
    controls.target.set(0, 1.1, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.8;
    controls.maxDistance = 9;
    // Never below the floor: an orbit that dips under the ground plane shows
    // the underside of the room and reads as the model having vanished.
    controls.maxPolarAngle = Math.PI / 2 - 0.03;
    controls.update();

    api.current = { scene, camera, renderer, controls, room, ambient, key, rim,
                    figures: {}, timer: new THREE.Timer(), el,
                    obstacles: [], setObstacles, furniture,
                    pickPoint: (cb) => {
                      const a = api.current;
                      a.picking = (p) => { a.picking = null; controls.enabled = true; cb?.(p); };
                      controls.enabled = false;
                      return true;
                    },
                    cancelPick: () => {
                      const a = api.current;
                      a.picking = null;
                      controls.enabled = true;
                      return true;
                    },
                    // Pick a placed prop back up. It leaves the room the moment you
                    // lift it — a ghost AND the thing it stands for both drawn is
                    // two chairs — and comes back with the same id when you put it
                    // down, so nothing that referred to it has to be rewritten.
                    moveProp: (id) => {
                      const a = api.current;
                      const it = (a.obstacles || []).find(o => o.id === id);
                      if (!it) return false;
                      // Out of the ROOM, so the ghost is not drawn on top of the
                      // thing it stands for and the footprint does not collide
                      // with itself — but NOT out of the composition. Telling the
                      // page it had gone made "walk to a prop" unmeasurable, so
                      // both entries started at zero, overlapped, and the
                      // character's track split into two lanes for as long as the
                      // chair was in your hand. It is being moved, not deleted.
                      const original = { ...it };
                      a.setObstacles((a.obstacles || []).filter(o => o.id !== id));
                      return a.beginPlacing(it.type, { yaw: it.yaw ?? 0, replaceId: id, original });
                    },
                    beginPlacing: (type, opts = {}) => {
                      const a = api.current;
                      a.endPlacing?.();
                      const t = PROP_TYPES[type] || PROP_TYPES.table;
                      const gm = new THREE.MeshStandardMaterial({ color: t.color, transparent: true,
                                                                  opacity: 0.45, depthWrite: false });
                      const ghost = new THREE.Group();
                      for (const [w, h, d, px, py, pz] of (t.parts || [[t.hw * 2, t.h, t.hd * 2, 0, t.h / 2, 0]])) {
                        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), gm);
                        m.position.set(px, py, pz);
                        ghost.add(m);
                      }
                      // The footprint. A filled square plus a bright edge, flat on
                      // the floor, sized to the prop's own half-extents — the same
                      // numbers the path planner will use once it is down.
                      const pad = new THREE.Mesh(
                        new THREE.PlaneGeometry(t.hw * 2, t.hd * 2),
                        new THREE.MeshBasicMaterial({ color: 0x1d9e75, transparent: true,
                                                      opacity: 0.26, depthWrite: false,
                                                      side: THREE.DoubleSide }));
                      pad.rotation.x = -Math.PI / 2;
                      pad.position.y = 0.006;
                      ghost.add(pad);

                      const edge = new THREE.LineSegments(
                        new THREE.EdgesGeometry(new THREE.PlaneGeometry(t.hw * 2, t.hd * 2)),
                        new THREE.LineBasicMaterial({ color: 0x1d9e75 }));
                      edge.rotation.x = -Math.PI / 2;
                      edge.position.y = 0.008;
                      ghost.add(edge);

                      ghost.position.set(0, 0, 0);
                      scene.add(ghost);
                      a.placing = { type, yaw: opts.yaw || 0, ghost, pad, edge, fits: true,
                                    replaceId: opts.replaceId || null,
                                    original: opts.original || null,
                                    at: null, lastX: 0, lastY: 0 };
                      ghost.rotation.y = a.placing.yaw;
                      // Orbiting while placing fights the cursor for the same
                      // drag, so it waits its turn.
                      controls.enabled = false;
                      return true;
                    },
                    endPlacing: () => {
                      const a = api.current;
                      if (!a.placing) return false;
                      scene.remove(a.placing.ghost);
                      // The ghost became a GROUP when props gained real shapes;
                      // disposing it as if it were a single mesh threw on every
                      // placement and took the whole click with it.
                      a.placing.ghost.traverse((m) => {
                        m.geometry?.dispose?.();
                        m.material?.dispose?.();
                      });
                      // Cancelled mid-move: put it back where it was. Without
                      // this, Escape while holding a prop is a delete that looks
                      // like a cancel — and the page never heard it leave, so the
                      // panel would go on listing furniture the room no longer had.
                      const back = a.placing.original;
                      if (back && !(a.obstacles || []).some(o => o.id === back.id)) {
                        a.setObstacles([...(a.obstacles || []), back]);
                      }
                      a.placing = null;
                      controls.enabled = true;
                      return true;
                    } };

    // The user's own lighting, once it arrives. Defaults render immediately
    // rather than waiting on a preferences fetch — an unlit room while the
    // network decides is worse than one lit by the constants.
    const abort = new AbortController();
    loadDisplay({ signal: abort.signal }).then(display => {
      const a = api.current;
      if (!a.renderer) return;
      a.display = display;
      applyDisplay(display, { renderer: a.renderer, scene: a.scene, key: a.key, ambient: a.ambient, rim: a.rim });
    });

    const onResize = () => {
      const a = api.current;
      if (!a.renderer || !a.el) return;
      const w = a.el.clientWidth, h = a.el.clientHeight;
      if (!w || !h) return;
      a.camera.aspect = w / h;
      a.camera.updateProjectionMatrix();
      a.renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const a = api.current;
      if (!a.renderer) return;
      a.timer.update();
      const delta = Math.min(a.timer.getDelta(), 0.1);
      for (const role of Object.keys(a.figures)) stepFigure(a.figures[role], delta);
      keepApart(a, delta);
      // Re-frame AFTER the bodies have moved this frame, so the shot is about
      // where they are now rather than where they were when the step began.
      if (a.activeShot && a.reframe) a.reframe(a.activeShot);
      a.controls.update();
      a.renderer.render(a.scene, a.camera);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      abort.abort();
      ro.disconnect();
      controls.dispose();
      envRT.dispose();
      scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach(m => { Object.values(m).forEach(v => v?.isTexture && v.dispose()); m.dispose(); });
        }
      });
      renderer.dispose();
      try { el.removeChild(renderer.domElement); } catch {}
      api.current = {};
    };
  }, []);

  // ── casting ────────────────────────────────────────────────────────────────
  //
  // Each role loads independently and reports its own progress, because they
  // do not arrive together: a 26 MB runtime model over the tunnel takes
  // seconds, and a studio that shows nothing until BOTH are in looks broken
  // for the whole of the first one.
  useEffect(() => {
    const ids = Object.keys(cast || {});
    // Anyone standing in the room who is no longer in the cast leaves it.
    for (const role of Object.keys(api.current.figures || {})) {
      if (!ids.includes(role)) removeFigure(role);
    }
    for (const role of ids) {
      const want = cast?.[role]?.glb_url || null;
      const have = api.current.figures?.[role];
      if (have?.url === want) continue;
      if (have) removeFigure(role);
      if (want) loadFigure(role, cast[role], ids.indexOf(role), ids);
    }
    // A signature over the whole cast, so adding a third body re-runs this the
    // same way swapping the second one does. The old dependency list named
    // a and b literally and could not see a change to anyone else.
  }, [Object.entries(cast || {}).map(([k, v]) => `${k}:${v?.id || ""}:${v?.glb_url || ""}`).join("|")]);   // eslint-disable-line react-hooks/exhaustive-deps

  function removeFigure(role) {
    const a = api.current;
    const fig = a.figures?.[role];
    if (!fig) return;
    fig.abort?.abort();
    fig.pending.forEach(p => p.reject?.(new Error("recast")));
    a.scene.remove(fig.group);
    fig.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(m => { Object.values(m).forEach(v => v?.isTexture && v.dispose()); m.dispose(); });
      }
    });
    delete a.figures[role];
    publishRig();
  }

  async function loadFigure(role, person, index = 0, ids = [role]) {
    const a = api.current;
    if (!a.scene) return;
    const url = person.glb_url;
    const abort = new AbortController();
    setFailed(f => ({ ...f, [role]: null }));
    setLoading(l => ({ ...l, [role]: 0 }));
    try {
      // Fetched by hand rather than through loader.load so a recast can abort
      // it mid-stream — GLTFLoader has no cancel of its own — and so the panel
      // can show a real percentage on a 26 MB body.
      const res = await fetch(sameOriginMedia(url), { credentials: "include", signal: abort.signal });
      if (!res.ok) throw new Error(`model fetch ${res.status}`);
      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
      const chunks = []; let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.byteLength;
        if (total) setLoading(l => ({ ...l, [role]: Math.round((got / total) * 100) }));
      }
      const buf = new Uint8Array(got);
      { let off = 0; for (const c of chunks) { buf.set(c, off); off += c.byteLength; } }
      const gltf = await new Promise((ok, no) => gltfLoader().parse(buf.buffer, "", ok, no));
      if (!api.current.scene) return;

      const model = gltf.scene;
      const bb = new THREE.Box3().setFromObject(model);
      const h = bb.max.y - bb.min.y;
      // The runtime model is built at her real height — rescale only if the
      // asset is in obviously wrong units, never to normalize a person.
      if (h > 0.1 && (h < 1.2 || h > 2.2)) model.scale.setScalar(1.68 / h);
      const bb2 = new THREE.Box3().setFromObject(model);
      const c2 = bb2.getCenter(new THREE.Vector3());
      // Feet on the floor, centred on its own origin, so the GROUP's position
      // is simply where this person is standing. Everything that moves them
      // moves the group; nothing has to know about the model's own offsets.
      model.position.set(-c2.x, -bb2.min.y, -c2.z);

      // Genesis 9's two transmissive eye slivers cost an entire extra scene
      // pass — measured at half the frame rate in the encounter (Session 153).
      // Same demotion here, for the same reason.
      let demoted = 0;
      model.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(m => {
          if (!m || !(m.transmission > 0)) return;
          m.transmission = 0; m.transparent = true;
          m.opacity = Math.min(m.opacity ?? 1, 0.15);
          m.depthWrite = false; m.needsUpdate = true;
          demoted++;
        });
      });
      if (demoted) console.log(`[studio] ${role}: ${demoted} transmissive material(s) demoted to alpha`);

      const group = new THREE.Group();
      group.add(model);
      group.add(buildMark(colorFor(role, index)));
      const marks = marksFor(ids);
      const mark = marks[role] || MARKS.a;
      group.position.set(mark.x, 0, mark.z);
      // Facing the other mark to begin with: two people put in a room back to
      // back is a bug report waiting to happen.
      // Face the middle of everyone else. With two that is the other person,
      // which is what it always did; with three or more it is the huddle,
      // rather than whichever body happens to be called "b".
      {
        const others = ids.filter(r => r !== role).map(r => marks[r]).filter(Boolean);
        const focus = others.length
          ? { x: others.reduce((s, m) => s + m.x, 0) / others.length,
              z: others.reduce((s, m) => s + m.z, 0) / others.length }
          : { x: 0, z: 0 };
        group.rotation.y = Math.atan2(focus.x - mark.x, focus.z - mark.z);
      }
      a.scene.add(group);

      const mixer = new THREE.AnimationMixer(model);
      const clips = {};
      (gltf.animations || []).forEach(c => { clips[c.name] = c; });
      // The REST rotation of every bone, taken before a single frame of
      // animation has run. Authored poses compose onto this.
      //
      // They used to compose onto whatever the bone happened to be doing when
      // the pose began — which for a body that had just WALKED to a chair meant
      // a stride was frozen into the posture: she sat with one leg stuck
      // straight out. The base has to be a fixed reference, not a moving one.
      const rest = new Map();
      model.traverse((o) => { if (o.isBone) rest.set(o.name, o.quaternion.clone()); });

      // How high the foot BONE sits when the sole is on the floor. Measured off
      // this body standing at rest rather than assumed, because it is a
      // property of the skeleton: driving the bone itself to y=0 buries the
      // foot by exactly this much, which is what put her legs through the
      // floorboards.
      // Left null: measured later, standing, because the bind pose is not it.
      const sole = null;

      const fig = {
        role, url, person, group, model, mixer, clips, rest, sole,
        actions: {}, current: null, abort,
        walk: null, turn: null, pending: [],
        home: { x: mark.x, z: mark.z, ry: group.rotation.y },
      };
      a.figures[role] = fig;

      // Standing still is a state, not the absence of one: without an idle
      // playing, a GLB renders in bind pose — arms out, a shop dummy.
      const idleName = clips.idle ? "idle" : Object.keys(clips)[0];
      if (idleName) {
        playClip(fig, idleName, { loop: true, fade: 0 });
        if (stillRef.current && fig.current) { fig.current.paused = true; fig.current.time = 0; }
      }

      setLoading(l => ({ ...l, [role]: null }));
      publishRig();
      onStatus?.({ role, ready: true, clips: Object.keys(clips) });
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.warn(`[studio] ${role} failed to load`, e);
      setLoading(l => ({ ...l, [role]: null }));
      setFailed(f => ({ ...f, [role]: String(e?.message || e) }));
      onStatus?.({ role, ready: false, error: String(e?.message || e) });
    }
  }

  // ── what a body can be told to do ─────────────────────────────────────────
  //
  // Each of these returns a promise the RUNNER awaits, and every one of them
  // is resolved from the animation loop rather than from a timer: a walk is
  // over when the feet arrive, not when a stopwatch says it should have.

  function playClip(fig, name, { loop = true, fade = 0.35 } = {}) {
    const clip = fig.clips[name];
    if (!clip) return Promise.reject(new Error(`no clip “${name}” on ${fig.person?.name || fig.role}`));
    let action = fig.actions[name];
    if (!action) { action = fig.mixer.clipAction(clip); fig.actions[name] = action; }

    action.reset();
    action.enabled = true;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.play();
    const prev = fig.current;
    if (prev && prev !== action && fade > 0) prev.crossFadeTo(action, fade, false);
    else if (prev && prev !== action) prev.stop();
    fig.current = action;

    if (loop) return Promise.resolve();
    // A one-shot resolves on the mixer's own finished event for THIS action —
    // duration arithmetic drifts, and a clip retimed in Blender would then
    // resolve at the wrong moment forever after.
    return new Promise((resolve) => {
      const onFinished = (e) => {
        if (e.action !== action) return;
        fig.mixer.removeEventListener("finished", onFinished);
        resolve();
      };
      fig.mixer.addEventListener("finished", onFinished);
    });
  }

  function walkTo(fig, x, z, { speed = 0.95, direct = false } = {}) {
    return new Promise((resolve) => {
      // A second walk order replaces the first rather than queueing behind it:
      // whoever asked last is who you are watching.
      fig.walk?.resolve?.();
      const back = fig.current;
      if (fig.clips.walk) playClip(fig, "walk", { loop: true, fade: 0.35 });

      // `direct` walks OFF the map, deliberately. Sitting into a chair at a
      // table means entering space the planner rightly calls illegal — the
      // gap between seat and table is narrower than a body radius. A person
      // does it anyway; that last metre is a squeeze, not a route.
      if (direct) {
        fig.walk = { to: new THREE.Vector3(x, 0, z), queue: [], speed, resolve, back, blocked: false };
        return;
      }

      // The route is planned HERE, once, against the room as it stands at the
      // moment the step begins — not baked into the script. That is the whole
      // property: put a table between them and this returns a way round it;
      // take the table away and the same step returns a straight line. The
      // author wrote "cross the room to him" either way.
      const plan = planPath(
        { x: fig.group.position.x, z: fig.group.position.z },
        { x, z },
        api.current.obstacles || [],
        { radius: BODY_RADIUS },
      );
      const queue = plan.waypoints.slice();
      const first = queue.shift() || { x, z };
      fig.walk = { to: new THREE.Vector3(first.x, 0, first.z), queue, speed, resolve, back, blocked: plan.blocked };
    });
  }

  function turnTo(fig, heading) {
    return new Promise((resolve) => {
      fig.turn?.resolve?.();
      fig.turn = { want: heading, resolve };
    });
  }

  function headingFrom(fig, other) {
    return Math.atan2(other.group.position.x - fig.group.position.x,
                      other.group.position.z - fig.group.position.z);
  }

  function stepFigure(fig, delta) {
    // Seated, the idle clip keeps playing so she breathes — but idle also
    // carries a standing sway (hips shifting, torso weight drifting to one
    // side), and the sit pose is applied as deltas ON TOP of the mixer, so
    // that whole dance rode through into the chair: hips wandering, torso
    // leaning off the chair's centre line (Magnus, 2026-09-11: "dampen the
    // idle hip movement", "his torso leans to the left too much"). Weight
    // below 1 blends the clip toward the rest pose, which shrinks the sway's
    // AMPLITUDE rather than just slowing it; the arms and legs are re-solved
    // by the settle every frame, so they do not drift with it. Eased so
    // sitting down and standing up shift the damping rather than snap it.
    const idleAct = fig.actions?.idle;
    if (idleAct) {
      const seated = !!(fig.seatedOn || fig.sitting);
      const k = Math.min(1, delta * 3);
      const wTarget = seated ? 0.18 : 1;
      const tTarget = seated ? 0.5 : 1;
      idleAct.setEffectiveWeight(idleAct.getEffectiveWeight() + (wTarget - idleAct.getEffectiveWeight()) * k);
      idleAct.timeScale += (tTarget - idleAct.timeScale) * k;
    }
    fig.mixer.update(delta);

    // How high the foot bone sits when the sole is on the floor. Measured once,
    // while she is standing and doing nothing else, because that is the only
    // moment the answer is true by definition: a standing body has its root at
    // zero and its soles on the ground.
    //
    // I chased this number for several rounds against a reading of 0.185 that
    // was simply WRONG — taken before released poses were restored, so her legs
    // were still bent from a previous sit. The real value is 0.111. A
    // measurement is only as good as the state it was taken in.
    if (fig.sole == null && !fig.walk && !fig.pose && !fig.sitting && fig.current) {
      const v = new THREE.Vector3();
      const ys = [];
      for (const n of ["l_foot", "r_foot"]) {
        const b = fig.group.getObjectByName(n);
        if (b) { b.getWorldPosition(v); ys.push(v.y - fig.group.position.y); }
      }
      if (ys.length) fig.sole = Math.min(...ys);
    }

    if (fig.walk) {
      const p = fig.group.position, w = fig.walk;
      const dx = w.to.x - p.x, dz = w.to.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.05 && w.queue && w.queue.length) {
        // A corner is reached, not the destination. The next waypoint becomes
        // the target and the promise stays unresolved — resolving at the first
        // corner would report her as arrived while she was still rounding the
        // table, and every step after it would play too early.
        const next = w.queue.shift();
        w.to.set(next.x, 0, next.z);
      } else if (dist < 0.05) {
        fig.walk = null;
        // Back to whatever they were doing before they were sent across the
        // room, so a walk does not silently leave them in a walk cycle on the
        // spot — the single most obvious way a rehearsal looks broken.
        const idleName = fig.clips.idle ? "idle" : null;
        if (idleName) {
          playClip(fig, idleName, { loop: true, fade: 0.4 });
          if (stillRef.current && fig.current) { fig.current.paused = true; fig.current.time = 0; }
        }
        else if (w.back) { w.back.reset().play(); fig.current?.crossFadeTo(w.back, 0.4, false); fig.current = w.back; }
        w.resolve?.();
      } else {
        const step = Math.min(dist, w.speed * delta);
        p.x += (dx / dist) * step;
        p.z += (dz / dist) * step;
        // Turning INTO the direction of travel rather than snapping to it:
        // a body that pivots instantly reads as a sprite, not a person.
        const want = Math.atan2(dx, dz);
        fig.group.rotation.y = easeAngle(fig.group.rotation.y, want, delta * 6);
      }
    }

    if (fig.turn) {
      const next = easeAngle(fig.group.rotation.y, fig.turn.want, delta * 5);
      fig.group.rotation.y = next;
      if (Math.abs(shortest(fig.turn.want - next)) < 0.02) {
        fig.group.rotation.y = fig.turn.want;
        fig.turn.resolve?.();
        fig.turn = null;
      }
    }

    // LAST, and it must stay last: these are deltas composed onto the pose the
    // mixer wrote at the top of this function. Run it before mixer.update and
    // the slap is overwritten every frame by the idle.
    applyPose(fig, delta);
    applyManual(fig);
    // AFTER the pose: the pose decides the shape, this decides how high off the
    // floor that shape has to sit.
    stepSitting(fig, delta);
    stepSettling(fig, delta);
    stepPulling(fig, delta);
    stepScooting(fig, delta);
  }

  // ── body interactions ─────────────────────────────────────────────────────
  //
  // Applied as DELTAS on top of whatever the mixer just wrote, not as a clip
  // that replaces it. That is why she keeps breathing through a slap: idle
  // still drives every bone, and the action rotates a handful of them further.
  // A clip would have to animate the whole body or freeze the rest of it.
  // Letting a pose go has to UNDO it. Clearing fig.pose only stops us writing
  // the bones — it does not restore them, and the mixer will not do it either
  // because `idle` does not animate the legs. So a released sit left her legs
  // folded forever: she stood up still bent, and the next sit measured from
  // there. Anything that drops a pose comes through here.
  const _qIdent = new THREE.Quaternion();

  // Standing up is the sit LEAVING the body, not being deleted from it.
  // releasePose() snaps every tracked bone to rest in one frame — right for
  // a reset, and exactly why he rose "faster than superman" (Magnus,
  // 2026-09-12): legs teleported straight, then the root chased them. This
  // marks the pose as RELEASING instead; applyPose fades its deltas toward
  // identity over `dur`, so the knees unfold across the rise.
  function releasePoseGently(fig, dur = 0.9) {
    fig.settling = null;
    const p = fig.pose;
    if (!p) return;
    if (!p.releasing) p.releasing = { t: 0, dur };
  }

  function releasePose(fig) {
    const p = fig.pose;
    fig.pose = null;
    // The settle writes the same bones; leaving it running would keep her
    // leaning on a chair she has stood up from.
    fig.settling = null;
    if (!p?.tracks) return;
    for (const tr of p.tracks) {
      const bone = p.bones?.get(tr.rigBone);
      if (!bone) continue;
      // Back to the frozen idle where there is one — snapping to `rest` in the
      // editor would leave the arms out at forty-five degrees, which is not
      // where she was standing before the pose.
      const back = fig.stillBase?.get(tr.rigBone) || fig.rest?.get(tr.rigBone);
      if (back) bone.quaternion.copy(back);
    }
  }

  function applyPose(fig, delta) {
    const p = fig.pose;
    if (!p) return;
    // A HELD pose does not advance and never completes: it is the same
    // evaluation the run uses, stopped at one instant. That is what a timeline
    // scrub is, and building it as a mode of the real thing rather than a
    // separate preview path means what you author is what plays.
    if (!p.held) p.t += delta;

    // Composed onto a REMEMBERED base, never onto the bone's current rotation.
    //
    // Multiplying onto the current value only works for bones the mixer
    // rewrites every frame — it resets them, so the delta applies once. The leg
    // bones are not animated by `idle`, so nothing reset them and the delta
    // compounded frame after frame: a held sit folded her into a heap on the
    // chair within a second. It was latent in every action; only a posture,
    // which never ends, made it visible.
    if (!p.base) {
      p.base = new Map();
      // WHO owns each bone decides what a delta composes onto. Bones the idle
      // clip animates are rewritten by the mixer every frame, so their honest
      // base is the mixer's live value — that is what "composed on top of the
      // idle" means, and it is why she keeps breathing through an action. But
      // the REST pose is the A-POSE: using it as the base for the arms held
      // them out at 45 degrees through every sit and stand — "he looks like a
      // bird flying" (Magnus, 2026-09-12). Rest stays the base ONLY for bones
      // idle never touches (the legs), where the mixer resets nothing and a
      // live base would compound frame over frame into a heap.
      p.mixerBones = new Set();

      // STILL MODE. The whole paragraph above turns on the mixer rewriting its
      // bones every frame. Freeze the idle and it stops doing that, so
      // `multiply` no longer applies the delta once — it applies it again on
      // every frame, and the arms rotate away and never stop. Exactly the
      // failure the leg bones already had, arriving at the arms by a different
      // road (caught live, 2026-09-13).
      //
      // With nothing moving underneath, no bone is "owned" by the mixer, so
      // every one composes onto a captured base. That base is the FROZEN IDLE
      // itself, taken once per figure and reused — not `rest`, which is the
      // A-pose and is what made her look like a bird flying.
      const still = stillRef.current;
      if (still && !fig.stillBase) fig.stillBase = new Map();
      if (!still) {
        const idleClip = fig.actions?.idle?.getClip?.();
        for (const t of idleClip?.tracks || []) {
          const dot = t.name.lastIndexOf(".");
          if (dot > 0) p.mixerBones.add(t.name.slice(0, dot));
        }
      }
      for (const tr of p.tracks) {
        const bone = p.bones.get(tr.rigBone);
        if (!bone) continue;
        if (still) {
          // Captured the first time this bone is ever posed, when it still
          // holds the clean frozen idle. Never recaptured: poseAt replaces the
          // pose object on every scrub tick, and re-reading the bone then would
          // fold the last delta into the base — the compounding again, one
          // scrub at a time.
          if (!fig.stillBase.has(tr.rigBone)) fig.stillBase.set(tr.rigBone, bone.quaternion.clone());
          p.base.set(tr.rigBone, fig.stillBase.get(tr.rigBone));
          continue;
        }
        const rest = fig.rest?.get(tr.rigBone);
        p.base.set(tr.rigBone, (rest || bone.quaternion).clone());
      }
    }
    let releaseK = 0;
    if (p.releasing) {
      p.releasing.t += delta;
      const r = Math.min(1, p.releasing.t / p.releasing.dur);
      releaseK = r * r * (3 - 2 * r);
    }
    for (const tr of p.tracks) {
      const bone = p.bones.get(tr.rigBone);
      if (!bone) continue;
      const base = p.base.get(tr.rigBone);
      if (!base) continue;
      const [rx, ry, rz] = sampleTrack(tr, p.t);
      _e.set(rx * DEG, ry * DEG, rz * DEG);
      _q.setFromEuler(_e);
      if (releaseK > 0) _q.slerp(_qIdent, releaseK);
      if (p.mixerBones?.has(bone.name)) {
        // Dampen the idle sway on ARM bones while a pose drives them
        // (Magnus 2026-09-12): the mixer keeps writing the full idle swing
        // under the pose, so held arms breathed and wandered. Blend the
        // mixer's live value 80% back toward what it was when the pose
        // began — a fifth of the sway survives, so the body still breathes,
        // but the arms hold their line. Ramps in with the pose, out with
        // the release; spine and head keep their full idle.
        if (/upperarm|forearm|hand|shldr|shoulder/.test(bone.name)) {
          if (!p.idleBase) p.idleBase = new Map();
          let ib = p.idleBase.get(bone.name);
          if (!ib) { ib = bone.quaternion.clone(); p.idleBase.set(bone.name, ib); }
          const damp = 0.8 * Math.min(1, p.t / Math.max(0.001, p.duration)) * (1 - releaseK);
          if (damp > 0) bone.quaternion.slerp(ib, damp);
        }
        bone.quaternion.multiply(_q);
      }
      else bone.quaternion.copy(base).multiply(_q);
    }
    // SKIN CLEARANCE (2026-09-12, Magnus: "we need some kind of skin
    // collision control"). The pose's arm angles are a shape; the BODY
    // decides how far forward that shape must sit. Was a one-shot measure at
    // hold-settle applied equally to both arms; now a PER-ARM controller
    // that re-measures every 120ms THROUGHOUT the motion:
    //   - torso front reach and half-width measured once per pose (shirt
    //     included — the garment is the surface you see);
    //   - a forearm vertex counts only while it is over the torso
    //     (armTorsoDeficit), so an arm hanging at the side is left alone;
    //   - residual deficit converts to EXTRA forward swing on that side's
    //     upper arm, approached exponentially, never snapped. Measuring
    //     after the wrap is applied makes the loop incremental: the target
    //     grows by what is still buried and decays only on clear surplus
    //     (3cm hysteresis), so it cannot oscillate.
    if (p.adapt === "wrapTorso") {
      if (!p.skin) p.skin = { r: 0, l: 0, tr: 0, tl: 0, nextAt: 0.2, prof: null, halfW: null };
      const sk = p.skin;
      // Clock, not pose time: p.t CLAMPS at the hold, so scheduling the
      // next measurement at p.t+0.12 stopped all measurement the moment the
      // pose settled — the last mid-fold reading (elbows legitimately close
      // to the chest = huge deficit) froze the wrap at its 42-degree cap and
      // Benny held a zombie reach forever (caught live, 2026-09-12).
      sk.clock = (sk.clock || 0) + delta;
      if (!p.releasing && sk.clock >= sk.nextAt) {
        sk.nextAt = sk.clock + 0.12;
        fig.group.updateMatrixWorld(true);
        const chest = fig.group.getObjectByName("spine3");
        if (chest) {
          const facing = fig.group.rotation.y;
          const fdir = new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing));
          const sdir = new THREE.Vector3(Math.cos(facing), 0, -Math.sin(facing));
          const cp = chest.getWorldPosition(new THREE.Vector3());
          if (!sk.prof) {
            // HEIGHT-RESOLVED torso front (2026-09-12). One global "front"
            // was Benny's belly maximum, 0.283m — arms resting properly ON
            // his chest still measured buried against the BELLY's reach, and
            // the lift pinned at its cap. The threshold must be the torso's
            // reach AT THE FOREARM'S OWN HEIGHT: 5cm bands over the torso,
            // garments included, measured once per pose.
            const region = limbRegion(fig, "spine1", ["l_upperarm", "r_upperarm", "neck1"]);
            const vv = new THREE.Vector3();
            let yMin = Infinity, yMax = -Infinity, hw = 0;
            const pts = [];
            fig.model.traverse((mesh) => {
              if (!mesh.isSkinnedMesh || typeof mesh.applyBoneTransform !== "function") return;
              const ids = limbVertexIds(fig, mesh, region);
              if (!ids) return;
              const pos = mesh.geometry.attributes.position;
              for (const i of ids) {
                vv.fromBufferAttribute(pos, i);
                mesh.applyBoneTransform(i, vv);
                vv.applyMatrix4(mesh.matrixWorld);
                const fwd = (vv.x - cp.x) * fdir.x + (vv.z - cp.z) * fdir.z;
                const lat = (vv.x - cp.x) * sdir.x + (vv.z - cp.z) * sdir.z;
                if (Math.abs(lat) > hw) hw = Math.abs(lat);
                if (vv.y < yMin) yMin = vv.y;
                if (vv.y > yMax) yMax = vv.y;
                pts.push(vv.y, lat, fwd);
              }
            });
            // 2D: height bands ALONE still pinned the lift at its cap —
            // the band front is the torso's reach at its CENTRE, while a
            // crossed forearm's elbow end wraps the torso's SIDE, where the
            // skin is far less forward. Those wrapped vertices read "buried
            // 20cm" forever. The threshold is the local skin surface at the
            // vertex's own (height, lateral) cell.
            const bandH = 0.05, nB = Math.max(1, Math.ceil((yMax - yMin) / bandH));
            const latB = 0.05, nL = Math.max(1, Math.ceil((2 * hw) / latB));
            const grid = new Array(nB * nL).fill(-Infinity);
            for (let k = 0; k < pts.length; k += 3) {
              const bi = Math.min(nB - 1, Math.floor((pts[k] - yMin) / bandH));
              const li = Math.min(nL - 1, Math.max(0, Math.floor((pts[k + 1] + hw) / latB)));
              const gi = bi * nL + li;
              if (pts[k + 2] > grid[gi]) grid[gi] = pts[k + 2];
            }
            sk.prof = { yMin, bandH, nB, latB, nL, halfW: hw, grid };
            sk.halfW = hw;
          }
          for (const sd of ["r", "l"]) {
            const d = armTorsoDeficit(fig, sd, fdir, sdir, cp, sk.prof, 0.01, sk.halfW);
            const tKey = "t" + sd;
            // Rate-limited: at most 8 degrees per measurement in either
            // direction. A transient mid-fold deficit nudges, it does not
            // slam the cap; equilibrium is reached over a few ticks.
            // Deadband [-0.02, 0.02]: a forearm RESTING ON the skin reads
            // a deficit of about the margin — that is the goal state, not a
            // reason to keep climbing.
            // STALL DETECTION: on a deep torso a tucked hand nests BESIDE
            // the pec bulge and always reads "behind" its cell's maximum —
            // a phantom deficit no amount of lifting clears (Benny pinned
            // the cap at deficit 0.13 with the arms at his chin). Lift only
            // while lifting BUYS clearance; when an increment returns less
            // than 5mm, hold there. The stall is sticky until the deficit
            // resolves or jumps (pose moved on).
            sk.prevD = sk.prevD || {}; sk.grew = sk.grew || {}; sk.stall = sk.stall || {};
            let step = 0;
            if (d == null) { step = -4; sk.stall[sd] = false; }
            else if (d > 0.02) {
              const prev = sk.prevD[sd];
              if (sk.grew[sd] && prev != null && prev - d < 0.005) sk.stall[sd] = true;
              if (prev != null && d - prev > 0.05) sk.stall[sd] = false;
              if (!sk.stall[sd]) step = Math.min(8, Math.asin(Math.min(0.95, d / 0.45)) / DEG);
            } else {
              sk.stall[sd] = false;
              if (d < -0.02) step = -Math.min(8, Math.asin(Math.min(0.95, (-d - 0.02) / 0.45)) / DEG);
            }
            sk.grew[sd] = step > 0;
            sk.prevD[sd] = d;
            sk[tKey] = Math.max(0, Math.min(30, sk[tKey] + step));
            sk.lastD = sk.lastD || {};
            sk.lastD[sd] = d == null ? null : +d.toFixed(3);
          }
        }
      }
      const ka = 1 - Math.exp(-8 * delta);
      sk.r += (sk.tr - sk.r) * ka;
      sk.l += (sk.tl - sk.l) * ka;
      // Actuate on RAISE (local Z), never on X (Magnus, 2026-09-12: "you can
      // only move the arms up and down, NOT X"). This delta multiplies in
      // AFTER the pose's twist is already on the bone, and Euler axes
      // composed after a twist do not mean what their names say — the X
      // "forward swing" swept the forearms INTO the midline on Benny. Raising
      // instead slides the crossed forearms up the torso until they sit
      // above the bulge, which is what a big-bellied cross really does.
      for (const sd of ["r", "l"]) {
        const w = (sd === "r" ? sk.r : sk.l) * (1 - releaseK);
        if (w <= 0.01) continue;
        const b = fig.group.getObjectByName(sd + "_upperarm");
        if (!b) continue;
        _e.set(0, 0, (sd === "r" ? -w : w) * DEG);
        _q.setFromEuler(_e);
        b.quaternion.multiply(_q);
      }
    }

    if (p.releasing && releaseK >= 1) {
      // Fully faded. Rest-restore only the bones the mixer will NOT rewrite
      // next frame — snapping a mixer-driven arm to the A-pose rest, even for
      // one frame, is a wing-flap.
      for (const tr of p.tracks) {
        if (p.mixerBones?.has(tr.rigBone)) continue;
        const bone = p.bones.get(tr.rigBone);
        const rest = fig.rest?.get(tr.rigBone);
        if (bone && rest) bone.quaternion.copy(rest);
      }
      fig.pose = null;
      p.resolve?.();
      return;
    }

    // Contact is an authored instant, not a collision: see bodyActions.js for
    // why. The rig only announces it; what it MEANS belongs to the host.
    // Aim ramps in around the contact instant and back out, so the windup and
    // the recovery stay exactly as authored and only the strike is corrected.
    // A constant-weight aim would drag the whole arm toward the face for the
    // entire action and flatten the throw into a reach.
    if (p.aim && p.otherFig && p.contactAt != null) {
      const w = 1 - Math.min(1, Math.abs(p.t - p.contactAt) / (p.aim.window || 0.18));
      if (w > 0) solveArm(fig, aimPoint(p.otherFig, p.aim.at), w * (p.aim.weight ?? 1));
    }

    if (!p.fired && p.contactAt != null && p.t >= p.contactAt) {
      p.fired = true;
      try { p.onContact?.(); } catch {}
    }
    if (!p.held && p.t >= p.duration) {
      if (p.hold) {
        // A POSTURE stays. It stops advancing at its last frame and keeps
        // being applied every frame until something else moves her.
        p.t = p.duration;
        if (!p.settled) { p.settled = true; p.resolve?.(); }
      } else {
        fig.pose = null;
        p.resolve?.();
      }
    }
  }

  // The editor's primitive: one bone, held at one rotation, composed on top of
  // everything else. Authoring an action is repeatedly doing this and then
  // saying "capture that at 0.28s", so it is the same evaluation path the
  // finished action uses rather than a preview that can disagree with it.
  function applyManual(fig) {
    const m = fig.manual;
    if (!m || !m.size) return;
    for (const [name, rot] of m) {
      const bone = fig.bonesCache?.get(name) || fig.group.getObjectByName(name);
      if (!bone) continue;
      if (!fig.bonesCache) fig.bonesCache = new Map();
      fig.bonesCache.set(name, bone);
      _e.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG);
      _q.setFromEuler(_e);
      bone.quaternion.multiply(_q);
    }
  }

  function bonesOf(fig, tracks) {
    const m = new Map();
    for (const t of tracks) {
      const b = fig.group.getObjectByName(t.rigBone);
      if (b) m.set(t.rigBone, b);
    }
    return m;
  }

  // Play one authored motion on one body. Both `interaction` and `reaction`
  // come through here — a reaction is not a lesser thing bolted onto an action,
  // it is a motion performed by the person it happens to, and the rig has no
  // reason to treat them differently.
  //
  // What it does NOT do any more: touch the other body. An interaction used to
  // drive the target's flinch from inside the actor's step, which is why a slap
  // could never play in an encounter — the target there is a living player.
  function playMotion(fig, slug, { onContact, otherFig } = {}) {
    const def = getAction(slug);
    if (!def) return Promise.reject(new Error(`no body motion “${slug}”`));
    const tracks = resolveTracks(def);
    return new Promise((resolve) => {
      fig.pose = {
        tracks, bones: bonesOf(fig, tracks),
        t: 0, duration: def.duration || 1,
        contactAt: def.contactAt ?? null, fired: def.contactAt == null,
        // A pose holds unless it says otherwise; anything ELSE holds only if
        // it asks to. Crossed arms is a reaction (one body, no partner) that
        // is also a STANCE — with hold gated on kind alone it played its 0.7s
        // and quietly let the arms back down.
        hold: def.kind === "pose" ? def.hold !== false : def.hold === true,
        aim: def.aim || null, otherFig: otherFig || null,
        adapt: def.adapt || null,
        resolve,
        onContact: () => { try { onContact?.(); } catch {} },
      };
    });
  }

  // ── proxemics ─────────────────────────────────────────────────────────────
  //
  // Two rules, and they are different in kind. The first is COLLISION: bodies
  // do not occupy the same place, ever, whatever anybody authored. The second
  // is PERSONAL SPACE: how close this person lets the other come before giving
  // ground — a property of the person and the relationship, defaulting to zero
  // so that adding this feature changes no existing script.
  //
  // Only the one whose space is invaded retreats, and only while they are not
  // themselves walking. Both retreating would drift them apart across the room;
  // retreating mid-walk would mean a scripted walk quietly failing to arrive.
  // id, then slot, then type — one resolution order, used by walking to a
  // prop, sitting on one, and the timeline's estimate of both. Three different
  // answers to "which chair" would be three different scenes.
  function findProp(list, ref) {
    const key = String(ref || "").toLowerCase();
    if (!key) return null;
    const all = list || [];
    return all.find(o => String(o.id).toLowerCase() === key)
        || all.find(o => String(o.slot || "").toLowerCase() === key)
        || all.find(o => String(o.type || "").toLowerCase() === key)
        || null;
  }

  // Every pair, not THE pair. This was O(1) maths on figures.a and figures.b,
  // so a third body walked through everyone. n is a handful, so n squared is
  // free and the ordering does not matter — each pair is resolved once.
  function keepApart(a, delta) {
    const ids = Object.keys(a.figures || {});
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        keepPairApart(a, delta, ids[i], ids[j]);
  }

  function keepPairApart(a, delta, idA, idB) {
    const fa = a.figures?.[idA], fb = a.figures?.[idB];
    if (!fa || !fb) return;
    const pa = fa.group.position, pb = fb.group.position;
    let dx = pb.x - pa.x, dz = pb.z - pa.z;
    let d = Math.hypot(dx, dz);
    if (d < 1e-4) { dx = 1; dz = 0; d = 1e-4; }
    const ux = dx / d, uz = dz / d;

    // Collision: split the overlap between them. Instant, because two bodies
    // inside each other is not a state to ease out of.
    if (d < TOUCH_DISTANCE) {
      const push = (TOUCH_DISTANCE - d) / 2;
      pa.x -= ux * push; pa.z -= uz * push;
      pb.x += ux * push; pb.z += uz * push;
      d = TOUCH_DISTANCE;
    }

    const limit = ROOM.size / 2 - 0.35;
    const clamp = (p) => {
      p.x = Math.max(-limit, Math.min(limit, p.x));
      p.z = Math.max(-limit, Math.min(limit, p.z));
    };

    const space = a.space || {};
    const give = (fig, sign) => {
      if (fig.walk) return;            // a scripted walk is not interrupted
      const step = RETREAT_SPEED * delta;
      fig.group.position.x += ux * sign * step;
      fig.group.position.z += uz * sign * step;
      clamp(fig.group.position);
    };
    if ((space[idA] || 0) > d) give(fa, -1);
    if ((space[idB] || 0) > d) give(fb, 1);
  }

  // ── landing the blow ──────────────────────────────────────────────────────
  //
  // An authored action is rotations only, which is what makes it portable
  // between bodies — and also what stops it from ever LANDING: a slap posed at
  // 0.4m swings through empty air at 0.6m, and on a taller body it passes under
  // the jaw. The authored motion supplies the STYLE; this supplies the AIM.
  //
  // Solved by CCD — iterative, not analytic — on purpose. Analytic two-bone IK
  // needs to know which way each joint bends, and mis-assumed axis conventions
  // are precisely what made the elbow appear frozen for an entire session. CCD
  // asks the bones where they currently point and rotates them toward the
  // target, so it cannot be wrong about a convention it never consults.
  //
  // It starts from the authored pose and nudges, rather than solving from
  // scratch: a few iterations from a plausible slap stay a plausible slap,
  // where a cold solve would happily find an elbow through the ribs.
  // Aim ANY two-bone chain at a point. Written for the slap's hand-to-chin and
  // now used for legs and arms alike: "the foot reaches the floor" and "the hand
  // finds the seat" are the same problem as "the hand finds the jaw", and
  // solving them the same way means one set of conventions to be wrong about.
  function solveChain(fig, boneNames, endName, target, weight, iterations = 5) {
    if (!(weight > 0.001) || !target) return;
    const chain = boneNames.map(n => fig.group.getObjectByName(n));
    const end = fig.group.getObjectByName(endName);
    if (!end || chain.some(b => !b)) return;
    solveCCD(fig, chain, end, target, weight, iterations);
  }

  function solveArm(fig, target, weight) {
    if (!(weight > 0.001) || !target) return;
    const chain = ["r_upperarm", "r_forearm"].map(n => fig.group.getObjectByName(n));
    const hand = fig.group.getObjectByName("r_hand");
    if (!hand || chain.some(b => !b)) return;
    solveCCD(fig, chain, hand, target, weight, 5);
  }

  // Point the FINGERS somewhere. CCD places the wrist and leaves the hand in
  // whatever rotation the pose last gave it — standing, that is fingers
  // hanging straight down, and a wrist held at lap height then drives them
  // through the thigh (Magnus, 2026-09-11: "hands digged into his laps").
  // The minimal rotation that takes the current finger direction to the
  // desired one keeps the palm roughly as the solve left it while the
  // fingers come up to lie along the surface.
  // A hand's orientation is TWO directions, not one. Aligning only the
  // fingers leaves the wrist's twist wherever the pose left it — fingers lay
  // along the thigh while the palm still faced sideways (Magnus: "can't you
  // twist the arm so the palms point on his laps?"). So build the full
  // basis: fingers along `dirWorld`, and the index-to-pinky line horizontal
  // the way a palm-down hand carries it — for the right hand that line runs
  // fingers-cross-down, for the left, down-cross-fingers. The rotation that
  // takes the measured current basis to that one is applied to the wrist,
  // blended by settle weight.
  function orientHand(fig, side, dirWorld, weight) {
    if (!(weight > 0.001) || !dirWorld) return;
    const hand = fig.group.getObjectByName(side + "_hand");
    if (!hand) return;
    let idx = null, pky = null, mid = null;
    hand.traverse((o) => {
      if (!o.isBone) return;
      const n = o.name;
      if (!idx && /index/i.test(n)) idx = o;
      if (!pky && /pinky/i.test(n)) pky = o;
      if (!mid && /mid/i.test(n)) mid = o;
    });
    const tip = mid || hand.children.find((c) => c.isBone && !/thumb/i.test(c.name)) || hand.children[0];
    if (!tip) return;
    hand.updateMatrixWorld(true);
    const hp = hand.getWorldPosition(new THREE.Vector3());
    const fCur = tip.getWorldPosition(new THREE.Vector3()).sub(hp);
    if (fCur.lengthSq() < 1e-8) return;
    fCur.normalize();

    const basis = (f, a) => {
      const e1 = f.clone().normalize();
      const e2 = a.clone().addScaledVector(e1, -a.dot(e1)).normalize();
      const e3 = e1.clone().cross(e2);
      const m = new THREE.Matrix4().makeBasis(e1, e2, e3);
      return new THREE.Quaternion().setFromRotationMatrix(m);
    };

    const down = new THREE.Vector3(0, -1, 0);
    const fDes = dirWorld.clone().normalize();
    // The convention was derived on paper and the body disagreed: built as
    // r=f×down / l=down×f, both palms landed facing the CEILING. On this rig
    // the index→pinky line runs the other way, so the handedness is the
    // mirror of the anatomical guess. Trust the measured outcome over the
    // derivation.
    const aDes = side === "r" ? down.clone().cross(fDes) : fDes.clone().cross(down);
    if (aDes.lengthSq() < 1e-6) return;

    let dq;
    if (idx && pky) {
      const aCur = pky.getWorldPosition(new THREE.Vector3()).sub(idx.getWorldPosition(new THREE.Vector3()));
      if (aCur.lengthSq() < 1e-8) return;
      dq = basis(fDes, aDes).multiply(basis(fCur, aCur).invert());
    } else {
      // No finger bones to read the twist from: fall back to fingers-only.
      dq = new THREE.Quaternion().setFromUnitVectors(fCur, fDes);
    }
    const wq = hand.getWorldQuaternion(new THREE.Quaternion());
    const pq = hand.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    const targetLocal = pq.multiply(dq).multiply(wq);
    hand.quaternion.slerp(targetLocal, Math.min(1, weight));
    hand.updateMatrixWorld(true);
  }

  // WHERE THE ELBOW POINTS. A two-bone CCD plants the wrist and is
  // indifferent to the elbow, which therefore stays wherever the hanging
  // pose left it — glued to the ribs (Magnus, twice: "arms pressed into his
  // ribs"). But the elbow is free to ORBIT the shoulder-to-wrist axis
  // without moving the hand a millimetre: the wrist lies ON that axis, and
  // the forearm and hand are children of the upper arm, so one rotation of
  // the upper arm about it swings the whole rigid arm. Swing the elbow
  // toward outboard-and-slightly-back — where a resting arm carries it.
  function swingElbowOut(fig, side, facing, weight) {
    if (!(weight > 0.001) || facing == null) return;
    const S = fig.group.getObjectByName(side + "_upperarm");
    const E = fig.group.getObjectByName(side + "_forearm");
    const H = fig.group.getObjectByName(side + "_hand");
    if (!S || !E || !H) return;
    S.updateMatrixWorld(true);
    const sp = S.getWorldPosition(new THREE.Vector3());
    const ep = E.getWorldPosition(new THREE.Vector3());
    const hp = H.getWorldPosition(new THREE.Vector3());
    const axis = hp.clone().sub(sp);
    if (axis.lengthSq() < 1e-6) return;
    axis.normalize();
    // Radial part of the elbow's offset — where it points now.
    const r = ep.clone().sub(sp);
    r.addScaledVector(axis, -r.dot(axis));
    if (r.lengthSq() < 1e-6) return;
    r.normalize();
    // Where it should point: outboard, with a touch of backward.
    const across = facing + Math.PI / 2;
    const sign = side === "l" ? 1 : -1;
    const d = new THREE.Vector3(
      Math.sin(across) * sign - Math.sin(facing) * 0.35, 0,
      Math.cos(across) * sign - Math.cos(facing) * 0.35);
    d.addScaledVector(axis, -d.dot(axis));
    if (d.lengthSq() < 1e-6) return;
    d.normalize();
    const cos = Math.max(-1, Math.min(1, r.dot(d)));
    const sin = new THREE.Vector3().crossVectors(r, d).dot(axis);
    const angle = Math.atan2(sin, cos);
    // Most of the way, never a violent snap.
    const dq = new THREE.Quaternion().setFromAxisAngle(axis, angle * 0.8 * Math.min(1, weight));
    const wq = S.getWorldQuaternion(new THREE.Quaternion());
    const pq = S.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    S.quaternion.copy(pq.multiply(dq).multiply(wq));
    S.updateMatrixWorld(true);
  }

  // The thumb is the one digit orientHand cannot reach: the hand basis lays
  // the PALM and FINGERS along the surface, but the thumb keeps whatever
  // curl the standing pose gave it — which, palm-down on a thigh, points it
  // straight into the flesh (Magnus, 2026-09-12: "palms on flesh YES but
  // thumbs buried"). Aim it where a resting thumb lies: splayed inboard off
  // the finger line, following the thigh's slope along the surface rather
  // than diving through it.
  function orientThumb(fig, side, fingerDir, facing, weight) {
    if (!(weight > 0.001) || !fingerDir || facing == null) return;
    const hand = fig.group.getObjectByName(side + "_hand");
    if (!hand) return;
    let t1 = null;
    hand.traverse((o) => { if (!t1 && o.isBone && /thumb/i.test(o.name)) t1 = o; });
    const tip = t1?.children.find((c) => c.isBone);
    if (!t1 || !tip) return;
    t1.updateMatrixWorld(true);
    const a = t1.getWorldPosition(new THREE.Vector3());
    const b = tip.getWorldPosition(new THREE.Vector3());
    const cur = b.sub(a);
    if (cur.lengthSq() < 1e-8) return;
    cur.normalize();
    const across = facing + Math.PI / 2;
    const sign = side === "l" ? 1 : -1;
    const inboard = new THREE.Vector3(-Math.sin(across) * sign, 0, -Math.cos(across) * sign);
    const des = fingerDir.clone().multiplyScalar(0.55).addScaledVector(inboard, 0.7);
    // The FULL palm-plane slope, not half. At half the thumb pointed below
    // the palm plane, reached the thigh first, and PROPPED the whole hand
    // like a kickstand — the per-vertex clearance honestly read "contact"
    // while the palm floated 3cm in the air on it. Level with the palm, the
    // thumb lies along the surface and the palm takes the contact.
    des.y = fingerDir.y;
    if (des.lengthSq() < 1e-6) return;
    des.normalize();
    const dq = new THREE.Quaternion().setFromUnitVectors(cur, des);
    const wq = t1.getWorldQuaternion(new THREE.Quaternion());
    const pq = t1.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    t1.quaternion.slerp(pq.multiply(dq).multiply(wq), Math.min(1, weight));
    t1.updateMatrixWorld(true);
  }

  // TRUE clearance between a hand and the thigh it rests on: every vertex
  // of the hand — thumb and fingers included — against the thigh's top
  // surface AT THAT VERTEX'S OWN STATION along the leg. Five rounds of
  // comparing one point of the hand against one sample of the surface each
  // failed a different way (fingertip vs crown, thumb as kickstand, palm
  // heel floating while knuckles "touched"): a hand is an extended object
  // on a curved surface, and only a per-vertex comparison says whether it
  // is actually resting.
  function lapHandClearance(fig, side) {
    const hipB = fig.group.getObjectByName(side + "_thigh");
    const kneeB = fig.group.getObjectByName(side + "_shin");
    if (!hipB || !kneeB) return null;
    const a = hipB.getWorldPosition(new THREE.Vector3());
    const b = kneeB.getWorldPosition(new THREE.Vector3());
    const axis = b.clone().sub(a);
    const len = axis.length();
    if (len < 0.05) return null;
    axis.divideScalar(len);
    const reg = limbRegion(fig, side + "_thigh", [side + "_shin"]);
    const bands = [[0.42, 0.55], [0.55, 0.7], [0.7, 0.85]];
    const sts = [], tops = [];
    for (const [t0, t1] of bands) {
      const sp = limbSurface(fig, reg, { boneFrom: side + "_thigh", boneTo: side + "_shin", tMin: t0, tMax: t1 });
      if (!sp) return null;
      sts.push((t0 + t1) / 2); tops.push(sp.maxY);
    }
    const topAt = (t) => {
      if (t <= sts[0]) return tops[0];
      if (t >= sts[2]) return tops[2];
      if (t <= sts[1]) return tops[0] + (tops[1] - tops[0]) * (t - sts[0]) / (sts[1] - sts[0]);
      return tops[1] + (tops[2] - tops[1]) * (t - sts[1]) / (sts[2] - sts[1]);
    };
    // The thumb is left OUT of the clearance. It points inboard, over the
    // thigh's falling inner slope, but topAt() only knows the crown height
    // at each station — so the thumb read "contact" while hovering over the
    // fall and kept the palm propped in the air. A resting thumb drapes the
    // inner slope carrying nothing; the palm and fingers are the contact.
    const handB2 = fig.group.getObjectByName(side + "_hand");
    let thumbB2 = null;
    handB2?.traverse((o) => { if (!thumbB2 && o.isBone && /thumb/i.test(o.name)) thumbB2 = o; });
    const handReg = limbRegion(fig, side + "_hand", thumbB2 ? [thumbB2.name] : []);
    const v = new THREE.Vector3();
    let minC = Infinity, n = 0;
    fig.model.traverse((mesh) => {
      if (!mesh.isSkinnedMesh || typeof mesh.applyBoneTransform !== "function") return;
      const ids = limbVertexIds(fig, mesh, handReg);
      if (!ids) return;
      const pos = mesh.geometry.attributes.position;
      for (const i of ids) {
        v.fromBufferAttribute(pos, i);
        mesh.applyBoneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        const t = ((v.x - a.x) * axis.x + (v.y - a.y) * axis.y + (v.z - a.z) * axis.z) / len;
        if (t < 0.4 || t > 0.9) continue;   // only the part of the hand over the thigh
        const c = v.y - topAt(t);
        if (c < minC) minC = c;
        n++;
      }
    });
    return n ? minC : null;
  }

  function solveCCD(fig, chain, hand, target, weight, iterations) {

    // Remember the authored pose so the correction can be BLENDED in rather
    // than replacing it — off the contact frame the authored motion is what
    // you see, and at contact the aim wins.
    const before = chain.map(b => b.quaternion.clone());

    for (let iter = 0; iter < iterations; iter++) {
      for (const bone of chain) {
        bone.updateMatrixWorld(true);
        hand.updateMatrixWorld(true);
        const P = bone.getWorldPosition(_vA);
        const H = hand.getWorldPosition(_vB);
        const toHand = _vC.copy(H).sub(P);
        if (toHand.lengthSq() < 1e-8) continue;
        const toTarget = new THREE.Vector3().copy(target).sub(P);
        if (toTarget.lengthSq() < 1e-8) continue;
        _qA.setFromUnitVectors(toHand.normalize(), toTarget.normalize());
        const wq = bone.getWorldQuaternion(_qB).clone();
        const pq = bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
        bone.quaternion.copy(pq.invert().multiply(_qA).multiply(wq));
        bone.updateMatrixWorld(true);
      }
    }

    for (let i = 0; i < chain.length; i++) {
      // The solved rotation is copied out BEFORE blending. slerpQuaternions(a,b,t)
      // is this.copy(a).slerp(b,t) — so passing the bone's own quaternion as `b`
      // overwrites it with `a` before the slerp reads it, and the result is
      // always exactly `a`. The solver ran correctly for hours and every frame
      // of its work was discarded by that aliasing.
      const solved = chain[i].quaternion.clone();
      chain[i].quaternion.copy(before[i]).slerp(solved, Math.min(1, weight));
      chain[i].updateMatrixWorld(true);
    }
  }

  // Where an action says to aim. A bone name on the OTHER body, resolved at the
  // moment of contact rather than baked into the action — which is the whole
  // point: the same slap finds the chin of whoever is standing there.
  function aimPoint(otherFig, boneName) {
    if (!otherFig) return null;
    const b = otherFig.group.getObjectByName(boneName || "chin");
    if (!b) return null;
    return b.getWorldPosition(new THREE.Vector3());
  }

  // ── lowering onto a seat ──────────────────────────────────────────────────
  //
  // Sitting is not a teleport with a pose on top. It is: keep your feet where
  // they are, bend, and let your hips travel back and down until they meet the
  // seat. The previous version bent the legs while the root stayed at floor
  // height — and the root IS the feet, so bending LIFTED them — then dropped
  // the root at the end. She jumped onto the chair.
  //
  // The feet are therefore a CONSTRAINT, not an output: every frame, whatever
  // the pose did to the legs, the root descends by however far the feet have
  // left the floor. Her hips end up wherever the leg angles put them, which is
  // what happens to a real body lowering onto a chair.
  // ── settling into a chair ─────────────────────────────────────────────────
  //
  // What a body does once it has landed: the weight goes back against the
  // backrest, and the hands come down until they find something. Both are
  // CONTACT, so both are solved against the furniture rather than posed to a
  // number — the chair decides how far back she can lean and where her hands
  // stop, which is the whole reason this reads differently on a stool.
  // The most she can lean before the back of her garment meets the backrest.
  //
  // Geometry, not a constant: how far her back surface currently sits in front
  // of the rest, over how tall her torso is, is the sine of the angle that
  // closes the gap. Anything more is fabric through wood.
  function leanLimit(fig, prop, t, facing) {
    const chest = fig.group.getObjectByName("spine3");
    const hipBone = fig.group.getObjectByName("hip");
    if (!chest || !hipBone) return 8;

    const c = new THREE.Vector3(), h = new THREE.Vector3();
    chest.getWorldPosition(c);
    hipBone.getWorldPosition(h);

    const yaw = prop.yaw ?? ((prop.rot || 0) * Math.PI) / 2;
    // The backrest plane: a point on it, and the direction she faces.
    const bx = prop.x - Math.sin(facing) * (t.hd * 0.82);
    const bz = prop.z - Math.cos(facing) * (t.hd * 0.82);
    const fx = Math.sin(facing), fz = Math.cos(facing);

    // How far the chest is IN FRONT of the backrest, less the thickness of what
    // she is wearing.
    const ahead = (c.x - bx) * fx + (c.z - bz) * fz;
    const gap = ahead - backSurfaceDepth(fig, facing);
    const torso = Math.max(0.15, c.y - h.y);

    const deg = Math.asin(Math.max(0, Math.min(1, gap / torso))) * 180 / Math.PI;
    // Capped: past about 22 degrees it stops reading as sitting back and starts
    // reading as lounging, whatever the geometry allows.
    return Math.max(0, Math.min(22, deg));
  }

  function stepSettling(fig, delta) {
    const st = fig.settling;
    if (!st) return;
    st.t = Math.min(st.dur, st.t + delta);
    const u = st.dur > 0 ? st.t / st.dur : 1;
    const w = u * u * (3 - 2 * u);

    // Legs first: they decide where the body meets the floor, and the torso
    // rotates about hips that the legs do not move.
    if (st.legs) {
      const hipBone = fig.group.getObjectByName("hip");
      if (hipBone) {
        const h = new THREE.Vector3();
        hipBone.getWorldPosition(h);
        const fx = Math.sin(st.facing), fz = Math.cos(st.facing);
        const ax = Math.sin(st.facing + Math.PI / 2), az = Math.cos(st.facing + Math.PI / 2);
        for (const sd of ["l", "r"]) {
          const lat = sd === "l" ? 0.09 : -0.09;
          const target = new THREE.Vector3(
            h.x + fx * 0.42 + ax * lat,
            st.floorAnkle,
            h.z + fz * 0.42 + az * lat,
          );
          solveChain(fig, [sd + "_thigh", sd + "_shin"], sd + "_foot", target, w, 6);
        }
      }
    }

    // Lean. Only where there is something to lean ON: on a stool this stays
    // upright, which is what sitting on a stool looks like.
    if (st.back) {
      const spine = fig.group.getObjectByName("spine1");
      const chest = fig.group.getObjectByName("spine3");
      for (const [bone, deg] of [[spine, st.lean * 0.6], [chest, st.lean * 0.4]]) {
        if (!bone) continue;
        const base = st.base.get(bone.name) || bone.quaternion.clone();
        if (!st.base.has(bone.name)) st.base.set(bone.name, base.clone());
        _e.set(deg * w * DEG, 0, 0);
        _q.setFromEuler(_e);
        bone.quaternion.copy(base).multiply(_q);
      }
    }

    // Hands down until they meet the seat. Solved, not posed: the target is a
    // point on the seat surface beside each hip, so a wider chair puts her
    // hands wider without anybody editing an angle.
    if (st.hands) {
      // Same correction as the thigh, for the same reason: the target is where
      // the WRIST BONE goes, and +3cm was a guess at how far the palm hangs
      // below it. Guessed low, the hand melts into the seat. Measured halfway
      // through the settle, when the hand is already near the surface and the
      // fingers are in their final shape.
      // Lower the hands until they COLLIDE with the lap (Magnus) — not the
      // wrist to an offset, the hand's own lowest vertex (fingers included;
      // they ARE the contact) down to the measured thigh top. Iterative,
      // one nudge per frame for a few frames: moving the wrist re-solves the
      // arm and re-poses the hand, so each pass measures the RESULT of the
      // previous one rather than a prediction.
      for (const side of ["l", "r"]) {
        const t = st.hands[side];
        if (!t) continue;
        solveChain(fig, [side + "_upperarm", side + "_forearm"], side + "_hand", t, w, 8);
        // Swivel first — it rolls the hand along with the arm — then set the
        // palm, so the wrist ends palm-down on top of whatever the swivel did.
        swingElbowOut(fig, side, st.facing, w);
        orientHand(fig, side, st.fingerDir?.[side], w);
        orientThumb(fig, side, st.fingerDir?.[side], st.facing, w);
      }

      // Contact check — AFTER the solve, adjusting the target for the NEXT
      // frame. It sat before the solve for three broken iterations, and in
      // that position it can only ever measure the RAW POSE: the held sit
      // pose rewrites the arm bones every frame before the settle runs, so a
      // pre-solve measurement sees hands hanging at the sides — ten
      // centimetres "sunk" — no matter where the solved hands actually are.
      // It read that on every body, and dutifully raised the targets into
      // the air. Only a post-solve skeleton knows where the hands ARE.
      if (w >= 0.9 && (st.palmPass || 0) < 8) {
        st.palmPass = (st.palmPass || 0) + 1;
        for (const side of ["l", "r"]) {
          const t = st.hands[side];
          const base = st.handSurface?.[side];
          if (!t || base == null) continue;
          let gap;
          if (st.restingOn === "lap") {
            const c = lapHandClearance(fig, side);
            if (c == null) continue;
            gap = c - 0.004;   // rest 4mm proud of the skin
          } else {
            // On the flat SEAT one sample of the surface is the surface, so
            // the simple palm-half reading is still right there.
            const handB = fig.group.getObjectByName(side + "_hand");
            let midB = null, thumbB = null;
            handB?.traverse((o) => {
              if (!o.isBone) return;
              if (!midB && /mid/i.test(o.name)) midB = o;
              if (!thumbB && /thumb/i.test(o.name)) thumbB = o;
            });
            if (!handB || !midB) continue;
            const span = limbSurface(fig, limbRegion(fig, side + "_hand", thumbB ? [thumbB.name] : []),
              { boneFrom: side + "_hand", boneTo: midB.name, tMin: 0, tMax: 0.5 });
            if (!span) continue;
            gap = span.minY - (base + 0.004);
          }
          if (gap > 0.003) t.y -= Math.min(gap, 0.02);
          else if (gap < -0.006) t.y += Math.min(-gap, 0.015);
        }
      }
    }

    // It does NOT end. The held sit pose rewrites these same bones every frame,
    // so a settle that finished and cleared itself was overwritten within one
    // frame of completing — she leaned back and snapped upright again, too fast
    // to see. Being settled is a STATE, like being seated: it keeps applying
    // until the pose is released.
    if (st.t >= st.dur && !st.finished) {
      st.finished = true;
      st.done?.();
    }
  }

  // The lowest surface of the BODY at a given world XZ. backSurfaceDepth
  // turned ninety degrees: fire UP from well below, so the first thing hit is
  // the underside — of the thigh, of the palm, of whatever hangs lowest there
  // — rather than a backface from inside the mesh.
  //
  // This is what a body actually rests ON. Everything above it is skeleton.
  function underSurfaceY(fig, at, maxDrop = 0.7) {
    if (!fig?.model) return null;
    const start = new THREE.Vector3(at.x, at.y - maxDrop, at.z);
    const rc = new THREE.Raycaster(start, new THREE.Vector3(0, 1, 0), 0, maxDrop);
    const hits = rc.intersectObject(fig.model, true).filter(h => h.object.isSkinnedMesh || h.object.isMesh);
    return hits.length ? hits[0].point.y : null;
  }

  // How far the underside of the thigh hangs below the thigh BONE, measured on
  // this body in this pose — mid-thigh, halfway between hip and knee, which is
  // the part spanning the seat.
  // The WORLD height of the underside of the thigh, mid-way between hip and
  // knee — the part that spans the seat.
  //
  // Returned as an absolute height, not as an offset from the hip bone. The
  // first version returned the offset and it was wrong for a reason worth
  // keeping: a seated thigh is not horizontal. Measured on Magnus, the knee
  // sat 22cm BELOW the hip, so "hip bone minus surface at mid-thigh" measured
  // the SLOPE of the leg and called it thickness — 0.19m — and lifted him that
  // far off the chair. An absolute height has no such confusion in it.
  function thighUnderY(fig) {
    const hip = fig.group.getObjectByName("l_thigh");
    const knee = fig.group.getObjectByName("l_shin");
    if (!hip || !knee) return null;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    hip.getWorldPosition(a); knee.getWorldPosition(b);
    const mid = a.clone().lerp(b, 0.5);
    // Short ray. Fired from far below, the first thing hit at this XZ can be a
    // foot rather than a thigh; 25cm cannot reach the floor from a thigh but
    // comfortably clears any leg.
    const span = limbSurface(fig, limbRegion(fig, "l_thigh", ["l_shin"]), { boneFrom: "l_thigh", boneTo: "l_shin", tMin: 0.3, tMax: 0.75, skipGarments: true });
    const under = span ? span.yAt(0.15) : null;
    if (under == null) return null;
    const thickness = mid.y - under;
    return thickness > 0.02 && thickness < 0.18 ? under : null;
  }

  // How far behind the chest the BACK OF HER actually is — found by firing a
  // ray backwards through her own mesh and seeing what it hits last.
  //
  // This is the garment, not the skeleton. A blouse stands several centimetres
  // clear of the spine, and leaning until the SPINE met the backrest drove the
  // fabric straight through it. There is no cloth simulation here and no mesh
  // collision; what there is, is the ability to ask the model where its surface
  // is, which is enough to stop at it.
  function backSurfaceDepth(fig, facing, boneName = "spine3") {
    const chest = fig.group.getObjectByName(boneName);
    if (!chest) return 0.12;
    const from = chest.getWorldPosition(new THREE.Vector3());
    // How far the surface of this body region reaches BEHIND the bone —
    // buttocks, jeans, blouse included, since garments are skinned to the
    // same bones and their vertices come along in the same query.
    const back = new THREE.Vector3(-Math.sin(facing), 0, -Math.cos(facing));
    // "hip" means the seat of the body — pelvis and its twists, minus the
    // legs. "spine3" means the back of the chest — minus arms and head.
    const region = boneName === "hip"
      ? limbRegion(fig, "pelvis", ["l_thigh", "r_thigh"])
      : limbRegion(fig, boneName, ["l_upperarm", "r_upperarm", "neck1"]);
    const span = limbSurface(fig, region, { dir: back, origin: from });
    if (!span || span.maxAlong == null || span.maxAlong <= 0) return 0.12;
    return Math.max(0.04, Math.min(0.3, span.maxAlong));
  }

  // The TOP surface of the body at a world XZ — underSurfaceY's twin, fired
  // downward. Kept deliberately short-range for the same reason the palm ray
  // is: from far above, the first thing hit over a lap is an arm.
  function topSurfaceY(fig, at, rise = 0.12) {
    if (!fig?.model) return null;
    const start = new THREE.Vector3(at.x, at.y + rise, at.z);
    const rc = new THREE.Raycaster(start, new THREE.Vector3(0, -1, 0), 0, rise);
    const hits = rc.intersectObject(fig.model, true).filter(h => h.object.isSkinnedMesh || h.object.isMesh);
    // Raw, unjudged. The caller decides whether it is plausible — keeping the
    // rejection separate from the miss is the difference between "the ray hit
    // nothing" and "the ray hit something I refused to believe", and those
    // need different fixes.
    return hits.length ? hits[0].point.y : null;
  }

  // A point on top of the thigh, just past halfway to the knee — where a palm
  // goes when it rests on the lap.
  function lapTarget(fig, side, facing) {
    const hip = fig.group.getObjectByName(side + "_thigh");
    const knee = fig.group.getObjectByName(side + "_shin");
    if (!hip || !knee) return null;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    hip.getWorldPosition(a); knee.getWorldPosition(b);
    const at = a.clone().lerp(b, 0.55);
    const span = limbSurface(fig, limbRegion(fig, side + "_thigh", [side + "_shin"]), { boneFrom: side + "_thigh", boneTo: side + "_shin", tMin: 0.4, tMax: 0.7 });
    const raw = span ? span.maxY : null;
    const ok = raw != null && raw > at.y + 0.01 && raw < at.y + 0.16;
    // On the thigh's CENTRE LINE the hands sit between the legs and the
    // elbows clamp to the ribs. A palm rests on the top-OUTER quadrant, so
    // measure how far the skin reaches outboard of the bone and put the hand
    // over the outer half of that. Wider wrists pull the elbows out with
    // them — no pole constraint needed.
    const across = facing != null ? facing + Math.PI / 2 : null;
    let ox = 0, oz = 0;
    if (across != null) {
      const sign = side === "l" ? 1 : -1;
      const out = new THREE.Vector3(Math.sin(across) * sign, 0, Math.cos(across) * sign);
      const edge = limbSurface(fig, limbRegion(fig, side + "_thigh", [side + "_shin"]),
        { boneFrom: side + "_thigh", boneTo: side + "_shin", tMin: 0.4, tMax: 0.7, dir: out, origin: at });
      const reach = edge && edge.maxAlong != null ? Math.max(0.03, Math.min(0.12, edge.maxAlong)) : 0.06;
      // 0.35, not 0.55: at 0.55 the hand sat on the outboard fall of the
      // thigh while its height was referenced to the crown — a built-in gap.
      ox = out.x * reach * 0.35; oz = out.z * reach * 0.35;
    }
    const v = new THREE.Vector3(at.x + ox, ((ok ? raw : null) ?? at.y + 0.07) + 0.03, at.z + oz);
    v.probe = { raw: raw == null ? null : +raw.toFixed(3), boneY: +at.y.toFixed(3), accepted: ok, verts: span ? span.count : 0 };
    return v;
  }

  // Shoulder to elbow to wrist, on this body, in this pose.
  function armLength(fig, side) {
    const u = fig.group.getObjectByName(side + "_upperarm");
    const f = fig.group.getObjectByName(side + "_forearm");
    const h = fig.group.getObjectByName(side + "_hand");
    if (!u || !f || !h) return null;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    u.getWorldPosition(a); f.getWorldPosition(b); h.getWorldPosition(c);
    return a.distanceTo(b) + b.distanceTo(c);
  }

  // ── measuring the DEFORMED body by its own vertices ───────────────────
  //
  // Raycasting these bodies is blind: rays fired straight through a solid
  // thigh return ZERO hits (three r185, 17 SkinnedMeshes — verified with the
  // rayTest accessor on 2026-09-11). Every surface helper then fell back to
  // a constant, silently, and "measured" became fiction. So: stop asking
  // rays, ask the vertices. Each vertex declares which bones own it
  // (skinIndex/skinWeight); take one limb's vertices, run them through the
  // same skinning the GPU does (applyBoneTransform), and read the surface
  // off the result. Weight-filtering also ends the "ray found the wrong
  // limb" class of bug outright — a thigh reading cannot see a hand, because
  // hand vertices are not weighted to the thigh.
  // A REGION of bones, not one bone. Genesis 9 does not weight vertices to
  // the named limb bones at all — measured on Magnus's avatar, all 17 meshes
  // carry ZERO vertices referencing l_thigh, yet the leg deforms, because the
  // weights live on that bone's child TWIST bones (l_thightwist1/2, ...). Ask
  // for the parent and you get silence; ask for the subtree and you get the
  // limb. `excludes` cuts off where the next limb segment begins.
  function limbRegion(fig, rootName, excludes = []) {
    const root = fig.group.getObjectByName(rootName);
    if (!root) return null;
    const ex = new Set();
    for (const e of excludes) {
      const b = fig.group.getObjectByName(e);
      if (b) b.traverse((o) => { if (o.isBone) ex.add(o.name); });
    }
    const names = new Set();
    root.traverse((o) => { if (o.isBone && !ex.has(o.name)) names.add(o.name); });
    return { key: rootName + "-" + excludes.join("+"), names };
  }

  function limbVertexIds(fig, mesh, region, minWeight = 0.3) {
    const key = mesh.uuid + ":" + region.key;
    fig._limbVerts = fig._limbVerts || new Map();
    if (fig._limbVerts.has(key)) return fig._limbVerts.get(key);
    const out = [];
    const geo = mesh.geometry;
    const si = geo?.attributes?.skinIndex, sw = geo?.attributes?.skinWeight;
    const bones = mesh.skeleton?.bones;
    if (si && sw && bones) {
      const wanted = new Set();
      bones.forEach((b, i) => { if (region.names.has(b.name)) wanted.add(i); });
      if (wanted.size) {
        for (let i = 0; i < si.count; i++) {
          for (let k = 0; k < 4; k++) {
            if (sw.getComponent(i, k) >= minWeight && wanted.has(si.getComponent(i, k))) { out.push(i); break; }
          }
        }
      }
    }
    const arr = out.length ? new Uint32Array(out) : null;
    fig._limbVerts.set(key, arr);
    return arr;
  }

  // World-space extremes of one limb's surface, in its CURRENT pose.
  // `boneFrom`/`boneTo` + tMin/tMax restrict to a stretch along the limb's
  // own axis, so a thigh reading is the middle of the thigh rather than the
  // knee or the buttock. `dir`+`origin` additionally report how far the
  // surface reaches along an arbitrary direction — that is what the backrest
  // clearance needs. Returns null rather than a guess when nothing matched:
  // the caller decides what a miss means, visibly.
  // `skipGarments`: a body SITS through its clothes — the support surface is
  // flesh, and measuring the shorts hem as "the underside of the thigh"
  // perched him 9cm above the chair with his feet off the floor. Clearance
  // surfaces (backrest, lap top) keep the clothes; support surfaces skip
  // them. Garment detection is by mesh name (body pieces are Genesis9*,
  // clothes are not) — fragile across outfits, but honest about being so.
  function limbSurface(fig, region, { boneFrom = null, boneTo = null, tMin = 0, tMax = 1, dir = null, origin = null, skipGarments = false } = {}) {
    if (!region) return null;
    if (!fig?.model) return null;
    let a = null, axis = null, len = 0;
    if (boneFrom && boneTo) {
      const A = fig.group.getObjectByName(boneFrom), B = fig.group.getObjectByName(boneTo);
      if (A && B) {
        a = A.getWorldPosition(new THREE.Vector3());
        const b = B.getWorldPosition(new THREE.Vector3());
        axis = b.sub(a); len = axis.length(); if (len > 0) axis.normalize();
      }
    }
    const v = new THREE.Vector3();
    let minY = Infinity, maxY = -Infinity, maxAlong = -Infinity, count = 0;
    const ys = [];
    fig.model.traverse((mesh) => {
      if (!mesh.isSkinnedMesh || typeof mesh.applyBoneTransform !== "function") return;
      if (skipGarments && !/^Genesis/.test(mesh.name || "")) return;
      const ids = limbVertexIds(fig, mesh, region);
      if (!ids) return;
      const pos = mesh.geometry.attributes.position;
      for (const i of ids) {
        v.fromBufferAttribute(pos, i);
        mesh.applyBoneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        if (axis && len > 0) {
          const t = ((v.x - a.x) * axis.x + (v.y - a.y) * axis.y + (v.z - a.z) * axis.z) / len;
          if (t < tMin || t > tMax) continue;
        }
        count++;
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
        ys.push(v.y);
        if (dir && origin) {
          const along = (v.x - origin.x) * dir.x + (v.y - origin.y) * dir.y + (v.z - origin.z) * dir.z;
          if (along > maxAlong) maxAlong = along;
        }
      }
    });
    if (!count) return null;
    ys.sort((x, y) => x - y);
    // yAt(0.15) = the height below which the lowest 15% of the surface lies.
    // Flesh COMPRESSES: seat a rigid mesh on its absolute lowest vertex and
    // the body perches on one polygon, feet in the air. Letting the lowest
    // fraction of the surface "sink in" stands in for the centimetres a real
    // thigh gives to a chair.
    const yAt = (q) => ys[Math.min(ys.length - 1, Math.max(0, Math.floor(q * ys.length)))];
    return { minY, maxY, count, maxAlong: dir ? maxAlong : null, yAt };
  }

  // How deep is this arm still inside the torso's visible front? The whole
  // forearm+hand region, every vertex — but only vertices currently OVER the
  // torso: laterally inside the chest's measured half-width and no more than
  // 10cm behind its front line. An arm hanging at the side is BESIDE the
  // body, not buried in it — without this filter the controller would shove
  // idle arms forward. Returns metres of deficit (positive = buried behind
  // the shirt front), or null when the arm is not over the torso at all.
  function armTorsoDeficit(fig, sd, fdir, sdir, cp, prof, margin, halfW) {
    const region = limbRegion(fig, sd + "_forearm");
    if (!region || !prof) return null;
    const v = new THREE.Vector3();
    const dvs = [];
    fig.model.traverse((mesh) => {
      if (!mesh.isSkinnedMesh || typeof mesh.applyBoneTransform !== "function") return;
      const ids = limbVertexIds(fig, mesh, region);
      if (!ids) return;
      const pos = mesh.geometry.attributes.position;
      for (const i of ids) {
        v.fromBufferAttribute(pos, i);
        mesh.applyBoneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        const lat = (v.x - cp.x) * sdir.x + (v.z - cp.z) * sdir.z;
        if (Math.abs(lat) > halfW) continue;
        const fwd = (v.x - cp.x) * fdir.x + (v.z - cp.z) * fdir.z;
        if (fwd < -0.10) continue;
        // Compare against the LOCAL skin surface at this vertex's own
        // (height, lateral) cell. Empty cell = no torso there = nothing to
        // clear. Deficit is PENETRATION: how far behind the local skin the
        // vertex sits, plus a 1cm visual margin.
        const bi = Math.floor((v.y - prof.yMin) / prof.bandH);
        if (bi < 0 || bi >= prof.nB) continue;
        const li = Math.floor((lat + prof.halfW) / prof.latB);
        if (li < 0 || li >= prof.nL) continue;
        const bf = prof.grid[bi * prof.nL + li];
        if (bf === -Infinity) continue;
        dvs.push(bf + margin - fwd);
      }
    });
    if (dvs.length < 12) return null;
    // 80th percentile, not max. The MAX is a phantom: a hand TUCKED beside
    // the pec bulge always reads "behind" its cell's maximum without being
    // inside anything (Benny read 0.13 buried while visually resting
    // naturally on his belly). A truly buried forearm SHAFT is hundreds of
    // vertices deep; a tucked hand is a few dozen shallow ones.
    dvs.sort((a, b) => a - b);
    return dvs[Math.min(dvs.length - 1, Math.floor(0.8 * dvs.length))];
  }

  // Slide her forward until the back of her CLEARS the backrest.
  //
  // Placing the hips half a seat-depth back put her buttocks and the hem of her
  // blouse out BEHIND the chair — she was not leaning through the wood, she was
  // sitting behind it. Where the hips belong is not a fraction of the seat: it
  // is wherever puts her back surface just in front of the rest, and only the
  // body knows how thick it is.
  function clearBackrest(fig, prop, t, facing) {
    if (t.seatFacing == null) return;          // nothing behind her on a stool
    const hipBone = fig.group.getObjectByName("hip");
    if (!hipBone) return;
    const h = new THREE.Vector3();
    hipBone.getWorldPosition(h);

    const fx = Math.sin(facing), fz = Math.cos(facing);
    const bx = prop.x - fx * (t.hd * 0.82);
    const bz = prop.z - fz * (t.hd * 0.82);

    const ahead = (h.x - bx) * fx + (h.z - bz) * fz;
    const depth = backSurfaceDepth(fig, facing, "hip");
    const clearance = 0.015;
    const push = clearance - (ahead - depth);
    if (push > 0) {
      fig.group.position.x += fx * push;
      fig.group.position.z += fz * push;
    }
  }

  // Work out what there is to settle against, then hand it to the frame loop.
  function startSettling(fig, prop) {
    const t = PROP_TYPES[prop.type];
    if (!t) return;
    const yaw = prop.yaw ?? ((prop.rot || 0) * Math.PI) / 2;
    const facing = t.seatFacing == null ? fig.group.rotation.y : yaw + t.seatFacing;

    // Before anything else: get her body in front of the backrest. Everything
    // after this — how far she can lean, where her hands land — is measured
    // from where she actually ends up.
    clearBackrest(fig, prop, t, facing);
    // ...and the matrices have to catch up before anything MEASURES her again.
    // getWorldPosition reads matrixWorld, which three.js only recomputes at
    // render: without this, the lean was measured against where she stood
    // BEFORE the slide, found no room, and allowed zero degrees. She sat bolt
    // upright and I nearly explained it as the garment colliding.
    fig.group.updateMatrixWorld(true);

    // A point on the seat surface beside each hip — where a hand would land.
    const side = (sign) => {
      const across = facing + Math.PI / 2;
      return new THREE.Vector3(
        prop.x + Math.sin(across) * sign * (t.hw * 0.9) - Math.sin(facing) * 0.02,
        t.seat + 0.03,
        prop.z + Math.cos(across) * sign * (t.hw * 0.9) - Math.cos(facing) * 0.02,
      );
    };

    // Where the hands go — and the honest answer is "it depends on the body".
    //
    // Hands flat on the seat beside the hips is only natural if the seat is
    // actually within reach. On Magnus's avatar it was not: his right shoulder
    // sat 0.067 off the chair's centre line and the target 0.216 out, so the
    // arm straightened, failed to arrive, and hung 6.7cm above the wood while
    // the left hand — whose target happened to fall almost under its shoulder
    // — landed fine. Solving harder would not have helped; the point was out
    // of range.
    //
    // A person resolves that conflict by not doing it: palms go to the lap
    // instead (Magnus, 2026-09-11). Elbow bend needs no special case — CCD
    // bends the elbow on its own as soon as the target is closer than a
    // straight arm, which is exactly what a reachable target means.
    //
    // Both hands move together. One on the seat and one on the lap is a
    // fidget, not a rest.
    const seatTargets = { l: side(+1), r: side(-1) };
    const reachable = ["l", "r"].every((sd) => {
      const sh = fig.group.getObjectByName(sd + "_upperarm");
      const len = armLength(fig, sd);
      if (!sh || !len) return true;
      return sh.getWorldPosition(new THREE.Vector3()).distanceTo(seatTargets[sd]) <= len * 0.95;
    });
    const lap = { l: lapTarget(fig, "l", facing), r: lapTarget(fig, "r", facing) };
    // Reachable is not the same as AVAILABLE. On a heavy body the thighs
    // spill over the point beside the hips where a seat-resting hand would
    // go — Benny's arms pass the reach test and his hands then drive
    // straight down into his own thigh flesh (Magnus, 2026-09-12: "the
    // hands are buried in his thigh"). There is no collision system to
    // catch that; what we can do is MEASURE it: how far this body's thigh
    // flesh spills sideways from the chair's centre line, and if it covers
    // the seat point, the seat is not on offer for this body. A hand needs
    // ~4cm of clear wood.
    const across = facing + Math.PI / 2;
    const seatBlocked = ["l", "r"].some((sd) => {
      const sign = sd === "l" ? 1 : -1;
      const out = new THREE.Vector3(Math.sin(across) * sign, 0, Math.cos(across) * sign);
      const spill = limbSurface(fig, limbRegion(fig, sd + "_thigh", [sd + "_shin"]),
        { dir: out, origin: new THREE.Vector3(prop.x, t.seat, prop.z) });
      if (!spill || spill.maxAlong == null) return false;
      return spill.maxAlong > t.hw * 0.9 - 0.04;
    });
    const onLap = (!reachable || seatBlocked) && lap.l && lap.r;
    const hands = onLap ? lap : seatTargets;
    // On the lap the fingers lie along the thigh, toward the knee. On the
    // seat they point forward, tipped slightly down onto the wood.
    const fingerDir = {};
    for (const sd of ["l", "r"]) {
      if (onLap) {
        const A = fig.group.getObjectByName(sd + "_thigh"), B = fig.group.getObjectByName(sd + "_shin");
        if (A && B) {
          // Fingers follow the SURFACE, not the bone. The bone's axis runs
          // through the middle of the leg and is shallower than the way the
          // flesh falls off toward the knee, so bone-aligned fingers left an
          // air wedge under the palm (Magnus, close-up 2026-09-12). Measure
          // the top of the thigh at the palm's station and at the fingers'
          // station, and aim the hand down that actual gradient.
          const ap = A.getWorldPosition(new THREE.Vector3());
          const bp = B.getWorldPosition(new THREE.Vector3());
          const h = bp.clone().sub(ap); h.y = 0;
          const horiz = h.length();
          const dir = horiz > 0.01 ? h.divideScalar(horiz) : new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing));
          const reg = limbRegion(fig, sd + "_thigh", [sd + "_shin"]);
          const near = limbSurface(fig, reg, { boneFrom: sd + "_thigh", boneTo: sd + "_shin", tMin: 0.45, tMax: 0.6 });
          const far = limbSurface(fig, reg, { boneFrom: sd + "_thigh", boneTo: sd + "_shin", tMin: 0.7, tMax: 0.85 });
          if (near && far && horiz > 0.01) {
            dir.y = (far.maxY - near.maxY) / (horiz * 0.25);
          } else {
            dir.y = (bp.y - ap.y) / Math.max(0.01, horiz);
          }
          fingerDir[sd] = dir.normalize();
        } else fingerDir[sd] = null;
      } else {
        fingerDir[sd] = new THREE.Vector3(Math.sin(facing), -0.25, Math.cos(facing)).normalize();
      }
    }

    fig.settling = {
      t: 0, dur: 0.45, base: new Map(), facing, seatY: t.seat,
      restingOn: onLap ? "lap" : "seat",
      // The surface under each hand, so the measured palm thickness can be
      // added to the right thing — the seat is one height, two thighs are
      // another two.
      handSurface: { l: hands.l.y - 0.03, r: hands.r.y - 0.03 },
      fingerDir,
      floorAnkle: fig.seatedFloorAnkle ?? 0,
      // Legs are SOLVED, not posed: hips are wherever the seat put them, so the
      // fold that reaches the floor from there is arithmetic, not a constant.
      legs: true,
      // Lean only against a real backrest — a stool leaves her upright, which
      // is what sitting on a stool looks like.
      back: t.seatFacing != null,
      lean: t.seatFacing == null ? 0 : -leanLimit(fig, prop, t, facing),
      hands,
      done: null,
    };
  }

  // Pulling a chair: the hands take the top of the backrest, then the chair
  // and the body move as ONE PIECE — same delta to the prop entry (which the
  // path planner reads), to the rendered group, and to the root. The body
  // slides backward rather than stepping; honest limitation, the feet do not
  // animate here yet.
  function stepPulling(fig, delta) {
    const st = fig.pulling;
    if (!st) return;
    st.t += delta;
    const e = Math.min(1, st.t / st.dur);
    // Take hold first, then move: the grab blends in over the first quarter
    // second, the pull itself runs through the middle, smoothstepped so the
    // chair leaves and arrives gently rather than being yanked.
    const grabW = Math.min(1, st.t / 0.25);
    const m = Math.max(0, Math.min(1, (e - 0.18) / 0.72));
    const k = m * m * (3 - 2 * m);
    const dx = st.dir.x * st.dist * k, dz = st.dir.z * st.dist * k;
    st.prop.x = st.fromProp.x + dx;
    st.prop.z = st.fromProp.z + dz;
    if (st.propGroup) st.propGroup.position.set(st.prop.x, 0, st.prop.z);
    fig.group.position.x = st.fromFig.x + dx;
    fig.group.position.z = st.fromFig.z + dz;
    fig.group.updateMatrixWorld(true);

    // Hands on the top corners of the backrest, wherever the chair is NOW.
    const up = new THREE.Vector3(0, 1, 0);
    for (const [side, sign] of [["l", 1], ["r", -1]]) {
      const local = new THREE.Vector3(sign * st.grabHalfWidth, st.grabHeight, -st.backLocalZ);
      local.applyAxisAngle(up, st.yaw);
      local.x += st.prop.x; local.z += st.prop.z;
      solveChain(fig, [side + "_upperarm", side + "_forearm"], side + "_hand", local, grabW, 6);
    }

    if (st.t >= st.dur) {
      fig.pulling = null;
      st.done?.(true);
    }
  }

  // SEATED, YOU AND THE CHAIR ARE ONE OBJECT (Magnus, 2026-09-12: "people
  // push themself and the chair backwards before raising... pull themself
  // and the chair forward when seated"). Scooting is that object moving:
  // the chair entry (planner), the chair mesh, the body root, and the
  // hands resting on the lap all translate together. Runtime-only, like the
  // pull — the authored room is not edited by someone shuffling a chair.
  function startScoot(fig, prop, dir, dist, dur = 0.7) {
    return new Promise((resolve) => {
      fig.scooting = {
        t: 0, dur, dist, dir, prop,
        propGroup: (api.current.furniture?.children || []).find?.((g) => g.userData?.propId === prop.id) || null,
        lastK: 0, done: resolve,
      };
    });
  }

  function stepScooting(fig, delta) {
    const st = fig.scooting;
    if (!st) return;
    st.t += delta;
    const e = Math.min(1, st.t / st.dur);
    const m = e * e * (3 - 2 * e);
    const dk = m - st.lastK;
    st.lastK = m;
    const dx = st.dir.x * st.dist * dk, dz = st.dir.z * st.dist * dk;
    st.prop.x += dx; st.prop.z += dz;
    if (st.propGroup) st.propGroup.position.set(st.prop.x, 0, st.prop.z);
    fig.group.position.x += dx;
    fig.group.position.z += dz;
    // The lap-hand targets are WORLD points; left behind, the settle would
    // drag his arms backward off his own knees as he slides.
    const hands = fig.settling?.hands;
    if (hands) for (const sd of ["l", "r"]) {
      if (hands[sd]) { hands[sd].x += dx; hands[sd].z += dz; }
    }
    if (st.t >= st.dur) { fig.scooting = null; st.done?.(true); }
  }

  // The nearest piece of furniture in FRONT of a seat, and the gap from the
  // seat's centre to its near edge — what both scoots decide against.
  function frontObstacle(prop, facing) {
    const fx = Math.sin(facing), fz = Math.cos(facing);
    let best = null;
    for (const o of api.current.obstacles || []) {
      if (!o.type || o.id === prop.id) continue;
      const dx = o.x - prop.x, dz = o.z - prop.z;
      const fwd = dx * fx + dz * fz;
      const lat = Math.abs(-dx * fz + dz * fx);
      if (fwd <= 0 || fwd > 1.6) continue;
      if (lat > (o.hw + o.hd) / 2 + 0.3) continue;
      const halfAlong = Math.abs(fx) * o.hw + Math.abs(fz) * o.hd;
      const gap = fwd - halfAlong;
      if (!best || gap < best.gap) best = { o, gap };
    }
    return best;
  }

  function stepSitting(fig, delta) {
    const st = fig.sitting;
    if (!st) return;
    st.t = Math.min(st.dur, st.t + delta);
    const u = st.dur > 0 ? st.t / st.dur : 1;
    const e = u * u * (3 - 2 * u);

    fig.group.position.x = st.from.x + (st.to.x - st.from.x) * e;
    fig.group.position.z = st.from.z + (st.to.z - st.from.z) * e;

    // Standing only: the torso pitches forward through the middle of the
    // rise and returns — a bell, zero at both ends, so it starts seated and
    // ends upright with no residue. Multiplied onto the mixer's fresh value
    // (idle animates the spine), so it applies once per frame by design.
    if (st.standLean) {
      const bell = Math.sin(Math.PI * Math.min(1, e));
      for (const [name, deg] of [["spine1", 10], ["spine3", 8]]) {
        const b = fig.group.getObjectByName(name);
        if (!b) continue;
        _e.set(deg * bell * DEG, 0, 0);
        _q.setFromEuler(_e);
        b.quaternion.multiply(_q);
      }
    }
    // The chair gives way to the legs, smoothly, over the same rise.
    if (st.push) {
      const m = Math.min(1, e);
      const k = m * m * (3 - 2 * m);
      st.push.prop.x = st.push.from.x + st.push.dir.x * st.push.dist * k;
      st.push.prop.z = st.push.from.z + st.push.dir.z * st.push.dist * k;
      if (st.push.group) st.push.group.position.set(st.push.prop.x, 0, st.push.prop.z);
    }

    // Two constraints, and which one rules changes as she lowers.
    //
    // On the way down her FEET are what she is standing on, so they stay on the
    // floor — that is what stops the jump. At the end the SEAT is what she is
    // resting on, so the thigh has to meet it, or she hovers just above the
    // chair in a sitting shape. Holding only the first left her 6cm off it.
    //
    // Blended over the last fifth of the movement so the handover is a settle,
    // not a step.
    // Raycast only over the last fifth, which is the only part where seatY is
    // weighted above zero anyway: ~15 frames of skinned raycast rather than
    // one per frame of the whole descent, and every one of them taken in a
    // pose close to the one she will hold.
    const seatY = st.seat != null ? seatHeightFor(fig, st.seat, e >= 0.78) : null;
    const footY = footHeightFor(fig, st.floorAnkle);
    if (seatY == null || footY == null) {
      if (footY != null) fig.group.position.y = footY;
    } else {
      // The SEAT decides the height, and the legs are then solved to reach the
      // floor from wherever that leaves them.
      //
      // This used to clamp to the feet — never lower than a foot-planted
      // solution — which meant fixed leg angles decided how high she sat, and
      // she perched 11cm above the chair. Fold cannot be a constant: it depends
      // on the seat, and on the length of the legs doing the sitting.
      const k = Math.max(0, Math.min(1, (e - 0.8) / 0.2));
      fig.group.position.y = footY + (seatY - footY) * k;
    }

    if (st.t >= st.dur) {
      fig.sitting = null;
      if (st.propId) {
        fig.seatedOn = st.propId;
        fig.seatedY = fig.group.position.y;
        // Kept so standing up can hold the same floor on the way back.
        fig.seatedFloorAnkle = st.floorAnkle;
        if (st.settleWith) startSettling(fig, st.settleWith);
      }
      st.done?.();
    }
  }

  // The root height that would put the lower foot on the floor. Returned
  // rather than applied, so the caller can weigh it against the seat.
  function footHeightFor(fig, floorAnkle) {
    const v = new THREE.Vector3();
    let lowest = Infinity;
    for (const name of ["l_foot", "r_foot"]) {
      const f = fig.group.getObjectByName(name);
      if (!f) continue;
      f.getWorldPosition(v);
      lowest = Math.min(lowest, v.y);
    }
    if (!Number.isFinite(lowest)) return null;
    if (!Number.isFinite(floorAnkle)) return fig.group.position.y;
    // Hold the ankle at the height it had when she was STANDING here — which
    // is, by definition, the height at which her sole meets this floor. No
    // global constant, no measurement taken in the wrong pose: the reference
    // comes from the body a moment before it started to move.
    return fig.group.position.y - (lowest - floorAnkle);
  }

  // The root height that would rest the thigh on a seat at `surface`.
  //
  // `drop` is the measured distance from the thigh bone to the underside of
  // the leg. THIGH_RADIUS is only the fallback: it is one number for every
  // body, and Benny's legs are not Lindsey's — with her constant he sat with
  // his thighs melted into the slab (Magnus, screenshot 2026-09-11). Clothing
  // counts too; the ray hits the shorts, not the skin.
  function seatHeightFor(fig, surface, measure) {
    // Measured path: move the root by exactly the gap between where the
    // underside of the leg IS and where the seat IS. Independent of how the
    // leg happens to be angled this frame, and self-correcting — moving the
    // root moves the surface with it, so this converges rather than oscillates.
    if (measure) {
      const under = thighUnderY(fig);
      if (under != null) return fig.group.position.y + (surface - under);
    }
    const thigh = fig.group.getObjectByName("l_thigh");
    if (!thigh) return null;
    const v = new THREE.Vector3();
    thigh.getWorldPosition(v);
    return fig.group.position.y + (surface + THIGH_RADIUS - v.y);
  }

  function shortest(d) {
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  function easeAngle(from, to, t) {
    return from + shortest(to - from) * Math.min(1, t);
  }

  // ── the rig the runner is handed ──────────────────────────────────────────
  //
  // Deliberately the SAME shape an encounter would implement: performer(role)
  // returning clip / walkTo / approach / turnTo. Nothing here knows what a
  // script is, and interactionScript.js knows nothing about three.js — which
  // is what lets one script run in both rooms.
  function publishRig() {
    const a = api.current;
    const rig = {
      performer(role) {
        const fig = a.figures?.[role];
        if (!fig) return null;
        return {
          // The role travels WITH the performer, and resolving the other side
          // of an approach goes through it. Matching on the person's name
          // instead looked tidier and is wrong the moment both slots hold the
          // same character — a perfectly reasonable thing to rehearse.
          role,
          name: fig.person?.name || role,
          clips: Object.keys(fig.clips),
          position: () => ({ x: +fig.group.position.x.toFixed(3), z: +fig.group.position.z.toFixed(3) }),
          clip: (name, opts) => playClip(fig, name, opts),
          walkTo: (x, z, opts) => {
            // Walking while seated stands her up first — otherwise she slides
            // across the room in the shape of a chair.
            if (fig.seatedOn) { fig.seatedOn = null; fig.seatedY = 0; fig.group.position.y = 0; releasePose(fig); }
            return walkTo(fig, x, z, opts);
          },

          // Walk to a named piece of furniture, stopping clear of its EDGE.
          // The prop is found by id, then by slot, then by type — so a script
          // that says "the table" still works in a room whose table is a
          // different table, which is the point of naming it at all.
          // ── sitting ───────────────────────────────────────────────────────
          //
          // Two halves, deliberately from different places. The SHAPE of
          // sitting is the authored `sit` posture — rotations, portable between
          // bodies. WHERE she ends up is geometry the room owns: the seat
          // height off the prop, the facing off its backrest. Rotations alone
          // could bend her into a sitting shape in mid-air; the room is what
          // puts her on the chair.
          sitOn: (ref) => {
            const prop = findProp(a.obstacles, ref);
            if (!prop) {
              // Silence here was the bug: a step that cannot find its prop
              // resolved as if it had done the thing, so the run log read
              // "a sits on the chair … done" while she never moved.
              console.warn("[rig] sit_on: no prop", ref, "in", (a.obstacles || []).map(o => o.id));
              return Promise.resolve({ missing: ref });
            }
            const t = PROP_TYPES[prop.type];
            if (!t?.seat) return Promise.resolve({ notSittable: prop.type });

            const yaw = prop.yaw ?? ((prop.rot || 0) * Math.PI) / 2;
            const facing = t.seatFacing == null
              // Backless: keep whatever way she was already looking, rather
              // than snapping her to an arbitrary side of a stool.
              ? fig.group.rotation.y
              : yaw + t.seatFacing;

            // In FRONT of where she will be sitting — the open side of the
            // chair, which is the direction a seated person faces. Derived from
            // the seated heading rather than guessed, so a chair turned any way
            // is still entered from the front.
            // How far out in front the entry point can be: as far as 0.55m,
            // but never inside another piece of furniture — a chair pulled
            // 0.6m from a table leaves the old entry point INSIDE the table,
            // and a walk ordered to an illegal goal fell back to a straight
            // line THROUGH the chair (Magnus: "he walked thru the chair and
            // sat down!").
            const inReal = (px, pz, o, m = 0.05) =>
              Math.abs(px - o.x) < o.hw + m && Math.abs(pz - o.z) < o.hd + m;
            const others = (a.obstacles || []).filter((o) => o.type && o.id !== prop.id);
            let frontD = 0.55;
            while (frontD > 0.3 && others.some((o) => inReal(prop.x + Math.sin(facing) * frontD,
                                                            prop.z + Math.cos(facing) * frontD, o))) {
              frontD -= 0.05;
            }
            const approachFrom = { x: prop.x + Math.sin(facing) * frontD,
                                   z: prop.z + Math.cos(facing) * frontD };

            // If the straight line from here to the entry point crosses the
            // chair itself, go around: a PLANNED walk to the chair's side
            // corner, then the squeeze. Sampled, not solved — twenty points
            // along the segment against one rectangle.
            const crossesChair = (() => {
              const fx = fig.group.position.x, fz = fig.group.position.z;
              for (let i = 1; i <= 20; i++) {
                const q = i / 20;
                if (inReal(fx + (approachFrom.x - fx) * q, fz + (approachFrom.z - fz) * q, prop, 0.12)) return true;
              }
              return false;
            })();

            const approachSeat = () => {
              if (!crossesChair) return walkTo(fig, approachFrom.x, approachFrom.z, { speed: 1.0 });
              const across = facing + Math.PI / 2;
              // Round whichever corner is nearer to where he stands.
              const side = ((fig.group.position.x - prop.x) * Math.sin(across)
                          + (fig.group.position.z - prop.z) * Math.cos(across)) >= 0 ? 1 : -1;
              const corner = {
                x: prop.x - Math.sin(facing) * 0.05 + Math.sin(across) * side * (t.hw + 0.38),
                z: prop.z - Math.cos(facing) * 0.05 + Math.cos(across) * side * (t.hw + 0.38),
              };
              return walkTo(fig, corner.x, corner.z, { speed: 1.0 })
                .then(() => walkTo(fig, approachFrom.x, approachFrom.z, { speed: 0.8, direct: true }));
            };
            return approachSeat()
              // She arrives looking AT the chair, because she just walked to
              // it. Sitting means turning around first — the seat ends up
              // behind her, and this is the 180 that puts it there.
              .then(() => turnTo(fig, facing))
              .then(() => {
                fig.group.rotation.y = facing;
                // fig.sole — how high the foot bone sits with the sole on the
                // floor — is measured in stepFigure while she stands idle.
                // The pose runs on its own clock; the lowering runs beside it on
                // the same clock, so the bend and the descent are ONE movement
                // rather than a pose followed by a drop.
                // Where her ankles are while she is still standing: the floor,
                // expressed in the only terms that cannot be stale.
                let floorAnkle = null;
                {
                  const v = new THREE.Vector3();
                  const ys = [];
                  for (const n of ["l_foot", "r_foot"]) {
                    const b = fig.group.getObjectByName(n);
                    if (b) { b.getWorldPosition(v); ys.push(v.y - fig.group.position.y); }
                  }
                  if (ys.length) floorAnkle = Math.min(...ys);
                }

                const seated = new Promise((resolve) => {
                  fig.sitting = {
                    t: 0, dur: 0.55, propId: prop.id, done: resolve, seat: t.seat, floorAnkle,
                    settleWith: prop,
                    from: { x: fig.group.position.x, z: fig.group.position.z },
                    // Back ON the seat, not perched on the front of it: toward
                    // the backrest by most of the seat's half-depth, so there
                    // is something behind her to lean against.
                    to: { x: prop.x - Math.sin(facing) * (t.hd * 0.5),
                          z: prop.z - Math.cos(facing) * (t.hd * 0.5) },
                  };
                });
                playMotion(fig, "sit");
                // Seated at a table means AT the table: once the settle has
                // hold of him, he and the chair scoot forward until the seat
                // sits a lap's depth from the table's edge.
                return seated.then(async (r) => {
                  const fb = frontObstacle(prop, facing);
                  if (fb && fb.gap > 0.5) {
                    const dist = Math.min(0.6, fb.gap - 0.42);
                    if (dist > 0.05) {
                      await startScoot(fig, prop, { x: Math.sin(facing), z: Math.cos(facing) }, dist);
                    }
                  }
                  return r;
                });
              });
          },

          pullProp: (ref, distance = 0.6) => {
            const prop = findProp(a.obstacles, ref);
            if (!prop) {
              console.warn("[rig] pull_prop: no prop", ref, "in", (a.obstacles || []).map(o => o.id));
              return Promise.resolve({ missing: ref });
            }
            const t = PROP_TYPES[prop.type];
            if (!t) return Promise.resolve({ notPullable: ref });
            const yaw = prop.yaw ?? ((prop.rot || 0) * Math.PI) / 2;
            // The way a sitter would face; the pull is the opposite way —
            // out from under whatever the seat is tucked against.
            const facing = yaw + (t.seatFacing ?? 0);
            const bx = Math.sin(facing), bz = Math.cos(facing);
            const grab = { x: prop.x - bx * (t.hd + 0.42), z: prop.z - bz * (t.hd + 0.42) };
            return walkTo(fig, grab.x, grab.z, { speed: 0.95 })
              .then(() => turnTo(fig, Math.atan2(prop.x - fig.group.position.x,
                                                 prop.z - fig.group.position.z)))
              .then(() => new Promise((resolve) => {
                fig.pulling = {
                  t: 0, dur: 1.1, prop, dist: distance, yaw,
                  fromProp: { x: prop.x, z: prop.z },
                  fromFig: { x: fig.group.position.x, z: fig.group.position.z },
                  dir: { x: -bx, z: -bz },
                  propGroup: a.furniture?.children?.find?.((g) => g.userData?.propId === prop.id) || null,
                  grabHeight: (t.h ?? 0.9) - 0.02,
                  grabHalfWidth: t.hw * 0.65,
                  backLocalZ: t.hd * 0.82,
                  done: resolve,
                };
              }))
              // Deliberately NOT pushed back into the page's props state. The
              // first version did, "so the panel and saves would know" — and
              // every run then STARTED from where the last one ended: run it
              // three times and the chair marched 1.8m across the room
              // (Magnus: "pulls the chair further and further back"). A run
              // may borrow the scene, never keep it — the pull is a runtime
              // effect on the planner's map and the meshes; the AUTHORED
              // position stays what the author placed.
              ;
          },

          standUp: async () => {
            if (!fig.seatedOn) return { notSeated: true };
            // FIRST the chair goes back, WITH him on it — then he stands.
            // Rising over the feet without this planted him inside the table
            // he was sitting at: the feet were in the gap, and the gap was
            // the table's.
            {
              const sp = findProp(a.obstacles, fig.seatedOn);
              if (sp) {
                const t0 = PROP_TYPES[sp.type];
                const f0 = (sp.yaw ?? ((sp.rot || 0) * Math.PI) / 2) + (t0?.seatFacing ?? 0);
                const fb = frontObstacle(sp, f0);
                if (fb && fb.gap < 0.75) {
                  const dist = Math.min(0.7, 0.75 - fb.gap);
                  await startScoot(fig, sp, { x: -Math.sin(f0), z: -Math.cos(f0) }, dist);
                }
              }
            }
            // A person does not levitate off a chair — they stand OVER THEIR
            // FEET. Rising in place ended him upright in the middle of the
            // seat, legs through the wood (Magnus, 2026-09-12, with the whole
            // recipe: feet down, torso forward, knees straighten, torso back
            // — and if the legs hit the chair, the chair gives). The feet
            // stayed planted in front of the seat all through the sit, so the
            // rise carries the root forward to their midpoint while the pose
            // fades and a bell-curve forward lean rides through the middle.
            const seatProp = findProp(a.obstacles, fig.seatedOn);
            fig.seatedOn = null;
            releasePoseGently(fig, 0.9);
            const here = { x: fig.group.position.x, z: fig.group.position.z };
            const v = new THREE.Vector3();
            let fx = 0, fz = 0, n = 0;
            for (const name of ["l_foot", "r_foot"]) {
              const b = fig.group.getObjectByName(name);
              if (b) { b.getWorldPosition(v); fx += v.x; fz += v.z; n++; }
            }
            const to = n ? { x: fx / n, z: fz / n } : here;
            // Will his legs end up inside the chair? Measure the gap from
            // where he will STAND to the chair's centre; a calf needs the
            // seat's half-depth plus ~0.22 of body. Short of that, the chair
            // is pushed back by the difference — runtime-only, like the pull:
            // the authored room is not edited by a body standing up in it.
            let push = null;
            if (seatProp) {
              const t = PROP_TYPES[seatProp.type];
              const dx = seatProp.x - to.x, dz = seatProp.z - to.z;
              const d = Math.hypot(dx, dz) || 1;
              const need = (t?.hd ?? 0.24) + 0.22;
              if (d < need) {
                push = {
                  prop: seatProp, dist: need - d,
                  dir: { x: dx / d, z: dz / d },
                  from: { x: seatProp.x, z: seatProp.z },
                  group: a.furniture?.children?.find?.((g) => g.userData?.propId === seatProp.id) || null,
                };
              }
            }
            return new Promise((resolve) => {
              fig.sitting = { t: 0, dur: 0.9, propId: null, seat: null,
                              floorAnkle: fig.seatedFloorAnkle ?? null,
                              standLean: true, push,
                              done: () => { fig.seatedY = 0; resolve(true); },
                              from: here, to };
            });
          },

          walkToProp: (ref, distance = 0.55, opts) => {
            const prop = findProp(a.obstacles, ref);
            if (!prop) {
              console.warn("[rig] walk_to_prop: no prop", ref, "in", (a.obstacles || []).map(o => o.id));
              return Promise.resolve({ missing: ref });
            }

            const from = fig.group.position;
            const dx = from.x - prop.x, dz = from.z - prop.z;
            const d = Math.hypot(dx, dz) || 1;
            // Approach from where the body already is: walking around a table
            // to reach a fixed "front" would look like obedience to a diagram.
            const ux = dx / d, uz = dz / d;
            // Clear the footprint along the approach direction, then the body's
            // own radius, then however close the step asked to stand.
            const reach = Math.abs(ux) * prop.hw + Math.abs(uz) * prop.hd + BODY_RADIUS + distance;
            return walkTo(fig, prop.x + ux * reach, prop.z + uz * reach, opts)
              .then(() => turnTo(fig, Math.atan2(prop.x - fig.group.position.x,
                                                 prop.z - fig.group.position.z)));
          },
          turnTo: (other) => {
            const o = otherFig(other);
            return o ? turnTo(fig, headingFrom(fig, o)) : Promise.resolve();
          },
          interact: (other, slug, opts) => playMotion(fig, slug, { ...opts, otherFig: otherFig(other) }),
          react: (slug) => playMotion(fig, slug),
          approach: (other, distance, opts) => {
            const o = otherFig(other);
            if (!o) return Promise.resolve();
            const from = fig.group.position, to = o.group.position;
            const dx = to.x - from.x, dz = to.z - from.z;
            const d = Math.hypot(dx, dz) || 1;
            // Stop SHORT of them by `distance` — walking to their coordinates
            // means walking into them, and two runtime models intersecting is
            // the ugliest failure this room can produce.
            const stop = Math.max(0, d - distance);
            return walkTo(fig, from.x + (dx / d) * stop, from.z + (dz / d) * stop, opts)
              .then(() => turnTo(fig, headingFrom(fig, o)));
          },
        };
      },
      // Where the camera IS. Read-only — `camera()` both computes and moves,
      // which makes it useless for checking whether a run actually re-framed
      // anything: calling it to look would be the thing that changed it.
      cameraNow() {
        const cam = a.camera, controls = a.controls;
        if (!cam) return null;
        const r = (n) => +n.toFixed(3);
        return { pos: { x: r(cam.position.x), y: r(cam.position.y), z: r(cam.position.z) },
                 target: controls ? { x: r(controls.target.x), y: r(controls.target.y), z: r(controls.target.z) } : null };
      },

      // ── the camera ────────────────────────────────────────────────────────
      //
      // Shots are COMPUTED from where the bodies are standing, every time. That
      // is the whole reason a shot is named rather than stored as coordinates:
      // "over b's shoulder onto a" means the same thing after they have walked
      // across the room, and an xyz means something wrong.
      //
      // It drives OrbitControls' own target rather than fighting it, so the
      // moment you touch the mouse you are simply orbiting from wherever the
      // shot left you — no mode to exit, nothing to fight for the camera.
      camera(spec) {
        const cam = a.camera, controls = a.controls;
        if (!cam || !controls) return false;
        // Remembered so the shot KEEPS FRAMING as they move. Setting the camera
        // once at the top of a step is right only for a step where nobody goes
        // anywhere: through a walk or an approach the two of them stroll out of
        // a frame computed for where they used to be.
        //
        // The side of a two-shot is decided ONCE, here, and carried on the
        // remembered spec. Re-deciding it every frame would let the camera flip
        // across the line between them mid-walk, the moment the midpoint
        // drifted past it.
        a.activeShot = { ...spec };

        const HEAD = 1.58, EYE = 1.62;
        const at = (role) => {
          const f = a.figures?.[role];
          return f ? { x: f.group.position.x, z: f.group.position.z } : null;
        };
        const norm = (v) => {
          const d = Math.hypot(v.x, v.z) || 1;
          return { x: v.x / d, z: v.z / d };
        };

        const shot = spec?.shot || "two_shot";
        let pos, target;

        if (shot === "wide") {
          const A = at("a") || { x: -0.75, z: 0 }, B = at("b") || { x: 0.75, z: 0 };
          const M = { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 };
          pos = { x: M.x, y: spec.height || 2.35, z: M.z + (spec.distance || 4.6) };
          target = { x: M.x, y: 1.15, z: M.z };
        } else if (shot === "two_shot") {
          const A = at("a"), B = at("b");
          if (!A || !B) return false;
          const M = { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 };
          const axis = norm({ x: B.x - A.x, z: B.z - A.z });
          // Perpendicular to the line between them — and on the side the camera
          // is ALREADY on. Flipping to the far side would cross the line
          // between two people mid-scene, which reads as a continuity error
          // even to someone who could not name it.
          let perp = { x: axis.z, z: -axis.x };
          if (spec._side === undefined) {
            const away = { x: cam.position.x - M.x, z: cam.position.z - M.z };
            spec._side = (perp.x * away.x + perp.z * away.z < 0) ? -1 : 1;
            if (a.activeShot) a.activeShot._side = spec._side;
          }
          if (spec._side < 0) perp = { x: -perp.x, z: -perp.z };
          const apart = Math.hypot(B.x - A.x, B.z - A.z);
          const d = spec.distance || Math.max(2.1, apart * 1.7);
          pos = { x: M.x + perp.x * d, y: spec.height || 1.55, z: M.z + perp.z * d };
          target = { x: M.x, y: 1.42, z: M.z };
        } else if (shot === "over_shoulder") {
          const F = at(spec.from), O = at(spec.of);
          if (!F || !O) return false;
          const dir = norm({ x: O.x - F.x, z: O.z - F.z });
          const perp = { x: dir.z, z: -dir.x };
          const back = spec.distance || 0.72;
          pos = { x: F.x - dir.x * back + perp.x * 0.42, y: spec.height || 1.70,
                  z: F.z - dir.z * back + perp.z * 0.42 };
          target = { x: O.x, y: HEAD, z: O.z };
        } else if (shot === "close") {
          const O = at(spec.of);
          if (!O) return false;
          const otherRole = spec.of === "a" ? "b" : "a";
          const P = at(otherRole) || { x: O.x + 1, z: O.z };
          // In FRONT of them, looking back — which means standing roughly where
          // the other person is, a little closer.
          const dir = norm({ x: P.x - O.x, z: P.z - O.z });
          const d = spec.distance || 0.85;
          pos = { x: O.x + dir.x * d, y: spec.height || EYE, z: O.z + dir.z * d };
          target = { x: O.x, y: HEAD, z: O.z };
        } else {
          return false;
        }

        cam.position.set(pos.x, pos.y, pos.z);
        controls.target.set(target.x, target.y, target.z);
        controls.update();
        return { shot, pos, target };
      },

      // Furnishing the room is a RIG capability, not a scene one, because the
      // encounter's rig will answer the same question from its own flat: the
      // planner does not care who supplied the footprints.
      // Hold one side of an interaction at one instant, for authoring and for
      // proving what a frame actually looks like. side: "actor" | "reaction".
      // t = null releases.
      poseAt(role, slug, t = 0) {
        const fig = a.figures?.[role];
        if (!fig) return false;
        if (t === null || !slug) { releasePose(fig); return true; }
        const def = getAction(slug);
        if (!def) return false;
        const tracks = resolveTracks(def);
        const bones = new Map();
        for (const tr of tracks) {
          const b = fig.group.getObjectByName(tr.rigBone);
          if (b) bones.set(tr.rigBone, b);
        }
        const otherRole = role === "a" ? "b" : "a";
        fig.pose = { tracks, bones, t: +t || 0, duration: Infinity,
                     contactAt: def.contactAt ?? null, fired: true, held: true,
                     aim: def.aim || null, otherFig: a.figures?.[otherRole] || null,
                     resolve: null };
        return { posed: [...bones.keys()],
                 missing: tracks.filter(tr => !bones.has(tr.rigBone)).map(tr => tr.rigBone),
                 aim: def.aim || null,
                 aimBone: def.aim ? !!(a.figures?.[otherRole]?.group.getObjectByName(def.aim.at)) : null };
      },

      // Where a bone actually is, in world space. The editor needs it to show
      // reach, and it is the only honest way to check that an authored pose
      // moved anything — a screenshot from the wrong side of a body proves
      // nothing either way.
      // Pose one bone by hand, in degrees, as a delta. null clears that bone;
      // no bone name clears them all.
      poseBone(role, canonical, rot) {
        const fig = a.figures?.[role];
        if (!fig) return false;
        if (!fig.manual) fig.manual = new Map();
        if (!canonical) { fig.manual.clear(); return true; }
        const name = boneFor(canonical) || canonical;
        if (!fig.group.getObjectByName(name)) return { missing: name };
        if (!rot) fig.manual.delete(name);
        else fig.manual.set(name, [+rot[0] || 0, +rot[1] || 0, +rot[2] || 0]);
        return { bone: name, held: [...fig.manual.keys()] };
      },

      // Put a body somewhere instantly, with no walk. Used when the editor
      // scrubs to a step: everything before that step is treated as ALREADY
      // PLAYED, so the two of them stand where the script would have left them
      // rather than at their opening marks. Authoring a contact pose against
      // the wrong separation is authoring the wrong pose.
      place(role, at) {
        const fig = a.figures?.[role];
        if (!fig || !at) return false;
        // Any walk in flight is abandoned, not left to fight the placement —
        // otherwise the body drifts back toward a destination nobody wants.
        fig.walk?.resolve?.(); fig.walk = null;
        fig.turn?.resolve?.(); fig.turn = null;
        fig.group.position.set(+at.x || 0, 0, +at.z || 0);
        if (Number.isFinite(at.facing)) fig.group.rotation.y = at.facing;
        return { x: fig.group.position.x, z: fig.group.position.z, facing: fig.group.rotation.y };
      },

      // How much room this role wants. 0 = they do not mind at all; the
      // collision floor still applies.
      setSpace(role, distance) {
        if (!a.space) a.space = {};
        // Any cast slot, not the two letters. The guard used to refuse a third
        // body's personal space outright, silently.
        if (!a.figures?.[role]) return false;
        a.space[role] = Math.max(0, Math.min(3.6, Number(distance) || 0));
        return { ...a.space };
      },
      spaceOf: () => ({ ...(a.space || { a: 0, b: 0 }) }),

      bonePos(role, canonical) {
        const fig = a.figures?.[role];
        if (!fig) return null;
        const name = boneFor(canonical) || canonical;
        const bone = fig.group.getObjectByName(name);
        if (!bone) return null;
        const v = new THREE.Vector3();
        bone.getWorldPosition(v);
        return { bone: name, x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) };
      },

      setObstacles: (list) => a.setObstacles?.(list) || [],
      // Arm a single floor pick — implemented where OrbitControls is in scope
      // (the room effect), delegated to from here. Written inline first, which
      // could not see `controls` and threw on every call.
      pickPoint: (cb) => a.pickPoint?.(cb),
      cancelPick: () => a.cancelPick?.(),

      // Which prop is under a click, so one can be selected in the room rather
      // than hunted for in a list.
      propAt(clientX, clientY) {
        const cam = a.camera;
        if (!cam || !a.furniture) return null;
        const rect = a.renderer.domElement.getBoundingClientRect();
        const v = new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1,
        );
        const rc = new THREE.Raycaster();
        rc.setFromCamera(v, cam);
        const hit = rc.intersectObjects(a.furniture.children, true)[0];
        let o = hit?.object;
        while (o && !o.userData?.propId) o = o.parent;
        return o?.userData?.propId || null;
      },

      // Props: typed furniture, placed by pointing at the floor.
      addProp: (type) => a.beginPlacing?.(type),
      // Same delegation as addProp. Defining it on the internal helper
      // object only is how it came to be unreachable: the page holds the
      // PUBLISHED rig, and an optional call to a method that is not on it
      // fails by doing nothing at all.
      moveProp: (id) => a.moveProp?.(id),
      cancelProp: () => a.endPlacing?.(),
      // What is waiting to be put down, so the UI can stop looking armed when
      // the scene has already ended placement (a drop, or Escape).
      placingType: () => a.placing?.type || null,
      // Debug: the measured sole offset and current root height, because
      // guessing at these has cost several rounds.
      footInfo: (role) => {
        const f = a.figures?.[role];
        if (!f) return null;
        return { sole: f.sole, rootY: +f.group.position.y.toFixed(3), seatedOn: f.seatedOn || null,
                 sitting: !!f.sitting, settling: !!f.settling,
                 settleT: f.settling ? +f.settling.t.toFixed(2) : null,
                 pose: f.pose ? f.pose.tracks.length : 0 };
      },
      // What the sit decided about the hands, and what it measured to decide
      // it. Added because "are the palms ON the lap or IN it" had no oracle
      // outside this module — the seat surface is a constant anyone can read,
      // a thigh's top is not.
      // Morph targets (hand grips etc. — exported in the runtime GLBs).
      // morphs(role) lists every morph name with its current value; setMorph
      // drives it on EVERY mesh that carries it (body + garments share
      // names), so a grip closes the glove too.
      morphs: (role) => {
        const f = a.figures?.[role];
        if (!f?.model) return null;
        const out = {};
        f.model.traverse((m) => {
          const dict = m.morphTargetDictionary;
          if (!dict || !m.morphTargetInfluences) return;
          for (const [name, idx] of Object.entries(dict)) {
            if (!(name in out)) out[name] = +m.morphTargetInfluences[idx].toFixed(3);
          }
        });
        return out;
      },
      setMorph: (role, name, value) => {
        const f = a.figures?.[role];
        if (!f?.model) return false;
        let hit = 0;
        f.model.traverse((m) => {
          const idx = m.morphTargetDictionary?.[name];
          if (idx == null || !m.morphTargetInfluences) return;
          m.morphTargetInfluences[idx] = value;
          hit++;
        });
        return hit;
      },
      skinInfo: (role) => {
        const f = a.figures?.[role];
        const sk = f?.pose?.skin;
        if (!sk) return null;
        return { r: +sk.r.toFixed(2), l: +sk.l.toFixed(2), tr: +sk.tr.toFixed(2), tl: +sk.tl.toFixed(2), halfW: sk.halfW, clock: +(sk.clock || 0).toFixed(2), deficits: sk.lastD || null, stall: sk.stall || null };
      },
      sitRest: (role) => {
        const f = a.figures?.[role];
        const st = f?.settling;
        if (!st) return null;
        const p3 = (v) => (v ? { x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) } : null);
        return {
          restingOn: st.restingOn || null,
          handSurface: st.handSurface
            ? { l: +st.handSurface.l.toFixed(3), r: +st.handSurface.r.toFixed(3) } : null,
          palmPass: st.palmPass || 0,
          target: { l: p3(st.hands?.l), r: p3(st.hands?.r) },
          probe: { l: st.hands?.l?.probe || null, r: st.hands?.r?.probe || null },
        };
      },

      // Does raycasting against this body work AT ALL? Every surface
      // measurement in the sit rests on it, and every one of them fails
      // SILENTLY to a fallback constant, so a blanket failure looks exactly
      // like a body that happens to match my guesses.
      rayTest: (role) => {
        const f = a.figures?.[role];
        if (!f?.model) return null;
        let meshes = 0, skinned = 0;
        f.model.traverse((o) => { if (o.isMesh) meshes++; if (o.isSkinnedMesh) skinned++; });
        const hip = f.group.getObjectByName("l_thigh");
        if (!hip) return { meshes, skinned, err: "no l_thigh" };
        const at = hip.getWorldPosition(new THREE.Vector3());
        const shoot = (from, dir, far) => {
          const rc = new THREE.Raycaster(from, dir, 0, far);
          const hits = rc.intersectObject(f.model, true);
          return { n: hits.length, first: hits.length ? +hits[0].point.y.toFixed(3) : null };
        };
        return {
          meshes, skinned,
          boneY: +at.y.toFixed(3),
          up: shoot(new THREE.Vector3(at.x, at.y - 0.25, at.z), new THREE.Vector3(0, 1, 0), 0.25),
          down: shoot(new THREE.Vector3(at.x, at.y + 0.25, at.z), new THREE.Vector3(0, -1, 0), 0.25),
          upFar: shoot(new THREE.Vector3(at.x, at.y - 1.2, at.z), new THREE.Vector3(0, 1, 0), 1.2),
        };
      },

      // Why does the limb query see nothing? Report the raw skinning data of
      // the first few meshes: attribute presence, bone-name samples, and how
      // many vertices reference the named bone at any weight at all.
      limbTest: (role, boneName) => {
        const f = a.figures?.[role];
        if (!f?.model) return null;
        const out = [];
        f.model.traverse((mesh) => {
          if (!mesh.isSkinnedMesh || out.length >= 24) return;
          const geo = mesh.geometry;
          const si = geo?.attributes?.skinIndex, sw = geo?.attributes?.skinWeight;
          const bones = mesh.skeleton?.bones || [];
          const idx = bones.findIndex((b) => b.name === boneName);
          let refs = 0, weighted = 0, maxW = 0;
          if (si && sw && idx >= 0) {
            for (let i = 0; i < si.count; i++) {
              for (let k = 0; k < 4; k++) {
                if (si.getComponent(i, k) === idx) {
                  const w = sw.getComponent(i, k);
                  if (w > 0.001) refs++;
                  if (w >= 0.35) weighted++;
                  if (w > maxW) maxW = w;
                }
              }
            }
          }
          out.push({
            name: mesh.name || "(unnamed)", verts: si ? si.count : null,
            hasSkinIndex: !!si, hasSkinWeight: !!sw,
            attrs: Object.keys(geo?.attributes || {}),
            nBones: bones.length, boneIdx: idx,
            boneSample: bones.slice(0, 4).map((b) => b.name),
            refs, weighted, maxW: +maxW.toFixed(3), skel: mesh.skeleton ? mesh.skeleton.uuid.slice(0, 4) : null,
            applyBT: typeof mesh.applyBoneTransform,
          });
        });
        return out;
      },

      // Told when the furniture changes, because placement happens in here.
      onProps: (fn) => { a.onProps = fn; return true; },
      props: () => (a.obstacles || []).filter(o => o.type),
      clearProps: () => { a.endPlacing?.(); a.setObstacles?.([]); a.onProps?.([]); return []; },
      obstacles: () => a.obstacles || [],

      // The runner hands back the performer object it was given, so resolve it
      // to the figure it stands for.
      reset() {
        // Personal space is script state, not room state: a run from the top
        // must not inherit what the last run's `space` steps set, or the second
        // playthrough of a scene quietly differs from the first.
        a.space = {};
        for (const role of Object.keys(a.figures || {})) {
          // ...and neither is a POSTURE. A held pose is meant to survive until
          // something moves her, and a re-run was not counted as something: the
          // second play began with her still folded into the previous sit, so
          // she stood at her mark in the shape of a chair, in mid-air.
          const f = a.figures[role];
          releasePose(f);
          f.seatedOn = null;
          f.seatedY = 0;
          f.group.position.y = 0;
          const fig = a.figures[role];
          fig.walk?.resolve?.(); fig.walk = null;
          fig.turn?.resolve?.(); fig.turn = null;
          fig.pose?.resolve?.(); fig.pose = null;
          fig.group.position.set(fig.home.x, 0, fig.home.z);
          fig.group.rotation.y = fig.home.ry;
          if (fig.clips.idle) playClip(fig, "idle", { loop: true, fade: 0.2 });
        }
      },
      stopAll() {
        for (const role of Object.keys(a.figures || {})) {
          const fig = a.figures[role];
          fig.walk?.resolve?.(); fig.walk = null;
          fig.turn?.resolve?.(); fig.turn = null;
          fig.pose?.resolve?.(); releasePose(fig);
          // Stopping mid-sit leaves her seated on nothing otherwise.
          if (fig.seatedOn) { fig.seatedOn = null; fig.seatedY = 0; fig.group.position.y = 0; }
          if (fig.clips.idle) playClip(fig, "idle", { loop: true, fade: 0.3 });
        }
      },
      state() {
        return Object.fromEntries(Object.entries(a.figures || {}).map(([role, fig]) => [role, {
          name: fig.person?.name,
          at: { x: +fig.group.position.x.toFixed(2), z: +fig.group.position.z.toFixed(2) },
          facing: +fig.group.rotation.y.toFixed(2),
          clip: Object.keys(fig.actions).find(n => fig.actions[n] === fig.current) || null,
          clips: Object.keys(fig.clips),
        }]));
      },
    };
    function otherFig(performer) {
      // performer objects are built fresh on every call, so identity
      // comparison is out — the role they carry is what identifies them.
      return a.figures?.[performer?.role] || null;
    }
    // The follow loop re-runs the SAME shot code, not a copy of it. A second
    // implementation that only ran per-frame would be free to drift from the
    // one that ran on the cut, and the drift would look like a camera bug.
    a.reframe = (spec) => rig.camera(spec);
    a.rig = rig;
    onRig?.(rig);
  }

  const busy = Object.keys(loading).filter(r => typeof loading[r] === "number");

  return (
    <div ref={host} style={{ position: "relative", width: "100%", height: "100%",
                             background: "#14120f", overflow: "hidden" }}>
      {busy.length > 0 && (
        <div style={{ position: "absolute", left: 14, bottom: 12, zIndex: 3, display: "flex", gap: 14 }}>
          {busy.map(r => (
            <span key={r} style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase",
                                   color: `rgba(201,151,58,.75)` }}>
              {cast?.[r]?.name || r} · {loading[r]}%
            </span>
          ))}
        </div>
      )}
      {Object.keys(failed).filter(r => failed[r]).map((r, i) => (
        <div key={r} style={{ position: "absolute", left: 14, top: 12 + (r === "b" ? 22 : 0), zIndex: 3,
                              fontSize: 10.5, color: "rgba(216,90,48,.9)" }}>
          {cast?.[r]?.name || r} did not load — {failed[r]}
        </div>
      ))}
    </div>
  );
}
