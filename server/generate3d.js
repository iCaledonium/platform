/**
 * generate3d.js
 *
 * POST /api/actors/:id/generate-3d   — kicks off the pipeline, returns immediately
 * GET  /api/actors/:id/generate-3d   — poll this for status while it runs
 *
 * Scope for this first pass, deliberately: mesh + rig + face + body shape
 * only. NO animations yet — Idle/Walk attach in a separate follow-up step
 * once this base pipeline is confirmed working end to end.
 *
 * PROVEN tonight, via real curl testing against daz-script-server:
 *   - setSourceImage / windowFilePath direct-set / DzFaceTransferGenerate{Male,Female}Action
 *   - getOptions(settings, false, "") + setIntValue("RunSilent", 1) + writeFile()
 *     on App.getExportMgr().getExporter(0) (DzBlenderExporter) — writes a
 *     working .blend DIRECTLY, no FBX/DTU intermediate needed for this
 *     specific exporter.
 *   - Scene.selectAllNodes(false) before selecting the target node, since
 *     .select(true) alone ADDS to existing selection rather than replacing it.
 *
 * NOT yet proven, built from the same patterns but untested against the
 * real system — verify before trusting in production:
 *   - The exact DazScript property names for Genesis 9 Body Shapes dials
 *     (height / breast size). If this throws, the fix is the same one that
 *     found Face Transfer's real methods: enumerate the actual node's
 *     properties rather than guess a second name.
 *   - SSH/SCP orchestration from this server to the Mac Mini.
 *
 * Photo lookup and GLB storage deliberately reuse the exact same
 * public/media/actors/{media_folder}/... convention already used by the
 * existing photo-upload handler in index.js, rather than inventing a
 * separate asset path — media_folder is already stored on the actors row
 * at creation time, so it's looked up, not recomputed.
 *
 * INTEGRATION NOTE: writes actors.glb_url on success — that column
 * doesn't exist in the schema shown yet. Either add it via migration, or
 * tell me the real column/table you'd rather this land in.
 */

import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import zlib from "zlib";
import fs from "fs";
import crypto from "crypto";
import sharp from "sharp";
import express from "express";
import { compressRuntimeGlb } from "./ktx2.js";
const execAsync = promisify(exec);

const CFG = {
  dazScriptServerUrl: process.env.DAZ_SCRIPT_SERVER_URL || "http://192.168.1.60:18811",
  dazScriptServerToken: process.env.DAZ_SCRIPT_SERVER_TOKEN,
  macMiniHost: process.env.MAC_MINI_SSH_HOST || "192.168.1.60",
  macMiniUser: process.env.MAC_MINI_SSH_USER || "magnusklack",
  // Session 145 — actor work folders live under /DAZ3D/Server on the
  // volume, beside the presets (same root as everything else after the
  // estate consolidation). NOTE: the service env's DAZ_TMP_DIR override
  // beats this default — it must say the same path, or scratch quietly
  // lands wherever the env points (exactly what happened all night with
  // the old /Users override).
  macMiniTmpDir: process.env.DAZ_TMP_DIR || "/Volumes/Extended Mac Mini M4/DAZ3D/Server/tmp",
  // Confirmed real path, Session 96 — note the odd trailing space before
  // ".app" in the actual installed bundle name ("LTS .app", not "LTS.app").
  macMiniBlenderPath: process.env.BLENDER_PATH || "/Applications/Blender 5.2.0 LTS .app/Contents/MacOS/Blender",
  macMiniConvertScript: process.env.CONVERT_SCRIPT_PATH || "/Volumes/Extended Mac Mini M4/DAZ3D/Server/scripts/convert.py",
  // New, Session 96: the Diffeomorphic-based conversion script and the
  // reusable favorite_morphs.json — confirmed agnostic across every
  // Genesis 9 character, not tied to whichever character it was
  // originally saved from (keyed on the base figure's asset path and a
  // mesh-topology fingerprint, both identical for every G9 character).
  macMiniConvertScriptDiffeomorphic: process.env.CONVERT_SCRIPT_DIFFEOMORPHIC_PATH || "/Volumes/Extended Mac Mini M4/DAZ3D/Server/scripts/convert_diffeomorphic.py",
  // Session 97: merges idle/walk Actions into the master .blend as
  // named NLA tracks, exports the one real final GLB. Same
  // SSH/Blender-headless pattern as convertViaDiffeomorphic.
  macMiniMergeAnimationsScript: process.env.MERGE_ANIMATIONS_SCRIPT_PATH || "/Volumes/Extended Mac Mini M4/DAZ3D/Server/scripts/merge_animations.py",
  macMiniFavoritesJsonPath: process.env.FAVORITES_JSON_PATH || "/Volumes/Extended Mac Mini M4/DAZ3D/Server/scripts/favorite_morphs.json",
  // Session 101+: photo-derived body proportions. Same machine, same
  // user — interpret_body.py needs mediapipe/opencv/rembg, already
  // confirmed installed here (Magnus ran it directly in his own
  // terminal on this exact machine to validate Benny/Frida).
  macMiniInterpretBodyScriptPath: process.env.INTERPRET_BODY_SCRIPT_PATH || "/Volumes/Extended Mac Mini M4/DAZ3D/Server/scripts/interpret_body.py",
  // CPU-only rembg (3 photos) + heavy-variant MediaPipe pose detection
  // (3 photos) — real, observed runs on this machine took low tens of
  // seconds; generous headroom rather than the DAZ-script 180s default,
  // since this is a completely different, non-DAZ process.
  interpretBodyTimeoutMs: 120_000,
  // Session 97: idle/walk Pose Presets, applied to every generated woman
  // via App.getContentMgr().openFile(path, true). Real path as given —
  // deliberately NOT assumed to live under macMiniTmpDir, since it
  // doesn't (different folder entirely: /Users/magnusklack/... vs
  // /Volumes/Extended Mac Mini M4/...). Gendered now (woman_*); man_*
  // presets are a real gap until they exist — the gender check that
  // selection between genders lives in discoverPosePresets below.
  // Session 143 — THE PRESETS DIRECTORY IS THE CONTRACT: every
  // _woman_<clip>_preset.duf / _man_<clip>_preset.duf in this folder
  // is discovered at generation time and baked into the fresh
  // character as a clip named <clip>. Frame ranges are parsed from
  // each .duf itself (dufMaxFrame below) — no per-preset CFG entries,
  // no hardcoded frame constants, no per-clip env knobs (the Session
  // 97 idle=149/walk=47 literals and the short-lived SIT_END_FRAME are
  // all superseded by this). Drop a preset in, every future character
  // knows the move. Loop policy: idle and walk always loop (the proven
  // Session 97 cycles); any other clip loops only when its name ends
  // in "_loop" — only the author knows whether a clip is a cycle or a
  // transition, so it's encoded in the filename
  // (_woman_sway_loop_preset.duf -> looping clip "sway_loop").
  // Session 145 — moved off the iCloud-exposed home dir to the external
  // volume with the rest of the DAZ estate (the eviction incident).
  macMiniPresetsDir: process.env.PRESETS_DIR || "/Volumes/Extended Mac Mini M4/DAZ3D/Server",
  daztimeoutMs: 180_000,
};

// ── Shell-escaping helpers ──────────────────────────────────────────────────
// This is the actual root cause of the "reference.jpg cannot be found"
// bug: quote-wrapping a path after "user@host:" does NOT reliably survive
// scp's own internal remote-path handling — a long-documented, decades-old
// scp gotcha with spaces specifically (unlike a normal local shell
// command, where quote-wrapping is sufficient). Manually-typed curl/ssh
// tests worked because they were quoted correctly by hand; this code was
// quoting the destination the wrong way for scp specifically.

// POSIX-safe wrapping for a single LOCAL shell argument.
// DUF frame-range parser (Session 143). DUF is JSON, very often
// gzip-compressed. Pose presets carry keyed values under
// scene.animations[].keys as [time, value] pairs with time in SECONDS;
// DAZ's default timeline is 30fps — the same assumption the whole
// Session 97 pipeline runs on. Returns 0 for a purely static preset.
// Exported: animations.js (the upload feature) parses uploaded .dufs
// with the SAME function — one parser, no drift.
export function dufMaxFrame(buffer) {
  let text;
  try { text = zlib.gunzipSync(buffer).toString("utf8"); }
  catch { text = buffer.toString("utf8"); }
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) { throw new Error(`.duf is neither gzip-JSON nor plain JSON: ${e.message}`); }
  let maxT = 0;
  for (const a of doc?.scene?.animations || []) {
    for (const key of a?.keys || []) {
      const t = Array.isArray(key) ? key[0] : 0;
      if (typeof t === "number" && t > maxT) maxT = t;
    }
  }
  return Math.round(maxT * 30);
}

// The two halves of the presets-directory contract (see CFG above).
async function discoverPosePresets(gender) {
  const prefix = gender === "male" ? "_man_" : "_woman_";
  const pattern = `"${CFG.macMiniPresetsDir}/"${prefix}*_preset.duf`;
  let stdout = "";
  try {
    ({ stdout } = await execAsync(`ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(`ls -1 ${pattern} 2>/dev/null`)}`, { timeout: 30_000 }));
  } catch { /* ls exits non-zero on zero matches — a valid empty result, not an error */ }
  const files = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const presets = files.map((presetPath) => {
    const base = presetPath.split("/").pop();
    const clipName = base.slice(prefix.length, -"_preset.duf".length);
    const loop = clipName === "idle" || clipName === "walk" || clipName.endsWith("_loop");
    return { clipName, presetPath, loop };
  });
  console.log(`[discoverPosePresets] ${gender}: ${presets.length} preset(s) in ${CFG.macMiniPresetsDir}: ${presets.map((p) => `${p.clipName}${p.loop ? " (loop)" : ""}`).join(", ") || "(none)"}`);
  return presets;
}

async function parseRemoteDufFrames(presetPath) {
  const { stdout } = await execAsync(`ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(`base64 < "${presetPath}"`)}`, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return dufMaxFrame(Buffer.from(stdout, "base64"));
}

function shellQuote(str) {
  return "'" + String(str).replace(/'/g, `'\\''`) + "'";
}

// scp's remote-path argument wants backslash-escaped spaces/specials, not
// quote-wrapping — this is the actual fix, applied to the path portion
// only, AFTER the "user@host:" prefix.
function scpRemoteEscape(str) {
  return String(str).replace(/([ "'$`\\])/g, "\\$1");
}

// In-memory status, keyed by actorId. Fine for a first pass; move to a
// real table if this needs to survive a server restart mid-generation.
const jobStatus = new Map();
const setStatus = (actorId, stage, extra = {}) => {
  console.log(`[generate3d] ${actorId} -> ${stage}`);
  jobStatus.set(actorId, { stage, error: null, ...extra });
};
const setError = (actorId, message) => {
  console.log(`[generate3d] ${actorId} -> ERROR: ${message}`);
  jobStatus.set(actorId, { ...(jobStatus.get(actorId) || {}), stage: "error", error: message });
};
// Session 97: separate from setStatus() deliberately — stage gates
// whether CharacterWizard.jsx renders the GLB viewer at all
// (stage==="ready" && glbUrl). Idle/walk run AFTER "ready" is first
// reached; using setStatus() for their progress would flip stage away
// from "ready" again and make the viewer the user is already looking at
// vanish behind the spinner a second time, for background work they
// don't need to wait through. This merges into the SAME jobStatus entry
// without ever touching stage.
const setPoseStatus = (actorId, poseStage, extra = {}) => {
  console.log(`[generate3d] ${actorId} -> poseStage: ${poseStage}`);
  jobStatus.set(actorId, { ...(jobStatus.get(actorId) || {}), poseStage, ...extra });
};

// Session 97: STUDIO_BUSY specifically retried, not thrown immediately —
// DAZ's own error message says "please retry shortly", which is DAZ
// itself documenting this as a transient condition, not a hard failure.
// Confirmed real in production: applyPosePreset succeeds, then the VERY
// NEXT call (same second, essentially zero gap) hits STUDIO_BUSY — this
// isn't a stuck dialog waiting for a human click (that already has its
// own separate handling elsewhere in this pipeline); it looks like
// DAZ's engine keeps doing internal work for a moment after a big
// openFile(merge=true) call technically returns success, and the very
// next command can race ahead of that settling. A short wait-and-retry
// is the correct fix for a race, not a longer timeout on the original
// call (which already succeeded) or a UI-dismissal workaround (which
// this isn't).
async function dazScriptRequest(script, timeoutMs) {
  const maxRetries = 5;
  const retryDelayMs = 2000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(`${CFG.dazScriptServerUrl}/execute`, {
      method: "POST",
      headers: { "X-API-Token": CFG.dazScriptServerToken, "Content-Type": "application/json" },
      body: JSON.stringify({ script }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    // Log the full raw response, including "output" — daz-script-server may
    // carry internal DAZ console warnings there that a bare success/failure
    // check has never actually surfaced. Left in permanently, not just for
    // this one bug — cheap, and the next mystery deserves real evidence too.
    console.log("[dazScript] raw response:", JSON.stringify(data));
    if (data.success) return data.result;
    if (data.error_code === "STUDIO_BUSY" && attempt < maxRetries) {
      console.log(`[dazScript] STUDIO_BUSY, retrying in ${retryDelayMs}ms (attempt ${attempt}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, retryDelayMs));
      continue;
    }
    throw new Error(`daz-script-server: ${data.error || "unknown error"}`);
  }
}

async function dazScript(script) {
  return dazScriptRequest(script, CFG.daztimeoutMs);
}

// scp's exit code only means "the transfer protocol reported done" — it's
// not a guarantee that a completely separate process (DAZ Studio) reading
// the same path immediately afterward will see a fully-visible file yet,
// especially over an external/mounted volume. Confirmed by observed
// behaviour: fails on first attempt, then succeeds once retried after a
// short wait. Rather than a blind delay, this checks readability directly
// from the Mac Mini's own filesystem view — the same vantage point DAZ
// Studio itself reads from — retrying briefly before giving up for real.
async function waitForFileOnDAZServer(remotePath, expectedSize, { retries = 20, delayMs = 1000 } = {}) {
  // test -f alone only proves a file ENTRY exists — scp creates the
  // destination file the moment it starts writing, so existence can be
  // true while the transfer is still in progress. This checks the actual
  // byte count matches the real local source size, confirming the write
  // has genuinely finished, not just started.
  const remoteSizeCmd = `stat -f%z ${shellQuote(remotePath)} 2>/dev/null || echo 0`;
  for (let i = 0; i < retries; i++) {
    try {
      const { stdout } = await execAsync(`ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(remoteSizeCmd)}`, { timeout: 15_000 });
      const remoteSize = parseInt(stdout.trim(), 10) || 0;
      if (remoteSize === expectedSize) return;
    } catch { /* treated the same as "not ready yet" — just retry */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`File did not reach expected size (${expectedSize} bytes) on DAZ server after ${retries} retries: ${remotePath}`);
}

async function pushPhotoToDAZServer(actorId, localPhotoPath) {
  // Don't trust that a file named .jpg/.jpeg actually contains standard
  // JPEG-encoded bytes — screenshots, HEIC conversions, and various
  // browser/OS tools can save non-standard variants under that extension.
  // sharp is already a project dependency (used for thumbnails); re-encode
  // to guaranteed, verified JPEG data here rather than passing the
  // original bytes straight through and hoping DAZ's loader accepts them.
  const normalizedPath = path.join(os.tmpdir(), `${actorId}-reference.jpg`);
  // Cap dimensions as part of the same pipeline (not a separate resize
  // after full decode) — lets sharp's underlying engine shrink-on-load
  // rather than fully decoding a phone-camera-resolution original into
  // memory first. A reference photo for face-matching needs nowhere near
  // full resolution; 1600px is generous. This machine already runs DAZ
  // Studio and a local LLM continuously — an uncapped decode of a large
  // original was very plausibly enough to exhaust memory and take the
  // whole machine down, not just this process.
  await sharp(localPhotoPath)
    .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toFile(normalizedPath);

  const remoteDir = `${CFG.macMiniTmpDir}/${actorId}`;
  const remoteMkdirCmd = `mkdir -p ${shellQuote(remoteDir)}`;
  // Real gap, closed here: unlike every DAZ-script-server call, these
  // SSH/SCP calls had no timeout at all — a stalled connection would hang
  // indefinitely with nothing to catch it, unrelated to anything DAZ-side.
  await execAsync(`ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(remoteMkdirCmd)}`, { timeout: 30_000 });
  const remotePath = `${remoteDir}/${actorId}-ref-${Date.now()}.jpg`;
  await execAsync(`scp ${shellQuote(normalizedPath)} ${CFG.macMiniUser}@${CFG.macMiniHost}:${scpRemoteEscape(remotePath)}`, { timeout: 60_000 });
  const expectedSize = fs.statSync(normalizedPath).size;
  await waitForFileOnDAZServer(remotePath, expectedSize);

  // Explicitly nudge DAZ Studio's own UI/event loop to catch up on the
  // newly-written file before Face Transfer ever touches it — a raw ssh
  // stat check confirms the OS sees the file, but says nothing about
  // whether DAZ's own app-level state has caught up yet.
  await dazScript(`(function(){ MainWindow.update(); return "ui updated"; })()`);

  try { fs.unlinkSync(normalizedPath); } catch {}
  return remotePath;
}

// Same proven pattern as pushPhotoToDAZServer above — normalize via
// sharp (guards against non-standard bytes under a .jpg/.png
// extension, same reasoning as the reference photo), scp to the same
// per-actor tmp dir, verify by byte size before trusting the file is
// actually there. 2000px cap instead of 1600 — these are full-body
// A-pose shots, not a headshot; the silhouette script needs enough
// resolution across the whole body to keep edge/width measurements
// meaningful, not just a face-sized region of interest.
async function pushBodyPhotosToDAZServer(actorId, localFrontPath, localSidePath, localBackPath) {
  const remoteDir = `${CFG.macMiniTmpDir}/${actorId}`;
  const remoteMkdirCmd = `mkdir -p ${shellQuote(remoteDir)}`;
  await execAsync(`ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(remoteMkdirCmd)}`, { timeout: 30_000 });

  const slots = [
    { label: "front", localPath: localFrontPath },
    { label: "side", localPath: localSidePath },
    { label: "back", localPath: localBackPath },
  ];

  const remotePaths = {};
  for (const { label, localPath } of slots) {
    const normalizedPath = path.join(os.tmpdir(), `${actorId}-body-${label}.jpg`);
    await sharp(localPath)
      .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toFile(normalizedPath);

    // <actorId>_front.jpeg / _side.jpeg / _back.jpeg — same per-actor tmp
    // dir as the reference photo/.blend/.glb, no timestamp. Unlike the
    // reference photo (which deliberately keeps timestamped history — a
    // known, separately-tracked cleanup gap), there's no reason to keep
    // stale body photos around after a Regenerate; overwriting the same
    // path each time is correct here, not an oversight.
    const remotePath = `${remoteDir}/${actorId}_${label}.jpeg`;
    await execAsync(`scp ${shellQuote(normalizedPath)} ${CFG.macMiniUser}@${CFG.macMiniHost}:${scpRemoteEscape(remotePath)}`, { timeout: 60_000 });
    const expectedSize = fs.statSync(normalizedPath).size;
    await waitForFileOnDAZServer(remotePath, expectedSize);
    try { fs.unlinkSync(normalizedPath); } catch {}
    remotePaths[label] = remotePath;
  }

  return remotePaths; // { front, side, back }
}

// Runs interpret_body.py on the Mac Mini (same machine DAZ Studio and
// daz-script-server run on — the Node process here talks to it over
// plain SSH, not daz-script-server, since this has nothing to do with
// DAZ itself until the measurements come back). Prints its full JSON
// result to stdout on success (see the script's own main()) — captured
// directly, no separate file-fetch round trip needed even though the
// script also writes --out server-side for its own debug/audit trail.
async function runInterpretBody(actorId, remotePaths, heightCm) {
  const remoteDir = `${CFG.macMiniTmpDir}/${actorId}`;
  const remoteOutPath = `${remoteDir}/${actorId}-measurements.json`;
  // Session 101+: silhouette debug images (interpret_body.py's own
  // --debug-dir output — the actual computed silhouette masks it
  // measures from, not just the raw uploaded photos) now land in the
  // SAME actor folder as the .duf/.blend/.glb files, in a debug/
  // subfolder rather than flat alongside them (interpret_body.py can
  // write several images per run — front/side/back — so a subfolder
  // keeps the main actor folder from getting cluttered while still
  // being one click away in Finder, not a separate location entirely).
  // Real, concrete reason this matters right now: when a photo-derived
  // target (e.g. Torso, Shoulder) comes back needing more range than
  // the real DAZ morph has, seeing the ACTUAL silhouette the
  // measurement was computed from — not just the raw photo — is the
  // fastest way to tell whether the measurement itself is inflated
  // (background/clothing/shadow contamination) versus a genuine
  // landmark-mapping mismatch between what the script measures and
  // what the DAZ side checks against.
  const remoteDebugDir = `${remoteDir}/debug`;
  const remoteMkdirCmd = `mkdir -p ${shellQuote(remoteDebugDir)}`;
  await execAsync(`ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(remoteMkdirCmd)}`, { timeout: 30_000 });

  const cmd = [
    "python3",
    shellQuote(CFG.macMiniInterpretBodyScriptPath),
    "--front", shellQuote(remotePaths.front),
    "--side", shellQuote(remotePaths.side),
    "--back", shellQuote(remotePaths.back),
    "--height-cm", shellQuote(String(heightCm)),
    "--out", shellQuote(remoteOutPath),
    "--debug-dir", shellQuote(remoteDebugDir),
  ].join(" ");

  let stdout, stderr;
  try {
    ({ stdout, stderr } = await execAsync(
      `ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(cmd)}`,
      { timeout: CFG.interpretBodyTimeoutMs }
    ));
  } catch (err) {
    // execAsync rejects on non-zero exit — interpret_body.py's own
    // fail() writes a JSON {"error": ...} to stderr before exiting
    // non-zero specifically so this is readable, not just "exit 1".
    throw new Error(`interpret_body.py failed for ${actorId}: ${err.stderr || err.message}`);
  }
  if (stderr && stderr.trim()) {
    // Non-fatal warnings (low-confidence landmarks, front/back
    // disagreement) also land here per the script's own design —
    // logged, not swallowed, but not a throw on their own.
    console.log(`[runInterpretBody] ${actorId} stderr:\n${stderr.trim()}`);
  }
  console.log(`[runInterpretBody] ${actorId} silhouette debug images: ${remoteDebugDir}`);

  let measurements;
  try {
    measurements = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`interpret_body.py produced non-JSON stdout for ${actorId}: ${err.message} | raw: ${stdout.slice(0, 500)}`);
  }
  if (measurements.error) {
    throw new Error(`interpret_body.py reported an error for ${actorId}: ${measurements.error}`);
  }
  return measurements; // { landmark: {...}, silhouette: {...}, calibration: {...}, warnings: [...] }
}

async function isStudioAlive() {
  try {
    await dazScript(`(function(){ return "alive"; })()`);
    return true;
  } catch {
    return false;
  }
}

async function restartDazStudio() {
  const macMiniDazPath = process.env.DAZ_STUDIO_PATH ||
    "/Applications/DAZ 3D/DAZStudio4 64-bit/DAZStudio.app/Contents/MacOS/DAZStudio";
  console.log("[restartDazStudio] killing existing DAZ Studio process...");
  await execAsync(`ssh ${CFG.macMiniUser}@${CFG.macMiniHost} "killall DAZStudio"`, { timeout: 15_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 5000));

  console.log("[restartDazStudio] relaunching...");
  // nohup + disown so the process survives this ssh session closing
  await execAsync(`ssh ${CFG.macMiniUser}@${CFG.macMiniHost} "nohup ${shellQuote(macMiniDazPath)} > /dev/null 2>&1 & disown"`, { timeout: 15_000 });

  // DAZ + Daz Script Server pane init takes real time — poll rather than
  // trust a fixed delay. Relies on "Start server when pane opens" already
  // being checked in the pane from earlier tonight; if it isn't, this
  // will time out here with a clear, honest error rather than hang.
  const maxWaitMs = 60_000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await isStudioAlive()) {
      console.log("[restartDazStudio] DAZ Studio back online, script server responsive");
      // Legacy reasoning (per direct confirmation, no longer believed
      // current): script responsiveness alone once didn't mean Face
      // Transfer's own underlying engine was ready — a real run once
      // completed "cleanly" per daz-script-server but produced a
      // default, non-face-transferred mesh. That's understood to no
      // longer reflect the current pipeline, hence the drop from the
      // original 10s to 3s here.
      console.log("[restartDazStudio] waiting additional 3s for Face Transfer's own engine to finish initializing...");
      await new Promise((r) => setTimeout(r, 3_000));
      return;
    }
  }
  throw new Error("DAZ Studio did not come back online after restart within 60s — check whether 'Start server when pane opens' is still enabled");
}

async function dazScriptWithTimeout(script, timeoutMs) {
  return dazScriptRequest(script, timeoutMs);
}

async function runDazGenerationSequence(actorId, remotePhotoPath, gender) {
  const genderActionClass = gender === "male" ? "DzFaceTransferGenerateMaleAction" : "DzFaceTransferGenerateFemaleAction";

  const disablePromptsScript = `(function(){ App.showPrompts(false); return "prompts disabled"; })()`;

  // PROVEN (Session 94, confirmed across three consecutive clean manual
  // tests with different images, no prompts, correct results every
  // time): close the pane, re-find it fresh, show it again, set the
  // image, set windowFilePath, refresh, AND trigger generate — ALL
  // within ONE script call, exactly matching the command confirmed
  // correct directly. The trigger was part of the SAME atomic call in
  // the proven test, not a separate one — keeping it merged here.
  const resetSetAndGenerateScript = `(function(){
    var oPaneMgr = MainWindow.getPaneMgr();
    var oFTPane = oPaneMgr.findPane("DzFaceTransferPane");
    oFTPane.closePane();
    var oFTPaneFresh = oPaneMgr.findPane("DzFaceTransferPane");
    oFTPaneFresh.showPane();
    oFTPaneFresh.setSourceImage(${JSON.stringify(remotePhotoPath)});
    oFTPaneFresh.windowFilePath = ${JSON.stringify(remotePhotoPath)};
    oFTPaneFresh.refresh();
    var oActionMgr = MainWindow.getActionMgr();
    oActionMgr.findAction("${genderActionClass}").trigger();
    return "reset pane and generated";
  })()`;

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await dazScriptWithTimeout(disablePromptsScript, 100_000);

      console.log("[runDazGenerationSequence] resetting pane and generating...");
      const lastResult = await dazScriptWithTimeout(resetSetAndGenerateScript, 100_000);
      console.log(`[runDazGenerationSequence] ${lastResult}`);
      return lastResult;
    } catch (err) {
      console.log(`[runDazGenerationSequence] attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxAttempts) throw err;
      setStatus(actorId, "recovering_daz_studio");
      console.log("[runDazGenerationSequence] treating as a hang — restarting DAZ Studio and retrying the whole sequence");
      await restartDazStudio();
    }
  }
}

// NOT yet proven — see file header. If this throws, enumerate the real
// node's properties before trusting these strings.
// Session 96: real, confirmed property names — no longer guessing.
// body_bs_ProportionHeight/ArmsLength/LegsLength are the actual DAZ
// internal names, confirmed directly from each morph's own Parameter
// Settings dialog, then proven end-to-end tonight (favorited, exported,
// verified as real adjustable shape keys via check_shape_keys.py on a
// real .blend). "Height"/"BreastSize" from the old version were never
// confirmed at all — that function's own header even said so.
//
// Also fixing a real bug flagged earlier and left alone until now: the
// old version did `if (hProp) hProp.setValue(...)` — silently doing
// nothing if the property wasn't found, exactly the kind of silent
// fallback the standing rule says never to do. Throwing instead.
// Real fix, not another guess: findProperty(name) was never going to
// find these — morphs are MODIFIERS attached to the node, not plain
// node properties. dump_g9_morphs.dsa already proved the right lookup
// (getNumModifiers/getModifier/getValueChannel) back when the morph
// list was first explored; this just applies that same proven pattern
// here instead of the never-actually-tested findProperty() call.
// Second fix on this function tonight: the reorder (select before
// applying shape) was correct but not sufficient — the log showed
// selectNodeForExport succeeding immediately beforehand, then this
// still failing the same way. Rather than guess why
// Scene.getPrimarySelection() isn't reliably carrying selection state
// across two separate dazScript() calls, sidestepping the question
// entirely: look the node up directly by label, the same proven method
// selectNodeForExport already uses successfully, instead of trusting
// that a prior call's selection persisted into this one.
// Third attempt, and this time built on something actually confirmed —
// not memory. getNumModifiers()/getModifier()/getValueChannel() (the
// last two attempts) were wrongly cited as "proven" — that was from
// dump_g9_morphs.dsa, which was never actually run. Real mistake,
// caught late. Using getNumProperties()/getProperty()/.name/.getValue()
// instead — copied verbatim from export_to_blender.dsa's own
// doProperties() function, which has genuinely produced real, working
// .dbz exports all night. .setValue() is the one inferred piece here
// (the natural counterpart to the confirmed .getValue()), not
// independently proven — logged clearly either way.
//
// FULL REWRITE (Session 101+, this pass) — real DAZ morphs instead of
// bone-scale hacks. The original conclusion that body_bs_Proportion*
// was "confirmed absent" was WRONG — not a naming miss, a lookup-path
// miss. getObject().getCurrentShape().getNumProperties() (6 hits) and
// oNode.getNumProperties() (565 hits) never reach modifiers at all.
// The real path, confirmed via multiple independent DAZ forum sources:
// oObject.getNumModifiers()/getModifier(i), where a morph is a DzMorph
// (DzModifier subtype) with its own .name and getValueChannel(). A
// full keyword-filtered scan through this path found every one of
// these real, by name, live on this exact node:
//   body_bs_ProportionTorsoLength, ArmsLength, LegsLength,
//   ShoulderWidth, ChestDepth, ChestWidth, head_bs_ProportionNeckLength
// All share range [-2, 2], default 0.
//
// HEIGHT — kept on the root YScale mechanism from the prior pass, NOT
// switched to body_bs_ProportionHeight. That specific morph was
// independently confirmed broken by direct manual testing
// (CharacterWizard.jsx's own Session 96 note: dragging it makes the
// character thicker, not taller — a real visual finding, not a
// lookup-mechanism problem like everything else here). YScale is
// exact (proven via two-point calibration, see below) — no reason to
// reopen a working mechanism for a known-broken one.
//
// TORSO, LEGS — real morphs, confirmed LINEAR via two independent test
// points (delta @ +0.5 and @ +1.0 from baseline): Torso -0.19% off a
// clean 2x, Legs 0.00% off. Simple closed-form formula, safe:
// newValue = currentValue + (targetCm - currentCm) / slope.
// Slopes measured directly on this node (cm per 1.0 unit of value):
// Torso=5.0248565673828125, Legs=23.2666015625.
//
// ARMS, SHOULDER — real morphs, but the SAME two-point test proved
// these are NOT linear: Arms was 16.93% off a clean 2x, Shoulder was
// 57.39% off — a naive linear formula would have silently produced a
// badly wrong shoulder width while reporting success:true throughout.
// Plausible cause: DAZ often builds one visible "Proportion" dial as
// an ERC driving several underlying morphs with different individual
// weights, which has no obligation to stay linear across its range.
// Real fix: don't characterize the curve, don't guess — solve for the
// target empirically, live, every time, via the secant method (two
// real measured points -> linear extrapolation -> re-measure -> repeat).
// This makes no assumption about linearity or a fixed slope, so it's
// robust to whatever the real shape of the curve actually is, and
// self-corrects character to character rather than trusting a
// constant measured once on Benny.
//
// SHOULDER now uses the real body_bs_ProportionShoulderWidth morph,
// NOT the old l_shoulder/r_shoulder XScale bone-scale approach from
// the prior pass — that mechanism is removed entirely. Real morphs
// avoid the exact risk a DAZ forum thread specifically warned about
// (non-uniform bone scaling visibly distorting a rig at the joints).
//
// CHEST DEPTH/WIDTH — real modifiers exist and are confirmed settable,
// but NOT wired in here. No verification path exists: pectoral bones
// have zero children (confirmed, so no position-based check like
// shoulder/arms have), and getBoundingBox() is confirmed unreliable
// for ANY live deformation — bone-scale OR morph — once anything on
// this node has changed this session (proven twice now: height/torso/
// shoulder bone-scale changes all read bbox delta=0 despite real,
// visually-confirmed effects; then AGAIN here — Torso/Legs/Arms/
// Shoulder/Neck all showed large real deltas via bone position while
// bbox height/width/depth all read exactly 0 the whole time). Chest
// stays unset — no interpret_body.py measurement exists to drive it
// with anyway (chest_depth_cm only lives under silhouette, and even
// if used, there's no way to confirm the result short of a human
// looking at the viewport).
//
// NECK — real morph, confirmed linear (-2.00% off 2x, close enough),
// but NOT wired in: interpret_body.py has no neck-length measurement
// at all, landmark or silhouette. Calibrated and ready for whenever
// that measurement exists; unused for now.
//
// interpret_body.py mapping caveat, unchanged from the prior pass:
// landmark.torso_length_cm is shoulder-midpoint-to-hip-midpoint; this
// measures hip-to-neck1 — close, not identical. Same kind of proxy
// gap for shoulder/arms against their own landmark definitions.
//
// All baselines measured LIVE, never hardcoded. Height applied first;
// everything else measures fresh against the already-correct-height
// body. All changes genuinely applied and KEPT — this is the real
// pipeline path, not a calibration test.
async function applyBodyShape(targetHeightCm, targetTorsoCm, targetShoulderCm, targetArmsCm, targetLegsCm, waistCircOverHeight, nodeLabel) {
  // ---------- GIRTH (Waist/Hip/Mass) — ratio-based deviation, not
  // absolute cm targeting. Real, confirmed limitation: unlike Height/
  // Torso/Legs/Arms/Shoulder, DAZ Script cannot measure these morphs'
  // effect at all (getBoundingBox() and direct vertex access both
  // confirmed stale for morphs, and for girth specifically there's no
  // adjacent bone position to fall back on either — pectorals/waist
  // region has none, confirmed earlier). Real calibration instead came
  // from Blender (evaluated_depsgraph_get(), correctly reflects morphs
  // unlike DazScript) against a real exported .blend — but what that
  // gave us is a SLOPE (how much a proxy metric moves per unit of
  // value), not an absolute mapping from real-world cm to a specific
  // value, since the proxy metric itself isn't the same measurement as
  // interpret_body.py's photo-derived cm figures.
  //
  // Given that, these six are driven by a deviation ratio instead of
  // a direct cm target: waist-to-height ratio is a real, well-
  // established anthropometric measure (multiple independent sources,
  // searched directly rather than assumed — Omnicalculator, BodySpec,
  // ScienceInsights, MDApp all converge on "healthy" being 0.4-0.49,
  // with 0.5 as the universally-cited cutoff). 0.45 (that range's
  // midpoint) is used as the "typical" reference point. How far a
  // real person's measured waist_circ_over_height sits above or below
  // that reference becomes a single, unified proportional signal,
  // clamped to [-1,1] and applied the same way across all six — they're
  // all expressions of the same general "how much bigger/smaller than
  // typical" question, just in different regions. Worth noting
  // honestly: five of these (WaistWidth/WaistDepth/HipSize/
  // MassLowerTorso/MassUpperTorso) have a real [-1,1] range, so this
  // uses their full range — but ChestDepth (Session 101+, added to
  // this group) is a Base Proportion morph with a [-2,2] range, so
  // this same [-1,1]-clamped signal only ever exercises half of what
  // it could. Not wrong, just conservative — a real limitation, not a
  // bug.
  //
  // WaistDepth specifically: its confirmed Blender slope came back
  // NEGATIVE (-0.65cm of proxy metric per unit) — but the proxy
  // metric's sign and the real, visual "more value = more actual belly
  // depth" direction aren't necessarily the same thing (the exact
  // category of trap getBoundingBox() sprung earlier this session).
  // Sign flipped here as a reasoned best guess — same direction as the
  // other four, higher deviation -> higher value -> larger real depth
  // — but this is NOT independently visually verified. Worth a real
  // check (same deliberate, non-restoring visual test pattern used for
  // Height's root YScale earlier) before fully trusting this in
  // production.
  const REFERENCE_WAIST_TO_HEIGHT = 0.45;
  let girthDeviation = 0;
  if (waistCircOverHeight > 0) {
    girthDeviation = (waistCircOverHeight - REFERENCE_WAIST_TO_HEIGHT) / REFERENCE_WAIST_TO_HEIGHT;
    girthDeviation = Math.max(-1, Math.min(1, girthDeviation));
  }
  const girthValue = girthDeviation; // same signal, applied uniformly
  const waistDepthValue = girthDeviation; // sign-flipped relative to its own confirmed slope, see comment above

  const result = await dazScript(`(function(){
    var oNode = Scene.findNodeByLabel(${JSON.stringify(nodeLabel)});
    if (!oNode) throw new Error("Node not found: ${nodeLabel}");

    function findProp(node, propName) {
      if (!node) return null;
      var nProps = node.getNumProperties();
      for (var i = 0; i < nProps; i++) {
        var p = node.getProperty(i);
        if (p && p.name === propName) return p;
      }
      return null;
    }

    var report = [];
    var appliedValues = {}; // structured, machine-readable — real values, for convert_diffeomorphic.py to bypass Diffeomorphic's broken driver linkage

    // ---------- HEIGHT (apply first — everything else measures against this) ----------
    var rootYScale = findProp(oNode, "YScale");
    if (!rootYScale) throw new Error("root YScale not found — this WAS confirmed present; if this throws, something upstream changed");

    var oObj = oNode.getObject();
    if (!oObj || !oObj.getBoundingBox) throw new Error("getBoundingBox not available on Genesis9's object");
    var bboxBefore = oObj.getBoundingBox();
    var baselineHeightCm = bboxBefore.maxY - bboxBefore.minY;
    if (!(baselineHeightCm > 0)) throw new Error("degenerate baseline height reading: " + baselineHeightCm);

    var targetHeightCm = ${targetHeightCm};
    if (!(targetHeightCm > 0)) throw new Error("invalid targetHeightCm: " + targetHeightCm);
    var newYScale = targetHeightCm / baselineHeightCm;
    rootYScale.setValue(newYScale);
    MainWindow.update();
    report.push("HEIGHT baseline=" + baselineHeightCm + " target=" + targetHeightCm + " YScale=" + newYScale);

    // ---------- Real morph value channels ----------
    var numMods = oObj.getNumModifiers();
    var morphNames = ["body_bs_ProportionTorsoLength", "body_bs_ProportionArmsLength", "body_bs_ProportionLegsLength", "body_bs_ProportionShoulderWidth", "body_bs_WaistWidth", "body_bs_WaistDepth", "body_bs_HipSize", "body_bs_MassLowerTorso", "body_bs_MassUpperTorso", "body_bs_ProportionChestDepth", "body_bs_ProportionChestWidth", "body_bs_ProportionFingersLength", "body_bs_ProportionFootLength", "body_bs_ProportionLarger", "body_bs_ProportionSmaller", "body_bs_ProportionSmallerBO", "body_bs_ProportionToesLength", "head_bs_ProportionNeckLength", "body_bs_AbdominalsCenterDefine", "body_bs_AbdominalsOuterDefine", "body_bs_AbdominalsWidth", "body_bs_BodyEmaciated", "body_bs_BodyFitnessDetails", "body_bs_BodyFitnessMass", "body_bs_BodyHeavy", "body_bs_BodyLithe", "body_bs_BodyMuscularDetails", "body_bs_BodyMuscularMass", "body_bs_BodyOlder", "body_bs_BodyThin", "body_bs_BodyTone", "body_bs_CalvesSize", "body_bs_CollarboneDetail", "body_bs_FingersWidth", "body_bs_FootArchDepth", "body_bs_GluteCrease", "body_bs_GluteDepthLower", "body_bs_GluteDepthUpper", "body_bs_GluteSize", "body_bs_GluteWidth", "body_bs_HipBackDimples", "body_bs_HipBoneCrest", "body_bs_HipBoneSize", "body_bs_HipGenitalBulge", "body_bs_HipPelvicTilt", "body_bs_HipVDefine", "body_bs_KneeBonesSize", "body_bs_LatsSize", "body_bs_LoveHandles", "body_bs_MassAnkles", "body_bs_MassBody", "body_bs_MassFeet", "body_bs_MassForearms", "body_bs_MassHands", "body_bs_MassKnees", "body_bs_MassNeck", "body_bs_MassShins", "body_bs_MassShoulders", "body_bs_MassThighs", "body_bs_MassUpperArms", "body_bs_MassWrist", "body_bs_NavelDepth_HD3", "body_bs_NavelHollow_HD3", "body_bs_NavelHorizontal_HD3", "body_bs_NavelOut_HD3", "body_bs_NavelSize_HD3", "body_bs_NavelVertical_HD3", "body_bs_RibcageArched", "body_bs_RibcagePointed", "body_bs_RibcageSize", "body_bs_ScapulaDepth", "body_bs_ScapulaSize", "body_bs_SternumDepth", "body_bs_SternumHeight", "body_bs_SternumWidth", "body_bs_StomachDepth", "body_bs_StomachDepthLower", "body_bs_StomachSoften", "body_bs_TaperForearmA", "body_bs_TaperForearmB", "body_bs_TaperNeckA", "body_bs_TaperNeckB", "body_bs_TaperShinA", "body_bs_TaperShinB", "body_bs_TaperThighA", "body_bs_TaperThighB", "body_bs_TaperUpperArmA", "body_bs_TaperUpperArmB", "body_bs_ThighDepth", "body_bs_ThighTone", "body_bs_TrapsSize", "body_bs_UpperArmTaperWidth", "body_bs_WaistWidthUpper"];
    var vcs = {};
    for (var i = 0; i < numMods; i++) {
      var mod = oObj.getModifier(i);
      if (!mod || morphNames.indexOf(mod.name) === -1) continue;
      vcs[mod.name] = mod.getValueChannel();
    }
    morphNames.forEach(function(n){ if (!vcs[n]) throw new Error("missing value channel: " + n + " — these WERE confirmed present via getNumModifiers(); if this throws, something upstream changed"); });

    // ---------- Bone lookups ----------
    var allNodes = oNode.getNodeChildren(true);
    function findBone(name) {
      for (var n = 0; n < allNodes.length; n++) if (allNodes[n] && allNodes[n].name === name) return allNodes[n];
      return null;
    }
    var hip = findBone("hip"), neck1 = findBone("neck1"), headBone = findBone("head"), footBone = findBone("l_foot");
    var lShoulder = findBone("l_shoulder"), lUpperarm = findBone("l_upperarm"), rUpperarm = findBone("r_upperarm"), lHand = findBone("l_hand");
    if (!hip || !neck1 || !headBone || !footBone || !lUpperarm || !rUpperarm || !lHand) {
      throw new Error("missing bone: hip=" + !!hip + " neck1=" + !!neck1 + " head=" + !!headBone + " l_foot=" + !!footBone + " l_upperarm=" + !!lUpperarm + " r_upperarm=" + !!rUpperarm + " l_hand=" + !!lHand);
    }

    function measureTorso() { return neck1.getWSPos().y - hip.getWSPos().y; }
    function measureLegs() { return hip.getWSPos().y - footBone.getWSPos().y; }
    function measureShoulder() { return Math.abs(lUpperarm.getWSPos().x - rUpperarm.getWSPos().x); }
    function measureArms() {
      var a = lShoulder.getWSPos(), b = lHand.getWSPos();
      var dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      return Math.sqrt(dx*dx + dy*dy + dz*dz);
    }

    // ---------- TORSO, LEGS: confirmed linear, closed-form ----------
    function applyLinear(vc, measureFn, targetCm, slope, label, morphKey) {
      var currentValue = vc.getValue();
      var currentCm = measureFn();
      var targetValue = currentValue + (targetCm - currentCm) / slope;
      targetValue = Math.max(-2, Math.min(2, targetValue));
      vc.setValue(targetValue);
      MainWindow.update();
      var actualCm = measureFn();
      report.push(label + " current=" + currentCm + " target=" + targetCm + " value=" + targetValue + " actualAfter=" + actualCm);
      appliedValues[morphKey] = targetValue;
    }
    if (${targetTorsoCm} > 0) applyLinear(vcs["body_bs_ProportionTorsoLength"], measureTorso, ${targetTorsoCm}, 5.0248565673828125, "TORSO", "body_bs_ProportionTorsoLength");
    if (${targetLegsCm} > 0) applyLinear(vcs["body_bs_ProportionLegsLength"], measureLegs, ${targetLegsCm}, 23.2666015625, "LEGS", "body_bs_ProportionLegsLength");

    // ---------- ARMS, SHOULDER: confirmed NONLINEAR, secant-method solve ----------
    function solveForTarget(vc, measureFn, targetCm, maxIterations, toleranceCm, label, morphKey) {
      var x0 = vc.getValue();
      vc.setValue(x0); MainWindow.update();
      var y0 = measureFn();

      var x1 = Math.max(-2, Math.min(2, x0 + (y0 < targetCm ? 0.3 : -0.3)));
      vc.setValue(x1); MainWindow.update();
      var y1 = measureFn();

      var bestX = (Math.abs(y0 - targetCm) < Math.abs(y1 - targetCm)) ? x0 : x1;
      var bestY = (Math.abs(y0 - targetCm) < Math.abs(y1 - targetCm)) ? y0 : y1;
      var iterUsed = 0;

      for (var iter = 0; iter < maxIterations; iter++) {
        iterUsed = iter + 1;
        if (Math.abs(bestY - targetCm) <= toleranceCm) break;
        var denom = (y1 - y0);
        if (Math.abs(denom) < 1e-6) break;
        var x2 = x1 - (y1 - targetCm) * (x1 - x0) / denom;
        x2 = Math.max(-2, Math.min(2, x2));
        vc.setValue(x2); MainWindow.update();
        var y2 = measureFn();
        if (Math.abs(y2 - targetCm) < Math.abs(bestY - targetCm)) { bestX = x2; bestY = y2; }
        x0 = x1; y0 = y1; x1 = x2; y1 = y2;
      }
      vc.setValue(bestX); MainWindow.update();
      report.push(label + " target=" + targetCm + " value=" + bestX + " actualAfter=" + bestY + " diffCm=" + (bestY - targetCm) + " iterations=" + iterUsed);
      appliedValues[morphKey] = bestX;
    }
    if (${targetArmsCm} > 0) solveForTarget(vcs["body_bs_ProportionArmsLength"], measureArms, ${targetArmsCm}, 6, 0.3, "ARMS", "body_bs_ProportionArmsLength");
    if (${targetShoulderCm} > 0) solveForTarget(vcs["body_bs_ProportionShoulderWidth"], measureShoulder, ${targetShoulderCm}, 6, 0.3, "SHOULDER", "body_bs_ProportionShoulderWidth");

    // ---------- GIRTH: ratio-based deviation, applied directly (no
    // DAZ-side measurement possible — see this function's own header
    // comment for the full reasoning) ----------
    var girthValue = ${girthValue};
    var waistDepthValue = ${waistDepthValue};
    vcs["body_bs_WaistWidth"].setValue(girthValue);
    vcs["body_bs_WaistDepth"].setValue(waistDepthValue);
    vcs["body_bs_HipSize"].setValue(girthValue);
    vcs["body_bs_MassLowerTorso"].setValue(girthValue);
    vcs["body_bs_MassUpperTorso"].setValue(girthValue);
    // ChestDepth added to the girth group — reuses the same deviation
    // signal rather than a separate formula. No well-established
    // anthropometric chest-depth-to-height reference exists the way
    // waist-to-height does, but a larger waist-to-height ratio
    // generally correlates with a deeper chest too — a reasonable,
    // stated approximation, not a precise independent calibration.
    vcs["body_bs_ProportionChestDepth"].setValue(girthValue);
    MainWindow.update();
    report.push("GIRTH deviation=" + girthValue + " (waistDepth=" + waistDepthValue + ") applied to WaistWidth/WaistDepth/HipSize/MassLowerTorso/MassUpperTorso/ChestDepth — NOT independently verified, no DAZ-side measurement exists for these");
    appliedValues["body_bs_WaistWidth"] = girthValue;
    appliedValues["body_bs_WaistDepth"] = waistDepthValue;
    appliedValues["body_bs_HipSize"] = girthValue;
    appliedValues["body_bs_MassLowerTorso"] = girthValue;
    appliedValues["body_bs_MassUpperTorso"] = girthValue;
    appliedValues["body_bs_ProportionChestDepth"] = girthValue;

    // ---------- Remaining ~98 morphs: explicitly baked at 0 ----------
    // Session 101+: real, deliberate choice, not a placeholder. These
    // have no photo-derived measurement backing them (interpret_body.py
    // has no metric for most of these — Ribcage shape, Sternum
    // proportions, individual taper/mass dials, etc.), so 0 (DAZ's own
    // neutral default for all of them, confirmed via getMin()/getMax()
    // scans throughout this session) is the honest, correct starting
    // point. The reason this needs to be explicit at all, not just left
    // alone: Diffeomorphic's broken driver leaves a favorited-but-
    // untouched morph's shape key permanently stuck at 0 REGARDLESS of
    // what's actually correct — bypassing it here, even to set the same
    // value it would have had anyway, guarantees these export as
    // genuinely live, working, centered sliders rather than accidentally
    // inert ones that only happen to look right by coincidence.
    var zeroBakeMorphs = ["body_bs_ProportionChestWidth", "body_bs_ProportionFingersLength", "body_bs_ProportionFootLength", "body_bs_ProportionLarger", "body_bs_ProportionSmaller", "body_bs_ProportionSmallerBO", "body_bs_ProportionToesLength", "head_bs_ProportionNeckLength", "body_bs_AbdominalsCenterDefine", "body_bs_AbdominalsOuterDefine", "body_bs_AbdominalsWidth", "body_bs_BodyEmaciated", "body_bs_BodyFitnessDetails", "body_bs_BodyFitnessMass", "body_bs_BodyHeavy", "body_bs_BodyLithe", "body_bs_BodyMuscularDetails", "body_bs_BodyMuscularMass", "body_bs_BodyOlder", "body_bs_BodyThin", "body_bs_BodyTone", "body_bs_CalvesSize", "body_bs_CollarboneDetail", "body_bs_FingersWidth", "body_bs_FootArchDepth", "body_bs_GluteCrease", "body_bs_GluteDepthLower", "body_bs_GluteDepthUpper", "body_bs_GluteSize", "body_bs_GluteWidth", "body_bs_HipBackDimples", "body_bs_HipBoneCrest", "body_bs_HipBoneSize", "body_bs_HipGenitalBulge", "body_bs_HipPelvicTilt", "body_bs_HipVDefine", "body_bs_KneeBonesSize", "body_bs_LatsSize", "body_bs_LoveHandles", "body_bs_MassAnkles", "body_bs_MassBody", "body_bs_MassFeet", "body_bs_MassForearms", "body_bs_MassHands", "body_bs_MassKnees", "body_bs_MassNeck", "body_bs_MassShins", "body_bs_MassShoulders", "body_bs_MassThighs", "body_bs_MassUpperArms", "body_bs_MassWrist", "body_bs_NavelDepth_HD3", "body_bs_NavelHollow_HD3", "body_bs_NavelHorizontal_HD3", "body_bs_NavelOut_HD3", "body_bs_NavelSize_HD3", "body_bs_NavelVertical_HD3", "body_bs_RibcageArched", "body_bs_RibcagePointed", "body_bs_RibcageSize", "body_bs_ScapulaDepth", "body_bs_ScapulaSize", "body_bs_SternumDepth", "body_bs_SternumHeight", "body_bs_SternumWidth", "body_bs_StomachDepth", "body_bs_StomachDepthLower", "body_bs_StomachSoften", "body_bs_TaperForearmA", "body_bs_TaperForearmB", "body_bs_TaperNeckA", "body_bs_TaperNeckB", "body_bs_TaperShinA", "body_bs_TaperShinB", "body_bs_TaperThighA", "body_bs_TaperThighB", "body_bs_TaperUpperArmA", "body_bs_TaperUpperArmB", "body_bs_ThighDepth", "body_bs_ThighTone", "body_bs_TrapsSize", "body_bs_UpperArmTaperWidth", "body_bs_WaistWidthUpper"];
    zeroBakeMorphs.forEach(function(n) {
      vcs[n].setValue(0);
      appliedValues[n] = 0;
    });
    MainWindow.update();
    report.push("ZERO-BAKED " + zeroBakeMorphs.length + " style morphs at DAZ default (0) — no photo measurement exists for these, real driver-bypass applied anyway so they export as genuinely live sliders. 12 body_ctrl_*/head_ctrl_* meta-dials confirmed NOT independently accessible via getNumModifiers() (real check, not assumed) and excluded here — may still be valid client-side favorite_morphs.json entries, just not usable for this DAZ-side baking mechanism.");

    // ---------- Final overall verification ----------
    var verifySpan = headBone.getWSPos().y - footBone.getWSPos().y;
    report.push("verify head-foot span after all changes=" + verifySpan);

    // Real, machine-readable envelope — not just the human log. This is
    // what actually solves the driver problem: convert_diffeomorphic.py
    // needs these exact values to bypass Diffeomorphic's broken
    // shape-key/driver linkage after import (confirmed: the DAZ-saved
    // .duf genuinely has the correct current_value for every one of
    // these morphs, but Diffeomorphic's own import path for FAVORITED
    // morphs initializes both the shape key AND its backing armature
    // custom property at 0, relying entirely on a driver whose target
    // data_path is malformed and can never resolve — confirmed
    // directly, path_resolve() fails on it). Returning these values
    // here is the only way generate3d.js can hand them to Blender.
    return JSON.stringify({ log: report.join(" | "), values: appliedValues });
  })()`);
  const parsed = JSON.parse(result);
  console.log(`[applyBodyShape] BODY SHAPE APPLIED (real morphs, kept): ${parsed.log}`);
  return parsed.values;
}
// NOTE (Session 101+): no longer called from runPipeline(). Real,
// deliberate decision, not an oversight — photo-derived auto-fitting is
// being replaced entirely by client-side slider fitting against the
// front/side reference images. Function body kept intact rather than
// deleted: the linear-formula/secant-solver logic inside took many real,
// hard-won calibration steps to get right (see this whole session's
// history) and may be genuinely useful again later even though nothing
// calls it right now. See bakeAllMorphsAtDefault() below for what
// actually runs in its place.

// Real, much simpler replacement for applyBodyShape() — Session 101+.
// Still needs the SAME real driver-bypass mechanism (find every real
// morph via getNumModifiers(), set its value directly, hand the exact
// values to convert_diffeomorphic.py) — that part isn't optional.
// Confirmed earlier this session: without it, Diffeomorphic's broken
// driver leaves every favorited morph's shape key permanently stuck at
// 0 regardless of what's dialed in DAZ. Bypassing it here — even just
// to set the same value (0) it would land on anyway — is what makes
// the shape key a genuinely live, working slider once exported, rather
// than an accidentally-inert one that only happens to look right.
// What's different from applyBodyShape(): no photo measurements, no
// formulas, no solver — every real morph just gets baked at DAZ's own
// neutral default, so every character ships with a full set of real,
// live, centered sliders ready for a human to adjust against the
// reference images, rather than the server guessing a starting shape.
// TWO NAME SPACES — do not "sync" this list with MiniGlbViewer's
// MORPH_NAMES (Session 102, learned from a real crash-loudly hit):
// this list speaks DAZ's OWN modifier names (what getNumModifiers()
// finds and what has value channels); MORPH_NAMES speaks the names
// Diffeomorphic RENAMES five of them to on export
// (BodyMuscularMass→BodyMuscularVolume, MassBody→BodyMass,
// MassUpperArms→MassUpperarms, BreastsSmall→BreastSmall,
// BreastsLarge→BreastSize — confirmed by 704a7c5b's GLB targetNames
// containing exactly the renamed forms and none of the originals,
// while DAZ throws "missing value channel" on the renamed forms).
// The two lists are CORRECTLY different for those five entries.
async function bakeAllMorphsAtDefault(nodeLabel) {
  const morphNames = ["body_bs_ProportionTorsoLength", "body_bs_ProportionArmsLength", "body_bs_ProportionLegsLength", "body_bs_ProportionShoulderWidth", "body_bs_WaistWidth", "body_bs_WaistDepth", "body_bs_HipSize", "body_bs_MassLowerTorso", "body_bs_MassUpperTorso", "body_bs_ProportionChestDepth", "body_bs_ProportionChestWidth", "body_bs_ProportionFingersLength", "body_bs_ProportionFootLength", "body_bs_ProportionLarger", "body_bs_ProportionSmaller", "body_bs_ProportionSmallerBO", "body_bs_ProportionToesLength", "head_bs_ProportionNeckLength", "body_bs_AbdominalsCenterDefine", "body_bs_AbdominalsOuterDefine", "body_bs_AbdominalsWidth", "body_bs_BodyEmaciated", "body_bs_BodyFitnessDetails", "body_bs_BodyFitnessMass", "body_bs_BodyHeavy", "body_bs_BodyLithe", "body_bs_BodyMuscularDetails", "body_bs_BodyMuscularMass", "body_bs_BodyOlder", "body_bs_BodyThin", "body_bs_BodyTone", "body_bs_CalvesSize", "body_bs_CollarboneDetail", "body_bs_FingersWidth", "body_bs_FootArchDepth", "body_bs_GluteCrease", "body_bs_GluteDepthLower", "body_bs_GluteDepthUpper", "body_bs_GluteSize", "body_bs_GluteWidth", "body_bs_HipBackDimples", "body_bs_HipBoneCrest", "body_bs_HipBoneSize", "body_bs_HipGenitalBulge", "body_bs_HipPelvicTilt", "body_bs_HipVDefine", "body_bs_KneeBonesSize", "body_bs_LatsSize", "body_bs_LoveHandles", "body_bs_MassAnkles", "body_bs_MassBody", "body_bs_MassFeet", "body_bs_MassForearms", "body_bs_MassHands", "body_bs_MassKnees", "body_bs_MassNeck", "body_bs_MassShins", "body_bs_MassShoulders", "body_bs_MassThighs", "body_bs_MassUpperArms", "body_bs_MassWrist", "body_bs_NavelDepth_HD3", "body_bs_NavelHollow_HD3", "body_bs_NavelHorizontal_HD3", "body_bs_NavelOut_HD3", "body_bs_NavelSize_HD3", "body_bs_NavelVertical_HD3", "body_bs_RibcageArched", "body_bs_RibcagePointed", "body_bs_RibcageSize", "body_bs_ScapulaDepth", "body_bs_ScapulaSize", "body_bs_SternumDepth", "body_bs_SternumHeight", "body_bs_SternumWidth", "body_bs_StomachDepth", "body_bs_StomachDepthLower", "body_bs_StomachSoften", "body_bs_TaperForearmA", "body_bs_TaperForearmB", "body_bs_TaperNeckA", "body_bs_TaperNeckB", "body_bs_TaperShinA", "body_bs_TaperShinB", "body_bs_TaperThighA", "body_bs_TaperThighB", "body_bs_TaperUpperArmA", "body_bs_TaperUpperArmB", "body_bs_ThighDepth", "body_bs_ThighTone", "body_bs_TrapsSize", "body_bs_UpperArmTaperWidth", "body_bs_WaistWidthUpper", "body_bs_BreastsSmall", "body_bs_BreastsLarge", "body_bs_BreastsNatural", "body_bs_BreastsHeavy", "body_bs_BreastsPerkSide", "body_bs_BreastsSidesDepth", "body_bs_BreastsLargeHigh", "body_bs_BreastsShape01", "body_bs_BreastsShape02", "body_bs_BreastsShape03", "body_bs_BreastsShape04", "body_bs_BreastsShape05", "body_bs_BreastsShape06", "body_bs_BreastsGone", "body_bs_BreastsCleavage", "body_bs_BreastsFullnessUpper", "body_bs_BreastsFullnessLower", "body_bs_BreastsDownwardSlope", "body_bs_BreastsDiameter"];

  const result = await dazScript(`(function(){
    var oNode = Scene.findNodeByLabel(${JSON.stringify(nodeLabel)});
    if (!oNode) throw new Error("Node not found: ${nodeLabel}");
    var oObj = oNode.getObject();
    if (!oObj) throw new Error("getObject() failed on node");

    var wanted = ${JSON.stringify(morphNames)};
    var numMods = oObj.getNumModifiers();
    var vcs = {};
    for (var i = 0; i < numMods; i++) {
      var mod = oObj.getModifier(i);
      if (mod && wanted.indexOf(mod.name) !== -1) vcs[mod.name] = mod.getValueChannel();
    }
    var missing = wanted.filter(function(n){ return !vcs[n]; });
    if (missing.length > 0) throw new Error("missing value channel(s): " + missing.join(", ") + " — these WERE confirmed present via getNumModifiers(); if this throws, something upstream changed");

    var appliedValues = {};
    wanted.forEach(function(n) {
      vcs[n].setValue(0);
      appliedValues[n] = 0;
    });
    MainWindow.update();

    return JSON.stringify({ log: "BAKED " + wanted.length + " real morphs at DAZ default (0) — driver bypassed for all, ready as live client-side sliders", values: appliedValues });
  })()`);
  const parsed = JSON.parse(result);
  console.log(`[bakeAllMorphsAtDefault] ${parsed.log}`);
  return parsed.values;
}

async function selectNodeForExport(nodeLabel) {
  await dazScript(`(function(){
    Scene.selectAllNodes(false);
    var oNode = Scene.findNodeByLabel(${JSON.stringify(nodeLabel)});
    if (!oNode) throw new Error("Node not found: ${nodeLabel}");
    oNode.select(true);
    Scene.setPrimarySelection(oNode);
    return "selected";
  })()`);
}

// NOT yet proven against the real server — built from three independently
// converging DAZ forum threads (one explicitly confirmed working by its
// own author), reusing App.getContentMgr(), which this file already uses
// elsewhere (ensureContentDirectoryRegistered, verifyDazCanFindFile) —
// not a fresh, unfamiliar API surface. openFile's second argument is
// merge: true applies the preset onto the current scene/selection rather
// than replacing it outright.
//
// PRECONDITION, handled by the caller: selectNodeForExport(nodeLabel)
// must run immediately before this — a pose preset applies to whatever
// node is currently selected, per DAZ's own documented behavior.
//
// Known real gotcha from a confirmed forum bug report, worth checking
// FIRST if this silently does nothing: a DUF's internal metadata must
// declare itself "preset_pose" — if it's saved as "wearable" or another
// type, openFile() loads it but never actually applies the pose. Worth
// opening _woman_idle_preset.duf as plain text to check this field
// directly if the first real test doesn't visibly move the figure.
// Confirmed real (docs.daz3d.com's own DzScene reference): setAnimRange
// and setPlayRange both take a DzTimeRange, measured in DAZ's own "tick"
// units (4800/sec), not frames directly. Deliberately reads
// Scene.getTimeStep() rather than hardcoding an assumed FPS (30 is
// common but not guaranteed) — the scene's own real tick-per-frame
// value, not a guess. This is the scripted fix for the "This preset
// contains information for frames beyond the length of your timeline"
// dialog seen applying the idle preset manually — pre-extending the
// timeline before openFile() should prevent the condition that triggers
// it, sidestepping a blocking modal a headless pipeline could never
// click through. NOT yet proven against the real server, same as
// applyPosePreset below it.
async function setTimelineRange(endFrame) {
  const result = await dazScript(`(function(){
    var tick = Scene.getTimeStep();
    var range = new DzTimeRange(0, ${endFrame} * tick);
    Scene.setAnimRange(range);
    Scene.setPlayRange(range);
    return "timeline set to 0-${endFrame}";
  })()`);
  console.log(`[setTimelineRange] ${result}`);
}

async function applyPosePreset(presetPath) {
  const result = await dazScript(`(function(){
    var oContentMgr = App.getContentMgr();
    var ok = oContentMgr.openFile(${JSON.stringify(presetPath)}, true);
    if (!ok) throw new Error("openFile() returned false for: ${presetPath}");
    return "applied pose preset: " + ${JSON.stringify(presetPath)};
  })()`);
  console.log(`[applyPosePreset] ${result}`);
}

// merge:false — loads dufPath as a genuinely fresh scene rather than
// merging into whatever's currently there. This is the "reload the
// original duf" step from the idle/walk sequencing discussion: cheaper
// and less error-prone than trying to revert bone-by-bone, since there's
// zero ambiguity about residual state — the scene IS the file's contents,
// nothing carried over from the idle preset that was just applied.
async function reloadDufFresh(dufPath) {
  const result = await dazScript(`(function(){
    var oContentMgr = App.getContentMgr();
    var ok = oContentMgr.openFile(${JSON.stringify(dufPath)}, false);
    if (!ok) throw new Error("openFile() returned false reloading: ${dufPath}");
    return "reloaded fresh: " + ${JSON.stringify(dufPath)};
  })()`);
  console.log(`[reloadDufFresh] ${result}`);
}

// Removes the default G9_Base_Shirt_Mesh / G9_Base_Shorts_Mesh nodes
// from the scene before it's saved/exported — confirmed present in
// every generated character's GLB (both genders) via live console
// inspection during MiniGlbViewer debugging. These come from whatever
// default-dressed figure Face Transfer operates on, not from anything
// this pipeline's own code adds — so the right fix is removing them
// from the DAZ scene tree directly, before export, rather than hiding
// them at runtime in the viewer.
//
// PRECONDITION: must run after selectNodeForExport(nodeLabel) (the
// figure needs to already be in the scene) and before
// saveSceneAsDuf(actorId) (removal has to happen before the scene gets
// written to disk for export).
//
// Confirmed against the live scene (first real run): Scene.findNodeByName
// does not exist as a method in this DAZ Script API at all — calling it
// throws a TypeError immediately, it doesn't just return null. Removed
// entirely; findNodeByLabel() alone is confirmed working — same method
// already proven for "Genesis 9" in selectNodeForExport() above.
//
// Second real finding (second live run): the label strings themselves
// were wrong too — used the underscore-joined mesh names as they
// appear in the exported GLB ("G9_Base_Shirt_Mesh"), but the actual
// in-scene DAZ label uses spaces ("G9 Base Shirt Mesh"). The GLB export
// step evidently converts spaces to underscores in mesh names; the
// scene's own node label never had them. Confirmed directly by the
// user checking the real scene tree.
//
// Third real finding (third live run, correct labels still not found):
// Scene.findNodeByLabel() only searches TOP-LEVEL scene nodes and
// returns just the first match — confirmed against DAZ's own
// forum/documentation, not a guess. Fitted clothing is parented as a
// CHILD of the figure it's fitted to, so it was never going to be
// found this way regardless of the label string. Fixed by searching
// the figure's own child hierarchy via findChildNodeByLabel(label,
// true) — recursive, called on the figure node itself (already the
// primary selection from the preceding selectNodeForExport() call),
// not Scene.findNodeByLabel() directly.
async function removeDefaultClothing() {
  // Fifth real finding on this feature: even with the confirmed-correct
  // labels and the null-child guard, a live run showed the master DUF
  // export (the one that actually becomes the final GLB's base mesh)
  // silently missed removing "G9 Base Shirt" because getNodeChild()
  // returned null for that one specific index on that specific call —
  // confirmed by the same DazScript succeeding cleanly on both other
  // calls in the very same pipeline run, same 3s startup delay each
  // time. Genuinely intermittent/timing-related, not deterministic —
  // the right fix is a retry at the JS level around the whole DazScript
  // call, not another change to the script itself.
  const maxAttempts = 3;
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await dazScript(`(function(){
    var names = ["G9 Base Shirt", "G9 Base Shorts"];
    var removed = [];
    var allLabelsFound = [];

    var oFigure = Scene.getPrimarySelection();
    if (!oFigure) {
      throw new Error("removeDefaultClothing: no primary selection — selectNodeForExport() must run before this");
    }

    // Fourth attempt on this feature — third convenience-method guess
    // (findChildNodeByLabel) also confirmed nonexistent by a live
    // TypeError. Rather than guess a fifth method name, walk the
    // figure's immediate children manually using only the most
    // fundamental, low-level DzNode primitives: getNumNodeChildren()
    // and getNodeChild(index) — far less likely to be missing than a
    // higher-level convenience method. Shallow (one level) rather than
    // fully recursive — fitted clothing is a direct child of the
    // figure, not nested inside the bone hierarchy (156 bones alone,
    // confirmed earlier tonight — recursing into that would be slow
    // and produce an unusably large log for no real benefit). Logs
    // every real immediate-child label found, not just matches — this
    // is what confirmed the actual, real labels: this shallow walk's
    // own log output showed the true immediate children as "G9 Base
    // Shirt" and "G9 Base Shorts" — no "Mesh" suffix at all. That
    // suffix only ever existed in the exported GLB's own mesh naming
    // convention, never the original DAZ scene node label.
    var numChildren = oFigure.getNumNodeChildren();
    for (var i = 0; i < numChildren; i++) {
      var child = oFigure.getNodeChild(i);
      // Real, live evidence: getNodeChild(i) can return null for some
      // index even within the range getNumNodeChildren() itself
      // reported — confirmed by a crash on a different character/run
      // than the one that produced the working label list. Doesn't
      // matter exactly why; skip nulls rather than assume every index
      // is valid.
      if (!child) continue;
      var label = child.getLabel();
      allLabelsFound.push(label);
      for (var j = 0; j < names.length; j++) {
        if (label === names[j]) {
          Scene.removeNode(child);
          removed.push(names[j]);
        }
      }
    }

    var alreadyGone = [];
    for (var k = 0; k < names.length; k++) {
      if (removed.indexOf(names[k]) === -1) alreadyGone.push(names[k]);
    }

    return "removed: [" + removed.join(", ") + "], not found among " + numChildren + " immediate children: [" + alreadyGone.join(", ") + "], all immediate child labels: [" + allLabelsFound.join(", ") + "]";
  })()`);

    console.log(`[removeDefaultClothing] attempt ${attempt}/${maxAttempts}: ${result}`);

    // "not found among N immediate children: []" (empty list) means
    // both names are accounted for this pass — either removed just now,
    // or already gone from a prior call in this same pipeline run
    // (which is fine, expected, and tolerated — see original comment
    // on the tolerant design further up this file's history). Anything
    // else means at least one name is still genuinely missing — retry.
    if (result.includes("immediate children: []")) break;
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1500));
  }
}

// Session 96: exportToBlender() (below) needs the scene already saved
// as a .duf — it reads Scene.getFilename() and embeds that path into
// the .dbz. Two straightforward attempts, not an elaborate hedge.
// variant defaults to "" — every existing call site (just the master DUF,
// today) keeps producing exactly ${actorId}.duf, unchanged. Idle/walk
// pass "_idle"/"_walk" to land as separate, non-colliding files in the
// same actor folder.
async function saveSceneAsDuf(actorId, variant = "") {
  const dufPath = `${CFG.macMiniTmpDir}/${actorId}/${actorId}${variant}.duf`;
  const result = await dazScript(`(function(){
    var path = ${JSON.stringify(dufPath)};
    Scene.saveScene(path);
    return "saved via Scene.saveScene: " + path;
  })()`);
  console.log(`[saveSceneAsDuf] ${result}`);
  return dufPath;
}

// PROVEN — this is the real logic from Diffeomorphic's own
// export_to_blender.dsa (Session 96, read verbatim from the installed
// script), with createDialog()/popup() stripped out since those show a
// blocking modal dialog. Everything below (exportToBlender and its
// helper functions: doDirs, doFigure, startObject, normString, doMesh,
// doHDMesh, doBaseMesh, endMesh, doProperties, doMaterialGroups,
// doVertices, doUVs, doPolylines, doFaces) is copied, not guessed —
// same file walking logic that already produced real, working .dbz
// exports tonight when run manually.
//
// useExportHD/useHDConvention/useHDUVs fixed to false — the standard,
// non-experimental export path, per Diffeomorphic's own documentation
// ("normally what you want to use").
//
// PRECONDITION, handled by the caller: saveSceneAsDuf() runs
// immediately before this in runPipeline, so the scene is already
// saved at dufPath by the time this executes. saveSceneAsDuf() itself
// is a new, real (not stale/placeholder) function above — worth
// watching its [saveSceneAsDuf] log line on the first live run, same
// as everything new tonight.
async function exportViaDiffeomorphic(actorId, dufPath) {
  const dbzPath = dufPath.replace(/\.duf$/, ".dbz");
  await dazScript(`(function(){
    var appName = "export_to_blender";
    var version = "\\"4.5.0.2668\\"";
    var useExportHD = false;
    var useHDConvention = false;
    var useHDUVs = false;

    function exportToBlender(filepath)
    {
        var filepath0 = filepath + "0"
        fp = new DzFile( filepath0 );
        fp.open( fp.WriteOnly );

        fp.writeLine("{");
        fp.writeLine("    \\"application\\": \\"export_highdef_to_blender\\",");
        fp.writeLine("    \\"version\\": " + version + ",");

        var origpath = Scene.getFilename();
        fp.writeLine("    \\"filepath\\": \\"" + normString(origpath) + "\\",");

        var cmgr = App.getContentMgr();
        fp.writeLine("    \\"rootpaths\\": {");
        doDirs(fp, "content", cmgr.getNumContentDirectories(), cmgr.getContentDirectoryPath);
        doDirs(fp, "builtin_mdl", cmgr.getNumBuiltInMDLDirectories(), cmgr.getBuiltInMDLDirectoryPath);
        doDirs(fp, "import_dirs", cmgr.getNumImportDirectories(), cmgr.getImportDirectoryPath);
        doDirs(fp, "mdl_dirs", cmgr.getNumMDLDirectories(), cmgr.getMDLDirectoryPath);
        path = cmgr.getBuiltInContentDirectoryPath();
        fp.writeLine("        \\"builtin_content\\" : \\"" + normString(path) + "\\",");
        path = cmgr.getCloudContentDirectoryPath();
        fp.writeLine("        \\"cloud_content\\" : \\"" + normString(path) + "\\"");
        fp.writeLine("    },")

        fp.writeLine("    \\"figures\\": [");

        for ( var i = 0; i < Scene.getNumNodes(); i++ )
        {
            var node = Scene.getNode(i);
            if ( node.inherits( "DzSkeleton" ) )
            {
                doFigure(fp, node);
            }
            else
            {
                obj = node.getObject();
                if (obj != null)
                {
                    doMesh(fp, obj, true, node, "        ]", "    },");
                }
                else
                {
                    var clname = node.className();
                    if (clname != "DzBone")
                    {
                        startObject(fp, node, node.assetId, "", "");
                        fp.writeLine("    }," );
                    }
                }
            }
        }

        fp.writeLine("    {");
        fp.writeLine("        \\"name\\": \\"dummy\\",");
        fp.writeLine("        \\"num verts\\": 0");
        fp.writeLine("    }");
        fp.writeLine("    ]");
        fp.writeLine("}" );
        fp.close();

        var fp1 = new DzGZFile( filepath );
        var ok = fp1.zip(filepath0);
        fp1.close();
        if (ok) { fp.remove() }
        else { var oDir = fp.dir(); oDir.move(filepath0, filepath) }
        return ok;
    }

    function doDirs(fp, key, ndirs, fcn)
    {
        fp.writeLine("        \\"" + key + "\\": [");
        var c = ",";
        for (var n=0; n<ndirs; n++)
        {
            if (n == ndirs-1) c = "";
            fp.writeLine("            \\"" + normString(fcn(n)) + "\\"" + c);
        }
        fp.writeLine("        ],");
    }

    function doFigure(fp, figure)
    {
        figure.finalize();
        startObject(fp, figure, normString(figure.name), "", ",");
        var obj = figure.getObject();
        if (obj != null) { doMesh(fp, obj, false, figure, "        ],", ""); }
        var bones = figure.getAllBones();
        var n = bones.length;
        fp.writeLine("        \\"bones\\": ");
        fp.writeLine("        [");
        c = ","
        for( var i = 0; i < n; i++ )
        {
            bone = bones[i];
            bone.finalize();
            startObject(fp, bone, normString(bone.name), "        ", ",")
            fp.writeLine("                \\"origin\\": " + bone.getOrigin());
            if (i == n-1) c = "";
            fp.writeLine("            }" + c );
        }
        fp.writeLine("        ]");
        fp.writeLine("    }," );
    }

    function startObject(fp, node, name, pad, endchar)
    {
        fp.writeLine(pad + "    {" );
        fp.writeLine(pad + "        \\"name\\": \\"" + normString(name) + "\\",");
        fp.writeLine(pad + "        \\"id\\": \\"" + normString(node.assetId) + "\\",");
        fp.writeLine(pad + "        \\"label\\": \\"" + normString(node.getLabel()) + "\\",");
        fp.writeLine(pad + "        \\"center_point\\": " + node.getOrigin() + ",");
        fp.writeLine(pad + "        \\"end_point\\": " + node.getEndPoint() + ",");
        fp.writeLine(pad + "        \\"orientation\\": " + node.getOrientation() + ",");
        fp.writeLine(pad + "        \\"rotation_order\\": \\"" + node.getRotationOrder() + "\\",");
        fp.writeLine(pad + "        \\"ws_transform\\": " + node.getWSTransform() + endchar);
    }

    function normString(string) { return encodeURI(string).replace(/%20/g, " "); }

    function doMesh(fp, obj, start, node, str1, str2)
    {
        var shape = obj.getCurrentShape();
        if (shape == null) return false;
        var clname = node.className();
        if (start) startObject(fp, node, normString(node.name), "", ",");
        fp.writeLine("        \\"class\\": \\"" + clname + "\\",");
        var useBase = true;
        var label = node.getLabel();
        if (useExportHD && (label.endsWith("HD") || !useHDConvention))
            useBase = doHDMesh(fp, obj, shape, clname, node, str1, str2);
        if (useBase) doBaseMesh(fp, obj, shape, clname, node, str1, str2);
    }

    function doHDMesh(fp, obj, shape, clname, node, str1, str2)
    {
        var geom = obj.getCachedGeom();
        var geom0 = shape.getGeometry();
        var nv = geom.getNumVertices();
        var nv0 = geom0.getNumVertices();
        var level = shape.getSubDDrawLevel();
        if (clname == "DzGeometryShellNode") {
            fp.writeLine("        \\"num verts\\": " + nv0 + ",");
            fp.writeLine("        \\"num hd verts\\": " + nv + ",");
            if (useHDUVs) doUVs(fp, geom, "hd ");
            doFaces(fp, geom, "hd ");
            doMaterialGroups(fp, geom, "hd ", "");
            fp.writeLine(str2);
            return false;
        }
        var nf = geom.getNumFacets();
        if (nv != nv0 && nf > 0)
        {
            fp.writeLine("        \\"subd level\\": " + level + ",");
            doVertices(fp, geom, "hd ");
            fp.writeLine("        ],");
            if (useHDUVs) doUVs(fp, geom, "hd ");
            doFaces(fp, geom, "hd ");
            doMaterialGroups(fp, geom, "hd ", ",");
        }
        return true;
    }

    function doBaseMesh(fp, obj, shape, clname, node, str1, str2)
    {
        var lodctrl = shape.getLODControl();
        var lodvalue = lodctrl.getValue();
        lodctrl.setValue(0);
        obj.forceCacheUpdate(node,false);
        var geom = obj.getCachedGeom();
        if (geom == null) { lodctrl.setValue(lodvalue); return endMesh(fp, str1, str2); }
        if (clname == "DzStrandHairNode")
        {
            fp.writeLine("        \\"node\\": {");
            doProperties(fp, node, "        ");
            fp.writeLine("        },");
            doFaces(fp, geom, "");
        }
        fp.writeLine("        \\"lod\\": " + lodvalue + ",");
        var nf = geom.getNumFacets();
        if (nf == 0) doPolylines(fp, geom, "");
        doMaterialGroups(fp, geom, "", ",");
        doVertices(fp, geom, "");
        fp.writeLine(str1);
        fp.writeLine(str2);
        lodctrl.setValue(lodvalue);
        return true;
    }

    function endMesh(fp, str1, str2) { fp.writeLine("        \\"dummy\\": 0"); fp.writeLine(str2); return false; }

    function doProperties(fp, mat, pad)
    {
        var np = mat.getNumProperties();
        var buf = (pad + "   \\"name\\": \\"" + normString(mat.name) + "\\",\\n");
        buf += (pad + "   \\"properties\\": {\\n" );
        var c = ","
        for (var i = 0; i < np; i++)
        {
            var prop = mat.getProperty(i);
            var value = prop.getValue();
            if (i == np-1) c = "";
            if (prop.isNumeric()) buf += (pad + "      \\"" + normString(prop.name) + "\\": " + value + c + "\\n");
        }
        buf += (pad + "   }");
        fp.writeLine(buf);
    }

    function doMaterialGroups(fp, geom, hd, endchar)
    {
        var nm = geom.getNumMaterialGroups();
        fp.writeLine("        \\"" + hd + "material groups\\": [" );
        var c = ","
        for (var i = 0; i < nm; i++)
        {
            var mat = geom.getMaterialGroup(i);
            if (i == nm-1) c = "";
            fp.writeLine("            \\"" + normString(mat.name) + "\\"" + c);
        }
        fp.writeLine("        ]" + endchar);
    }

    function doVertices(fp, geom, hd)
    {
        var nv = geom.getNumVertices();
        var buf = ("        \\"num " + hd + "verts\\": " + nv + ",\\n");
        buf += ("        \\"" + hd + "vertices\\": [\\n" );
        var c = ",\\n"
        for (var i = 0; i < nv; i++)
        {
            var v = geom.getVertex(i);
            if (i == nv-1) c = "";
            buf += ("            [" + v.x + ", " + v.y + ", " + v.z + "]" + c)
        }
        fp.writeLine(buf);
    }

    function doUVs(fp, geom, hd)
    {
        var uvs = geom.getUVs();
        var nuv = uvs.getNumValues();
        var label = uvs.getLabel();
        var buf = ("        \\"" + hd + "uvset\\": \\"" + label + "\\",\\n");
        buf += ("        \\"" + hd + "uvs\\": [\\n" );
        var c = ",\\n"
        for (var i = 0; i < nuv; i++)
        {
            var uv = uvs.getPnt2Vec(i);
            if (i == nuv-1) c = "\\n";
            buf += ("            [" + uv.x + ", " + uv.y + "]" + c);
        }
        buf += ("        ],");
        fp.writeLine(buf);
    }

    function doPolylines(fp, geom, hd)
    {
        var npl = geom.getNumPolylines();
        var buf = ("        \\"" + hd + "polylines\\": [\\n" );
        var c = ",\\n"
        for (var i = 0; i < npl; i++)
        {
            var vlist = geom.getPolylineVertexIndices(i);
            if (i == npl-1) c = "\\n";
            buf += ("            [" + vlist + "]" + c)
        }
        buf += ("        ],");
        fp.writeLine(buf);
        buf = ("        \\"" + hd + "polyline_materials\\": [" );
        c = ","
        for (var i = 0; i < npl; i++)
        {
            var idx = geom.getPolylineMaterialGroupIndex(i);
            if (i == npl-1) c = "";
            buf += (idx + c)
        }
        buf += ("],");
        fp.writeLine(buf);
    }

    function doFaces(fp, geom, hd)
    {
        var nf = geom.getNumFacets();
        var buf = ("        \\"" + hd + "faces\\": [\\n" );
        var c = ",\\n"
        for (var i = 0; i < nf; i++)
        {
            var f = geom.getFacet(i);
            if (i == nf-1) c = "\\n";
            buf += ("            " + f + c)
        }
        buf += ("        ],");
        fp.writeLine(buf);
    }

    var ok = exportToBlender(${JSON.stringify(dbzPath)});
    return "exported: " + ${JSON.stringify(dbzPath)} + " ok=" + ok;
  })()`);
  return dbzPath;
}

// Session 96, testing the real internal name format instead of a
// friendly label. Every attempt so far (9 guessed keys, then a preset
// hypothesis) used friendly labels like "Proportion Height" as the
// value. But the one manual export that DID produce real shape keys
// (112 of them, on the shirt) shows the actual naming convention:
// "G9BaseShirt__facs_bs_MouthLeft" — mesh name, double underscore,
// then a real internal identifier ("facs_bs_MouthLeft"), not the
// friendly label ("Mouth Left") at all. That's a genuinely different
// variable than anything tried before — real evidence, not a guess —
// so worth testing before anything else.
//
// Trying both the bare internal name and the full prefixed form, since
// it's not yet known which one (if either) this exporter's settings
// actually expect as an input value.
const TEST_MORPH_NAME_BARE = "facs_bs_MouthLeft";
const TEST_MORPH_NAME_PREFIXED = "Genesis9__facs_bs_MouthLeft"; // guessing the body's own mesh prefix, unconfirmed

async function exportBlendSilent(actorId) {
  const remoteBlendPath = `${CFG.macMiniTmpDir}/${actorId}/${actorId}.blend`;
  const result = await dazScript(`(function(){
    var oExp = App.getExportMgr().getExporter(0);
    var oSettings = new DzFileIOSettings();
    oExp.getOptions(oSettings, false, "");
    oSettings.setIntValue("RunSilent", 1);

    var report = [];
    var bare = ${JSON.stringify(TEST_MORPH_NAME_BARE)};
    var prefixed = ${JSON.stringify(TEST_MORPH_NAME_PREFIXED)};
    var attempts = [
      function(){ oSettings.setStringValue("MorphList", bare); },
      function(){ oSettings.setStringValue("SelectedMorphs", bare); },
      function(){ oSettings.setStringValue("MorphListValue", bare); },
      function(){ oSettings.setStringValue("aMorphList", bare); },
      function(){ oSettings.setStringValue("MorphList", prefixed); },
      function(){ oSettings.setStringValue("MorphListValue", prefixed); },
    ];
    for (var i = 0; i < attempts.length; i++) {
      try { attempts[i](); report.push("attempt " + i + ": no throw"); }
      catch (e) { report.push("attempt " + i + " FAILED: " + e); }
    }
    report.push("settings now: " + oSettings.toJsonString());

    oExp.writeFile(${JSON.stringify(remoteBlendPath)}, oSettings);
    report.push("exported: " + ${JSON.stringify(remoteBlendPath)});
    return report.join(" | ");
  })()`);
  console.log(`[exportBlendSilent] ${result}`);
  return remoteBlendPath;
}

async function convertBlendToGlb(actorId, remoteBlendPath) {
  const remoteGlbPath = `${CFG.macMiniTmpDir}/${actorId}/${actorId}.glb`;
  const remoteCmd = `${shellQuote(CFG.macMiniBlenderPath)} --background --python ${shellQuote(CFG.macMiniConvertScript)} -- ${shellQuote(remoteBlendPath)} ${shellQuote(remoteGlbPath)}`;
  const cmd = `ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(remoteCmd)}`;
  const { stdout, stderr } = await execAsync(cmd, { timeout: CFG.daztimeoutMs });
  if (!stdout.includes("Export complete")) {
    throw new Error(`Blender conversion did not report success. stdout: ${stdout} stderr: ${stderr}`);
  }
  return remoteGlbPath;
}

// Session 96 — replaces convertBlendToGlb() in the pipeline. Same
// SSH/Blender-headless pattern, but drives convert_diffeomorphic.py:
// imports the .duf via Diffeomorphic (with the real Genesis 9 morphs
// this whole session was about, via the reusable favorite_morphs.json)
// instead of just opening a plain .blend. GLB-export settings inside
// that script are byte-identical to the proven convertBlendToGlb above.
// variant defaults to "" — the existing master-character call site is
// unaffected. Genuinely necessary for idle/walk, not just tidiness: this
// function previously derived remoteBlendPath/remoteGlbPath from actorId
// ALONE, ignoring dufPath entirely — three calls with three different
// dufPaths but the same actorId would have silently overwritten the same
// ${actorId}.blend/.glb three times, last write wins. Caught before it
// shipped, not after.
async function convertViaDiffeomorphic(actorId, dufPath, variant = "", importAnimation = false, morphValues = null) {
  const remoteBlendPath = `${CFG.macMiniTmpDir}/${actorId}/${actorId}${variant}.blend`;
  const remoteGlbPath = `${CFG.macMiniTmpDir}/${actorId}/${actorId}${variant}.glb`;
  // importAnimation, Session 97: passed through as the Python script's
  // new optional 5th CLI arg. Real, confirmed gap — easy_import_daz()
  // alone never captures animation/pose data (confirmed via
  // check_animation_data.py: zero Actions, zero NLA tracks on an idle
  // .blend despite the source DUF genuinely having the pose data). true
  // for idle/walk specifically; the master never needs this.
  const animFlag = importAnimation ? "true" : "false";
  // targetHeightCm / precomputedScaleFactor — REMOVED entirely
  // (Session 101+), not just disabled. Real, explicit decision after
  // three separate bugs in a row (feet below floor level, master/idle/
  // walk each computing a different scale factor and breaking
  // animation data, then a still-unexplained deformation even after
  // fixing both of those). convert_diffeomorphic.py no longer touches
  // height or scale at all — same unmodified export non-Advanced mode
  // has always produced. Real height and body-shape now handled
  // entirely client-side via GLB morph sliders.
  //
  // morphValues, Session 101+: real fix for a real, confirmed bug —
  // Diffeomorphic's import path for FAVORITED morphs (useFavoMorphs)
  // initializes the shape key AND its backing armature custom property
  // at 0, never actually reading the .duf's real current_value at all
  // — confirmed directly, byte for byte, against the saved .duf file
  // itself (correct values genuinely present there) versus the
  // post-import .blend (zeros, for every favorited morph checked).
  // The driver meant to bridge the two has a malformed, unresolvable
  // target data_path (confirmed via path_resolve() failing on it) — a
  // third-party add-on bug this project doesn't control and can't
  // patch at the source. Real fix instead: hand convert_diffeomorphic.py
  // the exact values applyBodyShape() already computed and confirmed
  // in DAZ, so it can bypass the broken linkage entirely — remove each
  // driver, set the real value directly, the same proven technique
  // already used throughout this project's own calibration testing.
  const morphValuesArg = (morphValues && Object.keys(morphValues).length > 0) ? JSON.stringify(morphValues) : "";
  const remoteCmd = `${shellQuote(CFG.macMiniBlenderPath)} --background --python ${shellQuote(CFG.macMiniConvertScriptDiffeomorphic)} -- ${shellQuote(dufPath)} ${shellQuote(CFG.macMiniFavoritesJsonPath)} ${shellQuote(remoteBlendPath)} ${shellQuote(remoteGlbPath)} ${shellQuote(animFlag)} ${shellQuote(morphValuesArg)}`;
  const cmd = `ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(remoteCmd)}`;
  const { stdout, stderr } = await execAsync(cmd, { timeout: CFG.daztimeoutMs });
  // Real gap, closed here: this stdout used to be silently discarded on
  // success — meaning every MORPH VALUES APPLIED line
  // convert_diffeomorphic.py prints (confirming whether that fix
  // actually ran) was thrown away regardless of outcome, leaving no
  // way to tell from the logs whether it fired at all. Logging it
  // unconditionally now.
  console.log(`[convertViaDiffeomorphic] ${actorId}${variant} stdout: ${stdout}`);
  if (!stdout.includes("Export complete")) {
    throw new Error(`Diffeomorphic conversion did not report success. stdout: ${stdout} stderr: ${stderr}`);
  }
  // Returns both paths now, not just the GLB — idle/walk only need
  // remoteBlendPath (they're merge sources for a not-yet-built step that
  // appends their Actions into the master .blend, not final deliverables
  // on their own). The master call site still uses remoteGlbPath exactly
  // as before. Worth noting honestly: this doesn't confirm whether
  // convert_diffeomorphic.py itself can be told to skip GLB export for
  // the idle/walk case — that's real, unverified ground in the Python
  // script, not something this file's own code can settle. What this
  // DOES fix with confidence: the wasteful SCP transfer of an idle/walk
  // GLB that was never actually used for anything.
  return { remoteBlendPath, remoteGlbPath };
}

// Lands the GLB inside the SAME public/media/actors/{media_folder}/ tree
// the existing photo-upload handler already uses, under a new "3d"
// subfolder — same convention as its "images"/"voice" subfolders.
// Real implementation (Session 97) — matches convertViaDiffeomorphic's
// exact SSH/Blender-headless pattern. merge_animations.py does the
// actual work (bpy.data.libraries.load + NLA tracks + one glTF export);
// see that file's own comments for what's proven vs. not yet confirmed
// on the Blender side specifically.
//
// Session 143 — GENERALIZED to the presets-directory contract: takes
// the discovered variant list instead of a fixed idle/walk/sit shape.
// CONTRACT (both sides shipped together, never one alone):
//   merge_animations.py -- <master_blend> <glb_out> <name>=<path>[:loop] ...
// Loop-seam correction is applied per-clip only when :loop is present
// — the author encodes cyclicity in the preset filename (see CFG).
async function mergeAnimationsIntoMasterBlend(actorId, masterBlendPath, variantEntries) {
  const glbPath = `${CFG.macMiniTmpDir}/${actorId}/${actorId}.glb`;
  const clipArgs = variantEntries
    .map(({ name, path: blendPath, loop }) => shellQuote(`${name}=${blendPath}${loop ? ":loop" : ""}`))
    .join(" ");
  if (!variantEntries.length) {
    console.warn(`[mergeAnimationsIntoMasterBlend] ${actorId}: ZERO animation variants — the presets directory produced nothing usable. Exporting the master with no clips rather than failing the whole generation.`);
  }
  const remoteCmd = `${shellQuote(CFG.macMiniBlenderPath)} --background --python ${shellQuote(CFG.macMiniMergeAnimationsScript)} -- ${shellQuote(masterBlendPath)} ${shellQuote(glbPath)}${clipArgs ? " " + clipArgs : ""}`;
  const cmd = `ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(remoteCmd)}`;
  const { stdout, stderr } = await execAsync(cmd, { timeout: CFG.daztimeoutMs });
  if (!stdout.includes("Export complete")) {
    throw new Error(`Animation merge did not report success. stdout: ${stdout} stderr: ${stderr}`);
  }
  console.log(`[mergeAnimationsIntoMasterBlend] merged [${variantEntries.map((v) => v.name).join(", ") || "none"}] into ${glbPath}`);
  return glbPath;
}

async function pullGlbToServer({ __dirname, actorId, mediaFolder, remoteGlbPath, macMiniUser, macMiniHost }) {
  const dir = path.join(__dirname, "../public/media/actors", mediaFolder, "3d");
  await execAsync(`mkdir -p ${shellQuote(dir)}`, { timeout: 15_000 });
  const localPath = path.join(dir, `${actorId}.glb`);
  await execAsync(`scp ${macMiniUser}@${macMiniHost}:${scpRemoteEscape(remoteGlbPath)} ${shellQuote(localPath)}`, { timeout: 60_000 });
  return `/media/actors/${mediaFolder}/3d/${actorId}.glb`;
}

// Real, Session 101+: copies front_rows.png/side_rows.png (confirmed
// real, written by interpret_body.py at lines 438/442 — the reference
// images the client-side slider-fitting UI needs) into the exact same
// public/media/actors/{media_folder}/3d/ folder the GLB itself lands
// in, matching pullGlbToServer()'s own pattern exactly. Only called
// when remoteDebugDir is non-null (Advanced/body-photos path) — no
// debug dir exists otherwise, nothing to pull. Returns null (not an
// error) if remoteDebugDir wasn't provided, so the caller can handle
// "no reference images this run" without a special case.
async function pullReferenceImagesToServer({ __dirname, actorId, mediaFolder, remoteDebugDir, macMiniUser, macMiniHost }) {
  if (!remoteDebugDir) return null;
  const dir = path.join(__dirname, "../public/media/actors", mediaFolder, "3d");
  await execAsync(`mkdir -p ${shellQuote(dir)}`, { timeout: 15_000 });
  const files = ["front_rows.png", "side_rows.png"];
  for (const file of files) {
    const localPath = path.join(dir, `${actorId}_${file}`);
    const remotePath = `${remoteDebugDir}/${file}`;
    await execAsync(`scp ${macMiniUser}@${macMiniHost}:${scpRemoteEscape(remotePath)} ${shellQuote(localPath)}`, { timeout: 60_000 });
  }
  console.log(`[pullReferenceImagesToServer] ${actorId}: copied front_rows.png/side_rows.png to ${dir}`);

  // Session 102 — ALSO pull the RAW reference photos ({id}_front.jpeg /
  // {id}_side.jpeg, staged in the actor's scratch root for
  // interpret_body). Two reasons, both learned live: (1) the drafts
  // disk-fallback shows the raw photo as the reference backdrop (user
  // verdict: better than the rows silhouette) but could only find them
  // for a manually-resurrected character — the pipeline never pulled
  // them; (2) save-draft now DELETES the Mac Mini scratch, so without
  // this pull the raw photos' only copy dies on save (Benny's did —
  // irrecoverable). Non-fatal per file: a face-only generation has no
  // body photos and that's fine.
  for (const suffix of ["front", "side", "back"]) {
    const remoteRaw = `${remoteDebugDir}/../${actorId}_${suffix}.jpeg`;
    const localRaw = path.join(dir, `${actorId}_${suffix}.jpeg`);
    try {
      await execAsync(`scp ${macMiniUser}@${macMiniHost}:${scpRemoteEscape(remoteRaw)} ${shellQuote(localRaw)}`, { timeout: 60_000 });
      console.log(`[pullReferenceImagesToServer] ${actorId}: copied raw ${suffix} reference photo`);
    } catch (e) {
      console.log(`[pullReferenceImagesToServer] ${actorId}: no raw ${suffix} photo in scratch (non-fatal): ${e.message}`);
    }
  }

  // Real feature (Session 101+) — measurements.json's own calibration
  // block (front/side_px_per_cm_silhouette, front/side_bottom_px) is
  // what lets MiniGlbViewer's reference-image plane scale and ground
  // itself to the photo's real measured height, rather than a fixed
  // guess (confirmed wrong earlier this session — the debug PNGs have
  // real black padding around the subject). remoteDebugDir is
  // ${actorFolder}/debug — measurements.json itself lives one level up,
  // in the actor's own root folder (confirmed directly against
  // runInterpretBody()'s own remoteOutPath). Pulled alongside the two
  // PNGs, into the same folder, for the same record-keeping reason.
  const remoteMeasurementsPath = `${remoteDebugDir}/../${actorId}-measurements.json`;
  const localMeasurementsPath = path.join(dir, `${actorId}-measurements.json`);
  let calibration = null;
  let measurements = null;
  try {
    await execAsync(`scp ${macMiniUser}@${macMiniHost}:${scpRemoteEscape(remoteMeasurementsPath)} ${shellQuote(localMeasurementsPath)}`, { timeout: 60_000 });
    const raw = fs.readFileSync(localMeasurementsPath, "utf8");
    const parsed = JSON.parse(raw);
    calibration = parsed.calibration || null;
    // Session 102 — keep the whole parsed file, not just .calibration:
    // the wizard's "Apply measured proportions" solve reads
    // input_height_cm and the silhouette section. Same non-fatal
    // contract as calibration — absent on failure, feature just
    // stays disabled client-side.
    measurements = parsed;
    console.log(`[pullReferenceImagesToServer] ${actorId}: copied measurements.json to ${dir}, calibration=${JSON.stringify(calibration)}`);
  } catch (err) {
    // Non-fatal — the reference-image toggle just falls back to
    // MiniGlbViewer's own fixed-height guess (already the documented
    // behavior when no calibration is available) rather than failing
    // the whole generation over a fine-tuning feature.
    console.error(`[pullReferenceImagesToServer] ${actorId}: failed to pull/parse measurements.json (non-fatal, reference plane will use the fixed-height fallback): ${err.message || err}`);
  }

  return {
    frontUrl: `/media/actors/${mediaFolder}/3d/${actorId}_front_rows.png`,
    sideUrl: `/media/actors/${mediaFolder}/3d/${actorId}_side_rows.png`,
    calibration,
    measurements,
  };
}

// Real, strong new lead: DAZ_3D_SERVER_TMP was never registered as a
// known Content Directory in DAZ Studio's own Content Database — it's
// just a raw folder we write to. Every check tonight (test -f, byte-size
// stat) only confirms the OS filesystem sees the file; none of them prove
// DAZ's own internal content-awareness system does. This registers the
// base directory once (idempotent — checked, not re-added every run),
// forces a refresh, then verifies via DAZ's own findFile() — a genuine
// DAZ-native confirmation, not another OS-level proxy for one.
async function ensureContentDirectoryRegistered() {
  const isMapped = await dazScript(`(function(){
    var oMgr = App.getContentMgr();
    return oMgr.contentDirectoryIsMapped(${JSON.stringify(CFG.macMiniTmpDir)});
  })()`);
  if (!isMapped) {
    console.log("[ensureContentDirectoryRegistered] registering DAZ_3D_SERVER_TMP as a content directory for the first time");
    await dazScript(`(function(){
      var oMgr = App.getContentMgr();
      oMgr.addContentDirectory(${JSON.stringify(CFG.macMiniTmpDir)});
      return "added";
    })()`);
  }
  await dazScript(`(function(){
    var oMgr = App.getContentMgr();
    oMgr.refresh();
    return "content database refreshed";
  })()`);
}

async function verifyDazCanFindFile(remotePath) {
  const found = await dazScript(`(function(){
    var oMgr = App.getContentMgr();
    var result = oMgr.findFile(${JSON.stringify(remotePath)}, oMgr.AllDirs);
    return result || "";
  })()`);
  if (!found) {
    throw new Error(`DAZ's own Content Database could not find the file via findFile(), even though it exists on disk: ${remotePath}`);
  }
  console.log(`[verifyDazCanFindFile] DAZ confirms it can find: ${found}`);
}

async function disablePrompts() {
  // Confirmed real, callable (Session 94 curl test) — App.showPrompts(),
  // the same mechanism behind the -noPrompt startup flag, but callable
  // from script rather than only at launch. First genuinely new lead on
  // the reference.jpg dialog after several other approaches were ruled
  // out with real evidence. One thing worth watching for on the next
  // real run: some suppression modes have been reported (DAZ forums) to
  // cause a dialog to be silently logged and the app closed, rather than
  // just hidden — different behavior than the current indefinite hang,
  // and if that happens it'd at least surface as a real, catchable error
  // instead of a silent block.
  await dazScript(`(function(){ App.showPrompts(false); return "prompts disabled"; })()`);
}

async function runPipeline({ db, __dirname, actorId, localPhotoPath, mediaFolder, gender, torsoLength, armsLength, legsLength, localBodyFrontPath, localBodySidePath, localBodyBackPath, bodyHeightCm, nodeLabel = "Genesis 9" }) {
  try {
    // Architectural fix (Session 94): rather than keep fighting state
    // that persists across generations within one long-running DAZ
    // Studio process (leftover figures, stale combo-box history — every
    // intermittent bug chased tonight), start every single generation
    // from a genuinely fresh process. Costs ~30-45s of startup time per
    // generation; in exchange, nothing from a previous run can ever
    // survive to interfere with the next one. Reuses restartDazStudio()
    // — already proven, already used for error recovery — just calling
    // it unconditionally now, not only on failure.
    setStatus(actorId, "starting_daz_studio");
    await restartDazStudio();

    setStatus(actorId, "uploading_photo");
    const remotePhotoPath = await pushPhotoToDAZServer(actorId, localPhotoPath);

    setStatus(actorId, "generating_face");
    await runDazGenerationSequence(actorId, remotePhotoPath, gender);

    // CORRECTION (Session 101+) to the note below: applyBodyShape() is
    // revived, conditionally. The Session 96 reasoning was correct for
    // what it was actually about — the wizard's synthetic 0-100
    // torsoLength/armsLength/legsLength dial values (no ground truth,
    // arbitrary style preference, so client-side morphTargetInfluences
    // is genuinely the right call: instant, free, zero round-trip).
    // That path is UNCHANGED — torsoLength/armsLength/legsLength above
    // are still not used here, still belong client-side. What's new: a
    // real photo-measured proportion is a different kind of input, not
    // a style preference, and only exists at all when the wizard's
    // Advanced/body-photos path was used — hence conditional, not a
    // blanket revival. See applyBodyShape()'s own header for what's
    // confirmed vs. guessed within this new path specifically.
    //
    // Original Session 96 note, kept for history rather than deleted:
    // "applyBodyShape removed from the pipeline — real architecture
    // correction, not a bug fix. The three morphs are already real,
    // adjustable shape keys in every GLB this pipeline produces
    // (favorite_morphs.json + Baked Morphs, confirmed via
    // check_shape_keys.py). There's no reason to also set a specific
    // value on the DAZ side at generation time — that's solving a
    // problem the architecture doesn't have."
    //
    // UPDATE (Session 101+): Height's DAZ-side root YScale, set below,
    // is CONFIRMED to NOT survive Diffeomorphic's export at all — real,
    // multi-way-confirmed finding (mesh_obj.scale reads flat identity
    // after import regardless of YScale; the wizard's displayed height
    // for a 184cm-target generation matched manual Blender ruler
    // measurement of the UNSCALED default almost exactly). Left in
    // place here anyway — harmless, and gives a reasonable live preview
    // in DAZ Studio's own viewport — but it is NOT what makes the real
    // exported height correct anymore. The actual fix now lives in
    // convert_diffeomorphic.py (target_height_cm arg, applied and
    // baked in Blender, right after import) — see that file's own
    // header for the full chain of evidence.
    // UPDATE (Session 101+): applyBodyShape() is no longer called here.
    // Real, deliberate architecture change, not a bug fix — photo-
    // derived auto-fitting is being replaced by client-side slider
    // fitting against the front/side reference images instead. What
    // still runs: interpret_body.py, conditionally, when Advanced/body
    // photos are provided — not for its measurement numbers anymore,
    // but because it's what produces front_rows.png/side_rows.png
    // (confirmed real, written at lines 438/442 of that script), the
    // actual reference images the new slider-fitting UI needs.
    // bakeAllMorphsAtDefault() runs unconditionally for every
    // generation, Advanced or not — every character should ship with
    // the full set of real, live sliders, not just ones with body
    // photos.
    let morphValues = null; // real values, all 0 — passed to convert_diffeomorphic.py to bypass Diffeomorphic's broken driver linkage for favorited morphs
    let remoteDebugDir = null; // real debug_dir from interpret_body.py, when Advanced photos were provided — used below to pull front_rows.png/side_rows.png alongside the GLB
    if (localBodyFrontPath && localBodySidePath && localBodyBackPath && bodyHeightCm) {
      setStatus(actorId, "capturing_reference_images");
      const remoteBodyPaths = await pushBodyPhotosToDAZServer(actorId, localBodyFrontPath, localBodySidePath, localBodyBackPath);
      const measurements = await runInterpretBody(actorId, remoteBodyPaths, bodyHeightCm);
      remoteDebugDir = measurements.debug_dir;
      console.log(`[runPipeline] ${actorId}: reference images captured (debug_dir=${remoteDebugDir}); measurements themselves no longer used to set morph values`);
    } else {
      console.log(`[runPipeline] ${actorId}: Advanced/body photos not provided — no reference images this run, client-side slider path unaffected`);
    }
    setStatus(actorId, "applying_body_shape");
    morphValues = await bakeAllMorphsAtDefault(nodeLabel);

    setStatus(actorId, "selecting_node");
    await selectNodeForExport(nodeLabel);
    await removeDefaultClothing();

    setStatus(actorId, "saving_duf");
    const dufPath = await saveSceneAsDuf(actorId);

    setStatus(actorId, "exporting");
    await exportViaDiffeomorphic(actorId, dufPath); // writes the matching .dbz next to dufPath

    // Session 97 CORRECTION: this used to go straight to GLB, get
    // downloaded, and get marked "ready" right here — wrong. Real
    // ordering error, not a small tweak: there should only ever be ONE
    // GLB downloaded and shown, the FINAL one, after idle/walk are
    // merged in below. The master only needs to become a .blend at this
    // point — a source for the merge step, not a finished deliverable.
    setStatus(actorId, "converting");
    const { remoteBlendPath: masterBlendPath } = await convertViaDiffeomorphic(actorId, dufPath, "", false, morphValues);


    // Idle/walk: each gets its own timeline range, its own preset
    // applied, its own DUF, its own .blend — all sources for the merge
    // below, same as the master. NOT downloaded, NOT written to the
    // actors table — see the comments inside the loop.
    // Session 143 — discovery-driven: every preset in the presets
    // directory becomes a clip on this character (see the CFG comment
    // for the full contract). Frame ranges parsed from each .duf; a
    // preset that parses to 0 frames is refused loudly rather than
    // guessed at.
    const posePresets = await discoverPosePresets(gender);
    const variantEntries = []; // [{ name, path, loop }] for the merge

    for (const { clipName, presetPath, loop } of posePresets) {
      const variant = `_${clipName}`;
      let endFrame = 0;
      try {
        endFrame = await parseRemoteDufFrames(presetPath);
      } catch (e) {
        console.error(`[runPipeline] could not parse frame range from ${presetPath}: ${e.message} — skipping "${clipName}". The GLB will be missing this clip.`);
        continue;
      }
      if (!endFrame) {
        console.error(`[runPipeline] "${clipName}" parsed to 0 animated frames (static preset?) — skipping rather than guessing a timeline range. The GLB will be missing this clip.`);
        continue;
      }
      console.log(`[runPipeline] "${clipName}": ${endFrame} frames (parsed from preset)${loop ? ", looping" : ""}`);
      setPoseStatus(actorId, `generating${variant}`);
      await selectNodeForExport(nodeLabel);
      await removeDefaultClothing();
      // Set the timeline BEFORE loading the preset, per real observed
      // behavior applying idle manually — the extend-timeline dialog
      // fires because the preset's own frame data exceeds whatever the
      // timeline already is AT LOAD TIME.
      await setTimelineRange(endFrame);
      await applyPosePreset(presetPath);
      const variantDufPath = await saveSceneAsDuf(actorId, variant);
      await exportViaDiffeomorphic(actorId, variantDufPath);
      const { remoteBlendPath: variantBlendPath } = await convertViaDiffeomorphic(actorId, variantDufPath, variant, true, morphValues);
      variantEntries.push({ name: clipName, path: variantBlendPath, loop });
      setPoseStatus(actorId, `${variant}_ready`, { [`${clipName}BlendPath`]: variantBlendPath });
      console.log(`[runPipeline] ${variant} .blend ready on Mac Mini: ${variantBlendPath}`);
      await reloadDufFresh(dufPath);
    }

    // Appends each variant's Action into the master .blend as named
    // NLA tracks, then exports ONE combined GLB with every clip
    // present. (Session 143 note: an older comment here still called
    // mergeAnimationsIntoMasterBlend() a stub that throws — stale
    // since Session 97+, the function above is real and this pipeline
    // has been completing through it. Corrected while adding sit.)
    setStatus(actorId, "merging_animations");
    const finalGlbPath = await mergeAnimationsIntoMasterBlend(actorId, masterBlendPath, variantEntries);

    setStatus(actorId, "downloading");
    const glbUrl = await pullGlbToServer({
      __dirname, actorId, mediaFolder, remoteGlbPath: finalGlbPath,
      macMiniUser: CFG.macMiniUser, macMiniHost: CFG.macMiniHost,
    });
    // Session 144 — the MASTER .BLEND is the actor's asset, retained on
    // the platform in the exact same folder as her finished GLB (per
    // Magnus's ruling, replacing an earlier shared-base idea). It is
    // the Diffeomorphic-native rig every animation upload for this
    // actor bakes presets on (duf_to_clip_glb.py — see the
    // falls-backwards axis incident in its header for why the native
    // rig is required). Lives and dies with the actor's media folder.
    {
      const blendDir = path.join(__dirname, "../public/media/actors", mediaFolder, "3d");
      const localBlendPath = path.join(blendDir, `${actorId}.blend`);
      await execAsync(`scp ${CFG.macMiniUser}@${CFG.macMiniHost}:${scpRemoteEscape(masterBlendPath)} ${shellQuote(localBlendPath)}`, { timeout: 120_000 });
      console.log(`[runPipeline] master .blend retained beside the GLB: ${localBlendPath}`);
    }
    const referenceImageUrls = await pullReferenceImagesToServer({
      __dirname, actorId, mediaFolder, remoteDebugDir,
      macMiniUser: CFG.macMiniUser, macMiniHost: CFG.macMiniHost,
    });
    if (referenceImageUrls) {
      console.log(`[runPipeline] ${actorId}: reference images available at ${referenceImageUrls.frontUrl} / ${referenceImageUrls.sideUrl}, calibration=${JSON.stringify(referenceImageUrls.calibration)}`);
    }

    db.prepare(`UPDATE actors SET glb_url = ?, updated_at = ? WHERE id = ?`)
      .run(glbUrl, new Date().toISOString(), actorId); // requires a glb_url column — see file header

    // Real feature (Session 101+) — passed through jobStatus (in-memory,
    // NOT the DB — see setStatus()'s own comment on that tradeoff),
    // exactly the same way glbUrl already is. This is what lets a REAL
    // generation populate MiniGlbViewer's reference-image toggle
    // automatically, not just the dev folder-picker path. Deliberately
    // NOT written to the DB here — no schema decision has been made
    // yet for where these would live long-term (same open question
    // flagged for glb_url itself in this file's own header), and
    // jobStatus already satisfies what the wizard's status-polling
    // actually reads during and immediately after a live generation.
    setStatus(actorId, "ready", {
      glbUrl,
      frontReferenceImageUrl: referenceImageUrls?.frontUrl || null,
      sideReferenceImageUrl: referenceImageUrls?.sideUrl || null,
      referenceCalibration: referenceImageUrls?.calibration || null,
      referenceMeasurements: referenceImageUrls?.measurements || null,
    });
  } catch (err) {
    setError(actorId, err.message || String(err));
  }
}

// Session 96: cleans up everything generate3d.js writes to the Mac Mini
// for this actor — photo, .duf, .dbz, .blend, .glb, all under
// macMiniTmpDir/<actorId>/. Meant to be called from index.js's delete
// and abandon-draft endpoints, alongside their existing DB/local-file
// cleanup, which this doesn't replace or duplicate.
//
// Deliberately never awaited by its callers (see usage note below) —
// fire-and-forget, logs its own success/failure — so an unreachable or
// slow Mac Mini can't block or delay the delete response the user (or a
// sendBeacon call, which doesn't wait for a response at all) is actually
// waiting on. All failure handling happens inside this function; it
// never throws.
export async function deleteActorTmpFolder(actorId) {
  const remoteDir = `${CFG.macMiniTmpDir}/${actorId}`;
  const remoteRmCmd = `rm -rf ${shellQuote(remoteDir)}`;
  try {
    await execAsync(`ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(remoteRmCmd)}`, { timeout: 30_000 });
    console.log(`[deleteActorTmpFolder] deleted: ${remoteDir}`);
  } catch (err) {
    console.error(`[deleteActorTmpFolder] failed for ${actorId}: ${err.message}`);
  }
}

// Session 152 — what she looks like, as one short string.
//
// Everything that changes her published appearance and nothing that does not:
// the body file she was built from, the garments and their per-item transforms,
// and the morph values. Renaming her, or editing her psychology, must not
// trigger a 13MB rebuild — which is exactly why actors.updated_at is the wrong
// thing to compare.
export function appearanceHash({ glbUrl, glbMtimeMs, draft }) {
  const d = draft || {};
  const material = {
    // Session 152 — the bake pipeline's own version is an appearance input.
    // The hash otherwise only sees her data, so a change to HOW the runtime
    // file is built (skin-layer culling, rebind fixes) left every existing
    // build reading "fresh" while being built by superseded logic. Bumping
    // this flips every actor to stale and surfaces the Rebuild button.
    bake: "v8-weakmap-layer-state",
    glbUrl: glbUrl || null,
    glbMtimeMs: glbMtimeMs || 0,
    wardrobe: d.selectedAccessoryGlbUrls || {},
    scales: d.accessoryScales || {},
    offsets: d.accessoryOffsets || {},
    rotations: d.accessoryRotations || {},
    parts: d.accessoryParts || {},
    tints: d.accessoryTints || {},
    height: d.bodyHeightCm ?? d.bodyHeight ?? null,
    torso: d.bodyTorsoLength ?? null,
    arms: d.bodyArmsLength ?? null,
    legs: d.bodyLegsLength ?? null,
    morphs: d.extraMorphValues || {},
  };
  // Key order is not guaranteed across writers, so sort before hashing or the
  // same character fingerprints differently depending on who saved her last.
  const stable = JSON.stringify(material, Object.keys(material).sort());
  return crypto.createHash("sha1").update(stable).digest("hex").slice(0, 12);
}

function currentAppearance(db, __dirname, actorId) {
  const row = db.prepare(
    `SELECT id, media_folder, glb_url, draft_state, runtime_glb_url, runtime_glb_hash
       FROM actors WHERE id = ?`).get(actorId);
  if (!row) return null;

  let mtime = 0;
  if (row.glb_url) {
    try {
      mtime = fs.statSync(path.join(__dirname, "../public", row.glb_url)).mtimeMs;
    } catch { /* never exported yet — 0 is a fine component of the fingerprint */ }
  }
  let draft = {};
  try { draft = JSON.parse(row.draft_state || "{}"); } catch { /* unparseable draft is an empty one */ }

  return { row, hash: appearanceHash({ glbUrl: row.glb_url, glbMtimeMs: mtime, draft }) };
}

export function registerGenerate3DRoutes(app, { db, __dirname, authUser }) {
  // What the worlds should be loading, and whether it is still true.
  //
  // `fresh` is the whole point of the naming scheme: the published file carries
  // the fingerprint it was built from, so "is this current?" is a string
  // comparison against her rows rather than a flag somebody has to set.
  app.get("/api/actors/:id/runtime", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const cur = currentAppearance(db, __dirname, req.params.id);
    if (!cur) return res.status(404).json({ error: "not found" });

    const built = cur.row.runtime_glb_url;
    // The stored URL carries ?v=, which is not part of the path on disk.
    const onDisk = built && fs.existsSync(
      path.join(__dirname, "../public", built.split("?")[0]));

    res.json({
      url: onDisk ? built : null,
      hash: cur.hash,
      builtHash: cur.row.runtime_glb_hash || null,
      fresh: !!onDisk && cur.row.runtime_glb_hash === cur.hash,
    });
  });

  // The wizard finishing her. The file is named for its fingerprint, so a
  // rebuild of an unchanged character writes the same name and a changed one
  // writes a new file that nothing was holding a stale reference to.
  app.post("/api/actors/:id/runtime-glb",
    express.raw({ type: "model/gltf-binary", limit: "500mb" }),
    async (req, res) => {
      const user = authUser(req);
      if (!user) return res.status(401).json({ error: "unauthorized" });
      const actorId = req.params.id;

      const owned = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(actorId, user.id);
      if (!owned) return res.status(404).json({ error: "not found" });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "empty or missing glb body — ensure Content-Type: model/gltf-binary" });
      }

      const cur = currentAppearance(db, __dirname, actorId);
      const hash = cur.hash;

      try {
        const dir = path.join(__dirname, "../public/media/actors", cur.row.media_folder, "3d");
        await fs.promises.mkdir(dir, { recursive: true });
        // One stable path, overwritten in place — nothing accumulates and every
        // reference to her runtime model keeps working across rebuilds.
        const name = `runtime_${actorId}.glb`;
        await fs.promises.writeFile(path.join(dir, name), req.body);

        // The fingerprint rides on the URL rather than in the filename. A stable
        // name is what makes the path predictable; it is also what lets a
        // browser or a CDN serve yesterday's body forever, and that failure
        // looks like a character who did not change her top rather than like a
        // cache. ?v= costs nothing and makes every rebuild a different URL.
        const url = `/media/actors/${cur.row.media_folder}/3d/${name}?v=${hash}`;
        db.prepare(`UPDATE actors SET runtime_glb_url = ?, runtime_glb_hash = ?, updated_at = ? WHERE id = ?`)
          .run(url, hash, new Date().toISOString(), actorId);

        console.log(`[runtime-glb] ${actorId}: built ${(req.body.length / 1e6).toFixed(1)}MB as ${name}`);
        res.json({ saved: true, url, hash });

        // ── KTX2, after the response ─────────────────────────────────────────
        //
        // Session 152. The uncompressed file is already on disk and already
        // answered for, so the browser is never held on a ~90s encode and the
        // build cannot fail because of it. The compressor writes a temp file and
        // renames over this one, so a deploy landing mid-encode reads a complete
        // model either way — the older, heavier one, which still works.
        //
        // This is where the GPU cost actually gets paid down: the webp pass this
        // export already does shrank the DOWNLOAD (92 -> 27 MB) but not one byte
        // of VRAM, because textures are decoded to raw RGBA on upload. Measured
        // here: ~725 MB of texture memory for one character, ~2.9 GB for four —
        // past most integrated GPUs before any renderer is even chosen.
        // See server/ktx2.js for the numbers and the two-pass reason.
        // OFF BY DEFAULT — set KTX2_RUNTIME=1 to enable.
        //
        // Everything measurable about this is verified: structure is byte-for-byte
        // equivalent (33 meshes / 33 skins / 295 nodes / both clips), all 15
        // textures convert, and every payload passes `ktx validate`. What is NOT
        // verified is a browser actually rendering one, because the session
        // expired before that test could run.
        //
        // That gap matters more than it sounds. A GLTFLoader with no KTX2Loader
        // attached does not degrade — it fails the entire parse. KTX2 support was
        // added to all eight loader construction sites (lib/gltfKtx2.js) and
        // compiles, but if it is wrong at runtime then every character breaks
        // everywhere at once: door scene, model panel, wizard, mini viewer.
        // Shipping that on a build-clean-but-unrendered basis is not a trade
        // worth making silently, so it waits behind a flag until someone has
        // watched a compressed character load.
        if (process.env.KTX2_RUNTIME === "1") {
          compressRuntimeGlb(path.join(dir, name))
            .catch(err => console.warn(`[ktx2] ${actorId}: compression skipped — ${err.message}`));
        }
      } catch (err) {
        console.error(`[runtime-glb] ${actorId}: failed:`, err);
        res.status(500).json({ error: "failed to save runtime glb" });
      }
    });

  app.post("/api/actors/:id/generate-3d", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const actorId = req.params.id;

    const actor = db.prepare(`SELECT id, media_folder FROM actors WHERE id = ? AND owner_id = ?`).get(actorId, user.id);
    if (!actor) return res.status(404).json({ error: "not found" });

    const photo = db.prepare(
      `SELECT url FROM actor_media WHERE actor_id = ? AND state_slug = 'profile' AND media_type = 'photo' AND world_id IS NULL`
    ).get(actorId);
    if (!photo) return res.status(400).json({ error: "No reference photo uploaded for this character yet." });
    const localPhotoPath = path.join(__dirname, "../public", photo.url);

    const { gender, torsoLength, armsLength, legsLength, bodyHeightCm } = req.body;

    // Advanced/body photos: same state_slug convention CharacterWizard.jsx's
    // BODY_PHOTO_SLOTS already uploads under. Deliberately graceful, not a
    // 400 — Advanced is optional on the frontend, so a character with no
    // body photos is the normal case, not an error. Only passed through to
    // runPipeline if genuinely all three landed; a partial set (upload
    // failure on one of three, mid-flight) falls back to skipping the
    // photo-derived step entirely rather than running on incomplete data.
    const bodyPhotoRows = db.prepare(
      `SELECT state_slug, url FROM actor_media WHERE actor_id = ? AND state_slug IN ('body_front','body_side','body_back') AND media_type = 'photo' AND world_id IS NULL`
    ).all(actorId);
    const bodyPhotoBySlug = Object.fromEntries(bodyPhotoRows.map(r => [r.state_slug, r.url]));
    const hasAllBodyPhotos = ["body_front", "body_side", "body_back"].every(slug => bodyPhotoBySlug[slug]);
    const localBodyFrontPath = hasAllBodyPhotos ? path.join(__dirname, "../public", bodyPhotoBySlug.body_front) : null;
    const localBodySidePath = hasAllBodyPhotos ? path.join(__dirname, "../public", bodyPhotoBySlug.body_side) : null;
    const localBodyBackPath = hasAllBodyPhotos ? path.join(__dirname, "../public", bodyPhotoBySlug.body_back) : null;
    if (bodyPhotoRows.length > 0 && !hasAllBodyPhotos) {
      console.log(`[generate-3d] ${actorId}: partial body photo set (${bodyPhotoRows.length}/3) — skipping photo-derived body shape`);
    } else if (bodyPhotoRows.length === 0) {
      console.log(`[generate-3d] ${actorId}: no body photo rows found in actor_media (state_slug body_front/body_side/body_back) — Advanced likely not used, or upload to /media never landed`);
    }

    setStatus(actorId, "queued");
    // Fire and forget — the wizard polls GET for progress instead of
    // blocking one long HTTP request for several minutes.
    runPipeline({
      db, __dirname, actorId, localPhotoPath, mediaFolder: actor.media_folder, gender, torsoLength, armsLength, legsLength,
      localBodyFrontPath, localBodySidePath, localBodyBackPath, bodyHeightCm: hasAllBodyPhotos ? bodyHeightCm : null,
    });

    res.json({ started: true });
  });

  // Real feature (Session 101+) — accepts a raw .glb binary (the
  // client's own GLTFExporter output, current morph slider values as
  // starting weights — see MiniGlbViewer's exportMorphedGlbBlob) and
  // writes it directly to the SAME path/filename pullGlbToServer()
  // already uses for the original, un-morphed export. Deliberately an
  // overwrite, not a separately-named file — this is meant to BECOME
  // the actor's canonical glb going forward, matching what was asked
  // for directly ("save the adjusted glb and use that one"). glb_url
  // itself doesn't change (same path), but updated_at still bumps for
  // real record-keeping. Non-fatal by design on the client side (see
  // CharacterWizard's advanceStep) — a failed save here shouldn't
  // block step navigation, just leaves the actor's saved glb stale
  // until it succeeds on a later attempt.
  app.post("/api/actors/:id/save-morphed-glb", (req, res, next) => {
    // Session 103 — log the incoming size BEFORE the raw parser:
    // express raw-limit rejections are SILENT (no journal line, an
    // HTML-ish error page — misread for a whole day as "the request
    // never arrived"). This line makes every attempt visible with its
    // true size, so a 413 is attributable instead of theorized about.
    console.log(`[save-morphed-glb] ${req.params.id}: incoming, content-length=${req.headers["content-length"] || "?"} bytes`);
    next();
  }, express.raw({ type: "model/gltf-binary", limit: "500mb" }), async (req, res) => { // Session 102: 50mb -> 150mb — GLTFExporter output is UNCOMPRESSED (the source GLB's 47MB is Draco-pressed; 113 morph targets serialize raw), so even a body-only export exceeded the old cap (observed live: 413 on every Next despite accessory detach)
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const actorId = req.params.id;

    const actor = db.prepare(`SELECT id, media_folder FROM actors WHERE id = ? AND owner_id = ?`).get(actorId, user.id);
    if (!actor) return res.status(404).json({ error: "not found" });

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "empty or missing glb body — ensure Content-Type: model/gltf-binary" });
    }

    try {
      const dir = path.join(__dirname, "../public/media/actors", actor.media_folder, "3d");
      await fs.promises.mkdir(dir, { recursive: true });
      const localPath = path.join(dir, `${actorId}.glb`);
      await fs.promises.writeFile(localPath, req.body);

      const glbUrl = `/media/actors/${actor.media_folder}/3d/${actorId}.glb`;
      db.prepare(`UPDATE actors SET glb_url = ?, updated_at = ? WHERE id = ?`).run(glbUrl, new Date().toISOString(), actorId);

      console.log(`[save-morphed-glb] ${actorId}: saved ${req.body.length} bytes to ${localPath}`);
      res.json({ saved: true, glbUrl });
    } catch (err) {
      console.error(`[save-morphed-glb] ${actorId}: failed:`, err);
      res.status(500).json({ error: "failed to save glb" });
    }
  });

  app.get("/api/actors/:id/generate-3d", (req, res) => {
    res.json(jobStatus.get(req.params.id) || { stage: "idle" });
  });
}


// ── Shared Mac Mini / DAZ plumbing (Session 143) ─────────────────────
// Consumed by server/animations.js (the upload-an-animation feature).
// These are the SAME functions this pipeline runs on — exported rather
// than duplicated, per the no-drift rule. Nothing here is new code.
export {
  CFG,
  execAsync,
  shellQuote,
  scpRemoteEscape,
};
