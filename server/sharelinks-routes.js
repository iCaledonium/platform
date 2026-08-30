// ── Sharing a character outside your organisation ─────────────────────────────
//
// Session 158. Two ways out, and they are different products:
//
//   a LINK    - a secret handed to particular people, out of band  (session 158)
//   the GALLERY - listed for every signed-in account on the platform (session 159)
//
// They share one set of rules about what a grant may be, so they share one
// implementation of it: `grantShare()` below. Two copies of that logic would be
// two things to keep in step, and the rules are the whole point of the feature.
//
// Why this is not just "drop the same-org scope from the email lookup".
//
// `POST /api/actors/:id/shares` finds its target with an email search scoped to
// the caller's org, and that scope is load-bearing twice over: unscoped it is a
// cross-tenant reach, and it is an account-existence oracle for any address you
// care to type, on a host that is on the public internet over ngrok. The share
// picker (`GET /api/users`) is scoped for the same reason and says so in its own
// comment — across a tenant boundary a user list "is not a share target, it is a
// directory of strangers". Neither of those can be relaxed to reach outsiders.
//
// So a cross-org share is not addressed to an account at all. The owner mints a
// token, hands the link over out of band, and whoever opens it signed-in claims
// it. That is the same shape as the invite flow (`user_invites`): hashed at
// rest, expiring, single live secret, no mailer involved — this box has none.
// No address is ever typed, so the oracle never reopens.
//
// ── The cap: neither route can carry "copy" ───────────────────────────────────
//
// The in-org ladder is read < use < copy, where copy forks the character into
// one the claimant owns outright — roughly 100 MB of somebody else's media
// becoming permanently theirs. A link is aimed at NOBODY: at mint time you
// cannot know who will open it, or which tenant they are in. A gallery listing
// is aimed at everybody, which is the same problem larger. So ownership must
// not travel either path, and `permission` on both is validated against
// {read, use} only.
//
// This needs no change to the fork endpoint. `POST /api/actors/:id/fork` already
// requires `hasAccess(..., "copy")`, so a link-claimed holder is refused there by
// the existing ladder — the cap is enforced at the two ends independently.
//
// The rule that falls out of it, worth stating plainly because it is the whole
// design: OWNERSHIP ONLY EVER CROSSES BY AN ACT AIMED AT A KNOWN PERSON. In-org
// `copy` still exists and still works — it goes through the share dialog, which
// knows exactly whose account it is granting to.
//
// ── And never `can_reshare` ───────────────────────────────────────────────────
//
// A claim always writes can_reshare = 0, regardless of what the owner holds. A
// re-shareable link claim would let a stranger mint their own links onward, an
// unbounded rebroadcast the owner cannot see and cannot count. An owner who
// wants more reach mints another link, which they can see and revoke.

import crypto, { randomUUID } from "crypto";

// Deliberately NOT the ACCESS_RANK from index.js. That ladder includes copy and
// owner; this one is the set a link may carry, and it is a different question.
const LINK_RANK = { read: 1, use: 2 };
const LINK_PERMISSIONS = Object.keys(LINK_RANK);

const DEFAULT_TTL_DAYS = 14;
const MAX_TTL_DAYS     = 365;

const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

export function mount(app, { db, authUser }) {
  // ── Schema ──────────────────────────────────────────────────────────────────
  //
  // Created here rather than in db.js for the same reason memberships is: this
  // file owns the feature end to end, and a table declared next to the routes
  // that use it cannot be dropped by a whole-file write to another file.
  db.prepare(`CREATE TABLE IF NOT EXISTS actor_share_links (
    id           TEXT PRIMARY KEY,
    actor_id     TEXT NOT NULL REFERENCES actors(id),
    created_by   TEXT NOT NULL REFERENCES users(id),
    token_hash   TEXT NOT NULL UNIQUE,
    permission   TEXT NOT NULL DEFAULT 'read',
    label        TEXT,
    max_claims   INTEGER,
    claims_used  INTEGER NOT NULL DEFAULT 0,
    expires_at   TEXT NOT NULL,
    revoked_at   TEXT,
    inserted_at  TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS actor_share_links_actor_idx ON actor_share_links (actor_id)`).run();

  // `via_link_id` records which link admitted a share, so the owner can see who
  // came in through which link and revoke a link's claims as a group.
  try { db.prepare(`ALTER TABLE actor_shares ADD COLUMN via_link_id TEXT REFERENCES actor_share_links(id)`).run(); } catch { /* exists */ }

  // ── Publication (Session 159) ───────────────────────────────────────────────
  //
  // On `actors` rather than in a table of its own: a character has exactly one
  // publication state, so a row per publication would only ever hold zero or one
  // row per actor and buy nothing. Same idempotent conditional-ALTER pattern the
  // rest of this schema uses — SQLite has no ADD COLUMN IF NOT EXISTS.
  for (const ddl of [
    `ALTER TABLE actors ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`,
    `ALTER TABLE actors ADD COLUMN published_permission TEXT`,
    `ALTER TABLE actors ADD COLUMN published_note TEXT`,
    `ALTER TABLE actors ADD COLUMN published_at TEXT`,
    // Distinguishes a gallery adoption from a link claim (via_link_id) and from
    // a grant made by name (neither set), so unpublishing can withdraw exactly
    // the access publication created and nothing a person was given directly.
    `ALTER TABLE actor_shares ADD COLUMN via_public INTEGER NOT NULL DEFAULT 0`,
  ]) { try { db.prepare(ddl).run(); } catch { /* exists */ } }

  // `can_reshare` has been read and written by the share endpoints since Session
  // 150 but was only ever added to the live DB by a hand-run ALTER — it is in
  // NEITHER db.js's CREATE TABLE nor any migration. A rebuild from code would
  // therefore produce an actor_shares table that every share query references a
  // missing column on. Same divergence class as the `actors` table's hand-run
  // ALTERs. Added here so the schema is reproducible from the repo.
  try { db.prepare(`ALTER TABLE actor_shares ADD COLUMN can_reshare INTEGER NOT NULL DEFAULT 0`).run(); } catch { /* exists */ }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  // Minting is reserved to the creator, not extended to can_reshare holders.
  // A re-share is aimed at one named account and the grantor can see it in the
  // list; a link is aimed at anyone, forever, until it expires. Those are not
  // the same permission and the flag for one should not silently confer the
  // other.
  function requireOwner(req, res) {
    const user = authUser(req);
    if (!user) { res.status(401).json({ error: "unauthorized" }); return null; }
    const actor = db.prepare(`SELECT id, name, owner_id FROM actors WHERE id = ?`).get(req.params.id);
    if (!actor) { res.status(404).json({ error: "not found" }); return null; }
    if (actor.owner_id !== user.id) {
      // A share holder can see the character, so 404 would be a lie to them;
      // someone with no access at all learns nothing new from a 404.
      const share = db.prepare(`SELECT 1 FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`)
        .get(actor.id, user.id);
      if (share) { res.status(403).json({ error: "Only the character's creator can create share links." }); return null; }
      res.status(404).json({ error: "not found" });
      return null;
    }
    return { user, actor };
  }

  // ── The one place a share is granted to somebody who was not named ──────────
  //
  // Used by both the link claim and the gallery adoption. Everything the two
  // routes must agree on lives here, so they cannot drift:
  //
  //   - can_reshare is ALWAYS 0. Never inherited, never configurable. Onward
  //     re-sharing is a decision about a named person; neither of these routes
  //     has one.
  //   - an existing grant is never DOWNGRADED. Somebody given `copy` by name
  //     does not lose it by opening a `read` link or adopting from the gallery.
  //     `?? 99` is deliberate: copy and owner are not in LINK_RANK, and an
  //     unknown rung must read as "more than this", never as zero.
  //   - the CREATOR stays owner_id. A claim never reassigns a character's origin.
  //
  // Returns which of the three things happened, so the caller can report it and
  // so a link only counts a seat for a genuinely new person.
  function grantShare({ actorId, ownerId, userId, permission, viaLinkId = null, viaPublic = 0 }) {
    const now = new Date().toISOString();
    const existing = db.prepare(`SELECT * FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`)
      .get(actorId, userId);

    if (existing && (LINK_RANK[existing.permission] ?? 99) >= LINK_RANK[permission]) {
      return { outcome: "already_had", permission: existing.permission };
    }
    if (existing) {
      db.prepare(`UPDATE actor_shares SET permission = ?, via_link_id = ?, via_public = ?, updated_at = ? WHERE id = ?`)
        .run(permission, viaLinkId, viaPublic, now, existing.id);
      return { outcome: "upgraded", permission };
    }
    db.prepare(`INSERT INTO actor_shares
      (id, actor_id, owner_id, shared_with_id, shared_with_type, permission, can_reshare, via_link_id, via_public, inserted_at, updated_at)
      VALUES (?,?,?,?,'user',?,0,?,?,?,?)`)
      .run(randomUUID(), actorId, ownerId, userId, permission, viaLinkId, viaPublic, now, now);
    return { outcome: "created", permission };
  }

  function linkState(row, now) {
    if (row.revoked_at) return "revoked";
    if (row.expires_at <= now) return "expired";
    if (row.max_claims != null && row.claims_used >= row.max_claims) return "exhausted";
    return "active";
  }

  function publicLink(row, now) {
    return {
      id: row.id,
      permission: row.permission,
      label: row.label,
      max_claims: row.max_claims,
      claims_used: row.claims_used,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      inserted_at: row.inserted_at,
      state: linkState(row, now),
    };
  }

  // ── POST /api/actors/:id/share-links — mint one ─────────────────────────────
  app.post("/api/actors/:id/share-links", (req, res) => {
    const ok = requireOwner(req, res);
    if (!ok) return;
    const { user, actor } = ok;

    const permission = req.body?.permission ?? "read";
    if (!LINK_PERMISSIONS.includes(permission)) {
      // "copy" is the one worth naming explicitly. Silently rejecting it as an
      // unknown value would read as a typo; it is a deliberate refusal.
      if (permission === "copy") {
        return res.status(400).json({
          error: 'A share link cannot grant "copy". A link has no named recipient, and ownership only ever crosses by an act aimed at a known person — share by name for that.',
        });
      }
      return res.status(400).json({ error: `permission must be ${LINK_PERMISSIONS.join(" or ")}` });
    }

    const days = req.body?.expires_in_days == null ? DEFAULT_TTL_DAYS : Number(req.body.expires_in_days);
    if (!Number.isFinite(days) || days <= 0 || days > MAX_TTL_DAYS) {
      return res.status(400).json({ error: `expires_in_days must be between 1 and ${MAX_TTL_DAYS}` });
    }

    let maxClaims = req.body?.max_claims;
    if (maxClaims === "" || maxClaims == null) maxClaims = null;
    else {
      maxClaims = Number(maxClaims);
      if (!Number.isInteger(maxClaims) || maxClaims < 1) {
        return res.status(400).json({ error: "max_claims must be a positive whole number, or omitted for no limit" });
      }
    }

    const label = typeof req.body?.label === "string" ? req.body.label.slice(0, 120).trim() || null : null;

    // 32 bytes, base64url. The token is returned exactly once and only its
    // sha256 is stored — the same handling as invite tokens and API keys.
    const token = crypto.randomBytes(32).toString("base64url");
    const now   = new Date().toISOString();
    const expires = new Date(Date.now() + days * 86400_000).toISOString();
    const id = randomUUID();

    db.prepare(`INSERT INTO actor_share_links
      (id, actor_id, created_by, token_hash, permission, label, max_claims, claims_used, expires_at, inserted_at, updated_at)
      VALUES (?,?,?,?,?,?,?,0,?,?,?)`)
      .run(id, actor.id, user.id, hashToken(token), permission, label, maxClaims, expires, now, now);

    // A path, not a URL. express has no `trust proxy` here, so req.protocol says
    // "http" behind nginx+ngrok — composing an absolute URL server-side is how
    // you hand somebody an http:// link to an https:// site. The browser
    // prepends its own origin, exactly as the invite endpoints do.
    res.json({
      ok: true,
      ...publicLink(db.prepare(`SELECT * FROM actor_share_links WHERE id = ?`).get(id), now),
      token,
      share_path: `/share/${token}`,
    });
  });

  // ── GET /api/actors/:id/share-links — list them ─────────────────────────────
  //
  // Never returns a token: only the hash is stored, so a link's secret is
  // unrecoverable after minting by construction, not by policy. A lost link is
  // revoked and re-minted.
  app.get("/api/actors/:id/share-links", (req, res) => {
    const ok = requireOwner(req, res);
    if (!ok) return;
    const now = new Date().toISOString();
    const rows = db.prepare(`SELECT * FROM actor_share_links WHERE actor_id = ? ORDER BY inserted_at DESC`)
      .all(req.params.id);
    const claimants = db.prepare(`
      SELECT s.via_link_id, u.id AS user_id, u.name, u.email
      FROM actor_shares s JOIN users u ON u.id = s.shared_with_id
      WHERE s.actor_id = ? AND s.via_link_id IS NOT NULL
    `).all(req.params.id);
    res.json(rows.map(r => ({
      ...publicLink(r, now),
      claimed_by: claimants.filter(c => c.via_link_id === r.id).map(({ user_id, name, email }) => ({ user_id, name, email })),
    })));
  });

  // ── DELETE /api/actors/:id/share-links/:linkId — revoke ─────────────────────
  //
  // Revoking stops FUTURE claims and, by default, leaves standing shares alone:
  // a link that has done its job and is being tidied away should not silently
  // take a colleague's access with it. `?revoke_claims=1` is the other meaning
  // of the word — "I regret this link" — and removes both.
  app.delete("/api/actors/:id/share-links/:linkId", (req, res) => {
    const ok = requireOwner(req, res);
    if (!ok) return;
    const link = db.prepare(`SELECT * FROM actor_share_links WHERE id = ? AND actor_id = ?`)
      .get(req.params.linkId, req.params.id);
    if (!link) return res.status(404).json({ error: "link not found" });

    const now = new Date().toISOString();
    const alsoClaims = req.query.revoke_claims === "1";
    let removed = 0;
    db.transaction(() => {
      db.prepare(`UPDATE actor_share_links SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?`)
        .run(now, now, link.id);
      if (alsoClaims) {
        removed = db.prepare(`DELETE FROM actor_shares WHERE actor_id = ? AND via_link_id = ?`)
          .run(req.params.id, link.id).changes;
      }
    })();
    res.json({ ok: true, revoked_claims: removed });
  });

  // ── GET /api/share/:token — what am I being offered? ────────────────────────
  //
  // Signed-in only. An unauthenticated preview would put a route that reads
  // character names onto a public host for anyone holding a URL, and this
  // codebase has already been bitten once by an unauthenticated endpoint that
  // took an identifier from the request (`POST /api/enroll/start`). The claim
  // needs an account anyway, so requiring one to look changes nothing for a
  // legitimate recipient — the page prompts them to sign in and returns here.
  app.get("/api/share/:token", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const link = db.prepare(`SELECT * FROM actor_share_links WHERE token_hash = ?`).get(hashToken(req.params.token));
    // One shape of answer for "no such token" and for a token that never
    // existed — there is nothing to distinguish and nothing to leak.
    if (!link) return res.status(404).json({ error: "This share link is not valid." });

    const now   = new Date().toISOString();
    const state = linkState(link, now);
    const actor = db.prepare(`
      SELECT a.id, a.name, a.age, a.gender, a.occupation, a.owner_id,
             (SELECT url FROM actor_media WHERE actor_id = a.id AND media_type = 'photo'
                AND state_slug IN ('photo_close','profile') LIMIT 1) AS photo_url
      FROM actors a WHERE a.id = ?`).get(link.actor_id);
    if (!actor) return res.status(404).json({ error: "This character no longer exists." });

    const owner    = db.prepare(`SELECT name FROM users WHERE id = ?`).get(actor.owner_id);
    const existing = db.prepare(`SELECT permission FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`)
      .get(actor.id, user.id);

    res.json({
      state,
      permission: link.permission,
      expires_at: link.expires_at,
      is_owner: actor.owner_id === user.id,
      already_have: existing?.permission ?? null,
      shared_by: owner?.name ?? null,
      actor: { id: actor.id, name: actor.name, age: actor.age, gender: actor.gender,
               occupation: actor.occupation, photo_url: actor.photo_url },
    });
  });

  // ── POST /api/share/:token/claim — take it ──────────────────────────────────
  app.post("/api/share/:token/claim", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const link = db.prepare(`SELECT * FROM actor_share_links WHERE token_hash = ?`).get(hashToken(req.params.token));
    if (!link) return res.status(404).json({ error: "This share link is not valid." });

    const now   = new Date().toISOString();
    const state = linkState(link, now);
    if (state !== "active") {
      return res.status(410).json({ error: {
        revoked:   "This share link has been revoked.",
        expired:   "This share link has expired.",
        exhausted: "This share link has already been used the maximum number of times.",
      }[state], state });
    }

    const actor = db.prepare(`SELECT id, name, owner_id FROM actors WHERE id = ?`).get(link.actor_id);
    if (!actor) return res.status(404).json({ error: "This character no longer exists." });
    if (actor.owner_id === user.id) {
      return res.status(400).json({ error: "This is already your character." });
    }

    let r;
    db.transaction(() => {
      r = grantShare({
        actorId: actor.id, ownerId: actor.owner_id, userId: user.id,
        permission: link.permission, viaLinkId: link.id,
      });
      // Seats count PEOPLE the link let in, so neither a re-open nor an upgrade
      // consumes one.
      if (r.outcome === "created") {
        db.prepare(`UPDATE actor_share_links SET claims_used = claims_used + 1, updated_at = ? WHERE id = ?`)
          .run(now, link.id);
      }
    })();

    res.json({ ok: true, actor_id: actor.id, name: actor.name, permission: r.permission,
               already_had: r.outcome === "already_had", upgraded: r.outcome === "upgraded" });
  });

  // ══ THE PUBLIC GALLERY ══════════════════════════════════════════════════════
  //
  // Session 159. The other way a character leaves its org: listed for every
  // signed-in account on the platform rather than handed to particular people.
  //
  // "Public" here means EVERY SIGNED-IN ACCOUNT, not the open internet, and that
  // is a constraint rather than a preference. A character's photos and model
  // live under /media/actors/, which nginx serves behind `auth_request
  // /api/auth/check` — a stanza marked ANIMA-INVARIANT, the standing remediation
  // for personal media having been publicly reachable. An anonymous gallery
  // would be a page of broken images unless that control were weakened, so it
  // is not on the table. A listing is platform-wide, which is already the thing
  // org scoping prevented.
  //
  // Publication grants nothing by itself. It offers; the reader takes. That is
  // what keeps `actor_shares` the single answer to "who has access": a browser
  // of the gallery has no access to a character until they adopt it, and then
  // they hold an ordinary share row like everybody else. The alternative —
  // treating a listing as an implicit grant to all — would have meant a second
  // branch in `actorAccess`, and every access question on the platform would
  // have had two answers to reconcile forever.

  function publicActorRow(a, viewerId) {
    return {
      id: a.id, name: a.name, age: a.age, gender: a.gender, occupation: a.occupation,
      photo_url: a.photo_url, note: a.published_note, published_at: a.published_at,
      permission: a.published_permission,
      owner_name: a.owner_name,
      is_mine: a.owner_id === viewerId,
      already_have: a.my_permission ?? null,
    };
  }

  // ── GET /api/actors/:id/publish — is she listed, and who took her ───────────
  app.get("/api/actors/:id/publish", (req, res) => {
    const ok = requireOwner(req, res);
    if (!ok) return;
    const a = db.prepare(`SELECT visibility, published_permission, published_note, published_at, status
                          FROM actors WHERE id = ?`).get(req.params.id);
    const adopters = db.prepare(`
      SELECT u.id AS user_id, u.name, u.email, s.permission
      FROM actor_shares s JOIN users u ON u.id = s.shared_with_id
      WHERE s.actor_id = ? AND s.via_public = 1
      ORDER BY s.inserted_at
    `).all(req.params.id);
    res.json({
      visibility: a.visibility || "private",
      permission: a.published_permission,
      note: a.published_note,
      published_at: a.published_at,
      // The publish control needs to explain itself before the click, not after.
      publishable: a.status !== "draft",
      adopters,
    });
  });

  // ── PUT /api/actors/:id/publish — list it ───────────────────────────────────
  app.put("/api/actors/:id/publish", (req, res) => {
    const ok = requireOwner(req, res);
    if (!ok) return;
    const { actor } = ok;

    const permission = req.body?.permission ?? "read";
    if (!LINK_PERMISSIONS.includes(permission)) {
      if (permission === "copy") {
        return res.status(400).json({
          error: 'The gallery cannot offer "copy". A listing is aimed at everybody, and ownership only ever crosses by an act aimed at a known person — share by name for that.',
        });
      }
      return res.status(400).json({ error: `permission must be ${LINK_PERMISSIONS.join(" or ")}` });
    }

    // A draft is a character mid-build: the wizard writes the row on the first
    // step, long before there is a face, an age or a psychology. `status` is
    // already the product's answer to "is this finished" — the deploy gallery
    // has refused drafts since Session 103 for the same reason. Publishing one
    // would put a half-typed stub in front of the whole platform, and (since the
    // age floor binds only a SUPPLIED age) it is also the one state in which a
    // character can still legitimately carry no age at all.
    const full = db.prepare(`SELECT status, age FROM actors WHERE id = ?`).get(actor.id);
    if (full.status === "draft") {
      return res.status(400).json({ error: "This character is still a draft. Finish her before publishing." });
    }

    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 280).trim() || null : null;
    const now = new Date().toISOString();
    db.prepare(`UPDATE actors SET visibility = 'public', published_permission = ?, published_note = ?,
                published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`)
      .run(permission, note, now, now, actor.id);

    res.json({ ok: true, visibility: "public", permission, note });
  });

  // ── DELETE /api/actors/:id/publish — take it back down ──────────────────────
  //
  // Same two meanings as revoking a link, and the same default. Unlisting stops
  // NEW people finding her; the people who already adopted her keep what they
  // took, because withdrawing something a person is already building on should
  // be a deliberate act and not a side effect of tidying a listing.
  // `?revoke_claims=1` is the deliberate act.
  app.delete("/api/actors/:id/publish", (req, res) => {
    const ok = requireOwner(req, res);
    if (!ok) return;
    const now = new Date().toISOString();
    let removed = 0;
    db.transaction(() => {
      db.prepare(`UPDATE actors SET visibility = 'private', published_permission = NULL,
                  published_note = NULL, published_at = NULL, updated_at = ? WHERE id = ?`)
        .run(now, req.params.id);
      if (req.query.revoke_claims === "1") {
        // Only what publication created. A grant made by name, or through a
        // link, was a separate decision and is not publication's to undo.
        removed = db.prepare(`DELETE FROM actor_shares WHERE actor_id = ? AND via_public = 1`)
          .run(req.params.id).changes;
      }
    })();
    res.json({ ok: true, visibility: "private", revoked_claims: removed });
  });

  // ── GET /api/gallery — what everyone has published ──────────────────────────
  app.get("/api/gallery", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const like = `%${q.replace(/[%_]/g, m => "\\" + m)}%`;

    const rows = db.prepare(`
      SELECT a.id, a.name, a.age, a.gender, a.occupation, a.owner_id,
             a.published_permission, a.published_note, a.published_at,
             u.name AS owner_name,
             s.permission AS my_permission,
             (SELECT url FROM actor_media WHERE actor_id = a.id AND media_type = 'photo'
                AND state_slug IN ('photo_close','profile') LIMIT 1) AS photo_url
      FROM actors a
      JOIN users u ON u.id = a.owner_id
      LEFT JOIN actor_shares s ON s.actor_id = a.id AND s.shared_with_id = ?
      WHERE a.visibility = 'public'
        ${q ? `AND (a.name LIKE ? ESCAPE '\\' OR a.occupation LIKE ? ESCAPE '\\' OR a.published_note LIKE ? ESCAPE '\\')` : ""}
      ORDER BY a.published_at DESC
      LIMIT 200
    `).all(...(q ? [user.id, like, like, like] : [user.id]));

    res.json(rows.map(a => publicActorRow(a, user.id)));
  });

  // ── POST /api/gallery/:id/adopt — take what is offered ──────────────────────
  app.post("/api/gallery/:id/adopt", (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const actor = db.prepare(`SELECT id, name, owner_id, visibility, published_permission FROM actors WHERE id = ?`)
      .get(req.params.id);
    // Unlisted and never-listed answer identically: the gallery is the only way
    // this route knows about a character, so there is nothing to distinguish.
    if (!actor || actor.visibility !== "public") {
      return res.status(404).json({ error: "This character is not in the gallery." });
    }
    if (actor.owner_id === user.id) {
      return res.status(400).json({ error: "This is already your character." });
    }
    // Belt and braces against a row that went public before the cap existed, or
    // one edited by hand: the offered rung is re-validated at the point of grant,
    // not trusted from storage.
    const permission = LINK_PERMISSIONS.includes(actor.published_permission) ? actor.published_permission : "read";

    const r = db.transaction(() => grantShare({
      actorId: actor.id, ownerId: actor.owner_id, userId: user.id,
      permission, viaPublic: 1,
    }))();

    res.json({ ok: true, actor_id: actor.id, name: actor.name, permission: r.permission,
               already_had: r.outcome === "already_had", upgraded: r.outcome === "upgraded" });
  });
}
