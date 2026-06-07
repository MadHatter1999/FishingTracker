import { fetchWeather, fetchMarine } from "./services/weather";
import { fetchTides } from "./services/tides";
import { fetchTaggedAnimals } from "./services/ocearch";
import { fetchStocking } from "./services/stocking";
import { assembleBundle } from "./engine/merge";
import type { Bundle, FishingLocation, TideData, TaggedAnimal, StockingInfo } from "./types";

const EMPTY_TIDE: TideData = {
  series: [], extremes: [], live: false, stationName: "Freshwater (no tide)", meanRange: 0,
};

export async function loadBundle(loc: FishingLocation, days = 7): Promise<Bundle> {
  const fresh = loc.kind === "fresh";
  const [weather, marine, tide, predators, stocking] = await Promise.all([
    fetchWeather(loc.lat, loc.lon, days),
    fresh ? Promise.resolve({ byTime: new Map() }) : fetchMarine(loc.lat, loc.lon, days),
    fresh ? Promise.resolve(EMPTY_TIDE) : fetchTides(loc.tideStationId, loc.tideStationName, days),
    fresh ? Promise.resolve([] as TaggedAnimal[]) : fetchTaggedAnimals(loc.lat, loc.lon),
    fresh ? fetchStocking(loc) : Promise.resolve(null as StockingInfo | null),
  ]);
  const bundle = assembleBundle(loc, weather, marine, tide, predators);
  bundle.stocking = stocking;
  return bundle;
}
