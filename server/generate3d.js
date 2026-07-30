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
 *   - setSourceImage / selectFemaleGender / selectMaleGender / generate()
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
import fs from "fs";
import sharp from "sharp";
const execAsync = promisify(exec);

const CFG = {
  dazScriptServerUrl: process.env.DAZ_SCRIPT_SERVER_URL || "http://192.168.1.60:18811",
  dazScriptServerToken: process.env.DAZ_SCRIPT_SERVER_TOKEN,
  macMiniHost: process.env.MAC_MINI_SSH_HOST || "192.168.1.60",
  macMiniUser: process.env.MAC_MINI_SSH_USER || "magnusklack",
  macMiniTmpDir: process.env.DAZ_TMP_DIR || "/Volumes/Extended Mac Mini M4/DAZ3D/DAZ_3D_SERVER_TMP",
  macMiniBlenderPath: process.env.BLENDER_PATH || "/Applications/Blender 4.2.23 LTS.app/Contents/MacOS/Blender",
  macMiniConvertScript: process.env.CONVERT_SCRIPT_PATH || "/Users/magnusklack/scripts/convert.py",
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

async function dazScript(script) {
  const res = await fetch(`${CFG.dazScriptServerUrl}/execute`, {
    method: "POST",
    headers: { "X-API-Token": CFG.dazScriptServerToken, "Content-Type": "application/json" },
    body: JSON.stringify({ script }),
    signal: AbortSignal.timeout(CFG.daztimeoutMs),
  });
  const data = await res.json();
  // Log the full raw response, including "output" — daz-script-server may
  // carry internal DAZ console warnings there that a bare success/failure
  // check has never actually surfaced. Left in permanently, not just for
  // this one bug — cheap, and the next mystery deserves real evidence too.
  console.log("[dazScript] raw response:", JSON.stringify(data));
  if (!data.success) throw new Error(`daz-script-server: ${data.error || "unknown error"}`);
  return data.result;
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
      const { stdout } = await execAsync(`ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(remoteSizeCmd)}`);
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
  await execAsync(`ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(remoteMkdirCmd)}`);
  const remotePath = `${remoteDir}/reference.jpg`;
  await execAsync(`scp ${shellQuote(normalizedPath)} ${CFG.macMiniUser}@${CFG.macMiniHost}:${scpRemoteEscape(remotePath)}`);
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

async function runFaceTransfer(remotePhotoPath, gender) {
  const genderCall = gender === "male" ? "selectMaleGender" : "selectFemaleGender";
  const result = await dazScript(`(function(){
    var oFTPane = MainWindow.getPaneMgr().findPane("DzFaceTransferPane");
    oFTPane.setSourceImage(${JSON.stringify(remotePhotoPath)});
    // Proven fix (Session 94): setSourceImage() alone does NOT populate
    // windowFilePath — confirmed directly. Set it explicitly ourselves.
    oFTPane.windowFilePath = ${JSON.stringify(remotePhotoPath)};
    oFTPane.refresh();
    var currentValue = oFTPane.windowFilePath;
    if (!currentValue || currentValue.length === 0) {
      throw new Error("Image picker still has no value even after setting windowFilePath directly");
    }
    oFTPane.${genderCall}();
    oFTPane.generate();
    return "face generated, picker value was: " + currentValue;
  })()`);
  return result;
}

// NOT yet proven — see file header. If this throws, enumerate the real
// node's properties before trusting these strings.
async function applyBodyShape(heightValue, breastSizeValue) {
  await dazScript(`(function(){
    var oNode = Scene.getPrimarySelection();
    var hProp = oNode.findProperty("Height") || oNode.findPropertyByLabel("Height");
    var bProp = oNode.findProperty("BreastSize") || oNode.findPropertyByLabel("Breast Size");
    if (hProp) hProp.setValue(${heightValue});
    if (bProp) bProp.setValue(${breastSizeValue});
    return "body shape applied";
  })()`);
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

async function exportBlendSilent(actorId) {
  const remoteBlendPath = `${CFG.macMiniTmpDir}/${actorId}/${actorId}.blend`;
  await dazScript(`(function(){
    var oExp = App.getExportMgr().getExporter(0); // DzBlenderExporter
    var oSettings = new DzFileIOSettings();
    oExp.getOptions(oSettings, false, "");
    oSettings.setIntValue("RunSilent", 1);
    oExp.writeFile(${JSON.stringify(remoteBlendPath)}, oSettings);
    return "exported";
  })()`);
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

// Lands the GLB inside the SAME public/media/actors/{media_folder}/ tree
// the existing photo-upload handler already uses, under a new "3d"
// subfolder — same convention as its "images"/"voice" subfolders.
async function pullGlbToServer({ __dirname, actorId, mediaFolder, remoteGlbPath, macMiniUser, macMiniHost }) {
  const dir = path.join(__dirname, "../public/media/actors", mediaFolder, "3d");
  await execAsync(`mkdir -p ${shellQuote(dir)}`);
  const localPath = path.join(dir, `${actorId}.glb`);
  await execAsync(`scp ${macMiniUser}@${macMiniHost}:${scpRemoteEscape(remoteGlbPath)} ${shellQuote(localPath)}`);
  return `/media/actors/${mediaFolder}/3d/${actorId}.glb`;
}

async function clearScene() {
  await dazScript(`(function(){
    Scene.selectAllNodes(true);
    Scene.removeSelected();
    return "scene cleared";
  })()`);
}

async function runPipeline({ db, __dirname, actorId, localPhotoPath, mediaFolder, gender, height, breastSize, nodeLabel = "Genesis 9" }) {
  try {
    setStatus(actorId, "clearing_scene");
    await clearScene();

    setStatus(actorId, "uploading_photo");
    const remotePhotoPath = await pushPhotoToDAZServer(actorId, localPhotoPath);

    setStatus(actorId, "generating_face");
    await runFaceTransfer(remotePhotoPath, gender);

    setStatus(actorId, "applying_body_shape");
    await applyBodyShape(height, breastSize);

    setStatus(actorId, "selecting_node");
    await selectNodeForExport(nodeLabel);

    setStatus(actorId, "exporting");
    const remoteBlendPath = await exportBlendSilent(actorId);

    setStatus(actorId, "converting");
    const remoteGlbPath = await convertBlendToGlb(actorId, remoteBlendPath);

    setStatus(actorId, "downloading");
    const glbUrl = await pullGlbToServer({
      __dirname, actorId, mediaFolder, remoteGlbPath,
      macMiniUser: CFG.macMiniUser, macMiniHost: CFG.macMiniHost,
    });

    db.prepare(`UPDATE actors SET glb_url = ?, updated_at = ? WHERE id = ?`)
      .run(glbUrl, new Date().toISOString(), actorId); // requires a glb_url column — see file header

    setStatus(actorId, "ready", { glbUrl });
  } catch (err) {
    setError(actorId, err.message || String(err));
  }
}

export function registerGenerate3DRoutes(app, { db, __dirname, authUser }) {
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

    const { gender, height, breastSize } = req.body;

    setStatus(actorId, "queued");
    // Fire and forget — the wizard polls GET for progress instead of
    // blocking one long HTTP request for several minutes.
    runPipeline({ db, __dirname, actorId, localPhotoPath, mediaFolder: actor.media_folder, gender, height, breastSize });

    res.json({ started: true });
  });

  app.get("/api/actors/:id/generate-3d", (req, res) => {
    res.json(jobStatus.get(req.params.id) || { stage: "idle" });
  });
}
