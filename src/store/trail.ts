// Trail / Camp mode state: a breadcrumb track of where you've walked, a base-camp
// pin, and points of interest you drop along the way. Persisted to localStorage so
// it survives the map remounting (and app restarts) during a multi-day trip.
//
// Points are appended high-frequency while hiking, so (unlike the small spots/log
// stores) this mutates in place and the caller persists - cloning on every GPS
// tick would be wasteful.
import { haversineKm } from "../services/locations";

export interface TrailPoint { lat: number; lon: number; t: number; acc?: number; }
export interface TrailPoi { id: string; lat: number; lon: number; name: string; emoji: string; t: number; }
export interface TrailState {
  active: boolean;
  paused: boolean; // in-progress trip, but movement tracking is held (recharge break)
  startedAt: number | null;
  points: TrailPoint[];
  baseCamp: { lat: number; lon: number; name: string } | null;
  pois: TrailPoi[];
}

const KEY = "nsag.trail.v1";
const MAX_POINTS = 6000; // many hours of walking; cap so storage + redraw stay bounded
const MIN_MOVE_M = 8; // ignore sub-8m GPS jitter
const MIN_GAP_MS = 4000; // ...but log at least this often while moving

export function emptyTrail(): TrailState {
  return { active: false, paused: false, startedAt: null, points: [], baseCamp: null, pois: [] };
}

export function loadTrail(): TrailState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyTrail();
    return { ...emptyTrail(), ...(JSON.parse(raw) as Partial<TrailState>) };
  } catch {
    return emptyTrail();
  }
}

export function saveTrail(t: TrailState): void {
  try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* quota - ignore */ }
}

// Append a breadcrumb point only if we've meaningfully moved (de-noises a parked
// GPS that wanders within its own error circle). Returns true if a point was added.
export function maybeAppendPoint(t: TrailState, lat: number, lon: number, acc?: number): boolean {
  const now = Date.now();
  const last = t.points[t.points.length - 1];
  if (last) {
    const movedM = haversineKm(last.lat, last.lon, lat, lon) * 1000;
    if (movedM < MIN_MOVE_M && now - last.t < MIN_GAP_MS) return false;
    if (acc != null && acc > 50 && movedM < acc) return false; // fuzzy fix that hasn't clearly moved
  }
  t.points.push({ lat, lon, t: now, acc });
  if (t.points.length > MAX_POINTS) t.points.splice(0, t.points.length - MAX_POINTS);
  return true;
}

// Initial bearing (deg, 0=N) along the great circle from a -> b.
export function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toR = Math.PI / 180;
  const dLon = (bLon - aLon) * toR;
  const y = Math.sin(dLon) * Math.cos(bLat * toR);
  const x = Math.cos(aLat * toR) * Math.sin(bLat * toR) - Math.sin(aLat * toR) * Math.cos(bLat * toR) * Math.cos(dLon);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

// Evenly thin the breadcrumb down to <= max points (rounded to ~1m) for sharing
// over the wire, so a multi-hour hike still fits in one small presence write while
// keeping the path's overall shape. Always keeps the first and last point.
export function downsampleTrail(points: TrailPoint[], max = 150): { lat: number; lon: number }[] {
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  const n = points.length;
  if (n === 0) return [];
  if (n <= max) return points.map((p) => ({ lat: r5(p.lat), lon: r5(p.lon) }));
  const step = (n - 1) / (max - 1);
  const out: { lat: number; lon: number }[] = [];
  for (let i = 0; i < max; i++) {
    const p = points[Math.round(i * step)];
    out.push({ lat: r5(p.lat), lon: r5(p.lon) });
  }
  return out;
}

// Total walked distance of the breadcrumb, in km.
export function trailLengthKm(t: TrailState): number {
  let km = 0;
  for (let i = 1; i < t.points.length; i++) {
    km += haversineKm(t.points[i - 1].lat, t.points[i - 1].lon, t.points[i].lat, t.points[i].lon);
  }
  return km;
}

// ---- Trail History: a local archive of finished trips ----
// An archived trip is just a finished TrailState (so it can be replayed on the map
// straight through setTrail) plus an id and end time.
export interface ArchivedTrail extends TrailState { id: string; endedAt: number; }

const HISTORY_KEY = "nsag.trailhistory.v1";
const HISTORY_MAX = 60;

export function loadTrailHistory(): ArchivedTrail[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as ArchivedTrail[]) : [];
  } catch {
    return [];
  }
}
export function saveTrailHistory(list: ArchivedTrail[]): void {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* quota - ignore */ }
}

// Archive a finished trail (newest first). No-ops on an empty trip. Returns the
// updated history list.
export function archiveTrail(t: TrailState): ArchivedTrail[] {
  const list = loadTrailHistory();
  if (!t.points.length && !t.pois.length && !t.baseCamp) return list;
  const item: ArchivedTrail = {
    ...t,
    active: false,
    paused: false,
    id: `th-${t.startedAt ?? Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    endedAt: Date.now(),
  };
  const next = [item, ...list].slice(0, HISTORY_MAX);
  saveTrailHistory(next);
  return next;
}

export function deleteArchivedTrail(id: string): ArchivedTrail[] {
  const next = loadTrailHistory().filter((t) => t.id !== id);
  saveTrailHistory(next);
  return next;
}

// ---- Trail-share recipients (one-way): member ids who may see your live trail ----
// Persists independently of any single trip (survives Clear trip).
const SHAREWITH_KEY = "nsag.trailshare.v1";
export function loadShareWith(): string[] {
  try {
    const raw = localStorage.getItem(SHAREWITH_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
export function saveShareWith(ids: string[]): void {
  try { localStorage.setItem(SHAREWITH_KEY, JSON.stringify(ids)); } catch { /* ignore */ }
}
