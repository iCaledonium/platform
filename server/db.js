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

// -- Actor deletion audit (conduct-watch signal 7, 2026-09-05) ---------------
//
// Deleting an actor used to leave nothing behind at all: no tombstone, no
// soft-delete column, no audit row. The actors row went, its actor_media rows
// went, and its media folder went, so afterwards nothing anywhere said which
// character had existed, who owned it, or which account issued the delete. A
// benign delete and a create-upload-delete burst by somebody else were
// literally indistinguishable in the data.
//
// Append-only by convention and by construction: nothing in this codebase
// UPDATEs or DELETEs from this table, and the row is written inside the same
// transaction as the delete, so a committed delete always has its record.
//
// acting_user_id / owner_id are plain TEXT and deliberately NOT foreign keys:
// the record has to outlive the actor AND the accounts involved. A foreign key
// would make removing an account either fail or cascade the evidence away.
db.exec(`
  CREATE TABLE IF NOT EXISTS actor_deletions (
    id             TEXT PRIMARY KEY,
    actor_id       TEXT NOT NULL,
    actor_name     TEXT,
    owner_id       TEXT,
    acting_user_id TEXT,
    acting_email   TEXT,
    via            TEXT NOT NULL,
    actor_status   TEXT,
    media_folder   TEXT,
    media_count    INTEGER,
    deleted_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS actor_deletions_actor_id_idx ON actor_deletions (actor_id);
  CREATE INDEX IF NOT EXISTS actor_deletions_deleted_at_idx ON actor_deletions (deleted_at);
`);

// ── The audit is enforced by the DATABASE, not by convention (2026-09-09) ────
//
// conduct-watch filed this: two actor rows declaring age 10 existed on this
// host between two hourly runs and left the table leaving NO actor_deletions
// row at all. Every delete path in this repo already wrote one — the rows went
// out through something that opened the SQLite file directly (a lab probe, the
// sqlite3 CLI, a maintenance script), which no amount of care in the route
// handlers can cover, and no future route that forgets the call is covered
// either. So the invariant moves out of the application and into the schema.
//
// The trigger writes a fallback attribution row whenever no audited path
// claimed the delete in the preceding two minutes. Audited paths now record
// BEFORE the DELETE (see the recordActorDeletion callers in server/index.js
// and server/wizardlab-routes.js) precisely so the trigger can see their row
// and stay quiet; the 120s window rather than "ever" is so an id that is
// created and deleted again later still gets its own tombstone.
//
// actor_age exists because this table serves the child-safety sweep: "an actor
// row was removed" does not answer "did a declared minor exist between runs",
// and the age dies with the row unless the tombstone carries it.
try { db.exec(`ALTER TABLE actor_deletions ADD COLUMN actor_age INTEGER`); } catch { /* column already present */ }

// The likeness columns (2026-09-10, conduct-watch). actor_age was not enough:
// the tombstone recorded HOW MANY media files went away but nothing about what
// they DECLARED, and the actor_media rows die with the actor. conduct-watch
// signal 4 is a predicate over exactly actor_media.depicts and
// actor_media.subject_authorised, so once a draft was abandoned the watcher
// could never afterwards say whether it had carried a third party's likeness --
// the only surviving evidence for one such actor was the frozen prose of an
// incident row. The retention window was the gap between upload and abandon,
// once as short as seven seconds.
//
//   media_depicts            -- 'other=1,self=2' (sorted, 'unset' for NULL/'')
//   media_subject_authorised -- same shape over subject_authorised ('yes'/'no')
//   media_manifest           -- JSON array, one object per actor_media row:
//                               id, media_type, filename, depicts,
//                               subject_authorised. This is what makes a
//                               specific photograph nameable after the fact.
//
// 'none' (and '[]') means the actor provably had NO media -- deliberately
// distinct from NULL, which means "this tombstone predates these columns, the
// answer is unknown". A watcher must be able to tell "nothing was uploaded"
// from "we no longer know", which is the whole complaint.
try { db.exec(`ALTER TABLE actor_deletions ADD COLUMN media_depicts TEXT`); } catch { /* column already present */ }
try { db.exec(`ALTER TABLE actor_deletions ADD COLUMN media_subject_authorised TEXT`); } catch { /* column already present */ }
try { db.exec(`ALTER TABLE actor_deletions ADD COLUMN media_manifest TEXT`); } catch { /* column already present */ }

// DROP-then-CREATE rather than CREATE TRIGGER IF NOT EXISTS: the trigger body
// gets edited from time to time (the likeness columns are the 2026-09-10 edit),
// and IF NOT EXISTS would silently keep serving the OLD body forever on any
// database that already has it. Both statements run on every boot.
db.exec(`DROP TRIGGER IF EXISTS actors_delete_audit_fallback`);
db.exec(`
  CREATE TRIGGER actors_delete_audit_fallback
  AFTER DELETE ON actors
  FOR EACH ROW
  WHEN NOT EXISTS (
    SELECT 1 FROM actor_deletions
     WHERE actor_id = OLD.id
       AND deleted_at >= strftime('%Y-%m-%dT%H:%M:%S', 'now', '-120 seconds')
  )
  BEGIN
    INSERT INTO actor_deletions
      (id, actor_id, actor_name, owner_id, acting_user_id, acting_email, via,
       actor_status, media_folder, media_count, actor_age,
       media_depicts, media_subject_authorised, media_manifest, deleted_at)
    VALUES (
      lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),
      OLD.id, OLD.name, OLD.owner_id, NULL, NULL,
      'UNATTRIBUTED - actors row removed outside any audited delete path (db trigger fallback)',
      OLD.status, OLD.media_folder,
      (SELECT COUNT(*) FROM actor_media WHERE actor_id = OLD.id),
      OLD.age,
      -- AFTER DELETE ON actors, so actor_media is still readable here whenever
      -- the caller has not already swept it. Same shape the audited paths write
      -- (summariseActorMedia in server/actor-media-audit.js): sorted 'value=count' pairs,
      -- 'unset' for NULL/'', and the literal 'none' / '[]' for no media at all.
      (SELECT CASE WHEN COUNT(*) = 0 THEN 'none' ELSE group_concat(kv, ',') END FROM
         (SELECT COALESCE(NULLIF(depicts, ''), 'unset')||'='||COUNT(*) AS kv
            FROM actor_media WHERE actor_id = OLD.id
           GROUP BY COALESCE(NULLIF(depicts, ''), 'unset') ORDER BY 1)),
      (SELECT CASE WHEN COUNT(*) = 0 THEN 'none' ELSE group_concat(kv, ',') END FROM
         (SELECT COALESCE(NULLIF(subject_authorised, ''), 'unset')||'='||COUNT(*) AS kv
            FROM actor_media WHERE actor_id = OLD.id
           GROUP BY COALESCE(NULLIF(subject_authorised, ''), 'unset') ORDER BY 1)),
      (SELECT json_group_array(json_object(
                'id', id, 'media_type', media_type, 'filename', filename,
                'depicts', depicts, 'subject_authorised', subject_authorised))
         FROM actor_media WHERE actor_id = OLD.id),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );
  END;
`);

// ── The tombstones are APPEND-ONLY, enforced by the database (2026-09-10) ───
//
// conduct-watch filed the next layer down from the likeness columns above: the
// columns now exist, but the ROWS still did not have to. On 2026-09-10 three
// actors were destroyed through the audited abandon-draft path (journal
// 15:35:29 / 15:37:09 / 15:37:19, two of them declaring depicts=other with
// subject_authorised=no -- exactly the shape signal 4 exists to catch), their
// tombstones were written by recordActorDeletion as designed, and were then
// removed again by a fixture teardown that swept users, auth_tokens and
// actor_deletions together with a direct sqlite3 DELETE. Afterwards the table
// read exactly like a quiet hour. An hourly sweep could not distinguish "no
// deletions happened" from "deletions happened and their evidence was taken
// away", and the only surviving trace was the systemd journal, which rotates
// and which nothing else in the evidence chain treats as authoritative.
//
// "Append-only by convention" -- the phrase in the comment above this table
// since 2026-09-05 -- is not a property of the data, it is a property of this
// repo's habits, and the delete came from outside the repo. So, exactly like
// the missing-tombstone fix before it, the invariant moves into the schema:
//
//   1. actor_deletions_no_delete / actor_deletions_no_update -- any DELETE or
//      UPDATE against a tombstone ABORTs, whichever connection issues it: the
//      app, the sqlite3 CLI, a lab fixture teardown, a maintenance script.
//      Nothing in this codebase has ever deleted or updated one (grepped), so
//      no legitimate path is blocked; a teardown that used to sweep the table
//      now fails loudly instead of silently erasing evidence. Fixture noise is
//      not a reason to remove audit rows -- a fixture deletion of a declared
//      third-party likeness is precisely the event this table exists to hold.
//
//   2. audit_ledger -- a monotonic counter that is NOT derived from the rows,
//      so it survives their removal. Every INSERT into actor_deletions bumps
//      rows_issued by one; rows_issued may never decrease and its row may
//      never be deleted. A sweep can therefore detect tampering arithmetically
//      even if someone drops the triggers above and empties the table:
//
//        SELECT rows_issued FROM audit_ledger WHERE table_name='actor_deletions';
//        SELECT COUNT(*)    FROM actor_deletions;
//
//      rows_issued > COUNT(*) means tombstones were removed and the difference
//      is how many. Equal means the table is whole. That comparison is the
//      "monotonic counter this sweep can check for gaps" the incident asked
//      for, and it needs no cooperation from the deleting party.
//
// The seed is the one place the two could legitimately disagree, and does not:
// on a database that predates the ledger it starts from the rows that SURVIVE.
// The three tombstones already destroyed today are unrecoverable, and seeding
// a higher number would fabricate a permanent unexplainable gap. The ledger's
// guarantee is forward-looking; it cannot testify about the hour before it
// existed, and it should not pretend to.
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_ledger (
    table_name     TEXT PRIMARY KEY,
    rows_issued    INTEGER NOT NULL,
    last_issued_at TEXT
  );
`);
db.prepare(`INSERT OR IGNORE INTO audit_ledger (table_name, rows_issued, last_issued_at)
            VALUES ('actor_deletions',
                    (SELECT COUNT(*)        FROM actor_deletions),
                    (SELECT MAX(deleted_at) FROM actor_deletions))`).run();

// DROP-then-CREATE for the same reason as the fallback trigger above: these
// bodies get edited, and IF NOT EXISTS would keep serving a stale one forever.
db.exec(`DROP TRIGGER IF EXISTS actor_deletions_no_delete`);
db.exec(`DROP TRIGGER IF EXISTS actor_deletions_no_update`);
db.exec(`DROP TRIGGER IF EXISTS actor_deletions_ledger_bump`);
db.exec(`DROP TRIGGER IF EXISTS audit_ledger_no_delete`);
db.exec(`DROP TRIGGER IF EXISTS audit_ledger_monotonic`);
db.exec(`
  CREATE TRIGGER actor_deletions_no_delete
  BEFORE DELETE ON actor_deletions
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'actor_deletions is append-only: a deletion tombstone may not be removed (conduct-watch, 2026-09-10)');
  END;
`);
db.exec(`
  CREATE TRIGGER actor_deletions_no_update
  BEFORE UPDATE ON actor_deletions
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'actor_deletions is append-only: a deletion tombstone may not be rewritten (conduct-watch, 2026-09-10)');
  END;
`);
db.exec(`
  CREATE TRIGGER actor_deletions_ledger_bump
  AFTER INSERT ON actor_deletions
  FOR EACH ROW
  BEGIN
    INSERT INTO audit_ledger (table_name, rows_issued, last_issued_at)
    VALUES ('actor_deletions', 1, NEW.deleted_at)
    ON CONFLICT(table_name) DO UPDATE
      SET rows_issued    = rows_issued + 1,
          last_issued_at = excluded.last_issued_at;
  END;
`);
db.exec(`
  CREATE TRIGGER audit_ledger_no_delete
  BEFORE DELETE ON audit_ledger
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'audit_ledger is append-only: the issued-row counter may not be deleted (conduct-watch, 2026-09-10)');
  END;
`);
db.exec(`
  CREATE TRIGGER audit_ledger_monotonic
  BEFORE UPDATE ON audit_ledger
  FOR EACH ROW
  WHEN NEW.rows_issued < OLD.rows_issued
  BEGIN
    SELECT RAISE(ABORT, 'audit_ledger.rows_issued is monotonic: it may never be lowered (conduct-watch, 2026-09-10)');
  END;
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

// ── 3D profile ──────────────────────────────────────────────────────────────
//
// A user's own body in-world. It is an `actors` row they own rather than a set
// of columns here, so the whole existing pipeline applies to it unchanged:
// the wizard, generate3d's morph/export, the runtime bake, the deploy transfer.
// Only the pointer lives on the user.
//
// Nullable on purpose — it is null for exactly as long as somebody has not
// built one yet, which is the state the onboarding wizard exists to end.
if (!db.prepare(`PRAGMA table_info(users)`).all().some(c => c.name === "avatar_actor_id")) {
  db.prepare(`ALTER TABLE users ADD COLUMN avatar_actor_id TEXT REFERENCES actors(id)`).run();
}

// -- who a reference photograph depicts --------------------------------------
//
// Every actor_media row already said which actor a photograph belongs to, and
// actors.owner_id said who uploaded it, but nothing anywhere said whose
// likeness the photograph actually carries. That made one specific question
// unanswerable from the data: is this uploader building a body out of
// photographs of somebody who is not them. It is the reference photos and the
// body_front/side/back set that make it matter -- those are what the 3D
// pipeline turns into a face and a shape.
//
// Nullable and never inferred. NULL means "the uploader was not asked, or did
// not say", which is deliberately a different state from a declaration; the
// API refuses to invent one, because a guessed 'self' would read later as
// evidence somebody gave that answer. Written values: 'self' or 'other'.
if (!db.prepare(`PRAGMA table_info(actor_media)`).all().some(c => c.name === "depicts")) {
  db.prepare(`ALTER TABLE actor_media ADD COLUMN depicts TEXT`).run();
}

// -- whether the person depicted authorised the likeness ---------------------
//
// `depicts` made "is this uploader building a body out of photographs of
// somebody who is not them" answerable. It left the next question -- did that
// somebody agree -- recorded nowhere at all, which meant a declared 'other'
// likeness and an authorised one were the same row. This is that column.
//
// Same discipline as `depicts` and for the same reason: nullable, whitelisted,
// NEVER inferred. NULL means "not asked, or not answered", which must stay a
// different state from an answer -- a guessed 'yes' would read later as
// evidence somebody gave permission they were never asked for. Written values:
// 'yes' or 'no'. Only meaningful where depicts = 'other'; a self-portrait needs
// no third party's permission, and the gates below only consult it there.
if (!db.prepare(`PRAGMA table_info(actor_media)`).all().some(c => c.name === "subject_authorised")) {
  db.prepare(`ALTER TABLE actor_media ADD COLUMN subject_authorised TEXT`).run();
}

// -- what a REPLACED photograph had declared ---------------------------------
//
// conduct-watch, 2026-09-11: POST /api/actors/:id/media replaces a slot by
// DELETE+INSERT, and the declaration is deliberately NOT carried onto the new
// file -- "a different photograph is a different question", the same rule the
// PUT /api/actors/:id photo swap already applies, and the same rule as the two
// columns above ("NEVER inferred"). But the drop was TOTAL and SILENT: the
// answer the owner had given vanished with the old row, so afterwards a blank
// read as "never asked" rather than as "was declared 'self', cleared when the
// photograph was replaced at T". `none` and `null` must never collapse (see
// actor-media-audit.js) and this is the same collapse one layer down.
//
// These two columns are a RECORD, never a declaration: no gate, gate-reason or
// gate predicate reads them, and depicts stays NULL when they are written. They
// exist so the clearing can be explained to the owner in the editor, and so
// conduct-watch signal 4 can tell a set that was never asked from a set whose
// answer a file swap took away.
if (!db.prepare(`PRAGMA table_info(actor_media)`).all().some(c => c.name === "depicts_cleared_from")) {
  db.prepare(`ALTER TABLE actor_media ADD COLUMN depicts_cleared_from TEXT`).run();
}
if (!db.prepare(`PRAGMA table_info(actor_media)`).all().some(c => c.name === "depicts_cleared_at")) {
  db.prepare(`ALTER TABLE actor_media ADD COLUMN depicts_cleared_at TEXT`).run();
}

// ── actor_media IS the evidence, so it may not change silently (2026-09-11) ──
//
// conduct-watch, 2026-09-11: signal 4 (a declared third party's likeness with
// no authorisation) and signal 7 (burst-and-delete) are both predicates over
// actor_media.depicts / .subject_authorised, and both were reading a table that
// anything could rewrite or empty without leaving a mark. Two measurements that
// morning. (1) A PATCH /api/actors/:id/media/depicts rewrote the declaration on
// four rows — the rows carrying a 40-observation consent flag about a real named
// person — and left behind nothing but a bumped updated_at; the prior value was
// unrecoverable. (2) Six API-created actor_media rows were gone within the hour
// with no DELETE request in the journal, no tombstone and no ledger entry. Had
// that PATCH written 'self', the signal would simply have gone quiet and nothing
// in either database would have said why. The traffic was a sibling routine
// exercising the consent gates, i.e. legitimate — the defect is that the
// INSTRUMENT cannot tell that case from the other one.
//
// The simulator has had this right for a while (its actor_media carries an
// AFTER DELETE trigger writing content_deletion_log); the platform's audit
// covered `actors` only.
//
// WHY TRIGGERS AND NOT WRITES IN THE ROUTE HANDLERS: the finding is precisely
// that rows changed through a path nobody could name. A handler records only
// the paths we already know about, and the six vanished rows are exactly the
// case it would have missed. A trigger is a property of the TABLE, so a
// forgotten route, a maintenance script, the wizard-lab force-remove, a cleanup
// script or a direct `sqlite3 platform_dev.db 'delete from ...'` all land in the
// log the same way, with no cooperation required from the writer.
//
// This RECORDS, it never REFUSES. Nothing here can make a write fail, no gate
// reads these rows, and no upload/declaration/withdrawal behaviour changes.
// Only the silence goes.
//
// event:
//   'removed'               — the row is gone; its OLD declaration is frozen here
//   'depicts_changed'       — depicts_before/after (either may be NULL)
//   'authorisation_changed' — subject_authorised_before/after; a withdrawal
//                             being revised is the same class of fact
db.exec(`
  CREATE TABLE IF NOT EXISTS actor_media_audit (
    id                        TEXT PRIMARY KEY,
    event                     TEXT NOT NULL,
    media_id                  TEXT NOT NULL,
    actor_id                  TEXT,
    world_id                  TEXT,
    media_type                TEXT,
    state_slug                TEXT,
    filename                  TEXT,
    url                       TEXT,
    depicts_before            TEXT,
    depicts_after             TEXT,
    subject_authorised_before TEXT,
    subject_authorised_after  TEXT,
    row_inserted_at           TEXT,
    row_updated_at            TEXT,
    recorded_at               TEXT NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS actor_media_audit_actor_id_idx    ON actor_media_audit (actor_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS actor_media_audit_recorded_at_idx ON actor_media_audit (recorded_at)`);

// The same ledger the actor tombstones use, for the same reason: a counter that
// is NOT derived from the rows survives their removal, so a swept audit log is
// still detectable afterwards —
//   SELECT rows_issued FROM audit_ledger WHERE table_name='actor_media_audit';
//   SELECT COUNT(*)    FROM actor_media_audit;
// disagreeing means rows were removed. Seeded from the rows that SURVIVE on a
// database that predates it: it cannot testify about the hour before it existed
// and must not pretend to.
db.prepare(`INSERT OR IGNORE INTO audit_ledger (table_name, rows_issued, last_issued_at)
            VALUES ('actor_media_audit',
                    (SELECT COUNT(*)         FROM actor_media_audit),
                    (SELECT MAX(recorded_at) FROM actor_media_audit))`).run();

// DROP-then-CREATE for the same reason as every other trigger in this file:
// CREATE TRIGGER IF NOT EXISTS would keep serving a stale body forever on any
// database that already has it. Both statements run on every boot.
db.exec(`DROP TRIGGER IF EXISTS actor_media_delete_audit`);
db.exec(`DROP TRIGGER IF EXISTS actor_media_depicts_audit`);
db.exec(`DROP TRIGGER IF EXISTS actor_media_authorisation_audit`);
db.exec(`DROP TRIGGER IF EXISTS actor_media_audit_no_delete`);
db.exec(`DROP TRIGGER IF EXISTS actor_media_audit_no_update`);
db.exec(`DROP TRIGGER IF EXISTS actor_media_audit_ledger_bump`);
db.exec(`
  CREATE TRIGGER actor_media_delete_audit
  AFTER DELETE ON actor_media
  FOR EACH ROW
  BEGIN
    INSERT INTO actor_media_audit
      (id, event, media_id, actor_id, world_id, media_type, state_slug, filename, url,
       depicts_before, depicts_after, subject_authorised_before, subject_authorised_after,
       row_inserted_at, row_updated_at, recorded_at)
    VALUES (
      lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),
      'removed', OLD.id, OLD.actor_id, OLD.world_id, OLD.media_type, OLD.state_slug,
      OLD.filename, OLD.url,
      OLD.depicts, NULL, OLD.subject_authorised, NULL,
      OLD.inserted_at, OLD.updated_at,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );
  END;
`);
db.exec(`
  CREATE TRIGGER actor_media_depicts_audit
  AFTER UPDATE OF depicts ON actor_media
  FOR EACH ROW
  WHEN COALESCE(OLD.depicts, '') <> COALESCE(NEW.depicts, '')
  BEGIN
    INSERT INTO actor_media_audit
      (id, event, media_id, actor_id, world_id, media_type, state_slug, filename, url,
       depicts_before, depicts_after, subject_authorised_before, subject_authorised_after,
       row_inserted_at, row_updated_at, recorded_at)
    VALUES (
      lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),
      'depicts_changed', NEW.id, NEW.actor_id, NEW.world_id, NEW.media_type, NEW.state_slug,
      NEW.filename, NEW.url,
      OLD.depicts, NEW.depicts, OLD.subject_authorised, NEW.subject_authorised,
      NEW.inserted_at, NEW.updated_at,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );
  END;
`);
db.exec(`
  CREATE TRIGGER actor_media_authorisation_audit
  AFTER UPDATE OF subject_authorised ON actor_media
  FOR EACH ROW
  WHEN COALESCE(OLD.subject_authorised, '') <> COALESCE(NEW.subject_authorised, '')
  BEGIN
    INSERT INTO actor_media_audit
      (id, event, media_id, actor_id, world_id, media_type, state_slug, filename, url,
       depicts_before, depicts_after, subject_authorised_before, subject_authorised_after,
       row_inserted_at, row_updated_at, recorded_at)
    VALUES (
      lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),
      'authorisation_changed', NEW.id, NEW.actor_id, NEW.world_id, NEW.media_type, NEW.state_slug,
      NEW.filename, NEW.url,
      OLD.depicts, NEW.depicts, OLD.subject_authorised, NEW.subject_authorised,
      NEW.inserted_at, NEW.updated_at,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );
  END;
`);

// Append-only, enforced by the database — the same three guards actor_deletions
// grew on 2026-09-10, and for the same reason: an audit row that can itself be
// deleted or rewritten is not a record, it is a suggestion.
db.exec(`
  CREATE TRIGGER actor_media_audit_no_delete
  BEFORE DELETE ON actor_media_audit
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'actor_media_audit is append-only: a media audit row may not be removed (conduct-watch, 2026-09-11)');
  END;
`);
db.exec(`
  CREATE TRIGGER actor_media_audit_no_update
  BEFORE UPDATE ON actor_media_audit
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'actor_media_audit is append-only: a media audit row may not be rewritten (conduct-watch, 2026-09-11)');
  END;
`);
db.exec(`
  CREATE TRIGGER actor_media_audit_ledger_bump
  AFTER INSERT ON actor_media_audit
  FOR EACH ROW
  BEGIN
    INSERT INTO audit_ledger (table_name, rows_issued, last_issued_at)
    VALUES ('actor_media_audit', 1, NEW.recorded_at)
    ON CONFLICT(table_name) DO UPDATE
      SET rows_issued    = rows_issued + 1,
          last_issued_at = excluded.last_issued_at;
  END;
`);

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
