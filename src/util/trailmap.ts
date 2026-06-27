// Self-contained vector map of a saved trip: draws the breadcrumb route, start/end,
// base camp and marked spots onto an SVG with a simple equirectangular projection.
// No tiles / network, so it renders the same offline in the backcountry and can be
// rasterised to PNG or dropped into a printable report (PDF) for export.
import type { TrailState } from "../store/trail";

export interface TrailMapOpts {
  width?: number;
  height?: number;
  padding?: number;
}

const PAL = {
  paper: "#f5f2ea",
  frame: "#cfc7b4",
  grid: "#e3ddcf",
  route: "#ef7d3a",
  routeHalo: "#ffffff",
  start: "#2e9e5b",
  end: "#d23b3b",
  camp: "#e0a92b",
  poi: "#2a9db0",
  ink: "#3a3329",
  faint: "#8a8170",
};

const M_PER_UNIT = 111195; // metres per projected unit (~1° lat); both axes share this

function xesc(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Pick a tidy scale-bar length (1/2/5 × 10ⁿ) close to a target metre value.
function niceMetres(target: number): number {
  if (target <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const n = target / pow;
  const step = n >= 5 ? 5 : n >= 2 ? 2 : 1;
  return step * pow;
}

function fmtDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}

export function trailMapSVG(t: TrailState, opts: TrailMapOpts = {}): string {
  const W = opts.width ?? 480;
  const H = opts.height ?? 320;
  const pad = opts.padding ?? 30;
  const pts = t.points;
  const camp = t.baseCamp;
  const pois = t.pois ?? [];

  const coords: [number, number][] = [
    ...pts.map((p) => [p.lat, p.lon] as [number, number]),
    ...(camp ? [[camp.lat, camp.lon] as [number, number]] : []),
    ...pois.map((p) => [p.lat, p.lon] as [number, number]),
  ];

  const frame = `<rect x="0" y="0" width="${W}" height="${H}" fill="${PAL.paper}"/>
    <rect x="${pad - 6}" y="${pad - 6}" width="${W - 2 * pad + 12}" height="${H - 2 * pad + 12}" fill="none" stroke="${PAL.frame}" stroke-width="1.5" rx="6"/>`;

  if (coords.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui,Segoe UI,sans-serif">
      ${frame}
      <text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${PAL.faint}" font-size="14">No route recorded for this trip</text>
    </svg>`;
  }

  const lats = coords.map((c) => c[0]);
  const lons = coords.map((c) => c[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const meanLat = (minLat + maxLat) / 2;
  const kx = Math.cos((meanLat * Math.PI) / 180) || 1e-6;

  const minX = minLon * kx, maxX = maxLon * kx;
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const drawW = spanX * scale, drawH = spanY * scale;
  const offX = (W - drawW) / 2, offY = (H - drawH) / 2;

  const project = (lat: number, lon: number): [number, number] => [
    offX + (lon * kx - minX) * scale,
    offY + (maxLat - lat) * scale, // flip: north is up
  ];

  // faint frame grid (visual reference only, not graticule)
  let grid = "";
  const cols = 6, rows = 4;
  const gx0 = pad, gx1 = W - pad, gy0 = pad, gy1 = H - pad;
  for (let i = 1; i < cols; i++) {
    const x = gx0 + ((gx1 - gx0) * i) / cols;
    grid += `<line x1="${x.toFixed(1)}" y1="${gy0}" x2="${x.toFixed(1)}" y2="${gy1}" stroke="${PAL.grid}" stroke-width="1"/>`;
  }
  for (let i = 1; i < rows; i++) {
    const y = gy0 + ((gy1 - gy0) * i) / rows;
    grid += `<line x1="${gx0}" y1="${y.toFixed(1)}" x2="${gx1}" y2="${y.toFixed(1)}" stroke="${PAL.grid}" stroke-width="1"/>`;
  }

  // route (white halo under an orange line). Thin to a bounded number of vertices
  // for the path - identical at this size, but keeps the DOM/exports light when a
  // long hike holds thousands of points. The full set still drives the bbox above.
  let route = "";
  if (pts.length >= 2) {
    const MAXV = 600;
    const stride = Math.max(1, Math.ceil(pts.length / MAXV));
    const sampled = pts.filter((_, i) => i % stride === 0);
    if (sampled[sampled.length - 1] !== pts[pts.length - 1]) sampled.push(pts[pts.length - 1]);
    const d = sampled.map((p, i) => {
      const [x, y] = project(p.lat, p.lon);
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
    route =
      `<path d="${d}" fill="none" stroke="${PAL.routeHalo}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>` +
      `<path d="${d}" fill="none" stroke="${PAL.route}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  const dot = (lat: number, lon: number, fill: string, label: string) => {
    const [x, y] = project(lat, lon);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="${fill}" stroke="#fff" stroke-width="2"/>
      <text x="${x.toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="9" font-weight="700">${label}</text>`;
  };

  let markers = "";
  if (pts.length) {
    markers += dot(pts[0].lat, pts[0].lon, PAL.start, "S");
    if (pts.length > 1) markers += dot(pts[pts.length - 1].lat, pts[pts.length - 1].lon, PAL.end, "E");
  }
  if (camp) {
    const [x, y] = project(camp.lat, camp.lon);
    markers += `<rect x="${(x - 6).toFixed(1)}" y="${(y - 6).toFixed(1)}" width="12" height="12" transform="rotate(45 ${x.toFixed(1)} ${y.toFixed(1)})" fill="${PAL.camp}" stroke="#fff" stroke-width="2"/>
      <text x="${x.toFixed(1)}" y="${(y - 11).toFixed(1)}" text-anchor="middle" fill="${PAL.ink}" font-size="11" font-weight="600">⛺ ${xesc(camp.name)}</text>`;
  }
  pois.forEach((p, i) => {
    const [x, y] = project(p.lat, p.lon);
    markers += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${PAL.poi}" stroke="#fff" stroke-width="1.5"/>`;
    if (i < 8) markers += `<text x="${(x + 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="${PAL.ink}" font-size="10">${xesc(p.name)}</text>`;
  });

  // scale bar (bottom-left, inside the frame)
  const mPerPx = M_PER_UNIT / scale;
  const barM = niceMetres(mPerPx * (W * 0.22));
  const barPx = Math.min(barM / mPerPx, W - 2 * pad);
  const by = H - pad - 6, bx = pad + 4;
  const scaleBar = `<line x1="${bx}" y1="${by}" x2="${(bx + barPx).toFixed(1)}" y2="${by}" stroke="${PAL.ink}" stroke-width="3"/>
    <line x1="${bx}" y1="${by - 4}" x2="${bx}" y2="${by + 4}" stroke="${PAL.ink}" stroke-width="2"/>
    <line x1="${(bx + barPx).toFixed(1)}" y1="${by - 4}" x2="${(bx + barPx).toFixed(1)}" y2="${by + 4}" stroke="${PAL.ink}" stroke-width="2"/>
    <text x="${bx}" y="${by - 7}" fill="${PAL.ink}" font-size="11" font-weight="600">${fmtDist(barM)}</text>`;

  // north arrow (top-right)
  const nx = W - pad - 10, ny = pad + 22;
  const north = `<line x1="${nx}" y1="${ny}" x2="${nx}" y2="${ny - 16}" stroke="${PAL.ink}" stroke-width="2"/>
    <path d="M${nx} ${ny - 19} L${nx - 4} ${ny - 12} L${nx + 4} ${ny - 12} Z" fill="${PAL.ink}"/>
    <text x="${nx}" y="${ny + 11}" text-anchor="middle" fill="${PAL.ink}" font-size="11" font-weight="700">N</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui,Segoe UI,sans-serif">
    ${frame}
    ${grid}
    ${route}
    ${markers}
    ${scaleBar}
    ${north}
  </svg>`;
}

// Rasterise an SVG string to a PNG Blob at `scale`× for a crisp export. The SVG is
// fully inline (no external refs) so the canvas isn't tainted and toBlob succeeds.
export function svgToPngBlob(svg: string, w: number, h: number, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas not available")); return; }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png");
    };
    img.onerror = () => reject(new Error("Could not render map image"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}
