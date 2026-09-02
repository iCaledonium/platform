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
    pass_detail  TEXT,
    fail_detail  TEXT,
    inserted_at  TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lab_boards (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    inserted_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lab_board_members (
    id         TEXT PRIMARY KEY,
    board_id   TEXT NOT NULL REFERENCES lab_boards(id) ON DELETE CASCADE,
    source     TEXT NOT NULL,
    check_name TEXT NOT NULL,
    UNIQUE(board_id, source, check_name)
  );
`);

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
  const settings = new Map(
    db.prepare(`SELECT * FROM lab_case_settings`).all().map((s) => [`${s.source}|${s.check_name}`, s]));

  const builtin = db.prepare(`SELECT * FROM lab_known_cases ORDER BY source, check_name`).all()
    .map((k) => {
      const s = settings.get(`${k.source}|${k.check_name}`);
      return {
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
                  probe_method=?, pass_detail=?, fail_detail=?, updated_at=? WHERE id=?`)
      .run(name, c.kind, c.sql || null, c.op || "eq", Number(c.expected || 0), c.probe_path || null,
        c.probe_method || "GET", c.pass_detail || null, c.fail_detail || null, t, c.id);
    return c.id;
  }
  const id = uid();
  db.prepare(`INSERT INTO lab_test_cases (id, name, kind, sql, op, expected, probe_path, probe_method,
                pass_detail, fail_detail, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, c.kind, c.sql || null, c.op || "eq", Number(c.expected || 0), c.probe_path || null,
      c.probe_method || "GET", c.pass_detail || null, c.fail_detail || null, t, t);
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

// ── Composed boards ──────────────────────────────────────────────────────────

export function listBoards() {
  const boards = db.prepare(`SELECT * FROM lab_boards ORDER BY name`).all();
  const members = db.prepare(`SELECT * FROM lab_board_members`).all();
  return boards.map((b) => ({
    ...b,
    members: members.filter((m) => m.board_id === b.id)
      .map((m) => ({ source: m.source, check_name: m.check_name })),
  }));
}

export function saveBoard({ id, name, description }) {
  const n = String(name || "").trim();
  if (!n) throw new Error("a board needs a name");
  if (id) {
    db.prepare(`UPDATE lab_boards SET name=?, description=? WHERE id=?`).run(n, description || null, id);
    return id;
  }
  const bid = uid();
  db.prepare(`INSERT INTO lab_boards (id, name, description, inserted_at) VALUES (?,?,?,?)`)
    .run(bid, n, description || null, now());
  return bid;
}

export function deleteBoard(id) {
  return db.prepare(`DELETE FROM lab_boards WHERE id = ?`).run(id).changes > 0;
}

// Replace a board's contents wholesale — the picker sends the full selection,
// so a diff here would only be a chance to get it wrong.
export function setBoardMembers(board_id, members) {
  if (!db.prepare(`SELECT id FROM lab_boards WHERE id = ?`).get(board_id)) throw new Error("no such board");
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM lab_board_members WHERE board_id = ?`).run(board_id);
    const ins = db.prepare(`INSERT OR IGNORE INTO lab_board_members (id, board_id, source, check_name) VALUES (?,?,?,?)`);
    for (const m of members || []) {
      if (!m?.source || !m?.check_name) continue;
      ins.run(uid(), board_id, m.source, m.check_name);
    }
  });
  tx();
  return listBoards().find((b) => b.id === board_id);
}
