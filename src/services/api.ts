// Guild backend facade. Picks Firebase (Auth + Firestore) when Firebase config
// is present, otherwise falls back to the self-hosted Node API. The Firebase
// implementation is dynamically imported so its SDK stays in a separate chunk.
import type { GuildUser, CatchRecord, MemberTrip } from "../types";

export const useFirebase = Boolean(import.meta.env.VITE_FIREBASE_API_KEY && import.meta.env.VITE_FIREBASE_PROJECT_ID);

type FB = typeof import("./firebase-backend");
let fbPromise: Promise<FB> | null = null;
function fb(): Promise<FB> {
  return (fbPromise ??= import("./firebase-backend"));
}

export function backendMode(): "firebase" | "node" {
  return useFirebase ? "firebase" : "node";
}
export function backendCaps(): { mode: "firebase" | "node"; adminResetPassword: boolean; hardDelete: boolean } {
  return useFirebase
    ? { mode: "firebase", adminResetPassword: false, hardDelete: false }
    : { mode: "node", adminResetPassword: true, hardDelete: true };
}

// ---- Node API config (only used when Firebase is off) ----
const API_BASE = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? "http://localhost:8787" : "")).replace(/\/$/, "");
const TOKEN_KEY = "guild.token.v1";
const USER_KEY = "guild.user.v1";

export function apiBase(): string {
  return API_BASE;
}
export function wsBase(): string {
  if (API_BASE) return API_BASE.replace(/^http/, "ws");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
}
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

// ---- current user cache (shared across backends, kept sync for the UI) ----
let currentUser: GuildUser | null = readStoredUser();
function readStoredUser(): GuildUser | null {
  try {
    const r = localStorage.getItem(USER_KEY);
    return r ? (JSON.parse(r) as GuildUser) : null;
  } catch {
    return null;
  }
}
export function getCurrentUser(): GuildUser | null {
  return currentUser;
}
function setCurrentUser(u: GuildUser | null): void {
  currentUser = u;
  if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
  else localStorage.removeItem(USER_KEY);
}

async function apiNode<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...((opts.headers as Record<string, string>) || {}) };
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { ...opts, headers });
  } catch {
    throw new Error("Can't reach the guild server. Is it running?");
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    throw new Error((data as { error?: string } | null)?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

// ---- auth ----
export async function login(username: string, password: string): Promise<GuildUser> {
  let user: GuildUser;
  if (useFirebase) {
    user = await (await fb()).login(username, password);
  } else {
    const resp = await apiNode<{ token: string; user: GuildUser }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    if (!resp || !resp.token) {
      throw new Error(
        "This build has no Firebase config, so it is using the local server, which is not running here. " +
        "Add your VITE_FIREBASE_* values to .env.local, rebuild, and redeploy."
      );
    }
    setToken(resp.token);
    user = resp.user;
  }
  setCurrentUser(user);
  return user;
}

export function logout(): void {
  if (useFirebase) fb().then((m) => m.logout()).catch(() => {});
  setToken(null);
  setCurrentUser(null);
}

export async function fetchMe(): Promise<GuildUser | null> {
  if (useFirebase) {
    const user = await (await fb()).init();
    setCurrentUser(user);
    return user;
  }
  if (!getToken()) return null;
  try {
    const { user } = await apiNode<{ user: GuildUser }>("/api/me");
    setCurrentUser(user);
    return user;
  } catch {
    logout();
    return null;
  }
}

export async function changeMyPassword(currentPassword: string, newPassword: string): Promise<void> {
  if (useFirebase) return (await fb()).changeMyPassword(currentPassword, newPassword);
  await apiNode("/api/me/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
}

// ---- admin: user management ----
export async function listUsers(): Promise<GuildUser[]> {
  if (useFirebase) return (await fb()).listUsers();
  return (await apiNode<{ users: GuildUser[] }>("/api/users")).users;
}

// Public guild roster, readable by ANY active member (for the Trail-mode member
// lookup). Firebase serves the users collection to all members; the Node backend
// gates /api/users to admins, so it has a separate non-admin /api/members route.
export async function listMembers(): Promise<GuildUser[]> {
  if (useFirebase) return (await fb()).listUsers();
  return (await apiNode<{ members: GuildUser[] }>("/api/members")).members;
}
export async function createUser(payload: {
  username: string;
  password: string;
  displayName?: string;
  color?: string;
  isAdmin?: boolean;
}): Promise<GuildUser> {
  if (useFirebase) return (await fb()).createUser(payload);
  return (await apiNode<{ user: GuildUser }>("/api/users", { method: "POST", body: JSON.stringify(payload) })).user;
}
export async function updateUser(
  id: string | number,
  payload: { displayName?: string; color?: string; isAdmin?: boolean; active?: boolean }
): Promise<GuildUser> {
  if (useFirebase) return (await fb()).updateUser(id, payload);
  return (await apiNode<{ user: GuildUser }>(`/api/users/${id}`, { method: "PUT", body: JSON.stringify(payload) })).user;
}
export async function setUserActive(id: string | number, active: boolean): Promise<void> {
  if (useFirebase) return (await fb()).setUserActive(id, active);
  throw new Error("Enable/disable isn't supported by the Node backend - use Remove instead.");
}
export async function resetUserPassword(id: string | number, newPassword: string): Promise<void> {
  if (useFirebase) throw new Error("Admin password reset needs the Blaze plan. Have the member change their own password, or disable + recreate them.");
  await apiNode(`/api/users/${id}/password`, { method: "POST", body: JSON.stringify({ newPassword }) });
}
export async function deleteUser(id: string | number): Promise<void> {
  if (useFirebase) return (await fb()).deleteUser(id);
  await apiNode(`/api/users/${id}`, { method: "DELETE" });
}

// ---- catch-log trip sync (Firebase only; no-op on the Node backend) ----
export function tripsShared(): boolean {
  return useFirebase;
}
export async function syncTripSave(trip: CatchRecord): Promise<void> {
  if (!useFirebase) return;
  try { await (await fb()).saveTrip(trip); } catch { /* offline / non-fatal */ }
}
export async function syncTripDelete(id: string): Promise<void> {
  if (!useFirebase) return;
  try { await (await fb()).deleteTrip(id); } catch { /* non-fatal */ }
}
export async function listAllTrips(): Promise<MemberTrip[]> {
  if (!useFirebase) return [];
  return (await fb()).listAllTrips();
}
