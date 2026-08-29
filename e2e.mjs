import { compressRuntimeGlb } from "./server/ktx2.js";
import fs from "node:fs";
const SRC = "/home/magnus/platform/public/media/actors/lindsey-vaughn-58717f1c/3d/runtime_58717f1c-6007-42c9-af08-b2fe1321daf9.glb";
const T = "/tmp/e2e_runtime.glb";
fs.copyFileSync(SRC, T);
console.log("before:", (fs.statSync(T).size/1e6).toFixed(1), "MB");
const r = await compressRuntimeGlb(T);
console.log("summary:", JSON.stringify(r));
