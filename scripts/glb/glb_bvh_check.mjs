// Body-mesh sanity + BVH build over the concatenated body: NaNs, degenerate/duplicate triangles, depth extremes.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import * as THREE from "three";
import { MeshBVH, getBVHExtremes } from "three-mesh-bvh";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
for (const file of process.argv.slice(2)) {
  const doc = await io.read(file);
  const pos = [], idx = []; let off = 0, nan = 0, degenerate = 0, longEdge = 0; const seen = new Set(); let dup = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh(); if (!mesh || node.getExtras()?.isAccessoryMesh || !/^Genesis/.test(node.getName())) continue;
    for (const prim of mesh.listPrimitives()) {
      const p = prim.getAttribute("POSITION").getArray(), ix = prim.getIndices().getArray(); const n = p.length / 3;
      for (let i = 0; i < p.length; i++) { if (Number.isNaN(p[i])) nan++; pos.push(p[i]); }
      for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t], b = ix[t + 1], c = ix[t + 2];
        const A = [p[a * 3], p[a * 3 + 1], p[a * 3 + 2]], B = [p[b * 3], p[b * 3 + 1], p[b * 3 + 2]], C = [p[c * 3], p[c * 3 + 1], p[c * 3 + 2]];
        const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        if (Math.hypot(...cr) < 1e-12 || a === b || b === c || a === c) degenerate++;
        const e = Math.max(Math.hypot(...u), Math.hypot(...w), Math.hypot(C[0] - B[0], C[1] - B[1], C[2] - B[2])); if (e > 0.05) longEdge++;
        const k = [a + off, b + off, c + off].sort((x, y) => x - y).join(","); if (seen.has(k)) dup++; else seen.add(k);
        idx.push(a + off, b + off, c + off);
      }
      off += n;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const warns = []; const ow = console.warn; console.warn = (...a) => warns.push(a.join(" "));
  const t0 = performance.now(); const bvh = new MeshBVH(g); const ms = performance.now() - t0;
  console.warn = ow;
  const ex = getBVHExtremes(bvh)[0]; const exs = JSON.stringify(ex);
  console.log(`${file.split("/").pop()}: verts=${off} tris=${idx.length / 3} nan=${nan} degenerate=${degenerate} longEdge>5cm=${longEdge} dup=${dup} | BVH ${ms.toFixed(0)}ms extremes ${exs} warns=${warns.length} ${warns[0] || ""}`);
}
