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
import * as store from "./lab-incidents.js";

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
      const SIMULATOR_URL = process.env.SIMULATOR_URL || "http://192.168.1.58:4000";
      const SERVICE_TOKEN = process.env.PLATFORM_SERVICE_TOKEN || readTokenFromUnit();
      if (!SERVICE_TOKEN) {
        console.error("no PLATFORM_SERVICE_TOKEN — the simulator boards cannot be read without it");
        process.exit(2);
      }
      // The signup board lives inside the running platform-api process, not in
      // this one. A CLI sweep therefore covers the three simulator benches and
      // says so, rather than quietly reporting a bench it never read.
      const out = await store.runSweep({
        source: flag("source", "routine:cli"), SIMULATOR_URL, SERVICE_TOKEN,
      });
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
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

// index.js reads the token from PLATFORM_SERVICE_TOKEN, which the systemd unit
// supplies as an `Environment=` line rather than from an env file. A CLI run by
// hand or from cron has neither, so fall back to the unit itself.
function readTokenFromUnit() {
  for (const p of ["/etc/systemd/system/platform-api.service",
                   "/lib/systemd/system/platform-api.service",
                   `${process.env.HOME}/platform/.env`]) {
    try {
      const m = readFileSync(p, "utf8").match(/PLATFORM_SERVICE_TOKEN=([^\s"']+)/);
      if (m) return m[1].trim();
    } catch { /* not there */ }
  }
  return null;
}

main().catch((e) => { console.error(String(e.stack || e)); process.exit(2); });
