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
import fs from "fs";
import sharp from "sharp";
const execAsync = promisify(exec);

const CFG = {
  dazScriptServerUrl: process.env.DAZ_SCRIPT_SERVER_URL || "http://192.168.1.60:18811",
  dazScriptServerToken: process.env.DAZ_SCRIPT_SERVER_TOKEN,
  macMiniHost: process.env.MAC_MINI_SSH_HOST || "192.168.1.60",
  macMiniUser: process.env.MAC_MINI_SSH_USER || "magnusklack",
  macMiniTmpDir: process.env.DAZ_TMP_DIR || "/Volumes/Extended Mac Mini M4/DAZ3D/DAZ_3D_SERVER_TMP",
  // Confirmed real path, Session 96 — note the odd trailing space before
  // ".app" in the actual installed bundle name ("LTS .app", not "LTS.app").
  macMiniBlenderPath: process.env.BLENDER_PATH || "/Applications/Blender 5.2.0 LTS .app/Contents/MacOS/Blender",
  macMiniConvertScript: process.env.CONVERT_SCRIPT_PATH || "/Users/magnusklack/scripts/convert.py",
  // New, Session 96: the Diffeomorphic-based conversion script and the
  // reusable favorite_morphs.json — confirmed agnostic across every
  // Genesis 9 character, not tied to whichever character it was
  // originally saved from (keyed on the base figure's asset path and a
  // mesh-topology fingerprint, both identical for every G9 character).
  macMiniConvertScriptDiffeomorphic: process.env.CONVERT_SCRIPT_DIFFEOMORPHIC_PATH || "/Users/magnusklack/scripts/convert_diffeomorphic.py",
  macMiniFavoritesJsonPath: process.env.FAVORITES_JSON_PATH || "/Users/magnusklack/scripts/favorite_morphs.json",
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
      // Real, concrete new finding: script responsiveness alone doesn't
      // mean Face Transfer's own underlying engine is ready — confirmed
      // by a real run where the retry-after-restart completed "cleanly"
      // per daz-script-server, but produced a default, non-face-transferred
      // mesh, not an actual failure to respond. Give it real additional
      // time before trusting it with real work.
      console.log("[restartDazStudio] waiting additional 10s for Face Transfer's own engine to finish initializing...");
      await new Promise((r) => setTimeout(r, 10_000));
      return;
    }
  }
  throw new Error("DAZ Studio did not come back online after restart within 60s — check whether 'Start server when pane opens' is still enabled");
}

async function dazScriptWithTimeout(script, timeoutMs) {
  const res = await fetch(`${CFG.dazScriptServerUrl}/execute`, {
    method: "POST",
    headers: { "X-API-Token": CFG.dazScriptServerToken, "Content-Type": "application/json" },
    body: JSON.stringify({ script }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json();
  console.log("[dazScript] raw response:", JSON.stringify(data));
  if (!data.success) throw new Error(`daz-script-server: ${data.error || "unknown error"}`);
  return data.result;
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
async function applyBodyShape(heightValue, armsLengthValue, legsLengthValue, nodeLabel) {
  const result = await dazScript(`(function(){
    var oNode = Scene.findNodeByLabel(${JSON.stringify(nodeLabel)});
    if (!oNode) throw new Error("Node not found: ${nodeLabel}");

    var targets = [
      ["body_bs_ProportionHeight", ${heightValue}],
      ["body_bs_ProportionArmsLength", ${armsLengthValue}],
      ["body_bs_ProportionLegsLength", ${legsLengthValue}],
    ];

    // Confirmed real: 565 node-level properties exist, but the morphs
    // aren't among them — the Parameter Settings dialog showed
    // "Owner: Morph" for these, meaning they belong to the mesh's shape,
    // not the node's own transform-level property list. Searching one
    // level deeper via getObject()/getCurrentShape() — both confirmed
    // real from export_to_blender.dsa's own doMesh() function, not a
    // new guess — before falling back to the node-level list already
    // confirmed not to have them, kept only for the report/error detail.
    var report = ["node: " + oNode.name];
    var searchTargets = [];

    var oObj = oNode.getObject();
    var oShape = oObj ? oObj.getCurrentShape() : null;
    if (oShape && oShape.getNumProperties) {
      var nShapeProps = oShape.getNumProperties();
      report.push(nShapeProps + " shape properties");
      for (var i = 0; i < nShapeProps; i++) searchTargets.push(oShape.getProperty(i));
    } else {
      report.push("no shape or getNumProperties on shape");
    }

    var nNodeProps = oNode.getNumProperties();
    report.push(nNodeProps + " node properties");
    for (var i = 0; i < nNodeProps; i++) searchTargets.push(oNode.getProperty(i));

    for (var t = 0; t < targets.length; t++) {
      var name = targets[t][0];
      var value = targets[t][1];
      var found = false;
      for (var i = 0; i < searchTargets.length; i++) {
        var oProp = searchTargets[i];
        if (oProp && oProp.name === name) {
          oProp.setValue(value);
          report.push(name + "=" + value);
          found = true;
          break;
        }
      }
      if (!found) throw new Error("Property not found among " + searchTargets.length + " total (shape+node) properties: " + name + " | " + report.join(" | "));
    }

    return report.join(" | ");
  })()`);
  console.log(`[applyBodyShape] ${result}`);
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

// Session 96: exportToBlender() (below) needs the scene already saved
// as a .duf — it reads Scene.getFilename() and embeds that path into
// the .dbz. Two straightforward attempts, not an elaborate hedge.
async function saveSceneAsDuf(actorId) {
  const dufPath = `${CFG.macMiniTmpDir}/${actorId}/${actorId}.duf`;
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
async function convertViaDiffeomorphic(actorId, dufPath) {
  const remoteBlendPath = `${CFG.macMiniTmpDir}/${actorId}/${actorId}.blend`;
  const remoteGlbPath = `${CFG.macMiniTmpDir}/${actorId}/${actorId}.glb`;
  const remoteCmd = `${shellQuote(CFG.macMiniBlenderPath)} --background --python ${shellQuote(CFG.macMiniConvertScriptDiffeomorphic)} -- ${shellQuote(dufPath)} ${shellQuote(CFG.macMiniFavoritesJsonPath)} ${shellQuote(remoteBlendPath)} ${shellQuote(remoteGlbPath)}`;
  const cmd = `ssh ${CFG.macMiniUser}@${CFG.macMiniHost} ${shellQuote(remoteCmd)}`;
  const { stdout, stderr } = await execAsync(cmd, { timeout: CFG.daztimeoutMs });
  if (!stdout.includes("Export complete")) {
    throw new Error(`Diffeomorphic conversion did not report success. stdout: ${stdout} stderr: ${stderr}`);
  }
  return remoteGlbPath;
}

// Lands the GLB inside the SAME public/media/actors/{media_folder}/ tree
// the existing photo-upload handler already uses, under a new "3d"
// subfolder — same convention as its "images"/"voice" subfolders.
async function pullGlbToServer({ __dirname, actorId, mediaFolder, remoteGlbPath, macMiniUser, macMiniHost }) {
  const dir = path.join(__dirname, "../public/media/actors", mediaFolder, "3d");
  await execAsync(`mkdir -p ${shellQuote(dir)}`, { timeout: 15_000 });
  const localPath = path.join(dir, `${actorId}.glb`);
  await execAsync(`scp ${macMiniUser}@${macMiniHost}:${scpRemoteEscape(remoteGlbPath)} ${shellQuote(localPath)}`, { timeout: 60_000 });
  return `/media/actors/${mediaFolder}/3d/${actorId}.glb`;
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

async function runPipeline({ db, __dirname, actorId, localPhotoPath, mediaFolder, gender, torsoLength, armsLength, legsLength, nodeLabel = "Genesis 9" }) {
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

    // applyBodyShape removed from the pipeline (Session 96) — real
    // architecture correction, not a bug fix. The three morphs are
    // already real, adjustable shape keys in every GLB this pipeline
    // produces (favorite_morphs.json + Baked Morphs, confirmed via
    // check_shape_keys.py). There's no reason to also set a specific
    // value on the DAZ side at generation time — that's solving a
    // problem the architecture doesn't have. height/armsLength/
    // legsLength from the wizard belong in the actor record and get
    // applied client-side to morphTargetInfluences when the GLB
    // renders, not sent through DAZ Script at all. Kept the function
    // itself further down, unused, rather than deleting it outright —
    // the real modifier lookup (findNodeModifier, getNumNodeModifiers)
    // confirmed tonight might be useful for something else later.
    setStatus(actorId, "selecting_node");
    await selectNodeForExport(nodeLabel);

    setStatus(actorId, "saving_duf");
    const dufPath = await saveSceneAsDuf(actorId);

    setStatus(actorId, "exporting");
    await exportViaDiffeomorphic(actorId, dufPath); // writes the matching .dbz next to dufPath

    setStatus(actorId, "converting");
    const remoteGlbPath = await convertViaDiffeomorphic(actorId, dufPath);

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

    const { gender, torsoLength, armsLength, legsLength } = req.body;

    setStatus(actorId, "queued");
    // Fire and forget — the wizard polls GET for progress instead of
    // blocking one long HTTP request for several minutes.
    runPipeline({ db, __dirname, actorId, localPhotoPath, mediaFolder: actor.media_folder, gender, torsoLength, armsLength, legsLength });

    res.json({ started: true });
  });

  app.get("/api/actors/:id/generate-3d", (req, res) => {
    res.json(jobStatus.get(req.params.id) || { stage: "idle" });
  });
}
