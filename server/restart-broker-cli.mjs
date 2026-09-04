#!/usr/bin/env node
//
// The restart-broker daemon (~/bin/anima-restart-daemon, launchd-managed,
// runs OUTSIDE any Claude session) lives on the local Mac and pushes its
// status here over ssh - same trust boundary as resolution-manager-cli.mjs
// and lab-incidents-cli.mjs, and the same reason: nginx serves the LAN
// address and the public ngrok domain from the same server block, so there
// is no honest way to make a status-ingest route on :80 LAN-only. ssh is the
// boundary and adds no new surface.
//
//   ssh mac-mini-ubuntu 'node ~/platform/server/restart-broker-cli.mjs status' < patch.json
//   ssh mac-mini-ubuntu 'node ~/platform/server/restart-broker-cli.mjs get'
//
// `patch.json` is a partial object merged onto the current row - only send
// the fields that changed. `lease`, `queue`, and `recent`, when sent, are
// always the daemon's full current snapshot (see restart-broker-store.js):
//   {"lease":{"service":"deliver-worlds","reason":"...","session_id":"...","need_seconds":120,"granted_at":"...","expires_at_epoch":123},"queue":[...],"daemon_heartbeat_epoch":123}
//   {"lease":null,"queue":[],"daemon_heartbeat_epoch":123}

import { readFileSync } from "node:fs";
import * as store from "./restart-broker-store.js";

const cmd = process.argv[2];

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

if (cmd === "status") {
  const raw = readStdin().trim();
  if (!raw) { console.error("nothing on stdin"); process.exit(1); }
  let patch;
  try { patch = JSON.parse(raw); }
  catch (e) { console.error("stdin is not JSON: " + e.message); process.exit(1); }
  const next = store.setStatus(patch);
  console.log(JSON.stringify(next, null, 2));
  process.exit(0);
} else if (cmd === "get") {
  console.log(JSON.stringify(store.getStatus(), null, 2));
  process.exit(0);
} else {
  console.error("usage: restart-broker-cli.mjs <status|get>");
  process.exit(1);
}
