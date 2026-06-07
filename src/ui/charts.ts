import type { Bundle, FishingWindow } from "../types";
import { localDateKey } from "../engine/score";
import { fmtTime } from "../util/format";

export function scoreColor(score: number): string {
  // 0 red -> 5 amber -> 10 green
  if (score >= 7.5) return "#5ee0a0";
  if (score >= 6) return "#9ad86a";
  if (score >= 4.5) return "#ffcf5c";
  if (score >= 3) return "#ff9f5c";
  return "#ff6b6b";
}

export function gaugeSVG(score: number): string {
  const r = 56, c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, score / 10));
  const dash = c * frac;
  const col = scoreColor(score);
  return `
  <div class="gauge">
    <svg viewBox="0 0 132 132" width="132" height="132">
      <circle cx="66" cy="66" r="${r}" fill="none" stroke="var(--gauge-track)" stroke-width="12"/>
      <circle cx="66" cy="66" r="${r}" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${dash.toFixed(1)} ${(c - dash).toFixed(1)}" transform="rotate(-90 66 66)"/>
    </svg>
    <div class="num"><b style="color:${col}">${score.toFixed(1)}</b><span>/ 10</span></div>
  </div>`;
}

export function tideChartSVG(bundle: Bundle, day: Date, windows: FishingWindow[]): string {
  const key = localDateKey(day);
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = new Date(+dayStart + 86400000);
  const series = bundle.tide.series.filter((p) => +p.time >= +dayStart && +p.time <= +dayEnd);
  if (series.length < 2) return `<div class="muted">No tide curve available for this day.</div>`;

  const W = 1000, H = 260, padL = 38, padR = 16, padT = 24, padB = 28;
  const heights = series.map((p) => p.height);
  const minH = Math.min(...heights), maxH = Math.max(...heights);
  const range = Math.max(0.4, maxH - minH);
  const lo = minH - range * 0.12, hi = maxH + range * 0.12;

  const x = (t: Date) => padL + ((+t - +dayStart) / 86400000) * (W - padL - padR);
  const y = (h: number) => padT + (1 - (h - lo) / (hi - lo)) * (H - padT - padB);

  const path = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.time).toFixed(1)},${y(p.height).toFixed(1)}`).join(" ");
  const area = `${path} L${x(series[series.length - 1].time).toFixed(1)},${H - padB} L${x(series[0].time).toFixed(1)},${H - padB} Z`;

  // window shading
  const winRects = windows
    .map((w) => {
      const xs = Math.max(padL, x(w.start)), xe = Math.min(W - padR, x(w.end));
      if (xe <= xs) return "";
      return `<rect x="${xs.toFixed(1)}" y="${padT}" width="${(xe - xs).toFixed(1)}" height="${H - padT - padB}" fill="#5ee0a0" opacity="0.10"/>`;
    })
    .join("");

  // hour gridlines + labels (every 3h)
  let grid = "";
  for (let hr = 0; hr <= 24; hr += 3) {
    const t = new Date(+dayStart + hr * 3600000);
    const xx = x(t);
    grid += `<line x1="${xx.toFixed(1)}" y1="${padT}" x2="${xx.toFixed(1)}" y2="${H - padB}" stroke="#16314a" stroke-width="1"/>`;
    grid += `<text x="${xx.toFixed(1)}" y="${H - 10}" fill="#8fa9c0" font-size="11" text-anchor="middle">${hr === 24 ? "24" : hr}:00</text>`;
  }

  // extremes markers
  const exMarks = bundle.tide.extremes
    .filter((e) => localDateKey(e.time) === key)
    .map((e) => {
      const xx = x(e.time), yy = y(e.height);
      const col = e.type === "high" ? "#36c2ce" : "#5ee0a0";
      return `
        <circle cx="${xx.toFixed(1)}" cy="${yy.toFixed(1)}" r="4" fill="${col}"/>
        <text x="${xx.toFixed(1)}" y="${(yy - 10).toFixed(1)}" fill="#e8f1f8" font-size="11" text-anchor="middle" font-weight="700">${e.type === "high" ? "H" : "L"} ${e.height.toFixed(1)}m</text>
        <text x="${xx.toFixed(1)}" y="${(yy - 23).toFixed(1)}" fill="#8fa9c0" font-size="10" text-anchor="middle">${fmtTime(e.time)}</text>`;
    })
    .join("");

  // now marker
  const now = new Date();
  let nowMark = "";
  if (+now >= +dayStart && +now <= +dayEnd) {
    const xx = x(now);
    nowMark = `<line x1="${xx.toFixed(1)}" y1="${padT}" x2="${xx.toFixed(1)}" y2="${H - padB}" stroke="#ffcf5c" stroke-width="2" stroke-dasharray="4 3"/>
      <text x="${xx.toFixed(1)}" y="${padT - 8}" fill="#ffcf5c" font-size="11" text-anchor="middle" font-weight="700">now</text>`;
  }

  // y-axis labels
  let yLabels = "";
  for (let i = 0; i <= 3; i++) {
    const hv = lo + ((hi - lo) * i) / 3;
    const yy = y(hv);
    yLabels += `<text x="6" y="${(yy + 4).toFixed(1)}" fill="#8fa9c0" font-size="10">${hv.toFixed(1)}</text>`;
  }

  return `
  <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" style="display:block">
    <defs>
      <linearGradient id="tideFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#36c2ce" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#36c2ce" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${winRects}
    ${grid}
    ${yLabels}
    <path d="${area}" fill="url(#tideFill)"/>
    <path d="${path}" fill="none" stroke="#36c2ce" stroke-width="2.5"/>
    ${exMarks}
    ${nowMark}
  </svg>`;
}
