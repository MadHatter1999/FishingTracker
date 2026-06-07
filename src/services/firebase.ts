// Firebase initialisation (Spark / free plan: Auth + Firestore, all client-side).
// This module is only ever imported lazily (via firebase-backend.ts) so the
// Firebase SDK lands in its own chunk and never bloats the Node-backend build.
import { initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

const config: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};

let app: FirebaseApp | null = null;
export function fbApp(): FirebaseApp {
  if (!app) app = initializeApp(config);
  return app;
}
export function fbAuth(): Auth {
  return getAuth(fbApp());
}
export function fbDb(): Firestore {
  return getFirestore(fbApp());
}

// Members log in with a username, but Firebase Auth needs an email - so we map
// each username to a stable internal address. Must match the seed script.
export const EMAIL_DOMAIN = import.meta.env.VITE_GUILD_EMAIL_DOMAIN || "nsanglers.local";
export function emailFor(username: string): string {
  return `${username.trim().toLowerCase()}@${EMAIL_DOMAIN}`;
}
