#!/usr/bin/env node
// Backfills users.gender on the platform and pushes each value to the player
// actors the simulator already holds.
//
// There is no registration yet, so nothing has ever collected this field. The
// same work the PUT /api/users/:id/gender route does, without needing a session
// — run once, then verify with assert_gender_sync.mjs.
//
// Values are supplied on the command line, never inferred from a name:
//   node backfill_gender.mjs mk=male tn=male
import Database from "better-sqlite3";
import os from "os";
import path from "path";

const SIMULATOR_URL = "http://192.168.1.58:4000";
const SERVICE_TOKEN = process.env.PLATFORM_SERVICE_TOKEN || "";
const ALLOWED = ["male", "female", "non-binary"];
const DRY = !process.argv.includes("--commit");

if (!SERVICE_TOKEN) {
  console.error("PLATFORM_SERVICE_TOKEN is not set");
  process.exit(2);
}

const assignments = process.argv
  .slice(2)
  .filter(a => a.includes("="))
  .map(a => {
    const [id, gender] = a.split("=");
    return { id, gender };
  });

if (assignments.length === 0) {
  console.error("usage: node backfill_gender.mjs <user_id>=<gender> [...] [--commit]");
  process.exit(2);
}

for (const a of assignments) {
  if (!ALLOWED.includes(a.gender)) {
    console.error(`refusing ${a.id}: "${a.gender}" is not one of ${ALLOWED.join(", ")}`);
    process.exit(2);
  }
}

const db = new Database(path.join(os.homedir(), "platform_dev.db"));

for (const { id, gender } of assignments) {
  const user = db.prepare(`SELECT id, name FROM users WHERE id = ?`).get(id);
  if (!user) {
    console.log(`SKIP   ${id} — no such user`);
    continue;
  }

  if (!DRY) {
    db.prepare(`UPDATE users SET gender = ?, updated_at = ? WHERE id = ?`)
      .run(gender, new Date().toISOString(), id);
  }
  console.log(`${DRY ? "would set" : "platform"} ${user.name.padEnd(16)} -> ${gender}`);

  const memberships = db.prepare(
    `SELECT world_id, actor_id FROM world_memberships WHERE user_id = ?`
  ).all(id);

  for (const m of memberships) {
    if (DRY) {
      console.log(`           would push to ${m.actor_id} in ${m.world_id.slice(0, 8)}`);
      continue;
    }
    try {
      const r = await fetch(
        `${SIMULATOR_URL}/internal/worlds/${m.world_id}/members/${id}`,
        {
          method: "PATCH",
          headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ actor_id: m.actor_id, gender }),
        }
      );
      const note = r.status === 404 ? "no actor (world gone?)" : `HTTP ${r.status}`;
      console.log(`           ${r.ok ? "synced " : "skipped"} ${m.actor_id.padEnd(14)} ${note}`);
    } catch (e) {
      console.log(`           FAILED  ${m.actor_id} ${e.message}`);
    }
  }
}

console.log(DRY ? "\ndry run — nothing written. add --commit" : "\ndone");
