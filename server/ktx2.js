// ── KTX2 compression for the runtime GLB ─────────────────────────────────────
//
// Session 152. The runtime export already strips morph targets and re-encodes
// textures as webp, which got the file from 92 MB to 27 MB. That fixed the
// DOWNLOAD and left the GPU cost untouched, because a GPU cannot sample a webp
// or a JPEG: at upload every texture is decoded to raw RGBA. Measured on
// Lindsey's runtime file, whose textures are 16.9 MB on disk:
//
//     6 x 4096x4096  ->  89 MB each in VRAM
//     1 x 4096x2048  ->  45 MB
//     5 x 2048x2048  ->  22 MB each
//     ...            ->  725 MB for ONE character, ~2.9 GB for four
//
// KTX2/BasisU stays compressed ON the GPU — BasisU transcodes at load to
// whatever the device supports (BC7 desktop, ASTC mobile, ETC2 elsewhere), so
// one asset serves all of them. Measured on the same file:
//
//     KTX2 only            20.9 MB file,  181 MB VRAM   ( 4.0x)
//     KTX2 + 2048 cap      13.9 MB file,   71 MB VRAM   (10.2x)   <- default
//     KTX2 + 1024 cap      11.0 MB file,   19 MB VRAM   (37.2x)
//
// 2048 is the default because this character is looked at from a metre away in
// the door scene. A 4096 albedo is film-resolution for someone who occupies a
// few hundred pixels; 1024 would be defensible for ambient cast.
//
// Verified non-destructive on a rigged character: meshes 33->33, materials
// 33->33, skins 33->33, nodes 295->295, animations ['idle','walk'] preserved.
// gltf-transform only rewrites the texture payloads.
//
// TWO PASSES, and the first is not optional: `ktx` cannot read webp, which is
// exactly what the runtime export writes. Without the decode pass 5 of 15
// textures are skipped with a warning and keep their full uncompressed cost.

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { textureCompress } from "@gltf-transform/functions";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const execFileAsync = promisify(execFile);

// Extracted from the official Khronos release (v4.4.2, sha1-verified against
// the published checksum) into the user's home rather than installed
// system-wide, so removing the directory fully reverses it.
const KTX_HOME = process.env.KTX_HOME
  || path.join(os.homedir(), "opt", "KTX-Software-4.4.2-Linux-x86_64");

export const DEFAULT_TEXTURE_CAP = 2048;

export function ktxAvailable() {
  return fs.existsSync(path.join(KTX_HOME, "bin", "ktx"));
}

/**
 * Rewrite a GLB's textures as KTX2 in place (atomically).
 * Resolves to a summary, or null if the toolchain is unavailable — callers
 * treat that as "keep the uncompressed file", never as a build failure.
 */
export async function compressRuntimeGlb(glbPath, { cap = DEFAULT_TEXTURE_CAP, log = console } = {}) {
  if (!ktxAvailable()) {
    log.warn?.(`[ktx2] ${KTX_HOME}/bin/ktx not found — leaving ${path.basename(glbPath)} uncompressed`);
    return null;
  }

  const sharp = (await import("sharp")).default;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const px = (t) => { const s = t.getSize(); return s ? s[0] * s[1] : 0; };

  const t0 = Date.now();
  const doc = await io.read(glbPath);
  const before = doc.getRoot().listTextures();
  const vramBefore = before.reduce((a, t) => a + px(t) * 4 * 1.33, 0);

  // Pass 1 — decode webp to png so `ktx` can read it, and cap resolution.
  await doc.transform(textureCompress({
    encoder: sharp, targetFormat: "png", slots: /.*/, resize: [cap, cap],
  }));

  const dir = path.dirname(glbPath);
  const stem = path.basename(glbPath, ".glb");
  const tmpDecoded = path.join(dir, `.${stem}.decoded.glb`);
  const tmpOut     = path.join(dir, `.${stem}.ktx2.glb`);

  try {
    await io.write(tmpDecoded, doc);

    // Pass 2 — the CLI owns the ktx invocation; it is not exported from
    // @gltf-transform/functions in v4.
    const bin = path.join(process.cwd(), "node_modules", ".bin", "gltf-transform");
    await execFileAsync(bin, ["etc1s", tmpDecoded, tmpOut, "--quality", "200"], {
      env: {
        ...process.env,
        PATH: `${path.join(KTX_HOME, "bin")}:${process.env.PATH}`,
        LD_LIBRARY_PATH: `${path.join(KTX_HOME, "lib")}:${process.env.LD_LIBRARY_PATH || ""}`,
      },
      maxBuffer: 32 * 1024 * 1024,
    });

    const out = await io.read(tmpOut);
    const post = out.getRoot().listTextures();
    const stillRaw = post.filter((t) => t.getMimeType() !== "image/ktx2");
    if (stillRaw.length) {
      // Not fatal, but it means some textures kept their full VRAM cost and
      // the headline number below would be a lie if it ignored them.
      log.warn?.(`[ktx2] ${stillRaw.length}/${post.length} textures did not convert ` +
        `(${[...new Set(stillRaw.map((t) => t.getMimeType()))].join(", ")})`);
    }
    const vramAfter = post.reduce((a, t) => a + px(t) * 1 * 1.33, 0);

    // Replace only once the new file is complete, so a reader never sees a
    // half-written model.
    fs.renameSync(tmpOut, glbPath);

    const summary = {
      seconds: +((Date.now() - t0) / 1000).toFixed(1),
      bytes: fs.statSync(glbPath).size,
      vramBeforeMB: Math.round(vramBefore / 1e6),
      vramAfterMB: Math.round(vramAfter / 1e6),
      textures: post.length,
      converted: post.length - stillRaw.length,
    };
    log.log?.(`[ktx2] ${path.basename(glbPath)}: ${(summary.bytes / 1e6).toFixed(1)} MB, ` +
      `VRAM ~${summary.vramBeforeMB} -> ~${summary.vramAfterMB} MB ` +
      `(${(vramBefore / vramAfter).toFixed(1)}x), ${summary.converted}/${summary.textures} textures, ` +
      `${summary.seconds}s`);
    return summary;
  } finally {
    for (const f of [tmpDecoded, tmpOut]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
}
