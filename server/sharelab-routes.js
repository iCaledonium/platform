// Share Lab — assertions against live state for the two ways a character
// leaves its org: a share LINK aimed at whoever holds the URL, and the public
// GALLERY aimed at every signed-in account.
//
// Platform-local (this service owns both routes), global (no world target).
//
// Both share tables are EMPTY at the time of writing, and that shaped the
// board. A board made only of row assertions would be nine skips and no
// evidence — "no link grants copy" is trivially true of zero links. So the
// spine here is PROBES: read-only requests against the real endpoints whose
// refusal is the invariant. Those work identically at zero rows and at ten
// thousand, and they are the checks that would actually have caught the
// unauthenticated /api/enroll/start hole this codebase was bitten by.
//
// Every probe is refused BY DESIGN, so none of them writes. A probe that could
// succeed would be a probe that shares a character on a nightly cron, which is
// why there is no mint-and-claim walk in here — that belongs behind a button,
// like the wizard bench's probes.

let boundChecks = null;
export async function shareChecks() {
  if (!boundChecks) throw new Error("the share board is not mounted");
  return boundChecks();
}

export function mount(app, { db, authUser, PORT, PUBLIC_ORIGIN }) {
  const pass = (name, detail) => ({ verdict: "pass", name, detail });
  const fail = (name, detail) => ({ verdict: "fail", name, detail });
  const skip = (name, detail) => ({ verdict: "skip", name, detail });

  // No cookie on purpose: these probe what an ANONYMOUS holder of a URL gets.
  async function probe(path, init) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
      return r.status;
    } catch { return 0; }
  }

  async function computeChecks() {
    const checks = [];
    const guarded = (name, fn) => {
      try { fn(); } catch (e) { checks.push(fail(name, "query failed: " + e.message)); }
    };

    // ── The doors ────────────────────────────────────────────────────────────
    //
    // A link is a bearer credential. Every one of these must refuse before it
    // reads a character's name, because the whole point of a share link is that
    // it travels through channels nobody controls.

    {
      const n = "looking at a share link demands an account";
      const st = await probe("/api/share/not-a-real-token-000000");
      checks.push(st === 401
        ? pass(n, "GET /api/share/:token with no session is refused (401) — an anonymous preview would put character names on a public host for anyone holding a URL")
        : fail(n, `expected 401, got ${st} — the preview route reads names and is answering strangers`));
    }

    {
      const n = "claiming a share link demands an account";
      const st = await probe("/api/share/not-a-real-token-000000/claim", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      checks.push(st === 401
        ? pass(n, "POST /api/share/:token/claim with no session is refused (401)")
        : fail(n, `expected 401, got ${st} — a grant could be made to nobody in particular`));
    }

    {
      const n = "the gallery is signed-in-only";
      const st = await probe("/api/gallery");
      checks.push(st === 401
        ? pass(n, "GET /api/gallery with no session is refused (401) — 'public' here means every signed-in account, never the open internet, because the media sits behind auth_request")
        : fail(n, `expected 401, got ${st} — the listing is answering the open internet, and its images are behind auth_request, so this is either a leak or a page of broken images`));
    }

    {
      const n = "adopting from the gallery demands an account";
      const st = await probe("/api/gallery/some-actor-id/adopt", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      checks.push(st === 401
        ? pass(n, "POST /api/gallery/:id/adopt with no session is refused (401)")
        : fail(n, `expected 401, got ${st} — the gallery grants nothing until adopted, and adoption is an act by a known person`));
    }

    // ── The cap: neither route may carry "copy" ──────────────────────────────
    //
    // The product rule, in its own words: ownership only ever crosses by an act
    // aimed at a KNOWN PERSON. A link is aimed at whoever holds the URL and a
    // listing is aimed at everybody, so neither can fork the character.

    guarded("a share link never grants copy", () => {
      const rows = db.prepare(
        `SELECT id, permission FROM actor_share_links WHERE permission NOT IN ('read','use')`).all();
      const total = db.prepare(`SELECT COUNT(*) c FROM actor_share_links`).get().c;
      if (total === 0) {
        checks.push(skip("a share link never grants copy",
          "no share links exist — zero rows cannot demonstrate the cap holds. The endpoint-level refusal is asserted by the probe above"));
      } else {
        checks.push(rows.length === 0
          ? pass("a share link never grants copy", `${total} link(s), none above 'use'`)
          : fail("a share link never grants copy",
              `${rows.length} of ${total} link(s) carry ${[...new Set(rows.map(r => r.permission))].join(", ")} — a link has no named recipient, so ownership must not cross it`));
      }
    });

    guarded("the gallery never offers copy", () => {
      const listed = db.prepare(`SELECT COUNT(*) c FROM actors WHERE visibility = 'public'`).get().c;
      if (listed === 0) {
        checks.push(skip("the gallery never offers copy", "nothing is listed in the gallery"));
      } else {
        const bad = db.prepare(
          `SELECT COUNT(*) c FROM actors WHERE visibility = 'public'
            AND published_permission IS NOT NULL AND published_permission NOT IN ('read','use')`).get().c;
        checks.push(bad === 0
          ? pass("the gallery never offers copy", `${listed} character(s) listed, none offering more than 'use'`)
          : fail("the gallery never offers copy",
              `${bad} of ${listed} listed character(s) publish a rung above 'use' — the adopt route re-validates at the point of grant, so this is a stored row that disagrees with the cap`));
      }
    });

    // ── The token is a secret ────────────────────────────────────────────────

    guarded("no share link stores a token it could hand back", () => {
      const total = db.prepare(`SELECT COUNT(*) c FROM actor_share_links`).get().c;
      if (total === 0) {
        checks.push(skip("no share link stores a token it could hand back", "no share links exist"));
      } else {
        // A sha256 hex digest, and nothing that is not one. A raw token stored
        // here would let anyone with DB read re-issue every live link.
        const bad = db.prepare(
          `SELECT COUNT(*) c FROM actor_share_links
            WHERE token_hash IS NULL OR length(token_hash) != 64 OR token_hash GLOB '*[^0-9a-f]*'`).get().c;
        checks.push(bad === 0
          ? pass("no share link stores a token it could hand back", `${total} link(s), every token_hash a 64-char sha256 digest`)
          : fail("no share link stores a token it could hand back",
              `${bad} of ${total} row(s) hold something that is not a sha256 digest — if that is the raw token, DB read is link re-issue`));
      }
    });

    guarded("every share link expires", () => {
      const total = db.prepare(`SELECT COUNT(*) c FROM actor_share_links`).get().c;
      if (total === 0) {
        checks.push(skip("every share link expires", "no share links exist"));
      } else {
        const bad = db.prepare(
          `SELECT COUNT(*) c FROM actor_share_links
            WHERE expires_at IS NULL OR expires_at = '' OR julianday(expires_at) IS NULL`).get().c;
        checks.push(bad === 0
          ? pass("every share link expires", `${total} link(s), each with a readable expiry`)
          : fail("every share link expires",
              `${bad} of ${total} link(s) carry no usable expiry — a bearer credential that never dies`));
      }
    });

    // ── Revocation actually revokes ──────────────────────────────────────────

    guarded("a revoked link leaves no live grant behind", () => {
      const revoked = db.prepare(`SELECT COUNT(*) c FROM actor_share_links WHERE revoked_at IS NOT NULL`).get().c;
      if (revoked === 0) {
        checks.push(skip("a revoked link leaves no live grant behind",
          "no link has been revoked — nothing to check. Revoking one is what would exercise this"));
      } else {
        const n = db.prepare(
          `SELECT COUNT(*) c FROM actor_shares s JOIN actor_share_links l ON l.id = s.via_link_id
            WHERE l.revoked_at IS NOT NULL`).get().c;
        checks.push(n === 0
          ? pass("a revoked link leaves no live grant behind", `${revoked} revoked link(s), none still granting access`)
          : fail("a revoked link leaves no live grant behind",
              `${n} grant(s) trace to a revoked link — revocation removed the door and left the people who walked through it inside`));
      }
    });

    guarded("a link never lets more people in than its seats", () => {
      const capped = db.prepare(`SELECT COUNT(*) c FROM actor_share_links WHERE max_claims IS NOT NULL`).get().c;
      if (capped === 0) {
        checks.push(skip("a link never lets more people in than its seats", "no link carries a seat limit"));
      } else {
        const n = db.prepare(
          `SELECT COUNT(*) c FROM actor_share_links WHERE max_claims IS NOT NULL AND claims_used > max_claims`).get().c;
        checks.push(n === 0
          ? pass("a link never lets more people in than its seats", `${capped} capped link(s), none over its limit`)
          : fail("a link never lets more people in than its seats",
              `${n} link(s) have claims_used above max_claims — the seat count is decorative`));
      }
    });

    // ── The grants themselves ────────────────────────────────────────────────

    guarded("no share points at a ghost", () => {
      const total = db.prepare(`SELECT COUNT(*) c FROM actor_shares`).get().c;
      if (total === 0) {
        checks.push(skip("no share points at a ghost", "nothing is shared with anyone"));
      } else {
        const n = db.prepare(
          `SELECT COUNT(*) c FROM actor_shares s
            LEFT JOIN actors a ON a.id = s.actor_id
            LEFT JOIN users  u ON u.id = s.shared_with_id
            LEFT JOIN users  o ON o.id = s.owner_id
            WHERE a.id IS NULL OR u.id IS NULL OR o.id IS NULL`).get().c;
        checks.push(n === 0
          ? pass("no share points at a ghost", `${total} grant(s), each joining a real character, owner and recipient`)
          : fail("no share points at a ghost",
              `${n} of ${total} grant(s) reference a character or account that no longer exists — a reissued id would inherit a stranger's access`));
      }
    });

    guarded("a share always names someone other than the owner", () => {
      const total = db.prepare(`SELECT COUNT(*) c FROM actor_shares`).get().c;
      if (total === 0) {
        checks.push(skip("a share always names someone other than the owner", "nothing is shared with anyone"));
      } else {
        const n = db.prepare(`SELECT COUNT(*) c FROM actor_shares WHERE shared_with_id = owner_id`).get().c;
        checks.push(n === 0
          ? pass("a share always names someone other than the owner", `${total} grant(s), none pointing back at the owner`)
          : fail("a share always names someone other than the owner",
              `${n} grant(s) share a character with the person who already owns it — both claim routes refuse this, so these came from somewhere else`));
      }
    });

    guarded("a claimed grant records how it was claimed", () => {
      const viaSomething = db.prepare(
        `SELECT COUNT(*) c FROM actor_shares WHERE via_link_id IS NOT NULL OR via_public = 1`).get().c;
      if (viaSomething === 0) {
        checks.push(skip("a claimed grant records how it was claimed",
          "no grant came from a link or the gallery — every share so far was made by name"));
      } else {
        const n = db.prepare(
          `SELECT COUNT(*) c FROM actor_shares s
            LEFT JOIN actor_share_links l ON l.id = s.via_link_id
            WHERE s.via_link_id IS NOT NULL AND l.id IS NULL`).get().c;
        checks.push(n === 0
          ? pass("a claimed grant records how it was claimed",
              `${viaSomething} grant(s) came by link or gallery, each still traceable to its source`)
          : fail("a claimed grant records how it was claimed",
              `${n} grant(s) name a via_link_id that no longer exists — revocation walks from the link to its claims, so an untraceable grant cannot be revoked`));
      }
    });

    return checks;
  }

  boundChecks = computeChecks;

  app.get("/api/test/share/checks", async (req, res) => {
    const user = authUser(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    res.json({ ok: true, checked_at: new Date().toISOString(), checks: await computeChecks() });
  });
}
