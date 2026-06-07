import type { CatchRecord } from "../types";

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
  const totals = new Map<string, { fish: number; trips: number }>();
  for (const r of records) {
    const k = keyFn(r) || "-";
    const e = totals.get(k) ?? { fish: 0, trips: 0 };
    e.fish += r.count;
    e.trips += 1;
    totals.set(k, e);
  }
  const entries = [...totals.entries()].filter(([k]) => k !== "-");
  if (entries.length < 2) return null;
  entries.sort((a, b) => b[1].fish / b[1].trips - a[1].fish / a[1].trips);
  const [bestK, bestV] = entries[0];
  const [, worstV] = entries[entries.length - 1];
  const bestRate = bestV.fish / bestV.trips;
  const worstRate = worstV.fish / Math.max(1, worstV.trips);
  const strength = bestRate <= 0 ? 0 : Math.min(1, (bestRate - worstRate) / (bestRate + 0.5));
  return {
    dimension: label,
    best: bestK,
    detail: `${bestK} averaged ${bestRate.toFixed(1)} fish/trip across ${bestV.trips} trip(s) - your strongest ${label.toLowerCase()}.`,
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
