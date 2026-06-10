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

// Feather radius (px) for the coastline clip once we overzoom the z9 mask.
const featherFor = (zoom: number) => Math.max(0, Math.min(14, (zoom - MASK_MAXZOOM) * 2));

class TidalFlowLayer extends L.Layer implements FlowLayer {
  private map: L.Map | null = null;
  private canvas: HTMLCanvasElement | null = null; // animated streaks (screen-fixed)
  private ctx: CanvasRenderingContext2D | null = null;
  private maskC: HTMLCanvasElement | null = null; // seamless off-screen land mask
  private mctx: CanvasRenderingContext2D | null = null;
  private particles: Particle[] = [];
  private segs = new Float32Array(0);
  private raf = 0;
  private cur: TidalFlow = { speed01: 0, phase: "slack", bearingDeg: 0 };
  private target: TidalFlow | null = null;
  private waves: RenderWave[] = [];
  private waveDrift = { x: 0, y: 0 }; // small Stokes-like drift along the swell, px/frame
  private dpr = 1;
  private maskZ = MASK_MAXZOOM;
  private maskTiles: MaskTile[] = [];
  private imgCache = new Map<string, HTMLImageElement>();
  private onResize = () => { this.resize(); this.rebuildMask(); };
  private onView = () => this.rebuildMask();
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
    this.resize();
    this.rebuildMask();
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
    this.canvas = this.ctx = this.maskC = this.mctx = null as never;
    this.map = null; this.particles = []; this.maskTiles = []; this.imgCache.clear();
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
    const count = Math.round(Math.min(1200, Math.max(280, (size.x * size.y) / 2200)));
    this.particles = Array.from({ length: count }, () => this.spawn(size.x, size.y));
    this.segs = new Float32Array(count * 4);
  }

  private spawn(w: number, h: number): Particle {
    const x = Math.random() * w, y = Math.random() * h;
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
    const driftx = Math.sin(b) * (0.5 + sp * 3.8) + this.waveDrift.x; // tidal advection + wave (Stokes) drift
    const drifty = -Math.cos(b) * (0.5 + sp * 3.8) + this.waveDrift.y;
    const waves = this.waves;
    const t = performance.now() / 1000; // seconds, for the real wave period

    const segs = this.segs;
    let k = 0;
    for (const p of this.particles) {
      const px = p.x, py = p.y; // previous rendered position
      // mean position advects with the current
      p.bx += driftx; p.by += drifty;
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
      if (p.age > p.max || p.bx < -6 || p.by < -6 || p.bx > w + 6 || p.by > h + 6) Object.assign(p, this.spawn(w, h));
    }

    ctx.lineCap = "round";
    const path = () => { ctx.beginPath(); for (let i = 0; i < k; i += 4) { ctx.moveTo(segs[i], segs[i + 1]); ctx.lineTo(segs[i + 2], segs[i + 3]); } };
    // soft luminous halo
    ctx.strokeStyle = color; ctx.lineWidth = 5.5; ctx.globalAlpha = Math.min(0.22, 0.08 + sp * 0.18); path(); ctx.stroke();
    // dark edge for definition on pale water
    ctx.strokeStyle = OUTLINE; ctx.lineWidth = 3.0; ctx.globalAlpha = Math.min(0.5, 0.28 + sp * 0.28); path(); ctx.stroke();
    // bright core
    ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.globalAlpha = Math.min(0.98, 0.6 + sp * 0.4); path(); ctx.stroke();
    ctx.globalAlpha = 1;

    this.clipToWater(ctx, w, h);
    this.raf = requestAnimationFrame(this.frame);
  };
}

export function createFlowLayer(): FlowLayer {
  return new TidalFlowLayer();
}
