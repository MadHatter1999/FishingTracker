import type { Bundle } from "../types";
import type { DayContext } from "./context";
import { fmtTime, fmtRange, fmtDate } from "../util/format";
import { localDateKey } from "./score";

const LINE = "=================================================";

function dayStats(bundle: Bundle, date: Date) {
  const key = localDateKey(date);
  const hrs = bundle.hours.filter((h) => localDateKey(h.time) === key);
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  return {
    water: avg(hrs.map((h) => h.waterTemp)),
    air: avg(hrs.map((h) => h.airTemp)),
    wind: avg(hrs.map((h) => h.windSpeed)),
    wave: avg(hrs.map((h) => h.waveHeight)),
  };
}

export function generateBriefing(bundle: Bundle, ctx: DayContext): string {
  const { date } = ctx;
  const astro = bundle.astro.find((a) => a.date === localDateKey(date));
  const s = dayStats(bundle, date);
  const best = ctx.windows[0];
  const second = ctx.windows[1];

  const out: string[] = [];
  out.push(LINE, "FISHING SUMMARY", LINE, "");
  out.push(`${bundle.location.name}, ${bundle.location.area}`);
  out.push(`${fmtDate(date)}`);
  const fresh = bundle.location.kind === "fresh";
  out.push(fresh
    ? `Freshwater (no tide) | Moon: ${astro?.moonName ?? "-"} ${astro?.moonIllum ?? "-"}%`
    : `Tide: ${bundle.tide.stationName} ${bundle.tide.live ? "(live)" : "(APPROX - verify)"} | Moon: ${astro?.moonName ?? "-"} ${astro?.moonIllum ?? "-"}% | ${astro?.tideStrength ?? "-"} tides`);
  out.push(`Sun: ${fmtTime(astro?.sunrise ?? null)} → ${fmtTime(astro?.sunset ?? null)}`);
  out.push(`Conditions: water ${fmt(s.water, "°C")}, air ${fmt(s.air, "°C")}, wind ${fmt(s.wind, " km/h")}, wave ${fmt(s.wave, " m")}`);
  out.push("");
  out.push(`Overall Fishing Score: ${ctx.overall.toFixed(1)}/10`);
  out.push("");
  out.push("Best Fishing Window:");
  out.push(`  Start: ${best ? fmtTime(best.start) : "-"}`);
  out.push(`  End:   ${best ? fmtTime(best.end) : "-"}`);
  out.push(`  Reason: ${best ? best.reason : fresh ? "No standout window - fish dawn and dusk." : "No standout window - fish the tide changes."}`);
  out.push("");
  out.push("Second Best Window:");
  out.push(`  Start: ${second ? fmtTime(second.start) : "-"}`);
  out.push(`  End:   ${second ? fmtTime(second.end) : "-"}`);
  out.push(`  Reason: ${second ? second.reason : "-"}`);
  out.push("");
  out.push(`Confidence: ${ctx.confidence}`);
  out.push("");

  out.push(LINE, "SPECIES FORECAST", LINE, "");
  for (const sp of ctx.species.slice(0, 8)) {
    out.push(`${sp.name}`);
    out.push(`  Encounter Probability: ${sp.encounter}%`);
    out.push(`  Catch Probability:     ${sp.catch}%`);
    out.push(`  Best Time:             ${sp.bestWindow}`);
    out.push(`  Best Location:         ${sp.bestLocation}`);
    out.push(`  Recommended Rig:       ${sp.rig}`);
    out.push(`  Recommended Bait/Lure: ${sp.bait}`);
    out.push(`  Expected Size:         ${sp.size}`);
    out.push(`  Eating Quality:        ${sp.eating}/10`);
    out.push(`  Legal To Keep:         ${flagText(sp.legalFlag)} - ${sp.legal}`);
    out.push("");
  }

  out.push(LINE, "HOURLY BREAKDOWN", LINE, "");
  for (const h of ctx.scoredDay) {
    const t = h.time.getHours();
    if (t < 4 || t > 22) continue; // trim deep night for readability
    out.push(`${fmtTime(h.time).padStart(8)}  ${rateBlock(h.score)}  ${h.score.toFixed(1)}  ${h.reasons.join(", ") || "-"}`);
  }
  out.push("");

  out.push(LINE, "HOTSPOTS", LINE, "");
  for (const sp of ctx.hotspots) {
    out.push(`#${sp.rank} ${sp.name} (${sp.score}/10)`);
    out.push(`   Best for: ${sp.bestFor.join(", ")}`);
    out.push(`   ${sp.why}`);
    out.push("");
  }

  out.push(LINE, "TACTICS", LINE, "");
  out.push(`Recommended setup:     ${ctx.tactics.setup}`);
  out.push(`Recommended lure colors:${ctx.tactics.lureColors}`);
  out.push(`Recommended bait:      ${ctx.tactics.bait}`);
  out.push(`Recommended retrieval: ${ctx.tactics.retrieval}`);
  out.push("");

  out.push(LINE, "LOG ANALYSIS", LINE, "");
  const a = ctx.analysis;
  out.push(`Trips logged: ${a.trips} | Total fish: ${a.totalFish} | ${a.fishPerTrip}/trip | ${a.fishPerHour}/hr`);
  out.push("Historical patterns:");
  if (a.insights.length) a.insights.forEach((i) => out.push(`  - ${i.detail}`));
  else out.push("  - (log more trips to surface patterns)");
  out.push("Recent trends:");
  a.trends.forEach((t) => out.push(`  - ${t}`));
  out.push("Updated predictions:");
  if (a.predictions.length) a.predictions.forEach((p) => out.push(`  - ${p}`));
  else out.push("  - (need more data)");
  out.push("");

  out.push(LINE, "ACTION PLAN", LINE, "");
  ctx.tactics.actionPlan.forEach((p, i) => out.push(`${i + 1}. ${p}`));
  out.push("");
  out.push(`Arrive: ${ctx.tactics.arrival} | Leave: ${ctx.tactics.departure}`);
  out.push(`Start: ${ctx.tactics.startSpot}  →  Move to: ${ctx.tactics.moveSpot}`);
  out.push("");
  out.push("⚠ Always verify current DFO Maritimes recreational regulations (seasons, slot/size, limits, licences) before keeping any fish.");

  return out.join("\n");
}

function fmt(x: number | null, unit: string): string {
  return x == null ? "-" : `${x.toFixed(1)}${unit}`;
}
function flagText(f: string): string {
  return f === "keep" ? "Likely YES" : f === "release" ? "RELEASE" : "VERIFY";
}
function rateBlock(score: number): string {
  const n = Math.round(score / 2);
  return "█".repeat(n).padEnd(5, "·");
}

export { fmtRange };
