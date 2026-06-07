import type { DayAstro } from "../types";

const SYNODIC = 29.530588853; // days
// Reference new moon: 2000-01-06 18:14 UTC
const REF_NEW = Date.UTC(2000, 0, 6, 18, 14, 0) / 86400000; // in days

function moonAgeDays(date: Date): number {
  const d = date.getTime() / 86400000;
  let age = (d - REF_NEW) % SYNODIC;
  if (age < 0) age += SYNODIC;
  return age;
}

export function moonInfo(date: Date): { phase: number; illum: number; name: string } {
  const age = moonAgeDays(date);
  const phase = age / SYNODIC; // 0..1
  // illumination fraction
  const illum = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  const name = phaseName(phase);
  return { phase, illum: Math.round(illum * 100), name };
}

function phaseName(phase: number): string {
  const p = phase * 8;
  if (p < 0.5 || p >= 7.5) return "New Moon";
  if (p < 1.5) return "Waxing Crescent";
  if (p < 2.5) return "First Quarter";
  if (p < 3.5) return "Waxing Gibbous";
  if (p < 4.5) return "Full Moon";
  if (p < 5.5) return "Waning Gibbous";
  if (p < 6.5) return "Last Quarter";
  return "Waning Crescent";
}

// Spring tides near new/full moon, neap near quarters.
export function tideStrengthFromMoon(phase: number): DayAstro["tideStrength"] {
  // distance from nearest syzygy (0 or 0.5) in cycle units 0..0.25
  const distNew = Math.min(phase, 1 - phase);
  const distFull = Math.abs(phase - 0.5);
  const d = Math.min(distNew, distFull); // 0 at spring, 0.25 at neap
  if (d < 0.06) return "spring";
  if (d < 0.13) return "strong";
  if (d < 0.2) return "moderate";
  return "neap";
}

export function moonEmoji(phase: number): string {
  const icons = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
  return icons[Math.round(phase * 8) % 8];
}
