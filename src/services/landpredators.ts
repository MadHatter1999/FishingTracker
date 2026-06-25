// Recent LAND-predator sightings near a point, from iNaturalist (free, no key,
// CORS *). The inland counterpart to the OCEARCH ocean-predator feed - but note
// these are citizen-science OBSERVATIONS ("seen here on this date"), NOT live GPS
// tracking. There is no public live tracked-land-predator API for NS (the Acadia/
// DNRR collared-bear data is research-only), so sightings are the realistic feed.
import { cachedJSON, TTL } from "./cache";
import type { LandSighting } from "../types";

const URL = "https://api.inaturalist.org/v1/observations";
// NS land predators by iNaturalist taxon id (verified via /v1/taxa).
const TAXON_IDS = ["41638", "42051", "41976", "41974", "42069"].join(","); // bear, coyote, bobcat, lynx, fox

// Map a scientific name (species OR subspecies, since iNat returns descendants of
// the queried taxon) to a display name + emoji.
function classify(sciName: string): { common: string; emoji: string } {
  if (/^Ursus/.test(sciName)) return { common: "Black bear", emoji: "🐻" };
  if (/^Canis/.test(sciName)) return { common: "Coyote", emoji: "🐺" };
  if (/^Lynx rufus/.test(sciName)) return { common: "Bobcat", emoji: "🐆" };
  if (/^Lynx/.test(sciName)) return { common: "Canada lynx", emoji: "🐱" };
  if (/^Vulpes/.test(sciName)) return { common: "Red fox", emoji: "🦊" };
  return { common: "Predator", emoji: "🐾" };
}

export async function fetchLandPredators(lat: number, lon: number): Promise<LandSighting[]> {
  const params = new URLSearchParams({
    taxon_id: TAXON_IDS,
    lat: String(lat),
    lng: String(lon),
    radius: "50", // km
    quality_grade: "research,needs_id", // verified + pending; excludes casual/captive junk
    order_by: "observed_on",
    order: "desc",
    per_page: "50",
    photos: "true",
  });
  const j = await cachedJSON(`${URL}?${params}`, TTL.occurrences, { label: "iNaturalist" });
  const out: LandSighting[] = [];
  for (const o of (j.results ?? []) as RawObs[]) {
    const coords = o.geojson?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue; // no location -> skip
    const sci = o.taxon?.name ?? "";
    const tag = classify(sci);
    out.push({
      species: sci || tag.common,
      common: o.taxon?.preferred_common_name || tag.common,
      emoji: tag.emoji,
      lat: coords[1],
      lon: coords[0],
      observedOn: o.observed_on ?? null,
      obscured: !!o.obscured,
      place: o.place_guess ?? null,
      photo: o.photos?.[0]?.url ? o.photos[0].url.replace("square", "small") : null,
      url: o.uri ?? null,
    });
  }
  return out;
}

interface RawObs {
  observed_on?: string;
  obscured?: boolean;
  place_guess?: string;
  uri?: string;
  geojson?: { coordinates?: number[] };
  taxon?: { name?: string; preferred_common_name?: string };
  photos?: { url?: string }[];
}
