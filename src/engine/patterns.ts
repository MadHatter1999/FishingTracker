import type { CatchRecord, SpeciesForecast } from "../types";

export interface PatternInsight {
  dimension: string;
  best: string;
  detail: string;
  strength: number; // 0..1 confidence-ish
}

export interface LogAnalysis {
  trips: number;
  totalFish: number;
  fishPerTrip: number;
  fishPerHour: number;
  topSpecies: { name: string; count: number }[];
  insights: PatternInsight[];
  trends: string[];
  predictions: string[];
}

function hours(rec: CatchRecord): number {
  const [sh, sm] = rec.start.split(":").map(Number);
  const [eh, em] = rec.end.split(":").map(Number);
  let h = eh + em / 60 - (sh + sm / 60);
  if (h <= 0) h += 24;
  return h || 1;
}

function bucketBest(records: CatchRecord[], keyFn: (r: CatchRecord) => string, label: string): PatternInsight | null {
  // eff = log-scaled catch count (used for ranking + strength so one big haul
  // can't dominate); fish = raw count, kept for the human-readable display only.
  const totals = new Map<string, { eff: number; fish: number; trips: number }>();
  for (const r of records) {
    const k = keyFn(r) || "-";
    const e = totals.get(k) ?? { eff: 0, fish: 0, trips: 0 };
    e.eff += Math.log1p(Math.max(0, r.count));
    e.fish += r.count;
    e.trips += 1;
    totals.set(k, e);
  }
  const entries = [...totals.entries()].filter(([k]) => k !== "-");
  if (entries.length < 2) return null;
  entries.sort((a, b) => b[1].eff / b[1].trips - a[1].eff / a[1].trips);
  const [bestK, bestV] = entries[0];
  const [, worstV] = entries[entries.length - 1];
  const bestRate = bestV.eff / bestV.trips;
  const worstRate = worstV.eff / Math.max(1, worstV.trips);
  const rawStrength = bestRate <= 0 ? 0 : Math.min(1, (bestRate - worstRate) / (bestRate + 0.5));
  // shrink toward 0 for small samples: 2 trips -> ~0.33x, 12 trips -> 0.75x
  const n = bestV.trips + worstV.trips;
  const sampleShrink = n / (n + 4);
  const strength = rawStrength * sampleShrink;
  const displayAvg = bestV.fish / bestV.trips; // real fish/trip for the text
  return {
    dimension: label,
    best: bestK,
    detail: `${bestK} averaged ${displayAvg.toFixed(1)} fish/trip across ${bestV.trips} trip(s) - your strongest ${label.toLowerCase()}.`,
    strength,
  };
}

function timeBucket(start: string): string {
  const h = Number(start.split(":")[0]);
  if (h < 5) return "Night";
  if (h < 9) return "Dawn (5-9)";
  if (h < 16) return "Midday (9-16)";
  if (h < 20) return "Dusk (16-20)";
  return "Night";
}

export function analyzeLog(records: CatchRecord[]): LogAnalysis {
  const trips = records.length;
  const totalFish = records.reduce((s, r) => s + r.count, 0);
  const totalHours = records.reduce((s, r) => s + hours(r), 0);

  const speciesTotals = new Map<string, number>();
  for (const r of records) speciesTotals.set(r.species, (speciesTotals.get(r.species) ?? 0) + r.count);
  const topSpecies = [...speciesTotals.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const insights = [
    bucketBest(records, (r) => r.tideStage, "Tide stage"),
    bucketBest(records, (r) => timeBucket(r.start), "Time of day"),
    bucketBest(records, (r) => r.windDir, "Wind direction"),
    bucketBest(records, (r) => r.moonPhase ?? "", "Moon phase"),
    bucketBest(records, (r) => r.weather, "Weather"),
  ].filter((x): x is PatternInsight => x != null);

  const trends: string[] = [];
  if (trips === 0) {
    trends.push("No trips logged yet - add your sessions and patterns will appear here automatically.");
  } else {
    const recent = [...records].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 3);
    const recentFish = recent.reduce((s, r) => s + r.count, 0);
    trends.push(`Last ${recent.length} trip(s): ${recentFish} fish (${(recentFish / recent.length).toFixed(1)}/trip).`);
    const kept = records.filter((r) => r.kept === "kept").reduce((s, r) => s + r.count, 0);
    trends.push(`Lifetime: ${totalFish} fish over ${trips} trips (~${(totalFish / trips).toFixed(1)}/trip), ${kept} kept.`);
  }

  const predictions: string[] = [];
  const tideI = insights.find((i) => i.dimension === "Tide stage");
  const timeI = insights.find((i) => i.dimension === "Time of day");
  const windI = insights.find((i) => i.dimension === "Wind direction");
  if (tideI && timeI) {
    predictions.push(`Your data says: fish the ${tideI.best} tide during ${timeI.best.toLowerCase()} for your best results.`);
  }
  if (windI) predictions.push(`${windI.best} winds have produced best for you so far.`);
  if (trips > 0 && trips < 5) predictions.push("Small sample - these patterns will tighten up after ~8-10 logged trips.");

  return {
    trips,
    totalFish,
    fishPerTrip: trips ? +(totalFish / trips).toFixed(1) : 0,
    fishPerHour: totalHours ? +(totalFish / totalHours).toFixed(1) : 0,
    topSpecies,
    insights,
    trends,
    predictions,
  };
}

// ----------------------------------------------------------------------------
// Catch-report intel: a bounded nudge to the model's catch %. The species model
// is the prior; the user's own logged trips can only pull it a little, weighted
// by recency, how well each trip's conditions match today, and (capped) count.
// No nearby/distance weighting yet - CatchRecord has no location.
// ----------------------------------------------------------------------------
export interface TodayConditions {
  month: number;      // 1..12
  tideStage: string;  // "rising" | "falling" | "high-slack" | "low-slack" | "" (fresh)
  todBucket: string;  // "night" | "dawn" | "mid" | "dusk"
  weatherCat: string; // "clear" | "cloud" | "wet" | "unknown"
}

const INTEL = {
  priorStrength: 8,
  halfLifeDays: 21,
  requiredReportWeight: 12,
  maxIntelWeight: 0.35,
  countStrengthCap: 1.75,
};

function clampN(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function todBucketOf(hour: number): string {
  if (hour < 5 || hour >= 20) return "night";
  if (hour < 9) return "dawn";
  if (hour < 16) return "mid";
  return "dusk";
}

function classifyWeather(text: string): string {
  const s = (text || "").toLowerCase();
  if (/rain|shower|drizzle|storm|snow/.test(s)) return "wet";
  if (/cloud|overcast|fog|mist/.test(s)) return "cloud";
  if (/sun|clear|fair/.test(s)) return "clear";
  return "unknown";
}

// Build the "today" condition snapshot the reports are matched against.
export function buildTodayConditions(opts: { month: number; tideState: string; hour: number; weatherText: string }): TodayConditions {
  return {
    month: opts.month,
    tideStage: opts.tideState || "",
    todBucket: todBucketOf(opts.hour),
    weatherCat: classifyWeather(opts.weatherText),
  };
}

function tideWeight(reportStage: string, today: string): number {
  if (!reportStage || !today) return 0.75; // unknown / freshwater -> neutral
  if (reportStage === today) return 1;
  const moving = (x: string) => x === "rising" || x === "falling";
  const slack = (x: string) => x.endsWith("slack");
  if ((moving(reportStage) && moving(today)) || (slack(reportStage) && slack(today))) return 0.6;
  return 0.35;
}
function timeWeight(reportBucket: string, today: string): number {
  if (reportBucket === today) return 1;
  const lowLight = (x: string) => x === "dawn" || x === "dusk";
  if (lowLight(reportBucket) && lowLight(today)) return 0.6;
  return 0.45;
}
function seasonWeight(reportMonth: number, today: number): number {
  const d = Math.min(Math.abs(reportMonth - today), 12 - Math.abs(reportMonth - today));
  return d === 0 ? 1 : d === 1 ? 0.6 : d === 2 ? 0.35 : 0.15;
}
function weatherWeight(reportWeather: string, today: string): number {
  const rc = classifyWeather(reportWeather);
  if (rc === "unknown" || today === "unknown") return 0.75;
  return rc === today ? 1 : 0.6;
}

export function blendCatchIntel(species: SpeciesForecast[], log: CatchRecord[], today: TodayConditions): SpeciesForecast[] {
  if (!log.length) return species;
  const now = Date.now();
  const blended = species.map((sp) => {
    const reports = log.filter((r) => r.species === sp.name);
    if (!reports.length) return sp;

    const baselineP = clampN(sp.catch / 100, 0.01, 0.96);
    let alpha = baselineP * INTEL.priorStrength;
    let beta = (1 - baselineP) * INTEL.priorStrength;

    for (const r of reports) {
      const ageDays = Math.max(0, (now - Date.parse(r.date + "T12:00:00")) / 86400000);
      const recencyWeight = Math.exp(-ageDays / INTEL.halfLifeDays);
      const conditionWeight =
        tideWeight(r.tideStage, today.tideStage) *
        timeWeight(todBucketOf(Number(r.start?.split(":")[0]) || 0), today.todBucket) *
        seasonWeight(Number(r.date.slice(5, 7)) || today.month, today.month) *
        weatherWeight(r.weather, today.weatherCat);
      const userWeight = clampN(1, 0.1, 1); // single-user log; multi-user trust plugs in here later
      const success = r.count > 0;
      const countStrength = success ? clampN(1 + 0.25 * Math.log1p(r.count), 1, INTEL.countStrengthCap) : 1;
      const reportWeight = recencyWeight * conditionWeight * userWeight;
      if (success) alpha += reportWeight * countStrength;
      else beta += reportWeight;
    }

    const posteriorP = alpha / (alpha + beta);
    const effectiveReportWeight = alpha + beta - INTEL.priorStrength;
    const intelWeight = clampN(effectiveReportWeight / INTEL.requiredReportWeight, 0, INTEL.maxIntelWeight);
    const finalP = baselineP * (1 - intelWeight) + posteriorP * intelWeight;
    const finalChance = Math.round(clampN(finalP * 100, 1, 96));
    return finalChance === sp.catch ? sp : { ...sp, catch: finalChance };
  });
  blended.sort((a, b) => b.catch - a.catch || b.encounter - a.encounter);
  return blended;
}
