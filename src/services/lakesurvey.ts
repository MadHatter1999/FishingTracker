// Measured lake morphometry + water quality from the NS Environment Lake Survey
// (2,400+ surveyed stations). Free, no key, CORS *. This is the freshwater
// equivalent of the sea charts/bathymetry: real maximum & mean depth, water
// clarity (Secchi), bottom oxygen, pH and colour per lake. It both drives a
// "Lake profile" panel and feeds the stratification model (lakestate.ts) with a
// real depth instead of a guess.
//
// IMPORTANT: this hosted layer exposes NO queryable geometry (returnGeometry and
// spatial envelope filters are ignored - every query returns the full table), but
// it carries EASTING/NORTHING (UTM zone 20N) as attributes. So we pull the whole
// table once (it fits in a single request, maxRecordCount 2500 > 2422 rows),
// convert UTM -> lat/lon client-side, cache it (it's historical, barely changes),
// and do all distance/bbox filtering ourselves - same approach as the stocking
// matcher. The converted set is memoised so panning the overlay costs nothing.
//   FeatureServer layer 1 = LakeSurvey_2012_Final
import { cachedJSON, TTL } from "./cache";
import type { FishingLocation, LakeSurvey } from "../types";

const QUERY = "https://services1.arcgis.com/qpxtVXh93G601MmT/arcgis/rest/services/Nova_Scotia_Environment_Lake_Survey/FeatureServer/1/query";
const NEAR_KM = 3; // a survey station farther than this isn't this lake
const FIELDS = "LAKE_NAME,EASTING,NORTHING,MAXIMUM_DE,MEAN_DEPTH,SECCHI_DIS,THERMOCLIN,SURFACE_TE,BOTTOM_DIS,PH,COLOUR__TC,ASSESSMENT";

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

function num(v: unknown): number | null {
  const n = Number(v);
  return v == null || v === "" || !isFinite(n) ? null : n;
}

interface Attr {
  LAKE_NAME?: string; EASTING?: number; NORTHING?: number; MAXIMUM_DE?: number; MEAN_DEPTH?: number;
  SECCHI_DIS?: number; THERMOCLIN?: string; SURFACE_TE?: number; BOTTOM_DIS?: number; PH?: number;
  COLOUR__TC?: number; ASSESSMENT?: number;
}
interface SurveyRow {
  lat: number; lon: number; name: string; a: Attr;
}

// The whole table, converted to lat/lon, memoised for the session (it's static).
let memo: Promise<SurveyRow[]> | null = null;
function allSurvey(): Promise<SurveyRow[]> {
  if (memo) return memo;
  memo = (async () => {
    try {
      const u = new URL(QUERY);
      u.searchParams.set("where", "1=1");
      u.searchParams.set("outFields", FIELDS);
      u.searchParams.set("returnGeometry", "false");
      u.searchParams.set("resultRecordCount", "2500");
      u.searchParams.set("f", "json");
      const j = await cachedJSON(u.toString(), TTL.occurrences, { label: "NS lake survey" });
      const feats: { attributes?: Attr }[] = Array.isArray(j?.features) ? j.features : [];
      const rows: SurveyRow[] = [];
      for (const f of feats) {
        const a = f.attributes ?? {};
        const e = num(a.EASTING), n = num(a.NORTHING);
        if (e == null || n == null) continue;
        const [lat, lon] = utm20ToLatLon(e, n);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        rows.push({ lat, lon, name: String(a.LAKE_NAME ?? "").trim(), a });
      }
      return rows;
    } catch {
      memo = null; // let a later call retry
      return [];
    }
  })();
  return memo;
}

// Significant words from a lake name (mirrors the stocking matcher) so we can
// prefer survey stations whose own LAKE_NAME matches the spot.
function tokens(name: string): string[] {
  return name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !["LAKE", "POND", "RESERVOIR"].includes(w));
}

// The measured profile for the lake nearest to this fishing spot.
export async function fetchNearestLakeSurvey(loc: FishingLocation): Promise<LakeSurvey | null> {
  try {
    const all = await allSurvey();
    if (!all.length) return null;
    const near = all
      .map((r) => ({ r, km: haversineKm(loc.lat, loc.lon, r.lat, r.lon) }))
      .filter((x) => x.km <= NEAR_KM)
      .sort((a, b) => a.km - b.km);
    if (!near.length) return null;

    // Prefer stations whose own name matches the spot; else take everything close.
    const toks = tokens(loc.name);
    const named = toks.length ? near.filter((x) => { const n = x.r.name.toUpperCase(); return toks.some((t) => n.includes(t)); }) : [];
    const group = named.length ? named : near;

    // Aggregate the one lake's stations: max of the maxima (its deepest hole),
    // mean of the means, and the most-recent station for the point readings.
    const depths = group.map((x) => num(x.r.a.MAXIMUM_DE)).filter((v): v is number => v != null);
    const means = group.map((x) => num(x.r.a.MEAN_DEPTH)).filter((v): v is number => v != null);
    const ref = [...group].sort((a, b) => (num(b.r.a.ASSESSMENT) ?? 0) - (num(a.r.a.ASSESSMENT) ?? 0))[0].r;
    const a = ref.a;

    return {
      lakeName: ref.name || loc.name,
      maxDepthM: depths.length ? Math.max(...depths) : null,
      meanDepthM: means.length ? +(means.reduce((s, v) => s + v, 0) / means.length).toFixed(1) : null,
      secchiM: num(a.SECCHI_DIS),
      thermoclineNote: a.THERMOCLIN ? String(a.THERMOCLIN).trim() : null,
      surfaceTempC: num(a.SURFACE_TE),
      bottomDO: num(a.BOTTOM_DIS),
      ph: num(a.PH),
      colourTCU: num(a.COLOUR__TC),
      assessed: a.ASSESSMENT ? new Date(Number(a.ASSESSMENT)).toISOString().slice(0, 10) : null,
      distanceKm: +group[0].km.toFixed(2),
      stationCount: group.length,
    };
  } catch {
    return null;
  }
}

