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
// Exit codes: 0 = ran (see the JSON it prints), 1 = nothing filed / bad input,
// 2 = the store or the sweep itself failed.

import { readFileSync } from "node:fs";
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
    }

    case "report": {
      const raw = readStdin().trim();
      if (!raw) { console.error("nothing on stdin"); process.exit(1); }
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { console.error("stdin is not JSON: " + e.message); process.exit(1); }
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const source = flag("source", "routine:cli");
      const results = [];
      for (const it of items) {
        if (!it || !it.check_name) { results.push({ error: "each finding needs a check_name", item: it }); continue; }
        results.push(store.report({ ...it, source: it.source || source }));
      }
      console.log(JSON.stringify({ filed: results.length, results }, null, 2));
      process.exitCode = results.some((r) => r.error) ? 1 : 0;
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
      console.log(JSON.stringify({ ok: true, ...r }, null, 2));
      process.exitCode = 0;
      return;
    }

    case "list": {
      const rows = store.listIncidents({
        status: flag("status", "unresolved"), bench: flag("bench", "all"),
        limit: Number(flag("limit", "200")),
      });
      // process.exitCode, not process.exit(): a piped (non-TTY) stdout is
      // non-blocking on Linux, and process.exit() does not wait for a large
      // write to finish draining through the OS's 64KB pipe buffer before
      // terminating. Found live 2026-09-04 by the resolution manager's own
      // `list` call: truncated mid-string at byte 65536 with 30 real
      // incidents on the board — small payloads during development never
      // crossed the boundary. exitCode lets node exit only once the write
      // has actually flushed.
      console.log(JSON.stringify({ count: rows.length, counts: store.counts(), incidents: rows }, null, 2));
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

main().catch((e) => { console.error(String(e.stack || e)); process.exit(2); });
