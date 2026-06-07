import type { Bundle, Hotspot } from "../types";
import { compassDir } from "../config";
import { localDateKey } from "./score";

interface SpotDef {
  name: string;
  bestFor: string[];
  base: number;
  // wind directions (compass) that shelter this spot
  shelteredFrom: string[];
  exposedTo: string[];
  likesMovingWater: number; // 0..1
  base_desc: string;
}

// Generic shore-fishing marks that apply to any Nova Scotia coastline.
const GENERIC_SPOTS: SpotDef[] = [
  {
    name: "Point / headland into open water",
    bestFor: ["Pollock", "Mackerel", "Striped Bass"],
    base: 7.2,
    shelteredFrom: [],
    exposedTo: [],
    likesMovingWater: 0.9,
    base_desc: "Headlands stick into the current and concentrate bait, the classic shore mark on moving water.",
  },
  {
    name: "Rocky shoreline & ledges",
    bestFor: ["Pollock", "Cunner", "Striped Bass"],
    base: 6.9,
    shelteredFrom: [],
    exposedTo: [],
    likesMovingWater: 0.85,
    base_desc: "Structure-loving fish hold tight to rock and weed edges, great on flow but stay off it in big swell.",
  },
  {
    name: "Current seam / rip line",
    bestFor: ["Striped Bass", "Pollock", "Mackerel"],
    base: 6.6,
    shelteredFrom: [],
    exposedTo: [],
    likesMovingWater: 1.0,
    base_desc: "The visible line where fast and slow water meet, predators sit on the edge waiting for bait.",
  },
  {
    name: "Wharf / breakwater",
    bestFor: ["Mackerel", "Pollock", "Cunner"],
    base: 6.8,
    shelteredFrom: ["NW", "N", "W", "NNW", "WNW"],
    exposedTo: [],
    likesMovingWater: 0.5,
    base_desc: "Deep water access and shelter, a reliable mackerel and pollock spot in most NS harbours.",
  },
  {
    name: "Sheltered cove / harbour",
    bestFor: ["Mackerel", "Herring", "Winter Flounder"],
    base: 6.4,
    shelteredFrom: ["NW", "N", "W", "S", "SW"],
    exposedTo: [],
    likesMovingWater: 0.4,
    base_desc: "Calm water that holds bait and staging fish, the go-to when it is blowing hard outside.",
  },
  {
    name: "Sandy beach / soft bottom",
    bestFor: ["Winter Flounder", "Smooth Flounder", "Striped Bass"],
    base: 5.8,
    shelteredFrom: [],
    exposedTo: [],
    likesMovingWater: 0.25,
    base_desc: "Soft bottom for flatfish on bait and a dawn striper cruise lane in summer.",
  },
  {
    name: "River / estuary mouth",
    bestFor: ["Striped Bass", "Winter Flounder", "Mackerel"],
    base: 6.2,
    shelteredFrom: [],
    exposedTo: [],
    likesMovingWater: 0.8,
    base_desc: "Outflow concentrates bait and draws striped bass, especially on the dropping tide.",
  },
  {
    name: "Deep channel edge",
    bestFor: ["Cod", "Pollock", "Haddock"],
    base: 5.6,
    shelteredFrom: [],
    exposedTo: [],
    likesMovingWater: 0.7,
    base_desc: "Deeper edges that hold groundfish in the cold season, long casts and heavier gear.",
  },
];

const HOME_SPOTS: SpotDef[] = [
  {
    name: "Boardwalk drop-off",
    bestFor: ["Mackerel", "Herring", "Flounder"],
    base: 7.5,
    shelteredFrom: ["NW", "N", "W", "NNW", "WNW"],
    exposedTo: ["SE", "S", "ESE"],
    likesMovingWater: 0.6,
    base_desc: "Easy access deeper water off the boardwalk - the bread-and-butter mackerel/sabiki spot and soft bottom for flounder.",
  },
  {
    name: "Island-facing shoreline",
    bestFor: ["Pollock", "Mackerel", "Striped Bass"],
    base: 7.0,
    shelteredFrom: ["N", "NW", "W"],
    exposedTo: ["S", "SE", "E"],
    likesMovingWater: 0.9,
    base_desc: "Faces the offshore island where current funnels - strongest flow and bait staging on the moving tide.",
  },
  {
    name: "Rocky points",
    bestFor: ["Pollock", "Cunner", "Striped Bass"],
    base: 6.8,
    shelteredFrom: ["NW", "N"],
    exposedTo: ["S", "SE", "SW"],
    likesMovingWater: 0.85,
    base_desc: "Structure-loving fish hold tight to the rocks; great on moving water but dangerous in big swell.",
  },
  {
    name: "Current seams off the point",
    bestFor: ["Striped Bass", "Pollock", "Mackerel"],
    base: 6.5,
    shelteredFrom: [],
    exposedTo: [],
    likesMovingWater: 1.0,
    base_desc: "The visible line where fast and slow water meet - predators sit on the edge waiting for bait. Pure tide-dependent.",
  },
  {
    name: "Sandy beach flats",
    bestFor: ["Winter Flounder", "Smooth Flounder", "Striped Bass"],
    base: 5.8,
    shelteredFrom: ["NW", "N", "W"],
    exposedTo: ["S", "SE"],
    likesMovingWater: 0.25,
    base_desc: "Soft bottom for flatfish on bait, and a dawn striper cruise lane in summer. Best around the slower water.",
  },
  {
    name: "Channel drop-offs (deep)",
    bestFor: ["Cod", "Pollock", "Haddock"],
    base: 5.5,
    shelteredFrom: [],
    exposedTo: [],
    likesMovingWater: 0.7,
    base_desc: "Deeper edges that hold groundfish in the cold season - long casts/heavier gear, mostly a fall/winter play.",
  },
];

// Freshwater lake / river marks.
const FRESH_SPOTS: SpotDef[] = [
  {
    name: "Inflow / outflow (current)",
    bestFor: ["Brook Trout", "Smallmouth Bass", "White Perch"],
    base: 7.2, shelteredFrom: [], exposedTo: [], likesMovingWater: 0.5,
    base_desc: "Where a stream enters or leaves the lake - moving, oxygenated water that funnels food and holds trout & bass.",
  },
  {
    name: "Rocky shoals & points",
    bestFor: ["Smallmouth Bass", "Yellow Perch"],
    base: 7.0, shelteredFrom: [], exposedTo: [], likesMovingWater: 0.2,
    base_desc: "Classic smallmouth structure - rock, gravel and points dropping into deeper water.",
  },
  {
    name: "Weed beds & lily pads",
    bestFor: ["Chain Pickerel", "Yellow Perch", "Smallmouth Bass"],
    base: 6.8, shelteredFrom: [], exposedTo: [], likesMovingWater: 0.1,
    base_desc: "Weed edges and pads hold baitfish and ambush predators like pickerel; fish the edges.",
  },
  {
    name: "Drop-offs & deep holes",
    bestFor: ["Smallmouth Bass", "White Perch", "Brown Trout"],
    base: 6.6, shelteredFrom: [], exposedTo: [], likesMovingWater: 0.1,
    base_desc: "Steep contour breaks and the deepest basins - cooler refuge in summer and a midday holding zone.",
  },
  {
    name: "Wind-blown shoreline",
    bestFor: ["Smallmouth Bass", "White Perch"],
    base: 6.3, shelteredFrom: [], exposedTo: [], likesMovingWater: 0.1,
    base_desc: "The shore the wind is pushing into stacks plankton and bait - predators follow. Fish it when it's safe.",
  },
  {
    name: "Shaded / overhung banks",
    bestFor: ["Brook Trout", "Brown Trout", "Chain Pickerel"],
    base: 6.0, shelteredFrom: [], exposedTo: [], likesMovingWater: 0.1,
    base_desc: "Overhanging trees, docks and shade give cover and cooler water - prime in bright conditions and low light.",
  },
];

export function rankHotspots(bundle: Bundle, date: Date): Hotspot[] {
  const key = localDateKey(date);
  const hrs = bundle.hours.filter((h) => localDateKey(h.time) === key);
  if (!hrs.length) return [];
  const fresh = bundle.location.kind === "fresh";
  const spots = fresh ? FRESH_SPOTS : bundle.location.home ? HOME_SPOTS : GENERIC_SPOTS;
  const avgWind = hrs.reduce((s, h) => s + h.windSpeed, 0) / hrs.length;
  const avgDirDeg = circularMeanDeg(hrs.map((h) => h.windDir));
  const windDir = compassDir(avgDirDeg);
  const peakVel = Math.max(...hrs.map((h) => Math.abs(h.tideVelocity ?? 0)));
  const movingNorm = fresh ? 0.5 : Math.min(1, peakVel / (0.28 * (bundle.tide.meanRange || 1.4)));

  const ranked = spots.map((s): Hotspot => {
    let score = s.base;
    const why: string[] = [];

    if (s.shelteredFrom.includes(windDir)) {
      score += avgWind > 20 ? 1.4 : 0.6;
      why.push(`Sheltered from today's ${windDir} wind`);
    } else if (s.exposedTo.includes(windDir)) {
      score -= avgWind > 25 ? 2.2 : avgWind > 15 ? 1.1 : 0.4;
      why.push(`Exposed to the ${windDir} wind (${Math.round(avgWind)} km/h)`);
    }

    // tidal flow benefit scaled by how much the spot likes moving water
    score += (movingNorm - 0.5) * 2 * s.likesMovingWater;
    if (s.likesMovingWater > 0.7 && movingNorm > 0.6) why.push("Good current today - this spot fires on flow");
    if (s.likesMovingWater < 0.3 && movingNorm > 0.7) why.push("Strong current - fish the slacker stages here");

    score = Math.max(0, Math.min(10, score));
    return { name: s.name, rank: 0, score: +score.toFixed(1), why: why.join(" · ") || s.base_desc, bestFor: s.bestFor };
  });

  ranked.sort((a, b) => b.score - a.score);
  ranked.forEach((r, i) => (r.rank = i + 1));
  // attach base description as fallback detail
  return ranked.map((r) => ({ ...r, why: r.why + " - " + (spots.find((s) => s.name === r.name)?.base_desc ?? "") }));
}

function circularMeanDeg(degs: number[]): number {
  let x = 0, y = 0;
  for (const d of degs) {
    x += Math.cos((d * Math.PI) / 180);
    y += Math.sin((d * Math.PI) / 180);
  }
  let a = (Math.atan2(y, x) * 180) / Math.PI;
  if (a < 0) a += 360;
  return a;
}

export { circularMeanDeg };
