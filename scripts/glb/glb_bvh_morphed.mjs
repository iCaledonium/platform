// Replicates getBodySurfaceBVH: the five skin primitives merged, morph weights from the file applied, MeshBVH built.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import * as THREE from "three";
import { MeshBVH, getBVHExtremes } from "three-mesh-bvh";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
for (const file of process.argv.slice(2)) {
  const doc = await io.read(file);
  const pos = [], idx = []; let off = 0; const parts = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh(); if (!mesh || node.getExtras()?.isAccessoryMesh || !/^Genesis9(_[0-9])?$/.test(node.getName())) continue;
    const w = mesh.getWeights(); const prim = mesh.listPrimitives()[0];
    const p = Float32Array.from(prim.getAttribute("POSITION").getArray()); const n = p.length / 3;
    let maxW = 0, nanW = 0; const targets = prim.listTargets();
    for (let m = 0; m < targets.length; m++) { const wm = w[m] || 0; if (Number.isNaN(wm)) nanW++; maxW = Math.max(maxW, Math.abs(wm)); if (!wm) continue; const d = targets[m].getAttribute("POSITION")?.getArray(); if (!d) continue; for (let i = 0; i < p.length; i++) p[i] += d[i] * wm; }
    let nan = 0, big = 0; for (let i = 0; i < p.length; i++) { if (Number.isNaN(p[i])) nan++; else if (Math.abs(p[i]) > 5) big++; pos.push(p[i]); }
    for (const i of prim.getIndices().getArray()) idx.push(i + off);
    parts.push(`${node.getName()}:${n}v w=${w.length} max|w|=${maxW.toFixed(2)} nanW=${nanW} nanPos=${nan} |pos|>5m=${big}`);
    off += n;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  const warns = []; const ow = console.warn; console.warn = (...a) => warns.push(a.join(" "));
  const t0 = performance.now(); const bvh = new MeshBVH(g); const ms = performance.now() - t0; console.warn = ow;
  const ex = getBVHExtremes(bvh)[0];
  // and a raycast timing like the shrinkwrap would do: 2000 rays from around the hips
  const ray = new THREE.Ray(new THREE.Vector3(0, 0.95, 0.3), new THREE.Vector3(0, 0, -1)); const t1 = performance.now();
  for (let i = 0; i < 2000; i++) { ray.origin.x = (i / 2000 - 0.5) * 0.4; bvh.raycastFirst(ray, THREE.DoubleSide); }
  console.log(`${file.split("/").pop()}: ${parts.join(" | ")} | tris=${idx.length / 3} BVH ${ms.toFixed(0)}ms depth ${ex.depth.min}-${ex.depth.max} leaf ${ex.primitives.min}-${ex.primitives.max} warns=${warns.length} ${warns[0] || ""} | 2000 rays ${(performance.now() - t1).toFixed(0)}ms`);
}
