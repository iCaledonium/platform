// Restart broker status — a single row the always-alive daemon (on the
// local Mac, see ~/bin/anima-restart-daemon, launchd-managed, independent of
// any Claude session) pushes to over ssh, and the Test Lab page polls over
// HTTP. Own table, same reason as resolution_manager: db.js is large and
// shared, and a whole-file write to it is a chance to drop somebody else's
// table.
//
// One row, id='singleton', upserted.
//
// 2026-09-05 (Magnus): "you need two kinds of flags, one anima-platform-
// restart-flag and one anima-simulator-restart-flag... if they need both
// flags that is a third lease." What was one shared lease is now three
// independent ones - `platform`, `simulator`, `both` - each its own
// {lease, queue} pair:
//   `lease` (null when none held): {service, reason, session_id,
//   need_seconds, granted_at, expires_at_epoch} - a direct copy of the
//   matching ~/.claude/anima-restart/lease.<name>.json, or null.
//   `queue`: an array of {service, reason, session_id, need_seconds, ts} -
//   a direct copy of queue.<name>.jsonl's entries.
// The old singular `lease`/`queue` columns stay in the schema (harmless,
// unread by anything written after the three-way split) rather than being
// dropped, since a column drop needs more care than an ADD ever does.
// `daemon_heartbeat_epoch` is when the daemon last completed a loop tick
// (its own liveness signal) - the page uses "now minus this" to show
// whether the mechanical side of the broker is actually alive, independent
// of any Claude session. `recent` is the last N grant/release/reclaim lines
// from log.txt, newest first, so the page has some history without needing
// the whole file.

import db from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS restart_broker (
    id                     TEXT PRIMARY KEY,
    lease                  TEXT,
    queue                  TEXT NOT NULL DEFAULT '[]',
    daemon_heartbeat_epoch INTEGER,
    recent                 TEXT NOT NULL DEFAULT '[]',
    updated_at             TEXT NOT NULL
  );
`);
try { db.exec(`ALTER TABLE restart_broker ADD COLUMN platform TEXT NOT NULL DEFAULT '{"lease":null,"queue":[]}'`); }
catch { /* already there */ }
try { db.exec(`ALTER TABLE restart_broker ADD COLUMN simulator TEXT NOT NULL DEFAULT '{"lease":null,"queue":[]}'`); }
catch { /* already there */ }
try { db.exec(`ALTER TABLE restart_broker ADD COLUMN both TEXT NOT NULL DEFAULT '{"lease":null,"queue":[]}'`); }
catch { /* already there */ }

const now = () => new Date().toISOString();

const EMPTY_PAIR = { lease: null, queue: [] };

const DEFAULTS = {
  id: "singleton", lease: null, queue: [], daemon_heartbeat_epoch: null,
  recent: [], updated_at: null,
  platform: EMPTY_PAIR, simulator: EMPTY_PAIR, both: EMPTY_PAIR,
};

function parsePair(s) {
  try {
    const v = JSON.parse(s || "null");
    if (v && typeof v === "object") return { lease: v.lease ?? null, queue: Array.isArray(v.queue) ? v.queue : [] };
  } catch { /* fall through */ }
  return { ...EMPTY_PAIR };
}

function parseRow(row) {
  if (!row) return null;
  let lease = null;
  try { lease = row.lease ? JSON.parse(row.lease) : null; } catch { /* leave null */ }
  let queue = [];
  try { queue = JSON.parse(row.queue || "[]"); } catch { /* leave [] */ }
  let recent = [];
  try { recent = JSON.parse(row.recent || "[]"); } catch { /* leave [] */ }
  return {
    ...row, lease, queue, recent,
    platform: parsePair(row.platform),
    simulator: parsePair(row.simulator),
    both: parsePair(row.both),
  };
}

export function getStatus() {
  const row = db.prepare(`SELECT * FROM restart_broker WHERE id = 'singleton'`).get();
  return parseRow(row) || { ...DEFAULTS, updated_at: now() };
}

// A patch, not a replace - callers only send the fields that changed.
// `platform`/`simulator`/`both`/`recent`, when sent, are always the
// daemon's full current snapshot (it is the only process that tracks any
// of them, so it is the only source of truth for what "current" means) -
// there is nothing here to merge.
export function setStatus(patch) {
  const cur = getStatus();
  const next = { ...DEFAULTS, ...cur, ...patch, id: "singleton", updated_at: now() };
  const leaseJson = next.lease ? JSON.stringify(next.lease) : null;
  const queueJson = JSON.stringify(next.queue || []);
  const recentJson = JSON.stringify(next.recent || []);
  const platformJson = JSON.stringify(next.platform || EMPTY_PAIR);
  const simulatorJson = JSON.stringify(next.simulator || EMPTY_PAIR);
  const bothJson = JSON.stringify(next.both || EMPTY_PAIR);
  db.prepare(`
    INSERT INTO restart_broker
      (id, lease, queue, daemon_heartbeat_epoch, recent, updated_at, platform, simulator, both)
    VALUES ('singleton', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      lease = excluded.lease, queue = excluded.queue,
      daemon_heartbeat_epoch = excluded.daemon_heartbeat_epoch,
      recent = excluded.recent, updated_at = excluded.updated_at,
      platform = excluded.platform, simulator = excluded.simulator, both = excluded.both
  `).run(leaseJson, queueJson, next.daemon_heartbeat_epoch, recentJson, next.updated_at,
         platformJson, simulatorJson, bothJson);
  return next;
}
