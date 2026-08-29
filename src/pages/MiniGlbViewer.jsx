import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MeshBVH } from "three-mesh-bvh";
import { applySkinLayers, suspendSkinLayers, fitOuterLayers } from "./bodyLayers.js";
import { attachKtx2 } from "../lib/gltfKtx2.js";

// Session 96: the three real, confirmed body-shape morphs (see
// generate3d.js / favorite_morphs.json). Every GLB this pipeline
// produces has these as genuine glTF morph targets, spread across
// several meshes (body, clothing, mouth — confirmed via
// check_shape_keys.py, not every mesh has every morph). Named once
// here so the slider props below and the lookup logic can't drift
// apart from each other.
// DAZ_DEFAULT_HEIGHT — Session 101+: this is now ONLY a fixed reference
// line for the ruler overlay (see buildHeightRings below), matching
// DAZ's own confirmed Genesis 9 default (170cm, daz3d.com product
// page). It has no role in scaling anything — this viewer does not
// decide any character's height. That decision belongs entirely to
// generate3d.js's applyBodyShape() (real YScale, calibrated, baked
// into the export before it ever reaches this file). This viewer's
// only job is to render the GLB it's given, faithfully, as exported —
// the client-side rescale-to-a-target mechanism that used to live
// here (normaliseScale()) has been removed entirely, not just
// disconnected, since its continued presence — even unused — implied
// this file had a say in height, which it doesn't and shouldn't.
const DAZ_DEFAULT_HEIGHT = 1.7;

// TEMPORARY DEBUG SWITCHES for the shorts "two black rings" bug
// (Session 100 handoff, SAD.md "Accessory Skinning Investigation").
// Both default OFF — flip in source, rebuild, observe, flip back.
//
// isolate: skip the cross-skeleton rebind ENTIRELY for every accessory.
//   The accessory GLB's whole scene graph — its OWN skeleton, its own
//   node transforms, nothing reset or remapped — is added next to the
//   character, offset +0.6m on X. This is the discriminating test from
//   the handoff: shorts correct in isolation => bug is in the rebind
//   path; shorts wrong in isolation => bug is in the asset/export
//   itself, and MiniGlbViewer code is off the hook.
//
// xray: render the main character's body semi-transparent, so a bound
//   accessory sitting INSIDE the body becomes visible. Directly tests
//   the occlusion hypothesis: that the black shape at the hips is a
//   black-material shorts mesh deforming roughly correctly but buried
//   under the skin, visible only in the between-thighs gap and at
//   silhouette edges — not collapsed geometry at all.
const ACCESSORY_DEBUG = {
  isolate: false,
  xray: false,
};

// Clothing clearance shell. The body GLB is exported exactly as intended
// (confirmed by Magnus, Session 100) and clothing assets are fitted to
// the base G9 shape, so tight-fitting clothes can sit fractionally
// inside the rendered body surface — visible as skin patches poking
// through the fabric. Fix: at load time, push every clothing vertex
// outward along its own vertex NORMAL by a small fixed distance, giving
// uniform clearance everywhere. Deliberately NOT done via the scale
// sliders — scaling grows from the bounding-box center, which
// over-offsets the sides and under-offsets front/back; a normal offset
// is uniform by construction.
//
// Applied ONLY to accessories whose URL contains one of the path
// fragments below — hair is confirmed working and must not be touched
// (inflating hair cards along their normals visibly puffs/splits them).
// Extend the list as more clothing categories (torso, legs, feet...)
// come online. offsetMeters is in the accessory's native units (meters,
// pre-normalization) — 0.004 renders as ~3.7mm on the final 1.7m
// character. Tune here if clearance is too little/much.
const ACCESSORY_INFLATE = {
  pathFragments: ["/underwear/"],
  // SUPERSEDED by ACCESSORY_SHRINKWRAP below (Session 101, later the
  // same evening): uniform inflation had to be pumped to 0.012 to clear
  // the Kat glutes, ballooning the garment everywhere else. Set to 0 —
  // the shrinkwrap pass now resolves penetration per-vertex against the
  // actual body surface instead. Mechanism kept (not deleted) as the
  // fallback for a future garment whose geometry defeats shrinkwrap
  // (e.g. missing/degenerate normals): set a small value here and it
  // still runs before the shrinkwrap pass.
  offsetMeters: 0.0,
};

const MORPH_NAMES = {
  torsoLength: "body_bs_ProportionTorsoLength",
  armsLength: "body_bs_ProportionArmsLength",
  legsLength: "body_bs_ProportionLegsLength",
  height: "body_bs_ProportionHeight", // still looked up for diagnostics/future use, but deliberately never applied in applyMorphInfluences() below — confirmed broken shape key data (matches a documented DAZ bug, this morph behaves like Body Mass instead of Height). Height is driven by torso+legs+arms together instead — see applyMorphInfluences()
  // Real morphs (Session 101+) — all confirmed baked and driver-
  // bypassed by generate3d.js's bakeAllMorphsAtDefault(), same real
  // shape-key mechanism as the four above. Applied generically via
  // extraMorphValues (see applyMorphInfluences() below) rather than
  // one named function parameter each — the four above stay as they
  // are, this set is deliberately open-ended so more can be added here
  // without touching the application logic again.
  waistWidth: "body_bs_WaistWidth",
  waistDepth: "body_bs_WaistDepth",
  waistWidthUpper: "body_bs_WaistWidthUpper",
  hipSize: "body_bs_HipSize",
  massLowerTorso: "body_bs_MassLowerTorso",
  massUpperTorso: "body_bs_MassUpperTorso",
  loveHandles: "body_bs_LoveHandles",
  stomachDepth: "body_bs_StomachDepth",
  stomachDepthLower: "body_bs_StomachDepthLower",
  stomachSoften: "body_bs_StomachSoften",
  bodyHeavy: "body_bs_BodyHeavy",
  bodyThin: "body_bs_BodyThin",
  bodyEmaciated: "body_bs_BodyEmaciated",
  bodyLithe: "body_bs_BodyLithe",
  bodyFitnessMass: "body_bs_BodyFitnessMass",
  bodyTone: "body_bs_BodyTone",
  // Real, confirmed via getNumModifiers() scan (19/19 found) — sourced
  // specifically from DAZ's "Body Feminine" folder, the only genuine
  // standalone set found among several candidates (Projection Template
  // copies for clothing-fitting, Base Pose gravity/sag correctives,
  // and a third-party "Smart Enhancing System" physics product were
  // all excluded — none are real static shape controls).
  // Real fix (Session 101+) — the actual exported shape key names,
  // confirmed by directly inspecting a real production GLB's shape
  // keys (not DAZ's own getNumModifiers() output, which reflects
  // DAZ's internal name BEFORE Diffeomorphic's export, not necessarily
  // what comes out the other end). "BreastsSmall"/"BreastsLarge" were
  // simply the wrong names all along — body_bs_BreastSmall (singular)
  // and body_bs_BreastSize both exist as real, separate shape keys;
  // no "BreastLarge" exists at all. BreastSize's own effect direction
  // (does it actually make breasts larger, given the generic name?)
  // hasn't been visually confirmed yet — worth checking after deploy.
  breastsSmall: "body_bs_BreastSmall",
  breastsLarge: "body_bs_BreastSize",
  breastsNatural: "body_bs_BreastsNatural",
  breastsHeavy: "body_bs_BreastsHeavy",
  breastsPerkSide: "body_bs_BreastsPerkSide",
  breastsSidesDepth: "body_bs_BreastsSidesDepth",
  breastsLargeHigh: "body_bs_BreastsLargeHigh",
  breastsShape01: "body_bs_BreastsShape01",
  breastsShape02: "body_bs_BreastsShape02",
  breastsShape03: "body_bs_BreastsShape03",
  breastsShape04: "body_bs_BreastsShape04",
  breastsShape05: "body_bs_BreastsShape05",
  breastsShape06: "body_bs_BreastsShape06",
  breastsGone: "body_bs_BreastsGone",
  breastsCleavage: "body_bs_BreastsCleavage",
  breastsFullnessUpper: "body_bs_BreastsFullnessUpper",
  breastsFullnessLower: "body_bs_BreastsFullnessLower",
  breastsDownwardSlope: "body_bs_BreastsDownwardSlope",
  breastsDiameter: "body_bs_BreastsDiameter",
  // Real fix (Session 101+) — same discovery as BreastsSmall/BreastsSize
  // above: these three were also just wrong names all along, not a
  // genuine Diffeomorphic-export gap as previously believed and
  // documented. Direct inspection of a real production GLB found the
  // actual exported names: BodyMuscularMass -> BodyMuscularVolume,
  // MassBody -> BodyMass (reversed word order), MassUpperArms ->
  // MassUpperarms (lowercase "a" — the earlier casing fix attempt for
  // this exact morph was actually correct in the opposite direction:
  // DAZ's own getNumModifiers() genuinely reports "MassUpperArms", but
  // the shape key Diffeomorphic actually exports is "MassUpperarms").
  bodyMuscularMass: "body_bs_BodyMuscularVolume",
  massBody: "body_bs_BodyMass",
  massUpperArms: "body_bs_MassUpperarms",
  // Real, 71 morphs added (Session 101+) — the rest of the confirmed
  // baked set that had no slider yet, organized into new Proportions/
  // Torso Detail/Hips-Glutes sections and additions to existing ones.
  proportionChestDepth: "body_bs_ProportionChestDepth",
  proportionChestWidth: "body_bs_ProportionChestWidth",
  proportionFingersLength: "body_bs_ProportionFingersLength",
  proportionFootLength: "body_bs_ProportionFootLength",
  proportionToesLength: "body_bs_ProportionToesLength",
  proportionNeckLength: "head_bs_ProportionNeckLength",
  proportionShoulderWidth: "body_bs_ProportionShoulderWidth",
  proportionLarger: "body_bs_ProportionLarger",
  proportionSmaller: "body_bs_ProportionSmaller",
  proportionSmallerBO: "body_bs_ProportionSmallerBO",
  massNeck: "body_bs_MassNeck",
  taperNeckA: "body_bs_TaperNeckA",
  taperNeckB: "body_bs_TaperNeckB",
  bodyFitnessDetails: "body_bs_BodyFitnessDetails",
  bodyMuscularDetails: "body_bs_BodyMuscularDetails",
  bodyOlder: "body_bs_BodyOlder",
  abdominalsCenterDefine: "body_bs_AbdominalsCenterDefine",
  abdominalsOuterDefine: "body_bs_AbdominalsOuterDefine",
  abdominalsWidth: "body_bs_AbdominalsWidth",
  navelDepth: "body_bs_NavelDepth_HD3",
  navelHollow: "body_bs_NavelHollow_HD3",
  navelHorizontal: "body_bs_NavelHorizontal_HD3",
  navelOut: "body_bs_NavelOut_HD3",
  navelSize: "body_bs_NavelSize_HD3",
  navelVertical: "body_bs_NavelVertical_HD3",
  ribcageArched: "body_bs_RibcageArched",
  ribcagePointed: "body_bs_RibcagePointed",
  ribcageSize: "body_bs_RibcageSize",
  scapulaDepth: "body_bs_ScapulaDepth",
  scapulaSize: "body_bs_ScapulaSize",
  sternumDepth: "body_bs_SternumDepth",
  sternumHeight: "body_bs_SternumHeight",
  sternumWidth: "body_bs_SternumWidth",
  collarboneDetail: "body_bs_CollarboneDetail",
  latsSize: "body_bs_LatsSize",
  trapsSize: "body_bs_TrapsSize",
  gluteCrease: "body_bs_GluteCrease",
  gluteDepthLower: "body_bs_GluteDepthLower",
  gluteDepthUpper: "body_bs_GluteDepthUpper",
  gluteSize: "body_bs_GluteSize",
  gluteWidth: "body_bs_GluteWidth",
  hipBackDimples: "body_bs_HipBackDimples",
  hipBoneCrest: "body_bs_HipBoneCrest",
  hipBoneSize: "body_bs_HipBoneSize",
  hipGenitalBulge: "body_bs_HipGenitalBulge",
  hipPelvicTilt: "body_bs_HipPelvicTilt",
  hipVDefine: "body_bs_HipVDefine",
  thighDepth: "body_bs_ThighDepth",
  thighTone: "body_bs_ThighTone",
  calvesSize: "body_bs_CalvesSize",
  kneeBonesSize: "body_bs_KneeBonesSize",
  taperThighA: "body_bs_TaperThighA",
  taperThighB: "body_bs_TaperThighB",
  taperShinA: "body_bs_TaperShinA",
  taperShinB: "body_bs_TaperShinB",
  massAnkles: "body_bs_MassAnkles",
  massFeet: "body_bs_MassFeet",
  massKnees: "body_bs_MassKnees",
  massShins: "body_bs_MassShins",
  massThighs: "body_bs_MassThighs",
  footArchDepth: "body_bs_FootArchDepth",
  massForearms: "body_bs_MassForearms",
  massHands: "body_bs_MassHands",
  massShoulders: "body_bs_MassShoulders",
  massWrist: "body_bs_MassWrist",
  taperUpperArmA: "body_bs_TaperUpperArmA",
  taperUpperArmB: "body_bs_TaperUpperArmB",
  taperForearmA: "body_bs_TaperForearmA",
  taperForearmB: "body_bs_TaperForearmB",
  upperArmTaperWidth: "body_bs_UpperArmTaperWidth",
  fingersWidth: "body_bs_FingersWidth",
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

// Real (Session 101+) — head_ctrl_ProportionHeadSize_scl proved
// unreliable: confirmed present as a real DAZ modifier on one test
// character (185d8991) via direct DazScript inspection, but confirmed
// ABSENT (getNumModifiers() found nothing, and its own .duf never
// references it) on two separate real production generations
// (35e830e7, 704a7c5b). Not safe to depend on for production.
// Sidesteps the whole ERC/shape-key question entirely: scales the
// "head" bone directly. Confirmed via a full deform-bone audit earlier
// this session (use_deform=True AND a real, matching vertex group on
// the mesh — unlike "hip"/"hip(drv)", which turned out to be
// structural-only nodes with no deform influence at all). Bone-level
// scale on a REAL deform bone should propagate through Three.js's own
// skinning calculations the same way DAZ/Blender's does — same
// underlying glTF skinning spec, no format-specific workaround needed.
// maxDeviation of 0.3 (±30% at the slider's own ±100 extremes) is a
// conservative starting point, not a measured/calibrated value —
// worth tuning after a real visual check, same as every other real
// calibration this project has done.
function applyHeadBoneScale(meshEntries, headSizeVal) {
  if (!meshEntries || meshEntries.length === 0) return;
  const skeleton = meshEntries[0].mesh?.skeleton;
  if (!skeleton) return;
  const headBone = skeleton.bones.find((b) => b.name === "head");
  if (!headBone) {
    console.warn("[MiniGlbViewer] applyHeadBoneScale: 'head' bone not found in skeleton");
    return;
  }
  const maxDeviation = 0.3;
  const scale = 1 + sliderToInfluence(headSizeVal) * maxDeviation;
  headBone.scale.set(scale, scale, scale);
}

// applyUpperArmsMassScale REMOVED (Session 102) — it was a bone-scale
// sidestep for body_bs_MassUpperArms never producing a shape key. The
// bake list now targets body_bs_MassUpperarms (Diffeomorphic's actual
// exported key name), confirmed present in production GLB 704a7c5b via
// direct targetNames inspection — so massUpperArms is driven by the
// real shape key through the generic MORPH_NAMES loop like every other
// morph. Keeping the bone scale too would double-apply one slider
// (morph deformation + ±30% twist-bone scale simultaneously).

// Real (Session 101+) — body_ctrl_ProportionChestSize_scl, one of the
// 12 original _ctrl_ ERC meta-dials confirmed inaccessible via
// getNumModifiers() (same category as head_ctrl_ProportionHeadSize_scl
// above). Same bone-scale sidestep. l_pectoral/r_pectoral confirmed
// (real check, not assumed) use_deform=True with real vertex groups —
// chosen over spine3/spine4 (also confirmed real deform bones) since
// they're anatomically narrower to just the chest/pectoral region,
// where spine3/4 would also visibly affect back/shoulder geometry.
function applyChestSizeScale(meshEntries, chestSizeVal) {
  if (!meshEntries || meshEntries.length === 0) return;
  const skeleton = meshEntries[0].mesh?.skeleton;
  if (!skeleton) return;
  const maxDeviation = 0.3;
  const scale = 1 + sliderToInfluence(chestSizeVal) * maxDeviation;
  for (const boneName of ["l_pectoral", "r_pectoral"]) {
    const bone = skeleton.bones.find((b) => b.name === boneName);
    if (bone) bone.scale.set(scale, scale, scale);
    else console.warn(`[MiniGlbViewer] applyChestSizeScale: bone '${boneName}' not found in skeleton`);
  }
}

// Real (Session 101+) — body_ctrl_ProportionFootSize (+ L/R variants),
// another of the 12 _ctrl_ ERC meta-dials. l_foot/r_foot themselves
// confirmed use_deform=True with real vertex groups (unlike hip/
// l_upperarm, no need to drop down to a child bone here). Bilateral
// only — matches every other bone-scale slider so far (Head Size,
// Upper Arms Mass, Chest Size all move both sides together); no L/R
// split slider built, since nothing else in this UI does per-side
// control and the base morph itself doesn't distinguish either.
function applyFootSizeScale(meshEntries, footSizeVal) {
  if (!meshEntries || meshEntries.length === 0) return;
  const skeleton = meshEntries[0].mesh?.skeleton;
  if (!skeleton) return;
  const maxDeviation = 0.3;
  const scale = 1 + sliderToInfluence(footSizeVal) * maxDeviation;
  for (const boneName of ["l_foot", "r_foot"]) {
    const bone = skeleton.bones.find((b) => b.name === boneName);
    if (bone) bone.scale.set(scale, scale, scale);
    else console.warn(`[MiniGlbViewer] applyFootSizeScale: bone '${boneName}' not found in skeleton`);
  }
}

// Real (Session 101+) — body_ctrl_ProportionHandSize (+ L/R variants).
// Same pattern as Foot Size above — l_hand/r_hand confirmed real
// deform bones directly.
function applyHandSizeScale(meshEntries, handSizeVal) {
  if (!meshEntries || meshEntries.length === 0) return;
  const skeleton = meshEntries[0].mesh?.skeleton;
  if (!skeleton) return;
  const maxDeviation = 0.3;
  const scale = 1 + sliderToInfluence(handSizeVal) * maxDeviation;
  for (const boneName of ["l_hand", "r_hand"]) {
    const bone = skeleton.bones.find((b) => b.name === boneName);
    if (bone) bone.scale.set(scale, scale, scale);
    else console.warn(`[MiniGlbViewer] applyHandSizeScale: bone '${boneName}' not found in skeleton`);
  }
}

function applyMorphInfluences(meshEntries, torsoVal, armsVal, legsVal, heightVal, extraMorphValues = {}) {
  console.log(`[MiniGlbViewer] applyMorphInfluences called on ${meshEntries.length} mesh(es), values: torso=${torsoVal} arms=${armsVal} legs=${legsVal} height=${heightVal} extra=${JSON.stringify(extraMorphValues)}`);
  // Height-drives-torso/arms/legs logic deliberately lives in
  // CharacterWizard.jsx now, not here — it updates the actual
  // bodyTorsoLength/bodyArmsLength/bodyLegsLength state directly, so
  // the visible slider handles themselves move too, not just the
  // mesh underneath them silently diverging from what the UI shows.
  // This function stays a simple, direct pass-through of whatever
  // values it's given, same as it always was.
  const extraKeys = Object.keys(extraMorphValues);
  for (const { mesh, indices } of meshEntries) {
    console.log(`[MiniGlbViewer]   mesh "${mesh.name}": indices=${JSON.stringify(indices)}, morphTargetInfluences exists=${!!mesh.morphTargetInfluences}, length=${mesh.morphTargetInfluences?.length}, morphAttributes.position count=${mesh.geometry?.morphAttributes?.position?.length ?? "none"}`);
    if (indices.torsoLength !== undefined) mesh.morphTargetInfluences[indices.torsoLength] = sliderToInfluence(torsoVal);
    if (indices.armsLength !== undefined) mesh.morphTargetInfluences[indices.armsLength] = sliderToInfluence(armsVal);
    if (indices.legsLength !== undefined) mesh.morphTargetInfluences[indices.legsLength] = sliderToInfluence(legsVal);
    // The real body_bs_ProportionHeight shape key is deliberately never
    // applied here — confirmed broken (matches a documented DAZ bug:
    // this morph behaves like Body Mass instead of Height). Left out
    // of morphTargetInfluences entirely rather than applying known-broken
    // deformation data.

    // Generic application (Session 101+) — same pattern as the four
    // named ones above, just looped rather than one `if` per morph.
    // Any propKey present in both MORPH_NAMES and extraMorphValues (not
    // every mesh carries every morph — confirmed via check_shape_keys.py
    // earlier this project, body/clothing/mouth each have a different
    // subset) gets applied; a propKey with no matching index on THIS
    // mesh is silently skipped, same as the named ones handle it via
    // their own `!== undefined` guards.
    for (const key of extraKeys) {
      if (indices[key] !== undefined) {
        mesh.morphTargetInfluences[indices[key]] = sliderToInfluence(extraMorphValues[key]);
      }
    }
  }
}

// ---------------------------------------------------------------------
// Pose sliders via dial-delta calibration (Session 102)
//
// Each entry maps a pose slider to a pair of calibration GLBs exported
// by export_pose_variant.dsa + pose_blend_to_glb.py: the same ERC dial
// baked to bone keys at +1.0 and -1.0. Deltas are measured ENTIRELY in
// exported glTF space — calibration clip quaternion at t=0 against the
// calibration file's own node rest quaternion — so no DAZ->glTF axis
// conversion exists anywhere (the exact guesswork this design avoids).
// Because every character ships the identical skeleton from the same
// pipeline, one calibration file serves all characters by bone name.
// Applied post-mixer each frame (multiplying onto whatever the running
// idle wrote), same slot where the bone-scale sliders already win the
// frame — a pose slider therefore LAYERS OVER the animation.
const POSE_CALIBRATIONS = {
  // Served from inside the /media/actors mount — /media is NOT one
  // static root (worlds/ proxies to the simulator, actors/ serves
  // files; /media/poses matched neither and 404'd). Verified served:
  // 200, application/octet-stream, 46MB, via the ngrok origin.
  // pos/neg deliberately SWAPPED vs the DAZ dial: body_ctrl_ArmsUpDwn
  // positive means arms DOWN in DAZ's own convention; slider positive
  // should mean up. The files keep their honest DAZ-side names.
  armsUpDwn: { pos: "/media/actors/poses/armsUpDwn_neg.glb", neg: "/media/actors/poses/armsUpDwn_pos.glb" },
  // Single-sided (manually authored pose, export_pose_current.dsa):
  // slider blends bind -> pose over 0..100; negative half is dead.
  legsSpread: { pos: "/media/actors/poses/legs_spread.glb", neg: null },
};

// dialKey -> { boneName: { pos: THREE.Quaternion|null, neg: THREE.Quaternion|null } }
// Shared across viewer instances; loaded once, lazily.
const poseDeltaTables = {};
const poseDeltaLoading = {};

// Extracts ABSOLUTE pose targets: each quaternion track's t=0 sample.
// Deliberately no rest-pose reading and no filtering here — the
// calibration file's node TRS is NOT trustworthy as rest (the skinned
// exports carried bind pose there, the armature-only exports bake the
// evaluated POSE there — observed live as every delta collapsing to
// identity). The character's own bind snapshot is the single source
// of rest truth; filtering happens per-character at apply time.
function extractPoseTargets(gltf) {
  const clip = gltf.animations?.[0];
  if (!clip) return null;
  const targets = {};
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".quaternion")) continue;
    if (track.values.length < 4) continue;
    targets[track.name.slice(0, -".quaternion".length)] = new THREE.Quaternion().fromArray(track.values, 0);
  }
  return targets;
}

function ensurePoseCalibration(dialKey) {
  if (poseDeltaTables[dialKey] || poseDeltaLoading[dialKey]) return;
  const cfg = POSE_CALIBRATIONS[dialKey];
  if (!cfg) return;
  poseDeltaLoading[dialKey] = true;
  const draco = new DRACOLoader();
  draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  attachKtx2(loader);   // runtime GLBs carry KTX2 textures — see lib/gltfKtx2.js
  const table = {};
  const sides = ["pos", "neg"].filter((side) => cfg[side]); // single-sided entries have neg: null
  let pending = sides.length;
  const finish = () => {
    if (--pending > 0) return;
    poseDeltaTables[dialKey] = table;
    poseDeltaLoading[dialKey] = false;
    const n = Object.keys(table).length;
    console.log(`[MiniGlbViewer] pose calibration '${dialKey}' loaded: ${n} raw bone targets (per-character filtering happens on first apply)`);
    if (n === 0) console.error(`[MiniGlbViewer] pose calibration '${dialKey}' contains ZERO quaternion tracks — check the calibration GLBs`);
  };
  for (const side of sides) {
    loader.load(cfg[side],
      (gltf) => {
        const d = extractPoseTargets(gltf);
        if (d) for (const [bone, q] of Object.entries(d)) {
          if (!table[bone]) table[bone] = { pos: null, neg: null };
          table[bone][side] = q;
        }
        finish();
      },
      undefined,
      (err) => { console.error(`[MiniGlbViewer] pose calibration '${dialKey}' ${side} failed to load:`, err); finish(); }
    );
  }
}

// Override semantics (Session 102, v3 — replaces both the naive
// multiply AND the keyed/unkeyed accumulation guard). Composing the
// delta onto the running idle was mathematically "layering" but
// visually wrong: the 3DU idle contains real arm GESTURES, and
// gesture(40deg) x delta(45deg) overshot toward full raise on every
// gesture cycle ("arms go up 100% then settle, repeating") — and the
// calibration bake's pectoral entries (AlFan physics state in the
// live scene it was baked from) amplified the idle's breast sway into
// shaking. A pose slider means "HOLD this part here": posed bones are
// pinned to bindRest*delta absolutely every frame, post-mixer, while
// the idle keeps animating everything the pose doesn't touch. Bind
// rest is snapshotted at model load, before the mixer's first write.
function buildFilteredPoseTable(skeleton, dialKey, table) {
  // Filter the raw targets against THIS character's bind pose: only
  // bones the dial actually moves (>~0.5deg from bind on that side)
  // participate — pinning unmoved bones would freeze the idle on them.
  const entries = [];
  const names = [];
  for (const [boneName, entry] of Object.entries(table)) {
    const bone = skeleton.bones.find((b) => b.name === boneName);
    if (!bone || !bone.userData.poseBindQuat) continue;
    const bind = bone.userData.poseBindQuat;
    const keep = { bone, pos: null, neg: null };
    for (const side of ["pos", "neg"]) {
      const q = entry[side];
      if (q && bind.angleTo(q) > 0.009) keep[side] = q; // ~0.5deg
    }
    if (keep.pos || keep.neg) { entries.push(keep); names.push(`${boneName}(${keep.pos ? "+" : ""}${keep.neg ? "-" : ""})`); }
  }
  console.log(`[MiniGlbViewer] pose '${dialKey}': ${entries.length} bones move on this character:`, names.join(", "));
  if (entries.length === 0) console.error(`[MiniGlbViewer] pose '${dialKey}': ZERO moving bones after bind filtering — calibration targets match bind pose exactly?`);
  return entries;
}

// THREE.Skeleton is not an Object3D and has NO userData (found live:
// TypeError killed the render each frame the slider was nonzero) —
// per-skeleton filtered tables live in a module WeakMap instead, which
// also garbage-collects naturally when a character unloads.
const _poseFilteredCache = new WeakMap(); // skeleton -> { dialKey: entries }
// Session 146 — reusable temps for the per-frame pose-delta math; module-
// level so applyPoseValues allocates nothing per frame.
const _poseDeltaTmp = new THREE.Quaternion();
const _poseIdentityTmp = new THREE.Quaternion();
function applyPoseValues(meshEntries, poseValues) {
  if (!meshEntries?.length || !poseValues) return;
  const skeleton = meshEntries[0].mesh?.skeleton;
  if (!skeleton) return;
  for (const [dialKey, rawVal] of Object.entries(poseValues)) {
    const val = rawVal || 0;
    if (val === 0) continue;
    const table = poseDeltaTables[dialKey];
    if (!table) { ensurePoseCalibration(dialKey); continue; }
    let perSkel = _poseFilteredCache.get(skeleton);
    if (!perSkel) { perSkel = {}; _poseFilteredCache.set(skeleton, perSkel); }
    let filtered = perSkel[dialKey];
    if (!filtered) filtered = perSkel[dialKey] = buildFilteredPoseTable(skeleton, dialKey, table);
    const side = val > 0 ? "pos" : "neg";
    const t = Math.min(1, Math.abs(val) / 100);
    for (const entry of filtered) {
      const target = entry[side];
      if (!target) continue;
      // Absolute pin: from this character's bind toward the calibrated
      // pose, fraction t — post-mixer, so it overrides the animation on
      // exactly these bones and nothing else.
      // (Session 146 delta-layer experiment REVERTED same session: the
      // composed delta went wild on live animation. Do not re-attempt
      // per-frame delta composition here — if pose and animation must
      // ever coexist, solve it by scoping WHERE poses apply, not by
      // changing this math.)
      entry.bone.quaternion.copy(entry.bone.userData.poseBindQuat).slerp(target, t);
    }
  }
}

// ---------------------------------------------------------------------
// "Apply measured proportions" solve (Session 102)
//
// Measures the mesh the SAME WAY interpret_body.py measures the photo
// silhouette, so definitions cancel (the SAD's own principle from the
// Benny validation): rows located by height-fraction, front width =
// the contiguous X-run containing the body centre-line (excludes
// hanging arms — the exact outer-arm-to-outer-arm trap the photo tool
// hit first), depth = the largest Z-run (the photo tool's side-view
// rule), waist = narrowest torso run between shoulders and hips
// (matches waist_row_method: width_function_minimum), belly = max
// depth between the waist and hip rows. Positions are CPU-side rest
// pose + morph deltas — skinning is GPU-side, so the running idle
// animation cannot contaminate these numbers (same property
// computeBlendedY already relies on).
// Known approximation, stated not hidden: the chest row here is the
// midpoint between the shoulder and waist rows; the photo tool locates
// it from a MediaPipe landmark. Close, not identical — the one mapping
// below that does NOT fully cancel definitions.
function collectBlendedPoints(meshEntries) {
  const pts = [];
  const v = new THREE.Vector3();
  for (const { mesh } of meshEntries) {
    const posAttr = mesh.geometry.attributes.position;
    if (!posAttr) continue;
    const morphPos = mesh.geometry.morphAttributes?.position;
    const influences = mesh.morphTargetInfluences;
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i);
      if (morphPos && influences) {
        for (let m = 0; m < morphPos.length; m++) {
          const infl = influences[m];
          if (!infl) continue;
          v.x += morphPos[m].getX(i) * infl;
          v.y += morphPos[m].getY(i) * infl;
          v.z += morphPos[m].getZ(i) * infl;
        }
      }
      v.applyMatrix4(mesh.matrixWorld);
      pts.push(v.x, v.y, v.z);
    }
  }
  return pts;
}

// Extent of the contiguous run (values sorted, split at gaps > gapM)
// that contains `center`; null if no run contains it.
function runExtentContaining(sortedVals, center, gapM) {
  if (!sortedVals.length) return null;
  let runStart = sortedVals[0];
  let prev = sortedVals[0];
  for (let i = 1; i <= sortedVals.length; i++) {
    const cur = sortedVals[i];
    if (i === sortedVals.length || cur - prev > gapM) {
      if (center >= runStart && center <= prev) return prev - runStart;
      runStart = cur;
    }
    prev = cur;
  }
  return null;
}

// Extent of the largest contiguous run — the photo tool's side-view rule.
function largestRunExtent(sortedVals, gapM) {
  if (!sortedVals.length) return null;
  let best = 0;
  let runStart = sortedVals[0];
  let prev = sortedVals[0];
  for (let i = 1; i <= sortedVals.length; i++) {
    const cur = sortedVals[i];
    if (i === sortedVals.length || cur - prev > gapM) {
      if (prev - runStart > best) best = prev - runStart;
      runStart = cur;
    }
    prev = cur;
  }
  return best;
}

function measureBodyRows(meshEntries) {
  const pts = collectBlendedPoints(meshEntries);
  const n = pts.length / 3;
  if (n < 100) return null;
  let minY = Infinity, maxY = -Infinity, sumX = 0;
  for (let i = 0; i < n; i++) {
    const y = pts[i * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    sumX += pts[i * 3];
  }
  const heightM = maxY - minY;
  if (!(heightM > 0.2)) return null;
  const centerX = sumX / n;

  const BINS = 140;
  const GAP = 0.035; // 3.5cm — arm-to-torso gap threshold, both axes
  const MIN_PTS = 8; // sparse rows are unreliable — report null instead
  const rowX = Array.from({ length: BINS }, () => []);
  const rowZ = Array.from({ length: BINS }, () => []);
  for (let i = 0; i < n; i++) {
    let b = Math.floor(((pts[i * 3 + 1] - minY) / heightM) * BINS);
    if (b < 0) b = 0;
    if (b >= BINS) b = BINS - 1;
    rowX[b].push(pts[i * 3]);
    rowZ[b].push(pts[i * 3 + 2]);
  }
  const widths = new Array(BINS).fill(null);
  const depths = new Array(BINS).fill(null);
  for (let b = 0; b < BINS; b++) {
    if (rowX[b].length < MIN_PTS) continue;
    rowX[b].sort((a, c) => a - c);
    rowZ[b].sort((a, c) => a - c);
    widths[b] = runExtentContaining(rowX[b], centerX, GAP);
    depths[b] = largestRunExtent(rowZ[b], GAP);
  }
  const frac = (b) => (b + 0.5) / BINS;
  const argBest = (lo, hi, better) => {
    let bestB = -1;
    for (let b = 0; b < BINS; b++) {
      if (widths[b] === null) continue;
      const f = frac(b);
      if (f < lo || f > hi) continue;
      if (bestB === -1 || better(widths[b], widths[bestB])) bestB = b;
    }
    return bestB;
  };
  const shoulderB = argBest(0.70, 0.85, (a, c) => a > c);
  const hipB = argBest(0.40, 0.60, (a, c) => a > c);
  if (shoulderB === -1 || hipB === -1) return { heightM };
  // waist: narrowest run strictly between the hip and shoulder rows
  let waistB = -1;
  for (let b = hipB + 2; b < shoulderB - 2; b++) {
    if (widths[b] === null) continue;
    if (waistB === -1 || widths[b] < widths[waistB]) waistB = b;
  }
  const chestB = waistB !== -1 ? Math.round((shoulderB + waistB) / 2) : -1;
  let bellyDepthM = null;
  if (waistB !== -1) {
    for (let b = hipB; b <= waistB; b++) {
      if (depths[b] !== null && (bellyDepthM === null || depths[b] > bellyDepthM)) bellyDepthM = depths[b];
    }
  }
  // Waist circumference via Ramanujan ellipse from width + depth — the
  // photo tool's own waist_circumference_est_cm formula, so the two
  // cancel definitionally like every other row measurement here.
  let waistCircM = null;
  if (waistB !== -1 && widths[waistB] !== null && depths[waistB] !== null) {
    const a = widths[waistB] / 2, b = depths[waistB] / 2;
    waistCircM = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  }
  return {
    heightM,
    shoulderWidthM: widths[shoulderB],
    hipWidthM: widths[hipB],
    waistWidthM: waistB !== -1 ? widths[waistB] : null,
    waistDepthM: waistB !== -1 ? depths[waistB] : null,
    chestDepthM: chestB !== -1 ? depths[chestB] : null,
    bellyDepthM,
    waistCircM,
  };
}

// One-dimensional secant iteration: adjust a single slider until the
// measured dimension hits the target — the same shape as
// generate3d.js's own solveForTarget(), but client-side against
// instant morph application instead of DAZ round-trips.
function secantSolve({ setVal, measureKey, targetM, v0, meshEntries }) {
  const measure = () => {
    const m = measureBodyRows(meshEntries);
    return m ? m[measureKey] ?? null : null;
  };
  const clamp = (x) => Math.max(-100, Math.min(100, x));
  let v = clamp(v0);
  setVal(v);
  let cur = measure();
  if (cur === null) return { value: v0, achievedM: null, ok: false };
  const PROBE = 20;
  for (let it = 0; it < 3; it++) {
    if (Math.abs(cur - targetM) < 0.002) break; // 2mm — done
    const probeV = clamp(v + (v > 50 ? -PROBE : PROBE));
    setVal(probeV);
    const probed = measure();
    const slope = probed !== null ? (probed - cur) / (probeV - v) : 0;
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-5) {
      // Insensitive slider (dead morph or saturated) — restore and
      // report honestly rather than pretending it converged.
      setVal(v);
      return { value: v, achievedM: cur, ok: false };
    }
    v = clamp(v + (targetM - cur) / slope);
    setVal(v);
    cur = measure();
    if (cur === null) return { value: v, achievedM: null, ok: false };
  }
  return { value: Math.round(v), achievedM: cur, ok: true };
}

// targets, all in cm, any of them null to skip:
// { heightCm, shoulderWidthCm, waistWidthCm, hipWidthCm,
//   chestDepthCm, waistDepthCm, bellyDepthCm }
// Returns solved SLIDER values (the wizard writes them into state so
// the handles visibly move), plus a per-target report of achieved cm.
function solveBodyFromMeasurements(meshEntries, targets) {
  if (!meshEntries?.length) return null;
  const setKey = (propKey, sliderVal) => {
    const infl = sliderToInfluence(sliderVal);
    for (const { mesh, indices } of meshEntries) {
      if (indices[propKey] !== undefined) mesh.morphTargetInfluences[indices[propKey]] = infl;
    }
  };
  const getKey = (propKey) => {
    for (const { mesh, indices } of meshEntries) {
      if (indices[propKey] !== undefined) return (mesh.morphTargetInfluences[indices[propKey]] || 0) * 100;
    }
    return 0;
  };
  const report = {};
  const result = { extra: {} };

  // 1. Height first (everything else is measured under it). One scalar
  // drives torsoLength and legsLength together — a single unknown for a
  // single equation. The torso/legs SPLIT is deliberately not solved:
  // the photo's torso/legs rows and the mesh's hip-blend landmark are
  // different definitions (the SAD's landmark-vs-silhouette warning),
  // and fitting across mismatched definitions converges on the wrong
  // body. The split stays a human decision against the reference image.
  if (targets.heightCm) {
    const setPair = (v) => { setKey("torsoLength", v); setKey("legsLength", v); };
    const r = secantSolve({ setVal: setPair, measureKey: "heightM", targetM: targets.heightCm / 100, v0: getKey("torsoLength"), meshEntries });
    result.bodyTorsoLength = r.value;
    result.bodyLegsLength = r.value;
    report.height = { targetCm: targets.heightCm, achievedCm: r.achievedM !== null ? +(r.achievedM * 100).toFixed(1) : null, slider: r.value, ok: r.ok };
  }

  // 1.5 Global girth (Session 102, v2 — from the Benny run: local depth
  // sliders saturate far below a 139cm waist; BodyHeavy is the morph
  // that actually delivers global adiposity, confirmed manually at
  // Heavy=100 landing the silhouette). Solved against waist
  // CIRCUMFERENCE because a global fat morph moves width and depth
  // together — exactly what circumference captures — leaving the
  // locals below to fine-tune the width/depth split. If Heavy
  // saturates and circumference still falls short, the report says so
  // (ok:false) and Mass/Muscular stay a human choice: a silhouette
  // cannot tell fat from muscle.
  if (targets.waistCircCm) {
    // Bidirectional (Session 102 v3): measure at neutral girth first and
    // pick the channel by which side of the target the mesh sits on —
    // BodyHeavy for wider-than-default targets, BodyThin for slimmer.
    // Both clamped to >=0: each channel only pushes in its own
    // direction, never inverts into the other's territory.
    setKey("bodyHeavy", 0);
    setKey("bodyThin", 0);
    const neutral = measureBodyRows(meshEntries);
    const neutralCircM = neutral ? neutral.waistCircM : null;
    const targetM = targets.waistCircCm / 100;
    const channel = neutralCircM !== null && targetM < neutralCircM ? "bodyThin" : "bodyHeavy";
    const r = secantSolve({ setVal: (v) => setKey(channel, Math.max(0, v)), measureKey: "waistCircM", targetM, v0: 0, meshEntries });
    const solved = Math.max(0, r.value);
    if (r.ok || solved > 0) result.extra[channel] = solved;
    // The unused channel stays explicitly written at 0 so a re-run after
    // manual edits never leaves stale Heavy+Thin fighting each other.
    result.extra[channel === "bodyHeavy" ? "bodyThin" : "bodyHeavy"] = 0;
    report.girth = { targetCm: targets.waistCircCm, achievedCm: r.achievedM !== null ? +(r.achievedM * 100).toFixed(1) : null, slider: solved, channel, ok: r.ok };
  }

  // 2. Widths and depths, sequentially — interactions between these are
  // weak (each slider dominates its own row), verified by the height
  // re-check below rather than assumed.
  const mappings = [
    ["proportionShoulderWidth", "shoulderWidthM", targets.shoulderWidthCm, "shoulderWidth"],
    ["waistWidth", "waistWidthM", targets.waistWidthCm, "waistWidth"],
    ["hipSize", "hipWidthM", targets.hipWidthCm, "hipWidth"],
    ["proportionChestDepth", "chestDepthM", targets.chestDepthCm, "chestDepth"],
    ["waistDepth", "waistDepthM", targets.waistDepthCm, "waistDepth"],
    ["stomachDepth", "bellyDepthM", targets.bellyDepthCm, "bellyDepth"],
  ];
  for (const [propKey, measureKey, targetCm, label] of mappings) {
    if (!targetCm) continue;
    const r = secantSolve({ setVal: (v) => setKey(propKey, v), measureKey, targetM: targetCm / 100, v0: getKey(propKey), meshEntries });
    if (r.ok) result.extra[propKey] = r.value;
    report[label] = { targetCm, achievedCm: r.achievedM !== null ? +(r.achievedM * 100).toFixed(1) : null, slider: r.value, ok: r.ok };
  }

  // 3. Height re-check: girth morphs can nudge overall extent slightly.
  if (targets.heightCm) {
    const setPair = (v) => { setKey("torsoLength", v); setKey("legsLength", v); };
    const r = secantSolve({ setVal: setPair, measureKey: "heightM", targetM: targets.heightCm / 100, v0: result.bodyTorsoLength, meshEntries });
    result.bodyTorsoLength = r.value;
    result.bodyLegsLength = r.value;
    report.height.achievedCm = r.achievedM !== null ? +(r.achievedM * 100).toFixed(1) : report.height.achievedCm;
    report.height.slider = r.value;
  }

  result.report = report;
  return result;
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
    { y: DAZ_DEFAULT_HEIGHT, colour: 0xb05c08, radius: 0.42 }, // app's amber accent, marks DAZ's own confirmed default
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

// normaliseScale() — REMOVED (Session 101+), not just disconnected.
// It used to force-rescale every load to a client-side target height.
// This viewer does not decide height; generate3d.js does, before
// export. See DAZ_DEFAULT_HEIGHT's own comment above for the full
// reasoning. If a real reason to rescale on load ever comes back
// (e.g. genuinely inconsistent raw export units, confirmed, not
// assumed), rebuild this from git history rather than reintroducing
// dead code here.

// Loads a single fitted accessory GLB (hair, underwear top/bottom,
// etc.) and rebinds it to the main character's own, already-loaded
// skeleton — extracted from the original, hair-only version so any
// number of accessories can be loaded independently and
// simultaneously, each bound to the same shared skeleton with no
// interaction between them needed. See the call site's own comment
// for the full real-evidence backstory (bone-index remapping by name,
// confirmed structure, etc.) — unchanged here, just generalized past a
// single hardcoded slot.
//
// isMounted is a function, not a boolean, so it reflects the
// component's mounted state at the moment the async load actually
// completes, not at the moment loadAndBindAccessory was called.
// Load-time shrinkwrap — the body-aware replacement for uniform
// inflation (Session 101). For every clothing vertex, finds the closest
// point on the character's actual body surface (base positions plus
// whatever morph influences are active at load, evaluated on CPU); if
// the vertex sits inside the body or closer than clearanceMeters, it is
// pushed out to surfacePoint + faceNormal * clearance. Vertices already
// clear of the body — loose fabric spanning the thigh gap, strap spans —
// are left completely untouched, which is exactly what the uniform
// inflation could never do. Runs once at accessory load, BEFORE the
// baseline capture, so every downstream tool (scale/offset/rotation
// sliders, per-part adjustments) operates on an already-fitted garment.
// This fixes PENETRATION, not style — the manual controls remain the
// styling layer on top.
const ACCESSORY_SHRINKWRAP = {
  // Session 148 — extended per this config's own instruction, then
  // narrowed the same day on live evidence: /legs/ (jeans) genuinely
  // needed it and works; /torso/ was retracted within the hour — the
  // v6 resolver was tuned on TIGHT garments, and a loose pleated
  // blouse is its adversarial case (parity misreads verts folded
  // inside pleats as inside the BODY, resolve+smooth tears the
  // shoulders open, double-sided cutout shows dark interior
  // backfaces — confirmed live on the Angie top, Inspect vs a stale
  // pre-shrinkwrap Explore bake side by side). Loose torso garments
  // rarely penetrate anyway; if a future TIGHT top does, add its
  // specific path or build a tightness gate — do not blanket-enable
  // /torso/ again. /head/ (hair) stays excluded per the
  // ACCESSORY_INFLATE note above.
  // Session 152 — the Angie top's specific path, exactly as the note above
  // prescribes for a tight top. On a full-sculpt body (BodyMass 1.0) the bust
  // sits INSIDE this blouse's yoke: skin islands through the fabric below the
  // collar, at the neckline boundary where the skin-layer mask must keep skin.
  // Culling cannot fix a garment the body protrudes through at its own edge —
  // only fitting can. Shrinkwrap moves nothing on the parts of a loose blouse
  // that are already outside the body, so the drape survives; the bust region
  // gets pushed out to surface+2.5mm like every other fitted garment.
  pathFragments: ["/underwear/", "/legs/", "/feet/", "/torso/top/top_long_angie_top"],
  clearanceMeters: 0.0025, // fabric rests ~2.5mm above the skin
  maxSearchMeters: 0.12,   // vertices with no body surface within 12cm are ignored
  // Session 152, second iteration — direction, not distance, was the disease.
  //
  // On a BodyMass-100 male the garments arrive sized for a THIN man: the
  // landmark registration scales by bone distances, and morphs move vertices,
  // not bones. His flesh is therefore outside the authored fabric nearly
  // everywhere, and closest-point resolve hauled cloth THROUGH the belly fold
  // to whatever daylight was nearest — measured on Benny: all 5280 waistband
  // vertices, max 17.2cm, a crumpled fan (directions criss-cross inside a
  // concavity). A plain distance cap was tried first and swallowed the
  // garments whole — abandoning most of both.
  //
  // The cure the codebase already proved for thin bands (the Session 103
  // wrong-side guard): push RADIALLY OUTWARD from the body's central axis.
  // Radial directions from one axis never cross, so a ring stays a ring and a
  // big push is simply the garment inflating around the body it is worn on.
  // Pushes past radialAboveMeters resolve radially; only past
  // maxResolveMeters (a genuine teleport) is a vertex left buried.
  // 3cm caught the SLEEVES too (measured on Benny's shirt: sleeve fabric needs
  // 3-6cm toward the arm right beside it, and torso-radial hauled the sleeve
  // backs away from the arms they wrap — spikes and armpit tears). Closest-
  // point is correct wherever the target surface is near and locally
  // consistent; only the long cross-fold hauls (belly, crotch: 8-17cm) need
  // the radial field. The threshold sits between the two measured regimes.
  radialAboveMeters: 0.07,
  maxResolveMeters: 0.25,
  // Displacement-field smoothing (v5): without it, only genuinely-inside
  // vertices move while their just-outside neighbors stay frozen, so the
  // fabric creases and lumps exactly along the resolve boundary. Each
  // iteration blends every vertex's displacement with the average of its
  // topological neighbors' — feathering pushes outward into untouched
  // fabric like real cloth tension would.
  smoothIterations: 3,
  // Near-contact lift (v5): outside-but-within-clearance vertices
  // z-fight and let skin sparkle through at silhouettes. They are lifted
  // to clearance ONLY when the garment's own vertex normal roughly
  // agrees with the body face normal (dot > 0.3) — spanning fabric in a
  // concavity fails that test, so the v1 gluing failure stays
  // structurally impossible.
  nearContactLift: true,
  nearContactNormalDot: 0.3,
  // v6 convergence loop + hard assertion. Smoothing averages each
  // displacement with its neighbors, which UNDER-pushes the deepest
  // vertices — so a single resolve+smooth pass cannot promise zero
  // skin contact. The algorithm now loops resolve->smooth->re-verify
  // (same parity test) until a full verification pass finds zero
  // violations, up to maxPasses; any violators still left after the
  // final pass are hard-snapped to surface+clearance UNSMOOTHED —
  // correctness beats cosmetics for the last few vertices — and the
  // result is logged as an explicit ASSERT PASS/ENFORCED line.
  maxPasses: 4,
};

// Skeleton-landmark registration (Session 101, v7 of the fitting
// pipeline): SHRINKWRAP CANNOT PLACE A GARMENT — it only pushes
// vertices outward along normals, resolving penetration in place. A
// garment fitted to base G9 sits registered to base G9's landmarks
// (panties at base G9 hip height), and on a body whose hips are lower/
// shaped differently it hovers in the wrong place no matter how much
// contact is resolved. Fix, run BEFORE shrinkwrap: for each bone the
// garment's skin actually uses (weighted by total skin weight), take
// the positional delta between that bone in the garment's own rest
// skeleton and the SAME named bone in the character skeleton's bind
// pose, and translate the whole garment by the weight-averaged delta.
// Data-driven seating — correct for any future character/garment pair,
// no hardcoded nudges.
const ACCESSORY_REGISTRATION = {
  pathFragments: ["/underwear/"],
  enabled: true,
};

// Builds (once) and caches a BVH over the main body mesh's effective
// CPU-side surface: base vertex positions plus the mesh's CURRENT
// morphTargetInfluences (glTF morph targets are relative deltas —
// GLTFLoader sets morphTargetsRelative). Cached on the mesh's userData
// so the bra and the shorts in one load share a single build. Cache is
// per loaded model instance, so a fresh GLB load rebuilds naturally.
// Finds the actual BODY SKIN mesh among the character's 13 SkinnedMeshes.
// CRITICAL correction (found via console log, Session 101): the
// `mainSkinnedMesh` used for skeleton/bindMatrix reference is simply the
// FIRST SkinnedMesh in traversal order — "Genesis_9_Eyelashes_Mesh",
// 2028 verts — which is perfectly fine for binding (all 13 meshes share
// one skeleton) but catastrophically wrong as a "body surface": the
// shrinkwrap parity test was asking whether underwear vertices sit
// inside the EYELASHES, answered 0/N every time, and silently no-opped
// in every algorithm version. That is also why three successive
// algorithm changes produced pixel-identical renders. The body skin is
// selected as the largest SkinnedMesh by vertex count (Genesis9, the
// mesh carrying all 4 shape morphs), never by traversal order.
function findBodySkinMesh(referenceMesh) {
  let root = referenceMesh;
  while (root.parent) root = root.parent;
  let best = null;
  root.traverse((obj) => {
    // Session 142 (restoring a Session 106 fix this deployed file had
    // lost): garments are SkinnedMeshes too, and big ones (hair,
    // 384k verts) outbid every ~8k-vert body-skin primitive — the
    // confirmed root cause of garments shrinkwrapping against EACH
    // OTHER, order-dependent. Accessory meshes can never be the body.
    if (obj.isSkinnedMesh && !obj.userData?.isAccessoryMesh && (!best || obj.geometry.attributes.position.count > best.geometry.attributes.position.count)) {
      best = obj;
    }
  });
  return best || referenceMesh;
}

// Builds (once) and caches a BVH over the character's FULL body-skin
// surface. Second critical correction (Session 101, via console log):
// the body skin is itself SEVEN primitives (Genesis9..Genesis9_6 — the
// same per-material multi-primitive split as every garment tonight), so
// "largest SkinnedMesh" selected one 8350-vertex open PATCH of skin.
// An open patch has no interior — rays cross it 0 or 1 times — so the
// parity test still answered 0/N inside for everything. The correct
// surface is ALL body primitives merged, and the structural way to find
// them is that they are SIBLINGS: children of the same glTF mesh-node
// parent. So: largest SkinnedMesh -> its parent -> merge every
// SkinnedMesh child (morph influences applied on CPU; glTF morphs are
// relative deltas) into one geometry, and build the BVH over that.
// Cached on the parent's userData so all garments in one load share a
// single build. Known limitation, deliberate: mouth/eye interior
// shells are separate meshes NOT included here, and the skin has holes
// at the head — both irrelevant for below-neck garments with the
// horizontal parity rays.
function getBodySurfaceBVH(referenceMesh) {
  const largest = findBodySkinMesh(referenceMesh);
  const bodyParent = largest.parent || largest;
  // Session 142 (restoring a Session 106 fix this deployed file had
  // lost): VALIDATE the cache, never truthiness-check it. A dressed
  // export JSON-flattens userData; a reload can resurrect a hollow
  // shrinkwrapBVH entry that is truthy but not a usable cache —
  // confirmed incident: TypeError in shrinkwrapToBody, all garments
  // dropped. Real bvh + real BufferGeometry + position attribute, or
  // rebuild.
  {
    const c = bodyParent.userData.shrinkwrapBVH;
    if (c && c.bvh && c.geom?.isBufferGeometry && c.geom.attributes?.position) return c;
    if (c) delete bodyParent.userData.shrinkwrapBVH;
  }
  const t0 = performance.now();

  const parts = (bodyParent.children || []).filter((c) => c.isSkinnedMesh);
  if (parts.length === 0) parts.push(largest);

  let totalVerts = 0;
  let totalIndices = 0;
  for (const p of parts) {
    totalVerts += p.geometry.attributes.position.count;
    totalIndices += p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count;
  }

  const mergedPos = new Float32Array(totalVerts * 3);
  const mergedIndex = new Uint32Array(totalIndices);
  let vOff = 0;
  let iOff = 0;
  for (const p of parts) {
    const srcGeom = p.geometry;
    const base = srcGeom.attributes.position;
    // Base positions + this part's current morph influences.
    const morphed = Float32Array.from(base.array.subarray(0, base.count * 3));
    const morphAttrs = (srcGeom.morphAttributes && srcGeom.morphAttributes.position) || [];
    const influences = p.morphTargetInfluences || [];
    for (let m = 0; m < morphAttrs.length; m++) {
      const w = influences[m] || 0;
      if (w === 0) continue;
      const d = morphAttrs[m];
      for (let i = 0; i < base.count; i++) {
        morphed[i * 3] += d.getX(i) * w;
        morphed[i * 3 + 1] += d.getY(i) * w;
        morphed[i * 3 + 2] += d.getZ(i) * w;
      }
    }
    mergedPos.set(morphed, vOff * 3);
    if (srcGeom.index) {
      const idx = srcGeom.index;
      for (let i = 0; i < idx.count; i++) mergedIndex[iOff + i] = idx.getX(i) + vOff;
      iOff += idx.count;
    } else {
      for (let i = 0; i < base.count; i++) mergedIndex[iOff + i] = vOff + i;
      iOff += base.count;
    }
    vOff += base.count;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(mergedPos, 3));
  geom.setIndex(new THREE.BufferAttribute(mergedIndex, 1));
  const bvh = new MeshBVH(geom);
  const cached = { bvh, geom };
  bodyParent.userData.shrinkwrapBVH = cached;
  console.log(`[MiniGlbViewer] Shrinkwrap: body surface BVH built by MERGING ${parts.length} body-skin primitive(s) [${parts.map((p) => `"${p.name}" ${p.geometry.attributes.position.count}v`).join(", ")}] -> ${totalVerts} verts total, morphs applied, in ${(performance.now() - t0).toFixed(0)}ms.`);
  return cached;
}

// Resolves body penetration for one accessory primitive, in place, on
// its raw geometry positions. Both meshes live in the same bind space
// (directly confirmed: shorts raw bbox at y 0.77-0.99, body rawHeight
// 1.8254, identical space), and both deform with the same skeleton
// afterwards, so a rest-space fit stays valid through animation to the
// same degree the skinning weights agree — which is the same assumption
// the whole shared-skeleton binding already makes.
// Session 103 — position snapshots must be POSITION-ONLY, read/written
// through the attribute API: raw .array on INTERLEAVED geometry
// (Blender/Draco exports) is the shared stride buffer for every
// attribute — a whole-buffer snapshot captured pre-remap and restored
// post-remap silently REVERTED skinIndex to the accessory's local
// numbering against the main skeleton's 254 bones (vertex explosion on
// refit; DAZ's separate buffers made the old code accidentally safe).
export function capturePositions(attr) {
  const out = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) { out[i*3] = attr.getX(i); out[i*3+1] = attr.getY(i); out[i*3+2] = attr.getZ(i); }
  return out;
}
function restorePositions(attr, saved) {
  for (let i = 0; i < attr.count; i++) attr.setXYZ(i, saved[i*3], saved[i*3+1], saved[i*3+2]);
  attr.needsUpdate = true;
}

// Session 141 — tint was a config value with no consumer: AccessoryEditor
// emits `tint` per garment (and per-part tints inside `parts[matName].tint`,
// see buildViewerAccessories), the panel persists both to draft_state, and
// nothing anywhere ever applied either to a material. First real consumer.
// White-authoring standard (Base Color -> None in DAZ, chip white) is what
// makes a plain color.set the correct tint operation — the color channel
// multiplies the texture, so white = untinted. Apply-if-present rule:
// materials are only touched when a tint value exists for the garment or
// part (the UI's "white" reset stores "#ffffff" explicitly, which correctly
// restores the white-authored base); garments with no tint configured keep
// whatever their authored materials say, so non-conforming assets aren't
// silently repainted. Exported so ActorModelPanel's Explore mirror uses the
// SAME operation on its own copy of the meshes.
export function applyAccessoryTint(mesh, hex) {
  if (!hex) return;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) { if (m && m.color) m.color.set(hex); }
}

function shrinkwrapToBody(accessoryMesh, mainSkinnedMesh, accessoryUrl) {
  const { bvh, geom } = getBodySurfaceBVH(mainSkinnedMesh);
  const bodyPos = geom.attributes.position;
  const bodyIndex = geom.index;
  const posAttr = accessoryMesh.geometry.attributes.position;
  const clearance = ACCESSORY_SHRINKWRAP.clearanceMeters;
  const garmentNormals = accessoryMesh.geometry.attributes.normal;

  // History of this function (Session 101, keep — each version failed
  // for a general reason):
  // v1 closest-point normal-sign inside test -> glued spanning fabric
  //    into concavities (normal sign is not an inside test there).
  // v2 single upward parity ray -> threaded the head's holes (nostrils,
  //    eyes, mouth), flipping parity for everything below the neck.
  // v3 BVH over the wrong mesh (eyelashes; then one open skin patch) ->
  //    parity 0/N, silent no-op. Body skin is itself 7 primitives and
  //    must be MERGED (see getBodySurfaceBVH).
  // v4 horizontal 3-ray majority parity, single resolve pass.
  // v5 displacement field + Laplacian smoothing + gated near-contact
  //    lift -> smoothing under-pushes the deepest vertices; no
  //    zero-contact guarantee.
  // v6 (current): convergence loop + hard assertion — see config note.

  const rayDirs = [
    new THREE.Vector3(0.093, 0.031, 0.995).normalize(),
    new THREE.Vector3(0.719, 0.024, -0.694).normalize(),
    new THREE.Vector3(-0.757, 0.041, -0.652).normalize(),
  ];
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3());
  const p = new THREE.Vector3();
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  const toP = new THREE.Vector3();
  const target = { point: new THREE.Vector3() };

  const isInsideBody = (px, py, pz) => {
    let votes = 0;
    for (const dir of rayDirs) {
      ray.origin.set(px, py, pz);
      ray.direction.copy(dir);
      const hits = bvh.raycast(ray, THREE.DoubleSide);
      let crossings = 0;
      for (const h of hits) if (h.distance > 1e-6) crossings++;
      if ((crossings & 1) === 1) votes++;
    }
    return votes >= 2;
  };

  // Computes the closest surface point + outward face normal for p.
  // Returns false for no surface in reach / degenerate triangle.
  const surfaceAt = () => {
    const hit = bvh.closestPointToPoint(p, target, 0, ACCESSORY_SHRINKWRAP.maxSearchMeters);
    if (!hit) return false;
    const f = target.faceIndex * 3;
    const ia = bodyIndex ? bodyIndex.getX(f) : f;
    const ib = bodyIndex ? bodyIndex.getX(f + 1) : f + 1;
    const ic = bodyIndex ? bodyIndex.getX(f + 2) : f + 2;
    va.fromBufferAttribute(bodyPos, ia);
    vb.fromBufferAttribute(bodyPos, ib);
    vc.fromBufferAttribute(bodyPos, ic);
    n.crossVectors(e1.subVectors(vb, va), e2.subVectors(vc, va));
    if (n.lengthSq() === 0) return false;
    n.normalize();
    return true;
  };

  // One field computation over current positions. Returns violation count.
  // Session 103 — the wrong-side guard is gated to ABOVE THE FORK: the
  // flip failure lives in top bands (waistband, collar) where the body
  // is ONE volume and the radial test is valid; below the fork there
  // are TWO volumes side by side and the central-axis radial
  // legitimately points "inward" toward the other thigh — the ungated
  // guard shot legband vertices across the gap (found live: shards on
  // the thighs). Below the gate, original nearest-surface behavior,
  // which never had thigh issues.
  //
  // Session 104 — that gate used to be a FIXED body-height-percentage
  // window (52-57%), reverse-tuned to exactly the two garments tested
  // at the time (a bra band, a panties waistband). Confirmed via live
  // log evidence this doesn't generalize: a shorts waistband on a tall
  // (184cm) body sat at ~84cm, just under the 52% floor, got ZERO
  // guard protection, and needed 430 vertices hard-snapped after 4
  // failed smoothing passes (47% of its own vertices started inside
  // the body) — visibly crooked in the rendered result. A shirt
  // collar, well above the old 57% ceiling, hit the same gap from the
  // other direction — worse, since nothing bounded how far wrong it
  // could go.
  //
  // Session 105 — the Session 104 fix (swap the percentage for the
  // skeleton's "hip" bone position) was ALSO wrong, confirmed live the
  // same way: hip bone at 99.9cm, shorts waistband at 84cm — a 16cm
  // gap, garment still excluded. The "hip" bone is the pelvis's
  // skeletal origin, not the point where the mesh geometry actually
  // splits into two leg volumes; conflating the two landmarks
  // reproduced the same bug with a different wrong number. Stop
  // guessing at what represents the fork and TEST the actual condition
  // the guard depends on: is the body's own central axis (x=0, z=0 —
  // the same axis every radial-push calculation below already
  // assumes) still inside solid geometry at this primitive's height?
  // Above the fork, yes (one torso volume). Below it, that axis sits
  // in open air between the two legs, so isInsideBody — the exact same
  // test this function already runs on every vertex, not a second,
  // different heuristic that can quietly disagree with it — returns
  // false.
  let guardActive = false;
  {
    let gMinY = Infinity, gMaxY = -Infinity;
    for (let i = 0; i < posAttr.count; i++) { const y = posAttr.getY(i); if (y < gMinY) gMinY = y; if (y > gMaxY) gMaxY = y; }
    const spanY = gMaxY - gMinY, centerY = (gMinY + gMaxY) / 2;
    // Thin BAND primitives (spanY < 12cm) whose own center sits on
    // solid body at the central axis get the guard on EVERY vertex;
    // everything else gets none. Panels never flipped; legbands only
    // broke BECAUSE of the ungated guard.
    guardActive = spanY < 0.12 && isInsideBody(0, centerY, 0);
    if (guardActive) console.log(`[MiniGlbViewer] wrong-side guard ACTIVE for band primitive "${accessoryMesh.name}" (span ${(spanY*100).toFixed(1)}cm, center ${(centerY*100).toFixed(1)}cm)`);
  }
  const computeField = (disp) => {
    disp.fill(0);
    let violations = 0;
    let maxPush = 0;
    let abandoned = 0;
    for (let i = 0; i < posAttr.count; i++) {
      p.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      const inside = isInsideBody(p.x, p.y, p.z);
      if (!surfaceAt()) continue;
      if (inside) {
        violations++;
        // Session 103 — WRONG-SIDE GUARD for inside vertices: the
        // nearest surface for a vertex deep inside a limb/hip ring is
        // often the OPPOSITE side of the body, and resolving toward it
        // flips thin ring parts (a panties waistband) inside-out into
        // a flared hoop (found live, chaos-sensitive to mm of initial
        // placement — "satt fint förut, snett nu"). Sanity test: the
        // resolve direction must not point INWARD radially (toward the
        // body's central axis at this height, x≈0/z≈0 in bind space).
        // When it does, re-aim: push RADIALLY OUTWARD to the surface
        // via the same closest-point query from a point nudged outward.
        if (guardActive) {
          const rx = p.x, rz = p.z;
          const rlen = Math.hypot(rx, rz);
          if (rlen > 1e-4) {
            const dirx = target.point.x + n.x * clearance - p.x;
            const dirz = target.point.z + n.z * clearance - p.z;
            const dot = (dirx * rx + dirz * rz) / rlen;
            if (dot < -0.002) { // pushing >2mm radially INWARD — wrong side chosen
              const probe = p.clone();
              probe.x += (rx / rlen) * ACCESSORY_SHRINKWRAP.maxSearchMeters * 0.6;
              probe.z += (rz / rlen) * ACCESSORY_SHRINKWRAP.maxSearchMeters * 0.6;
              const t2 = { point: new THREE.Vector3(), faceIndex: 0 };
              const hit2 = bvh.closestPointToPoint(probe, t2, 0, ACCESSORY_SHRINKWRAP.maxSearchMeters);
              if (hit2) {
                target.point.copy(t2.point);
                n.set((rx / rlen), 0, (rz / rlen)); // outward radial as the lift direction
              }
            }
          }
        }
        let push = target.point.distanceTo(p) + clearance;
        // Large push: re-aim radially outward (see radialAboveMeters above) —
        // same probe mechanics as the band guard, applied by push size.
        if (push > ACCESSORY_SHRINKWRAP.radialAboveMeters) {
          const rlen = Math.hypot(p.x, p.z);
          if (rlen > 1e-4) {
            const probe = p.clone();
            probe.x += (p.x / rlen) * ACCESSORY_SHRINKWRAP.maxSearchMeters * 0.6;
            probe.z += (p.z / rlen) * ACCESSORY_SHRINKWRAP.maxSearchMeters * 0.6;
            const t2 = { point: new THREE.Vector3(), faceIndex: 0 };
            const hit2 = bvh.closestPointToPoint(probe, t2, 0, ACCESSORY_SHRINKWRAP.maxSearchMeters);
            if (hit2) {
              target.point.copy(t2.point);
              n.set(p.x / rlen, 0, p.z / rlen);
              push = target.point.distanceTo(p) + clearance;
            }
          }
        }
        if (push > ACCESSORY_SHRINKWRAP.maxResolveMeters) {
          violations--;
          abandoned++;
          continue;
        }
        disp[i * 3] = target.point.x + n.x * clearance - p.x;
        disp[i * 3 + 1] = target.point.y + n.y * clearance - p.y;
        disp[i * 3 + 2] = target.point.z + n.z * clearance - p.z;
        if (push > maxPush) maxPush = push;
      } else if (ACCESSORY_SHRINKWRAP.nearContactLift && garmentNormals) {
        const signed = toP.subVectors(p, target.point).dot(n);
        if (signed >= 0 && signed < clearance) {
          const agree = garmentNormals.getX(i) * n.x + garmentNormals.getY(i) * n.y + garmentNormals.getZ(i) * n.z;
          if (agree > ACCESSORY_SHRINKWRAP.nearContactNormalDot) {
            violations++;
            const lift = clearance - signed;
            disp[i * 3] = n.x * lift;
            disp[i * 3 + 1] = n.y * lift;
            disp[i * 3 + 2] = n.z * lift;
          }
        }
      }
    }
    return { violations, maxPush, abandoned };
  };

  // Adjacency (once) for the smoothing passes.
  const idx = accessoryMesh.geometry.index;
  const neighbors = Array.from({ length: posAttr.count }, () => new Set());
  if (idx) {
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      neighbors[a].add(b); neighbors[a].add(c);
      neighbors[b].add(a); neighbors[b].add(c);
      neighbors[c].add(a); neighbors[c].add(b);
    }
  }

  const smoothAndApply = (disp) => {
    let field = disp;
    for (let it = 0; it < ACCESSORY_SHRINKWRAP.smoothIterations; it++) {
      const next = new Float32Array(field.length);
      for (let i = 0; i < posAttr.count; i++) {
        const nb = neighbors[i];
        if (nb.size === 0) {
          next[i * 3] = field[i * 3]; next[i * 3 + 1] = field[i * 3 + 1]; next[i * 3 + 2] = field[i * 3 + 2];
          continue;
        }
        let ax = 0, ay = 0, az = 0;
        for (const j of nb) { ax += field[j * 3]; ay += field[j * 3 + 1]; az += field[j * 3 + 2]; }
        const inv = 1 / nb.size;
        next[i * 3] = 0.5 * field[i * 3] + 0.5 * ax * inv;
        next[i * 3 + 1] = 0.5 * field[i * 3 + 1] + 0.5 * ay * inv;
        next[i * 3 + 2] = 0.5 * field[i * 3 + 2] + 0.5 * az * inv;
      }
      field = next;
    }
    for (let i = 0; i < posAttr.count; i++) {
      posAttr.setXYZ(i, posAttr.getX(i) + field[i * 3], posAttr.getY(i) + field[i * 3 + 1], posAttr.getZ(i) + field[i * 3 + 2]);
    }
  };

  // Convergence loop: resolve+smooth, re-verify, repeat.
  const t0 = performance.now();
  const disp = new Float32Array(posAttr.count * 3);
  let passes = 0;
  let firstViolations = 0;
  let firstMaxPush = 0;
  let residual = 0;
  let buried = 0;
  while (passes < ACCESSORY_SHRINKWRAP.maxPasses) {
    const { violations, maxPush, abandoned } = computeField(disp);
    buried = abandoned;
    if (passes === 0) { firstViolations = violations; firstMaxPush = maxPush; }
    residual = violations;
    if (violations === 0) break;
    smoothAndApply(disp);
    passes++;
  }

  // Hard assertion: whatever smoothing left behind is snapped exactly,
  // unsmoothed, so the guarantee holds.
  let enforced = 0;
  if (residual > 0) {
    const { violations } = computeField(disp);
    for (let i = 0; i < posAttr.count; i++) {
      const dx = disp[i * 3], dy = disp[i * 3 + 1], dz = disp[i * 3 + 2];
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        posAttr.setXYZ(i, posAttr.getX(i) + dx, posAttr.getY(i) + dy, posAttr.getZ(i) + dz);
        enforced++;
      }
    }
    residual = violations;
  }
  posAttr.needsUpdate = true;

  const status = (residual === 0 ? "ASSERT PASS (converged)" : (enforced > 0 ? `ASSERT ENFORCED (${enforced} vertices hard-snapped after ${passes} smoothed passes)` : "ASSERT PASS"))
    + (buried > 0 ? ` — ${buried} vertex(es) left buried in flesh (push exceeded ${(ACCESSORY_SHRINKWRAP.maxResolveMeters * 100).toFixed(1)}cm cap)` : "");
  console.log(`[MiniGlbViewer] Shrinkwrap v6: "${accessoryMesh.name}" (${accessoryUrl}) — initial violations ${firstViolations}/${posAttr.count} (max push ${(firstMaxPush * 1000).toFixed(1)}mm), ${passes} resolve+smooth pass(es), ${status}, clearance ${(clearance * 1000).toFixed(1)}mm, ${(performance.now() - t0).toFixed(0)}ms.`);
}

// Applies a scale AND a translation offset to an accessory mesh's
// geometry, always computing from the TRUE baseline (pre-scale)
// positions passed in, never from whatever the geometry's current,
// possibly-already-transformed state is — that's what makes this safe
// to call repeatedly on every slider drag without compounding
// transforms. Deliberately operates on raw vertex data (not the mesh's
// own .position/.scale transforms — those must stay identity for the
// skeletal-binding math), consistent with how this always worked.
// Offset is in model space, native units (meters): Y up/down,
// Z front/back, X sideways. Added AFTER scaling, as a constant shift
// of the whole garment — the tool for placement fixes (e.g. a crotch
// hem riding too high) that scaling around the bbox center can never
// express. Name kept as applyAccessoryScale (working function, never
// renamed); offset defaults to zero so every existing call stays valid.
export function applyAccessoryScale(mesh, originalPositions, center, scale, offset = { x: 0, y: 0, z: 0 }, rotation = { x: 0, y: 0, z: 0 }) {
  const posAttr = mesh.geometry.attributes.position;
  // Rotation is given in DEGREES (UI-friendly), applied around this
  // part's own center, AFTER scale and BEFORE offset: scale sizes the
  // part in place, rotation tilts it in place, offset then moves it.
  // XYZ Euler order. Zero rotation takes the fast path with no matrix.
  const hasRot = rotation.x !== 0 || rotation.y !== 0 || rotation.z !== 0;
  if (!hasRot) {
    for (let i = 0; i < posAttr.count; i++) {
      posAttr.setXYZ(
        i,
        (originalPositions[i * 3] - center.x) * scale.x + center.x + offset.x,
        (originalPositions[i * 3 + 1] - center.y) * scale.y + center.y + offset.y,
        (originalPositions[i * 3 + 2] - center.z) * scale.z + center.z + offset.z
      );
    }
  } else {
    const d2r = Math.PI / 180;
    const rotMat = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotation.x * d2r, rotation.y * d2r, rotation.z * d2r, "XYZ"));
    const v = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      v.set(
        (originalPositions[i * 3] - center.x) * scale.x,
        (originalPositions[i * 3 + 1] - center.y) * scale.y,
        (originalPositions[i * 3 + 2] - center.z) * scale.z
      ).applyMatrix4(rotMat);
      posAttr.setXYZ(i, v.x + center.x + offset.x, v.y + center.y + offset.y, v.z + center.z + offset.z);
    }
  }
  posAttr.needsUpdate = true;
  mesh.geometry.computeBoundingBox();
}

// Combines the garment-level scale/offset with an optional per-part
// adjustment for one primitive (looked up by the part's material name):
// scales MULTIPLY component-wise, offsets ADD. This is what lets a bra
// be fitted as a whole first, then its cups ("Bra_Main") given more
// volume and its band ("Bra_Underbust") pulled snug independently,
// without the parts fighting the garment-level fit.
export function effectiveTransform(garmentScale, garmentOffset, garmentRotation, parts, matName) {
  const gs = garmentScale || { x: 1, y: 1, z: 1 };
  const go = garmentOffset || { x: 0, y: 0, z: 0 };
  const gr = garmentRotation || { x: 0, y: 0, z: 0 };
  const p = parts?.[matName];
  if (!p) return { scale: gs, offset: go, rotation: gr };
  const ps = p.scale || { x: 1, y: 1, z: 1 };
  const po = p.offset || { x: 0, y: 0, z: 0 };
  const pr = p.rotation || { x: 0, y: 0, z: 0 };
  return {
    scale: { x: gs.x * ps.x, y: gs.y * ps.y, z: gs.z * ps.z },
    offset: { x: go.x + po.x, y: go.y + po.y, z: go.z + po.z },
    // Rotations ADD (degrees) — garment tilt plus part tilt. Note the
    // part rotates around its OWN center, so a garment-level rotation
    // tilts each part in place rather than swinging parts around one
    // shared pivot — for whole-garment tilts keep values small.
    rotation: { x: gr.x + pr.x, y: gr.y + pr.y, z: gr.z + pr.z },
  };
}

// Session 152 — everything that must be true once the wardrobe settles, in
// layer order: hair is lifted over the clothing beneath it (fitOuterLayers),
// its manual-fit baseline recaptured so slider math builds on the layered
// shape, and only then is the skin mask computed. One function, because three
// call sites (settled load, finished load, body refit) were each going to
// repeat the sequence and drift.
function settleLayers(loadedRoot, store, accessories) {
  // Hair gets the same four-step discipline the refit effect uses for
  // shrinkwrapped garments, and for the same reason: anything that bakes into
  // positions must restore its raw shape first, or repeated passes compound.
  // The first version recaptured the manual-fit baseline AFTER the manual
  // transform was applied — settle twice with a manual hair tweak set and the
  // tweak doubles.
  const hairEntries = [];
  for (const [url, entries] of Object.entries(store || {})) {
    if (!url.includes("/head/hair/")) continue;
    for (const e of entries) {
      if (e.mesh && e.prefitPositions) hairEntries.push({ url, e });
    }
  }

  // 1. Back to the raw load shape — settles are now idempotent.
  for (const { e } of hairEntries) {
    restorePositions(e.mesh.geometry.attributes.position, e.prefitPositions);
    e.mesh.geometry.attributes.position.needsUpdate = true;
  }

  // 2. Lift the hair over the clothing exactly as it is currently fitted,
  //    manual transforms included — a top scaled up by its slider is a bigger
  //    surface to rest on, which is precisely the case that exposed this.
  fitOuterLayers(loadedRoot, store);

  // 3. The layered shape becomes the manual-fit baseline, and the manual
  //    transform re-applies on top — same order as the body refit.
  for (const { url, e } of hairEntries) {
    e.originalPositions = capturePositions(e.mesh.geometry.attributes.position);
    e.mesh.geometry.computeBoundingBox();
    e.mesh.geometry.boundingBox.getCenter(e.center);
    const acc = (accessories || []).find((a) => a.url === url);
    const t = effectiveTransform(acc?.scale, acc?.offset, acc?.rotation, acc?.parts, e.matName);
    applyAccessoryScale(e.mesh, e.originalPositions, e.center, t.scale, t.offset, t.rotation);
  }

  applySkinLayers(loadedRoot, store);
}

function loadAndBindAccessory(accessoryUrl, mainSkinnedMesh, mainSkeleton, loadedRoot, dracoLoader, isMounted, manualScale, manualOffset, manualRotation, manualParts, accessoryMeshesStore, statureHeightM = null, manualTint = null) {
  // Returns a Promise that always resolves (never rejects) once this
  // accessory's load has either succeeded, failed, or been skipped for
  // any reason — lets the caller wait for every accessory to genuinely
  // finish before considering the character "fully loaded," rather
  // than the fire-and-forget original where the loading spinner could
  // hide well before a selected accessory had actually appeared.
  return new Promise((resolve) => {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);
    attachKtx2(loader);   // runtime GLBs carry KTX2 textures — see lib/gltfKtx2.js
    loader.load(
      accessoryUrl,
      (gltf) => {
        if (!isMounted()) { resolve(); return; }
        // ROOT CAUSE of the Session 100 "two rings around the thighs"
        // bug, found via direct evidence (identical md5 on Mac and
        // server; Blender reads the same GLB as 8643 verts / 3
        // materials while this code rendered 550 verts / 1 material):
        // a multi-material mesh exports as MULTIPLE glTF primitives,
        // which GLTFLoader loads as MULTIPLE SkinnedMesh objects — the
        // shorts are three (Trim, Pants, Waistband), exactly like the
        // main character's own Genesis9/Genesis9_1/... split. The old
        // code here took only the FIRST SkinnedMesh found, so only the
        // 550-vertex Trim primitive (the edging around the two leg
        // openings — literally two rings) was ever bound and rendered;
        // Pants and Waistband were silently discarded. Hair never hit
        // this because it's a single-material, single-primitive mesh.
        // Every mesh must be remapped and bound, not just the first.
        const accessoryMeshes = [];
        gltf.scene.traverse((obj) => { if (obj.isSkinnedMesh) accessoryMeshes.push(obj); });

        if (accessoryMeshes.length === 0) {
          console.error(`[MiniGlbViewer] Accessory load (${accessoryUrl}): no SkinnedMesh found in the loaded GLB.`);
          resolve();
          return;
        }

        // All primitives of one glTF skin share the same Skeleton
        // instance in Three.js, so the accessory's own bone list can be
        // read from any of them.
        const accessoryBones = accessoryMeshes[0].skeleton.bones;

        // STATURE SCALE (Session 102, the user's 170-law): garments are
        // authored fitted on the 170cm DAZ base, and the shared G9
        // skeleton keeps them at the 170 line regardless of the body's
        // MORPH-driven stature — a tall/short body slides out of its
        // clothes (observed live: bra hanging in space on a re-heighted
        // character). Fix is deterministic arithmetic, not measurement
        // heuristics: factor = measured mesh height / 1.70, uniform,
        // about the ORIGIN (feet at y=0) so size AND placement follow
        // stature together. Applied BEFORE prefit capture and wrap, so
        // every baseline downstream is stature-correct and the wrap
        // only handles residual form. Clamped [0.8, 1.3] — outside
        // that, something upstream is wrong and the log will say so.
        if (statureHeightM && Math.abs(statureHeightM - 1.70) > 0.005) {
          let k = statureHeightM / 1.70;
          const kc = Math.min(1.3, Math.max(0.8, k));
          if (kc !== k) console.warn(`[MiniGlbViewer] stature scale clamped: raw ${k.toFixed(3)} -> ${kc.toFixed(3)} (measured ${(statureHeightM*100).toFixed(1)}cm)`);
          k = kc;
          // Anchor: the garment's OWN center — NOT the origin. Skinned
          // vertices follow their bones; scaling bind positions about
          // the origin moved every vertex away from its skeleton by
          // (k-1)*position (~+15cm at chest height for k=1.12): bra at
          // the neck, hair above the head (observed live). The
          // skeleton owns PLACEMENT; stature scale only owns SIZE —
          // scale about the garment's center and let the wrap close
          // the residual.
          let cx = 0, cy = 0, cz = 0, nTot = 0;
          for (const m of accessoryMeshes) {
            const p = m.geometry.attributes.position;
            for (let i = 0; i < p.count; i++) { cx += p.getX(i); cy += p.getY(i); cz += p.getZ(i); }
            nTot += p.count;
          }
          cx /= nTot; cy /= nTot; cz /= nTot;
          for (const m of accessoryMeshes) {
            const p = m.geometry.attributes.position;
            for (let i = 0; i < p.count; i++) p.setXYZ(i, cx + (p.getX(i) - cx) * k, cy + (p.getY(i) - cy) * k, cz + (p.getZ(i) - cz) * k);
            p.needsUpdate = true;
            m.geometry.computeBoundingBox();
            m.geometry.computeBoundingSphere();
          }
          console.log(`[MiniGlbViewer] Stature scale (${accessoryUrl}): body ${(statureHeightM*100).toFixed(1)}cm vs 170 base -> uniform x${k.toFixed(3)} about garment center`);
        }
        // GROUNDING COMPENSATION (Session 102/103, from the log's own
        // numbers): the head-anchored height morph grows the body
        // DOWNWARD in bind space (observed: minY=-0.189, maxY
        // unchanged), and grounding lifts the ROOT so feet meet y=0.
        // Accessories bound to the lifted skeleton land exactly
        // groundOffset ABOVE their body region (bra at the neck, hair
        // floating — both off by precisely 18.9cm on a 191cm body).
        // Compensation: subtract the root's current groundOffset from
        // the garment's bind Y. Self-scaling by construction: ~0 on
        // 170-line bodies (which always fit), full correction on tall
        // ones. Applied before prefit/wrap so all baselines agree.
        {
          const groundLift = loadedRoot?.userData?.groundOffset || 0;
          if (Math.abs(groundLift) > 0.002) {
            for (const m of accessoryMeshes) {
              const p = m.geometry.attributes.position;
              for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) - groundLift);
              p.needsUpdate = true;
              m.geometry.computeBoundingBox();
              m.geometry.computeBoundingSphere();
            }
            console.log(`[MiniGlbViewer] Grounding compensation (${accessoryUrl}): garment bind shifted ${(-groundLift*100).toFixed(1)}cm in Y (root groundOffset ${(groundLift*100).toFixed(1)}cm)`);
          }
        }

        console.log(`[MiniGlbViewer] Accessory (${accessoryUrl}): ${accessoryMeshes.length} SkinnedMesh primitive(s) found [${accessoryMeshes.map((m) => `"${m.name}" ${m.geometry.attributes.position.count}v`).join(", ")}], ${accessoryBones.length} bones in its own skeleton.`);

        // Per-primitive diagnostics — raw bbox (size AND min/max), material
        // properties, and node transform chain. These log lines are what
        // exposed the root cause (the lone 550-vertex Trim primitive with
        // its 0.07m Y-extent), so they stay on for every primitive.
        for (const accessoryMesh of accessoryMeshes) {
          accessoryMesh.geometry.computeBoundingBox();
          const bbox = accessoryMesh.geometry.boundingBox;
          const bboxSize = new THREE.Vector3();
          bbox.getSize(bboxSize);
          console.log(`[MiniGlbViewer] Accessory "${accessoryUrl}" primitive "${accessoryMesh.name}" raw bbox: size=(${bboxSize.x.toFixed(4)}, ${bboxSize.y.toFixed(4)}, ${bboxSize.z.toFixed(4)}) min=(${bbox.min.x.toFixed(4)}, ${bbox.min.y.toFixed(4)}, ${bbox.min.z.toFixed(4)}) max=(${bbox.max.x.toFixed(4)}, ${bbox.max.y.toFixed(4)}, ${bbox.max.z.toFixed(4)}).`);

          const mats = Array.isArray(accessoryMesh.material) ? accessoryMesh.material : [accessoryMesh.material];
          mats.forEach((m, mi) => {
            console.log(`[MiniGlbViewer] Accessory "${accessoryUrl}" primitive "${accessoryMesh.name}" material[${mi}] "${m.name}": type=${m.type} color=#${m.color?.getHexString?.() ?? "n/a"} metalness=${m.metalness ?? "n/a"} roughness=${m.roughness ?? "n/a"} map=${!!m.map} normalMap=${!!m.normalMap} transparent=${m.transparent} opacity=${m.opacity} side=${m.side}`);
            // ROOT CAUSE of the "crumpled / vacuum-sealed / inside-out"
            // garment rendering (Session 101, found via console log):
            // the exporter set alphaMode BLEND (transparent=true) on
            // every garment material because the textures carry an
            // alpha channel — combined with side=DoubleSide, Three.js
            // cannot depth-sort the overlapping fabric shells, so back
            // faces draw over front faces and the body bleeds through
            // the cloth. This was a MATERIAL bug, not geometry — the
            // meshes were fine all along. Fix: alpha-CUTOUT instead of
            // blend. Opaque pixels depth-write normally; genuinely
            // transparent texels (lace holes) are discarded by
            // alphaTest. Standard game-clothing treatment.
            // Session 103 — HAIR IS EXEMPT from the cutout conversion:
            // hair textures live in semi-transparency (caps, wisps),
            // and alphaTest=0.5 discards essentially every fragment —
            // an invisible hairdo that loaded perfectly (found live:
            // Basic Short, clean weights, zero pixels). The conversion
            // stays for garments, where it fixes real depth-sorting
            // artifacts; hair keeps BLEND and accepts sorting quirks.
            // Session 147 — the accepted quirk stopped being acceptable:
            // hair visibly melts into garments (reported live on Charm
            // Hair vs. the Angie top) because blend without depthWrite
            // never occludes — the shirt draws over nearer hair. Middle
            // path Session 103 never tested: KEEP the soft blend, ADD
            // depthWrite so hair fragments occlude, with a LOW alphaTest
            // (0.15 — not 0.5, the value that vanished the hairdo) so
            // near-invisible fringe texels are discarded instead of
            // punching invisible depth holes in whatever is behind them.
            // Residual cost: hair-over-hair inner layers can clip at
            // strand crossings — the standard trade, far smaller than
            // the melting.
            if (m.transparent && !accessoryUrl.includes("/hair/")) {
              m.transparent = false;
              m.alphaTest = 0.5;
              m.depthWrite = true;
              m.needsUpdate = true;
              console.log(`[MiniGlbViewer] Accessory material "${m.name}": converted alpha BLEND -> alpha CUTOUT (transparent=false, alphaTest=0.5, depthWrite=true) to fix garment depth-sorting artifacts.`);
            } else if (m.transparent && accessoryUrl.includes("/hair/")) {
              m.depthWrite = true;
              m.alphaTest = 0.15;
              m.needsUpdate = true;
              console.log(`[MiniGlbViewer] Accessory material "${m.name}": hair depth fix (blend kept, depthWrite=true, alphaTest=0.15) so hair occludes garments instead of melting into them.`);
            }
          });

          let node = accessoryMesh;
          const chain = [];
          while (node && node !== gltf.scene) {
            const p = node.position, r = node.rotation, s = node.scale;
            chain.push(`"${node.name || node.type}" pos=(${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}) rotXYZ=(${r.x.toFixed(4)}, ${r.y.toFixed(4)}, ${r.z.toFixed(4)}) scale=(${s.x.toFixed(4)}, ${s.y.toFixed(4)}, ${s.z.toFixed(4)})`);
            node = node.parent;
          }
          console.log(`[MiniGlbViewer] Accessory "${accessoryUrl}" primitive "${accessoryMesh.name}" node transform chain (mesh -> scene root):\n  ${chain.join("\n  ")}`);
        }

        // ISOLATION MODE — the discriminating test from the Session 100
        // handoff. Adds the accessory's ENTIRE original scene graph (its
        // own skeleton, its own node transforms, untouched — no
        // skinIndex remap, no identity reset, no rebind to the main
        // skeleton) to the scene, offset sideways so it renders next to
        // the character. Rest pose, unanimated, self-consistent. If it
        // looks like correct shorts standing here, the asset is sane and
        // the bug lives in the rebind path below. If it shows the same
        // rings/flattening here too, the exported GLB itself is broken
        // and no amount of binding code will fix it.
        if (ACCESSORY_DEBUG.isolate) {
          gltf.scene.position.x += 0.6;
          loadedRoot.add(gltf.scene);
          console.log(`[MiniGlbViewer] ISOLATION MODE: accessory "${accessoryUrl}" added with its OWN ${accessoryBones.length}-bone skeleton, untouched, offset +0.6m X. No rebinding performed.`);
          resolve();
          return;
        }

        // X-RAY MODE — makes the main character's body see-through so a
        // bound accessory hidden INSIDE the body becomes visible.
        // Directly tests the occlusion reading of the screenshot: black
        // fabric visible only in the between-thighs gap and at
        // silhouette edges, everything else buried under the skin.
        if (ACCESSORY_DEBUG.xray) {
          const bodyMats = Array.isArray(mainSkinnedMesh.material) ? mainSkinnedMesh.material : [mainSkinnedMesh.material];
          bodyMats.forEach((m) => {
            m.transparent = true;
            m.opacity = 0.3;
            m.depthWrite = false;
            m.needsUpdate = true;
          });
          console.log(`[MiniGlbViewer] X-RAY MODE: main body material(s) set to opacity 0.3 so bound accessories inside the body are visible.`);
        }

        // Scale-mismatch DIAGNOSTIC (log only — no longer applied). The
        // original rationale ("shorts bbox x=0.36 y=0.07 z=0.21, 5-25x
        // smaller than the character") is now known to have been a
        // misreading: that bbox belonged to ONLY the 550-vertex Trim
        // primitive (see root-cause note above), which was at perfectly
        // correct scale all along — the leg-opening edging of a pair of
        // shorts genuinely is 0.07m tall. The hip->head skeleton ratio
        // (~0.91) this computes reflects the character's morph-adjusted
        // proportions vs. the accessory's default-G9 rest skeleton, and
        // is kept purely as a logged sanity check for future assets.
        // Explicit update before measuring — this freshly-loaded scene
        // hasn't been added to the main scene graph yet (that happens
        // later, after binding), so its world matrices may not be
        // current. The main character's are already confirmed fresh —
        // groundAndMeasure() already called updateWorldMatrix() on it
        // earlier in this same load, before this accessory block runs
        // (normaliseScale(), previously credited here, was removed —
        // see the Session 101+ note further up this file).
        gltf.scene.updateWorldMatrix(true, true);

        const findBoneByName = (bones, name) => bones.find((b) => b.name === name) || null;
        const REFERENCE_BONE_A = "hip";
        const REFERENCE_BONE_B = "head";
        const accessoryBoneA = findBoneByName(accessoryBones, REFERENCE_BONE_A);
        const accessoryBoneB = findBoneByName(accessoryBones, REFERENCE_BONE_B);
        const mainBoneA = findBoneByName(mainSkeleton.bones, REFERENCE_BONE_A);
        const mainBoneB = findBoneByName(mainSkeleton.bones, REFERENCE_BONE_B);

        let scaleRatio = 1;
        if (accessoryBoneA && accessoryBoneB && mainBoneA && mainBoneB) {
          const accessoryPosA = new THREE.Vector3();
          const accessoryPosB = new THREE.Vector3();
          accessoryBoneA.getWorldPosition(accessoryPosA);
          accessoryBoneB.getWorldPosition(accessoryPosB);
          const accessoryDistance = accessoryPosA.distanceTo(accessoryPosB);

          const mainPosA = new THREE.Vector3();
          const mainPosB = new THREE.Vector3();
          mainBoneA.getWorldPosition(mainPosA);
          mainBoneB.getWorldPosition(mainPosB);
          const mainDistance = mainPosA.distanceTo(mainPosB);

          if (accessoryDistance > 0.0001) {
            scaleRatio = mainDistance / accessoryDistance;
          }
          console.log(`[MiniGlbViewer] Accessory scale check (${accessoryUrl}): ${REFERENCE_BONE_A}->${REFERENCE_BONE_B} distance in accessory's own skeleton=${accessoryDistance.toFixed(4)}, in main skeleton=${mainDistance.toFixed(4)}, computed scaleRatio=${scaleRatio.toFixed(4)}.`);
        } else {
          console.warn(`[MiniGlbViewer] Accessory scale check (${accessoryUrl}) skipped — reference bones "${REFERENCE_BONE_A}"/"${REFERENCE_BONE_B}" not found in one or both skeletons. No scale correction applied; geometry used as-is.`);
        }

        // Scale is deliberately NOT applied here anymore — moved to a
        // separate, lightweight live-update effect that doesn't
        // reload the model. Applying it here, tied to the load effect,
        // meant every single slider drag re-triggered a full scene
        // reload (confirmed directly: the loading spinner appeared on
        // every tick). manualScale is still accepted as a parameter
        // and used below, once, to set the mesh's INITIAL state to
        // match whatever the wizard's sliders already show at the
        // moment this accessory is first selected.

        // Build accessory-bone-index -> main-skeleton-bone-index map,
        // matching by bone NAME — the only thing guaranteed consistent
        // between the two separately-loaded skeletons.
        //
        // Real, confirmed fix here: the plain (non-"(drv)") versions of
        // certain bones — twist bones, hip — are frozen at rest pose,
        // never actually posed/animated. Confirmed directly: measured
        // l_thightwist1's own world transform at load and again 2s
        // into the idle animation playing — identical, unchanged. The
        // main skeleton has a SEPARATE "l_thightwist1(drv)" bone
        // alongside it — DAZ's own naming convention for the bone that
        // actually receives the driven/constrained pose. Preferring
        // the "(drv)" variant whenever one exists for a given bone name
        // redirects any accessory skinned to these bones onto the one
        // that's genuinely animated, instead of the frozen plain one.
        // Doesn't affect bones without a "(drv)" counterpart at all
        // (e.g. hair's own "pelvis" usage — no "pelvis(drv)" exists —
        // so this is a targeted fix, not a blanket behavior change).
        const mainBoneNameToIndex = {};
        mainSkeleton.bones.forEach((b, i) => {
          mainBoneNameToIndex[b.name] = i;
        });
        let drvPreferredCount = 0;
        mainSkeleton.bones.forEach((b, i) => {
          if (b.name.endsWith("(drv)")) {
            const plainName = b.name.slice(0, -"(drv)".length);
            if (mainBoneNameToIndex[plainName] !== undefined) {
              mainBoneNameToIndex[plainName] = i;
              drvPreferredCount++;
            }
          }
        });
        console.log(`[MiniGlbViewer] Bone remap (${accessoryUrl}): redirected ${drvPreferredCount} plain bone name(s) to their "(drv)" counterpart, where one exists, to avoid the confirmed-frozen plain versions.`);

        const boneIndexMap = new Array(accessoryBones.length);
        let unmatchedCount = 0;
        let suffixMatchedCount = 0;
        accessoryBones.forEach((b, i) => {
          let mainIndex = mainBoneNameToIndex[b.name];
          // Session 152 — Blender ".00N" duplicates. The Angie jeans carry 16
          // bones named l_thigh.001, l_thightwist1.002, spine1.001… — exports
          // where Blender deduplicated names on import. Exact-name matching
          // sent every one of them to the root fallback below, which pinned
          // the jeans' thigh and seat weights to a bone that never moves while
          // the body's thighs animated out from under the denim. That is the
          // largest single cause of skin rendering through the jeans in
          // Explore. Strip the suffix and retry — the stripped name then also
          // benefits from the "(drv)" redirect above, landing on the bone that
          // is genuinely animated. (The runtime export bake has done exactly
          // this since it was written; the live path never did.)
          if (mainIndex === undefined) {
            // Two spellings of the same duplicate: the file says "l_thigh.001",
            // but three.js sanitizes node names at load and the live skeleton
            // says "l_thigh001" — the dot is already gone by the time this map
            // is built, so matching "\.\d+$" alone found nothing (measured:
            // 0 of the jeans' 16). Strip a trailing three-digit run, with or
            // without its dot, and only accept the result if that bone really
            // exists — "spine1001" becomes "spine1", while a genuine name
            // ending in digits that resolves to nothing stays unmatched.
            const stripped = b.name.replace(/\.?\d{3}$/, "");
            if (stripped !== b.name && mainBoneNameToIndex[stripped] !== undefined) {
              mainIndex = mainBoneNameToIndex[stripped];
              suffixMatchedCount++;
            }
          }
          if (mainIndex === undefined) {
            unmatchedCount++;
            boneIndexMap[i] = 0; // Falls back to the root bone rather than an invalid index — flagged below if this ever actually happens.
          } else {
            boneIndexMap[i] = mainIndex;
          }
        });
        console.log(`[MiniGlbViewer] Accessory bone remap (${accessoryUrl}): ${accessoryBones.length} bones checked, ${suffixMatchedCount} matched after stripping a Blender .00N suffix, ${unmatchedCount} had no matching name in the main skeleton (mapped to root as fallback).`);

        // Everything from here runs PER PRIMITIVE — each SkinnedMesh has
        // its own geometry (own skinIndex/skinWeight attributes) even
        // though they all share one skeleton, so each must be remapped
        // and bound individually. This is the actual fix for the
        // two-rings bug: previously only the first primitive got here.
        // ---- Skeleton-landmark registration (see ACCESSORY_REGISTRATION) ----
        // Must run BEFORE the per-primitive loop: skinIndex values are
        // still indices into the accessory's OWN bone list here (the
        // remap to the main skeleton happens inside the loop below).
        if (ACCESSORY_REGISTRATION.enabled && ACCESSORY_REGISTRATION.pathFragments.some((f) => accessoryUrl.includes(f))) {
          gltf.scene.updateMatrixWorld(true);

          // Garment-skeleton rest positions, model space (armature 0.01
          // scale + 90deg rotation included via matrixWorld).
          const accBonePos = new Map();
          for (const b of accessoryBones) {
            const v = new THREE.Vector3();
            b.getWorldPosition(v);
            accBonePos.set(b.name, v);
          }

          // Character-skeleton BIND-pose positions: the inverse of each
          // boneInverse's translation IS the bone's bind position, in
          // the same bind space the garment's raw vertices live in
          // (directly confirmed earlier: garment coords are model-space
          // meters matching the body's).
          const mainBindPos = new Map();
          const tmpM = new THREE.Matrix4();
          const tmpV = new THREE.Vector3();
          for (let bi = 0; bi < mainSkeleton.bones.length; bi++) {
            tmpM.copy(mainSkeleton.boneInverses[bi]).invert();
            tmpV.setFromMatrixPosition(tmpM);
            mainBindPos.set(mainSkeleton.bones[bi].name, tmpV.clone());
          }

          // Per-bone usage weight, summed over ALL primitives, against
          // the accessory's own bone names (pre-remap indices). A bone
          // matches the main skeleton by plain name or its (drv) twin.
          const boneWeight = new Map();
          for (const mesh of accessoryMeshes) {
            const si = mesh.geometry.attributes.skinIndex;
            const sw = mesh.geometry.attributes.skinWeight;
            for (let i = 0; i < si.count; i++) {
              for (let j = 0; j < 4; j++) {
                const w = j === 0 ? sw.getX(i) : j === 1 ? sw.getY(i) : j === 2 ? sw.getZ(i) : sw.getW(i);
                if (w <= 0) continue;
                const bidx = j === 0 ? si.getX(i) : j === 1 ? si.getY(i) : j === 2 ? si.getZ(i) : si.getW(i);
                const name = accessoryBones[bidx]?.name;
                if (name) boneWeight.set(name, (boneWeight.get(name) || 0) + w);
              }
            }
          }

          // Weight-averaged delta over matched bones.
          const delta = new THREE.Vector3();
          let totalW = 0;
          const contributors = [];
          for (const [name, w] of boneWeight) {
            const accP = accBonePos.get(name);
            const mainP = mainBindPos.get(name) || mainBindPos.get(`${name}(drv)`);
            if (!accP || !mainP) continue;
            delta.x += (mainP.x - accP.x) * w;
            delta.y += (mainP.y - accP.y) * w;
            delta.z += (mainP.z - accP.z) * w;
            totalW += w;
            contributors.push([name, w]);
          }
          if (totalW > 0) {
            delta.multiplyScalar(1 / totalW);
            for (const mesh of accessoryMeshes) {
              const pa = mesh.geometry.attributes.position;
              for (let i = 0; i < pa.count; i++) {
                pa.setXYZ(i, pa.getX(i) + delta.x, pa.getY(i) + delta.y, pa.getZ(i) + delta.z);
              }
              pa.needsUpdate = true;
            }
            contributors.sort((a, b) => b[1] - a[1]);
            console.log(`[MiniGlbViewer] Registration (${accessoryUrl}): garment translated by (${(delta.x * 1000).toFixed(1)}, ${(delta.y * 1000).toFixed(1)}, ${(delta.z * 1000).toFixed(1)})mm — weight-averaged bone-landmark delta over ${contributors.length} bone(s), top: ${contributors.slice(0, 4).map(([n, w]) => `${n}(${w.toFixed(0)})`).join(", ")}.`);
          } else {
            console.warn(`[MiniGlbViewer] Registration (${accessoryUrl}): NO matched bones between garment skeleton and main skeleton — garment left unregistered. This should never happen; investigate.`);
          }
        }

        accessoryMeshesStore[accessoryUrl] = [];
        const inflate = ACCESSORY_INFLATE.pathFragments.some((f) => accessoryUrl.includes(f));
        for (const accessoryMesh of accessoryMeshes) {

        // Clothing clearance shell (see ACCESSORY_INFLATE above): offset
        // every vertex along its own normal BEFORE the baseline positions
        // are captured further below, so the manual scale sliders always
        // compute from the inflated shape and the clearance survives
        // every slider drag. Uses the geometry's own vertex normals as
        // loaded from the GLB.
        if (inflate) {
          const posAttr = accessoryMesh.geometry.attributes.position;
          const normAttr = accessoryMesh.geometry.attributes.normal;
          if (normAttr) {
            const d = ACCESSORY_INFLATE.offsetMeters;
            for (let i = 0; i < posAttr.count; i++) {
              posAttr.setXYZ(
                i,
                posAttr.getX(i) + normAttr.getX(i) * d,
                posAttr.getY(i) + normAttr.getY(i) * d,
                posAttr.getZ(i) + normAttr.getZ(i) * d
              );
            }
            posAttr.needsUpdate = true;
            console.log(`[MiniGlbViewer] Accessory primitive "${accessoryMesh.name}" (${accessoryUrl}): inflated ${posAttr.count} vertices by ${ACCESSORY_INFLATE.offsetMeters}m along vertex normals (clothing clearance shell).`);
          } else {
            console.warn(`[MiniGlbViewer] Accessory primitive "${accessoryMesh.name}" (${accessoryUrl}): inflation requested but geometry has NO normal attribute — skipped, expect possible skin poke-through.`);
          }
        }

        // Pre-shrinkwrap snapshot: registration + inflation are baked in
        // (both body-shape-independent), shrinkwrap is NOT — the body
        // refit effect restores this and re-runs shrinkwrap whenever the
        // body morphs change, so garments always wear the CURRENT body.
        const prefitPositions = capturePositions(accessoryMesh.geometry.attributes.position);
        const shrinkwrapEligible = ACCESSORY_SHRINKWRAP.pathFragments.some((f) => accessoryUrl.includes(f));

        // Shrinkwrap pass (see ACCESSORY_SHRINKWRAP above) — body-aware
        // penetration resolution, per vertex, against the actual body
        // surface. Runs before the baseline capture below so the fitted
        // shape IS the baseline every slider works from.
        if (shrinkwrapEligible) {
          shrinkwrapToBody(accessoryMesh, mainSkinnedMesh, accessoryUrl);
        }

        // Remap skinIndex in place — 4 bone influences per vertex, values
        // are indices into whichever skeleton.bones array is currently
        // bound.
        const skinIndexAttr = accessoryMesh.geometry.attributes.skinIndex;
        // Session 103 — remap through the ATTRIBUTE API, never the raw
        // array: Blender and Draco exports use INTERLEAVED buffers,
        // where .array is the SHARED buffer for several attributes — a
        // whole-array loop clobbered positions/normals/WEIGHTS with
        // bone-mapped integers (the identical -4.22e+37 garbage in two
        // "corrupted" files from independent pipelines — the corruptor
        // was this loop; DAZ's non-interleaved originals just happened
        // to survive it). get/set honor stride+offset on both layouts.
        for (let i = 0; i < skinIndexAttr.count; i++) {
          skinIndexAttr.setX(i, boneIndexMap[skinIndexAttr.getX(i)] ?? 0);
          skinIndexAttr.setY(i, boneIndexMap[skinIndexAttr.getY(i)] ?? 0);
          skinIndexAttr.setZ(i, boneIndexMap[skinIndexAttr.getZ(i)] ?? 0);
          skinIndexAttr.setW(i, boneIndexMap[skinIndexAttr.getW(i)] ?? 0);
        }
        skinIndexAttr.needsUpdate = true;

        // skinWeight validity + full bone-usage scan, per primitive —
        // these are the logs that proved the skinning data itself was
        // always sane during the Session 100 investigation.
        {
          const skinWeightAttr = accessoryMesh.geometry.attributes.skinWeight;
          const sampleCount = Math.min(5, skinIndexAttr.count);
          for (let i = 0; i < sampleCount; i++) {
            const idx = [skinIndexAttr.getX(i), skinIndexAttr.getY(i), skinIndexAttr.getZ(i), skinIndexAttr.getW(i)];
            const wt = [skinWeightAttr.getX(i), skinWeightAttr.getY(i), skinWeightAttr.getZ(i), skinWeightAttr.getW(i)];
            const sum = wt[0] + wt[1] + wt[2] + wt[3];
            console.log(`[MiniGlbViewer] Accessory "${accessoryMesh.name}" vertex ${i} skinning (${accessoryUrl}): skinIndex(post-remap)=[${idx.join(", ")}] skinWeight=[${wt.map(w => w.toFixed(4)).join(", ")}] sum=${sum.toFixed(4)} (expect ~1.0 if normalized correctly).`);
          }

          const usedBoneIndices = new Set();
          for (let i = 0; i < skinIndexAttr.count; i++) {
            const idx = [skinIndexAttr.getX(i), skinIndexAttr.getY(i), skinIndexAttr.getZ(i), skinIndexAttr.getW(i)];
            const wt = [skinWeightAttr.getX(i), skinWeightAttr.getY(i), skinWeightAttr.getZ(i), skinWeightAttr.getW(i)];
            for (let j = 0; j < 4; j++) {
              if (wt[j] > 0) usedBoneIndices.add(idx[j]);
            }
          }
          const usedBoneNames = [...usedBoneIndices].sort((a, b) => a - b).map((i) => `${i}:${mainSkeleton.bones[i]?.name ?? "?"}`);
          console.log(`[MiniGlbViewer] Accessory "${accessoryMesh.name}" (${accessoryUrl}) ALL ${skinIndexAttr.count} vertices scanned — ${usedBoneIndices.size} unique bone(s) actually used with nonzero weight: [${usedBoneNames.join(", ")}].`);
        }

        // Reset the mesh's own local transform to identity before
        // re-parenting — once skinned, positioning should come entirely
        // from the shared skeleton's bone matrices, not from any
        // residual transform carried over from the accessory GLB's own,
        // separate scene hierarchy.
        accessoryMesh.position.set(0, 0, 0);
        accessoryMesh.rotation.set(0, 0, 0);
        accessoryMesh.scale.set(1, 1, 1);

        // Rebind to the main character's own, already-posed skeleton —
        // sharing the same Skeleton instance means the accessory deforms
        // identically to the body on every future animation frame and
        // morph change, no separate syncing logic needed.
        //
        // mainSkinnedMesh.bindMatrix + bindMode "detached" is the
        // confirmed-good combination from the Session 100 investigation
        // (see SAD.md, Accessory Skinning Investigation) — do not change
        // without new evidence.
        accessoryMesh.bindMode = "detached";
        accessoryMesh.bind(mainSkeleton, mainSkinnedMesh.bindMatrix);

        loadedRoot.add(accessoryMesh);
        // Self-identifying from the moment it's live, independent of
        // accessoryMeshesStore below — that registration doesn't happen
        // until AFTER real per-primitive work (bounding box, shrinkwrap
        // resolve+smooth passes measured at 20-80ms each) finishes for
        // THIS primitive, several primitives per garment. A caller that
        // reads the scene graph directly (exportMorphedGlbBlob's
        // wardrobe-detach, below) during that window would otherwise see
        // an accessory mesh the store doesn't know about yet — confirmed
        // live: an export firing mid-load exported ~99MB instead of the
        // expected body-only ~47MB, accessories riding along uncounted.
        accessoryMesh.userData.isAccessoryMesh = true;
        console.log(`[MiniGlbViewer] Accessory primitive "${accessoryMesh.name}" added to scene (${accessoryUrl}), rebound to main skeleton (${mainSkeleton.bones.length} bones).`);

        // Save the TRUE baseline (pre-scale) vertex positions, this
        // primitive's own center (bounding-box midpoint — scaling needs
        // to happen relative to THIS, not the origin, or it visibly
        // translates the mesh instead of growing/shrinking it in
        // place, confirmed directly: a Y-axis scale attempt moved the
        // shorts up and down rather than resizing them, because their
        // own local geometry sits well off-center along Y), and a
        // reference to this mesh — appended to the URL-keyed ARRAY (one
        // entry per primitive, since a multi-material accessory loads as
        // several SkinnedMeshes), read later by the separate live-update
        // effect on every slider drag, so scale changes always compute
        // from this real baseline rather than compounding onto whatever
        // was applied last time.
        accessoryMesh.geometry.computeBoundingBox();
        const bboxCenter = new THREE.Vector3();
        accessoryMesh.geometry.boundingBox.getCenter(bboxCenter);
        const storeEntry = {
          mesh: accessoryMesh,
          prefitPositions,
          shrinkwrapEligible,
          url: accessoryUrl,
          // Part identity for per-part adjustments — the MATERIAL name
          // ("Bra_Main", "Bra_Underbust", "Pants"...), which is the
          // human-readable, stable key for a glTF primitive (primitives
          // are split per material at export; mesh names are just
          // "X", "X_1", "X_2"...). Unique within one garment.
          matName: (Array.isArray(accessoryMesh.material) ? accessoryMesh.material[0] : accessoryMesh.material)?.name || accessoryMesh.name,
          originalPositions: capturePositions(accessoryMesh.geometry.attributes.position),
          center: bboxCenter,
        };
        accessoryMeshesStore[accessoryUrl].push(storeEntry);
        // Session 141 — identity tags alongside isAccessoryMesh above,
        // set at the same moment for the same reason (self-identifying
        // from the scene graph, no store dependency). These round-trip
        // through GLTFExporter extras -> GLTFLoader userData (the exact
        // mechanism of the jeans double-wardrobe incident, used
        // deliberately this time): a dressed export loaded into
        // Explore can map each mesh back to its garment URL + part
        // without any side channel — that mapping is what makes
        // in-place tint/scale mirroring possible over there at all.
        accessoryMesh.userData.accessoryUrl = accessoryUrl;
        accessoryMesh.userData.accessoryMatName = storeEntry.matName;
        // Initial visibility — honors a part already hidden in the
        // wizard when the model reloads (step change, GLB swap).
        accessoryMesh.visible = manualParts?.[storeEntry.matName]?.visible !== false;
        // Apply whatever scale the wizard's sliders already show at
        // the moment this accessory is first loaded — in practice this
        // is {1,1,1} on a fresh selection, but handled properly either
        // way rather than assumed.
        {
          const t = effectiveTransform(manualScale, manualOffset, manualRotation, manualParts, storeEntry.matName);
          applyAccessoryScale(accessoryMesh, storeEntry.originalPositions, bboxCenter, t.scale, t.offset, t.rotation);
        }
        // Session 141 — load-completion tint, per-part override wins
        // over garment-level (same whole/part rule as the fit sliders).
        applyAccessoryTint(accessoryMesh, manualParts?.[storeEntry.matName]?.tint || manualTint);

        } // end per-primitive loop

        // Removed: an earlier "REAL, post-skinning world-space size"
        // diagnostic here, built on applyBoneTransform(), turned out to
        // be itself broken — confirmed directly when it produced the
        // EXACT identical "collapsed" result for two completely
        // different accessories (a 550-vertex shorts mesh and a
        // 384,849-vertex hair mesh, entirely different bone weights).
        // That's physically impossible if either mesh were actually
        // collapsing, proving the measurement itself was never
        // trustworthy. Removed rather than left in place to avoid
        // misleading anyone with false confidence in its output again.

        resolve();
      },
      undefined,
      (err) => { console.error(`[MiniGlbViewer] Accessory GLB load failed (${accessoryUrl}):`, err); resolve(); }
    );
  });
}

// Minimal, self-contained GLB viewer — deliberately NOT the full
// ActorModelPanel (animation clips, multi-loader support, FPV controls,
// etc.). This is scoped to exactly one job: load and display the freshly
// generated character inside the wizard's own modal, safely. Full
// ActorModelPanel remains the post-creation editor, per the original
// architecture decision.
export default function MiniGlbViewer({ glbUrl, accessories = [], bodyTorsoLength = 0, bodyArmsLength = 0, bodyLegsLength = 0, bodyHeight = 0, extraMorphValues = {}, activeAnimation = "idle", onAnimationsLoaded, onLoadingChange, onAccessoryPartsLoaded, frontReferenceImageUrl = null, sideReferenceImageUrl = null, referenceCalibration = null, onExportReady = null, onSolveReady = null, poseValues = {}, focusRegion = "fullBody", perspectiveOnly = false, loadingPhotoUrl = null, fullscreenLoadingOverlay = true, onSceneReady = null }) {
  const mountRef = useRef(null);
  // Populated once per model load, in the load callback below. Kept as
  // a ref (not state) so the slider-effect further down can read it on
  // every drag without re-triggering the load effect, which only
  // depends on glbUrl.
  const morphMeshesRef = useRef([]);
  // ── SESSION 148 MORPH PROBE (remove when the divergence is solved) ──
  // Prints, every 5s, each morph-bearing mesh's influence state BY NAME
  // (names via morphTargetDictionary — a scrambled order can fool a
  // plain sum). Counterpart probe in ActorModelPanel prints the same
  // format for Explore's displayed copy. Diff the lines.
  useEffect(() => {
    const t = setInterval(() => {
      try {
        const root = loadedRootRef.current;
        if (!root) return;
        const out = [];
        root.traverse((o) => {
          if (!o.isMesh || !o.morphTargetInfluences?.length || o.userData?.isAccessoryMesh) return;
          const dict = o.morphTargetDictionary || {};
          const inv = Object.fromEntries(Object.entries(dict).map(([k, v]) => [v, k]));
          const pairs = [];
          let sum = 0, nz = 0;
          o.morphTargetInfluences.forEach((w, i) => {
            if (Math.abs(w) > 1e-4) { nz++; sum += w; pairs.push([inv[i] || `#${i}`, w]); }
          });
          pairs.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
          out.push(`${o.name}:${nz}/${o.morphTargetInfluences.length} sum=${sum.toFixed(3)} top=[${pairs.slice(0, 3).map(([n, w]) => `${n}:${w.toFixed(2)}`).join(",")}]`);
        });
        if (out.length) console.log(`[MORPH live] ${out.join(" | ")}`);
      } catch { /* probe must never break the app */ }
    }, 5000);
    return () => clearInterval(t);
  }, []);
  // Loaded accessory meshes, keyed by their URL, along with a saved
  // copy of each mesh's ORIGINAL (pre-scale) vertex positions — needed
  // so live scale updates below can always scale from the true
  // baseline rather than compounding onto whatever scale was applied
  // last time. Populated once at load time, read (not reloaded) by the
  // separate live-update effect on every slider drag.
  const accessoryMeshesRef = useRef({});
  // Also kept as a ref (not the load effect's local variable) so the
  // slider-drag effect below can re-ground the model after every morph
  // update, not just once at load time.
  const loadedRootRef = useRef(null);
  // Session 97: animation playback — mixerRef persists the
  // THREE.AnimationMixer across renders (created once per load, not
  // per-frame). animationsRef holds the real clips returned by the
  // loader (gltf.animations), keyed by name, so the activeAnimation
  // effect below can look one up directly rather than re-scanning the
  // scene. clockRef drives delta time for mixer.update() in the render
  // loop — a fresh timer per load, matching loadedRootRef's own
  // per-load lifecycle. Session 147: THREE.Clock → THREE.Timer (Clock
  // deprecated; Timer verified IN CORE at three 0.185 — the addon path
  // does not exist there, per the Session 122 lesson in
  // ActorModelPanel). Timer separates sampling from reading: update()
  // once per frame, then getDelta().
  const mixerRef = useRef(null);
  const animationsRef = useRef({});
  const clockRef = useRef(null);
  const groundingCandidatesRef = useRef({ lowCandidates: [], highCandidates: [], hipCandidates: [] });
  const [heightM, setHeightM] = useState(null);
  // Measurement rings visibility — user toggle, DEFAULT OFF. The rings
  // group is created once in the load effect and captured in a ref;
  // this state only flips its .visible flag, no scene rebuild.
  const [showRings, setShowRings] = useState(false);
  const ringsGroupRef = useRef(null);
  // Reference SkinnedMesh of the loaded character (set during load) —
  // needed by the body-change refit effect below to reach the body
  // surface BVH cache and re-run shrinkwrap.
  const mainMeshRef = useRef(null);
  const showRingsRef = useRef(showRings);
  showRingsRef.current = showRings;
  // Body morph props, always-fresh via ref. Fixes the reported bug that
  // Appearance-step adjustments were not applied on the Accessories
  // step: the load effect (which re-runs on accessory-list changes,
  // i.e. exactly at the step transition) applied morphs from its own
  // CLOSURE's body prop values, which can be stale relative to the
  // sliders' latest state depending on which render the effect closure
  // was created in. Reading through a ref that is refreshed on every
  // render makes the load-time apply always use the current values, by
  // construction, regardless of effect/closure timing.
  // Session 102 — bumped when a GLB's meshes finish loading, and a dep
  // of the live-update effect below: guarantees the CURRENT slider
  // state applies through the exact same path a manual slider nudge
  // uses. Root cause context: on a draft load (nonzero state BEFORE
  // the async GLB), the load-completion apply at its call site reads
  // correct values yet the body rendered default until any nudge —
  // the nudge path provably works, so load-completion now triggers it.
  const [meshesVersion, setMeshesVersion] = useState(0);
  const heightMRef = useRef(null); // measured body height, for the accessory manager's stature scale (Session 103 split)
  const bodyPropsRef = useRef({ bodyTorsoLength, bodyArmsLength, bodyLegsLength, bodyHeight, extraMorphValues, poseValues });
  bodyPropsRef.current = { bodyTorsoLength, bodyArmsLength, bodyLegsLength, bodyHeight, extraMorphValues, poseValues };
  // Real feature (Session 101+) — camera framing per body region,
  // clicked from the new region nav in CharacterWizard's Adjustments
  // panel. Matches the small, fixed set of zoom presets researched
  // against real, established character-creator conventions (EVE
  // Online, GTA-style creators, etc all use 3-4 fixed regions, not one
  // zoom per fine-grained slider group). Positions/targets below are a
  // first, REASONABLE-BUT-UNCALIBRATED guess based on a ~170cm
  // character's approximate proportions (feet at Y=0) — not measured
  // against the actual mesh geometry, same "test then refine after a
  // real visual check" discipline as the rest of this project. ref (not
  // state) for the same stale-closure reason as bodyPropsRef — read
  // fresh every render loop frame below, not just once per React render.
  // orthoZoom (Session 102): the position vectors are PERSPECTIVE
  // dolly targets, all on the +Z axis — lerping the ORTHO camera
  // toward them swung it off its fixed axis (observed live in right
  // view as "the character rotates" on clicking Head). In front/right
  // the transition instead pans along the fixed axis and lerps
  // camera.zoom toward these values. Starting points, tune by eye.
  const REGION_CAMERA_TARGETS = {
    fullBody: { position: [0, 1.3, 3], target: [0, 1.0, 0], orthoZoom: 1.0 },
    head: { position: [0, 1.6, 0.6], target: [0, 1.6, 0], orthoZoom: 3.0 },
    torso: { position: [0, 1.3, 1.2], target: [0, 1.3, 0], orthoZoom: 1.8 },
    legs: { position: [0, 0.6, 1.5], target: [0, 0.6, 0], orthoZoom: 1.5 },
  };
  const focusRegionRef = useRef(focusRegion);
  focusRegionRef.current = focusRegion;
  // Real feature (Session 101+) — tracks which region the camera is
  // currently transitioning TOWARD, separate from focusRegionRef
  // (which just holds the latest prop value). Comparing the two lets
  // the animate() loop below detect a genuine region CHANGE (not just
  // re-render noise) and kick off a fresh lerp only then — otherwise
  // every render would restart the transition from scratch.
  const cameraTransitionTargetRef = useRef("fullBody");
  const cameraTransitionActiveRef = useRef(false);
  const [modelLoading, setModelLoading] = useState(true);
  const [torsoLengthM, setTorsoLengthM] = useState(null);
  const [legsLengthM, setLegsLengthM] = useState(null);
  // Real feature (Session 101+): perspective/front/right view switcher.
  // Front/right use an orthographic camera with rotation disabled (pan
  // + zoom only) — matching standard CAD/3D-tool convention where an
  // orthographic front/side view is a fixed, non-rolling projection,
  // not just "perspective from a different angle." activeCameraRef
  // (below, inside the load effect) is what animate() actually renders
  // with each frame — this state only decides which camera that ref
  // points at and how it's framed.
  const [viewMode, setViewMode] = useState("perspective");
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  // What animate() renders with each frame, and what the view-switch
  // effect further below updates — real React refs (not plain load-
  // effect locals) specifically so switching views doesn't require
  // re-running the whole load effect (which would re-fetch and re-
  // parse the GLB every time, visibly reloading the model).
  const activeCameraRef = useRef(null);
  const activeControlsRef = useRef(null);
  const perspectiveCameraRef = useRef(null);
  const perspectiveControlsRef = useRef(null);
  const orthoCameraRef = useRef(null);
  const orthoControlsRef = useRef(null);
  const setOrthoViewRef = useRef(null); // the setOrthoView() function itself, assigned in the load effect, called by the view-switch effect
  // Real feature (Session 101+): reference-image plane, shown behind
  // the character in front/right view for visual comparison against
  // the real photo. Off by default (checkbox), and only meaningful in
  // front/right — perspective has no single flat plane that would face
  // the camera correctly, so the toggle itself is hidden there (see
  // JSX below). referenceImagePlaneRef is the actual THREE.Mesh,
  // created once in the load effect; the separate effect further below
  // handles which texture it shows, where it's positioned/rotated for
  // the current view, and whether it's visible at all — same
  // "don't reload the GLB to change this" pattern as the view switch.
  const [showReferenceImage, setShowReferenceImage] = useState(false);
  const referenceImagePlaneRef = useRef(null);
  const textureLoaderRef = useRef(null);
  const loadedReferenceTexturesRef = useRef({}); // keyed by URL, avoids re-loading the same texture on every toggle/view-switch
  // Real feature — manual fine-tune offset for the reference plane, on
  // top of the calibrated position. Even correct calibration can leave
  // a real, small gap (camera not perfectly centered on the subject
  // when the photo was taken, subpixel rounding in the mask detection)
  // — confirmed directly, a real screenshot showed the front view's
  // silhouette offset sideways from the character despite the height/
  // ground calibration being correct. Separate state per view (front
  // vs right) rather than one shared offset — switching views doesn't
  // erase whichever one was just fine-tuned. Range matches the
  // existing wizard Slider convention (-100..100) for a consistent
  // feel, mapped to a real ±0.5m fine-tune range in the effect below —
  // deliberately small; this is for nudging alignment, not for
  // positioning the plane from scratch.
  const [referenceOffsets, setReferenceOffsets] = useState({ front: { x: 0, y: 0 }, right: { x: 0, y: 0 } });

  useEffect(() => {
    if (!glbUrl || !mountRef.current) return;
    const mount = mountRef.current;
    setModelLoading(true);
    if (onLoadingChange) onLoadingChange(true);

    const scene = new THREE.Scene();
    // Session 148 - COMPOSITED RENDER (final architecture, ruled by
    // Magnus: reflect Inspect exactly): the parent may render THIS
    // scene with its own camera as a second pass over its room,
    // temporarily translating scene.position to place the character -
    // restored within the same synchronous call, so this viewer's own
    // render never sees the offset. The character is never exported,
    // copied, or re-parented: what Explore draws IS this scene.
    if (onSceneReady) onSceneReady(scene);
    // White background, deliberately explicit rather than relying on
    // the renderer's alpha:true transparency — makes it possible to
    // actually see whether an accessory rendered at all, since a
    // black-appearing accessory (missing texture/material) was nearly
    // invisible against whatever dark background showed through the
    // transparent canvas before.
    scene.background = new THREE.Color(0xffffff);
    // Real bug found here, not in the later resize handler: mesh/bone
    // load logging never touches the renderer's size at all — it's pure
    // data traversal on the loaded scene graph. The actual FIRST render
    // call happens later, inside animate(), using whatever size was set
    // right here at setup. If mount.clientWidth/clientHeight read zero
    // at this exact moment (confirmed real risk during a fast step
    // transition), the renderer starts permanently broken — the later,
    // already-guarded handleResize() doesn't retroactively fix a
    // framebuffer already created at zero size on some GPU drivers.
    // Falling back to a safe placeholder here, corrected to the real
    // size once ResizeObserver fires with the settled layout.
    const initialWidth = mount.clientWidth || 800;
    const initialHeight = mount.clientHeight || 600;
    // Camera near/far/position are expressed in real meters — this
    // assumed scene units were guaranteed real meters via
    // normaliseScale(). That guarantee is gone (Session 101+, removed
    // — see the note further down this file); this camera setup now
    // depends on the SAME unverified assumption flagged there: that
    // the raw GLB export is already correctly in meters. If it isn't,
    // this framing will look wrong too, not just the character's size.
    const camera = new THREE.PerspectiveCamera(45, initialWidth / initialHeight, 0.1, 100);
    camera.position.set(0, 1.3, 3);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    console.log(`[MiniGlbViewer] INITIAL setSize: mount.clientWidth=${mount.clientWidth} mount.clientHeight=${mount.clientHeight} -> using ${initialWidth}x${initialHeight}`);
    renderer.setSize(initialWidth, initialHeight);
    // Real fix for a real, confirmed bug — Three.js's own setSize()
    // writes a FIXED pixel width/height directly onto canvas.style by
    // default (e.g. "800px"), not a responsive one. When the 800px
    // fallback above fires (mount.clientWidth read as 0 mid-layout,
    // e.g. during a fast step transition), that fixed CSS width never
    // shrinks back to fit its actual container afterward — even once
    // ResizeObserver later calls setSize() again with the real,
    // correct pixel dimensions for the INTERNAL render resolution, the
    // canvas's own VISUAL width on the page stays stuck at whatever
    // the very first call set. That's what was forcing the whole
    // 3-column grid row wider than the viewport and making the
    // Adjustments panel horizontally scrollable. Overriding both to
    // 100% here makes CSS/grid own the actual displayed size — Three.js
    // keeps full control over the internal framebuffer resolution via
    // setSize()'s own pixel arguments, completely independent of this.
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.maxWidth = "100%";
    renderer.domElement.style.display = "block";
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.0, 0);
    controls.enableDamping = true;
    controls.minDistance = 1;
    controls.maxDistance = 5;
    controls.update();
    // Session 147 — user input beats the courtesy animation. The
    // region-focus lerp in the render loop pulls the camera toward the
    // slot target every frame until it arrives; a drag started during
    // that window gets tugged back 8%/frame — a fight the lerp wins,
    // reported live as "it turns the camera back" on the head pill.
    // OrbitControls fires 'start' the instant a drag/zoom begins:
    // cancel the transition there. The zoom-to-slot still happens on
    // every pill click; it just yields the moment the person takes
    // the wheel.
    controls.addEventListener("start", () => { cameraTransitionActiveRef.current = false; });

    // Real feature (Session 101+): front/right orthographic views.
    // Separate camera + separate OrbitControls instance, rather than
    // swapping the same controls' .object between camera types —
    // THREE's OrbitControls keeps internal spherical state tied to
    // whichever camera it was constructed with; two independent
    // instances avoids any risk of that state leaking between an
    // orbit-around-target perspective view and a fixed-projection
    // ortho view. ORTHO_VIEW_HALF_HEIGHT sets the vertical frustum
    // half-height in real meters — 1.1m gives a ~2.2m tall view window,
    // reasonable margin around a ~1.7-1.8m character. Aspect-scaled
    // left/right in the resize handler below, same pattern as the
    // perspective camera's own aspect updates.
    const ORTHO_VIEW_HALF_HEIGHT = 1.1;
    const orthoAspect = initialWidth / initialHeight;
    const orthoCamera = new THREE.OrthographicCamera(
      -ORTHO_VIEW_HALF_HEIGHT * orthoAspect, ORTHO_VIEW_HALF_HEIGHT * orthoAspect,
      ORTHO_VIEW_HALF_HEIGHT, -ORTHO_VIEW_HALF_HEIGHT,
      0.1, 100
    );
    const orthoControls = new OrbitControls(orthoCamera, renderer.domElement);
    orthoControls.target.set(0, 1.0, 0);
    orthoControls.enableRotate = false; // real requirement — pan/zoom only, no roll, matching a fixed front/side projection
    orthoControls.enableDamping = true;
    // Session 147 — same cancel-on-input as the perspective controls
    // above: the ortho branch of the focus lerp fights pan/zoom the
    // same way.
    orthoControls.addEventListener("start", () => { cameraTransitionActiveRef.current = false; });
    // Respects whatever viewMode is ALREADY active (not hardcoded to
    // perspective) — matters if glbUrl changes while already in
    // front/right view, e.g. switching test files mid-session.
    const startInPerspective = viewModeRef.current === "perspective";
    orthoControls.enabled = !startInPerspective;
    controls.enabled = startInPerspective;

    // Snaps the ortho camera to a canonical front or right position —
    // called on mode switch (effect further below) and once here for
    // whichever mode the component may already be in on first mount.
    // Real, confirmed bug fix: the character model faces world +Z
    // (confirmed — "front" view, camera at +Z looking toward -Z, shows
    // the character's face correctly). A viewer facing someone sees
    // their right hand on the viewer's own screen-left — which works
    // out to world -X, not +X. The "right" camera therefore belongs at
    // -X looking toward +X, not +X looking toward -X — confirmed
    // directly against a real screenshot showing the wrong (left) side
    // when this was still +X.
    function setOrthoView(mode) {
      if (mode === "front") {
        orthoCamera.position.set(0, 1.0, 3);
      } else if (mode === "right") {
        orthoCamera.position.set(-3, 1.0, 0);
      }
      orthoCamera.up.set(0, 1, 0);
      orthoCamera.lookAt(0, 1.0, 0);
      orthoControls.target.set(0, 1.0, 0);
      orthoControls.update();
    }
    setOrthoViewRef.current = setOrthoView;
    if (viewModeRef.current === "front" || viewModeRef.current === "right") setOrthoView(viewModeRef.current);

    // Real component-level refs (not local closures) — see their own
    // declarations near the top of the component for why. animate()
    // and the separate view-switch effect both read/write these.
    perspectiveCameraRef.current = camera;
    perspectiveControlsRef.current = controls;
    orthoCameraRef.current = orthoCamera;
    orthoControlsRef.current = orthoControls;
    activeCameraRef.current = viewModeRef.current === "perspective" ? camera : orthoCamera;
    activeControlsRef.current = viewModeRef.current === "perspective" ? controls : orthoControls;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1.5, 2.5, 2.0);
    scene.add(key);
    {
      const rings = buildHeightRings();
      rings.visible = showRingsRef.current; // default OFF
      ringsGroupRef.current = rings;
      scene.add(rings);
    }

    // Real feature (Session 101+): reference-image plane. Created once
    // here, hidden by default — the separate effect further below
    // (depends on [viewMode, showReferenceImage, front/sideReference-
    // ImageUrl]) owns everything about what it actually shows: texture,
    // position, rotation, visibility. A single reused plane rather than
    // one-per-view — swapping its texture/transform is cheap and avoids
    // ever having two reference planes in the scene at once.
    {
      const geometry = new THREE.PlaneGeometry(1, 1); // real size set per-texture in the effect below, once the image's true aspect ratio is known
      // Session 102 — parallax fix: the plane now sits AT the
      // character's depth plane (0 on the depth axis, see the
      // placement effect), so a perspective dolly (the body-region
      // zoom) scales photo and character identically — the same
      // insight as the parallax-safe height rings. A plane at depth 0
      // would slice the mesh, so it's made a pure BACKGROUND by render
      // order instead of physical depth: depthTest/depthWrite off,
      // drawn first, character always paints over it.
      // transparent:false is load-bearing: a transparent material
      // renders in the TRANSPARENT pass, after all opaque geometry —
      // with depthTest off it painted over the character (observed
      // live: character invisible behind the photo). Opaque +
      // renderOrder -999 = first in the opaque pass; the character
      // overdraws it. The photos are opaque images; nothing needs
      // alpha here.
      const material = new THREE.MeshBasicMaterial({ transparent: false, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
      const plane = new THREE.Mesh(geometry, material);
      plane.renderOrder = -999;
      plane.visible = false;
      referenceImagePlaneRef.current = plane;
      textureLoaderRef.current = new THREE.TextureLoader();
      scene.add(plane);
    }

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
    attachKtx2(gltfLoader);   // runtime GLBs carry KTX2 textures — see lib/gltfKtx2.js
    gltfLoader.load(
      glbUrl,
      (gltf) => {
        if (!mounted) return;
        loadedRoot = gltf.scene;
        loadedRootRef.current = loadedRoot;
        scene.add(loadedRoot);

        // Session 142 — STRIP BAKED-IN WARDROBE AT LOAD. Root cause of
        // "removing/switching jeans doesn't remove the old jeans",
        // proven by the remove-diag survivor sweep: the actor's
        // canonical GLB was itself a DRESSED export (nested
        // AuxScene/AuxScene_1 = an export of a load of an export), so
        // its garment meshes arrive inside the body file, tagged
        // isAccessoryMesh via the userData round-trip. The accessory
        // manager then dressed her AGAIN with live store-tracked
        // copies — two of every garment, perfectly coincident and
        // invisible until a swap made the live copy diverge from the
        // baked one (the light/dark z-fight patches). Baked copies
        // were never in the store, so no diff could ever remove them.
        // Fix at the load boundary (validate at load — the other half
        // of the Session 106 law): the manager is the ONLY owner of
        // wardrobe in this viewer, so any mesh that self-identifies as
        // an accessory in an incoming body file is removed and
        // disposed before morph discovery, dressing, or export can
        // ever see it. Legacy dressed files and clean body files both
        // load correctly through this.
        {
          const baked = [];
          loadedRoot.traverse((obj) => { if (obj.isMesh && obj.userData?.isAccessoryMesh) baked.push(obj); });
          for (const m of baked) {
            m.parent?.remove(m);
            m.geometry?.dispose();
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            mats.forEach((mm) => { if (mm) { Object.values(mm).forEach((v) => v?.isTexture && v.dispose()); mm.dispose(); } });
          }
          if (baked.length) {
            console.warn(`[MiniGlbViewer] Stripped ${baked.length} baked accessory mesh(es) from the incoming body GLB [${baked.map((m) => `"${m.name}"`).join(", ")}] — this file is a dressed export; the accessory manager owns wardrobe and will dress from the live config.`);
          }
        }

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
        // Session 102 — snapshot every bone's BIND-POSE quaternion now,
        // before the mixer's first update can write anything. Pose
        // sliders pin posed bones to bindRest*delta absolutely each
        // frame (override semantics — see applyPoseValues), and this
        // is the only moment the loaded rest values are guaranteed
        // untouched.
        const bindSkeleton = found[0]?.mesh?.skeleton;
        if (bindSkeleton) {
          for (const b of bindSkeleton.bones) b.userData.poseBindQuat = b.quaternion.clone();
        }
        // Session 102 — preload every pose calibration as soon as a
        // character is up, instead of lazily on first slider touch:
        // the lazy fetch (2 x ~46MB today) made the first drag appear
        // dead for seconds. The tables are module-shared and the
        // loading guards make repeat calls free, so this costs nothing
        // on subsequent mounts within a session.
        for (const dialKey of Object.keys(POSE_CALIBRATIONS)) ensurePoseCalibration(dialKey);

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

        // Session 101+: the canonical-50-pose intermediate step that
        // used to live here is GONE, not patched — it existed solely
        // to give normaliseScale() (also removed, see DAZ_DEFAULT_
        // HEIGHT's own comment above) a stable baseline to rescale
        // from. With no rescale happening at all anymore, applying a
        // throwaway pose first, then immediately overwriting it with
        // the real current values a few lines below, served no
        // remaining purpose — dead weight, removed. The real slider
        // values are applied directly now, once, below. Real, still-
        // unverified risk worth restating here since it's the reason
        // ANY of this matters: this assumes the Blender/glTF export
        // step correctly converts DAZ's native (roughly centimeter-
        // scale) units into real Three.js meters. If it doesn't, the
        // character renders roughly 100x too large. Check the console
        // log line "[MiniGlbViewer] groundAndMeasure: ...height=
        // X.XXXXm" — X should look like a real human height in METERS
        // (roughly 1.5-2.0), not centimeters (150-200).

        // Now the real current slider values, via the always-fresh ref.
        {
          const bp = bodyPropsRef.current;
          applyMorphInfluences(found, bp.bodyTorsoLength, bp.bodyArmsLength, bp.bodyLegsLength, bp.bodyHeight, bp.extraMorphValues);
        }
        setMeshesVersion(v => v + 1); // re-fires the live-update effect (the proven nudge path) now that meshes exist

        const m = groundAndMeasure(loadedRoot, candidates.lowCandidates, candidates.highCandidates, hipCandidates);
        if (mounted && m) {
          heightMRef.current = m.heightM;
          setHeightM(m.heightM);
          setTorsoLengthM(m.torsoM);
          setLegsLengthM(m.legsM);
        }

        // Real animation playback (Session 97) — gltf.animations is the
        // actual array of THREE.AnimationClip the loader parsed out,
        // named "idle"/"walk" per the real, confirmed fix on the
        // Blender/merge side. Keyed by name here so switching clips
        // later (the activeAnimation effect below) is a simple lookup,
        // not a re-scan. Missing clips are a real possibility (older
        // GLBs generated before the merge fix won't have any
        // gltf.animations at all) — handled by simply not creating a
        // mixer at all in that case, not by throwing.
        if (gltf.animations && gltf.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(loadedRoot);
          mixerRef.current = mixer;
          clockRef.current = new THREE.Timer();
          const byName = {};
          // Session 152 — clips do not get to sculpt her.
          //
          // idle and walk carry .morphTargetInfluences tracks alongside their
          // bone tracks — a constant snapshot of whatever the morph state was
          // when the clip was merged. The mixer's PropertyBinding writes those
          // tracks onto the body meshes EVERY FRAME, so the moment a clip
          // played, every slider the user had dragged snapped back to that
          // stale snapshot: press Walk and the heavy man you just sculpted
          // deflates to the base body while the sliders still read your
          // values. (Found live on Benny, step 1.)
          //
          // In this editor the sliders own the morphs, full stop. The bone
          // tracks — the whole of what makes a clip a walk — are untouched.
          // The runtime export bake has stripped these same tracks since it
          // was written, for the file-side version of this same reason.
          for (const clip of gltf.animations) {
            const bones = clip.tracks.filter((t) => !t.name.endsWith(".morphTargetInfluences"));
            if (bones.length !== clip.tracks.length) {
              const trimmed = clip.clone();
              trimmed.tracks = bones;
              console.log(`[MiniGlbViewer] clip "${clip.name}": dropped ${clip.tracks.length - bones.length} morph track(s) — sliders own the morphs; ${bones.length} bone track(s) kept.`);
              byName[clip.name] = trimmed;
            } else {
              byName[clip.name] = clip;
            }
          }
          animationsRef.current = byName;
          console.log(`[MiniGlbViewer] ${gltf.animations.length} animation(s) found: ${gltf.animations.map(c => c.name).join(", ")}`);
          if (onAnimationsLoaded) onAnimationsLoaded(Object.keys(byName));

          const initialClip = byName[activeAnimation] || gltf.animations[0];
          if (initialClip) {
            const initialAction = mixer.clipAction(initialClip);
            // Explicit, not relying on Three.js defaults — matches
            // ActorModelPanel's own proven, working pattern exactly.
            // That code re-asserts these on every play() call rather
            // than trusting the default holds reliably across
            // crossfades — real, working precedent worth matching
            // rather than diverging from.
            initialAction.setLoop(THREE.LoopRepeat, Infinity);
            initialAction.clampWhenFinished = false;
            initialAction.play();
          }
        } else {
          console.log("[MiniGlbViewer] no animations in this GLB");
          if (onAnimationsLoaded) onAnimationsLoaded([]);
        }

        // Loading-complete signal deliberately NOT fired here anymore —
        // moved to after all accessory promises settle below. Firing it
        // here (right after the base body/animations) let the spinner
        // hide well before a selected accessory had actually finished
        // loading and appeared — confirmed directly by the user seeing
        // the character still "undressed" after the spinner was already
        // gone.

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

        // --- Accessories: load + bone remapping (generalized from the
        // original hair-only version) ---
        // Real, confirmed structure (check_hair_structure.py, run
        // directly against the hair asset): fitted accessories are
        // genuine SkinnedMeshes bound to their own, separate armature —
        // not static meshes. Critically, that armature's bone names are
        // IDENTICAL to this character's own Genesis 9 skeleton (same
        // underlying DAZ rig — standard for any fitted hair/clothing).
        // Rather than load and manage a second, separate skeleton per
        // accessory that would need manual syncing with every
        // animation, each accessory mesh is rebound to THIS
        // character's own, already-loaded skeleton — same technique
        // real DAZ fitted-clothing systems use. Three.js binds by bone
        // INDEX, not name, so even with identical names, each
        // accessory's own bone order needs to be explicitly remapped to
        // this skeleton's 156-bone order — never assumed to already
        // match. Multiple accessories (hair + underwear top + bottom,
        // etc.) all bind to the same shared skeleton independently —
        // no interaction between them needed.
        // Session 103 — BODY/PROP SPLIT: the accessory pipeline that
        // lived here (load+bind+wrap inside the body effect) moved to
        // its own manager effect below. This effect now owns the BODY
        // ONLY; the spinner ends here, when the body is visible.
        if (mounted) { setModelLoading(false); if (onLoadingChange) onLoadingChange(false); }
      },
      undefined,
      (err) => { console.error("[MiniGlbViewer] GLTF load failed:", err); if (mounted) { setModelLoading(false); if (onLoadingChange) onLoadingChange(false); } }
    );

    let frameId;
    let mixerErrorLogged = false;
    let zeroSizeAtRenderLogged = false;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      // Reads the ref fresh every frame — this is what makes switching
      // views (perspective/front/right) instant, no re-render of this
      // effect required. activeControlsRef starts populated above; it
      // can only be null in the impossible case this runs before the
      // camera setup that assigns it, which never happens in practice.
      if (activeControlsRef.current) activeControlsRef.current.update();
      // Real feature (Session 101+) — smooth, one-time camera transition
      // when the user clicks a body-region button. Detects a genuine
      // region CHANGE (comparing focusRegionRef against what the
      // transition is already targeting) rather than restarting the
      // lerp on every render. Runs AFTER controls.update() above, not
      // before — OrbitControls reads camera.position/controls.target as
      // its own source of truth each frame, so setting them first here
      // means the very next controls.update() call already sees our
      // updated values, not a stale pre-lerp position.
      if (focusRegionRef.current !== cameraTransitionTargetRef.current) {
        cameraTransitionTargetRef.current = focusRegionRef.current;
        cameraTransitionActiveRef.current = true;
      }
      if (cameraTransitionActiveRef.current && activeCameraRef.current && activeControlsRef.current) {
        const region = REGION_CAMERA_TARGETS[cameraTransitionTargetRef.current] || REGION_CAMERA_TARGETS.fullBody;
        const mode = viewModeRef.current;
        if (mode === "perspective") {
          const targetPos = new THREE.Vector3(...region.position);
          const targetLook = new THREE.Vector3(...region.target);
          activeCameraRef.current.position.lerp(targetPos, 0.08);
          activeControlsRef.current.target.lerp(targetLook, 0.08);
          activeControlsRef.current.update();
          if (activeCameraRef.current.position.distanceTo(targetPos) < 0.01) {
            cameraTransitionActiveRef.current = false;
          }
        } else {
          // Ortho front/right: stay on the canonical axis. Pan by
          // lerping camera + target Y to the region height, zoom via
          // camera.zoom — never toward the perspective positions.
          const cam = activeCameraRef.current;
          const ctr = activeControlsRef.current;
          const ty = region.target[1];
          const axisPos = mode === "front" ? new THREE.Vector3(0, ty, 3) : new THREE.Vector3(-3, ty, 0);
          const goalLook = new THREE.Vector3(0, ty, 0);
          const goalZoom = region.orthoZoom || 1.0;
          cam.position.lerp(axisPos, 0.08);
          ctr.target.lerp(goalLook, 0.08);
          cam.zoom += (goalZoom - cam.zoom) * 0.08;
          cam.updateProjectionMatrix();
          ctr.update();
          if (cam.position.distanceTo(axisPos) < 0.01 && Math.abs(cam.zoom - goalZoom) < 0.01) {
            cameraTransitionActiveRef.current = false;
          }
        }
      }
      // Kept permanently (Session 97) — requestAnimationFrame is already
      // called above, so a per-frame exception here wouldn't kill the
      // RAF loop's own scheduling, but it WOULD mean mixer.update() and
      // renderer.render() below never run again, every frame, forever —
      // a silent, invisible freeze unless the console happens to be
      // open. This guard was proven not to be firing during the actual
      // freeze investigation (mixer state confirmed correct throughout),
      // but the safeguard itself is real and worth keeping regardless.
      try {
        if (mixerRef.current && clockRef.current) {
          clockRef.current.update();
          mixerRef.current.update(clockRef.current.getDelta());
        }
      } catch (err) {
        if (!mixerErrorLogged) {
          mixerErrorLogged = true;
          console.error("[MiniGlbViewer] Exception in mixer update — this would otherwise silently freeze the animation every frame from here on:", err);
        }
      }
      // Real fix (Session 101+) — must run AFTER mixer.update() and
      // EVERY frame, not just once when React state changes. If the
      // loaded animation clip has any keyframe touching the head
      // bone's own scale channel (even a constant 1.0 one baked in
      // from the DAZ export), mixer.update() above overwrites our
      // slider-driven scale right back to the animation's own value on
      // every single frame — which is exactly the "fights back"
      // symptom. Calling this here, after the mixer, means our value
      // always wins for that frame's actual render.
      applyHeadBoneScale(morphMeshesRef.current, bodyPropsRef.current.extraMorphValues.headSize || 0);
      applyChestSizeScale(morphMeshesRef.current, bodyPropsRef.current.extraMorphValues.chestSize || 0);
      applyFootSizeScale(morphMeshesRef.current, bodyPropsRef.current.extraMorphValues.footSize || 0);
      applyHandSizeScale(morphMeshesRef.current, bodyPropsRef.current.extraMorphValues.handSize || 0);
      // Pose sliders — after mixer AND after scales. Session 146 (user
      // directive): while ANY clip action is running, animations play
      // AS AUTHORED — pose dials do not touch bones at all (the pin
      // painting over the walk was found live: armsUpDwn=19 held her
      // arms out horizontally through the whole walk cycle). Dials
      // therefore pose the model only when no clip is playing (legacy
      // clip-less GLBs, or a future pause/none control). isRunning()
      // over the known clip names — same no-internals pattern as the
      // animation-switch effect.
      let clipPlaying = false;
      if (mixerRef.current && animationsRef.current) {
        for (const name of Object.keys(animationsRef.current)) {
          const a = mixerRef.current.existingAction(animationsRef.current[name]);
          if (a && a.isRunning()) { clipPlaying = true; break; }
        }
      }
      if (!clipPlaying) applyPoseValues(morphMeshesRef.current, bodyPropsRef.current.poseValues);
      const rendererSize = renderer.getSize(new THREE.Vector2());
      if ((rendererSize.width === 0 || rendererSize.height === 0) && !zeroSizeAtRenderLogged) {
        zeroSizeAtRenderLogged = true;
        console.error(`[MiniGlbViewer] renderer size is ZERO at render time: width=${rendererSize.width} height=${rendererSize.height} — mount.clientWidth=${mount.clientWidth} mount.clientHeight=${mount.clientHeight}`);
      }
      renderer.render(scene, activeCameraRef.current || camera);
    };
    animate();

    const handleResize = () => {
      if (!mount) return;
      // Guard against a transient zero-size reading — e.g. during a
      // rapid step transition, where the ResizeObserver can briefly
      // fire with clientWidth/clientHeight still at 0 before layout
      // settles. Without this, renderer.setSize(0, 0) would succeed
      // silently here, then fail every subsequent animate() frame with
      // GL_INVALID_FRAMEBUFFER_OPERATION ("Attachment has zero size")
      // — confirmed directly, real console output showing exactly
      // that repeated failure after an otherwise fully successful load.
      if (mount.clientWidth === 0 || mount.clientHeight === 0) {
        console.log(`[MiniGlbViewer] handleResize SKIPPED (zero size): clientWidth=${mount.clientWidth} clientHeight=${mount.clientHeight}`);
        return;
      }
      console.log(`[MiniGlbViewer] handleResize applying real size: clientWidth=${mount.clientWidth} clientHeight=${mount.clientHeight}`);
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      // Ortho frustum recomputed from the same real half-height —
      // aspect changes width (left/right), never the vertical extent,
      // matching how the perspective camera's own aspect update works.
      const newOrthoAspect = mount.clientWidth / mount.clientHeight;
      orthoCamera.left = -ORTHO_VIEW_HALF_HEIGHT * newOrthoAspect;
      orthoCamera.right = ORTHO_VIEW_HALF_HEIGHT * newOrthoAspect;
      orthoCamera.top = ORTHO_VIEW_HALF_HEIGHT;
      orthoCamera.bottom = -ORTHO_VIEW_HALF_HEIGHT;
      orthoCamera.updateProjectionMatrix();
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
      orthoControls.dispose();
      morphMeshesRef.current = [];
      accessoryMeshesRef.current = {};
      loadedRootRef.current = null;
      groundingCandidatesRef.current = { lowCandidates: [], highCandidates: [], hipCandidates: [] };
      if (mixerRef.current) mixerRef.current.stopAllAction();
      mixerRef.current = null;
      animationsRef.current = {};
      clockRef.current = null;
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
      if (referenceImagePlaneRef.current) {
        referenceImagePlaneRef.current.geometry.dispose();
        referenceImagePlaneRef.current.material.dispose();
      }
      Object.values(loadedReferenceTexturesRef.current).forEach((tex) => tex.dispose());
      loadedReferenceTexturesRef.current = {};
      renderer.dispose();
      dracoLoader.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
    // Deliberately NOT depending on bodyTorsoLength/bodyArmsLength/bodyLegsLength
    // OR on accessory scale values here — all read once, at load time,
    // as the initial state. Live updates while dragging go through the
    // separate effect below, which doesn't tear down and rebuild the
    // whole Three.js scene. Confirmed real bug from depending on full
    // accessory objects (including scale) here: every single slider
    // tick re-triggered this entire effect, showing the loading
    // spinner and reloading the whole character on every drag —
    // watching only the URLs fixes that at the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glbUrl]); // Session 103 split: BODY only — prop changes no longer reload the character

  // ── Session 103 — ACCESSORY MANAGER: game-style prop swapping. ────
  // Diffs the wanted accessory list against the live store: removed
  // props are disposed from the running scene, new ones load and bind
  // against the existing body — the character never reloads for a
  // wardrobe change. Waits for the body via meshesVersion; a body
  // swap empties the store (body effect cleanup) and this re-dresses
  // the new body. Manual fit sliders and refit effects read the same
  // store and are untouched.
  useEffect(() => {
    if (!meshesVersion) return; // body not ready yet
    const loadedRoot = loadedRootRef.current;
    if (!loadedRoot) return;
    let cancelled = false;
    const store = accessoryMeshesRef.current;
    const desired = new Map(accessories.map(a => [a.url, a]));
    for (const url of Object.keys(store)) {
      if (!desired.has(url)) {
        // Session 142 DIAGNOSTIC (temporary, log-only, zero behaviour
        // change) — Magnus: "setting legs jeans to none / switching
        // jeans doesn't remove the current jeans." The 'removed' log
        // below fired in the failing session, yet the garment stayed
        // visible — a detached mesh cannot render, so what's on screen
        // is NOT the mesh this loop removes. These logs identify what
        // it is instead: per-entry removal truth (was it even attached
        // when we removed it?), then a full-graph sweep from the TRUE
        // scene top (not just loadedRoot) listing every mesh still
        // present that self-identifies as an accessory.
        for (const e of store[url]) {
          if (e.mesh) {
            const hadParent = !!e.mesh.parent;
            const parentName = e.mesh.parent?.name || e.mesh.parent?.type || "none";
            e.mesh.parent?.remove(e.mesh);
            e.mesh.geometry?.dispose();
            console.log(`[MiniGlbViewer] remove-diag: "${e.mesh.name}" uuid=${e.mesh.uuid.slice(0, 8)} matName=${e.matName} hadParent=${hadParent} (was under "${parentName}") stillHasParent=${!!e.mesh.parent}`);
          } else {
            console.warn(`[MiniGlbViewer] remove-diag: store entry "${e.matName}" for ${url} has NO mesh reference — nothing to detach`);
          }
        }
        delete store[url];
        console.log(`[MiniGlbViewer] Accessory manager: removed ${url} from the live scene`);
        // Session 152 — a removed garment uncovers skin. Recompute the layer
        // culling from what is actually left in the store, or she keeps a
        // hole shaped like the jeans she just took off.
        settleLayers(loadedRoot, store, accessories);
        {
          let sceneTop = loadedRootRef.current;
          while (sceneTop && sceneTop.parent) sceneTop = sceneTop.parent;
          const survivors = [];
          sceneTop?.traverse((o) => {
            if (o.isMesh && o.userData?.isAccessoryMesh) {
              survivors.push(`"${o.name}" uuid=${o.uuid.slice(0, 8)} visible=${o.visible} under="${o.parent?.name || o.parent?.type || "?"}"`);
            }
          });
          console.log(`[MiniGlbViewer] remove-diag: accessory meshes still in the FULL scene graph after removal (${survivors.length}): ${survivors.join(" | ") || "(none)"}`);
        }
      }
    }
    const missing = [...desired.values()].filter(a => !store[a.url]);
    const reportParts = () => {
      if (cancelled || !onAccessoryPartsLoaded) return;
      const partsMap = {};
      for (const [u, es] of Object.entries(store)) partsMap[u] = es.map(e => e.matName);
      onAccessoryPartsLoaded(partsMap);
    };
    if (missing.length === 0) {
      reportParts();
      // Session 152 — the settled path needs the mask too. Under StrictMode the
      // first effect pass often loads every garment and the second finds the
      // store already full, landing HERE — and the skin mask only ran at the
      // end of the additions path below. Whether this run loaded anything or
      // found it all done, the wardrobe is now settled, and settled is exactly
      // when the mask must be true.
      settleLayers(loadedRoot, store, accessories);
      return () => { cancelled = true; };
    }
    // Session 103 — CANCELLATION MUST CLEAN ITS HALF-WORK: during a
    // draft restore the deps settle in waves (accessory list, then
    // meshesVersion), so a new run can cancel one mid-garment. The
    // aborted run had already registered SOME primitives in the store,
    // so the next run saw the url as "present" and skipped it — a bra
    // whose key existed but whose meshes never reached the scene
    // (found live: restored draft, bra saved but invisible). On
    // cancel, dispose this run's partial entries so the next run sees
    // the truth and reloads cleanly.
    const startedUrls = missing.map(a => a.url);
    // Session 105 — the cleanup below used to purge every URL in
    // startedUrls unconditionally, on the sole test "does the store
    // still have an entry for it." That's true for a genuinely
    // half-loaded accessory AND for one that finished loading
    // completely moments earlier — the two are indistinguishable by
    // that test alone. Confirmed live: remove the shirt while the
    // shorts are still resolving in the same effect run, and the
    // instant the shorts' last primitive gets added to the scene, the
    // very next lines purge BOTH the shirt (correctly, still
    // incomplete) AND the shorts (incorrectly, already finished) —
    // visible as the shorts vanishing and reloading from scratch for
    // no reason tied to anything the user actually changed. Tracking
    // real per-URL completion, not just "is there currently something
    // in the store," is the fix — the store having entries and the
    // load having genuinely finished are different facts.
    const finishedUrls = new Set();
    let mainSkinnedMesh = null;
    loadedRoot.traverse((o) => { if (!mainSkinnedMesh && o.isSkinnedMesh && o.skeleton?.bones?.length) mainSkinnedMesh = o; });
    if (!mainSkinnedMesh) { console.error("[MiniGlbViewer] Accessory manager: no skinned mesh on the body to bind to"); return () => { cancelled = true; }; }
    mainMeshRef.current = mainSkinnedMesh;
    const dl = new DRACOLoader();
    dl.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
    console.log(`[MiniGlbViewer] Accessory manager: adding ${missing.length} prop(s) to the live scene`);
    Promise.allSettled(missing.map(({ url, scale, offset, rotation, parts, tint }) =>
      loadAndBindAccessory(url, mainSkinnedMesh, mainSkinnedMesh.skeleton, loadedRoot, dl, () => !cancelled, scale, offset, rotation, parts, store, heightMRef.current, tint)
        .then(() => { finishedUrls.add(url); })
        // Session 142 — allSettled exists so one broken garment can't
        // sink the others, but it also SWALLOWED every rejection: a
        // loader-wide crash rendered her nude with an empty console.
        // Never silent: name the garment, show the real error.
        .catch((e) => { console.error(`[MiniGlbViewer] Accessory manager: FAILED to load ${url} — she will be missing this garment:`, e); throw e; })
    )).then(() => {
      reportParts();
      // Session 152 — the body joins the layer system (see bodyLayers.js).
      // After every garment in this batch has loaded AND shrunk-wrapped
      // (shrinkwrap must see the full body surface, so culling comes last),
      // hide the skin the active wardrobe covers.
      if (!cancelled) settleLayers(loadedRoot, store, accessories);
    });
    return () => {
      cancelled = true;
      for (const url of startedUrls) {
        if (store[url] && !finishedUrls.has(url)) {
          for (const e of store[url]) { if (e.mesh) { e.mesh.parent?.remove(e.mesh); e.mesh.geometry?.dispose(); } }
          delete store[url];
          console.log(`[MiniGlbViewer] Accessory manager: cancelled mid-load — purged partial entries for ${url} so the next run reloads it cleanly`);
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(accessories.map(a => a.url)), meshesVersion]);

  // View mode switch (perspective/front/right) — deliberately separate
  // from the load effect above. Only flips which camera/controls the
  // render loop uses (via the refs populated during load) and, for
  // front/right, snaps to a fresh canonical view — never reloads the
  // GLB or touches the Three.js scene/renderer setup. Guards against
  // the refs not being populated yet (e.g. viewMode changes before the
  // load effect has run at all on first mount).
  useEffect(() => {
    if (!perspectiveCameraRef.current || !orthoCameraRef.current) return;
    if (viewMode === "perspective") {
      activeCameraRef.current = perspectiveCameraRef.current;
      activeControlsRef.current = perspectiveControlsRef.current;
      if (perspectiveControlsRef.current) perspectiveControlsRef.current.enabled = true;
      if (orthoControlsRef.current) orthoControlsRef.current.enabled = false;
    } else {
      activeCameraRef.current = orthoCameraRef.current;
      activeControlsRef.current = orthoControlsRef.current;
      if (orthoControlsRef.current) orthoControlsRef.current.enabled = true;
      if (perspectiveControlsRef.current) perspectiveControlsRef.current.enabled = false;
      if (setOrthoViewRef.current) setOrthoViewRef.current(viewMode);
    }
  }, [viewMode]);

  // Session 103 — perspectiveOnly enforcement: with the persistent
  // viewer, the instance survives step changes, so an ortho viewMode
  // chosen on the Appearance step would silently persist onto locked
  // steps (dropdown hidden, camera stuck in Front). Lock means lock.
  useEffect(() => {
    if (perspectiveOnly && viewMode !== "perspective") setViewMode("perspective");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perspectiveOnly, viewMode]);

  // Reference-image plane — which texture shows, where it's placed,
  // and whether it's visible at all. Deliberately separate from both
  // the load effect and the view-switch effect above: changing the
  // toggle or switching views here never reloads the GLB or touches
  // camera/controls state, matching the same "cheap live update"
  // pattern used throughout this file. Guards against the plane ref
  // not being populated yet, same as the view-switch effect.
  useEffect(() => {
    const plane = referenceImagePlaneRef.current;
    if (!plane) return;

    const url = viewMode === "front" ? frontReferenceImageUrl
              : viewMode === "right" ? sideReferenceImageUrl
              : null;

    if (!showReferenceImage || viewMode === "perspective" || !url) {
      plane.visible = false;
      return;
    }

    let cancelled = false;

    function positionPlane(texture) {
      if (cancelled) return;
      const isFront = viewMode === "front";
      // Real calibration (Session 101+) — interpret_body.py now exposes
      // {front,side}_px_per_cm_silhouette and {front,side}_bottom_px
      // (the exact pixel row of the person's own feet within the debug
      // PNG, which has real black padding below them — confirmed
      // visually, simply grounding the image's own bottom edge was
      // wrong). Together these give the plane's TRUE real-world height
      // and exactly how far below the image's own bottom edge the real
      // feet sit, rather than guessing a fixed frame size. Falls back
      // to the old fixed-height guess when calibration wasn't provided
      // (e.g. dev-loaded PNGs without a matching measurements.json) —
      // not accurate, but keeps the toggle usable rather than broken.
      const pxPerCm = referenceCalibration?.[isFront ? "front_px_per_cm_silhouette" : "side_px_per_cm_silhouette"];
      const bottomPx = referenceCalibration?.[isFront ? "front_bottom_px" : "side_bottom_px"];
      const hasCalibration = pxPerCm > 0 && bottomPx != null;

      const aspect = texture.image.width / texture.image.height;
      let planeHeightM, groundOffsetM;
      if (hasCalibration) {
        planeHeightM = (texture.image.height / pxPerCm) / 100;
        const paddingBelowFeetM = ((texture.image.height - bottomPx) / pxPerCm) / 100;
        groundOffsetM = planeHeightM / 2 - paddingBelowFeetM; // plane's own center, in world Y, so the real feet land exactly at y=0
      } else {
        // Session 102 — the fixed 2.2m guess that lived here is GONE
        // (user's rule): plane height reads from measurements.json's
        // calibration or the plane doesn't show at all. A guessed
        // scale renders a confidently WRONG comparison, which is
        // worse than an honestly absent one (crash loudly, don't
        // guess quietly).
        console.error("[MiniGlbViewer] reference image has NO calibration (px_per_cm/bottom_px) — refusing to show it at a guessed scale");
        plane.visible = false;
        return;
      }
      const planeWidth = planeHeightM * aspect;
      plane.geometry.dispose();
      plane.geometry = new THREE.PlaneGeometry(planeWidth, planeHeightM);
      plane.material.map = texture;
      plane.material.needsUpdate = true;

      if (isFront) {
        // Default PlaneGeometry already faces +Z — no rotation needed.
        // Placed at a small negative Z, genuinely behind the character
        // (who stands near the origin), facing the front camera at +Z.
        plane.rotation.set(0, 0, 0);
        plane.position.set(0, groundOffsetM, 0); // character's own depth plane — parallax-free under dolly (background via renderOrder, not depth)
      } else if (viewMode === "right") {
        // Right camera sits at -X (confirmed fix, see setOrthoView
        // above) looking toward +X — rotating -90° around Y turns the
        // default +Z-facing plane to face -X, toward that camera.
        // Placed at a small positive X, genuinely behind the character
        // from the -X camera's point of view.
        plane.rotation.set(0, -Math.PI / 2, 0);
        plane.position.set(0, groundOffsetM, 0); // same parallax-free depth-0 placement as front
      }

      // Real manual fine-tune offset, applied on top of the calibrated
      // base position above. Computed in the plane's own LOCAL space
      // (x = sideways across the image, y = up/down — always, from the
      // viewer's own point of view looking at the plane) then rotated
      // into world space via the plane's own current rotation — this
      // is what makes "sideways" correctly mean world X for front but
      // world Z for right (the plane itself is rotated -90° around Y
      // for right, so its own local X axis now points along world Z).
      // Deliberately NOT baked into groundOffsetM/position.set() above
      // — keeping this as a separate, always-reapplied addition means
      // dragging the offset slider never has to duplicate the real
      // calibration math, just nudge on top of it.
      const OFFSET_RANGE_M = 0.5; // ±0.5m at the slider's full ±100 range — small, deliberate: fine-tuning, not repositioning from scratch
      const view = isFront ? "front" : "right";
      const offset = referenceOffsets[view] || { x: 0, y: 0 };
      const localOffset = new THREE.Vector3((offset.x / 100) * OFFSET_RANGE_M, (offset.y / 100) * OFFSET_RANGE_M, 0);
      localOffset.applyEuler(plane.rotation);
      plane.position.add(localOffset);

      plane.visible = true;
    }

    const cached = loadedReferenceTexturesRef.current[url];
    if (cached) {
      positionPlane(cached);
    } else if (textureLoaderRef.current) {
      textureLoaderRef.current.load(
        url,
        (texture) => {
          if (cancelled) { texture.dispose(); return; }
          texture.colorSpace = THREE.SRGBColorSpace;
          loadedReferenceTexturesRef.current[url] = texture;
          positionPlane(texture);
        },
        undefined,
        (err) => console.error(`[MiniGlbViewer] reference image load failed for ${url}:`, err)
      );
    }

    return () => { cancelled = true; };
  }, [viewMode, showReferenceImage, frontReferenceImageUrl, sideReferenceImageUrl, referenceCalibration, referenceOffsets]);

  // Live updates on every slider drag — reads the meshes found during
  // load (via the ref) without reloading the model or touching the
  // Three.js scene setup, which only happens in the effect above.
  useEffect(() => {
    applyMorphInfluences(morphMeshesRef.current, bodyTorsoLength, bodyArmsLength, bodyLegsLength, bodyHeight, extraMorphValues);
    const { lowCandidates, highCandidates, hipCandidates } = groundingCandidatesRef.current;
    const m = groundAndMeasure(loadedRootRef.current, lowCandidates, highCandidates, hipCandidates);
    if (m) {
      setHeightM(m.heightM);
      setTorsoLengthM(m.torsoM);
      setLegsLengthM(m.legsM);
    }
    // extraMorphValues watched via JSON.stringify, not the object
    // reference directly — same reasoning as the accessories prop
    // elsewhere in this file: a parent re-render can hand down a new
    // object reference with identical values, which would otherwise
    // re-run this (cheap, but not free) effect on every render rather
    // than only on an actual value change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyTorsoLength, bodyArmsLength, bodyLegsLength, bodyHeight, JSON.stringify(extraMorphValues), meshesVersion]);

  // Measurement rings on/off — flips visibility only.
  useEffect(() => {
    if (ringsGroupRef.current) ringsGroupRef.current.visible = showRings;
  }, [showRings]);

  // Body-change REFIT (Session 101): registration + shrinkwrap are
  // baked into accessory geometry at load, against the body shape of
  // that moment. When the body morphs change afterwards, the old fit is
  // stale — garments keep wearing the previous body. This effect, per
  // body change (debounced so slider drags don't run the solver every
  // tick): invalidates the cached body-surface BVH (it bakes morph
  // influences), restores each primitive's pre-shrinkwrap positions,
  // re-runs shrinkwrap against the fresh body, recaptures the manual-
  // slider baseline, and re-applies the current manual transform.
  // Registration is skeleton-bind-pose math — morph-independent — so it
  // stays baked in the prefit snapshot and is not recomputed.
  const refitTimerRef = useRef(null);
  const layerSettleTimerRef = useRef(null);
  useEffect(() => {
    if (refitTimerRef.current) clearTimeout(refitTimerRef.current);
    refitTimerRef.current = setTimeout(() => {
      const mainMesh = mainMeshRef.current;
      const store = accessoryMeshesRef.current;
      const urls = Object.keys(store);
      if (!mainMesh || urls.length === 0) return;

      // Invalidate the BVH cache — next getBodySurfaceBVH rebuilds it
      // from the body's CURRENT morph influences.
      const largest = findBodySkinMesh(mainMesh);
      const parent = largest.parent || largest;
      delete parent.userData.shrinkwrapBVH;

      const t0 = performance.now();
      let refitted = 0;
      for (const url of urls) {
        const acc = accessories.find((a) => a.url === url);
        for (const entry of store[url]) {
          if (!entry.prefitPositions) continue;
          restorePositions(entry.mesh.geometry.attributes.position, entry.prefitPositions);
          entry.mesh.geometry.attributes.position.needsUpdate = true;
          if (entry.shrinkwrapEligible) {
            shrinkwrapToBody(entry.mesh, mainMesh, url);
          }
          // Recapture the manual-slider baseline from the refitted
          // shape, then re-apply the current manual transform on top.
          entry.originalPositions = capturePositions(entry.mesh.geometry.attributes.position);
          entry.mesh.geometry.computeBoundingBox();
          entry.mesh.geometry.boundingBox.getCenter(entry.center);
          const t = effectiveTransform(acc?.scale, acc?.offset, acc?.rotation, acc?.parts, entry.matName);
          applyAccessoryScale(entry.mesh, entry.originalPositions, entry.center, t.scale, t.offset, t.rotation);
          refitted++;
        }
      }
      console.log(`[MiniGlbViewer] Body refit: ${refitted} accessory primitive(s) re-shrinkwrapped against the current body shape in ${(performance.now() - t0).toFixed(0)}ms (body morphs changed).`);
      // Session 152 — the skin mask ages exactly like the garment fit does.
      //
      // The mask was computed against the body as it stood when the wardrobe
      // finished loading. A later morph change moves the skin — and the panel
      // now passes her saved proportions as props, which land precisely here,
      // AFTER the wardrobe's first mask. Found on her chest: the sculpt
      // arrived, the skin moved, and the stale mask left breast skin showing
      // through the top. Same cure as the fit itself: recompute after every
      // refit, against the garments as just re-wrapped and the body as it now
      // is.
      settleLayers(loadedRootRef.current, store, accessories);
    }, 300);
    return () => { if (refitTimerRef.current) clearTimeout(refitTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyTorsoLength, bodyArmsLength, bodyLegsLength, bodyHeight, JSON.stringify(extraMorphValues)]);
  // ^ Session 102: extraMorphValues added — the refit previously only
  // watched the four named sliders, so ANY of the 113 morphs (Heavy,
  // breasts, waist...) changed after dressing expanded the body
  // straight through the fabric with no re-shrinkwrap (reported live:
  // "kläderna sjunker in i skinnet"). Debounce unchanged; the BVH
  // invalidation inside already rebuilds against current influences.

  // Live updates on every accessory scale slider drag — same pattern as
  // the morph effect above: reads the meshes found during load (via
  // accessoryMeshesRef) and re-applies scale directly, without
  // reloading the model or touching Three.js scene setup at all. This
  // is the fix for the loading-spinner-on-every-drag bug — scale used
  // to live inside the load effect's own dependencies above, so every
  // tick re-triggered a full reload; now it's fully separate.
  useEffect(() => {
    for (const { url, scale, offset, rotation, parts, tint } of accessories) {
      // One entry PER PRIMITIVE — a multi-material accessory (e.g. the
      // shorts: Trim + Pants + Waistband, or the bra: Bra_Heart /
      // Bra_Main / Bra_Upper_Border / Bra_Straps / Bra_Underbust). Each
      // primitive gets the garment-level transform combined with its
      // own optional per-part adjustment (scales multiply, offsets add).
      const entries = accessoryMeshesRef.current[url];
      if (entries) {
        for (const entry of entries) {
          // Per-part visibility: hidden unless explicitly set false —
          // lets the wizard toggle individual parts (e.g. hide the
          // bra's heart ornament, or isolate the band while fitting
          // it). Lives inside the same parts object, so the dependency
          // key below already covers it.
          entry.mesh.visible = parts?.[entry.matName]?.visible !== false;
          const t = effectiveTransform(scale, offset, rotation, parts, entry.matName);
          applyAccessoryScale(entry.mesh, entry.originalPositions, entry.center, t.scale, t.offset, t.rotation);
          // Session 141 — live tint, same whole/part rule (see
          // applyAccessoryTint for why this was never live before).
          applyAccessoryTint(entry.mesh, parts?.[entry.matName]?.tint || tint);
        }
      }
    }
    // Session 152 — a manual fit change moves a LAYER, so the layers above
    // and beneath it are stale the moment the slider settles: scale a top's Z
    // to 1.15x and the yoke grows out over hair that was fitted against the
    // smaller top (found live, red ring around her yoke), while the skin mask
    // keeps culling for the old surface. Debounced like the body refit, so a
    // drag costs one settle, not sixty.
    if (layerSettleTimerRef.current) clearTimeout(layerSettleTimerRef.current);
    layerSettleTimerRef.current = setTimeout(() => {
      settleLayers(loadedRootRef.current, accessoryMeshesRef.current, accessories);
    }, 350);
    // Dependency key covers scale, offset, per-part adjustments AND
    // tint — all re-apply live on every drag/pick, with no model reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(accessories.map(a => [a.scale, a.offset, a.rotation, a.parts, a.tint]))]);

  // Switches the playing clip when activeAnimation changes — separate
  // from the load effect above, since the caller can switch clips
  // (idle <-> walk) on an already-loaded model without needing to
  // reload the GLB at all. Crossfades rather than an abrupt cut, using
  // Three.js's own built-in action.crossFadeTo — standard, not a custom
  // blend implementation.
  useEffect(() => {
    const mixer = mixerRef.current;
    const clips = animationsRef.current;
    if (!mixer || !clips[activeAnimation]) return;
    const nextAction = mixer.clipAction(clips[activeAnimation]);
    // Find whichever action is currently actually running, if any —
    // .getRoot() differs per action, but mixer._actions isn't public
    // API, so this walks the known clip names instead of reaching into
    // Three.js internals.
    let currentAction = null;
    for (const name of Object.keys(clips)) {
      if (name === activeAnimation) continue;
      const action = mixer.existingAction(clips[name]);
      if (action && action.isRunning()) { currentAction = action; break; }
    }
    // Matches ActorModelPanel's proven, working play() exactly — real,
    // working precedent, not assumed Three.js defaults. Two concrete
    // differences from the earlier version: explicit setLoop/
    // clampWhenFinished on every switch (not just relying on whatever
    // the default happens to be), and .play() chained directly onto
    // crossFadeFrom (called on the INCOMING action) rather than called
    // separately beforehand — crossFadeFrom returns the action it's
    // called on, so this guarantees .play() lands on nextAction, not
    // whichever action happened to be current before the switch.
    nextAction.reset();
    nextAction.setLoop(THREE.LoopRepeat, Infinity);
    nextAction.clampWhenFinished = false;
    if (currentAction && currentAction !== nextAction) {
      nextAction.crossFadeFrom(currentAction, 0.3, false).play();
    } else {
      nextAction.play();
    }
  }, [activeAnimation]);

// ── Session 152 — baking, for the file a running world loads ────────────────
//
// Three things separate the editor's export from the runtime one, and all three
// are deliberate choices in the editor that are simply wrong once nobody is
// going to edit the file again.

// 1. THE SCULPT.
//
// GLTFExporter keeps all 113 morph targets and writes the current influences as
// the file's starting weights — the export opens correctly shaped AND stays
// adjustable. That is the right trade for a working file and it is 81% of a
// 92MB download for a world that will never move a slider.
//
// The targets cannot simply be dropped: her shape is IN those influences.
// Sixteen are non-zero on the body meshes (BreastsDiameter -0.41, BreastSize
// 0.11, BodyMuscularVolume -0.1 …) and three on the head (ProportionLarger
// 0.32, TorsoLength 0.19, NeckLength 0.1). Strip without baking and she reverts
// to the unsculpted base — a different woman, quietly.
//
// So: fold the influences into the vertices, then drop the targets. glTF morphs
// are relative (GLTFLoader sets morphTargetsRelative), so a weighted sum of the
// deltas is the whole of it. Reversible — the caller restores afterwards,
// because this same mesh is still on screen being edited.
function bakeMorphsForExport(root) {
  const undo = [];
  let baked = 0, saved = 0;

  root.traverse((mesh) => {
    const geo = mesh.geometry;
    const infl = mesh.morphTargetInfluences;
    if (!geo?.morphAttributes?.position || !infl?.length) return;

    const relative = geo.morphTargetsRelative !== false;
    const live = infl
      .map((v, i) => [i, v])
      .filter(([, v]) => Math.abs(v) > 1e-6);

    const keptAttrs = geo.morphAttributes;
    const keptDict  = mesh.morphTargetDictionary;
    const keptInfl  = infl.slice();
    const keptPos   = geo.attributes.position.array.slice();
    const keptNorm  = geo.attributes.normal ? geo.attributes.normal.array.slice() : null;

    for (const which of ["position", "normal"]) {
      const base = geo.attributes[which];
      const targets = geo.morphAttributes[which];
      if (!base || !targets) continue;
      const arr = base.array;
      for (const [t, w] of live) {
        const d = targets[t];
        if (!d) continue;
        const da = d.array;
        // Absolute targets store final positions, so the delta is theirs minus
        // the base — which for `normal` would be nonsense, hence the guard.
        if (relative) {
          for (let k = 0; k < arr.length; k++) arr[k] += w * da[k];
        } else if (which === "position") {
          for (let k = 0; k < arr.length; k++) arr[k] += w * (da[k] - keptPos[k]);
        }
      }
      base.needsUpdate = true;
    }
    if (geo.attributes.normal) geo.normalizeNormals?.();

    // Count what the file no longer has to carry.
    for (const which of Object.keys(geo.morphAttributes)) {
      for (const a of geo.morphAttributes[which]) saved += a.array.byteLength;
    }

    geo.morphAttributes = {};
    // Empty, not undefined: three checks truthiness in some paths and .length
    // in others, and this mesh is still on screen and still being rendered
    // between here and the restore.
    mesh.morphTargetInfluences = [];
    mesh.morphTargetDictionary = {};
    baked++;

    undo.push(() => {
      geo.attributes.position.array.set(keptPos);
      geo.attributes.position.needsUpdate = true;
      if (keptNorm && geo.attributes.normal) {
        geo.attributes.normal.array.set(keptNorm);
        geo.attributes.normal.needsUpdate = true;
      }
      geo.morphAttributes = keptAttrs;
      mesh.morphTargetInfluences = keptInfl;
      mesh.morphTargetDictionary = keptDict;
    });
  });

  console.log(`[MiniGlbViewer] runtime bake: sculpt folded into ${baked} mesh(es), ` +
              `${(saved / 1e6).toFixed(1)}MB of morph targets dropped.`);
  return () => { for (const f of undo) f(); };
}

// 2. THE SKELETONS.
//
// Accessories keep their own skeleton on purpose here (see the note at the top
// of this file) — for an editor that is right, and standing in bind pose it
// costs nothing because everything is in the same rest pose. It is fatal for a
// runtime file: the clips animate the BODY's nodes, so `walk` moves her and
// leaves the jeans standing where they were.
//
// Measured against her actual wardrobe: Angie Top is 42 bones and all 42 match
// the body by name. Angie Jeans is 48 with 16 misses, every one a Blender
// `.00N` duplicate — zero misses once the suffix is stripped. Charm Hair shares
// only 2 of 13: it is skinned to a DAZ chain the body does not carry, so it is
// left alone rather than forced, and it follows the head because its weights
// are on the head bone either way.
//
// A garment is only rebound when EVERY one of its bones resolves. A partial
// rebind is worse than none — the unresolved bones collapse to the origin and
// take their vertices with them.
function rebindGarmentsForExport(root, bodySkinMesh) {
  const bodySkeleton = bodySkinMesh?.skeleton;
  if (!bodySkeleton) {
    console.warn("[MiniGlbViewer] runtime bake: no body skeleton — garments keep their own (they will not animate).");
    return () => {};
  }

  const byName = new Map();
  bodySkeleton.bones.forEach((b, i) => byName.set(b.name, i));
  const resolve = (name) => {
    if (byName.has(name)) return byName.get(name);
    // Both spellings of a Blender duplicate: "l_thigh.001" in the file,
    // "l_thigh001" after three.js sanitizes node names at load.
    const stripped = name.replace(/\.?\d{3}$/, "");
    return byName.has(stripped) ? byName.get(stripped) : -1;
  };

  const undo = [];
  root.traverse((mesh) => {
    if (!mesh.isSkinnedMesh || !mesh.userData?.isAccessoryMesh) return;
    if (mesh.skeleton === bodySkeleton) return;

    const bones = mesh.skeleton?.bones || [];
    const map = bones.map((b) => resolve(b.name));
    const missing = bones.filter((b, i) => map[i] < 0).map((b) => b.name);

    if (!bones.length || missing.length) {
      console.warn(`[MiniGlbViewer] runtime bake: "${mesh.name}" keeps its own skeleton — ` +
        `${missing.length}/${bones.length} bone(s) not on the body, e.g. ${missing.slice(0, 3).join(", ")}. ` +
        `It will not follow the animation.`);
      return;
    }

    const joints = mesh.geometry.getAttribute("skinIndex");
    if (!joints) return;
    const before = joints.array.slice();
    const oldSkeleton = mesh.skeleton;
    const oldBind = mesh.bindMatrix.clone();

    for (let k = 0; k < joints.array.length; k++) {
      const j = joints.array[k];
      joints.array[k] = j < map.length && map[j] >= 0 ? map[j] : 0;
    }
    joints.needsUpdate = true;
    mesh.bind(bodySkeleton, mesh.bindMatrix);

    console.log(`[MiniGlbViewer] runtime bake: "${mesh.name}" rebound onto the body skeleton ` +
                `(${bones.length} bones).`);

    undo.push(() => {
      joints.array.set(before);
      joints.needsUpdate = true;
      mesh.bind(oldSkeleton, oldBind);
    });
  });

  return () => { for (const f of undo) f(); };
}

  // Real feature — produces a blob: URL of the currently-loaded
  // character, with its CURRENT morph slider values as the starting
  // weights, as a real .glb binary. Deliberately NOT a "bake" that
  // permanently deforms the base mesh and discards the morph targets
  // — GLTFExporter by default keeps all 113 morph targets intact and
  // just writes the current morphTargetInfluences as each mesh's
  // starting weights. That means the produced file opens already
  // shaped correctly, but every slider stays fully adjustable
  // afterward. Animations (idle/walk, if any) are included too, so
  // this is a faithful, complete snapshot, not just the static mesh.
  // Promise-based specifically so callers (the download button below,
  // and CharacterWizard's step-navigation handler) can await a single
  // shared implementation rather than duplicating the export logic.
  function exportMorphedGlbBlob({ includeAccessories = false, runtime = false } = {}) {
    return new Promise((resolve, reject) => {
      if (!loadedRootRef.current) {
        reject(new Error("no character currently loaded"));
        return;
      }
      // Session 141 — the panel's Explore bridge has been calling this
      // with { includeAccessories: true } since Session 110, and this
      // function silently ignored it (took no parameters at all) while
      // unconditionally detaching every garment — the Session 102
      // body-only contract applied to a caller that wanted the
      // opposite. Real options now. Default stays body-only: the
      // wizard's per-Next shape bake (Session 101/102 contract, persist
      // size limit) is unchanged.
      //
      // LAW (Session 106 incident): userData is not private — strip
      // runtime caches before serializing. The body parent's
      // shrinkwrapBVH cache would otherwise be JSON-flattened into the
      // file and resurrected as a hollow cache entry on reload. Delete
      // it in BOTH paths; getBodySurfaceBVH rebuilds it lazily.
      try {
        const mainMesh = findBodySkinMesh(loadedRootRef.current);
        if (mainMesh) {
          const bodyParent = mainMesh.parent || mainMesh;
          delete bodyParent.userData.shrinkwrapBVH;
        }
      } catch (e) { /* body not found — nothing cached to strip */ }

      // Session 152 — the SAME law bit again, through the layer system: its
      // fullIndex / bodyZones caches live on geometry.userData, the wizard's
      // per-Next export flattened them into Benny's editable GLB (tens of MB
      // of JSON'd index), and on the next load the flattened fullIndex crashed
      // .slice() and hung the loader. Lift the caches off for the export and
      // hand them straight back — the live scene keeps its state, the file
      // carries none of it.
      const liftedLayerCaches = [];
      loadedRootRef.current.traverse((o) => {
        if (!o.isMesh || !o.geometry?.userData) return;
        const ud = o.geometry.userData;
        if ("fullIndex" in ud || "bodyZones" in ud) {
          liftedLayerCaches.push({ ud, fullIndex: ud.fullIndex, bodyZones: ud.bodyZones });
          delete ud.fullIndex;
          delete ud.bodyZones;
        }
      });
      const restoreLayerCaches = () => {
        for (const { ud, fullIndex, bodyZones } of liftedLayerCaches) {
          if (fullIndex !== undefined) ud.fullIndex = fullIndex;
          if (bodyZones !== undefined) ud.bodyZones = bodyZones;
        }
      };

      const exporter = new GLTFExporter();
      // Session 152 — the skin culling is a RENDER state, and this function
      // serializes live geometry. An editable export (wizard Save GLB, the
      // dressed editor snapshot) saved with the culled index would permanently
      // lose every hidden triangle — real data loss, compounding on each save.
      // Suspend for those; the runtime file KEEPS the culling, deliberately:
      // a world loads a body that cannot poke through its clothes.
      const reapplySkinLayers = runtime ? () => {} : suspendSkinLayers(loadedRootRef.current);
      const allAnimations = Object.values(animationsRef.current || {});

      // Session 152 — a clip cannot animate targets the file no longer has.
      //
      // idle and walk carry morph-influence tracks alongside the bone ones.
      // Bake the sculpt away and GLTFWriter.processAnimation reads .length off
      // the influences that are no longer there and throws — which is how this
      // announced itself, as a TypeError from deep inside the exporter with
      // nothing to say about morphs.
      //
      // Dropping those tracks is not a compromise: with the targets folded into
      // the vertices there is nothing left for them to drive. The bone tracks —
      // 773 channels on idle, 775 on walk — are untouched, and they are the
      // whole of what makes her walk.
      const animations = runtime
        ? allAnimations
            .map((clip) => {
              const bones = clip.tracks.filter((t) => !t.name.endsWith(".morphTargetInfluences"));
              if (bones.length === clip.tracks.length) return clip;
              const trimmed = clip.clone();
              trimmed.tracks = bones;
              console.log(`[MiniGlbViewer] runtime bake: "${clip.name}" — dropped ` +
                `${clip.tracks.length - bones.length} morph track(s), kept ${bones.length} bone track(s).`);
              return trimmed;
            })
            .filter((clip) => clip.tracks.length > 0)
        : allAnimations;

      if (!includeAccessories) {
        // Body-only path — exactly the Session 102 behaviour.
        //
        // That first fix detached via accessoryMeshesRef — but that ref
        // lags the real scene graph during a load (see the
        // userData.isAccessoryMesh comment above: the mesh is added to the
        // live scene well before its store entry is written, several
        // primitives per garment, tens of ms each for shrinkwrap alone).
        // An export firing in that window still exported dressed, at
        // ~99MB (confirmed live). Traversing loadedRootRef.current
        // directly for the tag is correct regardless of timing — if it's
        // in the scene right now, it's found right now, no dependency on
        // whether the store has caught up for this particular mesh yet.
        const detached = [];
        loadedRootRef.current.traverse((obj) => {
          if (obj.userData?.isAccessoryMesh && obj.parent) detached.push({ mesh: obj, parent: obj.parent });
        });
        for (const { mesh, parent } of detached) parent.remove(mesh);
        const reattach = () => { for (const { mesh, parent } of detached) parent.add(mesh); };
        exporter.parse(
          loadedRootRef.current,
          (result) => {
            reattach();
            restoreLayerCaches();
            reapplySkinLayers();
            const blob = new Blob([result], { type: "model/gltf-binary" });
            console.log(`[MiniGlbViewer] exportMorphedGlbBlob (body only): produced ${blob.size} bytes, ${animations.length} animation(s) included`);
            resolve(blob);
          },
          (err) => { reattach(); restoreLayerCaches(); reapplySkinLayers(); reject(err); },
          { binary: true, animations }
        );
        return;
      }

      // Dressed path (Session 141) — garments stay attached, and are
      // serialized at IDENTITY transform and full visibility:
      // originalPositions written back for the duration of the export,
      // every part temporarily visible (glTF has no visibility flag and
      // GLTFExporter's default onlyVisible would DROP hidden parts from
      // the file entirely — the consumer re-applies visibility), each
      // mesh tagged identityBaked. Why identity: the consumer
      // (ActorModelPanel's Explore mirror) captures each mesh's
      // positions at load as its own originalPositions baseline and
      // re-applies the CURRENT scale/offset/rotation/tint itself — the
      // same applyAccessoryScale math, from the same true baseline,
      // which is exactly what makes repeated slider drags safe there
      // for the same reason they're safe here. Baking the current
      // transform into the file instead would make the consumer's
      // captured "baseline" already-transformed, and every later edit
      // would compound on top of it. Restored in every exit path from
      // the live accessories prop.
      const store = accessoryMeshesRef.current;
      // Session 148 — EXPORT AT BIND POSE. GLTFExporter writes bones'
      // CURRENT transforms as the file's rest pose; this export fires
      // whenever the bridge fires, mid-idle, so the reimported copy's
      // rest pose was a random animation frame — neck slightly flexed,
      // head slightly turned, hair hanging from a wrongly-posed skull,
      // permanently, varying per rebake. (Morphs were measured
      // IDENTICAL both sides — this is the surviving mechanism for the
      // Explore divergence, hair measured 7.9cm off.) Skeleton.pose()
      // restores bind pose; the running mixer re-poses her next frame,
      // so nothing needs manual restoring.
      {
        const posed = new Set();
        loadedRootRef.current.traverse((o) => {
          if (o.isSkinnedMesh && o.skeleton && !posed.has(o.skeleton)) {
            posed.add(o.skeleton);
            o.skeleton.pose();
          }
        });
        loadedRootRef.current.updateMatrixWorld(true);
        console.log(`[MiniGlbViewer] dressed export: ${posed.size} skeleton(s) restored to BIND POSE for serialization.`);
      }
      const touched = [];
      for (const url of Object.keys(store)) {
        for (const entry of store[url]) {
          if (!entry.mesh?.geometry?.attributes?.position) continue;
          touched.push({ entry, wasVisible: entry.mesh.visible });
          // 3. THE GARMENT TRANSFORMS.
          //
          // The editor writes garments at IDENTITY and tags them identityBaked,
          // because its consumer captures those positions as its own baseline
          // and re-applies scale/offset/rotation itself — bake them in and every
          // later edit compounds on the last one.
          //
          // A runtime file has no later edit. It keeps the positions exactly as
          // they sit on screen, so the thing that loads it needs to know nothing
          // about accessories at all: no wardrobe config, no transforms, no
          // applyAccessoryScale. Just a model.
          if (!runtime) {
            restorePositions(entry.mesh.geometry.attributes.position, entry.originalPositions);
            entry.mesh.userData.identityBaked = true;
          }
          entry.mesh.visible = true;
        }
      }

      const unbake = runtime ? bakeMorphsForExport(loadedRootRef.current) : () => {};
      const unbind = runtime
        ? rebindGarmentsForExport(loadedRootRef.current, findBodySkinMesh(loadedRootRef.current))
        : () => {};
      const restoreLive = () => {
        // Order matters on the way back: rebinding and morphs were applied after
        // the garment positions were staged, so they come off first.
        unbind();
        unbake();
        restoreLayerCaches();
        reapplySkinLayers();
        for (const { entry, wasVisible } of touched) {
          delete entry.mesh.userData.identityBaked;
          entry.mesh.visible = wasVisible;
          if (runtime) continue;   // never moved — nothing to put back
          const cfg = accessories.find((a) => a.url === entry.url);
          const t = effectiveTransform(cfg?.scale, cfg?.offset, cfg?.rotation, cfg?.parts, entry.matName);
          applyAccessoryScale(entry.mesh, entry.originalPositions, entry.center, t.scale, t.offset, t.rotation);
        }
      };
      exporter.parse(
        loadedRootRef.current,
        (result) => {
          restoreLive();
          const blob = new Blob([result], { type: "model/gltf-binary" });
          console.log(`[MiniGlbViewer] exportMorphedGlbBlob (${runtime ? "RUNTIME: sculpt+transforms baked, morphs dropped" : "dressed, identity-baked"}): ` +
            `produced ${(blob.size / 1e6).toFixed(1)}MB, ${touched.length} garment primitive(s), ${animations.length} animation(s) included`);
          resolve(blob);
        },
        (err) => { restoreLive(); reject(err); },
        { binary: true, animations, onlyVisible: false }
      );
    });
  }

  async function handleDownloadGlbClick() {
    try {
      const blob = await exportMorphedGlbBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `morphed_${Date.now()}.glb`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[MiniGlbViewer] handleDownloadGlbClick failed:", err);
    }
  }

  // Real feature — hands the raw export function up to CharacterWizard
  // via a ref (see onExportReady prop), so step navigation can await a
  // freshly-morphed blob: URL and feed it directly into the next
  // step's glbUrl, rather than relying on that step's own MiniGlbViewer
  // instance re-applying extraMorphValues correctly on a fresh mount.
  // Runs every render (cheap — just a ref assignment) rather than
  // inside an effect, so it's never stale by even one render.
  if (onExportReady) onExportReady(exportMorphedGlbBlob);

  // Session 102 — same ref-based handoff pattern as onExportReady:
  // hands the wizard a function that runs the full measured-proportions
  // solve against the live meshes, then refreshes the on-screen
  // Length/Torso/Legs box so the numbers reflect the solved shape
  // immediately (the wizard's subsequent state writes re-apply the
  // identical influences, so there is no flicker or divergence).
  const solveFromReference = (targets) => {
    const entries = morphMeshesRef.current;
    if (!entries.length) return null;
    // Session 102 — deterministic solve: zero EVERY morph influence
    // first, so the result depends only on the photo, never on
    // whatever was manually dialed before. Must happen here on the
    // meshes directly (not via wizard state) — the solve reads
    // influences synchronously, before any React re-render could
    // apply a state reset. The wizard mirrors this by writing
    // zeroed-plus-solved state afterward, keeping mesh and sliders
    // in agreement.
    for (const { mesh } of entries) mesh.morphTargetInfluences?.fill(0);
    const res = solveBodyFromMeasurements(entries, targets);
    const { lowCandidates, highCandidates, hipCandidates } = groundingCandidatesRef.current;
    const m = groundAndMeasure(loadedRootRef.current, lowCandidates, highCandidates, hipCandidates);
    if (m) {
      setHeightM(m.heightM);
      setTorsoLengthM(m.torsoM);
      setLegsLengthM(m.legsM);
    }
    if (res) console.log("[MiniGlbViewer] solveFromReference report:", JSON.stringify(res.report));
    return res;
  };
  if (onSolveReady) onSolveReady(solveFromReference);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%" }} />
      {/* Session 147 — fullscreenLoadingOverlay was passed as {false} by
          ActorModelPanel since its panel era but NEVER implemented here
          (a dead prop): the panel got this portal AND its own busy
          spinner, stacked. Now honored: the panel owns loading UI in
          its context (it hears onLoadingChange); the wizard passes
          nothing and keeps this portal via the default. */}
      {modelLoading && fullscreenLoadingOverlay && ReactDOM.createPortal(
        <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, background: "rgba(255,255,255,0.82)", backdropFilter: "blur(8px)" }}>
          {/* Session 103 — same loading identity as the wizard's
              overlays (light frost, gold ring, quiet label): this was
              the third spinner design, black-screen era, and it's the
              one a draft load actually shows. */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            {loadingPhotoUrl && (
              <img src={loadingPhotoUrl} alt="" style={{ width: 100, height: 100, borderRadius: "50%", objectFit: "cover", display: "block", border: "1.5px solid rgba(0,0,0,0.10)" }} />
            )}
            <div style={{ width: 40, height: 40, border: "3px solid rgba(0,0,0,0.08)", borderTop: "3px solid #c9973a", borderRadius: "50%", animation: "spin 0.9s linear infinite" }} />
            <p style={{ fontFamily: "'DM Sans',system-ui,sans-serif", fontSize: 13, fontWeight: 500, color: "#1a1814", margin: 0 }}>Loading character</p>
          </div>
        </div>,
        document.body
      )}
      {/* Real feature — downloads the currently-loaded character as a
          .glb, with current morph slider values baked in as starting
          weights (not an irreversible bake — every morph target stays
          adjustable in the downloaded file too). Top-left, since
          top-right is already the view combo + reference toggle +
          offset sliders stack. */}
      <button
        onClick={handleDownloadGlbClick}
        style={{
          position: "absolute", top: 14, left: 14,
          fontFamily: "'DM Mono',monospace", fontSize: 13, color: "#c7b48c",
          background: "rgba(0,0,0,0.5)", padding: "8px 12px", borderRadius: 12,
          border: "1px solid rgba(199,180,140,0.2)",
          cursor: "pointer", outline: "none",
        }}
      >
        ↓ Save GLB
      </button>
      {/* View mode switcher — perspective/front/right. Front/right use
          an orthographic camera with rotation disabled (pan + zoom
          only), matching standard CAD/3D-tool convention for a fixed
          front/side projection rather than "perspective from a
          different angle." Styled to match the existing bottom-left
          measurement panel exactly — same dark panel, same accent,
          same font, just relocated to the top-right corner. */}
      {!perspectiveOnly && <select
        value={viewMode}
        onChange={(e) => setViewMode(e.target.value)}
        style={{
          position: "absolute", top: 14, right: 14,
          fontFamily: "'DM Mono',monospace", fontSize: 13, color: "#c7b48c",
          background: "rgba(0,0,0,0.5)", padding: "8px 12px", borderRadius: 12,
          border: "1px solid rgba(199,180,140,0.2)",
          cursor: "pointer", outline: "none",
        }}
      >
        <option value="perspective" style={{ background: "#0d0c0a" }}>Perspective</option>
        <option value="front" style={{ background: "#0d0c0a" }}>Front</option>
        <option value="right" style={{ background: "#0d0c0a" }}>Right</option>
      </select>}
      {/* Reference-image toggle — only shown in front/right (a flat
          reference plane has no single position that makes sense in
          orbiting perspective view), and only when a URL actually
          exists for whichever of the two is currently active. */}
      {viewMode !== "perspective" && (viewMode === "front" ? frontReferenceImageUrl : sideReferenceImageUrl) && (
        <label style={{
          position: "absolute", top: 58, right: 14,
          display: "flex", alignItems: "center", gap: 6,
          fontFamily: "'DM Mono',monospace", fontSize: 12, color: "#c7b48c",
          background: "rgba(0,0,0,0.5)", padding: "8px 12px", borderRadius: 12,
          border: "1px solid rgba(199,180,140,0.2)",
          cursor: "pointer", userSelect: "none",
        }}>
          <input
            type="checkbox"
            checked={showReferenceImage}
            onChange={(e) => setShowReferenceImage(e.target.checked)}
            style={{ accentColor: "#b05c08", cursor: "pointer" }}
          />
          Reference photo
        </label>
      )}
      {/* Real fine-tune offset controls — only meaningful once the
          reference photo is actually showing. Updates whichever of
          referenceOffsets.front/right matches the current view, so
          front and right keep their own independent adjustment. */}
      {viewMode !== "perspective" && showReferenceImage && (viewMode === "front" ? frontReferenceImageUrl : sideReferenceImageUrl) && (
        <div style={{
          position: "absolute", top: 102, right: 14,
          display: "flex", flexDirection: "column", gap: 8,
          fontFamily: "'DM Mono',monospace", fontSize: 11, color: "#c7b48c",
          background: "rgba(0,0,0,0.5)", padding: "10px 12px", borderRadius: 12,
          border: "1px solid rgba(199,180,140,0.2)",
          width: 160,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 20 }}>↔</span>
            <input
              type="range" min={-100} max={100}
              value={referenceOffsets[viewMode].x}
              onChange={(e) => setReferenceOffsets(prev => ({ ...prev, [viewMode]: { ...prev[viewMode], x: Number(e.target.value) } }))}
              style={{ flex: 1, accentColor: "#b05c08", height: 4, cursor: "pointer" }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 20 }}>↕</span>
            <input
              type="range" min={-100} max={100}
              value={referenceOffsets[viewMode].y}
              onChange={(e) => setReferenceOffsets(prev => ({ ...prev, [viewMode]: { ...prev[viewMode], y: Number(e.target.value) } }))}
              style={{ flex: 1, accentColor: "#b05c08", height: 4, cursor: "pointer" }}
            />
          </div>
        </div>
      )}
      {heightM !== null && (
        <div style={{
          position: "absolute", bottom: 14, left: 14,
          fontFamily: "'DM Mono',monospace", fontSize: 13, color: "#c7b48c",
          background: "rgba(0,0,0,0.5)", padding: "10px 14px", borderRadius: 12,
          border: "1px solid rgba(199,180,140,0.2)",
          lineHeight: 1.7,
        }}>
          <div>Length: {(heightM * 100).toFixed(1)} cm</div>
          {torsoLengthM !== null && <div>Torso: {(torsoLengthM * 100).toFixed(1)} cm</div>}
          {legsLengthM !== null && <div>Legs: {(legsLengthM * 100).toFixed(1)} cm</div>}
          <label style={{display:"flex",alignItems:"center",gap:6,marginTop:6,cursor:"pointer",fontSize:11,color:"#c7b48c",userSelect:"none"}}>
            <input type="checkbox" checked={showRings} onChange={(e) => setShowRings(e.target.checked)} style={{accentColor:"#b05c08",cursor:"pointer"}} />
            Measure rings
          </label>
        </div>
      )}
    </div>
  );
}
