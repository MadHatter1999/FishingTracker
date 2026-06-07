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
      notes: "Dusk pollock on the island-facing rocks as the tide ran out. Best on the seam.",
    },
  ];
  saveLog(samples);
  return samples;
}
