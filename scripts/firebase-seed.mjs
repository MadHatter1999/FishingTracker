// One-time seed: creates the guild admin (Tony) in Firebase Auth + Firestore.
// Run this once after creating your Firebase project, before anyone logs in.
//
//   1. Firebase console -> Project settings -> Service accounts ->
//      "Generate new private key" -> save it as serviceAccountKey.json here.
//   2. npm i -D firebase-admin
//   3. node scripts/firebase-seed.mjs
//
// Override the admin via env vars: GUILD_ADMIN_USER, GUILD_ADMIN_PASSWORD,
// GUILD_EMAIL_DOMAIN. The email domain MUST match VITE_GUILD_EMAIL_DOMAIN.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const keyPath = resolve(process.argv[2] || process.env.GOOGLE_APPLICATION_CREDENTIALS || join(root, "serviceAccountKey.json"));
if (!existsSync(keyPath)) {
  console.error(`\nService account key not found at: ${keyPath}`);
  console.error("Download it from Firebase console -> Project settings -> Service accounts -> Generate new private key,");
  console.error("save it as serviceAccountKey.json in the project root, then run this again.\n");
  process.exit(1);
}

let admin;
try {
  admin = (await import("firebase-admin")).default;
} catch {
  console.error("\nThe firebase-admin package isn't installed. Run:\n  npm i -D firebase-admin\nthen run this script again.\n");
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const USERNAME = process.env.GUILD_ADMIN_USER || "Tony";
const PASSWORD = process.env.GUILD_ADMIN_PASSWORD || "fishon";
const DOMAIN = process.env.GUILD_EMAIL_DOMAIN || "nsanglers.local";
const email = `${USERNAME.trim().toLowerCase()}@${DOMAIN}`;

const auth = admin.auth();
const db = admin.firestore();

let uid;
try {
  const existing = await auth.getUserByEmail(email);
  uid = existing.uid;
  await auth.updateUser(uid, { password: PASSWORD, displayName: USERNAME });
  console.log(`Updated existing admin auth user (${email}).`);
} catch {
  const created = await auth.createUser({ email, password: PASSWORD, displayName: USERNAME });
  uid = created.uid;
  console.log(`Created admin auth user (${email}).`);
}

await db.collection("users").doc(uid).set(
  {
    username: USERNAME,
    usernameLower: USERNAME.toLowerCase(),
    displayName: USERNAME,
    color: "#ffcf5c",
    role: "admin",
    active: true,
    createdAt: new Date().toISOString(),
    createdBy: null,
  },
  { merge: true }
);

console.log("=".repeat(58));
console.log(`  Guild admin ready.`);
console.log(`  Username: ${USERNAME}`);
console.log(`  Password: ${PASSWORD}`);
console.log(`  Change it after first login (Members -> Your account).`);
console.log("=".repeat(58));
process.exit(0);
