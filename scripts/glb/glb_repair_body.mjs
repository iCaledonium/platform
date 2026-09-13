// Restore a culled Genesis 9 body index from an intact donor of the same base mesh.
// Genesis 9 UVs are per base vertex and identical across characters (morphs move positions only),
// so (u,v) within a material identifies a vertex; where UVs repeat (seam duplicates) the patient's
// SURVIVING triangles propagate the correspondence along shared edges. Donor triangles are then
// re-expressed in the patient's numbering. The patient's own surviving triangles always win: a quad
// the two exports triangulated along different diagonals keeps the patient's split, and a region
// the donor cannot map (the merged mouth cavity, whose UVs differ) is kept exactly as the patient has
// it - legal only if none of its vertices sit in a hole, which is asserted. Every patient attribute
// (positions, morphs, weights) is untouched. Usage: node glb_repair_body.mjs donor.glb patient.glb [out.glb]
import { NodeIO, VertexLayout } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().setVertexLayout(VertexLayout.SEPARATE).registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
const [donorFile, patientFile, outFile] = process.argv.slice(2);
const bodyPrims = (doc) => {
  const out = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh(); if (!mesh || node.getExtras()?.isAccessoryMesh) continue;
    if (!/^Genesis/.test(node.getName())) continue;
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION"), uv = prim.getAttribute("TEXCOORD_0"), idx = prim.getIndices();
      if (!pos || !uv || !idx) continue;
      out.push({ node: node.getName(), mat: prim.getMaterial()?.getName() || "?", n: pos.getCount(), pos: pos.getArray(), uv: uv.getArray(), idx: idx.getArray(), prim });
    }
  }
  return out;
};
const key = (uv, i) => `${Math.round(uv[i * 2] * 1e5)},${Math.round(uv[i * 2 + 1] * 1e5)}`;
const triKey = (a, b, c) => [a, b, c].sort((x, y) => x - y).join(",");
const edgeKey = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
const donorDoc = await io.read(donorFile), patientDoc = await io.read(patientFile);
const donor = bodyPrims(donorDoc), patient = bodyPrims(patientDoc);
let ok = true, repaired = 0;
for (const p of patient) {
  const used = new Set(p.idx); if (used.size === p.n) { console.log(`${p.node} ${p.mat}: intact (${p.n} vertices all referenced)`); continue; }
  const combos = [];
  for (let i = 0; i < donor.length; i++) {
    if (donor[i].n === p.n) combos.push([donor[i]]);
    for (let j = i + 1; j < donor.length; j++) if (donor[i].n + donor[j].n === p.n) combos.push([donor[i], donor[j]], [donor[j], donor[i]]);
  }
  const ptris = []; for (let t = 0; t < p.idx.length; t += 3) ptris.push([p.idx[t], p.idx[t + 1], p.idx[t + 2]]);
  let best = null;
  for (const parts of combos) {
    const D = parts.reduce((s, d) => s + d.n, 0);
    const duv = new Map(); const tris = []; let off = 0;
    for (const d of parts) {
      for (let i = 0; i < d.n; i++) { const k = key(d.uv, i); (duv.get(k) || duv.set(k, []).get(k)).push(off + i); }
      for (let t = 0; t < d.idx.length; t += 3) tris.push([d.idx[t] + off, d.idx[t + 1] + off, d.idx[t + 2] + off]);
      off += d.n;
    }
    const dedge = new Map();
    for (const [a, b, c] of tris) for (const [x, y, z] of [[a, b, c], [b, c, a], [c, a, b]]) { const k = edgeKey(x, y); (dedge.get(k) || dedge.set(k, []).get(k)).push(z); }
    const puv = new Map();
    for (let i = 0; i < p.n; i++) { const k = key(p.uv, i); (puv.get(k) || puv.set(k, []).get(k)).push(i); }
    const p2d = new Int32Array(p.n).fill(-1), d2p = new Int32Array(D).fill(-1);
    const assign = (pi, di) => { p2d[pi] = di; d2p[di] = pi; };
    let seeds = 0;
    for (const [k, pids] of puv) { const dids = duv.get(k); if (pids.length === 1 && dids && dids.length === 1) { assign(pids[0], dids[0]); seeds++; } }
    let propagated = 0, changed = true;
    while (changed) {
      changed = false;
      for (const [a, b, c] of ptris) for (const [x, y, z] of [[a, b, c], [b, c, a], [c, a, b]]) {
        if (p2d[z] !== -1 || p2d[x] === -1 || p2d[y] === -1) continue;
        const thirds = (dedge.get(edgeKey(p2d[x], p2d[y])) || []).filter((v) => d2p[v] === -1);
        const kz = key(p.uv, z);
        const uvOk = thirds.filter((v) => duv.get(kz)?.includes(v));
        const pick = uvOk.length === 1 ? uvOk[0] : (thirds.length === 1 ? thirds[0] : null);
        if (pick !== null) { assign(z, pick); propagated++; changed = true; }
      }
    }
    // unmapped vertices are acceptable only where the patient still has them (never in a hole)
    let unmapped = 0, unmappedInHole = 0;
    for (let i = 0; i < p.n; i++) if (p2d[i] === -1) { unmapped++; if (!used.has(i)) unmappedInHole++; }
    // rebuilt = donor triangles with all corners mapped
    const out = new Map(); let dropped = 0;
    for (const [a, b, c] of tris) { if (d2p[a] < 0 || d2p[b] < 0 || d2p[c] < 0) { dropped++; continue; } const t = [d2p[a], d2p[b], d2p[c]]; out.set(triKey(...t), t); }
    // the patient's surviving triangles win: flipped quads swap the donor's split for the patient's
    const missing = ptris.filter((t) => !out.has(triKey(...t)));
    let flips = 0, kept = 0, unexplained = 0;
    const byEdge = new Map();
    for (const t of missing) for (const [x, y] of [[t[0], t[1]], [t[1], t[2]], [t[0], t[2]]]) { const k = edgeKey(x, y); (byEdge.get(k) || byEdge.set(k, []).get(k)).push(t); }
    const done = new Set();
    for (const t of missing) {
      const tk = triKey(...t); if (done.has(tk)) continue;
      if (t.some((v) => p2d[v] === -1)) { out.set(tk, t); done.add(tk); kept++; continue; }   // unmappable region: keep as is
      let partner = null;
      for (const [x, y] of [[t[0], t[1]], [t[1], t[2]], [t[0], t[2]]]) for (const u of byEdge.get(edgeKey(x, y)) || []) if (triKey(...u) !== tk && !done.has(triKey(...u))) partner = partner || u;
      if (partner) {
        const quad = new Set([...t, ...partner]);
        const donorPair = [...out.values()].filter((d) => d.every((v) => quad.has(v)));
        if (quad.size === 4 && donorPair.length === 2) {
          for (const d of donorPair) out.delete(triKey(...d));
          out.set(tk, t); out.set(triKey(...partner), partner); done.add(tk); done.add(triKey(...partner)); flips++; continue;
        }
      }
      // lone flip: the partner triangle sits in the hole, so only this half of the quad survived.
      // The donor pair covering the same four vertices is replaced by this triangle plus the
      // complementary one on the patient's diagonal, wound to agree with the donor's facing.
      const around = [...out.values()].filter((d) => d.filter((v) => t.includes(v)).length >= 2);
      let fixed = false;
      for (let i = 0; i < around.length && !fixed; i++) for (let j = i + 1; j < around.length && !fixed; j++) {
        const quad = new Set([...around[i], ...around[j]]);
        if (quad.size !== 4 || !t.every((v) => quad.has(v))) continue;
        const d = [...quad].find((v) => !t.includes(v));
        const shared = around[i].filter((v) => around[j].includes(v));          // donor diagonal
        const o = t.filter((v) => !shared.includes(v));                          // patient's diagonal ends...
        const diag = [...quad].filter((v) => !shared.includes(v));               // the other two quad vertices
        if (diag.length !== 2 || !diag.every((v) => t.includes(v))) continue;   // T must carry the other diagonal
        const tp = [diag[0], diag[1], d];
        const nrm = (tri) => { const [a, b, c] = tri.map((v) => [p.pos[v * 3], p.pos[v * 3 + 1], p.pos[v * 3 + 2]]); const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; };
        const ref = nrm(around[i]), n1 = nrm(tp);
        if (ref[0] * n1[0] + ref[1] * n1[1] + ref[2] * n1[2] < 0) tp.reverse();
        out.delete(triKey(...around[i])); out.delete(triKey(...around[j]));
        out.set(tk, t); out.set(triKey(...tp), tp); done.add(tk); flips++; fixed = true; void o;
      }
      if (fixed) continue;
      out.set(tk, t); done.add(tk); unexplained++;
    }
    const newIdx = new Uint32Array(out.size * 3); let w = 0; for (const t of out.values()) { newIdx[w++] = t[0]; newIdx[w++] = t[1]; newIdx[w++] = t[2]; }
    const ref = new Set(newIdx); const unreferenced = p.n - ref.size;
    const elen = (i, j) => Math.hypot(p.pos[i * 3] - p.pos[j * 3], p.pos[i * 3 + 1] - p.pos[j * 3 + 1], p.pos[i * 3 + 2] - p.pos[j * 3 + 2]);
    let maxNew = 0, maxOld = 0;
    for (let t = 0; t < newIdx.length; t += 3) maxNew = Math.max(maxNew, elen(newIdx[t], newIdx[t + 1]), elen(newIdx[t + 1], newIdx[t + 2]), elen(newIdx[t], newIdx[t + 2]));
    for (const [a, b, c] of ptris) maxOld = Math.max(maxOld, elen(a, b), elen(b, c), elen(a, c));
    const r = { parts: parts.map((d) => d.mat).join("+"), seeds, propagated, unmapped, unmappedInHole, dropped, flips, kept, unexplained, unreferenced, tris: out.size, donorTris: tris.length, newIdx, maxNew, maxOld };
    if (!best || (r.unreferenced + r.unexplained + r.unmappedInHole) < (best.unreferenced + best.unexplained + best.unmappedInHole)) best = r;
  }
  if (!best) { console.log(`${p.node} ${p.mat}: NO donor combination sums to ${p.n} vertices`); ok = false; continue; }
  const sound = best.unreferenced === 0 && best.unexplained === 0 && best.unmappedInHole === 0 && best.maxNew <= best.maxOld * 1.5;
  console.log(`${p.node} ${p.mat} (${p.n} v, ${used.size} referenced, ${ptris.length} tris) <- ${best.parts}: seeds=${best.seeds} propagated=${best.propagated} unmapped=${best.unmapped} (in a hole: ${best.unmappedInHole}) donorTrisDropped=${best.dropped} flippedQuads=${best.flips} keptUnmappable=${best.kept} unexplained=${best.unexplained} -> ${best.tris} tris (donor ${best.donorTris}), unreferenced=${best.unreferenced}, longest edge ${(best.maxNew * 1000).toFixed(1)}mm vs ${(best.maxOld * 1000).toFixed(1)}mm ${sound ? "SOUND" : "NOT SOUND"}`);
  if (!sound) { ok = false; continue; }
  if (outFile) { p.prim.getIndices().setArray(best.newIdx); repaired++; }
}
if (outFile) {
  if (!ok) { console.log("refusing to write: not every primitive repaired soundly"); process.exit(2); }
  await io.write(outFile, patientDoc);
  console.log(`wrote ${outFile} (${repaired} primitive(s) repaired)`);
}
