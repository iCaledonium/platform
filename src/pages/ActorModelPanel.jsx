// ActorModelPanel.jsx
// 3D character test harness for the actor editor.
//
// Loads a rigged biped (.vrm) and plays animations on it. Mixamo .fbx clips are
// retargeted onto the VRM humanoid rig at load time — that retarget is the whole
// experiment. If arbitrary Mixamo clips play correctly on an arbitrary VRM, one
// animation library serves every actor and the per-actor video library dies.
//
// Standalone: no imports from PresenceView, no backend, no DB. Models and clips
// are read from local disk. Persistence comes after the rig question is settled.
//
// Deps: three, @pixiv/three-vrm  (FBXLoader ships inside three)

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

// The bones that must resolve for retargeting to be viable at all.
const REQUIRED_BONES = [
  "hips", "spine", "chest", "neck", "head",
  "leftUpperArm", "leftLowerArm", "leftHand",
  "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperLeg", "leftLowerLeg", "leftFoot",
  "rightUpperLeg", "rightLowerLeg", "rightFoot",
];

// Mixamo rig name -> candidate VRM humanoid bone names.
// Candidates are tried in order: VRM 1.0 naming first, VRM 0.x fallback second
// (the two specs diverge on thumbs).
const MIXAMO_TO_VRM = {
  mixamorigHips: ["hips"],
  mixamorigSpine: ["spine"],
  mixamorigSpine1: ["chest"],
  mixamorigSpine2: ["upperChest"],
  mixamorigNeck: ["neck"],
  mixamorigHead: ["head"],

  mixamorigLeftShoulder: ["leftShoulder"],
  mixamorigLeftArm: ["leftUpperArm"],
  mixamorigLeftForeArm: ["leftLowerArm"],
  mixamorigLeftHand: ["leftHand"],
  mixamorigLeftHandThumb1: ["leftThumbMetacarpal", "leftThumbProximal"],
  mixamorigLeftHandThumb2: ["leftThumbProximal", "leftThumbIntermediate"],
  mixamorigLeftHandThumb3: ["leftThumbDistal"],
  mixamorigLeftHandIndex1: ["leftIndexProximal"],
  mixamorigLeftHandIndex2: ["leftIndexIntermediate"],
  mixamorigLeftHandIndex3: ["leftIndexDistal"],
  mixamorigLeftHandMiddle1: ["leftMiddleProximal"],
  mixamorigLeftHandMiddle2: ["leftMiddleIntermediate"],
  mixamorigLeftHandMiddle3: ["leftMiddleDistal"],
  mixamorigLeftHandRing1: ["leftRingProximal"],
  mixamorigLeftHandRing2: ["leftRingIntermediate"],
  mixamorigLeftHandRing3: ["leftRingDistal"],
  mixamorigLeftHandPinky1: ["leftLittleProximal"],
  mixamorigLeftHandPinky2: ["leftLittleIntermediate"],
  mixamorigLeftHandPinky3: ["leftLittleDistal"],

  mixamorigRightShoulder: ["rightShoulder"],
  mixamorigRightArm: ["rightUpperArm"],
  mixamorigRightForeArm: ["rightLowerArm"],
  mixamorigRightHand: ["rightHand"],
  mixamorigRightHandThumb1: ["rightThumbMetacarpal", "rightThumbProximal"],
  mixamorigRightHandThumb2: ["rightThumbProximal", "rightThumbIntermediate"],
  mixamorigRightHandThumb3: ["rightThumbDistal"],
  mixamorigRightHandIndex1: ["rightIndexProximal"],
  mixamorigRightHandIndex2: ["rightIndexIntermediate"],
  mixamorigRightHandIndex3: ["rightIndexDistal"],
  mixamorigRightHandMiddle1: ["rightMiddleProximal"],
  mixamorigRightHandMiddle2: ["rightMiddleIntermediate"],
  mixamorigRightHandMiddle3: ["rightMiddleDistal"],
  mixamorigRightHandRing1: ["rightRingProximal"],
  mixamorigRightHandRing2: ["rightRingIntermediate"],
  mixamorigRightHandRing3: ["rightRingDistal"],
  mixamorigRightHandPinky1: ["rightLittleProximal"],
  mixamorigRightHandPinky2: ["rightLittleIntermediate"],
  mixamorigRightHandPinky3: ["rightLittleDistal"],

  mixamorigLeftUpLeg: ["leftUpperLeg"],
  mixamorigLeftLeg: ["leftLowerLeg"],
  mixamorigLeftFoot: ["leftFoot"],
  mixamorigLeftToeBase: ["leftToes"],

  mixamorigRightUpLeg: ["rightUpperLeg"],
  mixamorigRightLeg: ["rightLowerLeg"],
  mixamorigRightFoot: ["rightFoot"],
  mixamorigRightToeBase: ["rightToes"],
};

function resolveBoneNode(humanoid, candidates) {
  for (const name of candidates) {
    const node = humanoid.getNormalizedBoneNode(name);
    if (node) return node;
  }
  return null;
}

/**
 * Convert a Mixamo FBX clip into an AnimationClip targeting the VRM's
 * normalized humanoid bones.
 *
 * Mixamo and VRM disagree on rest pose, units (cm vs m) and — for VRM 0.x —
 * forward axis. Each rotation track is rebased through the source rig's rest
 * rotation before being renamed onto the target bone.
 *
 * Returns { clip, mapped, sourceTracks, skipped } so the caller can report how
 * much of the animation actually survived the transfer.
 */
function retargetMixamoClip(asset, vrm, clipName, source) {
  const humanoid = vrm.humanoid;
  if (!humanoid) throw new Error("target model has no VRM humanoid rig");

  const tracks = [];
  let mapped = 0;
  const skipped = new Set();

  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const scratchQuat = new THREE.Quaternion();
  const scratchVec = new THREE.Vector3();

  const isVrm0 = vrm.meta?.metaVersion === "0";

  // Mixamo exports in centimetres against its own skeleton — rescale hip travel.
  const motionHips = asset.getObjectByName("mixamorigHips");
  if (!motionHips) {
    throw new Error("not a Mixamo rig — no mixamorigHips node");
  }

  const motionHipsHeight = motionHips.position.y;
  const vrmHipsY = resolveBoneNode(humanoid, ["hips"]).getWorldPosition(scratchVec).y;
  const vrmRootY = vrm.scene.getWorldPosition(scratchVec).y;
  const hipsPositionScale = Math.abs(vrmHipsY - vrmRootY) / motionHipsHeight;

  for (const track of source.tracks) {
    const [mixamoRigName, propertyName] = track.name.split(".");
    const candidates = MIXAMO_TO_VRM[mixamoRigName];

    if (!candidates) {
      skipped.add(mixamoRigName);
      continue;
    }

    const targetNode = resolveBoneNode(humanoid, candidates);
    const sourceNode = asset.getObjectByName(mixamoRigName);

    if (!targetNode || !sourceNode) {
      skipped.add(mixamoRigName);
      continue;
    }

    sourceNode.getWorldQuaternion(restRotationInverse).invert();
    if (sourceNode.parent) {
      sourceNode.parent.getWorldQuaternion(parentRestWorldRotation);
    } else {
      parentRestWorldRotation.identity();
    }

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const values = Array.from(track.values);

      for (let i = 0; i < values.length; i += 4) {
        scratchQuat
          .fromArray(values, i)
          .premultiply(parentRestWorldRotation)
          .multiply(restRotationInverse);
        scratchQuat.toArray(values, i);
      }

      // VRM 0.x faces +Z: mirror the x and z components.
      const finalValues = isVrm0
        ? values.map((v, i) => (i % 2 === 0 ? -v : v))
        : values;

      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${targetNode.name}.${propertyName}`,
          Array.from(track.times),
          finalValues
        )
      );
      mapped += 1;
    } else if (track instanceof THREE.VectorKeyframeTrack) {
      const values = Array.from(track.values).map((v, i) => {
        const mirrored = isVrm0 && i % 3 !== 1 ? -v : v;
        return mirrored * hipsPositionScale;
      });

      tracks.push(
        new THREE.VectorKeyframeTrack(
          `${targetNode.name}.${propertyName}`,
          Array.from(track.times),
          values
        )
      );
      mapped += 1;
    } else {
      skipped.add(mixamoRigName);
    }
  }

  if (tracks.length === 0) {
    throw new Error("no tracks could be mapped onto the target rig");
  }

  const dropped = tracks.filter((t) => t.name.endsWith(".scale")).length;
  const kept = tracks.filter((t) => !t.name.endsWith(".scale"));

  return {
    clip: new THREE.AnimationClip(clipName, source.duration, kept),
    mapped,
    sourceTracks: source.tracks.length,
    skipped: [...skipped],
    droppedScale: dropped,
  };
}

/**
 * Bind an FBX clip straight onto an FBX model with no retargeting.
 *
 * Valid only when clip and model share a skeleton — true for Mixamo character +
 * Mixamo animation. Counts how many track targets actually exist on the model so
 * a silent skeleton mismatch shows up as a number rather than a still figure.
 */
function bindDirectClip(root, clipName, source) {
  let mapped = 0;
  for (const track of source.tracks) {
    if (root.getObjectByName(track.name.split(".")[0])) mapped += 1;
  }

  if (mapped === 0) {
    throw new Error("no track targets exist on this model — different skeleton");
  }

  const clip = source.clone();
  clip.name = clipName;

  // Drop scale tracks. A walk cycle has no business resizing anyone, and an
  // exporter that bakes them in will fight the normalisation that puts her at
  // 1.7m — she grows the moment the clip plays and snaps back on idle.
  const scaled = clip.tracks.filter((t) => t.name.endsWith(".scale"));
  if (scaled.length) {
    clip.tracks = clip.tracks.filter((t) => !t.name.endsWith(".scale"));
  }

  return {
    clip,
    mapped,
    sourceTracks: source.tracks.length,
    skipped: [],
    droppedScale: scaled.length,
  };
}

// Everything below assumes metres. Source models arrive in whatever units the
// generator felt like, so the character is normalised to TARGET_HEIGHT on load
// and the room is built around that.
const TARGET_HEIGHT = 1.7;
const ROOM = 12;         // floor is ROOM x ROOM, metres
const WALL_H = 2.8;
const UP = new THREE.Vector3(0, 1, 0);
const EYE_HEIGHT = 1.65;
const PLAYER_SPEED = 1.5;   // m/s, a shade faster than her walk
const BODY_RADIUS = 0.32;   // how close either of you may get to a wall
const PROBE_EVERY = 70;     // ms between wall probes — raycasts are not cheap
// 30° is a portrait lens: correct proportions, but it flattens depth and makes
// anything near the camera loom. First person wants something close to human
// central vision.
const FOV_ORBIT = 35;
const FOV_FPV = 70;

function buildRoom() {
  const room = new THREE.Group();

  // A plain floor gives the eye nothing to measure motion against, so the
  // boards run in one direction and read as travel.
  const floorTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    g.fillStyle = "#6b5a48";
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? "#61513f" : "#725f4b";
      g.fillRect(0, i * 32, 256, 31);
    }
    g.strokeStyle = "rgba(0,0,0,.18)";
    g.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      g.beginPath(); g.moveTo(0, i * 32); g.lineTo(256, i * 32); g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(ROOM / 2, ROOM / 2);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM, ROOM),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  room.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xcfc7bb,
    roughness: 0.95,
    side: THREE.DoubleSide,
  });

  // Three walls only — the fourth is left open so an orbiting camera can see in.
  const specs = [
    { w: ROOM, x: 0, z: -ROOM / 2, ry: 0 },
    { w: ROOM, x: -ROOM / 2, z: 0, ry: Math.PI / 2 },
    { w: ROOM, x: ROOM / 2, z: 0, ry: -Math.PI / 2 },
  ];
  for (const sp of specs) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(sp.w, WALL_H), wallMat);
    wall.position.set(sp.x, WALL_H / 2, sp.z);
    wall.rotation.y = sp.ry;
    wall.receiveShadow = true;
    room.add(wall);
  }

  return room;
}

/**
 * Scale a freshly loaded model to TARGET_HEIGHT, stand it on y=0 and centre it
 * on the origin. Returns what it measured so the panel can show the inference
 * rather than hiding it.
 */
function normaliseToFloor(root) {
  const first = new THREE.Box3().setFromObject(root);
  const rawHeight = first.getSize(new THREE.Vector3()).y;
  const scale = rawHeight > 0 ? TARGET_HEIGHT / rawHeight : 1;

  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(root);
  root.position.y -= box.min.y;
  root.position.x -= (box.min.x + box.max.x) / 2;
  root.position.z -= (box.min.z + box.max.z) / 2;

  return { rawHeight, scale };
}

// Clip names come from whoever authored them ("Idle_11", "Walking_Woman").
// Match on substring and show the result in the UI so a wrong guess is visible.
/**
 * Measure skin weight sums per vertex.
 *
 * glTF carries four bone influences per vertex in JOINTS_0/WEIGHTS_0. A rig
 * needing more writes JOINTS_1, which three.js does not read — so those vertices
 * arrive with weights summing to less than 1 and the mesh pulls toward the
 * origin. Blender reads every set, which is why the same file looks correct
 * there. A sum below 1 is proof; renormalising redistributes what survived.
 */
function surveySkinning(root) {
  let meshes = 0;
  let bones = 0;
  let verts = 0;
  let short = 0;
  let minSum = Infinity;
  let maxSum = 0;

  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    meshes += 1;
    bones = Math.max(bones, o.skeleton?.bones?.length ?? 0);
    const w = o.geometry?.attributes?.skinWeight;
    if (!w) return;
    for (let i = 0; i < w.count; i++) {
      const sum = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i);
      verts += 1;
      if (sum < 0.995) short += 1;
      if (sum < minSum) minSum = sum;
      if (sum > maxSum) maxSum = sum;
    }
  });

  return {
    meshes,
    bones,
    verts,
    short,
    minSum: minSum === Infinity ? 1 : minSum,
    maxSum,
  };
}

function surveyMaterials(root) {
  const mats = new Set();
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m) mats.add(m);
    }
  });

  let minR = 1, maxR = 0, minM = 1, maxM = 0, textured = 0;
  const maps = { normal: 0, roughness: 0, metalness: 0, ao: 0, emissive: 0 };
  for (const m of mats) {
    if (m.normalMap) maps.normal += 1;
    if (m.roughnessMap) maps.roughness += 1;
    if (m.metalnessMap) maps.metalness += 1;
    if (m.aoMap) maps.ao += 1;
    if (m.emissiveMap) maps.emissive += 1;
    if (typeof m.roughness === "number") {
      minR = Math.min(minR, m.roughness);
      maxR = Math.max(maxR, m.roughness);
    }
    if (typeof m.metalness === "number") {
      minM = Math.min(minM, m.metalness);
      maxM = Math.max(maxM, m.metalness);
    }
    if (m.map) textured += 1;
  }
  // A metalness *map* means the scalar is only a multiplier, so a reading of
  // 1.00 is normal and must not be treated as the broken-export case.
  return {
    count: mats.size,
    minR, maxR, minM, maxM, textured, maps,
    mapped: maps.normal + maps.roughness + maps.metalness > 0,
    list: [...mats],
  };
}

function detectRoles(names) {
  const find = (re) => names.find((n) => re.test(n)) ?? null;
  return {
    idle: find(/idle|stand/i),
    walk: find(/walk/i),
    run: find(/run|jog|sprint/i),
  };
}

export default function ActorModelPanel({ actorId }) {
  const mountRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const vrmRef = useRef(null);
  const rootRef = useRef(null);
  const holderRef = useRef(null);
  const roomRef = useRef(null);
  const proceduralRoomRef = useRef(null);
  const fpvControlsRef = useRef(null);
  const fpvRef = useRef(false);
  // Where she has decided to go, and when she will next feel like moving.
  const wanderRef = useRef({ target: null, waitUntil: 0 });
  const floorYRef = useRef(0);
  const raycasterRef = useRef(new THREE.Raycaster());
  const rulerRef = useRef(null);
  // Where her feet actually end up in world space, measured rather than assumed.
  const feetYRef = useRef(0);
  // Wall distances on the four axes, refreshed on a timer rather than every
  // frame. A 315k-triangle room is far too much geometry to raycast at 60Hz.
  const probeActorRef = useRef({ at: 0, d: null });
  const probePlayerRef = useRef({ at: 0, d: null });
  // Walk limits come from whatever room is loaded, procedural or real.
  const boundsRef = useRef({ minX: -ROOM / 2, maxX: ROOM / 2, minZ: -ROOM / 2, maxZ: ROOM / 2 });
  const keysRef = useRef(new Set());
  const walkRef = useRef({ on: false, speed: 1.35, roles: null, current: null, flip: false });
  const matBackupRef = useRef(new Map());
  const skinBackupRef = useRef(new Map());
  const skeletonHelperRef = useRef(null);
  const showSkeletonRef = useRef(false);
  const mixerRef = useRef(null);
  const actionsRef = useRef(new Map());
  const currentActionRef = useRef(null);
  const frameRef = useRef(null);
  const clockRef = useRef(new THREE.Clock());
  const objectUrlsRef = useRef([]);

  const [report, setReport] = useState(null);
  const [clips, setClips] = useState([]);
  const [playing, setPlaying] = useState(null);
  const [loop, setLoop] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [fps, setFps] = useState(0);
  const [bgUrl, setBgUrl] = useState(null);
  const [expression, setExpression] = useState("");
  const [walkMode, setWalkMode] = useState(false);
  const [walkSpeed, setWalkSpeed] = useState(1.35);
  const [flipFacing, setFlipFacing] = useState(false);
  const [roles, setRoles] = useState(null);
  const [fitInfo, setFitInfo] = useState(null);
  const [matInfo, setMatInfo] = useState(null);
  const [shading, setShading] = useState("source");
  const [exposure, setExposure] = useState(1.0);
  const [wideFrame, setWideFrame] = useState(true);
  const [skinInfo, setSkinInfo] = useState(null);
  const [normalizeSkin, setNormalizeSkin] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [doubleSided, setDoubleSided] = useState(false);
  const [tint, setTint] = useState("#ffffff");
  const [roomInfo, setRoomInfo] = useState(null);
  const [fpv, setFpv] = useState(false);
  const [locked, setLocked] = useState(false);
  const [showRuler, setShowRuler] = useState(false);
  const [shadingAuto, setShadingAuto] = useState(false);

  function trackUrl(file) {
    const url = URL.createObjectURL(file);
    objectUrlsRef.current.push(url);
    return url;
  }

  // ---- scene setup (once) -------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      FOV_ORBIT,
      mount.clientWidth / mount.clientHeight,
      0.1,
      50
    );
    camera.position.set(0, 1.3, 3);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // glTF materials are authored against a filmic response curve. Without one,
    // anything approaching white clips to a hard specular — which is the plastic
    // sheen, not the texture.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.0, 0);
    controls.enableDamping = true;
    controls.update();
    controlsRef.current = controls;

    const fpvControls = new PointerLockControls(camera, renderer.domElement);
    fpvControls.addEventListener("lock", () => setLocked(true));
    fpvControls.addEventListener("unlock", () => setLocked(false));
    fpvControlsRef.current = fpvControls;

    // PBR expects an environment to reflect. Three point lights and nothing to
    // bounce off is why it read as vinyl — Blender always has a world.
    // RoomEnvironment is a neutral studio box, generated at runtime, no asset.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    pmrem.dispose();

    // With an environment carrying most of the load, direct lights only shape.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 0.25));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(1.5, 2.5, 2.0);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xaaccff, 0.3);
    rim.position.set(-2, 1.5, -2);
    scene.add(rim);

    const placeholder = buildRoom();
    scene.add(placeholder);
    proceduralRoomRef.current = placeholder;

    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      keysRef.current.add(e.code);
      if (e.code.startsWith("Arrow")) e.preventDefault();
    };
    const onKeyUp = (e) => keysRef.current.delete(e.code);
    // Switching tabs mid-keypress means the keyup never arrives and shift stays
    // held — which reads as her running when nothing is pressed.
    const onBlur = () => keysRef.current.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    let frames = 0;
    let acc = 0;

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      const delta = clockRef.current.getDelta();

      if (rulerRef.current?.visible && holderRef.current) {
        rulerRef.current.position.set(
          holderRef.current.position.x,
          feetYRef.current,
          holderRef.current.position.z
        );
      }

      stepPlayer(delta, camera);
      stepLocomotion(delta, camera, controls);

      if (mixerRef.current) mixerRef.current.update(delta);
      if (vrmRef.current) vrmRef.current.update(delta);
      controls.update();
      renderer.render(scene, camera);

      frames += 1;
      acc += delta;
      if (acc >= 1) {
        setFps(Math.round(frames / acc));
        frames = 0;
        acc = 0;
      }
    };
    animate();

    const onResize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      cancelAnimationFrame(frameRef.current);
      if (mixerRef.current) mixerRef.current.stopAllAction();
      if (rootRef.current) VRMUtils.deepDispose(rootRef.current);
      envRT.dispose();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
      objectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  // Renormalising is destructive to the attribute, so the originals are kept
  // and restored on toggle — the point is to see the difference, not trust it.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !skinInfo) return;
    const backup = skinBackupRef.current;

    root.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const attr = o.geometry?.attributes?.skinWeight;
      if (!attr) return;

      if (normalizeSkin) {
        if (!backup.has(attr)) backup.set(attr, attr.array.slice());
        o.normalizeSkinWeights();
      } else if (backup.has(attr)) {
        attr.array.set(backup.get(attr));
      }
      attr.needsUpdate = true;
    });
  }, [normalizeSkin, skinInfo]);

  // An unlit material still has a colour multiplier. Driving it from the room
  // gives time of day and lamp colour without fighting shading baked into the
  // texture — not physically correct, but it answers the only question that
  // matters here: does she change when the room does.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || shading !== "unlit") return;
    root.traverse((o) => {
      if (o.isMesh && o.userData.__swapMode === "unlit") {
        o.material.color.set(tint);
      }
    });
  }, [tint, shading, matInfo]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        if (m.userData.__origSide === undefined) m.userData.__origSide = m.side;
        m.side = doubleSided ? THREE.DoubleSide : m.userData.__origSide;
        m.needsUpdate = true;
      }
    });
  }, [doubleSided, shading, matInfo]);

  useEffect(() => {
    fpvRef.current = fpv;
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!controls || !camera) return;

    controls.enabled = !fpv;
    camera.fov = fpv ? FOV_FPV : FOV_ORBIT;
    camera.updateProjectionMatrix();

    if (fpv) {
      // Stand the player in a corner looking across the room, rather than
      // wherever the orbit camera happened to be.
      const b = boundsRef.current;
      const eye = floorYRef.current + EYE_HEIGHT;
      camera.position.set(b.minX + 0.6, eye, b.minZ + 0.6);
      camera.lookAt((b.minX + b.maxX) / 2, eye * 0.9, (b.minZ + b.maxZ) / 2);
      wanderRef.current = { target: null, waitUntil: 0 };
    } else {
      fpvControlsRef.current?.unlock();
      const b = boundsRef.current;
      controls.target.set(
        (b.minX + b.maxX) / 2,
        floorYRef.current + TARGET_HEIGHT * 0.6,
        (b.minZ + b.maxZ) / 2
      );
      controls.update();
    }
  }, [fpv]);

  useEffect(() => {
    showSkeletonRef.current = showSkeleton;
    if (skeletonHelperRef.current) skeletonHelperRef.current.visible = showSkeleton;
  }, [showSkeleton]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.toneMappingExposure = exposure;
  }, [exposure]);

  // Three honest readings of the same file rather than one "fixed" one.
  //   source — exactly what the exporter wrote
  //   lit    — metalness and emission neutralised so scene lighting reaches it
  //   unlit  — the texture as painted, which is what the exporter intended
  useEffect(() => {
    const root = rootRef.current;
    const mats = matInfo?.list;
    if (!root || !mats) return;
    const backup = matBackupRef.current;

    for (const m of mats) {
      if (!backup.has(m)) {
        backup.set(m, {
          metalness: m.metalness,
          roughness: m.roughness,
          emissiveIntensity: m.emissiveIntensity,
        });
      }
      const original = backup.get(m);
      if (shading === "lit") {
        m.metalness = 0;
        m.roughness = original.roughness ?? 0.8;
        m.emissiveIntensity = 0;
      } else {
        m.metalness = original.metalness;
        m.roughness = original.roughness;
        m.emissiveIntensity = original.emissiveIntensity;
      }
      m.needsUpdate = true;
    }

    // Unlit and normals need a different material type, not different values.
    // MeshNormalMaterial paints each fragment by its normal direction — an
    // inverted or degenerate normal shows as the wrong colour against its
    // neighbours, which is exactly what shades black under a real light.
    root.traverse((o) => {
      if (!o.isMesh) return;
      const want =
        shading === "unlit" ? "unlit" : shading === "normals" ? "normals" : null;
      const current = o.userData.__swapMode ?? null;
      if (current === want) return;

      if (current) {
        o.material.dispose?.();
        o.material = o.userData.__origMaterial;
        delete o.userData.__origMaterial;
        delete o.userData.__swapMode;
      }

      if (want) {
        o.userData.__origMaterial = o.material;
        const src = Array.isArray(o.material) ? o.material[0] : o.material;
        o.material =
          want === "unlit"
            ? new THREE.MeshBasicMaterial({
                map: src?.map ?? null,
                color: new THREE.Color(tint),
                transparent: src?.transparent ?? false,
                alphaTest: src?.alphaTest ?? 0,
              })
            : new THREE.MeshNormalMaterial();
        o.userData.__swapMode = want;
      }
    });
  }, [shading, matInfo]);

  useEffect(() => {
    walkRef.current.on = walkMode;
    walkRef.current.speed = walkSpeed;
    walkRef.current.roles = roles;
    walkRef.current.flip = flipFacing;
    // Force the state machine to re-evaluate, so switching the walk clip while
    // she is mid-stride swaps immediately instead of at the next stop.
    walkRef.current.current = null;
  }, [walkMode, walkSpeed, roles, flipFacing]);

  // ---- locomotion ---------------------------------------------------------
  // Clips are in-place — the walk cycle has no root motion baked in — so the
  // holder is driven in code and the cycle plays on top. Speed is exposed
  // because matching stride to travel is the difference between walking and
  // skating, and it's a per-clip number nobody can guess.
  function switchClip(name) {
    const action = actionsRef.current.get(name);
    if (!action) return;
    const previous = currentActionRef.current;
    if (previous === action) return;
    action.reset().setLoop(THREE.LoopRepeat, Infinity);
    if (previous) action.crossFadeFrom(previous, 0.18, false).play();
    else action.fadeIn(0.18).play();
    currentActionRef.current = action;
    setPlaying(name);
  }

  // Walking the player. Direction is taken from where the camera is looking,
  // so it behaves like any first-person control.
  function stepPlayer(delta, camera) {
    const fpvControls = fpvControlsRef.current;
    if (!fpvRef.current || !fpvControls?.isLocked) return;

    const keys = keysRef.current;
    let forward = 0;
    let strafe = 0;
    if (keys.has("KeyW") || keys.has("ArrowUp")) forward += 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) forward -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) strafe += 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) strafe -= 1;
    if (!forward && !strafe) return;

    const look = new THREE.Vector3();
    camera.getWorldDirection(look);
    look.y = 0;
    if (look.lengthSq() < 1e-6) return;
    look.normalize();
    const right = new THREE.Vector3().crossVectors(look, UP).normalize();

    const move = look.multiplyScalar(forward).add(right.multiplyScalar(strafe));
    if (move.lengthSq() < 1e-6) return;

    const running = keys.has("ShiftLeft") || keys.has("ShiftRight");
    move.normalize().multiplyScalar(PLAYER_SPEED * (running ? 2 : 1) * delta);

    const walls = probeWalls(
      probePlayerRef.current,
      camera.position,
      performance.now()
    );
    slide(move, walls);
    camera.position.add(move);

    const b = boundsRef.current;
    camera.position.x = Math.max(b.minX, Math.min(b.maxX, camera.position.x));
    camera.position.z = Math.max(b.minZ, Math.min(b.maxZ, camera.position.z));
    camera.position.y = floorYRef.current + EYE_HEIGHT;
  }

  /**
   * Her own movement, when nobody is driving her.
   *
   * A stand-in for the simulator feed: pick somewhere, walk there, stand for a
   * while, pick somewhere else. Crude, and enough to answer whether a person
   * moving around a room on her own reads as present.
   */
  function stepWander(delta, holder, st, now) {
    const w = wanderRef.current;

    if (!w.target) {
      if (now < w.waitUntil) return false;
      const b = boundsRef.current;
      w.target = new THREE.Vector3(
        b.minX + Math.random() * (b.maxX - b.minX),
        0,
        b.minZ + Math.random() * (b.maxZ - b.minZ)
      );
    }

    const to = new THREE.Vector3().subVectors(w.target, holder.position);
    to.y = 0;

    if (to.length() < 0.3) {
      w.target = null;
      w.waitUntil = now + 2000 + Math.random() * 6000;
      return false;
    }

    to.normalize();

    const step = to.clone().multiplyScalar(st.speed * delta);
    const walls = probeWalls(probeActorRef.current, holder.position, now);
    slide(step, walls);

    // Pressed against a wall with nowhere to slide — pick somewhere else
    // rather than grinding into it.
    if (step.lengthSq() < 1e-8) {
      w.target = null;
      w.waitUntil = now + 500;
      return false;
    }

    holder.position.add(step);

    const target = Math.atan2(to.x, to.z) + (st.flip ? Math.PI : 0);
    let diff = target - holder.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    holder.rotation.y += diff * Math.min(1, delta * 6);

    return true;
  }

  function stepLocomotion(delta, camera, controls) {
    const st = walkRef.current;
    const holder = holderRef.current;
    if (!st.on || !holder || !st.roles) return;

    // In first person the keyboard is yours, so she moves on her own.
    if (fpvRef.current) {
      const moving = stepWander(delta, holder, st, performance.now());
      const want = moving ? st.roles.walk ?? st.roles.idle : st.roles.idle;
      if (want && want !== st.current) {
        st.current = want;
        switchClip(want);
      }
      return;
    }

    const keys = keysRef.current;
    let forward = 0;
    let strafe = 0;
    if (keys.has("KeyW") || keys.has("ArrowUp")) forward += 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) forward -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) strafe += 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) strafe -= 1;

    const running = keys.has("ShiftLeft") || keys.has("ShiftRight");
    const moving = forward !== 0 || strafe !== 0;

    if (moving) {
      // Direction is camera-relative, so "forward" always means away from the
      // viewer no matter where they've orbited to.
      const f = new THREE.Vector3()
        .subVectors(holder.position, camera.position);
      f.y = 0;
      if (f.lengthSq() < 1e-6) f.set(0, 0, 1);
      f.normalize();
      const r = new THREE.Vector3().crossVectors(f, UP).normalize();

      const dir = f.multiplyScalar(forward).add(r.multiplyScalar(strafe));
      if (dir.lengthSq() > 1e-6) {
        dir.normalize();

        const speed = st.speed * (running && st.roles.run ? 2.4 : 1);
        const step = dir.clone().multiplyScalar(speed * delta);
        slide(
          step,
          probeWalls(probeActorRef.current, holder.position, performance.now())
        );
        holder.position.add(step);

        const b = boundsRef.current;
        holder.position.x = Math.max(b.minX, Math.min(b.maxX, holder.position.x));
        holder.position.z = Math.max(b.minZ, Math.min(b.maxZ, holder.position.z));

        // Turn toward travel by the shortest arc rather than snapping.
        const target = Math.atan2(dir.x, dir.z) + (st.flip ? Math.PI : 0);
        let diff = target - holder.rotation.y;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        holder.rotation.y += diff * Math.min(1, delta * 10);
      }
    }

    const want = moving
      ? (running && st.roles.run ? st.roles.run : st.roles.walk) ?? st.roles.idle
      : st.roles.idle ?? st.roles.walk;

    if (want && want !== st.current) {
      st.current = want;
      switchClip(want);
    }

    // The camera is left where the viewer put it — only what it looks at
    // follows her, so orbiting still works while she moves.
    if (fpvRef.current) return;

    const ease = 1 - Math.pow(0.0015, delta);
    controls.target.lerp(
      new THREE.Vector3(
        holder.position.x,
        floorYRef.current + TARGET_HEIGHT * 0.6,
        holder.position.z
      ),
      ease
    );
  }

  /**
   * Distance to the nearest wall along +x, -x, +z, -z from a position.
   *
   * Cached per caller so the player and the actor each get their own timer.
   * Crude compared with a real collider, and enough to stop either of you
   * walking through the bathroom.
   */
  function probeWalls(cache, position, now) {
    if (cache.d && now - cache.at < PROBE_EVERY) return cache.d;

    const room = roomRef.current;
    const open = { px: 99, nx: 99, pz: 99, nz: 99 };
    if (!room) {
      cache.at = now;
      cache.d = open;
      return open;
    }

    const ray = raycasterRef.current;
    ray.far = 2;
    const origin = new THREE.Vector3(
      position.x,
      floorYRef.current + 1.0,
      position.z
    );

    const axes = {
      px: new THREE.Vector3(1, 0, 0),
      nx: new THREE.Vector3(-1, 0, 0),
      pz: new THREE.Vector3(0, 0, 1),
      nz: new THREE.Vector3(0, 0, -1),
    };

    const out = {};
    for (const key of Object.keys(axes)) {
      ray.set(origin, axes[key]);
      const hits = ray.intersectObject(room, true);
      out[key] = hits.length ? hits[0].distance : 99;
    }

    cache.at = now;
    cache.d = out;
    return out;
  }

  // Zero out any component of a move that would push through a wall, leaving
  // the other axis free — so you slide along rather than stopping dead.
  function slide(move, walls) {
    if (move.x > 0 && walls.px < BODY_RADIUS) move.x = 0;
    if (move.x < 0 && walls.nx < BODY_RADIUS) move.x = 0;
    if (move.z > 0 && walls.pz < BODY_RADIUS) move.z = 0;
    if (move.z < 0 && walls.nz < BODY_RADIUS) move.z = 0;
    return move;
  }

  // A 1.7m post beside her. Nothing measures scale as reliably as putting a
  // known height next to the thing you are unsure about.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (!rulerRef.current) {
      const group = new THREE.Group();

      // Rings centred on her, not a post beside her. A post sits at a different
      // distance from the camera and therefore renders at a different size —
      // useless for judging height. A ring at her own position cannot lie:
      // her scalp is either above the 1.7m ring or below it, from any angle.
      const rings = [
        { y: TARGET_HEIGHT, colour: 0xff4444, radius: 0.42 },
        { y: 1.0, colour: 0xffffff, radius: 0.36 },
        { y: 0.5, colour: 0xffffff, radius: 0.36 },
      ];

      for (const r of rings) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(r.radius, 0.008, 6, 48),
          new THREE.MeshBasicMaterial({
            color: r.colour,
            toneMapped: false,
            depthTest: false,
          })
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = r.y;
        ring.renderOrder = 999;
        group.add(ring);
      }

      scene.add(group);
      rulerRef.current = group;
    }

    rulerRef.current.visible = showRuler;
  }, [showRuler]);

  // ---- room ---------------------------------------------------------------
  // The room is authoritative for scale: it arrives in real metres and the
  // character is normalised to 1.7m, so the two already agree. Grounding only —
  // no rescaling, which would break that relationship.
  async function loadRoom(file) {
    setBusy("Loading room…");
    setError(null);

    const scene = sceneRef.current;

    if (roomRef.current) {
      scene.remove(roomRef.current);
      VRMUtils.deepDispose(roomRef.current);
      roomRef.current = null;
    }

    try {
      const gltf = await new GLTFLoader().loadAsync(trackUrl(file));
      const root = gltf.scene;

      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());

      // Stand it on the floor plane without touching x/z — the layout matters,
      // and the door is not in the middle of a wall by accident.
      root.position.y -= box.min.y;
      root.updateMatrixWorld(true);

      const grounded = new THREE.Box3().setFromObject(root);
      const centre = grounded.getCenter(new THREE.Vector3());

      let triangles = 0;
      root.traverse((o) => {
        if (o.isMesh && o.geometry) {
          const g = o.geometry;
          triangles += g.index
            ? g.index.count / 3
            : (g.attributes.position?.count ?? 0) / 3;
        }
      });

      scene.add(root);
      roomRef.current = root;

      // Hide the placeholder box rather than dispose it, so unloading a room
      // leaves something to walk in.
      if (proceduralRoomRef.current) proceduralRoomRef.current.visible = false;

      // The bounding box bottom is the underside of the floor slab. The surface
      // you stand on is a slab thickness above it, so find it by looking down.
      // Start below the ceiling and above the floor, then take the FIRST hit
      // going down. Casting from the ceiling passes through ceiling-top,
      // ceiling-bottom, floor-top, floor-bottom — and the last of those is the
      // underside of the slab, which is a floor thickness too low.
      const ray = raycasterRef.current;
      ray.far = 3;
      ray.set(
        new THREE.Vector3(centre.x, grounded.min.y + 1.3, centre.z),
        new THREE.Vector3(0, -1, 0)
      );
      const downHits = ray.intersectObject(root, true);
      floorYRef.current = downHits.length ? downHits[0].point.y : 0;

      // The bounding box includes slab thickness top and bottom. What decides
      // whether a person looks right in here is the interior, so measure it.
      ray.set(
        new THREE.Vector3(centre.x, floorYRef.current + 0.05, centre.z),
        new THREE.Vector3(0, 1, 0)
      );
      const upHits = ray.intersectObject(root, true);
      const interiorHeight = upHits.length ? upHits[0].distance + 0.05 : size.y;

      probeActorRef.current = { at: 0, d: null };
      probePlayerRef.current = { at: 0, d: null };

      // Keep her off the skirting boards.
      const inset = 0.4;
      boundsRef.current = {
        minX: grounded.min.x + inset,
        maxX: grounded.max.x - inset,
        minZ: grounded.min.z + inset,
        maxZ: grounded.max.z - inset,
      };

      // Put her in the middle of it, and keep the camera from orbiting out
      // through the walls.
      if (holderRef.current) {
        holderRef.current.position.set(centre.x, floorYRef.current, centre.z);
      }
      if (controlsRef.current) {
        controlsRef.current.target.set(
          centre.x,
          floorYRef.current + TARGET_HEIGHT * 0.6,
          centre.z
        );
        controlsRef.current.maxDistance = Math.hypot(size.x, size.z);
        controlsRef.current.update();
      }
      if (cameraRef.current) {
        cameraRef.current.position.set(
          centre.x,
          floorYRef.current + TARGET_HEIGHT * 0.9,
          centre.z + Math.min(size.x, size.z) * 0.4
        );
      }

      setRoomInfo({
        source: file.name,
        floorY: floorYRef.current,
        interiorHeight,
        width: size.x,
        depth: size.z,
        height: size.y,
        triangles: Math.round(triangles),
      });
    } catch (e) {
      setError(`Could not load ${file.name}: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  function clearRoom() {
    const scene = sceneRef.current;
    if (roomRef.current) {
      scene.remove(roomRef.current);
      VRMUtils.deepDispose(roomRef.current);
      roomRef.current = null;
    }
    if (proceduralRoomRef.current) proceduralRoomRef.current.visible = true;
    floorYRef.current = 0;
    probeActorRef.current = { at: 0, d: null };
    probePlayerRef.current = { at: 0, d: null };
    if (holderRef.current) holderRef.current.position.y = 0;
    boundsRef.current = {
      minX: -ROOM / 2, maxX: ROOM / 2, minZ: -ROOM / 2, maxZ: ROOM / 2,
    };
    if (controlsRef.current) controlsRef.current.maxDistance = Infinity;
    setRoomInfo(null);
  }

  // ---- model --------------------------------------------------------------
  function frameModel(object) {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const camera = cameraRef.current;
    const controls = controlsRef.current;

    const fitDist = (size.y / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.35;
    controls.target.set(center.x, center.y, center.z);
    camera.position.set(center.x, center.y, center.z + fitDist);
    camera.updateProjectionMatrix();
    controls.update();
  }

  function inspect(vrm, root) {
    const out = {
      isVrm: Boolean(vrm),
      specVersion: vrm?.meta?.metaVersion === "0" ? "0.x" : vrm ? "1.0" : null,
      name: vrm?.meta?.name ?? vrm?.meta?.title ?? null,
      bones: [],
      missingBones: [],
      expressions: [],
      springBones: 0,
      triangles: 0,
      meshes: 0,
    };

    if (vrm?.humanoid) {
      for (const bone of REQUIRED_BONES) {
        if (vrm.humanoid.getNormalizedBoneNode(bone)) out.bones.push(bone);
        else out.missingBones.push(bone);
      }
    } else {
      out.missingBones = [...REQUIRED_BONES];
    }

    if (vrm?.expressionManager?.expressions) {
      out.expressions = vrm.expressionManager.expressions
        .map((e) => e.expressionName)
        .filter(Boolean)
        .sort();
    }

    if (vrm?.springBoneManager?.joints) {
      out.springBones = vrm.springBoneManager.joints.size ?? 0;
    }

    root.traverse((obj) => {
      if (obj.isMesh && obj.geometry) {
        out.meshes += 1;
        const g = obj.geometry;
        out.triangles += g.index
          ? g.index.count / 3
          : (g.attributes.position?.count ?? 0) / 3;
      }
    });
    out.triangles = Math.round(out.triangles);
    return out;
  }

  async function loadModel(file) {
    setBusy("Loading character…");
    setError(null);
    setReport(null);
    setClips([]);
    setPlaying(null);
    setExpression("");

    const scene = sceneRef.current;

    if (mixerRef.current) {
      mixerRef.current.stopAllAction();
      mixerRef.current = null;
    }
    actionsRef.current.clear();
    currentActionRef.current = null;

    if (holderRef.current) {
      scene.remove(holderRef.current);
      VRMUtils.deepDispose(holderRef.current);
      holderRef.current = null;
      rootRef.current = null;
      vrmRef.current = null;
    }
    setRoles(null);
    setFitInfo(null);
    setMatInfo(null);
    setSkinInfo(null);
    matBackupRef.current.clear();
    skinBackupRef.current.clear();
    setShading("source");
    setShadingAuto(false);
    if (skeletonHelperRef.current) {
      scene.remove(skeletonHelperRef.current);
      skeletonHelperRef.current.dispose?.();
      skeletonHelperRef.current = null;
    }
    walkRef.current.current = null;

    const isFbx = /\.fbx$/i.test(file.name);

    try {
      let vrm = null;
      let root;
      let embedded = [];

      if (isFbx) {
        root = await new FBXLoader().loadAsync(trackUrl(file));
        embedded = root.animations ?? [];
      } else {
        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));
        const gltf = await loader.loadAsync(trackUrl(file));
        vrm = gltf.userData.vrm ?? null;
        if (vrm && vrm.meta?.metaVersion === "0") VRMUtils.rotateVRM0(vrm);
        root = vrm?.scene ?? gltf.scene;
        embedded = gltf.animations ?? [];
      }

      const fit = normaliseToFloor(root);

      // The holder carries position and heading; the model keeps its grounding
      // offset inside. Moving the model directly would fight that offset.
      const holder = new THREE.Group();
      holder.add(root);
      scene.add(holder);

      holderRef.current = holder;
      rootRef.current = root;
      vrmRef.current = vrm;
      mixerRef.current = new THREE.AnimationMixer(root);
      // If a room is already loaded, she belongs in it, not at world origin.
      if (roomRef.current) {
        const b = boundsRef.current;
        holder.position.set(
          (b.minX + b.maxX) / 2,
          floorYRef.current,
          (b.minZ + b.maxZ) / 2
        );
      }

      // Measure where she really is, rather than trusting that the grounding
      // offset and the floor height agree. They are computed by different code
      // and there is no reason to assume they meet.
      holder.updateMatrixWorld(true);
      const world = new THREE.Box3().setFromObject(holder);
      feetYRef.current = world.min.y;

      setFitInfo({
        ...fit,
        standHeight: world.max.y - world.min.y,
        feetY: world.min.y,
        floorY: floorYRef.current,
      });
      const mats = surveyMaterials(root);
      setMatInfo(mats);
      setSkinInfo(surveySkinning(root));

      // Metalness 1.0 means no diffuse at all — the surface is pure reflection.
      // Valid for a chrome bumper, never for skin or cotton. Override it, but
      // say so rather than quietly papering over a bad export.
      if (mats.maxM > 0.9 && !mats.maps.metalness) {
        setShading("lit");
        setShadingAuto(true);
      }

      const helper = new THREE.SkeletonHelper(root);
      helper.visible = showSkeletonRef.current;
      scene.add(helper);
      skeletonHelperRef.current = helper;
      frameModel(holder);

      setReport({ ...inspect(vrm, root), source: file.name, isFbx });

      // A merged export carries its clips in the same file. They already target
      // this model's own skeleton, so they bind directly — no retargeting, for
      // VRM or otherwise.
      const found = [];
      embedded.forEach((source, i) => {
        const name = source.name || `clip ${i + 1}`;
        try {
          const bound = bindDirectClip(root, name, source);
          actionsRef.current.set(name, mixerRef.current.clipAction(bound.clip));
          found.push({
            name,
            duration: bound.clip.duration,
            mapped: bound.mapped,
            sourceTracks: bound.sourceTracks,
            skipped: bound.skipped,
            droppedScale: bound.droppedScale ?? 0,
          });
        } catch {
          // A clip that targets nodes this model doesn't have is reported by
          // its absence from the list rather than as a load failure.
        }
      });

      if (found.length) {
        setClips(found);
        const detected = detectRoles(found.map((c) => c.name));
        setRoles(detected);
        play(detected.idle ?? found[0].name);
      }
    } catch (e) {
      setError(`Could not load ${file.name}: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  // ---- animations ---------------------------------------------------------
  async function loadClips(files) {
    const vrm = vrmRef.current;
    const root = rootRef.current;

    if (!root) {
      setError("Load a character before loading animations.");
      return;
    }
    if (vrm && !vrm.humanoid) {
      setError("This VRM has no humanoid rig — nothing to retarget onto.");
      return;
    }

    setError(null);
    const added = [];
    const failures = [];

    async function loadAnimAsset(file) {
      if (/\.fbx$/i.test(file.name)) {
        return new FBXLoader().loadAsync(trackUrl(file));
      }
      const gltf = await new GLTFLoader().loadAsync(trackUrl(file));
      // GLTFLoader keeps clips beside the scene; put them on it so both asset
      // shapes look the same to the callers below.
      gltf.scene.animations = gltf.animations;
      return gltf.scene;
    }

    for (const file of files) {
      setBusy(`Retargeting ${file.name}…`);
      const base = file.name.replace(/\.(fbx|glb|gltf)$/i, "");
      try {
        const asset = await loadAnimAsset(file);
        const sources = asset.animations ?? [];

        if (sources.length === 0) {
          throw new Error("file contains no animation clips");
        }

        for (const source of sources) {
          // A GLB can carry several clips; keep their own names so they stay
          // distinguishable. Mixamo FBX is always a single clip called
          // "mixamo.com", which carries no information — use the filename.
          const name =
            sources.length > 1 && source.name && source.name !== "mixamo.com"
              ? `${base} · ${source.name}`
              : base;

          const result = vrm
            ? retargetMixamoClip(asset, vrm, name, source)
            : bindDirectClip(root, name, source);

          actionsRef.current.set(name, mixerRef.current.clipAction(result.clip));
          added.push({
            name,
            duration: result.clip.duration,
            mapped: result.mapped,
            sourceTracks: result.sourceTracks,
            skipped: result.skipped,
            droppedScale: result.droppedScale ?? 0,
          });
        }
      } catch (e) {
        failures.push(`${file.name} — ${e?.message ?? String(e)}`);
      }
    }

    setBusy(null);
    setClips((prev) => {
      const next = [...prev, ...added];
      setRoles(detectRoles(next.map((c) => c.name)));
      return next;
    });
    if (failures.length) setError(failures.join("\n"));
    if (added.length && !currentActionRef.current) play(added[0].name);
  }

  function play(name) {
    const action = actionsRef.current.get(name);
    if (!action) return;

    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;

    const previous = currentActionRef.current;
    if (previous && previous !== action) {
      action.crossFadeFrom(previous, 0.3, false).play();
    } else {
      action.fadeIn(0.2).play();
    }

    currentActionRef.current = action;
    setPlaying(name);
  }

  function stop() {
    const action = currentActionRef.current;
    if (!action) return;
    action.fadeOut(0.3);
    window.setTimeout(() => {
      action.stop();
      vrmRef.current?.humanoid?.resetNormalizedPose();
    }, 320);
    currentActionRef.current = null;
    setPlaying(null);
  }

  function applyExpression(name) {
    const vrm = vrmRef.current;
    if (!vrm?.expressionManager) return;
    for (const e of vrm.expressionManager.expressions) {
      vrm.expressionManager.setValue(e.expressionName, 0);
    }
    if (name) vrm.expressionManager.setValue(name, 1.0);
    setExpression(name);
  }

  const rigOk = report?.isVrm && report.missingBones.length === 0;

  const findings = [];
  if (skinInfo?.meshes > 0) {
    findings.push(
      skinInfo.short > 0
        ? {
            level: "bad",
            text: `Bone influences dropped on import — ${skinInfo.short.toLocaleString()} of ${skinInfo.verts.toLocaleString()} vertices carry less than full weight. Re-export with Include All Bone Influences OFF, or apply Limit Total = 4 in Blender.`,
          }
        : {
            level: "good",
            text: "Skin weights complete — nothing was lost on import, so any deformation error is in the rig itself.",
          }
    );
  }
  if (matInfo && matInfo.maxM > 0.9 && !matInfo.maps.metalness) {
    findings.push({
      level: "warn",
      text: "Metalness 1.00 — an unlit material wearing PBR clothing. Still unfixed at source.",
    });
  }
  if (matInfo && !matInfo.mapped) {
    findings.push({
      level: "warn",
      text: "Colour map only — no normal or roughness map, so one uniform roughness covers skin, cloth and hair. Dark hair has nothing to catch a highlight and renders as a flat silhouette.",
    });
  }
  if (matInfo?.maps.normal > 0 && matInfo?.maps.roughness > 0) {
    findings.push({
      level: "good",
      text: "Full PBR map set present — lit mode should now be the honest one.",
    });
  }
  if (report && !report.isVrm) {
    findings.push({
      level: "info",
      text: "No humanoid contract and no facial rig — clips must share this exact skeleton.",
    });
  }

  return (
    <div style={S.wrap}>
      <div style={S.controls}>
        <label style={S.btn}>
          Load character
          <input
            type="file"
            accept=".vrm,.glb,.gltf,.fbx"
            onChange={(e) => e.target.files?.[0] && loadModel(e.target.files[0])}
            style={{ display: "none" }}
          />
        </label>

        <label style={report ? S.btn : S.btnDisabled}>
          Load animations
          <input
            type="file"
            accept=".fbx,.glb,.gltf"
            multiple
            disabled={!report}
            onChange={(e) =>
              e.target.files?.length && loadClips([...e.target.files])
            }
            style={{ display: "none" }}
          />
        </label>

        <label style={S.btn}>
          Load room
          <input
            type="file"
            accept=".glb,.gltf"
            onChange={(e) => e.target.files?.[0] && loadRoom(e.target.files[0])}
            style={{ display: "none" }}
          />
        </label>

        {roomInfo && (
          <button style={S.btnGhost} onClick={clearRoom}>
            Clear room
          </button>
        )}

        <button
          style={fpv ? S.btn : S.btnGhost}
          onClick={() => setFpv((v) => !v)}
        >
          {fpv ? "Leave first person" : "First person"}
        </button>

        <button
          style={S.btnGhost}
          onClick={() => setWideFrame((v) => !v)}
        >
          {wideFrame ? "9:16 frame" : "Wide frame"}
        </button>

        <label style={S.btnGhost}>
          Load background
          <input
            type="file"
            accept="image/*"
            onChange={(e) =>
              e.target.files?.[0] && setBgUrl(trackUrl(e.target.files[0]))
            }
            style={{ display: "none" }}
          />
        </label>
      </div>

      <div style={S.body}>
        <div
          style={{
            ...S.stage,
            ...(wideFrame ? S.stageWide : S.stagePortrait),
            backgroundImage: bgUrl ? `url(${bgUrl})` : "none",
          }}
        >
          <div
            ref={mountRef}
            style={S.canvasMount}
            onClick={() => {
              if (fpvRef.current) fpvControlsRef.current?.lock();
            }}
          />
          {busy && <div style={S.overlay}>{busy}</div>}
          {!busy && !report && !error && (
            <div style={S.overlay}>
              Load a room, then a character, then animation clips.
            </div>
          )}
          <div style={S.fps}>{fps} fps</div>
          {fpv && !locked && (
            <div
              style={S.lockPrompt}
              onClick={() => fpvControlsRef.current?.lock()}
            >
              Click to look around
              <span style={S.lockHint}>
                WASD to walk, shift to run, escape to release
              </span>
            </div>
          )}
          {playing && <div style={S.nowPlaying}>{playing}</div>}
        </div>

        <div style={S.panel}>
          {error && <pre style={S.error}>{error}</pre>}
          {!report && !roomInfo && !error && (
            <div style={S.hint}>
              Load a room and a character. WASD walks her around it.
            </div>
          )}

          {roomInfo && (
            <div style={S.roomBar}>
              <span style={S.roomName}>{roomInfo.source}</span>
              <span style={S.roomMeta}>
                {roomInfo.width.toFixed(2)} × {roomInfo.depth.toFixed(2)} ×{" "}
                {roomInfo.height.toFixed(2)} m · ceiling{" "}
                <span
                  style={{
                    color:
                      roomInfo.interiorHeight < 2.2 ||
                      roomInfo.interiorHeight > 3.2
                        ? "#d97070"
                        : "#8a8a92",
                  }}
                >
                  {roomInfo.interiorHeight.toFixed(2)} m
                </span>{" "}
                · {roomInfo.triangles.toLocaleString()} tris
              </span>
            </div>
          )}

          {findings.length > 0 && (
            <div style={S.findings}>
              {findings.map((f, i) => (
                <div key={i} style={{ ...S.finding, ...S.findingLevel[f.level] }}>
                  {f.text}
                </div>
              ))}
            </div>
          )}

          {report && (
              <div style={S.panelGrid}>
                <div style={S.col}>
              <div style={S.reportHead}>{report.source}</div>

              <Row
                label="Format"
                value={
                  report.isVrm
                    ? `VRM ${report.specVersion}`
                    : report.isFbx
                    ? "FBX — direct playback, no face"
                    : "glTF — no VRM extension"
                }
                warn={!report.isVrm}
              />
              {report.name && <Row label="Model name" value={report.name} />}
              {report.isVrm ? (
                <>
                  <Row
                    label="Humanoid rig"
                    value={`${report.bones.length}/${REQUIRED_BONES.length} bones${
                      rigOk ? " — retarget viable" : ""
                    }`}
                    warn={!rigOk}
                  />
                  {report.missingBones.length > 0 && (
                    <Row label="Missing" value={report.missingBones.join(", ")} warn />
                  )}
                </>
              ) : (
                <Row
                  label="Humanoid rig"
                  value="none — clips must share this skeleton"
                  warn
                />
              )}
              <Row label="Spring bones" value={report.springBones} />
              <Row label="Triangles" value={report.triangles.toLocaleString()} />
              {fitInfo && (
                <>
                  <Row
                    label="Scaled to 1.7m"
                    value={`source ${fitInfo.rawHeight.toFixed(2)} → ×${fitInfo.scale.toFixed(3)}`}
                  />
                  {fitInfo.standHeight !== undefined && (
                    <>
                      <Row
                        label="Measured height"
                        value={`${fitInfo.standHeight.toFixed(3)} m`}
                        warn={Math.abs(fitInfo.standHeight - TARGET_HEIGHT) > 0.02}
                      />
                      <Row
                        label="Feet vs floor"
                        value={`${fitInfo.feetY.toFixed(3)} vs ${fitInfo.floorY.toFixed(3)} m`}
                        warn={Math.abs(fitInfo.feetY - fitInfo.floorY) > 0.01}
                      />
                    </>
                  )}
                </>
              )}
              {matInfo && (
                <>
                  <Row
                    label="Materials"
                    value={`${matInfo.count}, ${matInfo.textured} textured`}
                  />
                  <Row
                    label="PBR maps"
                    value={
                      matInfo.mapped
                        ? Object.entries(matInfo.maps)
                            .filter(([, n]) => n > 0)
                            .map(([k]) => k)
                            .join(", ")
                        : "colour only — no normal or roughness map"
                    }
                    warn={!matInfo.mapped}
                  />
                  <Row
                    label="Roughness"
                    value={
                      matInfo.maps.roughness
                        ? `map × ${matInfo.maxR.toFixed(2)}`
                        : `${matInfo.minR.toFixed(2)} – ${matInfo.maxR.toFixed(2)}`
                    }
                    warn={matInfo.maxR < 0.35 && !matInfo.maps.roughness}
                  />
                  <Row
                    label="Metalness"
                    value={
                      matInfo.maps.metalness
                        ? `map × ${matInfo.maxM.toFixed(2)}`
                        : `${matInfo.minM.toFixed(2)} – ${matInfo.maxM.toFixed(2)}`
                    }
                    warn={matInfo.maxM > 0.1 && !matInfo.maps.metalness}
                  />
                </>
              )}
              {skinInfo && skinInfo.meshes > 0 && (
                <>
                  <Row
                    label="Skinned meshes"
                    value={`${skinInfo.meshes}, ${skinInfo.bones} bones`}
                  />
                  <Row
                    label="Weight sums"
                    value={
                      skinInfo.short === 0
                        ? `${skinInfo.minSum.toFixed(2)} – ${skinInfo.maxSum.toFixed(2)}, all complete`
                        : `${skinInfo.short.toLocaleString()} of ${skinInfo.verts.toLocaleString()} short (min ${skinInfo.minSum.toFixed(2)})`
                    }
                    warn={skinInfo.short > 0}
                  />
                </>
              )}
              <Row
                label="Expressions"
                value={report.expressions.length}
                warn={report.expressions.length === 0}
              />

                </div>

                <div style={S.col}>
              {clips.length > 0 && (
                <div style={S.section}>
                  <div style={S.sectionLabel}>
                    <span>Animations — {clips.length} loaded</span>
                    <label style={S.loopToggle}>
                      <input
                        type="checkbox"
                        checked={loop}
                        onChange={(e) => setLoop(e.target.checked)}
                      />
                      loop
                    </label>
                  </div>

                  {clips.map((c) => (
                    <div key={c.name} style={S.clipRow}>
                      <button
                        style={playing === c.name ? S.clipOn : S.clipBtn}
                        onClick={() => play(c.name)}
                      >
                        {c.name}
                      </button>
                      <span
                        style={{
                          ...S.clipMeta,
                          color:
                            c.mapped < c.sourceTracks * 0.6 ? "#d97070" : "#8a8a92",
                        }}
                      >
                        {c.mapped}/{c.sourceTracks} tracks · {c.duration.toFixed(1)}s
                        {c.droppedScale > 0 && ` · ${c.droppedScale} scale dropped`}
                      </span>
                    </div>
                  ))}

                  <button style={S.stopBtn} onClick={stop} disabled={!playing}>
                    Stop
                  </button>
                </div>
              )}

                </div>

                <div style={S.col}>
              {matInfo && (
                <div style={S.section}>
                  <div style={S.sectionLabel}>
                    <span>Surface and skinning</span>
                    <select
                      value={shading}
                      onChange={(e) => setShading(e.target.value)}
                      style={S.select}
                    >
                      <option value="source">as exported</option>
                      <option value="lit">lit (PBR)</option>
                      <option value="unlit">unlit (as painted)</option>
                      <option value="normals">normals (debug)</option>
                    </select>
                  </div>
                  {shading === "unlit" && (
                    <div style={S.sliderRow}>
                      <span style={S.rowLabel}>Room light</span>
                      <input
                        type="color"
                        value={tint}
                        onChange={(e) => setTint(e.target.value)}
                        style={{ width: 44, height: 24, background: "none", border: "none" }}
                      />
                      {["#ffffff", "#ffd9a8", "#8fa6d9", "#4a4a58"].map((c) => (
                        <button
                          key={c}
                          onClick={() => setTint(c)}
                          title={c}
                          style={{ ...S.swatch, background: c }}
                        />
                      ))}
                    </div>
                  )}
                  <div style={S.sliderRow}>
                    <span style={S.rowLabel}>Exposure</span>
                    <input
                      type="range"
                      min="0.3"
                      max="2"
                      step="0.05"
                      value={exposure}
                      onChange={(e) => setExposure(parseFloat(e.target.value))}
                      style={{ flex: 1 }}
                    />
                    <span style={S.clipMeta}>{exposure.toFixed(2)}</span>
                  </div>
                  <div style={S.hint}>
                    {shading === "normals"
                      ? "Each fragment coloured by its normal. Smooth gradients are correct; a patch that jumps to an unrelated colour is an inverted or broken normal, and that is what shades black under a light."
                      : shading === "unlit"
                      ? "Texture as painted, lighting ignored. Matches the source viewer exactly — and will look identical at midnight and at noon."
                      : shading === "lit"
                      ? "Metalness and emission neutralised so room lighting reaches her. Any shading baked into the texture stays baked."
                      : shadingAuto
                      ? "This file declares metalness 1.00 with the colour map also wired to emission — an unlit material in PBR clothing. Switched to lit automatically; pick as exported to see it raw."
                      : "Exactly what the exporter wrote."}
                  </div>
                  <label style={{ ...S.loopToggle, marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={normalizeSkin}
                      onChange={(e) => setNormalizeSkin(e.target.checked)}
                    />
                    renormalise skin weights
                  </label>
                  <div style={S.hint}>
                    Toggle while she is posed. If the twisting comes back when
                    off, influences were dropped on import.
                  </div>
                  <label style={{ ...S.loopToggle, marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={doubleSided}
                      onChange={(e) => setDoubleSided(e.target.checked)}
                    />
                    force double-sided
                  </label>
                  <div style={S.hint}>
                    If the dark patches clear, those faces are wound inside out
                    and only their backs are visible.
                  </div>
                  <label style={{ ...S.loopToggle, marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={showRuler}
                      onChange={(e) => setShowRuler(e.target.checked)}
                    />
                    1.7m ruler
                  </label>
                  <div style={S.hint}>
                    Rings at 0.5m, 1.0m and 1.7m, centred on her. The red one is
                    exactly her height — her scalp should touch it.
                  </div>
                  <label style={{ ...S.loopToggle, marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={showSkeleton}
                      onChange={(e) => setShowSkeleton(e.target.checked)}
                    />
                    show skeleton
                  </label>
                  <div style={S.hint}>
                    If the bones move cleanly while the mesh does not, the rig is
                    fine and the weights are not.
                  </div>
                </div>
              )}

              {clips.length > 0 && (
                <div style={S.section}>
                  <div style={S.sectionLabel}>
                    <span>Walk her around</span>
                    <label style={S.loopToggle}>
                      <input
                        type="checkbox"
                        checked={walkMode}
                        onChange={(e) => setWalkMode(e.target.checked)}
                      />
                      enabled
                    </label>
                  </div>

                  {walkMode ? (
                    <>
                      <div style={S.hint}>
                        WASD or arrows to move, shift to run. Click the view
                        first so it has focus.
                      </div>
                      <RoleSelect
                        label="Idle clip"
                        value={roles?.idle}
                        clips={clips}
                        onChange={(v) => setRoles((r) => ({ ...r, idle: v }))}
                      />
                      <RoleSelect
                        label="Walk clip"
                        value={roles?.walk}
                        clips={clips}
                        onChange={(v) => setRoles((r) => ({ ...r, walk: v }))}
                      />
                      <RoleSelect
                        label="Run clip"
                        value={roles?.run}
                        clips={clips}
                        onChange={(v) => setRoles((r) => ({ ...r, run: v }))}
                      />
                      <div style={S.hint}>
                        Names come from the exporter and do not always match the
                        motion. Pick by what you see.
                      </div>
                      <div style={S.sliderRow}>
                        <span style={S.rowLabel}>Speed</span>
                        <input
                          type="range"
                          min="0.4"
                          max="3"
                          step="0.05"
                          value={walkSpeed}
                          onChange={(e) => setWalkSpeed(parseFloat(e.target.value))}
                          style={{ flex: 1 }}
                        />
                        <span style={S.clipMeta}>{walkSpeed.toFixed(2)} m/s</span>
                      </div>
                      <div style={S.hint}>
                        Tune speed until her feet stop sliding. Stride length
                        matched to travel.
                      </div>
                      <label style={{ ...S.loopToggle, marginTop: 8 }}>
                        <input
                          type="checkbox"
                          checked={flipFacing}
                          onChange={(e) => setFlipFacing(e.target.checked)}
                        />
                        flip facing (check if she walks backwards)
                      </label>
                    </>
                  ) : (
                    <div style={S.hint}>
                      Turns the clip list into a state machine: idle when still,
                      walk when moving.
                    </div>
                  )}
                </div>
              )}

              {report.expressions.length > 0 && (
                <div style={S.section}>
                  <div style={S.sectionLabel}>
                    <span>Expressions — what DELTAS would drive</span>
                  </div>
                  <div style={S.chips}>
                    <button
                      style={expression === "" ? S.chipOn : S.chip}
                      onClick={() => applyExpression("")}
                    >
                      neutral
                    </button>
                    {report.expressions.map((name) => (
                      <button
                        key={name}
                        style={expression === name ? S.chipOn : S.chip}
                        onClick={() => applyExpression(name)}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
                </div>
              </div>
          )}

          {actorId && <div style={S.actorId}>actor {actorId}</div>}
        </div>
      </div>
    </div>
  );
}

function RoleSelect({ label, value, clips, onChange }) {
  return (
    <div style={S.row}>
      <span style={S.rowLabel}>{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        style={S.select}
      >
        <option value="">none</option>
        {clips.map((c) => (
          <option key={c.name} value={c.name}>{c.name}</option>
        ))}
      </select>
    </div>
  );
}

function Row({ label, value, warn }) {
  return (
    <div style={S.row}>
      <span style={S.rowLabel}>{label}</span>
      <span style={{ ...S.rowValue, color: warn ? "#d97070" : "#e8e8ea" }}>
        {value}
      </span>
    </div>
  );
}

// Inline styles so the panel can't collide with any existing stylesheet while
// it's still disposable. Move to ActorModelPanel.module.css if it stays.
const S = {
  wrap: { display: "flex", flexDirection: "column", gap: 12 },
  controls: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  btn: {
    background: "#111", color: "#fff", border: "1px solid #111",
    borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer",
  },
  btnDisabled: {
    background: "#e5e5e5", color: "#999", border: "1px solid #e5e5e5",
    borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "not-allowed",
  },
  btnGhost: {
    background: "transparent", color: "#333", border: "1px solid #ccc",
    borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer",
  },
  body: { display: "flex", gap: 16, alignItems: "flex-start" },
  stage: {
    position: "relative",
    height: "min(78vh, 940px)",
    background: "#1a1a1e",
    backgroundSize: "cover", backgroundPosition: "center",
    borderRadius: 8, overflow: "hidden",
  },
  // Wide to see the room; 9:16 to check the encounter framing.
  stageWide: { flex: "1 1 480px", minWidth: 360 },
  stagePortrait: { flex: "0 0 auto", aspectRatio: "9 / 16" },
  canvasMount: { position: "absolute", inset: 0 },
  overlay: {
    position: "absolute", inset: 0, display: "flex", alignItems: "center",
    justifyContent: "center", color: "#8a8a92", fontSize: 13,
    textAlign: "center", padding: 24, pointerEvents: "none",
  },
  lockPrompt: {
    position: "absolute", inset: 0, display: "flex", gap: 8,
    flexDirection: "column", alignItems: "center", justifyContent: "center",
    background: "rgba(20,20,26,.55)", color: "#e8e8ea", fontSize: 15,
    cursor: "pointer", textAlign: "center", padding: 24,
  },
  lockHint: { color: "#a8a8b2", fontSize: 12 },
  fps: {
    position: "absolute", top: 8, right: 10, color: "#7a7a82", fontSize: 11,
    fontFamily: "ui-monospace, monospace", pointerEvents: "none",
  },
  nowPlaying: {
    position: "absolute", bottom: 10, left: 12, color: "#c8c8d0", fontSize: 11,
    fontFamily: "ui-monospace, monospace", pointerEvents: "none",
  },
  panel: {
    // Beside the canvas, and scrolling inside itself rather than moving the
    // page — the viewport should stay put while you read.
    flex: "1 1 380px", minWidth: 300, maxWidth: 520,
    maxHeight: "min(78vh, 940px)", overflowY: "auto",
    background: "#1a1a1e",
    borderRadius: 8, padding: 16, color: "#e8e8ea", fontSize: 13,
  },
  roomBar: {
    display: "flex", justifyContent: "space-between", alignItems: "baseline",
    gap: 16, flexWrap: "wrap", marginBottom: 12, padding: "9px 12px",
    background: "#22222a", borderRadius: 6, borderLeft: "3px solid #4a4a55",
  },
  roomName: {
    fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#c8c8d0",
    wordBreak: "break-all",
  },
  roomMeta: {
    fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#8a8a92",
  },
  findings: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 },
  finding: {
    borderRadius: 6, padding: "9px 12px", fontSize: 12, lineHeight: 1.5,
    borderLeft: "3px solid",
  },
  findingLevel: {
    bad:  { background: "#3a1f1f", color: "#f0c0c0", borderLeftColor: "#d97070" },
    warn: { background: "#3a321f", color: "#efdcb0", borderLeftColor: "#d9a870" },
    good: { background: "#1f3a2c", color: "#b8e8cf", borderLeftColor: "#4fbf8b" },
    info: { background: "#22222a", color: "#a8a8b2", borderLeftColor: "#4a4a55" },
  },
  panelGrid: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 0,
    alignItems: "start",
  },
  col: { minWidth: 0 },
  reportHead: {
    fontSize: 12, color: "#8a8a92", marginBottom: 12,
    fontFamily: "ui-monospace, monospace", wordBreak: "break-all",
  },
  row: {
    display: "flex", justifyContent: "space-between", gap: 12,
    padding: "6px 0", borderBottom: "1px solid #2a2a30",
  },
  rowLabel: { color: "#8a8a92", flex: "0 0 auto" },
  rowValue: { textAlign: "right", wordBreak: "break-word" },
  section: { marginTop: 0, marginBottom: 16 },
  sectionLabel: {
    color: "#8a8a92", fontSize: 12, marginBottom: 8,
    display: "flex", justifyContent: "space-between", alignItems: "center",
  },
  loopToggle: {
    display: "flex", alignItems: "center", gap: 4,
    color: "#8a8a92", fontSize: 12, cursor: "pointer",
  },
  clipRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: 8, marginBottom: 4,
  },
  clipBtn: {
    background: "#2a2a30", color: "#c8c8d0", border: "none", borderRadius: 4,
    padding: "5px 10px", fontSize: 12, cursor: "pointer", textAlign: "left",
  },
  clipOn: {
    background: "#e8e8ea", color: "#1a1a1e", border: "none", borderRadius: 4,
    padding: "5px 10px", fontSize: 12, cursor: "pointer", textAlign: "left",
  },
  clipMeta: {
    fontSize: 11, fontFamily: "ui-monospace, monospace",
    flex: "0 0 auto", textAlign: "right",
  },
  stopBtn: {
    marginTop: 8, background: "transparent", color: "#8a8a92",
    border: "1px solid #3a3a42", borderRadius: 4, padding: "5px 12px",
    fontSize: 12, cursor: "pointer",
  },
  hint: { color: "#7a7a82", fontSize: 11, lineHeight: 1.5, margin: "6px 0" },
  swatch: {
    width: 22, height: 22, borderRadius: 4,
    border: "1px solid #3a3a42", cursor: "pointer", padding: 0,
  },
  select: {
    background: "#2a2a30", color: "#e8e8ea", border: "1px solid #3a3a42",
    borderRadius: 4, padding: "3px 6px", fontSize: 12, maxWidth: 200,
  },
  sliderRow: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "8px 0", borderBottom: "1px solid #2a2a30",
  },
  chips: { display: "flex", flexWrap: "wrap", gap: 6 },
  chip: {
    background: "#2a2a30", color: "#c8c8d0", border: "none", borderRadius: 4,
    padding: "4px 9px", fontSize: 12, cursor: "pointer",
  },
  chipOn: {
    background: "#e8e8ea", color: "#1a1a1e", border: "none", borderRadius: 4,
    padding: "4px 9px", fontSize: 12, cursor: "pointer",
  },
  error: {
    background: "#3a1f1f", color: "#e8b0b0", borderRadius: 6,
    padding: "10px 12px", marginBottom: 12, lineHeight: 1.5,
    whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 12,
  },
  actorId: {
    marginTop: 16, color: "#5a5a62", fontSize: 11,
    fontFamily: "ui-monospace, monospace",
  },
};
