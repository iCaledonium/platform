// Lab incidents — the one place every bench and every routine files what it
// found, and the sweep that collects them.
//
// Two design rules carry the whole thing:
//
// 1. **An incident is a FINGERPRINT, not a run.** The same check failing on
//    ninety nightly sweeps is one incident seen ninety times, not ninety rows.
//    Without this the page is unreadable inside a week and the nightly routine
//    is the thing that made it unreadable.
//
// 2. **A bench that could not be reached resolves NOTHING.** The auto-resolve
//    pass closes an open incident only when its check comes back with an
//    explicit `pass`. A 502 from the simulator returns an empty board, and an
//    empty board naively read is indistinguishable from a clean one — that is
//    the "queries that lie" family, and it would silently close every open
//    incident the first night the simulator was down. An unreachable bench
//    files an incident of its own instead.
//
// Skips are never incidents. A skip means the check could not run (empty
// table, unknown world) and the lab's standing rule is that an empty result
// proves nothing — filing it as a fault would be filing the absence of
// evidence as evidence.

import crypto from "crypto";
import db from "./db.js";
import * as cases from "./lab-cases.js";

// The module owns its own tables rather than adding them to db.js's schema
// block: db.js is a large shared file and every whole-file write to one of
// those is a chance to drop somebody else's table.
db.exec(`
  CREATE TABLE IF NOT EXISTS lab_incidents (
    id            TEXT PRIMARY KEY,
    fingerprint   TEXT NOT NULL UNIQUE,
    bench         TEXT NOT NULL,
    bench_label   TEXT,
    check_name    TEXT NOT NULL,
    world_id      TEXT,
    actor_id      TEXT,
    scope_label   TEXT,
    severity      TEXT NOT NULL DEFAULT 'fail',
    status        TEXT NOT NULL DEFAULT 'open',
    source        TEXT NOT NULL DEFAULT 'sweep',
    detail        TEXT,
    first_detail  TEXT,
    note          TEXT,
    occurrences   INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    resolved_at   TEXT,
    resolved_by   TEXT,
    last_pass_at  TEXT,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lab_incidents_open ON lab_incidents(status, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_lab_incidents_bench ON lab_incidents(bench, status);

  CREATE TABLE IF NOT EXISTS lab_sweep_targets (
    id          TEXT PRIMARY KEY,
    bench       TEXT NOT NULL,
    world_id    TEXT,
    actor_id    TEXT,
    label       TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    inserted_at TEXT NOT NULL,
    UNIQUE(bench, world_id, actor_id)
  );

  CREATE TABLE IF NOT EXISTS lab_sweep_runs (
    id              TEXT PRIMARY KEY,
    source          TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    boards_ok       INTEGER NOT NULL DEFAULT 0,
    boards_errored  INTEGER NOT NULL DEFAULT 0,
    checks_total    INTEGER NOT NULL DEFAULT 0,
    passed          INTEGER NOT NULL DEFAULT 0,
    failed          INTEGER NOT NULL DEFAULT 0,
    skipped         INTEGER NOT NULL DEFAULT 0,
    opened          INTEGER NOT NULL DEFAULT 0,
    reopened        INTEGER NOT NULL DEFAULT 0,
    recurred        INTEGER NOT NULL DEFAULT 0,
    resolved        INTEGER NOT NULL DEFAULT 0,
    detail          TEXT
  );
`);

// Added 2026-09-02. A pass against a STICKY row (known / wontfix) writes here.
// Auto-resolve deliberately skips those two — a red-by-design check that goes
// green must not silently un-stick itself — but until now a `known` row whose
// check had started passing and one still failing rendered IDENTICALLY, which
// is the empty-board/clean-board shape this store guards against everywhere
// else. Both timestamps come off the same clock in the same format, so
// last_pass_at later than last_seen_at means "green at the last look".
// Nothing else about the row changes: only a person un-sticks it.
try { db.exec(`ALTER TABLE lab_incidents ADD COLUMN last_pass_at TEXT`); } catch { /* already there */ }
// Idempotency key of the LAST submission that actually moved this row's
// occurrence count. See report() for why a repeat must not move it again.
try { db.exec(`ALTER TABLE lab_incidents ADD COLUMN last_report_key TEXT`); } catch { /* already there */ }

// Append-only transition log (2026-09-05). The row itself carries only the
// LATEST of everything: `updated_at` is overwritten by the next write, and
// `resolved_at` is actively cleared the moment a row leaves `resolved`
// (setStatus's CASE, and report()'s reopen branch). Nothing recorded when a
// row entered `acknowledged`, `wontfix` or `known` at all. So a row resolved
// once cleanly and one that bounced resolved -> reopened -> resolved four
// times were indistinguishable, and "how long did this take" had no answer.
// That matters now that the resolution manager churns these states
// unattended. Keyed by fingerprint as well as id so the history survives the
// row being deleted and re-filed under the same check.
db.exec(`
  CREATE TABLE IF NOT EXISTS lab_incident_events (
    id           TEXT PRIMARY KEY,
    incident_id  TEXT NOT NULL,
    fingerprint  TEXT NOT NULL,
    from_status  TEXT,
    to_status    TEXT NOT NULL,
    at           TEXT NOT NULL,
    by           TEXT,
    via          TEXT NOT NULL,
    note         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_lab_incident_events_incident
    ON lab_incident_events(incident_id, at);
  CREATE INDEX IF NOT EXISTS idx_lab_incident_events_fp
    ON lab_incident_events(fingerprint, at);
`);

// Only genuine changes are recorded. A no-op (open -> open, e.g. a bulk
// reopen sweeping rows that were already open, or the resolution manager's
// pause revert) is not a transition and would only dilute the log.
function recordEvent({ incident_id, fingerprint, from_status, to_status, at, by, via, note }) {
  if (from_status === to_status) return;
  try {
    db.prepare(`
      INSERT INTO lab_incident_events
        (id, incident_id, fingerprint, from_status, to_status, at, by, via, note)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(uid(), incident_id, fingerprint, from_status ?? null, to_status, at,
           by ?? null, via, note == null ? null : String(note).slice(0, 500));
  } catch (e) {
    // The log is evidence, not a gate: never let a bookkeeping failure stop
    // an incident from actually changing state.
    console.error("[lab-incidents] event log write failed:", e.message);
  }
}

export function eventsFor(incidentId, fingerprint) {
  return db.prepare(`
    SELECT * FROM lab_incident_events
     WHERE incident_id = ? OR fingerprint = ?
     ORDER BY at ASC, rowid ASC
  `).all(incidentId, fingerprint || "");
}

const now = () => new Date().toISOString();
const uid = () => crypto.randomBytes(9).toString("hex");

// ── The benches ──────────────────────────────────────────────────────────────
//
// Each is a read-only board with the shared contract
// { ok, checked_at, checks: [{ name, verdict: pass|fail|skip, detail }] }.
// The field is `verdict`, NOT `status` — the controller injects `ok`.
//
// `scoped: true` means the board needs a world (and for two of them an actor),
// so it runs once per configured target. `signup` is platform-local and global,
// so it runs exactly once per sweep with no target.
export const BENCHES = {
  // The three Mac-side routines. They filed 30 of the board's 48 incidents
  // while not being benches at all -- no label, no page to hand a fault to, no
  // coverage entry, and no check, so runSweep could never re-run them and
  // their rows could neither auto-resolve nor auto-reopen. Their checks are
  // liveness (routinelab-routes.js): whether the routine ran recently enough,
  // and whether it reports EVERY run rather than only the eventful ones. What
  // a routine found is its own output and belongs in the rows it files.
  "fault-triage": {
    label: "Routine · Fault triage",
    page: "/lab/home/incidents?bench=fault-triage",
    watcher: "Routine - Fault triage",
    side: "platform", scoped: false, needsActor: false, local: "faultTriageChecks",
  },
  "conduct-watch": {
    label: "Routine · Conduct watch",
    page: "/lab/home/incidents?bench=conduct-watch",
    watcher: "Routine - Conduct watch",
    side: "platform", scoped: false, needsActor: false, local: "conductWatchChecks",
  },
  "behavior-watch": {
    label: "Routine · Behaviour watch",
    page: "/lab/home/incidents?bench=behavior-watch",
    watcher: "Routine - Behaviour watch",
    side: "platform", scoped: false, needsActor: false, local: "behaviorWatchChecks",
  },

  encounter: {
    label: "Actor · Apartment · Encounter",
    page: "/lab/actor/apartment/encounter",
    watcher: "Feature - Actor Apartment Encounter",
    side: "simulator", scoped: true, needsActor: true,
    path: (t) => `/internal/test/encounter/checks?world_id=${encodeURIComponent(t.world_id || "")}&actor_id=${encodeURIComponent(t.actor_id || "")}`,
  },
  transport: {
    label: "Transport · Actor",
    page: "/lab/transport/actor",
    watcher: "Runtime - Transport Engine",
    side: "simulator", scoped: true, needsActor: true,
    path: (t) => `/internal/test/transport/checks?world_id=${encodeURIComponent(t.world_id || "")}&actor_id=${encodeURIComponent(t.actor_id || "")}`,
  },
  behavior: {
    label: "World · Behaviour",
    page: "/lab/world/behavior",
    watcher: "Runtime - World Behaviour",
    side: "simulator", scoped: true, needsActor: false,
    path: (t) => `/internal/test/behavior/checks?world_id=${encodeURIComponent(t.world_id || "")}`,
  },
  signup: {
    label: "User · Signup · Creation",
    page: "/lab/user/signup",
    watcher: "Feature - User Signup and Creation",
    side: "platform", scoped: false, needsActor: false, local: "signupChecks",
  },
  wizard: {
    label: "Character · Wizard · Authoring",
    page: "/lab/character/wizard",
    watcher: "Feature - Character Wizard",
    side: "platform", scoped: false, needsActor: false, local: "wizardChecks",
  },
  signin: {
    label: "User · Sign in · Session",
    page: "/lab/user/signin",
    watcher: "Feature - User Sign In",
    side: "platform", scoped: false, needsActor: false, local: "signinChecks",
  },
  avatar: {
    label: "User · Avatar · Body",
    page: "/lab/user/avatar",
    watcher: "Feature - User Avatar",
    side: "platform", scoped: false, needsActor: false, local: "avatarChecks",
  },
  share: {
    label: "Character · Sharing · Link",
    page: "/lab/character/share",
    watcher: "Feature - Character Sharing",
    side: "platform", scoped: false, needsActor: false, local: "shareChecks",
  },
  deploy: {
    label: "Character · Deploy · World",
    page: "/lab/character/deploy",
    watcher: "Feature - Character Deploy",
    side: "platform", scoped: false, needsActor: false, local: "deployChecks",
  },
  // Cases written in the test manager rather than in code. A source like
  // any other downstream: same fingerprints, same incidents, same sweep.
  authored: {
    label: "Authored · Test cases",
    page: "/lab/home/testmanager",
    watcher: null,
    side: "platform", scoped: false, needsActor: false, local: "authoredChecks",
    // No /api/test/authored/checks route exists and none should: this source is
    // assembled in-process from lab_test_cases. Marked virtual so the coverage
    // check does not report it missing forever — a detector that cries wolf
    // every single run is a detector nobody reads.
    virtual: true,
  },
};

// Which boards exist that this catalogue does not know about?
//
// BENCHES is a hardcoded list of other people's work, and on 2026-08-30 it
// went stale twice in one evening: the avatar and wizard benches were added
// by other sessions and the manager kept reporting a clean sweep while
// measuring a subset. Silence is the defect there, not the missing entry.
// Every bench exposes GET /api/test/<key>/checks, so diff the LIVE Express
// route table against the catalogue instead of trusting anyone to remember.
export function boardCoverage(app) {
  const found = new Set();
  const stack = app?._router?.stack || app?.router?.stack || [];
  for (const layer of stack) {
    const p = layer?.route?.path;
    if (typeof p !== "string") continue;
    const m = p.match(/^\/api\/test\/([A-Za-z0-9_-]+)\/checks$/);
    if (m) found.add(m[1]);
  }
  const known = Object.keys(BENCHES);
  return {
    detected: [...found].sort(),
    // A live board no sweep touches.
    unwired: [...found].filter((k) => !known.includes(k)).sort(),
    // A catalogued bench whose route has gone — a rename or removal, which
    // would otherwise surface only as a board that mysteriously never fails.
    // Virtual sources have no route by design, so their absence is not a gap.
    missing: known.filter((k) => !found.has(k) && !BENCHES[k].virtual).sort(),
  };
}

export function fingerprintOf({ bench, check_name, world_id, actor_id }) {
  return [bench, check_name, world_id || "-", actor_id || "-"].join("|");
}

function scopeLabel(bench, t) {
  if (!BENCHES[bench]?.scoped) return "global";
  const w = (t.world_id || "").slice(0, 8);
  const a = (t.actor_id || "").slice(0, 8);
  return t.label || (BENCHES[bench].needsActor ? `world ${w} · actor ${a}` : `world ${w}`);
}

// ── What a check is ABOUT ─────────────────────────────────────────────
//
// An incident's identity is bench|check_name|world|actor, and until 2026-09-09
// fileBoard stamped EVERY check on a board with the whole target it had been
// run against. On an actor-scoped bench that is wrong for most of them: three
// of encounter's thirteen cases read an actor_id and three of transport's
// seven do. The rest are world-scoped, or read a global table and take no
// arguments at all.
//
// Stamping those with the subject actor ORPHANS them the moment the suite's
// subject changes. The row is pinned to an actor nothing will ever measure
// again, so it can never recur, never reopen and never auto-resolve, while the
// same finding re-files under a fresh fingerprint at occurrence 1 — one
// condition, split into a frozen history and a new row that looks new.
// Measured on this board: "a knock ends in a door or a refusal, never in
// nothing" sat frozen at 24 occurrences against an actor deleted on
// 2026-09-06, while the check itself was still being run every sweep.
//
// So a board DECLARES the subject of each case (`scope: "actor" | "world" |
// "global"`) and the store keys on what it declared rather than on what the
// runner happened to be pointed at. A board that declares nothing keeps
// exactly the old behaviour — the bench's own scope — so a board that has not
// been taught to say is never worse off than it is today.
function checkSubject(target, scope) {
  if (scope === "global") return { world_id: null, actor_id: null };
  if (scope === "world") return { world_id: target.world_id || null, actor_id: null };
  return { world_id: target.world_id || null, actor_id: target.actor_id || null };
}

// The label follows the subject, not the run: a world-scoped row must not read
// "world a · actor b" when b is nothing to do with it. The target's own label
// (e.g. a suite's name for its actor) is kept only for actor-scoped rows,
// because that is the only scope it actually describes.
function subjectScopeLabel(bench, target, scope) {
  if (!BENCHES[bench]?.scoped || scope === "global") return "global";
  if (scope === "world") return `world ${(target.world_id || "").slice(0, 8)}`;
  return scopeLabel(bench, target);
}

// ── Near-duplicate check_names ───────────────────────────────────────────────
//
// The fingerprint is bench|check_name|world|actor, so the check_name is the
// identity of a finding. A caller that RETYPES it — truncating the tail,
// swapping "what age was declared for them" for "how old they were" — does not
// recur the original row: it forks a second one at occurrence 1, and the real
// row's count stops climbing while the board grows a twin nobody merges.
//
// This is not hypothetical and it is not rare. On the board as it stood
// 2026-09-09 it had happened at least twelve times, including four separate
// wordings of ONE portrait-deletion finding (128529a7 at occ 67, bda5661b at
// occ 2, plus 715b6296 and 9c16eb1f). Worse, a reworded refile of a `wontfix`
// row forks a fresh OPEN row, quietly undoing an owner's won't-fix decision.
//
// So the store, not the caller's discipline, decides. Two rules, both
// calibrated against all 184 rows then on the board: every pair they flag is a
// genuine fork, and no genuinely-distinct pair is flagged.
//
//   • shared wording   — Jaccard over content tokens >= 0.65, and only when
//                        both names carry >= 4 content tokens, so a short name
//                        cannot collide by accident.
//   • shared opening   — >= 100 characters of identical normalised prefix,
//                        which is what a truncation or a tail-reword leaves.
//
// 0.65 rather than 0.70 because the two error costs are not symmetric: a false
// positive is a loud refusal the caller can step past in one flag, while a
// false negative is a silent fork nobody notices for weeks. Measured, not
// guessed — dropping the tail off 10129286 scores 0.69 against its own parent,
// so 0.70 let a real truncation through. There is still clear air below: the
// closest genuinely-distinct pair on the board scores 0.53 (two unguarded
// GenServer.call findings in different controllers), and the closest distinct
// pair that shares an opening clause reaches only 59 prefix characters.
//
// Deliberately compared against rows of EVERY status, wontfix and resolved
// included: those are exactly the ones a fork does the most damage to.
const DUP_JACCARD = 0.65;
const DUP_PREFIX_CHARS = 100;
const DUP_MIN_TOKENS = 4;
const DUP_STOPWORDS = new Set(["the","a","an","and","or","of","to","in","on","for","is","are","it","its",
  "that","this","so","as","at","by","with","from","was","were","be","been","has","have","had","not","no",
  "but","than","then","which","who","what","when","never","every","any","all"]);

const dupNormal = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const dupTokens = (s) => new Set(dupNormal(s).split(" ").filter((w) => w.length >= 3 && !DUP_STOPWORDS.has(w)));
function dupPrefixLen(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// Every row on the same bench and the same scope whose check_name is a
// reworded or truncated form of `check_name`. Exact matches are excluded:
// those are the fingerprint's own job and reach report()'s recur branch.
export function nearDuplicatesOf({ bench, check_name, world_id, actor_id }) {
  const rows = db.prepare(
    `SELECT id, fingerprint, check_name, status, occurrences, first_seen_at
       FROM lab_incidents
      WHERE bench = ? AND IFNULL(world_id, '-') = ? AND IFNULL(actor_id, '-') = ?`
  ).all(String(bench), world_id || "-", actor_id || "-");
  const A = dupTokens(check_name);
  const an = dupNormal(check_name);
  const hits = [];
  for (const r of rows) {
    if (r.check_name === check_name) continue;
    const B = dupTokens(r.check_name);
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    const union = A.size + B.size - inter;
    const jaccard = union > 0 ? inter / union : 0;
    const pfx = dupPrefixLen(an, dupNormal(r.check_name));
    const byWording = Math.min(A.size, B.size) >= DUP_MIN_TOKENS && jaccard >= DUP_JACCARD;
    const byOpening = pfx >= DUP_PREFIX_CHARS;
    if (!byWording && !byOpening) continue;
    const pct = Math.round(jaccard * 100);
    hits.push({
      id: r.id, fingerprint: r.fingerprint, status: r.status,
      occurrences: r.occurrences, check_name: r.check_name,
      jaccard: Number(jaccard.toFixed(2)), shared_opening_chars: pfx,
      why: byWording && byOpening ? `${pct}% shared wording and a ${pfx}-character shared opening`
         : byWording ? `${pct}% shared wording`
         : `a ${pfx}-character shared opening`,
    });
  }
  // The canonical row first: the one that has actually been recurring, and
  // among equals the one that has been on the board longest.
  hits.sort((x, y) => (y.occurrences - x.occurrences) ||
    String(x.first_seen_at || "").localeCompare(String(y.first_seen_at || "")));
  return hits;
}

// ── Filing ───────────────────────────────────────────────────────────────────

// How long after a row's last REAL occurrence an identical submission is read
// as the same observation arriving twice rather than as new evidence. Chosen
// against the actual cadences on this board: the only scheduled suite runs
// daily, and the watch routines run hourly at most, so nothing legitimate can
// re-report a byte-identical detail on the same fingerprint inside five
// minutes. Anchored to last_seen_at and NOT refreshed by a suppressed
// duplicate, so a stream of duplicates cannot roll the window forward
// indefinitely and hide a genuine recurrence behind it.
const DEDUP_WINDOW_MS = 300_000;

// Report one finding. Returns what happened to it, which is what the sweep
// counts and what the caller is told.
//
// `known` and `wontfix` are deliberately STICKY: three of the encounter
// board's reds are red by design (a board that cannot go red is not evidence),
// and if every sweep resurfaced them as fresh incidents the page would ship
// permanently red and stop meaning anything. Their occurrence count still
// climbs, so nothing is hidden — they just do not re-enter the open list.
export function report(inc) {
  const bench = String(inc.bench || "unknown");
  const check_name = String(inc.check_name || "unnamed check").slice(0, 400);
  const world_id = inc.world_id || null;
  const actor_id = inc.actor_id || null;
  const fp = fingerprintOf({ bench, check_name, world_id, actor_id });
  const t = now();
  const detail = inc.detail == null ? null : String(inc.detail).slice(0, 4000);
  const severity = ["fail", "unknown", "error"].includes(inc.severity) ? inc.severity : "fail";

  // ── One submission, one occurrence ────────────────────────────────────────
  //
  // Filed by conduct-watch against itself on 2026-09-09 and fixed here. A
  // routine ran `report` with a 17-finding payload, then ran a second command
  // that was MEANT to read the stored result back but re-executed the same
  // `report` with the same payload on stdin. All 17 rows incremented by +2,
  // measured by diffing the board before and after. Nothing in the store could
  // tell the two calls apart, and there is no decrement anywhere in this
  // module, so an inflated count could only ever be repaired by a person.
  //
  // The count is the board's whole value over an unread log: it is the number a
  // person reads to judge "persistent, or a one-off, and how urgently". A
  // repeat of an IDENTICAL payload is not new evidence about the world, so it
  // must not move that number. (This is the exact mirror of the near-duplicate
  // guard above: a fork splits one condition's history downward, a double-file
  // inflates it upward, and both corrupt the same number.)
  //
  // Two keys, in this order:
  //   run_id  — the caller states its own run identity. Deduplicates for as
  //             long as that row's last report carried the same run id, with no
  //             time window at all, because the caller has told us outright.
  //             This is the shape the incident asked for.
  //   payload — the fallback for callers that supply no run_id, which today is
  //             all of them: the watch procedures are SKILL.md files on the Mac,
  //             outside both governed repos, so they cannot be taught a new flag
  //             from in here. A fix that only works once every caller is
  //             re-educated is not a fix for the failure that was measured.
  const submissionKey = inc.run_id
    ? `run:${String(inc.run_id).slice(0, 120)}`
    : `payload:${crypto.createHash("sha256").update(`${severity}\n${detail || ""}`).digest("hex").slice(0, 32)}`;

  const existing = db.prepare(`SELECT * FROM lab_incidents WHERE fingerprint = ?`).get(fp);

  // Deliberately BEFORE the resolved-reopen branch is allowed to run: a repeat
  // is only ever suppressed against a row this same submission has already
  // moved, so it can never swallow the reopen of a resolved row (the first of
  // the pair reopens it; only the second, redundant one is dropped).
  if (existing && existing.last_report_key === submissionKey && existing.status !== "resolved") {
    const withinWindow = inc.run_id
      ? true
      : (Date.parse(t) - Date.parse(existing.last_seen_at || 0)) < DEDUP_WINDOW_MS;
    if (withinWindow) {
      // The row is left completely untouched — not even last_seen_at, which is
      // what anchors the window. Nothing is lost: the identical payload is
      // already stored as this row's detail.
      return {
        outcome: "duplicate-ignored",
        fingerprint: fp,
        occurrences: existing.occurrences,
        why: inc.run_id
          ? `run_id "${inc.run_id}" has already reported this row; occurrence count left at ${existing.occurrences}`
          : `an identical payload was reported for this row within the last ` +
            `${Math.round(DEDUP_WINDOW_MS / 1000)}s; occurrence count left at ${existing.occurrences}`,
      };
    }
  }

  if (!existing) {
    // A finding whose check_name is a reworded or truncated twin of a row
    // already on this bench is REFUSED, not filed: filing it is precisely the
    // fork this guard exists to stop, and the caller cannot see the fork from
    // its own side (report() returned "opened", which is what a genuinely new
    // finding also returns). Refusing is loud — the CLI exits non-zero — and
    // lossless: the rejected wording and its detail are written to the
    // canonical row's event log, so nothing a caller said is thrown away.
    //
    // Two ways past it, both deliberate rather than accidental:
    //   "distinct_from": "<id|fingerprint>"  — the caller has read the row it
    //       was matched against and asserts this really is a different finding.
    //   "guard_near_duplicates": false       — the internal sweep paths, whose
    //       check_names are literals in code and cannot drift.
    if (inc.guard_near_duplicates !== false) {
      const cleared = new Set([].concat(inc.distinct_from || []).filter(Boolean).map(String));
      const near = nearDuplicatesOf({ bench, check_name, world_id, actor_id })
        .filter((n) => !cleared.has(n.id) && !cleared.has(n.fingerprint));
      if (near.length) {
        const canon = near[0];
        recordEvent({
          incident_id: canon.id, fingerprint: canon.fingerprint,
          from_status: null, to_status: canon.status, at: t,
          by: inc.source || "sweep", via: "near-duplicate-refused",
          note: `Refused a fork of this row (${canon.why}). Rejected check_name: ` +
                `"${check_name}". Detail it carried: ${detail || "(none)"}`,
        });
        return {
          outcome: "refused-near-duplicate",
          fingerprint: fp,
          rejected_check_name: check_name,
          matched: near,
          hint: `This wording is a reworded or truncated form of an existing ${bench} row. ` +
                `To RECUR that row, re-report it under its exact check_name: ` +
                `"${canon.check_name}". If this really is a different finding, re-report with ` +
                `"distinct_from": "${canon.id}" in the payload.`,
        };
      }
    }
    db.prepare(`
      INSERT INTO lab_incidents
        (id, fingerprint, bench, bench_label, check_name, world_id, actor_id, scope_label,
         severity, status, source, detail, first_detail, occurrences,
         first_seen_at, last_seen_at, updated_at, last_report_key)
      VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,?,1,?,?,?,?)
    `).run(uid(), fp, bench, inc.bench_label || BENCHES[bench]?.label || bench, check_name,
      world_id, actor_id, inc.scope_label || "global", severity,
      inc.source || "sweep", detail, detail, t, t, t, submissionKey);
    const openedId = db.prepare(`SELECT id FROM lab_incidents WHERE fingerprint = ?`).get(fp)?.id;
    recordEvent({ incident_id: openedId, fingerprint: fp, from_status: null, to_status: "open",
      at: t, by: inc.source || "sweep", via: "report", note: detail });
    return { outcome: "opened", fingerprint: fp };
  }

  if (existing.status === "resolved") {
    db.prepare(`
      UPDATE lab_incidents SET status='open', severity=?, detail=?, occurrences=occurrences+1,
        last_seen_at=?, resolved_at=NULL, resolved_by=NULL, source=?, updated_at=?,
        last_report_key=? WHERE id=?
    `).run(severity, detail, t, inc.source || "sweep", t, submissionKey, existing.id);
    recordEvent({ incident_id: existing.id, fingerprint: fp, from_status: "resolved",
      to_status: "open", at: t, by: inc.source || "sweep", via: "report", note: detail });
    return { outcome: "reopened", fingerprint: fp };
  }

  db.prepare(`
    UPDATE lab_incidents SET severity=?, detail=?, occurrences=occurrences+1,
      last_seen_at=?, updated_at=?, last_report_key=? WHERE id=?
  `).run(severity, detail, t, t, submissionKey, existing.id);

  return {
    outcome: (existing.status === "known" || existing.status === "wontfix") ? "suppressed" : "recurred",
    fingerprint: fp,
  };
}

export function setStatus(id, status, by, note) {
  const allowed = ["open", "acknowledged", "known", "resolved", "wontfix"];
  if (!allowed.includes(status)) throw new Error(`unknown status ${status}`);
  const t = now();
  // Read the prior status first — it is the only way the transition log can
  // record what this changed FROM, and the UPDATE below is about to
  // overwrite it (along with resolved_at, which is cleared for every status
  // that is not `resolved`).
  const prior = db.prepare(`SELECT status, fingerprint FROM lab_incidents WHERE id = ?`).get(id);
  const r = db.prepare(`
    UPDATE lab_incidents
       SET status = ?, note = COALESCE(?, note), updated_at = ?,
           resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END,
           resolved_by = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END
     WHERE id = ?
  `).run(status, note ?? null, t, status, t, status, by || null, id);
  if (r.changes > 0 && prior) {
    recordEvent({ incident_id: id, fingerprint: prior.fingerprint, from_status: prior.status,
      to_status: status, at: t, by, via: "status", note });
  }
  return r.changes > 0;
}

export function listIncidents({ status, bench, limit = 300 } = {}) {
  const where = [];
  const args = [];
  if (status && status !== "all") {
    if (status === "unresolved") where.push(`status IN ('open','acknowledged')`);
    else { where.push(`status = ?`); args.push(status); }
  }
  if (bench && bench !== "all") { where.push(`bench = ?`); args.push(bench); }
  const sql = `SELECT * FROM lab_incidents
                ${where.length ? "WHERE " + where.join(" AND ") : ""}
                ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1
                                     WHEN 'known' THEN 2 WHEN 'wontfix' THEN 3 ELSE 4 END,
                         last_seen_at DESC
                LIMIT ?`;
  return db.prepare(sql).all(...args, Math.min(Number(limit) || 300, 1000));
}

export function counts() {
  const rows = db.prepare(`SELECT status, COUNT(*) c FROM lab_incidents GROUP BY status`).all();
  const out = { open: 0, acknowledged: 0, known: 0, resolved: 0, wontfix: 0 };
  for (const r of rows) out[r.status] = r.c;
  return out;
}

// ── Targets ──────────────────────────────────────────────────────────────────

export function listTargets() {
  return db.prepare(`SELECT * FROM lab_sweep_targets ORDER BY bench, inserted_at`).all();
}

export function addTarget({ bench, world_id, actor_id, label }) {
  if (!BENCHES[bench]) throw new Error(`unknown bench ${bench}`);
  if (!BENCHES[bench].scoped) throw new Error(`${bench} is global and takes no target`);
  if (!world_id) throw new Error("world_id is required");
  if (BENCHES[bench].needsActor && !actor_id) throw new Error("this bench needs an actor_id");
  db.prepare(`
    INSERT INTO lab_sweep_targets (id, bench, world_id, actor_id, label, enabled, inserted_at)
    VALUES (?,?,?,?,?,1,?)
    ON CONFLICT(bench, world_id, actor_id) DO UPDATE SET label = excluded.label, enabled = 1
  `).run(uid(), bench, world_id, actor_id || null, label || null, now());
  return listTargets();
}

export function removeTarget(id) {
  return db.prepare(`DELETE FROM lab_sweep_targets WHERE id = ?`).run(id).changes > 0;
}

export function setTargetEnabled(id, enabled) {
  return db.prepare(`UPDATE lab_sweep_targets SET enabled = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, id).changes > 0;
}

// ── The sweep ────────────────────────────────────────────────────────────────

const UNREACHABLE = "the bench answered";

async function fetchSimulatorBoard(bench, target, { SIMULATOR_URL, SERVICE_TOKEN }) {
  const url = `${SIMULATOR_URL}${BENCHES[bench].path(target)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const r = await fetch(url, { headers: { "X-Service-Token": SERVICE_TOKEN }, signal: ctl.signal });
    const body = await r.json().catch(() => null);
    if (!r.ok) return { error: `HTTP ${r.status}${body?.error ? " — " + body.error : ""}` };
    if (!body || !Array.isArray(body.checks)) return { error: "the board came back without a checks array" };
    return { checks: body.checks, checked_at: body.checked_at };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timed out after 30s" : String(e.message || e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

// One board → incidents. Returns the tally.
function fileBoard({ bench, target, checks, source }) {
  const tally = { checks: checks.length, passed: 0, failed: 0, skipped: 0, muted: 0,
                  opened: 0, reopened: 0, recurred: 0, resolved: 0 };
  // The catalogue learns what this source contains by watching it answer —
  // nothing anywhere holds a hardcoded list of case names.
  try { cases.recordSeen(bench, checks); } catch { /* never fail a sweep over bookkeeping */ }
  const muted = cases.mutedSet();
  // Passes, grouped by the subject each case declared — auto-resolve has to
  // close a world-scoped row under its world key, not under the run's target.
  const passedBySubject = new Map();
  // Every check this board ran, by name — what the manager shows when a board
  // row is expanded. Passes included: a board is its whole set of assertions,
  // and the incident page can only ever show the ones that failed.
  const roll = [];

  for (const c of checks) {
    const name = c?.name || "unnamed check";
    const verdict = c?.verdict;
    // Declared by the board; null when it says nothing, which keeps the old
    // whole-target behaviour for that case.
    const scope = ["actor", "world", "global"].includes(c?.scope) ? c.scope : null;
    const subject = checkSubject(target, scope);
    const isMuted = muted.has(`${bench}|${name}`);
    // `scope` rides along so a person reading a board can see WHICH subject each
    // case was filed against, and so a board that has not been taught to
    // declare one is visible as a null rather than looking like an actor case.
    roll.push({ name, verdict: isMuted ? "muted" : (verdict || "unknown"),
                muted: isMuted, real_verdict: verdict || "unknown", scope,
                detail: c?.detail == null ? "" : String(c.detail).slice(0, 600) });
    // A muted case files nothing and fails nothing. It is still COUNTED and
    // still shown, because a board that reads green only because somebody
    // turned three cases off is not a green board.
    if (isMuted) { tally.muted++; continue; }
    if (verdict === "pass") {
      tally.passed++;
      const key = `${subject.world_id || "-"}|${subject.actor_id || "-"}`;
      if (!passedBySubject.has(key)) passedBySubject.set(key, { ...subject, names: [] });
      passedBySubject.get(key).names.push(name);
      continue;
    }
    if (verdict === "skip") { tally.skipped++; continue; }

    // A verdict that is neither pass, fail nor skip is not a pass. The lab's
    // client already renders unknown verdicts as failing; the store agrees.
    const severity = verdict === "fail" ? "fail" : "unknown";
    tally.failed++;
    const sev = cases.severityMap().get(`${bench}|${name}`) || "blocking";
    const r = report({
      guard_near_duplicates: false,
      bench, bench_label: BENCHES[bench]?.label, check_name: name,
      case_severity: sev,
      world_id: subject.world_id, actor_id: subject.actor_id,
      scope_label: subjectScopeLabel(bench, target, scope),
      severity, source,
      detail: verdict === "fail" ? (c?.detail || "") :
        `verdict "${verdict}" is not one this board is allowed to return — ${c?.detail || "no detail"}`,
    });
    if (r.outcome === "opened") tally.opened++;
    else if (r.outcome === "reopened") tally.reopened++;
    else if (r.outcome === "recurred") tally.recurred++;
  }

  // Auto-resolve, and ONLY on an explicit pass. A check that has vanished from
  // the board (renamed, removed) is deliberately left open: its absence is not
  // a fix, and silently closing it would lose the only record that it existed.
  for (const group of passedBySubject.values()) {
    const placeholders = group.names.map(() => "?").join(",");
    const open = db.prepare(`
      SELECT id, check_name FROM lab_incidents
       WHERE bench = ? AND world_id IS ? AND actor_id IS ?
         AND status IN ('open','acknowledged')
         AND check_name IN (${placeholders})
    `).all(bench, group.world_id, group.actor_id, ...group.names);
    const t = now();
    for (const row of open) {
      db.prepare(`UPDATE lab_incidents SET status='resolved', resolved_at=?, resolved_by=?, updated_at=? WHERE id=?`)
        .run(t, source, t, row.id);
      tally.resolved++;
    }

    // The sticky pair get the SAME pass recorded, without their status moving.
    // This is the only thing a pass does to a known/wontfix row, and it is what
    // makes "this red is by design" distinguishable from "this red is by design
    // and stopped being red three weeks ago".
    db.prepare(`
      UPDATE lab_incidents SET last_pass_at = ?, updated_at = ?
       WHERE bench = ? AND world_id IS ? AND actor_id IS ?
         AND status IN ('known','wontfix')
         AND check_name IN (${placeholders})
    `).run(t, t, bench, group.world_id, group.actor_id, ...group.names);
  }

  // The bench answered, so its own unreachable incident (if any) is fixed.
  const reach = db.prepare(`SELECT id FROM lab_incidents WHERE fingerprint = ? AND status IN ('open','acknowledged')`)
    .get(fingerprintOf({ bench, check_name: UNREACHABLE, world_id: target.world_id, actor_id: target.actor_id }));
  if (reach) {
    const t = now();
    db.prepare(`UPDATE lab_incidents SET status='resolved', resolved_at=?, resolved_by=?, updated_at=? WHERE id=?`)
      .run(t, source, t, reach.id);
    tally.resolved++;
  }

  return { ...tally, roll };
}

// Run every configured board once and file what they say.
//
// `signupChecks` is injected rather than fetched over HTTP: the signup board is
// this same process, and making it a self-request would mean minting a session
// for the server to show to itself.
export async function runSweep({ source = "sweep", SIMULATOR_URL, SERVICE_TOKEN, signupChecks, wizardChecks, avatarChecks, shareChecks, deployChecks, authoredChecks, signinChecks, only = null, suite_id = null, targets: suppliedTargets = null } = {}) {
  // `only` limits the run to a set of categories — what a suite needs. null
  // means every category, which is the plain sweep.
  const wanted = only ? new Set(only) : null;
  // Platform-local boards are values, not HTTP routes the server would have
  // to authenticate to itself. The CLI cannot supply them — it runs outside
  // the process — so a CLI sweep reports them "not configured" rather than
  // green, which is the same rule as an unreachable simulator board.
  const localBoards = { signupChecks, wizardChecks, avatarChecks, shareChecks, deployChecks, authoredChecks, signinChecks };
  const runId = uid();
  const startedAt = now();
  try { db.exec(`ALTER TABLE lab_sweep_runs ADD COLUMN suite_id TEXT`); } catch { /* already there */ }
  db.prepare(`INSERT INTO lab_sweep_runs (id, source, started_at, suite_id) VALUES (?,?,?,?)`)
    .run(runId, source, startedAt, suite_id);

  const totals = { boards_ok: 0, boards_errored: 0, checks_total: 0, passed: 0, failed: 0,
                   skipped: 0, muted: 0, opened: 0, reopened: 0, recurred: 0, resolved: 0 };
  const boards = [];

  const add = (t) => {
    totals.checks_total += t.checks; totals.passed += t.passed; totals.failed += t.failed;
    totals.skipped += t.skipped; totals.muted += (t.muted || 0);
    totals.opened += t.opened; totals.reopened += t.reopened;
    totals.recurred += t.recurred; totals.resolved += t.resolved;
  };

  // Supplied by the caller — a suite's run configuration. A run with no
  // targets simply cannot measure the scoped categories, and says so.
  const targets = suppliedTargets || [];

  for (const bench of Object.keys(BENCHES)) {
    if (wanted && !wanted.has(bench)) continue;
    const spec = BENCHES[bench];

    if (spec.scoped) {
      // A suite's targets are the run configuration, not per-category rows:
      // every scoped category runs against each of them. A category needing an
      // actor takes only the targets that name one; a world-only category
      // DEDUPES BY WORLD, or two targets in the same world would run it twice
      // and file the same finding against itself.
      const mine = spec.needsActor
        ? targets.filter((t) => t.actor_id)
        : targets.filter((t, i, a) => a.findIndex((x) => x.world_id === t.world_id) === i)
                 .map((t) => ({ ...t, actor_id: null }));
      if (!mine.length) {
        // Not a pass and not a failure — nothing was measured. Say so loudly
        // rather than letting an unconfigured bench read as a clean one.
        boards.push({ bench, label: spec.label, scope: "—", state: "not configured",
          detail: spec.needsActor
            ? "this category needs a world AND an actor, and the suite supplies none — it was not measured"
            : "this category needs a world, and the suite supplies none — it was not measured" });
        continue;
      }
      for (const t of mine) {
        const res = await fetchSimulatorBoard(bench, t, { SIMULATOR_URL, SERVICE_TOKEN });
        if (res.error) {
          totals.boards_errored++;
          const r = report({
      guard_near_duplicates: false,
            bench, bench_label: spec.label, check_name: UNREACHABLE,
            world_id: t.world_id, actor_id: t.actor_id, scope_label: scopeLabel(bench, t),
            severity: "error", source,
            detail: `the board could not be read, so nothing about this bench was measured this run: ${res.error}`,
          });
          if (r.outcome === "opened") totals.opened++;
          else if (r.outcome === "reopened") totals.reopened++;
          else if (r.outcome === "recurred") totals.recurred++;
          boards.push({ bench, label: spec.label, scope: scopeLabel(bench, t),
            state: "unreachable", detail: res.error });
          continue;
        }
        totals.boards_ok++;
        const tally = fileBoard({ bench, target: t, checks: res.checks, source });
        add(tally);
        boards.push({ bench, label: spec.label, scope: scopeLabel(bench, t), state: "read",
          checked_at: res.checked_at, ...tally });
      }
      continue;
    }

    // Global, platform-local board.
    if (spec.local) {
      const board = localBoards[spec.local];
      if (typeof board !== "function") {
        boards.push({ bench, label: spec.label, scope: "global", state: "not configured",
          detail: `the ${bench} board was not wired into this sweep` });
        continue;
      }
      try {
        const checks = await board();
        if (!Array.isArray(checks)) throw new Error("the board came back without a checks array");
        totals.boards_ok++;
        const tally = fileBoard({ bench, target: { world_id: null, actor_id: null }, checks, source });
        add(tally);
        boards.push({ bench, label: spec.label, scope: "global", state: "read", ...tally });
      } catch (e) {
        totals.boards_errored++;
        const r = report({
      guard_near_duplicates: false,
          bench, bench_label: spec.label, check_name: UNREACHABLE,
          scope_label: "global", severity: "error", source,
          detail: `the board could not be read, so nothing about this bench was measured this run: ${String(e.message || e).slice(0, 200)}`,
        });
        if (r.outcome === "opened") totals.opened++;
        else if (r.outcome === "reopened") totals.reopened++;
        else if (r.outcome === "recurred") totals.recurred++;
        boards.push({ bench, label: spec.label, scope: "global", state: "unreachable",
          detail: String(e.message || e).slice(0, 200) });
      }
    }
  }

  const finishedAt = now();
  db.prepare(`
    UPDATE lab_sweep_runs SET finished_at=?, boards_ok=?, boards_errored=?, checks_total=?,
      passed=?, failed=?, skipped=?, opened=?, reopened=?, recurred=?, resolved=?, detail=?
    WHERE id=?
  `).run(finishedAt, totals.boards_ok, totals.boards_errored, totals.checks_total,
    totals.passed, totals.failed, totals.skipped, totals.opened, totals.reopened,
    totals.recurred, totals.resolved,
    // Strip the per-check roll before persisting: six boards of check text
    // would exceed the column's 20k cap and truncate the JSON into garbage.
    JSON.stringify(boards.map(({ roll, ...rest }) => rest)).slice(0, 20000), runId);

  return { run_id: runId, source, suite_id, started_at: startedAt, finished_at: finishedAt, ...totals, boards };
}

export function listRuns(limit = 25) {
  return db.prepare(`SELECT * FROM lab_sweep_runs ORDER BY started_at DESC LIMIT ?`)
    .all(Math.min(Number(limit) || 25, 200));
}

// ── The runner ───────────────────────────────────────────────────────────────

// Run ONE suite. Its categories are swept in full (a scorecard cannot be asked
// for a subset), incidents are filed for everything they returned, and the
// RESULT is filtered down to the suite's own members so the report answers
// "did my suite pass" rather than "what happened everywhere".
export async function runSuite(suiteId, deps = {}) {
  const suite = cases.listSuites().find((s) => s.id === suiteId);
  if (!suite) throw new Error("no such suite");
  const categories = cases.suiteCategories(suite);
  if (categories.length === 0) {
    // An empty suite must not report a clean pass. It measured nothing.
    const empty = { suite_id: suiteId, suite: suite.name, empty: true,
      passed: 0, failed: 0, skipped: 0, muted: 0, cases: [] };
    cases.recordSuiteRun(suiteId, empty);
    return empty;
  }

  const sweep = await runSweep({
    ...deps,
    source: deps.source || `suite:${suite.name}`,
    only: categories,
    suite_id: suiteId,
    targets: suite.targets || [],
  });

  // Filter the roll down to this suite's members.
  const mine = [];
  for (const b of sweep.boards) {
    for (const c of (b.roll || [])) {
      if (cases.suiteIncludes(suite, b.bench, c.name)) mine.push({ ...c, source: b.bench });
    }
  }
  const tally = mine.reduce((a, c) => {
    const v = c.muted ? "muted" : c.verdict;
    a[v] = (a[v] || 0) + 1; return a;
  }, {});

  const result = {
    suite_id: suiteId, suite: suite.name, run_id: sweep.run_id,
    categories, ran_at: sweep.finished_at,
    total: mine.length,
    passed: tally.pass || 0, failed: tally.fail || 0,
    skipped: tally.skip || 0, muted: tally.muted || 0,
    unreadable: sweep.boards_errored,
    cases: mine,
  };
  cases.recordSuiteRun(suiteId, { ...result, cases: undefined });
  return result;
}

// ── The scheduler ────────────────────────────────────────────────────────────
//
// One timer, started at boot, that runs whatever is due. Deliberately serial:
// two suites firing at once would race each other's auto-resolve pass, the same
// reason the manual sweep holds an in-process lock.
let schedulerTimer = null;
let schedulerBusy = false;

export function startScheduler(deps = {}, everyMs = 60_000) {
  if (schedulerTimer) return schedulerTimer;
  schedulerTimer = setInterval(async () => {
    // Silence is a finding. A routine that stopped firing writes nothing, so
    // something that is still up has to go looking for the gap. Kept ahead of the
    // suite work and inside its own try, so a bug in liveness can never stop a
    // scheduled suite from running.
    try { maybeCheckRoutineLiveness(); }
    catch (e) { console.log(`[lab] routine liveness check failed: ${e.message}`); }
    if (schedulerBusy) return;
    let due = [];
    try { due = cases.dueSuites(); } catch { return; }
    if (!due.length) return;
    schedulerBusy = true;
    try {
      for (const s of due) {
        try {
          const r = await runSuite(s.id, { ...deps, source: `schedule:${s.name}` });
          console.log(`[lab] scheduled suite "${s.name}": ${r.passed} pass, ${r.failed} fail, ${r.skipped} skip`);
        } catch (e) {
          console.log(`[lab] scheduled suite "${s.name}" failed: ${e.message}`);
        }
      }
    } finally { schedulerBusy = false; }
  }, everyMs);
  if (schedulerTimer.unref) schedulerTimer.unref();
  return schedulerTimer;
}

export function schedulerStatus() {
  return {
    running: !!schedulerTimer,
    busy: schedulerBusy,
    scheduled: cases.listSuites()
      .filter((s) => s.enabled && s.schedule_kind !== "manual")
      .map((s) => ({ id: s.id, name: s.name, kind: s.schedule_kind,
                     value: s.schedule_value, last_run_at: s.last_run_at,
                     next_run_at: s.next_run_at })),
  };
}

// ── Routine liveness ─────────────────────────────────────────────────────────
//
// Filed 2026-09-03: the behaviour watch missed eight consecutive firings across
// 24h56m and NOTHING noticed, because a routine that never runs writes nothing
// and an empty log is indistinguishable from a clean one. The ten-hour world
// outage that day was found by a person opening the Test Lab, not by the watch
// whose whole job is to find it. Absence of evidence was being filed as absence
// of problems.
//
// A routine cannot report its own silence: the run that would have said "I did
// not run" is the run that did not happen. So the detector has to live somewhere
// that stays up when the Mac's scheduler does not, and this process is the only
// such place that already owns the board a person actually reads.
//
// Liveness is the NEWER of two signals:
//   - a ping, written by lab-incidents-cli.mjs when a routine runs one of its
//     OWN work commands (report/sweep — see PROOF_OF_LIFE_CMDS there; `status`
//     deliberately does not count, because that is what somebody tidying up
//     after a dead routine runs). As of 2026-09-05 none of the three routine
//     SKILL.md files calls `ping` and lab_routine_pings holds 0 rows, so in
//     practice this signal is not yet wired up and a clean run that files
//     nothing leaves no trace at all here, and
//   - the newest last_seen_at of anything that source ever filed. last_seen_at
//     is written only by report(), never by setStatus, so it is real evidence of
//     a run and it gives this detector history from before its first ping.
db.exec(`
  CREATE TABLE IF NOT EXISTS lab_routine_pings (
    source       TEXT PRIMARY KEY,
    last_ping_at TEXT NOT NULL,
    last_cmd     TEXT,
    pings        INTEGER NOT NULL DEFAULT 1
  );
`);

// Grace is deliberately several missed firings, not one: a routine that starts
// late, or takes an hour, must not open a red row. Three misses for the
// behaviour watch is nine hours of nobody watching, which is worth waking to.
export const ROUTINES = {
  "behavior-watch": { label: "Routine · Behaviour watch", everyHours: 3, graceHours: 9 },
  "conduct-watch":  { label: "Routine · Conduct watch",   everyHours: 1, graceHours: 4 },
  "fault-triage":   { label: "Routine · Fault triage",    everyHours: 1, graceHours: 4 },
};

export const LIVENESS_CHECK = "the routine stopped running and nothing noticed";

// ONLY the `routine:<name>` provenance form counts as proof of life. The bare
// bench name (`--source behavior-watch`) is also what the resolution manager
// passes when it closes a row that routine filed, and treating that as a run
// would let a dead routine look alive because somebody else tidied up after
// it — precisely the false negative this detector exists to prevent. An
// explicit `ping` normalises to the prefixed form before calling in.
export function routineKey(source) {
  const s = String(source || "").trim();
  if (!s.startsWith("routine:")) return null;
  const k = s.slice("routine:".length);
  return Object.prototype.hasOwnProperty.call(ROUTINES, k) ? k : null;
}

export function recordRoutinePing(source, cmd) {
  const key = routineKey(source);
  if (!key) return null;
  const t = now();
  db.prepare(`
    INSERT INTO lab_routine_pings (source, last_ping_at, last_cmd, pings)
    VALUES (?,?,?,1)
    ON CONFLICT(source) DO UPDATE SET
      last_ping_at = excluded.last_ping_at, last_cmd = excluded.last_cmd, pings = pings + 1
  `).run(key, t, cmd ? String(cmd).slice(0, 80) : null);
  return { source: key, at: t };
}

export function routineLiveness() {
  return Object.entries(ROUTINES).map(([key, r]) => {
    const ping = db.prepare(`SELECT last_ping_at, pings FROM lab_routine_pings WHERE source = ?`).get(key);
    const filed = db.prepare(`SELECT MAX(last_seen_at) AS t FROM lab_incidents WHERE source IN (?, ?)`)
      .get(key, `routine:${key}`);
    const stamps = [ping?.last_ping_at, filed?.t].filter(Boolean).sort();
    const last = stamps.length ? stamps[stamps.length - 1] : null;
    const ageMs = last ? Date.now() - Date.parse(last) : null;
    return {
      source: key, label: r.label, every_hours: r.everyHours, grace_hours: r.graceHours,
      last_heard_at: last, pings: ping?.pings || 0,
      age_hours: ageMs == null ? null : Number((ageMs / 3600000).toFixed(2)),
      // Never heard from AT ALL is not the same finding as stopped: it is a
      // routine this store has no history for, and a detector that opens a red
      // row about something it has never seen is one nobody reads.
      stale: ageMs != null && ageMs > r.graceHours * 3600000,
    };
  });
}

export function checkRoutineLiveness() {
  const acted = [];
  for (const r of routineLiveness()) {
    const fp = fingerprintOf({ bench: r.source, check_name: LIVENESS_CHECK });
    const row = db.prepare(`SELECT * FROM lab_incidents WHERE fingerprint = ?`).get(fp);

    // A liveness row set `wontfix`/`known` says "this routine is switched off on
    // purpose, so its silence is not a fault" — a statement about a routine that
    // was not running at the time, NOT a standing decision to stop watching it.
    // The premise expires the moment the routine speaks again. Until 2026-09-05
    // it never did: report()'s sticky branch returns `suppressed` and leaves the
    // status alone, and the recovery arm below only looked at open/acknowledged,
    // so ONE wontfix on this fingerprint permanently blinded the detector for
    // that routine — it could never go red again and could never auto-close
    // either. The detector promises the opposite in its own detail text ("This
    // row closes itself as soon as the routine speaks again").
    //
    // Deliberately narrow. Sticky stays sticky everywhere else — the encounter
    // board's by-design reds, and anima-watch's `ignored`. This un-sticks ONLY
    // the liveness fingerprint, and ONLY when the routine has been heard from
    // AFTER the decision was recorded. `updated_at` is the "as of" for the
    // decision: report() bumps it only while the row is stale (i.e. always
    // strictly after last_heard_at at that moment), so it can only fall before
    // last_heard_at once the routine has genuinely spoken since.
    const stickyExpired = !!(row && (row.status === "wontfix" || row.status === "known") &&
      r.last_heard_at && String(row.updated_at) < String(r.last_heard_at));
    // Carried ONLY on the un-stick, so a person's won't-fix reasoning is not
    // silently overwritten by the detector. Not carried on ordinary auto-close,
    // which would grow the note without bound over repeated stop/start cycles.
    const carried = stickyExpired && row.note
      ? `\n\n--- carried over from the ${row.status} note set at ${row.updated_at} ---\n${row.note}`
      : "";

    if (r.stale) {
      const missed = Math.max(1, Math.floor(r.age_hours / r.every_hours));
      if (stickyExpired) {
        setStatus(row.id, "open", "routine-liveness",
          `Re-armed automatically: this row was set ${row.status} at ${row.updated_at}, but ` +
          `${r.label} has been heard from since (${r.last_heard_at}) and has now gone silent ` +
          `again. A "it is switched off" decision does not outlive the routine being switched ` +
          `back on.` + carried);
        acted.push({ source: r.source, action: `re-armed (was ${row.status})` });
      }
      // Only claim the evidence we actually have. With pings > 0 the age below
      // really is the newer of two independent signals. With pings = 0 the ONLY
      // input is last_seen_at, which report() moves and a clean run never
      // touches — so the age measures "nothing has been FILED for this long",
      // not a missed heartbeat, and a clean run is indistinguishable from a dead
      // one. Saying otherwise tells a reader a clean run would have been visible
      // when it would not.
      //
      // Deliberately NOT gating the row on pings > 0: with last_seen_at alone
      // this detector still produces true positives (2026-09-05: fault-triage
      // genuinely silent ~30h), and suppressing the row would delete a correct
      // alarm and recreate the outage nobody noticed. Only the wording was wrong.
      const evidence = r.pings > 0
        ? `Liveness is the newer of its last ping to this board and the last thing it filed; both are ` +
          `that old, so this is silence, not a clean run.`
        : `This routine has never pinged this board (0 pings recorded), so this row is inferred purely ` +
          `from the last thing it FILED. A clean run that files nothing writes nothing here, so read the ` +
          `age as "nothing filed for that long" — a clean run and a dead one are currently ` +
          `indistinguishable to this detector.`;
      report({
      guard_near_duplicates: false,
        bench: r.source, bench_label: r.label, check_name: LIVENESS_CHECK,
        severity: "error", source: "routine-liveness", scope_label: "global",
        detail: `${r.label} is scheduled every ${r.every_hours}h and has not been heard from since ` +
          `${r.last_heard_at} — ${r.age_hours}h ago, roughly ${missed} missed firings. ${evidence} ` +
          `Look for a previous run of this routine still stalled mid-flight ` +
          `and blocking its own next firing. This row closes itself as soon as the routine speaks again.`,
      });
      acted.push({ source: r.source, action: "reported", age_hours: r.age_hours });
    } else if (row && (row.status === "open" || row.status === "acknowledged" || stickyExpired)) {
      setStatus(row.id, "resolved", "routine-liveness",
        `Running again: heard from at ${r.last_heard_at}, ${r.age_hours}h ago, inside its ` +
        `${r.grace_hours}h grace. Closed automatically by the liveness detector.` +
        (stickyExpired
          ? ` This row had been set ${row.status} at ${row.updated_at} while the routine was off; ` +
            `the routine has spoken since, so that decision has expired rather than muting this ` +
            `routine's alarm for good.`
          : "") + carried);
      acted.push({ source: r.source, action: stickyExpired ? `resolved (was ${row.status})` : "resolved" });
    }
  }
  return acted;
}

// Ridden on the scheduler's existing one-minute timer rather than a second
// interval, but evaluated at most every ten minutes: the question "has anything
// been silent for hours" does not get a better answer by being asked sixty
// times an hour.
let lastLivenessAt = 0;
export function maybeCheckRoutineLiveness(everyMs = 600000) {
  if (Date.now() - lastLivenessAt < everyMs) return [];
  lastLivenessAt = Date.now();
  const acted = checkRoutineLiveness();
  for (const a of acted) {
    console.log(`[lab] routine liveness: ${a.source} ${a.action}` +
      (a.age_hours == null ? "" : ` (${a.age_hours}h silent)`));
  }
  return acted;
}
