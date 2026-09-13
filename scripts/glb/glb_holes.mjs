// Per body primitive: positions vs vertices referenced by the index. A gap = holes baked in.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(),
});
for (const file of process.argv.slice(2)) {
  let doc;
  try { doc = await io.read(file); } catch (e) { console.log(`${file}: ${e.message}`); continue; }
  console.log(`== ${file}`);
  const root = doc.getRoot();
  for (const node of root.listNodes()) {
    const mesh = node.getMesh(); if (!mesh) continue;
    const isAcc = node.getExtras()?.isAccessoryMesh;
    let pi = 0;
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION"); const idx = prim.getIndices();
      const n = pos ? pos.getCount() : 0; let used = "-";
      if (idx) { const a = idx.getArray(); const s = new Set(); for (let i = 0; i < a.length; i++) s.add(a[i]); used = s.size; }
      const mat = prim.getMaterial()?.getName() || "?";
      const ex = Object.keys(prim.getExtras() || {}).join(",");
      console.log(`${isAcc ? "ACC " : "BODY"} ${node.getName()}[${pi++}] mat=${mat} pos=${n} used=${used} idx=${idx ? idx.getCount() : "none"} extras=${ex}`);
    }
  }
}
