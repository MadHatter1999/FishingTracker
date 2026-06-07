// Regenerate src/waterways.ts from OpenStreetMap via the Overpass API.
// Usage: node scripts/gen-waterways.mjs
// Data (c) OpenStreetMap contributors, ODbL.
import { writeFileSync } from "node:fs";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const NS_BBOX = "43.30,-66.60,47.10,-59.40"; // S,W,N,E
const round = (v) => +v.toFixed(5);

// Named NS waterways to include. `match` = case-insensitive substrings used to
// group OSM ways by name. Long single ways are lightly thinned; everything else
// keeps full OSM detail.
const RIVERS = [
  { name: "Shubenacadie Canal (Dartmouth lakes)", match: ["Shubenacadie Canal"], type: "boatable", note: "Historic canal linking the Dartmouth lakes (Banook - Micmac - Charles - William) toward Grand Lake; some locks/portage." },
  { name: "Shubenacadie River", match: ["Shubenacadie River"], type: "boatable", note: "Drains Grand Lake north to the Bay of Fundy; powerful tidal bore on the lower river." },
  { name: "Stewiacke River", match: ["Stewiacke River"], type: "fishable", note: "Shubenacadie tributary; tidal bore, striped bass, gaspereau and trout." },
  { name: "Musquodoboit River", match: ["Musquodoboit River"], type: "fishable", note: "Long Eastern Shore valley river; brook trout and sea-run trout." },
  { name: "Sackville River", match: ["Sackville River"], type: "fishable", note: "Urban river under restoration; sea-run brook trout and Atlantic salmon." },
  { name: "Gaspereau River", match: ["Gaspereau River"], type: "fishable", note: "Famous gaspereau (alewife) run near Wolfville; trout below the dams." },
  { name: "Avon / St. Croix River", match: ["Avon River", "St. Croix River"], type: "boatable", note: "Tidal Fundy river at Windsor - some of the largest tides in the world." },
  { name: "Annapolis River", match: ["Annapolis River"], type: "boatable", note: "Long tidal river through the valley; smallmouth bass, perch and gaspereau." },
  { name: "LaHave River", match: ["LaHave River"], type: "boatable", note: "Big South Shore river, tidal lower down; trout, gaspereau and a striped bass run." },
  { name: "Medway River", match: ["Medway River"], type: "fishable", note: "Salmon and trout river reaching the sea at Port Medway." },
  { name: "Mersey River", match: ["Mersey River"], type: "fishable", note: "Classic Kejimkujik canoe river; brook trout (note dams/flow control)." },
  { name: "Gold River", match: ["Gold River"], type: "fishable", note: "Trout and salmon river near Chester." },
  { name: "St. Marys River", match: ["St. Marys River", "St. Mary's River"], type: "fishable", note: "One of NS's premier Atlantic salmon rivers (largely catch & release)." },
  { name: "Tusket River", match: ["Tusket River"], type: "boatable", note: "Large SW NS river and lake chain; smallmouth bass, perch and eels." },
  { name: "Margaree River", match: ["Margaree River"], type: "fishable", note: "Renowned Cape Breton Atlantic salmon and trout river." },
];

async function overpass(query) {
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "*/*",
      "User-Agent": "FishingTracker-waterways/1.0 (Nova Scotia angling app)",
    },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error("Overpass " + res.status + " " + (await res.text()).slice(0, 200));
  return res.json();
}

// Keep full detail; only thin a single very long way so the file stays sane.
function toSeg(geom) {
  const p = geom.map((g) => [round(g.lat), round(g.lon)]);
  if (p.length <= 800) return p;
  const o = [];
  for (let i = 0; i < p.length; i += 2) o.push(p[i]);
  if (o[o.length - 1].join() !== p[p.length - 1].join()) o.push(p[p.length - 1]);
  return o;
}

function centerline(outerPts, bands = 22) {
  const lats = outerPts.map((p) => p[0]);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const line = [];
  for (let i = 0; i <= bands; i++) {
    const lat = latMax - ((latMax - latMin) * i) / bands;
    const tol = (latMax - latMin) / bands;
    const near = outerPts.filter((p) => Math.abs(p[0] - lat) < tol);
    if (near.length < 2) continue;
    const ls = near.map((p) => p[1]);
    line.push([round(lat), round((Math.min(...ls) + Math.max(...ls)) / 2)]);
  }
  return line;
}

const segTxt = (s) => "[" + s.map((p) => "[" + p[0] + ", " + p[1] + "]").join(", ") + "]";
const segsTxt = (arr) => arr.map((s) => "      " + segTxt(s)).join(",\n");

async function main() {
  // Build one name-regex query for all rivers/canals across NS.
  const alts = RIVERS.flatMap((r) => r.match).map((m) => m.replace(/[.()]/g, "\\$&")).join("|");
  const q = `[out:json][timeout:240];
    way["waterway"]["name"~"(${alts})",i](${NS_BBOX});
    out geom;`;
  const data = await overpass(q);

  const groups = new Map(RIVERS.map((r) => [r.name, []]));
  for (const e of data.elements || []) {
    if (!e.geometry) continue;
    const nm = (e.tags?.name || "").toLowerCase();
    const cfg = RIVERS.find((r) => r.match.some((m) => nm.includes(m.toLowerCase())));
    if (cfg) groups.get(cfg.name).push(toSeg(e.geometry));
  }

  // Porters Lake: trace a centerline of the lake polygon to the sea.
  const pl = await overpass(`[out:json][timeout:90];rel["natural"="water"]["name"="Porters Lake"];out geom;`);
  const rel = (pl.elements || []).sort((a, b) => (b.members?.length || 0) - (a.members?.length || 0))[0];
  const outer = [];
  for (const m of rel?.members || []) if (m.role === "outer" && m.geometry) for (const g of m.geometry) outer.push([g.lat, g.lon]);
  const porters = centerline(outer);
  porters.push([44.633, -63.317]);

  const entries = [];
  for (const r of RIVERS) {
    const segs = groups.get(r.name);
    if (!segs.length) { console.warn("  (no geometry found for " + r.name + ")"); continue; }
    entries.push({ name: r.name, type: r.type, note: r.note, segs });
  }
  entries.push({ name: "Porters Lake to the Atlantic", type: "boatable", note: "Tidal lake that opens to the Atlantic at its south end - boatable run to salt water.", segs: [porters] });

  const body = entries.map((e) => `  {
    name: ${JSON.stringify(e.name)},
    type: ${JSON.stringify(e.type)},
    note: ${JSON.stringify(e.note)},
    segments: [
${segsTxt(e.segs)},
    ],
  }`).join(",\n");

  const out = `// AUTO-GENERATED from OpenStreetMap (Overpass) - real canal/river/lake geometry.
// Data (c) OpenStreetMap contributors, ODbL. Regenerate via: node scripts/gen-waterways.mjs
export interface Waterway {
  name: string;
  type: "boatable" | "fishable";
  note: string;
  segments: [number, number][][]; // each segment is an ordered [lat, lon] polyline
}

export const WATERWAYS: Waterway[] = [
${body},
];
`;
  writeFileSync(new URL("../src/waterways.ts", import.meta.url), out);
  const pts = entries.reduce((a, e) => a + e.segs.reduce((s, g) => s + g.length, 0), 0);
  console.log(`Wrote src/waterways.ts | ${entries.length} waterways, ${pts} points`);
}

main().catch((e) => { console.error(e); process.exit(1); });
