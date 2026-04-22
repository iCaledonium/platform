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

  CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    world_id     TEXT NOT NULL,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    key_prefix   TEXT NOT NULL,
    scopes       TEXT NOT NULL DEFAULT '[]',
    last_used_at TEXT,
    expires_at   TEXT,
    revoked_at   TEXT,
    inserted_at  TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS registered_tools (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    world_id    TEXT NOT NULL,
    actor_id    TEXT NOT NULL,
    api_key_id  TEXT NOT NULL REFERENCES api_keys(id),
    tool_type   TEXT NOT NULL,
    name        TEXT NOT NULL,
    url         TEXT,
    built_by    TEXT NOT NULL DEFAULT 'anima',
    contact_ids TEXT NOT NULL DEFAULT '[]',
    inserted_at TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id),
    world_id         TEXT NOT NULL,
    sender_actor_id  TEXT NOT NULL,
    sender_name      TEXT NOT NULL,
    content          TEXT NOT NULL,
    app_id           TEXT,
    read_at          TEXT,
    cleared_at       TEXT,
    inserted_at      TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications (user_id, cleared_at, inserted_at);

  -- ── Canonical actor tables ───────────────────────────────────────────────
  -- Actors are platform-level entities owned by a user (or org in future).
  -- No world_id here — these are the canonical profiles. Worlds contain clones.

  CREATE TABLE IF NOT EXISTS actors (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    name        TEXT NOT NULL,
    age         INTEGER,
    gender      TEXT,
    occupation  TEXT,
    appearance  TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    inserted_at TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actor_psychology (
    actor_id                  TEXT PRIMARY KEY REFERENCES actors(id),
    attachment_style          TEXT,
    wound                     TEXT,
    what_they_want            TEXT,
    blindspot                 TEXT,
    defenses                  TEXT,
    identity_certainty        REAL,
    self_view                 TEXT,
    others_view               TEXT,
    contradiction             TEXT,
    backstory                 TEXT,
    orientation               TEXT,
    view_on_sex               TEXT,
    marital_status            TEXT,
    coping_mechanisms         TEXT,
    family_model              TEXT,
    relationship_read_pattern TEXT,
    inserted_at               TEXT NOT NULL,
    updated_at                TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actor_big5 (
    actor_id          TEXT PRIMARY KEY REFERENCES actors(id),
    openness          INTEGER,
    conscientiousness INTEGER,
    extraversion      INTEGER,
    agreeableness     INTEGER,
    neuroticism       INTEGER,
    inserted_at       TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actor_disc (
    actor_id    TEXT PRIMARY KEY REFERENCES actors(id),
    d           INTEGER,
    i           INTEGER,
    s           INTEGER,
    c           INTEGER,
    inserted_at TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actor_hds (
    actor_id    TEXT PRIMARY KEY REFERENCES actors(id),
    bold        INTEGER,
    cautious    INTEGER,
    colorful    INTEGER,
    diligent    INTEGER,
    dutiful     INTEGER,
    excitable   INTEGER,
    imaginative INTEGER,
    leisurely   INTEGER,
    mischievous INTEGER,
    reserved    INTEGER,
    skeptical   INTEGER,
    inserted_at TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actor_lifestyle (
    actor_id             TEXT PRIMARY KEY REFERENCES actors(id),
    alcohol_relationship TEXT,
    drug_use             TEXT,
    substance_context    TEXT,
    sleep_pattern        TEXT,
    sleep_quality        TEXT,
    exercise_habit       TEXT,
    exercise_type        TEXT,
    social_frequency     TEXT,
    diet                 TEXT,
    lifestyle_note       TEXT,
    inserted_at          TEXT NOT NULL,
    updated_at           TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actor_economic (
    actor_id                TEXT PRIMARY KEY REFERENCES actors(id),
    attitude_to_wealth      TEXT,
    financial_anxiety       REAL,
    financial_situation     TEXT,
    income_stability        TEXT,
    savings_habit           TEXT,
    spending_style          TEXT,
    behavior_note           TEXT,
    monthly_income_sek      INTEGER,
    financial_runway_months REAL,
    inserted_at             TEXT NOT NULL,
    updated_at              TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actor_mental_health (
    actor_id                  TEXT PRIMARY KEY REFERENCES actors(id),
    depression_risk           REAL,
    anxiety_risk              REAL,
    substance_risk            REAL,
    isolation_risk            REAL,
    identity_fragility        REAL,
    crisis_threshold          REAL,
    obsessive_tendency        REAL,
    protective_factors        TEXT,
    risk_note                 TEXT,
    inserted_at               TEXT NOT NULL,
    updated_at                TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actor_upbringing (
    actor_id                 TEXT PRIMARY KEY REFERENCES actors(id),
    childhood_region         TEXT,
    socioeconomic_background TEXT,
    family_education_level   TEXT,
    first_generation_student INTEGER DEFAULT 0,
    upbringing_note          TEXT,
    inserted_at              TEXT NOT NULL,
    updated_at               TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actor_education (
    id             TEXT PRIMARY KEY,
    actor_id       TEXT NOT NULL REFERENCES actors(id),
    level          TEXT,
    field          TEXT,
    institution    TEXT,
    completed      INTEGER DEFAULT 1,
    self_taught_note TEXT,
    inserted_at    TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actor_diagnoses (
    id              TEXT PRIMARY KEY,
    actor_id        TEXT NOT NULL REFERENCES actors(id),
    diagnosis       TEXT NOT NULL,
    severity        TEXT,
    diagnosed       INTEGER DEFAULT 0,
    medicated       INTEGER DEFAULT 0,
    medication      TEXT,
    awareness       TEXT,
    behavioral_note TEXT,
    inserted_at     TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actor_expense_defaults (
    id                 TEXT PRIMARY KEY,
    actor_id           TEXT NOT NULL REFERENCES actors(id),
    name               TEXT NOT NULL,
    category           TEXT,
    monthly_budget_ore INTEGER,
    inserted_at        TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actor_shares (
    id              TEXT PRIMARY KEY,
    actor_id        TEXT NOT NULL REFERENCES actors(id),
    owner_id        TEXT NOT NULL REFERENCES users(id),
    shared_with_id  TEXT NOT NULL REFERENCES users(id),
    shared_with_type TEXT NOT NULL DEFAULT 'user',
    permission      TEXT NOT NULL DEFAULT 'read',
    inserted_at     TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE(actor_id, shared_with_id, shared_with_type)
  );

  CREATE INDEX IF NOT EXISTS actors_owner_id_idx ON actors (owner_id);
  CREATE INDEX IF NOT EXISTS actor_shares_shared_with_idx ON actor_shares (shared_with_id);
  CREATE INDEX IF NOT EXISTS actor_education_actor_id_idx ON actor_education (actor_id);
  CREATE INDEX IF NOT EXISTS actor_diagnoses_actor_id_idx ON actor_diagnoses (actor_id);
  CREATE INDEX IF NOT EXISTS actor_expense_defaults_actor_id_idx ON actor_expense_defaults (actor_id);

  CREATE TABLE IF NOT EXISTS actor_media (
    id          TEXT PRIMARY KEY,
    actor_id    TEXT NOT NULL REFERENCES actors(id),
    media_type  TEXT NOT NULL,
    filename    TEXT NOT NULL,
    url         TEXT NOT NULL,
    state_slug  TEXT,
    inserted_at TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS actor_media_actor_id_idx ON actor_media (actor_id);
`);

// ── Seed Anima employees if not present ─────────────────────────────────────

const employees = [
  { id: "mk", name: "Magnus Klack",     email: "magnus.klack@anima.se" },
  { id: "tn", name: "Tommy Norberg",    email: "tommy.norberg@anima.se" },
  { id: "jm", name: "Johan Molin",      email: "johan.molin@anima.se" },
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
  { user_id: "mk", world_id: STOCKHOLM_ID, actor_id: "magnus-klack-actor",   role: "owner" },
  { user_id: "tn", world_id: STOCKHOLM_ID, actor_id: "tommy-norberg-actor",  role: "viewer" },
  { user_id: "jm", world_id: STOCKHOLM_ID, actor_id: "johan-molin-actor",    role: "viewer" },
  { user_id: "dn", world_id: STOCKHOLM_ID, actor_id: "david-norberg-actor",  role: "viewer" },
];

const insertMembership = db.prepare(`
  INSERT OR IGNORE INTO world_memberships (id, user_id, world_id, actor_id, role, inserted_at, updated_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`);

for (const m of memberships) {
  insertMembership.run(randomUUID(), m.user_id, m.world_id, m.actor_id, m.role);
}

export default db;
