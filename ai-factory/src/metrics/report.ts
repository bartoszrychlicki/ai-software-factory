/**
 * Raport z runs/metrics.jsonl: koszt/czas/skuteczność per etap i silnik.
 * Uruchomienie: npx tsx src/metrics/report.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findUpFile } from "../pipeline/projects";
import type { MetricRow } from "../pipeline/metrics";

const path = join(dirname(findUpFile("package.json")), "runs", "metrics.jsonl");
let rows: MetricRow[];
try {
  rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as MetricRow);
} catch {
  console.log(`Brak metryk (${path}) — jeszcze żaden run nie przeszedł po instrumentacji.`);
  process.exit(0);
}

const fmtUsd = (v: number) => `$${v.toFixed(3)}`;
const fmtSec = (ms: number) => `${Math.round(ms / 1000)}s`;
const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((100 * a) / b)}%`);

// --- agregat per etap × silnik -------------------------------------------
interface Agg { calls: number; ok: number; costUsd: number; durationMs: number; timed: number }
const groups = new Map<string, Agg>();
for (const r of rows) {
  const key = `${r.stage}|${r.engine ?? "-"}`;
  const g = groups.get(key) ?? { calls: 0, ok: 0, costUsd: 0, durationMs: 0, timed: 0 };
  g.calls++;
  if (r.ok) g.ok++;
  if (r.costUsd) g.costUsd += r.costUsd;
  if (r.durationMs) { g.durationMs += r.durationMs; g.timed++; }
  groups.set(key, g);
}

console.log(`Metryki fabryki — ${rows.length} zdarzeń, ${new Set(rows.map((r) => `${r.ticket}/${r.runId}`)).size} runów\n`);
console.log("etap          silnik                calls   ok%    koszt razem   śr. koszt   śr. czas");
console.log("─".repeat(88));
for (const [key, g] of [...groups.entries()].sort()) {
  const [stage, engine] = key.split("|");
  console.log(
    stage.padEnd(14) + engine.padEnd(22) +
    String(g.calls).padEnd(8) + pct(g.ok, g.calls).padEnd(7) +
    fmtUsd(g.costUsd).padEnd(14) + fmtUsd(g.calls ? g.costUsd / g.calls : 0).padEnd(12) +
    (g.timed ? fmtSec(g.durationMs / g.timed) : "—")
  );
}

// --- planner cold vs resumed (BAR-136) -----------------------------------
const planModes = new Map<boolean, Agg>([
  [false, { calls: 0, ok: 0, costUsd: 0, durationMs: 0, timed: 0 }],
  [true, { calls: 0, ok: 0, costUsd: 0, durationMs: 0, timed: 0 }],
]);
for (const row of rows.filter((candidate) => candidate.stage === "plan" && candidate.resumed !== undefined)) {
  const group = planModes.get(row.resumed as boolean)!;
  group.calls++;
  if (row.ok) group.ok++;
  if (row.costUsd) group.costUsd += row.costUsd;
  if (row.durationMs) { group.durationMs += row.durationMs; group.timed++; }
}
if ([...planModes.values()].some((group) => group.calls > 0)) {
  console.log("\nPlan: cold vs resumed");
  console.log("tryb             calls   ok%    koszt razem   śr. koszt   śr. czas");
  console.log("─".repeat(70));
  for (const resumed of [false, true]) {
    const group = planModes.get(resumed)!;
    console.log(
      `resumed=${String(resumed)}`.padEnd(17) +
      String(group.calls).padEnd(8) + pct(group.ok, group.calls).padEnd(7) +
      fmtUsd(group.costUsd).padEnd(14) + fmtUsd(group.calls ? group.costUsd / group.calls : 0).padEnd(12) +
      (group.timed ? fmtSec(group.durationMs / group.timed) : "—")
    );
  }
}

// --- wskaźniki pochodne ---------------------------------------------------
const verifies = rows.filter((r) => r.stage === "verify" || r.stage === "verify-checks");
const runsWithVerify = new Map<string, MetricRow[]>();
for (const r of verifies) {
  const k = `${r.ticket}/${r.runId}`;
  runsWithVerify.set(k, [...(runsWithVerify.get(k) ?? []), r]);
}
const firstPass = [...runsWithVerify.values()].filter((rs) =>
  rs.some((r) => r.stage === "verify" && r.outcome === "pass" && (r.attempt ?? 1) === 1)
).length;
console.log(`\nFirst-pass rate verify (PASS w próbie 1): ${pct(firstPass, runsWithVerify.size)} (${firstPass}/${runsWithVerify.size} runów)`);

const reviews = rows.filter((r) => r.stage === "review");
const lgtmFirst = reviews.filter((r) => (r.round ?? 1) === 1 && r.outcome === "lgtm").length;
const reviewRuns = new Set(reviews.map((r) => `${r.ticket}/${r.runId}`)).size;
console.log(`Review LGTM w rundzie 1: ${pct(lgtmFirst, reviewRuns)} (${lgtmFirst}/${reviewRuns} runów)`);

const totalCost = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
console.log(`Łączny koszt (ekwiwalent API; na subskrypcji = limity, nie USD): ${fmtUsd(totalCost)}`);
