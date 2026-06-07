import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { FishingLocation } from "../types";
import { locationForPoint, HOME } from "../services/locations";
import { WATERWAYS } from "../waterways";
import type { TaggedAnimal, AnglerPresence } from "../types";

export interface MapApi {
  setPin(loc: FishingLocation, recenter?: boolean): void;
  flyTo(lat: number, lon: number, zoom?: number): void;
  fitPredators(): void;
  setPresence(anglers: AnglerPresence[], selfId?: string | number): void;
  setSelfLocation(lat: number, lon: number, accuracy?: number): void;
  clearSelfLocation(): void;
  centerOnSelf(): boolean;
  resize(): void;
  destroy(): void;
}

// Remember which base + overlay layers the user had on, so they survive the
// map being torn down and remounted when a new location loads.
interface LayerPrefs { base: string; overlays: string[]; }
const LAYER_KEY = "mccormacks.maplayers.v3";
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
  presence?: AnglerPresence[];
  selfId?: string | number;
  selfColor?: string;
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
  const { container, locations, active, predators = [], presence = [], selfId, selfColor = "#36c2ce", onSelect, onRemoveSaved } = opts;

  const map = L.map(container, { zoomControl: true }).setView([active.lat, active.lon], active.home ? 12 : active.kind === "fresh" ? 13 : 10);

  // --- base layers (added below according to saved prefs) ---
  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
  const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, attribution: "© OpenTopoMap" });

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
  // --- guild members (live shared positions) overlay ---
  // One coloured hook per member who is currently sharing their location.
  const memberLayer = L.layerGroup();
  const memberMarkers = new Map<string | number, L.Marker>();
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
    }
    for (const [id, m] of memberMarkers) {
      if (!seen.has(id)) { memberLayer.removeLayer(m); memberMarkers.delete(id); }
    }
  }
  renderPresence(presence, selfId);

  // --- layers control with persisted on/off state ---
  const bases: Record<string, L.Layer> = { "Street (OSM)": osm, "Topographic": topo };
  const overlays: Record<string, L.Layer> = {
    "Guild members": memberLayer,
    "Sea charts / depths": seamarks,
    "Bathymetry (GEBCO)": gebco,
    "Waterway links": waterLayer,
    "Ocean predators": predatorLayer,
  };

  const prefs = loadLayerPrefs();
  const baseName = prefs && bases[prefs.base] ? prefs.base : "Street (OSM)";
  bases[baseName].addTo(map);
  const onOverlays = prefs
    ? prefs.overlays
    : active.kind === "fresh"
    ? ["Guild members", "Waterway links"]
    : ["Guild members", "Sea charts / depths", "Waterway links", "Ocean predators"];
  for (const name of Object.keys(overlays)) if (onOverlays.includes(name)) overlays[name].addTo(map);

  L.control.layers(bases, overlays, { collapsed: true }).addTo(map);

  const savePrefs = () => {
    const base = Object.keys(bases).find((n) => map.hasLayer(bases[n])) ?? "Street (OSM)";
    const on = Object.keys(overlays).filter((n) => map.hasLayer(overlays[n]));
    saveLayerPrefs({ base, overlays: on });
  };
  map.on("overlayadd overlayremove baselayerchange", savePrefs);

  // --- location markers ---
  for (const loc of locations) {
    if (loc.home || loc.saved) continue;
    if (loc.kind === "fresh") {
      const m = L.circleMarker([loc.lat, loc.lon], { radius: 6, color: "#0c1a2b", weight: 1, fillColor: "#7ce0a0", fillOpacity: 0.95 }).addTo(map);
      m.bindTooltip(`🟢 ${loc.name} (lake)`, { direction: "top" });
      m.on("click", () => onSelect(loc));
    } else {
      const m = L.circleMarker([loc.lat, loc.lon], { radius: 5, color: "#0c1a2b", weight: 1, fillColor: "#36c2ce", fillOpacity: 0.9 }).addTo(map);
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
  // A hook + dot that follows the device's GPS, shown whether or not the user is
  // sharing with the guild, so you can orient yourself on the water.
  const selfIcon = L.divIcon({ className: "", html: `<div class="mk-self" style="--ac:${selfColor}">🪝</div>`, iconSize: [30, 30], iconAnchor: [15, 28] });
  let selfMarker: L.Marker | null = null;
  let selfDot: L.CircleMarker | null = null;
  let selfRing: L.Circle | null = null;
  let selfLatLng: L.LatLng | null = null;
  function setSelf(lat: number, lon: number, accuracy?: number) {
    selfLatLng = L.latLng(lat, lon);
    if (!selfMarker) {
      selfMarker = L.marker(selfLatLng, { icon: selfIcon, zIndexOffset: 1500, interactive: true }).addTo(map);
      selfMarker.bindTooltip("You (live position)", { direction: "top" });
      selfDot = L.circleMarker(selfLatLng, { radius: 5, color: "#ffffff", weight: 2, fillColor: selfColor, fillOpacity: 1 }).addTo(map);
    } else {
      selfMarker.setLatLng(selfLatLng);
      selfDot?.setLatLng(selfLatLng);
    }
    if (accuracy && accuracy > 0 && accuracy < 3000) {
      if (!selfRing) selfRing = L.circle(selfLatLng, { radius: accuracy, color: selfColor, weight: 1, opacity: 0.4, fillColor: selfColor, fillOpacity: 0.08 }).addTo(map);
      else { selfRing.setLatLng(selfLatLng); selfRing.setRadius(accuracy); }
    }
  }
  function clearSelf() {
    selfMarker?.remove(); selfDot?.remove(); selfRing?.remove();
    selfMarker = null; selfDot = null; selfRing = null; selfLatLng = null;
  }

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
    centerOnSelf: () => {
      if (!selfLatLng) return false;
      map.flyTo(selfLatLng, Math.max(map.getZoom(), 14));
      return true;
    },
    resize: () => map.invalidateSize(),
    destroy: () => map.remove(),
  };
}
