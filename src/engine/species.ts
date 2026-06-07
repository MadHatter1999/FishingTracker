import { SPECIES, FRESH_SPECIES, EURYHALINE_KEYS, type SpeciesDef } from "../config";
import type { Bundle, ScoredHour, SpeciesForecast } from "../types";
import { localDateKey, windowsForRange } from "./score";
import { fmtRange } from "../util/format";

function dayHours(bundle: Bundle, date: Date) {
  const key = localDateKey(date);
  return bundle.hours.filter((h) => localDateKey(h.time) === key);
}

function avgWaterTemp(bundle: Bundle, date: Date): number | null {
  const hrs = dayHours(bundle, date).map((h) => h.waterTemp).filter((x): x is number => x != null);
  if (!hrs.length) return null;
  return hrs.reduce((s, x) => s + x, 0) / hrs.length;
}

function tempFactor(temp: number | null, def: SpeciesDef): number {
  if (temp == null) return 0.7; // unknown
  const [il, ih] = def.waterTempIdeal;
  const [rl, rh] = def.waterTempRange;
  if (temp >= il && temp <= ih) return 1;
  if (temp < rl || temp > rh) return 0.1;
  // linear falloff in the tolerable bands
  if (temp < il) return 0.3 + 0.7 * ((temp - rl) / (il - rl));
  return 0.3 + 0.7 * ((rh - temp) / (rh - ih));
}

function seasonFactor(def: SpeciesDef, month: number): number {
  if (def.peakMonths.includes(month)) return 1;
  if (def.months.includes(month)) return 0.6;
  return 0.12;
}

export function forecastSpecies(bundle: Bundle, scored: ScoredHour[], date: Date): SpeciesForecast[] {
  const month = date.getMonth() + 1;
  const water = avgWaterTemp(bundle, date);
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(+dayStart + 86400000);
  const windows = windowsForRange(scored, dayStart, dayEnd);
  const top = windows[0];
  const dayScored = scored.filter((s) => localDateKey(s.time) === localDateKey(date));
  const peakScore = dayScored.length ? Math.max(...dayScored.map((s) => s.score)) : 5;

  // Pick the right species pool for the water type:
  //  - saltwater    -> sea species
  //  - freshwater   -> lake/river species only (0 chance of sea fish)
  //  - brackish lake (estuary / meeting of waters) -> freshwater PLUS the
  //    euryhaline/diadromous sea fish that actually run into brackish water
  const fresh = bundle.location.kind === "fresh";
  const brackishExtras = fresh && bundle.location.brackish
    ? SPECIES.filter((s) => EURYHALINE_KEYS.has(s.key))
    : [];
  const speciesSet = fresh ? [...FRESH_SPECIES, ...brackishExtras] : SPECIES;
  const brackishKeys = new Set(brackishExtras.map((s) => s.key));

  const out = speciesSet.map((def): SpeciesForecast => {
    const sf = seasonFactor(def, month);
    const tf = tempFactor(water, def);
    // sea fish only reach the brackish interface intermittently -> damp their odds
    const brackishDamp = brackishKeys.has(def.key) ? 0.5 : 1;
    const encounter = clampPct(def.baseEncounter * sf * (0.4 + 0.6 * tf) * brackishDamp);

    // condition alignment: blend the day's best window strength with species' bias
    const condBase = peakScore / 10;
    const movingHelp = def.prefersMovingWater * condBase;
    const align = clamp01(0.35 + 0.45 * condBase + 0.2 * movingHelp);
    const catchP = clampPct(encounter * (0.35 + 0.55 * align) * (0.6 + 0.4 * tf));

    // best window text: species that love low light skew to dawn/dusk window
    let bestWindow = top ? fmtRange(top.start, top.end) : "Tide changes";
    if (def.dawnDuskBias > 0.8) {
      const dusk = windows.find((w) => isLowLight(w.peak, bundle, date));
      if (dusk) bestWindow = fmtRange(dusk.start, dusk.end);
    }

    return {
      key: def.key,
      name: def.name,
      emoji: def.emoji,
      encounter: Math.round(encounter),
      catch: Math.round(catchP),
      bestWindow,
      bestLocation: def.location,
      rig: def.rig,
      bait: def.bait,
      size: def.size,
      eating: def.eating,
      legal: def.legal,
      legalFlag: def.legalFlag,
      notes: def.notes,
    };
  });

  return out.sort((a, b) => b.catch - a.catch || b.encounter - a.encounter);
}

function isLowLight(t: Date, bundle: Bundle, date: Date): boolean {
  const a = bundle.astro.find((x) => x.date === localDateKey(date));
  if (!a?.sunrise || !a?.sunset) return false;
  const m = 90 * 60000;
  return Math.abs(+t - +a.sunrise) < m || Math.abs(+t - +a.sunset) < m;
}

function clampPct(x: number) { return Math.max(1, Math.min(96, x)); }
function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
