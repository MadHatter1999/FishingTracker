import type { Bundle, HourPoint, ScoredHour, DayAstro, FishingWindow } from "../types";

export function dayAstroFor(astro: DayAstro[], t: Date): DayAstro | undefined {
  const key = localDateKey(t);
  return astro.find((a) => a.date === key);
}

export function localDateKey(t: Date): string {
  // local yyyy-mm-dd
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function clamp(x: number, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, x));
}

// proximity bonus to a target time (minutes), bell-shaped within +-window
function nearTime(t: Date, target: Date | null, windowMin: number): number {
  if (!target) return 0;
  const diff = Math.abs(+t - +target) / 60000;
  if (diff > windowMin) return 0;
  return Math.cos((diff / windowMin) * (Math.PI / 2)); // 1 at center -> 0 at edge
}

export interface ScoreWeights {
  tide: number;
  lowLight: number;
  wind: number;
  wave: number;
  pressure: number;
  sky: number;
  moon: number;
  thermal: number;
}

const W: ScoreWeights = { tide: 3.0, lowLight: 2.2, wind: 1.8, wave: 1.2, pressure: 1.0, sky: 0.6, moon: 0.8, thermal: 1.8 };

export interface ScoreOpts {
  freshwater?: boolean;
  highProximity?: number; // 0..1 closeness to a high tide (salt only)
}

export function scoreHour(h: HourPoint, astro: DayAstro | undefined, meanRange: number, opts: ScoreOpts = {}): ScoredHour {
  const freshwater = opts.freshwater ?? false;
  const factors: Record<string, number> = {};
  const reasons: string[] = [];

  // --- Tidal movement + tide phase: moving water concentrates bait, and a flood
  //     toward high pushes fish over flats/structure within reach of shore ---
  const vel = Math.abs(h.tideVelocity ?? 0);
  const velNorm = freshwater ? 0 : clamp(vel / (0.28 * (meanRange || 1.4))); // ~peak flow -> 1
  const highProx = freshwater ? 0 : clamp(opts.highProximity ?? 0);
  factors.tide = freshwater ? 0 : clamp(0.7 * velNorm + 0.45 * highProx);
  if (!freshwater) {
    if (highProx > 0.6 && h.tideState !== "falling") reasons.push("Building to high tide - fish pushing shoreward");
    else if (velNorm > 0.7) reasons.push("Strong tidal flow - bait on the move");
    else if (velNorm < 0.2 && highProx < 0.4) reasons.push("Near slack water - slower bite");
  }

  // --- Low light (dawn/dusk) ---
  const dawn = nearTime(h.time, astro?.sunrise ?? null, 100);
  const dusk = nearTime(h.time, astro?.sunset ?? null, 100);
  const lowLight = Math.max(dawn, dusk);
  factors.lowLight = lowLight;
  if (lowLight > 0.55) reasons.push(dawn >= dusk ? "Dawn low-light window" : "Dusk low-light window");

  // --- Wind: moderate is best for shore casting; gales unfishable/unsafe ---
  const ws = h.windSpeed;
  let windScore: number;
  if (ws <= 5) windScore = 0.55;
  else if (ws <= 22) windScore = 1 - Math.abs(ws - 13) / 30; // peak ~13 km/h
  else if (ws <= 35) windScore = clamp(0.5 - (ws - 22) / 26);
  else windScore = 0.05;
  factors.wind = clamp(windScore);
  if (ws > 35) reasons.push(`Strong wind ${Math.round(ws)} km/h - tough/unsafe from shore`);
  else if (h.windGust > 45) reasons.push(`Gusty (${Math.round(h.windGust)} km/h gusts)`);

  // --- Wave / swell: a little chop good, big surf dangerous on the rocks ---
  const wh = h.waveHeight;
  let waveScore = 0.6;
  if (wh != null) {
    if (wh <= 0.3) waveScore = 0.6;
    else if (wh <= 0.9) waveScore = 1;
    else if (wh <= 1.5) waveScore = clamp(1 - (wh - 0.9) / 0.9);
    else waveScore = 0.1;
    if (wh > 1.8) reasons.push(`Big swell ${wh.toFixed(1)} m - stay off the rocks`);
  }
  factors.wave = waveScore;

  // --- Barometric pressure & trend ---
  const p = h.pressure;
  const trend = h.pressureTrend;
  let pScore = 0.6;
  if (p >= 1018) pScore = 0.75; // stable high - steady fishing
  if (p < 1005) pScore = 0.5; // deep low
  if (trend <= -1.5) pScore = Math.max(pScore, 0.85); // falling before front - feeding push
  if (trend >= 2) pScore = 0.45; // sharp rise after front - slow
  factors.pressure = pScore;
  if (trend <= -1.5) reasons.push("Falling barometer - pre-front feeding window");
  else if (trend >= 2) reasons.push("Rising barometer post-front - often slow");

  // --- Sky / cloud: overcast helps daytime predators ---
  const isDay = lowLight === 0 && isDaylight(h.time, astro);
  let skyScore = 0.6;
  if (isDay) skyScore = clamp(0.4 + h.cloud / 200); // up to ~0.9 fully overcast
  else skyScore = 0.7;
  if (h.precip > 4) skyScore *= 0.6;
  factors.sky = skyScore;

  // --- Moon / spring-neap strength (day-level) ---
  const moonStrength = astro ? { spring: 1, strong: 0.8, moderate: 0.6, neap: 0.4 }[astro.tideStrength] : 0.6;
  factors.moon = moonStrength;
  if (astro?.tideStrength === "spring") reasons.push(freshwater ? "New/full moon - strong solunar period" : "Spring tides - maximum water movement");

  // --- Thermal / time-of-day (freshwater): warm lakes go quiet in midday heat;
  //     fish feed at dawn/dusk. In cool water / spring & fall, midday is fine ---
  if (freshwater) {
    const hr = h.time.getHours();
    const month = h.time.getMonth() + 1;
    const warm = (h.waterTemp ?? 15) >= 19;
    const heatSeason = month >= 6 && month <= 9;
    let thermal = 0.85;
    if (lowLight > 0.4) thermal = 1; // dawn/dusk prime
    else if ((warm || heatSeason) && hr >= 10 && hr <= 16) {
      thermal = 0.45; // midday lull
      if (lowLight === 0) reasons.push("Midday warmth - fish deep & sluggish; go early/late");
    } else if (!isDaylight(h.time, astro)) {
      thermal = 0.8; // after dark - decent for bullhead/eel/walleye-types
    }
    factors.thermal = thermal;
  }

  // weighted sum (freshwater drops tide & wave, adds a thermal/time-of-day factor)
  let totalW: number, raw: number;
  if (freshwater) {
    totalW = W.lowLight + W.wind + W.pressure + W.sky + W.moon + W.thermal;
    raw =
      W.lowLight * factors.lowLight +
      W.wind * factors.wind +
      W.pressure * factors.pressure +
      W.sky * factors.sky +
      W.moon * factors.moon +
      W.thermal * factors.thermal;
  } else {
    totalW = W.tide + W.lowLight + W.wind + W.wave + W.pressure + W.sky + W.moon;
    raw =
      W.tide * factors.tide +
      W.lowLight * factors.lowLight +
      W.wind * factors.wind +
      W.wave * factors.wave +
      W.pressure * factors.pressure +
      W.sky * factors.sky +
      W.moon * factors.moon;
  }
  let score = (raw / totalW) * 10;

  // hard safety caps
  if (ws > 45 || (wh != null && wh > 2.2)) score = Math.min(score, 3);
  if (h.precip > 8) score = Math.min(score, 5);

  return { time: h.time, score: +score.toFixed(2), reasons: reasons.slice(0, 4), factors };
}

function isDaylight(t: Date, astro?: DayAstro): boolean {
  if (!astro?.sunrise || !astro?.sunset) return true;
  return +t >= +astro.sunrise && +t <= +astro.sunset;
}

export function computeScores(bundle: Bundle): ScoredHour[] {
  const fresh = bundle.location.kind === "fresh";
  const highs = fresh ? [] : bundle.tide.extremes.filter((e) => e.type === "high").map((e) => +e.time);
  const highProximityAt = (t: Date): number => {
    if (!highs.length) return 0;
    const nearest = highs.reduce((m, x) => Math.min(m, Math.abs(x - +t)), Infinity);
    const win = 150 * 60000; // within 2.5 h of a high tide
    return nearest > win ? 0 : Math.cos((nearest / win) * (Math.PI / 2));
  };
  return bundle.hours.map((h) =>
    scoreHour(h, dayAstroFor(bundle.astro, h.time), bundle.tide.meanRange, {
      freshwater: fresh,
      highProximity: highProximityAt(h.time),
    })
  );
}

// --- Window detection ---
export function findWindows(scored: ScoredHour[], opts?: { min?: number; relax?: number }): FishingWindow[] {
  if (!scored.length) return [];
  const max = Math.max(...scored.map((s) => s.score));
  const min = opts?.min ?? Math.max(5.5, max - 1.8);
  const windows: FishingWindow[] = [];
  let run: ScoredHour[] = [];
  const flush = () => {
    if (run.length) {
      const peak = run.reduce((a, b) => (b.score > a.score ? b : a));
      const avg = run.reduce((s, r) => s + r.score, 0) / run.length;
      windows.push({
        start: run[0].time,
        end: new Date(+run[run.length - 1].time + 3600000),
        peak: peak.time,
        score: +avg.toFixed(2),
        reason: peak.reasons.join(" · ") || "Favourable conditions",
      });
      run = [];
    }
  };
  for (const s of scored) {
    if (s.score >= min) run.push(s);
    else flush();
  }
  flush();
  return windows.sort((a, b) => b.score - a.score);
}

export function windowsForRange(scored: ScoredHour[], from: Date, to: Date): FishingWindow[] {
  return findWindows(scored.filter((s) => +s.time >= +from && +s.time < +to));
}

export function overallScoreForDay(scored: ScoredHour[], date: Date): number {
  const key = localDateKey(date);
  const day = scored.filter((s) => localDateKey(s.time) === key);
  if (!day.length) return 0;
  // weight the best few hours - a day is as good as its best windows
  const top = [...day].sort((a, b) => b.score - a.score).slice(0, 4);
  return +(top.reduce((s, r) => s + r.score, 0) / top.length).toFixed(1);
}
