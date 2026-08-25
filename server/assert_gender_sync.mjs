#!/usr/bin/env node
// Asserts that every player actor in the simulator carries the gender the
// platform holds for that user.
//
// The two sides keep separate copies — the platform owns the fact, the
// simulator owns the actor — so they can drift without anything failing. A
// PATCH returning 200 proves the request arrived, not that the two now agree,
// which is why this reads the value back rather than trusting the write.
//
// Exit code 0 = in sync, 1 = drift found. Safe to run repeatedly.
import Database from "better-sqlite3";
import os from "os";
import path from "path";

const DB_PATH = path.join(os.homedir(), "platform_dev.db");
const SIMULATOR_URL = "http://192.168.1.58:4000";
const SERVICE_TOKEN = process.env.PLATFORM_SERVICE_TOKEN || "";

if (!SERVICE_TOKEN) {
  console.error("PLATFORM_SERVICE_TOKEN is not set");
  process.exit(2);
}

const db = new Database(DB_PATH, { readonly: true });

const rows = db.prepare(`
  SELECT u.id AS user_id, u.name, u.gender AS platform_gender,
         m.world_id, m.actor_id
  FROM world_memberships m
  JOIN users u ON u.id = m.user_id
  ORDER BY u.name, m.world_id
`).all();

if (rows.length === 0) {
  console.log("no memberships to check");
  process.exit(0);
}

let drift = 0;
let missing = 0;
let orphaned = 0;

for (const r of rows) {
  const url = `${SIMULATOR_URL}/internal/worlds/${r.world_id}/members/${r.user_id}` +
              `?actor_id=${encodeURIComponent(r.actor_id)}`;

  let sim = null;
  let note = "";
  let orphan = false;

  try {
    const res = await fetch(url, { headers: { "X-Service-Token": SERVICE_TOKEN } });
    if (res.ok) {
      sim = (await res.json()).gender ?? null;
    } else if (res.status === 404) {
      // The platform keeps a membership for a world the simulator no longer
      // has. Real, and worth seeing, but it is not gender drift — counting it
      // as such would leave this check failing forever for an unrelated reason.
      orphan = true;
      note = "no player actor — world deleted?";
    } else {
      note = `simulator HTTP ${res.status}`;
    }
  } catch (e) {
    note = `unreachable: ${e.message}`;
  }

  const platform = r.platform_gender ?? null;
  const agree = note === "" && platform === sim;

  if (orphan) orphaned++;
  else if (platform === null && sim === null) missing++;

  if (!agree && !orphan) drift++;

  const status = orphan
    ? "orphaned"
    : note
      ? "ERROR"
      : agree
        ? (platform === null ? "both unset" : "in sync")
        : "DRIFT";

  console.log(
    `${status.padEnd(10)} ${r.name.padEnd(16)} ${r.world_id.slice(0, 8)}  ` +
    `platform=${String(platform).padEnd(11)} simulator=${String(sim).padEnd(11)} ${note}`
  );
}

console.log("");
console.log(`${rows.length} membership(s) checked`);
console.log(`  ${orphaned} orphaned — platform membership, no actor in the simulator`);
console.log(`  ${missing} live, with no gender recorded on either side`);
console.log(`  ${drift} out of sync`);

process.exit(drift === 0 ? 0 : 1);
