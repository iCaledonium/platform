// Is a culled body's surviving index a strict subset of an intact donor's, per material, in the
// same vertex order? Prints containment per primitive. Usage: node glb_verify_topology.mjs donor.glb culled.glb
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
const [donorFile, culledFile] = process.argv.slice(2);
const bodyPrims = (doc) => {
  const out = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh(); if (!mesh || node.getExtras()?.isAccessoryMesh) continue;
    for (const prim of mesh.listPrimitives()) out.push({ node: node.getName(), mat: prim.getMaterial()?.getName() || "?", pos: prim.getAttribute("POSITION").getCount(), idx: prim.getIndices()?.getArray() });
  }
  return out;
};
const donor = bodyPrims(await io.read(donorFile));
const culled = bodyPrims(await io.read(culledFile));
const triSet = (idx, offset = 0) => { const s = new Set(); for (let i = 0; i < idx.length; i += 3) { const t = [idx[i] + offset, idx[i + 1] + offset, idx[i + 2] + offset].sort((a, b) => a - b); s.add(t.join(",")); } return s; };
// Donor candidates for a culled prim: the same-size single prim, or a concatenation of consecutive donor prims summing to the size.
for (const c of culled) {
  if (!c.idx) continue;
  const cand = [];
  for (let i = 0; i < donor.length; i++) {
    let sum = 0; const parts = [];
    for (let j = i; j < donor.length && sum < c.pos; j++) { sum += donor[j].pos; parts.push(donor[j]); if (sum === c.pos) cand.push(parts.slice()); }
  }
  const mine = triSet(c.idx);
  let best = null;
  for (const parts of cand) {
    const s = new Set(); let off = 0;
    for (const p of parts) { for (const t of triSet(p.idx, off)) s.add(t); off += p.pos; }
    let hit = 0; for (const t of mine) if (s.has(t)) hit++;
    const r = { parts: parts.map((p) => p.mat).join("+"), donorTris: s.size, mineTris: mine.size, hit };
    if (!best || hit > best.hit) best = r;
  }
  console.log(`${c.node} mat=${c.mat} pos=${c.pos} tris=${mine.size} -> ${best ? `${best.parts}: ${best.hit}/${best.mineTris} contained, donor has ${best.donorTris}` : "NO SIZE MATCH"}`);
}
