import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// Session 96: the three real, confirmed body-shape morphs (see
// generate3d.js / favorite_morphs.json). Every GLB this pipeline
// produces has these as genuine glTF morph targets, spread across
// several meshes (body, clothing, mouth — confirmed via
// check_shape_keys.py, not every mesh has every morph). Named once
// here so the slider props below and the lookup logic can't drift
// apart from each other.
// Real per-load normalization, ported from ActorModelPanel's proven
// normaliseToFloor(): measure whatever height this GLB actually renders
// at, then rescale to a known-correct target — instead of guessing a
// fixed cm-per-unit ratio that may not hold across every character's
// export. TARGET_HEIGHT matches DAZ's own confirmed Genesis 9 default
// (170cm, daz3d.com product page). Once this runs, scene units ARE real
// meters, so everything else (rings, camera, lights) can go back to
// being expressed directly in meters.
const TARGET_HEIGHT = 1.7;

const MORPH_NAMES = {
  torsoLength: "body_bs_ProportionTorsoLength",
  armsLength: "body_bs_ProportionArmsLength",
  legsLength: "body_bs_ProportionLegsLength",
};

// NOT YET EMPIRICALLY CONFIRMED. Maps the wizard's 0-100 slider onto
// glTF morph influence (0-1). Diffeomorphic builds these shape keys
// with Blender's own slider_min=0/max=1, not DAZ's original -200% to
// +200% dial range, so influence 1.0 likely means "fully morphed
// target shape," not "matches DAZ's 100%." Whether the wizard's
// default of 50 should look like a neutral/average body (which would
// need a different formula, not a flat /100) hasn't been checked
// against the actual model yet — flagged rather than assumed correct.
// Change just this function once the real mapping is known.
function sliderToInfluence(sliderValue) {
  return sliderValue / 100;
}

function applyMorphInfluences(meshEntries, torsoVal, armsVal, legsVal) {
  console.log(`[MiniGlbViewer] applyMorphInfluences called on ${meshEntries.length} mesh(es), values: torso=${torsoVal} arms=${armsVal} legs=${legsVal}`);
  for (const { mesh, indices } of meshEntries) {
    console.log(`[MiniGlbViewer]   mesh "${mesh.name}": indices=${JSON.stringify(indices)}, morphTargetInfluences exists=${!!mesh.morphTargetInfluences}, length=${mesh.morphTargetInfluences?.length}, morphAttributes.position count=${mesh.geometry?.morphAttributes?.position?.length ?? "none"}`);
    if (indices.torsoLength !== undefined) mesh.morphTargetInfluences[indices.torsoLength] = sliderToInfluence(torsoVal);
    if (indices.armsLength !== undefined) mesh.morphTargetInfluences[indices.armsLength] = sliderToInfluence(armsVal);
    if (indices.legsLength !== undefined) mesh.morphTargetInfluences[indices.legsLength] = sliderToInfluence(legsVal);
  }
}

// Vertical ruler in real-world meters, matching the scene's existing units
// (the camera/controls setup already assumes meters — 1.4/1.1 only make
// sense as a human-height figure in meters). Minor ticks every 10cm, major
// every 50cm, with a highlighted tick at 1.70m — DAZ's own confirmed
// default Genesis 9 height (daz3d.com product page, Measure Metrics
// plugin), not a guess.
// Parallax-safe height rings, ported directly from ActorModelPanel — a
// side-positioned ruler sits at a different camera distance than the
// character, so with free orbit/zoom it can render at a misleadingly
// different apparent size. Rings centred on her own position can't lie:
// her scalp is either above the 1.7m ring or below it, from any angle.
function buildHeightRings() {
  const group = new THREE.Group();
  const rings = [
    { y: TARGET_HEIGHT, colour: 0xb05c08, radius: 0.42 }, // app's amber accent, marks DAZ's own confirmed default
    { y: 1.0, colour: 0xffffff, radius: 0.36 },
    { y: 0.5, colour: 0xffffff, radius: 0.36 },
  ];
  for (const r of rings) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(r.radius, 0.008, 6, 48),
      new THREE.MeshBasicMaterial({ color: r.colour, toneMapped: false, depthTest: false })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = r.y;
    ring.renderOrder = 999;
    group.add(ring);
  }
  return group;
}

// Keeps the model's lowest point pinned at Y=0 regardless of how tall the
// current morph values make it.
//
const CANDIDATE_COUNT = 40;

function findExtremeVertexCandidates(loadedRoot) {
  const lowCandidates = [];
  const highCandidates = [];
  loadedRoot.updateWorldMatrix(true, true);
  loadedRoot.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
    const posAttr = obj.geometry.attributes.position;
    const v = new THREE.Vector3();
    const rows = [];
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(obj.matrixWorld);
      rows.push([i, v.y]);
    }
    rows.sort((a, b) => a[1] - b[1]);
    for (const [i] of rows.slice(0, CANDIDATE_COUNT)) lowCandidates.push({ mesh: obj, vertexIndex: i });
    for (const [i] of rows.slice(-CANDIDATE_COUNT)) highCandidates.push({ mesh: obj, vertexIndex: i });
  });
  console.log(`[MiniGlbViewer] findExtremeVertexCandidates: ${lowCandidates.length} low + ${highCandidates.length} high vertices tracked, for grounding and the live height readout`);
  return { lowCandidates, highCandidates };
}

// Torso/Legs length need a hip landmark to split the body into two
// segments — CONFIRMED the hip bone itself doesn't move when Torso/Legs
// Length morphs are dragged (bones and shape keys are separate systems
// here), so the bone's own live position is the wrong thing to track.
// Instead: read the hip bone's position ONCE, at true base pose, only to
// know roughly where the hip is — then find real mesh vertices near that
// height and track THEM live with the same morph-aware blending already
// proven for feet/head-top. That's morph-aware where the raw bone isn't.
function findHipLevelVertexCandidates(loadedRoot, targetY) {
  const candidates = [];
  loadedRoot.updateWorldMatrix(true, true);
  loadedRoot.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
    const posAttr = obj.geometry.attributes.position;
    const v = new THREE.Vector3();
    const rows = [];
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(obj.matrixWorld);
      rows.push([i, Math.abs(v.y - targetY)]);
    }
    rows.sort((a, b) => a[1] - b[1]);
    for (const [i] of rows.slice(0, CANDIDATE_COUNT)) candidates.push({ mesh: obj, vertexIndex: i });
  });
  console.log(`[MiniGlbViewer] findHipLevelVertexCandidates: ${candidates.length} vertices near hip Y=${targetY.toFixed(4)}`);
  return candidates;
}

function findHipBone(loadedRoot) {
  let hipBone = null;
  loadedRoot.traverse((obj) => { if (obj.isBone && obj.name === "hip" && !hipBone) hipBone = obj; });
  return hipBone;
}

// Real macOS activity indicator, same as CharacterWizard's — a ring of
// tapered blades, each fading through the same opacity cycle at a
// staggered start point. Nothing actually rotates, only opacity sweeps.
function MacSpinner({ size = 40 }) {
  const blades = 12;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      {Array.from({ length: blades }).map((_, i) => (
        <div key={i} style={{
          position: "absolute", top: "50%", left: "50%",
          width: size * 0.09, height: size * 0.26,
          background: "#c9973a",
          borderRadius: size * 0.045,
          transform: `rotate(${(360 / blades) * i}deg) translate(0, -${size * 0.37}px)`,
          transformOrigin: "center",
          opacity: 0.35,
          animation: "macSpinnerBlade 1s linear infinite",
          animationDelay: `${-(i / blades)}s`,
        }} />
      ))}
      <style>{`@keyframes macSpinnerBlade { 0% { opacity: 1; } 100% { opacity: 0.35; } }`}</style>
    </div>
  );
}

function computeBlendedY(candidates, mode) {
  let result = mode === "min" ? Infinity : -Infinity;
  const v = new THREE.Vector3();
  for (const { mesh, vertexIndex } of candidates) {
    const posAttr = mesh.geometry.attributes.position;
    v.fromBufferAttribute(posAttr, vertexIndex);
    const morphPos = mesh.geometry.morphAttributes?.position;
    const influences = mesh.morphTargetInfluences;
    if (morphPos && influences) {
      for (let m = 0; m < morphPos.length; m++) {
        const infl = influences[m];
        if (!infl) continue;
        v.x += morphPos[m].getX(vertexIndex) * infl;
        v.y += morphPos[m].getY(vertexIndex) * infl;
        v.z += morphPos[m].getZ(vertexIndex) * infl;
      }
    }
    v.applyMatrix4(mesh.matrixWorld);
    if (mode === "min" ? v.y < result : v.y > result) result = v.y;
  }
  return Number.isFinite(result) ? result : 0;
}

// Average blended Y across a candidate set — used for the hip-level
// landmark, where we want a representative height, not an extreme.
function computeBlendedAverageY(candidates) {
  if (!candidates.length) return 0;
  let sum = 0;
  const v = new THREE.Vector3();
  for (const { mesh, vertexIndex } of candidates) {
    const posAttr = mesh.geometry.attributes.position;
    v.fromBufferAttribute(posAttr, vertexIndex);
    const morphPos = mesh.geometry.morphAttributes?.position;
    const influences = mesh.morphTargetInfluences;
    if (morphPos && influences) {
      for (let m = 0; m < morphPos.length; m++) {
        const infl = influences[m];
        if (!infl) continue;
        v.y += morphPos[m].getY(vertexIndex) * infl;
      }
    }
    v.applyMatrix4(mesh.matrixWorld);
    sum += v.y;
  }
  return sum / candidates.length;
}

// Grounds the model AND returns her current real height in meters — one
// measurement serves both, since height is just maxY-minY and doesn't
// depend on whatever Y-offset grounding applies (shifting both extremes
// equally leaves their difference unchanged).
function groundAndMeasure(loadedRoot, lowCandidates, highCandidates, hipCandidates) {
  if (!loadedRoot || !lowCandidates?.length) return null;
  const previousOffset = loadedRoot.userData.groundOffset || 0;
  loadedRoot.position.y -= previousOffset;
  loadedRoot.updateWorldMatrix(true, true);

  const minY = computeBlendedY(lowCandidates, "min");
  const maxY = highCandidates?.length ? computeBlendedY(highCandidates, "max") : minY;
  const heightM = maxY - minY;

  let torsoM = null;
  let legsM = null;
  if (hipCandidates?.length) {
    const hipY = computeBlendedAverageY(hipCandidates);
    legsM = hipY - minY;
    torsoM = maxY - hipY;
  }

  console.log(`[MiniGlbViewer] groundAndMeasure: minY=${minY.toFixed(4)} maxY=${maxY.toFixed(4)} height=${heightM.toFixed(4)}m` + (torsoM !== null ? ` torso=${torsoM.toFixed(4)}m legs=${legsM.toFixed(4)}m` : ""));

  loadedRoot.position.y -= minY;
  loadedRoot.userData.groundOffset = -minY;
  return { heightM, torsoM, legsM };
}

// Real per-load scale fix, run ONCE — ported from ActorModelPanel's
// normaliseToFloor(), but morph-aware where that one doesn't need to be:
// ActorModelPanel's characters arrive with fixed, already-final shapes, so
// its plain Box3().setFromObject() correctly reads their true geometry.
// Ours don't — the wizard's sliders default to 50, not 0, so a naive Box3
// call here would measure the WRONG (un-morphed base) height even at load
// time. Using the same CPU-blend measurement as grounding instead, so the
// scale is fixed against her actual initial pose, not an unmorphed one.
function normaliseScale(loadedRoot, lowCandidates, highCandidates) {
  const minY = computeBlendedY(lowCandidates, "min");
  const maxY = computeBlendedY(highCandidates, "max");
  const rawHeight = maxY - minY;
  const scale = rawHeight > 0 ? TARGET_HEIGHT / rawHeight : 1;
  loadedRoot.scale.setScalar(scale);
  loadedRoot.updateWorldMatrix(true, true);
  console.log(`[MiniGlbViewer] normaliseScale: rawHeight=${rawHeight.toFixed(4)} (native units, at initial slider pose) -> scale=${scale.toFixed(4)} to reach TARGET_HEIGHT=${TARGET_HEIGHT}m`);
}

// Minimal, self-contained GLB viewer — deliberately NOT the full
// ActorModelPanel (animation clips, multi-loader support, FPV controls,
// etc.). This is scoped to exactly one job: load and display the freshly
// generated character inside the wizard's own modal, safely. Full
// ActorModelPanel remains the post-creation editor, per the original
// architecture decision.
export default function MiniGlbViewer({ glbUrl, bodyTorsoLength = 50, bodyArmsLength = 50, bodyLegsLength = 50 }) {
  const mountRef = useRef(null);
  // Populated once per model load, in the load callback below. Kept as
  // a ref (not state) so the slider-effect further down can read it on
  // every drag without re-triggering the load effect, which only
  // depends on glbUrl.
  const morphMeshesRef = useRef([]);
  // Also kept as a ref (not the load effect's local variable) so the
  // slider-drag effect below can re-ground the model after every morph
  // update, not just once at load time.
  const loadedRootRef = useRef(null);
  const groundingCandidatesRef = useRef({ lowCandidates: [], highCandidates: [], hipCandidates: [] });
  const [heightM, setHeightM] = useState(null);
  const [modelLoading, setModelLoading] = useState(true);
  const [torsoLengthM, setTorsoLengthM] = useState(null);
  const [legsLengthM, setLegsLengthM] = useState(null);

  useEffect(() => {
    if (!glbUrl || !mountRef.current) return;
    const mount = mountRef.current;
    setModelLoading(true);

    const scene = new THREE.Scene();
    // Plain real meters — genuinely correct now that normaliseScale()
    // guarantees scene units are real meters after load, not a guess.
    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / mount.clientHeight, 0.1, 100);
    camera.position.set(0, 1.3, 3);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.0, 0);
    controls.enableDamping = true;
    controls.minDistance = 1;
    controls.maxDistance = 5;
    controls.update();

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1.5, 2.5, 2.0);
    scene.add(key);
    scene.add(buildHeightRings());

    let mounted = true;
    let loadedRoot = null;

    // Required since convert.py started exporting with Draco mesh
    // compression enabled — GLTFLoader can't decode Draco geometry on
    // its own without this. Google's officially hosted decoder path;
    // avoids needing to self-host the WASM/JS decoder files.
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
    const gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(dracoLoader);

    gltfLoader.load(
      glbUrl,
      (gltf) => {
        if (!mounted) return;
        loadedRoot = gltf.scene;
        loadedRootRef.current = loadedRoot;
        scene.add(loadedRoot);

        // Find every mesh carrying any of our three morphs — body,
        // clothing, and mouth each have some subset, not the same set
        // everywhere (confirmed via check_shape_keys.py), so each
        // mesh is checked independently rather than assuming a fixed
        // list applies uniformly.
        const found = [];
        let meshCount = 0;
        let meshesWithMorphDict = 0;
        loadedRoot.traverse((obj) => {
          if (!obj.isMesh) return;
          meshCount++;
          if (!obj.morphTargetDictionary) return;
          meshesWithMorphDict++;
          const indices = {};
          for (const [propKey, morphName] of Object.entries(MORPH_NAMES)) {
            if (morphName in obj.morphTargetDictionary) {
              indices[propKey] = obj.morphTargetDictionary[morphName];
            }
          }
          if (Object.keys(indices).length > 0) found.push({ mesh: obj, indices });
        });
        console.log(`[MiniGlbViewer] traversed: ${meshCount} meshes total, ${meshesWithMorphDict} with a morphTargetDictionary, ${found.length} matched one of our 3 target morphs`);
        morphMeshesRef.current = found;

        // Find extreme vertices at TRUE base pose (before any morph
        // influence) — the most robust reference set, since it doesn't
        // depend on the wizard's default slider values (50) being
        // anatomically neutral, which they aren't confirmed to be.
        const candidates = findExtremeVertexCandidates(loadedRoot);

        // Hip-level candidates for Torso/Legs length — CONFIRMED the hip
        // bone itself doesn't move when these morphs are dragged, so its
        // base-pose position is only used to identify WHICH vertices sit
        // near the hip; those vertices then get tracked live, morph-aware,
        // the same way feet/head-top already are.
        const hipBone = findHipBone(loadedRoot);
        let hipCandidates = [];
        if (hipBone) {
          const hipPos = new THREE.Vector3();
          hipBone.getWorldPosition(hipPos);
          hipCandidates = findHipLevelVertexCandidates(loadedRoot, hipPos.y);
        } else {
          console.log("[MiniGlbViewer] no hip bone found — Torso/Legs length readouts will be unavailable");
        }

        groundingCandidatesRef.current = { ...candidates, hipCandidates };

        applyMorphInfluences(found, bodyTorsoLength, bodyArmsLength, bodyLegsLength);

        // Fix real-world scale ONCE, against her actual initial pose (not
        // an unmorphed one) — after this, scene units genuinely are real
        // meters, resolving the whole scale-mismatch question directly
        // instead of guessing a fixed ratio. Never re-run after this —
        // continuously re-normalizing to TARGET_HEIGHT on every drag would
        // erase the very effect the Legs/Torso sliders are supposed to show.
        normaliseScale(loadedRoot, candidates.lowCandidates, candidates.highCandidates);

        const m = groundAndMeasure(loadedRoot, candidates.lowCandidates, candidates.highCandidates, hipCandidates);
        if (mounted && m) {
          setHeightM(m.heightM);
          setTorsoLengthM(m.torsoM);
          setLegsLengthM(m.legsM);
        }
        if (mounted) setModelLoading(false);

        // TEMP DIAGNOSTIC — needed to build real Torso/Legs length
        // measurement. That needs a hip landmark to split the body into
        // two segments, unlike overall height which only needed the
        // absolute top/bottom already tracked above. Broadened after the
        // narrow isSkinnedMesh check logged nothing — rather than assume
        // why, dump everything actually in the hierarchy so we see real
        // evidence instead of guessing whether skinning even exists here.
        // Remove once the real structure is confirmed and wired in.
        const typeCounts = {};
        let skinnedFound = 0;
        let boneFound = 0;
        loadedRoot.traverse((obj) => {
          typeCounts[obj.type] = (typeCounts[obj.type] || 0) + 1;
          if (obj.isSkinnedMesh) {
            skinnedFound++;
            console.log(`[MiniGlbViewer] SkinnedMesh "${obj.name}": skeleton=${!!obj.skeleton}, bones=${obj.skeleton?.bones?.length ?? 0}`);
            if (obj.skeleton?.bones?.length) {
              console.log(`[MiniGlbViewer]   bone names: ${obj.skeleton.bones.map(b => b.name).join(", ")}`);
            }
          }
          if (obj.isBone) boneFound++;
        });
        console.log(`[MiniGlbViewer] full hierarchy type counts:`, typeCounts, `| SkinnedMesh count: ${skinnedFound} | Bone count: ${boneFound}`);
      },
      undefined,
      (err) => { console.error("[MiniGlbViewer] GLTF load failed:", err); if (mounted) setModelLoading(false); }
    );

    let frameId;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!mount) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    // ResizeObserver instead of a plain window "resize" listener — it
    // tracks the mount element's own size directly, so the canvas stays
    // correctly sized regardless of WHAT caused the change (browser
    // window resize, flex/grid reflow, sidebar toggling), not just literal
    // window resize events, which is what "fixed size" turned out to mean.
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(mount);

    // Proper cleanup matters here specifically because this runs inside a
    // modal that mounts/unmounts repeatedly (Generate -> Regenerate),
    // unlike a full page's viewer that mounts once.
    return () => {
      mounted = false;
      setHeightM(null);
      setModelLoading(true);
      setTorsoLengthM(null);
      setLegsLengthM(null);
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.dispose();
      morphMeshesRef.current = [];
      loadedRootRef.current = null;
      groundingCandidatesRef.current = { lowCandidates: [], highCandidates: [], hipCandidates: [] };
      if (loadedRoot) {
        loadedRoot.traverse((obj) => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach((m) => {
              Object.values(m).forEach((v) => v?.isTexture && v.dispose());
              m.dispose();
            });
          }
        });
      }
      renderer.dispose();
      dracoLoader.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
    // Deliberately NOT depending on bodyTorsoLength/bodyArmsLength/bodyLegsLength
    // here — they're only read once, at load time, as the initial pose.
    // Live updates while dragging go through the separate effect below,
    // which doesn't tear down and rebuild the whole Three.js scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glbUrl]);

  // Live updates on every slider drag — reads the meshes found during
  // load (via the ref) without reloading the model or touching the
  // Three.js scene setup, which only happens in the effect above.
  useEffect(() => {
    applyMorphInfluences(morphMeshesRef.current, bodyTorsoLength, bodyArmsLength, bodyLegsLength);
    const { lowCandidates, highCandidates, hipCandidates } = groundingCandidatesRef.current;
    const m = groundAndMeasure(loadedRootRef.current, lowCandidates, highCandidates, hipCandidates);
    if (m) {
      setHeightM(m.heightM);
      setTorsoLengthM(m.torsoM);
      setLegsLengthM(m.legsM);
    }
  }, [bodyTorsoLength, bodyArmsLength, bodyLegsLength]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%" }} />
      {modelLoading && ReactDOM.createPortal(
        <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, background: "#0d0c0a" }}>
          <MacSpinner size={40} />
        </div>,
        document.body
      )}
      {heightM !== null && (
        <div style={{
          position: "absolute", bottom: 14, left: 14,
          fontFamily: "'DM Mono',monospace", fontSize: 13, color: "#c7b48c",
          background: "rgba(0,0,0,0.5)", padding: "10px 14px", borderRadius: 12,
          border: "1px solid rgba(199,180,140,0.2)",
          pointerEvents: "none", lineHeight: 1.7,
        }}>
          <div>Length: {(heightM * 100).toFixed(1)} cm</div>
          {torsoLengthM !== null && <div>Torso: {(torsoLengthM * 100).toFixed(1)} cm</div>}
          {legsLengthM !== null && <div>Legs: {(legsLengthM * 100).toFixed(1)} cm</div>}
        </div>
      )}
    </div>
  );
}
