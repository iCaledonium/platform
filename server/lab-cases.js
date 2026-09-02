// Test cases — the administration layer under /lab/home/testmanager.
//
// The vocabulary this module settles, because the lab had been using one word
// for three things:
//
//   TEST CASE — one assertion. "no deployed character is a minor". 77 of them.
//               Either BUILT-IN (returned by a bench's scorecard, defined in
//               code) or AUTHORED (written here, stored in the DB).
//   SOURCE    — where a built-in case comes from: encounter, wizard, avatar…
//               Eight of them. Formerly, and confusingly, also called "board".
//   BOARD     — a NAMED SET of test cases that you compose. A view, not an
//               execution path: the same case can sit in five boards and is
//               still one case with one incident.
//
// The catalogue LEARNS ITSELF. Nothing here holds a hardcoded list of built-in
// case names — every sweep upserts what each source actually returned. That is
// the same rule the sweep already follows for sources: a board is the authority
// on its own contents, and a list of somebody else's work goes stale in silence
// (which is exactly how two whole sources went unmeasured for an evening).

import crypto from "crypto";
import Database from "better-sqlite3";
import path from "path";
import os from "os";
import db from "./db.js";

const DB_PATH = path.join(os.homedir(), "platform_dev.db");

// A SECOND connection, opened read-only, used for nothing but authored SQL.
//
// This is the whole safety story for letting a test case be written in a web
// form. A write on this handle fails inside SQLite with SQLITE_READONLY — it is
// not a keyword blocklist, not a regex over the query text, and not something a
// cleverly-worded statement gets around. Opened lazily so importing this module
// never costs a file handle on a host that has no authored cases.
let ro = null;
function readonlyDb() {
  if (!ro) ro = new Database(DB_PATH, { readonly: true });
  return ro;
}

db.exec(`
  -- What each source actually returned, learned by observation.
  CREATE TABLE IF NOT EXISTS lab_known_cases (
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    check_name    TEXT NOT NULL,
    last_verdict  TEXT,
    last_detail   TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    UNIQUE(source, check_name)
  );

  -- Per-case administration. Keyed by (source, check_name) so it works for a
  -- built-in case whose definition lives in code and cannot carry a column.
  CREATE TABLE IF NOT EXISTS lab_case_settings (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    check_name  TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    severity    TEXT NOT NULL DEFAULT 'blocking',
    owner       TEXT,
    note        TEXT,
    category_id TEXT,
    updated_at  TEXT NOT NULL,
    UNIQUE(source, check_name)
  );

  -- Cases written here rather than in code. They sweep under the source
  -- 'authored', which is a source like any other as far as everything
  -- downstream is concerned.
  CREATE TABLE IF NOT EXISTS lab_test_cases (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL,          -- 'query' | 'probe'
    sql          TEXT,                   -- kind=query: must return one number
    op           TEXT NOT NULL DEFAULT 'eq',
    expected     REAL NOT NULL DEFAULT 0,
    probe_path   TEXT,                   -- kind=probe: a loopback path
    probe_method TEXT NOT NULL DEFAULT 'GET',
    category_id  TEXT,
    pass_detail  TEXT,
    fail_detail  TEXT,
    inserted_at  TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  -- A SUITE is a named set of test cases. A member is either one CASE or a
  -- whole CATEGORY — "everything the deploy category asserts" should not have
  -- to be re-picked every time somebody adds a case to it, which is the point
  -- of letting a category be a member in its own right.
  -- Categories are managed here, not inferred from code. builtin_source is
  -- set on the ones seeded to mirror a board, so seeding stays idempotent and
  -- a renamed category is never re-created behind your back.
  CREATE TABLE IF NOT EXISTS lab_categories (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    description    TEXT,
    builtin_source TEXT UNIQUE,
    inserted_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lab_suites (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    description    TEXT,
    schedule_kind  TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'interval' | 'daily'
    schedule_value TEXT,                             -- interval: minutes; daily: "HH:MM"
    enabled        INTEGER NOT NULL DEFAULT 1,
    last_run_at    TEXT,
    last_result    TEXT,
    inserted_at    TEXT NOT NULL
  );

  -- Which world (and actor) a suite runs its SCOPED categories against.
  -- A suite with only platform-wide categories needs none of these.
  CREATE TABLE IF NOT EXISTS lab_suite_targets (
    id        TEXT PRIMARY KEY,
    suite_id  TEXT NOT NULL REFERENCES lab_suites(id) ON DELETE CASCADE,
    world_id  TEXT NOT NULL,
    actor_id  TEXT,
    label     TEXT,
    UNIQUE(suite_id, world_id, actor_id)
  );

  CREATE TABLE IF NOT EXISTS lab_suite_members (
    id         TEXT PRIMARY KEY,
    suite_id   TEXT NOT NULL REFERENCES lab_suites(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT 'case',          -- 'case' | 'category'
    source     TEXT NOT NULL,                         -- kind='case': the board; kind='category': a category id
    check_name TEXT,                                  -- NULL when kind='category'
    UNIQUE(suite_id, kind, source, check_name)
  );
`);

// Additive migrations for databases created before categories existed.
for (const stmt of [
  `ALTER TABLE lab_test_cases ADD COLUMN category_id TEXT`,
  `ALTER TABLE lab_case_settings ADD COLUMN category_id TEXT`,
]) { try { db.exec(stmt); } catch { /* already there */ } }

const now = () => new Date().toISOString();
const uid = () => crypto.randomBytes(9).toString("hex");

export const SEVERITIES = ["blocking", "advisory"];
const OPS = { eq: "=", ne: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" };

// ── The catalogue ────────────────────────────────────────────────────────────

// Called by the sweep for every case a source returned. This is what makes the
// catalogue complete without anybody maintaining it.
export function recordSeen(source, checks) {
  const t = now();
  const stmt = db.prepare(`
    INSERT INTO lab_known_cases (id, source, check_name, last_verdict, last_detail, first_seen_at, last_seen_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(source, check_name) DO UPDATE SET
      last_verdict = excluded.last_verdict,
      last_detail  = excluded.last_detail,
      last_seen_at = excluded.last_seen_at
  `);
  const many = db.transaction((rows) => {
    for (const c of rows) {
      if (!c?.name) continue;
      stmt.run(uid(), source, String(c.name).slice(0, 400), c.verdict || "unknown",
        c.detail == null ? null : String(c.detail).slice(0, 1000), t, t);
    }
  });
  many(checks || []);
}

// Every case the lab knows about, built-in and authored, with its settings.
export function catalogue() {
  const maps = categoryMaps();
  const catName = (source, name) => {
    const id = categoryOf(source, name, maps);
    return { category_id: id, category: id ? (maps.byId.get(id)?.name || null) : null };
  };
  const settings = new Map(
    db.prepare(`SELECT * FROM lab_case_settings`).all().map((s) => [`${s.source}|${s.check_name}`, s]));

  // An authored case that has been DELETED leaves its catalogue row behind on
  // purpose, so incident history stays readable — but it must not go on
  // appearing in the catalogue as a live case with no category. Drop the
  // ghosts here rather than deleting the row and losing the history.
  const liveAuthored = new Set(db.prepare(`SELECT name FROM lab_test_cases`).all().map((a) => a.name));
  const builtin = db.prepare(`SELECT * FROM lab_known_cases ORDER BY source, check_name`).all()
    .filter((k) => k.source !== "authored" || liveAuthored.has(k.check_name))
    .map((k) => {
      const s = settings.get(`${k.source}|${k.check_name}`);
      return {
        ...catName(k.source, k.check_name),
        source: k.source, check_name: k.check_name, authored: false,
        last_verdict: k.last_verdict, last_detail: k.last_detail, last_seen_at: k.last_seen_at,
        enabled: s ? !!s.enabled : true,
        severity: s?.severity || "blocking",
        owner: s?.owner || null, note: s?.note || null,
      };
    });

  const authored = db.prepare(`SELECT * FROM lab_test_cases ORDER BY name`).all().map((a) => {
    const s = settings.get(`authored|${a.name}`);
    const k = db.prepare(`SELECT * FROM lab_known_cases WHERE source='authored' AND check_name=?`).get(a.name);
    return {
      ...catName("authored", a.name),
      source: "authored", check_name: a.name, authored: true, id: a.id,
      kind: a.kind, sql: a.sql, op: a.op, expected: a.expected,
      probe_path: a.probe_path, probe_method: a.probe_method,
      last_verdict: k?.last_verdict || null, last_detail: k?.last_detail || null,
      last_seen_at: k?.last_seen_at || null,
      enabled: s ? !!s.enabled : true,
      severity: s?.severity || "blocking",
      owner: s?.owner || null, note: s?.note || null,
    };
  });

  return [...builtin, ...authored];
}

export function setCaseSettings({ source, check_name, enabled, severity, owner, note }) {
  if (severity && !SEVERITIES.includes(severity)) throw new Error(`severity must be ${SEVERITIES.join(" or ")}`);
  const existing = db.prepare(`SELECT * FROM lab_case_settings WHERE source=? AND check_name=?`)
    .get(source, check_name);
  const row = {
    enabled: enabled === undefined ? (existing ? existing.enabled : 1) : (enabled ? 1 : 0),
    severity: severity || existing?.severity || "blocking",
    owner: owner === undefined ? (existing?.owner ?? null) : (owner || null),
    note: note === undefined ? (existing?.note ?? null) : (note || null),
  };
  db.prepare(`
    INSERT INTO lab_case_settings (id, source, check_name, enabled, severity, owner, note, updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(source, check_name) DO UPDATE SET
      enabled=excluded.enabled, severity=excluded.severity,
      owner=excluded.owner, note=excluded.note, updated_at=excluded.updated_at
  `).run(uid(), source, check_name, row.enabled, row.severity, row.owner, row.note, now());
  return true;
}

// A muted case must not file, must not fail a run, and must not be silently
// invisible either — the sweep reports it as 'muted' so a board that looks
// green because somebody turned three cases off still says so.
export function mutedSet() {
  return new Set(db.prepare(`SELECT source, check_name FROM lab_case_settings WHERE enabled = 0`)
    .all().map((r) => `${r.source}|${r.check_name}`));
}

export function severityMap() {
  return new Map(db.prepare(`SELECT source, check_name, severity FROM lab_case_settings`)
    .all().map((r) => [`${r.source}|${r.check_name}`, r.severity]));
}

// ── Authored cases ───────────────────────────────────────────────────────────

export function listAuthored() {
  return db.prepare(`SELECT * FROM lab_test_cases ORDER BY name`).all();
}

// Everything an authored case must satisfy before it is allowed anywhere near
// a sweep. One copy, used by save AND by the dry run, so the form can never
// accept something the sweep would then choke on.
export function validateAuthored(c) {
  const name = String(c.name || "").trim();
  if (!name) throw new Error("a test case needs a name");
  // Provenance is not subject: a case written here is still ABOUT something,
  // and must say which category before it can join a sweep.
  if (!c.category_id) throw new Error("pick the category this test case belongs to");
  if (!db.prepare(`SELECT id FROM lab_categories WHERE id = ?`).get(c.category_id)) {
    throw new Error("no such category");
  }
  if (!["query", "probe"].includes(c.kind)) throw new Error("kind must be query or probe");
  if (!OPS[c.op || "eq"]) throw new Error(`op must be one of ${Object.keys(OPS).join(", ")}`);
  if (!Number.isFinite(Number(c.expected))) throw new Error("expected must be a number");

  if (c.kind === "query") {
    if (!String(c.sql || "").trim()) throw new Error("a query case needs SQL");
    // Prepared on the READ-ONLY handle, so a write is rejected by SQLite itself
    // at save time rather than at 3am inside a sweep. This is the safety story
    // for authoring from a form: not a keyword blocklist, an engine that cannot
    // write through this connection at all.
    let stmt;
    try { stmt = readonlyDb().prepare(c.sql); }
    catch (e) { throw new Error(`SQLite rejected this query: ${e.message}`); }
    // BOTH properties, and the second is the one that matters. `.reader` only
    // says the statement returns rows — DELETE ... RETURNING does that, and an
    // earlier version of this guard accepted exactly that. `.readonly` is the
    // one that says it writes nothing. The read-only CONNECTION would still
    // refuse it at execution, but a write that is caught at run time surfaces
    // as a failing test case rather than as a rejected one, which is the wrong
    // place to find out.
    if (!stmt.readonly) throw new Error("that statement writes — a test case must ask a question, not perform an action");
    if (!stmt.reader) throw new Error("that statement does not return rows — a test case must select a single number");
  } else {
    const pp = String(c.probe_path || "");
    if (!pp.startsWith("/")) throw new Error("a probe path must start with /");
    if (pp.includes("://")) throw new Error("a probe path is a path on this server, not a URL");
    if (!["GET", "POST"].includes(c.probe_method || "GET")) throw new Error("probe method must be GET or POST");
  }
  return name;
}

export function saveAuthored(c) {
  const name = validateAuthored(c);
  const t = now();
  const existing = c.id ? db.prepare(`SELECT id FROM lab_test_cases WHERE id = ?`).get(c.id) : null;
  if (existing) {
    db.prepare(`UPDATE lab_test_cases SET name=?, kind=?, sql=?, op=?, expected=?, probe_path=?,
                  probe_method=?, pass_detail=?, fail_detail=?, category_id=?, updated_at=? WHERE id=?`)
      .run(name, c.kind, c.sql || null, c.op || "eq", Number(c.expected || 0), c.probe_path || null,
        c.probe_method || "GET", c.pass_detail || null, c.fail_detail || null, c.category_id, t, c.id);
    return c.id;
  }
  const id = uid();
  db.prepare(`INSERT INTO lab_test_cases (id, name, kind, sql, op, expected, probe_path, probe_method,
                pass_detail, fail_detail, category_id, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, c.kind, c.sql || null, c.op || "eq", Number(c.expected || 0), c.probe_path || null,
      c.probe_method || "GET", c.pass_detail || null, c.fail_detail || null, c.category_id, t, t);
  return id;
}

export function deleteAuthored(id) {
  const row = db.prepare(`SELECT name FROM lab_test_cases WHERE id = ?`).get(id);
  if (!row) return false;
  db.prepare(`DELETE FROM lab_test_cases WHERE id = ?`).run(id);
  // Leave lab_known_cases alone on purpose: the incident history for this case
  // stays readable, and the catalogue entry ages out rather than vanishing
  // mid-investigation.
  db.prepare(`DELETE FROM lab_board_members WHERE source='authored' AND check_name = ?`).run(row.name);
  return true;
}

function compare(actual, op, expected) {
  switch (op) {
    case "eq":  return actual === expected;
    case "ne":  return actual !== expected;
    case "lt":  return actual < expected;
    case "lte": return actual <= expected;
    case "gt":  return actual > expected;
    case "gte": return actual >= expected;
    default:    return false;
  }
}

// Run every authored case and return them in the standard board shape, so the
// sweep treats 'authored' as a source like any other.
// Run ONE case and return it in the standard { name, verdict, detail } shape.
export async function runCase(c, { PORT = 4002 } = {}) {
  const checks = [];
  {
    const label = `${OPS[c.op] || "="} ${c.expected}`;
    try {
      if (c.kind === "query") {
        const stmt = readonlyDb().prepare(c.sql);
        if (!stmt.reader) throw new Error("this statement no longer returns rows");
        const row = stmt.get();
        const first = row == null ? null : (typeof row === "object" ? Object.values(row)[0] : row);
        const n = Number(first);
        if (!Number.isFinite(n)) {
          // A bare block, not a loop: return the row rather than continuing.
          return { name: c.name, verdict: "fail",
            detail: `the query returned ${JSON.stringify(first)}, which is not a number — a query case must select a single count` };
        }
        const ok = compare(n, c.op, Number(c.expected));
        checks.push({ name: c.name, verdict: ok ? "pass" : "fail",
          detail: ok ? (c.pass_detail || `returned ${n}, and the case asserts ${label}`)
                     : (c.fail_detail ? `${c.fail_detail} (returned ${n}, expected ${label})`
                                      : `returned ${n}, but the case asserts ${label}`) });
      } else {
        let status = 0;
        try {
          // Anonymous on purpose: an authored probe asserts what a request with
          // no session gets, which is the shape of every door check in the lab.
          const r = await fetch(`http://127.0.0.1:${PORT}${c.probe_path}`, {
            method: c.probe_method || "GET",
            headers: { "Content-Type": "application/json" },
            ...(c.probe_method === "POST" ? { body: "{}" } : {}),
          });
          status = r.status;
        } catch (e) { status = 0; }
        const ok = compare(status, c.op, Number(c.expected));
        checks.push({ name: c.name, verdict: ok ? "pass" : "fail",
          detail: ok ? (c.pass_detail || `${c.probe_method} ${c.probe_path} answered ${status}, and the case asserts ${label}`)
                     : (c.fail_detail ? `${c.fail_detail} (${c.probe_method} ${c.probe_path} answered ${status}, expected ${label})`
                                      : `${c.probe_method} ${c.probe_path} answered ${status}, but the case asserts ${label}`) });
      }
    } catch (e) {
      // A case that crashes is a red row, never a 500 that takes the run down.
      checks.push({ name: c.name, verdict: "fail", detail: `the case crashed instead of answering: ${e.message}` });
    }
  }
  return checks[0];
}

// Every authored case, in the standard board shape, so the sweep treats
// 'authored' as a source like any other.
export async function runAuthored({ PORT = 4002 } = {}) {
  const out = [];
  for (const c of listAuthored()) out.push(await runCase(c, { PORT }));
  return out;
}

// Validate a DRAFT and run it once without storing anything. This is what makes
// authoring survivable: you find out the query returns text, or the probe path
// is wrong, before the case is in the nightly sweep filing incidents.
export async function tryAuthored(draft, { PORT = 4002 } = {}) {
  const name = validateAuthored(draft);
  return runCase({ ...draft, name, expected: Number(draft.expected || 0), op: draft.op || "eq" }, { PORT });
}

// ── Suites ───────────────────────────────────────────────────────────────────

export const SCHEDULE_KINDS = ["manual", "interval", "daily"];

export function listSuites() {
  const suites = db.prepare(`SELECT * FROM lab_suites ORDER BY name`).all();
  const members = db.prepare(`SELECT * FROM lab_suite_members`).all();
  const targets = db.prepare(`SELECT * FROM lab_suite_targets`).all();
  return suites.map((s) => ({
    ...s,
    enabled: !!s.enabled,
    last_result: s.last_result ? JSON.parse(s.last_result) : null,
    members: members.filter((m) => m.suite_id === s.id)
      .map((m) => ({ kind: m.kind, source: m.source, check_name: m.check_name })),
    targets: targets.filter((t) => t.suite_id === s.id)
      .map((t) => ({ id: t.id, world_id: t.world_id, actor_id: t.actor_id, label: t.label })),
    next_run_at: nextRunAt(s),
  }));
}

export function setSuiteTargets(suite_id, targets) {
  if (!db.prepare(`SELECT id FROM lab_suites WHERE id = ?`).get(suite_id)) throw new Error("no such suite");
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM lab_suite_targets WHERE suite_id = ?`).run(suite_id);
    const ins = db.prepare(`INSERT OR IGNORE INTO lab_suite_targets (id, suite_id, world_id, actor_id, label)
                            VALUES (?,?,?,?,?)`);
    for (const t of targets || []) {
      if (!t?.world_id) continue;
      ins.run(uid(), suite_id, t.world_id, t.actor_id || null, t.label || null);
    }
  });
  tx();
  return listSuites().find((s) => s.id === suite_id);
}

// Categories that no suite covers. The analogue of the unwired-source check:
// a category nothing runs is not a passing category, and the only thing worse
// than an untested area is an untested area nobody mentions.
export function uncoveredCategories(allCategories) {
  const covered = new Set();
  for (const s of listSuites()) {
    if (!s.enabled) continue;
    for (const m of s.members) covered.add(m.source);
  }
  return (allCategories || []).filter((c) => !covered.has(c)).sort();
}

export function saveSuite({ id, name, description, schedule_kind, schedule_value, enabled }) {
  const n = String(name || "").trim();
  if (!n) throw new Error("a suite needs a name");
  const kind = schedule_kind || "manual";
  if (!SCHEDULE_KINDS.includes(kind)) throw new Error(`schedule must be ${SCHEDULE_KINDS.join(", ")}`);
  if (kind === "interval") {
    const m = Number(schedule_value);
    if (!Number.isFinite(m) || m < 5) throw new Error("an interval is a whole number of minutes, 5 or more");
  }
  if (kind === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(schedule_value || ""))) {
    throw new Error("a daily schedule needs a time as HH:MM");
  }
  const en = enabled === undefined ? 1 : (enabled ? 1 : 0);
  if (id) {
    db.prepare(`UPDATE lab_suites SET name=?, description=?, schedule_kind=?, schedule_value=?, enabled=? WHERE id=?`)
      .run(n, description || null, kind, schedule_value == null ? null : String(schedule_value), en, id);
    return id;
  }
  const sid = uid();
  db.prepare(`INSERT INTO lab_suites (id,name,description,schedule_kind,schedule_value,enabled,inserted_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(sid, n, description || null, kind, schedule_value == null ? null : String(schedule_value), en, now());
  return sid;
}

export function deleteSuite(id) {
  return db.prepare(`DELETE FROM lab_suites WHERE id = ?`).run(id).changes > 0;
}

export function setSuiteMembers(suite_id, members) {
  if (!db.prepare(`SELECT id FROM lab_suites WHERE id = ?`).get(suite_id)) throw new Error("no such suite");
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM lab_suite_members WHERE suite_id = ?`).run(suite_id);
    const ins = db.prepare(`INSERT OR IGNORE INTO lab_suite_members (id, suite_id, kind, source, check_name)
                            VALUES (?,?,?,?,?)`);
    for (const m of members || []) {
      if (!m?.source) continue;
      const kind = m.kind === "category" ? "category" : "case";
      if (kind === "case" && !m.check_name) continue;
      ins.run(uid(), suite_id, kind, m.source, kind === "category" ? null : m.check_name);
    }
  });
  tx();
  return listSuites().find((s) => s.id === suite_id);
}

// Which CATEGORIES a suite needs run. A category member pulls its whole
// category; a case member pulls the one it belongs to. Running is per-category
// because a scorecard endpoint is all-or-nothing — it cannot be asked for one
// case — so the suite is applied as a filter over what comes back.
// Which BOARDS must run for this suite. A case member names its board
// directly; a category member resolves to every board that currently holds
// a case in it, which is what lets a category span boards.
export function suiteCategories(suite) {
  const out = new Set();
  for (const m of suite.members || []) {
    if (m.kind === "case") { out.add(m.source); continue; }
    for (const s of sourcesForCategory(m.source)) out.add(s);
  }
  return [...out];
}

// Does this suite include a given case? A category member includes everything
// in it, INCLUDING cases added to that category later — which is the whole
// reason a category can be a member.
export function suiteIncludes(suite, source, check_name, maps) {
  const m0 = maps || categoryMaps();
  const cat = categoryOf(source, check_name, m0);
  for (const m of suite.members || []) {
    // A category member matches on the case's CATEGORY, so a case moved into
    // that category is picked up wherever it is executed from.
    if (m.kind === "category" && m.source === cat) return true;
    if (m.kind === "case" && m.source === source && m.check_name === check_name) return true;
  }
  return false;
}

export function recordSuiteRun(id, result) {
  db.prepare(`UPDATE lab_suites SET last_run_at = ?, last_result = ? WHERE id = ?`)
    .run(now(), JSON.stringify(result).slice(0, 4000), id);
}

// ── Scheduling ───────────────────────────────────────────────────────────────
//
// Deliberately a small vocabulary rather than cron: "every N minutes" and
// "daily at HH:MM" cover what this lab needs, and both are unambiguous to read
// off the page. Next-run is COMPUTED from last_run_at rather than stored, so a
// restart cannot lose a schedule or fire a backlog of missed runs at boot.

export function nextRunAt(s) {
  if (!s || !s.enabled || s.schedule_kind === "manual") return null;
  const last = s.last_run_at ? new Date(s.last_run_at).getTime() : null;
  if (s.schedule_kind === "interval") {
    const ms = Math.max(5, Number(s.schedule_value || 60)) * 60_000;
    return new Date((last || Date.now()) + ms).toISOString();
  }
  if (s.schedule_kind === "daily") {
    const [hh, mm] = String(s.schedule_value || "03:00").split(":").map(Number);
    const now_ = new Date();
    const next = new Date(now_);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= now_.getTime()) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  return null;
}

export function dueSuites() {
  const t = Date.now();
  return listSuites().filter((s) => {
    if (!s.enabled || s.schedule_kind === "manual") return false;
    if (s.schedule_kind === "interval") {
      const ms = Math.max(5, Number(s.schedule_value || 60)) * 60_000;
      if (!s.last_run_at) return true;
      return t - new Date(s.last_run_at).getTime() >= ms;
    }
    if (s.schedule_kind === "daily") {
      const [hh, mm] = String(s.schedule_value || "03:00").split(":").map(Number);
      const now_ = new Date(t);
      const todayAt = new Date(now_); todayAt.setHours(hh, mm, 0, 0);
      if (now_ < todayAt) return false;
      // Due if it has not already run since today's slot came round.
      return !s.last_run_at || new Date(s.last_run_at) < todayAt;
    }
    return false;
  });
}

// ── Migration: the old global target list becomes a suite ────────────────────
//
// Targets used to sit in lab_sweep_targets, global to every run. Moving them
// onto the suite would otherwise silently stop measuring whatever was pinned,
// so the old rows are folded into an "All tests" suite once — covering every
// category, carrying the same targets, and left for the owner to edit or
// delete like any other suite.
export function migrateGlobalTargets(allCategories) {
  try {
    const haveSuites = db.prepare(`SELECT COUNT(*) c FROM lab_suites`).get().c;
    if (haveSuites > 0) return null;
    const old = db.prepare(`SELECT * FROM lab_sweep_targets WHERE enabled = 1`).all();
    const id = saveSuite({ name: "All tests", description:
      "Every category. Created automatically when targets moved from a global list onto suites." });
    setSuiteMembers(id, (allCategories || []).map((c) => ({ kind: "category", source: c })));
    // Distinct worlds/actors: the old table keyed targets by category, but a
    // suite's targets are the run configuration, not per-category rows.
    const seen = new Set();
    const targets = [];
    for (const t of old) {
      const k = `${t.world_id}|${t.actor_id || ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      targets.push({ world_id: t.world_id, actor_id: t.actor_id, label: t.label });
    }
    if (targets.length) setSuiteTargets(id, targets);
    return { id, targets: targets.length, categories: (allCategories || []).length };
  } catch { return null; }
}

// ── Categories ───────────────────────────────────────────────────────────────

// Seed one category per board, once. Idempotent via builtin_source, and it
// never touches a category somebody has renamed or re-described.
export function seedCategories(benches) {
  const ins = db.prepare(`INSERT OR IGNORE INTO lab_categories
    (id, name, description, builtin_source, inserted_at) VALUES (?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (const [key, b] of Object.entries(benches || {})) {
      // `authored` is a SOURCE, not a category — cases written in the manager
      // are about whatever their author says they are about.
      if (key === "authored") continue;
      ins.run(uid(), b.label || key, null, key, now());
    }
  });
  tx();
  return listCategories();
}

export function listCategories() {
  return db.prepare(`SELECT * FROM lab_categories ORDER BY name`).all();
}

export function saveCategory({ id, name, description }) {
  const n = String(name || "").trim();
  if (!n) throw new Error("a category needs a name");
  if (id) {
    db.prepare(`UPDATE lab_categories SET name=?, description=? WHERE id=?`).run(n, description || null, id);
    return id;
  }
  const cid = uid();
  db.prepare(`INSERT INTO lab_categories (id, name, description, inserted_at) VALUES (?,?,?,?)`)
    .run(cid, n, description || null, now());
  return cid;
}

export function deleteCategory(id) {
  const row = db.prepare(`SELECT builtin_source FROM lab_categories WHERE id = ?`).get(id);
  if (!row) return false;
  // A board's own category may not be deleted: its cases would have nowhere to
  // land, and it would be re-seeded at the next boot anyway.
  if (row.builtin_source) throw new Error("this category mirrors a board and cannot be deleted — rename it instead");
  const used = db.prepare(`SELECT COUNT(*) c FROM lab_case_settings WHERE category_id = ?`).get(id).c
             + db.prepare(`SELECT COUNT(*) c FROM lab_test_cases WHERE category_id = ?`).get(id).c;
  if (used > 0) throw new Error(`${used} test case(s) still sit in this category — move them first`);
  db.prepare(`DELETE FROM lab_categories WHERE id = ?`).run(id);
  return true;
}

// Where a case lives: an explicit assignment if one exists, otherwise the
// category that mirrors the board it comes from.
export function categoryOf(source, check_name, maps) {
  const { assigned, bySource } = maps;
  return assigned.get(`${source}|${check_name}`) || bySource.get(source) || null;
}

export function categoryMaps() {
  const cats = listCategories();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const bySource = new Map(cats.filter((c) => c.builtin_source).map((c) => [c.builtin_source, c.id]));
  const assigned = new Map();
  for (const s of db.prepare(`SELECT source, check_name, category_id FROM lab_case_settings WHERE category_id IS NOT NULL`).all()) {
    assigned.set(`${s.source}|${s.check_name}`, s.category_id);
  }
  for (const a of db.prepare(`SELECT name, category_id FROM lab_test_cases WHERE category_id IS NOT NULL`).all()) {
    assigned.set(`authored|${a.name}`, a.category_id);
  }
  return { byId, bySource, assigned, cats };
}

// Move test cases into a category. Works for built-in and authored alike —
// an authored case keeps its own column, a built-in gets a settings override.
export function assignCategory(cases_, category_id) {
  if (!db.prepare(`SELECT id FROM lab_categories WHERE id = ?`).get(category_id)) {
    throw new Error("no such category");
  }
  const tx = db.transaction(() => {
    for (const c of cases_ || []) {
      if (!c?.source || !c?.check_name) continue;
      if (c.source === "authored") {
        db.prepare(`UPDATE lab_test_cases SET category_id = ?, updated_at = ? WHERE name = ?`)
          .run(category_id, now(), c.check_name);
      } else {
        const existing = db.prepare(`SELECT id FROM lab_case_settings WHERE source=? AND check_name=?`)
          .get(c.source, c.check_name);
        if (existing) {
          db.prepare(`UPDATE lab_case_settings SET category_id=?, updated_at=? WHERE id=?`)
            .run(category_id, now(), existing.id);
        } else {
          db.prepare(`INSERT INTO lab_case_settings (id, source, check_name, category_id, updated_at)
                      VALUES (?,?,?,?,?)`).run(uid(), c.source, c.check_name, category_id, now());
        }
      }
    }
  });
  tx();
  return listCategories();
}

// Which SOURCES must run to cover a category — a category can draw cases from
// several boards once you move things around, and running is per-board because
// a scorecard is all-or-nothing.
export function sourcesForCategory(category_id) {
  const maps = categoryMaps();
  const out = new Set();
  for (const k of db.prepare(`SELECT source, check_name FROM lab_known_cases`).all()) {
    if (categoryOf(k.source, k.check_name, maps) === category_id) out.add(k.source);
  }
  const cat = maps.byId.get(category_id);
  if (cat?.builtin_source) out.add(cat.builtin_source);
  // Authored cases assigned to this category, INCLUDING ones that have never
  // run. Reading only the observed catalogue would be circular: a new case
  // would not run until it had already run.
  const n = db.prepare(`SELECT COUNT(*) c FROM lab_test_cases WHERE category_id = ?`).get(category_id).c;
  if (n > 0) out.add("authored");
  return [...out];
}

// One-time translation of suite category members from board keys to category
// ids. Without it a suite built before categories existed matches nothing and
// reports a clean run over an empty selection, which is the worst failure this
// system can have.
export function migrateSuiteCategoryMembers() {
  const maps = categoryMaps();
  const rows = db.prepare(`SELECT * FROM lab_suite_members WHERE kind = 'category'`).all();
  let moved = 0, dropped = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (maps.byId.has(r.source)) continue;              // already a category id
      const id = maps.bySource.get(r.source);
      if (id) {
        db.prepare(`UPDATE lab_suite_members SET source = ? WHERE id = ?`).run(id, r.id);
        moved++;
      } else {
        // `authored` was a member when it was pretending to be a category. It is
        // a source, so the membership has no meaning any more — its cases are
        // covered by whatever category their author put them in.
        db.prepare(`DELETE FROM lab_suite_members WHERE id = ?`).run(r.id);
        dropped++;
      }
    }
  });
  tx();
  return { moved, dropped };
}

// ── Read access for the designer assistant ───────────────────────────────────
//
// The assistant checks its own SQL through the SAME read-only connection the
// finished test case will use. That is the point: what it proves in the chat is
// what the case will do, and it cannot write there any more than the case can.
export function readQuery(sql, { rows = 20 } = {}) {
  let stmt;
  try { stmt = readonlyDb().prepare(sql); }
  catch (e) { throw new Error(`SQLite rejected this query: ${e.message}`); }
  if (!stmt.readonly) throw new Error("that statement writes — the assistant may only read");
  if (!stmt.reader) throw new Error("that statement returns no rows");
  return stmt.all().slice(0, rows);
}

// Table names and columns, so the assistant writes against the real schema
// instead of a plausible-looking invention.
export function schemaSummary() {
  const tables = readonlyDb().prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  return tables.map((t) => {
    const cols = readonlyDb().prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all();
    return `${t.name}(${cols.map((c) => c.name).join(", ")})`;
  });
}
