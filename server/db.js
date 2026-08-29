import Database from "better-sqlite3";
import path from "path";
import os from "os";

const DB_PATH = path.join(os.homedir(), "platform_dev.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  -- ── Tenancy ──────────────────────────────────────────────────────────────
  -- Every user belongs to exactly one org. A company is an org with many
  -- members; a private person is an org with exactly one. Making the solo case
  -- a real org rather than a NULL is what keeps the scoping uniform: every
  -- "who may this account see" query is org_id = ?, with no branch for the
  -- consumer tier and no NULL to forget.
  --
  -- created_by_org_id is how a personal account provisioned by staff stays
  -- administrable. Without it the account would vanish from its creator's own
  -- People page the instant it was made, and an expired invite could never be
  -- re-issued by anyone.
  CREATE TABLE IF NOT EXISTS orgs (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    kind              TEXT NOT NULL DEFAULT 'organization',
    status            TEXT NOT NULL DEFAULT 'active',
    created_by_org_id TEXT REFERENCES orgs(id),
    inserted_at       TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

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

  -- DEAD TABLE — an abandoned first attempt at invites. Nothing reads or writes
  -- it, it has never held a row, and it stores tokens in PLAINTEXT. The live
  -- invite flow is user_invites (hashed, single-use), created in index.js. Do
  -- not revive this; drop it once someone confirms nothing external expects it.
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
    monthly_income          INTEGER,
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

// ── Tenancy migration ───────────────────────────────────────────────────────
//
// There is no migration framework here — the live `actors` table has picked up
// a dozen columns by hand-run ALTERs that this file's CREATE never mentions. So
// this does what the rest of the schema does, only explicitly: add the column
// if it is missing, then backfill. Both halves are idempotent, because this runs
// on every single boot.

db.prepare(`INSERT OR IGNORE INTO orgs (id, name, kind, status, inserted_at, updated_at)
            VALUES ('anima', 'Anima Systems AB', 'organization', 'active',
                    datetime('now'), datetime('now'))`).run();

const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
if (!userCols.includes("org_id")) {
  db.prepare(`ALTER TABLE users ADD COLUMN org_id TEXT REFERENCES orgs(id)`).run();
}
db.prepare(`CREATE INDEX IF NOT EXISTS users_org_id_idx ON users (org_id)`).run();

// Everyone who predates orgs is Anima staff by definition — those four rows are
// the company. A user with no org would be invisible to every scoped query, so
// this must never be allowed to stay NULL.
db.prepare(`UPDATE users SET org_id = 'anima', updated_at = datetime('now')
            WHERE org_id IS NULL`).run();

// ── Org role ────────────────────────────────────────────────────────────────
//
// admin runs the organization (invite, remove, promote); member simply uses it.
// Before this, "staff of an organization" was the only gate on account
// management, which made all four Anima employees implicit administrators.
//
// The seeding of the first admin happens ONLY inside the ALTER branch, and that
// placement is the entire point. This file runs on every boot, so an
// unconditional `UPDATE ... WHERE id = 'mk'` would silently re-promote Magnus
// every restart and make a later demotion impossible to keep — precisely the
// bug the removed world_membership seed below caused, where deleted rows came
// back within two seconds of a restart. Bootstrap once, then never again.
if (!db.prepare(`PRAGMA table_info(users)`).all().some(c => c.name === "org_role")) {
  db.prepare(`ALTER TABLE users ADD COLUMN org_role TEXT`).run();
  db.prepare(`UPDATE users SET org_role = 'admin' WHERE id = 'mk'`).run();
}
db.prepare(`UPDATE users SET org_role = 'member' WHERE org_role IS NULL`).run();

// ── Seed Anima employees if not present ─────────────────────────────────────

const employees = [
  { id: "mk", name: "Magnus Klack",     email: "magnus.klack@anima.se" },
  { id: "tn", name: "Tommy Norberg",    email: "tommy.norberg@anima.se" },
  { id: "jm", name: "Johan Molin",      email: "johan.molin@anima.se" },
  { id: "dn", name: "David Norberg",    email: "david.norberg@anima.se" },
];

const insert = db.prepare(`
  INSERT OR IGNORE INTO users (id, name, email, status, user_type, org_id, org_role, inserted_at, updated_at)
  VALUES (?, ?, ?, 'active', 'staff', 'anima', 'member', datetime('now'), datetime('now'))
`);

for (const e of employees) {
  insert.run(e.id, e.name, e.email);
}

// Session 150 — this used to unconditionally seed 4 world_memberships for
// world e7368020 on every single server start: it ran on every boot, not
// once, relying on the table's UNIQUE(user_id, world_id, actor_id) to make
// repeat runs a no-op. That world was deliberately deleted at some point
// after this was written. The seed did not know that and kept winning: the
// membership rows this same session's owner/player rename and delete_world
// leak fix both had to clean up came back within one restart, because
// nothing here ever stopped recreating them — with the pre-rename "viewer"
// role baked into the array, on top of it. Found live: deleted the 4 rows
// by hand, restarted the service to test an unrelated fix, and they were
// back with fresh ids and the old role name inside of two seconds.
//
// This was one-time bootstrap convenience for a fresh empty database, not
// something meant to run forever against a real one. Removed rather than
// updated to say "player" — reseeding a deleted world's membership is wrong
// regardless of which word it uses for the role.

export default db;
