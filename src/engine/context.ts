import type { Bundle, ScoredHour, CatchRecord, FishingWindow, SpeciesForecast, Hotspot } from "../types";
import { windowsForRange, overallScoreForDay, localDateKey } from "./score";
import { forecastSpecies } from "./species";
import { rankHotspots } from "./hotspots";
import { buildTactics, type Tactics } from "./tactics";
import { analyzeLog, blendCatchIntel, buildTodayConditions, type LogAnalysis } from "./patterns";
import { weatherLabel } from "../config";

export interface DayContext {
  date: Date;
  overall: number;
  windows: FishingWindow[];
  species: SpeciesForecast[];
  hotspots: Hotspot[];
  tactics: Tactics;
  analysis: LogAnalysis;
  confidence: "Low" | "Medium" | "High";
  scoredDay: ScoredHour[];
}

export function computeDay(bundle: Bundle, scored: ScoredHour[], log: CatchRecord[], date: Date): DayContext {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(+dayStart + 86400000);
  const windows = windowsForRange(scored, dayStart, dayEnd);
  const overall = overallScoreForDay(scored, date);
  const scoredDay = scored.filter((s) => localDateKey(s.time) === localDateKey(date));

  // Model baseline, then a bounded nudge from the user's own logged catches.
  const modelSpecies = forecastSpecies(bundle, scored, date);
  const dayHours = bundle.hours.filter((h) => localDateKey(h.time) === localDateKey(date));
  const peakScored = scoredDay.length ? scoredDay.reduce((a, b) => (b.score > a.score ? b : a)) : null;
  const repTime = windows[0]?.peak ?? peakScored?.time ?? null;
  const repHour = repTime && dayHours.length
    ? dayHours.reduce((a, h) => (Math.abs(+h.time - +repTime) < Math.abs(+a.time - +repTime) ? h : a), dayHours[0])
    : (dayHours[0] ?? null);
  const today = buildTodayConditions({
    month: date.getMonth() + 1,
    tideState: bundle.location.kind === "fresh" ? "" : (repHour?.tideState ?? ""),
    hour: repHour ? repHour.time.getHours() : 6,
    weatherText: repHour ? weatherLabel(repHour.weatherCode).label : "",
  });
  const species = blendCatchIntel(modelSpecies, log, today);

  const hotspots = rankHotspots(bundle, date);
  const tactics = buildTactics(bundle, species, windows, hotspots, date);
  const analysis = analyzeLog(log);

  // confidence: live tide data + how decisive the best window is + log size
  let conf: DayContext["confidence"] = "Medium";
  const decisive = windows.length && windows[0].score - (overall ?? 0) >= 0; // window above day avg
  if (bundle.tide.live && windows.length && windows[0].score >= 6.5 && decisive) conf = "High";
  if (!bundle.tide.live || overall < 4) conf = "Low";

  return { date, overall, windows, species, hotspots, tactics, analysis, confidence: conf, scoredDay };
}
