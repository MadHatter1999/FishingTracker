import L from "leaflet";

// Reusable water clip from NASA GIBS OSM_Land_Mask tiles (land = opaque, water =
// transparent, static, CORS *). We only composite the mask (destination-out),
// never read its pixels, so cross-origin tainting is a non-issue. Past the mask's
// native zoom the clip is feathered so the coastline stays smooth instead of
// stair-stepping into squares.

const MASK_URL = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/OSM_Land_Mask/default/GoogleMapsCompatible_Level9";
const MASK_MAXZOOM = 9;
const TILE = 256;

export class LandMask {
  private cv = document.createElement("canvas");
  private ctx = this.cv.getContext("2d");
  private tiles: { x: number; y: number; img: HTMLImageElement }[] = [];
  private cache = new Map<string, HTMLImageElement>();
  private z = MASK_MAXZOOM;

  resize(deviceW: number, deviceH: number): void {
    this.cv.width = Math.max(1, deviceW);
    this.cv.height = Math.max(1, deviceH);
  }

  // Queue the mask tiles covering the viewport (+1 tile margin).
  rebuild(map: L.Map): void {
    const z = Math.min(Math.max(0, Math.round(map.getZoom())), MASK_MAXZOOM);
    this.z = z;
    const size = map.getSize();
    const tl = map.project(map.containerPointToLatLng([0, 0]), z);
    const br = map.project(map.containerPointToLatLng([size.x, size.y]), z);
    const n = 1 << z;
    const x0 = Math.floor(tl.x / TILE) - 1, x1 = Math.floor(br.x / TILE) + 1;
    const y0 = Math.max(0, Math.floor(tl.y / TILE) - 1), y1 = Math.min(n - 1, Math.floor(br.y / TILE) + 1);
    const tiles: { x: number; y: number; img: HTMLImageElement }[] = [];
    for (let x = x0; x <= x1 && tiles.length < 80; x++) {
      const tx = ((x % n) + n) % n;
      for (let y = y0; y <= y1; y++) {
        const key = `${z}/${tx}/${y}`;
        let img = this.cache.get(key);
        if (!img) {
          img = new Image();
          img.decoding = "async";
          img.src = `${MASK_URL}/${z}/${y}/${tx}.png`;
          this.cache.set(key, img);
        }
        tiles.push({ x, y, img });
      }
    }
    this.tiles = tiles;
    if (this.cache.size > 200) this.cache.clear();
  }

  // Erase (destination-out) land from `ctx`, feathering the coastline past native
  // zoom. `ctx` must already have the dpr transform set.
  clip(ctx: CanvasRenderingContext2D, map: L.Map, w: number, h: number, dpr: number): void {
    const mctx = this.ctx;
    if (!mctx) return;
    const scale = Math.pow(2, map.getZoom() - this.z), tpx = TILE * scale;
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.clearRect(0, 0, w, h);
    mctx.imageSmoothingEnabled = true;
    mctx.imageSmoothingQuality = "high";
    for (const t of this.tiles) {
      if (!t.img.complete || t.img.naturalWidth === 0) continue;
      const o = map.latLngToContainerPoint(map.unproject([t.x * TILE, t.y * TILE], this.z));
      mctx.drawImage(t.img, o.x, o.y, tpx, tpx);
    }
    const blur = Math.max(0, Math.min(14, (map.getZoom() - MASK_MAXZOOM) * 2));
    ctx.globalCompositeOperation = "destination-out";
    ctx.filter = blur > 0 ? `blur(${blur}px)` : "none";
    ctx.drawImage(this.cv, 0, 0, w, h);
    ctx.filter = "none";
    ctx.globalCompositeOperation = "source-over";
  }
}
