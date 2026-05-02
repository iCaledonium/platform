import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import crypto from "crypto";
import { randomUUID } from "crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import db from "./db.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100mb for videos

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
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
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO auth_tokens (id, user_id, token_hash, expires_at, inserted_at) VALUES (?, ?, ?, ?, datetime('now'))`).run(randomUUID(), user_id, hash, expires);
  res.setHeader("Set-Cookie", `anima_token=${raw}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=2592000`);
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

// ── GET /api/orgs/:org/members — login page user list (unauthenticated, safe — no sensitive data) ─
app.get("/api/orgs/:org/members", (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.photo_url,
           CASE WHEN t.enrolled_at IS NOT NULL THEN 1 ELSE 0 END as enrolled
    FROM users u
    LEFT JOIN user_totp_secrets t ON t.user_id = u.id
    WHERE u.status = 'active'
    ORDER BY u.name
  `).all();
  res.json(users);
});

// ── GET /api/users — org members for share picker ────────────────────────────
app.get("/api/users", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const users = db.prepare(`SELECT id, name, email, photo_url FROM users WHERE status = 'active' ORDER BY name`).all();
  res.json(users);
});

// ── POST /api/users/me/photo — upload profile photo for current user ──────────
app.post("/api/users/me/photo", upload.single("photo"), async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  if (!req.file) return res.status(400).json({ error: "no file uploaded" });

  const ext      = path.extname(req.file.originalname || "photo.jpg") || ".jpg";
  const filename = `photo${ext}`;
  const userDir  = path.join(__dirname, "../public/media/users", user.id);

  const { mkdirSync, writeFileSync } = await import("fs");
  mkdirSync(userDir, { recursive: true });
  writeFileSync(path.join(userDir, filename), req.file.buffer);

  try {
    const sharp = (await import("sharp")).default;
    await sharp(req.file.buffer).resize(200, 200, { fit:"cover" }).jpeg({ quality:82 }).toFile(path.join(userDir, "thumb_photo.jpg"));
  } catch {}

  const url = `/media/users/${user.id}/${filename}`;
  const now = new Date().toISOString();
  db.prepare(`UPDATE users SET photo_url = ?, updated_at = ? WHERE id = ?`).run(url, now, user.id);

  res.json({ url });
});

app.get("/api/me", (req, res) => {
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/anima_token=([a-f0-9]+)/);
  if (!match) return res.status(401).json({ error: "not authenticated" });
  const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
  const row = db.prepare(`
    SELECT u.id, u.name, u.email, u.photo_url FROM auth_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > datetime('now')
  `).get(hash);
  if (!row) return res.status(401).json({ error: "not authenticated" });
  const worlds = db.prepare(`SELECT world_id, actor_id, role FROM world_memberships WHERE user_id = ?`).all(row.id);
  res.json({ id: row.id, name: row.name, email: row.email, photo_url: row.photo_url, worlds });
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
// ── POST /api/actors/:id/media — upload tagged photo ─────────────────────────
app.post("/api/actors/:id/media", upload.fields([{name:"photo",maxCount:1},{name:"audio",maxCount:1}]), async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });

  const req_file = req.files?.photo?.[0] || req.files?.audio?.[0] || req.file;
  if (!req_file) return res.status(400).json({ error: "no file uploaded" });

  const state_slug = req.body.state_slug || "profile";
  const media_type = req.body.media_type || "photo";
  const isAudio    = req_file.mimetype?.startsWith("audio/") || req_file.originalname?.endsWith(".mp3");
  const ext        = path.extname(req_file.originalname || (isAudio ? "reference.mp3" : "photo.jpg")) || (isAudio ? ".mp3" : ".jpg");
  const filename   = `${state_slug}${ext}`;
  // Use name-based slug for media path to avoid ngrok UUID caching issues
  const actorSlug  = (() => {
    const a = db.prepare(`SELECT name FROM actors WHERE id = ?`).get(req.params.id);
    if (!a?.name) return req.params.id;
    return a.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") + "-" + req.params.id.slice(0,8);
  })();
  const actorDir   = path.join(__dirname, "../public/media/actors", actorSlug, "images");

  const isVideo = req_file.mimetype.startsWith("video/") || filename.endsWith(".mp4");

  const { mkdirSync, writeFileSync } = await import("fs");
  mkdirSync(actorDir, { recursive: true });
  const fileDir = isAudio ? path.join(__dirname, "../public/media/actors", actorSlug, "voice") : actorDir;
  mkdirSync(fileDir, { recursive: true });
  writeFileSync(path.join(fileDir, filename), req_file.buffer);

  // Generate 200px thumbnail for images only
  if (!isVideo && !isAudio) {
    try {
      const sharp = (await import("sharp")).default;
      const thumbName = `thumb_${filename.replace(/\.\w+$/, ".jpg")}`;
      await sharp(req_file.buffer).resize(200, 200, { fit:"cover" }).jpeg({ quality:82 }).toFile(path.join(actorDir, thumbName));
    } catch {}
  }

  const url = isAudio ? `/media/actors/${actorSlug}/voice/${filename}` : `/media/actors/${actorSlug}/images/${filename}`;
  const now = new Date().toISOString();
  const id  = randomUUID();

  db.prepare(`DELETE FROM actor_media WHERE actor_id = ? AND state_slug = ? AND media_type = ?`)
    .run(req.params.id, state_slug, media_type);
  db.prepare(`INSERT INTO actor_media (id, actor_id, media_type, filename, url, state_slug, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, req.params.id, media_type, filename, url, state_slug, now, now);

  res.json({ id, url, state_slug, media_type, filename });
});

// ── PATCH /api/actors/:id/media/:mediaId/rename ──────────────────────────────
app.patch("/api/actors/:id/media/:mediaId/rename", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const { state_slug } = req.body;
  if (!state_slug) return res.status(400).json({ error: "state_slug required" });
  const now = new Date().toISOString();
  db.prepare(`UPDATE actor_media SET state_slug = ?, updated_at = ? WHERE id = ? AND actor_id = ?`)
    .run(state_slug, now, req.params.mediaId, req.params.id);
  res.json({ id: req.params.mediaId, state_slug });
});

// ── DELETE /api/actors/:id/media/:mediaId ─────────────────────────────────────
app.delete("/api/actors/:id/media/:mediaId", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const media = db.prepare(`SELECT * FROM actor_media WHERE id = ? AND actor_id = ?`).get(req.params.mediaId, req.params.id);
  if (!media) return res.status(404).json({ error: "not found" });
  try {
    const { default: fs } = await import("fs");
    const filePath = path.join(__dirname, "../public", media.url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
  db.prepare(`DELETE FROM actor_media WHERE id = ?`).run(req.params.mediaId);
  res.json({ deleted: req.params.mediaId });
});

app.get("/api/actors/:id/media", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const media = db.prepare(`SELECT * FROM actor_media WHERE actor_id = ? ORDER BY media_type, inserted_at`).all(req.params.id);
  res.json(media);
});

// ── GET /api/worlds — worlds available to deploy into ────────────────────────
// ── GET /api/worlds/:id/actors — characters deployed in a world ───────────────
app.get("/api/worlds/:id/actors", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actors = db.prepare(`
    SELECT a.id, a.name, a.first_name, a.last_name, a.occupation, a.gender,
           COALESCE(
             (SELECT m.url FROM actor_media m WHERE m.actor_id = a.id AND m.media_type = 'photo' ORDER BY m.inserted_at LIMIT 1),
             (SELECT m.url FROM actor_media m WHERE m.actor_id = a.id AND m.media_type = 'state_image' AND m.filename LIKE '%close%' LIMIT 1)
           ) as photo_url
    FROM actors a
    JOIN actor_deployments d ON d.platform_actor_id = a.id
    WHERE d.world_id = ?
    ORDER BY a.name
  `).all(req.params.id);
  res.json(actors);
});

// ── GET /api/relationship-types ───────────────────────────────────────────────
app.get("/api/relationship-types", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  try {
    const data = await simFetch("/internal/relationship-types");
    res.json(data || []);
  } catch {
    res.json([]);
  }
});

// ── POST /api/actors/:id/undeploy ────────────────────────────────────────────
app.post("/api/actors/:id/undeploy", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const actor = db.prepare(`SELECT * FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });

  const deployment = db.prepare(`SELECT * FROM actor_deployments WHERE platform_actor_id = ? AND undeployed_at IS NULL ORDER BY deployed_at DESC LIMIT 1`).get(req.params.id);
  if (!deployment) return res.status(400).json({ error: "not deployed" });

  try {
    await fetch(`${SIMULATOR_URL}/internal/actors/${deployment.simulator_actor_id}/undeploy`, { method:"POST", headers:{"X-Service-Token": SERVICE_TOKEN} });
  } catch (e) {
    console.warn("[undeploy] simulator call failed:", e.message);
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE actor_deployments SET undeployed_at = ? WHERE id = ?`).run(now, deployment.id);

  res.json({ ok: true });
});

// ── POST /api/actors/:id/deploy ───────────────────────────────────────────────
app.post("/api/actors/:id/deploy", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const actorId = req.params.id;
  const { world, home, workplace, career, relationships, schedule, fromWeek } = req.body;

  if (!world?.id || !home?.place_id || !schedule?.length) {
    return res.status(400).json({ error: "missing required deploy fields" });
  }

  const actor = db.prepare(`SELECT * FROM actors WHERE id = ? AND owner_id = ?`).get(actorId, user.id);
  if (!actor) return res.status(403).json({ error: "forbidden" });

  function getPsychTable(table, id) {
    try { return db.prepare(`SELECT * FROM ${table} WHERE actor_id = ?`).get(id) || null; } catch { return null; }
  }

  const psych = {
    ...(getPsychTable("actor_psychology", actorId) || {}),
    actor_big5:          getPsychTable("actor_big5", actorId),
    actor_disc:          getPsychTable("actor_disc", actorId),
    actor_economic:      getPsychTable("actor_economic", actorId),
    actor_lifestyle:     getPsychTable("actor_lifestyle", actorId),
    actor_mental_health: getPsychTable("actor_mental_health", actorId),
    actor_education:     getPsychTable("actor_education", actorId),
    actor_upbringing:    getPsychTable("actor_upbringing", actorId),
    actor_hds:           getPsychTable("actor_hds", actorId),
    actor_diagnoses:     getPsychTable("actor_diagnoses", actorId),
  };

  // Resolve simulator actor IDs for relationships
  const resolvedRelationships = (relationships || []).map(rel => {
    if (rel.character?._isUser) {
      // User — look up their simulator actor ID from world_memberships
      const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`).get(rel.character.id, world.id);
      if (!membership?.actor_id) return null;
      return { ...rel, target_simulator_actor_id: membership.actor_id, target_type: "user" };
    }
    const dep = db.prepare(`SELECT simulator_actor_id FROM actor_deployments WHERE platform_actor_id = ? AND world_id = ? AND undeployed_at IS NULL ORDER BY deployed_at DESC LIMIT 1`).get(rel.character?.id, world.id);
    if (!dep) return null;
    return { ...rel, target_simulator_actor_id: dep.simulator_actor_id };
  }).filter(Boolean);

  // Base64-encode all media files into payload — self-contained, no SSH/rsync needed
  const { readFileSync: readFS } = await import("fs");
  const mediaRows = db.prepare(`SELECT media_type, filename, url, state_slug FROM actor_media WHERE actor_id = ?`).all(actorId);
  const mediaWithData = mediaRows.map(m => {
    try {
      const ext  = path.extname(m.filename).toLowerCase();
      const mime = ext === ".mp3" ? "audio/mpeg" : ext === ".mp4" ? "video/mp4" : ext === ".png" ? "image/png" : "image/jpeg";
      const data = readFS(path.join(__dirname, "../public", m.url)).toString("base64");
      return { media_type: m.media_type, filename: m.filename, state_slug: m.state_slug, mime, data };
    } catch(e) { console.warn("[deploy] skipping media", m.filename, e.message); return null; }
  }).filter(Boolean);

  const payload = {
    platform_actor_id: actorId,
    world_id:   world.id,
    actor: {
      first_name: actor.first_name, last_name: actor.last_name,
      name: actor.name, age: actor.age, gender: actor.gender,
      occupation: actor.occupation, appearance: actor.appearance,
      media_folder: actor.media_folder
    },
    home, workplace: workplace || null, career: career || null,
    psychology: psych,
    relationships: resolvedRelationships,
    schedule, from_week: fromWeek || 1,
    media: mediaWithData,
  };

  // Save payload to disk for debugging
  try {
    const { mkdirSync: mkd, writeFileSync: wf } = await import("fs");
    const deployDir = path.join(__dirname, "../deploy-logs");
    mkd(deployDir, { recursive: true });
    wf(path.join(deployDir, `${actorId}-${Date.now()}.json`), JSON.stringify(payload));
  } catch {}

  try {
    const simRes = await fetch(`${SIMULATOR_URL}/internal/actors/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": SERVICE_TOKEN },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000) // 3 min — Dolphin can be slow under load
    }).then(r => r.json());
    if (!simRes?.simulator_actor_id) throw new Error("no simulator_actor_id returned");

    const now = new Date().toISOString();
    const deployStatus = simRes.warning ? 'pending_boot' : 'deployed';
    db.prepare(`INSERT OR REPLACE INTO actor_deployments (id, platform_actor_id, world_id, simulator_actor_id, world_name, deploy_status, deployed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), actorId, world.id, simRes.simulator_actor_id, world.name, deployStatus, now, now);

    res.json({ ok: true, simulator_actor_id: simRes.simulator_actor_id });
  } catch (e) {
    console.error("[deploy] error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/actors/:id/suggest-home — Haiku neighbourhood suggestions ────────
app.post("/api/actors/:id/suggest-home", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  let actor;
  try {
    actor = db.prepare(`
      SELECT a.first_name, a.name, a.occupation, a.age,
             ap.attachment_style,
             b.openness, b.conscientiousness, b.extraversion, b.neuroticism,
             e.income_level, e.financial_situation, e.lifestyle_tier,
             l.neighbourhood_pref, l.housing_type
      FROM actors a
      LEFT JOIN actor_psychology ap ON ap.actor_id = a.id
      LEFT JOIN actor_big5 b ON b.actor_id = a.id
      LEFT JOIN actor_economic e ON e.actor_id = a.id
      LEFT JOIN actor_lifestyle l ON l.actor_id = a.id
      WHERE a.id = ?
    `).get(req.params.id);
  } catch { actor = db.prepare(`SELECT * FROM actors WHERE id = ?`).get(req.params.id); }

  if (!actor) return res.status(404).json({ error: "not found" });

  const name = actor.first_name || actor.name;
  const b5 = [actor.openness, actor.conscientiousness, actor.extraversion, actor.neuroticism].map(v => v != null ? Math.round(v) : "?");
  const prompt = `Character: ${name}, ${actor.age || "unknown age"}, ${actor.occupation || "unknown occupation"}
Attachment: ${actor.attachment_style || "unknown"}
Big5: O:${b5[0]} C:${b5[1]} E:${b5[2]} N:${b5[3]}
Economic: ${[actor.income_level, actor.financial_situation, actor.lifestyle_tier].filter(Boolean).join(", ") || "unknown"}
Housing preference: ${[actor.neighbourhood_pref, actor.housing_type].filter(Boolean).join(", ") || "unknown"}

Suggest 3 Stockholm neighbourhoods where this person would realistically live given their occupation, psychology, income and lifestyle. Be specific and grounded.

Respond with JSON only — no preamble:
[{"neighbourhood":"...","reason":"..."},{"neighbourhood":"...","reason":"..."},{"neighbourhood":"...","reason":"..."}]`;

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type":"application/json", "x-api-key":process.env.CLAUDE_API_KEY, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:300, system:"You suggest Stockholm neighbourhoods. Respond in JSON only.", messages:[{ role:"user", content:prompt }] })
    });
    const data = await apiRes.json();
    const text = data.content?.find(b => b.type === "text")?.text || "";
    res.json(JSON.parse(text.replace(/```json|```/g, "").trim()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/places/autocomplete — address autocomplete proxy ────────────────
app.get("/api/places/autocomplete", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "q required" });

  const MAPS_KEY = "AIzaSyDy45Dov_WkN9FcxdVNYQEx23PjexI-Fxc";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(q)}&types=address&components=country:se&language=en&key=${MAPS_KEY}`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await r.json();
    const results = (data.predictions || []).slice(0, 5).map(p => ({
      place_id:    p.place_id,
      description: p.description,
    }));
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/places/reverse — reverse geocode lat/lng to address ─────────────
app.get("/api/places/reverse", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });

  const MAPS_KEY = "AIzaSyDy45Dov_WkN9FcxdVNYQEx23PjexI-Fxc";
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${MAPS_KEY}&language=en`, { signal: controller.signal });
    const data = await r.json();
    const result = data.results?.[0];
    if (!result) return res.status(404).json({ error: "no result" });
    res.json({
      place_id: result.place_id,
      address:  result.formatted_address,
      name:     result.formatted_address,
      lat:      parseFloat(lat),
      lng:      parseFloat(lng),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/places/details — place details by place_id ──────────────────────
app.get("/api/places/details", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const { place_id } = req.query;
  if (!place_id) return res.status(400).json({ error: "place_id required" });

  const MAPS_KEY = "AIzaSyDy45Dov_WkN9FcxdVNYQEx23PjexI-Fxc";
  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=place_id,name,formatted_address,geometry&language=en&key=${MAPS_KEY}`);
    const data = await r.json();
    const p = data.result;
    if (!p) return res.status(404).json({ error: "not found" });
    res.json({
      place_id: p.place_id,
      name:     p.name,
      address:  p.formatted_address,
      lat:      p.geometry?.location?.lat,
      lng:      p.geometry?.location?.lng,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// ── POST /api/actors/:id/suggest-career — Haiku career suggestion ──────────────
app.post("/api/actors/:id/suggest-career", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  let actor;
  try {
    actor = db.prepare(`
      SELECT a.first_name, a.name, a.occupation, a.age,
             ap.attachment_style, b.conscientiousness, b.openness,
             e.income_level, e.lifestyle_tier
      FROM actors a
      LEFT JOIN actor_psychology ap ON ap.actor_id = a.id
      LEFT JOIN actor_big5 b ON b.actor_id = a.id
      LEFT JOIN actor_economic e ON e.actor_id = a.id
      WHERE a.id = ?
    `).get(req.params.id);
  } catch { actor = db.prepare(`SELECT * FROM actors WHERE id = ?`).get(req.params.id); }
  if (!actor) return res.status(404).json({ error: "not found" });

  const name = actor.first_name || actor.name;
  const prompt = `Character: ${name}, ${actor.age || "unknown age"}, ${actor.occupation || "unknown occupation"}
Attachment: ${actor.attachment_style || "unknown"}
Conscientiousness: ${actor.conscientiousness || "?"}
Income: ${actor.income_level || "unknown"}

Suggest realistic career details for this person. Use ONLY these values:
- career_level: junior | established | senior | independent
- employment_type: employed | freelance
- career_ladder: a short slug like "medical_specialist", "performer", "sound_engineer", "sales", "technical" etc — derive from occupation
- reputation_score: 0.0–1.0 (how well known and respected in their field)

Respond with JSON only:
{"career_level":"...","career_ladder":"...","employment_type":"...","reputation_score":0.0}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type":"application/json", "x-api-key":process.env.CLAUDE_API_KEY, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:150, system:"You suggest career details. Respond in JSON only.", messages:[{ role:"user", content:prompt }] })
    });
    const data = await r.json();
    const text = data.content?.find(b=>b.type==="text")?.text||"";
    res.json(JSON.parse(text.replace(/```json|```/g,"").trim()));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── POST /api/actors/:id/suggest-workplace — Haiku workplace suggestions ────────
app.post("/api/actors/:id/suggest-workplace", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  let actor;
  try {
    actor = db.prepare(`SELECT a.first_name, a.name, a.occupation, a.age, e.income_level, e.lifestyle_tier FROM actors a LEFT JOIN actor_economic e ON e.actor_id = a.id WHERE a.id = ?`).get(req.params.id);
  } catch { actor = db.prepare(`SELECT * FROM actors WHERE id = ?`).get(req.params.id); }
  if (!actor) return res.status(404).json({ error: "not found" });

  const name = actor.first_name || actor.name;
  const prompt = `Character: ${name}, ${actor.age||"unknown age"}, ${actor.occupation||"unknown occupation"}
${actor.income_level ? `Income: ${actor.income_level}` : ""}

Suggest 3 realistic Stockholm workplaces for this person. Be specific — name real hospitals, clinics, offices, studios etc. that fit their occupation and seniority.

Respond with JSON only:
[{"name":"...","reason":"..."},{"name":"...","reason":"..."},{"name":"...","reason":"..."}]`;

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{ "Content-Type":"application/json", "x-api-key":process.env.CLAUDE_API_KEY, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:300, system:"You suggest Stockholm workplaces. Respond in JSON only.", messages:[{ role:"user", content:prompt }] })
    });
    const data = await apiRes.json();
    const text = data.content?.find(b=>b.type==="text")?.text||"";
    res.json(JSON.parse(text.replace(/```json|```/g,"").trim()));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── POST /api/actors/:id/generate-schedule — Haiku schedule generation ─────────
app.post("/api/actors/:id/generate-schedule", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  let actor;
  try {
    actor = db.prepare(`
      SELECT a.first_name, a.name, a.occupation, a.age, a.gender,
             ap.attachment_style, ap.core_wound,
             b.openness, b.conscientiousness, b.extraversion, b.agreeableness, b.neuroticism,
             e.income_level, e.financial_situation, e.lifestyle_tier,
             l.housing_type, l.morning_person, l.social_frequency
      FROM actors a
      LEFT JOIN actor_psychology ap ON ap.actor_id = a.id
      LEFT JOIN actor_big5 b ON b.actor_id = a.id
      LEFT JOIN actor_economic e ON e.actor_id = a.id
      LEFT JOIN actor_lifestyle l ON l.actor_id = a.id
      WHERE a.id = ?
    `).get(req.params.id);
  } catch { actor = db.prepare(`SELECT * FROM actors WHERE id = ?`).get(req.params.id); }

  if (!actor) return res.status(404).json({ error: "not found" });

  const { home_address } = req.body;
  const name = actor.first_name || actor.name;
  const b5 = [actor.openness, actor.conscientiousness, actor.extraversion, actor.agreeableness, actor.neuroticism].map(v => v != null ? Math.round(v) : "?");

  const SLUGS = "sleeping, morning_routine, waking, bath, skincare, grooming, eating, cooking, meal_prep, brunch, coffee, drinking_coffee, snacking, exercise, running, cycling, yoga, stretching, foam_rolling, swimming, hiking, sport, work_deep, work_admin, work_meetings, work_audition, work_casting, work_onset, work_reviewing, work_mainstream_audition, script_reading, rehearsing, filming, editing, recording, composing, mixing, storyboarding, admin, planning, errands, laundry, cleaning, childcare, shopping, medical, therapy, coaching, studying, reading, writing, journaling, sketching, painting, creative, reflection, daydreaming, meditating, praying, decompressing, relaxing, napping, watching_tv, scrolling, gaming, listening, social_dinner, social_bar, social_cafe, social_drinks, social_late_night, party, networking, exhibition, gallery, cinema, concert, ceremony, volunteering, walking, transit, taxi, travel, waiting, withdrawing, philosophical, pitching, negotiating, dining, drinking_wine, drinking_alcohol, sunbathing, sauna, spa, massage, people_watching, window_watching, flirting, hooking_up";

  const prompt = `Character: ${name}, ${actor.age || "unknown age"}, ${actor.occupation || "unknown occupation"}
Attachment: ${actor.attachment_style || "unknown"}${actor.core_wound ? ` | Wound: ${actor.core_wound}` : ""}
Big5: O:${b5[0]} C:${b5[1]} E:${b5[2]} A:${b5[3]} N:${b5[4]}
${actor.income_level ? `Economic: ${actor.income_level} income` : ""}
${actor.morning_person ? `Morning person: ${actor.morning_person}` : ""}
${actor.social_frequency ? `Social frequency: ${actor.social_frequency}` : ""}
Home: ${home_address || "Stockholm"}

Generate a realistic weekly schedule that reflects this person's psychology, occupation and lifestyle.
Rules:
- Cover ALL 7 days: monday tuesday wednesday thursday friday saturday sunday
- Each day MUST cover exactly 00:00 to 24:00 with NO gaps and NO overlaps
- TARGET exactly 10-11 slots per day — no more
- MINIMUM slot duration: 1 hour. Never create slots shorter than 1 hour.
- Sleep = ONE block of 6-9 hours. Morning routine = ONE block of 1-2 hours. Do NOT fragment these.
- Merge consecutive similar activities into one block — do NOT split work_deep into two separate slots on the same day
- Use ONLY these activity slugs: ${SLUGS}
- location_type must be one of: home, work, hospital, clinic, gym, cafe, restaurant, bar, outdoor, transit, other
- state_note: short label (2-5 words), specific to this character
- Vary the schedule realistically — weekdays differ from weekends
- Reflect the psychology: attachment style and Big5 should shape social activity, routine rigidity, and leisure choices

Respond with a compact JSON array only — no preamble, no markdown, no extra whitespace:
[{"day_of_week":"monday","start_time":"00:00","end_time":"06:30","activity_slug":"sleeping","state_note":"deep sleep","location_type":"home"},...]`;

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type":"application/json", "x-api-key":process.env.CLAUDE_API_KEY, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16000,
        system: "You generate weekly schedules as JSON arrays. Respond with JSON only — no preamble, no markdown fences.",
        messages: [{ role:"user", content: prompt }]
      })
    });
    const data = await apiRes.json();
    const text = data.content?.find(b => b.type === "text")?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const slots = JSON.parse(clean);
    res.json(slots);
  } catch (e) {
    console.error("[generate-schedule] error:", e);
    res.status(500).json({ error: e.message, stack: e.stack?.split("\n").slice(0,3) });
  }
});

// ── POST /api/actors/:id/inspire-relationship — Haiku relationship description ─
app.post("/api/actors/:id/inspire-relationship", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const { rel_type_id, rel_type_name, dimension_name, target_type, target_id } = req.body;
  if (!rel_type_id || !target_type || !target_id) return res.status(400).json({ error: "missing fields" });

  function formatPsych(a) {
    const name = a.first_name || a.name;
    const b5 = [a.openness, a.conscientiousness, a.extraversion, a.agreeableness, a.neuroticism]
      .map(v => v != null ? Math.round(v) : "?");
    return [
      `${name}, ${a.occupation || "unknown occupation"}`,
      a.attachment_style ? `Attachment: ${a.attachment_style}${a.core_wound ? ` | Wound: ${a.core_wound}` : ""}` : null,
      `Big5: O:${b5[0]} C:${b5[1]} E:${b5[2]} A:${b5[3]} N:${b5[4]}`,
      a.blind_spot    ? `Blind spot: ${a.blind_spot}` : null,
      a.coping_strategies ? `Coping: ${a.coping_strategies}` : null,
    ].filter(Boolean).join("\n");
  }

  function getPsych(actorId) {
    try {
      return db.prepare(`
        SELECT a.first_name, a.last_name, a.name, a.occupation,
               ap.attachment_style, ap.core_wound,
               b.openness, b.conscientiousness, b.extraversion, b.agreeableness, b.neuroticism,
               p.blind_spot, p.coping_strategies
        FROM actors a
        LEFT JOIN actor_psychology ap ON ap.actor_id = a.id
        LEFT JOIN actor_big5 b ON b.actor_id = a.id
        LEFT JOIN actor_personality p ON p.actor_id = a.id
        WHERE a.id = ?
      `).get(actorId);
    } catch { return db.prepare(`SELECT * FROM actors WHERE id = ?`).get(actorId); }
  }

  const sourceActor = getPsych(req.params.id);
  if (!sourceActor) return res.status(404).json({ error: "actor not found" });

  const systemPrompt = `You write relationship descriptions for an AI world simulation.
Be specific, psychologically grounded, and avoid clichés.
Respond in JSON only — no preamble, no markdown fences.`;

  let messages;

  if (target_type === "actor") {
    const target = getPsych(target_id);
    if (!target) return res.status(404).json({ error: "target not found" });
    messages = [{
      role: "user",
      content: `Character A:\n${formatPsych(sourceActor)}\n\nCharacter B:\n${formatPsych(target)}\n\nRelationship type: ${rel_type_name.replace(/_/g," ")} (${dimension_name})\n\nReturn JSON only:\n{"description":"2-3 sentences of backstory — how this relationship came to be","context":"1-2 sentences of current dynamic between them right now","scores":{"warmth":0.0,"trust":0.0,"respect":0.0,"tension":0.0,"attraction":0.0,"pull":0.0}}`


    }];

  } else if (target_type === "user") {
    const targetUser = db.prepare(`SELECT id, name, photo_url FROM users WHERE id = ?`).get(target_id);
    if (!targetUser) return res.status(404).json({ error: "user not found" });

    const content = [];
    if (targetUser.photo_url) {
      try {
        const { readFileSync } = await import("fs");
        const filePath = path.join(__dirname, "../public", targetUser.photo_url);
        const buf = readFileSync(filePath);
        const ext = path.extname(targetUser.photo_url).toLowerCase();
        const mime = ext === ".png" ? "image/png" : "image/jpeg";
        content.push({ type:"image", source:{ type:"base64", media_type:mime, data:buf.toString("base64") } });
      } catch {}
    }
    content.push({
      type: "text",
      text: `Character: ${formatPsych(sourceActor)}\n\nThe other person is a player named ${targetUser.name}.${targetUser.photo_url ? "\nUse the photo above to inform the relational dynamic." : ""}\n\nRelationship type: ${rel_type_name.replace(/_/g," ")} (${dimension_name})\n\nReturn JSON only:\n{"description":"2-3 sentences of backstory","context":"1-2 sentences of current dynamic","scores":{"warmth":0.0,"trust":0.0,"respect":0.0,"tension":0.0,"attraction":0.0,"pull":0.0}}`


    });
    messages = [{ role:"user", content }];

  } else {
    return res.status(400).json({ error: "invalid target_type" });
  }

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type":"application/json", "x-api-key":process.env.CLAUDE_API_KEY, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:600, system:systemPrompt, messages })
    });
    const apiData = await apiRes.json();
    const text = apiData.content?.find(b => b.type === "text")?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    // Extract JSON object robustly — find first { to last }
    const start = clean.indexOf("{");
    const end   = clean.lastIndexOf("}");
    const jsonStr = start >= 0 && end > start ? clean.slice(start, end + 1) : clean;
    res.json(JSON.parse(jsonStr));
  } catch (e) {
    res.status(500).json({ error: "inspire failed", detail: e.message });
  }
});


// ── GET /api/actors/deployments — which actors are deployed ──────────────────
app.get("/api/actors/deployments", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const deps = db.prepare(`
    SELECT d.platform_actor_id, d.world_id, d.world_name, d.deployed_at
    FROM actor_deployments d
    JOIN actors a ON a.id = d.platform_actor_id
    WHERE a.owner_id = ?
    UNION
    SELECT d.platform_actor_id, d.world_id, d.world_name, d.deployed_at
    FROM actor_deployments d
    JOIN actor_shares s ON s.actor_id = d.platform_actor_id
    WHERE s.shared_with_id = ?
  `).all(user.id, user.id);
  res.json(deps);
});

// ── GET /api/actors/:id/in-play — worlds, relationships, memories ────────────────
app.get("/api/actors/:id/in-play", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const actor = db.prepare(`SELECT id, owner_id FROM actors WHERE id = ?`).get(req.params.id);
  if (!actor) return res.status(404).json({ error: "not found" });

  const isOwner = actor.owner_id === user.id;
  const share   = !isOwner && db.prepare(`SELECT permission, viewer_actor_id FROM actor_shares WHERE actor_id = ? AND shared_with_id = ?`).get(req.params.id, user.id);
  if (!isOwner && !share) return res.status(403).json({ error: "forbidden" });

  const viewerActorId = isOwner ? null : (share.viewer_actor_id || null);

  // Get deployments from platform DB
  const deployments = db.prepare(`SELECT * FROM actor_deployments WHERE platform_actor_id = ?`).all(req.params.id);
  if (!deployments.length) return res.json({ data: [], is_owner: isOwner, viewer_actor_id: null });

  // Look up the viewing user's player actor in each world
  const results = await Promise.all(deployments.map(async dep => {
    try {
      // Find viewer's player actor in this world via world_memberships
      const membership = db.prepare(`SELECT actor_id FROM world_memberships WHERE user_id = ? AND world_id = ?`).get(user.id, dep.world_id);
      const myActorId = membership?.actor_id || viewerActorId || null;

      // Owner gets all memories — never pass viewer_actor_id
      const qs = (!isOwner && myActorId) ? `?viewer_actor_id=${myActorId}` : "";
      const data = await simFetch(`/internal/actors/${dep.simulator_actor_id}/in-play${qs}`);
      return { ...data, world_name: dep.world_name, deployed_at: dep.deployed_at, my_actor_id: myActorId };
    } catch {
      return { world_id: dep.world_id, world_name: dep.world_name, deployed_at: dep.deployed_at, error: "simulator unreachable" };
    }
  }));

  res.json({ data: results, is_owner: isOwner });
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

// ── DELETE /api/actors/:id — hard delete undeployed actor ───────────────────
app.delete("/api/actors/:id", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });

  const deployment = db.prepare(`SELECT id FROM actor_deployments WHERE platform_actor_id = ? AND undeployed_at IS NULL`).get(req.params.id);
  if (deployment) return res.status(409).json({ error: "actor is deployed — undeploy first" });

  // Delete media files from disk using already-imported fs
  const mediaFiles = db.prepare(`SELECT url FROM actor_media WHERE actor_id = ?`).all(req.params.id);
  for (const m of mediaFiles) {
    try { fs.unlinkSync(path.join(__dirname, "../public", m.url)); } catch {}
  }

  const tables = ["actor_psychology","actor_big5","actor_disc","actor_hds","actor_economic",
    "actor_lifestyle","actor_mental_health","actor_education","actor_upbringing",
    "actor_diagnoses","actor_media","actor_shares","actor_assessment_results","actor_deployments"];

  db.transaction(() => {
    for (const t of tables) {
      try { db.prepare(`DELETE FROM ${t} WHERE actor_id = ?`).run(req.params.id); } catch {}
    }
    try { db.prepare(`DELETE FROM actor_deployments WHERE platform_actor_id = ?`).run(req.params.id); } catch {}
    db.prepare(`DELETE FROM actors WHERE id = ? AND owner_id = ?`).run(req.params.id, user.id);
  })();
  res.json({ ok: true });
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


// ── POST /api/generate/profile — AI-generate character data via Haiku ─────────
app.post("/api/generate/profile", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  const key = process.env.CLAUDE_API_KEY;
  if (!key) return res.status(500).json({ error: "no API key" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4000,
        system: "You are a character design assistant. Return ONLY raw JSON. No markdown, no code fences, no backticks, no explanation. Start your response with { and end with }.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const d = await r.json();
    res.json({ text: d.content?.[0]?.text || "" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/generate/appearance — describe character from photos via Haiku ──
app.post("/api/generate/appearance", async (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { images, name, gender, age } = req.body;
  if (!images?.length) return res.status(400).json({ error: "no images" });
  const key = process.env.CLAUDE_API_KEY;
  if (!key) return res.status(500).json({ error: "no API key" });
  try {
    const content = [
      ...images.map(b64 => ({ type: "image", source: { type: "base64", media_type: b64.startsWith("/9j/") ? "image/jpeg" : "image/png", data: b64 } })),
      { type: "text", text: "placeholder" }
    ];
    const isFemale = (gender||"").toLowerCase() === "female";
    const isMale   = (gender||"").toLowerCase() === "male";
    const genderSpecific = isFemale
      ? `,"bust":"small|average|full|large","figure":"straight|slightly curved|curved|very curved","waist_hip_ratio":"low|average|high","legs":"short|average|long|athletic"`
      : isMale
      ? `,"physique":"slim|average|toned|muscular|heavy","shoulders":"narrow|average|broad|very broad","height_dominance":"average|tall|very tall"`
      : "";
    const lastMsg = `You are a creative writing assistant helping build a detailed fictional character profile. Describe the physical characteristics of the person in this photo for use in a character description. Name: ${name||"character"}, Age: ${age||"unknown"}, Gender: ${gender||"unknown"}.

Return ONLY valid JSON, short descriptive values:
{"gender":"${gender||"unknown"}","height":"tall|above average|average|petite|short","build":"slim|lean|athletic|curvy|full-figured|stocky|muscular","body_shape":"hourglass|pear|apple|rectangle|inverted triangle","hair":"[colour, length, texture, style]","eyes":"[colour and notable quality]","face":"[shape, skin tone, jaw, cheekbones, notable features]","style":"[inferred clothing style]","notable":"[any distinctive features or none]","presence":"commanding|warm|understated|magnetic|reserved","body_confidence":"high|moderate|low","grooming":"meticulous|natural|minimal|casual","tension_markers":"none|[visible physical tension signals]"${genderSpecific}}`;
    const contentWithText = [...content.slice(0,-1), { type: "text", text: lastMsg }];
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 512, messages: [{ role: "user", content: contentWithText }] }),
    });
    const d = await r.json();
    console.log("[generate/appearance] Anthropic response:", JSON.stringify(d).slice(0,300));
    const raw = d.content?.[0]?.text?.trim() || "{}";
    console.log("[generate/appearance] raw:", raw.slice(0,300));
    try {
      // Strip markdown fences and find JSON object
      const cleaned = raw.replace(/```json|```/gi,"").trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      const fields = JSON.parse(match ? match[0] : cleaned);
      res.json({ fields });
    } catch(parseErr) {
      console.error("[generate/appearance] parse error:", parseErr.message, "raw:", raw.slice(0,200));
      res.json({ fields: {} });
    }
  } catch(e) { console.error("[generate/appearance]", e); res.status(500).json({ error: e.message }); }
});

// ── POST /api/actors — create canonical actor ─────────────────────────────────
app.post("/api/actors", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const { identity, psychology, personality, lifestyle, economy } = req.body;
  if (!identity?.first_name) return res.status(400).json({ error: "first_name required" });
  const id   = randomUUID();
  const now  = new Date().toISOString();
  const name        = [identity.first_name?.trim(), identity.last_name?.trim()].filter(Boolean).join(" ");
  const mediaFolder = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") + "-" + id.slice(0,8);
  const run = db.transaction(() => {
    db.prepare(`INSERT INTO actors (id, owner_id, name, first_name, last_name, age, gender, occupation, appearance, media_folder, status, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, user.id, name, identity.first_name?.trim(), identity.last_name?.trim()||null, identity.age||null, identity.gender||"female", identity.occupation||null, identity.appearance||null, mediaFolder, "active", now, now);
    const p = psychology||{};
    db.prepare(`INSERT INTO actor_psychology (actor_id, attachment_style, wound, what_they_want, blindspot, defenses, contradiction, backstory, orientation, view_on_sex, marital_status, coping_mechanisms, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, personality?.attachment_style||p.attachment_style||"secure", p.wound||null, p.what_they_want||null, p.blindspot||null, p.defenses||null, p.contradiction||null, p.backstory||null, identity.orientation||"straight", p.view_on_sex||null, p.marital_status||"single", p.coping_mechanisms||null, now, now);
    const b = personality?.big5||{};
    db.prepare(`INSERT INTO actor_big5 (actor_id, openness, conscientiousness, extraversion, agreeableness, neuroticism, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, b.openness||50, b.conscientiousness||50, b.extraversion||50, b.agreeableness||50, b.neuroticism||50, now, now);
    const disc = personality?.disc||{};
    db.prepare(`INSERT INTO actor_disc (actor_id, d, i, s, c, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, disc.d||50, disc.i||50, disc.s||50, disc.c||50, now, now);
    const h = personality?.hds||{};
    db.prepare(`INSERT INTO actor_hds (actor_id, bold, cautious, colorful, diligent, dutiful, excitable, imaginative, leisurely, mischievous, reserved, skeptical, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, h.bold||30, h.cautious||30, h.colorful||30, h.diligent||30, h.dutiful||30, h.excitable||30, h.imaginative||30, h.leisurely||30, h.mischievous||30, h.reserved||30, h.skeptical||30, now, now);
    const l = lifestyle||{};
    db.prepare(`INSERT INTO actor_lifestyle (actor_id, alcohol_relationship, drug_use, substance_context, sleep_pattern, sleep_quality, exercise_habit, exercise_type, social_frequency, diet, lifestyle_note, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, l.alcohol_relationship||null, l.drug_use||"none", l.substance_context||null, l.sleep_pattern||"normal", l.sleep_quality||"good", l.exercise_habit||null, l.exercise_type||null, l.social_frequency||null, l.diet||null, l.lifestyle_note||null, now, now);
    const e = economy||{};
    db.prepare(`INSERT INTO actor_economic (actor_id, financial_situation, income_stability, monthly_income_sek, spending_style, savings_habit, attitude_to_wealth, financial_anxiety, behavior_note, inserted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, e.financial_situation||"stable", e.income_stability||"stable", e.monthly_income_sek?parseInt(e.monthly_income_sek):null, e.spending_style||"balanced", e.savings_habit||"moderate", e.attitude_to_wealth||"practical", e.financial_anxiety||0.3, e.behavior_note||null, now, now);
  });
  run();
  res.json({ id, name: identity.name, status: "created" });
});


// ── GET /api/assessment-questions/:type — fetch question bank ─────────────────
app.get("/api/assessment-questions/:type", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const questions = db.prepare(`
    SELECT id, assessment_type, scale, item_order, item_text, response_type
    FROM assessment_questions
    WHERE assessment_type = ? AND active = 1
    ORDER BY scale, item_order
  `).all(req.params.type);
  res.json(questions);
});

// ── POST /api/actors/:id/assessments — save assessment result ─────────────────
app.post("/api/actors/:id/assessments", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const actor = db.prepare(`SELECT id FROM actors WHERE id = ? AND owner_id = ?`).get(req.params.id, user.id);
  if (!actor) return res.status(404).json({ error: "not found" });
  const { assessment_type, answers, scores, interpretation, notes } = req.body;
  if (!assessment_type) return res.status(400).json({ error: "assessment_type required" });
  const now = new Date().toISOString();
  const id  = randomUUID();
  // Delete previous result for this actor+type
  db.prepare(`DELETE FROM actor_assessment_results WHERE actor_id = ? AND assessment_type = ?`).run(req.params.id, assessment_type);
  db.prepare(`INSERT INTO actor_assessment_results (id, actor_id, assessment_type, answers, scores, interpretation, notes, run_at, inserted_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, req.params.id, assessment_type, JSON.stringify(answers||[]), JSON.stringify(scores||{}), interpretation||"", JSON.stringify(notes||{}), now, now);
  res.json({ id });
});

// ── GET /api/actors/:id/assessments — get all assessment results ──────────────
app.get("/api/actors/:id/assessments", (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const results = db.prepare(`SELECT * FROM actor_assessment_results WHERE actor_id = ? ORDER BY run_at DESC`).all(req.params.id);
  res.json(results.map(r => ({
    ...r,
    answers: JSON.parse(r.answers||"[]"),
    scores: JSON.parse(r.scores||"{}"),
    notes: JSON.parse(r.notes||"{}"),
  })));
});


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

