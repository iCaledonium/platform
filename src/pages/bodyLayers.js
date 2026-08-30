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
    if (!ArrayBuffer.isView(geo.userData.fullIndex)) geo.userData.fullIndex = geo.index.array.slice();
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
        ray.origin.copy(pos).addScaledVector(nrm, 0.003); // start just off the skin
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
export function suspendSkinLayers(root) {
  if (!root) return () => {};
  for (const mesh of bodyMeshes(root)) {
    const full = mesh.geometry.userData.fullIndex;
    if (ArrayBuffer.isView(full) && mesh.geometry.index.count !== full.length) {
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
const HAIR_CLEARANCE = 0.004;   // hair rests ~4mm proud of cloth
const HAIR_SEARCH = 0.06;       // strands deeper than 6cm inside are left alone
const HAIR_MAX_LIFT = 0.08;     // and no vertex teleports

export function fitOuterLayers(root, store) {
  const clothing = [];
  const hair = [];
  for (const [url, entries] of Object.entries(store || {})) {
    const meshes = (entries || []).filter((e) => e.mesh && e.mesh.visible !== false);
    if (url.includes("/torso/") || url.includes("/legs/")) clothing.push(...meshes);
    else if (url.includes("/head/hair/")) hair.push(...entries.filter((e) => e.mesh));
  }
  if (!clothing.length || !hair.length) return [];

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
  if (!tri.length) return [];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3));
  const bvh = new MeshBVH(g);

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3(), h = new THREE.Vector3(), v = new THREE.Vector3();
  const hit = {};
  const faceNormal = (fi) => {
    a.fromArray(tri, fi * 9); b.fromArray(tri, fi * 9 + 3); c.fromArray(tri, fi * 9 + 6);
    n.subVectors(b, a).cross(v.subVectors(c, a)).normalize();
    // Winding is not trusted: orient the normal outward from the torso axis,
    // which for a worn garment is always the right way to lift.
    h.set(hit.point.x, 0, hit.point.z);
    if (h.lengthSq() > 1e-8 && n.dot(h) < 0) n.negate();
    return n;
  };

  const touched = [];
  const t0 = performance.now();
  let movedTotal = 0;

  for (const entry of hair) {
    const geo = entry.mesh.geometry;
    const pos = geo.attributes.position;
    if (!pos) continue;

    const disp = new Float32Array(pos.count * 3);
    let moved = 0;
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      const res = bvh.closestPointToPoint(v, hit, 0, HAIR_SEARCH);
      if (!res) continue;
      const fn = faceNormal(hit.faceIndex);
      const depth = v.sub(hit.point).dot(fn);   // + outside, - beneath the cloth
      if (depth >= HAIR_CLEARANCE || depth < -HAIR_SEARCH) continue;
      const lift = Math.min(HAIR_CLEARANCE - depth, HAIR_MAX_LIFT);
      disp[i * 3] = fn.x * lift; disp[i * 3 + 1] = fn.y * lift; disp[i * 3 + 2] = fn.z * lift;
      moved++;
    }
    if (!moved) continue;

    // Smooth through the strand topology — two passes of neighbour averaging,
    // so a lifted ribbon carries its neighbours with it instead of kinking at
    // the first untouched vertex.
    if (geo.index) {
      const adj = new Map();
      const link = (x, y) => {
        (adj.get(x) || adj.set(x, new Set()).get(x)).add(y);
      };
      for (let i = 0; i < geo.index.count; i += 3) {
        const x = geo.index.getX(i), y = geo.index.getX(i + 1), z = geo.index.getX(i + 2);
        link(x, y); link(y, x); link(y, z); link(z, y); link(x, z); link(z, x);
      }
      for (let pass = 0; pass < 2; pass++) {
        const next = disp.slice();
        for (const [i, ns] of adj) {
          let sx = 0, sy = 0, sz = 0;
          for (const j of ns) { sx += disp[j * 3]; sy += disp[j * 3 + 1]; sz += disp[j * 3 + 2]; }
          const k = ns.size;
          next[i * 3] = 0.5 * disp[i * 3] + 0.5 * (sx / k);
          next[i * 3 + 1] = 0.5 * disp[i * 3 + 1] + 0.5 * (sy / k);
          next[i * 3 + 2] = 0.5 * disp[i * 3 + 2] + 0.5 * (sz / k);
        }
        disp.set(next);
      }
    }

    for (let i = 0; i < pos.count; i++) {
      if (!disp[i * 3] && !disp[i * 3 + 1] && !disp[i * 3 + 2]) continue;
      pos.setXYZ(i, pos.getX(i) + disp[i * 3], pos.getY(i) + disp[i * 3 + 1], pos.getZ(i) + disp[i * 3 + 2]);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals?.();
    movedTotal += moved;
    touched.push(entry);
  }

  if (movedTotal) {
    console.log(`[bodyLayers] hair layered over clothing: ${movedTotal} vertex(es) lifted ` +
      `across ${touched.length} hair primitive(s) in ${(performance.now() - t0).toFixed(0)}ms.`);
  }
  return touched;
}
