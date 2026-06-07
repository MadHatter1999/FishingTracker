// Nova Scotian Anglers Guild - self-hosted backend.
// HTTP REST API (auth + user management) + WebSocket live presence.
// Deps: ws only. SQLite via Node's built-in node:sqlite. Crypto via node:crypto.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, dirname, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { db, seedAdmin, pickColor, publicUser, PALETTE } from "./db.js";
import { hashPassword, verifyPassword, signToken, verifyToken } from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const DIST_DIR = join(__dirname, "..", "dist");

seedAdmin();

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(data);
}

function cors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function userFromToken(token) {
  const data = verifyToken(token);
  if (!data) return null;
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(data.uid);
  return row || null;
}

function authUser(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return userFromToken(token);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveStatic(req, res, urlPath) {
  // Serve the built PWA (dist/) so the app + API can share one origin in production.
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const filePath = normalize(join(DIST_DIR, rel));
  if (!filePath.startsWith(DIST_DIR)) return send(res, 403, "Forbidden");
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error("dir");
    const buf = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    // SPA fallback to index.html (if a build exists)
    try {
      const buf = await readFile(join(DIST_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buf);
    } catch {
      send(res, 404, "Not found. (Run `npm run build` to serve the app from this server, or use the Vite dev server.)");
    }
  }
}

// ---------- REST routing ----------
async function handleApi(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  // --- login ---
  if (path === "/api/login" && method === "POST") {
    const body = await readJson(req);
    if (!body || !body.username || !body.password) return send(res, 400, { error: "Username and password required" });
    const row = db.prepare("SELECT * FROM users WHERE username = ?").get(String(body.username).trim());
    if (!row || !verifyPassword(String(body.password), row.password_salt, row.password_hash)) {
      return send(res, 401, { error: "Invalid username or password" });
    }
    const token = signToken({ uid: row.id });
    return send(res, 200, { token, user: publicUser(row) });
  }

  // everything below requires auth
  const me = authUser(req);
  if (!me) return send(res, 401, { error: "Not authenticated" });

  if (path === "/api/me" && method === "GET") {
    return send(res, 200, { user: publicUser(me) });
  }

  if (path === "/api/me/password" && method === "POST") {
    const body = await readJson(req);
    if (!body || !body.currentPassword || !body.newPassword) return send(res, 400, { error: "Current and new password required" });
    if (!verifyPassword(String(body.currentPassword), me.password_salt, me.password_hash)) {
      return send(res, 403, { error: "Current password is incorrect" });
    }
    if (String(body.newPassword).length < 4) return send(res, 400, { error: "New password too short" });
    const { salt, hash } = hashPassword(String(body.newPassword));
    db.prepare("UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?").run(salt, hash, me.id);
    return send(res, 200, { ok: true });
  }

  // --- presence roster (REST fallback; WS is primary) ---
  if (path === "/api/locations" && method === "GET") {
    return send(res, 200, { anglers: rosterFor(me.id) });
  }

  if (path === "/api/palette" && method === "GET") {
    return send(res, 200, { palette: PALETTE });
  }

  // --- admin-only: user management ---
  if (path.startsWith("/api/users")) {
    if (!me.is_admin) return send(res, 403, { error: "Admin only" });

    if (path === "/api/users" && method === "GET") {
      const rows = db.prepare("SELECT * FROM users ORDER BY is_admin DESC, username COLLATE NOCASE").all();
      const online = new Set([...presence.keys()]);
      return send(res, 200, { users: rows.map((r) => ({ ...publicUser(r), online: online.has(r.id) })) });
    }

    if (path === "/api/users" && method === "POST") {
      const body = await readJson(req);
      const username = String(body?.username || "").trim();
      const password = String(body?.password || "");
      if (!username || !password) return send(res, 400, { error: "Username and password required" });
      if (!/^[\w .'-]{2,32}$/.test(username)) return send(res, 400, { error: "Username must be 2-32 letters/numbers" });
      if (password.length < 4) return send(res, 400, { error: "Password must be at least 4 characters" });
      const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
      if (exists) return send(res, 409, { error: "That username is taken" });
      const { salt, hash } = hashPassword(password);
      const color = body?.color && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : pickColor();
      const displayName = String(body?.displayName || username).trim().slice(0, 40) || username;
      const info = db.prepare(
        `INSERT INTO users (username, display_name, password_salt, password_hash, is_admin, color, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(username, displayName, salt, hash, body?.isAdmin ? 1 : 0, color, new Date().toISOString(), me.id);
      const row = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
      return send(res, 201, { user: publicUser(row) });
    }

    const idMatch = path.match(/^\/api\/users\/(\d+)(\/password)?$/);
    if (idMatch) {
      const targetId = Number(idMatch[1]);
      const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId);
      if (!target) return send(res, 404, { error: "User not found" });

      if (idMatch[2] === "/password" && method === "POST") {
        const body = await readJson(req);
        if (!body?.newPassword || String(body.newPassword).length < 4) return send(res, 400, { error: "Password must be at least 4 characters" });
        const { salt, hash } = hashPassword(String(body.newPassword));
        db.prepare("UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?").run(salt, hash, targetId);
        return send(res, 200, { ok: true });
      }

      if (!idMatch[2] && method === "PUT") {
        const body = await readJson(req);
        const displayName = body?.displayName != null ? String(body.displayName).trim().slice(0, 40) : target.display_name;
        const color = body?.color && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : target.color;
        let isAdmin = target.is_admin;
        if (body?.isAdmin != null) {
          // don't allow removing the last admin
          const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").get().n;
          if (!body.isAdmin && target.is_admin && admins <= 1) return send(res, 400, { error: "Cannot remove the last admin" });
          isAdmin = body.isAdmin ? 1 : 0;
        }
        db.prepare("UPDATE users SET display_name = ?, color = ?, is_admin = ? WHERE id = ?").run(displayName, color, isAdmin, targetId);
        broadcastRoster();
        const row = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId);
        return send(res, 200, { user: publicUser(row) });
      }

      if (!idMatch[2] && method === "DELETE") {
        if (targetId === me.id) return send(res, 400, { error: "You can't delete your own account" });
        if (target.is_admin) {
          const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").get().n;
          if (admins <= 1) return send(res, 400, { error: "Cannot delete the last admin" });
        }
        db.prepare("DELETE FROM users WHERE id = ?").run(targetId);
        dropUser(targetId);
        return send(res, 200, { ok: true });
      }
    }
  }

  return send(res, 404, { error: "Unknown endpoint" });
}

// ---------- HTTP server ----------
const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      return await handleApi(req, res, url);
    } catch (e) {
      console.error("API error:", e);
      return send(res, 500, { error: "Server error" });
    }
  }
  if (url.pathname === "/ws") return; // handled by the WS upgrade
  return serveStatic(req, res, req.url);
});

// ---------- WebSocket live presence ----------
// presence: userId -> { lat, lon, accuracy, updatedAt, sockets:Set<ws> }
const presence = new Map();

function rosterFor(excludeId) {
  const out = [];
  for (const [uid, p] of presence) {
    if (uid === excludeId) continue;
    if (p.lat == null || p.lon == null) continue; // sharing turned off / no fix yet
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
    if (!u) continue;
    out.push({ id: uid, username: u.username, displayName: u.display_name, color: u.color, lat: p.lat, lon: p.lon, updatedAt: p.updatedAt });
  }
  return out;
}

function broadcastRoster() {
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN || !client.userId) continue;
    safeSend(client, { type: "roster", anglers: rosterFor(client.userId) });
  }
}

function safeSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch { /* ignore */ }
}

function dropUser(userId) {
  presence.delete(userId);
  broadcastRoster();
}

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get("token") || "";
  const user = userFromToken(token);
  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.userId = user.id;
    wss.emit("connection", ws, user);
  });
});

wss.on("connection", (ws, user) => {
  // register socket
  let entry = presence.get(user.id);
  if (!entry) {
    entry = { lat: null, lon: null, accuracy: null, updatedAt: null, sockets: new Set() };
    presence.set(user.id, entry);
  }
  entry.sockets.add(ws);

  // send this client the current roster of everyone else who is sharing
  safeSend(ws, { type: "roster", anglers: rosterFor(user.id) });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const e = presence.get(user.id);
    if (!e) return;
    if (msg.type === "loc" && typeof msg.lat === "number" && typeof msg.lon === "number") {
      e.lat = msg.lat;
      e.lon = msg.lon;
      e.accuracy = typeof msg.accuracy === "number" ? msg.accuracy : null;
      e.updatedAt = new Date().toISOString();
      broadcastRoster();
    } else if (msg.type === "stop") {
      e.lat = null;
      e.lon = null;
      e.updatedAt = null;
      broadcastRoster();
    }
  });

  ws.on("close", () => {
    const e = presence.get(user.id);
    if (!e) return;
    e.sockets.delete(ws);
    if (e.sockets.size === 0) {
      presence.delete(user.id);
      broadcastRoster();
    }
  });

  ws.on("error", () => { /* ignore */ });
});

// heartbeat to drop dead sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
});

server.listen(PORT, () => {
  console.log(`Nova Scotian Anglers Guild server listening on http://localhost:${PORT}`);
  console.log(`WebSocket presence on ws://localhost:${PORT}/ws`);
});
