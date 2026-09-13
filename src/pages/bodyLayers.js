import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

// ── Session 152 — the body joins the layer system ────────────────────────────
//
// The wardrobe already has z-layers: OCCLUDES removes the panties when jeans
// are worn and the bra when a top is — an outer layer suppresses the inner one
// it covers. The chain stopped one layer short: nothing ever suppressed the
// SKIN, and every source of animation drift — mis-bound twist bones, the idle
// clip's own morph tracks, skinning disagreement — rendered as flesh through
// denim. This module is the game-engine answer: the skin a garment covers is
// NOT DRAWN. A culled triangle cannot poke through anything, at any pose.
//
// v2 lesson, learned from a screenshot of floating feet: declaring whole zones
// covered is too blunt for garment LENGTH. The jeans are cuffed above the
// ankle, but "calf" as a zone swept the exposed ankle skin away with the shin,
// and her feet hovered disconnected below the cuffs. Studios generate their
// hide masks from the mesh for exactly this reason.
//
// So coverage is now decided in two steps:
//   1. ZONES (from each vertex's dominant skinning bone) act as the CANDIDATE
//      gate — cheap, skeleton-derived, and a hard safety rail: skin outside a
//      garment's declared zones is never even tested, so a stray raycast can
//      never cull a cheek because a collar passed nearby.
//   2. GEOMETRY confirms each candidate: from the (morphed) bind-pose vertex,
//      a ray along the vertex normal either finds that garment's fabric within
//      NEAR_FABRIC metres — genuinely covered, cull — or it doesn't, and the
//      skin stays. Capri jeans keep their ankles, 3/4 sleeves keep their
//      forearms, and a future floor-length coat needs no new tuning.
//   3. A triangle is culled only when ALL THREE vertices are confirmed, so a
//      ring of real skin always survives at every hem, cuff and neckline.
//
// The test runs in bind space — the same space the shrinkwrap guarantees the
// fit in — with the body's CURRENT morph influences folded in on the CPU, so
// a sculpted body is masked against the garment as worn, not against the base
// mesh. Culling is INDEX-ONLY (positions, skinning, morphs untouched), kept
// restorable: editable exports suspend it — saving her working body with holes
// would be permanent data loss — while the runtime bake keeps it, so worlds
// load a body that cannot poke through its clothes.
//
// Underwear still culls nothing on purpose: skin-tight, shrinkwrapped, and its
// hems sit mid-zone where even a confirmed mask would read as odd bald patches
// through any later transparency. Same call studios make.

const ZONE_PATTERNS = [
  [/thigh/, "thigh"],
  [/shin|calf|knee/, "calf"],
  [/foot|toe|heel|tarsal/, "foot"],
  [/pelvis|hip|glute|buttock/, "pelvis"],
  [/spine[34]|chest|pector|breast|sternum|rib/, "chest"],
  [/spine|abdomen|waist|navel/, "abdomen"],
  [/forearm|elbow/, "forearm"],
  [/shldrtwist|upperarm|bicep|armtwist/, "upperarm"],
  [/collar|shldr|shoulder|scap|trap|delt/, "shoulder"],
  [/hand|finger|thumb|carpal|wrist|pinky/, "hand"],
  [/neck/, "neck"],
  [/head|skull|face|jaw|eye|brow|lip|tongue|ear|nose|cheek|chin|mouth/, "head"],
];

// Candidate zones per catalog family — the gate, not the verdict. Generous on
// purpose (the top lists forearm although its sleeves end early; the raycast
// keeps the bare part) while still hard-excluding what a garment must never
// touch: no entry lists head, hand or foot.
const COVERAGE = [
  { match: "/legs/pants/", zones: ["pelvis", "thigh", "calf"] },
  { match: "/torso/top/", zones: ["chest", "abdomen", "shoulder", "upperarm", "forearm"] },
  // Session 160 — an underwear TOP is a top. The catalogue files shirts under
  // /underwear/top/, which matched nothing here, so a shirt declared no
  // coverage at all and this pass short-circuited to "no covering garments —
  // full skin restored". Session 157 had just excluded that same shirt from
  // shrinkwrap for tearing its shoulders, so the garment ended up with neither
  // fitting nor culling and the body rendered straight through the fabric.
  //
  // Same zones as /torso/top/ because it is the same silhouette, and generous
  // by the rule stated above: this is the gate, not the verdict — the raycast
  // decides per vertex, so a bra listing shoulder and forearm keeps the bare
  // skin the rays find. That per-vertex test plus BURIED_FABRIC is exactly the
  // combination this module documents for a top that is never shrinkwrapped.
  { match: "/underwear/top/", zones: ["chest", "abdomen", "shoulder", "upperarm", "forearm"] },
  { match: "/legs/shoes/", zones: ["foot", "calf"] },
];

// How far outside the skin fabric may sit and still count as covering it.
// Comfortably past the shrinkwrap clearance (2.5mm) and loose-fit drape, well
// short of the other leg (~12cm+ across at the ankles).
const NEAR_FABRIC = 0.08;

// And how far BENEATH the skin fabric may sit and still count. An outward ray
// alone has a blind spot found live on her chest: skin that has already broken
// through the cloth has the fabric BEHIND it, sees nothing above, and the mask
// calls it exposed — precisely the vertices that most need hiding (the top is
// deliberately never shrinkwrapped, so a sculpted bust protrudes straight
// through it). Fabric within this distance below the surface means the skin is
// poking through a garment. Kept short so the ray cannot cross a limb and
// mistake the far side of a sleeve or trouser leg for buried fabric — the
// slimmest candidate cross-section (a forearm) is ~6cm through.
const BURIED_FABRIC = 0.05;

function zoneOfBone(name) {
  const n = (name || "").toLowerCase();
  for (const [re, zone] of ZONE_PATTERNS) if (re.test(n)) return zone;
  return "other";
}

function ensureZones(mesh) {
  const geo = mesh.geometry;
  // Session 106's law, learned again the hard way: userData is not private.
  // GLTFExporter serializes it, so a body exported by the wizard WHILE these
  // caches were set carries them back on the next load — the zones as a real
  // array (JSON keeps arrays), the typed index as a plain object. Trust
  // nothing that did not come from this run: validate, else recompute.
  const cached = geo.userData.bodyZones;
  if (Array.isArray(cached) && typeof cached[0] === "string") return cached;
  delete geo.userData.bodyZones;
  const idxA = geo.attributes.skinIndex;
  const wA = geo.attributes.skinWeight;
  const bones = mesh.skeleton?.bones;
  if (!idxA || !wA || !bones) return null;
  const boneZone = bones.map((b) => zoneOfBone(b.name));
  const zones = new Array(idxA.count);
  for (let i = 0; i < idxA.count; i++) {
    let best = 0, bw = wA.getX(i);
    if (wA.getY(i) > bw) { bw = wA.getY(i); best = 1; }
    if (wA.getZ(i) > bw) { bw = wA.getZ(i); best = 2; }
    if (wA.getW(i) > bw) { bw = wA.getW(i); best = 3; }
    const bone = [idxA.getX(i), idxA.getY(i), idxA.getZ(i), idxA.getW(i)][best];
    zones[i] = boneZone[bone] || "other";
  }
  geo.userData.bodyZones = zones;
  return zones;
}

function bodyMeshes(root) {
  const out = [];
  root.traverse((o) => {
    if (o.isSkinnedMesh && !o.userData?.isAccessoryMesh && o.geometry?.index) out.push(o);
  });
  return out;
}

// The vertex as the shrinkwrap saw it: bind-pose base position plus the body's
// current morph influences, evaluated on the CPU (glTF morphs are relative).
function morphedPosition(mesh, i, out) {
  const geo = mesh.geometry;
  out.fromBufferAttribute(geo.attributes.position, i);
  const infl = mesh.morphTargetInfluences;
  const targets = geo.morphAttributes?.position;
  if (infl && targets) {
    for (let t = 0; t < infl.length; t++) {
      const w = infl[t];
      if (Math.abs(w) < 1e-6 || !targets[t]) continue;
      out.x += w * targets[t].getX(i);
      out.y += w * targets[t].getY(i);
      out.z += w * targets[t].getZ(i);
    }
  }
  return out;
}

// One BVH over every visible primitive of one garment, in its bind-pose,
// post-shrinkwrap, post-fit geometry — coverage is tested against the garment
// exactly as it is worn.
function garmentBVH(meshes) {
  const positions = [];
  for (const m of meshes) {
    const geo = m.geometry;
    const pos = geo.attributes.position;
    if (!pos) continue;
    const push = (i) => positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (geo.index) for (let i = 0; i < geo.index.count; i++) push(geo.index.getX(i));
    else for (let i = 0; i < pos.count; i++) push(i);
  }
  if (!positions.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return new MeshBVH(g);
}

export function coveredZonesFor(garmentUrls) {
  const zones = new Set();
  for (const url of garmentUrls || []) {
    for (const c of COVERAGE) if (url.includes(c.match)) c.zones.forEach((z) => zones.add(z));
  }
  return zones;
}

// Apply the layer rule. `store` is the live accessory store (url -> entries
// with .mesh) — the same object the wardrobe sync effect maintains.
// Layer state lives HERE, not on the scene graph. The first version parked the
// store on root.userData so exports could re-settle — and GLTFExporter
// serializes userData, so every runtime file built that day carried a 144MB
// JSON flattening of every garment's position snapshots (Lindsey: 172MB on
// disk, 26MB of actual model). Same law as the geometry caches, broken a
// second time by the fix for the first. A WeakMap is invisible to every
// exporter by construction, and cannot leak.
const layerState = new WeakMap();

export function applySkinLayers(root, store) {
  if (!root) return;
  layerState.set(root, store);
  // Probing a running mask beats guessing at it from screenshots.
  if (typeof window !== "undefined") window.__skinDebug = { root, store, zones: {} };

  // Garment groups that declare coverage, with their fitted meshes.
  const groups = [];
  for (const [url, entries] of Object.entries(store || {})) {
    const cov = COVERAGE.find((c) => url.includes(c.match));
    if (!cov) continue;
    const meshes = (entries || []).map((e) => e.mesh).filter((m) => m && m.visible !== false);
    if (meshes.length) groups.push({ url, zones: new Set(cov.zones), bvh: garmentBVH(meshes) });
  }

  const t0 = performance.now();
  const ray = new THREE.Ray();
  const pos = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  let culledTotal = 0, testedTotal = 0, meshCount = 0;

  for (const mesh of bodyMeshes(root)) {
    const geo = mesh.geometry;
    // A fullIndex round-tripped through an export is a JSON-flattened object,
    // not a typed array — it crashed .slice() and hung Benny's load forever.
    // Session 162 - recover a round-tripped fullIndex rather than discarding it.
    // Only fall back to the current index when there is genuinely nothing to
    // recover, and never let a SMALLER stored index replace a larger live one.
    if (!ArrayBuffer.isView(geo.userData.fullIndex)) {
      const recovered = recoverFullIndex(geo.userData.fullIndex);
      geo.userData.fullIndex = (recovered && recovered.length >= geo.index.count)
        ? recovered
        : geo.index.array.slice();
    }
    const full = geo.userData.fullIndex;

    if (!groups.length) {
      if (geo.index.count !== full.length) geo.setIndex(new THREE.BufferAttribute(full.slice(), 1));
      continue;
    }
    const zones = ensureZones(mesh);
    const nA = geo.attributes.normal;
    if (!zones || !nA) continue;

    // Per-vertex verdict: in a candidate zone AND fabric within reach.
    const covered = new Uint8Array(geo.attributes.position.count);
    for (let i = 0; i < covered.length; i++) {
      let candidate = null;
      for (const g of groups) {
        if (g.bvh && g.zones.has(zones[i])) { candidate = candidate || []; candidate.push(g); }
      }
      if (!candidate) continue;
      testedTotal++;
      morphedPosition(mesh, i, pos);
      nrm.fromBufferAttribute(nA, i).normalize();
      for (const g of candidate) {
        // Above me? (fabric covering intact skin)
        // Session 162 - was 0.003. That offset was larger than the shrinkwrap's
        // own clearanceMeters (0.0025), so for any garment the resolver had
        // fitted properly the ray STARTED PAST THE FABRIC and flew away from
        // it; the buried check then fired backwards and missed too. The better
        // the fit, the more reliably the mask failed - which is why the tight
        // shoulder ridge went uncovered while the looser chest passed.
        // Measured live on the basic shirt: of 197 uncovered shoulder vertices,
        // 172 had the fabric AHEAD along the normal and 77 had it within 5mm.
        // The offset also guarded nothing: this ray is cast against the GARMENT
        // bvh, never the body, so there is no self-hit to step over. Kept at a
        // hair above zero purely for numerical safety, and it must stay well
        // under clearanceMeters - if that constant ever shrinks, shrink this.
        ray.origin.copy(pos).addScaledVector(nrm, 0.0001);
        ray.direction.copy(nrm);
        let hit = g.bvh.raycastFirst(ray, THREE.DoubleSide);
        if (hit && hit.distance <= NEAR_FABRIC) { covered[i] = 1; break; }
        // Beneath me? (skin already poking through the fabric)
        ray.origin.copy(pos).addScaledVector(nrm, -0.001);
        ray.direction.copy(nrm).negate();
        hit = g.bvh.raycastFirst(ray, THREE.DoubleSide);
        if (hit && hit.distance <= BURIED_FABRIC) { covered[i] = 1; break; }
      }
    }

    // Per-zone verdict counts, for the debug handle.
    if (typeof window !== "undefined") {
      const zc = window.__skinDebug.zones;
      for (let i = 0; i < covered.length; i++) {
        const z = zones[i];
        zc[z] = zc[z] || { covered: 0, kept: 0 };
        covered[i] ? zc[z].covered++ : zc[z].kept++;
      }
    }
    const kept = new (full.constructor)(full.length);
    let k = 0;
    for (let t = 0; t < full.length; t += 3) {
      const a = full[t], b = full[t + 1], c = full[t + 2];
      // Session 162 - back to ALL THREE. Two-of-three was added when coverage
      // was poor and the kept ring was wide; it cut into that ring unevenly and
      // rendered as a SAWTOOTH fringe at the collar, because triangles then
      // alternate culled/kept along the boundary. With the ray-offset bug fixed
      // (shoulder cov 593 -> 703) the ring is thin on its own, so the smooth
      // boundary is worth more than the extra row it culls.
      if (covered[a] && covered[b] && covered[c]) { culledTotal++; continue; }
      kept[k++] = a; kept[k++] = b; kept[k++] = c;
    }
    if (k !== geo.index.count) {
      geo.setIndex(new THREE.BufferAttribute(kept.slice(0, k), 1));
      meshCount++;
    }
  }

  if (groups.length) {
    console.log(`[bodyLayers] geometric mask: ${testedTotal} candidate vertices tested against ` +
      `${groups.length} garment(s), ${culledTotal} triangle(s) hidden across ${meshCount} ` +
      `body mesh(es) in ${(performance.now() - t0).toFixed(0)}ms.`);
  } else {
    console.log("[bodyLayers] no covering garments — full skin restored.");
  }
}

// Editable exports serialize the live geometry, and a working file must keep
// every triangle. Returns the re-apply function for the finally-path.
// Session 162 - recover a fullIndex that has been round-tripped through a GLB.
//
// GLTFExporter serialises userData, so a body exported once comes back with its
// fullIndex as a PLAIN JSON OBJECT, not a typed array. Both call sites tested
// ArrayBuffer.isView() and, finding false, treated it as absent: settleLayers
// overwrote it with the CURRENT (already culled) index, and suspendSkinLayers
// declined to restore. The true full mesh was therefore discarded on the first
// reload after an export, and every later save rewrote the holes - measured
// live as drawnTris === fullTris with culled:0 on a body visibly missing its
// torso and upper arms, and as an editable export byte-identical in geometry
// to the runtime bake that is SUPPOSED to keep culling.
//
// JSON gives back either {"0":n,"1":n,...} or a real array; both are recoverable.
function recoverFullIndex(v) {
  if (ArrayBuffer.isView(v)) return v;
  if (Array.isArray(v)) return Uint32Array.from(v);
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) return null;
    const out = new Uint32Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const n = v[i];
      if (typeof n !== "number") return null;
      out[i] = n;
    }
    return out;
  }
  return null;
}

export function suspendSkinLayers(root) {
  if (!root) return () => {};
  for (const mesh of bodyMeshes(root)) {
    const full = recoverFullIndex(mesh.geometry.userData.fullIndex);
    if (full && mesh.geometry.index.count !== full.length) {
      mesh.geometry.setIndex(new THREE.BufferAttribute(full.slice(), 1));
    }
  }
  const store = layerState.get(root) || {};
  return () => applySkinLayers(root, store);
}

// ── Hair over clothing — the outermost layer fits what is beneath it ─────────
//
// Session 152, from a screenshot with a red ring around her chest: hair
// strands ran INSIDE the blouse and peeked out through the pleat gaps — read
// at first as skin, then as holes, actually hair. Hair is authored draping
// against a bare body, is excluded from body-shrinkwrap on purpose (thin
// ribbon cards distort badly under aggressive per-vertex resolve), and knew
// nothing about the garment layer that had just been fitted OVER the space it
// hangs through.
//
// The layer rule generalises: layer N rests on the union of layers below it.
// Clothing wraps the body; hair wraps body-plus-clothing. This pass is gentler
// than the body shrinkwrap because its target is different: for each hair
// vertex near the clothing surface, find the closest fabric point, and if the
// vertex sits beneath that surface (or within clearance of it), lift it out
// along the fabric normal — then smooth the displacements through the strand
// topology so ribbons bend instead of kinking. Vertices nowhere near fabric —
// which is almost all of the hair — are untouched.
const HAIR_CLEARANCE = 0.02;   // hair floats ~2cm proud of cloth (and 2cm out of skin) - a visible gap, not a decal (Session 172: 4mm z-fought with the fabric on screen and read as "melting")
const HAIR_SEARCH = 0.15;       // a strand up to 15cm beneath the cloth is still brought out (parity makes "beneath" reliable; 4 of Lindsey's sat 8-11cm in)
const HAIR_MAX_LIFT = 0.08;     // and no vertex teleports
const HAIR_MAX_PASSES = 4;      // lift+smooth rounds before the assertion takes over
const HAIR_FEATHER = 4;         // neighbour rings relaxed around a pinned vertex
const HAIR_ENVELOPE_RINGS = 8;  // a cloth lift spreads this many rings along the strand ...
const HAIR_ENVELOPE_DECAY = 0.85; // ... shrinking by this much per ring, so a LOCK rises off the fabric intact
const HAIR_BODY_SEARCH = 0.05;  // no skin within 5cm means the vertex cannot be inside the body

// Session 171 (Magnus: "assert that the hair doesn't melt into the garment and
// skin"). The pass above was ONE lift round, smoothed at half strength, never
// re-measured, and had no skin rule at all. Measured live on Lindsey Vaughn
// after it reported "783 vertex(es) lifted": 5702 hair vertices were still
// beneath the blouse (62mm at worst), 3344 more sat inside the clearance, and
// 481 were inside her chest and shoulders. Same lesson as shrinkwrapToBody:
// smoothing under-pushes the edge of a region, and a pass that never
// re-measures cannot promise anything.
//
// Now the shrinkwrap discipline. A field of lifts is computed, smoothed and
// applied for up to HAIR_MAX_PASSES rounds, re-measured after each; whatever
// still violates is PINNED to its exact target with its free neighbours
// feathered around it (Jacobi relaxation, pinned set as the boundary),
// verified once more, and anything left is snapped raw. Two violation kinds,
// in layer order, because the hair rests on the union of everything beneath it:
//   skin  - a hair vertex INSIDE the body (3-ray parity against the intact
//           body surface) whose nearest skin is not the head. Roots belong
//           inside the scalp; nothing belongs inside a chest or a shoulder.
//           Lifted to skin + clearance via the closest face.
//   cloth - a hair vertex beneath the clothing (odd number of garment
//           crossings along the outward radial from the torso axis - see the
//           note at the rule), lifted to that ray's last crossing + clearance;
//           or outside but inside the clearance, lifted along the face normal.
// Scalp vertices (inside the body with head skin nearest) are never moved by
// either rule, so a collar near the nape cannot pull roots out of the skull.
// The body is optional: called without one, only the cloth rule runs.
//
// The verdict is logged per hair primitive as ASSERT PASS / ENFORCED / FAILED,
// the same vocabulary as the garment wrap, so a screenshot claim ("hair melts
// into the top") can be checked against numbers instead of eyes.
// Session 175 - what a settle re-derived from scratch every time, cached:
// the strand adjacency (topology never changes) and the scalp mask (three
// raycasts per vertex; only changes when the hair or the body moves, which a
// position fingerprint catches). Both keyed on the geometry object.
const _hairAdjCache = new WeakMap();
const _hairScalpCache = new WeakMap();
const _scalpFingerprint = (pos, bbvh) => {
  const N = pos.count, step = Math.max(1, Math.floor(N / 97));
  let h = N * 7919;
  for (let i = 0; i < N; i += step) h = (h * 31 + Math.round((pos.getX(i) + pos.getY(i) * 3 + pos.getZ(i) * 7) * 1e4)) | 0;
  return `${h}:${N}`;
};
const _bvhTag = new WeakMap(); let _bvhSeq = 0;
const _bvhId = (bvh) => { if (!bvh) return "none"; if (!_bvhTag.has(bvh)) _bvhTag.set(bvh, ++_bvhSeq); return String(_bvhTag.get(bvh)); };

export function fitOuterLayers(root, store, body = null) {
  const clothing = [];
  const hair = [];
  for (const [url, entries] of Object.entries(store || {})) {
    const meshes = (entries || []).filter((e) => e.mesh && e.mesh.visible !== false);
    // Session 174 (Magnus: "it shall work with bra and none bra") - visible
    // underwear is clothing too; a bra hidden under a top is invisible and
    // drops out through the filter above, as before.
    if (url.includes("/torso/") || url.includes("/legs/") || url.includes("/underwear/")) clothing.push(...meshes);
    else if (url.includes("/head/hair/")) hair.push(...entries.filter((e) => e.mesh));
  }
  if (!hair.length) return [];

  // One triangle soup of the clothing as currently fitted, positions kept for
  // per-face normals (the BVH result hands back a faceIndex).
  const tri = [];
  for (const e of clothing) {
    const geo = e.mesh.geometry;
    const pos = geo.attributes.position;
    if (!pos) continue;
    const push = (i) => tri.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (geo.index) for (let i = 0; i < geo.index.count; i++) push(geo.index.getX(i));
    else for (let i = 0; i < pos.count; i++) push(i);
  }
  let cbvh = null, cbox = null;
  if (tri.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3));
    cbvh = new MeshBVH(g);
    // Session 175 - the cloth's box, padded by the farthest any cloth rule
    // reaches. Most of a long hairdo (scalp, crown, bangs) sits above every
    // garment and never needed the raycasts it was paying for.
    g.computeBoundingBox();
    cbox = g.boundingBox.clone().expandByScalar(Math.max(HAIR_SEARCH, HAIR_CLEARANCE) + 0.01);
  }

  // The intact body surface (getBodySurfaceBVH's cache: bvh + merged geom +
  // the primitives it was merged from, in order) and one zone per merged
  // vertex so "head" can be told from "chest".
  let bbvh = null, bpos = null, bidx = null, bzones = null;
  if (body && body.bvh && body.geom?.attributes?.position && Array.isArray(body.parts)) {
    bbvh = body.bvh; bpos = body.geom.attributes.position; bidx = body.geom.index;
    bzones = [];
    for (const part of body.parts) {
      const z = ensureZones(part);
      const n = part.geometry.attributes.position.count;
      for (let i = 0; i < n; i++) bzones.push(z ? z[i] : "other");
    }
    if (bzones.length !== bpos.count) { bbvh = null; bzones = null; }
  }
  if (!cbvh && !bbvh) return [];

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3(), h = new THREE.Vector3(), v = new THREE.Vector3(), tmp = new THREE.Vector3();
  const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const bt = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  // Session 173 - MeshBVH REORDERS the index of the geometry it is built on,
  // so a faceIndex from a query addresses the BVH's index, not the order the
  // corners were pushed in. Reading `tri` at fi*9 (as this did since Session
  // 152) picked an unrelated triangle's normal. Go through the index.
  const clothNormal = (fi) => {
    const ix = cbvh.geometry.index, f = fi * 3;
    a.fromArray(tri, ix.getX(f) * 3); b.fromArray(tri, ix.getX(f + 1) * 3); c.fromArray(tri, ix.getX(f + 2) * 3);
    n.subVectors(b, a).cross(tmp.subVectors(c, a)).normalize();
    // Winding is not trusted: orient the normal outward from the torso axis,
    // which for a worn garment is always the right way to lift.
    h.set(hit.point.x, 0, hit.point.z);
    if (h.lengthSq() > 1e-8 && n.dot(h) < 0) n.negate();
    return n;
  };
  const bodyNormal = (fi) => {
    const f = fi * 3;
    a.fromBufferAttribute(bpos, bidx ? bidx.getX(f) : f);
    b.fromBufferAttribute(bpos, bidx ? bidx.getX(f + 1) : f + 1);
    c.fromBufferAttribute(bpos, bidx ? bidx.getX(f + 2) : f + 2);
    n.subVectors(b, a).cross(tmp.subVectors(c, a));
    if (n.lengthSq() === 0) return null;
    return n.normalize();
  };
  const bodyZoneAt = (fi) => bzones[bidx ? bidx.getX(fi * 3) : fi * 3];
  // Same three rays and the same majority vote as shrinkwrapToBody.
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3());
  const rayDirs = [
    new THREE.Vector3(0.093, 0.031, 0.995).normalize(),
    new THREE.Vector3(0.719, 0.024, -0.694).normalize(),
    new THREE.Vector3(-0.757, 0.041, -0.652).normalize(),
  ];
  const insideBody = (p) => {
    let votes = 0;
    for (const d of rayDirs) {
      ray.origin.copy(p); ray.direction.copy(d);
      const hits = bbvh.raycast(ray, THREE.DoubleSide);
      let crossings = 0;
      for (const x of hits) if (x.distance > 1e-6) crossings++;
      if ((crossings & 1) === 1) votes++;
    }
    return votes >= 2;
  };

  // The lift for one vertex: 1 = out of the skin, 2 = out from under the
  // cloth, 0 = nothing to do. Skin first - it is the layer beneath the cloth,
  // and a vertex lifted out of the chest is re-measured against the blouse on
  // the next pass.
  const lift = new THREE.Vector3();
  const away = new THREE.Vector3();
  // mode "normal": lift a beneath-cloth vertex to the NEAREST fabric point
  // along that face's normal, oriented away from the body - a lock that
  // entered the blouse behind the shoulder comes out over the back, one in
  // front comes out over the chest, and nothing is dragged sideways onto the
  // yoke (Session 172: the radial exit did exactly that, smearing locks onto
  // the yoke where Magnus circled them). mode "exit": the radial ray's last
  // crossing, used once the normal lift has had its passes, because inside a
  // pleat the nearest face can be a fold wall and the normal lift can
  // oscillate there; the exit lift always converges. clearScale ramps the
  // float down next to the scalp so a root-pinned card cannot pivot out
  // like a flag (seen live at 2cm).
  const evaluate = (p, mode, clearScale) => {
    const clear = HAIR_CLEARANCE * clearScale;
    if (bbvh && bbvh.closestPointToPoint(p, bt, 0, HAIR_BODY_SEARCH) && insideBody(p)) {
      const fn = bodyNormal(bt.faceIndex);
      if (fn) {
        lift.copy(bt.point).addScaledVector(fn, clear).sub(p);
        if (lift.length() > HAIR_MAX_LIFT) lift.setLength(HAIR_MAX_LIFT);
        return 1;
      }
    }
    if (cbvh && cbox.containsPoint(p)) {
      // Beneath or outside is decided by PARITY along the outward radial from
      // the torso axis, not by the sign of the closest face: on a pleated
      // blouse the closest face is often the far wall of a fold, whose normal
      // points the wrong way, and the first version of this rule lifted 1355
      // vertices into 1427 "beneath" (measured live on Lindsey). A ray that
      // crosses the garment an odd number of times starts under it, whatever
      // the folds do; its LAST crossing is the outer surface the hair must rest
      // on. An even count means outside, where the only remaining rule is the
      // clearance to the nearest cloth, lifted along that face's normal
      // oriented toward the vertex (safe now that the side is known).
      h.set(p.x, 0, p.z);
      if (h.lengthSq() > 1e-8) {
        ray.origin.copy(p); ray.direction.copy(h.normalize());
        const hits = cbvh.raycast(ray, THREE.DoubleSide);
        let crossings = 0, far = null;
        for (const x of hits) { if (x.distance <= 1e-6) continue; crossings++; if (!far || x.distance > far.distance) far = x; }
        if ((crossings & 1) === 1 && far && far.distance <= HAIR_SEARCH) {
          if (mode === "normal" && cbvh.closestPointToPoint(p, hit, 0, HAIR_SEARCH)) {
            const fn = clothNormal(hit.faceIndex);
            // orient away from the body when the body is known; the radial
            // orientation inside clothNormal is the fallback
            if (bbvh && bbvh.closestPointToPoint(hit.point, bt, 0, 0.5)) {
              away.subVectors(hit.point, bt.point);
              if (away.lengthSq() > 1e-10 && fn.dot(away) < 0) fn.negate();
            }
            lift.copy(hit.point).addScaledVector(fn, clear).sub(p);
          } else {
            lift.copy(far.point).addScaledVector(ray.direction, clear).sub(p);
          }
          if (lift.length() > HAIR_MAX_LIFT) lift.setLength(HAIR_MAX_LIFT);
          return 2;
        }
        if ((crossings & 1) === 1) return 0;   // deeper than the search: left alone, as before
      }
      // Outside but closer than the clearance: a soft NUDGE along the face
      // normal, applied in the convergence passes but never counted, pinned
      // or snapped. It cannot be asserted: in a pleat behind the neck a
      // strand has fabric within 4mm on BOTH sides, and a rule that demands
      // clearance from each oscillates forever (measured live: 1616 of 1623
      // "still beneath" after the raw snap were exactly these). Hair resting
      // on cloth is not hair melting into it.
      if (cbvh.closestPointToPoint(p, hit, 0, clear)) {
        const fn = clothNormal(hit.faceIndex);
        if (fn.dot(tmp.subVectors(p, hit.point)) < 0) fn.negate();
        lift.copy(fn).multiplyScalar(clear - hit.distance);
        return 3;
      }
    }
    return 0;
  };

  const touched = [];
  const t0 = performance.now();

  for (const entry of hair) {
    const geo = entry.mesh.geometry;
    const pos = geo.attributes.position;
    if (!pos) continue;
    const N = pos.count;

    // Scalp mask, taken BEFORE anything moves: inside the body, head nearest.
    let scalp;
    {
      const key = `${_bvhId(bbvh)}|${_scalpFingerprint(pos, bbvh)}`;
      const cached = _hairScalpCache.get(geo);
      if (cached && cached.key === key) scalp = cached.scalp;
      else {
        scalp = new Uint8Array(N);
        if (bbvh) {
          for (let i = 0; i < N; i++) {
            v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
            if (bbvh.closestPointToPoint(v, bt, 0, HAIR_BODY_SEARCH) && bodyZoneAt(bt.faceIndex) === "head" && insideBody(v)) scalp[i] = 1;
          }
        }
        _hairScalpCache.set(geo, { key, scalp });
      }
    }

    // Strand topology, once, for the smoothing and the feather.
    let adj = null;
    if (geo.index) {
      adj = _hairAdjCache.get(geo) || null;
      if (!adj || adj.length !== N) {
        adj = Array.from({ length: N }, () => new Set());
        for (let i = 0; i < geo.index.count; i += 3) {
          const x = geo.index.getX(i), y = geo.index.getX(i + 1), z = geo.index.getX(i + 2);
          adj[x].add(y); adj[x].add(z); adj[y].add(x); adj[y].add(z); adj[z].add(x); adj[z].add(y);
        }
        _hairAdjCache.set(geo, adj);
      }
    }

    // the float ramps from 40% at the skull base (lowest scalp root) to 100%
    // ten centimetres below it
    let scalpBaseY = null;
    for (let i = 0; i < N; i++) if (scalp[i]) { const y = pos.getY(i); if (scalpBaseY === null || y < scalpBaseY) scalpBaseY = y; }
    const clearScaleAt = (y) => scalpBaseY === null ? 1 : Math.min(1, Math.max(0.4, 0.4 + 0.6 * (scalpBaseY - y) / 0.10));
    const disp = new Float32Array(N * 3);
    const kindOf = new Uint8Array(N);   // 1 skin, 2 cloth (violations), 3 clearance nudge
    // Session 175 - the cloth and the body do not move during a settle, so
    // after the first full measurement only a vertex that MOVED (apply,
    // feather, raw snap) or was violating can change its verdict. Later
    // fields evaluate that set only; everything else keeps a clean zero.
    const moved = new Uint8Array(N);
    const cand = new Uint8Array(N);
    const markCand = () => { for (let i = 0; i < N; i++) cand[i] = (kindOf[i] !== 0 || moved[i]) ? 1 : 0; };
    const computeField = (mode = "exit", only = null) => {
      disp.fill(0); kindOf.fill(0);
      let skin = 0, cloth = 0, near = 0;
      for (let i = 0; i < N; i++) {
        if (scalp[i]) continue;
        if (only && !only[i]) continue;
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        const kind = evaluate(v, mode, clearScaleAt(v.y));
        if (!kind) continue;
        disp[i * 3] = lift.x; disp[i * 3 + 1] = lift.y; disp[i * 3 + 2] = lift.z;
        kindOf[i] = kind;
        if (kind === 1) skin++; else if (kind === 2) cloth++; else near++;
      }
      return { skin, cloth, near, total: skin + cloth };
    };
    // Two passes of half-strength neighbour averaging, so a lifted ribbon
    // carries its neighbours with it instead of kinking at the first
    // untouched vertex (the original smoothing, unchanged).
    const smoothed = (field) => {
      if (!adj) return field;
      let f = field;
      for (let pass = 0; pass < 2; pass++) {
        const next = f.slice();
        for (let i = 0; i < N; i++) {
          const ns = adj[i];
          if (ns.size === 0) continue;
          let sx = 0, sy = 0, sz = 0;
          for (const j of ns) { sx += f[j * 3]; sy += f[j * 3 + 1]; sz += f[j * 3 + 2]; }
          const k = ns.size;
          next[i * 3] = 0.5 * f[i * 3] + 0.5 * (sx / k);
          next[i * 3 + 1] = 0.5 * f[i * 3 + 1] + 0.5 * (sy / k);
          next[i * 3 + 2] = 0.5 * f[i * 3 + 2] + 0.5 * (sz / k);
        }
        f = next;
      }
      for (let i = 0; i < N; i++) if (scalp[i]) { f[i * 3] = 0; f[i * 3 + 1] = 0; f[i * 3 + 2] = 0; }
      return f;
    };
    // Session 172 - an ENVELOPE lift was tried here (each vertex takes the
    // largest radial lift within HAIR_ENVELOPE_RINGS, decaying per ring, so a
    // lock rises off the fabric as a whole). Measured live it satisfied the
    // assertion (idle residual 73) but the sideways radial pushed whole locks
    // out past the shoulders into wings - visibly worse than the flat lock it
    // was meant to fix. Kept, unused, as the record of that; the per-vertex
    // lift with a 2cm float is what runs.
    const enveloped = (field) => {
      if (!adj) return field;
      let mag = new Float32Array(N);
      for (let i = 0; i < N; i++) if (kindOf[i] === 2) mag[i] = Math.hypot(field[i * 3], field[i * 3 + 1], field[i * 3 + 2]);
      for (let r = 0; r < HAIR_ENVELOPE_RINGS; r++) {
        const next = mag.slice();
        for (let i = 0; i < N; i++) {
          if (scalp[i]) continue;
          let m = mag[i];
          for (const j of adj[i]) { const c = mag[j] * HAIR_ENVELOPE_DECAY; if (c > m) m = c; }
          next[i] = m;
        }
        mag = next;
      }
      const out = field.slice();
      for (let i = 0; i < N; i++) {
        if (mag[i] <= 0 || scalp[i] || kindOf[i] === 1) continue;
        h.set(pos.getX(i), 0, pos.getZ(i));
        if (h.lengthSq() <= 1e-8) continue;
        h.normalize();
        const own = Math.hypot(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]);
        const m = Math.max(mag[i], own);
        out[i * 3] = h.x * m; out[i * 3 + 1] = h.y * m; out[i * 3 + 2] = h.z * m;
      }
      return out;
    };
    const apply = (field) => {
      let n = 0;
      moved.fill(0);
      for (let i = 0; i < N; i++) {
        const dx = field[i * 3], dy = field[i * 3 + 1], dz = field[i * 3 + 2];
        if (dx === 0 && dy === 0 && dz === 0) continue;
        pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i) + dz);
        moved[i] = 1;
        n++;
      }
      return n;
    };

    let counts = computeField("normal");
    const initial = counts;
    if (!initial.total) continue;
    const trace = [`${initial.cloth}c/${initial.skin}s (+${initial.near} within clearance, nudged only)`];

    // 1. Converge: lift, smooth, apply, re-measure. The first two passes lift
    //    toward the nearest fabric (mode "normal"); the rest use the radial
    //    exit, which always converges.
    let passes = 0;
    while (counts.total > 0 && passes < HAIR_MAX_PASSES) {
      const n = apply(smoothed(disp));   // (the envelope variant spread locks into wings over the shoulders - see enveloped)
      passes++;
      const mode = passes < 2 ? "normal" : "exit";
      markCand();
      counts = computeField(mode, cand);
      trace.push(`p${passes}:${n}m>${counts.cloth}c/${counts.skin}s${mode === "normal" ? "n" : "x"}`);
    }

    // 2. Assert: pin the leftovers to their exact lift, feather the free
    //    neighbours, verify, and snap raw whatever still violates.
    let pinned = 0, feathered = 0, raw = 0;
    if (counts.total > 0) {
      const pin = new Uint8Array(N);
      for (let i = 0; i < N; i++) if (kindOf[i] === 1 || kindOf[i] === 2) { pin[i] = 1; pinned++; }
      let field = disp;
      if (adj) {
        for (let it = 0; it < HAIR_FEATHER; it++) {
          const next = new Float32Array(field.length);
          for (let i = 0; i < N; i++) {
            if (pin[i]) { next[i * 3] = field[i * 3]; next[i * 3 + 1] = field[i * 3 + 1]; next[i * 3 + 2] = field[i * 3 + 2]; continue; }
            const ns = adj[i];
            if (ns.size === 0 || scalp[i]) continue;
            let sx = 0, sy = 0, sz = 0;
            for (const j of ns) { sx += field[j * 3]; sy += field[j * 3 + 1]; sz += field[j * 3 + 2]; }
            const inv = 1 / ns.size;
            next[i * 3] = sx * inv; next[i * 3 + 1] = sy * inv; next[i * 3 + 2] = sz * inv;
          }
          field = next;
        }
      }
      feathered = apply(field) - pinned;
      markCand();
      counts = computeField("exit", cand);
      trace.push(`feather:${pinned}pin>${counts.cloth}c/${counts.skin}s`);
      if (counts.total > 0) {
        raw = counts.total;
        let n = 0;
        moved.fill(0);
        for (let i = 0; i < N; i++) {
          if (kindOf[i] !== 1 && kindOf[i] !== 2) continue;
          pos.setXYZ(i, pos.getX(i) + disp[i * 3], pos.getY(i) + disp[i * 3 + 1], pos.getZ(i) + disp[i * 3 + 2]);
          moved[i] = 1;
          n++;
        }
        markCand();
        counts = computeField("exit", cand);
        trace.push(`raw:${n}m>${counts.cloth}c/${counts.skin}s`);
      }
    }

    pos.needsUpdate = true;
    geo.computeVertexNormals?.();
    touched.push(entry);

    const status = counts.total > 0
      ? `ASSERT FAILED (${counts.cloth} still beneath cloth, ${counts.skin} still inside skin)`
      : (pinned === 0 ? "ASSERT PASS (converged)"
        : `ASSERT ENFORCED (${pinned} pinned to clearance, ${feathered} neighbours feathered${raw ? `, ${raw} snapped raw` : ""})`);
    const line = `[bodyLayers] hair layering "${entry.mesh.name}": ${initial.cloth} beneath cloth, ${initial.skin} inside skin (scalp exempt: ${scalp.reduce((s, x) => s + x, 0)}) -> ${passes} pass(es), ${status} [${trace.join(" ")}].`;
    if (counts.total > 0) console.warn(line); else console.log(line);
  }

  if (touched.length) {
    console.log(`[bodyLayers] hair layered over ${cbvh ? "clothing" : "nothing"}${bbvh ? " and out of the skin" : " (no body surface given, skin rule skipped)"}: ${touched.length} hair primitive(s) in ${(performance.now() - t0).toFixed(0)}ms.`);
  }
  return touched;
}


// ── Hair rides the garment, every frame ─────────────────────────────────────
//
// Session 173 (Magnus: "do number 2" - collision-aware skinning at render
// time). Everything above fits the hair once, in bind pose, and then the
// GPU skins hair and blouse with different bones: the head turns, the
// chest breathes, and a few strand tips dip back under the yoke at the
// extreme of the clip (measured: worst 256 of 24302 vertices, 33mm). No
// bind-pose rule can remove that, so this layer removes it where it
// happens - in the POSED space, per frame.
//
// At settle, every hair vertex within HAIR_RIDE_REACH of fabric remembers
// the fabric triangle it rests on (the nearest one), the barycentric point
// on it, and which side of it the hair is on. Each frame, after the mixer
// has posed the bones, that triangle and the hair vertex are both skinned
// on the CPU exactly as the GPU does it; if the vertex is closer than
// HAIR_RIDE_GAP to its triangle's plane (or under it) it is pushed back out
// along the posed normal, and the push is written into the BIND-space
// position through the inverse of the vertex's own skinning matrix, so the
// GPU still does the skinning and the hair is otherwise untouched. Vertices
// that need no push are written back to their settled position, so the
// layer is stateless from frame to frame. Only the anchor triangle's plane
// is tested, never the whole garment: the anchor stays the nearest fabric
// under the small relative motion an idle clip produces, and that makes
// the per-frame cost a few thousand skinning ops instead of a BVH query
// per vertex.
//
// Paused around exports (the file must carry the settled shape, not one
// frame's correction) and invalidated by a manual-fit change until the
// next settle rebuilds the anchors.
const HAIR_RIDE_REACH = 0.06;   // anchor a hair vertex to fabric within 6cm of it at settle (10cm anchored 2000 more and read as melting on the shoulders in the desktop app; the 41 residual tips were anchored anyway)
const HAIR_RIDE_GAP = 0.02;     // and never let it come closer than 2cm to that fabric in motion - the same float the settle gives it (8mm let strands sink into the pleat valleys of the blouse back, below the ridge tops, and read as inside the fabric)
const HAIR_RIDE_SECOND_ANCHOR = false;   // see anchor 2 in prepareHairRide
const rideState = new WeakMap();  // store -> { cloth, cvMesh, cvVi, posed, paused, frame }
const _rq = new THREE.Vector3(), _racc = new THREE.Vector3(), _rt = new THREE.Vector3(), _rm = new THREE.Matrix4();
const _rsum = new THREE.Matrix4(), _rM = new THREE.Matrix4();
const _rP = new THREE.Vector3(), _rA = new THREE.Vector3(), _rn = new THREE.Vector3(), _re1 = new THREE.Vector3(), _re2 = new THREE.Vector3();
const _rc0 = new THREE.Vector3(), _rc1 = new THREE.Vector3(), _rc2 = new THREE.Vector3(), _rd = new THREE.Vector3();

// posed position of (x,y,z) skinned with vertex i's bones of mesh
function ridePose(mesh, i, x, y, z, out) {
  const g = mesh.geometry, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, bm = mesh.skeleton.boneMatrices;
  _rq.set(x, y, z).applyMatrix4(mesh.bindMatrix);
  _racc.set(0, 0, 0);
  const i0 = SI.getX(i), i1 = SI.getY(i), i2 = SI.getZ(i), i3 = SI.getW(i);
  const w0 = SW.getX(i), w1 = SW.getY(i), w2 = SW.getZ(i), w3 = SW.getW(i);
  if (w0) { _rm.fromArray(bm, i0 * 16); _rt.copy(_rq).applyMatrix4(_rm); _racc.addScaledVector(_rt, w0); }
  if (w1) { _rm.fromArray(bm, i1 * 16); _rt.copy(_rq).applyMatrix4(_rm); _racc.addScaledVector(_rt, w1); }
  if (w2) { _rm.fromArray(bm, i2 * 16); _rt.copy(_rq).applyMatrix4(_rm); _racc.addScaledVector(_rt, w2); }
  if (w3) { _rm.fromArray(bm, i3 * 16); _rt.copy(_rq).applyMatrix4(_rm); _racc.addScaledVector(_rt, w3); }
  return out.copy(_racc).applyMatrix4(mesh.bindMatrixInverse);
}
// the full bind->posed matrix of vertex i (bindMatrixInverse * sum(w*B) * bindMatrix), into out
function rideMatrix(mesh, i, out) {
  const g = mesh.geometry, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, bm = mesh.skeleton.boneMatrices;
  const e = _rsum.elements; for (let k = 0; k < 16; k++) e[k] = 0;
  const idx = [SI.getX(i), SI.getY(i), SI.getZ(i), SI.getW(i)], w = [SW.getX(i), SW.getY(i), SW.getZ(i), SW.getW(i)];
  for (let k = 0; k < 4; k++) { if (!w[k]) continue; const o = idx[k] * 16; for (let c = 0; c < 16; c++) e[c] += bm[o + c] * w[k]; }
  return out.copy(mesh.bindMatrixInverse).multiply(_rsum).multiply(mesh.bindMatrix);
}

// Session 174 - the ride also anchors to the SKIN: with no top and no bra
// the strands still rest on bare shoulders and chest, and the head turn
// still moves them relative to it. `body` is getBodySurfaceBVH's cache
// (intact, morphed bind-space surface + the primitives it was merged from);
// a hair vertex anchors to whichever is nearer within reach, fabric or
// skin. Skin anchors skip the head (roots live inside the scalp) and any
// vertex already inside the body (a root), so nothing pulls hair out of the
// skull.
export function prepareHairRide(store, body = null) {
  const cloth = [], hair = [];
  for (const [url, entries] of Object.entries(store || {})) {
    for (const e of (entries || [])) {
      const m = e.mesh; if (!m || !m.isSkinnedMesh) continue;
      if (url.includes("/head/hair/")) hair.push(e);
      else if ((url.includes("/torso/") || url.includes("/legs/") || url.includes("/underwear/")) && m.visible !== false && m.geometry.attributes.skinIndex) cloth.push(m);
    }
  }
  for (const e of hair) e.ride = null;
  rideState.delete(store);
  const bodyOk = !!(body && body.bvh && body.geom?.index && Array.isArray(body.parts) && body.parts.length);
  if ((!cloth.length && !bodyOk) || !hair.length) return null;
  // body: merged vertex -> (part, local), zone per merged vertex
  let partOf = null, localOf = null, zoneOf = null;
  if (bodyOk) {
    const total = body.geom.attributes.position.count;
    partOf = new Int32Array(total); localOf = new Uint32Array(total); zoneOf = new Array(total);
    let off = 0;
    body.parts.forEach((p, pi) => {
      const z = ensureZones(p); const n = p.geometry.attributes.position.count;
      for (let i = 0; i < n; i++) { partOf[off + i] = pi; localOf[off + i] = i; zoneOf[off + i] = z ? z[i] : "other"; }
      off += n;
    });
    if (off !== total) { partOf = null; }
  }
  const bvKey = new Map(); const bvPart = [], bvLocal = [], bvBase = [];
  const bvId = (mv) => { let id = bvKey.get(mv); if (id === undefined) { id = bvPart.length; bvKey.set(mv, id); bvPart.push(partOf[mv]); bvLocal.push(localOf[mv]); const bp = body.geom.attributes.position; bvBase.push(bp.getX(mv), bp.getY(mv), bp.getZ(mv)); } return id; };
  // cloth soup with (mesh, vertex) per corner
  const tri = []; const cMesh = []; const cVi = [];
  cloth.forEach((m, mi) => {
    const g = m.geometry, pos = g.attributes.position;
    const push = (vi) => { tri.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi)); cMesh.push(mi); cVi.push(vi); };
    if (g.index) for (let i = 0; i < g.index.count; i++) push(g.index.getX(i)); else for (let i = 0; i < pos.count; i++) push(i);
  });
  let g = null, bvh = null;
  if (tri.length) { g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3)); bvh = new MeshBVH(g); }
  // unique cloth vertex table
  const cvKey = new Map(); const cvMesh = [], cvVi = [];
  const cvId = (corner) => { const key = cMesh[corner] * 4294967296 + cVi[corner]; let id = cvKey.get(key); if (id === undefined) { id = cvMesh.length; cvKey.set(key, id); cvMesh.push(cMesh[corner]); cvVi.push(cVi[corner]); } return id; };
  const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const p = new THREE.Vector3();
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3());
  // one anchor from a (faceIndex, point on it): corners through the BVH's
  // reordered index (see clothNormal), barycentric of the point, and which
  // side of the face the hair vertex is on. Returns false for a degenerate face.
  const makeAnchor = (faceIndex, point, corner, bary, sign, i) => {
    const f = faceIndex * 3, ix = g.index;
    const k0 = ix.getX(f), k1 = ix.getX(f + 1), k2 = ix.getX(f + 2);
    _rc0.fromArray(tri, k0 * 3); _rc1.fromArray(tri, k1 * 3); _rc2.fromArray(tri, k2 * 3);
    _re1.subVectors(_rc1, _rc0); _re2.subVectors(_rc2, _rc0); _rd.subVectors(point, _rc0);
    const d00 = _re1.dot(_re1), d01 = _re1.dot(_re2), d11 = _re2.dot(_re2), d20 = _rd.dot(_re1), d21 = _rd.dot(_re2);
    const den = d00 * d11 - d01 * d01; if (Math.abs(den) < 1e-14) return false;
    const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den, u = 1 - v - w;
    _rn.crossVectors(_re1, _re2); if (_rn.lengthSq() === 0) return false; _rn.normalize();
    corner[i * 3] = cvId(k0); corner[i * 3 + 1] = cvId(k1); corner[i * 3 + 2] = cvId(k2);
    bary[i * 3] = u; bary[i * 3 + 1] = v; bary[i * 3 + 2] = w;
    sign[i] = _rd.subVectors(p, point).dot(_rn) >= 0 ? 1 : -1;
    return true;
  };
  // one SKIN anchor from a body face: corners are merged body vertex ids
  const bhit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const makeBodyAnchor = (faceIndex, point, corner, bary, sign, i) => {
    const bp = body.geom.attributes.position, ix = body.geom.index, f = faceIndex * 3;
    const m0 = ix.getX(f), m1 = ix.getX(f + 1), m2 = ix.getX(f + 2);
    if (zoneOf[m0] === "head" || zoneOf[m1] === "head" || zoneOf[m2] === "head") return false;
    _rc0.fromBufferAttribute(bp, m0); _rc1.fromBufferAttribute(bp, m1); _rc2.fromBufferAttribute(bp, m2);
    _re1.subVectors(_rc1, _rc0); _re2.subVectors(_rc2, _rc0); _rd.subVectors(point, _rc0);
    const d00 = _re1.dot(_re1), d01 = _re1.dot(_re2), d11 = _re2.dot(_re2), d20 = _rd.dot(_re1), d21 = _rd.dot(_re2);
    const den = d00 * d11 - d01 * d01; if (Math.abs(den) < 1e-14) return false;
    const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den, u = 1 - v - w;
    _rn.crossVectors(_re1, _re2); if (_rn.lengthSq() === 0) return false; _rn.normalize();
    // the intact body winding is outward: a vertex on the inner side is a root, leave it
    if (_rd.subVectors(p, point).dot(_rn) < 0) return false;
    corner[i * 3] = bvId(m0); corner[i * 3 + 1] = bvId(m1); corner[i * 3 + 2] = bvId(m2);
    bary[i * 3] = u; bary[i * 3 + 1] = v; bary[i * 3 + 2] = w;
    sign[i] = 1;
    return true;
  };
  let anchored = 0, total = 0, second = 0, skin = 0;
  for (const e of hair) {
    const pos = e.mesh.geometry.attributes.position; const N = pos.count; total += N;
    const base = new Float32Array(N * 3); for (let i = 0; i < N; i++) { base[i * 3] = pos.getX(i); base[i * 3 + 1] = pos.getY(i); base[i * 3 + 2] = pos.getZ(i); }
    const corner = new Int32Array(N * 3).fill(-1), bary = new Float32Array(N * 3), sign = new Int8Array(N);
    const corner2 = new Int32Array(N * 3).fill(-1), bary2 = new Float32Array(N * 3), sign2 = new Int8Array(N);
    const cornerB = new Int32Array(N * 3).fill(-1), baryB = new Float32Array(N * 3), signB = new Int8Array(N);
    for (let i = 0; i < N; i++) {
      p.set(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
      // anchor 1: the nearest fabric
      let first = -1;
      if (bvh && bvh.closestPointToPoint(p, hit, 0, HAIR_RIDE_REACH) && makeAnchor(hit.faceIndex, hit.point, corner, bary, sign, i)) { first = hit.faceIndex; anchored++; }
      // skin anchor: the nearest skin within reach (fabric or not - a strand
      // on a bare shoulder has no fabric, one over a bra band has both)
      if (partOf && body.bvh.closestPointToPoint(p, bhit, 0, HAIR_RIDE_REACH) && makeBodyAnchor(bhit.faceIndex, bhit.point, cornerB, baryB, signB, i)) skin++;
      // anchor 2: the fabric directly beneath, along the inward radial - the
      // surface the parity verdict measures against. DISABLED (Magnus, on the
      // desktop app: "still melts on both shoulders, you had it right but
      // changed something" - the build before this anchor was the one that
      // was right). It took the idle residual from 41 to 33 in the numbers
      // and pushed shoulder strands along a fold wall's normal on screen. A
      // sideways ray from a strand on the shoulder does not find the fabric
      // under that strand. Kept behind HAIR_RIDE_SECOND_ANCHOR for the record.
      _rd.set(-p.x, 0, -p.z);
      if (HAIR_RIDE_SECOND_ANCHOR && bvh && _rd.lengthSq() > 1e-8) {
        ray.origin.copy(p); ray.direction.copy(_rd.normalize());
        const hits = bvh.raycast(ray, THREE.DoubleSide);
        let near = null;
        for (const x of hits) { if (x.distance <= 1e-6 || x.distance > HAIR_RIDE_REACH) continue; if (!near || x.distance < near.distance) near = x; }
        if (near && near.faceIndex !== first && makeAnchor(near.faceIndex, near.point, corner2, bary2, sign2, i)) second++;
      }
    }
    e.ride = { base, corner, bary, sign, corner2, bary2, sign2, cornerB, baryB, signB };
  }
  rideState.set(store, {
    cloth, cvMesh: Int32Array.from(cvMesh), cvVi: Uint32Array.from(cvVi), posed: new Float32Array(cvMesh.length * 3),
    bodyParts: bodyOk ? body.parts : null, bvPart: Int32Array.from(bvPart), bvLocal: Uint32Array.from(bvLocal), bvBase: Float32Array.from(bvBase), bposed: new Float32Array(bvPart.length * 3),
    paused: false, lastPushed: 0,
  });
  return { anchored, second, skin, total, clothVertices: cvMesh.length, skinVertices: bvPart.length };
}

const HAIR_RIDE_PAUSE_MAX_MS = 15000;   // no export takes this long; a pause older than this was never resumed
export function pauseHairRide(store, paused) {
  const st = rideState.get(store); if (!st) return;
  st.paused = !!paused;
  st.pausedAt = paused ? performance.now() : 0;
  if (paused) restoreHairRide(store);
}
// What the ride is doing right now, for the render loop's watchdog and for
// window.__skinDebug.hairRideStatus. Session 174: Magnus saw the hair melt
// again "suddenly" with the resume fix deployed; the layer must say WHY it
// is not correcting instead of silently doing nothing.
const rideStatusOf = (state, extra) => {
  const s = Object.assign({ state, at: performance.now() }, extra || {});
  if (typeof window !== "undefined" && window.__skinDebug) window.__skinDebug.hairRideStatus = s;
  return s;
};

export function restoreHairRide(store) {
  for (const entries of Object.values(store || {})) for (const e of (entries || [])) {
    if (!e.ride || !e.mesh) continue;
    const pos = e.mesh.geometry.attributes.position, base = e.ride.base;
    for (let i = 0; i < pos.count; i++) pos.setXYZ(i, base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
    pos.needsUpdate = true;
  }
}

// Per frame, after the mixer and after root.updateMatrixWorld(true).
export function rideHairOnCloth(store) {
  const st = rideState.get(store);
  if (!st) { rideStatusOf("no-anchors"); return null; }
  if (st.paused) {
    if (performance.now() - st.pausedAt > HAIR_RIDE_PAUSE_MAX_MS) {
      // safety net: whatever paused the ride never resumed it
      st.paused = false; st.pausedAt = 0;
      console.warn(`[bodyLayers] hair ride was left paused for ${(HAIR_RIDE_PAUSE_MAX_MS / 1000).toFixed(0)}s+ (an export that never resumed it) - resuming on its own.`);
    } else { rideStatusOf("paused", { forMs: Math.round(performance.now() - st.pausedAt) }); return null; }
  }
  const { cloth, cvMesh, cvVi, posed, bodyParts, bvPart, bvLocal, bvBase, bposed } = st;
  let skeleton = null;
  for (const m of cloth) { skeleton = m.skeleton; break; }
  if (!skeleton && bodyParts) for (const m of bodyParts) { skeleton = m.skeleton; break; }
  if (!skeleton) return null;
  skeleton.update();
  // pose the anchored cloth vertices
  for (let k = 0; k < cvMesh.length; k++) {
    const m = cloth[cvMesh[k]], vi = cvVi[k], pos = m.geometry.attributes.position;
    ridePose(m, vi, pos.getX(vi), pos.getY(vi), pos.getZ(vi), _rP);
    posed[k * 3] = _rP.x; posed[k * 3 + 1] = _rP.y; posed[k * 3 + 2] = _rP.z;
  }
  // and the anchored skin vertices, from the intact MORPHED bind positions
  // (the GPU adds the morphs before skinning; the merged surface has them in)
  if (bodyParts) for (let k = 0; k < bvPart.length; k++) {
    const m = bodyParts[bvPart[k]];
    if (m.skeleton !== skeleton) m.skeleton.update();
    ridePose(m, bvLocal[k], bvBase[k * 3], bvBase[k * 3 + 1], bvBase[k * 3 + 2], _rP);
    bposed[k * 3] = _rP.x; bposed[k * 3 + 1] = _rP.y; bposed[k * 3 + 2] = _rP.z;
  }
  let checked = 0, pushed = 0, deepest = 0;
  for (const entries of Object.values(store || {})) for (const e of (entries || [])) {
    const r = e.ride; if (!r || !e.mesh) continue;
    const mesh = e.mesh, pos = mesh.geometry.attributes.position, N = pos.count;
    if (mesh.skeleton !== skeleton) mesh.skeleton.update();
    let touched = 0;
    const planes = [[r.corner, r.bary, r.sign, posed], [r.corner2, r.bary2, r.sign2, posed], [r.cornerB, r.baryB, r.signB, bposed]];
    for (let i = 0; i < N; i++) {
      const bx = r.base[i * 3], by = r.base[i * 3 + 1], bz = r.base[i * 3 + 2];
      if (r.corner[i * 3] < 0 && r.corner2[i * 3] < 0 && r.cornerB[i * 3] < 0) continue;
      checked++;
      ridePose(mesh, i, bx, by, bz, _rP);
      // every plane; a push from one moves the point the next sees
      _rd.set(0, 0, 0); let need = 0;
      for (const [corner, bary, sign, table] of planes) {
        const c0 = corner[i * 3]; if (c0 < 0) continue;
        const c1 = corner[i * 3 + 1], c2 = corner[i * 3 + 2];
        _rc0.fromArray(table, c0 * 3); _rc1.fromArray(table, c1 * 3); _rc2.fromArray(table, c2 * 3);
        _rA.copy(_rc0).multiplyScalar(bary[i * 3]).addScaledVector(_rc1, bary[i * 3 + 1]).addScaledVector(_rc2, bary[i * 3 + 2]);
        _rn.crossVectors(_re1.subVectors(_rc1, _rc0), _re2.subVectors(_rc2, _rc0));
        if (_rn.lengthSq() === 0) continue;
        _rn.normalize().multiplyScalar(sign[i]);
        const d = _rA.subVectors(_rP, _rA).dot(_rn);   // _rA now holds P - A
        if (d >= HAIR_RIDE_GAP) continue;
        const push = HAIR_RIDE_GAP - d;
        _rP.addScaledVector(_rn, push); _rd.addScaledVector(_rn, push); need += push;
      }
      if (need === 0) {
        if (pos.getX(i) !== bx || pos.getY(i) !== by || pos.getZ(i) !== bz) { pos.setXYZ(i, bx, by, bz); touched++; }
        continue;
      }
      pushed++; if (need > deepest) deepest = need;
      // posed-space push -> bind space through the inverse skinning matrix
      rideMatrix(mesh, i, _rM).invert();
      const m = _rM.elements;
      const dx = m[0] * _rd.x + m[4] * _rd.y + m[8] * _rd.z;
      const dy = m[1] * _rd.x + m[5] * _rd.y + m[9] * _rd.z;
      const dz = m[2] * _rd.x + m[6] * _rd.y + m[10] * _rd.z;
      pos.setXYZ(i, bx + dx, by + dy, bz + dz);
      touched++;
    }
    if (touched) pos.needsUpdate = true;
  }
  st.lastPushed = pushed;
  const stats = { checked, pushed, deepestMm: +(deepest * 1000).toFixed(1) };
  if (typeof window !== "undefined" && window.__skinDebug) window.__skinDebug.hairRide = stats;
  if (checked === 0) { rideStatusOf("no-anchors", stats); return null; }   // every entry lost its anchors (a manual fit) and no settle followed
  rideStatusOf("running", stats);
  return stats;
}
