import type { TaggedAnimal } from "../types";
import { cachedJSON, TTL } from "./cache";

// OCEARCH publishes its named, satellite-tagged animals (white sharks, tigers,
// makos, tuna, turtles...) via the Mapotic API (map 3413). The geojson feed is
// public + CORS-enabled and carries the most recent ping per animal. White
// sharks like Nukumi were tagged right off Nova Scotia.
const FEED = "https://www.mapotic.com/api/v1/maps/3413/pois/geojson/";

function emojiFor(species: string, category: string): string {
  const s = `${species} ${category}`.toLowerCase();
  if (s.includes("turtle")) return "🐢";
  if (s.includes("tuna")) return "🐟";
  if (s.includes("whale") || s.includes("dolphin")) return "🐋";
  if (s.includes("seal")) return "🦭";
  if (s.includes("shark")) return "🦈";
  return "🐟";
}

export async function fetchTaggedAnimals(lat: number, lon: number, radiusDeg = 6): Promise<TaggedAnimal[]> {
  try {
    const j = await cachedJSON(FEED, TTL.ocearch, { label: "OCEARCH" });
    const out: TaggedAnimal[] = [];
    for (const f of (j.features ?? []) as any[]) {
      const g = f.geometry;
      if (!g || g.type !== "Point") continue;
      const lo = g.coordinates?.[0], la = g.coordinates?.[1];
      if (typeof la !== "number" || typeof lo !== "number") continue;
      if (Math.abs(la - lat) > radiusDeg || Math.abs(lo - lon) > radiusDeg * 1.5) continue;
      const p = f.properties ?? {};
      const sp: string = p.species ?? "";
      const m = /^(.*?)\s*\((.*)\)\s*$/.exec(sp);
      out.push({
        id: String(p.id ?? f.id ?? Math.random()),
        name: p.name || "Unknown",
        species: m ? m[1].trim() : sp || "Tagged animal",
        sci: m ? m[2].trim() : "",
        emoji: emojiFor(sp, p.category_name?.en ?? ""),
        lat: la,
        lon: lo,
        lastPing: p.last_move_datetime ?? p.last_update ?? null,
        length: p.length ?? null,
        weight: p.weight ?? null,
        gender: p.gender ?? null,
        stage: p.stage_of_life ?? null,
        tagLocation: p.tag_location ?? null,
        image: p.image ?? null,
        url: p.slug ? `https://www.ocearch.org/tracker/profile/${p.slug}/` : null,
      });
    }
    out.sort((a, b) => (Date.parse(b.lastPing ?? "") || 0) - (Date.parse(a.lastPing ?? "") || 0));
    return out;
  } catch {
    return [];
  }
}
