import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import crypto from "crypto";
import { randomUUID } from "crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import path from "path";
import { fileURLToPath } from "url";
import db from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ── GET /api/users — org members for share picker ────────────────────────────
app.get("/api/users", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const users = db.prepare(`SELECT id, name, email FROM users WHERE id != ? AND status = 'active' ORDER BY name`).all(user.id);
  res.json(users);
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

// ── GET /api/worlds ───────────────────────────────────────────────────────────
app.get("/api/worlds", async (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const user = db.prepare(`
    SELECT u.id FROM auth_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')
  `).get(hash);
  if (!user) return res.status(401).json({ error: "not authenticated" });

  const memberships = db.prepare(`
    SELECT world_id, actor_id, role FROM world_memberships WHERE user_id = ?
  `).all(user.id);

  if (memberships.length === 0) return res.json([]);

  const ids = memberships.map(m => m.world_id).join(",");
  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/worlds?ids=${ids}`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
    });
    const worlds = await simRes.json();
    // Merge simulator metadata with platform role/actor
    const membershipMap = Object.fromEntries(memberships.map(m => [m.world_id, m]));
    const enriched = worlds.map(w => ({
      ...w,
      role:     membershipMap[w.id]?.role,
      actor_id: membershipMap[w.id]?.actor_id,
    }));
    res.json(enriched);
  } catch {
    res.status(502).json({ error: "simulator unreachable" });
  }
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

const SIMULATOR_URL = "http://192.168.1.58:4000";
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
            const convType = payload.conversation_type || (
              payload.message_type === "call_request"  ? "call_request"  :
              payload.message_type === "voice_message" ? "voice_message" :
              payload.message_type === "email"         ? "email_thread"  :
              "text_thread"
            );
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

// ── GET /api/actors/:id/shares ────────────────────────────────────────────────
app.get("/api/actors/:id/shares", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const shares = db.prepare(`
    SELECT s.id, s.shared_with_id, s.permission, s.inserted_at, u.name, u.email
    FROM actor_shares s JOIN users u ON u.id = s.shared_with_id
    WHERE s.actor_id = ?
    ORDER BY s.inserted_at
  `).all(req.params.id);
  res.json(shares);
});

// ── POST /api/actors/:id/shares ───────────────────────────────────────────────
app.post("/api/actors/:id/shares", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const { email, permission = "read" } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  const target = db.prepare(`SELECT id, name FROM users WHERE email = ?`).get(email);
  if (!target) return res.status(404).json({ error: "user not found" });
  if (target.id === user.id) return res.status(400).json({ error: "cannot share with yourself" });
  const now = new Date().toISOString();
  try {
    db.prepare(`INSERT INTO actor_shares (id, actor_id, owner_id, shared_with_id, shared_with_type, permission, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), req.params.id, user.id, target.id, "user", permission, now, now);
    res.json({ ok: true, name: target.name, shared_with_id: target.id, permission });
  } catch (e) {
    if (e.message?.includes("UNIQUE")) return res.status(409).json({ error: "already shared" });
    throw e;
  }
});

// ── DELETE /api/actors/:id/shares/:shared_with_id ─────────────────────────────
app.delete("/api/actors/:id/shares/:shared_with_id", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  db.prepare(`DELETE FROM actor_shares WHERE actor_id = ? AND shared_with_id = ? AND owner_id = ?`)
    .run(req.params.id, req.params.shared_with_id, user.id);
  res.json({ ok: true });
});

// ── Update actors gallery to include shared actors ────────────────────────────
app.get("/api/actors/shared", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actors = db.prepare(`
    SELECT a.id, a.name, a.age, a.gender, a.occupation, a.status,
           p.attachment_style, b.openness, b.neuroticism, s.permission,
           (SELECT url FROM actor_media WHERE actor_id = a.id AND media_type = 'photo' AND state_slug IN ('photo_close','profile') LIMIT 1) as photo_url
    FROM actor_shares s
    JOIN actors a ON a.id = s.actor_id
    LEFT JOIN actor_psychology p ON p.actor_id = a.id
    LEFT JOIN actor_big5 b ON b.actor_id = a.id
    WHERE s.shared_with_id = ?
    ORDER BY a.name
  `).all(user.id);
  res.json(actors);
});
app.get("/api/actors/:id/media", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const media = db.prepare(`SELECT * FROM actor_media WHERE actor_id = ? ORDER BY media_type, inserted_at`).all(req.params.id);
  res.json(media);
});

// ── GET /api/actors/:id/worlds — worlds this actor is running in ──────────────
app.get("/api/actors/:id/worlds", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { id } = req.params;
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND (owner_id = ? OR id IN (SELECT actor_id FROM actor_shares WHERE shared_with_id = ?))`).get(id, user.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/actor-worlds/${id}`, {
      headers: { "X-Service-Token": SERVICE_TOKEN }
    });
    if (!simRes.ok) return res.json([]);
    const data = await simRes.json();
    res.json(data);
  } catch {
    res.json([]);
  }
});

// ── Static media ─────────────────────────────────────────────────────────────
app.use("/media", express.static(path.join(__dirname, "../public/media")));

const PORT = 4002;
// ── Simulator proxies ─────────────────────────────────────────────────────────
// ── Simulator proxies — each route gets its own instance (v2 requirement) ─────
const SIM = "http://192.168.1.58:4000";

// /sim/* — LiveView pages
app.use("/sim", createProxyMiddleware({ target: SIM, changeOrigin: true, ws: true, pathRewrite: { "^/sim": "" } }));

// /js — LiveView JS assets
app.use("/js", createProxyMiddleware({ target: SIM, changeOrigin: true }));

// /assets/* — proxy simulator assets if not in platform dist
app.use("/assets", (req, res, next) => {
  const localPath = path.join(__dirname, "../dist/assets", path.basename(req.path));
  if (!fs.existsSync(localPath)) return createProxyMiddleware({ target: SIM, changeOrigin: true })(req, res, next);
  next();
});

// /live — LiveView WebSocket
app.use("/live", createProxyMiddleware({ target: SIM, changeOrigin: true, ws: true }));

// /phoenix — Phoenix channels WebSocket
app.use("/phoenix", createProxyMiddleware({ target: SIM, changeOrigin: true, ws: true }));

// Create HTTP server explicitly so WebSocket upgrades can be forwarded
import { createServer } from "http";
const server = createServer(app);

// Attach WebSocket upgrade handlers for LiveView
const liveWsProxy  = createProxyMiddleware({ target: SIM, changeOrigin: true, ws: true });
const simPageProxy = createProxyMiddleware({ target: SIM, changeOrigin: true, ws: true, pathRewrite: { "^/sim": "" } });

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/live")) {
    liveWsProxy.upgrade(req, socket, head);
  } else if (req.url.startsWith("/sim")) {
    simPageProxy.upgrade(req, socket, head);
  } else if (req.url.startsWith("/phoenix")) {
    liveWsProxy.upgrade(req, socket, head);
  }
});

server.listen(PORT, () => console.log(`Platform API running on :${PORT}`));

// ── GET /api/actors — list canonical actors owned by or shared with the user ─
app.get("/api/actors", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actors = db.prepare(`
    SELECT a.id, a.name, a.age, a.gender, a.occupation, a.status,
           p.attachment_style, b.openness, b.conscientiousness, b.extraversion, b.agreeableness, b.neuroticism,
           (SELECT url FROM actor_media WHERE actor_id = a.id AND media_type = 'photo' AND state_slug IN ('photo_close','profile') LIMIT 1) as photo_url
    FROM actors a
    LEFT JOIN actor_psychology p ON p.actor_id = a.id
    LEFT JOIN actor_big5 b ON b.actor_id = a.id
    WHERE a.owner_id = ?
    ORDER BY a.name
  `).all(user.id);
  res.json(actors);
});

// ── GET /api/actors/:id — full canonical profile ──────────────────────────────
app.get("/api/actors/:id", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { id } = req.params;

  // Allow owner or anyone with a share
  let actor = db.prepare(`SELECT a.*, (SELECT url FROM actor_media WHERE actor_id = a.id AND media_type = 'photo' AND state_slug IN ('photo_close','profile') LIMIT 1) as photo_url FROM actors a WHERE a.id = ? AND a.owner_id = ?`).get(id, user.id);
  if (!actor) {
    const share = db.prepare(`SELECT permission FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(id, user.id);
    if (!share) return res.status(404).json({ error: "not found" });
    actor = db.prepare(`SELECT a.*, (SELECT url FROM actor_media WHERE actor_id = a.id AND media_type = 'photo' AND state_slug IN ('photo_close','profile') LIMIT 1) as photo_url, ? as permission FROM actors a WHERE a.id = ?`).get(share.permission, id);
    if (!actor) return res.status(404).json({ error: "not found" });
  }

  const psychology = db.prepare(`SELECT * FROM actor_psychology WHERE actor_id = ?`).get(id);
  const big5       = db.prepare(`SELECT * FROM actor_big5 WHERE actor_id = ?`).get(id);
  const disc       = db.prepare(`SELECT * FROM actor_disc WHERE actor_id = ?`).get(id);
  const hds        = db.prepare(`SELECT * FROM actor_hds WHERE actor_id = ?`).get(id);
  const lifestyle  = db.prepare(`SELECT * FROM actor_lifestyle WHERE actor_id = ?`).get(id);
  const economic   = db.prepare(`SELECT * FROM actor_economic WHERE actor_id = ?`).get(id);
  const mental     = db.prepare(`SELECT * FROM actor_mental_health WHERE actor_id = ?`).get(id);
  const upbringing = db.prepare(`SELECT * FROM actor_upbringing WHERE actor_id = ?`).get(id);
  const education  = db.prepare(`SELECT * FROM actor_education WHERE actor_id = ? ORDER BY inserted_at`).all(id);
  const diagnoses  = db.prepare(`SELECT * FROM actor_diagnoses WHERE actor_id = ? ORDER BY inserted_at`).all(id);
  const expenses   = db.prepare(`SELECT * FROM actor_expense_defaults WHERE actor_id = ? ORDER BY name`).all(id);

  res.json({ actor, psychology, big5, disc, hds, lifestyle, economic, mental, upbringing, education, diagnoses, expenses });
});

// ── PUT /api/actors/:id — update canonical profile ────────────────────────────
app.put("/api/actors/:id", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { id } = req.params;
  const { section, data } = req.body;

  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });

  const now = new Date().toISOString();

  const TABLES = {
    actor:      { table: "actors",            pk: "id" },
    psychology: { table: "actor_psychology",  pk: "actor_id" },
    big5:       { table: "actor_big5",        pk: "actor_id" },
    disc:       { table: "actor_disc",        pk: "actor_id" },
    hds:        { table: "actor_hds",         pk: "actor_id" },
    lifestyle:  { table: "actor_lifestyle",   pk: "actor_id" },
    economic:   { table: "actor_economic",    pk: "actor_id" },
    mental:     { table: "actor_mental_health", pk: "actor_id" },
    upbringing: { table: "actor_upbringing",  pk: "actor_id" },
  };

  const target = TABLES[section];
  if (!target) return res.status(400).json({ error: "unknown section" });

  const fields = Object.keys(data).filter(k => k !== target.pk && k !== "inserted_at");
  const sets   = fields.map(f => `${f} = ?`).join(", ");
  const values = fields.map(f => data[f]);

  db.prepare(`UPDATE ${target.table} SET ${sets}, updated_at = ? WHERE ${target.pk} = ?`)
    .run(...values, now, id);

  res.json({ ok: true });
});

// ── Helper: auth from cookie ──────────────────────────────────────────────────
function authUser(req) {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return null;
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  return db.prepare(`SELECT u.id, u.name FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')`).get(hash);
}


// ── POST /api/worlds/:world_id/meetings/confirm ───────────────────────────────
// Player accepts a meetup proposal — writes PlannedMeeting on simulator,
// Amber's engine fires the meeting when scheduled_at is reached.
app.post("/api/worlds/:world_id/meetings/confirm", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  try {
    const resp = await fetch(`${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/meetings/confirm`, {
      method: "POST",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/actors/:actor_id/messages/:contact_id/respond/:msg_id
// Marks a proposal message as responded on the simulator.
app.post("/api/worlds/:world_id/actors/:actor_id/messages/:contact_id/respond/:msg_id", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  try {
    const resp = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/messages/${req.params.contact_id}/respond/${req.params.msg_id}`,
      { method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/actors/:actor_id/calendar ──────────────────────
// Returns today's schedule slots + upcoming confirmed planned meetings.
app.get("/api/worlds/:world_id/actors/:actor_id/calendar", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  try {
    const data = await simFetch(`/internal/worlds/${req.params.world_id}/actors/${req.params.actor_id}/calendar`);
    res.json(data);
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});


// ── GET /api/worlds/:world_id/presence ───────────────────────────────────────
app.get("/api/worlds/:world_id/presence", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  try {
    const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ? LIMIT 1`).get(user.id, req.params.world_id);
    const playerActorId = membership?.actor_id || "";
    res.json(await simFetch(`/internal/worlds/${req.params.world_id}/presence?player_actor_id=${playerActorId}`));
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/spawn ─────────────────────────────────────────
app.post("/api/worlds/:world_id/spawn", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const { world_id } = req.params;
  const { location_id } = req.body;
  if (!location_id) return res.status(400).json({ error: "location_id required" });
  const membership = db.prepare(
    `SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`
  ).get(user.id, world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });
  try {
    const resp = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${world_id}/player/${membership.actor_id}/spawn`,
      {
        method:  "POST",
        headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
        body:    JSON.stringify({ location_id }),
      }
    );
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/actors/:actor_id/stream — SSE proxy ─────────────────────────────
app.get("/api/actors/:actor_id/stream", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).end();
  const { actor_id } = req.params;
  const membership = db.prepare(
    `SELECT actor_id FROM world_memberships WHERE user_id = ? AND actor_id = ?`
  ).get(user.id, actor_id);
  if (!membership) return res.status(403).end();
  try {
    const simResp = await fetch(
      `${SIMULATOR_URL}/internal/actors/${actor_id}/stream`,
      { headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    res.setHeader("Content-Type",      "text/event-stream");
    res.setHeader("Cache-Control",     "no-cache");
    res.setHeader("Connection",        "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const reader = simResp.body.getReader();
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch {}
      res.end();
    };
    pump();
    req.on("close", () => { try { reader.cancel(); } catch {} });
  } catch { res.status(502).end(); }
});

// ── POST /api/worlds/:world_id/encounter/start ───────────────────────────────
app.post("/api/worlds/:world_id/encounter/start", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const { world_id } = req.params;
  const membership = db.prepare(
    `SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`
  ).get(user.id, world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });
  const { target_actor_id, location_id, trigger } = req.body;
  try {
    const resp = await fetch(`${SIMULATOR_URL}/internal/worlds/${world_id}/encounter/start`, {
      method:  "POST",
      headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
      body:    JSON.stringify({
        trigger:         trigger || "knock",
        target_actor_id: target_actor_id,
        player_actor_id: membership.actor_id,
        location_id:     location_id
      })
    });
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/encounter/:encounter_id/end ────────────────────
app.post("/api/worlds/:world_id/encounter/:encounter_id/end", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  try {
    const resp = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/encounter/${req.params.encounter_id}/end`,
      { method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/worlds/:world_id/encounter/:encounter_id ─────────────────────────
app.get("/api/worlds/:world_id/encounter/:encounter_id", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  try {
    res.json(await simFetch(
      `/internal/worlds/${req.params.world_id}/encounter/${req.params.encounter_id}`
    ));
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/encounter/:encounter_id/enter ─────────────────
app.post("/api/worlds/:world_id/encounter/:encounter_id/enter", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  try {
    const resp = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/encounter/${req.params.encounter_id}/enter`,
      { method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/encounter/:encounter_id/message ────────────────
app.post("/api/worlds/:world_id/encounter/:encounter_id/message", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: "content required" });
  try {
    const resp = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/encounter/${req.params.encounter_id}/message`,
      {
        method:  "POST",
        headers: { "X-Service-Token": SERVICE_TOKEN, "Content-Type": "application/json" },
        body:    JSON.stringify({ content })
      }
    );
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── POST /api/worlds/:world_id/encounter/:encounter_id/typing ─────────────────
app.post("/api/worlds/:world_id/encounter/:encounter_id/typing", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  try {
    fetch(
      `${SIMULATOR_URL}/internal/worlds/${req.params.world_id}/encounter/${req.params.encounter_id}/typing`,
      { method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN } }
    ).catch(() => {});
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// ── POST /api/worlds/:world_id/leave — clear player location ─────────────────
app.post("/api/worlds/:world_id/leave", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const { world_id } = req.params;
  const membership = db.prepare(
    `SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`
  ).get(user.id, world_id);
  if (!membership) return res.status(403).json({ error: "not a member of this world" });
  try {
    const resp = await fetch(
      `${SIMULATOR_URL}/internal/worlds/${world_id}/player/${membership.actor_id}/leave`,
      { method: "POST", headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    res.json(await resp.json());
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/encounter/model-status — which LLM is active ────────────────────
app.get("/api/encounter/model-status", async (_req, res) => {
  try {
    const r = await fetch("http://212.147.242.70:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      const has70b = d?.models?.some(m => m.name?.includes("hermes3:70b"));
      return res.json({ model: has70b ? "Hermes-3-70B" : "Haiku" });
    }
  } catch {}
  res.json({ model: "Haiku" });
});

// ── GET /api/places/:place_id/photos — venue photos list ─────────────────────
app.get("/api/places/:place_id/photos", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "not authenticated" });
  const { place_id } = req.params;
  if (!/^[a-zA-Z0-9_\-]+$/.test(place_id)) return res.status(400).end();
  try {
    res.json(await simFetch(`/internal/places/${place_id}/photos`));
  } catch { res.status(502).json({ error: "simulator unreachable" }); }
});

// ── GET /api/places/:place_id/photo — venue photo proxy ──────────────────────
app.get("/api/places/:place_id/photo", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).end();
  const { place_id } = req.params;
  if (!/^[a-zA-Z0-9_\-]+$/.test(place_id)) return res.status(400).end();
  try {
    const simResp = await fetch(
      `${SIMULATOR_URL}/internal/places/${place_id}/photo`,
      { headers: { "X-Service-Token": SERVICE_TOKEN } }
    );
    if (!simResp.ok) return res.status(simResp.status).end();
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buf = await simResp.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch { res.status(502).end(); }
});

// ── Serve React SPA ───────────────────────────────────────────────────────────
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const fs = _require("fs");


const distPath = path.join(__dirname, "../dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/assets/")) { return res.status(404).end(); }
    if (!req.path.startsWith("/api") && !req.path.startsWith("/media")) {
      res.sendFile(path.join(distPath, "index.html"));
    }
  });
}

