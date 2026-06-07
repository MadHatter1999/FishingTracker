// SQLite via Node's built-in node:sqlite (no native build step required).
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { hashPassword } from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "data");
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, "guild.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT UNIQUE NOT NULL COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin     INTEGER NOT NULL DEFAULT 0,
    color        TEXT NOT NULL DEFAULT '#36c2ce',
    created_at   TEXT NOT NULL,
    created_by   INTEGER
  );
  CREATE TABLE IF NOT EXISTS locations (
    user_id    INTEGER PRIMARY KEY,
    lat        REAL,
    lon        REAL,
    accuracy   REAL,
    updated_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Distinct hook colours handed out to new members.
export const PALETTE = [
  "#ff6b6b", "#ffcf5c", "#5ee0a0", "#36c2ce", "#9b8cff",
  "#ff9f43", "#f368e0", "#54a0ff", "#1dd1a1", "#ff6b9b",
];

export function pickColor() {
  const used = new Set(db.prepare("SELECT color FROM users").all().map((r) => r.color));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

// Seed the admin (Tony) on first run.
export function seedAdmin() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (count > 0) return;
  const username = process.env.GUILD_ADMIN_USER || "Tony";
  const password = process.env.GUILD_ADMIN_PASSWORD || "fishon";
  const { salt, hash } = hashPassword(password);
  db.prepare(
    `INSERT INTO users (username, display_name, password_salt, password_hash, is_admin, color, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  ).run(username, username, salt, hash, "#ffcf5c", new Date().toISOString());
  console.log("=".repeat(60));
  console.log(`  Seeded admin user: "${username}"  password: "${password}"`);
  console.log("  CHANGE THIS PASSWORD after first login (Members panel).");
  console.log("  Set GUILD_ADMIN_PASSWORD before first run to override.");
  console.log("=".repeat(60));
}

export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: !!row.is_admin,
    color: row.color,
    createdAt: row.created_at,
  };
}
