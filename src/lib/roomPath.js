// ── routing two feet around the furniture ────────────────────────────────────
//
// `approach` and `walk_to` used to be a straight line to a point, which is
// correct in a bare rehearsal room and wrong everywhere else: the same script
// played in her flat walked her through the coffee table. A script is supposed
// to describe an INTENTION — cross the room to him — and the room is supposed
// to decide what that costs. So the path is planned per run against whatever
// obstacles the host declares. Put a table between them and she rounds it;
// take the table away and the same step walks straight. Nothing in the script
// changes, which is the whole point.
//
// Deliberately NOT a collider. A collider stops a body and lets it slide along
// a surface; it cannot tell you to set off to the LEFT because the way right is
// blocked. That is a planning question and it is answered before the first step
// is taken.
//
// The method is a visibility graph, not a grid. A room holds a handful of
// pieces of furniture, so the graph is tiny (4 corners each), the search is
// milliseconds, and — unlike a grid — the path comes out already taut: it
// clips the corner of the table the way a person does, with no smoothing pass
// and no staircase artefacts.
//
// This module knows nothing about three.js, React or animation. It takes plain
// numbers and returns plain waypoints, so the studio and the encounter can both
// use it, and it can be tested without a browser.

// Footprints are axis-aligned rectangles on the floor: { x, z, hw, hd }, the
// centre and the HALF extents. Anything a body must go around is one of these;
// a chair is a small one. Height is not modelled on purpose — you cannot duck
// under a table while walking, so a footprint is the whole truth for feet.

const EPS = 1e-6;

// Grown by the body's radius so the PATH can be planned for a point while the
// BODY still clears the furniture. Without this she clips every corner she
// rounds, because her shoulder is not on the line her feet follow.
function inflate(o, r) {
  return { x: o.x, z: o.z, hw: Math.max(0.01, o.hw) + r, hd: Math.max(0.01, o.hd) + r };
}

function inside(p, o) {
  return Math.abs(p.x - o.x) <= o.hw + EPS && Math.abs(p.z - o.z) <= o.hd + EPS;
}

// Segment vs rectangle, by the slab method. `shrink` pulls the rectangle in a
// hair so that a segment running exactly along an edge — which is what every
// corner-to-corner leg of the graph does — is not counted as a crossing.
function blocked(a, b, o, shrink = 1e-3) {
  const hw = o.hw - shrink, hd = o.hd - shrink;
  if (hw <= 0 || hd <= 0) return false;
  const dx = b.x - a.x, dz = b.z - a.z;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a.x - (o.x - hw)], [dx, (o.x + hw) - a.x],
                        [-dz, a.z - (o.z - hd)], [dz, (o.z + hd) - a.z]]) {
    if (Math.abs(p) < EPS) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else       { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 <= t1;
}

function visible(a, b, obs) {
  for (const o of obs) if (blocked(a, b, o)) return false;
  return true;
}

// A goal that has ended up inside a footprint — she was told to walk to where
// the table now is, or to approach someone standing against it — is pushed to
// the nearest point outside rather than refused. Refusing would strand the run;
// walking to the edge is what a person does.
function pushOut(p, obs) {
  let out = { x: p.x, z: p.z };
  for (const o of obs) {
    if (!inside(out, o)) continue;
    const dx = out.x - o.x, dz = out.z - o.z;
    const px = o.hw - Math.abs(dx) + 0.02, pz = o.hd - Math.abs(dz) + 0.02;
    if (px < pz) out = { x: out.x + Math.sign(dx || 1) * px, z: out.z };
    else         out = { x: out.x, z: out.z + Math.sign(dz || 1) * pz };
  }
  return out;
}

// Returns { waypoints, direct, blocked } — waypoints EXCLUDES the start and
// ends at the goal. `direct` says the straight line was clear, which is the
// common case and worth knowing so a caller can skip the follower entirely.
export function planPath(from, to, obstacles = [], { radius = 0.28 } = {}) {
  const obs = (obstacles || [])
    .filter(o => o && Number.isFinite(o.x) && Number.isFinite(o.z))
    .map(o => inflate(o, radius));

  const start = pushOut({ x: +from.x, z: +from.z }, obs);
  const goal  = pushOut({ x: +to.x,   z: +to.z   }, obs);

  if (visible(start, goal, obs)) return { waypoints: [goal], direct: true, blocked: false };

  // Nodes: the two ends, plus every corner of every inflated footprint. Corners
  // are the only places a shortest path can turn — that is the property that
  // makes a visibility graph exact rather than approximate.
  const nodes = [start, goal];
  for (const o of obs) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const c = { x: o.x + sx * o.hw, z: o.z + sz * o.hd };
      if (!obs.some(other => other !== o && inside(c, other))) nodes.push(c);
    }
  }

  const n = nodes.length;
  const dist = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const seen = new Array(n).fill(false);
  dist[0] = 0;

  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!seen[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u === -1) break;
    if (u === 1) break;
    seen[u] = true;
    for (let v = 0; v < n; v++) {
      if (seen[v] || v === u) continue;
      if (!visible(nodes[u], nodes[v], obs)) continue;
      const alt = dist[u] + d(nodes[u], nodes[v]);
      if (alt < dist[v] - EPS) { dist[v] = alt; prev[v] = u; }
    }
  }

  if (!Number.isFinite(dist[1])) {
    // Walled in. Better to walk at them and stop short than to stand still and
    // report nothing — a rehearsal that goes wrong should be visibly wrong.
    return { waypoints: [goal], direct: false, blocked: true };
  }

  const out = [];
  for (let at = 1; at !== -1; at = prev[at]) out.push(nodes[at]);
  out.reverse();
  out.shift();
  return { waypoints: out, direct: false, blocked: false };
}

// How far the planned route actually is, for callers that want to budget time.
export function pathLength(from, waypoints) {
  let total = 0, cur = from;
  for (const w of waypoints) { total += Math.hypot(w.x - cur.x, w.z - cur.z); cur = w; }
  return total;
}
