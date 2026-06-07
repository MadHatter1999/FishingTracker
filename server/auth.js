// Password hashing + stateless signed tokens, using only Node's built-in crypto
// (no native deps, no third-party JWT library).
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// --- server secret (used to sign tokens). Stable across restarts so sessions survive. ---
function loadSecret() {
  if (process.env.GUILD_SECRET) return process.env.GUILD_SECRET;
  const dataDir = join(__dirname, "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, ".secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = randomBytes(48).toString("hex");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const SECRET = loadSecret();

// --- passwords ---
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const known = Buffer.from(hash, "hex");
  if (candidate.length !== known.length) return false;
  return timingSafeEqual(candidate, known);
}

// --- tokens (compact HMAC-signed, like a minimal JWT) ---
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}
function sign(body) {
  return b64url(createHmac("sha256", SECRET).update(body).digest());
}

export function signToken(payload) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS }));
  return `${body}.${sign(body)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = sign(body);
  // constant-time compare of signatures
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(b64urlDecode(body));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}
