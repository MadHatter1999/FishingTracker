import { fetchWeather, fetchMarine } from "./services/weather";
import { fetchTides } from "./services/tides";
import { fetchTaggedAnimals } from "./services/ocearch";
import { fetchStocking } from "./services/stocking";
import { fetchNearbyTaxa } from "./services/occurrences";
import { fetchLandPredators } from "./services/landpredators";
import { assembleBundle } from "./engine/merge";
import type { Bundle, FishingLocation, TideData, TaggedAnimal, StockingInfo, OccTaxon, LandSighting } from "./types";

const EMPTY_TIDE: TideData = {
  series: [], extremes: [], live: false, stationName: "Freshwater (no tide)", meanRange: 0,
};

export async function loadBundle(loc: FishingLocation, days = 7): Promise<Bundle> {
  const fresh = loc.kind === "fresh";
  // Only weather is essential. The rest already have internal fallbacks, but
  // wrap them so a single optional-feed failure can never reject the whole load
  // (which showed up as the map "loading in funny / data not there").
  const [weather, marine, tide, predators, stocking, nearbyTaxa, landPredators] = await Promise.all([
    fetchWeather(loc.lat, loc.lon, days),
    fresh ? Promise.resolve({ byTime: new Map() }) : fetchMarine(loc.lat, loc.lon, days).catch(() => ({ byTime: new Map() })),
    fresh ? Promise.resolve(EMPTY_TIDE) : fetchTides(loc.tideStationId, loc.tideStationName, days).catch(() => EMPTY_TIDE),
    fresh ? Promise.resolve([] as TaggedAnimal[]) : fetchTaggedAnimals(loc.lat, loc.lon).catch(() => [] as TaggedAnimal[]),
    fresh ? fetchStocking(loc).catch(() => null as StockingInfo | null) : Promise.resolve(null as StockingInfo | null),
    fetchNearbyTaxa(loc.lat, loc.lon, loc.kind).catch(() => [] as OccTaxon[]),
    // Land-predator sightings are relevant province-wide (bears/coyotes roam the
    // coast too), so fetch for any spot; optional feed, so never block the load.
    fetchLandPredators(loc.lat, loc.lon).catch(() => [] as LandSighting[]),
  ]);
  const bundle = assembleBundle(loc, weather, marine, tide, predators);
  bundle.stocking = stocking;
  bundle.nearbyTaxa = nearbyTaxa;
  bundle.landPredators = landPredators;
  return bundle;
}
