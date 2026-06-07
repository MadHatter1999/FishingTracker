import type { TideData, TideExtreme } from "../types";

const BASE = "https://api-iwls.dfo-mpo.gc.ca/api/v1/stations";

interface IwlsPoint {
  eventDate: string;
  value: number;
}

async function fetchSeries(stationId: string, code: string, fromISO: string, toISO: string): Promise<IwlsPoint[]> {
  const url = `${BASE}/${stationId}/data?time-series-code=${code}&from=${fromISO}&to=${toISO}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`IWLS ${code} ${res.status}`);
  return (await res.json()) as IwlsPoint[];
}

function classifyExtremes(pts: IwlsPoint[]): TideExtreme[] {
  const sorted = [...pts].sort((a, b) => +new Date(a.eventDate) - +new Date(b.eventDate));
  return sorted.map((p, i) => {
    const prev = sorted[i - 1]?.value ?? -Infinity;
    const next = sorted[i + 1]?.value ?? -Infinity;
    const isHigh = p.value >= prev && p.value >= next;
    return { time: new Date(p.eventDate), type: isHigh ? "high" : "low", height: p.value } as TideExtreme;
  });
}

// Tides are very close to a cosine between consecutive high/low turning points.
// Building the curve from the (small, reliable) hi/lo request avoids fetching
// thousands of 1-minute points and is robust to rate limiting.
function curveFromExtremes(ex: TideExtreme[]): { time: Date; height: number }[] {
  const out: { time: Date; height: number }[] = [];
  for (let i = 0; i < ex.length - 1; i++) {
    const a = ex[i], b = ex[i + 1];
    const span = +b.time - +a.time;
    if (span <= 0) continue;
    for (let t = +a.time; t < +b.time; t += 10 * 60000) {
      const ph = (t - +a.time) / span;
      const h = a.height + (b.height - a.height) * (1 - Math.cos(Math.PI * ph)) / 2;
      out.push({ time: new Date(t), height: +h.toFixed(3) });
    }
  }
  if (ex.length) out.push({ time: ex[ex.length - 1].time, height: ex[ex.length - 1].height });
  return out;
}

export async function fetchTides(stationId: string, stationName: string, days = 7): Promise<TideData> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(start.getTime() + days * 86400000);
  // widen by +-12h so the cosine curve fully brackets the visible range
  const fromISO = new Date(+start - 12 * 3600000).toISOString();
  const toISO = new Date(+end + 12 * 3600000).toISOString();

  try {
    const hilo = await fetchSeries(stationId, "wlp-hilo", fromISO, toISO);
    const extremes = classifyExtremes(hilo);
    if (extremes.length < 3) throw new Error("No tide predictions for this station");
    const series = curveFromExtremes(extremes);
    const heights = extremes.map((e) => e.height);
    const meanRange = Math.max(...heights) - Math.min(...heights);
    return { series, extremes, live: true, stationName, meanRange };
  } catch (e) {
    console.warn("Tide fetch failed, using approximation:", e);
    return approximateTides(start, days, stationName);
  }
}

// Fallback: semidiurnal M2 synthetic curve so the app stays usable if a station
// has no predictions or the API is unreachable.
function approximateTides(start: Date, days: number, stationName: string): TideData {
  const M2 = 12.4206;
  const meanLevel = 0.95;
  const amp = 0.7;
  const anchor = new Date(start.getTime() + 3 * 3600000).getTime();
  const series: { time: Date; height: number }[] = [];
  for (let m = 0; m < days * 24 * 60; m += 10) {
    const t = new Date(start.getTime() + m * 60000);
    const hoursFromAnchor = (t.getTime() - anchor) / 3600000;
    const height = meanLevel + amp * Math.cos((2 * Math.PI * hoursFromAnchor) / M2);
    series.push({ time: t, height: +height.toFixed(3) });
  }
  const extremes = deriveExtremes(series);
  return { series, extremes, live: false, stationName: stationName + " (approx.)", meanRange: 2 * amp };
}

function deriveExtremes(series: { time: Date; height: number }[]): TideExtreme[] {
  const out: TideExtreme[] = [];
  for (let i = 1; i < series.length - 1; i++) {
    const a = series[i - 1].height, b = series[i].height, c = series[i + 1].height;
    if (b > a && b >= c) out.push({ time: series[i].time, type: "high", height: b });
    else if (b < a && b <= c) out.push({ time: series[i].time, type: "low", height: b });
  }
  return out;
}
