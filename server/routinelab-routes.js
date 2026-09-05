// Routine Lab — the three Mac-side routines as first-class benches.
//
// WHY THIS EXISTS. fault-triage, conduct-watch and behavior-watch filed 30 of
// the board's 48 incidents while not being benches at all: they were absent
// from BENCHES, so they had no label (the page rendered the bare key), no
// `page` for "hand this to the watcher that owns it" to dispatch to, no entry
// in boardCoverage — which diffs the live route table against the catalogue
// precisely so a board nobody measures cannot hide — and, worst, no check.
//
// That last one mattered more than it looks. runSweep walks BENCHES and throws
// `unknown bench` on anything else, so nothing could ever re-run these
// fingerprints. Auto-resolve and auto-reopen both key off a check re-running,
// which is also the safety net the resolution manager's "resolve on a
// hypothesis" policy leans on: a wrong guess is supposed to come back. On the
// majority of the board it could not come back, and every worker note on these
// benches carried some version of "safety net is weaker than usual".
//
// The check is liveness, because that is the honest thing a board can assert
// about a routine from here: did it run recently enough. What it FOUND is the
// routine's own output and belongs in the rows it files. routineLiveness()
// already computes this for the detector; this exposes the same reading as a
// sweepable board so the three benches behave like every other one.

import { routineLiveness, ROUTINES } from "./lab-incidents.js";

const pass = (name, detail) => ({ verdict: "pass", name, detail });
const fail = (name, detail) => ({ verdict: "fail", name, detail });
const skip = (name, detail) => ({ verdict: "skip", name, detail });

// One board per routine. Keyed by the same short name the board, the pings
// table and routine-runner.mjs all use, so a bench key is never a second
// spelling of a routine name.
export function routineChecks(key) {
  const spec = ROUTINES[key];
  if (!spec) throw new Error(`unknown routine ${key}`);
  const live = routineLiveness().find((r) => r.source === key);
  if (!live) throw new Error(`no liveness reading for ${key}`);

  const checks = [];
  const every = `every ${spec.everyHours}h, grace ${spec.graceHours}h`;

  // Never heard from AT ALL is deliberately a skip, not a fail: it is a routine
  // this store has no history for, and a red row about something never seen is
  // one nobody reads. Same reasoning as routineLiveness()'s own `stale` guard.
  if (!live.last_heard_at) {
    checks.push(skip("the routine has run recently enough",
      `no run has ever been recorded for this routine (${every}) — nothing to measure yet`));
  } else if (live.stale) {
    checks.push(fail("the routine has run recently enough",
      `last heard from ${live.age_hours}h ago, past its ${spec.graceHours}h grace (${every}). ` +
      `Liveness is the newer of its last ping and the last thing it filed.`));
  } else {
    checks.push(pass("the routine has run recently enough",
      `last heard from ${live.age_hours}h ago (${every})`));
  }

  // A routine that only ever proves itself by FILING something is invisible on
  // a clean night — the exact hole that let all three sit off for 30 hours. So
  // assert the ping itself, separately from liveness: a routine with pings is
  // one that reports every run, not only the eventful ones.
  checks.push(live.pings > 0
    ? pass("the routine reports every run, not only eventful ones",
        `${live.pings} ping(s) recorded; a clean run is distinguishable from no run`)
    : fail("the routine reports every run, not only eventful ones",
        "no ping has ever been recorded, so a run that finds nothing leaves no trace " +
        "and is indistinguishable from the routine being switched off"));

  return checks;
}

export function mount(app, { authUser }) {
  for (const key of Object.keys(ROUTINES)) {
    // boardCoverage detects benches by this exact route shape, so registering
    // here is also what makes these three visible to coverage at all.
    app.get(`/api/test/${key}/checks`, (req, res) => {
      if (!authUser(req)) return res.status(401).json({ error: "not authenticated" });
      try {
        res.json({ ok: true, checks: routineChecks(key) });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });
  }
}
