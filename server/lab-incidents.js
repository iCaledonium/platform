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
    missing: known.filter((k) => !found.has(k)).sort(),
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

// ── Filing ───────────────────────────────────────────────────────────────────

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

  const existing = db.prepare(`SELECT * FROM lab_incidents WHERE fingerprint = ?`).get(fp);

  if (!existing) {
    db.prepare(`
      INSERT INTO lab_incidents
        (id, fingerprint, bench, bench_label, check_name, world_id, actor_id, scope_label,
         severity, status, source, detail, first_detail, occurrences,
         first_seen_at, last_seen_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,?,1,?,?,?)
    `).run(uid(), fp, bench, inc.bench_label || BENCHES[bench]?.label || bench, check_name,
      world_id, actor_id, inc.scope_label || "global", severity,
      inc.source || "sweep", detail, detail, t, t, t);
    return { outcome: "opened", fingerprint: fp };
  }

  if (existing.status === "resolved") {
    db.prepare(`
      UPDATE lab_incidents SET status='open', severity=?, detail=?, occurrences=occurrences+1,
        last_seen_at=?, resolved_at=NULL, resolved_by=NULL, source=?, updated_at=? WHERE id=?
    `).run(severity, detail, t, inc.source || "sweep", t, existing.id);
    return { outcome: "reopened", fingerprint: fp };
  }

  db.prepare(`
    UPDATE lab_incidents SET severity=?, detail=?, occurrences=occurrences+1,
      last_seen_at=?, updated_at=? WHERE id=?
  `).run(severity, detail, t, t, existing.id);

  return {
    outcome: (existing.status === "known" || existing.status === "wontfix") ? "suppressed" : "recurred",
    fingerprint: fp,
  };
}

export function setStatus(id, status, by, note) {
  const allowed = ["open", "acknowledged", "known", "resolved", "wontfix"];
  if (!allowed.includes(status)) throw new Error(`unknown status ${status}`);
  const t = now();
  const r = db.prepare(`
    UPDATE lab_incidents
       SET status = ?, note = COALESCE(?, note), updated_at = ?,
           resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END,
           resolved_by = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END
     WHERE id = ?
  `).run(status, note ?? null, t, status, t, status, by || null, id);
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
  const scope_label = scopeLabel(bench, target);
  const passedNames = [];
  // Every check this board ran, by name — what the manager shows when a board
  // row is expanded. Passes included: a board is its whole set of assertions,
  // and the incident page can only ever show the ones that failed.
  const roll = [];

  for (const c of checks) {
    const name = c?.name || "unnamed check";
    const verdict = c?.verdict;
    const isMuted = muted.has(`${bench}|${name}`);
    roll.push({ name, verdict: isMuted ? "muted" : (verdict || "unknown"),
                muted: isMuted, real_verdict: verdict || "unknown",
                detail: c?.detail == null ? "" : String(c.detail).slice(0, 600) });
    // A muted case files nothing and fails nothing. It is still COUNTED and
    // still shown, because a board that reads green only because somebody
    // turned three cases off is not a green board.
    if (isMuted) { tally.muted++; continue; }
    if (verdict === "pass") { tally.passed++; passedNames.push(name); continue; }
    if (verdict === "skip") { tally.skipped++; continue; }

    // A verdict that is neither pass, fail nor skip is not a pass. The lab's
    // client already renders unknown verdicts as failing; the store agrees.
    const severity = verdict === "fail" ? "fail" : "unknown";
    tally.failed++;
    const sev = cases.severityMap().get(`${bench}|${name}`) || "blocking";
    const r = report({
      bench, bench_label: BENCHES[bench]?.label, check_name: name,
      case_severity: sev,
      world_id: target.world_id, actor_id: target.actor_id, scope_label,
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
  if (passedNames.length) {
    const placeholders = passedNames.map(() => "?").join(",");
    const open = db.prepare(`
      SELECT id, check_name FROM lab_incidents
       WHERE bench = ? AND world_id IS ? AND actor_id IS ?
         AND status IN ('open','acknowledged')
         AND check_name IN (${placeholders})
    `).all(bench, target.world_id || null, target.actor_id || null, ...passedNames);
    const t = now();
    for (const row of open) {
      db.prepare(`UPDATE lab_incidents SET status='resolved', resolved_at=?, resolved_by=?, updated_at=? WHERE id=?`)
        .run(t, source, t, row.id);
      tally.resolved++;
    }
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
export async function runSweep({ source = "sweep", SIMULATOR_URL, SERVICE_TOKEN, signupChecks, wizardChecks, avatarChecks, shareChecks, deployChecks, authoredChecks } = {}) {
  // Platform-local boards are values, not HTTP routes the server would have
  // to authenticate to itself. The CLI cannot supply them — it runs outside
  // the process — so a CLI sweep reports them "not configured" rather than
  // green, which is the same rule as an unreachable simulator board.
  const localBoards = { signupChecks, wizardChecks, avatarChecks, shareChecks, deployChecks, authoredChecks };
  const runId = uid();
  const startedAt = now();
  db.prepare(`INSERT INTO lab_sweep_runs (id, source, started_at) VALUES (?,?,?)`)
    .run(runId, source, startedAt);

  const totals = { boards_ok: 0, boards_errored: 0, checks_total: 0, passed: 0, failed: 0,
                   skipped: 0, muted: 0, opened: 0, reopened: 0, recurred: 0, resolved: 0 };
  const boards = [];

  const add = (t) => {
    totals.checks_total += t.checks; totals.passed += t.passed; totals.failed += t.failed;
    totals.skipped += t.skipped; totals.muted += (t.muted || 0);
    totals.opened += t.opened; totals.reopened += t.reopened;
    totals.recurred += t.recurred; totals.resolved += t.resolved;
  };

  const targets = listTargets().filter((t) => t.enabled);

  for (const bench of Object.keys(BENCHES)) {
    const spec = BENCHES[bench];

    if (spec.scoped) {
      const mine = targets.filter((t) => t.bench === bench);
      if (!mine.length) {
        // Not a pass and not a failure — nothing was measured. Say so loudly
        // rather than letting an unconfigured bench read as a clean one.
        boards.push({ bench, label: spec.label, scope: "—", state: "not configured",
          detail: "no enabled target — this bench was not measured" });
        continue;
      }
      for (const t of mine) {
        const res = await fetchSimulatorBoard(bench, t, { SIMULATOR_URL, SERVICE_TOKEN });
        if (res.error) {
          totals.boards_errored++;
          const r = report({
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

  return { run_id: runId, source, started_at: startedAt, finished_at: finishedAt, ...totals, boards };
}

export function listRuns(limit = 25) {
  return db.prepare(`SELECT * FROM lab_sweep_runs ORDER BY started_at DESC LIMIT ?`)
    .all(Math.min(Number(limit) || 25, 200));
}
