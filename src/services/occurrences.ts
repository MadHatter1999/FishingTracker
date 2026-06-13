// "What's where" - real species documented near a location, from OBIS (Ocean
// Biogeographic Information System), the global marine occurrence database.
// Free, no key, CORS *. One checklist call returns scientific names + record
// counts + taxonomic class for a bounding box; we keep the fish, attach common
// names where we know them, and group sharks/rays vs bony fish. Works anywhere on
// Earth (coastal/marine) and surfaces species beyond our curated NS roster.
//
// OBIS is MARINE only - freshwater lakes return nothing (those rely on the
// curated freshwater species list + provincial stocking).
import { cachedJSON, TTL } from "./cache";
import type { OccTaxon } from "../types";

export type { OccTaxon };

const FISH_CLASS = /Teleostei|Actinopteri|Actinopterygii|Elasmobranchii|Holocephali|Petromyzont|Myxini|Chondrichthyes/i;
const SHARK = /Carcharhin|Lamn|Squal|Alopi|Cetorhin|Hexanch|Scyliorhin|Triakid|Sphyrn|Odontaspid/i; // shark orders/families
const RAY = /Raj|Myliobat|Dasyat|Torpedin|Rhinobat|Narcin/i; // skates & rays

// Common names for the well-known NW-Atlantic / widely-recognised species OBIS
// returns by scientific name. Unknown species fall back to the scientific name.
const COMMON: Record<string, string> = {
  "Scomber scombrus": "Atlantic mackerel", "Gadus morhua": "Atlantic cod", "Pollachius virens": "Pollock",
  "Clupea harengus": "Atlantic herring", "Melanogrammus aeglefinus": "Haddock", "Morone saxatilis": "Striped bass",
  "Pseudopleuronectes americanus": "Winter flounder", "Tautogolabrus adspersus": "Cunner", "Urophycis tenuis": "White hake",
  "Merluccius bilinearis": "Silver hake", "Hippoglossus hippoglossus": "Atlantic halibut", "Anarhichas lupus": "Atlantic wolffish",
  "Squalus acanthias": "Spiny dogfish", "Prionace glauca": "Blue shark", "Lamna nasus": "Porbeagle shark",
  "Isurus oxyrinchus": "Shortfin mako", "Carcharodon carcharias": "White shark", "Cetorhinus maximus": "Basking shark",
  "Salmo salar": "Atlantic salmon", "Anguilla rostrata": "American eel", "Alosa pseudoharengus": "Alewife (gaspereau)",
  "Alosa sapidissima": "American shad", "Osmerus mordax": "Rainbow smelt", "Microgadus tomcod": "Atlantic tomcod",
  "Hippoglossoides platessoides": "American plaice", "Sebastes": "Redfish", "Sebastes fasciatus": "Acadian redfish",
  "Myoxocephalus scorpius": "Shorthorn sculpin", "Myoxocephalus octodecemspinosus": "Longhorn sculpin",
  "Hemitripterus americanus": "Sea raven", "Macrozoarces americanus": "Ocean pout", "Zoarces americanus": "Ocean pout",
  "Cyclopterus lumpus": "Lumpfish", "Mallotus villosus": "Capelin", "Ammodytes": "Sand lance",
  "Gasterosteus aculeatus": "Threespine stickleback", "Menidia menidia": "Atlantic silverside", "Fundulus heteroclitus": "Mummichog",
  "Thunnus thynnus": "Atlantic bluefin tuna", "Xiphias gladius": "Swordfish", "Raja": "Skate",
  "Leucoraja ocellata": "Winter skate", "Amblyraja radiata": "Thorny skate", "Malacoraja senta": "Smooth skate",
  "Brevoortia tyrannus": "Atlantic menhaden", "Lophius americanus": "Monkfish (goosefish)", "Cyclopterus": "Lumpfish",
  "Pomatomus saltatrix": "Bluefish", "Centropristis striata": "Black sea bass", "Tautoga onitis": "Tautog (blackfish)",
};

function classify(r: { scientificName?: string; class?: string; order?: string; family?: string }): { group: OccTaxon["group"]; emoji: string } {
  const cls = r.class || "";
  const lower = `${r.order || ""} ${r.family || ""} ${r.scientificName || ""}`;
  if (/Elasmobranchii|Holocephali|Chondrichthyes/i.test(cls)) {
    if (RAY.test(lower)) return { group: "ray", emoji: "🥏" };
    if (SHARK.test(lower)) return { group: "shark", emoji: "🦈" };
    return { group: "shark", emoji: "🦈" }; // cartilaginous: default shark
  }
  return { group: "fish", emoji: "🐟" };
}

// Common-name lookup, falling back to genus-level entries (e.g. "Sebastes sp.").
function commonFor(sci: string): string | null {
  if (COMMON[sci]) return COMMON[sci];
  const genus = sci.split(" ")[0];
  return COMMON[genus] ?? null;
}

export async function fetchNearbyTaxa(lat: number, lon: number, kind: "salt" | "fresh"): Promise<OccTaxon[]> {
  if (kind === "fresh") return []; // OBIS is marine only
  const d = 0.35; // ~25-40 km box around the point
  const poly = `POLYGON((${(lon - d).toFixed(3)} ${(lat - d).toFixed(3)},${(lon + d).toFixed(3)} ${(lat - d).toFixed(3)},${(lon + d).toFixed(3)} ${(lat + d).toFixed(3)},${(lon - d).toFixed(3)} ${(lat + d).toFixed(3)},${(lon - d).toFixed(3)} ${(lat - d).toFixed(3)}))`;
  const url = `https://api.obis.org/v3/checklist?size=500&geometry=${encodeURIComponent(poly)}`;
  try {
    const j = await cachedJSON(url, TTL.occurrences, { label: "OBIS" });
    const out: OccTaxon[] = [];
    for (const r of (j.results || []) as Array<Record<string, unknown>>) {
      if (!FISH_CLASS.test(String(r.class || ""))) continue;
      const sci = String(r.scientificName || r.species || "").trim();
      if (!sci) continue;
      const { group, emoji } = classify(r as { class?: string; order?: string; family?: string; scientificName?: string });
      out.push({ sci, common: commonFor(sci), group, emoji, records: Number(r.records) || 0 });
    }
    // de-dup by scientific name, keep highest record count
    const byName = new Map<string, OccTaxon>();
    for (const t of out) { const e = byName.get(t.sci); if (!e || t.records > e.records) byName.set(t.sci, t); }
    return [...byName.values()].sort((a, b) => b.records - a.records);
  } catch {
    return [];
  }
}
