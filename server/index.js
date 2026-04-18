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
    db.prepare(`UPDATE auth_tokens SET revoked_at = datetime('now') WHERE token_hash = ?`).run(hash);
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

const PORT = 4002;
app.listen(PORT, () => console.log(`Platform API running on :${PORT}`));
