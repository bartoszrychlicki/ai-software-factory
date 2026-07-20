import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findUpFile } from "./projects";

/**
 * Jeden wiersz = jedno zdarzenie fabryki (zwykle wywołanie silnika).
 * Trafia do runs/metrics.jsonl — grepowalne, agregowane przez src/metrics/report.ts.
 * Podstawa pod data-driven routing i porównania silników (backlog #6).
 */
export interface MetricRow {
  ts: string;
  ticket: string;
  runId: string;
  stage: "plan" | "build" | "verify" | "verify-checks" | "review" | "fix";
  engine?: string; // spec z routingu, np. codex albo claude-code/sonnet
  attempt?: number; // próba build→verify
  round?: number; // runda review→fix
  ok: boolean; // czy wywołanie/krok technicznie się powiodło
  outcome: string; // znaczenie biznesowe: committed / pass / fail / lgtm / fix / check-fail / no-changes / engine-fail...
  costUsd?: number;
  durationMs?: number;
}

export async function recordMetric(row: Omit<MetricRow, "ts">): Promise<void> {
  try {
    const root = dirname(findUpFile("package.json"));
    await mkdir(join(root, "runs"), { recursive: true });
    await appendFile(
      join(root, "runs", "metrics.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n"
    );
  } catch (err) {
    // metryki są dodatkiem — nigdy nie wywalają pipeline'u
    console.error("Metryka nie zapisana:", err instanceof Error ? err.message : err);
  }
}
