import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// ── Session 152 — does she walk without leaving her clothes behind? ──────────
//
// The runtime bake rebinds every garment onto the body's skeleton so one clip
// drives all of it. Name-matching bones is necessary but not sufficient: the
// inverse bind matrices have to agree too, and when they do not the failure is
// clothes that look right standing still and tear on the first step. That is
// not something to certify by reading the code.
//
// So: load the built file, play `walk`, and measure. A garment that is bound
// correctly moves with the limb underneath it — the distance between their
// centroids stays put while both of them travel.
window.__checkRuntimeWalk = async (url) => {
  const gltf = await new Promise((ok, no) => new GLTFLoader().load(url, ok, undefined, no));
  const root = gltf.scene;
  const clip = gltf.animations.find((a) => a.name === "walk") || gltf.animations[0];
  if (!clip) return { error: "no animation in the file" };

  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();

  const byMaterial = (name) => {
    let found = null;
    root.traverse((o) => {
      if (found || !o.isSkinnedMesh) return;
      const mats = [].concat(o.material || []);
      if (mats.some((m) => (m?.name || "").toLowerCase() === name)) found = o;
    });
    return found;
  };

  // Sampled rather than exhaustive: a few hundred vertices locate a centroid
  // to well under a millimetre and the meshes run to tens of thousands.
  const centroid = (mesh) => {
    mesh.skeleton?.update();
    mesh.updateMatrixWorld(true);
    const pos = mesh.geometry.attributes.position;
    const v = new THREE.Vector3();
    const sum = new THREE.Vector3();
    let n = 0;
    const step = Math.max(1, Math.floor(pos.count / 400));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i);
      mesh.applyBoneTransform(i, v);
      sum.add(mesh.localToWorld(v));
      n++;
    }
    return sum.divideScalar(n);
  };

  const legs = byMaterial("legs");
  // Whatever cloth this character actually wears over the legs — Lindsey's
  // jeans, Benny's shorts. First match wins; the drift maths is identical.
  const jeans = ["jeans", "pants", "shorts"].map(byMaterial).find(Boolean);
  if (!legs || !jeans) return { error: "could not find a leg-skin mesh and a legwear mesh" };

  // Two earlier versions of this measured the wrong thing, so it is worth being
  // explicit about what makes a pair meaningful.
  //
  // Centroid distance conflated shape with binding: the jeans run hip to ankle
  // and the Legs material does not, so their centres drift apart on a stride
  // however well bound. Nearest-neighbour pairing fixed that but introduced its
  // own artefact — with the skin sparsely sampled across BOTH legs, plenty of
  // cloth points paired to a vertex on the opposite leg, and a stride separates
  // those by centimetres no matter what.
  //
  // A pair only means something if the two points were touching to begin with.
  // Fabric sits within a couple of centimetres of skin; anything further apart
  // at rest is not the skin under that cloth, it is somewhere else on her.
  // 2.5cm suited skin-tight jeans; Benny's radially-inflated shorts hang up to
  // ~5cm off the thigh and paired zero points at the old radius. A looser rest
  // radius does not loosen the VERDICT — drift measures change from whatever
  // the rest offset was, so a pair that starts at 4cm and stays at 4cm is
  // exactly as healthy as one that starts at 2mm and stays there.
  const NEIGHBOUR = 0.055;

  const sample = (mesh, count) => {
    mesh.skeleton?.update();
    mesh.updateMatrixWorld(true);
    const pos = mesh.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / count));
    const out = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i);
      mesh.applyBoneTransform(i, v);
      out.push({ i, p: mesh.localToWorld(v.clone()) });
    }
    return out;
  };

  const cloth0 = sample(jeans, 300);
  const skin0  = sample(legs, 3000);

  const pairs = [];
  for (const c of cloth0) {
    let best = null, bestD = Infinity;
    for (const k of skin0) {
      const d = c.p.distanceToSquared(k.p);
      if (d < bestD) { bestD = d; best = k; }
    }
    const rest = Math.sqrt(bestD);
    // Same-side only. At full BodyMass her inner thighs nearly touch, so a
    // cloth point on one leg can find its nearest skin on the OTHER leg at
    // rest — and a stride tears that pair apart however well the garment is
    // bound. Measured as a lone 4cm outlier against a 1.3mm mean.
    const crossLeg = Math.sign(c.p.x) !== Math.sign(best.p.x) && Math.abs(c.p.x - best.p.x) > 0.01;
    // The midline strip is unpairable by nature: cloth at the fly and the seat
    // centre serves BOTH legs, so it pairs with one inner thigh at rest and
    // must separate from it when that leg swings — located live as the last
    // "failing" pair, at (x -0.004, y 0.795): the fly, drifting 4cm while the
    // leg travelled 28. Fabric doing its job, not a binding defect.
    const midline = Math.abs(c.p.x) < 0.025;
    if (!crossLeg && !midline && rest <= NEIGHBOUR) pairs.push({ cloth: c.i, skin: best.i, rest });
  }
  if (pairs.length < 20) {
    return { error: `only ${pairs.length} cloth points sit within ${NEIGHBOUR * 100}cm of skin — cannot measure` };
  }

  // Walk the clip and judge at the frame where she has actually moved most —
  // a stride sampled at the wrong instant proves nothing either way.
  let report = null;
  const skinRef = new Map(skin0.map((k) => [k.i, k.p.clone()]));
  for (let t = 0; t < 1.2; t += 0.1) {
    mixer.update(0.1);
    root.updateMatrixWorld(true);
    const cloth = new Map(sample(jeans, 300).map((c) => [c.i, c.p]));
    const skin  = new Map(sample(legs, 3000).map((k) => [k.i, k.p]));

    let travel = 0, worst = 0, sum = 0, n = 0, worstAt = null;
    for (const pr of pairs) {
      const a = cloth.get(pr.cloth), b = skin.get(pr.skin);
      if (!a || !b) continue;
      const drift = Math.abs(a.distanceTo(b) - pr.rest);
      sum += drift; n++;
      if (drift > worst) {
        worst = drift;
        // Where this pair LIVES (rest pose) names the artefact: y≈0.1 is a
        // cuff at the ankle, y≈0.9 is a thigh. A hem that cannot follow an
        // ankle crease is fabric behaving like fabric; a thigh pair opening
        // 4cm would be a binding defect.
        const c0 = cloth0.find((cc) => cc.i === pr.cloth);
        worstAt = c0 ? { x: +c0.p.x.toFixed(3), y: +c0.p.y.toFixed(3), z: +c0.p.z.toFixed(3), rest: +pr.rest.toFixed(4) } : null;
      }
      travel = Math.max(travel, skinRef.get(pr.skin).distanceTo(b));
    }
    if (!report || travel > report.travel) {
      report = { travel, worst, mean: n ? sum / n : 0, n, at: +(t + 0.1).toFixed(1), worstAt };
    }
  }

  return {
    clip: clip.name,
    touchingPairs: report.n,
    atSeconds: report.at,
    skinTravelledCm: +(report.travel * 100).toFixed(1),
    meanDriftMm: +(report.mean * 1000).toFixed(2),
    worstDriftMm: +(report.worst * 1000).toFixed(2),
    worstPairAt: report.worstAt,
    verdict:
      report.travel < 0.02
        ? "the clip barely moves her — nothing was tested"
        : report.worst < 0.02
          ? "PASS — cloth stayed with the skin under it through the stride"
          : `FAIL — cloth slid ${(report.worst * 100).toFixed(1)}cm while the skin moved ${(report.travel * 100).toFixed(1)}cm`,
  };
};

// ── Does the hair follow the body through the clips? ─────────────────────────
//
// Session 152. The hair is the shakiest binding in the wardrobe: its GLB
// carries 13 DAZ-named bones of which only two matched the body skeleton by
// name, so most of its weights were remapped by fallback. "It looks attached"
// at rest proves nothing — bind pose is where every binding looks right. This
// measures it through the walk:
//
//   * SKULLCAP vertices are expressed in the HEAD BONE's local frame at rest,
//     then re-expressed mid-stride. A scalp that follows the head rigidly
//     keeps those local coordinates to within millimetres; a scalp pinned to
//     the wrong bone drifts by exactly however far the head moved.
//   * STRAND vertices get the same measurement with a loose bound — long hair
//     is SUPPOSED to lag and sway against the head frame — plus a world-travel
//     figure to prove they move at all (a strand frozen in world space while
//     she walks away from it is the classic root-pinned failure).
window.__checkHairFollow = async (url) => {
  const gltf = await new Promise((ok, no) => new GLTFLoader().load(url, ok, undefined, no));
  const root = gltf.scene;
  const clip = gltf.animations.find((a) => a.name === "walk") || gltf.animations[0];
  if (!clip) return { error: "no animation in the file" };
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();

  const HAIR_MATS = ["skullcap", "base", "bangs", "top", "wisps"];
  const hairMeshes = [];
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const mats = [].concat(o.material || []).map((m) => (m?.name || "").toLowerCase());
    if (mats.some((n) => HAIR_MATS.includes(n))) hairMeshes.push({ mesh: o, mat: mats[0] });
  });
  if (!hairMeshes.length) return { error: "no hair meshes found" };

  const skeleton = hairMeshes[0].mesh.skeleton;
  const head = skeleton.bones.find((b) => b.name === "head(drv)") ||
               skeleton.bones.find((b) => b.name.toLowerCase().includes("head"));
  if (!head) return { error: "no head bone" };

  const sample = (mesh, count) => {
    mesh.skeleton?.update();
    mesh.updateMatrixWorld(true);
    const pos = mesh.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / count));
    const out = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i);
      mesh.applyBoneTransform(i, v);
      out.push({ i, p: mesh.localToWorld(v.clone()) });
    }
    return out;
  };

  root.updateMatrixWorld(true);
  const headInv = new THREE.Matrix4();
  const readHead = () => {
    head.updateWorldMatrix(true, false);
    headInv.copy(head.matrixWorld).invert();
  };

  readHead();
  const headRest = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
  const rest = hairMeshes.map(({ mesh, mat }) => ({
    mat,
    pts: sample(mesh, mat === "skullcap" ? 200 : 120).map((s) => ({
      i: s.i, world: s.p.clone(), local: s.p.clone().applyMatrix4(headInv),
    })),
  }));

  // Judge at the frame where the head has moved most.
  let best = null;
  for (let t = 0; t < 1.2; t += 0.1) {
    mixer.update(0.1);
    root.updateMatrixWorld(true);
    readHead();
    const headNow = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
    const headTravel = headNow.distanceTo(headRest);

    const groups = {};
    hairMeshes.forEach(({ mesh, mat }, mi) => {
      const now = new Map(sample(mesh, mat === "skullcap" ? 200 : 120).map((s) => [s.i, s.p]));
      const g = groups[mat === "skullcap" ? "skullcap" : "strands"] ||
        (groups[mat === "skullcap" ? "skullcap" : "strands"] = { drifts: [], travels: [] });
      for (const r of rest[mi].pts) {
        const p = now.get(r.i);
        if (!p) continue;
        g.travels.push(p.distanceTo(r.world));
        g.drifts.push(p.clone().applyMatrix4(headInv).distanceTo(r.local));
      }
    });

    const stat = (a) => a.length
      ? { meanMm: +(1000 * a.reduce((x, y) => x + y, 0) / a.length).toFixed(2),
          worstMm: +(1000 * Math.max(...a)).toFixed(2) }
      : null;
    const snap = {
      headTravelCm: +(headTravel * 100).toFixed(1),
      skullcap: groups.skullcap && {
        driftInHeadFrame: stat(groups.skullcap.drifts),
        worldTravelCm: +(100 * Math.max(...groups.skullcap.travels)).toFixed(1),
      },
      strands: groups.strands && {
        driftInHeadFrame: stat(groups.strands.drifts),
        worldTravelCm: +(100 * Math.max(...groups.strands.travels)).toFixed(1),
      },
    };
    if (!best || snap.headTravelCm > best.headTravelCm) best = snap;
  }

  // Rigidity is judged on the MEAN: a scalp that follows the head averages
  // under a millimetre of drift in the head's own frame (measured live: 0.86mm
  // over a 5cm head bob). The worst-case bound is loose on purpose — the
  // skullcap's lower rim is part-weighted to the NECK, so the nape lags the
  // head frame when the head tilts. That is correct skinning; an 8mm hard cap
  // read it as detachment (measured live: 11.2mm at the nape, false FAIL).
  const capOk = best.skullcap &&
    best.skullcap.driftInHeadFrame.meanMm < 3 &&
    best.skullcap.driftInHeadFrame.worstMm < 25;
  const strandsMove = best.strands && best.strands.worldTravelCm > best.headTravelCm * 0.3;
  const strandsSane = best.strands && best.strands.driftInHeadFrame.worstMm < 80;
  best.verdict =
    !best.skullcap ? "no skullcap to judge" :
    !capOk ? `FAIL — the scalp drifted ${best.skullcap.driftInHeadFrame.worstMm}mm in the head's own frame; the hair is not following the head` :
    !strandsMove ? "FAIL — strands stayed in world space while the head moved; they are pinned to the wrong bone" :
    !strandsSane ? `MARGINAL — scalp rigid, but strands lag the head frame by ${best.strands.driftInHeadFrame.worstMm}mm (check which bones drive them)` :
    "PASS — scalp rigid to the head, strands travel with her and sway within bounds";
  return best;
};
