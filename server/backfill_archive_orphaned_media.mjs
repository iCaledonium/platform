// One-off backfill — Session 151.
//
// Undeploy erased the simulator-side actor instance but never touched
// platform-side media, so actor_media rows survive every past undeploy with
// world_id/world_name still naming a world the actor has since left and
// archived_at still NULL. (The video half of the problem was partly covered:
// archiveWorldMedia() stamps the video rows it manages to copy down, which is
// why all 72 videos of the deleted world "Private - Los Angeles" are archived
// while that same world's photo row is not.)
//
// Orphan test: actor_media.world_id names a world for which the actor has no
// deployment with undeployed_at IS NULL. A missing actor_deployments row counts
// as orphaned too — DELETE /api/worlds/:id hard-deletes deployment rows, so a
// deleted world leaves no record of the deployment at all.
//
// archived_at is set to the undeploy that actually ended the deployment when
// actor_deployments still remembers it, and to the run timestamp otherwise,
// which is the most that can honestly be said once that row is gone.
//
// Dry run by default. Pass --apply to write.
//
//   node backfill_archive_orphaned_media.mjs           # report only
//   node backfill_archive_orphaned_media.mjs --apply   # write

import Database from "better-sqlite3";
import path from "path";
import os from "os";

const APPLY = process.argv.includes("--apply");
const DB_PATH = path.join(os.homedir(), "platform_dev.db");

// Same list as ARCHIVABLE_MEDIA_TYPES in index.js: media that belongs to a
// deployment, not to the character template.
const MEDIA_TYPES = ["photo", "video", "voice_reference", "audio"];

const db = new Database(DB_PATH);
const runAt = new Date().toISOString();
const slots = MEDIA_TYPES.map(() => "?").join(",");

const ORPHAN_PREDICATE = `
      m.world_id    IS NOT NULL
  AND m.archived_at IS NULL
  AND m.media_type IN (${slots})
  AND NOT EXISTS (
        SELECT 1 FROM actor_deployments ad
         WHERE ad.platform_actor_id = m.actor_id
           AND ad.world_id          = m.world_id
           AND ad.undeployed_at     IS NULL)`;

const orphans = db.prepare(
  `SELECT m.id, m.actor_id, m.media_type, m.filename, m.world_id,
          m.world_name    AS media_world_name,
          a.name          AS actor_name,
          d.id            AS deployment_id,
          d.undeployed_at AS undeployed_at,
          d.world_name    AS deployment_world_name
     FROM actor_media m
     JOIN actors a ON a.id = m.actor_id
     LEFT JOIN actor_deployments d
            ON d.platform_actor_id = m.actor_id
           AND d.world_id          = m.world_id
    WHERE ${ORPHAN_PREDICATE}
    ORDER BY m.world_id, a.name, m.media_type, m.filename`
).all(...MEDIA_TYPES);

console.log(`DB        ${DB_PATH}`);
console.log(`Mode      ${APPLY ? "APPLY" : "dry run (pass --apply to write)"}`);
console.log(`Run at    ${runAt}`);
console.log(`Orphaned  ${orphans.length} actor_media row(s)\n`);

if (orphans.length === 0) {
  console.log("Nothing to backfill.");
  process.exit(0);
}

const plan = orphans.map((o) => ({
  ...o,
  // The undeploy that ended it, where that is still on record.
  archivedAt: o.undeployed_at || runAt,
  archivedFrom: o.undeployed_at ? "undeployed_at" : "run timestamp",
  // Only fills a gap; never overwrites a name the row already carries.
  worldName: o.media_world_name || o.deployment_world_name || null,
}));

const byWorld = new Map();
for (const p of plan) {
  if (!byWorld.has(p.world_id)) byWorld.set(p.world_id, []);
  byWorld.get(p.world_id).push(p);
}

for (const [worldId, rows] of byWorld) {
  const name = rows.find((r) => r.worldName)?.worldName;
  const known = rows.some((r) => r.deployment_id);
  console.log(`world ${worldId}${name ? ` (${name})` : ""} — ${rows.length} row(s), deployment record ${known ? "present" : "gone"}`);
  for (const r of rows) {
    console.log(`  ${String(r.actor_name).padEnd(18)} ${r.media_type.padEnd(16)} ${r.filename.padEnd(24)} -> archived_at ${r.archivedAt} (${r.archivedFrom})`);
  }
  console.log();
}

if (!APPLY) {
  console.log("Dry run — no rows written.");
  process.exit(0);
}

const update = db.prepare(
  `UPDATE actor_media
      SET archived_at = ?,
          world_name  = COALESCE(world_name, ?),
          updated_at  = ?
    WHERE id = ?
      AND archived_at IS NULL`
);

let changed = 0;
db.transaction(() => {
  for (const p of plan) changed += update.run(p.archivedAt, p.worldName, runAt, p.id).changes;
})();

console.log(`Archived ${changed}/${plan.length} row(s).`);

const remaining = db.prepare(
  `SELECT COUNT(*) AS n FROM actor_media m WHERE ${ORPHAN_PREDICATE}`
).get(...MEDIA_TYPES).n;

console.log(`Orphans remaining: ${remaining}`);
