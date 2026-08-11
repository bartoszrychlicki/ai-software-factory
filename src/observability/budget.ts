import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findUpFile, getProject } from "../config/projects";
import type { MetricRow } from "./metrics";

/**
 * Budżet per ticket-run: twardy limit łącznego czasu i kosztu (ekwiwalent API)
 * wywołań silników w jednym runie. Liczony z runs/metrics.jsonl — deterministyczny
 * kod pilnuje budżetów, agenci o nich nie decydują.
 * Globalne defaulty przez env, per projekt nadpisywane w projects.yaml (budget:).
 */
const DEFAULT_MAX_MINUTES = 45;
const DEFAULT_MAX_USD = 3;

export interface RunUsage {
  minutes: number;
  usd: number;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Wspólne, walidowane fallbacki budżetu dla egzekwowania i projekcji MCP. */
export function budgetDefaults(): { maxMinutes: number; maxUsd: number } {
  return {
    maxMinutes: positiveNumber(process.env.FACTORY_BUDGET_MAX_MIN, DEFAULT_MAX_MINUTES),
    maxUsd: positiveNumber(process.env.FACTORY_BUDGET_MAX_USD, DEFAULT_MAX_USD),
  };
}

export async function getRunUsage(ticket: string, runId: string): Promise<RunUsage> {
  let ms = 0;
  let usd = 0;
  try {
    const path = join(dirname(findUpFile("package.json")), "runs", "metrics.jsonl");
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (!line) continue;
      const r = JSON.parse(line) as MetricRow;
      if (r.ticket === ticket && r.runId === runId) {
        ms += r.durationMs ?? 0;
        usd += r.costUsd ?? 0;
      }
    }
  } catch {
    /* brak pliku = brak zużycia */
  }
  return { minutes: ms / 60_000, usd };
}

/**
 * null = w budżecie; string = powód przekroczenia.
 * Kroki decydują same: build/verify rzucają BLOCKED, review/fix degradują się do no-op.
 */
export async function budgetExceeded(
  ticket: { id: string; project: string },
  runId: string
): Promise<string | null> {
  const project = await getProject(ticket.project).catch(() => undefined);
  const defaults = budgetDefaults();
  const maxMinutes = project?.budget?.maxMinutes ?? defaults.maxMinutes;
  const maxUsd = project?.budget?.maxUsd ?? defaults.maxUsd;
  const usage = await getRunUsage(ticket.id, runId);

  if (usage.minutes > maxMinutes) {
    return `łączny czas silników ${usage.minutes.toFixed(1)} min > limit ${maxMinutes} min`;
  }
  if (usage.usd > maxUsd) {
    return `łączny koszt $${usage.usd.toFixed(2)} (ekwiwalent API) > limit $${maxUsd}`;
  }
  return null;
}
