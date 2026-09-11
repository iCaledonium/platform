// Resolution manager status — a single row the always-alive daemon (on the
// local Mac, see anima-watcher-bridge/resolution-manager.mjs) pushes to over
// ssh, and the Test Lab page polls over HTTP. Its own table, same reason as
// lab-incidents.js: db.js is large and shared, and a whole-file write to it
// is a chance to drop somebody else's table.
//
// One row, id='singleton', upserted. There is exactly one resolution
// manager, so there is exactly one status.
//
// `active_workers` (2026-09-04, concurrency raised to 6): a JSON array of
// {bench, check_name, started_at}, one per incident currently being worked.
// `recent` (2026-09-04): a JSON array of the last N incidents a worker
// FINISHED — {bench, check_name, fingerprint, status, finished_at} — so the
// page can show a row per completed activity rather than only the single
// most recent as a string, and light a link on the ones that need a human.
// `paused`/`paused_by` (2026-09-04): the ONLY field this store is written
// to by the platform's own routes rather than only by the daemon over ssh —
// a person pauses from the browser, the daemon polls this flag itself each
// loop tick and is the one that actually stops, aborting whatever it has in
// flight and leaving those incidents `open` rather than flagging them.
// `state` is still stored rather than derived, but the daemon is the only
// writer of it and always sends it consistent with active_workers' length —
// empty means idle, one-or-more means active. The old singular
// bench/check_name/started_at/note fields stay in the schema (harmless,
// unused by anything written after concurrency went in) rather than being
// dropped, since a column drop needs more care than an ADD ever does.

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
try { db.exec(`ALTER TABLE resolution_manager ADD COLUMN active_workers TEXT NOT NULL DEFAULT '[]'`); }
catch { /* already there */ }
try { db.exec(`ALTER TABLE resolution_manager ADD COLUMN recent TEXT NOT NULL DEFAULT '[]'`); }
catch { /* already there */ }
try { db.exec(`ALTER TABLE resolution_manager ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`); }
catch { /* already there */ }
try { db.exec(`ALTER TABLE resolution_manager ADD COLUMN paused_by TEXT`); }
catch { /* already there */ }

// ---------------------------------------------------------------------------
// Secret redaction at the persistence boundary (2026-09-05, conduct-watch:
// "the lab run ledger stores each step's shell command verbatim, so secrets
// typed into a command are persisted to platform_dev.db"). The daemon
// publishes each worker's CURRENT SHELL COMMAND as `last_action`, so a
// worker that types `T=<service token>; ...` writes that token into this
// database, which the Test Lab API then serves back out. The daemon lives on
// a machine this store cannot police, and any future publisher has the same
// problem, so the scrub happens HERE, on the way in: every string in a patch
// is redacted before it is persisted, and the redacted form is what callers
// get back. Over-redaction (a backup filename with a long digit run) is the
// acceptable failure direction; under-redaction is the fault being fixed.
const SECRETISH_NAME =
  /(token|secret|password|passwd|pwd|apikey|api[_-]?key|credential|auth|bearer|session|cookie|private[_-]?key)/i;

// "Looks like a credential, not like English or a path": a long unbroken run
// of credential-alphabet characters carrying BOTH letters and digits.
function looksLikeSecret(v) {
  const t = String(v == null ? "" : v).replace(/^["']|["']$/g, "");
  if (t.length < 20) return false;
  if (!/^[A-Za-z0-9+/=_.-]+$/.test(t)) return false;
  if (!/[0-9]/.test(t) || !/[A-Za-z]/.test(t)) return false;
  // Ordinary filenames and paths are not credentials.
  if (/\.(js|mjs|cjs|jsx|ex|exs|eex|json|db|sql|md|txt|log|sh|py|css|html|wal)$/i.test(t)) return false;
  if (/^\d[\d.]*$/.test(t)) return false;
  return true;
}

export function redactSecrets(s) {
  if (typeof s !== "string" || !s) return s;
  let out = s;
  // 1. KEY=VALUE - redacted when the NAME says secret (PLATFORM_SERVICE_TOKEN=x)
  //    or when the VALUE looks like a credential (the observed leak was `T=<token>`,
  //    whose name says nothing at all).
  out = out.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;|&)]+)/g,
    (m, k, v) => (SECRETISH_NAME.test(k) || looksLikeSecret(v)) ? k + "=[redacted]" : m
  );
  // 2. Header / flag / bearer forms.
  out = out.replace(/\b(bearer|basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi, (m, k) => k + " [redacted]");
  out = out.replace(
    /\b((?:x-[a-z0-9-]*(?:token|key|secret)|authorization|token|password|passwd|api[_-]?key)\s*[:=]\s*)(["']?)([^\s"'&;|]{6,})/gi,
    (m, lead) => lead + "[redacted]"
  );
  out = out.replace(/(--?(?:password|passwd|token|api-?key|secret)[=\s])(\S{6,})/gi, (m, lead) => lead + "[redacted]");
  // 3. Any remaining bare credential-shaped run, wherever it appears.
  out = out.replace(/[A-Za-z0-9+/=_-]{24,}/g, (m) => (looksLikeSecret(m) ? "[redacted]" : m));
  // 4. Hard cap: the ledger is a progress display, not a transcript.
  return out.length > 400 ? out.slice(0, 400) + "…" : out;
}

// session_id is a plain UUID, not a secret - but the redaction cascade above
// (rule 3 especially: "any remaining bare credential-shaped run") matches it
// anyway, since a UUID with its hyphens stripped by nothing is a 36-char run
// of the exact allowed alphabet containing both letters and digits. Skip
// redaction by KEY NAME for this one known-safe identifier field rather than
// loosen the general pattern - the restart-broker daemon cross-references
// this id against a lease's own session_id, so a "[redacted]" here silently
// breaks that lookup instead of erroring.
function scrubDeep(v, key) {
  if (typeof v === "string") return key === "session_id" ? v : redactSecrets(v);
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, key));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = scrubDeep(x, k);
    return o;
  }
  return v;
}
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();

const DEFAULTS = {
  id: "singleton", state: "idle", bench: null, check_name: null, note: null,
  started_at: null, updated_at: null, resolved_count: 0, flagged_count: 0,
  last_result: null, last_run_at: null, active_workers: [], recent: [],
  paused: false, paused_by: null,
};

function parseRow(row) {
  if (!row) return null;
  let active_workers = [];
  try { active_workers = JSON.parse(row.active_workers || "[]"); } catch { /* leave [] */ }
  let recent = [];
  try { recent = JSON.parse(row.recent || "[]"); } catch { /* leave [] */ }
  return { ...row, active_workers, recent, paused: !!row.paused };
}

export function getStatus() {
  const row = db.prepare(`SELECT * FROM resolution_manager WHERE id = 'singleton'`).get();
  return parseRow(row) || { ...DEFAULTS, updated_at: now() };
}

// A patch, not a replace — callers only send the fields that changed.
// `active_workers` and `recent`, when sent, are always the daemon's full
// current arrays (it is the only process that tracks either, so it is the
// only source of truth for what "current" means — there is nothing here to
// merge). `paused`/`paused_by` are the exception: the platform's own routes
// write those directly, not the daemon.
export function setStatus(patch) {
  const cur = getStatus();
  const merged = { ...DEFAULTS, ...cur, ...patch, id: "singleton", updated_at: now() };
  // Nothing reaches the database unredacted, and the caller is handed back
  // exactly what was stored (see redactSecrets above).
  const next = {
    ...merged,
    note: redactSecrets(merged.note),
    last_result: redactSecrets(merged.last_result),
    check_name: redactSecrets(merged.check_name),
    active_workers: scrubDeep(merged.active_workers || []),
    recent: scrubDeep(merged.recent || []),
  };
  const activeWorkersJson = JSON.stringify(next.active_workers);
  const recentJson = JSON.stringify(next.recent);
  db.prepare(`
    INSERT INTO resolution_manager
      (id, state, bench, check_name, note, started_at, updated_at,
       resolved_count, flagged_count, last_result, last_run_at, active_workers, recent,
       paused, paused_by)
    VALUES ('singleton', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      state = excluded.state, bench = excluded.bench, check_name = excluded.check_name,
      note = excluded.note, started_at = excluded.started_at, updated_at = excluded.updated_at,
      resolved_count = excluded.resolved_count, flagged_count = excluded.flagged_count,
      last_result = excluded.last_result, last_run_at = excluded.last_run_at,
      active_workers = excluded.active_workers, recent = excluded.recent,
      paused = excluded.paused, paused_by = excluded.paused_by
  `).run(next.state, next.bench, next.check_name, next.note, next.started_at,
         next.updated_at, next.resolved_count, next.flagged_count,
         next.last_result, next.last_run_at, activeWorkersJson, recentJson,
         next.paused ? 1 : 0, next.paused_by);
  return next;
}
