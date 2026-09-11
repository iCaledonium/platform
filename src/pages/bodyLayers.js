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
const HAIR_CLEARANCE = 0.004;   // hair rests ~4mm proud of cloth, and of skin
const HAIR_SEARCH = 0.15;       // a strand up to 15cm beneath the cloth is still brought out (parity makes "beneath" reliable; 4 of Lindsey's sat 8-11cm in)
const HAIR_MAX_LIFT = 0.08;     // and no vertex teleports
const HAIR_MAX_PASSES = 4;      // lift+smooth rounds before the assertion takes over
const HAIR_FEATHER = 4;         // neighbour rings relaxed around a pinned vertex
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
export function fitOuterLayers(root, store, body = null) {
  const clothing = [];
  const hair = [];
  for (const [url, entries] of Object.entries(store || {})) {
    const meshes = (entries || []).filter((e) => e.mesh && e.mesh.visible !== false);
    if (url.includes("/torso/") || url.includes("/legs/")) clothing.push(...meshes);
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
  let cbvh = null;
  if (tri.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3));
    cbvh = new MeshBVH(g);
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
  const clothNormal = (fi) => {
    a.fromArray(tri, fi * 9); b.fromArray(tri, fi * 9 + 3); c.fromArray(tri, fi * 9 + 6);
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
  const evaluate = (p) => {
    if (bbvh && bbvh.closestPointToPoint(p, bt, 0, HAIR_BODY_SEARCH) && insideBody(p)) {
      const fn = bodyNormal(bt.faceIndex);
      if (fn) {
        lift.copy(bt.point).addScaledVector(fn, HAIR_CLEARANCE).sub(p);
        if (lift.length() > HAIR_MAX_LIFT) lift.setLength(HAIR_MAX_LIFT);
        return 1;
      }
    }
    if (cbvh) {
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
          lift.copy(far.point).addScaledVector(ray.direction, HAIR_CLEARANCE).sub(p);
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
      if (cbvh.closestPointToPoint(p, hit, 0, HAIR_CLEARANCE)) {
        const fn = clothNormal(hit.faceIndex);
        if (fn.dot(tmp.subVectors(p, hit.point)) < 0) fn.negate();
        lift.copy(fn).multiplyScalar(HAIR_CLEARANCE - hit.distance);
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
    const scalp = new Uint8Array(N);
    if (bbvh) {
      for (let i = 0; i < N; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        if (bbvh.closestPointToPoint(v, bt, 0, HAIR_BODY_SEARCH) && bodyZoneAt(bt.faceIndex) === "head" && insideBody(v)) scalp[i] = 1;
      }
    }

    // Strand topology, once, for the smoothing and the feather.
    let adj = null;
    if (geo.index) {
      adj = Array.from({ length: N }, () => new Set());
      for (let i = 0; i < geo.index.count; i += 3) {
        const x = geo.index.getX(i), y = geo.index.getX(i + 1), z = geo.index.getX(i + 2);
        adj[x].add(y); adj[x].add(z); adj[y].add(x); adj[y].add(z); adj[z].add(x); adj[z].add(y);
      }
    }

    const disp = new Float32Array(N * 3);
    const kindOf = new Uint8Array(N);   // 1 skin, 2 cloth (violations), 3 clearance nudge
    const computeField = () => {
      disp.fill(0); kindOf.fill(0);
      let skin = 0, cloth = 0, near = 0;
      for (let i = 0; i < N; i++) {
        if (scalp[i]) continue;
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        const kind = evaluate(v);
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
    const apply = (field) => {
      let moved = 0;
      for (let i = 0; i < N; i++) {
        const dx = field[i * 3], dy = field[i * 3 + 1], dz = field[i * 3 + 2];
        if (dx === 0 && dy === 0 && dz === 0) continue;
        pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i) + dz);
        moved++;
      }
      return moved;
    };

    let counts = computeField();
    const initial = counts;
    if (!initial.total) continue;
    const trace = [`${initial.cloth}c/${initial.skin}s (+${initial.near} within clearance, nudged only)`];   // per-stage counts, for the log line

    // 1. Converge: lift, smooth, apply, re-measure.
    let passes = 0;
    while (counts.total > 0 && passes < HAIR_MAX_PASSES) {
      const moved = apply(smoothed(disp));
      passes++;
      counts = computeField();
      trace.push(`p${passes}:${moved}m>${counts.cloth}c/${counts.skin}s`);
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
      counts = computeField();
      trace.push(`feather:${pinned}pin>${counts.cloth}c/${counts.skin}s`);
      if (counts.total > 0) {
        raw = counts.total;
        let moved = 0;
        for (let i = 0; i < N; i++) {
          if (kindOf[i] !== 1 && kindOf[i] !== 2) continue;
          pos.setXYZ(i, pos.getX(i) + disp[i * 3], pos.getY(i) + disp[i * 3 + 1], pos.getZ(i) + disp[i * 3 + 2]);
          moved++;
        }
        counts = computeField();
        trace.push(`raw:${moved}m>${counts.cloth}c/${counts.skin}s`);
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
