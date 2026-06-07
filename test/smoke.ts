import { loadBundle } from "../src/data";
import { computeScores } from "../src/engine/score";
import { computeDay } from "../src/engine/context";
import { generateBriefing } from "../src/engine/briefing";
import { HOME, LAKES, loadNSLocations, makePinnedLocation, nearestStation, locationForPoint } from "../src/services/locations";
import { SPECIES, FRESH_SPECIES } from "../src/config";
import type { CatchRecord } from "../src/types";

async function main() {
  console.log("Fetching live bundle…");
  const bundle = await loadBundle(HOME, 7);
  console.log("tide.live:", bundle.tide.live, "| series pts:", bundle.tide.series.length, "| extremes:", bundle.tide.extremes.length, "| meanRange:", bundle.tide.meanRange.toFixed(2));
  console.log("hours:", bundle.hours.length, "| astro days:", bundle.astro.length, "| warnings:", bundle.warnings.length);
  const h0 = bundle.hours.find((h) => h.waterTemp != null);
  console.log("sample hour:", h0?.time.toISOString(), "water:", h0?.waterTemp, "wind:", h0?.windSpeed, "tide:", h0?.tideHeight, h0?.tideState);

  const scored = computeScores(bundle);
  const badScore = scored.find((s) => Number.isNaN(s.score));
  if (badScore) throw new Error("NaN score detected at " + badScore.time);

  const sampleLog: CatchRecord[] = [];
  const today = new Date();
  const ctx = computeDay(bundle, scored, sampleLog, today);
  console.log("\n--- TODAY ---");
  console.log("overall:", ctx.overall, "| confidence:", ctx.confidence, "| windows:", ctx.windows.length);
  ctx.windows.slice(0, 2).forEach((w) => console.log("  window", w.start.toISOString(), "->", w.end.toISOString(), "score", w.score, "|", w.reason));
  console.log("top species:");
  ctx.species.slice(0, 4).forEach((s) => console.log(`  ${s.name}: enc ${s.encounter}% catch ${s.catch}% | ${s.bestWindow} | ${s.legalFlag}`));
  console.log("hotspots:", ctx.hotspots.map((s) => `${s.name}=${s.score}`).join(", "));
  console.log("tactics arrival:", ctx.tactics.arrival, "depart:", ctx.tactics.departure, "start:", ctx.tactics.startSpot);

  const briefing = generateBriefing(bundle, ctx);
  console.log("\nbriefing length:", briefing.length, "chars");
  if (briefing.length < 800) throw new Error("Briefing suspiciously short");

  // check a future day works too
  const d3 = new Date(today.getTime() + 3 * 86400000);
  const ctx3 = computeDay(bundle, scored, sampleLog, d3);
  console.log("\n+3 days overall:", ctx3.overall, "windows:", ctx3.windows.length);

  // province-wide station list + a non-home NS location end to end
  const locs = await loadNSLocations();
  console.log("\nNS locations available:", locs.length, "| e.g.", locs.slice(1, 6).map((l) => l.name).join(", "));
  const other = locs.find((l) => /yarmouth|sydney|lunenburg|pictou|digby/i.test(l.name)) ?? locs[1];
  if (other) {
    const b2 = await loadBundle(other, 2);
    console.log(`\n${other.name}: tide.live=${b2.tide.live}, extremes=${b2.tide.extremes.length}, range=${b2.tide.meanRange.toFixed(2)}m`);
    const c2 = computeDay(b2, computeScores(b2), [], today);
    console.log(`  overall ${c2.overall}, top hotspot: ${c2.hotspots[0]?.name}`);
  }

  // pinned/arbitrary point -> nearest gauge (simulate clicking the map near Peggys Cove)
  const near = nearestStation(44.49, -63.92, locs);
  console.log("\nnearest gauge to 44.49,-63.92:", near?.station.name, `(${near?.km.toFixed(1)} km)`);
  const pin = makePinnedLocation(44.49, -63.92, locs, "Map pin");
  console.log("pinned:", pin.name, "|", pin.area, "| tideStation:", pin.tideStationName);
  const pinBundle = await loadBundle(pin, 2);
  console.log("pinned bundle: tide.live=", pinBundle.tide.live, "water=", pinBundle.hours.find((h) => h.waterTemp != null)?.waterTemp);
  if (!near) throw new Error("nearestStation returned null");

  // freshwater lake path
  const lake = LAKES[0];
  const lb = await loadBundle(lake, 3);
  const ls = computeScores(lb);
  const lc = computeDay(lb, ls, [], today);
  console.log(`\nLAKE: ${lake.name} | kind=${lb.location.kind} | tide.live=${lb.tide.live} extremes=${lb.tide.extremes.length}`);
  console.log("  overall:", lc.overall, "| windows:", lc.windows.length);
  console.log("  fresh species:", lc.species.slice(0, 4).map((s) => `${s.name} ${s.catch}%`).join(", "));
  console.log("  fresh hotspots:", lc.hotspots.slice(0, 3).map((h) => h.name).join(", "));
  if (lb.tide.live) throw new Error("Lake should not have live tide");
  if (lc.overall <= 0 || Number.isNaN(lc.overall)) throw new Error("Lake overall score invalid");
  if (!lc.species.some((s) => /trout|bass|perch|pickerel/i.test(s.name))) throw new Error("Lake should use freshwater species");

  // species variety + lake-aware map click
  console.log(`\nspecies lists: salt=${SPECIES.length}, fresh=${FRESH_SPECIES.length}`);
  const clickLake = locationForPoint(lake.lat, lake.lon, locs, "Click");
  const clickSea = locationForPoint(44.49, -63.5, locs, "Click");
  console.log("click on lake ->", clickLake.kind, "|", clickLake.name);
  console.log("click at sea  ->", clickSea.kind, "|", clickSea.tideStationName);
  if (clickLake.kind !== "fresh") throw new Error("Click on a lake should be freshwater");
  if (clickSea.kind !== "salt") throw new Error("Click at sea should be saltwater");
  if (SPECIES.length < 18 || FRESH_SPECIES.length < 11) throw new Error("Species lists not expanded");

  // named tagged animals (OCEARCH)
  const preds = bundle.predators;
  console.log(`\ntagged animals near home: ${preds.length}`);
  console.log("  e.g.:", preds.slice(0, 6).map((p) => `${p.name} (${p.species}, ping ${p.lastPing?.slice(0, 10) ?? "?"})`).join("; "));
  if (preds.length && !preds.every((p) => p.name && typeof p.lat === "number")) throw new Error("Tagged animals missing name/coords");

  // freshwater lake temp drives variation; brackish vs pure lake species sets
  const porters = LAKES.find((l) => l.name === "Porters Lake")!;
  const banook = LAKES.find((l) => l.name === "Lake Banook")!;
  const pb = await loadBundle(porters, 2);
  const bb = await loadBundle(banook, 2);
  const lakeTemp = pb.hours.find((h) => h.waterTemp != null)?.waterTemp;
  console.log("Porters brackish:", porters.brackish, "| est lake temp:", lakeTemp);
  const pSpecies = forecastNames(pb);
  const bSpecies = forecastNames(bb);
  console.log("Porters (brackish) species incl:", pSpecies.filter((n) => /bass|striped|mackerel|smelt|gaspereau|flounder|shad/i.test(n)).join(", "));
  console.log("Lake Banook (pure) species:", bSpecies.join(", "));
  if (lakeTemp == null) throw new Error("Lake water temp not estimated");
  if (!pSpecies.some((n) => /striped bass|mackerel|smelt|gaspereau|shad|flounder/i.test(n))) throw new Error("Brackish lake should include some sea fish");
  if (bSpecies.some((n) => /mackerel|pollock|cod|striped bass|herring/i.test(n))) throw new Error("Pure lake must NOT show open-sea fish");

  // provincial stocking (NS open data): a stocked HRM lake vs a wild one
  const maynard = LAKES.find((l) => l.name === "Maynard Lake")!;
  const mb = await loadBundle(maynard, 2);
  const st = mb.stocking;
  console.log(`\nstocking Maynard Lake: match=${st?.waterbody ?? "none"} latest=${st?.latest ?? "-"}`);
  if (st) console.log("  " + st.bySpecies.map((s) => `${s.species} x${s.total}`).join(" | "));
  console.log("Lake Banook stocking:", bb.stocking ? `MATCH ${bb.stocking.waterbody}` : "none (expected - wild lake)");
  if (!st || !st.bySpecies.some((s) => /trout/i.test(s.species))) throw new Error("Maynard Lake should show stocked trout");
  const mSpecies = computeDay(mb, computeScores(mb), [], today).species;
  if (!mSpecies.some((s) => s.stocked)) throw new Error("Maynard forecast should flag a stocked species");
  console.log("  Maynard stocked species in forecast:", mSpecies.filter((s) => s.stocked).map((s) => s.name).join(", "));

  console.log("\nSMOKE TEST PASSED ✅");
}

function forecastNames(b: import("../src/types").Bundle): string[] {
  const s = computeScores(b);
  return computeDay(b, s, [], new Date()).species.map((x) => x.name);
}

main().catch((e) => { console.error("SMOKE TEST FAILED ❌", e); process.exit(1); });
