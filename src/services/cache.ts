// localStorage-backed TTL cache for rate-limited external APIs.
//
// Goal: never hammer a provider (Open-Meteo's free tier is a per-IP daily quota)
// and never show "unavailable" once we've loaded real data. Within `maxAge` we
// serve the cached copy with NO network call; when stale we refetch; and on any
// failure (429 daily limit, network blip) we FALL BACK to the last cached value
// so the app keeps showing real - if slightly old - data ("estimate between
// updates"). Forecasts cover days, so a few hours stale is harmless.

const PREFIX = "fc.cache.";

interface Entry { t: number; v: unknown; }

// Common time-to-live values (ms). Tuned to how often each source actually
// changes vs. how scarce the quota is.
export const TTL = {
  weather: 1 * 3600e3,   // Open-Meteo forecast model re-runs ~hourly -> refresh hourly (cheap single-point call)
  marine: 6 * 3600e3,    // SMOC waves/SST update ~daily; 6h picks up the daily run promptly
  current: 12 * 3600e3,  // SMOC ocean current (multi-point: the heaviest caller, daily upstream)
  tide: 24 * 3600e3,     // CHS predictions are deterministic for days
  ocearch: 6 * 3600e3,   // tagged-animal pings ~daily
  stocking: 24 * 3600e3, // provincial stocking updates ~weekly
};

export function cacheRead<T>(key: string): { age: number; value: T } | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const e = JSON.parse(raw) as Entry;
    return { age: Date.now() - e.t, value: e.v as T };
  } catch { return null; }
}

export function cacheWrite(key: string, value: unknown): void {
  const put = () => localStorage.setItem(PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
  try { put(); } catch { evictOldest(); try { put(); } catch { /* out of room; give up */ } }
}

// Drop the oldest quarter of our entries when storage is full.
function evictOldest(): void {
  try {
    const aged = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).map((k) => {
      let t = 0; try { t = (JSON.parse(localStorage.getItem(k)!) as Entry).t; } catch { /* corrupt */ }
      return { k, t };
    }).sort((a, b) => a.t - b.t);
    for (let i = 0; i < Math.max(1, Math.ceil(aged.length / 4)); i++) localStorage.removeItem(aged[i].k);
  } catch { /* ignore */ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fetch JSON through the cache. Fresh hit -> no network. Retries only genuine
// transient failures (network / 5xx); fails fast on 4xx incl. 429 (retrying a
// rate limit just burns more quota). Serves stale on any failure.
export async function cachedJSON(url: string, maxAgeMs: number, opts: { label?: string; signal?: AbortSignal } = {}): Promise<any> {
  const hit = cacheRead<unknown>(url);
  if (hit && hit.age < maxAgeMs) return hit.value;
  const label = opts.label || "fetch";
  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    let res: Response;
    try {
      res = await fetch(url, opts.signal ? { signal: opts.signal } : undefined);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e; // caller superseded; not a failure
      lastErr = e; if (i < 1) await sleep(500); continue;
    }
    if (res.ok) { const data = await res.json(); cacheWrite(url, data); return data; }
    if (res.status >= 500) { lastErr = new Error(`${label} ${res.status}`); if (i < 1) await sleep(500); continue; }
    lastErr = new Error(`${label} ${res.status}`); break; // 4xx / 429 -> do not retry
  }
  if (hit) return hit.value; // last-good real data beats nothing
  throw lastErr;
}
