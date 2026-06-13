import "../styles.css";
import { loadBundle } from "../data";
import { computeScores, overallScoreForDay, localDateKey } from "../engine/score";
import { computeDay, type DayContext } from "../engine/context";
import { tideVelocityAt } from "../engine/merge";
import { buildSeaState, type SeaState } from "../engine/seastate";
import { generateBriefing } from "../engine/briefing";
import { tideChartSVG, gaugeSVG, scoreColor } from "./charts";
import { loadLog, addRecord, deleteRecord, newId, seedSamples, exportJSON, importJSON } from "../store/log";
import { SPECIES, FRESH_SPECIES, weatherLabel, compassDir } from "../config";
import { loadNSLocations, getActiveLocation, setActiveLocation, locationForPoint, HOME } from "../services/locations";
import { loadSpots, addSpot, removeSpot } from "../store/spots";
import type { MapApi } from "./map";
import type { TidalFlow } from "./flow";
import { moonEmoji, moonInfo } from "../services/astronomy";
import { fmtTime, fmtRange, fmtWeekday, fmtDate } from "../util/format";
import type { Bundle, ScoredHour, CatchRecord, HourPoint, FishingLocation, GuildUser, AnglerPresence } from "../types";
import { fetchMe, logout as apiLogout, getCurrentUser, syncTripSave, syncTripDelete } from "../services/api";
import { connect as presenceConnect, disconnect as presenceDisconnect, onRoster, toggleSharing, loadSharePref } from "../services/presence";
import { renderLogin } from "./login";
import { openAdminPanel } from "./admin";

interface State {
  bundle: Bundle | null;
  scored: ScoredHour[];
  log: CatchRecord[];
  dayOffset: number; // 0=today
  tab: string;
  error: string | null;
  location: FishingLocation;
  locations: FishingLocation[]; // base list (home + lakes + stations)
  saved: FishingLocation[];
  user: GuildUser | null;
  presence: AnglerPresence[];
}

const state: State = {
  bundle: null, scored: [], log: loadLog(), dayOffset: 0, tab: "overview",
  error: null, location: getActiveLocation(), locations: [HOME], saved: loadSpots(),
  user: null, presence: [],
};

let mapApi: MapApi | null = null;

// combined list for the map + dropdown (saved favourites first)
function allLocations(): FishingLocation[] {
  return [...state.saved, ...state.locations];
}

const TABS = [
  ["overview", "Summary"],
  ["map", "Map / Location"],
  ["tide", "Tide & Hourly"],
  ["species", "Species"],
  ["hotspots", "Hotspots"],
  ["tactics", "Tactics"],
  ["log", "Catch Log"],
  ["analysis", "Analysis"],
  ["briefing", "Briefing"],
  ["handbook", "Handbook"],
];

const root = () => document.getElementById("app")!;

export async function start() {
  // Gate the whole app behind the guild login.
  root().innerHTML = `<div class="boot"><img class="boot-logo" src="/fishing.png" width="64" height="64"/><div class="boot-spinner"></div><div class="boot-text">Checking your guild membership...</div></div>`;
  const user = await fetchMe();
  if (!user) {
    renderLogin(root(), () => { start(); });
    return;
  }
  state.user = user;
  startPresence();
  startAutoRefresh();

  root().innerHTML = `<div class="boot"><img class="boot-logo" src="/fishing.png" width="64" height="64"/><div class="boot-spinner"></div><div class="boot-text">Reading the water...</div></div>`;
  try {
    state.bundle = await loadBundle(state.location, 7);
    state.scored = computeScores(state.bundle);
  } catch (e) {
    state.error = (e as Error).message;
  }
  render();
  // load the province-wide station list in the background, then refresh the picker + map
  loadNSLocations().then((locs) => {
    state.locations = locs;
    const picker = document.getElementById("locpicker");
    if (picker) {
      picker.outerHTML = locationPicker();
      attachPicker();
    }
    if (state.tab === "map") postRender(); // remount with full station set
  });
}

// Connect the live-presence socket once, and push roster updates to the map +
// the header "members online" badge whenever they change.
let presenceSubscribed = false;
function startPresence() {
  presenceConnect();
  if (presenceSubscribed) return;
  presenceSubscribed = true;
  onRoster((anglers) => {
    state.presence = anglers;
    mapApi?.setPresence(anglers, state.user?.id);
    const badge = document.getElementById("memberbadge");
    if (badge) badge.outerHTML = memberBadge();
  });
}

function doLogout() {
  presenceDisconnect();
  apiLogout();
  state.user = null;
  state.presence = [];
  state.bundle = null;
  teardownMap();
  renderLogin(root(), () => { start(); });
}

// Keep an open app current without hammering the APIs. Re-derive "now" and pull
// any newer model run when the clock crosses an hour, or when you return to the
// tab. loadBundle is cache-backed, so this hits the network ONLY if a TTL has
// elapsed (typically just the hourly weather refresh); otherwise it just advances
// the displayed hour. Skipped while typing (don't wipe a half-filled catch-log)
// or while the tab is hidden.
let autoRefreshSetup = false;
function startAutoRefresh() {
  if (autoRefreshSetup) return;
  autoRefreshSetup = true;
  let lastHour = new Date().getHours();
  setInterval(() => {
    if (document.hidden) return;
    const h = new Date().getHours();
    if (h !== lastHour) { lastHour = h; backgroundRefresh(); }
  }, 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.bundle && Date.now() - +state.bundle.fetchedAt > 10 * 60 * 1000) backgroundRefresh();
  });
}

async function backgroundRefresh() {
  if (!state.user || !state.bundle || state.error) return;
  const el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return; // don't interrupt data entry
  try {
    state.bundle = await loadBundle(state.location, 7); // cache-backed: network only if a TTL elapsed
    state.scored = computeScores(state.bundle);
    render();
  } catch { /* keep showing the last good data */ }
}

async function reloadForLocation() {
  state.error = null;
  state.dayOffset = 0;
  teardownMap();
  root().innerHTML = `<div class="boot"><img class="boot-logo" src="/fishing.png" width="64" height="64"/><div class="boot-spinner"></div><div class="boot-text">Reading the water at ${esc(state.location.name)}...</div></div>`;
  try {
    state.bundle = await loadBundle(state.location, 7);
    state.scored = computeScores(state.bundle);
  } catch (e) {
    state.error = (e as Error).message;
  }
  render();
}

function teardownMap() {
  if (mapApi) { mapApi.destroy(); mapApi = null; }
}

// Live "you are here" position for self-orientation on the map. Runs locally
// while the map tab is open (independent of guild sharing) so you can see the
// hook follow you whether or not you're broadcasting to the guild.
let selfWatchId: number | null = null;
let selfLoc: { lat: number; lon: number; acc: number } | null = null;
function startSelfWatch() {
  if (!("geolocation" in navigator) || selfWatchId != null) return;
  selfWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      selfLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
      mapApi?.setSelfLocation(selfLoc.lat, selfLoc.lon, selfLoc.acc);
    },
    () => { /* permission denied / unavailable - just no self marker */ },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}
function stopSelfWatch() {
  if (selfWatchId != null) { navigator.geolocation.clearWatch(selfWatchId); selfWatchId = null; }
}

// Mobile fullscreen for the map / tide chart / handbook. CSS-overlay based
// (works on iOS, where the native Fullscreen API doesn't apply to arbitrary
// elements, and gives true fullscreen in the installed PWA). The exit button is
// a child of the host so it stays visible on top of the map.
function setFullscreen(host: HTMLElement, on: boolean, onResize?: () => void) {
  host.classList.toggle("fs", on);
  document.documentElement.classList.toggle("fs-lock", on);
  let btn = host.querySelector<HTMLButtonElement>(":scope > .fs-close");
  if (on) {
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn primary fs-close";
      btn.textContent = "✕ Exit fullscreen";
      btn.addEventListener("click", (ev) => { ev.stopPropagation(); setFullscreen(host, false, onResize); });
      host.appendChild(btn);
    }
  } else {
    btn?.remove();
  }
  bumpResize(onResize);
}
function bumpResize(onResize?: () => void) {
  if (!onResize) return;
  requestAnimationFrame(() => requestAnimationFrame(onResize));
  setTimeout(onResize, 260);
}
function clearFullscreen() {
  document.querySelectorAll<HTMLElement>(".fs-host.fs").forEach((e) => {
    e.classList.remove("fs");
    e.querySelector<HTMLElement>(":scope > .fs-close")?.remove();
  });
  document.documentElement.classList.remove("fs-lock");
}

function useDeviceLocation() {
  if (!("geolocation" in navigator)) {
    toast("Geolocation not supported on this device");
    return;
  }
  toast("Requesting your location...");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      const loc = locationForPoint(latitude, longitude, allLocations(), "Live Location");
      selectLocation(loc);
    },
    (err) => toast(`Location failed: ${err.message}`),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

function selectedDate(): Date {
  const t = new Date();
  const d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  d.setDate(d.getDate() + state.dayOffset);
  return d;
}

function nowHour(b: Bundle): HourPoint {
  const now = Date.now();
  return b.hours.reduce((a, h) => (Math.abs(+h.time - now) < Math.abs(+a.time - now) ? h : a), b.hours[0]);
}

function esc(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function render() {
  teardownMap();
  clearFullscreen();
  const b = state.bundle;
  if (state.error || !b) {
    root().innerHTML = `<div class="card" style="margin-top:40px">
      <h2>Couldn't load live data</h2>
      <p class="muted">${esc(state.error ?? "Unknown error")}. Check your internet connection - the app pulls live tides (DFO/CHS) and weather (Open-Meteo).</p>
      <button class="btn primary" data-action="refresh">Retry</button></div>`;
    bind();
    return;
  }

  const ctx = computeDay(b, state.scored, state.log, selectedDate());
  root().innerHTML = `
    ${header(b)}
    ${condStrip(b)}
    ${b.warnings.length ? `<div class="warnbar">⚠ ${b.warnings.map(esc).join("<br>⚠ ")}</div>` : ""}
    ${dayBar(b)}
    ${tabBar()}
    <div id="tabbody">${renderTab(b, ctx)}</div>
  `;
  bind();
  scrollActiveTabIntoView();
  postRender();
}

// On phones the tab bar is a single swipeable row; after a re-render keep the
// active tab centred (horizontal scroll only - never moves the page).
function scrollActiveTabIntoView() {
  const active = document.querySelector(".tabs .tab.active") as HTMLElement | null;
  const strip = active?.parentElement;
  if (!active || !strip) return;
  if (strip.scrollWidth <= strip.clientWidth) return; // not overflowing (desktop/tablet)
  strip.scrollTo({ left: active.offsetLeft - strip.clientWidth / 2 + active.offsetWidth / 2, behavior: "smooth" });
}

// Indicative tidal-stream axis for the Halifax approaches: flood sets up-harbour
// to the NW, ebb runs back out to the SE. Used only to orient the animated flow.
const FLOOD_BEARING_DEG = 305;
const EBB_BEARING_DEG = 125;

// Turn the live tide curve into a flood/ebb flow for the animated map layer.
// Magnitude and the flood<->ebb reversal are real; the bearing is the axis above.
function tidalFlowNow(): TidalFlow | null {
  const tide = state.bundle?.tide;
  if (!tide || state.location.kind !== "salt") return null;
  const v = tideVelocityAt(tide, new Date()); // m/h signed (+rising = flood)
  if (v == null) return null;
  const range = tide.meanRange || 1;
  const speed01 = Math.max(0, Math.min(1, Math.abs(v) / (0.5 * range)));
  const slack = 0.06 * range;
  const phase: TidalFlow["phase"] = Math.abs(v) < slack ? "slack" : v > 0 ? "flood" : "ebb";
  return { speed01, phase, bearingDeg: phase === "ebb" ? EBB_BEARING_DEG : FLOOD_BEARING_DEG };
}

// Build the mathematical sea state for an hour from its real marine fields
// (Open-Meteo). Current is converted km/h -> m/s; depth is left deep-water (no
// free CORS point-depth source wired yet). Null when there is no wave data.
function seaStateForHour(h: HourPoint): SeaState | null {
  if (h.waveHeight == null && h.swellHeight == null && h.windWaveHeight == null) return null;
  return buildSeaState({
    waveHeight: h.waveHeight, wavePeriod: h.wavePeriod, waveDir: h.waveDir,
    swellHeight: h.swellHeight, swellPeriod: h.swellPeriod, swellDir: h.swellDir,
    windWaveHeight: h.windWaveHeight, windWavePeriod: h.windWavePeriod, windWaveDir: h.windWaveDir,
    currentSpeed: h.currentVelocity != null ? h.currentVelocity / 3.6 : null,
    currentDir: h.currentDir,
    depth: null,
  });
}
function seaStateNow(): SeaState | null {
  const b = state.bundle;
  if (!b || b.location.kind !== "salt") return null;
  return seaStateForHour(nowHour(b));
}
// Current wind (km/h + deg FROM) for the flow layer's wind-Ekman drift.
function windNow(): { speedKmh: number; dirFromDeg: number } | null {
  const b = state.bundle;
  if (!b || b.location.kind !== "salt") return null;
  const h = nowHour(b);
  if (h.windSpeed == null || h.windDir == null) return null;
  return { speedKmh: h.windSpeed, dirFromDeg: h.windDir };
}
const SEA_ICON: Record<SeaState["label"], string> = { calm: "🟢", moderate: "🟡", rough: "🟠", dangerous: "🔴" };

async function postRender() {
  if (state.tab !== "map") { stopSelfWatch(); return; }
  const el = document.getElementById("mapcanvas");
  if (!el) return;
  teardownMap();
  // lazy-load Leaflet + waterway data only when the map is actually opened
  const { mountMap } = await import("./map");
  if (state.tab !== "map" || !document.body.contains(el)) return; // user navigated away while loading
  mapApi = mountMap({
    container: el,
    locations: allLocations(),
    active: state.location,
    predators: state.bundle?.predators ?? [],
    presence: state.presence,
    selfId: state.user?.id,
    selfColor: state.user?.color,
    flow: tidalFlowNow(),
    waves: seaStateNow()?.components ?? null,
    wind: windNow(),
    onSelect: (loc) => selectLocation(loc),
    onRemoveSaved: (id) => {
      state.saved = removeSpot(id);
      toast("Spot removed");
      render();
    },
  });
  startSelfWatch();
  if (selfLoc) mapApi.setSelfLocation(selfLoc.lat, selfLoc.lon, selfLoc.acc);
}

// Placing the hook (clicking the map / a marker / device location) immediately
// becomes the active location, so the Species/Hotspots/Tactics tabs follow it.
function selectLocation(loc: FishingLocation) {
  state.location = loc;
  setActiveLocation(loc);
  toast(`Loading ${loc.name}...`);
  reloadForLocation();
}

function header(b: Bundle): string {
  const live = b.tide.live;
  return `<div class="app-header">
    <div class="brand">
      <img class="logo" src="/fishing.png" alt="logo" />
      <div>
        <h1>Nova Scotian Anglers Guild</h1>
        <div class="sub">${esc(b.location.name)} · ${b.location.lat.toFixed(3)}, ${b.location.lon.toFixed(3)} · tides: ${esc(b.tide.stationName)}</div>
      </div>
    </div>
    <div class="header-actions">
      ${locationPicker()}
      <span class="badge ${live ? "live" : "approx"}">${live ? "● LIVE tides" : "≈ approx tides"}</span>
      <span class="badge">updated ${fmtTime(b.fetchedAt)}</span>
      <button class="btn small" data-action="refresh">↻ Refresh</button>
    </div>
    ${accountBar()}
  </div>`;
}

function memberBadge(): string {
  const n = state.presence.length;
  return `<span id="memberbadge" class="badge ${n ? "live" : ""}" title="Guild members sharing their location right now">👥 ${n} sharing</span>`;
}

function accountBar(): string {
  const u = state.user ?? getCurrentUser();
  if (!u) return "";
  const sharing = loadSharePref();
  return `<div class="account-bar">
    <span class="acct-chip"><span class="acct-dot" style="background:${esc(u.color)}"></span>${esc(u.displayName)}${u.isAdmin ? ` <span class="badge">admin</span>` : ""}</span>
    ${memberBadge()}
    <button id="sharebtn" class="btn small ${sharing ? "primary" : ""}" data-action="toggle-share" title="Share your live location with the guild (this device only)">${sharing ? "📡 Sharing: ON" : "📡 Share location"}</button>
    ${u.isAdmin ? `<button class="btn small" data-action="open-admin">👥 Members</button>` : ""}
    <button class="btn small" data-action="logout">Sign out</button>
  </div>`;
}

function locationPicker(): string {
  const all = allLocations();
  const sel = (l: FishingLocation) => (l.id === state.location.id ? "selected" : "");
  const opt = (l: FishingLocation, label?: string) => `<option value="${esc(l.id)}" ${sel(l)}>${esc(label ?? l.name)}</option>`;
  const home = all.filter((l) => l.home);
  const saved = all.filter((l) => l.saved);
  const lakes = all.filter((l) => l.kind === "fresh" && !l.saved);
  const stations = all.filter((l) => l.kind === "salt" && !l.home && !l.saved);
  const pinned = all.filter((l) => l.id.startsWith("pin:"));
  let html = `<select id="locpicker" class="locpicker" title="Pick a fishing spot">`;
  html += `<optgroup label="Home">${home.map((l) => opt(l, "★ " + l.name)).join("")}</optgroup>`;
  if (pinned.length) html += `<optgroup label="Pinned">${pinned.map((l) => opt(l)).join("")}</optgroup>`;
  if (saved.length) html += `<optgroup label="My spots">${saved.map((l) => opt(l, "● " + l.name)).join("")}</optgroup>`;
  if (lakes.length) html += `<optgroup label="Lakes (freshwater)">${lakes.map((l) => opt(l, "🟢 " + l.name)).join("")}</optgroup>`;
  html += `<optgroup label="${stations.length ? stations.length + " tide stations" : "loading stations..."}">${stations.map((l) => opt(l)).join("")}</optgroup>`;
  html += `</select>`;
  return html;
}

function condStrip(b: Bundle): string {
  const h = nowHour(b);
  const w = weatherLabel(h.weatherCode);
  const mi = moonInfo(new Date());
  const fresh = b.location.kind === "fresh";
  const tideArrow = h.tideState === "rising" ? "↑ rising" : h.tideState === "falling" ? "↓ falling" : h.tideState.replace("-", " ");
  const sea = fresh ? null : seaStateForHour(h);
  return `<div class="cond-strip">
    ${cond("Now", `${w.icon} ${w.label}`, fmtTime(h.time))}
    ${cond("Air", `${Math.round(h.airTemp)}°C`, `feels ${Math.round(h.airTemp)}°`)}
    ${cond("Water", h.waterTemp != null ? `${h.waterTemp.toFixed(1)}°C` : "-", fresh ? "lake" : "sea surface")}
    ${cond("Wind", `${Math.round(h.windSpeed)} km/h`, `${compassDir(h.windDir)} · gust ${Math.round(h.windGust)}`)}
    ${cond("Pressure", `${Math.round(h.pressure)} hPa`, `${h.pressureTrend >= 0 ? "↑" : "↓"} ${Math.abs(h.pressureTrend).toFixed(1)}/3h`)}
    ${fresh
      ? cond("Type", "Freshwater", "no tide")
      : cond("Tide", h.tideHeight != null ? `${h.tideHeight.toFixed(2)} m` : "-", tideArrow)}
    ${fresh
      ? cond("Sun", fmtTime(b.astro.find((a) => a.date === localDateKey(h.time))?.sunrise ?? null), "sunrise")
      : sea
      ? cond("Sea", `${SEA_ICON[sea.label]} ${sea.label[0].toUpperCase() + sea.label.slice(1)} ${sea.score}`, h.waveHeight != null ? `${h.waveHeight.toFixed(1)} m · ${sea.tp.toFixed(0)}s` : "swell")
      : cond("Wave", h.waveHeight != null ? `${h.waveHeight.toFixed(1)} m` : "-", "swell")}
    ${cond("Moon", `${moonEmoji(mi.phase)} ${mi.illum}%`, mi.name)}
  </div>`;
}
function cond(k: string, v: string, x: string): string {
  return `<div class="cond"><div class="k">${k}</div><div class="v">${v}</div><div class="x">${x}</div></div>`;
}

function dayBar(b: Bundle): string {
  const chips = [];
  for (let i = 0; i < 7; i++) {
    const t = new Date();
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    d.setDate(d.getDate() + i);
    const sc = overallScoreForDay(state.scored, d);
    const col = scoreColor(sc);
    chips.push(`<div class="daychip ${i === state.dayOffset ? "active" : ""}" data-day="${i}">
      <div class="d1">${i === 0 ? "Today" : i === 1 ? "Tmrw" : fmtWeekday(d)}</div>
      <div class="d2">${d.getDate()}</div>
      <div class="dot" style="background:${col}"></div>
      <div class="d1">${sc.toFixed(1)}</div>
    </div>`);
  }
  void b;
  return `<div class="daybar">${chips.join("")}</div>`;
}

function tabBar(): string {
  return `<div class="tabs">${TABS.map(([k, l]) => `<button class="tab ${state.tab === k ? "active" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>`;
}

function renderTab(b: Bundle, ctx: DayContext): string {
  switch (state.tab) {
    case "overview": return tabOverview(b, ctx);
    case "map": return tabMap(b);
    case "tide": return tabTide(b, ctx);
    case "species": return tabSpecies(b, ctx);
    case "hotspots": return tabHotspots(ctx);
    case "tactics": return tabTactics(ctx);
    case "log": return tabLog();
    case "analysis": return tabAnalysis(ctx);
    case "briefing": return tabBriefing(b, ctx);
    case "handbook": return tabHandbook();
    default: return "";
  }
}

/* ---------- HANDBOOK (NS Anglers' Handbook PDF) ---------- */
const HANDBOOK_PDF = "https://www.novascotia.ca/sites/default/files/documents/1-2412/anglers-handbook-en.pdf";
function tabHandbook(): string {
  const viewer = `https://docs.google.com/viewer?embedded=true&url=${encodeURIComponent(HANDBOOK_PDF)}`;
  return `<div class="card">
    <div class="flex spread" style="gap:10px;flex-wrap:wrap">
      <h2 style="margin:0">NS Anglers' Handbook</h2>
      <span class="flex" style="flex-wrap:wrap">
        <a class="btn small" href="${HANDBOOK_PDF}" target="_blank" rel="noopener">↗ Open / download PDF</a>
        <button class="btn small mobile-only" data-action="handbook-fs">⛶ Fullscreen</button>
      </span>
    </div>
    <p class="note-sm">Official Nova Scotia Anglers' Handbook (open seasons, size & bag limits, licences, gear rules). This is the final word, it overrides the app's guidance whenever they differ.</p>
    <div id="handbook" class="fs-host pdfwrap mt">
      <iframe class="pdfframe" src="${viewer}" title="NS Anglers' Handbook" loading="lazy" referrerpolicy="no-referrer"></iframe>
    </div>
    <p class="note-sm">If the viewer doesn't load (or on some phones), tap <b>Open / download PDF</b> above to read it in your device's PDF reader.</p>
  </div>`;
}

/* ---------- MAP / LOCATION ---------- */
function tabMap(b: Bundle): string {
  const count = state.locations.length > 1 ? `${state.locations.length - 1} tide stations` : "loading stations...";
  return `
  <div class="card">
    <div class="flex spread" style="flex-wrap:wrap;gap:10px">
      <h2 style="margin:0">Pick your fishing spot</h2>
      <div class="flex" style="flex-wrap:wrap">
        <button class="btn small" data-action="geo">📍 Use live location</button>
        <button class="btn small" data-action="home-loc">★ McCormacks Beach</button>
      </div>
    </div>
    <p class="muted" style="font-size:13px;margin:8px 0">
      Click anywhere on the water to fish that exact spot (weather is taken at the point, tides from the nearest CHS gauge),
      tap a blue dot to use a tide station directly, or use your device location. Currently showing ${count}.
    </p>
    <div id="mapcanvas" class="mapcanvas fs-host"></div>
    <div class="map-toolbar mt">
      <span class="muted">Fishing: <b>${esc(b.location.name)}</b> <span class="muted">${esc(b.location.area)}</span></span>
      <span class="flex" style="flex-wrap:wrap">
        <button class="btn small" data-action="center-self">📍 Find me</button>
        <button class="btn small mobile-only" data-action="map-fs">⛶ Fullscreen</button>
        ${b.location.kind !== "fresh" && b.predators.length ? `<button class="btn small" data-action="fit-preds">🦈 Show ${b.predators.length} tagged animals</button>` : ""}
        <button id="map-save" class="btn small" data-action="save-spot" ${b.location.saved ? "disabled" : ""}>＋ Save this spot</button>
      </span>
    </div>
    ${b.location.kind !== "fresh" && b.predators.length ? `<p class="note-sm">🦈 ${b.predators.length} tagged animals (OCEARCH) are pinging in the wider region - they roam far offshore, so hit "Show tagged animals" to zoom out to them, or see the named list on the Species tab.</p>` : ""}
    <p class="note-sm">Click the map (or a marker) to fish that spot - the whole forecast, including the Species tab, reloads for wherever you drop the hook.</p>
    <div class="note-sm flex" style="flex-wrap:wrap;gap:14px">
      <span><span class="legend-dot" style="background:#36c2ce"></span> tide station</span>
      <span><span class="legend-dot" style="background:#7ce0a0"></span> lake (freshwater)</span>
      <span><span class="legend-dot" style="background:#ffcf5c"></span> saved spot</span>
      <span>★ McCormacks (home)</span>
      <span>🪝 selected</span>
      <span><span class="legend-dot" style="background:${esc(state.user?.color ?? "#36c2ce")}"></span> you (live)</span>
      <span>🪝 guild member (their colour)</span>
      <span style="color:#5ad1ff">━ boatable link</span>
      <span style="color:#7ce0a0">┄ fishable link</span>
    </div>
    <p class="note-sm">Your own <b>live position</b> dot follows you for orientation while the Map tab is open, whether or not you're sharing. Tap <b>📍 Find me</b> to recentre. Turn on <b>📡 Share location</b> (top of the page) to also let the guild see your position live. Use the layers control (top-right of the map) to toggle Saltwater spots, Freshwater spots, Guild members, Sea charts / depths, Bathymetry and Waterway links; turn off the spot layers to see the whole map.</p>
    ${savedSpotsList()}
  </div>`;
}

function savedSpotsList(): string {
  if (!state.saved.length) return "";
  return `<div class="mt"><h3 style="font-size:13px;color:var(--muted);text-transform:uppercase">My saved spots</h3>
    ${state.saved.map((s) => `<div class="flex spread" style="padding:6px 0;border-bottom:1px solid var(--line)">
      <span><b>${esc(s.name)}</b> <span class="muted" style="font-size:12px">${esc(s.area)}</span></span>
      <span class="flex">
        <button class="btn small" data-action="goto-spot" data-id="${esc(s.id)}">Load</button>
        <button class="btn small danger" data-action="remove-spot" data-id="${esc(s.id)}">Remove</button>
      </span>
    </div>`).join("")}
  </div>`;
}

/* ---------- OVERVIEW ---------- */
function tabOverview(b: Bundle, ctx: DayContext): string {
  const best = ctx.windows[0], second = ctx.windows[1];
  const astro = b.astro.find((a) => a.date === localDateKey(ctx.date));
  const topSp = ctx.species.slice(0, 3);
  // weekend window
  const weekend = weekendBest(b);
  return `
  <div class="grid cols-2">
    <div class="card">
      <h2>Fishing Summary - ${fmtDate(ctx.date)}</h2>
      <div class="gauge-wrap">
        ${gaugeSVG(ctx.overall)}
        <div class="score-meta">
          <div class="muted" style="font-size:13px">Overall conditions score</div>
          <div style="margin:6px 0"><span class="confidence conf-${ctx.confidence}">Confidence: ${ctx.confidence}</span></div>
          <div class="muted" style="font-size:13px">${astro ? `${moonEmoji(astro.moonPhase)} ${astro.moonName} · ${astro.moonIllum}%${b.location.kind === "fresh" ? "" : " · " + astro.tideStrength + " tides"}` : ""}</div>
          <div class="muted" style="font-size:13px">☀ ${fmtTime(astro?.sunrise ?? null)} → ${fmtTime(astro?.sunset ?? null)}</div>
        </div>
      </div>
      <div class="mt">
        ${best ? windowBlock("Best window", best, true) : `<div class="muted">No standout window - fish the tide changes.</div>`}
        ${second ? windowBlock("Second window", second, false) : ""}
      </div>
    </div>

    <div class="card">
      <h2>Top Targets Today</h2>
      ${topSp.map((sp) => `
        <div style="margin-bottom:12px">
          <div class="flex spread">
            <div><span style="font-size:18px">${sp.emoji}</span> <b>${sp.name}</b> ${legalChip(sp.legalFlag)}</div>
            <div class="muted">eat ${sp.eating}/10</div>
          </div>
          ${barRow("Encounter", sp.encounter)}
          ${barRow("Catch", sp.catch)}
          <div class="muted" style="font-size:12.5px">⏱ ${sp.bestWindow} · 📍 ${esc(sp.bestLocation)}</div>
        </div>`).join("")}
    </div>
  </div>

  <div class="card mt">
    <h2>7-Day Outlook</h2>
    <div class="hours">
      ${outlookRows(b)}
    </div>
    <div class="note-sm">🗓 Best for the weekend: ${weekend}</div>
  </div>`;
}

function weekendBest(b: Bundle): string {
  const t = new Date();
  // find upcoming Sat & Sun within the 7-day window
  let bestTxt = "-", bestScore = -1;
  for (let i = 0; i < 7; i++) {
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i);
    const dow = d.getDay();
    if (dow === 6 || dow === 0) {
      const ctx = computeDay(b, state.scored, state.log, d);
      if (ctx.windows[0] && ctx.windows[0].score > bestScore) {
        bestScore = ctx.windows[0].score;
        bestTxt = `${fmtWeekday(d)} ${fmtRange(ctx.windows[0].start, ctx.windows[0].end)} (score ${ctx.overall.toFixed(1)})`;
      }
    }
  }
  return bestTxt;
}

function outlookRows(b: Bundle): string {
  const t = new Date();
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i);
    const ctx = computeDay(b, state.scored, state.log, d);
    const sc = ctx.overall;
    const col = scoreColor(sc);
    const win = ctx.windows[0];
    rows.push(`<div class="hourrow" data-day="${i}" style="cursor:pointer">
      <div class="ht">${i === 0 ? "Today" : fmtWeekday(d) + " " + d.getDate()}</div>
      <div class="hs" style="background:${col}">${sc.toFixed(1)}</div>
      <div class="hreason">${win ? `Best ${fmtRange(win.start, win.end)} - ${esc(win.reason)}` : "Fish the tide changes"}</div>
    </div>`);
  }
  return rows.join("");
}

function windowBlock(label: string, w: { start: Date; end: Date; peak: Date; score: number; reason: string }, best: boolean): string {
  return `<div class="window ${best ? "best" : ""}">
    <div class="flex spread"><span class="ws">${label}</span><span class="ws">${w.score.toFixed(1)}/10</span></div>
    <div class="wt">${fmtRange(w.start, w.end)}</div>
    <div class="wr">Peak ~${fmtTime(w.peak)} · ${esc(w.reason)}</div>
  </div>`;
}

function barRow(lbl: string, pct: number): string {
  return `<div class="barrow"><div class="lbl">${lbl}</div><div class="bar"><span style="width:${Math.min(100, pct)}%"></span></div><div class="pct">${pct}%</div></div>`;
}

function legalChip(f: string): string {
  const map: Record<string, [string, string]> = { keep: ["lf-keep", "KEEP*"], release: ["lf-release", "RELEASE"], check: ["lf-check", "VERIFY"] };
  const [cls, txt] = map[f] ?? map.check;
  return `<span class="legalflag ${cls}">${txt}</span>`;
}

/* ---------- TIDE & HOURLY ---------- */
function tabTide(b: Bundle, ctx: DayContext): string {
  if (b.location.kind === "fresh") {
    return `
    <div class="card">
      <h2>Tides - ${fmtDate(ctx.date)}</h2>
      <p class="muted">${esc(b.location.name)} is a freshwater lake, so there are no tides. The forecast is driven by
      dawn/dusk light, wind, barometric pressure and the moon's solunar periods instead.</p>
    </div>
    <div class="card mt">
      <h2>Hourly Breakdown</h2>
      <div class="hours">${hourlyRows(b, ctx)}</div>
    </div>`;
  }
  const exes = b.tide.extremes.filter((e) => localDateKey(e.time) === localDateKey(ctx.date));
  return `
  <div class="card">
    <div class="flex spread" style="gap:10px">
      <h2 style="margin:0">Tide Curve - ${fmtDate(ctx.date)} <span class="muted" style="text-transform:none">(${b.tide.stationName})</span></h2>
      <button class="btn small mobile-only" data-action="tide-fs">⛶ Fullscreen</button>
    </div>
    <div id="tidechart" class="fs-host tidechart mt">${tideChartSVG(b, ctx.date, ctx.windows)}</div>
    <div class="note-sm flex" style="flex-wrap:wrap;gap:14px">
      <span>🟦 High/Low markers</span><span>🟩 shaded = best fishing windows</span><span>🟡 now</span>
      <span>Mean range ≈ ${b.tide.meanRange.toFixed(1)} m</span>
    </div>
    <div class="mt flex" style="flex-wrap:wrap;gap:10px">
      ${exes.map((e) => `<span class="badge ${e.type === "high" ? "live" : ""}">${e.type === "high" ? "▲ High" : "▼ Low"} ${fmtTime(e.time)} · ${e.height.toFixed(2)} m</span>`).join("")}
    </div>
  </div>

  <div class="card mt">
    <h2>Hourly Breakdown</h2>
    <div class="hours">${hourlyRows(b, ctx)}</div>
  </div>`;
}

function hourlyRows(b: Bundle, ctx: DayContext): string {
  const key = localDateKey(ctx.date);
  const hours = b.hours.filter((h) => localDateKey(h.time) === key);
  return hours.map((h) => {
    const sh = ctx.scoredDay.find((s) => +s.time === +h.time);
    const sc = sh?.score ?? 0;
    const col = scoreColor(sc);
    const w = weatherLabel(h.weatherCode);
    const tide = h.tideState === "rising" ? "↑" : h.tideState === "falling" ? "↓" : "≈";
    const tideBit = b.location.kind === "fresh" ? "" : ` · ${tide}${h.tideHeight != null ? h.tideHeight.toFixed(1) : "-"}m${h.waveHeight != null ? " · 🌊" + h.waveHeight.toFixed(1) + "m" : ""}`;
    const bits = `${w.icon} ${Math.round(h.airTemp)}° · 💨${Math.round(h.windSpeed)} ${compassDir(h.windDir)}${tideBit}`;
    return `<div class="hourrow">
      <div class="ht">${fmtTime(h.time)}</div>
      <div class="hs" style="background:${col}">${sc.toFixed(1)}</div>
      <div>
        <div class="hbits">${bits}</div>
        ${sh?.reasons.length ? `<div class="hreason">${esc(sh.reasons.join(" · "))}</div>` : ""}
      </div>
    </div>`;
  }).join("");
}

/* ---------- SPECIES ---------- */
function tabSpecies(b: Bundle, ctx: DayContext): string {
  const fresh = b.location.kind === "fresh";
  const brackish = fresh && b.location.brackish;
  const badge = brackish
    ? `<span class="legalflag lf-check">🟢🌊 Brackish / estuary</span>`
    : fresh
    ? `<span class="legalflag lf-keep">🟢 Freshwater fishery</span>`
    : `<span class="legalflag lf-check">🌊 Saltwater fishery</span>`;
  return `<div class="card"><h2>Species Forecast - ${fmtDate(ctx.date)} ${badge}</h2>
    <p class="muted" style="font-size:13px;margin:0 0 10px">${brackish
      ? `Brackish water at ${esc(b.location.name)}: freshwater species plus the sea fish that run into the estuary (shown at reduced odds). NS inland fishing needs a provincial licence.`
      : fresh
      ? `Freshwater species for ${esc(b.location.name)} (lake/river) - no open-sea species here. NS inland fishing needs a provincial licence.`
      : `Saltwater species for ${esc(b.location.name)}.`}</p>
    <div class="species-grid">
      ${ctx.species.map(spCard).join("")}
    </div>
    <div class="note-sm">* "KEEP" still requires you to verify current DFO Maritimes / NS Anglers' Handbook seasons, size/slot limits and licences. When in doubt, release.</div>
  </div>
  ${fresh ? stockingPanel(b) : predatorPanel(b)}`;
}

function stockingPanel(b: Bundle): string {
  const st = b.stocking;
  const fmtD = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" }) : "-");
  const links = `<a href="https://data.novascotia.ca/d/8e4a-m6fw" target="_blank" rel="noopener">Source: NS open data →</a> · <a href="https://novascotia.ca/fish/sportfishing/hatchery-stocking/stocking-update/" target="_blank" rel="noopener">Weekly stocking update →</a>`;
  if (!st || !st.bySpecies.length) {
    return `<div class="card mt">
      <h2>🐟 Provincial Stocking</h2>
      <p class="muted" style="font-size:13px;margin:0 0 8px">No NS hatchery stocking records found within ~3.5 km of ${esc(b.location.name)} (since 2018). Plenty of NS lakes hold wild trout, bass and pickerel without being stocked.</p>
      <div class="note-sm">${links}</div>
    </div>`;
  }
  return `<div class="card mt">
    <h2>🐟 Provincial Stocking ${st.recentlyStocked ? `<span class="legalflag lf-keep">recently stocked</span>` : ""}</h2>
    <p class="muted" style="font-size:13px;margin:0 0 10px">Nearest match in the NS Fish Hatchery Stocking Records: <b>${esc(st.waterbody)}</b> · latest release <b>${fmtD(st.latest)}</b>. Stocked species are boosted in the forecast above. NS inland fishing needs a provincial licence, verify seasons & limits.</p>
    <div class="note-sm flex" style="flex-wrap:wrap;gap:8px;margin-bottom:6px">
      ${st.bySpecies.map((s) => `<span class="badge live">${esc(s.species)} · ${s.total.toLocaleString()} since 2018 · latest ${fmtD(s.latest)}</span>`).join("")}
    </div>
    <div class="table-scroll"><table class="logtable">
      <thead><tr><th>Date</th><th>Species</th><th>Number released</th></tr></thead>
      <tbody>${st.records.slice(0, 10).map((r) => `<tr><td>${fmtD(r.date)}</td><td>${esc(r.species)}</td><td>${r.number.toLocaleString()}</td></tr>`).join("")}</tbody>
    </table></div>
    <div class="note-sm">${links}</div>
  </div>`;
}

function predatorPanel(b: Bundle): string {
  const animals = b.predators;
  const km = Math.round(6 * 111);
  const fmtPing = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" }) : "unknown");
  // species summary
  const bySp = new Map<string, number>();
  for (const a of animals) bySp.set(a.species, (bySp.get(a.species) ?? 0) + 1);
  const summary = [...bySp.entries()].sort((a, c) => c[1] - a[1]).map(([s, n]) => `${s} (${n})`).join(", ");
  return `<div class="card mt">
    <h2>🦈 Tagged Sharks &amp; Predators - tracked near here</h2>
    <p class="muted" style="font-size:13px;margin:0 0 10px">Named, satellite-tagged animals within ~${km} km of ${esc(b.location.name)}, live from <b>OCEARCH</b> (most recent ping per animal).
    Toggle <b>Ocean predators</b> on the map to see them, and click any animal for its profile.</p>
    ${animals.length === 0 ? `<p class="muted">No tagged animals currently pinging near here. (White sharks light up NS waters mostly Aug-Oct.)</p>` : `
    <p class="note-sm" style="margin-top:0">${esc(summary)}</p>
    <div class="table-scroll"><table class="logtable">
      <thead><tr><th></th><th>Name</th><th>Species</th><th>Size</th><th>Last ping</th><th>Tagged near</th></tr></thead>
      <tbody>
        ${animals.slice(0, 18).map((a) => `<tr>
          <td>${a.emoji}</td>
          <td><b>${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a>` : esc(a.name)}</b></td>
          <td>${esc(a.species)}</td>
          <td>${esc([a.length, a.weight].filter(Boolean).join(", ") || "-")}</td>
          <td>${fmtPing(a.lastPing)}</td>
          <td>${esc(a.tagLocation ?? "-")}</td>
        </tr>`).join("")}
      </tbody>
    </table></div>
    ${animals.length > 18 ? `<div class="note-sm">+ ${animals.length - 18} more on the map.</div>` : ""}
    <div class="note-sm">⚠ Big predators (esp. white sharks) frequent NS waters in late summer/fall - be shark-smart around seals, baitfish and dusk.</div>`}
  </div>`;
}

function spCard(sp: import("../types").SpeciesForecast): string {
  return `<div class="sp">
    <div class="sp-head">
      <span class="sp-emoji">${sp.emoji}</span>
      <span class="sp-name">${sp.name}${sp.stocked ? ` <span class="legalflag lf-keep" title="Recently stocked by the NS hatchery program">stocked</span>` : ""}</span>
      <span class="sp-eat">🍽 ${sp.eating}/10</span>
    </div>
    ${barRow("Encounter", sp.encounter)}
    ${barRow("Catch", sp.catch)}
    <div class="kv">
      <div class="k">Best time</div><div>${sp.bestWindow}</div>
      <div class="k">Location</div><div>${esc(sp.bestLocation)}</div>
      <div class="k">Rig</div><div>${esc(sp.rig)}</div>
      <div class="k">Bait/Lure</div><div>${esc(sp.bait)}</div>
      <div class="k">Size</div><div>${esc(sp.size)}</div>
      <div class="k">Keep?</div><div>${legalChip(sp.legalFlag)} <span class="muted" style="font-size:12px">${esc(sp.legal)}</span></div>
    </div>
    <div class="note-sm">${esc(sp.notes)}</div>
  </div>`;
}

/* ---------- HOTSPOTS ---------- */
function tabHotspots(ctx: DayContext): string {
  return `<div class="card"><h2>Hotspot Ranking - ${fmtDate(ctx.date)}</h2>
    ${ctx.hotspots.map((s) => `
      <div class="spot">
        <div class="rk">#${s.rank}</div>
        <div>
          <div class="flex spread"><b>${s.name}</b></div>
          <div class="tags">${s.bestFor.map((x) => `<span class="tag">${x}</span>`).join("")}</div>
          <div class="why">${esc(s.why)}</div>
        </div>
        <div class="sc" style="color:${scoreColor(s.score)}">${s.score}</div>
      </div>`).join("")}
  </div>`;
}

/* ---------- TACTICS ---------- */
function tabTactics(ctx: DayContext): string {
  const t = ctx.tactics;
  return `
  <div class="grid cols-2">
    <div class="card">
      <h2>Recommended Setup</h2>
      <div class="kvbig">
        <div class="k">Setup</div><div>${esc(t.setup)}</div>
        <div class="k">Lure colours</div><div>${esc(t.lureColors)}</div>
        <div class="k">Bait</div><div>${esc(t.bait)}</div>
        <div class="k">Retrieval</div><div>${esc(t.retrieval)}</div>
        <div class="k">Arrive</div><div>${esc(t.arrival)}</div>
        <div class="k">Depart</div><div>${esc(t.departure)}</div>
        <div class="k">Start at</div><div>${esc(t.startSpot)}</div>
        <div class="k">Move to</div><div>${esc(t.moveSpot)}</div>
      </div>
    </div>
    <div class="card">
      <h2>Shore-Fishing Tips</h2>
      <ul class="tac-list">${t.shoreTips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    </div>
  </div>
  <div class="card mt">
    <h2>Action Plan - Putting Fish on the Table</h2>
    <ol class="plan">${t.actionPlan.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
  </div>`;
}

/* ---------- LOG ---------- */
function tabLog(): string {
  const speciesOpts =
    `<optgroup label="Saltwater">${SPECIES.map((s) => `<option>${s.name}</option>`).join("")}</optgroup>` +
    `<optgroup label="Freshwater">${FRESH_SPECIES.map((s) => `<option>${s.name}</option>`).join("")}</optgroup>` +
    `<option>Other</option>`;
  const today = localDateKey(new Date());
  const tideOpts = ["rising", "falling", "high-slack", "low-slack"].map((x) => `<option>${x}</option>`).join("");
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"].map((x) => `<option>${x}</option>`).join("");
  return `
  <div class="card">
    <h2>Log a Trip</h2>
    <form id="logform">
      <div class="form-grid">
        <label class="field">Date<input name="date" type="date" value="${today}" required></label>
        <label class="field">Start<input name="start" type="time" value="06:00"></label>
        <label class="field">End<input name="end" type="time" value="08:00"></label>
        <label class="field">Species<select name="species">${speciesOpts}</select></label>
        <label class="field">Count<input name="count" type="number" min="0" value="0"></label>
        <label class="field">Approx size<input name="size" placeholder="e.g. 30-35 cm"></label>
        <label class="field">Tide stage<select name="tideStage">${tideOpts}</select></label>
        <label class="field">Tide height<input name="tideHeight" placeholder="e.g. 1.2 m"></label>
        <label class="field">Wind dir<select name="windDir">${dirs}</select></label>
        <label class="field">Wind speed<input name="windSpeed" placeholder="e.g. 12 km/h"></label>
        <label class="field">Weather<input name="weather" placeholder="e.g. Overcast"></label>
        <label class="field">Water<input name="water" placeholder="e.g. Light chop"></label>
        <label class="field">Kept<select name="kept"><option value="kept">kept</option><option value="released">released</option><option value="mixed">mixed</option></select></label>
        <label class="field">Gear<input name="gear" placeholder="e.g. Sabiki + float"></label>
        <label class="field wide">Notes<textarea name="notes" placeholder="What worked, where the fish were, bait, behaviour…"></textarea></label>
      </div>
      <div class="mt flex">
        <button class="btn primary" type="submit">＋ Add trip</button>
        <span class="muted" style="font-size:12px">Conditions snapshot (moon, water temp) is auto-attached from the forecast for that date.</span>
      </div>
    </form>
  </div>

  <div class="card mt">
    <div class="flex spread">
      <h2 style="margin:0">Catch Log (${state.log.length})</h2>
      <div class="flex">
        ${state.log.length === 0 ? `<button class="btn small" data-action="seed">Load sample trips</button>` : ""}
        <button class="btn small" data-action="export">⬇ Export JSON</button>
        <button class="btn small" data-action="import">⬆ Import</button>
        ${state.log.length ? `<button class="btn small danger" data-action="clearlog">Clear all</button>` : ""}
      </div>
    </div>
    ${state.log.length ? logTable() : `<p class="muted mt">No trips logged yet. Add one above, or load sample trips to see the analysis in action.</p>`}
  </div>`;
}

function logTable(): string {
  return `<div class="table-scroll mt"><table class="logtable">
    <thead><tr>
      <th>Date</th><th>Time</th><th>Species</th><th>#</th><th>Size</th><th>Tide</th><th>Wind</th><th>Weather</th><th>Kept</th><th>Gear</th><th>Notes</th><th></th>
    </tr></thead>
    <tbody>
      ${state.log.map((r) => `<tr>
        <td>${esc(r.date)}</td>
        <td>${esc(r.start)}-${esc(r.end)}</td>
        <td>${esc(r.species)}</td>
        <td>${r.count}</td>
        <td>${esc(r.size)}</td>
        <td>${esc(r.tideStage)} ${esc(r.tideHeight)}</td>
        <td>${esc(r.windDir)} ${esc(r.windSpeed)}</td>
        <td>${esc(r.weather)}</td>
        <td>${esc(r.kept)}</td>
        <td>${esc(r.gear)}</td>
        <td class="notes">${esc(r.notes)}</td>
        <td><button class="btn small danger" data-action="del" data-id="${r.id}">✕</button></td>
      </tr>`).join("")}
    </tbody>
  </table></div>`;
}

/* ---------- ANALYSIS ---------- */
function tabAnalysis(ctx: DayContext): string {
  const a = ctx.analysis;
  return `
  <div class="card">
    <h2>Log Analysis & Predictive Model</h2>
    <div class="stats">
      <div class="stat"><b>${a.trips}</b><span>trips</span></div>
      <div class="stat"><b>${a.totalFish}</b><span>fish</span></div>
      <div class="stat"><b>${a.fishPerTrip}</b><span>fish / trip</span></div>
      <div class="stat"><b>${a.fishPerHour}</b><span>fish / hour</span></div>
      <div class="stat"><b>${a.topSpecies[0]?.name?.split(" ").pop() ?? "-"}</b><span>top species</span></div>
    </div>
  </div>

  <div class="grid cols-2 mt">
    <div class="card">
      <h2>Patterns Detected</h2>
      ${a.insights.length ? a.insights.map((i) => `
        <div style="margin-bottom:10px">
          <div class="flex spread"><b>${i.dimension}: ${esc(i.best)}</b><span class="muted">${Math.round(i.strength * 100)}% signal</span></div>
          <div class="bar"><span style="width:${Math.round(i.strength * 100)}%"></span></div>
          <div class="muted" style="font-size:12.5px;margin-top:4px">${esc(i.detail)}</div>
        </div>`).join("") : `<p class="muted">Log a few trips (or load samples in the Catch Log tab) to surface tide/wind/moon/time patterns.</p>`}
    </div>
    <div class="card">
      <h2>Trends & Predictions</h2>
      <h3 style="font-size:13px;color:var(--muted);text-transform:uppercase">Recent trends</h3>
      <ul class="tac-list">${a.trends.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      <h3 style="font-size:13px;color:var(--muted);text-transform:uppercase" class="mt">Updated predictions</h3>
      <ul class="tac-list">${a.predictions.length ? a.predictions.map((t) => `<li>${esc(t)}</li>`).join("") : "<li class='muted'>Need more data.</li>"}</ul>
      ${a.topSpecies.length ? `<h3 style="font-size:13px;color:var(--muted);text-transform:uppercase" class="mt">Top species (logged)</h3>
        ${a.topSpecies.map((s) => barRow(s.name, Math.round((s.count / a.totalFish) * 100))).join("")}` : ""}
    </div>
  </div>`;
}

/* ---------- BRIEFING ---------- */
function tabBriefing(b: Bundle, ctx: DayContext): string {
  const text = generateBriefing(b, ctx);
  return `<div class="card">
    <div class="flex spread"><h2 style="margin:0">Full Briefing - ${fmtDate(ctx.date)}</h2>
      <button class="btn small" data-action="copy-briefing">📋 Copy</button></div>
    <pre class="briefing" id="briefing-text">${esc(text)}</pre>
  </div>`;
}

/* ---------- EVENTS ---------- */
function bind() {
  root().querySelectorAll<HTMLElement>("[data-tab]").forEach((el) =>
    el.addEventListener("click", () => { state.tab = el.dataset.tab!; render(); })
  );
  root().querySelectorAll<HTMLElement>("[data-day]").forEach((el) =>
    el.addEventListener("click", () => { state.dayOffset = Number(el.dataset.day); render(); })
  );
  root().querySelectorAll<HTMLElement>("[data-action]").forEach((el) =>
    el.addEventListener("click", (e) => handleAction(el.dataset.action!, el, e))
  );
  const form = document.getElementById("logform") as HTMLFormElement | null;
  if (form) form.addEventListener("submit", onLogSubmit);
  attachPicker();
}

function attachPicker() {
  const picker = document.getElementById("locpicker") as HTMLSelectElement | null;
  if (!picker) return;
  picker.onchange = () => {
    const loc = allLocations().find((l) => l.id === picker.value);
    if (!loc) return;
    state.location = loc;
    setActiveLocation(loc);
    reloadForLocation();
  };
}

async function handleAction(action: string, el: HTMLElement, e: Event) {
  e.preventDefault();
  switch (action) {
    case "refresh":
      state.error = null;
      teardownMap();
      root().innerHTML = `<div class="boot"><img class="boot-logo" src="/fishing.png" width="64" height="64"/><div class="boot-spinner"></div><div class="boot-text">Reading the water...</div></div>`;
      await start();
      break;
    case "geo":
      useDeviceLocation();
      break;
    case "home-loc":
      selectLocation(HOME);
      break;
    case "fit-preds":
      mapApi?.fitPredators();
      break;
    case "center-self":
      if (!mapApi?.centerOnSelf()) toast("Waiting for your GPS fix... allow location access");
      break;
    case "map-fs": {
      const host = document.getElementById("mapcanvas");
      if (host) setFullscreen(host, !host.classList.contains("fs"), () => mapApi?.resize());
      break;
    }
    case "tide-fs": {
      const host = document.getElementById("tidechart");
      if (host) setFullscreen(host, !host.classList.contains("fs"));
      break;
    }
    case "handbook-fs": {
      const host = document.getElementById("handbook");
      if (host) setFullscreen(host, !host.classList.contains("fs"));
      break;
    }
    case "toggle-share": {
      const now = toggleSharing();
      const btn = document.getElementById("sharebtn");
      if (btn) {
        btn.textContent = now ? "📡 Sharing: ON" : "📡 Share location";
        btn.classList.toggle("primary", now);
      }
      toast(now ? "Sharing your live location with the guild" : "Stopped sharing your location");
      break;
    }
    case "open-admin":
      openAdminPanel();
      break;
    case "logout":
      doLogout();
      break;
    case "save-spot": {
      const base = state.location;
      const name = prompt("Name this spot:", /^(Pinned spot|Live Location|My location)/.test(base.name) ? "" : base.name);
      if (name && name.trim()) {
        state.saved = addSpot(base, name);
        toast("Spot saved");
        render();
      }
      break;
    }
    case "remove-spot":
      state.saved = removeSpot(el.dataset.id!);
      toast("Spot removed");
      render();
      break;
    case "goto-spot": {
      const loc = state.saved.find((s) => s.id === el.dataset.id);
      if (loc) selectLocation(loc);
      break;
    }
    case "del": {
      const id = el.dataset.id!;
      state.log = deleteRecord(id);
      syncTripDelete(id);
      render();
      break;
    }
    case "seed":
      state.log = seedSamples();
      toast("Loaded sample trips");
      render();
      break;
    case "clearlog":
      if (confirm("Delete all logged trips? This cannot be undone.")) {
        for (const r of state.log) syncTripDelete(r.id);
        state.log = [];
        localStorage.removeItem("mccormacks.catchlog.v1");
        render();
      }
      break;
    case "export":
      downloadText("mccormacks-catchlog.json", exportJSON());
      toast("Exported catch log");
      break;
    case "import":
      importFlow();
      break;
    case "copy-briefing": {
      const txt = document.getElementById("briefing-text")?.textContent ?? "";
      navigator.clipboard.writeText(txt).then(() => toast("Briefing copied"));
      break;
    }
  }
}

function onLogSubmit(e: Event) {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  const g = (n: string) => (f.elements.namedItem(n) as HTMLInputElement)?.value ?? "";
  const date = g("date");
  const snapMoon = moonInfo(new Date(date + "T12:00:00"));
  const waterSnap = waterTempForDate(date);
  const rec: CatchRecord = {
    id: newId(),
    date, start: g("start"), end: g("end"),
    tideStage: g("tideStage"), tideHeight: g("tideHeight"),
    windDir: g("windDir"), windSpeed: g("windSpeed"),
    weather: g("weather"), water: g("water"),
    species: g("species"), count: Number(g("count")) || 0,
    size: g("size"), kept: g("kept") as CatchRecord["kept"], gear: g("gear"), notes: g("notes"),
    moonPhase: snapMoon.name,
    waterTemp: waterSnap,
  };
  state.log = addRecord(rec);
  syncTripSave(rec); // share to the guild backend so admins can see it (Firebase)
  toast("Trip added to log");
  state.tab = "analysis";
  render();
}

function waterTempForDate(date: string): string | undefined {
  if (!state.bundle) return undefined;
  const hrs = state.bundle.hours.filter((h) => localDateKey(h.time) === date);
  const temps = hrs.map((h) => h.waterTemp).filter((x): x is number => x != null);
  if (!temps.length) return undefined;
  return `${(temps.reduce((s, x) => s + x, 0) / temps.length).toFixed(1)} °C`;
}

function importFlow() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        state.log = importJSON(String(reader.result));
        toast("Imported catch log");
        render();
      } catch (err) {
        alert("Import failed: " + (err as Error).message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

let toastTimer: number | undefined;
function toast(msg: string) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), 2200);
}
