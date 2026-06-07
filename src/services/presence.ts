// Live guild presence. Uses Firestore realtime when Firebase is enabled,
// otherwise a WebSocket to the self-hosted Node server. Either way it streams
// this device's GPS to the guild (opt-in) and surfaces everyone else's roster.
import type { AnglerPresence } from "../types";
import { getToken, wsBase, useFirebase } from "./api";

const SHARE_KEY = "guild.share.v1";
type Listener = (anglers: AnglerPresence[]) => void;

export function loadSharePref(): boolean {
  return localStorage.getItem(SHARE_KEY) === "1";
}
function saveSharePref(on: boolean): void {
  localStorage.setItem(SHARE_KEY, on ? "1" : "0");
}

// ---- Firebase delegation ----
type FB = typeof import("./firebase-backend");
let fbPromise: Promise<FB> | null = null;
function fb(): Promise<FB> {
  return (fbPromise ??= import("./firebase-backend"));
}

// ---- Node WebSocket state ----
let ws: WebSocket | null = null;
let roster: AnglerPresence[] = [];
const listeners = new Set<Listener>();
let geoWatchId: number | null = null;
let sharing = false;
let reconnectTimer: number | undefined;
let lastSent = 0;

export function isSharing(): boolean {
  return sharing || (useFirebase && loadSharePref());
}

export function onRoster(fn: Listener): () => void {
  if (useFirebase) {
    let off = () => {};
    fb().then((m) => { off = m.onRoster(fn); }).catch(() => {});
    return () => off();
  }
  listeners.add(fn);
  fn(roster);
  return () => listeners.delete(fn);
}
function emit(): void {
  for (const fn of listeners) fn(roster);
}

export function connect(): void {
  if (useFirebase) {
    fb().then((m) => m.connectPresence()).catch(() => {});
    return;
  }
  const token = getToken();
  if (!token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(`${wsBase()}/ws?token=${encodeURIComponent(token)}`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    if (loadSharePref()) startSharing();
  };
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data as string);
      if (m && m.type === "roster") {
        roster = (m.anglers as AnglerPresence[]) || [];
        emit();
      }
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}

function scheduleReconnect(): void {
  if (useFirebase || !getToken()) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connect, 3000);
}

export function disconnect(): void {
  if (useFirebase) {
    fb().then((m) => m.disconnectPresence()).catch(() => {});
    return;
  }
  stopSharing(false);
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
  roster = [];
  emit();
}

function sendLoc(lat: number, lon: number, accuracy?: number): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "loc", lat, lon, accuracy }));
}

export function startSharing(): boolean {
  if (!("geolocation" in navigator)) return false;
  if (useFirebase) {
    saveSharePref(true);
    fb().then((m) => m.startSharing()).catch(() => {});
    return true;
  }
  sharing = true;
  saveSharePref(true);
  if (geoWatchId == null) {
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - lastSent < 8000) return; // throttle updates
        lastSent = now;
        sendLoc(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      },
      () => { /* permission denied / unavailable - stay hidden */ },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
  }
  return true;
}

export function stopSharing(persist = true): void {
  if (useFirebase) {
    if (persist) saveSharePref(false);
    fb().then((m) => m.stopSharing(persist)).catch(() => {});
    return;
  }
  sharing = false;
  if (persist) saveSharePref(false);
  if (geoWatchId != null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
  lastSent = 0;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
}

export function toggleSharing(): boolean {
  if (useFirebase) {
    const willShare = !loadSharePref();
    saveSharePref(willShare);
    fb().then((m) => (willShare ? m.startSharing() : m.stopSharing())).catch(() => {});
    return willShare;
  }
  if (sharing) {
    stopSharing();
    return false;
  }
  return startSharing();
}
