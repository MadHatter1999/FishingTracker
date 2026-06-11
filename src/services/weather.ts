import { LOCATION } from "../config";

export interface RawWeather {
  hours: {
    time: Date;
    airTemp: number;
    humidity: number;
    pressure: number;
    cloud: number;
    windSpeed: number;
    windDir: number;
    windGust: number;
    precip: number;
    weatherCode: number;
  }[];
  daily: { date: string; sunrise: Date | null; sunset: Date | null }[];
}

export interface MarineHour {
  waveHeight: number | null;     // Hs total, m
  wavePeriod: number | null;     // s
  waveDir: number | null;        // deg FROM
  swellHeight: number | null;
  swellPeriod: number | null;
  swellDir: number | null;       // deg FROM
  windWaveHeight: number | null;
  windWavePeriod: number | null;
  windWaveDir: number | null;    // deg FROM
  currentVelocity: number | null; // km/h (Open-Meteo default)
  currentDir: number | null;      // deg TO
  waterTemp: number | null;       // sea-surface temp, C
}

export interface RawMarine {
  byTime: Map<string, MarineHour>;
}

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";

// Open-Meteo occasionally returns a transient 429 (rate limit) or a network
// blip, especially as we now request many marine variables at once. Retry a few
// times with backoff so a single hiccup does not blank the whole forecast.
async function fetchJSON(url: string, label: string, tries = 3): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) throw new Error(`${label} ${res.status}`);
      if (!res.ok) throw new Error(`${label} ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1) + Math.random() * 200));
    }
  }
  throw lastErr;
}

function isoKey(d: Date): string {
  // round to the hour, use UTC ms key to align series
  return new Date(Math.round(d.getTime() / 3600000) * 3600000).toISOString();
}

export async function fetchWeather(lat: number, lon: number, days = 7): Promise<RawWeather> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: [
      "temperature_2m",
      "relative_humidity_2m",
      "pressure_msl",
      "cloud_cover",
      "wind_speed_10m",
      "wind_direction_10m",
      "wind_gusts_10m",
      "precipitation",
      "weather_code",
    ].join(","),
    daily: "sunrise,sunset",
    timezone: LOCATION.tz,
    forecast_days: String(days),
    wind_speed_unit: "kmh",
  });
  const j = await fetchJSON(`${FORECAST_URL}?${params}`, "Weather API");
  const h = j.hourly;
  const hours = h.time.map((t: string, i: number) => ({
    time: new Date(t),
    airTemp: h.temperature_2m[i],
    humidity: h.relative_humidity_2m[i],
    pressure: h.pressure_msl[i],
    cloud: h.cloud_cover[i],
    windSpeed: h.wind_speed_10m[i],
    windDir: h.wind_direction_10m[i],
    windGust: h.wind_gusts_10m[i],
    precip: h.precipitation[i],
    weatherCode: h.weather_code[i],
  }));
  const daily = j.daily.time.map((d: string, i: number) => ({
    date: d,
    sunrise: j.daily.sunrise[i] ? new Date(j.daily.sunrise[i]) : null,
    sunset: j.daily.sunset[i] ? new Date(j.daily.sunset[i]) : null,
  }));
  return { hours, daily };
}

export async function fetchMarine(lat: number, lon: number, days = 7): Promise<RawMarine> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: [
      "wave_height", "wave_period", "wave_direction",
      "swell_wave_height", "swell_wave_period", "swell_wave_direction",
      "wind_wave_height", "wind_wave_period", "wind_wave_direction",
      "ocean_current_velocity", "ocean_current_direction",
      "sea_surface_temperature",
    ].join(","),
    timezone: LOCATION.tz,
    forecast_days: String(days),
  });
  const byTime = new Map<string, MarineHour>();
  try {
    const j = await fetchJSON(`${MARINE_URL}?${params}`, "Marine API");
    const h = j.hourly;
    h.time.forEach((t: string, i: number) => {
      byTime.set(isoKey(new Date(t)), {
        waveHeight: h.wave_height?.[i] ?? null,
        wavePeriod: h.wave_period?.[i] ?? null,
        waveDir: h.wave_direction?.[i] ?? null,
        swellHeight: h.swell_wave_height?.[i] ?? null,
        swellPeriod: h.swell_wave_period?.[i] ?? null,
        swellDir: h.swell_wave_direction?.[i] ?? null,
        windWaveHeight: h.wind_wave_height?.[i] ?? null,
        windWavePeriod: h.wind_wave_period?.[i] ?? null,
        windWaveDir: h.wind_wave_direction?.[i] ?? null,
        currentVelocity: h.ocean_current_velocity?.[i] ?? null,
        currentDir: h.ocean_current_direction?.[i] ?? null,
        waterTemp: h.sea_surface_temperature?.[i] ?? null,
      });
    });
  } catch (e) {
    // marine layer is optional; return empty map
    console.warn("Marine fetch failed", e);
  }
  return { byTime };
}

export { isoKey };
