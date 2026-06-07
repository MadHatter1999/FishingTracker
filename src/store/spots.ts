import type { FishingLocation } from "../types";

const KEY = "mccormacks.savedspots.v1";

export function loadSpots(): FishingLocation[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    return JSON.parse(raw) as FishingLocation[];
  } catch {
    return [];
  }
}

function persist(spots: FishingLocation[]) {
  localStorage.setItem(KEY, JSON.stringify(spots));
}

export function addSpot(base: FishingLocation, name: string): FishingLocation[] {
  const spots = loadSpots();
  const spot: FishingLocation = {
    ...base,
    id: `saved:${Date.now().toString(36)}`,
    name: name.trim() || base.name,
    saved: true,
  };
  spots.push(spot);
  persist(spots);
  return spots;
}

export function removeSpot(id: string): FishingLocation[] {
  const spots = loadSpots().filter((s) => s.id !== id);
  persist(spots);
  return spots;
}
