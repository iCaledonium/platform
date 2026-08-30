// Seed / drop a throwaway account for eyeballing /profile in a browser.
//   node server/profile_preview.mjs seed   → prints the cookie value
//   node server/profile_preview.mjs drop   → removes every row it made
// Nothing real is touched.
import Database from "better-sqlite3";
import crypto from "crypto";
import os from "os";
import path from "path";

const db = new Database(path.join(os.homedir(), "platform_dev.db"));
const now = () => new Date().toISOString();
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

const ORG = "tprev-org", USER = "tprev-u";
const cmd = process.argv[2];

if (cmd === "seed") {
  db.prepare(`INSERT OR REPLACE INTO orgs (id, name, kind, status, inserted_at, updated_at)
              VALUES (?,?,'organization','active',?,?)`).run(ORG, "Preview Org", now(), now());
  db.prepare(`INSERT OR REPLACE INTO users (id, name, email, status, user_type, gender, org_id, org_role, inserted_at, updated_at)
              VALUES (?,?,?,'active','staff','female',?,'member',?,?)`)
    .run(USER, "Preview Person", "preview@example.test", ORG, now(), now());
  db.prepare(`INSERT OR REPLACE INTO memberships (user_id, org_id, role, inserted_at, updated_at)
              VALUES (?,?,'member',?,?)`).run(USER, ORG, now(), now());
  const raw = crypto.randomBytes(24).toString("hex");
  db.prepare(`INSERT OR REPLACE INTO auth_tokens (id, user_id, token_hash, expires_at, inserted_at)
              VALUES (?,?,?,datetime('now','+2 hours'),?)`).run("tprev-tok", USER, sha(raw), now());
  console.log(raw);
} else if (cmd === "drop") {
  db.prepare(`DELETE FROM auth_tokens WHERE user_id = ?`).run(USER);
  db.prepare(`DELETE FROM memberships WHERE user_id = ?`).run(USER);
  db.prepare(`DELETE FROM users       WHERE id = ?`).run(USER);
  db.prepare(`DELETE FROM orgs        WHERE id = ?`).run(ORG);
  const left = db.prepare(`SELECT COUNT(*) n FROM users WHERE id = ?`).get(USER).n;
  console.log(left === 0 ? "dropped clean" : "STILL PRESENT");
} else {
  console.log("usage: profile_preview.mjs seed|drop");
}
