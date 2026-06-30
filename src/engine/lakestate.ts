// Freshwater stratification model - the lake equivalent of seastate.ts. NS lakes
// are dimictic: they mix top-to-bottom in spring and fall (turnover) and stratify
// in summer into a warm surface layer over a cold deep layer separated by the
// thermocline. WHERE the fish hold depends entirely on which state the lake is in,
// so this turns the surface temp (estimated live in merge.ts) + the measured
// depth/clarity (lakesurvey.ts) into a phase, a thermocline depth, and concrete
// depth advice. No API - pure physics-flavoured heuristics, honestly bounded.
import type { LakeState, LakeSurvey } from "../types";

export interface LakeStateInput {
  month: number; // 1..12
  surfaceTempC: number; // live-ish estimate from recent air temp (merge.ts)
  survey: LakeSurvey | null;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// Pull an explicit thermocline depth out of the survey's free-text field if it
// states one (e.g. "5", "5 m", "thermocline at 6m"); otherwise null.
function notedThermocline(note: string | null): number | null {
  if (!note) return null;
  const m = note.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = Number(m[1]);
  return isFinite(v) && v > 1 && v < 60 ? v : null;
}

const LABELS: Record<LakeState["phase"], string> = {
  ice: "Iced / very cold",
  cold: "Cold water",
  "spring-turnover": "Spring turnover",
  stratified: "Summer stratified",
  "fall-turnover": "Fall turnover",
  mixed: "Mixed / unstratified",
};

export function buildLakeState(input: LakeStateInput): LakeState {
  const { month, survey } = input;
  const surf = +input.surfaceTempC.toFixed(1);
  const maxDepth = survey?.maxDepthM ?? null;
  const secchi = survey?.secchiM ?? null;
  const measured = maxDepth != null;
  // Lakes shallower than ~6 m don't hold a stable summer thermocline (wind keeps
  // them mixed) - they're polymictic and relate to weed/structure all season.
  const shallow = maxDepth != null && maxDepth < 6;

  // --- phase ---
  let phase: LakeState["phase"];
  if (surf <= 4 && (month === 12 || month <= 3)) phase = surf < 1.5 ? "ice" : "cold";
  else if (surf < 6) phase = "cold";
  else if (month >= 4 && month <= 5) phase = "spring-turnover";
  else if (month >= 6 && month <= 9 && surf >= 18 && !shallow) phase = "stratified";
  else if (month >= 10 && month <= 11) phase = "fall-turnover";
  else phase = "mixed";

  const stratified = phase === "stratified";

  // --- thermocline depth (only meaningful when stratified) ---
  let thermoclineDepthM: number | null = null;
  if (stratified) {
    const noted = notedThermocline(survey?.thermoclineNote ?? null);
    if (noted != null) {
      thermoclineDepthM = noted;
    } else {
      // Clearer + deeper lakes set up a deeper thermocline; small/stained ones a
      // shallow one. Bounded to fit the lake (always above the bottom).
      const base = 4 + 0.5 * (secchi ?? 2.5) + 0.12 * (maxDepth ?? 10);
      const cap = maxDepth != null ? Math.max(3, maxDepth - 1) : 12;
      thermoclineDepthM = +clamp(base, 3, Math.min(12, cap)).toFixed(0);
    }
  }

  // --- depth advice + score ---
  const lowO2 = (survey?.bottomDO ?? 99) < 4; // anoxic deep basin in late summer
  const notes: string[] = [];
  let targetDepth: string;
  let score: number;

  if (phase === "ice") {
    targetDepth = "Hard water / near-freezing: fish are deep and slow over the basin. Small jigs/bait near bottom, midday best.";
    score = 40;
  } else if (phase === "cold") {
    targetDepth = "Cold water: fish are sluggish and usually deep near the basin and drop-offs. Slow presentations, midday warmth helps.";
    score = 52;
  } else if (phase === "spring-turnover") {
    targetDepth = "Whole water column is mixed and oxygenated - fish are shallow and feeding. Cover water on shoals, points and warming bays.";
    notes.push("Spring: shallow dark-bottom bays warm first and pull baitfish and trout.");
    score = 74;
  } else if (phase === "fall-turnover") {
    targetDepth = "Turnover: the lake is re-mixing top to bottom, fish can be scattered shallow to mid-depth. Big fall fish feed up before winter - run and gun.";
    notes.push("Right after turnover can be tough for a few days; then it's some of the best fishing of the year.");
    score = 70;
  } else if (stratified) {
    const zt = thermoclineDepthM ?? 6;
    targetDepth = `Stratified: a thermocline sits around ${zt} m. Cool-water fish (trout, togue, salmon) stack just above it on drop-offs; warm-water fish (bass, pickerel, perch) work the shallows and weed edges at dawn/dusk and slide deeper midday.`;
    notes.push(`Thermocline ~${zt} m: that band is the cool, oxygenated sweet spot - target the contour where the bottom crosses it.`);
    if (lowO2) notes.push("Survey shows low oxygen in the deep basin - fish won't hold below the thermocline, so don't fish the very bottom in the deep water.");
    if (surf >= 24) { notes.push("Hot surface: midday topwater is slow. Fish early/late shallow or down at the thermocline through the day."); score = 50; }
    else score = 62;
  } else {
    // mixed / shallow polymictic
    targetDepth = shallow
      ? "Shallow lake (no stable thermocline): fish relate to weed beds, wood, rocky shoals and inflows right through the column."
      : "Largely mixed: fish the structure - points, shoals, weed edges and inflows - across a range of depths.";
    score = 64;
  }

  if (secchi != null) {
    if (secchi < 1.5) notes.push(`Stained/turbid water (Secchi ${secchi.toFixed(1)} m): fish shallower and use dark or high-vis, high-vibration baits.`);
    else if (secchi > 4) notes.push(`Very clear water (Secchi ${secchi.toFixed(1)} m): fish hold deeper and spook easily - go natural colours, longer leaders, low light.`);
  }
  if ((survey?.ph ?? 7) < 5.5) notes.push(`Acidic, tea-stained lake (pH ${survey?.ph?.toFixed(1)}): expect a thinner fishery skewed to acid-tolerant brook trout, perch and pickerel.`);

  const label = LABELS[phase];
  return {
    phase, label, surfaceTempC: surf, maxDepthM: maxDepth, measured,
    stratified, thermoclineDepthM, targetDepth, clarityM: secchi,
    score: Math.round(score), notes,
  };
}

export function lakeActivityLabel(score: number): "slow" | "fair" | "good" | "prime" {
  return score >= 72 ? "prime" : score >= 60 ? "good" : score >= 50 ? "fair" : "slow";
}
