// ── Interaction scripts ──────────────────────────────────────────────────────
//
// Session 157 — the store behind the Interaction Studio.
//
// A script is a named sequence of things two bodies do to each other, authored
// in the studio and MEANT to be played back inside an encounter. That second
// half is why this is a table and a route rather than localStorage: the studio
// runs in the developer's browser, the encounter runs wherever the player is,
// and the only thing they can both reach is the platform.
//
// The vocabulary lives in src/lib/interactionScript.js and this file IMPORTS
// it. It briefly carried its own copy of normalizeSteps, kept honest by a
// comment — and that instrument has already failed once on this system: the
// transport bench asserted against a hand-maintained duplicate of
// VehicleEngine.valid_mode/2 instead of calling it, and stayed blind to a real
// defect for as long as the copy existed ("the scorecard was grading a copy of
// itself"). Chief Architect's ruling, 2026-09-06: delete the copy, import the
// original.
//
// The import is sound because the package is "type": "module" throughout, the
// lib is plain ESM with no window, no three.js and no asset imports, and the
// deploy model is scp-into-the-live-checkout — src/ is present at runtime
// because the repo IS the working tree on the host. If that ever stops being
// true, this file fails loudly at boot rather than validating with a stale
// rulebook, which is the correct direction to fail in.
//
// A stored row is executed later by code that will not re-check it, so nothing
// is trusted on the way in: every step is rebuilt field by field from a
// whitelist, numbers are clamped, and anything unrecognised is refused with the
// step number rather than silently dropped.

import { randomUUID } from "crypto";
import express from "express";
import { normalizeSteps, drivenRoles, normalizeCameras } from "../src/lib/interactionScript.js";
import { normalizeAction, slugify as actionSlug } from "../src/lib/bodyActions.js";

// A slug is how an ENCOUNTER will ask for a script — by the name somebody gave
// it, not by a uuid nobody can type into a prompt. Unique per owner, so two
// developers can each have their own "greet-at-the-door".
function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "script";
}

export function mount(app, { db, authUser }) {
  // Same idempotent-at-boot pattern the rest of the server uses: the table is
  // created here rather than in db.js so the whole feature is one file that can
  // be added or removed without editing the schema module.
  db.exec(`
    CREATE TABLE IF NOT EXISTS interaction_scripts (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL REFERENCES users(id),
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL,
      description TEXT,
      -- The cast is the SLOTS and what they were rehearsed with, never a
      -- binding an encounter has to honour: role "a" is whoever the encounter
      -- casts as "a". Stored so re-opening a script in the studio puts the
      -- same two bodies back in the room.
      cast_json   TEXT NOT NULL DEFAULT '[]',
      steps_json  TEXT NOT NULL DEFAULT '[]',
      inserted_at TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      UNIQUE(owner_id, slug)
    );
  `);

  // Body interactions: what two people DO to each other, as authored data.
  // Separate from scripts on purpose — a script REFERENCES an action by slug so
  // that editing the slap updates every script that uses it, instead of each
  // script carrying a copy that forks the moment the action is retimed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS body_interactions (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL REFERENCES users(id),
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL,
      -- The whole action: duration, contact instant, authored distance, and
      -- the actor/reaction rotation tracks. One JSON document because it is
      -- read and written whole and never queried into.
      action_json TEXT NOT NULL DEFAULT '{}',
      inserted_at TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      UNIQUE(owner_id, slug)
    );
  `);

  const json = express.json({ limit: "512kb" });

  // Added after the table shipped, so it goes on with ALTER rather than in the
  // CREATE — an existing row must keep its steps, and dropping the table to add
  // a column is how somebody's saved work disappears.
  const cols = db.prepare(`PRAGMA table_info(interaction_scripts)`).all().map(c => c.name);
  if (!cols.includes("cameras_json")) {
    db.exec(`ALTER TABLE interaction_scripts ADD COLUMN cameras_json TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!cols.includes("props_json")) {
    db.exec(`ALTER TABLE interaction_scripts ADD COLUMN props_json TEXT NOT NULL DEFAULT '[]'`);
  }

  // A prop is a TYPE, a place, a quarter-turn — and a SLOT, which is the whole
  // point of persisting them. The studio's table is a stand-in; when this plays
  // in a real room the furniture is wherever it actually is, and a real piece
  // claims a rehearsal one by matching the slot. Coordinates are rehearsal
  // detail; the slot and the type are the contract.
  const PROP_KINDS = ["table", "chair", "bed"];
  const normalizeProps = (raw) => (Array.isArray(raw) ? raw : [])
    .filter(p => p && PROP_KINDS.includes(String(p.type)))
    .slice(0, 24)
    .map(p => ({
      id: String(p.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || randomUUID().slice(0, 8),
      type: String(p.type),
      slot: String(p.slot || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || null,
      x: Math.max(-8, Math.min(8, Number(p.x) || 0)),
      z: Math.max(-8, Math.min(8, Number(p.z) || 0)),
      // Free rotation, in radians. `rot` was quarter-turns; it is read as a
      // fallback so furniture saved before this keeps facing the way it was put.
      yaw: Number.isFinite(Number(p.yaw))
        ? ((Number(p.yaw) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        : ((Math.max(0, Math.min(3, Math.round(Number(p.rot) || 0))) * Math.PI) / 2),
    }));

  const rowOut = (r) => {
    const steps = safeParse(r.steps_json, []);
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description || "",
      cast: safeParse(r.cast_json, []),
      steps,
      cameras: safeParse(r.cameras_json, []),
      // The furniture the rehearsal was staged with. A STAND-IN: what matters
      // is that a table was between them, not that it stood at x=0.4. When this
      // plays in her flat the room supplies the real furniture and these are
      // replaced — the `slot` is how a real piece claims a rehearsal one.
      props: safeParse(r.props_json, []),
      // Which roles this script takes hold of, computed from the steps by the
      // same function the runner uses. It is here so a host can decide BEFORE
      // it commits to a beat: pull by slug, compare `drives` against the roles
      // it owns, and never play. Discovering it from runScript returning false
      // is correct but late — by then an encounter has already paused in front
      // of a player. (Chief Architect, 2026-09-06.)
      drives: drivenRoles({ steps }),
      inserted_at: r.inserted_at,
      updated_at: r.updated_at,
    };
  };

  function safeParse(s, fallback) {
    try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; }
  }

  const actionOut = (row) => ({
    id: row.id, name: row.name, slug: row.slug,
    ...safeParse(row.action_json, {}),
    updated_at: row.updated_at,
  });

  // ── GET /api/body-interactions ────────────────────────────────────────────
  app.get("/api/body-interactions", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const rows = db.prepare(
      `SELECT * FROM body_interactions WHERE owner_id = ? ORDER BY updated_at DESC`
    ).all(user.id);
    res.json(rows.map(actionOut));
  });

  // ── POST /api/body-interactions — create or overwrite by slug ─────────────
  //
  // Validated with the SAME normalizeAction the editor uses. The row is
  // executed later by a rig that will not re-check it, and it drives bone
  // rotations on a body, so the server refuses rather than storing something it
  // would have to defend against at play time.
  app.post("/api/body-interactions", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const { action, errors } = normalizeAction(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join("; "), errors });

    const slug = actionSlug(req.body?.slug || action.name) || action.slug;
    action.slug = slug;
    const now = new Date().toISOString();
    const existing = db.prepare(
      `SELECT id FROM body_interactions WHERE owner_id = ? AND slug = ?`
    ).get(user.id, slug);

    const id = existing?.id || randomUUID();
    if (existing) {
      db.prepare(`UPDATE body_interactions SET name = ?, action_json = ?, updated_at = ? WHERE id = ?`)
        .run(action.name, JSON.stringify(action), now, id);
    } else {
      db.prepare(`INSERT INTO body_interactions (id, owner_id, name, slug, action_json, inserted_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, user.id, action.name, slug, JSON.stringify(action), now, now);
    }
    res.json(actionOut(db.prepare(`SELECT * FROM body_interactions WHERE id = ?`).get(id)));
  });

  // ── DELETE /api/body-interactions/:slug ───────────────────────────────────
  app.delete("/api/body-interactions/:slug", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const info = db.prepare(`DELETE FROM body_interactions WHERE owner_id = ? AND slug = ?`)
      .run(user.id, req.params.slug);
    if (!info.changes) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  // ── GET /api/interaction-scripts — the shelf ───────────────────────────────
  app.get("/api/interaction-scripts", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const rows = db.prepare(
      `SELECT * FROM interaction_scripts WHERE owner_id = ? ORDER BY updated_at DESC`
    ).all(user.id);
    res.json(rows.map(rowOut));
  });

  // ── GET /api/interaction-scripts/:idOrSlug ────────────────────────────────
  //
  // Slug as well as id, because the caller that matters most is an encounter
  // asking for "greet-at-the-door" by name.
  app.get("/api/interaction-scripts/:key", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const row = db.prepare(
      `SELECT * FROM interaction_scripts WHERE owner_id = ? AND (id = ? OR slug = ?)`
    ).get(user.id, req.params.key, req.params.key);
    if (!row) return res.status(404).json({ error: "not found" });
    res.json(rowOut(row));
  });

  // ── POST /api/interaction-scripts — save a new one ────────────────────────
  app.post("/api/interaction-scripts", json, (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const name = String(req.body?.name || "").trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: "a script needs a name" });

    const { steps, errors } = normalizeSteps(req.body?.steps || []);
    if (errors.length) return res.status(400).json({ error: errors.join("; ") });

    // A name collision is a REPLACE offer, not an error the author has to
    // rename around: same owner, same slug means they meant the same script.
    const slug = slugify(name);
    const existing = db.prepare(
      `SELECT id FROM interaction_scripts WHERE owner_id = ? AND slug = ?`).get(user.id, slug);
    if (existing) return res.status(409).json({ error: `“${name}” already exists`, id: existing.id });

    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO interaction_scripts (id, owner_id, name, slug, description, cast_json, steps_json, cameras_json, props_json, inserted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, user.id, name, slug, String(req.body?.description || "").slice(0, 400),
          JSON.stringify(req.body?.cast || []), JSON.stringify(steps),
          JSON.stringify(normalizeCameras(req.body?.cameras, steps.length)),
          JSON.stringify(normalizeProps(req.body?.props)), now, now);

    res.json(rowOut(db.prepare(`SELECT * FROM interaction_scripts WHERE id = ?`).get(id)));
  });

  // ── PUT /api/interaction-scripts/:id — rewrite one ────────────────────────
  app.put("/api/interaction-scripts/:id", json, (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const row = db.prepare(
      `SELECT * FROM interaction_scripts WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
    if (!row) return res.status(404).json({ error: "not found" });

    const name = String(req.body?.name ?? row.name).trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: "a script needs a name" });
    const { steps, errors } = normalizeSteps(req.body?.steps ?? safeParse(row.steps_json, []));
    if (errors.length) return res.status(400).json({ error: errors.join("; ") });

    const slug = slugify(name);
    const clash = db.prepare(
      `SELECT id FROM interaction_scripts WHERE owner_id = ? AND slug = ? AND id != ?`
    ).get(user.id, slug, row.id);
    if (clash) return res.status(409).json({ error: `“${name}” is already the name of another script` });

    db.prepare(
      `UPDATE interaction_scripts
          SET name = ?, slug = ?, description = ?, cast_json = ?, steps_json = ?, cameras_json = ?, props_json = ?, updated_at = ?
        WHERE id = ?`
    ).run(name, slug,
          String(req.body?.description ?? row.description ?? "").slice(0, 400),
          JSON.stringify(req.body?.cast ?? safeParse(row.cast_json, [])),
          JSON.stringify(steps),
          JSON.stringify(normalizeCameras(req.body?.cameras ?? safeParse(row.cameras_json, []), steps.length)),
          JSON.stringify(normalizeProps(req.body?.props ?? safeParse(row.props_json, []))),
          new Date().toISOString(), row.id);

    res.json(rowOut(db.prepare(`SELECT * FROM interaction_scripts WHERE id = ?`).get(row.id)));
  });

  // ── DELETE /api/interaction-scripts/:id ───────────────────────────────────
  app.delete("/api/interaction-scripts/:id", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    const info = db.prepare(
      `DELETE FROM interaction_scripts WHERE id = ? AND owner_id = ?`).run(req.params.id, user.id);
    if (!info.changes) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  // ── GET /api/interaction-studio/cast — who can stand in the room ──────────
  //
  // Only bodies that actually LOAD: a runtime GLB is the dressed, baked,
  // ~26 MB file a world fetches, and the editable glb_url is a 75-100 MB bare
  // body that will not cross the tunnel. Offering a character without one is
  // offering an empty room, so those are listed as unavailable WITH the reason
  // rather than hidden — "where is Sarah" has an answer this way.
  app.get("/api/interaction-studio/cast", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const mine = db.prepare(`
      SELECT a.id, a.name, a.gender, a.runtime_glb_url, a.updated_at,
             (SELECT url FROM actor_media WHERE actor_id = a.id AND media_type = 'photo'
                AND state_slug IN ('photo_close','profile') LIMIT 1) AS photo_url
        FROM actors a
       WHERE a.owner_id = ?
       ORDER BY a.name
    `).all(user.id);

    // The account's own 3D profile is an actors row too (users.avatar_actor_id),
    // and /api/actors deliberately hides it — deploying your own body is
    // nonsense. Standing it in a room is not: "me and her" is the commonest
    // pair a rehearsal wants, so it is listed here, flagged as a person.
    const avatarId = db.prepare(`SELECT avatar_actor_id FROM users WHERE id = ?`).get(user.id)?.avatar_actor_id;

    const cast = mine.map(a => ({
      id: a.id,
      name: a.name,
      kind: a.id === avatarId ? "you" : "character",
      photo_url: a.photo_url || null,
      glb_url: a.runtime_glb_url || null,
      updated_at: a.updated_at,
      unavailable: a.runtime_glb_url ? null : "no runtime model — finish the character in the wizard",
    }));

    res.json(cast);
  });
}
