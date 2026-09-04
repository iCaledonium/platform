#!/usr/bin/env node
//
// The always-alive resolution manager runs on the local Mac (it needs a live
// Claude Agent SDK session, which this platform host cannot host itself) and
// pushes its status here over ssh — same trust boundary as
// lab-incidents-cli.mjs and the same reason: nginx serves the LAN address
// and the public ngrok domain from the same server block, so there is no
// honest way to make a status-ingest route on :80 LAN-only. ssh is the
// boundary and adds no new surface.
//
//   ssh mac-mini-ubuntu 'node ~/platform/server/resolution-manager-cli.mjs status' < patch.json
//   ssh mac-mini-ubuntu 'node ~/platform/server/resolution-manager-cli.mjs get'
//
// `patch.json` is a partial object merged onto the current row - only send
// the fields that changed:
//   {"state":"active","bench":"transport","check_name":"...","note":null,"started_at":"..."}
//   {"state":"idle","bench":null,"check_name":null,"note":null,"last_run_at":"..."}

import { readFileSync } from "node:fs";
import * as store from "./resolution-manager-store.js";

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
  console.error("usage: resolution-manager-cli.mjs <status|get>");
  process.exit(1);
}
