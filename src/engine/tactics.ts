import type { Bundle, SpeciesForecast, FishingWindow } from "../types";
import { localDateKey } from "./score";
import { fmtTime, fmtRange } from "../util/format";
import { compassDir } from "../config";
import { buildLakeState } from "./lakestate";

export interface Tactics {
  setup: string;
  lureColors: string;
  bait: string;
  retrieval: string;
  arrival: string;
  departure: string;
  startSpot: string;
  moveSpot: string;
  shoreTips: string[];
  actionPlan: string[];
}

export function buildTactics(
  bundle: Bundle,
  species: SpeciesForecast[],
  windows: FishingWindow[],
  topSpots: { name: string }[],
  date: Date
): Tactics {
  const key = localDateKey(date);
  const hrs = bundle.hours.filter((h) => localDateKey(h.time) === key);
  const top = species[0];
  const second = species[1];
  const win = windows[0];

  const avgCloud = hrs.length ? hrs.reduce((s, h) => s + h.cloud, 0) / hrs.length : 50;
  const water = hrs.map((h) => h.waterTemp).filter((x): x is number => x != null);
  const avgWater = water.length ? water.reduce((s, x) => s + x, 0) / water.length : null;
  const avgWindDir = hrs.length ? compassDir(circ(hrs.map((h) => h.windDir))) : "-";
  const avgWind = hrs.length ? Math.round(hrs.reduce((s, h) => s + h.windSpeed, 0) / hrs.length) : 0;

  // Freshwater: model the lake's stratification so the depth/clarity advice is right.
  const fresh = bundle.location.kind === "fresh";
  const lake = fresh
    ? buildLakeState({ month: date.getMonth() + 1, surfaceTempC: avgWater ?? 15, survey: bundle.lakeSurvey ?? null })
    : null;

  const bright = avgCloud < 40;
  const lureColors = lake
    ? lake.clarityM != null && lake.clarityM < 1.5
      ? "Stained/tannic water → dark or high-vis, high-vibration: black, chartreuse, fire-tiger, spinnerbaits/bladed baits"
      : lake.clarityM != null && lake.clarityM > 4
      ? "Very clear water → natural & subtle: green-pumpkin, smelt/shiner patterns, light fluoro, finesse profiles"
      : bright
      ? "Bright sun → natural: green-pumpkin, watermelon, silver/shiner; downsize and slow down midday"
      : "Overcast/low light → high-contrast: white, chartreuse, gold blades, a touch bigger profile"
    : bright
    ? "Bright sun → natural/chrome: silver, blue-chrome, mackerel/herring patterns; smaller profiles"
    : "Overcast/low light → high-contrast: white, chartreuse, pink, glow; a touch bigger profile";

  const setup =
    `Primary: 7-9 ft medium spinning rod, 15-20 lb braid + 12-20 lb fluoro leader. ` +
    `Mackerel/herring: sabiki tree under a casting float. ` +
    `Pollock/striper: jigs & soft plastics on the moving water. ` +
    `Flounder: light bottom rig with small hooks on the sand.`;

  const retrieval =
    top.key === "mackerel" || top.key === "herring"
      ? "Cast the sabiki, let it sink, then a slow lift-drop ('sabiki jig'). Once you hit a school, keep the rig in that zone."
      : top.key === "pollock" || top.key === "striped-bass"
      ? "Fan-cast metals/soft plastics across the current seam; vary speed - pollock want a steady mid-water swim, stripers often hit on the pause/fall."
      : "Bait on the bottom, rod in a holder or held with a light lift every few minutes; let flatfish find it on the slower water.";

  const arrival = win ? fmtTime(new Date(+win.start - 30 * 60000)) : "Around the first major tide change";
  const departure = win ? fmtTime(win.end) : "After the tide change tapers off";

  const startSpot = topSpots[0]?.name ?? "Boardwalk drop-off";
  const moveSpot = topSpots[1]?.name ?? "Island-facing shoreline";

  const shoreTips: string[] = fresh && lake
    ? [
        lake.targetDepth,
        ...lake.notes.slice(0, 2),
        `Wind is ${avgWindDir} ~${avgWind} km/h - the wind-blown shore stacks plankton and bait and fish follow it; start there when it's safe.`,
        "Polarized glasses to read weed edges, drop-offs, shoals and cruising fish.",
        avgWater != null ? `Surface water ~${avgWater.toFixed(1)} °C - ${avgWater < 10 ? "cold; fish deep & slow" : avgWater > 21 ? "warm; dawn/dusk shallow, deeper/cooler midday" : "in the active range for trout & bass"}.` : "Check water temp on arrival.",
        "Barbless hooks and a wet-hands release for anything undersized or out of season - verify NS Anglers' Handbook limits.",
      ]
    : [
        `Wind is ${avgWindDir} ~${avgWind} km/h - start on the sheltered side and keep the wind off your casting shoulder.`,
        "Polarized glasses to read current seams, colour changes and bait flicks on the surface.",
        "Bring a long-handled net or drop-net at the boardwalk - landing fish up the rocks loses a lot of them.",
        "Watch for diving terns/gulls and surface 'nervous water' - that's bait, and the predators are under it.",
        avgWater != null ? `Water is ~${avgWater.toFixed(1)} °C - ${avgWater < 8 ? "cold; fish deeper & slower" : avgWater > 16 ? "warm; fish dawn/dusk & deeper midday" : "in the sweet spot for mackerel/pollock"}.` : "Check water temp on arrival.",
        "Barbless hooks for any striped bass, and have a wet-hands release plan for anything you can't keep.",
      ];

  const actionPlan = buildActionPlan(win, top, second, startSpot, moveSpot, avgWindDir, avgWind);

  return { setup, lureColors, bait: top.bait, retrieval, arrival, departure, startSpot, moveSpot, shoreTips, actionPlan };
}

function buildActionPlan(
  win: FishingWindow | undefined,
  top: SpeciesForecast,
  second: SpeciesForecast | undefined,
  startSpot: string,
  moveSpot: string,
  windDir: string,
  windKmh: number
): string[] {
  const plan: string[] = [];
  if (win) {
    plan.push(`Be rigged & casting by ${fmtTime(new Date(+win.start - 30 * 60000))} - the prime window is ${fmtRange(win.start, win.end)} (peak ~${fmtTime(win.peak)}).`);
  } else {
    plan.push("Time your session around the nearest tide change; the hours of moving water are your best shot.");
  }
  plan.push(`Open at the ${startSpot}. ${windDir} wind at ${windKmh} km/h - set up so it's at your back or off your shoulder.`);
  plan.push(`Target ${top.name} first (${top.catch}% catch odds today): ${top.bait}. ${top.notes}`);
  if (second) plan.push(`If they're quiet, switch to ${second.name}: ${second.bait}.`);
  plan.push(`On the tide change, move to the ${moveSpot} to follow the current and bait.`);
  plan.push("Keep moving until you find fish - shore mackerel/pollock are about being in the right 50 m of water, not waiting them out.");
  plan.push("Keep only legal, in-season fish; verify mackerel/cod/striper status before retaining, and release the rest quickly.");
  return plan;
}

function circ(degs: number[]): number {
  let x = 0, y = 0;
  for (const d of degs) { x += Math.cos((d * Math.PI) / 180); y += Math.sin((d * Math.PI) / 180); }
  let a = (Math.atan2(y, x) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
}
