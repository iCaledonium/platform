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

export const ROLE_COLOR = { a: 0xc9973a, b: 0x378add };

export default function InteractionStudioScene({ cast, onRig, onStatus }) {
  const host = useRef(null);
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

    const onPlaceMove = (ev) => {
      const a = api.current;
      if (!a.placing) return;
      const p = floorPoint(ev);
      if (!p) return;
      a.placing.at = p;
      a.placing.ghost.position.set(p.x, 0, p.z);
      a.placing.ghost.rotation.y = a.placing.yaw;
    };

    const onPlaceClick = (ev) => {
      const a = api.current;
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
      const prop = { id: Math.random().toString(36).slice(2, 9), type: a.placing.type,
                     x: +p.x.toFixed(3), z: +p.z.toFixed(3), yaw: +a.placing.yaw.toFixed(4) };
      a.setObstacles([...(a.obstacles || []), prop]);
      a.endPlacing?.();
      a.onProps?.(a.obstacles);
    };

    const onPlaceKey = (ev) => {
      const a = api.current;
      if (!a.placing) return;
      if (ev.key === "Escape") a.endPlacing?.();
      if (ev.key.toLowerCase() === "r") {
        // Fine by default, quarter-turns with shift — you usually want a chair
        // askew by a little, and square to the room occasionally.
        const step = ev.shiftKey ? Math.PI / 2 : Math.PI / 12;
        a.placing.yaw = (a.placing.yaw + step) % (Math.PI * 2);
        a.placing.ghost.rotation.y = a.placing.yaw;
        onPlaceMove({ clientX: a.placing.lastX, clientY: a.placing.lastY });
      }
    };

    renderer.domElement.addEventListener("pointermove", (e) => {
      const a = api.current;
      if (a.placing) { a.placing.lastX = e.clientX; a.placing.lastY = e.clientY; }
      onPlaceMove(e);
    });
    renderer.domElement.addEventListener("pointerdown", onPlaceClick, true);
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
                    beginPlacing: (type) => {
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
                      ghost.position.set(0, 0, 0);
                      scene.add(ghost);
                      a.placing = { type, yaw: 0, ghost, at: null, lastX: 0, lastY: 0 };
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
    for (const role of ["a", "b"]) {
      const want = cast?.[role]?.glb_url || null;
      const have = api.current.figures?.[role];
      if (have?.url === want) continue;
      if (have) removeFigure(role);
      if (want) loadFigure(role, cast[role]);
    }
  }, [cast?.a?.id, cast?.b?.id, cast?.a?.glb_url, cast?.b?.glb_url]);   // eslint-disable-line react-hooks/exhaustive-deps

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

  async function loadFigure(role, person) {
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
      group.add(buildMark(ROLE_COLOR[role]));
      const mark = MARKS[role];
      group.position.set(mark.x, 0, mark.z);
      // Facing the other mark to begin with: two people put in a room back to
      // back is a bug report waiting to happen.
      group.rotation.y = Math.atan2(MARKS[role === "a" ? "b" : "a"].x - mark.x,
                                    MARKS[role === "a" ? "b" : "a"].z - mark.z);
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
      if (idleName) playClip(fig, idleName, { loop: true, fade: 0 });

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

  function walkTo(fig, x, z, { speed = 0.95 } = {}) {
    return new Promise((resolve) => {
      // A second walk order replaces the first rather than queueing behind it:
      // whoever asked last is who you are watching.
      fig.walk?.resolve?.();
      const back = fig.current;
      if (fig.clips.walk) playClip(fig, "walk", { loop: true, fade: 0.35 });

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
        if (idleName) playClip(fig, idleName, { loop: true, fade: 0.4 });
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
  function releasePose(fig) {
    const p = fig.pose;
    fig.pose = null;
    if (!p?.tracks || !fig.rest) return;
    for (const tr of p.tracks) {
      const bone = p.bones?.get(tr.rigBone);
      const rest = fig.rest.get(tr.rigBone);
      if (bone && rest) bone.quaternion.copy(rest);
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
      for (const tr of p.tracks) {
        const bone = p.bones.get(tr.rigBone);
        if (!bone) continue;
        // Rest first; only fall back to the live rotation if this body somehow
        // has no rest recorded, because that path bakes in a stride.
        const rest = fig.rest?.get(tr.rigBone);
        p.base.set(tr.rigBone, (rest || bone.quaternion).clone());
      }
    }
    for (const tr of p.tracks) {
      const bone = p.bones.get(tr.rigBone);
      if (!bone) continue;
      const base = p.base.get(tr.rigBone);
      if (!base) continue;
      const [rx, ry, rz] = sampleTrack(tr, p.t);
      _e.set(rx * DEG, ry * DEG, rz * DEG);
      _q.setFromEuler(_e);
      bone.quaternion.copy(base).multiply(_q);
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
        hold: def.kind === "pose" && def.hold !== false,
        aim: def.aim || null, otherFig: otherFig || null,
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

  function keepApart(a, delta) {
    const fa = a.figures?.a, fb = a.figures?.b;
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
    if ((space.a || 0) > d) give(fa, -1);
    if ((space.b || 0) > d) give(fb, 1);
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
  function solveArm(fig, target, weight) {
    if (!(weight > 0.001) || !target) return;
    const chain = ["r_upperarm", "r_forearm"].map(n => fig.group.getObjectByName(n));
    const hand = fig.group.getObjectByName("r_hand");
    if (!hand || chain.some(b => !b)) return;

    // Remember the authored pose so the correction can be BLENDED in rather
    // than replacing it — off the contact frame the authored motion is what
    // you see, and at contact the aim wins.
    const before = chain.map(b => b.quaternion.clone());

    for (let iter = 0; iter < 5; iter++) {
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
  function stepSitting(fig, delta) {
    const st = fig.sitting;
    if (!st) return;
    st.t = Math.min(st.dur, st.t + delta);
    const u = st.dur > 0 ? st.t / st.dur : 1;
    const e = u * u * (3 - 2 * u);

    fig.group.position.x = st.from.x + (st.to.x - st.from.x) * e;
    fig.group.position.z = st.from.z + (st.to.z - st.from.z) * e;

    // Two constraints, and which one rules changes as she lowers.
    //
    // On the way down her FEET are what she is standing on, so they stay on the
    // floor — that is what stops the jump. At the end the SEAT is what she is
    // resting on, so the thigh has to meet it, or she hovers just above the
    // chair in a sitting shape. Holding only the first left her 6cm off it.
    //
    // Blended over the last fifth of the movement so the handover is a settle,
    // not a step.
    const seatY = st.seat != null ? seatHeightFor(fig, st.seat) : null;
    const footY = footHeightFor(fig, st.floorAnkle);
    if (seatY == null || footY == null) {
      if (footY != null) fig.group.position.y = footY;
    } else {
      const k = Math.max(0, Math.min(1, (e - 0.8) / 0.2));
      // Never below the feet. If resting on the seat would drive them through
      // the floor, the floor wins — a body cannot sink into it, and the honest
      // consequence is that she perches rather than sits back, which is at
      // least a thing a person does.
      fig.group.position.y = Math.max(footY + (seatY - footY) * k, footY);
    }

    if (st.t >= st.dur) {
      fig.sitting = null;
      if (st.propId) {
        fig.seatedOn = st.propId;
        fig.seatedY = fig.group.position.y;
        // Kept so standing up can hold the same floor on the way back.
        fig.seatedFloorAnkle = st.floorAnkle;
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
  function seatHeightFor(fig, surface) {
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
            const approachFrom = { x: prop.x + Math.sin(facing) * 0.55,
                                   z: prop.z + Math.cos(facing) * 0.55 };
            return walkTo(fig, approachFrom.x, approachFrom.z, { speed: 1.0 })
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
                    from: { x: fig.group.position.x, z: fig.group.position.z },
                    // Hips finish over the seat, not over where she stood.
                    to: { x: prop.x, z: prop.z },
                  };
                });
                playMotion(fig, "sit");
                return seated;
              });
          },

          standUp: () => {
            if (!fig.seatedOn) return Promise.resolve({ notSeated: true });
            // Rising is the same movement backwards: the pose releases and the
            // feet stay planted on the way up, so she pushes off the seat
            // instead of popping back to standing height.
            fig.seatedOn = null;
            releasePose(fig);
            const here = { x: fig.group.position.x, z: fig.group.position.z };
            return new Promise((resolve) => {
              // Standing: no seat constraint any more, so the feet rule all
              // the way up.
              fig.sitting = { t: 0, dur: 0.4, propId: null, seat: null,
                              floorAnkle: fig.seatedFloorAnkle ?? null,
                              done: () => { fig.seatedY = 0; resolve(true); },
                              from: here, to: here };
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
        if (!a.space) a.space = { a: 0, b: 0 };
        if (role !== "a" && role !== "b") return false;
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
      cancelProp: () => a.endPlacing?.(),
      // What is waiting to be put down, so the UI can stop looking armed when
      // the scene has already ended placement (a drop, or Escape).
      placingType: () => a.placing?.type || null,
      // Debug: the measured sole offset and current root height, because
      // guessing at these has cost several rounds.
      footInfo: (role) => {
        const f = a.figures?.[role];
        if (!f) return null;
        return { sole: f.sole, rootY: +f.group.position.y.toFixed(3), seatedOn: f.seatedOn || null };
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
        a.space = { a: 0, b: 0 };
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

  const busy = ["a", "b"].filter(r => typeof loading[r] === "number");

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
      {["a", "b"].filter(r => failed[r]).map(r => (
        <div key={r} style={{ position: "absolute", left: 14, top: 12 + (r === "b" ? 22 : 0), zIndex: 3,
                              fontSize: 10.5, color: "rgba(216,90,48,.9)" }}>
          {cast?.[r]?.name || r} did not load — {failed[r]}
        </div>
      ))}
    </div>
  );
}
