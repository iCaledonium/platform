import * as THREE from "three";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

// ── KTX2 support for every GLTFLoader in the app ─────────────────────────────
//
// Session 152. The runtime GLB export now writes KTX2/BasisU textures (see
// server/ktx2.js — 725 MB of VRAM per character down to 71 MB). A GLTFLoader
// without a KTX2Loader attached cannot read those files AT ALL: it fails the
// whole parse, so every consumer of a runtime model — the door scene, the model
// panel, the mini viewer, the wizard — would break at once. This is not an
// optimisation that degrades gracefully; it is load-bearing.
//
// detectSupport() needs a WebGLRenderer to ask which compressed formats the GPU
// actually has (BC7 on desktop, ASTC on mobile, ETC2 elsewhere) — BasisU
// transcodes to whichever is present. The call sites build their loaders at
// different moments, several before any renderer exists, so rather than thread
// a renderer through eight of them this creates ONE tiny throwaway renderer the
// first time it is needed and reuses the result. One extra WebGL context for
// the life of the tab, against eight call sites that would otherwise each need
// their renderer in scope.
//
// The transcoder is self-hosted from /basis/ (copied out of three's own
// examples) rather than a CDN, so it keeps working offline and cannot drift out
// of step with the bundled three version.

let shared = null;

export function getKtx2Loader() {
  if (shared) return shared;
  try {
    // Small and never rendered to — this exists purely so detectSupport can
    // read the GPU's texture-format extensions.
    const probe = new THREE.WebGLRenderer();
    shared = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(probe);
    probe.dispose();
  } catch (e) {
    console.warn("[ktx2] no WebGL context for format detection — " +
      "KTX2 textures will fail to load:", e?.message || e);
    return null;
  }
  return shared;
}

/**
 * Attach KTX2 support to a GLTFLoader. Safe to call on every loader; returns
 * the same loader so it can be chained onto existing construction.
 */
export function attachKtx2(loader) {
  const ktx2 = getKtx2Loader();
  if (ktx2) loader.setKTX2Loader(ktx2);
  return loader;
}
