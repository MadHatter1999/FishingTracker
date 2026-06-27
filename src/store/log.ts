import type { CatchRecord } from "../types";

const KEY = "mccormacks.catchlog.v1";

export function loadLog(): CatchRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    return JSON.parse(raw) as CatchRecord[];
  } catch {
    return [];
  }
}

export function saveLog(records: CatchRecord[]): void {
  localStorage.setItem(KEY, JSON.stringify(records));
}

export function addRecord(rec: CatchRecord): CatchRecord[] {
  const all = loadLog();
  all.push(rec);
  all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  saveLog(all);
  return all;
}

export function deleteRecord(id: string): CatchRecord[] {
  const all = loadLog().filter((r) => r.id !== id);
  saveLog(all);
  return all;
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function exportJSON(): string {
  return JSON.stringify(loadLog(), null, 2);
}

// Flat spreadsheet of every trip - one row per record, every field as a column,
// plus a computed Duration (h). Opens straight into Excel/Sheets if you want the
// whole trip & catch log in one place.
export function exportCSV(): string {
  const cols: [string, (r: CatchRecord) => string | number][] = [
    ["Date", (r) => r.date],
    ["Start", (r) => r.start],
    ["End", (r) => r.end],
    ["Duration (h)", (r) => tripHours(r).toFixed(2)],
    ["Location", (r) => r.location ?? ""],
    ["Lat", (r) => r.lat ?? ""],
    ["Lon", (r) => r.lon ?? ""],
    ["Method", (r) => r.method ?? ""],
    ["Party", (r) => r.party ?? ""],
    ["Species", (r) => r.species],
    ["Count", (r) => r.count],
    ["Size", (r) => r.size],
    ["Weight", (r) => r.weight ?? ""],
    ["Kept", (r) => r.kept],
    ["Gear", (r) => r.gear],
    ["Bait", (r) => r.bait ?? ""],
    ["Wildlife seen", (r) => r.wildlife ?? ""],
    ["Tide stage", (r) => r.tideStage],
    ["Tide height", (r) => r.tideHeight],
    ["Wind dir", (r) => r.windDir],
    ["Wind speed", (r) => r.windSpeed],
    ["Weather", (r) => r.weather],
    ["Water", (r) => r.water],
    ["Moon phase", (r) => r.moonPhase ?? ""],
    ["Water temp", (r) => r.waterTemp ?? ""],
    ["Notes", (r) => r.notes],
  ];
  const cell = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = loadLog().map((r) => cols.map(([, fn]) => cell(fn(r))).join(","));
  return [cols.map(([h]) => cell(h)).join(","), ...rows].join("\r\n");
}

// Trip length in hours (handles a session that runs past midnight).
function tripHours(r: CatchRecord): number {
  const [sh, sm] = r.start.split(":").map(Number);
  const [eh, em] = r.end.split(":").map(Number);
  let h = eh + em / 60 - (sh + sm / 60);
  if (h <= 0) h += 24;
  return h || 0;
}

export function importJSON(text: string): CatchRecord[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array of catch records");
  saveLog(parsed);
  return parsed;
}

// A couple of realistic sample trips so the analysis tab is alive on first run.
export function seedSamples(): CatchRecord[] {
  const samples: CatchRecord[] = [
    {
      id: newId(), date: "2025-09-14", start: "06:00", end: "08:30",
      tideStage: "rising", tideHeight: "1.2 m", windDir: "NW", windSpeed: "12 km/h",
      weather: "Partly cloudy", water: "Light chop", species: "Atlantic Mackerel", count: 18,
      size: "30-35 cm", kept: "kept", gear: "Sabiki + float", moonPhase: "Waxing Gibbous", waterTemp: "15 °C",
      location: "McCormacks Beach", method: "Shore", party: "Solo",
      bait: "Sabiki (gold hooks)", weight: "~0.4 kg each", wildlife: "2 harbour seals, cormorants working the bait ball",
      notes: "Hit a school right at sunrise off the boardwalk on the incoming tide. Fast and furious for ~40 min.",
    },
    {
      id: newId(), date: "2025-09-20", start: "12:00", end: "14:00",
      tideStage: "high-slack", tideHeight: "1.7 m", windDir: "SW", windSpeed: "22 km/h",
      weather: "Sunny", water: "Flat", species: "Cunner", count: 6,
      size: "15-20 cm", kept: "released", gear: "Bottom rig + worm", moonPhase: "Last Quarter", waterTemp: "16 °C",
      notes: "Slow midday on slack water, bright sun. Only cunner off the rocks.",
    },
    {
      id: newId(), date: "2025-10-05", start: "17:30", end: "19:30",
      tideStage: "falling", tideHeight: "0.9 m", windDir: "NW", windSpeed: "15 km/h",
      weather: "Overcast", water: "Chop", species: "Pollock", count: 5,
      size: "35-45 cm", kept: "kept", gear: "White jig", moonPhase: "Waning Crescent", waterTemp: "12 °C",
      location: "Fisherman's Cove", method: "Shore", party: "With Dave",
      bait: "White jig", weight: "Best ~1.1 kg", wildlife: "Bald eagle overhead, grey seal hauled out on the ledge",
      notes: "Dusk pollock on the island-facing rocks as the tide ran out. Best on the seam.",
    },
  ];
  saveLog(samples);
  return samples;
}
