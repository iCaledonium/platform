// Session 176 - the fit worker.
//
// Magnus: "all scripting makes the UI (MiniGlbViewer) freeze". The wardrobe
// pipeline - morph transfer, shrinkwrap, seam weld, the settle's tops-over-
// bottoms and hair layering, the hair rig transfer, the ride anchors and the
// skin mask - is pure geometry work on attribute arrays, and it ran on the
// thread that draws the UI: a slider rest cost ~2s of frozen page, a load
// several. Nothing in it needs the DOM or the renderer, so it runs HERE, on a
// MIRROR of the scene: the body's primitives (positions, normals, skinning,
// intact index, zones, the summed morph delta) and every garment primitive
// (prefit shape, normals, index, skinning) rebuilt as plain three.js meshes.
// The very same functions from garmentFit.js and bodyLayers.js run on the
// mirror, unchanged; what comes back is arrays - fitted positions, hair
// normals and rig, ride anchors, the culled body index - which fitClient.js
// writes into the live meshes. The main thread keeps only what must be
// per-frame (the hair ride) or is one-off (exports).
//
// Messages are processed in order, so a settle queued after a garment's fit
// sees that fit; the mirror and the live store can only ever differ by what
// is still in flight, and fitClient drops a settle whose generation is stale.
import * as THREE from "three";
import { applyManualFit, fitEntryFromPrefit, settleCore, capturePositions } from "./garmentFit.js";
import { exportHairRideState } from "./bodyLayers.js";

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const fmt = (a) => a.map((x) => {
  if (x instanceof Error) return x.stack || x.message;
  if (x && typeof x === "object") { try { return JSON.stringify(x); } catch { return String(x); } }
  return String(x);
}).join(" ");
// The pipeline's own console lines keep their prefixes and reach the page's
// console through the client, so the probes that grep them keep working.
console.log = (...a) => post({ t: "log", level: "log", text: fmt(a) });
console.warn = (...a) => post({ t: "log", level: "warn", text: fmt(a) });
console.error = (...a) => post({ t: "log", level: "error", text: fmt(a) });

const root = new THREE.Group(); root.name = "fitMirror";
let bodyParent = null, mainMesh = null;
const store = {};
const A = (arr, size) => new THREE.BufferAttribute(arr, size);
const findEntry = (url, matName) => (store[url] || []).find((e) => e.matName === matName) || null;

function setMorph(m, delta) {
  m.geometry.morphAttributes.position = delta ? [A(delta, 3)] : [];
  m.morphTargetInfluences = delta ? [1] : [];
}

function setBody(msg) {
  if (bodyParent) root.remove(bodyParent);
  bodyParent = new THREE.Group(); bodyParent.name = "body"; root.add(bodyParent);
  const bones = msg.bones.map((n) => { const b = new THREE.Bone(); b.name = n; return b; });
  const inv = bones.map((_, i) => new THREE.Matrix4().fromArray(msg.boneInverses, i * 16));
  const skeleton = new THREE.Skeleton(bones, inv);
  for (const p of msg.parts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", A(p.position, 3));
    if (p.normal) g.setAttribute("normal", A(p.normal, 3));
    if (p.skinIndex) g.setAttribute("skinIndex", A(p.skinIndex, 4));
    if (p.skinWeight) g.setAttribute("skinWeight", A(p.skinWeight, 4));
    g.setIndex(A(p.fullIndex.slice(), 1));
    g.userData.fullIndex = p.fullIndex;
    if (p.bodyZones) g.userData.bodyZones = p.bodyZones;
    const m = new THREE.SkinnedMesh(g);
    m.name = p.name; m.skeleton = skeleton; m.frustumCulled = false;
    setMorph(m, p.morphDelta);
    bodyParent.add(m);
  }
  mainMesh = bodyParent.children[0] || null;
  for (const entries of Object.values(store)) for (const e of entries) e.ride = null;
  console.log(`[fitWorker] body mirrored: ${msg.parts.length} primitive(s), ${msg.bones.length} bones.`);
}

function setBodyMorph(msg) {
  if (!bodyParent) return;
  msg.deltas.forEach((d, i) => { const m = bodyParent.children[i]; if (m) setMorph(m, d); });
  delete bodyParent.userData.shrinkwrapBVH;
  delete bodyParent.userData.morphTransfer;
}

function removeGarment(url) {
  for (const e of store[url] || []) { root.remove(e.mesh); e.mesh.geometry.dispose(); }
  delete store[url];
}

function addGarment(msg) {
  removeGarment(msg.url);
  const entries = [];
  for (const d of msg.entries) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", A(d.prefit.slice(), 3));
    if (d.normal) g.setAttribute("normal", A(d.normal, 3));
    if (d.index) g.setIndex(A(d.index, 1));
    if (d.skinIndex) g.setAttribute("skinIndex", A(d.skinIndex, 4));
    if (d.skinWeight) g.setAttribute("skinWeight", A(d.skinWeight, 4));
    const m = new THREE.SkinnedMesh(g);
    m.name = d.name; m.visible = d.visible !== false; m.frustumCulled = false;
    m.userData.isAccessoryMesh = true; m.userData.accessoryUrl = msg.url; m.userData.accessoryMatName = d.matName;
    root.add(m);
    entries.push({
      mesh: m, url: msg.url, matName: d.matName, prefitPositions: d.prefit, shrinkwrapEligible: !!d.shrinkwrapEligible,
      originalPositions: d.prefit.slice(), center: new THREE.Vector3(), ride: null,
    });
  }
  store[msg.url] = entries;
  return entries;
}

function fitResult(e, full) {
  const r = { url: e.url, matName: e.matName, position: capturePositions(e.mesh.geometry.attributes.position) };
  if (full) { r.originalPositions = e.originalPositions.slice(); r.center = [e.center.x, e.center.y, e.center.z]; }
  return r;
}

// every ArrayBuffer inside a result, once, for a zero-copy transfer
function buffersOf(obj, out = new Set()) {
  if (!obj || typeof obj !== "object") return out;
  if (ArrayBuffer.isView(obj)) { out.add(obj.buffer); return out; }
  if (Array.isArray(obj)) { for (const v of obj) buffersOf(v, out); return out; }
  for (const v of Object.values(obj)) buffersOf(v, out);
  return out;
}
const reply = (msg) => post(msg, [...buffersOf(msg)]);

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    switch (msg.t) {
      case "body": setBody(msg); break;
      case "bodyMorph": setBodyMorph(msg); break;
      case "remove": removeGarment(msg.url); break;
      case "visible":
        for (const it of msg.items) { const e = findEntry(it.url, it.matName); if (e) e.mesh.visible = it.visible !== false; }
        break;
      case "garment": {
        const entries = addGarment(msg);
        const results = [];
        for (const e of entries) {
          const t = (msg.transforms || {})[e.matName] || null;
          if (mainMesh) fitEntryFromPrefit(e, t, mainMesh);
          else if (t) applyManualFit(e, t, null);
          results.push(fitResult(e, true));
        }
        reply({ t: "fitted", jobId: msg.jobId, entries: results });
        break;
      }
      case "fit":
      case "refit": {
        const results = [];
        for (const it of msg.items) {
          const e = findEntry(it.url, it.matName); if (!e) continue;
          if (msg.t === "refit" && mainMesh) fitEntryFromPrefit(e, it.transform, mainMesh, { quiet: true });
          else applyManualFit(e, it.transform, mainMesh);
          results.push(fitResult(e, msg.t === "refit"));
        }
        reply({ t: "fitted", jobId: msg.jobId, entries: results });
        break;
      }
      case "settle": {
        const t0 = performance.now();
        const r = settleCore(root, store, msg.hair || []);
        const hair = [], tops = [], body = [];
        for (const e of (r ? r.hairEntries : [])) {
          const g = e.mesh.geometry;
          hair.push({
            url: e.url, matName: e.matName,
            position: capturePositions(g.attributes.position),
            normal: g.attributes.normal ? capturePositions(g.attributes.normal) : null,
            originalPositions: e.originalPositions.slice(), center: [e.center.x, e.center.y, e.center.z],
            skinIndex: g.attributes.skinIndex ? Float32Array.from(g.attributes.skinIndex.array) : null,
            skinWeight: g.attributes.skinWeight ? Float32Array.from(g.attributes.skinWeight.array) : null,
            ride: e.ride ? Object.fromEntries(Object.entries(e.ride).map(([k, v]) => [k, ArrayBuffer.isView(v) ? v.slice() : v])) : null,
          });
        }
        for (const [url, entries] of Object.entries(store)) {
          if (!url.includes("/torso/")) continue;
          for (const e of entries) {
            if (e.mesh.visible === false) continue;
            const g = e.mesh.geometry;
            tops.push({ url, matName: e.matName, position: capturePositions(g.attributes.position), normal: g.attributes.normal ? capturePositions(g.attributes.normal) : null });
          }
        }
        if (bodyParent) for (const m of bodyParent.children) body.push({ name: m.name, index: m.geometry.index ? m.geometry.index.array.slice() : null });
        const rs = exportHairRideState(store);
        const ride = rs ? { cloth: rs.cloth, hasBody: rs.hasBody, cvMesh: rs.cvMesh.slice(), cvVi: rs.cvVi.slice(), bvPart: rs.bvPart.slice(), bvLocal: rs.bvLocal.slice(), bvBase: rs.bvBase.slice() } : null;
        reply({ t: "settled", jobId: msg.jobId, gen: msg.gen, hair, tops, body, ride, ms: Math.round(performance.now() - t0) });
        break;
      }
      case "dispose": self.close(); break;
      default: break;
    }
  } catch (err) {
    console.error(`[fitWorker] ${msg && msg.t} failed:`, err);
    if (msg && msg.jobId) post({ t: "failed", jobId: msg.jobId, error: String((err && err.stack) || err) });
  }
};
post({ t: "ready" });
