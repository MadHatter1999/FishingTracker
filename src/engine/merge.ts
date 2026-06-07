import type { Bundle, HourPoint, TideData, TideState, DayAstro, FishingLocation, TaggedAnimal } from "../types";
import type { RawWeather, RawMarine } from "../services/weather";
import { isoKey } from "../services/weather";
import { moonInfo, tideStrengthFromMoon } from "../services/astronomy";

// Linear-interpolated tide height at an arbitrary time.
export function tideHeightAt(tide: TideData, t: Date): number | null {
  const s = tide.series;
  if (!s.length) return null;
  const x = t.getTime();
  if (x <= +s[0].time) return s[0].height;
  if (x >= +s[s.length - 1].time) return s[s.length - 1].height;
  // binary search
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (+s[mid].time <= x) lo = mid;
    else hi = mid;
  }
  const a = s[lo], b = s[hi];
  const f = (x - +a.time) / (+b.time - +a.time);
  return a.height + f * (b.height - a.height);
}

// Signed velocity in m/h (centered difference, +rising).
export function tideVelocityAt(tide: TideData, t: Date): number | null {
  const dt = 30 * 60000; // 30 min
  const a = tideHeightAt(tide, new Date(+t - dt));
  const b = tideHeightAt(tide, new Date(+t + dt));
  if (a == null || b == null) return null;
  return (b - a) / (dt / 1800000); // per hour (dt*2 = 1h)
}

function tideStateAt(tide: TideData, t: Date): TideState {
  const v = tideVelocityAt(tide, t);
  const h = tideHeightAt(tide, t);
  if (v == null || h == null) return "unknown";
  const mid = tide.meanRange ? avgExtreme(tide) : 1;
  const slack = 0.06 * (tide.meanRange || 1); // threshold m/h
  if (Math.abs(v) < slack) return h >= mid ? "high-slack" : "low-slack";
  return v > 0 ? "rising" : "falling";
}

function avgExtreme(tide: TideData): number {
  if (!tide.extremes.length) return 1;
  return tide.extremes.reduce((s, e) => s + e.height, 0) / tide.extremes.length;
}

export function assembleBundle(location: FishingLocation, weather: RawWeather, marine: RawMarine, tide: TideData, predators: TaggedAnimal[] = []): Bundle {
  const warnings: string[] = [];
  const fresh = location.kind === "fresh";
  if (fresh) {
    warnings.push("Freshwater location - no tides. Forecast uses light, wind, pressure and moon. NS inland fishing needs a provincial licence; verify seasons/limits in the NS Anglers' Handbook.");
  } else {
    if (!tide.live) warnings.push("Live tide data unavailable for this station, using an approximate model. Verify times against a CHS tide table before relying on them.");
    if ([...marine.byTime.values()].length === 0) warnings.push("Marine (wave/water-temp) layer unavailable here, wave & water-temperature factors are estimated.");
  }

  const hours: HourPoint[] = weather.hours.map((w, i) => {
    const m = marine.byTime.get(isoKey(w.time));
    const prev3 = weather.hours[i - 3]?.pressure;
    return {
      time: w.time,
      airTemp: w.airTemp,
      humidity: w.humidity,
      pressure: w.pressure,
      pressureTrend: prev3 != null ? +(w.pressure - prev3).toFixed(1) : 0,
      cloud: w.cloud,
      windSpeed: w.windSpeed,
      windDir: w.windDir,
      windGust: w.windGust,
      precip: w.precip,
      weatherCode: w.weatherCode,
      waveHeight: m?.waveHeight ?? null,
      swellHeight: m?.swellHeight ?? null,
      swellPeriod: m?.swellPeriod ?? null,
      waterTemp: m?.waterTemp ?? null,
      tideHeight: tideHeightAt(tide, w.time),
      tideVelocity: tideVelocityAt(tide, w.time),
      tideState: tideStateAt(tide, w.time),
    };
  });

  // Freshwater lakes have no marine SST feed. Estimate a lake surface temperature
  // from recent air temperature (lakes track a multi-day mean, lagged and damped)
  // so the species catch-% actually shifts by season and location.
  if (location.kind === "fresh" && hours.length) {
    const meanAir = hours.reduce((s, h) => s + h.airTemp, 0) / hours.length;
    const month = hours[0].time.getMonth() + 1;
    // small seasonal offset: summer surface runs a few degrees above mean air, winter near it
    const offset = month >= 6 && month <= 9 ? 3 : month >= 4 && month <= 10 ? 1 : 0;
    const est = Math.max(0.5, Math.min(27, +(meanAir + offset).toFixed(1)));
    for (const h of hours) h.waterTemp = est;
  }

  // build per-day astro from weather daily + moon math
  const astro: DayAstro[] = weather.daily.map((d) => {
    const noon = new Date(d.date + "T12:00:00");
    const mi = moonInfo(noon);
    return {
      date: d.date,
      sunrise: d.sunrise,
      sunset: d.sunset,
      moonPhase: mi.phase,
      moonIllum: mi.illum,
      moonName: mi.name,
      tideStrength: tideStrengthFromMoon(mi.phase),
    };
  });

  return { location, hours, tide, astro, predators, fetchedAt: new Date(), warnings };
}
