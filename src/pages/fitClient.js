// Session 176 - the main-thread side of the fit worker (see fitWorker.js).
//
// Owns the worker, mirrors the body and every garment into it as typed
// arrays, sends the jobs (a garment's load-time fit, a slider's manual fit,
// the body refit, the settle) and writes the results into the live meshes:
// positions and normals into the attributes (through the attribute API, since
// a Blender/Draco garment can be interleaved), the hair's rig into its skin
// attributes, the ride anchors into bodyLayers' per-frame state, the culled
// body index onto the body primitives. Every request returns a promise that
// resolves once its result has been applied.
//
// Settles are coalesced: while one is in flight the next request waits and
// carries the latest hair transforms, so a drag never queues a stack of
// stale settles. Each carries the generation of the wardrobe it was asked
// for; a result from an older generation (a garment was added or removed
// meanwhile) is dropped - the change that bumped the generation asks for
// its own settle.
import * as THREE from "three";
import { findBodySkinMesh, intactBodyIndex, capturePositions } from "./garmentFit.js";
import { ensureZones, installHairRide, installSkinMask, clearHairRide } from "./bodyLayers.js";

const read4 = (a) => {
  const out = new Float32Array(a.count * 4);
  for (let i = 0; i < a.count; i++) { out[i * 4] = a.getX(i); out[i * 4 + 1] = a.getY(i); out[i * 4 + 2] = a.getZ(i); out[i * 4 + 3] = a.getW(i); }
  return out;
};
const write3 = (a, arr) => {
  if (!a || !arr) return;
  if (!a.isInterleavedBufferAttribute && a.array.length === arr.length && a.array.constructor === arr.constructor) a.array.set(arr);
  else for (let i = 0; i < a.count; i++) a.setXYZ(i, arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]);
  a.needsUpdate = true;
};
const write4 = (a, arr) => {
  if (!a || !arr) return;
  for (let i = 0; i < a.count; i++) a.setXYZW(i, arr[i * 4], arr[i * 4 + 1], arr[i * 4 + 2], arr[i * 4 + 3]);
  a.needsUpdate = true;
};
// the body's current morph displacement per vertex, summed over its influences (null at neutral)
const morphDeltaOf = (mesh) => {
  const g = mesh.geometry, base = g.attributes.position;
  const targets = (g.morphAttributes && g.morphAttributes.position) || [];
  const infl = mesh.morphTargetInfluences || [];
  let any = false;
  for (let m = 0; m < targets.length; m++) if (infl[m]) { any = true; break; }
  if (!any) return null;
  const d = new Float32Array(base.count * 3);
  for (let m = 0; m < targets.length; m++) {
    const w = infl[m] || 0; if (!w) continue;
    const t = targets[m];
    for (let i = 0; i < base.count; i++) { d[i * 3] += t.getX(i) * w; d[i * 3 + 1] += t.getY(i) * w; d[i * 3 + 2] += t.getZ(i) * w; }
  }
  return d;
};
function buffersOf(obj, out = new Set()) {
  if (!obj || typeof obj !== "object") return out;
  if (ArrayBuffer.isView(obj)) { out.add(obj.buffer); return out; }
  if (Array.isArray(obj)) { for (const v of obj) buffersOf(v, out); return out; }
  for (const v of Object.values(obj)) buffersOf(v, out);
  return out;
}

export function createFitClient() {
  const client = { available: false, gen: 0, bodyRoot: null, bodyParts: [], root: null, store: null };
  let worker = null;
  try {
    if (typeof Worker !== "undefined") worker = new Worker(new URL("./fitWorker.js", import.meta.url), { type: "module" });
  } catch (e) {
    console.warn("[fitClient] no worker available - fitting stays on the main thread:", e);
  }
  if (!worker) return client;
  client.available = true;

  let nextId = 1;
  const pending = new Map();   // jobId -> { resolve, reject, settle }
  let settleInFlight = null, settlePending = null;
  const send = (msg) => worker.postMessage(msg, [...buffersOf(msg)]);
  const findEntry = (url, matName) => ((client.store || {})[url] || []).find((e) => e.matName === matName) || null;

  const failAll = (err) => {
    for (const [, p] of pending) { try { p.reject(err); } catch { /* listener */ } }
    pending.clear();
    settleInFlight = null;
    if (settlePending) { const sp = settlePending; settlePending = null; sp.resolvers.forEach((r) => r.reject(err)); }
  };
  worker.onerror = (e) => {
    // the module failed to load or threw at top level: every caller falls back to the main thread
    console.error("[fitClient] fit worker error - fitting falls back to the main thread:", e.message || e);
    client.available = false;
    failAll(new Error(e.message || "fit worker error"));
  };
  worker.onmessage = (ev) => {
    const m = ev.data;
    switch (m.t) {
      case "log": (console[m.level] || console.log)(m.text); break;
      case "fitted": { const ok = applyFitted(m); finish(m.jobId, ok); break; }
      case "settled": { const applied = applySettled(m); finish(m.jobId, applied); nextSettle(); break; }
      case "failed": { const p = pending.get(m.jobId); pending.delete(m.jobId); if (p) p.reject(new Error(m.error)); if (p && p.settle) nextSettle(); break; }
      default: break;
    }
  };
  const finish = (jobId, value) => { const p = pending.get(jobId); pending.delete(jobId); if (p) p.resolve(value); };
  const job = (msg) => new Promise((resolve, reject) => { msg.jobId = nextId++; pending.set(msg.jobId, { resolve, reject }); send(msg); });

  function applyFitted(m) {
    let n = 0;
    for (const r of m.entries || []) {
      const e = findEntry(r.url, r.matName);
      if (!e || !e.mesh) continue;
      write3(e.mesh.geometry.attributes.position, r.position);
      e.mesh.geometry.computeBoundingBox();
      if (r.originalPositions) e.originalPositions = r.originalPositions;
      if (r.center && e.center) e.center.set(r.center[0], r.center[1], r.center[2]);
      e.ride = null;
      e.fitPending = false;
      if (e.wantVisible !== undefined) e.mesh.visible = e.wantVisible;
      n++;
    }
    return n;
  }

  function applySettled(m) {
    if (m.gen !== client.gen) { console.log(`[fitClient] dropped a settle from wardrobe generation ${m.gen} (now ${client.gen}).`); return false; }
    const root = client.root, store = client.store;
    if (!root || !store) return false;
    for (const r of m.hair || []) {
      const e = findEntry(r.url, r.matName); if (!e || !e.mesh) continue;
      const g = e.mesh.geometry;
      write3(g.attributes.position, r.position);
      if (r.normal) { if (g.attributes.normal) write3(g.attributes.normal, r.normal); else g.setAttribute("normal", new THREE.BufferAttribute(r.normal, 3)); }
      if (r.originalPositions) e.originalPositions = r.originalPositions;
      if (r.center && e.center) e.center.set(r.center[0], r.center[1], r.center[2]);
      if (r.skinIndex) write4(g.attributes.skinIndex, r.skinIndex);
      if (r.skinWeight) write4(g.attributes.skinWeight, r.skinWeight);
      g.computeBoundingBox();
      e.ride = r.ride || null;
    }
    for (const r of m.tops || []) {
      const e = findEntry(r.url, r.matName); if (!e || !e.mesh) continue;
      const g = e.mesh.geometry;
      write3(g.attributes.position, r.position);
      if (r.normal && g.attributes.normal) write3(g.attributes.normal, r.normal);
      g.computeBoundingBox();
    }
    if (m.body && client.bodyParts.length) {
      const entries = [];
      m.body.forEach((b, i) => { const mesh = client.bodyParts[i]; if (mesh && mesh.name === b.name && b.index) entries.push({ mesh, index: b.index }); });
      installSkinMask(root, entries);
    }
    if (m.ride) {
      const cloth = m.ride.cloth.map((k) => { const e = findEntry(k.url, k.matName); return e && e.mesh; });
      if (cloth.every(Boolean)) installHairRide(store, m.ride, cloth, client.bodyParts);
      else { clearHairRide(store); console.warn("[fitClient] ride anchors referenced a garment no longer in the store - no ride until the next settle."); }
    } else clearHairRide(store);
    return true;
  }

  function nextSettle() {
    settleInFlight = null;
    if (settlePending) { const req = settlePending; settlePending = null; startSettle(req); }
  }
  function startSettle(req) {
    settleInFlight = req;
    const id = nextId++;
    pending.set(id, { settle: true, resolve: (v) => req.resolvers.forEach((r) => r.resolve(v)), reject: (e) => req.resolvers.forEach((r) => r.reject(e)) });
    send({ t: "settle", jobId: id, gen: client.gen, hair: req.hair });
  }

  client.attach = (root, store) => { client.root = root; client.store = store; };

  client.syncBody = (loadedRoot, referenceMesh) => {
    const largest = findBodySkinMesh(referenceMesh);
    const parent = largest.parent || largest;
    let parts = (parent.children || []).filter((c) => c.isSkinnedMesh);
    if (!parts.length) parts = [largest];
    const skeleton = largest.skeleton;
    const parts_ = parts.map((p) => {
      const g = p.geometry, a = g.attributes;
      const full = intactBodyIndex(g);
      return {
        name: p.name,
        position: capturePositions(a.position),
        normal: a.normal ? capturePositions(a.normal) : null,
        skinIndex: a.skinIndex ? read4(a.skinIndex) : null,
        skinWeight: a.skinWeight ? read4(a.skinWeight) : null,
        fullIndex: full ? Uint32Array.from(full) : Uint32Array.from({ length: a.position.count }, (_, i) => i),
        bodyZones: ensureZones(p),
        morphDelta: morphDeltaOf(p),
      };
    });
    const bones = skeleton ? skeleton.bones.map((b) => b.name) : [];
    const boneInverses = new Float32Array(bones.length * 16);
    if (skeleton) skeleton.boneInverses.forEach((mtx, i) => boneInverses.set(mtx.elements, i * 16));
    client.bodyRoot = loadedRoot; client.bodyParts = parts; client.gen++;
    send({ t: "body", parts: parts_, bones, boneInverses });
  };

  client.syncBodyMorphs = () => {
    if (!client.bodyParts.length) return;
    client.gen++;
    send({ t: "bodyMorph", deltas: client.bodyParts.map(morphDeltaOf) });
  };

  client.addGarment = (url, entries, transforms) => {
    client.gen++;
    const data = entries.map((e) => {
      const g = e.mesh.geometry, a = g.attributes;
      return {
        matName: e.matName, name: e.mesh.name,
        prefit: e.prefitPositions.slice(),
        normal: a.normal ? capturePositions(a.normal) : null,
        index: g.index ? Uint32Array.from(g.index.array) : null,
        skinIndex: a.skinIndex ? read4(a.skinIndex) : null,
        skinWeight: a.skinWeight ? read4(a.skinWeight) : null,
        shrinkwrapEligible: !!e.shrinkwrapEligible,
        visible: e.wantVisible !== undefined ? e.wantVisible : e.mesh.visible,
      };
    });
    return job({ t: "garment", url, entries: data, transforms: transforms || {} });
  };

  client.removeGarment = (url) => { client.gen++; send({ t: "remove", url }); };
  client.setVisible = (items) => { if (items.length) send({ t: "visible", items }); };
  client.fit = (items) => (items.length ? job({ t: "fit", items }) : Promise.resolve(0));
  client.refit = (items) => (items.length ? job({ t: "refit", items }) : Promise.resolve(0));
  client.settle = (hair) => new Promise((resolve, reject) => {
    const req = { hair, resolvers: [{ resolve, reject }] };
    if (settleInFlight) {
      if (settlePending) { settlePending.hair = hair; settlePending.resolvers.push(...req.resolvers); }
      else settlePending = req;
      return;
    }
    startSettle(req);
  });
  client.settleBusy = () => !!settleInFlight || !!settlePending;
  client.dispose = () => {
    try { send({ t: "dispose" }); } catch { /* already gone */ }
    try { worker.terminate(); } catch { /* already gone */ }
    client.available = false;
    failAll(new Error("fit client disposed"));
  };
  return client;
}
