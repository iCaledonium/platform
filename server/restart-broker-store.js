// Restart broker status — a single row the always-alive daemon (on the
// local Mac, see ~/bin/anima-restart-daemon, launchd-managed, independent of
// any Claude session) pushes to over ssh, and the Test Lab page polls over
// HTTP. Own table, same reason as resolution_manager: db.js is large and
// shared, and a whole-file write to it is a chance to drop somebody else's
// table.
//
// One row, id='singleton', upserted. There is exactly one restart flag for
// deliver-worlds/platform-api, so there is exactly one status.
//
// `lease` is the current holder (null when no lease is held): {service,
// reason, session_id, need_seconds, granted_at, expires_at_epoch} - a direct
// copy of ~/.claude/anima-restart/lease.json, or null.
// `queue` is the full waiting list in order: an array of {service, reason,
// session_id, need_seconds, ts} - a direct copy of queue.jsonl's entries.
// `daemon_heartbeat_epoch` is when the daemon last completed a loop tick
// (its own liveness signal, distinct from the old session-hosted broker's
// heartbeat) - the page uses "now minus this" to show whether the mechanical
// side of the broker is actually alive, independent of any Claude session.
// `recent` is the last N grant/release/reclaim lines from log.txt, newest
// first, so the page has some history without needing the whole file.

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

const now = () => new Date().toISOString();

const DEFAULTS = {
  id: "singleton", lease: null, queue: [], daemon_heartbeat_epoch: null,
  recent: [], updated_at: null,
};

function parseRow(row) {
  if (!row) return null;
  let lease = null;
  try { lease = row.lease ? JSON.parse(row.lease) : null; } catch { /* leave null */ }
  let queue = [];
  try { queue = JSON.parse(row.queue || "[]"); } catch { /* leave [] */ }
  let recent = [];
  try { recent = JSON.parse(row.recent || "[]"); } catch { /* leave [] */ }
  return { ...row, lease, queue, recent };
}

export function getStatus() {
  const row = db.prepare(`SELECT * FROM restart_broker WHERE id = 'singleton'`).get();
  return parseRow(row) || { ...DEFAULTS, updated_at: now() };
}

// A patch, not a replace - callers only send the fields that changed.
// `lease`, `queue`, and `recent`, when sent, are always the daemon's full
// current snapshot (it is the only process that tracks any of them, so it
// is the only source of truth for what "current" means) - there is nothing
// here to merge.
export function setStatus(patch) {
  const cur = getStatus();
  const next = { ...DEFAULTS, ...cur, ...patch, id: "singleton", updated_at: now() };
  const leaseJson = next.lease ? JSON.stringify(next.lease) : null;
  const queueJson = JSON.stringify(next.queue || []);
  const recentJson = JSON.stringify(next.recent || []);
  db.prepare(`
    INSERT INTO restart_broker
      (id, lease, queue, daemon_heartbeat_epoch, recent, updated_at)
    VALUES ('singleton', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      lease = excluded.lease, queue = excluded.queue,
      daemon_heartbeat_epoch = excluded.daemon_heartbeat_epoch,
      recent = excluded.recent, updated_at = excluded.updated_at
  `).run(leaseJson, queueJson, next.daemon_heartbeat_epoch, recentJson, next.updated_at);
  return next;
}
