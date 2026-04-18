import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import path from "path";
import os from "os";

const DB_PATH = path.join(os.homedir(), "platform_dev.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'active',
    user_type   TEXT NOT NULL DEFAULT 'staff',
    inserted_at TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_totp_secrets (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL UNIQUE REFERENCES users(id),
    secret      TEXT NOT NULL,
    enrolled_at TEXT,
    inserted_at TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT,
    inserted_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS enrollment_invites (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    token       TEXT NOT NULL UNIQUE,
    expires_at  TEXT NOT NULL,
    used_at     TEXT,
    inserted_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS world_memberships (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    world_id   TEXT NOT NULL,
    actor_id   TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'viewer',
    inserted_at TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(user_id, world_id, actor_id)
  );
`);

// ── Seed Anima employees if not present ─────────────────────────────────────

const employees = [
  { id: "mk", name: "Magnus Klack",     email: "magnus.klack@anima.se" },
  { id: "tn", name: "Tommy Norberg",    email: "tommy.norberg@anima.se" },
  { id: "jm", name: "Johan Molin",      email: "johan.molin@anima.se" },
  { id: "as", name: "Amber Söderström", email: "amber.soderstrom@anima.se" },
  { id: "cb", name: "Clark Bennet",     email: "clark.bennet@anima.se" },
  { id: "dn", name: "David Norberg",    email: "david.norberg@anima.se" },
];

const insert = db.prepare(`
  INSERT OR IGNORE INTO users (id, name, email, status, user_type, inserted_at, updated_at)
  VALUES (?, ?, ?, 'active', 'staff', datetime('now'), datetime('now'))
`);

for (const e of employees) {
  insert.run(e.id, e.name, e.email);
}

// ── Seed world memberships ───────────────────────────────────────────────────
// Magnus is owner/player. Tommy, Johan, David are viewers.

const STOCKHOLM_ID = "e7368020-fc19-4914-95ac-2f7c5508a13c";

const memberships = [
  { user_id: "mk", world_id: STOCKHOLM_ID, actor_id: "magnus-klack-actor", role: "owner" },
  { user_id: "tn", world_id: STOCKHOLM_ID, actor_id: "magnus-klack-actor", role: "viewer" },
  { user_id: "jm", world_id: STOCKHOLM_ID, actor_id: "magnus-klack-actor", role: "viewer" },
  { user_id: "dn", world_id: STOCKHOLM_ID, actor_id: "magnus-klack-actor", role: "viewer" },
];

const insertMembership = db.prepare(`
  INSERT OR IGNORE INTO world_memberships (id, user_id, world_id, actor_id, role, inserted_at, updated_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`);

for (const m of memberships) {
  insertMembership.run(randomUUID(), m.user_id, m.world_id, m.actor_id, m.role);
}

export default db;
