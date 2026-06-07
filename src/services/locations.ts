import type { FishingLocation } from "../types";
import { LOCATION, NS_LAKES } from "../config";

// Decide the right location for an arbitrary clicked/device point: if it falls
// within a known lake's radius treat it as freshwater (that lake's species),
// otherwise it's a saltwater spot using the nearest tide gauge.
export function locationForPoint(lat: number, lon: number, list: FishingLocation[], label = "Pinned spot"): FishingLocation {
  let near: { name: string; km: number; brackish: boolean } | null = null;
  for (const lk of NS_LAKES) {
    const km = haversineKm(lat, lon, lk.lat, lk.lon);
    if (km <= lk.radiusKm && (!near || km < near.km)) near = { name: lk.name, km, brackish: lk.brackish ?? false };
  }
  if (near) {
    const lat5 = +lat.toFixed(5), lon5 = +lon.toFixed(5);
    return {
      id: `pin:${lat5},${lon5}`,
      name: `${label} (${near.name})`,
      area: near.brackish ? `Freshwater/brackish - near ${near.name}` : `Freshwater - near ${near.name}`,
      lat: lat5, lon: lon5,
      tideStationId: "", tideStationName: "Freshwater (no tide)",
      home: false, kind: "fresh", brackish: near.brackish,
    };
  }
  return makePinnedLocation(lat, lon, list, label);
}

// The home spot: McCormacks Beach is not itself a tide gauge, so it reads tides
// from the Halifax gauge (same harbour system, a few minutes offset).
export const HOME: FishingLocation = {
  id: "home",
  name: LOCATION.name,
  area: LOCATION.area,
  lat: LOCATION.lat,
  lon: LOCATION.lon,
  tideStationId: LOCATION.tideStationId,
  tideStationName: LOCATION.tideStationName,
  home: true,
  kind: "salt",
};

// Freshwater lakes (no tides). Built from the curated NS_LAKES list.
export const LAKES: FishingLocation[] = NS_LAKES.map((l) => ({
  id: `lake:${l.name}`,
  name: l.name,
  area: `Freshwater lake - ${l.note}`,
  lat: l.lat,
  lon: l.lon,
  tideStationId: "",
  tideStationName: "Freshwater (no tide)",
  home: false,
  kind: "fresh",
  brackish: l.brackish ?? false,
}));

const STATIONS_URL = "https://api-iwls.dfo-mpo.gc.ca/api/v1/stations";

// Nova Scotia bounding box (a little generous so border ports are included).
const NS = { latMin: 43.3, latMax: 47.2, lonMin: -66.6, lonMax: -59.4 };

interface RawStation {
  id: string;
  code: string;
  officialName: string;
  latitude: number;
  longitude: number;
  operating: boolean;
  type: string;
  timeSeries?: { code: string }[];
}

const STORAGE_KEY = "mccormacks.location.v1";
let cache: FishingLocation[] | null = null;

export async function loadNSLocations(): Promise<FishingLocation[]> {
  if (cache) return cache;
  try {
    const res = await fetch(STATIONS_URL);
    if (!res.ok) throw new Error(`stations ${res.status}`);
    const all = (await res.json()) as RawStation[];
    const ns = all
      .filter(
        (s) =>
          s.latitude >= NS.latMin && s.latitude <= NS.latMax &&
          s.longitude >= NS.lonMin && s.longitude <= NS.lonMax &&
          (s.timeSeries ?? []).some((t) => t.code === "wlp-hilo" || t.code === "wlp")
      )
      .map(
        (s): FishingLocation => ({
          id: s.id,
          name: titleCase(s.officialName),
          area: `Nova Scotia (CHS ${s.code})`,
          lat: s.latitude,
          lon: s.longitude,
          tideStationId: s.id,
          tideStationName: `${titleCase(s.officialName)} (CHS ${s.code})`,
          home: false,
          kind: "salt",
        })
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    cache = [HOME, ...LAKES, ...ns];
  } catch (e) {
    console.warn("Station list failed; offering home + lakes only", e);
    cache = [HOME, ...LAKES];
  }
  return cache;
}

export function getActiveLocation(): FishingLocation {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const loc = JSON.parse(raw) as FishingLocation;
      // always use the current (corrected) home coordinates, ignoring stale cached copies
      return loc.id === "home" ? HOME : loc;
    }
  } catch {
    /* ignore */
  }
  return HOME;
}

export function setActiveLocation(loc: FishingLocation): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(loc));
}

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Nearest CHS gauge (with predictions) to an arbitrary point.
export function nearestStation(lat: number, lon: number, list: FishingLocation[]): { station: FishingLocation; km: number } | null {
  const stations = list.filter((l) => l.kind === "salt" && !l.home && !l.saved && !!l.tideStationId && l.id === l.tideStationId);
  if (!stations.length) return null;
  let best = stations[0];
  let bestKm = Infinity;
  for (const s of stations) {
    const km = haversineKm(lat, lon, s.lat, s.lon);
    if (km < bestKm) { bestKm = km; best = s; }
  }
  return { station: best, km: bestKm };
}

// Build a fishing location for an arbitrary pinned/device point: weather uses the
// exact coordinates, tides use the nearest CHS gauge.
export function makePinnedLocation(lat: number, lon: number, list: FishingLocation[], label = "Pinned spot"): FishingLocation {
  const near = nearestStation(lat, lon, list);
  const lat5 = +lat.toFixed(5), lon5 = +lon.toFixed(5);
  return {
    id: `pin:${lat5},${lon5}`,
    name: label,
    area: near
      ? `${lat5}, ${lon5} · tides via ${near.station.name} (${near.km.toFixed(1)} km)`
      : `${lat5}, ${lon5}`,
    lat: lat5,
    lon: lon5,
    tideStationId: near ? near.station.tideStationId : HOME.tideStationId,
    tideStationName: near ? near.station.tideStationName : HOME.tideStationName,
    home: false,
    kind: "salt",
  };
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bN\.s\.\b/i, "NS");
}
