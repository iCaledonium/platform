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
// (Session 107 already broke "no backend" — this loads the actor's own GLB via
// /api/actors/:id. Session 109 adds a second, deliberate exception: Wardrobe
// below imports MiniGlbViewer + AccessoryEditor, the SAME dressing components
// CharacterWizard uses, rather than re-implementing a second copy. "Standalone"
// now means "doesn't own a database", not "shares nothing".)
//
// Deps: three, @pixiv/three-vrm  (FBXLoader ships inside three)

import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { MeshBVH, StaticGeometryGenerator } from "three-mesh-bvh";
import MiniGlbViewer, { applyAccessoryScale, effectiveTransform, applyAccessoryTint, capturePositions } from "./MiniGlbViewer";
import AccessoryEditor, {
  defaultAccessories,
  fetchAccessoryOptions,
  buildViewerAccessories,
  ACCESSORY_REGION_CAMERA,
  stripV,
} from "./AccessoryEditor";

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

// Session 118 — Magnus: "how hard can it be to change her spawn
// position?" Fair — a room's layout doesn't change between sessions,
// so re-detecting furniture via raycasting on every load was solving a
// harder problem than the one that actually exists. Verified-by-eye
// spawn points go here, keyed by the room file's name; when an entry
// exists it's used directly, no raycasting at all. Rooms without an
// entry fall back to the dynamic centre-probe/grid-scan detection
// below — that detection is now believed correct (Session 116/117
// fixed the margin and the null-as-furniture bug with console-verified
// data), but a known value is still simpler and can't misfire on a
// margin or a stray ray ever again. Add entries as: "exact-filename.glb":
// { x: ..., z: ... } — read the x/z off the "Holder position after
// clamp" console line once you've confirmed by eye it looks right, and
// it never needs detecting again for that room.
const KNOWN_ROOM_SPAWNS = {};

const WALL_H = 2.8;
const UP = new THREE.Vector3(0, 1, 0);
const EYE_HEIGHT = 1.65;
const PLAYER_SPEED = 1.5;   // m/s, a shade faster than her walk
const BODY_RADIUS = 0.32;   // how close either of you may get to a wall — still used for the exclusion-zone margin
// Session 132 — the whole probeWalls/slide/STOP_DISTANCE lineage
// (Sessions 111, 127–131) is gone, replaced by resolveCapsule further
// down: real geometric capsule-vs-triangle collision via
// three-mesh-bvh's shapecast, the established pattern for exactly
// this, not another hand-tuned raycast variant. It has no PROBE_EVERY-
// style throttle to go stale, so the tunneling problem those sessions
// were chasing with ever-larger distance margins doesn't apply to this
// system the same way — it resolves actual overlap at the real final
// position every frame, not a cached reading from up to 70ms ago.
// 30° is a portrait lens: correct proportions, but it flattens depth and makes
// anything near the camera loom. First person wants something close to human
// central vision.
// Session 148 - was 35, while Inspect renders at 45: two FOVs
// foreshorten the same head differently at equal distance. One
// character, one lens.
const FOV_ORBIT = 45;
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

// Every vertex, every measurement pass. 30k verts at 2Hz costs under 2ms and
// buys an exact scalp — a stride would miss the apex by up to a vertex spacing,
// which is the same order as the error being measured.
const POSE_SAMPLE_STRIDE = 1;
const _poseVertex = new THREE.Vector3();

/**
 * True bounding height of a posed skinned character.
 *
 * Box3.setFromObject transforms geometry.boundingBox by matrixWorld. That box
 * is baked at bind pose and skinning runs on the GPU, so it is blind to the
 * current pose: a clip that straightens the legs makes the character visibly
 * taller while the box does not move. applyBoneTransform runs the same skinning
 * maths on the CPU for one vertex, against bones[].matrixWorld — current for the
 * frame as long as this is called after the renderer has updated the graph.
 *
 * Returns null when there is nothing to measure, so the caller shows nothing
 * rather than a confident zero.
 */
function measurePosedBounds(root, stride = POSE_SAMPLE_STRIDE) {
  let minY = Infinity;
  let maxY = -Infinity;
  let sampled = 0;
  let skinnedMeshes = 0;

  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const pos = o.geometry.attributes.position;
    if (!pos) return;

    // r151 renamed boneTransform -> applyBoneTransform. Support both rather
    // than silently measuring a skinned mesh as if it were static, which would
    // reproduce exactly the bug this function exists to find.
    let apply = null;
    if (o.isSkinnedMesh && o.skeleton) {
      skinnedMeshes += 1;
      const fn = o.applyBoneTransform || o.boneTransform;
      if (!fn) {
        throw new Error(
          "ActorModelPanel: SkinnedMesh has neither applyBoneTransform nor " +
          "boneTransform — three.js version is outside the supported range " +
          "and posed height cannot be measured."
        );
      }
      apply = fn.bind(o);
    }

    for (let i = 0; i < pos.count; i += stride) {
      _poseVertex.fromBufferAttribute(pos, i);
      if (apply) apply(i, _poseVertex);
      _poseVertex.applyMatrix4(o.matrixWorld);
      if (_poseVertex.y < minY) minY = _poseVertex.y;
      if (_poseVertex.y > maxY) maxY = _poseVertex.y;
      sampled += 1;
    }
  });

  if (!sampled) return null;
  return { minY, maxY, height: maxY - minY, sampled, skinnedMeshes };
}

// Meshy generates each clip in a separate job and none of them agree on where
// the floor is: measured on Frida, Walking sits 1.6cm below it and
// Walking_Woman 14.2cm above, a 15.8cm spread on one character. Her *height* is
// constant across all of them, so this is not scale — each clip simply writes an
// absolute Hips Y of its own choosing.
//
// So grounding is a property of the clip, not of the character. Measured once
// per clip from the lowest foot across the whole duration, never per frame:
// per-frame would clamp Running to the floor and delete its airborne phase.
const CLIP_GROUND_SAMPLES = 24;
const CLIP_GROUND_STRIDE = 8;

/**
 * Lowest world Y the character reaches anywhere in a clip, with the holder at
 * its base height. Leaves the mixer wound to the end of the sweep — the caller
 * is responsible for resetting it.
 */
function measureClipLowestY(holder, mixer, action) {
  const duration = action.getClip()?.duration ?? 0;
  if (duration <= 0) return null;

  let lowest = Infinity;
  for (let i = 0; i < CLIP_GROUND_SAMPLES; i += 1) {
    mixer.setTime((duration * i) / CLIP_GROUND_SAMPLES);
    holder.updateMatrixWorld(true);
    const bounds = measurePosedBounds(holder, CLIP_GROUND_STRIDE);
    if (bounds && bounds.minY < lowest) lowest = bounds.minY;
  }

  return Number.isFinite(lowest) ? lowest : null;
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

// Session 108→109 — the read-only wardrobe mirror constants that used to
// live here are gone. Wardrobe now renders the real <AccessoryEditor>
// (imported above), which owns the override/occlusion rules itself.

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
  // Session 147 — Display sliders reach the lights through these.
  const hemiLightRef = useRef(null);
  const keyLightRef = useRef(null);
  const rimLightRef = useRef(null);
  // Scene setup runs in a mount effect that must not re-run on display
  // changes — it reads initial values through this ref instead.
  const displayRef = useRef(null);
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
  // Session 132 — Magnus: "check the internet how this is done." Found
  // the actual established pattern (three-mesh-bvh's own reference
  // character-movement example): a capsule (segment + radius) checked
  // directly against real mesh triangles via shapecast, not point-rays
  // fired in a handful of directions. Replaces probeWalls/slide/
  // STOP_DISTANCE/the fan-angle system entirely — see resolveCapsule
  // below. probeActorRef/probePlayerRef (the old throttled-raycast
  // caches) are gone with it — resolveCapsule has no equivalent cache,
  // it checks real overlap fresh every call.
  //
  // Session 140 — ONE merged world-space BVH for the whole room
  // (StaticGeometryGenerator, exactly like the reference example),
  // replacing Session 132's one-BVH-per-mesh set. That per-mesh split
  // was a deliberate risk call when StaticGeometryGenerator's
  // availability was unverified at 2am; its availability is now
  // CONFIRMED by listing the installed package's actual exports
  // (three-mesh-bvh 0.9.14, checked via node -e on the platform
  // server, 15 Aug). The merge is load-bearing, not a convenience:
  // sequential per-mesh depenetration has no convergence guarantee
  // when several meshes (a doorway's two frame pieces) touch her at
  // once — the suspected cause of the bathroom/hallway navigation
  // failures — and baking every matrixWorld into one world-space
  // geometry also deletes the Session 137 per-mesh scale compensation
  // outright instead of maintaining it. RESOLVE_ITERATIONS (Session
  // 139's compensation for the per-mesh split) is gone with it.
  // colliderRef: { geometry (world-space, with .boundsTree), triangles }.
  const colliderRef = useRef(null);
  // Diagnostic only: world-space Box3 per source mesh, so correction
  // logs can still name what she hit even though the collision
  // geometry itself is one anonymous merged buffer.
  const collisionNameBoxesRef = useRef([]);
  // Walk limits come from whatever room is loaded, procedural or real.
  const boundsRef = useRef({ minX: -ROOM / 2, maxX: ROOM / 2, minZ: -ROOM / 2, maxZ: ROOM / 2 });
  // Session 113 — hard circular no-go zones (currently: whatever
  // obstacle sits at the room's centre, usually the coffee table).
  // Deterministic distance check, not another raycast probe — Magnus's
  // call after the height-probe approach still let her end up on top of
  // furniture: "make an invisible pillar... impossible to walk inside
  // the table's radius." {x, z, radius} in world space, populated at
  // room load, applied as a final position clamp after every movement
  // path (WASD walking, FPV auto-wander, and the initial spawn).
  const furnitureExclusionsRef = useRef([]);
  const keysRef = useRef(new Set());
  const walkRef = useRef({ on: false, speed: 1.35, roles: null, current: null, flip: false });
  // Session 112 — tracks how long a real WASD input has produced near-zero
  // actual displacement (slide() blocked it). Used only to break a
  // furniture-corner deadlock after it's persisted a moment, not to
  // second-guess normal wall/furniture sliding on a single frame.
  const stuckRef = useRef({ since: 0, lastLog: 0 });
  // Session 135 — Magnus: "she can still walk thru the furnitures,"
  // reported alongside a console log that showed zero Blocked lines at
  // all — meaning resolveCapsule wasn't finding a penetration to
  // correct, not that it was finding one and failing to push her out.
  // Throttled log of every real correction resolveCapsule actually
  // makes, so we can see directly whether it fires at all near
  // whatever furniture this turns out to be, instead of inferring it
  // from the absence of the (different) stuck-detection log.
  const correctionLogRef = useRef(0);
  // Session 119 — last position where a real input actually produced
  // real movement. Not a guess at "somewhere safe in the room" — she
  // was physically there and moving, so by definition nothing was
  // blocking her. Basis for the hard last-resort escape below: if she's
  // ever genuinely boxed in on all four sides (the existing nudge
  // correctly refuses to push through real geometry in that case, which
  // is right, but leaves her with no recovery path at all), return her
  // to here instead of leaving her frozen indefinitely.
  const lastGoodPositionRef = useRef(new THREE.Vector3());
  // Live inputs to the clip state machine, so a wrong clip can be read off the
  // panel instead of reasoned about.
  const walkDebugRef = useRef(null);
  // Per-clip floor correction, held as an offset from floorY rather than an
  // absolute height so nothing else that writes holder.position can clobber it.
  // `target` is where the current clip wants her, `applied` is where she has
  // eased to. Snapping target straight onto the holder puts her at the incoming
  // clip's height while she is still wearing the outgoing clip's pose, which
  // shows up as a 7.3cm grow-then-shrink across the crossfade.
  const groundRef = useRef({ target: 0, applied: 0 });
  const matBackupRef = useRef(new Map());
  const skinBackupRef = useRef(new Map());
  const skeletonHelperRef = useRef(null);
  const showSkeletonRef = useRef(false);
  const mixerRef = useRef(null);
  const actionsRef = useRef(new Map());
  const clipGroundRef = useRef(new Map());
  const currentActionRef = useRef(null);
  const frameRef = useRef(null);
  // Session 122 - attempted THREE.Clock -> Timer migration, broke the
  // build on a guessed addon import path; reverted with the demand that
  // any retry verify the real path from node_modules first.
  // Session 147 - verified: at three 0.185 there IS no addon path;
  // Timer was promoted to CORE, update/getDelta confirmed via node
  // against the installed package. No new import. Also fixed:
  // useRef(new THREE.Clock()) constructed a new Clock on EVERY render
  // - the wall of repeated deprecation warnings. Lazy construction in
  // the animate loop: exactly one Timer, ever.
  const timerRef = useRef(null);
  const objectUrlsRef = useRef([]);
  const dracoLoaderRef = useRef(null);

  const [report, setReport] = useState(null);
  const [clips, setClips] = useState([]);
  const [playing, setPlaying] = useState(null);
  const [loop, setLoop] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [fps, setFps] = useState(0);
  // Session 120 — Magnus needs a real, verified spawn point for this
  // room after three rounds of the dynamic detection getting the shape
  // wrong for a clustered furniture layout. Easiest way to get one:
  // let him walk her to a spot that looks right and read the number
  // straight off the screen, instead of digging through console logs.
  const [holderXZ, setHolderXZ] = useState(null);
  const [bgUrl, setBgUrl] = useState(null);
  const [expression, setExpression] = useState("");
  // Session 107 — panel modes. "explore" is the inhabited view: her home
  // loaded, locomotion on, minimal chrome; the walking/FP machinery below
  // was all built in the VRM sessions and is simply auto-engaged here.
  // "inspect" is the original diagnostic surface, unchanged. Explore is
  // the default because the panel's day job is now showing the character
  // living, not debugging rigs.
  const [mode, setMode] = useState("explore");
  const [walkMode, setWalkMode] = useState(false);
  const [walkSpeed, setWalkSpeed] = useState(1.35);
  const [flipFacing, setFlipFacing] = useState(false);
  const [roles, setRoles] = useState(null);
  const [fitInfo, setFitInfo] = useState(null);
  const [posedInfo, setPosedInfo] = useState(null);
  const [clipGround, setClipGround] = useState(new Map());
  const [walkDebug, setWalkDebug] = useState(null);
  const [matInfo, setMatInfo] = useState(null);
  const [shading, setShading] = useState("source");
  // Session 147 — Explore display settings ("Display" card, right panel,
  // Explore mode). Replaces the orphaned `exposure` state that sat here
  // wired to toneMappingExposure with no UI ever calling its setter (a
  // past-session stub, absorbed rather than left as drift). Defaults are
  // exactly the previously hardcoded scene values. Persisted to
  // localStorage (instant, per-browser) AND users.preferences in the DB
  // (per Magnus: user preference, survives browser changes) under the
  // exploreDisplay namespace.
  const EXPLORE_DISPLAY_DEFAULTS = { exposure: 1.0, envIntensity: 1.0, keyIntensity: 0.9, ambientIntensity: 0.25, rimIntensity: 0.3, shadows: false, sunAzimuth: 37, sunElevation: 45 };
  const [display, setDisplay] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("anima_explore_display") || "null");
      if (stored && typeof stored === "object") return { ...EXPLORE_DISPLAY_DEFAULTS, ...stored };
    } catch (e) { console.warn("[ActorModelPanel] stored display settings unreadable, using defaults:", e); }
    return { ...EXPLORE_DISPLAY_DEFAULTS };
  });
  const displayPrefsSaveTimerRef = useRef(null);
  // Same render-time-assignment pattern as saveWardrobeRef below: the
  // scene-setup mount effect reads initial light values through this.
  displayRef.current = display;
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

  // ---- Wardrobe (Session 109 — Magnus's explicit call: "share dressing
  // components with the character wizard, one place to change"). Same
  // state shape as CharacterWizard's Accessories step, seeded from this
  // actor's draft_state and saved back to it. null/{} = no draft_state on
  // this actor yet (legacy actor, or nothing picked) — defaultAccessories()
  // covers rendering either way, same convention as the wizard's own
  // initial state.
  const [accessories, setAccessories] = useState(() => defaultAccessories());
  const [selectedAccessoryGlbUrls, setSelectedAccessoryGlbUrls] = useState({});
  const [accessoryScales, setAccessoryScales] = useState({});
  const [accessoryOffsets, setAccessoryOffsets] = useState({});
  const [accessoryRotations, setAccessoryRotations] = useState({});
  const [accessoryParts, setAccessoryParts] = useState({});
  const [accessoryTints, setAccessoryTints] = useState({});
  const [accessoryPartNames, setAccessoryPartNames] = useState({});
  const [activeSlot, setActiveSlot] = useState(null);
  const [scaleDetailSlot, setScaleDetailSlot] = useState(null);
  const [activePart, setActivePart] = useState(null);
  const [activeAccessoryRegion, setActiveAccessoryRegion] = useState("Torso");
  const [dynamicAccessoryOptions, setDynamicAccessoryOptions] = useState({});
  const [actorStatus, setActorStatus] = useState(null);
  const [actorGlbUrl, setActorGlbUrl] = useState(null);
  const [savingWardrobe, setSavingWardrobe] = useState(false);
  const [wardrobeSaveError, setWardrobeSaveError] = useState(null);
  const [wardrobeSaveOk, setWardrobeSaveOk] = useState(false);
  const [draftStateUnparseable, setDraftStateUnparseable] = useState(false);
  // Session 109 — Inspect's main stage now runs MiniGlbViewer instead of
  // the bespoke engine (Magnus: "let inspect use the miniglbViewer" —
  // Explore keeps the bespoke engine unchanged; MiniGlbViewer can't do
  // room/walk/FPV at all). MiniGlbViewer only plays animations already
  // embedded in the GLB (gltf.animations) — no arbitrary FBX upload, no
  // retargeting, matching the roadmap direction (DAZ-exported animations,
  // Mixamo retarget testing dropped). embeddedAnimations is populated by
  // MiniGlbViewer's own onAnimationsLoaded callback.
  const [embeddedAnimations, setEmbeddedAnimations] = useState([]);
  // Session 143 — "upload an animation and it is merged": drives
  // POST /api/actors/:id/animations (server/animations.js). Accepts
  // .duf too — the server does the DAZ pass and parses the frame
  // range out of the file itself. On success the page reloads the
  // actor GLB fresh (updated_at bump = new ?v= = cache miss).
  const [animUploadBusy, setAnimUploadBusy] = useState(false);
  const [animUploadMsg, setAnimUploadMsg] = useState(null);
  const [animUploadClipName, setAnimUploadClipName] = useState("");
  const [animUploadLoop, setAnimUploadLoop] = useState(false);

  // Session 143 — clip deletion (trash icon per clip). idle/walk are
  // protected server-side and get no trash icon here.
  const [animDeleting, setAnimDeleting] = useState(null);

  async function handleAnimationDelete(name) {
    if (!actorId || animDeleting) return;
    if (!window.confirm(`Remove the clip "${name}" from this character's model? This edits the GLB itself.`)) return;
    setAnimDeleting(name);
    setAnimUploadMsg({ err: false, text: `Removing "${name}"...` });
    try {
      const resp = await fetch(`/api/actors/${actorId}/animations/${encodeURIComponent(name)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setAnimUploadMsg({ err: false, text: `Removed "${name}". Refreshing the model...` });
      // In-place refresh — same reasoning as the upload handler above.
      // Session 144 — the ledger re-derives the canonical GLB from the
      // master, which is BODY-ONLY (composition direction): mark the
      // wardrobe bridge dirty so Explore rebakes her dressed on next
      // entry instead of showing the undressed derivation.
      wardrobeDirtyRef.current = true;
      await loadActorModel(actorId);
      setAnimUploadMsg({ err: false, text: `Removed "${name}".` });
      setAnimDeleting(null);
    } catch (e) {
      setAnimUploadMsg({ err: true, text: `Removal failed: ${String(e.message || e).slice(0, 600)}` });
      setAnimDeleting(null);
    }
  }

  async function handleAnimationUpload(file) {
    console.log(`[ActorModelPanel] animation upload: file="${file?.name}" clipName="${animUploadClipName}" actorId=${actorId}`);
    if (!file || !actorId) return;
    const clipName = animUploadClipName.trim();
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(clipName)) {
      setAnimUploadMsg({ err: true, text: "Clip name first: 1-32 chars, letters/digits/_/- (e.g. \"sit\")." });
      return;
    }
    setAnimUploadBusy(true);
    setAnimUploadMsg({ err: false, text: `Merging "${clipName}" — a .duf goes through DAZ and can take a few minutes...` });
    try {
      const form = new FormData();
      form.append("animation", file);
      form.append("clip_name", clipName);
      if (animUploadLoop) form.append("loop", "true");
      const resp = await fetch(`/api/actors/${actorId}/animations`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setAnimUploadMsg({ err: false, text: `Merged "${data.clip}"${data.detected_frames ? ` (${data.detected_frames} frames detected)` : ""}. Refreshing the model...` });
      // Session 143 — in-place refresh, NOT window.location.reload():
      // the full reload dumped the user back on the Identity page (the
      // 3D panel's selection isn't in the URL). loadActorModel already
      // does the honest refresh — re-fetches the actor (new updated_at
      // -> new cache-busted GLB), reloads BOTH viewers, and rebuilds
      // the wardrobe mirror index — without losing where you are.
      // Session 144 — the ledger re-derives the canonical GLB from the
      // master, which is BODY-ONLY (composition direction): mark the
      // wardrobe bridge dirty so Explore rebakes her dressed on next
      // entry instead of showing the undressed derivation.
      wardrobeDirtyRef.current = true;
      await loadActorModel(actorId);
      setAnimUploadMsg({ err: false, text: `Merged "${data.clip}"${data.detected_frames ? ` (${data.detected_frames} frames)` : ""}.` });
      setAnimUploadBusy(false);
    } catch (e) {
      setAnimUploadMsg({ err: true, text: `Merge failed: ${String(e.message || e).slice(0, 600)}` });
      setAnimUploadBusy(false);
    }
  }
  const [inspectActiveAnimation, setInspectActiveAnimation] = useState("idle");
  // Session 109 — Animations and Wardrobe are separate tabs within
  // Inspect's right panel, not stacked in one scroll.
  const [inspectTab, setInspectTab] = useState("animations");
  // Full draft_state object, kept verbatim so Save can merge wardrobe
  // fields back in without clobbering psychology/body/economy/etc. —
  // POST /api/actors/:id/draft-state is a full overwrite, not a merge.
  const fullDraftStateRef = useRef({});
  const autoSaveWardrobeTimerRef = useRef(null);
  // Session 110 — MiniGlbViewer hands up its bake function the same way
  // CharacterWizard captures it (onExportReady). Used to refresh
  // Explore's own separately-loaded mesh with live wardrobe edits when
  // switching back to it — the two engines don't share geometry, so a
  // tint change made in Inspect otherwise never reaches Explore's copy.
  const exportGlbRef = useRef(null);
  const wardrobeDirtyRef = useRef(false);
  // Session 147 — Plan A bridge state: one rebake at a time, and a
  // bounded retry count so a garment that permanently fails to load in
  // the hidden viewer can't spin the export/reload loop forever.
  const exploreRebakeInFlightRef = useRef(false);
  const exploreRebakeRetriesRef = useRef(0);
  const [exploreRebakeTick, setExploreRebakeTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchAccessoryOptions()
      .then((grouped) => { if (!cancelled) setDynamicAccessoryOptions(grouped); })
      .catch((err) => console.error("[ActorModelPanel] Failed to fetch /api/accessories:", err));
    return () => { cancelled = true; };
  }, []);

  async function saveWardrobe() {
    // Session 147 — was also gated on actorStatus === "draft", which made
    // every wardrobe edit on a finished actor a silent no-op (found live
    // on Lindsey, ready_to_deploy). Under Plan A the wardrobe config IS
    // the canonical dressed state — deployed GLBs are body-only — so it
    // must persist for every status. Server-side gate lifted in the same
    // session (index.js /draft-state route).
    if (!actorId || draftStateUnparseable) return;
    setSavingWardrobe(true);
    setWardrobeSaveError(null);
    try {
      const merged = {
        ...fullDraftStateRef.current,
        accessories, selectedAccessoryGlbUrls, accessoryScales, accessoryOffsets,
        accessoryRotations, accessoryParts, accessoryTints,
      };
      const resp = await fetch(`/api/actors/${actorId}/draft-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: merged }),
      });
      if (!resp.ok) throw new Error(`save failed (${resp.status})`);
      fullDraftStateRef.current = merged;
      setWardrobeSaveOk(true);
      setTimeout(() => setWardrobeSaveOk(false), 2000);
    } catch (e) {
      // Real failure (network, server) — this one DOES surface, as a
      // small caption in WardrobeCard, not a blocking box. The routine
      // "not in draft status" case above returns before this and never
      // sets an error at all — that's expected, not a failure.
      console.error("[ActorModelPanel] wardrobe auto-save failed:", e);
      setWardrobeSaveError(`Could not save wardrobe: ${e?.message ?? String(e)}`);
    } finally {
      setSavingWardrobe(false);
    }
  }

  // Session 109 — auto-save, no button. Magnus: "changing top or any
  // asset should auto save like character wizard, no save button
  // needed." Same 1.5s debounce as CharacterWizard's own
  // persistDraftState effect, watching the same seven accessory fields
  // saveWardrobe writes.
  useEffect(() => {
    if (!actorId) return;
    if (autoSaveWardrobeTimerRef.current) clearTimeout(autoSaveWardrobeTimerRef.current);
    autoSaveWardrobeTimerRef.current = setTimeout(() => { saveWardrobe(); }, 1500);
    return () => { if (autoSaveWardrobeTimerRef.current) clearTimeout(autoSaveWardrobeTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, JSON.stringify(accessories), JSON.stringify(selectedAccessoryGlbUrls), JSON.stringify(accessoryScales), JSON.stringify(accessoryOffsets), JSON.stringify(accessoryRotations), JSON.stringify(accessoryParts), JSON.stringify(accessoryTints)]);

  // Session 117 — Magnus: "why isn't the scaling saved in wardrobe?"
  // Traced: scale WAS wired into the save correctly (watch list, save
  // payload, restore-on-load all confirmed). The real gap — adjust a
  // scale slider, then navigate away (back to the character list,
  // switch actors) before the 1.5s debounce fires, and the pending
  // save is just CANCELLED, silently, no error. Scale sliders get
  // dragged and left; a single accessory pick is a more isolated,
  // deliberate action less likely to be followed by leaving
  // immediately — so scale specifically would go missing more than
  // anything else, without this being scale-specific in the code.
  //
  // saveWardrobeRef is updated on every render (not inside an effect —
  // a plain assignment during render, a standard pattern for this) so
  // it always holds the CURRENT closure over accessories/scales/etc.
  // The empty-deps effect below only runs its cleanup on true unmount,
  // and reads from that ref rather than closing over the first
  // render's (stale) saveWardrobe.
  const saveWardrobeRef = useRef(saveWardrobe);
  saveWardrobeRef.current = saveWardrobe;
  useEffect(() => {
    return () => {
      if (autoSaveWardrobeTimerRef.current) {
        clearTimeout(autoSaveWardrobeTimerRef.current);
        saveWardrobeRef.current();
      }
    };
  }, []);

  // Session 110 — same dependency list as the auto-save effect above,
  // separate concern: marks Explore's own separately-loaded mesh as
  // stale relative to whatever's live in Inspect right now. Cheap sync
  // set, no debounce needed (the actual refresh below IS debounced by
  // only firing on the mode switch itself, not on every keystroke).
  // Session 141 — STRUCTURAL changes only (garment added/removed/
  // swapped): those genuinely need MiniGlbViewer's fitting pipeline
  // and therefore a rebake. Tint/scale/offset/rotation/parts changes
  // no longer touch this flag at all — they're mirrored onto Explore's
  // meshes in place by the live-mirror effect below, the same way
  // MiniGlbViewer applies them to its own copy.
  useEffect(() => {
    wardrobeDirtyRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(selectedAccessoryGlbUrls)]);

  // Session 110 — Magnus: "if i change the color of an accessory in
  // inspect and go back to explore that change shall be reflected in
  // explore mode too." Explore and Inspect are two SEPARATE engines
  // with two separate copies of her geometry (Explore never adopted
  // MiniGlbViewer — no room/walk/FPV there, see the earlier decision).
  // A tint/slot change made live in MiniGlbViewer only touches its own
  // copy. Bridging them without merging the engines: on switching back
  // to Explore, if wardrobe was touched, bake the CURRENT dressed state
  // via MiniGlbViewer's own export function (the same one "Save GLB"
  // used to call) and reload Explore's mesh from that fresh blob —
  // same loadModel() path as a normal actor load, just fed a
  // freshly-baked file instead of one fetched from the server.
  //
  // ── Session 141 — EXPLORE WARDROBE MIRROR ──────────────────────────
  // Explore holds its own copy of her meshes (separate engine, separate
  // scene). Historically ANY wardrobe edit forced the full bridge:
  // serialize a GLB, reload, position reset. But almost nothing edited
  // in the wardrobe needs the fitting pipeline — tint is a material
  // color, and scale/offset/rotation are vertex rewrites from a stored
  // baseline (MiniGlbViewer's own live-slider mechanism, its functions
  // imported above). So: index Explore's garment meshes once per load,
  // then mirror every non-structural edit onto them in place. Only
  // works on a copy whose garments were exported at IDENTITY transform
  // (userData.identityBaked — see exportMorphedGlbBlob's dressed path):
  // capturing baselines from a transform-baked file would make every
  // later edit compound. Legacy/canonical dressed files simply produce
  // no index, and edits fall back to the old rebake path unchanged.
  const exploreWardrobeIndexRef = useRef(null);

  function buildExploreWardrobeIndex() {
    exploreWardrobeIndexRef.current = null;
    const root = rootRef.current;
    if (!root) return;
    const index = {};
    const seenMaterialUuids = new Set();
    let tagged = 0, identity = 0;
    root.traverse((o) => {
      if (!o.isMesh || !o.userData?.isAccessoryMesh) return;
      tagged += 1;
      if (!o.userData.identityBaked || !o.userData.accessoryUrl) return;
      identity += 1;
      // GLTFExporter dedupes identical materials, so two garments can
      // arrive SHARING one material instance — tinting the shirt would
      // tint the jeans. Guarantee per-mesh-unique materials up front.
      if (Array.isArray(o.material)) {
        o.material = o.material.map((m) => {
          if (!m) return m;
          if (seenMaterialUuids.has(m.uuid)) return m.clone();
          seenMaterialUuids.add(m.uuid);
          return m;
        });
      } else if (o.material) {
        if (seenMaterialUuids.has(o.material.uuid)) o.material = o.material.clone();
        else seenMaterialUuids.add(o.material.uuid);
      }
      o.geometry.computeBoundingBox();
      const center = new THREE.Vector3();
      o.geometry.boundingBox.getCenter(center);
      const key = stripV(o.userData.accessoryUrl);
      if (!index[key]) index[key] = [];
      index[key].push({
        mesh: o,
        matName: o.userData.accessoryMatName || (Array.isArray(o.material) ? o.material[0] : o.material)?.name || o.name,
        originalPositions: capturePositions(o.geometry.attributes.position),
        center,
      });
    });
    if (identity > 0) exploreWardrobeIndexRef.current = index;
    console.log(`[ActorModelPanel] Explore wardrobe index: ${tagged} accessory mesh(es) in this copy, ${identity} identity-baked and mirrorable across ${Object.keys(index).length} garment(s).${identity === 0 && tagged > 0 ? " Legacy dressed file — live mirroring off, edits will rebake." : ""}`);
  }

  // Applies the CURRENT wardrobe config to Explore's indexed meshes in
  // place — same operations, same imported functions, same whole/part
  // rules as MiniGlbViewer's own live-update effect. Returns true if
  // every configured garment was covered by the index (nothing
  // structural pending); false means a garment was added/removed since
  // this copy was baked, and only a rebake can fix that.
  function applyExploreWardrobe() {
    const index = exploreWardrobeIndexRef.current;
    if (!index) return false;
    const cfgs = buildViewerAccessories({
      selectedAccessoryGlbUrls, accessoryScales, accessoryOffsets, accessoryRotations,
      accessoryParts, accessoryTints, activeSlot: null, dynamicAccessoryOptions,
    });
    let allCovered = true;
    const configured = new Set();
    for (const cfg of cfgs) {
      const key = stripV(cfg.url);
      configured.add(key);
      const entries = index[key];
      if (!entries) { allCovered = false; continue; }
      for (const entry of entries) {
        entry.mesh.visible = cfg.parts?.[entry.matName]?.visible !== false;
        const t = effectiveTransform(cfg.scale, cfg.offset, cfg.rotation, cfg.parts, entry.matName);
        applyAccessoryScale(entry.mesh, entry.originalPositions, entry.center, t.scale, t.offset, t.rotation);
        applyAccessoryTint(entry.mesh, cfg.parts?.[entry.matName]?.tint || cfg.tint);
      }
    }
    // A garment removed from config but still in this copy: hide it
    // immediately (honest visual now), and report uncovered so the
    // structural rebake still happens and truly deletes it.
    for (const key of Object.keys(index)) {
      if (!configured.has(key)) {
        for (const e of index[key]) e.mesh.visible = false;
        allCovered = false;
      }
    }
    return allCovered;
  }

  // The live mirror itself: every non-structural wardrobe edit lands
  // here. Mirrorable copy -> applied in place, instantly, ZERO reload,
  // and the dirty flag is left alone. No index (legacy copy) or a
  // structural gap -> fall back to marking dirty exactly as before.
  useEffect(() => {
    if (!rootRef.current) return;
    const covered = applyExploreWardrobe();
    if (exploreWardrobeIndexRef.current && covered) return;
    wardrobeDirtyRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(accessoryScales), JSON.stringify(accessoryOffsets), JSON.stringify(accessoryRotations), JSON.stringify(accessoryParts), JSON.stringify(accessoryTints)]);

  // Real side effect, worth knowing: loadModel() resets walk state,
  // current animation, and position — she'll be standing in idle again
  // after this, not wherever she was walking. Accepted tradeoff: this
  // only fires right after actually editing wardrobe, and re-dressing
  // her mid-stride was never going to look right anyway.
  //
  // ── Session 147 — PLAN A: the wardrobe config is the dressed state ─
  // The deployed GLB is now canonically BODY-ONLY (the animation-ledger
  // pipeline re-derives it from the master .blend, which never contained
  // platform accessories — Session 147's texture repair surfaced this).
  // So Explore can no longer assume its loaded copy carries garments,
  // and this bridge can no longer be edge-triggered on the mode toggle
  // alone: Explore-first must dress her too. Three changes, same proven
  // export/reload machinery underneath:
  //   1. TRIGGERS — also re-runs when the (persistently mounted, hidden)
  //      Inspect viewer finishes loading a garment (accessoryPartNames
  //      changes) and on retry ticks, not only on mode switches.
  //   2. SHORT-CIRCUITS — if the copy already on stage covers the full
  //      config (applyExploreWardrobe() true), or the config is empty
  //      and the copy has no garments, there is nothing to bake: clear
  //      dirty and stop. A body-only GLB with an empty wardrobe IS the
  //      correct dressed state.
  //   3. VERIFY, DON'T ASSUME — the hidden viewer loads garments async,
  //      so an export can race ahead of it and produce a partially
  //      dressed file. After reloading, coverage is re-checked; not
  //      covered leaves dirty set and schedules a bounded retry (the
  //      next garment finishing also retriggers naturally). Retries cap
  //      at 3 so a permanently failing garment logs loudly instead of
  //      spinning the export/reload loop forever.
  useEffect(() => {
    if (mode !== "explore") return;
    if (!wardrobeDirtyRef.current) return;
    if (exploreRebakeInFlightRef.current) return;
    if (!rootRef.current) return;
    // Copy on stage already matches config — nothing structural pending.
    if (applyExploreWardrobe()) { wardrobeDirtyRef.current = false; exploreRebakeRetriesRef.current = 0; return; }
    const cfgs = buildViewerAccessories({
      selectedAccessoryGlbUrls, accessoryScales, accessoryOffsets, accessoryRotations,
      accessoryParts, accessoryTints, activeSlot: null, dynamicAccessoryOptions,
    });
    if (cfgs.length === 0 && !exploreWardrobeIndexRef.current) {
      // Nothing configured, nothing baked in: body-only is correct.
      wardrobeDirtyRef.current = false;
      exploreRebakeRetriesRef.current = 0;
      return;
    }
    if (!exportGlbRef.current) return; // hidden viewer not ready — a later trigger retries
    if (exploreRebakeRetriesRef.current >= 3) {
      console.error("[ActorModelPanel] Explore dressed-state bake: retry cap reached — a configured garment never became exportable from the hidden viewer. Explore stays on the current copy; check earlier accessory-load errors above.");
      return;
    }
    let cancelled = false;
    // 600ms settle: garment loads arrive in a burst on first mount —
    // coalesce them into one export instead of one per garment.
    const timer = setTimeout(async () => {
      if (cancelled || exploreRebakeInFlightRef.current) return;
      exploreRebakeInFlightRef.current = true;
      const t0 = performance.now();
      try {
        // Session 141 — preserve where she is: the rebake is now rare
        // (structural changes only), and losing her position for a
        // garment swap was always collateral, never intent.
        const savedPos = holderRef.current ? holderRef.current.position.clone() : null;
        const savedRotY = holderRef.current ? holderRef.current.rotation.y : null;
        const blob = await exportGlbRef.current({ includeAccessories: true });
        const tExport = performance.now();
        if (cancelled || !blob) return;
        const file = new File([blob], "dressed.glb", { type: "model/gltf-binary" });
        await loadModel(file);
        // Session 141 — this copy came from the identity-baked dressed
        // export: garments are at baseline transform and untinted-or-
        // baked-color. Index them, then apply the CURRENT config so she
        // arrives wearing exactly what Inspect shows.
        buildExploreWardrobeIndex();
        const covered2 = applyExploreWardrobe();
        if (savedPos && holderRef.current && !cancelled) {
          holderRef.current.position.set(savedPos.x, floorYRef.current, savedPos.z);
          if (savedRotY !== null) holderRef.current.rotation.y = savedRotY;
          resolveCapsule(holderRef.current.position);
          lastGoodPositionRef.current.copy(holderRef.current.position);
        }
        const tReload = performance.now();
        // Session 147 — verify, don't assume: a partial export (hidden
        // viewer still loading) leaves dirty set and retries.
        wardrobeDirtyRef.current = !covered2;
        if (covered2) {
          exploreRebakeRetriesRef.current = 0;
        } else {
          exploreRebakeRetriesRef.current += 1;
          console.warn(`[ActorModelPanel] Explore dressed-state bake incomplete (attempt ${exploreRebakeRetriesRef.current}/3) — hidden viewer likely still loading garments; will retry.`);
        }
        console.log(`[ActorModelPanel] Explore wardrobe refresh: export ${(tExport - t0).toFixed(0)}ms (${(blob.size / 1e6).toFixed(1)}MB) + reload ${(tReload - tExport).toFixed(0)}ms = ${(tReload - t0).toFixed(0)}ms total, position preserved, covered=${covered2}.`);
      } catch (e) {
        console.error("[ActorModelPanel] Could not refresh Explore with live wardrobe edits:", e);
      } finally {
        exploreRebakeInFlightRef.current = false;
        if (!cancelled && wardrobeDirtyRef.current) setExploreRebakeTick((t) => t + 1);
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, JSON.stringify(accessoryPartNames), exploreRebakeTick]);

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
    // Session 147 — shadows: level 1, the master switch, toggled live by
    // the Display card. PCFShadowMap (PCFSoft deprecated at three 0.185;
    // runtime warning states PCF is used instead — set the replacement
    // explicitly rather than ride a deprecation fallback).
    renderer.shadowMap.enabled = displayRef.current.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.0, 0);
    controls.enableDamping = true;
    controls.update();
    controlsRef.current = controls;

    // GLBs coming off the pipeline (convert.py) are Draco-compressed. Every
    // GLTFLoader in this file shares this one decoder instance rather than
    // spinning up its own — same approach as MiniGlbViewer.jsx.
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
    dracoLoaderRef.current = dracoLoader;

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
    // Session 147 — held in refs (and initialized from the display settings
    // rather than literals) so the Display sliders can adjust them live.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444455, displayRef.current.ambientIntensity);
    scene.add(hemi);
    hemiLightRef.current = hemi;
    const key = new THREE.DirectionalLight(0xffffff, displayRef.current.keyIntensity);
    key.position.set(1.5, 2.5, 2.0);
    // Session 147 — level 2: ONLY the key casts (a second shadow from
    // the rim double-shadows everything and reads as a lighting bug).
    // Frustum sized to a domestic room; 1024 map is the fps-friendly
    // choice. Session 147 same night: frustum tightened ±5 → ±4 (room
    // fits inside ±4, more texels/cm) and normalBias added — "stripes
    // on the skin" reported live = shadow acne on curved skinned
    // surfaces, worst at grazing sun angles; normalBias is the
    // purpose-built fix.
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
    scene.add(key);
    keyLightRef.current = key;
    const rim = new THREE.DirectionalLight(0xaaccff, displayRef.current.rimIntensity);
    rim.position.set(-2, 1.5, -2);
    scene.add(rim);
    rimLightRef.current = rim;

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
    // Window blur only catches leaving the page. Clicking a select or a slider
    // inside the panel keeps the window focused while onKeyDown starts ignoring
    // keys, so anything held at that moment is latched with no way to release
    // it. Clearing on focus change covers the case window blur cannot see.
    const onFocusIn = (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        keysRef.current.clear();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("focusin", onFocusIn);

    let frames = 0;
    let acc = 0;
    let poseAcc = 0;

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      // Session 147 - Timer separates sampling from reading: update()
      // once per frame, then getDelta().
      if (!timerRef.current) timerRef.current = new THREE.Timer();
      timerRef.current.update();
      const delta = timerRef.current.getDelta();

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

      // Ease the feet on roughly the same curve as the crossfade blends the
      // pose, and write it every frame so a room load or a holder.position.set
      // elsewhere cannot silently drop the correction.
      if (holderRef.current) {
        const g = groundRef.current;
        const diff = g.target - g.applied;
        if (Math.abs(diff) > 1e-5) {
          g.applied += diff * (1 - Math.exp(-delta / 0.06));
        } else {
          g.applied = g.target;
        }
        holderRef.current.position.y = floorYRef.current + g.applied;
      }

      // OrbitControls.enabled only gates input. update() still runs, and it
      // ends with object.lookAt(target) — which in first person overwrites the
      // pointer-lock orientation every frame and pins the view to the room
      // centre. Mouse look cannot survive it, so it does not run in FPV.
      if (!fpvRef.current) controls.update();

      renderer.render(scene, camera);

      // After render, so bones[].matrixWorld is current for this frame. Twice a
      // second is enough to read while a clip plays and cheap enough to leave on.
      poseAcc += delta;
      if (poseAcc >= 0.5) {
        poseAcc = 0;
        setWalkDebug(walkDebugRef.current);
        if (holderRef.current) {
          const posed = measurePosedBounds(holderRef.current);
          if (posed) {
            setPosedInfo({
              height: posed.height,
              topY: posed.maxY,
              feetY: posed.minY,
              sampled: posed.sampled,
              skinnedMeshes: posed.skinnedMeshes,
            });
          }
        }
      }

      frames += 1;
      acc += delta;
      if (acc >= 1) {
        setFps(Math.round(frames / acc));
        frames = 0;
        acc = 0;
        if (holderRef.current) {
          setHolderXZ({ x: holderRef.current.position.x, z: holderRef.current.position.z });
        }
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
      document.removeEventListener("focusin", onFocusIn);
      cancelAnimationFrame(frameRef.current);
      if (mixerRef.current) mixerRef.current.stopAllAction();
      if (rootRef.current) VRMUtils.deepDispose(rootRef.current);
      envRT.dispose();
      controls.dispose();
      dracoLoader.dispose();
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
        floorYRef.current + TARGET_HEIGHT * 0.85,
        (b.minZ + b.maxZ) / 2
      );
      controls.update();
    }
  }, [fpv]);

  useEffect(() => {
    showSkeletonRef.current = showSkeleton;
    if (skeletonHelperRef.current) skeletonHelperRef.current.visible = showSkeleton;
  }, [showSkeleton]);

  // Session 147 — apply Display settings live. Sun direction: azimuth/
  // elevation → position on a sphere of the original hardcoded radius
  // (3.536; defaults 37°/45° reproduce the old (1.5, 2.5, 2.0) exactly).
  // environmentIntensity: three r163+ (0.185 here). Shadow flips touch
  // every material once per toggle — three only recompiles on
  // material.needsUpdate.
  const envIntensityUnsupportedRef = useRef(false);
  const shadowsWereRef = useRef(null);
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.toneMappingExposure = display.exposure;
      if (shadowsWereRef.current !== display.shadows) {
        shadowsWereRef.current = display.shadows;
        rendererRef.current.shadowMap.enabled = display.shadows;
        const scene0 = sceneRef.current;
        if (scene0) scene0.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
        });
      }
    }
    if (hemiLightRef.current) hemiLightRef.current.intensity = display.ambientIntensity;
    if (keyLightRef.current) {
      keyLightRef.current.intensity = display.keyIntensity;
      const R = 3.536;
      const az = (display.sunAzimuth * Math.PI) / 180;
      const el = (display.sunElevation * Math.PI) / 180;
      keyLightRef.current.position.set(
        R * Math.cos(el) * Math.sin(az),
        R * Math.sin(el),
        R * Math.cos(el) * Math.cos(az),
      );
    }
    if (rimLightRef.current) rimLightRef.current.intensity = display.rimIntensity;
    const scene = sceneRef.current;
    if (scene) {
      if ("environmentIntensity" in scene) {
        scene.environmentIntensity = display.envIntensity;
      } else if (!envIntensityUnsupportedRef.current) {
        envIntensityUnsupportedRef.current = true;
        console.error("[ActorModelPanel] scene.environmentIntensity not supported by this three.js build — Environment slider inert. Upgrade three (r163+) or wire a PMREM re-render.");
      }
    }
  }, [display]);

  // Session 147 — persistence, two tiers: localStorage immediately,
  // DB preferences debounced 800ms (exploreDisplay namespace; server
  // merges top-level so other namespaces are untouched).
  useEffect(() => {
    try { localStorage.setItem("anima_explore_display", JSON.stringify(display)); }
    catch (e) { console.warn("[ActorModelPanel] could not write display settings to localStorage:", e); }
    if (displayPrefsSaveTimerRef.current) clearTimeout(displayPrefsSaveTimerRef.current);
    displayPrefsSaveTimerRef.current = setTimeout(async () => {
      try {
        const resp = await fetch("/api/me/preferences", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preferences: { exploreDisplay: display } }),
        });
        if (!resp.ok) throw new Error(`save failed (${resp.status})`);
      } catch (e) {
        console.error("[ActorModelPanel] display preferences DB save failed (localStorage copy still applied):", e);
      }
    }, 800);
    return () => { if (displayPrefsSaveTimerRef.current) clearTimeout(displayPrefsSaveTimerRef.current); };
  }, [display]);

  // Session 147 — on mount, the DB copy wins over localStorage.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/me/preferences");
        if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
        const data = await resp.json();
        const stored = data?.preferences?.exploreDisplay;
        if (!cancelled && stored && typeof stored === "object") {
          setDisplay({ ...EXPLORE_DISPLAY_DEFAULTS, ...stored });
        }
      } catch (e) {
        console.warn("[ActorModelPanel] could not load display preferences from DB (using localStorage/defaults):", e);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Session 118 — leaving Explore via the Inspect tab button wasn't
  // covered by the existing onBlur/onFocusIn key-clearing (a <button>
  // isn't INPUT/TEXTAREA/SELECT, and the window never loses focus for
  // an in-page tab click). Explicit and unambiguous instead of relying
  // on focus-event tag matching: any key still "held" the moment she
  // leaves Explore is stale, full stop.
  useEffect(() => {
    if (mode !== "explore") keysRef.current.clear();
  }, [mode]);

  // Session 107 — explore auto-engages locomotion the moment roles are
  // known (embedded idle/walk clips detected on actor load); inspect
  // returns to stillness and third person for calibration work.
  useEffect(() => {
    if (mode === "explore") {
      if (roles?.idle || roles?.walk) setWalkMode(true);
    } else {
      setWalkMode(false);
      setFpv(false);
    }
  }, [mode, roles]);

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
    // Same per-clip floor correction as play(). Without it the state machine
    // reintroduces the float every time it crosses between idle and walk,
    // which on Frida's clips is a 7.3cm step.
    groundForClip(name, action);
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
    const fpvSpeed = PLAYER_SPEED * (running ? 2 : 1);
    move.normalize().multiplyScalar(fpvSpeed * delta);

    // Session 132 — move optimistically, then resolve, same pattern as
    // stepLocomotion/stepWander.
    const preResolveX = camera.position.x, preResolveZ = camera.position.z;
    camera.position.add(move);
    const fpvResolveResult = resolveCapsule(camera.position);
    const fpvCorrectionDist = Math.hypot(camera.position.x - preResolveX - move.x, camera.position.z - preResolveZ - move.z);
    if (fpvCorrectionDist > 0.01 && performance.now() - correctionLogRef.current > 300) {
      correctionLogRef.current = performance.now();
      console.log(`[ActorModelPanel] (FPV camera) resolveCapsule corrected ${fpvCorrectionDist.toFixed(3)}m against [${fpvResolveResult.hitNames.join(", ")}].`);
    }

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

    // Session 132 — move optimistically, then resolve, same pattern as
    // stepLocomotion.
    const step = to.clone().multiplyScalar(st.speed * delta);
    const beforeX = holder.position.x, beforeZ = holder.position.z;
    holder.position.add(step);
    const preResolveX = holder.position.x, preResolveZ = holder.position.z;
    const wanderResolveResult = resolveCapsule(holder.position);
    const wanderCorrectionDist = Math.hypot(holder.position.x - preResolveX, holder.position.z - preResolveZ);
    if (wanderCorrectionDist > 0.01 && performance.now() - correctionLogRef.current > 300) {
      correctionLogRef.current = performance.now();
      console.log(`[ActorModelPanel] (wander) resolveCapsule corrected ${wanderCorrectionDist.toFixed(3)}m against [${wanderResolveResult.hitNames.join(", ")}].`);
    }
    const netDx = holder.position.x - beforeX;
    const netDz = holder.position.z - beforeZ;

    // Pressed against something with nowhere to go — pick somewhere
    // else rather than grinding into it.
    if (netDx * netDx + netDz * netDz < step.lengthSq() * 0.05) {
      w.target = null;
      w.waitUntil = now + 500;
      return false;
    }

    // Session 133 — Magnus: "swimming in the sofa... collision is not
    // working." Removed the clampOutsideExclusions call that used to
    // run here. resolveCapsule (above) now checks real geometry every
    // frame — the exclusion-zone box this called was always an
    // approximation from a grid scan, built specifically because the
    // OLD raycast collision couldn't reliably catch a round table.
    // That's no longer true. Running both every frame meant two
    // independent systems correcting her position each frame, and
    // when they disagreed about exactly where a boundary was (likely,
    // since one checks actual triangles and the other checks a coarse
    // scanned box), they fought each other — capsule pushes out based
    // on real geometry, box clamp pulls back based on its own less
    // precise boundary, repeat every frame. That's what "swimming"
    // looks like. The exclusion-zone system itself stays intact for
    // spawn-time placement (a one-time check, not a per-frame fight),
    // just not run alongside resolveCapsule during movement anymore.

    // Session 132 — this referenced an undefined `target` variable
    // before (pre-existing, not from tonight's changes) — would have
    // thrown ReferenceError any time this path actually ran. Computed
    // properly now, same pattern as stepLocomotion's rotation code.
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
      walkDebugRef.current = { moving, running: false, want, current: st.current };
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
    if (!moving) stuckRef.current.since = 0;

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
        const desiredLenSq = step.lengthSq();

        // Session 132 — move optimistically, then resolve. resolveCapsule
        // mutates holder.position in place, pushing it directly out of
        // whatever it actually overlaps after the move — real geometric
        // correction against actual triangles, not a pre-move distance
        // check against a handful of sampled directions.
        const beforeX = holder.position.x, beforeZ = holder.position.z;
        holder.position.add(step);
        const preResolveX = holder.position.x, preResolveZ = holder.position.z;
        const resolveResult = resolveCapsule(holder.position);
        const correctionDist = Math.hypot(holder.position.x - preResolveX, holder.position.z - preResolveZ);
        if (correctionDist > 0.01 && performance.now() - correctionLogRef.current > 300) {
          correctionLogRef.current = performance.now();
          console.log(`[ActorModelPanel] resolveCapsule corrected ${correctionDist.toFixed(3)}m against [${resolveResult.hitNames.join(", ")}] (merged BVH, ${colliderRef.current ? colliderRef.current.triangles.toFixed(0) : 0} triangles).`);
        }
        const netDx = holder.position.x - beforeX;
        const netDz = holder.position.z - beforeZ;
        const netMovedSq = netDx * netDx + netDz * netDz;

        // Stuck now means exactly what it sounds like: real input, but
        // she barely moved (net, after the full resolve) — no more
        // reasoning about pre-move wall-distance readings. Threshold
        // (5% of intended) is a reasonable starting point, not
        // something validated against real data yet — if genuine
        // sliding-along-a-surface movement ever mistakenly trips this,
        // that's the number to revisit first.
        if (desiredLenSq > 1e-6 && netMovedSq < desiredLenSq * 0.05) {
          const now = performance.now();
          if (stuckRef.current.since === 0) stuckRef.current.since = now;
          const stuckFor = now - stuckRef.current.since;
          if (now - stuckRef.current.lastLog > 500) {
            stuckRef.current.lastLog = now;
            console.log(`[ActorModelPanel] Blocked ${stuckFor.toFixed(0)}ms — intended step ${Math.sqrt(desiredLenSq).toFixed(3)}m, actual net movement ${Math.sqrt(netMovedSq).toFixed(3)}m.`);
          }
          if (stuckFor > 2000) {
            // Genuinely stuck for 2 full seconds despite active input —
            // same safety net as before: return to the last spot she
            // was actually free to move from.
            holder.position.copy(lastGoodPositionRef.current);
            stuckRef.current.since = 0;
            console.warn(`[ActorModelPanel] Stuck for ${stuckFor.toFixed(0)}ms with no real progress — returned to last free position (${lastGoodPositionRef.current.x.toFixed(2)}, ${lastGoodPositionRef.current.z.toFixed(2)}).`);
          }
        } else {
          stuckRef.current.since = 0;
          lastGoodPositionRef.current.copy(holder.position);
        }

        // Session 133 — removed clampOutsideExclusions here, same
        // reasoning as stepWander above: resolveCapsule already
        // checked real geometry a few lines up, running the
        // approximate exclusion-zone box on top of it every frame was
        // producing the "swimming" effect from the two systems
        // disagreeing and fighting each other.

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

    walkDebugRef.current = { moving, running, want, current: st.current };

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
        floorYRef.current + TARGET_HEIGHT * 0.85,
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
  // Session 132 — replaces probeWalls + slide + STOP_DISTANCE + the
  // fan/height-probe system entirely. Established pattern, not another
  // hand-rolled variant: three-mesh-bvh's own reference character-
  // movement example. Represent her as a CAPSULE (a vertical line
  // segment + radius, not a point firing rays in a few directions),
  // and use shapecast to find the true closest-point distance from
  // that segment to every nearby triangle. Where a triangle actually
  // penetrates the capsule, push the capsule directly away from it by
  // the exact penetration depth. This is real geometric collision, not
  // an approximation built from sampled directions — no angle gaps
  // (the round tables), no height gaps (any furniture height, all at
  // once, continuously, not five sampled heights), and no manual
  // distance-margin tuning to guess at tunneling risk, since this
  // resolves actual overlap rather than "did a ray happen to hit
  // something within some safety margin taken up to 70ms ago."
  //
  // Different call pattern from the old slide(): that checked distances
  // BEFORE moving and zeroed components that would cross a threshold.
  // This applies the full desired movement optimistically, then
  // corrects — push the capsule out of whatever it actually ends up
  // overlapping. That's what the reference pattern does, and it's what
  // makes tunneling a non-issue: there's no "was the reading stale"
  // window, because this checks real overlap at the actual final
  // position, every frame, not a cached reading from up to 70ms ago.
  //
  // position: {x, z} — mutated in place with the resolved position.
  // Returns the correction applied, {x, z}, so callers can tell how
  // much (if any) she got pushed and detect a genuine stuck state from
  // "intended movement vs. actual resulting movement" instead of wall-
  // distance readings.
  // Session 138 — Magnus: "can't access the hall... bathroom not
  // accessible... got into the hall, can't get back." Direct
  // consequence of the scale fix actually working: door frames and
  // threshold geometry that were invisible to collision before are now
  // properly detected, and doorways are the tightest passages in any
  // room. At 0.3m radius (0.6m diameter), she had zero to minimal
  // margin against a tight bathroom/hallway door — real interior doors
  // in a compact studio apartment are often only 0.6-0.7m clear width.
  // "Got in, can't get back" is a strong tell too: consistent with a
  // passage that barely, inconsistently fits her one direction but not
  // reliably both. Reduced to a closer match for actual shoulder width
  // (~0.44m diameter), leaving real margin for tight doorways while
  // still catching genuine wall/furniture overlap — the fix was never
  // about needing a wide berth, just not clipping through anything.
  const CAPSULE_RADIUS = 0.22; // metres — her rough body radius
  // Session 140 — was 0.1, i.e. BELOW the radius: the capsule's bottom
  // sphere reached 0.12m below floor level, permanently penetrating
  // the floor slab. That's what the "60 corrections, all against
  // floor_Material_#57_0, 1–3cm" log from Session 137 actually was —
  // not benign contact resolution but a fight re-fought every frame
  // (Y-corrections are discarded, so the capsule respawned inside the
  // floor each call). Wasted work in open floor; at a doorway, floor
  // triangles meeting the threshold push at oblique angles and pollute
  // the resolution right where the passage is tightest. The reference
  // example keeps the capsule fully above ground; the invariant is
  // CAPSULE_BOTTOM >= CAPSULE_RADIUS. 0.25 leaves 3cm of ground
  // clearance — thresholds and rugs are stepped over, anything taller
  // than 3cm still collides.
  const CAPSULE_BOTTOM = 0.25; // metres above floor — MUST be >= CAPSULE_RADIUS
  const CAPSULE_TOP = 1.5;    // metres above floor — spans essentially her whole body

  const _capSegment = new THREE.Line3();
  const _capBox = new THREE.Box3();
  const _triPoint = new THREE.Vector3();
  const _capPoint = new THREE.Vector3();
  const _pushDir = new THREE.Vector3();

  // Session 140 — rewritten to match the reference example exactly:
  // ONE shapecast against ONE merged, world-space BVH (built at room
  // load, see loadRoom). Everything below happens in world metres —
  // no per-mesh matrix inversion, no local-space radius, no scale
  // compensation (Session 137's fix is now unnecessary by
  // construction: StaticGeometryGenerator bakes every matrixWorld,
  // including that 0.0103 baked scale, into the merged vertices at
  // build time). No RESOLVE_ITERATIONS either (Session 139's
  // compensation): the oscillation it papered over came from fully
  // resolving against mesh A before looking at mesh B — with one BVH
  // there is no mesh ordering, the single traversal resolves the
  // capsule cumulatively against every nearby triangle (a doorway's
  // left frame AND right frame in the same pass), which is precisely
  // why the reference merges in the first place.
  //
  // position: {x, z} — mutated in place with the resolved position.
  // Y-corrections are computed (they keep push directions honest) but
  // deliberately not written back — floor contact is owned by the
  // existing grounding path, same division of labour as before.
  function resolveCapsule(position) {
    const collider = colliderRef.current;
    if (!collider) return { x: 0, z: 0, hitNames: [] };

    const startX = position.x, startZ = position.z;
    _capSegment.start.set(position.x, floorYRef.current + CAPSULE_BOTTOM, position.z);
    _capSegment.end.set(position.x, floorYRef.current + CAPSULE_TOP, position.z);

    _capBox.makeEmpty();
    _capBox.expandByPoint(_capSegment.start);
    _capBox.expandByPoint(_capSegment.end);
    _capBox.min.addScalar(-CAPSULE_RADIUS);
    _capBox.max.addScalar(CAPSULE_RADIUS);

    // Diagnostic only: hit points collected during the cast, matched
    // to source-mesh names afterwards via their world boxes — the
    // merged buffer itself is anonymous. Kept out of the hot callback
    // beyond a cheap push.
    const hitPoints = [];

    collider.geometry.boundsTree.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_capBox),
      intersectsTriangle: (tri) => {
        const distance = tri.closestPointToSegment(_capSegment, _triPoint, _capPoint);
        if (distance < CAPSULE_RADIUS) {
          const depth = CAPSULE_RADIUS - distance;
          _pushDir.copy(_capPoint).sub(_triPoint);
          // Degenerate: centre-line exactly touches the triangle,
          // push direction undefined — skip rather than push nowhere.
          if (_pushDir.lengthSq() < 1e-10) return false;
          _pushDir.normalize();
          _capSegment.start.addScaledVector(_pushDir, depth);
          _capSegment.end.addScaledVector(_pushDir, depth);
          hitPoints.push(_triPoint.clone());
        }
        return false;
      },
    });

    position.x = _capSegment.start.x;
    position.z = _capSegment.start.z;

    const hitNames = [];
    if (hitPoints.length) {
      const nameBoxes = collisionNameBoxesRef.current;
      const seen = new Set();
      for (const p of hitPoints) {
        for (const nb of nameBoxes) {
          if (!seen.has(nb.name) && nb.box.containsPoint(p)) {
            seen.add(nb.name);
            hitNames.push(nb.name);
            break;
          }
        }
      }
      if (!hitNames.length) hitNames.push("(merged room geometry)");
    }

    return { x: _capSegment.start.x - startX, z: _capSegment.start.z - startZ, hitNames };
  }

  // Session 114 — the circle-from-one-assumed-centre-point approach
  // (Session 113) missed the real edge: it assumed the room's
  // geometric centre sits exactly ON the table and radiated outward
  // from there. If the table's actual centre is even slightly offset
  // from that point — near-certain, since "room bounding-box centre"
  // and "where the coffee table sits" are two unrelated numbers that
  // happen to be close — the circle is centred wrong and simply
  // doesn't reach the true edge on that side. Replaced with axis-
  // aligned boxes built from an actual grid scan (see room-load below)
  // instead of a guessed radius from one point. Push out to the
  // NEAREST box edge if she ends up inside one — same "doesn't care how
  // she got there" backstop as before, just a shape that matches
  // reality instead of an assumption.
  function clampOutsideExclusions(position) {
    for (const zone of furnitureExclusionsRef.current) {
      if (position.x <= zone.minX || position.x >= zone.maxX) continue;
      if (position.z <= zone.minZ || position.z >= zone.maxZ) continue;
      const dLeft = position.x - zone.minX;
      const dRight = zone.maxX - position.x;
      const dBack = position.z - zone.minZ;
      const dFront = zone.maxZ - position.z;
      const minD = Math.min(dLeft, dRight, dBack, dFront);
      if (minD === dLeft) position.x = zone.minX;
      else if (minD === dRight) position.x = zone.maxX;
      else if (minD === dBack) position.z = zone.minZ;
      else position.z = zone.maxZ;
    }
    return position;
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
      const roomLoader = new GLTFLoader();
      if (dracoLoaderRef.current) roomLoader.setDRACOLoader(dracoLoaderRef.current);
      const gltf = await roomLoader.loadAsync(trackUrl(file));
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
      // Session 147 - Option A (ruled by Magnus): archviz home GLBs ship
      // every material as KHR_materials_unlit (studio_apartment.glb:
      // 59/59 confirmed by direct JSON-chunk inspection), which three
      // imports as MeshBasicMaterial - ignores lights, ignores the
      // environment, CANNOT receive shadows. Rebuild each unlit material
      // as MeshStandardMaterial carrying the baked texture/color forward
      // (roughness 1, metalness 0). Lit materials pass through.
      let convertedMats = 0;
      const matCache = new Map(); // shared materials stay shared
      root.traverse((o) => {
        if (o.isMesh && o.geometry) {
          const g = o.geometry;
          triangles += g.index
            ? g.index.count / 3
            : (g.attributes.position?.count ?? 0) / 3;
          const convert = (m) => {
            if (!m || !m.isMeshBasicMaterial) return m;
            if (matCache.has(m)) return matCache.get(m);
            const std = new THREE.MeshStandardMaterial({
              name: m.name,
              map: m.map ?? null,
              color: m.color.clone(),
              roughness: 1,
              metalness: 0,
              transparent: m.transparent,
              opacity: m.opacity,
              alphaTest: m.alphaTest,
              side: m.side,
              depthWrite: m.depthWrite,
            });
            matCache.set(m, std);
            convertedMats++;
            return std;
          };
          o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
          // Session 147 - level 3: room receives and casts. Inert while
          // the Display toggle is off.
          o.receiveShadow = true;
          o.castShadow = true;
        }
      });
      if (convertedMats > 0) {
        console.log(`[ActorModelPanel] Room materials: ${convertedMats} unlit (MeshBasicMaterial) converted to lit MeshStandardMaterial - shadows and Display lighting now apply to the room.`);
      }

      scene.add(root);
      roomRef.current = root;

      // Session 140 — ONE merged world-space BVH via
      // StaticGeometryGenerator, exactly like the reference example,
      // replacing Session 132's one-BVH-per-mesh set (see the
      // colliderRef declaration comment for the full why + the export
      // confirmation that unblocked this). Built once here, not per
      // frame. The generator bakes each mesh's full matrixWorld into
      // the output vertices — the 0.0103 3ds-Max scale included — so
      // the merged geometry is in true world metres and resolveCapsule
      // runs entirely in world space with no per-mesh compensation.
      // Build AFTER the grounding shift above (root.position.y already
      // adjusted, matrixWorld already updated) — the baked transforms
      // must match where the room actually renders.
      //
      // Session 134's skip-tiny-meshes filter kept, with a fix: it
      // measured footprint in LOCAL space, which the Session 137 scale
      // discovery retroactively broke — a 0.0103-scale mesh's local
      // footprint is ~100x its real size, so scaled-down small clutter
      // was never skipped and true-scale small items could be skipped
      // wrongly. Measured in world space now (setFromObject accounts
      // for matrixWorld).
      //
      // Session 136's skinned/morph/instanced warnings kept: those
      // mesh types are excluded from the merge input (same behaviour
      // as before — none exist in the current room, confirmed then).
      const bvhStart = performance.now();
      const collisionInputMeshes = [];
      const collisionNameBoxes = [];
      let skippedCount = 0;
      const _meshBox = new THREE.Box3();
      root.traverse((child) => {
        if (child.isMesh && child.geometry?.attributes?.position) {
          if (child.isSkinnedMesh || child.morphTargetInfluences?.length || child.isInstancedMesh) {
            console.warn(`[ActorModelPanel] "${child.name || "(unnamed)"}" is skinned/morphed/instanced — excluded from static collision geometry.`);
            return;
          }
          _meshBox.setFromObject(child);
          const size = _meshBox.getSize(new THREE.Vector3());
          const footprint = Math.max(size.x, size.z);
          if (footprint < 0.15) {
            skippedCount += 1;
            return;
          }
          collisionInputMeshes.push(child);
          // Diagnostic name index for resolveCapsule's correction log
          // (the merged buffer has no names). Expanded slightly so a
          // contact point ON a surface still tests as contained.
          collisionNameBoxes.push({
            name: child.name || "(unnamed mesh)",
            box: _meshBox.clone().expandByScalar(0.02),
          });
        }
      });
      try {
        const staticGenerator = new StaticGeometryGenerator(collisionInputMeshes);
        staticGenerator.attributes = ["position"];
        const mergedGeometry = staticGenerator.generate();
        mergedGeometry.boundsTree = new MeshBVH(mergedGeometry);
        colliderRef.current = {
          geometry: mergedGeometry,
          triangles: mergedGeometry.index
            ? mergedGeometry.index.count / 3
            : mergedGeometry.attributes.position.count / 3,
        };
        collisionNameBoxesRef.current = collisionNameBoxes;
        const bvhMs = performance.now() - bvhStart;
        console.log(`[ActorModelPanel] Built ONE merged collision BVH: ${collisionInputMeshes.length} mesh(es) merged (${skippedCount} skipped as too small to matter), ${colliderRef.current.triangles.toFixed(0)} triangles, in ${bvhMs.toFixed(0)}ms.`);
        console.log(`[ActorModelPanel] Collision mesh names: ${collisionNameBoxes.map((nb) => nb.name).join(", ")}`);
      } catch (e) {
        // Crash loudly, not silently: no collider means Explore has NO
        // collision at all. Make that impossible to miss.
        colliderRef.current = null;
        collisionNameBoxesRef.current = [];
        console.error("[ActorModelPanel] FAILED to build merged collision BVH — Explore mode has NO collision:", e);
      }

      // Session 136 — the mesh IS present, built, and structurally
      // normal (no skinning/morphs/instancing) — yet never triggers a
      // correction. That rules out "missing geometry" and points at a
      // coordinate mismatch instead: mesh.matrixWorld saying the
      // geometry is somewhere different from where it's actually
      // rendered. The mesh-name convention here (_Material_#52_0 style,
      // hash-prefixed material IDs) is a strong 3ds Max signature — a
      // very common source of exactly this kind of bug (pivot-point
      // offsets, coordinate-system conversion during export). Log the
      // TRUE world-space bounding box (setFromObject accounts for
      // matrixWorld correctly) for furniture specifically, so it's
      // directly comparable against the room centre (0.13, 0.23) and
      // wherever she's actually ending up — if these don't line up
      // with where the furniture visibly sits on screen, that confirms
      // the mismatch directly rather than inferring it.
      // (Session 140 — reads the world boxes already computed for the
      // name index above; identical output to before.)
      const furnitureKeywords = ["table", "divan", "armchair", "chair", "stul", "stolik"];
      collisionNameBoxes.forEach((nb) => {
        const lname = nb.name.toLowerCase();
        if (furnitureKeywords.some((kw) => lname.includes(kw))) {
          const c = nb.box.getCenter(new THREE.Vector3());
          const s = nb.box.getSize(new THREE.Vector3());
          console.log(`[ActorModelPanel] "${nb.name}" world bounds: centre=(${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}) size=(${s.x.toFixed(2)}, ${s.y.toFixed(2)}, ${s.z.toFixed(2)}).`);
        }
      });

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

      // Session 112 — SAD's own Open Thread #5: "holder seats at room
      // centre = on the studio's coffee table; use measured clear
      // floor." The room's geometric centre is exactly where a coffee
      // table typically sits, so probing straight down from there hits
      // the tabletop, not the floor — and both the floor-height
      // calibration AND her spawn point inherited that wrong, elevated
      // reading, standing her on the table. A real floor slab is a few
      // cm thick; if the hit sits noticeably higher than the slab's
      // measured underside, it's furniture, not floor. Ring-search
      // outward from centre for a point that reads as genuine bare
      // floor instead of trusting centre blindly.
      function probeFloorAt(x, z) {
        ray.set(new THREE.Vector3(x, grounded.min.y + 1.3, z), new THREE.Vector3(0, -1, 0));
        const hits = ray.intersectObject(root, true);
        return hits.length ? hits[0].point.y : null;
      }

      // Session 116 — was 0.3m. Console data from a real failed room:
      // the coffee table read at 0.22m above the slab underside and
      // was STILL classified as "clear floor" because 0.22 < 0.3 — the
      // margin was simply too generous, letting a real obstacle read
      // as floor. A genuine slab is a few cm thick; there was never a
      // reason for 0.3m. Tightened to catch this exact case with room
      // to spare.
      const CLEAR_FLOOR_MARGIN = 0.12; // metres — is this point FURNITURE (exclusion zone)?
      // Session 124 — Magnus: "she did start at the right position
      // before you started to fix the table collision detection."
      // Traced it: tightening CLEAR_FLOOR_MARGIN above was necessary
      // to correctly flag the table (0.22 was slipping past the old
      // 0.3), but that same tight number was ALSO gating the ring
      // search's fallback spawn candidates below — so a rug edge, a
      // threshold, a slight slope, anything with a little legitimate
      // elevation that's completely fine to stand on, started failing
      // that check too, when it used to pass under the looser 0.3.
      // "Is this furniture?" and "is this an acceptable place to
      // stand?" are different questions and never should have shared
      // one number. This one is deliberately the old, looser value —
      // only for judging spawn-candidate acceptability, never for
      // furniture detection.
      const SPAWN_ACCEPTABLE_MARGIN = 0.3; // metres — is this point OK TO STAND ON (spawn fallback)?
      furnitureExclusionsRef.current = [];
      let spawnX = centre.x;
      let spawnZ = centre.z;
      let floorY = probeFloorAt(spawnX, spawnZ);
      const centreIsFurniture = floorY !== null && floorY - grounded.min.y > CLEAR_FLOOR_MARGIN;
      console.log(`[ActorModelPanel] Room load: centre=(${centre.x.toFixed(2)}, ${centre.z.toFixed(2)}), slab underside=${grounded.min.y.toFixed(2)}, centre probe hit y=${floorY === null ? "none" : floorY.toFixed(2)} → centreIsFurniture=${centreIsFurniture}.`);

      // Session 118 — known-good spawn point, if this room has one
      // (see KNOWN_ROOM_SPAWNS above). This ONLY replaces where she
      // starts — real detection below still always runs regardless,
      // because it's also what builds the exclusion zone that protects
      // her from walking INTO the table later, not just at spawn.
      // Skipping detection entirely for known rooms would have quietly
      // dropped that protection too.
      const known = KNOWN_ROOM_SPAWNS[file.name];
      if (known) {
        spawnX = known.x;
        spawnZ = known.z;
        floorY = probeFloorAt(spawnX, spawnZ) ?? floorY;
        console.log(`[ActorModelPanel] Room load: using known spawn point for "${file.name}": (${spawnX.toFixed(2)}, ${spawnZ.toFixed(2)}).`);
      }

      if (centreIsFurniture) {
        // Session 123 — the registered box's edges landed EXACTLY on
        // the old 1.6m scan boundary on all four sides (verified: box
        // minus BODY_RADIUS matches the scan window to the metre). A
        // real furniture edge doesn't coincidentally align with an
        // arbitrary scan radius on every side at once — this meant the
        // scan was hitting its own limit before ever finding genuine
        // clear floor, not that the room is furniture everywhere.
        // Extended both searches so they have a real chance of
        // reaching past a large furniture cluster instead of giving up
        // at an arbitrary distance.
        const ringRadii = [0.8, 1.4, 2.0, 2.6, 3.2];
        const ringAngles = [0, 45, 90, 135, 180, 225, 270, 315].map((d) => (d * Math.PI) / 180);
        // Session 125 — Magnus: "she starts half ways into the wall on
        // the opposite side." Real gap, distinct from every furniture
        // fix so far: probeFloorAt only ever checks vertical floor
        // elevation. Nothing about "is this point too close to a wall"
        // was ever checked for ring-search candidates — the floor right
        // at a wall's base usually reads perfectly flat, so a candidate
        // could pass the elevation test while sitting half inside a
        // wall. The 0.4m bounding-box inset only guards the room's
        // OUTER perimeter; it has no idea an interior wall (like the
        // one that TV is mounted on) exists at all. probeWalls already
        // does real horizontal collision detection for movement — it
        // was just never used to validate a spawn candidate. It needs
        // floorYRef.current for its probe heights, which isn't finalized
        // until after this whole block; seed it with a working estimate
        // now so probeWalls behaves sanely here, and it gets overwritten
        // with the real value below regardless.
        floorYRef.current = grounded.min.y + 0.1;
        let found = false;
        for (const r of ringRadii) {
          for (const a of ringAngles) {
            const x = centre.x + Math.cos(a) * r;
            const z = centre.z + Math.sin(a) * r;
            if (x < grounded.min.x + 0.4 || x > grounded.max.x - 0.4) continue;
            if (z < grounded.min.z + 0.4 || z > grounded.max.z - 0.4) continue;
            const y = probeFloorAt(x, z);
            if (y === null || y - grounded.min.y > SPAWN_ACCEPTABLE_MARGIN) continue;
            // Session 132 — probeWalls no longer exists (replaced by
            // resolveCapsule). Same idea: place a capsule at this
            // candidate and see how far it needs pushing to clear real
            // geometry. Near-zero correction means genuinely clear;
            // anything more means it's overlapping something even
            // though the floor read fine.
            const candidatePos = { x, z };
            const candidateCorrection = resolveCapsule(candidatePos);
            const candidateCorrectionDist = Math.hypot(candidateCorrection.x, candidateCorrection.z);
            if (candidateCorrectionDist > 0.05) continue; // flat floor, but overlapping something real
            // Only actually adopt this as the spawn point if we don't
            // already have a known-good one — the search still runs
            // (cheap, and logged) so the console output stays useful
            // for confirming/updating a KNOWN_ROOM_SPAWNS entry.
            if (!known) { spawnX = x; spawnZ = z; floorY = y; }
            found = true;
            break;
          }
          if (found) break;
        }
        if (!found && !known) {
          console.warn("[ActorModelPanel] No clear floor found near room centre (checked centre + a ring of fallback points) — spawning at centre anyway, she may appear on furniture.");
          floorY = floorY ?? 0;
        }

        // Session 114 — the previous version (Session 113) radiated
        // outward from centre.x/centre.z assuming that point sits
        // exactly on the obstacle's own centre, and built a circle from
        // that guessed radius. Found live: it missed the real edge —
        // the room's geometric centre and the table's actual centre
        // are two different points that only happen to be close, so a
        // circle centred on the wrong point doesn't reach the true edge
        // on whichever side is offset. Fixed properly: grid-scan the
        // actual area, find every point that genuinely reads as
        // furniture, and build the exclusion box from THAT extent —
        // not a guessed shape from one point.
        //
        // Session 123 — SCAN_HALF widened 1.6 → 3.2m (see note above);
        // also added the same room-bounds check the ring-search already
        // had, which this scan was missing — without it, points beyond
        // the room's actual walls could get sampled and misread as
        // furniture (or as an inconclusive null, now correctly ignored
        // either way, but still wasted a sample). One-time cost at room
        // load only, never per-frame.
        const SCAN_HALF = 3.2; // metres — half-width of the area to scan around centre
        const SCAN_STEP = 0.2; // widened alongside SCAN_HALF to keep the ray count reasonable
        let minFx = Infinity, maxFx = -Infinity, minFz = Infinity, maxFz = -Infinity;
        let anyFurniture = false;
        let scanHitOwnBoundary = false;
        for (let dx = -SCAN_HALF; dx <= SCAN_HALF; dx += SCAN_STEP) {
          for (let dz = -SCAN_HALF; dz <= SCAN_HALF; dz += SCAN_STEP) {
            const x = centre.x + dx;
            const z = centre.z + dz;
            if (x < grounded.min.x + 0.4 || x > grounded.max.x - 0.4) continue;
            if (z < grounded.min.z + 0.4 || z > grounded.max.z - 0.4) continue;
            const y = probeFloorAt(x, z);
            const isFurniture = y !== null && y - grounded.min.y > CLEAR_FLOOR_MARGIN;
            if (isFurniture) {
              anyFurniture = true;
              if (x < minFx) minFx = x;
              if (x > maxFx) maxFx = x;
              if (z < minFz) minFz = z;
              if (z > maxFz) maxFz = z;
              if (Math.abs(dx) > SCAN_HALF - SCAN_STEP || Math.abs(dz) > SCAN_HALF - SCAN_STEP) {
                scanHitOwnBoundary = true;
              }
            }
          }
        }
        // Session 126 — Magnus: "she is back in the sofa again." The
        // log showed exactly why: scanHitOwnBoundary=true, and the
        // registered box was z[-3.29, 3.55] — a 6.84m span. Not
        // plausible as real furniture in this room. My own self-check
        // (added last round specifically to flag this) was firing
        // correctly and I kept letting the code act on the number
        // anyway — that was the actual mistake, not the room. If the
        // scan can't confirm where furniture actually ends even at
        // 3.2m, the measurement isn't trustworthy enough to build a
        // hard exclusion zone from, and acting on it regardless is how
        // spawn ended up worse than having no zone at all: pushed to
        // the edge of a box that was never real. Ongoing collision
        // during actual movement still has real, working protection —
        // probeWalls' multi-height raycasting (Session 111) already
        // catches the table directly against real geometry, entirely
        // independent of this scan. Don't register a zone from a
        // measurement that admits it isn't confirmed.
        if (scanHitOwnBoundary) {
          console.warn(`[ActorModelPanel] Grid scan hit its own boundary (SCAN_HALF=${SCAN_HALF}m) without finding a confirmed furniture edge — measurement not trustworthy, no exclusion zone registered. Ongoing collision still protected by probeWalls during movement.`);
        } else if (anyFurniture) {
          const zone = {
            minX: minFx - BODY_RADIUS, maxX: maxFx + BODY_RADIUS,
            minZ: minFz - BODY_RADIUS, maxZ: maxFz + BODY_RADIUS,
          };
          furnitureExclusionsRef.current.push(zone);
          console.log(`[ActorModelPanel] Registered furniture exclusion from grid scan: x[${zone.minX.toFixed(2)}, ${zone.maxX.toFixed(2)}] z[${zone.minZ.toFixed(2)}, ${zone.maxZ.toFixed(2)}].`);
        } else {
          // Scanned the whole area and found nothing furniture-like
          // outside the exact centre point — shouldn't happen given
          // centreIsFurniture was true, but if it does, don't silently
          // register an empty/wrong zone.
          console.warn("[ActorModelPanel] centre read as furniture but the grid scan found no furniture extent around it — no exclusion zone registered, investigate.");
        }
      }
      floorYRef.current = floorY;

      // The bounding box includes slab thickness top and bottom. What decides
      // whether a person looks right in here is the interior, so measure it.
      ray.set(
        new THREE.Vector3(spawnX, floorYRef.current + 0.05, spawnZ),
        new THREE.Vector3(0, 1, 0)
      );
      const upHits = ray.intersectObject(root, true);
      const interiorHeight = upHits.length ? upHits[0].distance + 0.05 : size.y;

      // Keep her off the skirting boards.
      const inset = 0.4;
      boundsRef.current = {
        minX: grounded.min.x + inset,
        maxX: grounded.max.x - inset,
        minZ: grounded.min.z + inset,
        maxZ: grounded.max.z - inset,
      };

      // Put her at the verified-clear spawn point (not necessarily the
      // room's geometric centre anymore — see above), and keep the
      // camera from orbiting out through the walls.
      if (holderRef.current) {
        holderRef.current.position.set(spawnX, floorYRef.current, spawnZ);
        console.log(`[ActorModelPanel] Chosen spawn before clamp: (${spawnX.toFixed(2)}, ${spawnZ.toFixed(2)}), ${furnitureExclusionsRef.current.length} exclusion zone(s) registered.`);
        clampOutsideExclusions(holderRef.current.position);

        // Session 121 — real bug, not the exclusion zones themselves:
        // the spawn point survived the exclusion-zone clamp (which only
        // knows about the detected furniture box) but could still sit
        // against OTHER real geometry the exclusion system never
        // modeled — the sofa, here. Worse: lastGoodPositionRef was
        // then seeded with that same bad spot below, so the "return to
        // safety" escape (Session 119) just returned her to the same
        // bad spot — fully stuck with no way out, which is exactly
        // what happened. Verify the chosen spawn isn't itself
        // overlapping real geometry before accepting it; if it is
        // badly, fall back to whichever room corner is farthest from
        // the detected furniture — far more likely to be genuinely
        // open regardless of how the exclusion-zone math misjudged the
        // furniture shape.
        //
        // Session 132 — probeWalls no longer exists (replaced by
        // resolveCapsule). Calling it directly here is actually a
        // small improvement over the old detect-then-maybe-fix
        // pattern: resolveCapsule corrects minor overlap on its own as
        // a side effect, so only a genuinely large correction (meaning
        // the point was fundamentally bad, not just slightly close to
        // something) falls through to the room-corner fallback.
        const spawnCorrection = resolveCapsule(holderRef.current.position);
        const spawnCorrectionDist = Math.hypot(spawnCorrection.x, spawnCorrection.z);
        const spawnBoxedIn = spawnCorrectionDist > 0.3;
        if (spawnBoxedIn) {
          const b = boundsRef.current;
          const corners = [
            { x: b.minX + 0.6, z: b.minZ + 0.6 },
            { x: b.minX + 0.6, z: b.maxZ - 0.6 },
            { x: b.maxX - 0.6, z: b.minZ + 0.6 },
            { x: b.maxX - 0.6, z: b.maxZ - 0.6 },
          ];
          const farthest = corners.reduce(
            (best, c) => {
              const d = Math.hypot(c.x - centre.x, c.z - centre.z);
              return d > best.d ? { ...c, d } : best;
            },
            { ...corners[0], d: -1 }
          );
          console.warn(`[ActorModelPanel] Spawn point needed a ${spawnCorrectionDist.toFixed(2)}m correction — treating as fundamentally bad, falling back to room corner (${farthest.x.toFixed(2)}, ${farthest.z.toFixed(2)}).`);
          holderRef.current.position.set(farthest.x, floorYRef.current, farthest.z);
          clampOutsideExclusions(holderRef.current.position);
          resolveCapsule(holderRef.current.position);
        }

        lastGoodPositionRef.current.copy(holderRef.current.position);
        console.log(`[ActorModelPanel] Holder position after clamp: (${holderRef.current.position.x.toFixed(2)}, ${holderRef.current.position.z.toFixed(2)}).`);
      }
      // Session 115 — small rooms (a compact kitchen/dining nook, say)
      // put the camera too close under the old room-size-only formula,
      // and the look-at target sat at chest height — combined, that's
      // a face-cropped, chest-filling close-up on load, not a portrait.
      // Minimum distance floor + aiming higher (shoulder/lower-face,
      // not mid-torso) fixes the default framing regardless of room size.
      const camDist = Math.max(2.4, Math.min(size.x, size.z) * 0.4);
      if (controlsRef.current) {
        controlsRef.current.target.set(
          spawnX,
          floorYRef.current + TARGET_HEIGHT * 0.85,
          spawnZ
        );
        controlsRef.current.maxDistance = Math.hypot(size.x, size.z);
        controlsRef.current.update();
      }
      if (cameraRef.current) {
        cameraRef.current.position.set(
          spawnX,
          floorYRef.current + TARGET_HEIGHT * 0.9,
          spawnZ + camDist
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
    if (holderRef.current) holderRef.current.position.y = 0;
    boundsRef.current = {
      minX: -ROOM / 2, maxX: ROOM / 2, minZ: -ROOM / 2, maxZ: ROOM / 2,
    };
    furnitureExclusionsRef.current = [];
    // Session 140 — the merged collider geometry is a real GPU-side
    // buffer built by us, not part of the room GLB that deepDispose
    // above already handled; dispose it explicitly or it leaks per
    // room load.
    if (colliderRef.current) {
      colliderRef.current.geometry.dispose();
      colliderRef.current = null;
    }
    collisionNameBoxesRef.current = [];
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
    clipGroundRef.current.clear();
    setClipGround(new Map());
    groundRef.current.target = 0;
    groundRef.current.applied = 0;
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
    setPosedInfo(null);
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
        if (dracoLoaderRef.current) loader.setDRACOLoader(dracoLoaderRef.current);
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
      // Session 147 - level 3, character side: she casts and receives.
      // Session 148 - hair does NOT cast: semi-transparent hair cards
      // throw solid silhouettes onto the chest as strand-shaped dark
      // slits (confirmed live); same hair-is-special judgment as
      // ACCESSORY_INFLATE / SHRINKWRAP.
      root.traverse((o) => {
        if (o.isMesh) {
          const isHair = (o.userData?.accessoryUrl || "").includes("/hair/");
          o.castShadow = !isHair;
          o.receiveShadow = true;
        }
      });
      vrmRef.current = vrm;
      mixerRef.current = new THREE.AnimationMixer(root);
      // If a room is already loaded, she belongs in it, not at world origin.
      // Session 118 — this naive bounds-centre placement was bypassing every
      // exclusion zone loadRoom builds: on the FIRST load the room isn't in
      // yet, so this branch never fires and loadRoom's own spawn logic wins.
      // But the wardrobe-refresh reload (Session 109) calls loadModel again
      // AFTER the room is already loaded — so THIS branch fires, blindly
      // resets her to the bounds midpoint, and nothing here knew the table
      // existed. Same clamp every other position-setting path already uses.
      if (roomRef.current) {
        const b = boundsRef.current;
        holder.position.set(
          (b.minX + b.maxX) / 2,
          floorYRef.current,
          (b.minZ + b.maxZ) / 2
        );
        clampOutsideExclusions(holder.position);
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

  // ---- actor-linked model (this editor's own character, not a test file) --
  // Pulls the actor's canonical GLB (GET /api/actors/:id -> actor.glb_url,
  // same column the drafts/asset system writes to) and hands it to loadModel
  // as a real File — no changes to the load/parse/report/clip-binding path
  // above, which is already proven against arbitrary GLBs.
  async function loadActorModel(id) {
    if (!id) return;
    setBusy("Loading character…");
    setError(null);
    try {
      const actorResp = await fetch(`/api/actors/${id}`);
      if (!actorResp.ok) {
        throw new Error(`actor fetch failed (${actorResp.status})`);
      }
      const actorData = await actorResp.json();

      // Wardrobe state for Inspect — parsed here, ahead of the GLB fetch,
      // so it's ready even if the 3D model itself fails to load. This is
      // the SAME draft_state column CharacterWizard reads and writes —
      // AccessoryEditor below is the SAME editing component the wizard
      // uses, so there is exactly one implementation of "what does
      // draft_state mean" between the two files, not two that can drift.
      setActorStatus(actorData?.actor?.status ?? null);
      // actorGlbUrl is set below, AFTER the GLB is fetched — see the
      // blob: URL note there for why this can't just be actor.glb_url.
      const draftStateRaw = actorData?.actor?.draft_state;
      if (draftStateRaw) {
        try {
          const parsedDraft = JSON.parse(draftStateRaw);
          fullDraftStateRef.current = parsedDraft;
          setAccessories(parsedDraft.accessories || defaultAccessories());
          setSelectedAccessoryGlbUrls(parsedDraft.selectedAccessoryGlbUrls || {});
          setAccessoryScales(parsedDraft.accessoryScales || {});
          setAccessoryOffsets(parsedDraft.accessoryOffsets || {});
          setAccessoryRotations(parsedDraft.accessoryRotations || {});
          setAccessoryParts(parsedDraft.accessoryParts || {});
          setAccessoryTints(parsedDraft.accessoryTints || {});
          setDraftStateUnparseable(false);
          setWardrobeSaveError(null);
        } catch (we) {
          console.error("[ActorModelPanel] draft_state did not parse as JSON:", we);
          fullDraftStateRef.current = {};
          setAccessories(defaultAccessories());
          setDraftStateUnparseable(true);
          setWardrobeSaveError("wardrobe data is unreadable — draft_state is not valid JSON. Saving is disabled here until that record is fixed on the server, so this view can't silently overwrite it.");
        }
      } else {
        fullDraftStateRef.current = {};
        setAccessories(defaultAccessories());
        setDraftStateUnparseable(false);
      }

      const glbUrl = actorData?.actor?.glb_url;
      if (!glbUrl) {
        throw new Error("this actor has no saved 3D model (glb_url is empty)");
      }

      // Session 107 — cache bust, versioned by the actor's updated_at.
      // The server serves /media/**.glb with Cache-Control: immutable,
      // max-age=1y, but the canonical actor GLB is OVERWRITTEN in place
      // on every wizard re-export (it is NOT content-addressed, despite
      // that route's comment) — so without a version parameter the
      // browser can show a year-old body no matter how many times the
      // wizard re-exports. updated_at changes on every save, giving
      // correct caching: stable between edits, fresh after them.
      const glbVersion = encodeURIComponent(actorData?.actor?.updated_at || Date.now());
      const glbResp = await fetch(`${glbUrl}${glbUrl.includes("?") ? "&" : "?"}v=${glbVersion}`);
      if (!glbResp.ok) {
        throw new Error(`GLB fetch failed (${glbResp.status}) — ${glbUrl}`);
      }
      const blob = await glbResp.blob();
      const filename = glbUrl.split("/").pop() || `${id}.glb`;
      const file = new File([blob], filename, { type: "model/gltf-binary" });

      // Session 109 — the Wardrobe preview's MiniGlbViewer must NOT be
      // handed actor.glb_url directly. That raw server path goes straight
      // into three.js's own GLTFLoader with no cache-bust stamp — found
      // live: it hangs on "Loading character" forever, no error, nothing.
      // CharacterWizard gets away with the raw-URL pattern (different page
      // context); rather than chase why, reuse the SAME already-fetched,
      // already-cache-busted blob the main viewer below loads from — one
      // network request, and the preview inherits the exact path already
      // proven to work.
      setActorGlbUrl(trackUrl(blob));

      await loadModel(file);
      // Session 141 — canonical files are transform-baked (not identity),
      // so this normally yields no index and live mirroring stays off
      // until the first structural rebake produces an identity-baked
      // copy. Logged either way so the state is never a mystery.
      buildExploreWardrobeIndex();

      // Session 107 — default home (re-applied; the Session 106 patch
      // landed on an older copy of this file and never shipped). If the
      // actor carries default_home_template_url, load it as the room
      // through the SAME loadRoom path as a manual file: measured floor,
      // bounds, and holder placement apply unchanged, and load order
      // gives "actor standing in her home". In explore mode this is what
      // makes the tab HER apartment rather than the placeholder stage.
      // A missing or broken home reports but never blocks the character.
      const homeUrl = actorData?.actor?.default_home_template_url;
      if (homeUrl) {
        try {
          const homeResp = await fetch(homeUrl);
          if (!homeResp.ok) throw new Error(`home GLB fetch failed (${homeResp.status})`);
          const homeBlob = await homeResp.blob();
          const homeName = homeUrl.split("/").pop() || "home.glb";
          await loadRoom(new File([homeBlob], homeName, { type: "model/gltf-binary" }));
        } catch (he) {
          setError(`Character loaded, but her home did not: ${he?.message ?? String(he)}`);
        }
      }
    } catch (e) {
      setBusy(null);
      setError(`Could not load actor's 3D model: ${e?.message ?? String(e)}`);
    }
  }

  // Auto-load on mount / whenever a different actor is passed in. sceneRef is
  // already populated by the time this runs — the scene-setup effect above is
  // synchronous and fires first within the same effect-flush.
  useEffect(() => {
    if (!actorId) return;
    loadActorModel(actorId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId]);

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
      const clipLoader = new GLTFLoader();
      if (dracoLoaderRef.current) clipLoader.setDRACOLoader(dracoLoaderRef.current);
      const gltf = await clipLoader.loadAsync(trackUrl(file));
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

    groundForClip(name, action);

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

  /**
   * Put the holder at the height that makes this clip's lowest foot touch the
   * floor. Measured on first play and cached — the sweep costs about 5ms and
   * stopping the mixer to run it is only safe before the crossfade starts.
   */
  function groundForClip(name, action) {
    const holder = holderRef.current;
    const mixer = mixerRef.current;
    if (!holder || !mixer) return;

    const baseY = floorYRef.current;
    let offset = clipGroundRef.current.get(name);

    if (offset === undefined) {
      const restore = currentActionRef.current;
      mixer.stopAllAction();
      holder.position.y = baseY;

      action.reset();
      action.setEffectiveWeight(1);
      action.play();

      const lowest = measureClipLowestY(holder, mixer, action);
      offset = lowest === null ? 0 : baseY - lowest;
      clipGroundRef.current.set(name, offset);

      mixer.stopAllAction();
      mixer.setTime(0);
      if (restore) restore.play();

      setClipGround(new Map(clipGroundRef.current));
    }

    // First clip after a load has no outgoing pose to blend against, so it
    // snaps; every later switch eases and arrives with the crossfade.
    groundRef.current.target = offset;
    if (!currentActionRef.current) groundRef.current.applied = offset;
  }

  function stop() {
    const action = currentActionRef.current;
    if (!action) return;
    action.fadeOut(0.3);
    window.setTimeout(() => {
      action.stop();
      vrmRef.current?.humanoid?.resetNormalizedPose();
      // Bind pose is what normaliseToFloor grounded against, so the clip's
      // correction has to come back off or Stop lands her wherever the last
      // clip wanted her. Eased, for the same reason the switch is.
      groundRef.current.target = 0;
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

  // Session 109 — shared by the main-stage Inspect viewer below. Was
  // previously computed inside WardrobeCard for its own now-removed
  // preview box; one live-dressed picture now, not two.
  const previewAccessories = buildViewerAccessories({
    selectedAccessoryGlbUrls, accessoryScales, accessoryOffsets, accessoryRotations,
    accessoryParts, accessoryTints, activeSlot, dynamicAccessoryOptions,
  });

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
        {/* Session 107 — mode tabs. Explore: her home, walking, first
            person. Inspect: the original toolbar and diagnostics. */}
        <div style={{ display: "flex", gap: 2, background: "#111", borderRadius: 8, padding: 3, marginRight: 8 }}>
          {["explore", "inspect"].map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                ...S.btnGhost,
                border: "none",
                padding: "6px 16px",
                borderRadius: 6,
                background: mode === m ? "#2b2b2b" : "transparent",
                color: mode === m ? "#fff" : "#888",
                fontWeight: mode === m ? 600 : 400,
              }}
            >
              {m === "explore" ? "Explore" : "Inspect"}
            </button>
          ))}
        </div>

        {mode === "explore" && (
          <button
            style={fpv ? S.btn : S.btnGhost}
            onClick={() => setFpv((v) => !v)}
          >
            {fpv ? "Leave first person" : "First person"}
          </button>
        )}
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
            style={{ ...S.canvasMount, visibility: mode === "explore" ? "visible" : "hidden" }}
            onClick={() => {
              if (fpvRef.current) fpvControlsRef.current?.lock();
            }}
          />
          {actorGlbUrl && (
            <div style={{ position: "absolute", inset: 0, visibility: mode === "inspect" ? "visible" : "hidden", pointerEvents: mode === "inspect" ? "auto" : "none" }}>
              <MiniGlbViewer
                glbUrl={actorGlbUrl}
                accessories={previewAccessories}
                activeAnimation={inspectActiveAnimation}
                onAnimationsLoaded={setEmbeddedAnimations}
                onAccessoryPartsLoaded={setAccessoryPartNames}
                onExportReady={(fn) => { exportGlbRef.current = fn; }}
                focusRegion={ACCESSORY_REGION_CAMERA[activeAccessoryRegion] || "fullBody"}
                showSaveButton={false}
                showMeasurements={mode === "inspect"}
                fullscreenLoadingOverlay={false}
              />
            </div>
          )}
          {busy && ReactDOM.createPortal(
            <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, background: "rgba(255,255,255,0.82)", backdropFilter: "blur(8px)" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
                <style>{`@keyframes amp-spin { to { transform: rotate(360deg); } }`}</style>
                <div style={{ width: 40, height: 40, border: "3px solid rgba(0,0,0,0.08)", borderTop: "3px solid #c9973a", borderRadius: "50%", animation: "amp-spin 0.9s linear infinite" }} />
                <p style={{ fontFamily: "'DM Sans',system-ui,sans-serif", fontSize: 13, fontWeight: 500, color: "#1a1814", margin: 0 }}>{busy}</p>
              </div>
            </div>,
            document.body,
          )}
          {mode === "explore" && !busy && !report && !error && (
            <div style={S.overlay}>
              Load a room, then a character, then animation clips.
            </div>
          )}
          {mode === "explore" && <div style={S.fps}>{fps} fps</div>}
          {mode === "explore" && holderXZ && (
            <div style={{ ...S.fps, top: 26 }}>
              x={holderXZ.x.toFixed(2)} z={holderXZ.z.toFixed(2)}
            </div>
          )}
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
          {mode === "explore" && playing && <div style={S.nowPlaying}>{playing}</div>}
          {mode === "explore" && !fpv && walkMode && (
            <div style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", fontSize: 11, color: "#aaa", background: "rgba(0,0,0,0.55)", borderRadius: 999, padding: "4px 14px", whiteSpace: "nowrap", pointerEvents: "none" }}>
              WASD move · shift run · drag to orbit · First person to step inside
            </div>
          )}
        </div>

        {mode === "explore" && (
        <div style={{ ...LIGHT.panel, flex: "0 1 300px", minWidth: 240, maxWidth: 320 }}>
          <div style={LIGHT.sectionLabel}>
            <span>Display</span>
            <button
              style={LIGHT.btnGhostSmall}
              onClick={() => setDisplay({ ...EXPLORE_DISPLAY_DEFAULTS })}
            >
              Reset
            </button>
          </div>
          <div style={{ marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#6b6760" }}>Shadows</span>
            <input
              type="checkbox"
              checked={display.shadows}
              onChange={(e) => setDisplay((d) => ({ ...d, shadows: e.target.checked }))}
              style={{ accentColor: "#b05c08", width: 16, height: 16, cursor: "pointer" }}
            />
          </div>
          {[
            { key: "exposure", label: "Exposure", min: 0.2, max: 2, step: 0.05 },
            { key: "envIntensity", label: "Environment", min: 0, max: 2, step: 0.05 },
            { key: "keyIntensity", label: "Key light", min: 0, max: 2, step: 0.05 },
            { key: "sunAzimuth", label: "Sun direction", min: 0, max: 360, step: 1, fmt: (v) => `${v.toFixed(0)}°` },
            { key: "sunElevation", label: "Sun height", min: 10, max: 80, step: 1, fmt: (v) => `${v.toFixed(0)}°` },
            { key: "ambientIntensity", label: "Ambient", min: 0, max: 1, step: 0.05 },
            { key: "rimIntensity", label: "Rim light", min: 0, max: 1, step: 0.05 },
          ].map(({ key: k, label, min, max, step, fmt }) => (
            <div key={k} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: "#6b6760" }}>{label}</span>
                <span style={{ fontSize: 12, color: "#1a1814", fontFamily: "'DM Mono',monospace" }}>{(fmt ?? ((v) => v.toFixed(2)))(display[k])}</span>
              </div>
              <input
                type="range"
                min={min} max={max} step={step}
                value={display[k]}
                onChange={(e) => setDisplay((d) => ({ ...d, [k]: Number(e.target.value) }))}
                style={{ width: "100%", accentColor: "#b05c08" }}
              />
            </div>
          ))}
        </div>
        )}

        {mode === "inspect" && (
        <div style={LIGHT.panel}>
          {error && <pre style={S.error}>{error}</pre>}
          {!report && !error && (
            <div style={LIGHT.hint}>
              Load her to inspect animations and wardrobe.
            </div>
          )}

          <div style={LIGHT.tabBar}>
            {["animations", "wardrobe"].map((t) => (
              <button
                key={t}
                onClick={() => setInspectTab(t)}
                style={inspectTab === t ? LIGHT.tabBtnOn : LIGHT.tabBtn}
              >
                {t === "animations" ? "Animations" : "Wardrobe"}
              </button>
            ))}
          </div>

          {inspectTab === "animations" && actorGlbUrl && (
            <div>
              <div style={LIGHT.sectionLabel}>
                <span>Animations{embeddedAnimations.length > 0 ? ` — ${embeddedAnimations.length} in file` : ""}</span>
              </div>

              {/* Session 109 — MiniGlbViewer only plays animations
                  already embedded in the GLB (gltf.animations); no
                  arbitrary FBX upload, no retargeting. That testing
                  tool lived entirely in the bespoke engine, which
                  Inspect no longer uses. */}
              {embeddedAnimations.length === 0 && (
                <div style={LIGHT.hint}>No animations embedded in this file.</div>
              )}

              {/* Session 143 — one clip per row (Magnus: inline chips
                  with a floating trash can looked bad): full-width row,
                  clip name selectable on the left, trash pinned right.
                  idle/walk have no trash (protected server-side too). */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                {embeddedAnimations.map((name) => (
                  <div key={name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button
                      style={{ ...(inspectActiveAnimation === name ? LIGHT.clipOn : LIGHT.clipBtn), flex: 1, textAlign: "left" }}
                      onClick={() => setInspectActiveAnimation(name)}
                    >
                      {name}
                    </button>
                    {name !== "idle" && name !== "walk" ? (
                      <button
                        title={`Remove "${name}" from the model`}
                        disabled={!!animDeleting}
                        onClick={() => handleAnimationDelete(name)}
                        style={{ border: "none", background: "none", cursor: animDeleting ? "wait" : "pointer", fontSize: 14, padding: "2px 6px", opacity: animDeleting === name ? 0.4 : 0.7, flexShrink: 0 }}
                      >
                        {"\uD83D\uDDD1"}
                      </button>
                    ) : (
                      /* spacer keeps every row's clip button the same width */
                      <span style={{ width: 26, flexShrink: 0 }} />
                    )}
                  </div>
                ))}
              </div>

              {/* Session 143 — upload-and-merge. Field order matters to
                  the user flow: name the clip, THEN pick the file (the
                  file picker fires the merge immediately). */}
              <div style={{ ...LIGHT.sectionLabel, marginTop: 18 }}><span>Add animation</span></div>
              <div style={LIGHT.hint}>
                Merges a clip into this character's GLB. Accepts .duf (DAZ pose/animation preset — converted automatically), .blend, .glb, or .fbx.
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                <input
                  type="text"
                  placeholder="clip name (e.g. sit)"
                  value={animUploadClipName}
                  onChange={(e) => setAnimUploadClipName(e.target.value)}
                  disabled={animUploadBusy}
                  style={{ padding: "6px 10px", fontFamily: "inherit", fontSize: 13, border: "1px solid #ccc", borderRadius: 6, width: 160 }}
                />
                <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                  <input type="checkbox" checked={animUploadLoop} onChange={(e) => setAnimUploadLoop(e.target.checked)} disabled={animUploadBusy} />
                  looping clip
                </label>
                {/* Session 143 — native <label> pattern, NOT hidden
                    input + JS click(): the programmatic-click route
                    was confirmed broken live (console showed "opening
                    file picker" with the change event NEVER firing
                    after selection — a known Chrome/macOS quirk class
                    with display:none inputs). A label wrapping the
                    input makes the browser own the entire gesture; no
                    ref, no click(), nothing for React re-renders to
                    detach. Input is visually hidden but NOT
                    display:none (also implicated in that quirk class).
                    No accept attribute — macOS UTI mapping for
                    third-party extensions like .duf is unreliable;
                    validation is real in the handler and server. */}
                <label
                  style={{
                    ...(animUploadBusy || !/^[a-zA-Z0-9_-]{1,32}$/.test(animUploadClipName.trim()) ? LIGHT.clipBtn : LIGHT.clipOn),
                    cursor: animUploadBusy || !/^[a-zA-Z0-9_-]{1,32}$/.test(animUploadClipName.trim()) ? "not-allowed" : "pointer",
                    display: "inline-block",
                  }}
                >
                  {animUploadBusy ? "Merging..." : (/^[a-zA-Z0-9_-]{1,32}$/.test(animUploadClipName.trim()) ? "Choose file & merge" : "Enter clip name first")}
                  <input
                    type="file"
                    disabled={animUploadBusy || !/^[a-zA-Z0-9_-]{1,32}$/.test(animUploadClipName.trim())}
                    style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden", clip: "rect(0 0 0 0)" }}
                    onChange={(e) => { const f = e.target.files?.[0]; console.log(`[ActorModelPanel] file input change: ${f ? f.name + " (" + f.size + " bytes)" : "no file"}`); e.target.value = ""; if (f) handleAnimationUpload(f); }}
                  />
                </label>
              </div>
              {animUploadMsg && (
                <div style={{ ...LIGHT.hint, marginTop: 6, color: animUploadMsg.err ? "#b3261e" : undefined }}>
                  {animUploadMsg.text}
                </div>
              )}
            </div>
          )}

          {inspectTab === "wardrobe" && actorId && (
            <WardrobeCard
              actorId={actorId}
              actorGlbUrl={actorGlbUrl}
              actorStatus={actorStatus}
              accessories={accessories} setAccessories={setAccessories}
              dynamicAccessoryOptions={dynamicAccessoryOptions}
              selectedAccessoryGlbUrls={selectedAccessoryGlbUrls} setSelectedAccessoryGlbUrls={setSelectedAccessoryGlbUrls}
              accessoryScales={accessoryScales} setAccessoryScales={setAccessoryScales}
              accessoryOffsets={accessoryOffsets} setAccessoryOffsets={setAccessoryOffsets}
              accessoryRotations={accessoryRotations} setAccessoryRotations={setAccessoryRotations}
              accessoryParts={accessoryParts} setAccessoryParts={setAccessoryParts}
              accessoryTints={accessoryTints} setAccessoryTints={setAccessoryTints}
              accessoryPartNames={accessoryPartNames}
              activeSlot={activeSlot} setActiveSlot={setActiveSlot}
              scaleDetailSlot={scaleDetailSlot} setScaleDetailSlot={setScaleDetailSlot}
              activePart={activePart} setActivePart={setActivePart}
              activeAccessoryRegion={activeAccessoryRegion} setActiveAccessoryRegion={setActiveAccessoryRegion}
              saving={savingWardrobe}
              saveError={wardrobeSaveError}
              saveOk={wardrobeSaveOk}
              draftStateUnparseable={draftStateUnparseable}
            />
          )}

          {actorId && <div style={LIGHT.actorId}>actor {actorId}</div>}
        </div>
        )}
      </div>
    </div>
  );
}

// Inspect's Wardrobe panel. Live dressing on the SAME editing component
// CharacterWizard uses (AccessoryEditor, imported at the top of this file)
// against a small dedicated MiniGlbViewer preview — not the main
// Explore/Inspect viewport above, which stays the untouched, proven
// baked-file viewer. Session 109, Magnus's explicit call: "share dressing
// components with the character wizard, one place to change."
//
// MiniGlbViewer strips any already-baked isAccessoryMesh meshes from
// actorGlbUrl on load (the same "body from file, garments from live list"
// contract CharacterWizard's loadDraft relies on) — so feeding it the
// actor's canonical, already-dressed glb_url and a live accessories array
// re-dresses correctly rather than doubling garments.
function WardrobeCard({
  actorId, actorGlbUrl, actorStatus,
  accessories, setAccessories,
  dynamicAccessoryOptions,
  selectedAccessoryGlbUrls, setSelectedAccessoryGlbUrls,
  accessoryScales, setAccessoryScales,
  accessoryOffsets, setAccessoryOffsets,
  accessoryRotations, setAccessoryRotations,
  accessoryParts, setAccessoryParts,
  accessoryTints, setAccessoryTints,
  accessoryPartNames,
  activeSlot, setActiveSlot,
  scaleDetailSlot, setScaleDetailSlot,
  activePart, setActivePart,
  activeAccessoryRegion, setActiveAccessoryRegion,
  saving, saveError, saveOk, draftStateUnparseable,
}) {
  return (
    <div>
      <div style={LIGHT.sectionLabel}>
        <span>Wardrobe</span>
        <span style={{
          fontFamily: "'DM Mono',monospace", fontSize: 10,
          color: saving ? "#b05c08" : saveOk ? "#34c759" : "#c9c6c0",
        }}>
          {/* Session 147 - the third branch ("not saved - status: X") was
              the DISPLAY twin of the removed draft-only save gate. Saves
              work for every status; caption reports actual activity. */}
          {saving ? "saving…" : saveOk ? "saved" : ""}
        </span>
      </div>

      {draftStateUnparseable && (
        <div style={{ ...LIGHT.finding, ...LIGHT.findingLevel.bad }}>
          This actor's draft_state didn't parse as JSON — fix the record on
          the server before editing here, or changes can't be saved at all.
        </div>
      )}
      {saveError && (
        <div style={{ ...LIGHT.finding, ...LIGHT.findingLevel.bad }}>{saveError}</div>
      )}

      {!actorGlbUrl ? (
        <div style={LIGHT.hint}>Load her before editing wardrobe.</div>
      ) : (
        <AccessoryEditor
          accessories={accessories} setAccessories={setAccessories}
          dynamicAccessoryOptions={dynamicAccessoryOptions}
          selectedAccessoryGlbUrls={selectedAccessoryGlbUrls} setSelectedAccessoryGlbUrls={setSelectedAccessoryGlbUrls}
          accessoryScales={accessoryScales} setAccessoryScales={setAccessoryScales}
          accessoryOffsets={accessoryOffsets} setAccessoryOffsets={setAccessoryOffsets}
          accessoryRotations={accessoryRotations} setAccessoryRotations={setAccessoryRotations}
          accessoryParts={accessoryParts} setAccessoryParts={setAccessoryParts}
          accessoryTints={accessoryTints} setAccessoryTints={setAccessoryTints}
          accessoryPartNames={accessoryPartNames}
          activeSlot={activeSlot} setActiveSlot={setActiveSlot}
          scaleDetailSlot={scaleDetailSlot} setScaleDetailSlot={setScaleDetailSlot}
          activePart={activePart} setActivePart={setActivePart}
          activeAccessoryRegion={activeAccessoryRegion} setActiveAccessoryRegion={setActiveAccessoryRegion}
        />
      )}
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
// Light theme for Inspect's right panel — matches the surrounding page
// (sidebar, "3D character" header, EDIT button), not the dark diagnostic
// panel this file used to be. Palette pulled directly from
// CharacterWizard.jsx's own S object: same app, same design language,
// so Wardrobe's AccessoryEditor content (already styled from that same
// palette) stops looking trapped inside a mismatched dark box.
const LIGHT = {
  panel: {
    background: "#faf9f7",
    border: "1px solid rgba(0,0,0,0.08)",
    borderRadius: 10,
    padding: 18,
    color: "#1a1814",
    fontFamily: "'DM Sans',system-ui,sans-serif",
    fontSize: 13,
    maxHeight: "min(78vh, 940px)",
    overflowY: "auto",
    flex: "1 1 380px", minWidth: 300, maxWidth: 520,
  },
  tabBar: { display: "flex", gap: 2, background: "rgba(0,0,0,0.04)", borderRadius: 8, padding: 3, marginBottom: 18 },
  tabBtn: { flex: 1, textAlign: "center", padding: "7px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: "'DM Sans',system-ui,sans-serif", fontSize: 12, fontWeight: 400, background: "transparent", color: "#a8a5a0" },
  tabBtnOn: { flex: 1, textAlign: "center", padding: "7px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: "'DM Sans',system-ui,sans-serif", fontSize: 12, fontWeight: 600, background: "#fff", color: "#1a1814", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" },
  sectionLabel: { fontFamily: "'DM Sans',system-ui,sans-serif", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#a8a5a0", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" },
  hint: { color: "#a8a5a0", fontSize: 12, lineHeight: 1.5 },
  clipBtn: { background: "transparent", border: "1px solid rgba(0,0,0,0.1)", color: "#1a1814", borderRadius: 6, padding: "8px 12px", fontSize: 12, cursor: "pointer", marginBottom: 6, display: "block", width: "100%", textAlign: "left" },
  clipOn: { background: "rgba(176,92,8,0.1)", border: "1px solid #b05c08", color: "#b05c08", borderRadius: 6, padding: "8px 12px", fontSize: 12, cursor: "pointer", marginBottom: 6, display: "block", width: "100%", textAlign: "left", fontWeight: 500 },
  btnGhostSmall: { background: "transparent", border: "1px solid rgba(0,0,0,0.14)", color: "#6b6760", borderRadius: 6, padding: "5px 11px", fontSize: 11, cursor: "pointer", fontFamily: "'DM Mono',monospace" },
  btnGhostSmallDisabled: { background: "transparent", border: "1px solid rgba(0,0,0,0.06)", color: "#c9c6c0", borderRadius: 6, padding: "5px 11px", fontSize: 11, cursor: "not-allowed", fontFamily: "'DM Mono',monospace" },
  finding: { borderRadius: 6, padding: "10px 12px", fontSize: 12, lineHeight: 1.5, marginBottom: 14, borderLeft: "3px solid" },
  findingLevel: {
    info: { background: "rgba(107,103,96,0.06)", color: "#6b6760", borderLeftColor: "#a8a5a0" },
    bad: { background: "rgba(192,57,43,0.06)", color: "#c0392b", borderLeftColor: "#c0392b" },
    good: { background: "rgba(52,199,89,0.08)", color: "#1f8a44", borderLeftColor: "#34c759" },
  },
  actorId: { marginTop: 16, color: "#c9c6c0", fontSize: 10, fontFamily: "'DM Mono',monospace" },
};

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
  btnGhostSmall: {
    background: "transparent", color: "#c8c8d0", border: "1px solid #3a3a42",
    borderRadius: 4, padding: "3px 9px", fontSize: 11, cursor: "pointer",
  },
  btnGhostSmallDisabled: {
    background: "transparent", color: "#5a5a62", border: "1px solid #2a2a30",
    borderRadius: 4, padding: "3px 9px", fontSize: 11, cursor: "not-allowed",
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
