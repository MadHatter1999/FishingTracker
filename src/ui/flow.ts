import L from "leaflet";
import type { WaveComponent } from "../engine/seastate";

// A modelled tidal-stream visualisation: an animated canvas particle field that
// drifts in the flood/ebb direction with a speed set by the live tidal velocity.
// The MAGNITUDE and the flood/ebb REVERSAL are real (taken from the tide curve);
// the compass direction is the indicative local tidal axis, not a measured
// current map (honest label lives in the layer attribution).
//
// The field is clipped to open water using NASA GIBS OSM_Land_Mask tiles (land =
// opaque, water = transparent, static, CORS *). We only composite the mask,
// never read its pixels, so cross-origin tainting is a non-issue. Past the mask's
// native zoom the clip is feathered so the coastline stays smooth instead of
// stair-stepping into squares. Streaks carry their own dark outline + bright core
// so they read over the water without tinting/darkening the map underneath.

export interface TidalFlow {
  speed01: number; // 0..1 strength of the tidal stream (0 = slack, 1 = strong mid-tide)
  phase: "flood" | "ebb" | "slack";
  bearingDeg: number; // compass bearing the water is moving TOWARD
}

export interface FlowLayer extends L.Layer {
  setFlow(flow: TidalFlow | null): void;
  setWaves(components: WaveComponent[] | null): void;
  setWind(speedKmh: number | null, dirFromDeg: number | null): void;
}

// Particle: `bx/by` is the mean position (advected by the current); `x/y` is the
// rendered position = mean + wave orbital displacement.
interface Particle { x: number; y: number; bx: number; by: number; age: number; max: number; }

// A wave component reduced to what the renderer needs (pixel-space spatial
// frequency + screen amplitude, real apparent temporal frequency & direction).
interface RenderWave { kpx: number; ampPx: number; omegaApp: number; dx: number; dy: number; phase0: number; }

const FLOOD_COLOR = "#5ce4f5"; // bright cyan - water flooding in
const EBB_COLOR = "#ffb066"; // warm amber - water ebbing out
const SLACK_COLOR = "#9fb6c4"; // muted - barely moving
const OUTLINE = "#03131d"; // dark edge so streaks read on pale water

const MASK_URL = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/OSM_Land_Mask/default/GoogleMapsCompatible_Level9";
const MASK_MAXZOOM = 9; // native max zoom of the OSM land mask
const TILE = 256;

interface MaskTile { x: number; y: number; img: HTMLImageElement; }

// --- SST-gradient current field ---------------------------------------------
// At ocean scale the meaningful "current" is the large-scale circulation, which
// the sea-surface-temperature field reveals (the Gulf Stream is a warm tongue
// with a sharp thermal front). Geostrophic surface currents run ALONG the
// isotherms with the warm water on their right (Northern Hemisphere) and are
// strongest where the temperature gradient is steepest. We read the GIBS MUR SST
// tiles (CORS *, so pixel readback is allowed), take the gradient, and steer the
// flow from it. Above SST_FLOW_MAXZOOM the field is too coarse/local and we fall
// back to the tidal/laminar flow.
const SST_DATE = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
const SST_URL = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature/default/${SST_DATE}/GoogleMapsCompatible_Level7`;
const SST_MAXNATIVE = 7;
const SST_FLOW_MAXZOOM = 11; // above this: tidal/laminar flow only
const SST_GRID = 16; // px step of the gradient grid
const SST_FLIP = 1; // orientation sign of the warm-on-right rule
const SST_GREF = 42; // warmth-gradient magnitude that counts as a "full" front
const SST_MIN_PX = 0.8; // flow speed along a weak front, px/frame
const SST_SPAN_PX = 2.9; // extra speed at a strong front

// `str` = front strength (~|grad T|); `amp` = visual intensity A = a*F_T + c*|vort|
// (where streaks should be denser/brighter); vx/vy = unit current direction.
interface SstField { step: number; cols: number; rows: number; vx: Float32Array; vy: Float32Array; str: Float32Array; amp: Float32Array; }

// shortest-arc angle interpolation
function angLerp(a0: number, a1: number, t: number): number {
  let d = a1 - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a0 + d * t;
}

// Feather radius (px) for the coastline clip once we overzoom the z9 mask.
const featherFor = (zoom: number) => Math.max(0, Math.min(14, (zoom - MASK_MAXZOOM) * 2));

// Laminar flow field: a few low-frequency sinusoids summed into a smooth scalar,
// used to gently BEND the flow direction across space so streamlines curve like
// a real ocean current instead of marching in one straight line. Deterministic
// (fixed phases) and slowly time-evolving - coherent, not the old per-particle
// jitter. Wavelengths are in screen px; `sp` is rad/s temporal drift.
const FLOW_OCTAVES = [
  { wl: 560, amp: 1.0, phase: 0.6, sp: 0.035 },
  { wl: 320, amp: 0.55, phase: 2.3, sp: 0.06 },
  { wl: 195, amp: 0.30, phase: 4.1, sp: 0.09 },
].map((o) => ({ ...o, f: (2 * Math.PI) / o.wl }));
const FLOW_AMP_SUM = FLOW_OCTAVES.reduce((s, o) => s + o.amp, 0);
const MAX_BEND = 0.9; // radians of max streamline curvature

// Smooth signed bend angle (radians) at a screen position & time. The two octave
// orientations (here x-ish and y-ish via alternating axes) keep it 2-D so the
// streamlines swirl gently rather than ripple along one axis.
function flowBend(x: number, y: number, t: number): number {
  let n = 0;
  for (let i = 0; i < FLOW_OCTAVES.length; i++) {
    const o = FLOW_OCTAVES[i];
    const arg = i % 2 === 0 ? o.f * x + o.f * 0.6 * y : o.f * 0.6 * x - o.f * y;
    n += o.amp * Math.sin(arg + o.phase + o.sp * t);
  }
  return (n / FLOW_AMP_SUM) * MAX_BEND;
}

class TidalFlowLayer extends L.Layer implements FlowLayer {
  private map: L.Map | null = null;
  private canvas: HTMLCanvasElement | null = null; // animated streaks (screen-fixed)
  private ctx: CanvasRenderingContext2D | null = null;
  private maskC: HTMLCanvasElement | null = null; // seamless off-screen land mask
  private mctx: CanvasRenderingContext2D | null = null;
  private particles: Particle[] = [];
  private segs = new Float32Array(0);
  private segsHot = new Float32Array(0); // segments on strong fronts/eddies (extra-bright pass)
  private raf = 0;
  private cur: TidalFlow = { speed01: 0, phase: "slack", bearingDeg: 0 };
  private target: TidalFlow | null = null;
  private waves: RenderWave[] = [];
  private waveDrift = { x: 0, y: 0 }; // small Stokes-like drift along the swell, px/frame
  private ekman = { x: 0, y: 0 }; // wind-driven Ekman surface drift, px/frame
  private dpr = 1;
  private maskZ = MASK_MAXZOOM;
  private maskTiles: MaskTile[] = [];
  private imgCache = new Map<string, HTMLImageElement>();
  // SST-gradient current field
  private sstC: HTMLCanvasElement | null = null;
  private sstCtx: CanvasRenderingContext2D | null = null;
  private sstTiles: MaskTile[] = [];
  private sstCache = new Map<string, HTMLImageElement>();
  private sstField: SstField | null = null;
  private sstZ = SST_MAXNATIVE;
  private sstDirty = false;
  private sstTainted = false; // pixel readback blocked -> give up on SST steering
  private onResize = () => { this.resize(); this.rebuildMask(); this.rebuildSst(); };
  private onView = () => { this.rebuildMask(); this.rebuildSst(); };
  private onVis = () => { if (document.hidden) this.stop(); else this.start(); };

  getAttribution(): string {
    return "Tidal flow: modelled from tide phase | land mask &copy; OpenStreetMap (NASA GIBS)";
  }

  onAdd(map: L.Map): this {
    this.map = map;
    if (!map.getPane("tidalflow")) {
      const pane = map.createPane("tidalflow");
      pane.style.zIndex = "250";
      pane.style.pointerEvents = "none";
    }
    const pane = map.getPane("tidalflow")!;
    this.canvas = this.mkCanvas(pane);
    this.ctx = this.canvas.getContext("2d");
    this.maskC = document.createElement("canvas");
    this.mctx = this.maskC.getContext("2d");
    this.sstC = document.createElement("canvas");
    this.sstCtx = this.sstC.getContext("2d", { willReadFrequently: true });
    this.resize();
    this.rebuildMask();
    this.rebuildSst();
    map.on("resize", this.onResize);
    map.on("moveend zoomend", this.onView);
    document.addEventListener("visibilitychange", this.onVis);
    if (!document.hidden) this.start();
    return this;
  }

  onRemove(map: L.Map): this {
    this.stop();
    map.off("resize", this.onResize);
    map.off("moveend zoomend", this.onView);
    document.removeEventListener("visibilitychange", this.onVis);
    this.canvas?.remove();
    this.canvas = this.ctx = this.maskC = this.mctx = this.sstC = this.sstCtx = null as never;
    this.map = null; this.particles = []; this.maskTiles = []; this.imgCache.clear();
    this.sstTiles = []; this.sstCache.clear(); this.sstField = null;
    return this;
  }

  setFlow(flow: TidalFlow | null): void {
    this.target = flow;
    if (flow) { this.cur.bearingDeg = flow.bearingDeg; this.cur.phase = flow.phase; }
  }

  // Convert the physical wave components into pixel-space render waves. Direction,
  // (apparent) frequency and the relative wavelength/energy between components are
  // physical; only the absolute on-screen wavelength & amplitude are scaled to be
  // visible (true ~50-300 m wavelengths are sub-pixel on a km-wide map).
  setWaves(components: WaveComponent[] | null): void {
    const cs = components ?? [];
    if (!cs.length) { this.waves = []; this.waveDrift = { x: 0, y: 0 }; return; }
    const lMax = Math.max(...cs.map((c) => c.L));
    const aMax = Math.max(...cs.map((c) => c.amp));
    const variance = cs.reduce((s, c) => s + (c.amp * c.amp) / 2, 0);
    const hsEff = 4 * Math.sqrt(variance);
    const energy01 = Math.max(0, Math.min(1, hsEff / 2.5));
    const ampScale = 2.5 + 7 * energy01; // px orbit radius of the strongest component
    this.waves = cs.map((c) => {
      const Lpx = Math.max(55, Math.min(240, (c.L / lMax) * 150));
      return {
        kpx: (2 * Math.PI) / Lpx,
        ampPx: (c.amp / aMax) * ampScale,
        omegaApp: c.omegaApp,
        dx: c.dx, dy: c.dy, phase0: c.phase0,
      };
    });
    // Energy-weighted mean travel direction -> a small net drift so the swell
    // visibly travels even at slack water (Stokes drift is along wave travel).
    let mdx = 0, mdy = 0;
    for (const c of cs) { const wgt = c.amp * c.amp; mdx += wgt * c.dx; mdy += wgt * c.dy; }
    const mlen = Math.hypot(mdx, mdy) || 1;
    const driftPx = 1.0 * energy01;
    this.waveDrift = { x: (mdx / mlen) * driftPx, y: (mdy / mlen) * driftPx };
  }

  // Wind-driven Ekman surface drift: stress tau ~ |W|*W, surface transport is
  // 90 deg to the RIGHT of the wind in the Northern Hemisphere -> u_E ~ (tau_y,
  // -tau_x). We keep the physical direction and scale the magnitude to px/frame.
  setWind(speedKmh: number | null, dirFromDeg: number | null): void {
    if (speedKmh == null || dirFromDeg == null || speedKmh <= 0) { this.ekman = { x: 0, y: 0 }; return; }
    const ms = speedKmh / 3.6;
    const beta = ((dirFromDeg + 180) * Math.PI) / 180; // wind blows TO this bearing
    const wx = Math.sin(beta), wy = -Math.cos(beta); // wind unit vector (screen)
    const mag = Math.min(1.8, ms * ms * 0.004); // ~stress, capped px/frame
    // right of the wind (screen y-down): (vx,vy) -> (-vy, vx)
    this.ekman = { x: -wy * mag, y: wx * mag };
  }

  private mkCanvas(pane: HTMLElement): HTMLCanvasElement {
    const c = L.DomUtil.create("canvas", "", pane) as HTMLCanvasElement;
    c.style.position = "absolute";
    c.style.top = c.style.left = "0";
    c.style.pointerEvents = "none";
    c.style.willChange = "transform";
    return c;
  }

  private resize(): void {
    if (!this.map || !this.canvas) return;
    const size = this.map.getSize();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(size.x * this.dpr)), H = Math.max(1, Math.round(size.y * this.dpr));
    for (const c of [this.canvas, this.maskC]) {
      if (!c) continue;
      c.width = W; c.height = H;
      c.style.width = size.x + "px"; c.style.height = size.y + "px";
    }
    // SST readback canvas stays at CSS-px resolution (1:1 with particle coords)
    if (this.sstC) { this.sstC.width = Math.max(1, size.x); this.sstC.height = Math.max(1, size.y); }
    const count = Math.round(Math.min(1200, Math.max(280, (size.x * size.y) / 2200)));
    this.particles = Array.from({ length: count }, () => this.spawn(size.x, size.y));
    this.segs = new Float32Array(count * 4);
    this.segsHot = new Float32Array(count * 4);
  }

  // Spawn a particle, importance-sampled toward high intensity (fronts/eddies) so
  // streaks concentrate where A is high, while flat water still gets some spread.
  private spawn(w: number, h: number): Particle {
    let x = Math.random() * w, y = Math.random() * h;
    if (this.sstField) {
      let best = -1;
      for (let i = 0; i < 4; i++) {
        const cx = Math.random() * w, cy = Math.random() * h;
        const s = this.sampleSst(cx, cy);
        const a = (s ? s.amp : 0) + 0.05; // floor so flat areas aren't starved
        if (a > best) { best = a; x = cx; y = cy; }
      }
    }
    return { x, y, bx: x, by: y, age: 0, max: 30 + Math.random() * 70 };
  }

  // Which land-mask tiles cover the viewport (+1 tile margin so a pan doesn't
  // expose unmasked land at the edge); kick off their loading.
  private rebuildMask(): void {
    const map = this.map;
    if (!map) return;
    const z = Math.min(Math.max(0, Math.round(map.getZoom())), MASK_MAXZOOM);
    this.maskZ = z;
    const size = map.getSize();
    const tl = map.project(map.containerPointToLatLng([0, 0]), z);
    const br = map.project(map.containerPointToLatLng([size.x, size.y]), z);
    const n = 1 << z;
    const x0 = Math.floor(tl.x / TILE) - 1, x1 = Math.floor(br.x / TILE) + 1;
    const y0 = Math.max(0, Math.floor(tl.y / TILE) - 1), y1 = Math.min(n - 1, Math.floor(br.y / TILE) + 1);
    const tiles: MaskTile[] = [];
    for (let x = x0; x <= x1 && tiles.length < 80; x++) {
      const tx = ((x % n) + n) % n; // wrap longitude
      for (let y = y0; y <= y1; y++) {
        const key = `${z}/${tx}/${y}`;
        let img = this.imgCache.get(key);
        if (!img) {
          img = new Image();
          img.decoding = "async";
          img.src = `${MASK_URL}/${z}/${y}/${tx}.png`; // WMTS REST order z/row/col
          this.imgCache.set(key, img);
        }
        tiles.push({ x, y, img });
      }
    }
    this.maskTiles = tiles;
    if (this.imgCache.size > 200) this.imgCache.clear();
  }

  // Queue the SST tiles covering the viewport (CORS-readable) for the gradient
  // field. Skipped when zoomed in past where SST is meaningful, or once readback
  // has been blocked by tainting.
  private rebuildSst(): void {
    const map = this.map;
    if (!map || this.sstTainted || map.getZoom() > SST_FLOW_MAXZOOM) { this.sstField = null; this.sstTiles = []; return; }
    const z = Math.min(Math.max(0, Math.round(map.getZoom())), SST_MAXNATIVE);
    this.sstZ = z;
    const size = map.getSize();
    const tl = map.project(map.containerPointToLatLng([0, 0]), z);
    const br = map.project(map.containerPointToLatLng([size.x, size.y]), z);
    const n = 1 << z;
    const x0 = Math.floor(tl.x / TILE), x1 = Math.floor(br.x / TILE);
    const y0 = Math.max(0, Math.floor(tl.y / TILE)), y1 = Math.min(n - 1, Math.floor(br.y / TILE));
    const tiles: MaskTile[] = [];
    for (let x = x0; x <= x1 && tiles.length < 60; x++) {
      const tx = ((x % n) + n) % n;
      for (let y = y0; y <= y1; y++) {
        const key = `${z}/${tx}/${y}`;
        let img = this.sstCache.get(key);
        if (!img) {
          img = new Image();
          img.crossOrigin = "anonymous"; // GIBS sends ACAO * -> pixel readback allowed
          img.decoding = "async";
          img.onload = () => { this.sstDirty = true; };
          img.src = `${SST_URL}/${z}/${y}/${tx}.png`;
          this.sstCache.set(key, img);
        }
        tiles.push({ x, y, img });
      }
    }
    this.sstTiles = tiles;
    this.sstDirty = true;
    if (this.sstCache.size > 160) this.sstCache.clear();
  }

  // Draw the SST tiles into the readback canvas and turn the temperature field
  // into a grid of flow vectors: direction = along the isotherm with warm water
  // on the right (NH geostrophic rule), strength = steepness of the front.
  private buildSstField(): boolean {
    const map = this.map, cv = this.sstC, sctx = this.sstCtx;
    if (!map || !cv || !sctx) return false;
    const w = cv.width, h = cv.height;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, w, h);
    const scale = Math.pow(2, map.getZoom() - this.sstZ), tpx = TILE * scale;
    let drew = false;
    for (const t of this.sstTiles) {
      if (!t.img.complete || t.img.naturalWidth === 0) continue;
      const o = map.latLngToContainerPoint(map.unproject([t.x * TILE, t.y * TILE], this.sstZ));
      sctx.drawImage(t.img, o.x, o.y, tpx, tpx);
      drew = true;
    }
    if (!drew) return false; // tiles not loaded yet
    let data: Uint8ClampedArray;
    try { data = sctx.getImageData(0, 0, w, h).data; }
    catch { this.sstTainted = true; this.sstField = null; return true; }
    const step = SST_GRID;
    const cols = Math.max(1, Math.floor(w / step)), rows = Math.max(1, Math.floor(h / step));
    const vx = new Float32Array(cols * rows), vy = new Float32Array(cols * rows), str = new Float32Array(cols * rows);
    const warmth = (cx: number, cy: number): number => {
      cx = cx < 0 ? 0 : cx >= w ? w - 1 : cx; cy = cy < 0 ? 0 : cy >= h ? h - 1 : cy;
      const i = (cy * w + cx) * 4;
      if (data[i + 3] < 100) return NaN; // transparent => land / no data
      return data[i] - data[i + 2]; // R - B: warmth proxy across the blue->red ramp
    };
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = (i * step + step / 2) | 0, y = (j * step + step / 2) | 0;
        const wl = warmth(x - step, y), wr = warmth(x + step, y), wu = warmth(x, y - step), wd = warmth(x, y + step);
        const idx = j * cols + i;
        if (isNaN(wl) || isNaN(wr) || isNaN(wu) || isNaN(wd)) continue;
        const gx = (wr - wl) / 2, gy = (wd - wu) / 2; // warmth gradient (toward warmer)
        const gmag = Math.hypot(gx, gy);
        if (gmag < 1e-3) continue;
        // flow along the isotherm, warm on the right (NH): d = (gy, -gx)
        let dxu = gy * SST_FLIP, dyu = -gx * SST_FLIP;
        const dl = Math.hypot(dxu, dyu) || 1;
        vx[idx] = dxu / dl; vy[idx] = dyu / dl; str[idx] = Math.min(1, gmag / SST_GREF);
      }
    }
    // Propagate the front's direction outward (str-weighted smoothing) so the
    // current has width - the whole warm jet flows, not just the thin edge.
    let cvx = vx, cvy = vy, cstr = str;
    for (let pass = 0; pass < 4; pass++) {
      const nvx = new Float32Array(cols * rows), nvy = new Float32Array(cols * rows), nstr = new Float32Array(cols * rows);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          let sx = 0, sy = 0, sw = 0, ss = 0, cnt = 0;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const ii = i + di, jj = j + dj;
              if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
              const id = jj * cols + ii, wgt = cstr[id] + 1e-4;
              sx += cvx[id] * wgt; sy += cvy[id] * wgt; sw += wgt; ss += cstr[id]; cnt++;
            }
          }
          const id = j * cols + i;
          if (sw > 0) { const dx = sx / sw, dy = sy / sw, dl = Math.hypot(dx, dy) || 1; nvx[id] = dx / dl; nvy[id] = dy / dl; }
          nstr[id] = (ss / cnt) * 0.94; // slight decay as the direction spreads
        }
      }
      cvx = nvx; cvy = nvy; cstr = nstr;
    }
    // Intensity field A = a*F_T + c*|vorticity|: where streaks should concentrate
    // and brighten. Vorticity zeta = d(Vy)/dx - d(Vx)/dy of the current vectors
    // (magnitude proxied by str), central-differenced on the grid; it lights up
    // eddies and shear lines that a plain front map misses.
    const amp = new Float32Array(cols * rows);
    const V = (a: number, comp: Float32Array) => comp[a] * cstr[a]; // velocity proxy
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const id = j * cols + i;
        const il = j * cols + Math.max(0, i - 1), ir = j * cols + Math.min(cols - 1, i + 1);
        const ju = Math.max(0, j - 1) * cols + i, jd = Math.min(rows - 1, j + 1) * cols + i;
        const zeta = (V(ir, cvy) - V(il, cvy)) / 2 - (V(jd, cvx) - V(ju, cvx)) / 2;
        amp[id] = Math.min(1, 0.75 * cstr[id] + 2.6 * Math.abs(zeta));
      }
    }
    this.sstField = { step, cols, rows, vx: cvx, vy: cvy, str: cstr, amp };
    return true;
  }

  // Bilinear sample of the SST flow grid at a screen position.
  private sampleSst(x: number, y: number): { vx: number; vy: number; str: number; amp: number } | null {
    const f = this.sstField;
    if (!f) return null;
    const gx = x / f.step - 0.5, gy = y / f.step - 0.5;
    let i0 = Math.floor(gx), j0 = Math.floor(gy);
    const fx = gx - i0, fy = gy - j0;
    i0 = Math.min(f.cols - 1, Math.max(0, i0)); j0 = Math.min(f.rows - 1, Math.max(0, j0));
    const i1 = Math.min(f.cols - 1, i0 + 1), j1 = Math.min(f.rows - 1, j0 + 1);
    const a = j0 * f.cols + i0, b = j0 * f.cols + i1, c = j1 * f.cols + i0, d = j1 * f.cols + i1;
    const mix = (arr: Float32Array) => (arr[a] * (1 - fx) + arr[b] * fx) * (1 - fy) + (arr[c] * (1 - fx) + arr[d] * fx) * fy;
    return { vx: mix(f.vx), vy: mix(f.vy), str: mix(f.str), amp: mix(f.amp) };
  }

  // Compose the seamless mask in the off-screen canvas, then subtract it from
  // `ctx` (destination-out), feathering the coastline past native zoom.
  private clipToWater(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const mctx = this.mctx, mcv = this.maskC, map = this.map;
    if (!mctx || !mcv || !map) return;
    const scale = Math.pow(2, map.getZoom() - this.maskZ), tpx = TILE * scale;
    mctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    mctx.clearRect(0, 0, w, h);
    mctx.imageSmoothingEnabled = true;
    mctx.imageSmoothingQuality = "high";
    for (const t of this.maskTiles) {
      if (!t.img.complete || t.img.naturalWidth === 0) continue;
      const o = map.latLngToContainerPoint(map.unproject([t.x * TILE, t.y * TILE], this.maskZ));
      mctx.drawImage(t.img, o.x, o.y, tpx, tpx);
    }
    const blur = featherFor(map.getZoom());
    ctx.globalCompositeOperation = "destination-out";
    ctx.filter = blur > 0 ? `blur(${blur}px)` : "none";
    ctx.drawImage(mcv, 0, 0, w, h);
    ctx.filter = "none";
    ctx.globalCompositeOperation = "source-over";
  }

  private start(): void { if (!this.raf && this.ctx) this.raf = requestAnimationFrame(this.frame); }
  private stop(): void { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  private frame = (): void => {
    const ctx = this.ctx, cv = this.canvas, map = this.map;
    if (!ctx || !cv || !map) return;
    // keep the streak canvas covering the viewport regardless of panning
    L.DomUtil.setPosition(cv, map.containerPointToLayerPoint([0, 0]));

    const w = map.getSize().x, h = map.getSize().y;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const targetSpeed = this.target ? this.target.speed01 : 0;
    this.cur.speed01 += (targetSpeed - this.cur.speed01) * 0.04;
    const sp = this.cur.speed01;

    // fade existing trails (multiply alpha down) without clearing the map beneath
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = "rgba(0,0,0,0.92)"; // slower fade -> longer, more continuous streaks
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";

    const phase = this.target?.phase ?? this.cur.phase;
    const color = phase === "ebb" ? EBB_COLOR : phase === "slack" ? SLACK_COLOR : FLOOD_COLOR;
    const b = this.cur.bearingDeg * Math.PI / 180;
    // Base flow = tidal advection + wave (Stokes) drift, expressed as a mean
    // heading + speed. Per particle we BEND the heading by the smooth flow field
    // so they trace curving laminar streamlines (not one straight reversing line).
    const driftx = Math.sin(b) * (0.5 + sp * 3.8) + this.waveDrift.x + this.ekman.x;
    const drifty = -Math.cos(b) * (0.5 + sp * 3.8) + this.waveDrift.y + this.ekman.y;
    const baseAng = Math.atan2(drifty, driftx);
    const baseSpd = Math.max(0.7, Math.hypot(driftx, drifty)); // floor so it always flows
    const waves = this.waves;
    const t = performance.now() / 1000; // seconds, for the real wave period

    // (re)build the SST current field when the view changed and tiles arrived
    if (this.sstDirty && map.getZoom() <= SST_FLOW_MAXZOOM && !this.sstTainted) {
      if (this.buildSstField()) this.sstDirty = false;
    }
    const sstField = this.sstField;

    const segs = this.segs, segsHot = this.segsHot;
    let k = 0, kh = 0;
    for (const p of this.particles) {
      const px = p.x, py = p.y; // previous rendered position
      // Steer along the SST-derived current where a thermal front exists; blend
      // back to the tidal/wind/laminar flow where the temperature field is flat.
      let a: number, spd: number, inten = 0;
      const cell = sstField ? this.sampleSst(p.bx, p.by) : null;
      if (cell) {
        inten = cell.amp;
        if (cell.str > 0.04) {
          const sstA = Math.atan2(cell.vy, cell.vx);
          const baseA = baseAng + flowBend(p.bx, p.by, t) * (1 - cell.str);
          a = angLerp(baseA, sstA, cell.str);
          spd = baseSpd * (1 - cell.str) + (SST_MIN_PX + cell.str * SST_SPAN_PX) * cell.str;
        } else { a = baseAng + flowBend(p.bx, p.by, t); spd = baseSpd; }
      } else { a = baseAng + flowBend(p.bx, p.by, t); spd = baseSpd; }
      p.bx += Math.cos(a) * spd; p.by += Math.sin(a) * spd;
      // wave orbital displacement = sum of components (deterministic, physical dir/period)
      let ox = 0, oy = 0;
      for (const wv of waves) {
        const ph = wv.kpx * (wv.dx * p.bx + wv.dy * p.by) - wv.omegaApp * t + wv.phase0;
        const d = wv.ampPx * Math.sin(ph);
        ox += d * wv.dx; oy += d * wv.dy;
      }
      p.x = p.bx + ox; p.y = p.by + oy;
      p.age++;
      segs[k++] = px; segs[k++] = py; segs[k++] = p.x; segs[k++] = p.y;
      // route streaks on strong fronts/eddies to an extra-bright pass
      if (inten > 0.4) { segsHot[kh++] = px; segsHot[kh++] = py; segsHot[kh++] = p.x; segsHot[kh++] = p.y; }
      if (p.age > p.max || p.bx < -6 || p.by < -6 || p.bx > w + 6 || p.by > h + 6) Object.assign(p, this.spawn(w, h));
    }

    ctx.lineCap = "round";
    const stroke = (buf: Float32Array, n: number) => { ctx.beginPath(); for (let i = 0; i < n; i += 4) { ctx.moveTo(buf[i], buf[i + 1]); ctx.lineTo(buf[i + 2], buf[i + 3]); } ctx.stroke(); };
    // soft luminous halo
    ctx.strokeStyle = color; ctx.lineWidth = 5.5; ctx.globalAlpha = Math.min(0.22, 0.08 + sp * 0.18); stroke(segs, k);
    // dark edge for definition on pale water
    ctx.strokeStyle = OUTLINE; ctx.lineWidth = 3.0; ctx.globalAlpha = Math.min(0.5, 0.28 + sp * 0.28); stroke(segs, k);
    // bright core
    ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.globalAlpha = Math.min(0.98, 0.6 + sp * 0.4); stroke(segs, k);
    // extra-bright pass on fronts/eddies (intensity field A)
    if (kh) { ctx.strokeStyle = color; ctx.lineWidth = 2.0; ctx.globalAlpha = 0.9; stroke(segsHot, kh); }
    ctx.globalAlpha = 1;

    this.clipToWater(ctx, w, h);
    this.raf = requestAnimationFrame(this.frame);
  };
}

export function createFlowLayer(): FlowLayer {
  return new TidalFlowLayer();
}
