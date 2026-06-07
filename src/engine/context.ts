import type { Bundle, ScoredHour, CatchRecord, FishingWindow, SpeciesForecast, Hotspot } from "../types";
import { windowsForRange, overallScoreForDay, localDateKey } from "./score";
import { forecastSpecies } from "./species";
import { rankHotspots } from "./hotspots";
import { buildTactics, type Tactics } from "./tactics";
import { analyzeLog, type LogAnalysis } from "./patterns";

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
  const species = forecastSpecies(bundle, scored, date);
  const hotspots = rankHotspots(bundle, date);
  const tactics = buildTactics(bundle, species, windows, hotspots, date);
  const analysis = analyzeLog(log);
  const scoredDay = scored.filter((s) => localDateKey(s.time) === localDateKey(date));

  // confidence: live tide data + how decisive the best window is + log size
  let conf: DayContext["confidence"] = "Medium";
  const decisive = windows.length && windows[0].score - (overall ?? 0) >= 0; // window above day avg
  if (bundle.tide.live && windows.length && windows[0].score >= 6.5 && decisive) conf = "High";
  if (!bundle.tide.live || overall < 4) conf = "Low";

  return { date, overall, windows, species, hotspots, tactics, analysis, confidence: conf, scoredDay };
}
