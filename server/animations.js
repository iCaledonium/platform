// server/animations.js — Session 143.
// "Upload an animation and it is merged": the actor-animation upload
// feature, in its own module. Character GENERATION lives in
// generate3d.js; this file only borrows that pipeline's Mac Mini/DAZ
// plumbing (imported below — shared, never duplicated). Routes are
// registered from index.js, which calls into the exports here.

import fs from "fs";
import path from "path";
import { dufMaxFrame, CFG, execAsync, shellQuote, scpRemoteEscape } from "./generate3d.js";

// Session 143 (corrected same night): the earlier .duf leg drove DAZ
// Studio through a base-G9 scene — wrong, per Magnus: everything is
// baked in BLENDER. Diffeomorphic's import_action consumes a .duf
// directly onto the character's own imported armature inside
// merge_animation_into_glb.py, so a .duf now flows through the exact
// same path as a .blend/.glb/.fbx: one Blender run, no DAZ Studio, no
// base scene, no upload serialization lock. dufMaxFrame is kept only
// to report detected_frames in the route's response.
export function parseDufFrames(buffer) {
  return dufMaxFrame(buffer);
}

// Session 144 — THE LEDGER MODEL (per Magnus's ruling): the actor's
// retained master .blend, living beside her GLB on the platform, is
// the single source of truth for animations. Every add/remove is a
// ledger operation performed by update_master_animations.py on the Mac
// Mini: the master is updated AND saved, and the canonical GLB is
// re-derived from it. Both files ship back and swap atomically. No
// GLB->Blender->GLB round trips ever again — one derivation from the
// DAZ-native source, always. This supersedes the phase-1/phase-2 clip-
// GLB flow and the direct GLB merge/remove scripts from earlier
// tonight. Supported clip inputs: .duf and .blend (the Diffeomorphic-
// native world); foreign-skeleton .fbx/.glb needs a real retarget leg
// and is refused with exactly that message.
const UPDATE_MASTER_SCRIPT = process.env.UPDATE_MASTER_ANIMATIONS_SCRIPT_PATH || "/Volumes/Extended Mac Mini M4/DAZ3D/Server/scripts/update_master_animations.py";

async function runLedgerOp({ actorId, localMasterBlendAbsPath, localGlbAbsPath, opArgs }) {
  const sshTarget = `${CFG.macMiniUser}@${CFG.macMiniHost}`;
  const remoteDir = `${CFG.macMiniTmpDir}/${actorId}_ledger`;
  const remoteMaster = `${remoteDir}/master.blend`;
  const remoteGlb = `${remoteDir}/derived.glb`;
  try {
    // Session 147: shellQuote protects only the LOCAL hop — the path must
    // ALSO be quoted inside the remote command, or the spaces in
    // "Extended Mac Mini M4" split it on the Mac Mini's shell (same bug
    // class as generate3d.js:152, fixed Session 146; correct double-layer
    // pattern per generate3d.js:296).
    await execAsync(`ssh ${sshTarget} ${shellQuote(`mkdir -p ${shellQuote(remoteDir)}`)}`, { timeout: 30_000 });
    await execAsync(`scp ${shellQuote(localMasterBlendAbsPath)} ${sshTarget}:${scpRemoteEscape(remoteMaster)}`, { timeout: 180_000 });
    const remoteCmd = `${shellQuote(CFG.macMiniBlenderPath)} --background --python ${shellQuote(UPDATE_MASTER_SCRIPT)} -- ${shellQuote(remoteMaster)} ${shellQuote(remoteGlb)} ${opArgs.map(shellQuote).join(" ")}`;
    let stdout = "", stderr = "";
    try {
      ({ stdout, stderr } = await execAsync(`ssh ${sshTarget} ${shellQuote(remoteCmd)}`, { timeout: CFG.daztimeoutMs }));
    } catch (e) {
      const tail = (s) => (s || "").split("\n").filter(Boolean).slice(-8).join("\n");
      throw new Error(`Ledger operation failed (exit ${e.code ?? "?"}).\n${tail(e.stdout)}\n${tail(e.stderr)}`);
    }
    if (!stdout.includes("Export complete")) {
      throw new Error(`Ledger operation did not report success.\nstdout: ${stdout}\nstderr: ${stderr}`);
    }
    // Both artifacts back, both swaps atomic: master first (the truth);
    // if the GLB pull failed after, any ledger op re-derives it.
    const tmpMaster = `${localMasterBlendAbsPath}.ledger.tmp`;
    await execAsync(`scp ${sshTarget}:${scpRemoteEscape(remoteMaster)} ${shellQuote(tmpMaster)}`, { timeout: 180_000 });
    await fs.promises.rename(tmpMaster, localMasterBlendAbsPath);
    const tmpGlb = `${localGlbAbsPath}.ledger.tmp`;
    await execAsync(`scp ${sshTarget}:${scpRemoteEscape(remoteGlb)} ${shellQuote(tmpGlb)}`, { timeout: 180_000 });
    await fs.promises.rename(tmpGlb, localGlbAbsPath);
    console.log(`[ledger] ${actorId}: ${opArgs.join(" ")} — master + GLB updated`);
    return stdout;
  } finally {
    // Session 147: same double-layer quoting as the mkdir above — the
    // unquoted remote path meant this cleanup silently failed every run
    // (remote rm on /Volumes/Extended denied), leaving scratch dirs behind.
    try { await execAsync(`ssh ${sshTarget} ${shellQuote(`rm -rf ${shellQuote(remoteDir)}`)}`, { timeout: 30_000 }); }
    catch (e) { console.warn(`[ledger] scratch cleanup failed (non-fatal): ${e.message}`); }
  }
}

export async function mergeAnimationIntoActorGlb({ actorId, localMasterBlendAbsPath, localGlbAbsPath, localAnimAbsPath, clipName, loop = false }) {
  const sshTarget = `${CFG.macMiniUser}@${CFG.macMiniHost}`;
  const remoteDir = `${CFG.macMiniTmpDir}/${actorId}_ledger`;
  const animExt = path.extname(localAnimAbsPath).toLowerCase();
  const remoteAnim = `${remoteDir}/clip${animExt}`;
  // Session 147: double-layer quoting (see runLedgerOp) — path must be
  // quoted inside the remote command too.
  await execAsync(`ssh ${sshTarget} ${shellQuote(`mkdir -p ${shellQuote(remoteDir)}`)}`, { timeout: 30_000 });
  await execAsync(`scp ${shellQuote(localAnimAbsPath)} ${sshTarget}:${scpRemoteEscape(remoteAnim)}`, { timeout: 120_000 });
  const opArgs = ["add", clipName, remoteAnim, ...(loop ? ["loop"] : [])];
  return runLedgerOp({ actorId, localMasterBlendAbsPath, localGlbAbsPath, opArgs });
}

export async function removeAnimationFromActorGlb({ actorId, localMasterBlendAbsPath, localGlbAbsPath, clipName }) {
  return runLedgerOp({ actorId, localMasterBlendAbsPath, localGlbAbsPath, opArgs: ["remove", clipName] });
}
