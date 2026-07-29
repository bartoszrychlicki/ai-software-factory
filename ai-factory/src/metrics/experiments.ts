import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findUpFile } from "../pipeline/projects";
import type { LifecycleRun, LifecycleStore } from "../pipeline/lifecycle-store";

/**
 * runs/experiments.jsonl — dane eksperymentu kosztowo-jakościowego procesu.
 *
 * `summary` = jeden wiersz per ukończony ticket (wariant procesu, konfiguracja
 * modeli per etap wzięta z PODPISÓW faktycznych prób — nie z routing.yaml,
 * który zmienia się w czasie). `score` = ocena człowieka (/score 1-5),
 * dopisywana osobno, łączona po ticket+generation w raporcie.
 */
export interface ExperimentStageSummary {
  attempts: number;
  usd: number;
  minutes: number;
  /** Pierwsza próba etapu skończyła się sukcesem (first-pass rate). */
  firstTryOk: boolean;
  lastOutcome?: string;
  /** Podpis ostatniej próby: agent · harness@wersja · model@effort · profil. */
  signature?: string;
}

export interface ExperimentSummaryRow {
  kind: "summary";
  ts?: string;
  ticket: string;
  generation: number;
  project: string;
  /** solo | deep | v2 (runy sprzed pipeline'u v3). */
  variant: string;
  planEntry?: string;
  totalUsd: number;
  totalMinutes: number;
  /** Czas od claimu tej generacji do Done (ms). */
  leadTimeMs: number;
  stages: Record<string, ExperimentStageSummary>;
  degradations?: string[];
  critiqueVerdict?: string;
  reviewStatus?: string;
  smokeStatus?: string;
  prUrl?: string;
  retries: number;
  replans: number;
  score?: number;
  scoreComment?: string;
}

export interface ExperimentScoreRow {
  kind: "score";
  ts?: string;
  ticket: string;
  generation: number;
  project: string;
  score: number;
  comment?: string;
}

export type ExperimentRow = ExperimentSummaryRow | ExperimentScoreRow;

export async function appendExperimentRow(row: ExperimentRow): Promise<void> {
  try {
    const root = dirname(findUpFile("package.json"));
    await mkdir(join(root, "runs"), { recursive: true });
    await appendFile(
      join(root, "runs", "experiments.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n"
    );
  } catch (err) {
    // dane eksperymentu są dodatkiem — nigdy nie wywalają pollera
    console.error("Wiersz eksperymentu nie zapisany:", err instanceof Error ? err.message : err);
  }
}

/** Agregat prób per stage z trwałego rejestru — źródłem prawdy są podpisy prób. */
export function buildExperimentSummary(
  store: LifecycleStore,
  run: LifecycleRun
): ExperimentSummaryRow {
  const stages: Record<string, ExperimentStageSummary> = {};
  const firstAttempt = new Map<string, { attempt: number; ok: boolean }>();
  for (const attempt of store.listAttempts(run.ticketId)) {
    const entry = stages[attempt.stage] ?? {
      attempts: 0,
      usd: 0,
      minutes: 0,
      firstTryOk: false,
    };
    entry.attempts += 1;
    entry.usd += attempt.costUsd ?? 0;
    entry.minutes += (attempt.durationMs ?? 0) / 60_000;
    entry.lastOutcome = attempt.outcome ?? entry.lastOutcome;
    entry.signature = attempt.signature ?? entry.signature;
    stages[attempt.stage] = entry;
    const previous = firstAttempt.get(attempt.stage);
    if (!previous || attempt.attempt < previous.attempt) {
      firstAttempt.set(attempt.stage, { attempt: attempt.attempt, ok: attempt.status === "success" });
    }
  }
  for (const [stage, first] of firstAttempt) {
    stages[stage].firstTryOk = first.ok;
    stages[stage].usd = Number(stages[stage].usd.toFixed(4));
    stages[stage].minutes = Number(stages[stage].minutes.toFixed(2));
  }
  const usage = store.totalUsage(run.ticketId);
  return {
    kind: "summary",
    ticket: run.ticketId,
    generation: run.generation,
    project: run.project,
    variant: run.planVariant ?? (run.planEntry === "triage" ? "deep" : "v2"),
    planEntry: run.planEntry,
    totalUsd: Number(usage.usd.toFixed(4)),
    totalMinutes: Number(usage.minutes.toFixed(2)),
    leadTimeMs: Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt)),
    stages,
    degradations: run.degradations?.length ? run.degradations : undefined,
    critiqueVerdict: run.critiqueVerdict,
    reviewStatus: run.reviewStatus,
    smokeStatus: run.smokeStatus,
    prUrl: run.prUrl,
    retries: store.countProcessedCommands(run.ticketId, ["retry"]),
    replans: store.countProcessedCommands(run.ticketId, ["replan", "restart"]),
    score: run.score,
    scoreComment: run.scoreComment,
  };
}
