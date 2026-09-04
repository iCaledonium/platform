// Resolution manager status — a single row the always-alive daemon (on the
// local Mac, see anima-watcher-bridge/resolution-manager.mjs) pushes to over
// ssh, and the Test Lab page polls over HTTP. Its own table, same reason as
// lab-incidents.js: db.js is large and shared, and a whole-file write to it
// is a chance to drop somebody else's table.
//
// One row, id='singleton', upserted. There is exactly one resolution
// manager, so there is exactly one status.

import db from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS resolution_manager (
    id             TEXT PRIMARY KEY,
    state          TEXT NOT NULL DEFAULT 'idle',
    bench          TEXT,
    check_name     TEXT,
    note           TEXT,
    started_at     TEXT,
    updated_at     TEXT NOT NULL,
    resolved_count INTEGER NOT NULL DEFAULT 0,
    flagged_count  INTEGER NOT NULL DEFAULT 0,
    last_result    TEXT,
    last_run_at    TEXT
  );
`);

const now = () => new Date().toISOString();

const DEFAULTS = {
  id: "singleton", state: "idle", bench: null, check_name: null, note: null,
  started_at: null, updated_at: null, resolved_count: 0, flagged_count: 0,
  last_result: null, last_run_at: null,
};

export function getStatus() {
  const row = db.prepare(`SELECT * FROM resolution_manager WHERE id = 'singleton'`).get();
  return row || { ...DEFAULTS, updated_at: now() };
}

// A patch, not a replace — the daemon only sends the fields that changed
// (e.g. going idle clears bench/check_name/note but leaves the counters).
export function setStatus(patch) {
  const cur = getStatus();
  const next = { ...DEFAULTS, ...cur, ...patch, id: "singleton", updated_at: now() };
  db.prepare(`
    INSERT INTO resolution_manager
      (id, state, bench, check_name, note, started_at, updated_at,
       resolved_count, flagged_count, last_result, last_run_at)
    VALUES ('singleton', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      state = excluded.state, bench = excluded.bench, check_name = excluded.check_name,
      note = excluded.note, started_at = excluded.started_at, updated_at = excluded.updated_at,
      resolved_count = excluded.resolved_count, flagged_count = excluded.flagged_count,
      last_result = excluded.last_result, last_run_at = excluded.last_run_at
  `).run(next.state, next.bench, next.check_name, next.note, next.started_at,
         next.updated_at, next.resolved_count, next.flagged_count,
         next.last_result, next.last_run_at);
  return next;
}
