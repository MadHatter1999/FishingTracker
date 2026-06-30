import "../styles.css";
import { loadBundle } from "../data";
import { computeScores, overallScoreForDay, localDateKey } from "../engine/score";
import { computeDay, type DayContext } from "../engine/context";
import { tideVelocityAt } from "../engine/merge";
import { buildSeaState, type SeaState } from "../engine/seastate";
import { buildLakeState, lakeActivityLabel } from "../engine/lakestate";
import type { LakeState } from "../types";
import { generateBriefing } from "../engine/briefing";
import { trailMapSVG, svgToPngBlob } from "../util/trailmap";
import { tideChartSVG, gaugeSVG, scoreColor } from "./charts";
import { loadLog, addRecord, deleteRecord, newId, seedSamples, exportJSON, exportCSV, importJSON } from "../store/log";
import { SPECIES, FRESH_SPECIES, weatherLabel, compassDir } from "../config";
import { loadNSLocations, getActiveLocation, setActiveLocation, locationForPoint, haversineKm, HOME } from "../services/locations";
import { loadSpots, addSpot, removeSpot } from "../store/spots";
import { loadTrail, saveTrail, emptyTrail, maybeAppendPoint, bearingDeg, trailLengthKm, downsampleTrail, loadTrailHistory, archiveTrail, deleteArchivedTrail, loadShareWith, saveShareWith, type TrailState, type ArchivedTrail } from "../store/trail";
import type { MapApi } from "./map";
import type { TidalFlow } from "./flow";
import { moonEmoji, moonInfo } from "../services/astronomy";
import { fmtTime, fmtRange, fmtWeekday, fmtDate } from "../util/format";
import type { Bundle, ScoredHour, CatchRecord, HourPoint, FishingLocation, GuildUser, AnglerPresence } from "../types";
import { fetchMe, logout as apiLogout, getCurrentUser, syncTripSave, syncTripDelete, listMembers } from "../services/api";
import { connect as presenceConnect, disconnect as presenceDisconnect, onRoster, toggleSharing, loadSharePref, setSharedTrail as presenceSetTrail, setShareTargets as presenceSetTargets } from "../services/presence";
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
  members: GuildUser[]; // full guild roster (for the Trail-mode member lookup)
}

const state: State = {
  bundle: null, scored: [], log: loadLog(), dayOffset: 0, tab: "overview",
  error: null, location: getActiveLocation(), locations: [HOME], saved: loadSpots(),
  user: null, presence: [], members: [],
};

let mapApi: MapApi | null = null;

// combined list for the map + dropdown (saved favourites first)
function allLocations(): FishingLocation[] {
  return [...state.saved, ...state.locations];
}

const TABS = [
  ["overview", "Summary"],
  ["map", "Map / Location"],
  ["trails", "Trail History"],
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
  presenceSetTargets(shareWith); // so recipients are known as soon as sharing starts
  resumeTrailIfActive();
  // Load the guild roster (any active member may) for the Trail-mode lookup; the
  // Node backend may refuse non-admins (graceful: lookup falls back to sharers).
  listMembers().then((m) => {
    state.members = m;
    if (state.tab === "map") refreshTrailPanel();
  }).catch(() => {});

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
    // Refresh the Trail-mode lookup so live "sharing/distance" stays current, but
    // not while the user is mid-search (would steal focus / reset their query).
    if (state.tab === "map" && document.activeElement?.id !== "guild-search") refreshTrailPanel();
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
  if (trail.active && trail.paused) return; // movement held - keep the marker frozen at the last point
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

/* ---------- TRAIL / CAMP MODE ---------- */
// A self-paced hiking mode: records a breadcrumb, keeps the screen awake so the
// GPS keeps logging in-hand, and always shows the way back to base camp. The web
// platform can't track with the screen off / app backgrounded (no background-geo
// API on iOS, throttled on Android), so we hold a screen Wake Lock instead and
// tell the user to keep the app open. The same code carries over to a future
// native (Capacitor) shell that *can* track in the pocket.
let trail: TrailState = loadTrail();
let trailHistory: ArchivedTrail[] = loadTrailHistory();
let viewingHistory: ArchivedTrail | null = null; // a past trip being replayed on the map
let shareWith: string[] = loadShareWith(); // member ids you share your live trail with
let trailWatchId: number | null = null;

// Push the current trail + share targets to the live feed. The trail is only sent
// when you've chosen at least one recipient (otherwise nobody should see it).
function applyTrailShare(): void {
  presenceSetTargets(shareWith);
  presenceSetTrail(shareWith.length && trail.active && !trail.paused ? downsampleTrail(trail.points) : null);
}

// Last recorded breadcrumb point - where the marker holds while paused.
function lastTrailPoint(): { lat: number; lon: number; acc: number } | null {
  const p = trail.points[trail.points.length - 1];
  return p ? { lat: p.lat, lon: p.lon, acc: p.acc ?? 0 } : null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wakeLock: any = null;

async function acquireWakeLock() {
  try {
    const wl = (navigator as unknown as { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock;
    if (wl?.request) wakeLock = await wl.request("screen");
  } catch { /* unsupported / denied - tracking still works while the screen is on */ }
}
function releaseWakeLock() {
  try { wakeLock?.release?.(); } catch { /* ignore */ }
  wakeLock = null;
}
// Wake locks drop when the tab is hidden; re-grab it when we come back into view.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && trail.active && !trail.paused && !wakeLock) acquireWakeLock();
});

function startTrailWatch() {
  if (!("geolocation" in navigator) || trailWatchId != null) return;
  trailWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (trail.paused) return; // movement held - ignore fixes so the marker stays frozen
      const lat = pos.coords.latitude, lon = pos.coords.longitude, acc = pos.coords.accuracy;
      selfLoc = { lat, lon, acc };
      mapApi?.setSelfLocation(lat, lon, acc);
      if (trail.active && maybeAppendPoint(trail, lat, lon, acc)) {
        saveTrail(trail);
        if (!viewingHistory) mapApi?.setTrail(trail); // don't clobber a history replay
        presenceSetTrail(shareWith.length ? downsampleTrail(trail.points) : null); // only to chosen recipients
      }
      updateTrailReadout();
    },
    () => { /* permission denied / unavailable */ },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
}
function stopTrailWatch() {
  if (trailWatchId != null) { navigator.geolocation.clearWatch(trailWatchId); trailWatchId = null; }
}

async function startTrailMode() {
  trail.active = true;
  trail.paused = false;
  if (!trail.startedAt) trail.startedAt = Date.now();
  saveTrail(trail);
  await acquireWakeLock();
  startTrailWatch();
  mapApi?.setTrail(trail);
  applyTrailShare();
  refreshTrailPanel();
  toast("Trail mode on. Keep the app open (screen stays awake); your breadcrumb is recording.");
}
function stopTrailMode() {
  trail.active = false;
  trail.paused = false;
  saveTrail(trail);
  releaseWakeLock();
  stopTrailWatch();
  startSelfWatch(); // resume the live marker if it was frozen by a pause
  presenceSetTrail(null); // stop broadcasting the live line
  refreshTrailPanel();
  toast("Trail mode stopped. Your breadcrumb, camp and marks are saved.");
}

// Pause movement: hold the trip without recording, so you can put the phone down
// (or close the app) to recharge. The marker freezes at the last point, the screen
// is free to sleep, and the paused state persists so it's still there next launch.
function pauseTrail() {
  if (!trail.active || trail.paused) return;
  trail.paused = true;
  saveTrail(trail);
  stopTrailWatch();
  stopSelfWatch();
  releaseWakeLock();
  presenceSetTrail(null); // stop broadcasting the live line while parked
  const last = lastTrailPoint();
  if (last) { selfLoc = last; mapApi?.setSelfLocation(last.lat, last.lon, last.acc); }
  refreshTrailPanel();
  toast("Movement paused. You can close the app to recharge - pick up right here when you're back.");
}

// Unpause: resume normal recording from wherever you are now.
async function resumeTrail() {
  if (!trail.active || !trail.paused) return;
  trail.paused = false;
  saveTrail(trail);
  await acquireWakeLock();
  startTrailWatch();
  startSelfWatch();
  applyTrailShare();
  refreshTrailPanel();
  toast("Tracking resumed. Your breadcrumb is recording again.");
}

// After a reload mid-hike, quietly resume recording - unless the trip was paused,
// in which case we stay paused (the marker is frozen by postRender on map open).
function resumeTrailIfActive() {
  if (!trail.active || trail.paused) return;
  acquireWakeLock();
  startTrailWatch();
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

// Turn a load error into an accurate hint. A 4xx is the SERVER rejecting the
// request, not a connection problem; a rate limit just needs time, not a reload.
function loadErrorHint(err: string): string {
  if (/429|limit exceeded|too many requests/i.test(err)) {
    return "Open-Meteo's free per-IP request quota is temporarily used up (it resets within the hour/day). Wait a few minutes before retrying, and avoid rapid reloads - any spot you already opened still shows its last data.";
  }
  if (/\b4\d\d\b|rejected|invalid|out of range/i.test(err)) {
    return "The weather service rejected the request - this is not a connection problem. If you'd just dropped a pin, try a different spot or reload home.";
  }
  return "Check your internet connection - the app pulls live tides (DFO/CHS) and weather (Open-Meteo).";
}

function render() {
  teardownMap();
  clearFullscreen();
  const b = state.bundle;
  if (state.error || !b) {
    root().innerHTML = `<div class="card" style="margin-top:40px">
      <h2>Couldn't load live data</h2>
      <p class="muted">${esc(state.error ?? "Unknown error")}. ${loadErrorHint(state.error ?? "")}</p>
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
// Modelled lake stratification state for the active freshwater spot - the lake
// equivalent of seaStateNow(). Surface temp comes from the live air-temp-based
// estimate (merge.ts); depth/clarity from the NS Lake Survey when available.
function lakeStateNow(b: Bundle, date?: Date): LakeState | null {
  if (b.location.kind !== "fresh") return null;
  const h = nowHour(b);
  return buildLakeState({
    month: (date ?? new Date()).getMonth() + 1,
    surfaceTempC: h.waterTemp ?? 15,
    survey: b.lakeSurvey ?? null,
  });
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
const LAKE_ICON: Record<ReturnType<typeof lakeActivityLabel>, string> = { slow: "🔴", fair: "🟠", good: "🟡", prime: "🟢" };

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
    landPredators: state.bundle?.landPredators ?? [],
    presence: state.presence,
    selfId: state.user?.id,
    selfColor: state.user?.color,
    flow: tidalFlowNow(),
    waves: seaStateNow()?.components ?? null,
    wind: windNow(),
    trail: viewingHistory ?? trail,
    onSelect: (loc) => selectLocation(loc),
    onRemoveSaved: (id) => {
      state.saved = removeSpot(id);
      toast("Spot removed");
      render();
    },
  });
  startSelfWatch(); // no-op while paused, so the marker stays put
  // While paused, hold the marker at the last recorded point (selfLoc is empty after
  // an app restart); otherwise show the latest live fix.
  const frozen = trail.active && trail.paused ? (selfLoc ?? lastTrailPoint()) : selfLoc;
  if (frozen) { selfLoc = frozen; mapApi.setSelfLocation(frozen.lat, frozen.lon, frozen.acc); }
  if (viewingHistory) mapApi.fitTrail();
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
  const lake = fresh ? lakeStateNow(b) : null;
  return `<div class="cond-strip">
    ${cond("Now", `${w.icon} ${w.label}`, fmtTime(h.time))}
    ${cond("Air", `${Math.round(h.airTemp)}°C`, `feels ${Math.round(h.airTemp)}°`)}
    ${cond("Water", h.waterTemp != null ? `${h.waterTemp.toFixed(1)}°C` : "-", fresh ? "lake" : "sea surface")}
    ${cond("Wind", `${Math.round(h.windSpeed)} km/h`, `${compassDir(h.windDir)} · gust ${Math.round(h.windGust)}`)}
    ${cond("Pressure", `${Math.round(h.pressure)} hPa`, `${h.pressureTrend >= 0 ? "↑" : "↓"} ${Math.abs(h.pressureTrend).toFixed(1)}/3h`)}
    ${fresh
      ? cond("Lake", lake ? `${LAKE_ICON[lakeActivityLabel(lake.score)]} ${lake.label}` : "Freshwater", lake?.stratified && lake.thermoclineDepthM ? `thermocline ~${lake.thermoclineDepthM} m` : lake ? lakeActivityLabel(lake.score) : "no tide")
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
    case "trails": return tabTrailHistory();
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
        <button class="btn small" data-action="save-offline" title="Download this map view so it works with no signal in the backcountry">⬇ Save offline</button>
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
  </div>
  ${trailPanel()}`;
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

function fmtDur(ms: number): string {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

// Distance + bearing back to base camp, relative to map-north (no device heading).
function campCompassHTML(): string {
  if (!trail.baseCamp) return `<p class="note-sm muted" style="margin:6px 0">No base camp yet. Drop one so you always have a bearing back.</p>`;
  if (!selfLoc) return `<p class="note-sm" style="margin:6px 0">⛺ <b>${esc(trail.baseCamp.name)}</b> set. Waiting for a GPS fix to point the way back...</p>`;
  const km = haversineKm(selfLoc.lat, selfLoc.lon, trail.baseCamp.lat, trail.baseCamp.lon);
  const brg = bearingDeg(selfLoc.lat, selfLoc.lon, trail.baseCamp.lat, trail.baseCamp.lon);
  const dist = km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`;
  return `<div class="camp-compass">
    <span class="camp-arrow" style="transform:rotate(${brg}deg)">⬆</span>
    <span>⛺ <b>${esc(trail.baseCamp.name)}</b> is <b>${dist}</b> ${compassDir(brg)} <span class="muted">(${Math.round(brg)}° from north)</span></span>
  </div>`;
}

function trailLiveHTML(): string {
  const dur = trail.startedAt ? fmtDur(Date.now() - trail.startedAt) : "-";
  const status = !trail.active ? "⚪ off" : trail.paused ? "⏸ paused" : "🟢 recording";
  return `<div class="trail-stats">
      <span>${status}</span>
      <span>⏱ ${dur}</span>
      <span>📏 ${trailLengthKm(trail).toFixed(2)} km</span>
      <span>· ${trail.points.length} pts</span>
    </div>${campCompassHTML()}`;
}

function poiListHTML(): string {
  if (!trail.pois.length) return "";
  return `<div class="mt"><h4 class="trail-sub">Marked spots</h4>
    ${trail.pois.map((p) => `<div class="flex spread trail-row">
      <button class="btn small ghost" data-action="trail-gotopoi" data-id="${esc(p.id)}">${p.emoji} ${esc(p.name)}</button>
      <button class="btn small danger" data-action="trail-rmpoi" data-id="${esc(p.id)}">✕</button>
    </div>`).join("")}
  </div>`;
}

// The chips of people you currently share your trail with.
function shareChipsHTML(): string {
  if (!shareWith.length) {
    return `<p class="note-sm muted" style="margin:4px 0 8px">You're not sharing your trail with anyone yet. Tap a member below to show your live trail on their map.</p>`;
  }
  const chips = shareWith.map((id) => {
    const m = state.members.find((x) => String(x.id) === id);
    const a = state.presence.find((x) => String(x.id) === id);
    const name = m?.displayName ?? a?.displayName ?? "Member";
    const color = m?.color ?? a?.color ?? "#36c2ce";
    return `<span class="share-chip"><span class="legend-dot" style="background:${esc(color)}"></span>${esc(name)}<button class="chip-x" data-action="guild-share-remove" data-id="${esc(id)}" title="Stop sharing with ${esc(name)}">×</button></span>`;
  }).join("");
  return `<div class="share-list">${chips}</div>`;
}

function guildLookupHTML(): string {
  const meId = state.user?.id;
  // live position by member id (only those currently sharing)
  const live = new Map(state.presence.filter((a) => a.lat != null && a.lon != null).map((a) => [String(a.id), a]));
  // Prefer the full roster; if it didn't load (e.g. Node non-admin), fall back to
  // whoever is currently sharing so the lookup still shows something useful.
  const roster = state.members.filter((m) => m.id !== meId && m.active !== false);
  const list = roster.length
    ? roster.map((m) => ({ id: m.id, displayName: m.displayName, color: m.color }))
    : state.presence.filter((a) => a.id !== meId).map((a) => ({ id: a.id, displayName: a.displayName, color: a.color }));
  list.sort((a, b) => (live.has(String(b.id)) ? 1 : 0) - (live.has(String(a.id)) ? 1 : 0)); // sharers first

  const rows = list.map((m) => {
    const idStr = String(m.id);
    const a = live.get(idStr);
    const shared = shareWith.includes(idStr);
    let right: string;
    if (a) {
      let dist = "sharing live";
      if (selfLoc) {
        const km = haversineKm(selfLoc.lat, selfLoc.lon, a.lat, a.lon);
        const brg = bearingDeg(selfLoc.lat, selfLoc.lon, a.lat, a.lon);
        dist = `${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`} ${compassDir(brg)}`;
      }
      right = `<button class="btn small ghost" data-action="guild-goto" data-id="${esc(idStr)}" title="Show on map">📍 ${dist}</button>`;
    } else {
      right = `<span class="muted" style="font-size:12px">not sharing</span>`;
    }
    return `<div class="flex spread trail-row" data-member-row data-name="${esc(m.displayName.toLowerCase())}">
      <button class="btn small ${shared ? "primary" : "ghost"}" data-action="guild-share-toggle" data-id="${esc(idStr)}" title="${shared ? "Stop sharing your trail with them" : "Share your trail with them"}">${shared ? "✓ " : "+ "}<span class="legend-dot" style="background:${esc(m.color)}"></span> ${esc(m.displayName)}</button>
      ${right}
    </div>`;
  }).join("");
  return `<div class="mt"><h4 class="trail-sub">Sharing my trail with</h4>
    ${shareChipsHTML()}
    <h4 class="trail-sub">Add / find a guild member</h4>
    <input id="guild-search" class="trail-search" type="search" placeholder="Search guild members..." />
    ${list.length ? rows : `<p class="note-sm muted" style="margin:6px 0">No other guild members yet.</p>`}
  </div>`;
}

function trailPanel(): string {
  if (viewingHistory) {
    const when = viewingHistory.startedAt ? fmtDate(new Date(viewingHistory.startedAt)) : "a past trip";
    return `
  <div class="card trail-panel mt">
    <div class="flex spread" style="flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">🗺 Viewing past trip</h3>
      <button class="btn small primary" data-action="trail-view-exit">↩ Return to live trail</button>
    </div>
    <p class="note-sm">Replaying your trip from <b>${esc(when)}</b> - ${trailLengthKm(viewingHistory).toFixed(2)} km, ${viewingHistory.points.length} points. Your live recording isn't affected.</p>
  </div>`;
  }
  const active = trail.active;
  const paused = trail.paused;
  return `
  <div class="card trail-panel mt">
    <div class="flex spread" style="flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">Trail / Camp mode</h3>
      <div class="flex" style="gap:6px">
        ${active ? (paused
          ? `<button class="btn small primary" data-action="trail-resume">▶ Unpause</button>`
          : `<button class="btn small" data-action="trail-pause">⏸ Pause movement</button>`) : ""}
        <button class="btn small ${active ? "" : "primary"}" data-action="trail-toggle">${active ? "⏹ Stop trail mode" : "▶ Start trail mode"}</button>
      </div>
    </div>
    <p class="note-sm">${paused
      ? "⏸ Paused - your position is held at the last point. Close the app to recharge if you like; tap Unpause to carry on from where you are."
      : "Records a breadcrumb and keeps the screen awake so it logs while you hike." + (active ? "" : " Web apps can't track with the screen off, so keep the app open while moving.")}</p>
    <div id="trail-live">${trailLiveHTML()}</div>
    <div class="flex" style="flex-wrap:wrap;gap:6px;margin-top:8px">
      <button class="btn small" data-action="trail-camp">⛺ Set base camp here</button>
      <button class="btn small" data-action="trail-poi">📍 Mark this spot</button>
      ${trail.baseCamp ? `<button class="btn small" data-action="trail-tocamp">🧭 Centre on camp</button>` : ""}
      ${(trail.points.length || trail.pois.length || trail.baseCamp) ? `<button class="btn small" data-action="trail-save">💾 Save trip</button>
      <button class="btn small danger" data-action="trail-clear">🗑 Clear trip</button>` : ""}
    </div>
    ${poiListHTML()}
    ${guildLookupHTML()}
  </div>`;
}

// Live-update the trail stats + camp compass without a full re-render (which would
// remount the map). Called on every GPS tick.
function updateTrailReadout(): void {
  const el = document.getElementById("trail-live");
  if (el) el.innerHTML = trailLiveHTML();
}

// Refresh the whole trail panel in place (POI list, buttons, stats) WITHOUT a full
// render(), so the map keeps your current pan/zoom while you drop marks mid-hike.
function refreshTrailPanel(): void {
  const old = document.querySelector(".trail-panel");
  if (!old) return;
  const prevQuery = (document.getElementById("guild-search") as HTMLInputElement | null)?.value ?? "";
  const tmp = document.createElement("div");
  tmp.innerHTML = trailPanel().trim();
  const fresh = tmp.firstElementChild as HTMLElement | null;
  if (!fresh) return;
  old.replaceWith(fresh);
  fresh.querySelectorAll<HTMLElement>("[data-action]").forEach((el) =>
    el.addEventListener("click", (e) => handleAction(el.dataset.action!, el, e)));
  attachTrailSearch();
  // keep any in-progress member search applied after a live roster refresh
  const inp = document.getElementById("guild-search") as HTMLInputElement | null;
  if (inp && prevQuery) { inp.value = prevQuery; inp.dispatchEvent(new Event("input")); }
}

function attachTrailSearch(): void {
  const inp = document.getElementById("guild-search") as HTMLInputElement | null;
  if (!inp) return;
  inp.oninput = () => {
    const q = inp.value.trim().toLowerCase();
    document.querySelectorAll<HTMLElement>("[data-member-row]").forEach((row) => {
      row.style.display = !q || (row.dataset.name ?? "").includes(q) ? "" : "none";
    });
  };
}

/* ---------- TRAIL HISTORY ---------- */
function tabTrailHistory(): string {
  if (!trailHistory.length) {
    return `<div class="card">
      <h2>Trail History</h2>
      <p class="muted">No saved trips yet. Open the <b>Map / Location</b> tab, start <b>Trail mode</b>, walk your route, then tap <b>💾 Save trip</b> to keep it here. Each saved trip keeps your breadcrumb path, base camp and marked spots — replay it on the map, or export it as an image or PDF.</p>
    </div>`;
  }
  const rows = trailHistory.map((t) => {
    const when = t.startedAt ? fmtDate(new Date(t.startedAt)) : "Trip";
    const dur = (t.startedAt && t.endedAt) ? fmtDur(t.endedAt - t.startedAt) : "-";
    return `<div class="card trail-hist">
      <div class="flex spread" style="flex-wrap:wrap;gap:8px">
        <div>
          <b>${esc(when)}</b>${t.baseCamp ? ` <span class="muted">· ⛺ ${esc(t.baseCamp.name)}</span>` : ""}
          <div class="trail-stats" style="margin-top:4px">
            <span>⏱ ${dur}</span><span>📏 ${trailLengthKm(t).toFixed(2)} km</span><span>· ${t.points.length} pts</span>${t.pois.length ? `<span>· 📍 ${t.pois.length}</span>` : ""}
          </div>
        </div>
        <span class="flex" style="flex-wrap:wrap">
          <button class="btn small" data-action="trail-view" data-id="${esc(t.id)}">🗺 Show on map</button>
          <button class="btn small" data-action="trail-img" data-id="${esc(t.id)}" title="Save this trip map as a PNG image">🖼 Image</button>
          <button class="btn small" data-action="trail-pdf" data-id="${esc(t.id)}" title="Open a printable trip sheet you can save as PDF">📄 PDF</button>
          <button class="btn small danger" data-action="trail-del" data-id="${esc(t.id)}">Delete</button>
        </span>
      </div>
      <div class="trail-thumb">${trailMapSVG(t, { width: 640, height: 280 })}</div>
    </div>`;
  }).join("");
  return `<div class="card">
    <h2>Trail History</h2>
    <p class="muted" style="font-size:13px">Your saved trips (this device). Each shows a map of the whole route — tap <b>Show on map</b> to replay it live, or <b>🖼 Image</b> / <b>📄 PDF</b> to export a trip sheet.</p>
  </div>${rows}`;
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
  ${fresh ? lakeProfilePanel(b, ctx.date) + waterwayFlowPanel(b) + stockingPanel(b) : predatorPanel(b)}
  ${nearbyPanel(b)}`;
}

// B + C: modelled lake stratification (where the fish are holding) backed by the
// real measured morphometry/clarity from the NS Environment Lake Survey.
function lakeProfilePanel(b: Bundle, date: Date): string {
  const ls = lakeStateNow(b, date);
  if (!ls) return "";
  const sv = b.lakeSurvey ?? null;
  const act = lakeActivityLabel(ls.score);
  const fmtD = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-CA", { year: "numeric", month: "short" }) : "-");
  const stat = (label: string, val: string) => `<span class="badge">${label}: <b>${esc(val)}</b></span>`;
  const morph = sv
    ? `<div class="note-sm flex" style="flex-wrap:wrap;gap:8px;margin:2px 0 8px">
        ${sv.maxDepthM != null ? stat("Max depth", `${sv.maxDepthM} m`) : ""}
        ${sv.meanDepthM != null ? stat("Mean depth", `${sv.meanDepthM} m`) : ""}
        ${sv.secchiM != null ? stat("Clarity (Secchi)", `${sv.secchiM.toFixed(1)} m`) : ""}
        ${sv.ph != null ? stat("pH", sv.ph.toFixed(1)) : ""}
        ${sv.colourTCU != null ? stat("Colour", `${Math.round(sv.colourTCU)} TCU`) : ""}
        ${sv.bottomDO != null ? stat("Bottom O₂", `${sv.bottomDO.toFixed(1)} mg/L`) : ""}
      </div>
      <div class="note-sm">Measured: <b>${esc(sv.lakeName)}</b>${sv.stationCount > 1 ? ` (${sv.stationCount} survey stations)` : ""}, surveyed ${fmtD(sv.assessed)} - <a href="https://hub.arcgis.com/maps/1936e489870343cd8a6e79d312f6d0f5" target="_blank" rel="noopener">NS Environment Lake Survey →</a></div>`
    : `<p class="note-sm muted" style="margin:0 0 6px">No NS lake-survey station within ~3 km, so depth is estimated. The stratification read below is modelled from temperature and season.</p>`;
  return `<div class="card mt">
    <h2>🌡 Lake conditions &amp; depth <span class="legalflag ${act === "prime" || act === "good" ? "lf-keep" : "lf-check"}">${LAKE_ICON[act]} ${ls.label}</span></h2>
    <p class="muted" style="font-size:13px;margin:0 0 8px">Surface ~${ls.surfaceTempC.toFixed(1)} °C. ${esc(ls.targetDepth)}</p>
    ${morph}
    ${ls.notes.length ? `<ul class="tac-list" style="margin:6px 0 0">${ls.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
  </div>`;
}

// A: live river/stream/lake level + flow from the nearest Environment Canada gauge.
function waterwayFlowPanel(b: Bundle): string {
  const hy = b.hydro ?? null;
  const arrow = (t: "rising" | "falling" | "steady") => (t === "rising" ? "↑ rising" : t === "falling" ? "↓ falling" : "→ steady");
  if (!hy) {
    return `<div class="card mt">
      <h2>🌊 Waterway flow &amp; level</h2>
      <p class="muted" style="font-size:13px;margin:0">No live hydrometric gauge within ~60 km of ${esc(b.location.name)}. Inflows/outflows still concentrate fish - fish them on and just after rain.</p>
    </div>`;
  }
  const lvl = hy.latest.level != null ? `${hy.latest.level.toFixed(2)} m` : "-";
  const dis = hy.latest.discharge != null ? `${hy.latest.discharge.toFixed(1)} m³/s` : null;
  const sig = Math.round(hy.flowSignal * 100);
  return `<div class="card mt">
    <h2>🌊 Waterway flow &amp; level <span class="legalflag lf-check">${hy.kind === "river" ? "river / stream" : "lake gauge"}</span></h2>
    <p class="muted" style="font-size:13px;margin:0 0 8px">Nearest live gauge: <b>${esc(hy.stationName)}</b> (${hy.distanceKm} km away), from Environment Canada. ${hy.kind === "river"
      ? "Higher, rising flow oxygenates inflows/outflows and pulls fish onto the moving water."
      : "Lake level trend hints at how much water is moving through the inflows and outlet."}</p>
    <div class="note-sm flex" style="flex-wrap:wrap;gap:8px">
      <span class="badge live">Level: <b>${lvl}</b> ${arrow(hy.levelTrend)}</span>
      ${dis ? `<span class="badge live">Flow: <b>${dis}</b> ${arrow(hy.dischargeTrend)}</span>` : ""}
      <span class="badge">Moving-water index: <b>${sig}%</b></span>
    </div>
    <div class="note-sm" style="margin-top:8px"><a href="https://wateroffice.ec.gc.ca/report/real_time_e.html?stn=${esc(hy.stationNumber)}" target="_blank" rel="noopener">Environment Canada gauge ${esc(hy.stationNumber)} →</a></div>
  </div>`;
}

// "What's where": real marine species documented near this point (OBIS, global).
// Surfaces species beyond our curated roster and works at any coastal location.
function nearbyPanel(b: Bundle): string {
  if (b.location.kind === "fresh") return ""; // OBIS is marine; lakes use the curated list + stocking
  const taxa = b.nearbyTaxa ?? [];
  const src = `<a href="https://obis.org" target="_blank" rel="noopener">OBIS →</a>`;
  if (!taxa.length) {
    return `<div class="card mt"><h2>🌊 Documented near here</h2>
      <p class="muted" style="font-size:13px;margin:0">No marine occurrence records within ~35 km of this point (OBIS). Drop the hook on a coastal/ocean point to see what's recorded there. Source: ${src}</p></div>`;
  }
  const short = (n: number) => (n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
  const chip = (t: import("../types").OccTaxon) =>
    `<span class="badge" title="${esc(t.sci)} · ${t.records.toLocaleString()} records">${t.emoji} ${t.common ? esc(t.common) : `<i>${esc(t.sci)}</i>`} <span class="muted">${short(t.records)}</span></span>`;
  const sharks = taxa.filter((t) => t.group !== "fish");
  const fish = taxa.filter((t) => t.group === "fish");
  const fishShown = fish.slice(0, 48);
  const more = taxa.length - sharks.length - fishShown.length;
  return `<div class="card mt">
    <h2>🌊 Documented near here <span class="legalflag lf-check">${taxa.length} species</span></h2>
    <p class="muted" style="font-size:13px;margin:0 0 10px">Marine species with verified records within ~35 km of ${esc(b.location.name)}, from the global <b>OBIS</b> database. These are observation records (count = how often recorded), not a live forecast - but they tell you what actually lives here. Works anywhere you drop the hook.</p>
    ${sharks.length ? `<div class="note-sm" style="margin:0 0 4px"><b>Sharks &amp; rays</b></div>
      <div class="flex" style="flex-wrap:wrap;gap:6px;margin-bottom:10px">${sharks.map(chip).join("")}</div>` : ""}
    <div class="note-sm" style="margin:0 0 4px"><b>Fish</b></div>
    <div class="flex" style="flex-wrap:wrap;gap:6px">${fishShown.map(chip).join("")}</div>
    <div class="note-sm" style="margin-top:10px">${more > 0 ? `+ ${more} more recorded. ` : ""}Source: ${src} · scientific name shown where no common name.</div>
  </div>`;
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
  const methodOpts = ["Shore", "Boat", "Kayak", "Pier", "Fly", "Ice"].map((x) => `<option>${x}</option>`).join("");
  const here = esc(state.location?.name ?? "");
  return `
  <div class="card">
    <h2>Log a Trip</h2>
    <form id="logform">
      <h3 class="form-section">Trip &amp; conditions</h3>
      <div class="form-grid">
        <label class="field">Date<input name="date" type="date" value="${today}" required></label>
        <label class="field">Start<input name="start" type="time" value="06:00"></label>
        <label class="field">End<input name="end" type="time" value="08:00"></label>
        <label class="field">Location / spot<input name="location" value="${here}" placeholder="e.g. McCormacks Beach"></label>
        <label class="field">Method<select name="method">${methodOpts}</select></label>
        <label class="field">With<input name="party" placeholder="e.g. Solo, with Dave"></label>
        <label class="field">Tide stage<select name="tideStage">${tideOpts}</select></label>
        <label class="field">Tide height<input name="tideHeight" placeholder="e.g. 1.2 m"></label>
        <label class="field">Wind dir<select name="windDir">${dirs}</select></label>
        <label class="field">Wind speed<input name="windSpeed" placeholder="e.g. 12 km/h"></label>
        <label class="field">Weather<input name="weather" placeholder="e.g. Overcast"></label>
        <label class="field">Water<input name="water" placeholder="e.g. Light chop"></label>
      </div>

      <h3 class="form-section">Catch &amp; wildlife</h3>
      <div class="form-grid">
        <label class="field">Species<select name="species">${speciesOpts}</select></label>
        <label class="field">Count<input name="count" type="number" min="0" value="0"></label>
        <label class="field">Approx size<input name="size" placeholder="e.g. 30-35 cm"></label>
        <label class="field">Approx weight<input name="weight" placeholder="e.g. ~0.5 kg, best 1.1 kg"></label>
        <label class="field">Kept<select name="kept"><option value="kept">kept</option><option value="released">released</option><option value="mixed">mixed</option></select></label>
        <label class="field">Gear / rig<input name="gear" placeholder="e.g. Sabiki + float"></label>
        <label class="field">Bait / lure<input name="bait" placeholder="e.g. mackerel strip, white jig"></label>
        <label class="field wide">Other wildlife seen<input name="wildlife" placeholder="e.g. harbour seals, bald eagle, porpoise, sharks…"></label>
      </div>

      <h3 class="form-section">Notes</h3>
      <div class="form-grid">
        <label class="field wide"><textarea name="notes" placeholder="What worked, where the fish were, behaviour, anything to remember for next time…"></textarea></label>
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
        ${state.log.length ? `<button class="btn small" data-action="exportcsv" title="Spreadsheet of every trip — opens in Excel/Sheets">⬇ Export CSV</button>` : ""}
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
      <th>Date</th><th>Time</th><th>Spot</th><th>Species</th><th>#</th><th>Size</th><th>Kept</th><th>Bait / gear</th><th>Tide</th><th>Wind</th><th>Weather</th><th>Wildlife</th><th>Notes</th><th></th>
    </tr></thead>
    <tbody>
      ${state.log.map((r) => `<tr>
        <td>${esc(r.date)}</td>
        <td>${esc(r.start)}-${esc(r.end)}</td>
        <td>${esc(r.location ?? "")}${r.method ? `<br><span class="muted" style="font-size:11px">${esc(r.method)}</span>` : ""}</td>
        <td>${esc(r.species)}</td>
        <td>${r.count}</td>
        <td>${esc(r.size)}${r.weight ? `<br><span class="muted" style="font-size:11px">${esc(r.weight)}</span>` : ""}</td>
        <td>${esc(r.kept)}</td>
        <td>${esc(r.bait || r.gear)}${r.bait && r.gear ? `<br><span class="muted" style="font-size:11px">${esc(r.gear)}</span>` : ""}</td>
        <td>${esc(r.tideStage)} ${esc(r.tideHeight)}</td>
        <td>${esc(r.windDir)} ${esc(r.windSpeed)}</td>
        <td>${esc(r.weather)}</td>
        <td class="notes">${esc(r.wildlife ?? "")}</td>
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
  attachTrailSearch();
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
    case "save-offline": {
      if (!mapApi) break;
      const btn = el as HTMLButtonElement;
      const orig = btn.textContent;
      btn.disabled = true;
      try {
        const r = await mapApi.cacheVisibleArea((p) => { btn.textContent = `⬇ ${p.done}/${p.total}`; });
        toast(`Saved ${r.ok} map tiles for offline use${r.fail ? ` (${r.fail} failed)` : ""}. This area now works with no signal.`);
      } catch (err) {
        toast(`Offline save failed: ${(err as Error).message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
      break;
    }
    case "trail-toggle":
      if (trail.active) stopTrailMode();
      else await startTrailMode();
      break;
    case "trail-pause":
      pauseTrail();
      break;
    case "trail-resume":
      await resumeTrail();
      break;
    case "trail-camp": {
      if (!selfLoc) { toast("Waiting for your GPS fix - tap 📍 Find me first."); break; }
      const name = prompt("Name your base camp:", trail.baseCamp?.name || "Base camp");
      if (name == null) break;
      trail.baseCamp = { lat: selfLoc.lat, lon: selfLoc.lon, name: name.trim() || "Base camp" };
      saveTrail(trail);
      mapApi?.setTrail(trail);
      refreshTrailPanel();
      toast("Base camp set - you'll always have a bearing back to it.");
      break;
    }
    case "trail-poi": {
      if (!selfLoc) { toast("Waiting for your GPS fix - tap 📍 Find me first."); break; }
      const name = prompt("Name this spot (e.g. good pool, fallen tree, lookout):", "");
      if (name == null) break;
      trail.pois.push({ id: newId(), lat: selfLoc.lat, lon: selfLoc.lon, name: name.trim() || "Spot", emoji: "📍", t: Date.now() });
      saveTrail(trail);
      mapApi?.setTrail(trail);
      refreshTrailPanel();
      toast("Spot marked.");
      break;
    }
    case "trail-tocamp":
      if (trail.baseCamp) mapApi?.flyTo(trail.baseCamp.lat, trail.baseCamp.lon, 15);
      break;
    case "trail-view": {
      const t = trailHistory.find((x) => x.id === el.dataset.id);
      if (!t) break;
      viewingHistory = t;
      state.tab = "map";
      render(); // remounts the map with this trip; postRender fits it
      break;
    }
    case "trail-view-exit":
      viewingHistory = null;
      render();
      break;
    case "trail-img": {
      const t = trailHistory.find((x) => x.id === el.dataset.id);
      if (!t) break;
      try {
        const svg = trailMapSVG(t, { width: 1200, height: 720 });
        const blob = await svgToPngBlob(svg, 1200, 720);
        downloadBlob(`trip-map-${tripSlug(t)}.png`, blob);
        toast("Trip map image saved");
      } catch (err) {
        toast(`Image export failed: ${(err as Error).message}`);
      }
      break;
    }
    case "trail-pdf": {
      const t = trailHistory.find((x) => x.id === el.dataset.id);
      if (t) printTrailReport(t);
      break;
    }
    case "trail-del":
      trailHistory = deleteArchivedTrail(el.dataset.id!);
      if (viewingHistory && viewingHistory.id === el.dataset.id) viewingHistory = null;
      render();
      break;
    case "trail-gotopoi": {
      const p = trail.pois.find((x) => x.id === el.dataset.id);
      if (p) mapApi?.flyTo(p.lat, p.lon, 16);
      break;
    }
    case "trail-rmpoi": {
      const id = el.dataset.id;
      trail.pois = trail.pois.filter((p) => p.id !== id);
      saveTrail(trail);
      mapApi?.setTrail(trail);
      refreshTrailPanel();
      break;
    }
    case "trail-save": {
      if (!trail.points.length && !trail.pois.length && !trail.baseCamp) { toast("Nothing to save yet - start walking."); break; }
      trailHistory = archiveTrail(trail); // snapshot to history; keep recording
      refreshTrailPanel();
      toast("Trip saved to Trail History. You can keep going or clear it.");
      break;
    }
    case "trail-clear":
      if (confirm("Clear the current trip? Tap Save trip first if you want to keep it - this can't be undone.")) {
        stopTrailWatch();
        releaseWakeLock();
        presenceSetTrail(null);
        trail = emptyTrail();
        saveTrail(trail);
        startSelfWatch(); // resume the live marker if we'd frozen it while paused
        mapApi?.setTrail(trail);
        refreshTrailPanel();
        toast("Trip cleared.");
      }
      break;
    case "guild-share-toggle": {
      const id = el.dataset.id!;
      const adding = !shareWith.includes(id);
      shareWith = adding ? [...shareWith, id] : shareWith.filter((x) => x !== id);
      saveShareWith(shareWith);
      applyTrailShare();
      refreshTrailPanel();
      if (adding && !loadSharePref()) toast("Added. Turn on 📡 Share location (top of page) so your trail reaches them.");
      break;
    }
    case "guild-share-remove": {
      const id = el.dataset.id!;
      shareWith = shareWith.filter((x) => x !== id);
      saveShareWith(shareWith);
      applyTrailShare();
      refreshTrailPanel();
      break;
    }
    case "guild-goto": {
      const a = state.presence.find((m) => String(m.id) === el.dataset.id);
      if (!a) break;
      mapApi?.flyTo(a.lat, a.lon, 15);
      if (selfLoc) {
        const km = haversineKm(selfLoc.lat, selfLoc.lon, a.lat, a.lon);
        const brg = bearingDeg(selfLoc.lat, selfLoc.lon, a.lat, a.lon);
        toast(`${a.displayName}: ${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`} ${compassDir(brg)} of you.`);
      } else {
        toast(`Showing ${a.displayName} on the map.`);
      }
      break;
    }
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
      downloadText("mccormacks-catchlog.json", exportJSON(), "application/json");
      toast("Exported catch log");
      break;
    case "exportcsv":
      downloadText("mccormacks-catchlog.csv", exportCSV(), "text/csv");
      toast("Exported spreadsheet (CSV)");
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
  const location = g("location").trim();
  // tag with coordinates when the spot matches the active location (handy for mapping)
  const matchesActive = location && location === (state.location?.name ?? "");
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
    location: location || undefined,
    lat: matchesActive ? state.location.lat : undefined,
    lon: matchesActive ? state.location.lon : undefined,
    method: g("method") || undefined,
    party: g("party").trim() || undefined,
    bait: g("bait").trim() || undefined,
    weight: g("weight").trim() || undefined,
    wildlife: g("wildlife").trim() || undefined,
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

function downloadText(name: string, text: string, mime = "application/json") {
  downloadBlob(name, new Blob([text], { type: mime }));
}
function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Date-stamped, filesystem-safe name for a saved trip's exports.
function tripSlug(t: ArchivedTrail): string {
  return t.startedAt ? localDateKey(new Date(t.startedAt)) : t.id;
}

// Open a printable one-page trip sheet (route map + stats + marked spots) in a
// hidden iframe and trigger the browser's print dialog - "Save as PDF" from there.
// No PDF library needed, and it prints cleanly on mobile and desktop.
function printTrailReport(t: ArchivedTrail) {
  const when = t.startedAt ? fmtDate(new Date(t.startedAt)) : "Trip";
  const dur = (t.startedAt && t.endedAt) ? fmtDur(t.endedAt - t.startedAt) : "-";
  const km = trailLengthKm(t).toFixed(2);
  const svg = trailMapSVG(t, { width: 900, height: 560 });
  const stat = (label: string, val: string) => `<div class="st"><b>${esc(val)}</b><span>${esc(label)}</span></div>`;
  const poiRows = t.pois.map((p, i) =>
    `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</td></tr>`).join("");
  const camp = t.baseCamp
    ? `<p class="camp">⛺ Base camp: <b>${esc(t.baseCamp.name)}</b> — ${t.baseCamp.lat.toFixed(5)}, ${t.baseCamp.lon.toFixed(5)}</p>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Trip — ${esc(when)}</title>
    <style>
      *{box-sizing:border-box} body{font:14px/1.45 system-ui,Segoe UI,sans-serif;color:#23303a;margin:0;padding:24px}
      h1{font-size:20px;margin:0 0 2px} .sub{color:#6b7785;margin:0 0 14px}
      .stats{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 14px}
      .st b{display:block;font-size:18px} .st span{font-size:12px;color:#6b7785;text-transform:uppercase;letter-spacing:.4px}
      .map{border:1px solid #cfc7b4;border-radius:8px;overflow:hidden;max-width:100%} .map svg{display:block;width:100%;height:auto}
      .camp{margin:12px 0 4px}
      table{border-collapse:collapse;width:100%;margin-top:8px;font-size:13px}
      th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e3e8ee} th{color:#6b7785;font-size:11px;text-transform:uppercase}
      footer{margin-top:18px;color:#9aa6b2;font-size:11px}
      @media print{body{padding:0}}
    </style></head><body>
    <h1>Trip — ${esc(when)}</h1>
    <p class="sub">Nova Scotian Anglers Guild · trail record</p>
    <div class="stats">${stat("Duration", dur)}${stat("Distance", km + " km")}${stat("Track points", String(t.points.length))}${stat("Marked spots", String(t.pois.length))}</div>
    <div class="map">${svg}</div>
    ${camp}
    ${t.pois.length ? `<table><thead><tr><th>#</th><th>Marked spot</th><th>Coordinates</th></tr></thead><tbody>${poiRows}</tbody></table>` : ""}
    <footer>Generated ${esc(fmtDate(new Date()))} · McCormacks Fishing Analyst</footer>
  </body></html>`;

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.onload = () => {
    try {
      const win = frame.contentWindow;
      if (!win) throw new Error("print frame unavailable");
      win.focus();
      win.print();
    } catch (err) {
      toast(`PDF export failed: ${(err as Error).message}`);
    }
    setTimeout(() => frame.remove(), 1500);
  };
  document.body.appendChild(frame);
  frame.srcdoc = html;
  toast("Opening printable trip sheet — choose “Save as PDF”.");
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
