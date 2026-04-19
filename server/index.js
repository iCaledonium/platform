import express from "express";
import crypto from "crypto";
import { randomUUID } from "crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import db from "./db.js";

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/api/orgs/:org/members", (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.email,
           CASE WHEN t.enrolled_at IS NOT NULL THEN 1 ELSE 0 END as enrolled
    FROM users u
    LEFT JOIN user_totp_secrets t ON t.user_id = u.id
    WHERE u.status = 'active'
    ORDER BY u.name
  `).all();
  res.json(users);
});

app.post("/api/enroll/start", (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: "user_id required" });
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(user_id);
  if (!user) return res.status(404).json({ error: "user not found" });
  let row = db.prepare("SELECT * FROM user_totp_secrets WHERE user_id = ?").get(user_id);
  if (!row || row.enrolled_at) {
    const totp = new OTPAuth.TOTP({ issuer: "Anima", label: user.email, algorithm: "SHA1", digits: 6, period: 30 });
    const secret = totp.secret.base32;
    db.prepare(`INSERT OR REPLACE INTO user_totp_secrets (id, user_id, secret, enrolled_at, inserted_at, updated_at) VALUES (?, ?, ?, NULL, datetime('now'), datetime('now'))`).run(randomUUID(), user_id, secret);
    row = db.prepare("SELECT * FROM user_totp_secrets WHERE user_id = ?").get(user_id);
  }
  const totp = new OTPAuth.TOTP({ issuer: "Anima", label: user.email, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(row.secret) });
  QRCode.toDataURL(totp.toString(), { width: 280, margin: 2 }, (err, url) => {
    if (err) return res.status(500).json({ error: "qr generation failed" });
    res.json({ qr: url, email: user.email });
  });
});

app.post("/api/enroll/confirm", (req, res) => {
  const { user_id, code } = req.body;
  if (!user_id || !code) return res.status(400).json({ error: "user_id and code required" });
  const row = db.prepare("SELECT * FROM user_totp_secrets WHERE user_id = ?").get(user_id);
  if (!row) return res.status(404).json({ error: "no secret found" });
  const totp = new OTPAuth.TOTP({ issuer: "Anima", algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(row.secret) });
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return res.status(401).json({ error: "invalid code" });
  db.prepare(`UPDATE user_totp_secrets SET enrolled_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?`).run(user_id);
  res.json({ ok: true });
});

app.post("/api/auth/verify", (req, res) => {
  const { user_id, code } = req.body;
  if (!user_id || !code) return res.status(400).json({ error: "user_id and code required" });
  const row = db.prepare("SELECT * FROM user_totp_secrets WHERE user_id = ? AND enrolled_at IS NOT NULL").get(user_id);
  if (!row) return res.status(403).json({ error: "not enrolled" });
  const totp = new OTPAuth.TOTP({ issuer: "Anima", algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(row.secret) });
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return res.status(401).json({ error: "invalid code" });
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO auth_tokens (id, user_id, token_hash, expires_at, inserted_at) VALUES (?, ?, ?, ?, datetime('now'))`).run(randomUUID(), user_id, hash, expires);
  res.setHeader("Set-Cookie", `anima_token=${raw}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=28800`);
  // Push presence online to simulator
  const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? LIMIT 1`).get(user_id);
  if (membership) {
    fetch(`${SIMULATOR_URL}/internal/presence/${membership.actor_id}`, {
      method: "POST",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "online" })
    }).catch(() => {});
  }
  res.json({ ok: true });
});

app.get("/api/auth/check", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).end();
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const row = db.prepare(`SELECT id FROM auth_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')`).get(hash);
  if (!row) return res.status(401).end();
  res.status(200).end();
});

app.get("/api/me", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const row = db.prepare(`
    SELECT u.id, u.name, u.email FROM auth_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')
  `).get(hash);
  if (!row) return res.status(401).json({ error: "not authenticated" });
  const worlds = db.prepare(`SELECT world_id, actor_id, role FROM world_memberships WHERE user_id = ?`).all(row.id);
  res.json({ id: row.id, name: row.name, email: row.email, worlds });
});

// ── POST /api/auth/signout ───────────────────────────────────────────────────
app.post("/api/auth/signout", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (match) {
    const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
    const token = db.prepare(`SELECT user_id FROM auth_tokens WHERE token_hash = ?`).get(hash);
    db.prepare(`UPDATE auth_tokens SET revoked_at = datetime('now') WHERE token_hash = ?`).run(hash);
    // Push presence offline to simulator
    if (token) {
      const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? LIMIT 1`).get(token.user_id);
      if (membership) {
        fetch(`${SIMULATOR_URL}/internal/presence/${membership.actor_id}`, {
          method: "POST",
          headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ status: "offline" })
        }).catch(() => {});
      }
    }
  }
  res.setHeader("Set-Cookie", "anima_token=; Path=/; Max-Age=0; SameSite=None; Secure");
  res.json({ ok: true });
});

const SIMULATOR_URL = "http://localhost:4000";
const SERVICE_TOKEN = process.env.PLATFORM_SERVICE_TOKEN || "";

async function simFetch(path, method = "GET") {
  const res = await fetch(`${SIMULATOR_URL}${path}`, { method, headers: { "X-Service-Token": SERVICE_TOKEN } });
  return res.json();
}

app.get("/api/worlds/:id/status", async (req, res) => {
  try { res.json(await simFetch(`/internal/worlds/${req.params.id}/status`)); }
  catch { res.status(502).json({ error: "simulator unreachable" }); }
});

app.post("/api/worlds/:id/start", async (req, res) => {
  try { res.json(await simFetch(`/internal/worlds/${req.params.id}/start`, "POST")); }
  catch { res.status(502).json({ error: "simulator unreachable" }); }
});

app.post("/api/worlds/:id/stop", async (req, res) => {
  try { res.json(await simFetch(`/internal/worlds/${req.params.id}/stop`, "POST")); }
  catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/keys ─────────────────────────────────────────────────────────────
app.get("/api/keys", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const keys = db.prepare(`SELECT id, name, world_id, key_prefix, scopes, last_used_at, inserted_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY inserted_at DESC`).all(user.id);
  res.json(keys.map(k => ({ ...k, scopes: JSON.parse(k.scopes) })));
});

// ── POST /api/keys  { name, world_id, scopes[] } ──────────────────────────────
app.post("/api/keys", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const { name, world_id, scopes } = req.body;
  if (!name || !world_id || !scopes?.length) return res.status(400).json({ error: "name, world_id, scopes required" });
  const raw = `sk-an-${crypto.randomBytes(32).toString("hex")}`;
  const keyHash = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 12) + "••••••••" + raw.slice(-4);
  db.prepare(`INSERT INTO api_keys (id, user_id, world_id, name, key_hash, key_prefix, scopes, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`).run(randomUUID(), user.id, world_id, name, keyHash, prefix, JSON.stringify(scopes));
  res.json({ key: raw, prefix });
});

// ── DELETE /api/keys/:id ───────────────────────────────────────────────────────
app.delete("/api/keys/:id", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  db.prepare(`UPDATE api_keys SET revoked_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(req.params.id, user.id);
  res.json({ ok: true });
});

// ── GET /api/apps ─────────────────────────────────────────────────────────────
app.get("/api/apps", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const apps = db.prepare(`
    SELECT r.id, r.name, r.tool_type, r.world_id, r.actor_id, r.api_key_id, r.inserted_at,
           r.url, r.built_by, r.contact_ids, k.key_prefix, k.scopes
    FROM registered_tools r
    JOIN api_keys k ON k.id = r.api_key_id
    WHERE r.user_id = ?
    ORDER BY r.inserted_at DESC
  `).all(user.id);
  res.json(apps.map(a => ({ ...a, scopes: JSON.parse(a.scopes), contact_ids: JSON.parse(a.contact_ids || '[]') })));
});

// ── POST /api/apps  { name, tool_type, world_id, actor_id, api_key_id, url?, built_by? } ───
app.post("/api/apps", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const { name, tool_type, world_id, actor_id, api_key_id, url, built_by, contact_ids } = req.body;
  if (!name || !tool_type || !world_id || !actor_id || !api_key_id) return res.status(400).json({ error: "all fields required" });
  const key = db.prepare(`SELECT id FROM api_keys WHERE id = ? AND user_id = ? AND revoked_at IS NULL`).get(api_key_id, user.id);
  if (!key) return res.status(403).json({ error: "invalid api key" });
  const id = randomUUID();
  db.prepare(`INSERT INTO registered_tools (id, user_id, world_id, actor_id, api_key_id, tool_type, name, url, built_by, contact_ids, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`).run(id, user.id, world_id, actor_id, api_key_id, tool_type, name, url || null, built_by || "anima", JSON.stringify(contact_ids || []));
  res.json({ id, name, tool_type, url, built_by: built_by || "anima" });
});

// ── PATCH /api/apps/:id  { contact_ids } ──────────────────────────────────────
app.patch("/api/apps/:id", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const { contact_ids } = req.body;
  if (!contact_ids) return res.status(400).json({ error: "contact_ids required" });
  db.prepare(`UPDATE registered_tools SET contact_ids = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(JSON.stringify(contact_ids), req.params.id, user.id);
  res.json({ ok: true });
});

// ── DELETE /api/apps/:id ───────────────────────────────────────────────────────
app.delete("/api/apps/:id", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  db.prepare(`DELETE FROM registered_tools WHERE id = ? AND user_id = ?`).run(req.params.id, user.id);
  res.json({ ok: true });
});

// ── GET /api/worlds/:world_id/actors/:actor_id/contacts ───────────────────────
app.get("/api/worlds/:world_id/actors/:actor_id/contacts", async (req, res) => {
  try {
    const data = await simFetch(`/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/contacts`);
    res.json(data);
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/actors/:actor_id/messages/:contact_id ───────────
app.get("/api/worlds/:world_id/actors/:actor_id/messages/:contact_id", async (req, res) => {
  try {
    const data = await simFetch(`/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/messages/${req.params.contact_id}`);
    res.json(data);
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/actors/:actor_id/context/:contact_id ────────────
app.get("/api/worlds/:world_id/actors/:actor_id/context/:contact_id", async (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "unauthorized" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')`).get(hash);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  try {
    const data = await simFetch(`/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/context/${req.params.contact_id}`);
    res.json(data);
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/actors/:actor_id/messages/:contact_id ──────────
app.post("/api/worlds/:world_id/actors/:actor_id/messages/:contact_id", async (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  let visibility = "private"; // safe default
  if (match) {
    const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
    const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')`).get(hash);
    if (user) {
      const app = db.prepare(`SELECT contact_ids FROM registered_tools WHERE user_id = ? AND world_id = ? AND tool_type != 'custom' ORDER BY inserted_at DESC LIMIT 1`).get(user.id, req.params.world_id);
      if (app) {
        const contacts = JSON.parse(app.contact_ids || "[]");
        const contact = contacts.find(c => c.id === req.params.contact_id);
        if (contact) visibility = contact.privacy || "private";
      }
    }
  }
  try {
    const resp = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/messages/${req.params.contact_id}`, {
      method: "POST",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ ...req.body, visibility }),
    });
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/viewer-token?world_id= ───────────────────────────────────────────
app.get("/api/viewer-token", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`
    SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')
  `).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });

  const { world_id } = req.query;
  if (!world_id) return res.status(400).json({ error: "world_id required" });

  const membership = db.prepare(`
    SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?
  `).get(user.id, world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });

  const payload = JSON.stringify({
    actor_id: membership.actor_id,
    world_id,
    exp: Math.floor(Date.now() / 1000) + 300, // 5 min TTL
  });
  const b64 = Buffer.from(payload).toString("base64url");
  const sig  = crypto.createHmac("sha256", SERVICE_TOKEN).update(b64).digest("hex");
  res.json({ token: `${b64}.${sig}` });
});

// ── Notification helpers ──────────────────────────────────────────────────────
function getAuthUser(req) {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return null;
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  return db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')`).get(hash) || null;
}

// ── GET /api/notifications ────────────────────────────────────────────────────
app.get("/api/notifications", (req, res) => {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const notifs = db.prepare(`
    SELECT id, sender_actor_id, sender_name, content, app_id, read_at, inserted_at,
           conversation_type, sender_actor_type
    FROM notifications
    WHERE user_id = ? AND cleared_at IS NULL
    ORDER BY inserted_at DESC
    LIMIT 100
  `).all(user.id);

  const CONV_TO_TOOL = {
    text_thread:   "messages",
    voice_message: "voice",
    email_thread:  "email",
    call:          "voice",
    video_call:    "video",
  };

  // Get all installed tool types for this user
  const installedTools = new Set(
    db.prepare(`SELECT DISTINCT tool_type FROM registered_tools WHERE user_id = ? AND built_by = 'anima'`).all(user.id).map(r => r.tool_type)
  );

  const enriched = notifs.map(n => ({
    ...n,
    has_app: installedTools.has(CONV_TO_TOOL[n.conversation_type] || "messages"),
  }));

  res.json(enriched);
});

// ── PATCH /api/notifications/:id/read ────────────────────────────────────────
app.patch("/api/notifications/:id/read", (req, res) => {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ? AND read_at IS NULL`).run(req.params.id, user.id);
  res.json({ ok: true });
});

// ── DELETE /api/notifications/:id ────────────────────────────────────────────
app.delete("/api/notifications/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  db.prepare(`UPDATE notifications SET cleared_at = datetime('now') WHERE id = ? AND user_id = ?`).run(req.params.id, user.id);
  res.json({ ok: true });
});

// ── DELETE /api/notifications ─────────────────────────────────────────────────
app.delete("/api/notifications", (req, res) => {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  db.prepare(`UPDATE notifications SET cleared_at = datetime('now') WHERE user_id = ? AND cleared_at IS NULL`).run(user.id);
  res.json({ ok: true });
});

// ── GET /api/pending-messages ─────────────────────────────────────────────────
// Returns count of unread inbox messages for the user's actor
app.get("/api/pending-messages", async (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ count: 0 });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')`).get(hash);
  if (!user) return res.status(401).json({ count: 0 });
  const membership = db.prepare(`SELECT actor_id, world_id FROM world_memberships WHERE user_id = ? LIMIT 1`).get(user.id);
  if (!membership) return res.json({ count: 0 });
  try {
    const data = await simFetch(`/internal/worlds/${membership.world_id}/actors/${membership.actor_id}/unread-count`);
    res.json(data);
  } catch { res.json({ count: 0 }); }
});

// ── GET /api/stream — SSE proxy ───────────────────────────────────────────────
app.get("/api/stream", async (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).end();
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`SELECT u.id, u.name FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')`).get(hash);
  if (!user) return res.status(401).end();

  const membership = db.prepare(`SELECT actor_id, world_id FROM world_memberships WHERE user_id = ? LIMIT 1`).get(user.id);
  if (!membership) return res.status(403).end();

  const { actor_id, world_id } = membership;

  // Load this user's contact privacy settings
  const appRow = db.prepare(`SELECT contact_ids FROM registered_tools WHERE user_id = ? AND world_id = ? AND tool_type != 'custom' ORDER BY inserted_at DESC LIMIT 1`).get(user.id, world_id);
  const contactIds = appRow ? JSON.parse(appRow.contact_ids || "[]") : [];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: "connected", actor_id })}\n\n`);

  // Connect to simulator SSE stream
  let simRes;
  try {
    simRes = await fetch(`${SIMULATOR_URL}/internal/actors/${actor_id}/stream`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
    });
  } catch {
    res.write(`data: ${JSON.stringify({ type: "error", message: "simulator unreachable" })}\n\n`);
    return res.end();
  }

  const reader = simRes.body.getReader();
  const decoder = new TextDecoder();

  req.on("close", () => { reader.cancel(); });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);

      // Parse SSE lines from simulator
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          if (payload.type === "new_message") {
            // Conversation type → tool type mapping
            const CONV_TO_TOOL = {
              text_thread:   "messages",
              voice_message: "voice",
              email_thread:  "email",
              call:          "voice",
              video_call:    "video",
            };
            const convType = payload.conversation_type || "text_thread";
            const toolType = CONV_TO_TOOL[convType] || "messages";

            // Check privacy
            const contact = contactIds.find(c => c.id === payload.sender_id);
            const privacy = contact?.privacy || "private";

            // Find matching installed app
            const app = db.prepare(`SELECT id FROM registered_tools WHERE user_id = ? AND world_id = ? AND tool_type = ? LIMIT 1`).get(user.id, world_id, toolType);
            const hasApp = !!app;

            // Deduplicate by message_id
            const existing = db.prepare(`SELECT id FROM notifications WHERE user_id = ? AND message_id = ? LIMIT 1`).get(user.id, payload.message_id);

            let notifId;
            if (!existing) {
              notifId = crypto.randomUUID();
              db.prepare(`INSERT OR IGNORE INTO notifications (id, user_id, world_id, sender_actor_id, sender_name, content, app_id, message_id, conversation_type, sender_actor_type, inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
                .run(notifId, user.id, world_id, payload.sender_id, payload.sender_name, payload.content, app?.id || null, payload.message_id || null, convType, payload.sender_actor_type || null);
            } else {
              notifId = existing.id;
            }

            res.write(`data: ${JSON.stringify({ ...payload, privacy, notif_id: notifId, conv_type: convType, tool_type: toolType, has_app: hasApp })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          }
        } catch { /* skip malformed lines */ }
      }
    }
  } catch { /* client disconnected */ }

  res.end();
});

const PORT = 4002;
app.listen(PORT, () => console.log(`Platform API running on :${PORT}`));
