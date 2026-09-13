// Structural summary for diffing two GLBs: nodes, prims, morph targets, skins, animations, textures, extras.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
const doc = await io.read(process.argv[2]); const r = doc.getRoot();
const ex = (o) => { const e = o.getExtras() || {}; return Object.keys(e).map((k) => `${k}:${JSON.stringify(e[k]).length}`).join(","); };
console.log(`asset ${JSON.stringify(r.getAsset())} extensionsUsed ${r.listExtensionsUsed().map((e) => e.extensionName).join(",")}`);
for (const n of r.listNodes()) {
  const m = n.getMesh(); const s = n.getSkin();
  const prims = m ? m.listPrimitives().map((p) => `${p.getAttribute("POSITION")?.getCount()}v/${p.getIndices()?.getCount()}i/${p.listTargets().length}t/${p.listAttributes().length}a`).join(" ") : "-";
  console.log(`node ${n.getName()} mesh=${m ? m.getName() : "-"} [${prims}] weights=${m ? m.getWeights().length : 0} skin=${s ? s.listJoints().length : "-"} t=${n.getTranslation().map((v) => v.toFixed(4))} extras{${ex(n)}} meshExtras{${m ? ex(m) : ""}}`);
}
for (const a of r.listAnimations()) console.log(`anim ${a.getName()} channels=${a.listChannels().length} samplers=${a.listSamplers().length}`);
console.log(`textures ${r.listTextures().length} materials ${r.listMaterials().length} skins ${r.listSkins().length} accessors ${r.listAccessors().length} buffers ${r.listBuffers().length}`);
