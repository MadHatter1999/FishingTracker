// Fetch accurate lake centres + sizes from OpenStreetMap (Overpass) and print
// the NS_LAKES array for src/config.ts. Usage: node scripts/gen-lakes.mjs
import { writeFileSync } from "node:fs";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const round = (v) => +v.toFixed(5);

const LAKES = [
  { name: "Porters Lake", near: [44.725, -63.312], note: "Large lake near the coast, smallmouth/pickerel/perch; connects to the sea" },
  { name: "Lake Banook", near: [44.674, -63.564], note: "Dartmouth, smallmouth/perch; Shubenacadie Canal system" },
  { name: "Lake Micmac", near: [44.690, -63.557], note: "Dartmouth, bass/perch; linked to Banook & Charles" },
  { name: "Lake Charles", near: [44.715, -63.564], note: "Shubenacadie Canal chain, bass/pickerel" },
  { name: "Long Lake", near: [44.621, -63.632], note: "Halifax/Spryfield reservoir, trout/bass, shore access" },
  { name: "First Lake", near: [44.785, -63.679], note: "Lower Sackville, perch/bass/pickerel" },
  { name: "Shubenacadie Grand Lake", near: [44.905, -63.500], note: "Major lake on the Shubenacadie system, boatable to Fundy; bass/perch/pickerel" },
  { name: "Lake Echo", near: [44.735, -63.390], note: "Bass/pickerel/perch, east of Dartmouth" },
  { name: "Williams Lake", near: [44.621, -63.587], note: "Halifax, trout/bass, quiet shore fishing" },
  { name: "Lake Mic Mac", near: [44.690, -63.557], note: "alias" }, // fallback spelling, ignored if dup
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "*/*", "User-Agent": "FishingTracker-lakes/1.0 (NS angling app)" },
      body: "data=" + encodeURIComponent(query),
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status === 504) && i < tries - 1) { await sleep(5000 * (i + 1)); continue; }
    throw new Error("Overpass " + res.status + " " + (await res.text()).slice(0, 160));
  }
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, dLat = ((bLat - aLat) * Math.PI) / 180, dLon = ((bLon - aLon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function pointsOf(el) {
  const pts = [];
  if (el.geometry) for (const g of el.geometry) pts.push([g.lat, g.lon]);
  if (el.members) for (const m of el.members) if (m.geometry) for (const g of m.geometry) pts.push([g.lat, g.lon]);
  return pts;
}

async function main() {
  const out = [];
  const seen = new Set();
  for (const lk of LAKES) {
    if (lk.note === "alias") continue;
    const [la, lo] = lk.near;
    const bbox = `${la - 0.08},${lo - 0.10},${la + 0.08},${lo + 0.10}`;
    const q = `[out:json][timeout:60];
      ( way["natural"="water"]["name"="${lk.name}"](${bbox});
        relation["natural"="water"]["name"="${lk.name}"](${bbox}); );
      out geom;`;
    await sleep(2500); // be polite to Overpass between lakes
    let data;
    try { data = await overpass(q); } catch (e) { console.warn("  fail", lk.name, e.message); continue; }
    // pick the element with the most points (the main basin)
    let best = null, bestPts = [];
    for (const el of data.elements || []) {
      const pts = pointsOf(el);
      if (pts.length > bestPts.length) { best = el; bestPts = pts; }
    }
    if (!best || bestPts.length < 4) { console.warn("  no geom for", lk.name); continue; }
    const lats = bestPts.map((p) => p[0]), lons = bestPts.map((p) => p[1]);
    const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const cLon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const radiusKm = +Math.max(...bestPts.map((p) => haversineKm(cLat, cLon, p[0], p[1]))).toFixed(1);
    const key = lk.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const clickR = +Math.min(4, Math.max(0.8, radiusKm)).toFixed(1); // cap so big lakes don't claim nearby sea
    out.push({ name: lk.name, lat: round(cLat), lon: round(cLon), note: lk.note, radiusKm: clickR });
    console.log(`  ${lk.name}: ${round(cLat)}, ${round(cLon)} actualR=${radiusKm}km clickR=${clickR} (${bestPts.length} pts)`);
  }
  const text = "export const NS_LAKES: { name: string; lat: number; lon: number; note: string; radiusKm: number }[] = [\n" +
    out.map((l) => `  { name: ${JSON.stringify(l.name)}, lat: ${l.lat}, lon: ${l.lon}, note: ${JSON.stringify(l.note)}, radiusKm: ${l.radiusKm} },`).join("\n") +
    "\n];\n";
  writeFileSync(new URL("../ns_lakes.generated.txt", import.meta.url), text);
  console.log("\nWrote ns_lakes.generated.txt (" + out.length + " lakes)");
}

main().catch((e) => { console.error(e); process.exit(1); });
