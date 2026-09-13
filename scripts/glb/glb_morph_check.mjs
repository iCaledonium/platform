// Morph-target sanity per body primitive: NaN / magnitude, split by vertices that WERE referenced in a
// reference (holed) file vs those that were not. Usage: node glb_morph_check.mjs file.glb [holed.glb]
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
const [file, holedFile] = process.argv.slice(2);
const prims = (doc) => { const m = new Map(); for (const n of doc.getRoot().listNodes()) { const mesh = n.getMesh(); if (!mesh || n.getExtras()?.isAccessoryMesh || !/^Genesis9(_[0-9])?$/.test(n.getName())) continue; m.set(n.getName(), mesh.listPrimitives()[0]); } return m; };
const doc = await io.read(file); const P = prims(doc);
const H = holedFile ? prims(await io.read(holedFile)) : null;
for (const [name, prim] of P) {
  const n = prim.getAttribute("POSITION").getCount();
  const used = new Uint8Array(n); if (H && H.get(name)) for (const i of H.get(name).getIndices().getArray()) used[i] = 1; else used.fill(1);
  let nanU = 0, nanN = 0, maxU = 0, maxN = 0, targets = 0, otherAttrs = [];
  for (const t of prim.listTargets()) {
    targets++;
    const a = t.getAttribute("POSITION"); if (!a) continue; const arr = a.getArray();
    for (let i = 0; i < n; i++) { const d = Math.hypot(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]); if (Number.isNaN(d)) { used[i] ? nanU++ : nanN++; continue; } if (used[i]) maxU = Math.max(maxU, d); else maxN = Math.max(maxN, d); }
  }
  for (const s of prim.listSemantics()) if (s !== "POSITION") { const arr = prim.getAttribute(s).getArray(); let nan = 0, sumZeroN = 0; for (let i = 0; i < arr.length; i++) if (Number.isNaN(arr[i])) nan++; if (s === "WEIGHTS_0") { for (let i = 0; i < n; i++) { if (used[i]) continue; const w = arr[i * 4] + arr[i * 4 + 1] + arr[i * 4 + 2] + arr[i * 4 + 3]; if (w < 0.5) sumZeroN++; } } otherAttrs.push(`${s}${nan ? ` NaN=${nan}` : ""}${s === "WEIGHTS_0" ? ` unrefWeightSum<0.5=${sumZeroN}` : ""}`); }
  const unref = used.reduce((s, v) => s + (v ? 0 : 1), 0);
  console.log(`${name}: ${n} v (${unref} were unreferenced), ${targets} targets | referenced: NaN=${nanU} max|delta|=${(maxU * 100).toFixed(1)}cm | unreferenced: NaN=${nanN} max|delta|=${(maxN * 100).toFixed(1)}cm | ${otherAttrs.join(", ")}`);
}
