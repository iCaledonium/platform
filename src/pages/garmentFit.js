// Session 176 - the garment fit pipeline, as one module.
//
// Everything here used to live inside MiniGlbViewer.jsx. It is pure geometry
// work on attribute arrays - morph transfer, shrinkwrap, seam weld, the manual
// fit, the hair rig transfer, and (below, settleCore) the settle that layers
// tops over bottoms, hair over clothing, anchors the ride and culls the skin -
// and it needs neither React nor the DOM. Moved out so the same code runs in
// two places: on the live scene (main thread, the fallback and the export
// paths) and on the mirror scene inside fitWorker.js, where the wardrobe is
// fitted without blocking the UI. Comments and history travel with the code.
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { applySkinLayers, fitOuterLayers, prepareHairRide, fitTopsOverBottoms } from "./bodyLayers.js";

export const ACCESSORY_SHRINKWRAP = {
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
  // Session 175 - the Angie top is OUT again, and here is the saying-so the
  // Session 162 note asks for. Measured on Lindsey (3D panel, groundOffset 0,
  // garments correctly placed by the transfer): the resolver still declared
  // 142/7363 body and 91/3298 sleeve vertices "inside" and hauled them
  // 124mm/120mm radially - shoulders and sleeve tops in shards, hair fanned
  // out over them (342 sleeve edges over 30mm in the exported runtime, 16 in
  // an older export). That is the second cause the note predicted: loose
  // fabric spanning between the arm and the torso reads as inside whichever
  // limb is nearest, and no displacement-size threshold separates it from a
  // real penetration. The transfer now carries the body's proportions onto
  // the garment, which is what the resolver was standing in for when the
  // path was added; so the top keeps transfer + weld and skips the resolver.
  // Session 175 - the Basic Shirt is a TIGHT tee, the case this list exists
  // for: as a torso item it lost the resolver and the shoulder skin came
  // straight through the sleeve seam (found live on Frida). Its own path,
  // exactly as the Session 148 note prescribes for a tight top.
  pathFragments: ["/underwear/", "/legs/", "/feet/", "/torso/top/top_short_basic_shirt"],
  // Session 157 — the /torso/ retraction above was written as a FOLDER
  // category, and a shirt is not filed under /torso/. "Basic Shirt" lives at
  // /underwear/top/underwear_shirt_basic_shirt, so it matches "/underwear/"
  // and gets the exact resolver that was pulled from tops for tearing their
  // shoulders open — confirmed live on this body: black shirt, shoulders and
  // armpit ripped into shards, the same picture the Angie top produced.
  //
  // Excluded by name rather than by narrowing "/underwear/" to
  // "/underwear/bottom/", because that would also drop bras — and a bra band
  // is one of the two garments the band guard below was built for, so it
  // genuinely wants this pass. Tightness is not derivable from the folder,
  // which is the whole reason this config lists specific garments; this is the
  // same admission in the other direction.
  // Session 162 - exclusion LIFTED, and the reason it existed is now handled
  // upstream. The shirt was excluded because the resolver tore its shoulders
  // open, but that tearing was the resolver being asked to move vertices
  // CENTIMETRES: clothing carries no morph targets, so it lagged the morphed
  // body wholesale. Garments now carry the body's proportion morphs first (see
  // transferBodyMorphToGarment), leaving shrinkwrap the residual millimetres it
  // was actually built for.
  //
  // Excluding it instead left the body protruding straight through the fabric -
  // skin islands across the entire torso, confirmed live on this avatar - which
  // is exactly what the note above predicts: "Culling cannot fix a garment the
  // body protrudes through at its own edge - only fitting can."
  //
  // If the shoulders tear again after this, put the path back and SAY SO in the
  // comment: that would mean the tearing has a second cause independent of
  // displacement size (the pleat-parity misread), and the answer is a tightness
  // gate, not this list.
  excludeFragments: [],
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
  // Session 170 - how many neighbour rings the finisher feathers over. See the
  // "pinned feather" note in shrinkwrapToBody: this is what replaced the raw,
  // unsmoothed hard-snap that corrugated cup edges.
  featherIterations: 4,
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
export function findBodySkinMesh(referenceMesh) {
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
// Session 170 (Magnus: "something is really wrong with the bra fitting") —
// the body's LIVE index is not the body. bodyLayers culls skin under fabric
// by REWRITING geometry.index, so once a garment is worn the skin triangles
// under it are gone from the live index — and both merges below built their
// collision surface from exactly that culled index. Measured live on Frida's
// bra: Genesis9_4 carried 18432 live vs 22008 intact index entries (1192
// triangles missing, 481 orphaned vertices, all in the bust). Against that
// holed surface the 3-ray parity test found 2 of 1927 cup vertices inside
// instead of 399, so the shrinkwrap pushed nothing, the cups sat up to 37mm
// inside the breast, and the culled ring showed through as a sawtooth edge.
// Every rebuild after the first culling pass hit this (body morph refit,
// manual-fit re-wrap, morph transfer); only the very first fit on a fresh
// load ever saw the whole body. The intact index is captured at load
// (fullIndex, Session 162) — build from it, never from the live one.
export function intactBodyIndex(srcGeom) {
  const full = srcGeom.userData && srcGeom.userData.fullIndex;
  const liveCount = srcGeom.index ? srcGeom.index.count : 0;
  if (ArrayBuffer.isView(full) && full.length >= liveCount && full.length % 3 === 0) return full;
  return srcGeom.index ? srcGeom.index.array : null;
}

export function getBodySurfaceBVH(referenceMesh) {
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
    { const ii = intactBodyIndex(p.geometry); totalIndices += ii ? ii.length : p.geometry.attributes.position.count; }
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
    const intact = intactBodyIndex(srcGeom); // Session 170 — never the culled live index
    if (intact) {
      for (let i = 0; i < intact.length; i++) mergedIndex[iOff + i] = intact[i] + vOff;
      iOff += intact.length;
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
  // Session 171 - the primitives too, in merge order: fitOuterLayers maps
  // every merged vertex back to its body zone (head vs chest) through them.
  const cached = { bvh, geom, parts };
  bodyParent.userData.shrinkwrapBVH = cached;
  console.log(`[MiniGlbViewer] Shrinkwrap: body surface BVH built by MERGING ${parts.length} body-skin primitive(s) [${parts.map((p) => `"${p.name}" ${p.geometry.attributes.position.count}v`).join(", ")}] -> ${totalVerts} verts / ${totalIndices / 3} tris total (intact index, not the culled live one), morphs applied, in ${(performance.now() - t0).toFixed(0)}ms.`);
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
export function restorePositions(attr, saved) {
  for (let i = 0; i < attr.count; i++) attr.setXYZ(i, saved[i*3], saved[i*3+1], saved[i*3+2]);
  attr.needsUpdate = true;
}


// ---------------------------------------------------------------------
// Session 162 - garments follow the body's PROPORTION MORPHS.
//
// Root cause of two separate garment failures, same disease. Verified in the
// assets: underwear_shorts_basic_shorts.glb and underwear_shirt_basic_shirt.glb
// both report targets=0 on every primitive. Clothing has NO morph targets, so
// it follows the SKELETON only, while the body's proportion morphs move the
// skin independently of the bones. Dial Height/Legs/Torso and the skin walks
// out from under a garment that stayed where the bones put it.
//
// Shrinkwrap was then the only bridge between the two, and it is a PENETRATION
// resolver sized for millimetres, not a fitter sized for centimetres:
//   - tight garment (shorts): some hip vertices still find surface inside
//     maxSearchMeters and are pulled to it, their neighbours find nothing and
//     stay put, and the primitive rips between them.
//   - loose garment (shirt): the same pass tears shoulders open, which is why
//     it was excluded - and excluding it drops the garment INSIDE the body,
//     because nothing else was holding it out. Confirmed live, both directions.
// No per-garment allowlist can satisfy both: one needs the resolver off, the
// other needs it on. The fix is to stop asking the resolver to do fitting.
//
// Each garment vertex is bound to the closest point on the body's UNMORPHED
// surface and carries that point's morph displacement (barycentric across the
// triangle, so neighbouring vertices move together and the mesh cannot tear).
// Shrinkwrap still runs afterwards on exactly the garments it ran on before,
// but now only resolves the residual millimetres it was built for.
//
// Deliberately a no-op when no morph is active: at neutral body this function
// returns 0 without touching a vertex, so it cannot regress the neutral case.
export const MORPH_TRANSFER_MAX_BIND_METERS = 0.15;

export function getBodyMorphTransfer(referenceMesh) {
  const largest = findBodySkinMesh(referenceMesh);
  const bodyParent = largest.parent || largest;
  // VALIDATE, never truthiness-check - same law as the shrinkwrap cache above
  // (a JSON-flattened userData can resurrect a hollow entry).
  const c = bodyParent.userData.morphTransfer;
  if (c && c.bvh && c.geom?.isBufferGeometry && c.delta) return c;
  if (c) delete bodyParent.userData.morphTransfer;

  const parts = (bodyParent.children || []).filter((x) => x.isSkinnedMesh);
  if (parts.length === 0) parts.push(largest);

  let anyMorph = false;
  for (const part of parts) {
    const infl = part.morphTargetInfluences || [];
    for (let i = 0; i < infl.length; i++) if (infl[i] !== 0) { anyMorph = true; break; }
    if (anyMorph) break;
  }
  if (!anyMorph) return null;

  let totalVerts = 0, totalIndices = 0;
  for (const part of parts) {
    totalVerts += part.geometry.attributes.position.count;
    { const ii = intactBodyIndex(part.geometry); totalIndices += ii ? ii.length : part.geometry.attributes.position.count; }
  }

  const basePos = new Float32Array(totalVerts * 3);
  const delta = new Float32Array(totalVerts * 3);
  const mergedIndex = new Uint32Array(totalIndices);
  let vOff = 0, iOff = 0;
  const t0 = performance.now();
  for (const part of parts) {
    const srcGeom = part.geometry;
    const base = srcGeom.attributes.position;
    for (let i = 0; i < base.count; i++) {
      basePos[(vOff + i) * 3]     = base.getX(i);
      basePos[(vOff + i) * 3 + 1] = base.getY(i);
      basePos[(vOff + i) * 3 + 2] = base.getZ(i);
    }
    const morphAttrs = (srcGeom.morphAttributes && srcGeom.morphAttributes.position) || [];
    const influences = part.morphTargetInfluences || [];
    for (let m = 0; m < morphAttrs.length; m++) {
      const w = influences[m] || 0;
      if (w === 0) continue;
      const d = morphAttrs[m];
      for (let i = 0; i < base.count; i++) {
        delta[(vOff + i) * 3]     += d.getX(i) * w;
        delta[(vOff + i) * 3 + 1] += d.getY(i) * w;
        delta[(vOff + i) * 3 + 2] += d.getZ(i) * w;
      }
    }
    const intact = intactBodyIndex(srcGeom); // Session 170 — never the culled live index
    if (intact) {
      for (let i = 0; i < intact.length; i++) mergedIndex[iOff + i] = intact[i] + vOff;
      iOff += intact.length;
    } else {
      for (let i = 0; i < base.count; i++) mergedIndex[iOff + i] = vOff + i;
      iOff += base.count;
    }
    vOff += base.count;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(basePos, 3));
  geom.setIndex(new THREE.BufferAttribute(mergedIndex, 1));
  const bvh = new MeshBVH(geom);
  const cached = { bvh, geom, delta };
  bodyParent.userData.morphTransfer = cached;
  console.log(`[MiniGlbViewer] Morph transfer: UNMORPHED body surface BVH built from ${parts.length} primitive(s), ${totalVerts} verts, in ${(performance.now() - t0).toFixed(0)}ms.`);
  return cached;
}

// Session 172 (Magnus: "let the hair float upon the garment and mind the
// idle movements"). The Charm hair is rigged to the HEAD bone alone (the
// bone-usage scan below prints exactly that), so under the idle clip every
// nod swings forty centimetres of strands as one rigid plate through a
// blouse that follows the chest and shoulders. Measured live on Lindsey:
// 0 hair vertices beneath the cloth in bind pose, 2328 (70mm) in the
// animated pose, every one of them between chest and shoulder height. Hair
// that rests on the body or on clothing must MOVE with what it rests on, so
// every hair vertex below the head takes the skin weights of its nearest
// body vertex - the same bones the garment beneath it follows - blended in
// over the neck so a strand bends instead of snapping. Positions are not
// touched: at bind pose nothing changes, which is why the layering
// assertion made at bind pose (bodyLayers.fitOuterLayers) now also holds
// while she breathes. Runs after the skinIndex remap (both sides index the
// main skeleton) and before the rebind.
const HAIR_SKIN_HEAD = /head|skull|face|jaw|eye|brow|lip|tongue|ear|nose|cheek|chin|mouth/i;
const HAIR_SKIN_CLOTH_REACH = 0.03;   // hair within 3cm of fabric rests on it and takes ITS rig
const HAIR_SKIN_BODY_REACH = 0.15;    // otherwise the nearest skin within 15cm
const HAIR_SKIN_RAMP = 0.10;          // the head's rig fades into the surface rig over 10cm below the skull base (6cm folded the cards into a clump on the shoulder at the turn's extreme; 10cm leaves ~1% of the hair briefly beneath the yoke instead)
const HAIR_SKIN_SMOOTH = 4;           // rig smoothing passes through the strand topology
// Session 172, second cut: the first transfer copied the SKIN's weights at
// load. Not enough - measured live, 186..1181 hair vertices still beneath
// the blouse depending on the instant of the idle clip - because a loose
// garment is rigged with its own weights, not the chest's, so hair that
// rests on it must follow the FABRIC, not the skin under the fabric. Runs at
// settle time, on the final layered shape, with every garment present.
//
// Third cut: a per-vertex SWITCH between the head's rig and the surface rig
// tore strands - a card whose upper half turned with the head while its
// lower half stayed on the yoke bunched into a visible clump above the
// shoulder. So the surface rig is (a) smoothed through the strand topology
// so neighbouring vertices agree on their bones, and (b) blended in by
// height: the hair's own rig above the skull base, the surface rig from
// HAIR_SKIN_RAMP below it, a straight ramp between - a strand twists over
// ten centimetres instead of folding at a line. Always mixed from the hair's
// ORIGINAL weights, so repeated settles cannot compound.
export function transferSurfaceSkinToHair(hairEntries, store, mainSkinnedMesh) {
  if (!hairEntries.length || !mainSkinnedMesh?.skeleton) return null;
  const skeleton = mainSkinnedMesh.skeleton, bones = skeleton.bones;
  const body = getBodySurfaceBVH(mainSkinnedMesh);
  const bodyOk = body && Array.isArray(body.parts) && body.geom?.index;
  let partOf = null, localOf = null;
  if (bodyOk) {
    const total = body.geom.attributes.position.count;
    partOf = new Uint8Array(total); localOf = new Uint32Array(total);
    let off = 0;
    body.parts.forEach((p, pi) => { const n = p.geometry.attributes.position.count; for (let i = 0; i < n; i++) { partOf[off + i] = pi; localOf[off + i] = i; } off += n; });
  }
  // skull base height in bind space, from the head bone's inverse bind matrix
  let skullY = null;
  {
    const hi = bones.findIndex((b) => /^head/i.test(b.name));
    if (hi >= 0 && skeleton.boneInverses?.[hi]) {
      const m = new THREE.Matrix4().copy(skeleton.boneInverses[hi]).invert();
      skullY = m.elements[13];
    }
  }
  if (skullY === null) return null;
  const tri = []; const srcMesh = []; const srcVert = [];
  for (const [url, entries] of Object.entries(store || {})) {
    if (!(url.includes("/torso/") || url.includes("/legs/") || url.includes("/underwear/"))) continue;   // Session 174 - visible underwear is fabric too
    for (const e of entries || []) {
      const m = e.mesh; if (!m || m.visible === false) continue;
      const g = m.geometry, pos = g.attributes.position;
      if (!pos || !g.attributes.skinIndex || !g.attributes.skinWeight) continue;
      const push = (vi) => { tri.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi)); srcMesh.push(m); srcVert.push(vi); };
      if (g.index) for (let i = 0; i < g.index.count; i++) push(g.index.getX(i));
      else for (let i = 0; i < pos.count; i++) push(i);
    }
  }
  let cbvh = null, cgeom = null, cbox = null;
  if (tri.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3)); cgeom = g; cbvh = new MeshBVH(g); g.computeBoundingBox(); cbox = g.boundingBox.clone().expandByScalar(HAIR_SKIN_CLOTH_REACH + 0.005); }
  if (!cbvh && !bodyOk) return null;
  // Session 175 - a vertex farther from every non-head skin vertex than the
  // reach can only find head faces, which this rig discards anyway; the crown
  // and bangs of a 72k-vertex hairdo skip both queries on a box test.
  // Session 176 - declared before the box below uses them (the worker made the
  // TDZ throw visible: the box test read cand before this line and the rig
  // transfer silently kept the hair's own rig on every settle since Session 175).
  const p = new THREE.Vector3(), cand = new THREE.Vector3();
  let nbox = null;
  if (bodyOk) {
    nbox = new THREE.Box3();
    const bp = body.geom.attributes.position; let off = 0;
    for (const part of body.parts) { const z = part.geometry.userData.bodyZones; const n = part.geometry.attributes.position.count; for (let i = 0; i < n; i++) { if (!Array.isArray(z) || z[i] !== "head") nbox.expandByPoint(cand.fromBufferAttribute(bp, off + i)); } off += n; }
    nbox.expandByScalar(HAIR_SKIN_BODY_REACH + 0.005);
  }
  const tRig0 = performance.now();

  const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const readSkin = (SI, SW, li) => { const m = new Map(); const idx = [SI.getX(li), SI.getY(li), SI.getZ(li), SI.getW(li)], w = [SW.getX(li), SW.getY(li), SW.getZ(li), SW.getW(li)]; for (let k = 0; k < 4; k++) if (w[k] > 0) m.set(idx[k], (m.get(idx[k]) || 0) + w[k]); return m; };
  const summary = { cloth: 0, body: 0, kept: 0, ramp: 0 };
  for (const e of hairEntries) {
    const g = e.mesh.geometry, pos = g.attributes.position, hSI = g.attributes.skinIndex, hSW = g.attributes.skinWeight;
    if (!pos || !hSI || !hSW) continue;
    const N = pos.count;
    if (!e.skinOriginal) {
      const si = new Float32Array(N * 4), sw = new Float32Array(N * 4);
      for (let i = 0; i < N; i++) { si[i * 4] = hSI.getX(i); si[i * 4 + 1] = hSI.getY(i); si[i * 4 + 2] = hSI.getZ(i); si[i * 4 + 3] = hSI.getW(i); sw[i * 4] = hSW.getX(i); sw[i * 4 + 1] = hSW.getY(i); sw[i * 4 + 2] = hSW.getZ(i); sw[i * 4 + 3] = hSW.getW(i); }
      e.skinOriginal = { si, sw };
    }
    const { si: oSI, sw: oSW } = e.skinOriginal;

    // 1. surface rig + height blend per vertex
    let rig = new Array(N).fill(null);
    let f = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      p.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      let m = null;
      if (cbvh && cbox.containsPoint(p) && cbvh.closestPointToPoint(p, hit, 0, HAIR_SKIN_CLOTH_REACH)) {
        // Session 173 - corners through the BVH's REORDERED index (it rewrites
        // the index of the geometry it is built on); fc+k addressed the wrong
        // triangle before.
        const fc = hit.faceIndex * 3; let best = -1, bestD = Infinity;
        for (let k = 0; k < 3; k++) { const ci = cgeom.index.getX(fc + k); cand.fromArray(tri, ci * 3); const d = cand.distanceToSquared(p); if (d < bestD) { bestD = d; best = ci; } }
        const sm = srcMesh[best]; m = readSkin(sm.geometry.attributes.skinIndex, sm.geometry.attributes.skinWeight, srcVert[best]);
        summary.cloth++;
      } else if (bodyOk && nbox.containsPoint(p) && body.bvh.closestPointToPoint(p, hit, 0, HAIR_SKIN_BODY_REACH)) {
        const fc = hit.faceIndex * 3; let best = -1, bestD = Infinity;
        for (let k = 0; k < 3; k++) { const vi = body.geom.index.getX(fc + k); cand.fromBufferAttribute(body.geom.attributes.position, vi); const d = cand.distanceToSquared(p); if (d < bestD) { bestD = d; best = vi; } }
        const part = body.parts[partOf[best]], li = localOf[best];
        const pSI = part.geometry.attributes.skinIndex, pSW = part.geometry.attributes.skinWeight;
        if (pSI && pSW) {
          m = readSkin(pSI, pSW, li);
          let dom = null, dw = -1; for (const [b, w] of m) if (w > dw) { dw = w; dom = b; }
          if (HAIR_SKIN_HEAD.test(bones[dom]?.name || "")) m = null; else summary.body++;
        }
      }
      rig[i] = m;
      f[i] = m ? Math.min(1, Math.max(0, (skullY - p.y) / HAIR_SKIN_RAMP)) : 0;
    }

    // 2. smooth rig and blend through the strand topology
    if (g.index) {
      const adj = Array.from({ length: N }, () => new Set());
      for (let t = 0; t < g.index.count; t += 3) {
        const a = g.index.getX(t), b = g.index.getX(t + 1), c = g.index.getX(t + 2);
        adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
      }
      for (let it = 0; it < HAIR_SKIN_SMOOTH; it++) {
        const nextRig = new Array(N).fill(null), nextF = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          const ns = adj[i];
          let sf = f[i], cnt = 1; const acc = new Map();
          if (rig[i]) for (const [b, w] of rig[i]) acc.set(b, w);
          let rigCnt = rig[i] ? 1 : 0;
          for (const j of ns) {
            sf += f[j]; cnt++;
            if (rig[j]) { rigCnt++; for (const [b, w] of rig[j]) acc.set(b, (acc.get(b) || 0) + w); }
          }
          nextF[i] = sf / cnt;
          if (rigCnt) { for (const [b, w] of acc) acc.set(b, w / rigCnt); nextRig[i] = acc; }
        }
        rig = nextRig; f = nextF;
      }
    }

    // 3. mix from the original weights, top four bones, normalised
    for (let i = 0; i < N; i++) {
      const fb = rig[i] ? f[i] : 0;
      if (fb <= 0) {
        hSI.setXYZW(i, oSI[i * 4], oSI[i * 4 + 1], oSI[i * 4 + 2], oSI[i * 4 + 3]);
        hSW.setXYZW(i, oSW[i * 4], oSW[i * 4 + 1], oSW[i * 4 + 2], oSW[i * 4 + 3]);
        summary.kept++;
        continue;
      }
      const mix = new Map();
      for (let k = 0; k < 4; k++) { const w = oSW[i * 4 + k] * (1 - fb); if (w > 0) mix.set(oSI[i * 4 + k], (mix.get(oSI[i * 4 + k]) || 0) + w); }
      for (const [b, w] of rig[i]) { const ww = w * fb; if (ww > 0) mix.set(b, (mix.get(b) || 0) + ww); }
      const top = [...mix.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      let sum = 0; for (const [, w] of top) sum += w;
      if (!(sum > 0)) { summary.kept++; continue; }
      while (top.length < 4) top.push([0, 0]);
      hSI.setXYZW(i, top[0][0], top[1][0], top[2][0], top[3][0]);
      hSW.setXYZW(i, top[0][1] / sum, top[1][1] / sum, top[2][1] / sum, top[3][1] / sum);
      if (fb < 1) summary.ramp++;
    }
    hSI.needsUpdate = true; hSW.needsUpdate = true;
  }
  summary.ms = Math.round(performance.now() - tRig0);
  return summary;
}

const _mtP = new THREE.Vector3();
const _mtTarget = { point: new THREE.Vector3() };
const _mtA = new THREE.Vector3(), _mtB = new THREE.Vector3(), _mtC = new THREE.Vector3();
const _mtV0 = new THREE.Vector3(), _mtV1 = new THREE.Vector3(), _mtV2 = new THREE.Vector3();

// Applies the body's morph displacement to one accessory primitive, in place.
// Returns how many vertices moved (0 = neutral body, or nothing in reach).
export function transferBodyMorphToGarment(accessoryMesh, mainSkinnedMesh, accessoryUrl) {
  const t = getBodyMorphTransfer(mainSkinnedMesh);
  if (!t) return 0;
  const { bvh, geom, delta } = t;
  const bodyIndex = geom.index;
  const bodyPos = geom.attributes.position;
  const attr = accessoryMesh.geometry.attributes.position;
  let moved = 0;
  for (let i = 0; i < attr.count; i++) {
    _mtP.set(attr.getX(i), attr.getY(i), attr.getZ(i));
    const hit = bvh.closestPointToPoint(_mtP, _mtTarget, 0, MORPH_TRANSFER_MAX_BIND_METERS);
    if (!hit) continue;
    const f = _mtTarget.faceIndex * 3;
    const ia = bodyIndex.getX(f), ib = bodyIndex.getX(f + 1), ic = bodyIndex.getX(f + 2);
    _mtA.fromBufferAttribute(bodyPos, ia);
    _mtB.fromBufferAttribute(bodyPos, ib);
    _mtC.fromBufferAttribute(bodyPos, ic);
    // Barycentric weights of the bound point (Ericson). Interpolating across
    // the triangle is what keeps adjacent garment vertices moving together.
    _mtV0.subVectors(_mtB, _mtA);
    _mtV1.subVectors(_mtC, _mtA);
    _mtV2.subVectors(_mtTarget.point, _mtA);
    const d00 = _mtV0.dot(_mtV0), d01 = _mtV0.dot(_mtV1), d11 = _mtV1.dot(_mtV1);
    const d20 = _mtV2.dot(_mtV0), d21 = _mtV2.dot(_mtV1);
    const denom = d00 * d11 - d01 * d01;
    let wa = 1, wb = 0, wc = 0;
    if (denom !== 0) {
      wb = (d11 * d20 - d01 * d21) / denom;
      wc = (d00 * d21 - d01 * d20) / denom;
      wa = 1 - wb - wc;
    }
    const dx = delta[ia * 3] * wa + delta[ib * 3] * wb + delta[ic * 3] * wc;
    const dy = delta[ia * 3 + 1] * wa + delta[ib * 3 + 1] * wb + delta[ic * 3 + 1] * wc;
    const dz = delta[ia * 3 + 2] * wa + delta[ib * 3 + 2] * wb + delta[ic * 3 + 2] * wc;
    attr.setXYZ(i, _mtP.x + dx, _mtP.y + dy, _mtP.z + dz);
    moved++;
  }
  attr.needsUpdate = true;
  return moved;
}

// ---------------------------------------------------------------------
// Session 162 - seam weld. Garment seams in this catalogue ship UNWELDED:
// measured on underwear_shirt_basic_shirt, 912 of its 1162 boundary vertices
// sit within 2mm of a twin (489 within 0.2mm), and its 8 boundary loops include
// two that run the full height of the torso and across BOTH shoulders - panel
// edges that were never merged. In bind pose the twins are coincident and the
// seam is invisible. The moment anything moves vertices per-vertex - skinning,
// shrinkwrap, the morph transfer above - the two halves are free to move
// INDEPENDENTLY, the hairline opens, and skin shows through a gap that has no
// cloth in it. That is why it traces seams exactly, why it survived every mask
// change, and why forcing the mask to hide it only ate real skin at the hems.
//
// The real fix is a weld on the asset (merge-by-distance, re-export). This is
// the defence for assets we do not control: group vertices that were coincident
// in the garment's OWN pre-fit geometry, and after fitting, snap each group back
// to its average. Grouping uses the pre-fit positions deliberately - by the time
// shrinkwrap has run the twins have already drifted apart, so grouping on
// current positions would be grouping the symptom.
//
// Cache is a WeakMap, NOT geometry.userData: GLTFExporter serialises userData
// into the GLB, and a per-vertex index map would ride into every export.
const _seamGroupsCache = new WeakMap();
const SEAM_WELD_CELL = 20000; // 0.05mm buckets

function seamGroups(geometry, basePositions) {
  let groups = _seamGroupsCache.get(geometry);
  if (groups) return groups;
  const n = Math.floor(basePositions.length / 3);
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const k = Math.round(basePositions[i * 3] * SEAM_WELD_CELL) + "_" +
              Math.round(basePositions[i * 3 + 1] * SEAM_WELD_CELL) + "_" +
              Math.round(basePositions[i * 3 + 2] * SEAM_WELD_CELL);
    let a = buckets.get(k);
    if (!a) { a = []; buckets.set(k, a); }
    a.push(i);
  }
  groups = [];
  for (const a of buckets.values()) if (a.length > 1) groups.push(a);
  _seamGroupsCache.set(geometry, groups);
  return groups;
}

// Snaps each coincident group back together, in place. Returns groups welded.
export function weldGarmentSeams(accessoryMesh, basePositions, accessoryUrl) {
  if (!basePositions) return 0;
  const groups = seamGroups(accessoryMesh.geometry, basePositions);
  if (!groups.length) return 0;
  const attr = accessoryMesh.geometry.attributes.position;
  for (const grp of groups) {
    let x = 0, y = 0, z = 0;
    for (const i of grp) { x += attr.getX(i); y += attr.getY(i); z += attr.getZ(i); }
    const inv = 1 / grp.length;
    x *= inv; y *= inv; z *= inv;
    for (const i of grp) attr.setXYZ(i, x, y, z);
  }
  attr.needsUpdate = true;
  return groups.length;
}

export function shrinkwrapToBody(accessoryMesh, mainSkinnedMesh, accessoryUrl, opts = {}) {
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
    if (guardActive && !opts.quiet) console.log(`[MiniGlbViewer] wrong-side guard ACTIVE for band primitive "${accessoryMesh.name}" (span ${(spanY*100).toFixed(1)}cm, center ${(centerY*100).toFixed(1)}cm)`);
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

  // Hard assertion: whatever smoothing left behind is snapped exactly, so the
  // guarantee holds - but Session 170: as a PINNED FEATHER, not a raw snap.
  //
  // The smoothing above under-pushes the BOUNDARY of a penetrating region: a
  // violator next to non-violating neighbours has its displacement averaged
  // with their zeros, so after maxPasses the leftovers sit exactly along the
  // region's edge. Snapping those raw put each of them at surface+clearance
  // next to neighbours that stayed wherever smoothing left them, and the
  // fabric between them corrugated into a sawtooth that the skin showed
  // through - measured live on Frida Svensson's bra: 630/1927 cup vertices
  // 29.5mm inside her bust, 163 left for the snap, and a serrated skin fringe
  // along both cup edges and the straps exactly where those 163 were.
  //
  // Same guarantee, smooth result: the leftovers are PINNED to their exact
  // push, and their free neighbours relax to the mean of their neighbours'
  // field for a few rings (Jacobi with the pinned set as the boundary), so the
  // transition into the resolved region is continuous instead of a step. The
  // free vertices only ever receive averages of outward pushes, and a final
  // verification pass reports (and raw-snaps) anything that still violates,
  // so nothing this adds can end inside the body.
  let enforced = 0;
  let feathered = 0;
  if (residual > 0) {
    const { violations } = computeField(disp);
    const pinned = new Uint8Array(posAttr.count);
    for (let i = 0; i < posAttr.count; i++) {
      if (disp[i * 3] !== 0 || disp[i * 3 + 1] !== 0 || disp[i * 3 + 2] !== 0) { pinned[i] = 1; enforced++; }
    }
    let field = disp;
    const iterations = ACCESSORY_SHRINKWRAP.featherIterations ?? 4;
    for (let it = 0; it < iterations; it++) {
      const next = new Float32Array(field.length);
      for (let i = 0; i < posAttr.count; i++) {
        if (pinned[i]) {
          next[i * 3] = field[i * 3]; next[i * 3 + 1] = field[i * 3 + 1]; next[i * 3 + 2] = field[i * 3 + 2];
          continue;
        }
        const nb = neighbors[i];
        if (nb.size === 0) continue;
        let ax = 0, ay = 0, az = 0;
        for (const j of nb) { ax += field[j * 3]; ay += field[j * 3 + 1]; az += field[j * 3 + 2]; }
        const inv = 1 / nb.size;
        next[i * 3] = ax * inv; next[i * 3 + 1] = ay * inv; next[i * 3 + 2] = az * inv;
      }
      field = next;
    }
    for (let i = 0; i < posAttr.count; i++) {
      const dx = field[i * 3], dy = field[i * 3 + 1], dz = field[i * 3 + 2];
      if (dx === 0 && dy === 0 && dz === 0) continue;
      if (!pinned[i]) feathered++;
      posAttr.setXYZ(i, posAttr.getX(i) + dx, posAttr.getY(i) + dy, posAttr.getZ(i) + dz);
    }
    // Verify. Anything the feather could not settle is snapped raw, as before,
    // so the guarantee is unchanged - this should be zero or near it.
    const check = computeField(disp);
    let rawSnapped = 0;
    for (let i = 0; i < posAttr.count; i++) {
      const dx = disp[i * 3], dy = disp[i * 3 + 1], dz = disp[i * 3 + 2];
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        posAttr.setXYZ(i, posAttr.getX(i) + dx, posAttr.getY(i) + dy, posAttr.getZ(i) + dz);
        rawSnapped++;
      }
    }
    if (rawSnapped && !opts.quiet) console.log(`[MiniGlbViewer] Shrinkwrap feather: ${rawSnapped} vertex(es) still violated after feathering "${accessoryMesh.name}" and were snapped raw.`);
    residual = check.violations;
  }
  posAttr.needsUpdate = true;

  const status = (residual === 0 && enforced === 0 ? "ASSERT PASS (converged)" : (enforced > 0 ? `ASSERT ENFORCED (${enforced} vertices pinned to clearance, ${feathered} neighbours feathered, after ${passes} smoothed passes)` : "ASSERT PASS"))
    + (buried > 0 ? ` — ${buried} vertex(es) left buried in flesh (push exceeded ${(ACCESSORY_SHRINKWRAP.maxResolveMeters * 100).toFixed(1)}cm cap)` : "");
  if (!opts.quiet) console.log(`[MiniGlbViewer] Shrinkwrap v6: "${accessoryMesh.name}" (${accessoryUrl}) — initial violations ${firstViolations}/${posAttr.count} (max push ${(firstMaxPush * 1000).toFixed(1)}mm), ${passes} resolve+smooth pass(es), ${status}, clearance ${(clearance * 1000).toFixed(1)}mm, ${(performance.now() - t0).toFixed(0)}ms.`);
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

// The manual fit is applied AFTER the shrinkwrap, from the wrapped baseline —
// and until now nothing wrapped it again. Scale a bra to 0.88x and the wrapped
// cups shrink straight into the breast; offset it 1.5cm sideways and one cup
// slides onto the fuller flesh. Found live on Lindsey: "skin tight" meant skin
// islands across both cups and the band, and the only slider answer was to
// scale UP past the leak, which is the opposite of what tight means.
//
// So the transform is followed by a second wrap on the transformed shape, then
// the seam weld the wrap can split. Idempotent, because applyAccessoryScale
// always starts from originalPositions. Quiet, because it runs on every slider
// tick, one primitive at a time. The wrap only ever pushes OUT to surface +
// clearance, so a garment scaled down now lands exactly on the skin instead of
// inside it, and one scaled up is untouched.
export function applyManualFit(entry, t, bodyMesh) {
  entry.ride = null;   // Session 173 - a moved garment or hair invalidates the ride anchors until the next settle rebuilds them
  applyAccessoryScale(entry.mesh, entry.originalPositions, entry.center, t.scale, t.offset, t.rotation);
  if (!bodyMesh || !entry.shrinkwrapEligible) return;
  shrinkwrapToBody(entry.mesh, bodyMesh, entry.url, { quiet: true });
  weldGarmentSeams(entry.mesh, entry.prefitPositions, entry.url);
}


// ── Session 176 - shared entry points for the main thread and the fit worker ──

const IDENTITY_T = { scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };

// The load-time fit of one primitive from its prefit shape (registration and
// inflation baked in, body-shape independent): the body's proportion morphs,
// the shrinkwrap on eligible paths, the seam weld, then the manual-fit
// baseline is captured and the current manual transform applied on top. The
// body refit runs exactly this sequence again against the new body.
export function fitEntryFromPrefit(entry, t, bodyMesh, opts = {}) {
  const geo = entry.mesh.geometry;
  const attr = geo.attributes.position;
  restorePositions(attr, entry.prefitPositions);
  if (bodyMesh) {
    transferBodyMorphToGarment(entry.mesh, bodyMesh, entry.url);
    if (entry.shrinkwrapEligible) shrinkwrapToBody(entry.mesh, bodyMesh, entry.url, { quiet: !!opts.quiet });
  }
  const welded = weldGarmentSeams(entry.mesh, entry.prefitPositions, entry.url);
  if (welded && !opts.quiet) console.log(`[MiniGlbViewer] Seam weld: ${welded} coincident vertex group(s) snapped back together on "${entry.mesh.name}" (${entry.url}).`);
  entry.originalPositions = capturePositions(attr);
  geo.computeBoundingBox();
  if (!entry.center) entry.center = new THREE.Vector3();
  geo.boundingBox.getCenter(entry.center);
  applyManualFit(entry, t || IDENTITY_T, bodyMesh);
  return welded;
}

// The hair entries' manual transforms, from the wardrobe config, as a list the
// worker can be handed: [{ url, matName, transform }].
export function hairTransformsFor(store, accessories) {
  const out = [];
  for (const [url, entries] of Object.entries(store || {})) {
    if (!url.includes("/head/hair/")) continue;
    const acc = (accessories || []).find((a) => a.url === url);
    for (const e of entries || []) out.push({ url, matName: e.matName, transform: effectiveTransform(acc?.scale, acc?.offset, acc?.rotation, acc?.parts, e.matName) });
  }
  return out;
}

// Session 152 — everything that must be true once the wardrobe settles, in
// layer order: hair back to its raw shape, its manual transform, tops over
// bottoms, hair lifted over the clothing beneath it and out of the skin, the
// hair's rig following the surface it rests on, the ride anchors, and only
// then the skin mask. One function, because the call sites (settled load,
// finished load, body refit, slider rest) were each going to repeat the
// sequence and drift. Session 171: the manual transform FIRST, from the raw
// shape - it used to come after the lift, with the layered shape as its
// baseline, so a hair offset of -8cm dragged freshly layered strands back
// into the blouse. Session 176: synchronous and thread-agnostic; the deferral
// of the rig transfer that the slider path used is gone because the whole
// settle now runs off the main thread (see MiniGlbViewer.settleLayers).
export function settleCore(loadedRoot, store, hairTransforms) {
  if (!loadedRoot) return null;
  const tmap = new Map();
  for (const h of hairTransforms || []) tmap.set(`${h.url}|${h.matName}`, h.transform);
  const hairEntries = [];
  for (const [url, entries] of Object.entries(store || {})) {
    if (!url.includes("/head/hair/")) continue;
    for (const e of entries) if (e.mesh && e.prefitPositions) hairEntries.push({ url, e });
  }
  // 1. back to the raw load shape - settles are idempotent
  for (const { e } of hairEntries) {
    restorePositions(e.mesh.geometry.attributes.position, e.prefitPositions);
  }
  // 2. the manual transform, from the raw shape
  for (const { url, e } of hairEntries) {
    e.originalPositions = capturePositions(e.mesh.geometry.attributes.position);
    e.mesh.geometry.computeBoundingBox();
    if (!e.center) e.center = new THREE.Vector3();
    e.mesh.geometry.boundingBox.getCenter(e.center);
    const t = tmap.get(`${url}|${e.matName}`) || IDENTITY_T;
    applyAccessoryScale(e.mesh, e.originalPositions, e.center, t.scale, t.offset, t.rotation);
  }
  // 3. the layers, on the intact body surface
  let bodySurface = null;
  try { const m = findBodySkinMesh(loadedRoot); if (m) bodySurface = getBodySurfaceBVH(m); }
  catch (e) { console.warn("[MiniGlbViewer] settleLayers: no body surface for the hair skin rule:", e); }
  try { fitTopsOverBottoms(store, bodySurface); }
  catch (e) { console.warn("[MiniGlbViewer] tops-over-bottoms layering failed:", e); }
  fitOuterLayers(loadedRoot, store, bodySurface);
  // 4. the hair's rig follows the surface it rests on; 4b. the ride anchors
  let rig = null, ride = null;
  try {
    rig = transferSurfaceSkinToHair(hairEntries.map((h) => h.e), store, findBodySkinMesh(loadedRoot));
    if (rig) console.log(`[MiniGlbViewer] Hair rig follows its resting surface: ${rig.cloth} vertex(es) near fabric, ${rig.body} near skin, ${rig.ramp} on the head-to-surface ramp, ${rig.kept} kept the hair's own rig (${rig.ms}ms).`);
  } catch (e) { console.warn("[MiniGlbViewer] Hair rig transfer failed, hair keeps its own rig:", e); }
  try {
    ride = prepareHairRide(store, bodySurface);
    if (ride) console.log(`[MiniGlbViewer] Hair ride: ${ride.anchored} of ${ride.total} hair vertex(es) anchored to fabric, ${ride.skin} to skin; ${ride.clothVertices} fabric + ${ride.skinVertices} skin vertex(es) posed per frame; corrected per frame from here on (${ride.ms}ms).`);
  } catch (e) { console.warn("[MiniGlbViewer] Hair ride anchors failed, hair keeps its settled shape only:", e); }
  // 5. the skin mask, last, against the garments as they finally sit
  applySkinLayers(loadedRoot, store);
  return { hairEntries: hairEntries.map((h) => h.e), rig, ride };
}
