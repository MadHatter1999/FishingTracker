// Firebase (Spark/free) implementation of the guild backend: Auth for login,
// Firestore for member profiles/roles and live presence. All client-side - no
// Cloud Functions, no billing account required.
import { initializeApp, deleteApp } from "firebase/app";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword, updatePassword, reauthenticateWithCredential, EmailAuthProvider,
} from "firebase/auth";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, collection, onSnapshot, deleteDoc, serverTimestamp,
} from "firebase/firestore";
import { fbApp, fbAuth, fbDb, emailFor } from "./firebase";
import type { GuildUser, AnglerPresence, CatchRecord, MemberTrip } from "../types";

const SHARE_KEY = "guild.share.v1";
const STALE_MS = 60000; // hide members whose last ping is older than this

let currentProfile: GuildUser | null = null;
export function getCurrentUser(): GuildUser | null {
  return currentProfile;
}

interface UserDoc {
  username: string;
  displayName: string;
  color: string;
  role: "admin" | "member";
  active?: boolean;
  createdAt?: string;
}

function toUser(uid: string, d: UserDoc, online?: boolean): GuildUser {
  return {
    id: uid,
    username: d.username,
    displayName: d.displayName,
    isAdmin: d.role === "admin",
    color: d.color,
    createdAt: d.createdAt ?? "",
    active: d.active !== false,
    online,
  };
}

function mapAuthError(e: unknown): string {
  const code = (e as { code?: string })?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "Invalid username or password";
  if (code.includes("configuration-not-found")) return "Firebase Authentication is not enabled for this project. In Firebase Console, open nova-scotian-anglers > Build > Authentication > Get started, then enable Email/Password.";
  if (code.includes("too-many-requests")) return "Too many attempts - try again shortly";
  if (code.includes("email-already-in-use")) return "That username is already taken";
  if (code.includes("weak-password")) return "Password must be at least 6 characters";
  if (code.includes("network")) return "Can't reach Firebase - check your connection";
  return (e as Error)?.message || "Authentication error";
}

// ---- auth ----
export async function login(username: string, password: string): Promise<GuildUser> {
  let cred;
  try {
    cred = await signInWithEmailAndPassword(fbAuth(), emailFor(username), password);
  } catch (e) {
    throw new Error(mapAuthError(e));
  }
  const snap = await getDoc(doc(fbDb(), "users", cred.user.uid));
  if (!snap.exists()) {
    await signOut(fbAuth());
    throw new Error("No guild profile for this account. Ask your admin to set you up.");
  }
  const d = snap.data() as UserDoc;
  if (d.active === false) {
    await signOut(fbAuth());
    throw new Error("Your account has been disabled. Contact your guild admin.");
  }
  currentProfile = toUser(cred.user.uid, d);
  return currentProfile;
}

// Restore an existing session on page load.
export function init(): Promise<GuildUser | null> {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(fbAuth(), async (u) => {
      unsub();
      if (!u) {
        currentProfile = null;
        return resolve(null);
      }
      try {
        const snap = await getDoc(doc(fbDb(), "users", u.uid));
        if (!snap.exists() || (snap.data() as UserDoc).active === false) {
          await signOut(fbAuth());
          currentProfile = null;
          return resolve(null);
        }
        currentProfile = toUser(u.uid, snap.data() as UserDoc);
        resolve(currentProfile);
      } catch {
        currentProfile = null;
        resolve(null);
      }
    });
  });
}

export async function logout(): Promise<void> {
  disconnectPresence();
  await signOut(fbAuth());
  currentProfile = null;
}

export async function changeMyPassword(current: string, next: string): Promise<void> {
  const u = fbAuth().currentUser;
  if (!u || !u.email) throw new Error("Not signed in");
  if (String(next).length < 6) throw new Error("New password must be at least 6 characters");
  try {
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, current));
  } catch {
    throw new Error("Current password is incorrect");
  }
  await updatePassword(u, next);
}

// ---- admin: user management ----
export async function listUsers(): Promise<GuildUser[]> {
  const [usersSnap, presenceSnap] = await Promise.all([
    getDocs(collection(fbDb(), "users")),
    getDocs(collection(fbDb(), "presence")),
  ]);
  const now = Date.now();
  const online = new Set<string>();
  presenceSnap.forEach((p) => {
    const v = p.data() as { updatedAt?: number; sharing?: boolean };
    if (v.sharing && typeof v.updatedAt === "number" && now - v.updatedAt < STALE_MS) online.add(p.id);
  });
  const out: GuildUser[] = [];
  usersSnap.forEach((d) => out.push(toUser(d.id, d.data() as UserDoc, online.has(d.id))));
  out.sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin) || a.username.localeCompare(b.username));
  return out;
}

export async function createUser(payload: {
  username: string;
  password: string;
  displayName?: string;
  color?: string;
  isAdmin?: boolean;
}): Promise<GuildUser> {
  const username = payload.username.trim();
  if (!/^[a-z0-9._-]{2,32}$/i.test(username)) throw new Error("Username must be 2-32 letters, numbers, . _ - only");
  if (payload.password.length < 6) throw new Error("Password must be at least 6 characters");

  // Create the Auth account on a throwaway secondary app instance so the admin
  // stays signed in on the primary app (Spark plan has no Admin SDK).
  const secondary = initializeApp(fbApp().options, "guild-secondary-" + Date.now());
  const secAuth = getAuth(secondary);
  let uid: string;
  try {
    const cred = await createUserWithEmailAndPassword(secAuth, emailFor(username), payload.password);
    uid = cred.user.uid;
    await signOut(secAuth);
  } catch (e) {
    await deleteApp(secondary).catch(() => {});
    throw new Error(mapAuthError(e));
  }
  await deleteApp(secondary).catch(() => {});

  // Write the profile as the (still signed-in) admin so security rules allow it.
  const profile: UserDoc & { usernameLower: string; createdBy: string | null } = {
    username,
    usernameLower: username.toLowerCase(),
    displayName: (payload.displayName || username).trim().slice(0, 40) || username,
    color: payload.color && /^#[0-9a-fA-F]{6}$/.test(payload.color) ? payload.color : "#5ee0a0",
    role: payload.isAdmin ? "admin" : "member",
    active: true,
    createdAt: new Date().toISOString(),
    createdBy: fbAuth().currentUser?.uid ?? null,
  };
  await setDoc(doc(fbDb(), "users", uid), profile);
  return toUser(uid, profile);
}

export async function updateUser(
  id: string | number,
  payload: { displayName?: string; color?: string; isAdmin?: boolean; active?: boolean }
): Promise<GuildUser> {
  const ref = doc(fbDb(), "users", String(id));
  const upd: Record<string, unknown> = {};
  if (payload.displayName != null) upd.displayName = payload.displayName.trim().slice(0, 40);
  if (payload.color != null) upd.color = payload.color;
  if (payload.isAdmin != null) upd.role = payload.isAdmin ? "admin" : "member";
  if (payload.active != null) upd.active = payload.active;
  await updateDoc(ref, upd);
  const snap = await getDoc(ref);
  return toUser(String(id), snap.data() as UserDoc);
}

export async function setUserActive(id: string | number, active: boolean): Promise<void> {
  await updateDoc(doc(fbDb(), "users", String(id)), { active });
}

// No Admin SDK on Spark -> "remove" = disable (lock out). Account can be re-enabled.
export async function deleteUser(id: string | number): Promise<void> {
  await setUserActive(id, false);
}

// ---- catch-log trips (synced so admins can see everyone's) ----
export async function saveTrip(trip: CatchRecord): Promise<void> {
  const me = fbAuth().currentUser;
  if (!me) return;
  await setDoc(doc(fbDb(), "trips", String(trip.id)), {
    ...trip,
    userId: me.uid,
    displayName: currentProfile?.displayName ?? "Angler",
    createdAt: new Date().toISOString(),
  });
}

export async function deleteTrip(id: string): Promise<void> {
  await deleteDoc(doc(fbDb(), "trips", id)).catch(() => {});
}

// Admin-only: every member's trips, newest first.
export async function listAllTrips(): Promise<MemberTrip[]> {
  const snap = await getDocs(collection(fbDb(), "trips"));
  const out: MemberTrip[] = [];
  snap.forEach((d) => out.push(d.data() as MemberTrip));
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out;
}

// ---- live presence (Firestore realtime) ----
type RosterListener = (anglers: AnglerPresence[]) => void;
const rosterListeners = new Set<RosterListener>();
let lastRoster: AnglerPresence[] = [];
let presenceUnsub: (() => void) | null = null;
let geoWatch: number | null = null;
let sharing = false;
let lastSent = 0;
let pageHideBound = false;

export function loadSharePref(): boolean {
  return localStorage.getItem(SHARE_KEY) === "1";
}
function saveSharePref(on: boolean): void {
  localStorage.setItem(SHARE_KEY, on ? "1" : "0");
}
export function isSharing(): boolean {
  return sharing;
}
export function onRoster(fn: RosterListener): () => void {
  rosterListeners.add(fn);
  fn(lastRoster);
  return () => rosterListeners.delete(fn);
}
function emit(): void {
  for (const fn of rosterListeners) fn(lastRoster);
}

export function connectPresence(): void {
  const me = fbAuth().currentUser;
  if (!me) return;
  if (!presenceUnsub) {
    presenceUnsub = onSnapshot(collection(fbDb(), "presence"), (snap) => {
      const now = Date.now();
      const out: AnglerPresence[] = [];
      snap.forEach((d) => {
        if (d.id === me.uid) return;
        const v = d.data() as { displayName?: string; username?: string; color?: string; lat?: number; lon?: number; sharing?: boolean; updatedAt?: number };
        if (!v.sharing || typeof v.lat !== "number" || typeof v.lon !== "number") return;
        if (typeof v.updatedAt !== "number" || now - v.updatedAt > STALE_MS) return;
        out.push({
          id: d.id,
          username: v.username ?? "",
          displayName: v.displayName ?? "Angler",
          color: v.color ?? "#36c2ce",
          lat: v.lat,
          lon: v.lon,
          updatedAt: new Date(v.updatedAt).toISOString(),
        });
      });
      lastRoster = out;
      emit();
    });
  }
  if (loadSharePref()) startSharing();
}

async function writePresence(lat: number, lon: number, accuracy?: number): Promise<void> {
  const me = fbAuth().currentUser;
  if (!me) return;
  await setDoc(doc(fbDb(), "presence", me.uid), {
    displayName: currentProfile?.displayName ?? "Angler",
    username: currentProfile?.username ?? "",
    color: currentProfile?.color ?? "#36c2ce",
    lat,
    lon,
    accuracy: accuracy ?? null,
    sharing: true,
    updatedAt: Date.now(),
    serverAt: serverTimestamp(),
  }).catch(() => {});
}

export function startSharing(): boolean {
  if (!("geolocation" in navigator)) return false;
  sharing = true;
  saveSharePref(true);
  if (!pageHideBound) {
    pageHideBound = true;
    window.addEventListener("pagehide", () => { if (sharing) clearPresenceDoc(); });
  }
  if (geoWatch == null) {
    geoWatch = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - lastSent < 10000) return; // throttle Firestore writes
        lastSent = now;
        void writePresence(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      },
      () => { /* permission denied / unavailable */ },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
  }
  return true;
}

function clearPresenceDoc(): void {
  const me = fbAuth().currentUser;
  if (me) deleteDoc(doc(fbDb(), "presence", me.uid)).catch(() => {});
}

export function stopSharing(persist = true): void {
  sharing = false;
  if (persist) saveSharePref(false);
  if (geoWatch != null) {
    navigator.geolocation.clearWatch(geoWatch);
    geoWatch = null;
  }
  lastSent = 0;
  clearPresenceDoc();
}

export function toggleSharing(): boolean {
  if (sharing) {
    stopSharing();
    return false;
  }
  return startSharing();
}

export function disconnectPresence(): void {
  stopSharing(false);
  if (presenceUnsub) {
    presenceUnsub();
    presenceUnsub = null;
  }
  lastRoster = [];
  emit();
}
