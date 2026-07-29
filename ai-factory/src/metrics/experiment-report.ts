/**
 * Raport eksperymentu procesu: koszt/czas/first-pass/score per wariant
 * (solo vs deep vs v2) i per konfiguracja modeli.
 *
 * Uruchomienie: npx tsx src/metrics/experiment-report.ts
 * Czyta runs/experiments.jsonl (wiersze `summary` + `score`); duplikaty
 * ticket+generation rozstrzyga ostatni wiersz (re-emit po crash-restart).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { findUpFile } from "../pipeline/projects";
import type { ExperimentRow, ExperimentSummaryRow } from "./experiments";

interface VariantAggregate {
  tickets: number;
  totalUsd: number;
  totalMinutes: number;
  leadTimeMs: number;
  testFirstPass: number;
  testMeasured: number;
  reviewLgtm: number;
  reviewMeasured: number;
  retries: number;
  replans: number;
  scores: number[];
}

export function loadExperimentRows(path: string): ExperimentRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ExperimentRow];
      } catch {
        return [];
      }
    });
}

export function mergeRows(rows: ExperimentRow[]): ExperimentSummaryRow[] {
  const summaries = new Map<string, ExperimentSummaryRow>();
  for (const row of rows) {
    if (row.kind !== "summary") continue;
    summaries.set(`${row.ticket}:g${row.generation}`, row);
  }
  for (const row of rows) {
    if (row.kind !== "score") continue;
    const summary = summaries.get(`${row.ticket}:g${row.generation}`);
    if (summary) {
      summary.score = row.score;
      summary.scoreComment = row.comment ?? summary.scoreComment;
    }
  }
  return [...summaries.values()];
}

function aggregate(summaries: ExperimentSummaryRow[]): Map<string, VariantAggregate> {
  const byVariant = new Map<string, VariantAggregate>();
  for (const row of summaries) {
    const entry = byVariant.get(row.variant) ?? {
      tickets: 0,
      totalUsd: 0,
      totalMinutes: 0,
      leadTimeMs: 0,
      testFirstPass: 0,
      testMeasured: 0,
      reviewLgtm: 0,
      reviewMeasured: 0,
      retries: 0,
      replans: 0,
      scores: [],
    };
    entry.tickets += 1;
    entry.totalUsd += row.totalUsd;
    entry.totalMinutes += row.totalMinutes;
    entry.leadTimeMs += row.leadTimeMs;
    const test = row.stages.test;
    if (test) {
      entry.testMeasured += 1;
      if (test.firstTryOk) entry.testFirstPass += 1;
    }
    if (row.reviewStatus === "lgtm" || row.reviewStatus === "advisory-fix") {
      entry.reviewMeasured += 1;
      if (row.reviewStatus === "lgtm") entry.reviewLgtm += 1;
    }
    entry.retries += row.retries;
    entry.replans += row.replans;
    if (typeof row.score === "number") entry.scores.push(row.score);
    byVariant.set(row.variant, entry);
  }
  return byVariant;
}

function fmtPct(part: number, total: number): string {
  return total ? `${Math.round((part / total) * 100)}% (${part}/${total})` : "—";
}

function fmtAvg(total: number, count: number, digits = 2): string {
  return count ? (total / count).toFixed(digits) : "—";
}

export function renderReport(summaries: ExperimentSummaryRow[]): string {
  if (!summaries.length) return "Brak wierszy summary w runs/experiments.jsonl.";
  const lines: string[] = [];
  lines.push("# Eksperyment procesu planowania — wariant × wynik");
  lines.push("");
  const byVariant = aggregate(summaries);
  const header = [
    "wariant", "tickety", "śr. koszt $", "śr. minuty", "śr. lead h",
    "test first-pass", "review LGTM", "retry/tkt", "replan/tkt", "śr. score",
  ];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const [variant, agg] of [...byVariant.entries()].sort()) {
    lines.push(`| ${[
      variant,
      String(agg.tickets),
      fmtAvg(agg.totalUsd, agg.tickets),
      fmtAvg(agg.totalMinutes, agg.tickets, 1),
      fmtAvg(agg.leadTimeMs / 3_600_000, agg.tickets, 1),
      fmtPct(agg.testFirstPass, agg.testMeasured),
      fmtPct(agg.reviewLgtm, agg.reviewMeasured),
      fmtAvg(agg.retries, agg.tickets, 1),
      fmtAvg(agg.replans, agg.tickets, 1),
      agg.scores.length
        ? `${fmtAvg(agg.scores.reduce((sum, score) => sum + score, 0), agg.scores.length, 1)} (n=${agg.scores.length})`
        : "—",
    ].join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Konfiguracje modeli per ticket (podpisy faktycznych prób)");
  lines.push("");
  for (const row of summaries.sort((a, b) => a.ticket.localeCompare(b.ticket))) {
    const models = Object.entries(row.stages)
      .filter(([, stage]) => stage.signature)
      .map(([stage, data]) => `${stage}: ${data.signature?.split(" · ").slice(1, 3).join("/")}`)
      .join("; ");
    lines.push(
      `- ${row.ticket} (g${row.generation}, ${row.variant}): $${row.totalUsd.toFixed(2)}, ` +
      `${row.totalMinutes.toFixed(0)} min, score ${row.score ?? "—"}` +
      `${row.degradations?.length ? `, ⚠️ ${row.degradations.length} degradacji` : ""}` +
      `${models ? ` — ${models}` : ""}`
    );
  }
  return lines.join("\n");
}

function main(): void {
  const path = join(dirname(findUpFile("package.json")), "runs", "experiments.jsonl");
  console.log(renderReport(mergeRows(loadExperimentRows(path))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
