// ---- Shared domain types ----

export interface HourPoint {
  time: Date;
  airTemp: number; // °C
  humidity: number; // %
  pressure: number; // hPa (msl)
  pressureTrend: number; // hPa over previous 3h (signed)
  cloud: number; // %
  windSpeed: number; // km/h
  windDir: number; // deg FROM
  windGust: number; // km/h
  precip: number; // mm
  weatherCode: number; // WMO
  waveHeight: number | null; // Hs total, m
  wavePeriod: number | null; // s
  waveDir: number | null; // deg FROM
  swellHeight: number | null; // m
  swellPeriod: number | null; // s
  swellDir: number | null; // deg FROM
  windWaveHeight: number | null; // m
  windWavePeriod: number | null; // s
  windWaveDir: number | null; // deg FROM
  currentVelocity: number | null; // km/h (ocean current, Open-Meteo)
  currentDir: number | null; // deg TO
  waterTemp: number | null; // °C (sea surface)
  // tide (interpolated onto this hour)
  tideHeight: number | null; // m
  tideVelocity: number | null; // m/h signed (+rising)
  tideState: TideState;
}

export type TideState = "rising" | "falling" | "high-slack" | "low-slack" | "unknown";

export interface TideExtreme {
  time: Date;
  type: "high" | "low";
  height: number; // m
}

export interface TideData {
  series: { time: Date; height: number }[];
  extremes: TideExtreme[];
  live: boolean; // true if from IWLS, false if approximated
  stationName: string;
  meanRange: number; // m, computed from extremes
}

export interface DayAstro {
  date: string; // yyyy-mm-dd (local)
  sunrise: Date | null;
  sunset: Date | null;
  moonPhase: number; // 0..1 (0 new, 0.5 full)
  moonIllum: number; // 0..100 %
  moonName: string;
  tideStrength: "spring" | "strong" | "moderate" | "neap"; // from moon
}

export interface ScoredHour {
  time: Date;
  score: number; // 0..10
  reasons: string[];
  factors: Record<string, number>; // factor -> contribution
}

export interface FishingWindow {
  start: Date;
  end: Date;
  peak: Date;
  score: number;
  reason: string;
}

export interface SpeciesForecast {
  key: string;
  name: string;
  emoji: string;
  encounter: number; // %
  catch: number; // %
  bestWindow: string;
  bestLocation: string;
  rig: string;
  bait: string;
  size: string;
  eating: number; // 1..10
  legal: string; // retention note
  legalFlag: "keep" | "release" | "check";
  notes: string;
  stocked?: boolean; // recently stocked here (NS hatchery program)
}

// Provincial fish-stocking history for a waterbody (NS open data).
export interface StockingEntry {
  species: string;
  number: number;
  date: string; // yyyy-mm-dd
}
export interface StockingInfo {
  waterbody: string; // matched dataset name
  records: StockingEntry[]; // recent, newest first
  bySpecies: { species: string; total: number; latest: string }[];
  latest: string | null; // ISO date of most recent stocking
  recentlyStocked: boolean; // within ~12 weeks
}

// --- Freshwater: live river/stream/lake level + flow (Environment Canada) ---
export interface HydroPoint {
  time: string; // ISO
  level: number | null; // m (gauge datum)
  discharge: number | null; // m3/s
}
export interface HydroInfo {
  stationName: string;
  stationNumber: string;
  distanceKm: number;
  kind: "river" | "lake"; // discharge present -> moving water; level-only -> lake gauge
  latest: HydroPoint;
  series: HydroPoint[]; // recent (downsampled) for a sparkline / trend
  levelTrend: "rising" | "falling" | "steady";
  dischargeTrend: "rising" | "falling" | "steady";
  flowSignal: number; // 0..1 "how much moving water right now" - drives fresh hotspot scoring
}

// --- Freshwater: NS Environment Lake Survey morphometry (measured, historical) ---
export interface LakeSurvey {
  lakeName: string;
  maxDepthM: number | null;
  meanDepthM: number | null;
  secchiM: number | null; // water clarity (Secchi disk)
  thermoclineNote: string | null; // survey thermocline field (raw)
  surfaceTempC: number | null; // survey-day reading (NOT live)
  bottomDO: number | null; // bottom dissolved oxygen mg/L
  ph: number | null;
  colourTCU: number | null; // water colour (bog-stained vs clear)
  assessed: string | null; // ISO date the lake was surveyed
  distanceKm: number;
  stationCount: number; // survey stations matched to this lake
}
// --- Freshwater: modelled lake stratification state (the freshwater "sea state") ---
export interface LakeState {
  phase: "ice" | "cold" | "spring-turnover" | "stratified" | "fall-turnover" | "mixed";
  label: string;
  surfaceTempC: number;
  maxDepthM: number | null;
  measured: boolean; // depth came from a real survey vs estimated
  stratified: boolean;
  thermoclineDepthM: number | null;
  targetDepth: string; // where the fish are holding + how to fish it
  clarityM: number | null;
  score: number; // 0..100 comfort/activity proxy
  notes: string[];
}

export interface Hotspot {
  name: string;
  rank: number;
  score: number; // 0..10
  why: string;
  bestFor: string[];
}

export interface CatchRecord {
  id: string;
  date: string; // yyyy-mm-dd
  start: string; // HH:MM
  end: string; // HH:MM
  tideStage: string;
  tideHeight: string;
  windDir: string;
  windSpeed: string;
  weather: string;
  water: string;
  species: string;
  count: number;
  size: string;
  kept: "kept" | "released" | "mixed";
  gear: string;
  notes: string;
  // auto-captured snapshot
  moonPhase?: string;
  waterTemp?: string;
  // ---- trip context (all optional; a full record of the day) ----
  location?: string; // spot fished (free text, defaults to active location)
  lat?: number; // captured from the active location when it matches
  lon?: number;
  method?: string; // Shore / Boat / Kayak / Pier / Fly
  party?: string; // who you fished with
  // ---- catch & wildlife detail ----
  bait?: string; // bait / lure used (e.g. "mackerel strip", "white grub")
  weight?: string; // approx weight (total or biggest fish)
  wildlife?: string; // other animals seen (seals, eagles, sharks, whales…)
}

// A catch-log trip with its owner, for the admin cross-member view (Firebase).
export interface MemberTrip extends CatchRecord {
  userId: string | number;
  displayName: string;
}

export interface FishingLocation {
  id: string; // "home" or IWLS station id
  name: string;
  area: string;
  lat: number;
  lon: number;
  tideStationId: string;
  tideStationName: string;
  home: boolean;
  kind: "salt" | "fresh"; // saltwater (tides) vs freshwater lake/river
  brackish?: boolean; // freshwater that meets the sea (estuary) - some sea fish possible
  saved?: boolean; // user-created favourite
}

// A named, satellite-tagged animal (OCEARCH) at its most recent ping.
export interface TaggedAnimal {
  id: string;
  name: string;
  species: string; // common name
  sci: string; // scientific name
  emoji: string;
  lat: number;
  lon: number;
  lastPing: string | null; // ISO date of last transmission
  length: string | null;
  weight: string | null;
  gender: string | null;
  stage: string | null;
  tagLocation: string | null;
  image: string | null;
  url: string | null;
}

// A guild member account (Nova Scotian Anglers Guild).
// id is a number for the Node/SQLite backend, a string (uid) for Firebase.
export interface GuildUser {
  id: string | number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  color: string; // hook colour on the map
  createdAt: string;
  online?: boolean; // present in admin user list
  active?: boolean; // false = disabled (locked out) - Firebase free-tier soft delete
}

// A guild member's live shared position (only present while they share).
export interface AnglerPresence {
  id: string | number;
  username: string;
  displayName: string;
  color: string;
  lat: number;
  lon: number;
  updatedAt: string | null;
  // Downsampled recent breadcrumb shared while the member is in Trail mode, drawn
  // as their "Indiana Jones" path. Absent/empty when not hiking.
  trail?: { lat: number; lon: number }[];
  // Member ids this person has chosen to share their trail with (one-way). A
  // viewer draws this trail only if their own id is in here.
  shareWith?: (string | number)[];
}

// A species documented near a location (OBIS "what's where").
export interface OccTaxon {
  sci: string;
  common: string | null;
  group: "shark" | "ray" | "fish";
  emoji: string;
  records: number;
}

export interface Bundle {
  location: FishingLocation;
  hours: HourPoint[];
  tide: TideData;
  astro: DayAstro[];
  predators: TaggedAnimal[]; // named tagged animals (OCEARCH)
  landPredators?: LandSighting[]; // recent land-predator sightings near here (iNaturalist)
  nearbyTaxa?: OccTaxon[]; // species documented near here (OBIS, marine) - "what's where"
  stocking?: StockingInfo | null; // provincial stocking history (freshwater)
  hydro?: HydroInfo | null; // live river/stream/lake level + flow (freshwater)
  lakeSurvey?: LakeSurvey | null; // measured lake morphometry/clarity (freshwater)
  fetchedAt: Date;
  warnings: string[];
}

// A recent land-predator sighting (bear/coyote/bobcat/lynx/fox) from iNaturalist.
// These are OBSERVATIONS (where an animal was seen + recorded), NOT live tracking.
export interface LandSighting {
  species: string; // scientific name
  common: string; // display common name
  emoji: string;
  lat: number;
  lon: number;
  observedOn: string | null; // ISO date the animal was seen
  obscured: boolean; // iNaturalist randomised the location (sensitive taxon) -> approximate
  place: string | null;
  photo: string | null;
  url: string | null; // iNaturalist observation page
}
