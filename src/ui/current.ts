import L from "leaflet";
import { LandMask } from "./landmask";

// "Ocean current" overlay: the REAL surface-current data (Open-Meteo Marine
// `ocean_current_velocity`/`direction`), sampled on a grid across the viewport
// and shown as an ANIMATED particle field - streaks advect along the measured
// current vectors (bilinearly interpolated), coloured by speed. This is the
// measured-data layer, distinct from the modelled SST/tidal flow in `flow.ts`.
// Free, no key, CORS *.

const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";

// Regular lat/lon grid of current vectors decomposed into east/north components
// (m-agnostic km/h) so we can interpolate them without angle wraparound. NaN
// marks land / no-data cells.
interface CurGrid { n: number; s: number; w: number; e: number; cols: number; rows: number; ue: Float32Array; un: Float32Array; spd: Float32Array; }

interface Particle { x: number; y: number; age: number; max: number; }

// speed (km/h) -> colour (calm teal -> amber -> strong red)
function speedColor(v: number): string {
  const t = Math.max(0, Math.min(1, v / 3));
  const stops: [number, [number, number, number]][] = [
    [0.0, [120, 200, 220]],
    [0.5, [120, 210, 140]],
    [0.75, [240, 200, 70]],
    [1.0, [255, 90, 60]],
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) if (t >= stops[i][0] && t <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
  const f = (t - lo[0]) / (hi[0] - lo[0] || 1);
  const ch = (k: number) => Math.round(lo[1][k] + (hi[1][k] - lo[1][k]) * f);
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}

const BUCKETS = 6;
const BUCKET_COLORS = Array.from({ length: BUCKETS }, (_, b) => speedColor(((b + 0.5) / BUCKETS) * 3));

class OceanCurrentLayer extends L.Layer {
  private map: L.Map | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;
  private grid: CurGrid | null = null;
  private particles: Particle[] = [];
  private mask = new LandMask();
  private raf = 0;
  private seq = 0;
  private timer = 0;
  private abort: AbortController | null = null;
  private lastFetch: { lat: number; lon: number; z: number } | null = null;
  private onSettled = () => { if (this.map) this.mask.rebuild(this.map); this.syncCount(); this.scheduleFetch(); };
  private onResize = () => this.resize();
  private onVis = () => { if (document.hidden) this.stop(); else this.start(); };

  getAttribution(): string { return "Ocean current: Open-Meteo Marine"; }

  onAdd(map: L.Map): this {
    this.map = map;
    if (!map.getPane("oceancurrent")) {
      const pane = map.createPane("oceancurrent");
      pane.style.zIndex = "255"; // above the modelled flow - it's the data readout
      pane.style.pointerEvents = "none";
    }
    const c = L.DomUtil.create("canvas", "", map.getPane("oceancurrent")!) as HTMLCanvasElement;
    c.style.position = "absolute"; c.style.top = c.style.left = "0"; c.style.pointerEvents = "none"; c.style.willChange = "transform";
    this.canvas = c; this.ctx = c.getContext("2d");
    this.resize();
    this.mask.rebuild(map);
    this.fetchGrid();
    map.on("moveend zoomend", this.onSettled);
    map.on("resize", this.onResize);
    document.addEventListener("visibilitychange", this.onVis);
    if (!document.hidden) this.start();
    return this;
  }

  onRemove(map: L.Map): this {
    this.stop();
    map.off("moveend zoomend", this.onSettled);
    map.off("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onVis);
    if (this.timer) clearTimeout(this.timer);
    this.abort?.abort();
    this.canvas?.remove();
    this.canvas = this.ctx = null; this.map = null; this.particles = []; this.grid = null;
    return this;
  }

  private resize(): void {
    if (!this.map || !this.canvas) return;
    const size = this.map.getSize();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(size.x * this.dpr));
    this.canvas.height = Math.max(1, Math.round(size.y * this.dpr));
    this.canvas.style.width = size.x + "px"; this.canvas.style.height = size.y + "px";
    this.mask.resize(this.canvas.width, this.canvas.height);
    this.syncCount();
  }

  // Streak count scales with the GEOGRAPHIC area shown: zoomed out (bigger ocean
  // on screen) gets many more stripes; zoomed in gets fewer. Grows/shrinks the
  // pool in place so existing streaks aren't reset on every zoom.
  private syncCount(): void {
    if (!this.map) return;
    const size = this.map.getSize();
    const basePixel = (size.x * size.y) / 3500;
    const boost = Math.max(0.7, Math.min(3.4, Math.pow(2, (10 - this.map.getZoom()) * 0.6)));
    const target = Math.round(Math.max(160, Math.min(1900, basePixel * boost)));
    const cur = this.particles.length;
    if (target > cur) for (let i = cur; i < target; i++) this.particles.push(this.spawn(size.x, size.y));
    else if (target < cur) this.particles.length = target;
  }

  private spawn(w: number, h: number): Particle {
    // prefer a spot that has current data (avoid wasting streaks on land)
    let x = Math.random() * w, y = Math.random() * h;
    if (this.grid && this.map) {
      let best = -1;
      for (let i = 0; i < 4; i++) {
        const cx = Math.random() * w, cy = Math.random() * h;
        const ll = this.map.containerPointToLatLng([cx, cy]);
        const f = this.sampleField(ll.lat, ll.lng);
        const score = f ? 0.2 + f.spd : 0; // valid + faster preferred
        if (score > best) { best = score; x = cx; y = cy; }
      }
    }
    return { x, y, age: 0, max: 26 + Math.random() * 60 };
  }

  private scheduleFetch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.fetchGrid(), 800); // debounce panning (gentle on the API)
  }

  // One request for a coarse grid of real current values over the viewport.
  // Skips the request when the view has barely changed so panning/zoom-nudging
  // does not blow through Open-Meteo's per-IP rate limit (a multi-point request
  // counts each point against the quota).
  private async fetchGrid(): Promise<void> {
    const map = this.map;
    if (!map) return;
    const size = map.getSize();
    const z = map.getZoom();
    const c = map.getCenter();
    const last = this.lastFetch;
    if (this.grid && last && last.z === z) {
      const span = Math.abs(this.grid.e - this.grid.w);
      if (Math.abs(c.lng - last.lon) < span * 0.3 && Math.abs(c.lat - last.lat) < span * 0.3) return; // close enough, reuse
    }
    const cols = Math.max(3, Math.min(6, Math.round(size.x / 200)));
    const rows = Math.max(3, Math.min(5, Math.round(size.y / 200)));
    const b = map.getBounds().pad(-0.04);
    const n = b.getNorth(), s = b.getSouth(), w = b.getWest(), e = b.getEast();
    const lats: number[] = [], lons: number[] = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      lats.push(+(n + (s - n) * (j / (rows - 1))).toFixed(4));
      lons.push(+(w + (e - w) * (i / (cols - 1))).toFixed(4));
    }
    const url = `${MARINE_URL}?latitude=${lats.join(",")}&longitude=${lons.join(",")}&current=ocean_current_velocity,ocean_current_direction`;
    const seq = ++this.seq;
    this.abort?.abort();
    this.abort = new AbortController();
    try {
      const res = await fetch(url, { signal: this.abort.signal });
      if (!res.ok) throw new Error(`current ${res.status}`);
      const data = await res.json();
      if (seq !== this.seq) return; // superseded
      const arr = Array.isArray(data) ? data : [data];
      const ue = new Float32Array(cols * rows), un = new Float32Array(cols * rows), spd = new Float32Array(cols * rows);
      for (let idx = 0; idx < cols * rows; idx++) {
        const cur = arr[idx]?.current;
        const v = cur?.ocean_current_velocity, dir = cur?.ocean_current_direction;
        if (v == null || dir == null) { ue[idx] = un[idx] = spd[idx] = NaN; continue; }
        const beta = (dir * Math.PI) / 180; // flows TO
        ue[idx] = v * Math.sin(beta); un[idx] = v * Math.cos(beta); spd[idx] = v;
      }
      this.grid = { n, s, w, e, cols, rows, ue, un, spd };
      this.lastFetch = { lat: c.lat, lon: c.lng, z };
    } catch (err) {
      if ((err as Error).name !== "AbortError") console.warn("Ocean current fetch failed", err);
    }
  }

  // Bilinear sample of the current grid at a lat/lon. Returns east/north velocity
  // components + speed, skipping NaN (land) corners; null outside the grid.
  private sampleField(lat: number, lon: number): { ue: number; un: number; spd: number } | null {
    const g = this.grid;
    if (!g) return null;
    const fx = ((lon - g.w) / (g.e - g.w)) * (g.cols - 1);
    const fy = ((g.n - lat) / (g.n - g.s)) * (g.rows - 1);
    if (fx < 0 || fx > g.cols - 1 || fy < 0 || fy > g.rows - 1) return null;
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    const i1 = Math.min(g.cols - 1, i0 + 1), j1 = Math.min(g.rows - 1, j0 + 1);
    const tx = fx - i0, ty = fy - j0;
    let ue = 0, un = 0, sp = 0, wsum = 0;
    const acc = (i: number, j: number, wgt: number) => {
      const id = j * g.cols + i;
      if (Number.isNaN(g.spd[id])) return;
      ue += g.ue[id] * wgt; un += g.un[id] * wgt; sp += g.spd[id] * wgt; wsum += wgt;
    };
    acc(i0, j0, (1 - tx) * (1 - ty)); acc(i1, j0, tx * (1 - ty)); acc(i0, j1, (1 - tx) * ty); acc(i1, j1, tx * ty);
    if (wsum < 0.35) return null; // mostly land here
    return { ue: ue / wsum, un: un / wsum, spd: sp / wsum };
  }

  private start(): void { if (!this.raf && this.ctx) this.raf = requestAnimationFrame(this.frame); }
  private stop(): void { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  private frame = (): void => {
    const map = this.map, ctx = this.ctx, cv = this.canvas;
    if (!map || !ctx || !cv) return;
    L.DomUtil.setPosition(cv, map.containerPointToLayerPoint([0, 0]));
    const w = map.getSize().x, h = map.getSize().y;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // fade trails
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = "rgba(0,0,0,0.86)";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";

    // collect this frame's segments per speed bucket (so each colour is one stroke)
    const segs: number[][] = Array.from({ length: BUCKETS }, () => []);
    const SCALE = 2.6; // px/frame per km/h
    for (const p of this.particles) {
      const px = p.x, py = p.y;
      const ll = map.containerPointToLatLng([p.x, p.y]);
      const f = this.sampleField(ll.lat, ll.lng);
      if (!f) { Object.assign(p, this.spawn(w, h)); continue; }
      // screen velocity from east/north components (north = -y)
      const vmag = f.spd || 0.0001;
      const step = Math.max(0.6, vmag * SCALE); // floor so weak current still drifts
      p.x += (f.ue / vmag) * step;
      p.y += (-f.un / vmag) * step;
      p.age++;
      const b = Math.min(BUCKETS - 1, Math.floor((Math.min(vmag, 3) / 3) * BUCKETS));
      segs[b].push(px, py, p.x, p.y);
      if (p.age > p.max || p.x < -4 || p.y < -4 || p.x > w + 4 || p.y > h + 4) Object.assign(p, this.spawn(w, h));
    }

    ctx.lineCap = "round";
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;
    for (let b = 0; b < BUCKETS; b++) {
      const s = segs[b];
      if (!s.length) continue;
      ctx.strokeStyle = BUCKET_COLORS[b];
      ctx.beginPath();
      for (let i = 0; i < s.length; i += 4) { ctx.moveTo(s[i], s[i + 1]); ctx.lineTo(s[i + 2], s[i + 3]); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // keep the animation strictly on water (the current grid is coarse near shore)
    this.mask.clip(ctx, map, w, h, this.dpr);
    this.raf = requestAnimationFrame(this.frame);
  };
}

export function createCurrentLayer(): L.Layer {
  return new OceanCurrentLayer();
}
