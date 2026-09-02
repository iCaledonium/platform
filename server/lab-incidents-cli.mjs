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
          process.exit(2);
        }
        console.log(JSON.stringify(body, null, 2));
        // A run that measured NOTHING is not a pass. Exit non-zero so a cron
        // job cannot read silence as success.
        const rs = body.results || (body.result ? [body.result] : []);
        const measured = rs.reduce((a, x) => a + (x.total || 0), 0);
        const failed = rs.reduce((a, x) => a + (x.failed || 0), 0);
        if (rs.length && measured === 0) {
          console.error("nothing was measured — every suite was empty or had no target");
          process.exit(2);
        }
        process.exit(failed > 0 ? 1 : 0);
      } catch (e) {
        // A dead platform-api must be loud. Reporting nothing here would look
        // exactly like a clean sweep to whatever reads this output.
        console.error(`platform-api unreachable on 127.0.0.1:${PORT} — nothing was measured: ${e.message}`);
        process.exit(2);
      } finally {
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
      process.exit(results.some((r) => r.error) ? 1 : 0);
    }

    case "list": {
      const rows = store.listIncidents({
        status: flag("status", "unresolved"), bench: flag("bench", "all"),
        limit: Number(flag("limit", "200")),
      });
      console.log(JSON.stringify({ count: rows.length, counts: store.counts(), incidents: rows }, null, 2));
      process.exit(0);
    }

    case "runs":
      console.log(JSON.stringify(store.listRuns(Number(flag("limit", "10"))), null, 2));
      process.exit(0);

    default:
      console.error(`usage: lab-incidents-cli.mjs <sweep|report|list|runs> [--source X] [--status X] [--bench X] [--limit N]`);
      process.exit(1);
  }
}

main().catch((e) => { console.error(String(e.stack || e)); process.exit(2); });
