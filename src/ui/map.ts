import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { FishingLocation } from "../types";
import { locationForPoint, HOME } from "../services/locations";
import { WATERWAYS } from "../waterways";
import { createFlowLayer, type TidalFlow } from "./flow";
import { createCurrentLayer } from "./current";
import { createLakeDepthLayer } from "./lakedepth";
import type { WaveComponent } from "../engine/seastate";
import type { TaggedAnimal, AnglerPresence, LandSighting } from "../types";
import type { TrailState } from "../store/trail";

export interface MapApi {
  setPin(loc: FishingLocation, recenter?: boolean): void;
  flyTo(lat: number, lon: number, zoom?: number): void;
  fitPredators(): void;
  setPresence(anglers: AnglerPresence[], selfId?: string | number): void;
  setSelfLocation(lat: number, lon: number, accuracy?: number): void;
  clearSelfLocation(): void;
  setTrail(trail: TrailState | null): void;
  fitTrail(): void;
  setFlow(flow: TidalFlow | null): void;
  setWaves(waves: WaveComponent[] | null): void;
  setWind(speedKmh: number | null, dirFromDeg: number | null): void;
  centerOnSelf(): boolean;
  cacheVisibleArea(onProgress?: (p: OfflineProgress) => void): Promise<{ ok: number; fail: number; total: number }>;
  resize(): void;
  destroy(): void;
}

// NASA GIBS ocean layers (free, no key, CORS *). MUR SST and PACE OCI
// chlorophyll are 1km daily fields published ~1 day behind, served as
// GoogleMapsCompatible_Level7 PNG tiles. WMTS REST order is {z}/{row}/{col}.
const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
function gibsDate(daysBack: number): string {
  // step back a couple of days so the most-recent tile is always published
  return new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
}
function gibsLayer(layerId: string, attribution: string): L.TileLayer {
  return L.tileLayer(
    `${GIBS}/${layerId}/default/{time}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`,
    { time: gibsDate(2), maxNativeZoom: 7, maxZoom: 19, opacity: 0.72, attribution } as unknown as L.TileLayerOptions,
  );
}

// NS government ArcGIS MapServers expose a working REST `export` operation but a
// BROKEN WMS endpoint (GetCapabilities returns an HTML error page), so Crown land
// is rendered as a per-tile ArcGIS dynamic export rather than L.tileLayer.wms.
// Display-only tiles (loaded as <img>), so cross-origin CORS does not apply.
const WM_ORIGIN = 20037508.342789244; // half the Web Mercator world extent, in metres
// `dynamicLayers` (a JSON renderer string) overrides the service's own washed-out
// symbology with our own vibrant colours; when omitted we just draw layer `layerId`.
function arcgisExportLayer(baseUrl: string, layerId: string, options: L.TileLayerOptions, dynamicLayers?: string): L.TileLayer {
  const layer = L.tileLayer("", options);
  (layer as unknown as { getTileUrl(c: L.Coords): string }).getTileUrl = (coords: L.Coords): string => {
    const span = (2 * WM_ORIGIN) / 2 ** coords.z; // tile edge length in metres at this zoom
    const xmin = -WM_ORIGIN + coords.x * span;
    const ymax = WM_ORIGIN - coords.y * span;
    const qs = new URLSearchParams({
      bbox: `${xmin},${ymax - span},${xmin + span},${ymax}`,
      bboxSR: "3857", imageSR: "3857", size: "256,256", dpi: "96",
      format: "png32", transparent: "true", f: "image",
    });
    if (dynamicLayers) qs.set("dynamicLayers", dynamicLayers);
    else qs.set("layers", `show:${layerId}`);
    return `${baseUrl}/export?${qs}`;
  };
  return layer;
}

// Vibrant override for Crown land: a punchy translucent green fill + bold outline,
// so it reads clearly over both the OSM and topographic basemaps (the service's
// native symbology washes out under the map).
const CROWN_RENDERER = JSON.stringify([{
  id: 0,
  source: { type: "mapLayer", mapLayerId: 0 },
  drawingInfo: { renderer: { type: "simple", symbol: {
    type: "esriSFS", style: "esriSFSSolid", color: [64, 224, 120, 125],
    outline: { type: "esriSLS", style: "esriSLSSolid", color: [22, 163, 74, 255], width: 1.5 },
  } } },
}]);

// Base-map tile templates, shared by the live layers and the offline cacher so
// the saved tile URLs match exactly what Leaflet requests (subdomain formula and
// all), giving real cache hits when there's no signal.
const OSM_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TOPO_URL = "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png";
const TRAILS_URL = "https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png";
// Must match public/sw.js, which serves these tiles cache-first when offline.
const TILE_CACHE = "nsag-tiles-v1";

export interface OfflineProgress { done: number; total: number; }

// slippy-map tile maths (lon/lat -> tile x/y at zoom z)
function lon2tx(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function lat2ty(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}
// Same subdomain rota Leaflet uses (abs(x+y) % subs), so a saved URL is byte-for-
// byte the one the live <img> later requests.
function tileUrl(template: string, z: number, x: number, y: number): string {
  const subs = ["a", "b", "c"];
  return template
    .replace("{s}", subs[Math.abs(x + y) % subs.length])
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

// Download every tile covering `bounds` from zoomFrom..zoomTo for the given XYZ
// layers into the offline cache. Capped + pooled so it stays a polite, bounded
// "save this view" action rather than a bulk scrape (OSM tile policy).
async function cacheArea(
  layers: { url: string; maxZoom: number }[],
  bounds: L.LatLngBounds,
  zoomFrom: number,
  zoomTo: number,
  onProgress?: (p: OfflineProgress) => void,
): Promise<{ ok: number; fail: number; total: number }> {
  const MAX_TILES = 1500;
  const urls: string[] = [];
  loop: for (let z = zoomFrom; z <= zoomTo; z++) {
    const x0 = lon2tx(bounds.getWest(), z);
    const x1 = lon2tx(bounds.getEast(), z);
    const y0 = lat2ty(bounds.getNorth(), z);
    const y1 = lat2ty(bounds.getSouth(), z);
    for (const layer of layers) {
      if (z > layer.maxZoom) continue;
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          urls.push(tileUrl(layer.url, z, x, y));
          if (urls.length >= MAX_TILES) break loop;
        }
    }
  }
  const cache = await caches.open(TILE_CACHE);
  const total = urls.length;
  let ok = 0, fail = 0, done = 0, i = 0;
  const worker = async (): Promise<void> => {
    while (i < urls.length) {
      const url = urls[i++];
      try {
        const res = await fetch(url, { mode: "no-cors" });
        await cache.put(url, res);
        ok++;
      } catch {
        fail++;
      }
      onProgress?.({ done: ++done, total });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { ok, fail, total };
}

// Remember which base + overlay layers the user had on, so they survive the
// map being torn down and remounted when a new location loads.
interface LayerPrefs { base: string; overlays: string[]; }
const LAYER_KEY = "mccormacks.maplayers.v9";
function loadLayerPrefs(): LayerPrefs | null {
  try {
    const raw = localStorage.getItem(LAYER_KEY);
    return raw ? (JSON.parse(raw) as LayerPrefs) : null;
  } catch {
    return null;
  }
}
function saveLayerPrefs(p: LayerPrefs): void {
  try { localStorage.setItem(LAYER_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

interface MountOpts {
  container: HTMLElement;
  locations: FishingLocation[];
  active: FishingLocation;
  predators?: TaggedAnimal[];
  landPredators?: LandSighting[];
  presence?: AnglerPresence[];
  selfId?: string | number;
  selfColor?: string;
  flow?: TidalFlow | null;
  waves?: WaveComponent[] | null;
  wind?: { speedKmh: number; dirFromDeg: number } | null;
  trail?: TrailState | null;
  onSelect: (loc: FishingLocation) => void;
  onRemoveSaved: (id: string) => void;
}

const homeIcon = L.divIcon({ className: "", html: `<div class="mk-home">★</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
const pinIcon = L.divIcon({ className: "", html: `<img src="/fishing.png" class="mk-pin"/>`, iconSize: [34, 34], iconAnchor: [17, 32] });
function savedIcon(name: string) {
  return L.divIcon({ className: "", html: `<div class="mk-saved" title="${name}">●</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}

function pesc(s: string): string {
  return (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function sightingAge(iso: string | null): string {
  if (!iso) return "date unknown";
  const d = new Date(`${iso}T12:00:00`).getTime();
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} mo ago`;
  return `${Math.round(days / 365)} yr ago`;
}

function sightingPopup(s: LandSighting): string {
  const img = s.photo ? `<img src="${pesc(s.photo)}" alt="" style="width:100%;height:96px;object-fit:cover;display:block"/>` : "";
  return `<div style="width:200px">${img}<div style="padding:7px 9px">
    <div style="font-weight:700;color:#06243a">${s.emoji} ${pesc(s.common)}</div>
    <div style="font-size:12px;color:#33495c">Seen ${pesc(s.observedOn ?? "date unknown")} (${sightingAge(s.observedOn)})</div>
    ${s.place ? `<div style="font-size:12px;color:#5b768c">${pesc(s.place)}</div>` : ""}
    ${s.obscured ? `<div style="font-size:11px;color:#b06a00">~ approximate location (obscured by iNaturalist)</div>` : ""}
    ${s.url ? `<a href="${pesc(s.url)}" target="_blank" rel="noopener" style="font-size:12px">iNaturalist &rarr;</a>` : ""}
  </div></div>`;
}

// Combined popup when several sightings overlap at one spot (so you can read all
// of them even though you could only hover one marker).
function sightingsPopup(items: LandSighting[]): string {
  const rows = items.slice(0, 12).map((s) => `<div style="padding:4px 0;border-top:1px solid #dce6ef">
    <span style="font-weight:600;color:#06243a">${s.emoji} ${pesc(s.common)}</span>
    <span style="color:#5b768c;font-size:12px"> ${sightingAge(s.observedOn)}</span>${s.obscured ? ` <span style="font-size:10px;color:#b06a00">~approx</span>` : ""}
    ${s.url ? ` <a href="${pesc(s.url)}" target="_blank" rel="noopener" style="font-size:11px">iNat &rarr;</a>` : ""}
  </div>`).join("");
  const more = items.length > 12 ? `<div style="font-size:11px;color:#5b768c;padding-top:4px">+ ${items.length - 12} more</div>` : "";
  return `<div style="width:216px;padding:7px 9px">
    <div style="font-weight:700;color:#06243a">${items.length} sightings near here</div>${rows}${more}</div>`;
}

function animalPopup(a: TaggedAnimal): string {
  const ping = a.lastPing ? new Date(a.lastPing).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" }) : "unknown";
  const bits = [a.gender, a.stage, a.length, a.weight].filter(Boolean).map((x) => pesc(String(x))).join(" · ");
  const img = a.image ? `<img src="${pesc(a.image)}" alt="" style="width:100%;height:110px;object-fit:cover;display:block"/>` : "";
  return `<div style="width:226px">${img}
    <div style="padding:8px 10px">
      <div style="font-weight:700;font-size:15px;color:#06243a">${a.emoji} ${pesc(a.name)}</div>
      <div style="font-style:italic;color:#5b768c;font-size:12px">${pesc(a.species)}${a.sci ? ` (${pesc(a.sci)})` : ""}</div>
      ${bits ? `<div style="font-size:12px;color:#33495c;margin-top:4px">${bits}</div>` : ""}
      ${a.tagLocation ? `<div style="font-size:12px;color:#5b768c">Tagged near ${pesc(a.tagLocation)}</div>` : ""}
      <div style="font-size:12px;color:#5b768c">Last ping: ${ping}</div>
      ${a.url ? `<a href="${pesc(a.url)}" target="_blank" rel="noopener" style="font-size:12px">OCEARCH profile &rarr;</a>` : ""}
    </div></div>`;
}

export function mountMap(opts: MountOpts): MapApi {
  const { container, locations, active, predators = [], landPredators = [], presence = [], selfId, selfColor = "#36c2ce", flow = null, waves = null, wind = null, trail = null, onSelect, onRemoveSaved } = opts;

  const map = L.map(container, { zoomControl: true }).setView([active.lat, active.lon], active.home ? 12 : active.kind === "fresh" ? 13 : 10);

  // --- base layers (added below according to saved prefs) ---
  const osm = L.tileLayer(OSM_URL, { maxZoom: 19, attribution: "© OpenStreetMap" });
  const topo = L.tileLayer(TOPO_URL, { maxZoom: 17, attribution: "© OpenTopoMap" });

  // --- depth / nautical overlays ---
  const seamarks = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
    maxZoom: 18, opacity: 1, attribution: "© OpenSeaMap",
  });
  const gebco = L.tileLayer.wms("https://wms.gebco.net/mapserv", {
    layers: "GEBCO_LATEST",
    format: "image/png",
    transparent: true,
    opacity: 0.55,
    attribution: "GEBCO bathymetry",
  } as L.WMSOptions);

  // --- inland / Crown land overlays (for camping + freshwater trips) ---
  // Crown land = the provincial (DNRR) parcels, much of it former/active forestry
  // land where folks backcountry camp. Rendered via the ArcGIS REST export op
  // (the service's WMS endpoint is broken); the service draws its own symbology.
  const crownLand = arcgisExportLayer(
    "https://nsgiwa.novascotia.ca/arcgis/rest/services/PLAN/PLANCrownLandsWM84V1/MapServer",
    "0",
    { opacity: 0.9, maxZoom: 19, attribution: "Crown land: GeoNOVA / NS DNRR" } as L.TileLayerOptions,
    CROWN_RENDERER,
  );
  // Marked/named hiking routes (free, transparent overlay from OSM relations).
  const hikingTrails = L.tileLayer(TRAILS_URL, {
    maxZoom: 18,
    opacity: 0.9,
    attribution: '© <a href="https://waymarkedtrails.org">Waymarked Trails</a> (CC-BY-SA)',
  });

  // --- ocean-colour / temperature overlays (NASA GIBS) ---
  // SST shows temperature breaks where bass/mackerel stack; chlorophyll shows
  // productive green water (plankton -> baitfish -> predators).
  const sst = gibsLayer("GHRSST_L4_MUR_Sea_Surface_Temperature", "SST: NASA GIBS / GHRSST MUR");
  const chlorophyll = gibsLayer("OCI_PACE_Chlorophyll_a", "Chlorophyll: NASA GIBS / PACE OCI");

  // --- animated tidal-flow overlay (modelled from the live tide phase) ---
  const flowLayer = createFlowLayer();
  flowLayer.setFlow(flow);
  flowLayer.setWaves(waves);
  flowLayer.setWind(wind?.speedKmh ?? null, wind?.dirFromDeg ?? null);

  // --- waterway links overlay ---
  const waterLayer = L.layerGroup();
  for (const w of WATERWAYS) {
    for (const seg of w.segments) {
      const line = L.polyline(seg as L.LatLngExpression[], {
        color: w.type === "boatable" ? "#5ad1ff" : "#7ce0a0",
        weight: 4,
        opacity: 0.85,
        dashArray: w.type === "boatable" ? undefined : "6 6",
      });
      line.bindTooltip(`${w.name} (${w.type})<br><span style="opacity:.8">${w.note}</span>`, { sticky: true });
      line.addTo(waterLayer);
    }
  }

  // --- named tagged animals (OCEARCH) overlay ---
  // Each marker is an individual NAMED animal at its most recent ping; click for
  // its profile (species, size, gender, where/when tagged, last ping).
  const predatorLayer = L.layerGroup();
  const predIcon = (emoji: string) => L.divIcon({ className: "", html: `<div class="mk-pred">${emoji}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  for (const a of predators) {
    const m = L.marker([a.lat, a.lon], { icon: predIcon(a.emoji), zIndexOffset: 600 });
    m.bindTooltip(`${a.emoji} <b>${a.name}</b> - ${a.species}`, { direction: "top" });
    m.bindPopup(animalPopup(a), { maxWidth: 250 });
    m.addTo(predatorLayer);
  }

  // --- land predators (recent iNaturalist sightings) overlay ---
  // Bears/coyotes/bobcat/lynx/fox SEEN near here (observations, not live tracking),
  // for camping awareness. Each marker is one sighting; click for date + photo.
  const landLayer = L.layerGroup();
  const landIcon = (emoji: string, obscured: boolean) =>
    L.divIcon({ className: "", html: `<div class="mk-land"${obscured ? ' style="opacity:.7"' : ""}>${emoji}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
  const landClusterIcon = (emoji: string, n: number) =>
    L.divIcon({ className: "", html: `<div class="mk-land mk-landcluster">${emoji}<span class="cl-count">${n}</span></div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  // Group sightings that sit within a marker's width of each other AT THE CURRENT
  // ZOOM into one marker, so overlapping pins don't bury each other - the combined
  // popup lists them all. Re-clustered on zoom (relative pixel spacing changes).
  function renderLand(): void {
    landLayer.clearLayers();
    if (!landPredators.length) return;
    const THRESH = 24; // px, ~ the icon size
    const groups: { x: number; y: number; items: LandSighting[] }[] = [];
    for (const s of landPredators) {
      const p = map.latLngToContainerPoint([s.lat, s.lon]);
      const g = groups.find((q) => Math.abs(q.x - p.x) < THRESH && Math.abs(q.y - p.y) < THRESH);
      if (g) g.items.push(s);
      else groups.push({ x: p.x, y: p.y, items: [s] });
    }
    for (const g of groups) {
      const rep = g.items[0]; // list is already newest-first
      if (g.items.length === 1) {
        const m = L.marker([rep.lat, rep.lon], { icon: landIcon(rep.emoji, rep.obscured), zIndexOffset: 550 });
        m.bindTooltip(`${rep.emoji} ${pesc(rep.common)} - ${sightingAge(rep.observedOn)}`, { direction: "top" });
        m.bindPopup(sightingPopup(rep), { maxWidth: 220 });
        m.addTo(landLayer);
      } else {
        const m = L.marker([rep.lat, rep.lon], { icon: landClusterIcon(rep.emoji, g.items.length), zIndexOffset: 560 });
        const kinds = [...new Set(g.items.map((i) => `${i.emoji} ${i.common}`))].join(", ");
        m.bindTooltip(`${g.items.length} sightings: ${pesc(kinds)}`, { direction: "top" });
        m.bindPopup(sightingsPopup(g.items), { maxWidth: 240 });
        m.addTo(landLayer);
      }
    }
  }
  renderLand();
  map.on("zoomend", renderLand);
  // --- guild members (live shared positions) overlay ---
  // One coloured hook per member who is currently sharing their location.
  const memberLayer = L.layerGroup();
  const memberMarkers = new Map<string | number, L.Marker>();
  const memberTrails = new Map<string | number, L.Polyline>(); // live "Indiana Jones" path per member
  const anglerIcon = (color: string) =>
    L.divIcon({ className: "", html: `<div class="mk-angler" style="--ac:${color}">🪝</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
  function renderPresence(anglers: AnglerPresence[], self?: string | number): void {
    const seen = new Set<string | number>();
    for (const a of anglers) {
      if (self != null && a.id === self) continue;
      seen.add(a.id);
      const seenAt = a.updatedAt ? new Date(a.updatedAt).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" }) : "now";
      const tip = `${pesc(a.displayName)} - sharing live (updated ${seenAt})`;
      let m = memberMarkers.get(a.id);
      if (m) {
        m.setLatLng([a.lat, a.lon]);
        m.setIcon(anglerIcon(a.color));
        m.setTooltipContent(tip);
      } else {
        m = L.marker([a.lat, a.lon], { icon: anglerIcon(a.color), zIndexOffset: 800 });
        m.bindTooltip(tip, { direction: "top" });
        m.addTo(memberLayer);
        memberMarkers.set(a.id, m);
      }
      // The member's shared Trail-mode path, in their colour (dashed, map-style).
      // Only drawn if they've shared their trail with US (one-way per-recipient).
      const allowed = self != null && (a.shareWith ?? []).some((id) => String(id) === String(self));
      const pts = allowed ? (a.trail ?? []).map((p) => [p.lat, p.lon] as [number, number]) : [];
      let line = memberTrails.get(a.id);
      if (pts.length > 1) {
        if (line) line.setLatLngs(pts).setStyle({ color: a.color });
        else {
          line = L.polyline(pts, { color: a.color, weight: 3, opacity: 0.85, dashArray: "2 7", lineCap: "round" }).addTo(memberLayer);
          line.bindTooltip(`${pesc(a.displayName)}'s trail`, { sticky: true });
          memberTrails.set(a.id, line);
        }
      } else if (line) {
        memberLayer.removeLayer(line);
        memberTrails.delete(a.id);
      }
    }
    for (const [id, m] of memberMarkers) {
      if (!seen.has(id)) { memberLayer.removeLayer(m); memberMarkers.delete(id); }
    }
    for (const [id, line] of memberTrails) {
      if (!seen.has(id)) { memberLayer.removeLayer(line); memberTrails.delete(id); }
    }
  }
  renderPresence(presence, selfId);

  // --- saltwater (tide-station) + freshwater (lake) spot markers, each its own
  //     toggleable layer so the angler can hide them and see the whole map ---
  const saltLayer = L.layerGroup();
  const freshLayer = L.layerGroup();

  // --- ocean current (real Open-Meteo data, sampled on a grid) ---
  const currentLayer = createCurrentLayer();

  // --- province-wide modelled lake-depth field (tiled; self-fetching water mask) ---
  if (!map.getPane("lakedepth")) {
    const p = map.createPane("lakedepth");
    p.style.zIndex = "240"; // above base/overlay tiles, below waterway lines + markers
    p.style.pointerEvents = "none";
  }
  const lakeDepthLayer = createLakeDepthLayer();

  // --- layers control with persisted on/off state ---
  const bases: Record<string, L.Layer> = { "Street (OSM)": osm, "Topographic": topo };
  const overlays: Record<string, L.Layer> = {
    "Guild members": memberLayer,
    "Tidal flow (animated)": flowLayer,
    "Ocean current (data)": currentLayer,
    "Sea temp (SST)": sst,
    "Chlorophyll": chlorophyll,
    "Saltwater spots": saltLayer,
    "Freshwater spots": freshLayer,
    "Lake depth": lakeDepthLayer,
    "Crown land": crownLand,
    "Hiking trails": hikingTrails,
    "Sea charts / depths": seamarks,
    "Bathymetry (GEBCO)": gebco,
    "Waterway links": waterLayer,
    "Ocean predators": predatorLayer,
    "Land predators (sightings)": landLayer,
  };

  const prefs = loadLayerPrefs();
  const baseName = prefs && bases[prefs.base] ? prefs.base : "Street (OSM)";
  bases[baseName].addTo(map);
  const onOverlays = prefs
    ? prefs.overlays
    : active.kind === "fresh"
    ? ["Guild members", "Crown land", "Hiking trails", "Land predators (sightings)", "Waterway links", "Freshwater spots", "Lake depth"]
    : ["Guild members", "Tidal flow (animated)", "Sea charts / depths", "Waterway links", "Ocean predators", "Saltwater spots", "Freshwater spots"];
  for (const name of Object.keys(overlays)) if (onOverlays.includes(name)) overlays[name].addTo(map);

  L.control.layers(bases, overlays, { collapsed: true }).addTo(map);

  const savePrefs = () => {
    const base = Object.keys(bases).find((n) => map.hasLayer(bases[n])) ?? "Street (OSM)";
    const on = Object.keys(overlays).filter((n) => map.hasLayer(overlays[n]));
    saveLayerPrefs({ base, overlays: on });
  };
  map.on("overlayadd overlayremove baselayerchange", savePrefs);

  // --- lake-depth legend (only while the modelled depth overlay is on) ---
  const modelLegend = new L.Control({ position: "bottomleft" });
  modelLegend.onAdd = () => {
    const d = L.DomUtil.create("div", "lakedepth-legend");
    d.style.cssText = "background:rgba(8,20,32,.78);color:#dbe7f0;padding:6px 9px;border-radius:8px;font:11px/1.35 system-ui,sans-serif;box-shadow:0 1px 6px rgba(0,0,0,.4);pointer-events:none";
    d.innerHTML =
      `<b>Lake depth</b> <span style="opacity:.65">(estimated)</span><br>` +
      `<span style="display:inline-block;width:64px;height:8px;border-radius:2px;background:linear-gradient(90deg,rgb(233,201,106),rgb(95,176,216),rgb(47,127,192),rgb(16,52,104));vertical-align:middle;margin-right:5px"></span>shallow &rarr; deep<br>` +
      `<span style="opacity:.65">rough: all NS lakes, from shoreline distance</span>`;
    return d;
  };
  const syncModelLegend = () => { if (map.hasLayer(lakeDepthLayer)) modelLegend.addTo(map); else modelLegend.remove(); };
  map.on("overlayadd overlayremove", syncModelLegend);
  syncModelLegend();

  // --- flow legend (only visible while the animated tidal-flow layer is on) ---
  const flowLegend = new L.Control({ position: "bottomleft" });
  flowLegend.onAdd = () => {
    const d = L.DomUtil.create("div", "flow-legend");
    d.style.cssText = "background:rgba(8,20,32,.78);color:#dbe7f0;padding:6px 9px;border-radius:8px;font:11px/1.35 system-ui,sans-serif;box-shadow:0 1px 6px rgba(0,0,0,.4);pointer-events:none";
    d.innerHTML =
      `<b>Tidal flow</b> <span style="opacity:.65">(modelled)</span><br>` +
      `<span style="display:inline-block;width:12px;height:3px;background:#5ce4f5;vertical-align:middle;margin-right:3px"></span>flooding` +
      `<span style="display:inline-block;width:12px;height:3px;background:#ffb066;vertical-align:middle;margin:0 3px 0 7px"></span>ebbing<br>` +
      `<span style="opacity:.65">longer streaks = stronger</span>`;
    return d;
  };
  const syncFlowLegend = () => { if (map.hasLayer(flowLayer)) flowLegend.addTo(map); else flowLegend.remove(); };
  map.on("overlayadd overlayremove", syncFlowLegend);
  syncFlowLegend();

  // --- ocean-current legend (only visible while the data layer is on) ---
  const currentLegend = new L.Control({ position: "bottomleft" });
  currentLegend.onAdd = () => {
    const d = L.DomUtil.create("div", "current-legend");
    d.style.cssText = "background:rgba(8,20,32,.78);color:#dbe7f0;padding:6px 9px;border-radius:8px;font:11px/1.35 system-ui,sans-serif;box-shadow:0 1px 6px rgba(0,0,0,.4);pointer-events:none";
    d.innerHTML =
      `<b>Ocean current</b> <span style="opacity:.65">(live data)</span><br>` +
      `<span style="display:inline-block;width:34px;height:0;border-top:2px solid;border-image:linear-gradient(90deg,#78c8dc,#7fd28c,#f0c846,#ff5a3c) 1;vertical-align:middle;margin-right:4px"></span>` +
      `calm &rarr; strong<br><span style="opacity:.65">streaks flow downstream</span>`;
    return d;
  };
  const syncCurrentLegend = () => { if (map.hasLayer(currentLayer)) currentLegend.addTo(map); else currentLegend.remove(); };
  map.on("overlayadd overlayremove", syncCurrentLegend);
  syncCurrentLegend();

  // SST + chlorophyll are coarse (~1km) ocean-scale fields - great zoomed out for
  // spotting breaks, but ugly low-res blocks zoomed in. Fade them out smoothly as
  // you zoom past ~z10.5 so close-up views stay clean.
  const fadeOceanOverlays = () => {
    const f = Math.max(0, Math.min(1, (12.5 - map.getZoom()) / 2));
    sst.setOpacity(0.72 * f);
    chlorophyll.setOpacity(0.72 * f);
  };
  map.on("zoomend overlayadd", fadeOceanOverlays);
  fadeOceanOverlays();

  // --- location markers (grouped into the salt / fresh toggle layers) ---
  for (const loc of locations) {
    if (loc.home || loc.saved) continue;
    if (loc.kind === "fresh") {
      const m = L.circleMarker([loc.lat, loc.lon], { radius: 6, color: "#0c1a2b", weight: 1, fillColor: "#7ce0a0", fillOpacity: 0.95 }).addTo(freshLayer);
      m.bindTooltip(`🟢 ${loc.name} (lake)`, { direction: "top" });
      m.on("click", () => onSelect(loc));
    } else {
      const m = L.circleMarker([loc.lat, loc.lon], { radius: 5, color: "#0c1a2b", weight: 1, fillColor: "#36c2ce", fillOpacity: 0.9 }).addTo(saltLayer);
      m.bindTooltip(loc.name, { direction: "top" });
      m.on("click", () => onSelect(loc));
    }
  }

  // saved favourites (with remove button in popup)
  for (const loc of locations) {
    if (!loc.saved) continue;
    const m = L.marker([loc.lat, loc.lon], { icon: savedIcon(loc.name) }).addTo(map);
    m.bindPopup(`<b>${loc.name}</b><br><span style="opacity:.8">${loc.area}</span><br><button class="rm-spot" data-id="${loc.id}">Remove spot</button>`);
    m.on("click", () => onSelect(loc));
    m.on("popupopen", (e) => {
      const btn = (e as L.PopupEvent).popup.getElement()?.querySelector(".rm-spot") as HTMLButtonElement | null;
      if (btn) btn.onclick = () => { map.closePopup(); onRemoveSaved(loc.id); };
    });
  }

  // home marker
  const home = L.marker([HOME.lat, HOME.lon], { icon: homeIcon, title: HOME.name }).addTo(map);
  home.bindTooltip(`★ ${HOME.name} (home)`, { direction: "top" });
  home.on("click", () => onSelect(HOME));

  // selected / pinned marker
  let pinMarker: L.Marker | null = null;
  function placePin(loc: FishingLocation, recenter = false) {
    if (pinMarker) pinMarker.setLatLng([loc.lat, loc.lon]);
    else pinMarker = L.marker([loc.lat, loc.lon], { icon: pinIcon, zIndexOffset: 1000 }).addTo(map);
    pinMarker.bindTooltip(loc.name, { direction: "top" });
    if (recenter) map.panTo([loc.lat, loc.lon]);
  }
  placePin(active, false);

  // click anywhere -> pin a spot (freshwater if it lands on a known lake, else salt)
  map.on("click", (e: L.LeafletMouseEvent) => {
    const loc = locationForPoint(e.latlng.lat, e.latlng.lng, locations);
    placePin(loc, false);
    onSelect(loc);
  });

  // --- "you are here" live self-location (for orientation; not the guild feed) ---
  // A small coloured dot follows the device's GPS, shown whether or not the user
  // is sharing with the guild, so you can orient yourself on the water.
  let selfDot: L.CircleMarker | null = null;
  let selfRing: L.Circle | null = null;
  let selfLatLng: L.LatLng | null = null;
  function setSelf(lat: number, lon: number, accuracy?: number) {
    selfLatLng = L.latLng(lat, lon);
    if (!selfDot) {
      selfDot = L.circleMarker(selfLatLng, {
        radius: 6,
        color: "#ffffff",
        weight: 2,
        fillColor: selfColor,
        fillOpacity: 1,
        pane: "markerPane",
      }).addTo(map);
      selfDot.bindTooltip("You (live position)", { direction: "top" });
    } else {
      selfDot.setLatLng(selfLatLng);
    }
    if (accuracy && accuracy > 0 && accuracy < 3000) {
      if (!selfRing) selfRing = L.circle(selfLatLng, { radius: accuracy, color: selfColor, weight: 1, opacity: 0.4, fillColor: selfColor, fillOpacity: 0.08 }).addTo(map);
      else { selfRing.setLatLng(selfLatLng); selfRing.setRadius(accuracy); }
    }
    updateCampLine();
  }
  function clearSelf() {
    selfDot?.remove(); selfRing?.remove();
    selfDot = null; selfRing = null; selfLatLng = null;
    updateCampLine();
  }

  // --- Trail / Camp mode overlay: breadcrumb track + base camp + POIs, plus a
  //     dashed "line back to camp" from your live position (so you're never lost) ---
  const campIcon = L.divIcon({ className: "", html: `<div class="mk-camp">⛺</div>`, iconSize: [30, 30], iconAnchor: [15, 28] });
  const poiIcon = (emoji: string) => L.divIcon({ className: "", html: `<div class="mk-poi">${emoji}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
  const trailLayer = L.featureGroup().addTo(map);
  let campLatLng: L.LatLng | null = null;
  let campLine: L.Polyline | null = null;
  function updateCampLine() {
    campLine?.remove();
    campLine = null;
    if (campLatLng && selfLatLng) {
      campLine = L.polyline([selfLatLng, campLatLng], { color: "#ffcf5c", weight: 2, opacity: 0.85, dashArray: "6 8", pane: "overlayPane" }).addTo(trailLayer);
    }
  }
  function renderTrail(t: TrailState | null) {
    trailLayer.clearLayers();
    campLine = null;
    campLatLng = t?.baseCamp ? L.latLng(t.baseCamp.lat, t.baseCamp.lon) : null;
    if (t && t.points.length > 1) {
      L.polyline(t.points.map((p) => [p.lat, p.lon] as [number, number]), { color: "#ff8a3d", weight: 3, opacity: 0.9 }).addTo(trailLayer);
    }
    for (const poi of t?.pois ?? []) {
      const m = L.marker([poi.lat, poi.lon], { icon: poiIcon(poi.emoji), zIndexOffset: 650 }).addTo(trailLayer);
      m.bindTooltip(`${poi.emoji} ${pesc(poi.name)}`, { direction: "top" });
    }
    if (t?.baseCamp && campLatLng) {
      const m = L.marker(campLatLng, { icon: campIcon, zIndexOffset: 700 }).addTo(trailLayer);
      m.bindTooltip(`⛺ ${pesc(t.baseCamp.name)} (base camp)`, { direction: "top" });
    }
    updateCampLine();
  }
  renderTrail(trail);

  setTimeout(() => map.invalidateSize(), 60);

  return {
    setPin: (loc, recenter = true) => placePin(loc, recenter),
    flyTo: (lat, lon, zoom = 12) => map.flyTo([lat, lon], zoom),
    fitPredators: () => {
      if (!predators.length) return;
      if (!map.hasLayer(predatorLayer)) predatorLayer.addTo(map);
      map.fitBounds(L.latLngBounds(predators.map((a) => [a.lat, a.lon] as [number, number])).pad(0.2));
    },
    setPresence: (anglers, self) => renderPresence(anglers, self),
    setSelfLocation: (lat, lon, accuracy) => setSelf(lat, lon, accuracy),
    clearSelfLocation: () => clearSelf(),
    setTrail: (t) => renderTrail(t),
    fitTrail: () => {
      const b = trailLayer.getBounds();
      if (b.isValid()) map.fitBounds(b.pad(0.25));
    },
    setFlow: (f) => flowLayer.setFlow(f),
    setWaves: (waveComps) => flowLayer.setWaves(waveComps),
    setWind: (s, d) => flowLayer.setWind(s, d),
    centerOnSelf: () => {
      if (!selfLatLng) return false;
      map.flyTo(selfLatLng, Math.max(map.getZoom(), 14));
      return true;
    },
    cacheVisibleArea: (onProgress) => {
      if (typeof caches === "undefined") return Promise.reject(new Error("offline caching not supported here"));
      const useTopo = map.hasLayer(topo);
      const layers = [{ url: useTopo ? TOPO_URL : OSM_URL, maxZoom: useTopo ? 17 : 19 }];
      if (map.hasLayer(hikingTrails)) layers.push({ url: TRAILS_URL, maxZoom: 18 });
      const z0 = Math.round(map.getZoom());
      return cacheArea(layers, map.getBounds(), z0, Math.min(z0 + 2, layers[0].maxZoom), onProgress);
    },
    resize: () => map.invalidateSize(),
    destroy: () => map.remove(),
  };
}
