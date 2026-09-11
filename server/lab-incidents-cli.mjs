#!/usr/bin/env node
//
// The routine-facing door onto the incident store. Deliberately a CLI over ssh
// rather than an HTTP ingest route:
//
// The nightly suite runner and the watchers live on the Mac and hold no browser
// session, so an HTTP ingest would need its own bearer token — and nginx serves
// the LAN address and the public ngrok domain from the SAME server block, with
// the tunnel arriving at nginx from 127.0.0.1. There is therefore no honest way
// to make an HTTP route on :80 LAN-only, and a token route would be a new
// publicly-reachable credential (same rule family as "never allow 127.0.0.1 in
// nginx"). Those routines already hold ssh to this host; ssh is the trust
// boundary, key-authed, and adds no new surface at all.
//
//   ssh mac-mini-ubuntu 'node ~/platform/server/lab-incidents-cli.mjs sweep --source routine:nightly'
//     (delegates to the running platform-api over loopback: it runs every
//      enabled SUITE, each with its own targets, so it measures exactly what
//      the button measures. Add --suite <id> to run one.)
//
// Exit codes for cron: 0 all passed, 1 something failed, 2 nothing measured
// or the service was unreachable.
//   ssh mac-mini-ubuntu 'node ~/platform/server/lab-incidents-cli.mjs report' < finding.json
//   ssh mac-mini-ubuntu 'node ~/platform/server/lab-incidents-cli.mjs list --status unresolved'
//   ssh mac-mini-ubuntu 'node ~/platform/server/lab-incidents-cli.mjs status resolved \
//        --source fault-triage --check "the ThoughtEngine cannot reach the decision model"'
//
// `status` exists because a routine could previously file and never close.
// runSweep is only ever invoked with a CATEGORY key, so its auto-resolve arm
// (WHERE bench = ?) can never match an incident filed under a routine SOURCE —
// fault-triage, behavior-watch and conduct-watch findings sat open until a
// person clicked them in the browser, however long ago the fault was fixed.
// A routine that has re-run its own check and found it clean says so here,
// through the same door it filed through and against the same fingerprint.
//
// `report` reads one JSON object, or an array of them, on stdin:
//   { "bench": "suite", "check_name": "...", "detail": "...",
//     "world_id": null, "actor_id": null, "severity": "fail" }
//
// The check_name IS the identity of a finding (the fingerprint is
// bench|check_name|world|actor), so retyping it from memory forks a second row
// at occurrence 1 instead of recurring the real one — twelve times on this
// board by 2026-09-09, once forking four wordings of a single finding, and a
// reworded refile of a `wontfix` row silently reopens a decision the owner
// closed. `report` therefore REFUSES a check_name that is a reworded or
// truncated twin of a row already on that bench: it prints the canonical row
// and exits 1 without filing. Re-report under that row's exact check_name to
// recur it, or add "distinct_from": "<its id>" if it genuinely is a different
// finding. Copy check_names programmatically; never retype them.
//
// Exit codes: 0 = ran (see the JSON it prints), 1 = nothing filed / bad input,
// 2 = the store or the sweep itself failed.

import { readFileSync, statSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as store from "./lab-incidents.js";
import db from "./db.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

async function main() {
  // A routine talking to this board is proof that the routine ran. Only the
  // `routine:<name>` provenance form counts (see routineKey): the bare bench
  // name is what OTHER callers pass when they close that routine's rows.
  //
  // ...and only the commands by which a routine does its own work count. The
  // hole this closes is `status`: to MOVE a row you must name that row's own
  // source, and every row a routine filed carries `routine:<name>` (the skills
  // file with `report --source routine:<name>`). So anyone tidying up after a
  // routine -- the resolution manager, a person at a terminal -- was writing
  // proof that the routine itself had just run. That is not a theory: at
  // 2026-09-05T01:51-01:52Z all three liveness rows auto-closed with "Running
  // again: heard from at ..." while all three routines were still enabled=false
  // in the Mac scheduler and had not run since 2026-09-03. `report` and `sweep`
  // are work only the routine does; the explicit `ping` command records itself
  // further down and does not need this line.
  const PROOF_OF_LIFE_CMDS = new Set(["report", "sweep"]);
  try { if (PROOF_OF_LIFE_CMDS.has(cmd)) store.recordRoutinePing(flag("source", null), cmd); }
  catch { /* liveness bookkeeping must never fail a routine's real work */ }
  switch (cmd) {
    case "sweep": {
      // Delegate to the RUNNING platform-api rather than sweeping in here.
      //
      // Three of the six boards (signup, wizard, avatar) are functions living
      // inside that process; a sweep from out here can only report them "not
      // configured", which is honest but useless for a nightly routine. Going
      // through the process means the routine and the button run the identical
      // code over the identical six boards.
      const PORT = Number(process.env.PORT || 4002);
      const source = flag("source", "routine:cli");
      const token = crypto.randomBytes(16).toString("hex");
      const hash = crypto.createHash("sha256").update(token).digest("hex");
      const user = db.prepare(
        `SELECT id FROM users WHERE status != 'removed' ORDER BY (id='mk') DESC LIMIT 1`).get();
      if (!user) { console.error("no user to act as"); process.exit(2); }
      db.prepare(`INSERT INTO auth_tokens (id, user_id, token_hash, expires_at, inserted_at)
                  VALUES (lower(hex(randomblob(8))), ?, ?, datetime('now','+60 seconds'), datetime('now'))`)
        .run(user.id, hash);
      try {
        // Every enabled suite, which is the only execution path: a suite
        // carries its own targets, so a run out here measures exactly what
        // the button measures. `--suite <id>` runs just one.
        const suiteId = flag("suite", null);
        const url = suiteId
          ? `http://127.0.0.1:${PORT}/api/test/suites/${suiteId}/run`
          : `http://127.0.0.1:${PORT}/api/test/suites/run-all`;
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Cookie": `anima_token=${token}` },
          body: JSON.stringify({ source }),
        });
        const body = await r.json().catch(() => null);
        if (!r.ok || !body?.ok) {
          console.error(`the sweep endpoint refused: HTTP ${r.status} ${JSON.stringify(body)}`);
          process.exitCode = 2;
          return;
        }
        console.log(JSON.stringify(body, null, 2));
        // A run that measured NOTHING is not a pass. Exit non-zero so a cron
        // job cannot read silence as success.
        const rs = body.results || (body.result ? [body.result] : []);
        const measured = rs.reduce((a, x) => a + (x.total || 0), 0);
        const failed = rs.reduce((a, x) => a + (x.failed || 0), 0);
        if (rs.length && measured === 0) {
          console.error("nothing was measured — every suite was empty or had no target");
          process.exitCode = 2;
          return;
        }
        process.exitCode = failed > 0 ? 1 : 0;
      } catch (e) {
        // A dead platform-api must be loud. Reporting nothing here would look
        // exactly like a clean sweep to whatever reads this output.
        console.error(`platform-api unreachable on 127.0.0.1:${PORT} — nothing was measured: ${e.message}`);
        process.exitCode = 2;
      } finally {
        // process.exitCode (never process.exit()) above so THIS always runs:
        // process.exit() terminates immediately and skips a pending finally,
        // which was leaking a 60s auth_tokens row on every sweep call. Same
        // fix also covers a second, separate bug: a piped (non-TTY) stdout
        // is non-blocking on Linux, and process.exit() does not wait for a
        // large write (a full sweep report) to finish draining through the
        // 64KB OS pipe buffer before terminating — found live 2026-09-04 via
        // `list` truncating mid-string with 30 real incidents on the board.
        db.prepare(`DELETE FROM auth_tokens WHERE token_hash = ?`).run(hash);
      }
      // This `return` is load-bearing. Without it a SUCCESSFUL sweep fell
      // through into `case "report"` below — the only `return`s above are on
      // error paths, so the happy path hit JS switch fallthrough every time.
      // `report` then read stdin, found it empty (cron pipes nothing), printed
      // "nothing on stdin" and called process.exit(1): a clean nightly sweep
      // reported failure to cron, and process.exit() truncated the sweep's own
      // large stdout write mid-flush, which is the exact bug the comments above
      // this line were written to prevent. A sweep invoked WITH JSON on stdin
      // would additionally have filed it as findings. Found 2026-09-09 by the
      // resolution manager while fixing report idempotency in this same pair
      // of files.
      return;
    }

    case "report": {
      const raw = readStdin().trim();
      if (!raw) { console.error("nothing on stdin"); process.exit(1); }
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { console.error("stdin is not JSON: " + e.message); process.exit(1); }
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const source = flag("source", "routine:cli");
      // --run-id names THIS run, so the store can tell a re-submission from a
      // recurrence. Optional: with no run id the store falls back to comparing
      // the payload itself over a short window, which is what protects the
      // callers that cannot be taught this flag (the watch procedures live in
      // SKILL.md files on the Mac, outside both governed repos).
      const runId = flag("run-id", null);
      const results = [];
      for (const it of items) {
        if (!it || !it.check_name) { results.push({ error: "each finding needs a check_name", item: it }); continue; }
        results.push(store.report({ ...it, source: it.source || source,
          run_id: it.run_id || runId || undefined }));
      }
      console.log(JSON.stringify({ filed: results.length, results }, null, 2));
      // A refusal must be LOUD. The store now declines to open a row whose
      // check_name is a reworded or truncated twin of one already on that
      // bench, because filing it forks the board instead of recurring the
      // original — and the caller could not tell, since a fork returns
      // "opened" exactly like a genuinely new finding does. stdout JSON alone
      // is not enough: a routine that pipes it nowhere would read silence as
      // success, which is the same failure this guards against.
      // A suppressed duplicate must be visible on stderr for the same reason a
      // refusal is: the caller cannot otherwise tell that its second identical
      // call did nothing, and the whole point of this incident was a routine
      // that believed it had filed once when it had filed twice.
      const duped = results.filter((r) => r && r.outcome === "duplicate-ignored");
      if (duped.length) {
        console.error(`NOT COUNTED AGAIN: ${duped.length} finding(s) were an identical re-submission, ` +
                      `so their occurrence counts were left where they were.`);
        for (const r of duped) console.error(`  ${r.fingerprint} — ${r.why}`);
      }

      const refused = results.filter((r) => r && r.outcome === "refused-near-duplicate");
      for (const r of refused) {
        console.error(`REFUSED as a fork of an existing row: "${r.rejected_check_name}"`);
        for (const m of r.matched) {
          console.error(`  matches ${m.id} (${m.status}, occ ${m.occurrences}) — ${m.why}`);
          console.error(`    "${m.check_name}"`);
        }
        console.error(`  ${r.hint}`);
      }
      process.exitCode = (results.some((r) => r.error) || refused.length) ? 1 : 0;
      return;
    }

    // Address a row the way `report` does — by (source, check, world, actor) —
    // because a routine knows what it FILED, not what row id the store gave it.
    // --id is there for a person reading the board.
    case "status": {
      const allowed = ["open", "acknowledged", "known", "resolved", "wontfix"];
      const next = argv[1] && !argv[1].startsWith("--") ? argv[1] : flag("to", null);
      const usage = `usage: status <${allowed.join("|")}> ` +
        `(--id X | --source X --check "name" [--world W] [--actor A]) [--by X] [--note X | --note-stdin]`;
      if (!allowed.includes(next)) { console.error(usage); process.exit(1); }

      const id = flag("id", null);
      let row;
      if (id) {
        row = db.prepare(`SELECT id, status, fingerprint FROM lab_incidents WHERE id = ?`).get(id);
        if (!row) { console.error(`no incident with id ${id}`); process.exit(1); }
      } else {
        const bench = flag("source", null), check = flag("check", null);
        if (!bench || !check) { console.error(usage); process.exit(1); }
        const fp = store.fingerprintOf({ bench, check_name: check,
          world_id: flag("world", null), actor_id: flag("actor", null) });
        row = db.prepare(`SELECT id, status, fingerprint FROM lab_incidents WHERE fingerprint = ?`).get(fp);
        // A miss is nearly always a mistyped check name, or `--source routine:x`
        // copied from the `report` line above while the row's source is `x`
        // (report's --source is PROVENANCE; here it selects the board). Name the
        // sources that do carry this check, because exiting 0 would let a
        // routine report that it had closed something it had not.
        if (!row) {
          console.error(`no incident with fingerprint ${fp}`);
          const near = db.prepare(`SELECT DISTINCT bench FROM lab_incidents WHERE check_name = ?`)
            .all(check).map((r) => r.bench);
          if (near.length) console.error(`that check_name is filed under --source ${near.join(", ")}`);
          process.exit(1);
        }
      }

      // --note-stdin reads the note from stdin instead of argv, so a note
      // containing backticks, $(...), or quotes cannot be re-parsed by the
      // remote shell on its way here. Confirmed live 2026-09-04: a backtick
      // quoting an Elixir atom inside --note killed real resolve/flag
      // commands with an unexpected-EOF error, leaving those incidents
      // silently stuck open. Callers pass the note through a quoted heredoc
      // instead; argv --note still works unchanged.
      const note = argv.includes("--note-stdin") ? (readStdin().trim() || null) : flag("note", null);
      const ok = store.setStatus(row.id, next, flag("by", flag("source", "routine:cli")), note);
      console.log(JSON.stringify(
        { ok, id: row.id, fingerprint: row.fingerprint, from: row.status, to: next }, null, 2));
      process.exitCode = ok ? 0 : 2;
      return;
    }

    // Check in without filing anything. A run that finds nothing still ran, and
    // that is the run this board could never see: it wrote no incident, so the
    // only trace it left was an empty log entry on the Mac indistinguishable
    // from no run at all. Takes the bare routine name or the prefixed form.
    case "ping": {
      const raw = flag("source", null);
      if (!raw) { console.error("usage: ping --source <behavior-watch|conduct-watch|fault-triage>"); process.exit(1); }
      const r = store.recordRoutinePing(raw.startsWith("routine:") ? raw : `routine:${raw}`, "ping");
      if (!r) {
        console.error(`not a known routine: ${raw} (known: ${Object.keys(store.ROUTINES).join(", ")})`);
        process.exit(1);
      }
      console.log(JSON.stringify({ ok: true, ...r, env: environmentFacts() }, null, 2));
      process.exitCode = 0;
      return;
    }

    case "list": {
      // 2026-09-09: `list` reads status/bench/limit and NOTHING else. `--source`
      // is accepted by the arg parser and silently discarded here, while the
      // same flag means the routine name on `ping`, provenance on `report` and
      // the BENCH on `status`. A caller that learned "--source is the bench"
      // from `status` therefore gets EVERY bench back from `list` and has no
      // way to tell: `list --source conduct-watch` and `list --nonsense zzz`
      // returned byte-identical output. That cross-filed a behaviour-watch
      // check_name onto conduct-watch (dba2e22bf4ff7ecb0c, withdrawn in the
      // same run) because the fingerprint is bench|check_name|world|actor, so
      // the bench is what forks a row.
      //
      // The fix is disclosure rather than validation: the payload now states
      // the filter that was ACTUALLY applied, so a wrong scope is visible in
      // the caller's own output instead of being inferred from the flags it
      // passed. Deliberately the SAME object that is handed to listIncidents,
      // not a second copy of the same expressions — an echo that can drift
      // from the query it describes would be worse than no echo.
      const applied = {
        status: flag("status", "unresolved"), bench: flag("bench", "all"),
        limit: Number(flag("limit", "200")),
      };
      const rows = store.listIncidents(applied);
      // process.exitCode, not process.exit(): a piped (non-TTY) stdout is
      // non-blocking on Linux, and process.exit() does not wait for a large
      // write to finish draining through the OS's 64KB pipe buffer before
      // terminating. Found live 2026-09-04 by the resolution manager's own
      // `list` call: truncated mid-string at byte 65536 with 30 real
      // incidents on the board — small payloads during development never
      // crossed the boundary. exitCode lets node exit only once the write
      // has actually flushed.
      console.log(JSON.stringify({ count: rows.length, applied, counts: store.counts(), incidents: rows }, null, 2));
      process.exitCode = 0;
      return;
    }

    case "runs":
      // Same 64KB-pipe-truncation fix as `list` above.
      console.log(JSON.stringify(store.listRuns(Number(flag("limit", "10"))), null, 2));
      process.exitCode = 0;
      return;

    default:
      console.error(`usage: lab-incidents-cli.mjs <sweep|report|status|ping|list|runs> [--source X] [--status X] [--bench X] [--limit N]\n` +
        `       status <open|acknowledged|known|resolved|wontfix> (--id X | --source X --check "name") [--by X] [--note X | --note-stdin]`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Environment facts, emitted by `ping` — which every watch procedure runs as
// the FIRST command of every run, before it reads anything.
//
// Added 2026-09-09 by the resolution manager for the conduct-watch incident
// "this routine's procedure names no on-disk media root, so a scan for a
// minor's media against the wrong path returns empty and reads clean". The
// watch procedures are SKILL.md files on the Mac, outside both governed repos,
// so they cannot be corrected from here — but the reason they go wrong can be.
// A routine is now TOLD where the data lives by the host that holds it, at run
// start, instead of carrying transcribed paths that drift out of date silently.
//
// The distinction that makes this worth printing: an empty result is only
// clean if it came from the right path. A scope query run as
// `cd ~/platform; sqlite3 platform_dev.db` hit a 0-byte file (created by that
// very command) and answered "no such table: world_memberships" for every
// scope query on 2026-09-08/09 — which a run could have reported as zero
// memberships, zero actors, clean sweep. Local paths below are stat'ed live at
// ping time and are measurements; the simulator's are documented constants and
// are labelled as unverified from here, so they cannot be mistaken for one.
function statPath(p) {
  try {
    const st = statSync(p);
    const out = { path: p, exists: true };
    if (st.isFile()) out.bytes = st.size;
    if (st.isDirectory()) out.entries = readdirSync(p).sort();
    return out;
  } catch (e) { return { path: p, exists: false, error: e.code || String(e) }; }
}

// The repo-relative twin of the platform DB. Reported every ping precisely
// because its failure mode is silence: nothing in the codebase opens it (every
// module resolves os.homedir()), so it only ever gets read by a person or a
// routine typing a relative path, and reading it wrong looks like good news.
function repoRelativeDb(home, dbOfRecord) {
  const p = path.join(home, "platform/platform_dev.db");
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      const target = realpathSync(p);
      return { path: p, symlink_to: target, is_db_of_record: target === dbOfRecord };
    }
    return {
      path: p, symlink_to: null, is_db_of_record: false, bytes: st.size,
      warning: "NOT the database of record. `cd ~/platform; sqlite3 platform_dev.db` reads THIS file, and an empty one answers 'no such table' to every scope query — an absence of rows, not an absence of subjects.",
    };
  } catch (e) { return { path: p, exists: false, error: e.code || String(e) }; }
}

function environmentFacts() {
  const home = os.homedir();
  let dbOfRecord;
  try { dbOfRecord = db.name; } catch { dbOfRecord = path.join(home, "platform_dev.db"); }
  return {
    note: "`local` is stat'ed on this host at ping time (measured). `simulator` is documented and NOT measured from here — check it over ssh before you read an empty result from it as clean.",
    local: {
      host: "mac-mini-ubuntu (192.168.1.59) — platform",
      db: statPath(dbOfRecord),
      media_root: statPath(path.join(home, "platform/public/media")),
      repo_relative_db: repoRelativeDb(home, dbOfRecord),
    },
    simulator: {
      host: "magnus@192.168.1.58",
      db: "/mnt/anima-db/dev.db",
      media_root: "/home/magnus/deliver_worlds/priv/static/media",
    },
    media_url_shapes: {
      personal_actor_media: "/media/worlds/<world_id>/actors/<slug>/images/ — platform, nginx-authed (ANIMA-INVARIANT: never loosen)",
      ambient_portrait: "/media/cities/<city_id>/ambient_actors/<actors.id>/images/profile.jpg — simulator",
    },
  };
}

main().catch((e) => { console.error(String(e.stack || e)); process.exit(2); });
