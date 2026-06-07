// Live Nova Scotia provincial fish-stocking history for a waterbody.
// Source: NS open data "Fish Hatchery Stocking Records" (Socrata, CORS-enabled,
// no API key). https://data.novascotia.ca/d/8e4a-m6fw
//
// Matching: the dataset names each release by waterbody (e.g. "MAYNARD") and
// stores UTM (zone 20N) easting/northing. We query by the lake's name token(s),
// then use distance as a tie-breaker (so e.g. several "Long Lake"s across the
// province resolve to the nearest one). This keeps adjacent urban lakes
// (Maynard vs Banook vs Penhorn) from bleeding into each other.
import type { FishingLocation, StockingInfo, StockingEntry } from "../types";

const DATASET = "https://data.novascotia.ca/resource/8e4a-m6fw.json";
const SINCE = "2018-01-01T00:00:00"; // recent enough to reflect the current fishery
const MAX_KM = 7; // a same-named release farther than this isn't this lake
const RECENT_WEEKS = 12; // "recently stocked" window

// --- UTM zone 20N (WGS84) inverse (easting/northing -> lat/lon) ---
const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const K0 = 0.9996;
const LON0 = (-63 * Math.PI) / 180; // zone 20 central meridian

function utm20ToLatLon(east: number, north: number): [number, number] {
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const x = east - 500000;
  const M = north / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
  const phi1 = mu
    + (3 * e1 / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu)
    + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const ep2 = E2 / (1 - E2);
  const C1 = ep2 * Math.cos(phi1) ** 2;
  const T1 = Math.tan(phi1) ** 2;
  const N1 = A / Math.sqrt(1 - E2 * Math.sin(phi1) ** 2);
  const R1 = (A * (1 - E2)) / Math.pow(1 - E2 * Math.sin(phi1) ** 2, 1.5);
  const D = x / (N1 * K0);
  const lat = phi1 - (N1 * Math.tan(phi1) / R1) * (D * D / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = LON0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / Math.cos(phi1);
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

interface Row {
  name?: string;
  stock?: string;
  number_released?: string;
  stocking_date?: string;
  easting?: string;
  northing?: string;
}

// Significant words from a lake name to search the dataset's `name` column.
function nameTokens(name: string): string[] {
  return [...new Set(
    name
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !["LAKE", "POND", "RESERVOIR"].includes(w))
  )];
}

export async function fetchStocking(loc: FishingLocation): Promise<StockingInfo | null> {
  try {
    const tokens = nameTokens(loc.name);
    if (!tokens.length) return null;
    const where = "(" + tokens.map((t) => `upper(name) like '%${t}%'`).join(" OR ") + `) AND stocking_date > '${SINCE}'`;
    const u = new URL(DATASET);
    u.searchParams.set("$select", "name,stock,number_released,stocking_date,easting,northing");
    u.searchParams.set("$where", where);
    u.searchParams.set("$order", "stocking_date DESC");
    u.searchParams.set("$limit", "600");

    const res = await fetch(u.toString());
    if (!res.ok) return null;
    const rows = (await res.json()) as Row[];
    if (!Array.isArray(rows) || !rows.length) return null;

    // Group candidate releases by waterbody name; pick the nearest one to the lake.
    const groups = new Map<string, { records: Row[]; minKm: number }>();
    for (const r of rows) {
      const key = String(r.name || "").trim();
      if (!key) continue;
      let km = Infinity;
      const e = Number(r.easting);
      const n = Number(r.northing);
      if (isFinite(e) && isFinite(n)) {
        const [la, lo] = utm20ToLatLon(e, n);
        km = haversineKm(loc.lat, loc.lon, la, lo);
      }
      const g = groups.get(key) || { records: [], minKm: Infinity };
      g.records.push(r);
      g.minKm = Math.min(g.minKm, km);
      groups.set(key, g);
    }
    let best: { name: string; records: Row[]; minKm: number } | null = null;
    for (const [name, g] of groups) if (!best || g.minKm < best.minKm) best = { name, records: g.records, minKm: g.minKm };
    if (!best || best.minKm > MAX_KM) return null;

    const records: StockingEntry[] = best.records
      .map((r) => ({
        species: String(r.stock || "").trim(),
        number: Math.round(Number(r.number_released) || 0),
        date: String(r.stocking_date || "").slice(0, 10),
      }))
      .filter((r) => r.species && r.date)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (!records.length) return null;

    const map = new Map<string, { total: number; latest: string }>();
    for (const r of records) {
      const cur = map.get(r.species) || { total: 0, latest: "" };
      cur.total += r.number;
      if (r.date > cur.latest) cur.latest = r.date;
      map.set(r.species, cur);
    }
    const bySpecies = [...map.entries()]
      .map(([species, v]) => ({ species, total: v.total, latest: v.latest }))
      .sort((a, b) => b.latest.localeCompare(a.latest) || b.total - a.total);

    const latest = records.reduce((m, r) => (r.date > m ? r.date : m), "");
    const recentlyStocked = latest ? Date.now() - Date.parse(latest) < RECENT_WEEKS * 7 * 86400000 : false;
    const waterbody = best.name || loc.name;

    return { waterbody, records: records.slice(0, 12), bySpecies, latest: latest || null, recentlyStocked };
  } catch {
    return null;
  }
}

// Map a dataset stock name ("Rainbow Trout") to a FRESH_SPECIES key.
export function stockingSpeciesKey(stock: string): string {
  const s = stock.toLowerCase();
  if (s.includes("rainbow")) return "rainbow-trout";
  if (s.includes("brown")) return "brown-trout";
  if (s.includes("brook") || s.includes("speckled") || s.includes("splake")) return "brook-trout";
  if (s.includes("salmon")) return "atlantic-salmon";
  return s;
}
