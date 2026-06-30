import L from "leaflet";

// Whole-province MODELLED lake-depth overlay - shades EVERY inland lake in view by
// depth. There is no surveyed bathymetric-contour data for NS lakes, so depth is
// estimated from distance-to-shore.
//
// Rendered as a TILED L.GridLayer (not one viewport image) so Leaflet pans/zooms/
// caches it natively - smooth, and pan-back is instant. Each tile fetches a small
// solid water mask for its own bbox (plus a margin so distance-to-shore is correct
// near tile edges) from the NS Topographic Database, distance-transforms it, and
// paints a shallow-tan -> deep-navy gradient + contour lines.
//
// INLAND LAKES ONLY: NSTDB "Wet Features" (layer 8) classifies each polygon by
// `FEAT_DESC`. We render only "Lake/Reservoir/River Lake Water polygon" via a
// dynamicLayers definitionExpression, so the ocean/bays ("Coast Water Area",
// "Coast River Water") never appear - they have their own GEBCO/chart layers.
// The export reflects the request Origin in Access-Control-Allow-Origin, so an
// anonymous-crossOrigin <img> can be getImageData-read back.

const EXPORT = "https://nsgiwa.novascotia.ca/arcgis/rest/services/BASE/BASE_NSTDB_10k_Water_WM84/MapServer/export";
const WATER_DL = JSON.stringify([{
  id: 8, source: { type: "mapLayer", mapLayerId: 8 },
  definitionExpression: "FEAT_DESC IN ('Lake Water polygon','River Lake Water polygon','Reservoir Water polygon')",
  drawingInfo: { renderer: { type: "simple", symbol: { type: "esriSFS", style: "esriSFSSolid", color: [255, 255, 255, 255], outline: { type: "esriSLS", style: "esriSLSNull" } } } },
}]);

const MARGIN = 0.5;  // overscan each tile by this fraction so edge distances are right
const SLOPE = 0.05;  // modelled depth metres per metre of distance-from-shore (rough)
const DCAP = 24;     // cap modelled depth (m)
const ALPHA = 185;   // fill opacity (0-255)

const HALF = 20037508.342789244;
const lon2x = (lon: number) => (lon * HALF) / 180;
const lat2y = (lat: number) => (Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180)) * HALF / 180;

const RAMP: [number, [number, number, number]][] = [
  [0.0, [233, 201, 106]], [0.18, [120, 196, 170]], [0.4, [95, 176, 216]],
  [0.62, [47, 127, 192]], [0.82, [29, 90, 160]], [1.0, [16, 52, 104]],
];
function ramp(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  let lo = RAMP[0], hi = RAMP[RAMP.length - 1];
  for (let i = 0; i < RAMP.length - 1; i++) if (t >= RAMP[i][0] && t <= RAMP[i + 1][0]) { lo = RAMP[i]; hi = RAMP[i + 1]; break; }
  const f = (t - lo[0]) / (hi[0] - lo[0] || 1);
  return [0, 1, 2].map((k) => Math.round(lo[1][k] + (hi[1][k] - lo[1][k]) * f)) as [number, number, number];
}

// Distance transform + colour a water mask, returning per-cell depth fraction.
function depthFromMask(mask: Uint8ClampedArray, w: number, h: number, metresPerCell: number): { rgba: Uint8ClampedArray; nd: Float32Array } {
  const n = w * h;
  const water = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (mask[i * 4 + 3] > 128) water[i] = 1;

  const INF = 1e9, D1 = 1, D2 = Math.SQRT2;
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = water[i] ? INF : 0;
  const at = (x: number, y: number) => y * w + x;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = at(x, y); if (!water[i]) continue;
    let d = dist[i];
    if (x > 0) d = Math.min(d, dist[i - 1] + D1);
    if (y > 0) d = Math.min(d, dist[i - w] + D1);
    if (x > 0 && y > 0) d = Math.min(d, dist[i - w - 1] + D2);
    if (x < w - 1 && y > 0) d = Math.min(d, dist[i - w + 1] + D2);
    dist[i] = d;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = at(x, y); if (!water[i]) continue;
    let d = dist[i];
    if (x < w - 1) d = Math.min(d, dist[i + 1] + D1);
    if (y < h - 1) d = Math.min(d, dist[i + w] + D1);
    if (x < w - 1 && y < h - 1) d = Math.min(d, dist[i + w + 1] + D2);
    if (x > 0 && y < h - 1) d = Math.min(d, dist[i + w - 1] + D2);
    dist[i] = d;
  }

  const rgba = new Uint8ClampedArray(n * 4);
  const nd = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!water[i]) { nd[i] = -1; continue; }
    const depthM = Math.min(DCAP, SLOPE * dist[i] * metresPerCell);
    const v = depthM / DCAP;
    nd[i] = v;
    const [r, g, b] = ramp(v);
    const j = i * 4;
    rgba[j] = r; rgba[j + 1] = g; rgba[j + 2] = b; rgba[j + 3] = ALPHA;
  }
  return { rgba, nd };
}

const LakeDepthGrid = L.GridLayer.extend({
  getAttribution(): string { return "Lake depth: modelled from NS Topographic Database (GeoNOVA)"; },

  createTile(this: L.GridLayer, coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const size = this.getTileSize();
    const ts = size.x;
    const tile = document.createElement("canvas");
    tile.width = ts; tile.height = ts;
    const ctx = tile.getContext("2d");
    const map = (this as unknown as { _map: L.Map })._map;
    if (!ctx || !map) { setTimeout(() => done(undefined, tile), 0); return tile; }

    const m = Math.round(ts * MARGIN);          // overscan in px
    const iw = ts + 2 * m;                       // mask dimensions
    const z = coords.z;
    // tile bbox (+margin) in EPSG:3857 via unproject of the padded pixel rect
    const nw = map.unproject(L.point(coords.x * ts - m, coords.y * ts - m), z);
    const se = map.unproject(L.point((coords.x + 1) * ts + m, (coords.y + 1) * ts + m), z);
    const bbox = `${lon2x(nw.lng)},${lat2y(se.lat)},${lon2x(se.lng)},${lat2y(nw.lat)}`;
    const url = `${EXPORT}?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=${iw},${iw}&format=png32&transparent=true&dynamicLayers=${encodeURIComponent(WATER_DL)}&f=image`;

    const metresPerCell = (40075016.686 * Math.cos((nw.lat * Math.PI) / 180)) / Math.pow(2, z + 8);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const off = document.createElement("canvas");
        off.width = iw; off.height = iw;
        const octx = off.getContext("2d")!;
        octx.drawImage(img, 0, 0, iw, iw);
        const mask = octx.getImageData(0, 0, iw, iw).data;
        const { rgba, nd } = depthFromMask(mask, iw, iw, metresPerCell);

        // paint the gradient (full padded grid) then blit only the centre tile
        const full = octx.createImageData(iw, iw);
        full.data.set(rgba);
        octx.putImageData(full, 0, 0);
        ctx.clearRect(0, 0, ts, ts);
        ctx.drawImage(off, m, m, ts, ts, 0, 0, ts, ts);

        // contour lines at real metre levels (marching squares), in tile-local px
        const step = DCAP <= 12 ? 2 : 5;
        const at = (x: number, y: number) => y * iw + x;
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = "rgba(8,30,52,0.5)";
        ctx.beginPath();
        for (let depth = step; depth < DCAP; depth += step) {
          const lvl = depth / DCAP;
          for (let y = 0; y < iw - 1; y++) for (let x = 0; x < iw - 1; x++) {
            const a = nd[at(x, y)], b = nd[at(x + 1, y)], c = nd[at(x + 1, y + 1)], d = nd[at(x, y + 1)];
            if (a < 0 || b < 0 || c < 0 || d < 0) continue;
            const pts: [number, number][] = [];
            const edge = (v0: number, v1: number, x0: number, y0: number, x1: number, y1: number) => {
              if ((v0 < lvl && v1 >= lvl) || (v0 >= lvl && v1 < lvl)) {
                const f = (lvl - v0) / (v1 - v0);
                pts.push([x0 + (x1 - x0) * f - m, y0 + (y1 - y0) * f - m]); // shift into tile space
              }
            };
            edge(a, b, x, y, x + 1, y);
            edge(b, c, x + 1, y, x + 1, y + 1);
            edge(c, d, x + 1, y + 1, x, y + 1);
            edge(d, a, x, y + 1, x, y);
            if (pts.length >= 2) { ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); }
          }
        }
        ctx.stroke();
        done(undefined, tile);
      } catch (e) {
        done(e as Error, tile); // readback blocked etc.
      }
    };
    img.onerror = () => done(new Error("tile fetch failed"), tile);
    img.src = url;
    return tile;
  },
});

export function createLakeDepthLayer(): L.GridLayer {
  return new (LakeDepthGrid as unknown as new (opts: L.GridLayerOptions) => L.GridLayer)({
    pane: "lakedepth", attribution: "Lake depth: modelled from NS Topographic Database (GeoNOVA)", updateWhenZooming: false, keepBuffer: 2,
  });
}
export type LakeDepthLayer = L.GridLayer;
