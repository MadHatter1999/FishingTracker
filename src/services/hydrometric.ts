// Live freshwater level + flow for inland fishing - the freshwater analogue of
// the tide feed. Source: Environment Canada GeoMet "hydrometric" OGC API
// (Water Survey of Canada gauges). Free, no key, CORS *.
//   stations: https://api.weather.gc.ca/collections/hydrometric-stations
//   realtime: https://api.weather.gc.ca/collections/hydrometric-realtime
//
// Strategy: find the nearest ACTIVE real-time gauge to the spot, then pull its
// recent level/discharge series. Discharge present -> moving water (river/
// stream) which is what fires inflow/outflow lake fishing; level-only gauges are
// lake-level. `flowSignal` (0..1) feeds the freshwater hotspot scoring so the
// inflow/outflow marks rank up when the streams are high and dropping.
import { cachedJSON, TTL } from "./cache";
import type { HydroInfo, HydroPoint } from "../types";

const STN = "https://api.weather.gc.ca/collections/hydrometric-stations/items";
const RT = "https://api.weather.gc.ca/collections/hydrometric-realtime/items";
const SEARCH_DEG = 0.45; // ~50 km half-box to look for a gauge
const MAX_KM = 60; // a gauge farther than this isn't representative of this spot

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return v == null || !isFinite(n) ? null : n;
}

interface GeoFeat<P> { properties?: P; geometry?: { coordinates?: [number, number] }; }
interface StnProps { STATION_NAME?: string; STATION_NUMBER?: string; STATUS_EN?: string; REAL_TIME?: number; }
interface RtProps { DATETIME?: string; LEVEL?: number | null; DISCHARGE?: number | null; }

// Mean of the most recent `hours` vs the `hours` before that -> a trend, with a
// dead-band scaled by the series spread so noise doesn't read as "rising".
function trendOf(series: HydroPoint[], sel: (p: HydroPoint) => number | null, hours = 24): "rising" | "falling" | "steady" {
  const pts = series.map((p) => ({ t: Date.parse(p.time), v: sel(p) })).filter((p) => p.v != null && isFinite(p.t)) as { t: number; v: number }[];
  if (pts.length < 4) return "steady";
  const end = pts[pts.length - 1].t;
  const win = hours * 3600e3;
  const recent = pts.filter((p) => p.t >= end - win);
  const prior = pts.filter((p) => p.t < end - win && p.t >= end - 2 * win);
  if (!recent.length || !prior.length) return "steady";
  const mean = (a: { v: number }[]) => a.reduce((s, x) => s + x.v, 0) / a.length;
  const vals = pts.map((p) => p.v);
  const spread = Math.max(...vals) - Math.min(...vals);
  const dead = Math.max(spread * 0.04, 1e-4);
  const d = mean(recent) - mean(prior);
  return d > dead ? "rising" : d < -dead ? "falling" : "steady";
}

// 0..1 "how much moving water" proxy: where the latest value sits within the
// recent range, nudged up a touch when it's rising (fish stack on a freshet).
function flowSignal(series: HydroPoint[]): number {
  const useFlow = series.some((p) => p.discharge != null);
  const sel = useFlow ? (p: HydroPoint) => p.discharge : (p: HydroPoint) => p.level;
  const vals = series.map(sel).filter((v): v is number => v != null);
  if (vals.length < 2) return 0.5;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const last = vals[vals.length - 1];
  let s = hi > lo ? (last - lo) / (hi - lo) : 0.5;
  if (trendOf(series, sel) === "rising") s = Math.min(1, s + 0.15);
  return +s.toFixed(2);
}

function downsample(series: HydroPoint[], max: number): HydroPoint[] {
  if (series.length <= max) return series;
  const step = series.length / max;
  const out: HydroPoint[] = [];
  for (let i = 0; i < max; i++) out.push(series[Math.floor(i * step)]);
  out.push(series[series.length - 1]);
  return out;
}

export async function fetchNearestHydro(lat: number, lon: number): Promise<HydroInfo | null> {
  try {
    const su = new URL(STN);
    su.searchParams.set("bbox", `${lon - SEARCH_DEG},${lat - SEARCH_DEG},${lon + SEARCH_DEG},${lat + SEARCH_DEG}`);
    su.searchParams.set("properties", "STATION_NAME,STATION_NUMBER,STATUS_EN,REAL_TIME");
    su.searchParams.set("limit", "300");
    su.searchParams.set("f", "json");
    // Station metadata barely changes -> cache it long (reuse the stocking TTL).
    const sj = await cachedJSON(su.toString(), TTL.stocking, { label: "EC hydro stations" });
    const feats: GeoFeat<StnProps>[] = Array.isArray(sj?.features) ? sj.features : [];

    const cand = feats
      .map((f) => ({
        name: String(f.properties?.STATION_NAME ?? "").trim(),
        num: String(f.properties?.STATION_NUMBER ?? "").trim(),
        rt: Number(f.properties?.REAL_TIME) === 1,
        lon: f.geometry?.coordinates?.[0],
        lat: f.geometry?.coordinates?.[1],
      }))
      .filter((s) => s.num && s.rt && s.lat != null && s.lon != null && isFinite(s.lat) && isFinite(s.lon))
      .map((s) => ({ ...s, km: haversineKm(lat, lon, s.lat as number, s.lon as number) }))
      .filter((s) => s.km <= MAX_KM)
      .sort((a, b) => a.km - b.km);
    if (!cand.length) return null;
    const best = cand[0];

    const since = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 19) + "Z";
    const ru = new URL(RT);
    ru.searchParams.set("STATION_NUMBER", best.num);
    ru.searchParams.set("datetime", `${since}/..`);
    // Newest-first + a cap, so when a station has more points than the limit we
    // keep the LATEST ones (we re-sort ascending below for the series/trend).
    ru.searchParams.set("sortby", "-DATETIME");
    ru.searchParams.set("properties", "DATETIME,LEVEL,DISCHARGE");
    ru.searchParams.set("limit", "1500");
    ru.searchParams.set("f", "json");
    // Re-runs ~hourly upstream; the weather TTL (1h) keeps it current without hammering.
    const rj = await cachedJSON(ru.toString(), TTL.weather, { label: "EC hydro realtime" });
    const rows: GeoFeat<RtProps>[] = Array.isArray(rj?.features) ? rj.features : [];

    const series: HydroPoint[] = rows
      .map((r) => ({ time: String(r.properties?.DATETIME ?? ""), level: numOrNull(r.properties?.LEVEL), discharge: numOrNull(r.properties?.DISCHARGE) }))
      .filter((p) => p.time && (p.level != null || p.discharge != null))
      .sort((a, b) => a.time.localeCompare(b.time));
    if (!series.length) return null;

    const hasFlow = series.some((p) => p.discharge != null);
    return {
      stationName: best.name || best.num,
      stationNumber: best.num,
      distanceKm: +best.km.toFixed(1),
      kind: hasFlow ? "river" : "lake",
      latest: series[series.length - 1],
      series: downsample(series, 200),
      levelTrend: trendOf(series, (p) => p.level),
      dischargeTrend: trendOf(series, (p) => p.discharge),
      flowSignal: flowSignal(series),
    };
  } catch {
    return null;
  }
}
