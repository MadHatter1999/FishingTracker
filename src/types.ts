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
  waveHeight: number | null; // m
  swellHeight: number | null; // m
  swellPeriod: number | null; // s
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
}

export interface Bundle {
  location: FishingLocation;
  hours: HourPoint[];
  tide: TideData;
  astro: DayAstro[];
  predators: TaggedAnimal[]; // named tagged animals (OCEARCH)
  stocking?: StockingInfo | null; // provincial stocking history (freshwater)
  fetchedAt: Date;
  warnings: string[];
}
