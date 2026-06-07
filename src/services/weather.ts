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

export interface RawMarine {
  byTime: Map<string, { waveHeight: number | null; swellHeight: number | null; swellPeriod: number | null; waterTemp: number | null }>;
}

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";

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
  const res = await fetch(`${FORECAST_URL}?${params}`);
  if (!res.ok) throw new Error(`Weather API ${res.status}`);
  const j = await res.json();
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
    hourly: ["wave_height", "swell_wave_height", "swell_wave_period", "sea_surface_temperature"].join(","),
    timezone: LOCATION.tz,
    forecast_days: String(days),
  });
  const byTime = new Map<string, { waveHeight: number | null; swellHeight: number | null; swellPeriod: number | null; waterTemp: number | null }>();
  try {
    const res = await fetch(`${MARINE_URL}?${params}`);
    if (!res.ok) throw new Error(`Marine API ${res.status}`);
    const j = await res.json();
    const h = j.hourly;
    h.time.forEach((t: string, i: number) => {
      byTime.set(isoKey(new Date(t)), {
        waveHeight: h.wave_height?.[i] ?? null,
        swellHeight: h.swell_wave_height?.[i] ?? null,
        swellPeriod: h.swell_wave_period?.[i] ?? null,
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
