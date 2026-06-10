// Mathematically-grounded sea-state model.
//
// Turns the real marine forecast (significant/ swell/ wind-wave height, period &
// direction + ocean current + optional depth) into a set of DETERMINISTIC wave
// components via the linear dispersion relation, plus a 0-100 sea-condition
// score. Nothing here is random except a fixed per-component phase offset so the
// rendered surface does not visibly tile (amplitude, wavelength, frequency and
// direction are all physical). See `src/ui/flow.ts` for how the components drive
// the animation.

const G = 9.81; // m/s^2

export interface SeaStateInput {
  waveHeight: number | null;     // Hs total significant wave height, m
  wavePeriod: number | null;     // Tp total peak/mean period, s
  waveDir: number | null;        // deg the waves come FROM
  swellHeight: number | null;
  swellPeriod: number | null;
  swellDir: number | null;       // deg FROM
  windWaveHeight: number | null;
  windWavePeriod: number | null;
  windWaveDir: number | null;    // deg FROM
  currentSpeed: number | null;   // m/s
  currentDir: number | null;     // deg the current flows TO
  depth: number | null;          // m (positive down); null => deep water
}

// One deterministic monochromatic wave component (everything in SI + a unit
// screen-space travel vector so the renderer can use it directly).
export interface WaveComponent {
  amp: number;       // amplitude a, m  (height = 2a)
  k: number;         // wave number, rad/m
  L: number;         // wavelength, m
  omega: number;     // intrinsic angular frequency, rad/s
  omegaApp: number;  // apparent (current-Doppler-shifted) angular frequency, rad/s
  dx: number; dy: number; // unit TRAVEL direction in screen space (x east, y south)
  phase0: number;    // stable phase offset, rad
  steepness: number; // a*k
}

export type SeaLabel = "calm" | "moderate" | "rough" | "dangerous";

export interface SeaState {
  components: WaveComponent[];
  hs: number;        // representative significant height, m
  tp: number;        // representative period, s
  steepness: number; // characteristic sea steepness 2*pi*Hs/(g*Tp^2)
  current: { speed: number; dx: number; dy: number }; // m/s + unit screen vector (flow TO)
  depth: number | null;
  breaking: boolean;
  score: number;     // 0..100
  label: SeaLabel;
  notes: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const rad = (deg: number) => (deg * Math.PI) / 180;

// Compass bearing (0=N, 90=E) -> unit vector in screen space (x east, y south).
function compassVec(deg: number): { x: number; y: number } {
  const r = rad(deg);
  return { x: Math.sin(r), y: -Math.cos(r) };
}

// Stable, deterministic phase in [0, 2pi) from a small integer seed. This is the
// ONLY randomness in the model - it just de-correlates components so the surface
// does not look like one repeating sinusoid.
function stablePhase(seed: number): number {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return (s - Math.floor(s)) * Math.PI * 2;
}

// Solve the linear dispersion relation omega^2 = g k tanh(k h) for k (rad/m).
// Newton iteration seeded with the deep-water solution k0 = omega^2/g. Returns
// the deep-water value when depth is unknown or effectively infinite.
export function solveWaveNumber(omega: number, depth: number | null): number {
  const k0 = (omega * omega) / G; // deep water
  if (depth == null || !isFinite(depth) || depth <= 0 || k0 * depth > 12) return k0;
  let k = k0;
  for (let i = 0; i < 32; i++) {
    const th = Math.tanh(k * depth);
    const f = G * k * th - omega * omega;
    const df = G * th + G * k * depth * (1 - th * th); // d/dk
    const kn = k - f / df;
    if (!isFinite(kn) || kn <= 0) break;
    if (Math.abs(kn - k) < 1e-9) { k = kn; break; }
    k = kn;
  }
  return k;
}

// Spread one wave SYSTEM (a height/period/from-direction) into `n` deterministic
// components with slightly varied period and direction, distributing the energy
// so the surface-elevation variance matches sigma^2 = (Hs/4)^2.
function spreadSystem(
  hs: number, period: number, dirFrom: number, depth: number | null,
  current: { speed: number; dx: number; dy: number }, seedBase: number, n = 3,
): WaveComponent[] {
  const sigma = hs / 4; // elevation std-dev for this system
  const travel = dirFrom + 180; // waves come FROM dirFrom, so they travel toward +180
  const periodFactors = [0.88, 1.0, 1.14];
  const dirOffsets = [-13, 0, 13]; // degrees of directional spread
  const weights = [0.85, 1.0, 0.85];
  const wNorm = Math.sqrt(weights.reduce((s, w) => s + w * w, 0));
  const out: WaveComponent[] = [];
  for (let i = 0; i < n; i++) {
    const T = period * periodFactors[i];
    const omega = (2 * Math.PI) / T;
    const k = solveWaveNumber(omega, depth);
    const v = compassVec(travel + dirOffsets[i]);
    // a_i so that sum(a_i^2 / 2) = sigma^2
    const amp = sigma * weights[i] * Math.sqrt(2) / wNorm;
    // apparent frequency: omega + k (U . d)
    const omegaApp = omega + k * current.speed * (current.dx * v.x + current.dy * v.y);
    out.push({ amp, k, L: (2 * Math.PI) / k, omega, omegaApp, dx: v.x, dy: v.y, phase0: stablePhase(seedBase + i), steepness: amp * k });
  }
  return out;
}

// Build the full sea state from the raw marine numbers.
export function buildSeaState(input: SeaStateInput): SeaState {
  const notes: string[] = [];
  const depth = input.depth != null && input.depth > 0 ? input.depth : null;
  const current = (() => {
    if (input.currentSpeed != null && input.currentSpeed > 0 && input.currentDir != null) {
      const v = compassVec(input.currentDir); // current dir is TO
      return { speed: input.currentSpeed, dx: v.x, dy: v.y };
    }
    return { speed: 0, dx: 0, dy: 0 };
  })();

  // Prefer the swell + wind-wave split (two real systems); fall back to the total
  // sea, then to nothing.
  const components: WaveComponent[] = [];
  const haveSwell = (input.swellHeight ?? 0) > 0.01 && (input.swellPeriod ?? 0) > 0;
  const haveWind = (input.windWaveHeight ?? 0) > 0.01 && (input.windWavePeriod ?? 0) > 0;
  if (haveSwell) {
    components.push(...spreadSystem(input.swellHeight!, input.swellPeriod!, input.swellDir ?? input.waveDir ?? 0, depth, current, 11));
  }
  if (haveWind) {
    components.push(...spreadSystem(input.windWaveHeight!, input.windWavePeriod!, input.windWaveDir ?? input.waveDir ?? 0, depth, current, 41));
  }
  if (!haveSwell && !haveWind && (input.waveHeight ?? 0) > 0.01 && (input.wavePeriod ?? 0) > 0) {
    components.push(...spreadSystem(input.waveHeight!, input.wavePeriod!, input.waveDir ?? 0, depth, current, 71));
    notes.push("Single combined sea (no swell/wind-wave split available).");
  }

  // Representative height & period for scoring.
  const hs = input.waveHeight ?? Math.hypot(input.swellHeight ?? 0, input.windWaveHeight ?? 0);
  const tp = input.wavePeriod ?? input.swellPeriod ?? input.windWavePeriod ?? 0;
  const steepness = tp > 0 ? (2 * Math.PI * hs) / (G * tp * tp) : 0; // deep-water characteristic steepness

  const { score, label, breaking, scoreNotes } = scoreSeaState(hs, steepness, components, current, depth);
  notes.push(...scoreNotes);
  return { components, hs, tp, steepness, current, depth, breaking, score, label, notes };
}

// 0-100 sea-condition score with a calm/moderate/rough/dangerous label.
function scoreSeaState(
  hs: number, steepness: number, components: WaveComponent[],
  current: { speed: number; dx: number; dy: number }, depth: number | null,
): { score: number; label: SeaLabel; breaking: boolean; scoreNotes: string[] } {
  const notes: string[] = [];

  // 1) Height is the dominant term (0 at flat, ~maxed near 3 m Hs).
  let s = clamp(hs / 3, 0, 1) * 55;

  // 2) Steepness: short, steep wind-seas are nastier than long swell of equal Hs.
  //    Wind-sea steepness ~0.04-0.06; >0.06 is steep/whitecapping.
  s += clamp(steepness / 0.06, 0, 1) * 18;
  if (steepness > 0.055) notes.push("Short, steep seas (whitecapping likely).");

  // 3) Opposing current steepens and shortens waves (wave-against-tide chop).
  let opposing = false;
  if (current.speed > 0.05 && components.length) {
    const d = components[0]; // dominant component travel direction
    const dot = current.speed * (current.dx * d.dx + current.dy * d.dy);
    if (dot < 0) { // current flows against wave travel
      opposing = true;
      s += clamp((-dot) * hs * 1.2, 0, 1) * 15;
      notes.push("Current opposing the swell - expect steeper, shorter chop.");
    }
  }

  // 4) Shallow-water / breaking risk: waves break when H ~ 0.78*depth.
  let depthBreak = false;
  if (depth != null && depth > 0 && hs > 0) {
    const ratio = hs / depth;
    if (ratio > 0.4) { s += clamp((ratio - 0.4) / 0.4, 0, 1) * 12; }
    if (ratio > 0.6) { depthBreak = true; notes.push("Shallow water - waves breaking near the bottom."); }
  }

  const score = Math.round(clamp(s, 0, 100));
  const breaking = depthBreak || steepness > 0.062 || (opposing && hs > 1.5);
  const label: SeaLabel = score < 20 ? "calm" : score < 45 ? "moderate" : score < 70 ? "rough" : "dangerous";
  return { score, label, breaking, scoreNotes: notes };
}
