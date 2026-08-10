import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findUpFile } from "../config/projects";
import type {
  LifecycleRun,
  LifecycleStore,
  LifecycleTransition,
  StageAttempt,
} from "../lifecycle/store";

interface StageSummary {
  attempts: number;
  usd: number;
  minutes: number;
  firstTryOk: boolean;
  signature?: string;
}

// `human` to jawne komendy, `linear` to ręczne zmiany ticketu. Push zmieniający
// head PR-a ma aktora `github`, ale fizycznie pochodzi od operatora — dlatego
// `pr-head-changed` również liczymy jako decyzję wywołaną przez człowieka.
const HUMAN_TRANSITION_ACTORS = new Set(["human", "linear"]);

function isHumanTransition(transition: LifecycleTransition): boolean {
  return HUMAN_TRANSITION_ACTORS.has(transition.actor) || transition.reason === "pr-head-changed";
}

function flatText(value: unknown): string {
  return String(value ?? "").replace(/\r\n?|\n/g, " ");
}

function cell(value: unknown): string {
  const text = flatText(value).replace(/\|/g, "\\|").trim();
  return text || "—";
}

function clippedReason(reason: string): string {
  const text = flatText(reason).trim();
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function minutes(value: number): string {
  return `${value.toFixed(2)} min`;
}

function leadTimeMinutes(run: LifecycleRun): number {
  const elapsed = Date.parse(run.updatedAt) - Date.parse(run.createdAt);
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) / 60_000 : 0;
}

function finalStatus(run: LifecycleRun): string {
  if (run.status === "done" && run.errorCode === "CANCELED") return "anulowany";
  if (run.status === "done") return "done";
  return `w toku — generacja ${Math.max(1, run.generation - 1)} porzucona`;
}

function transitionState(stage: string | undefined, status: string | undefined): string {
  return stage && status ? `${stage}/${status}` : "—";
}

function renderTransitionTable(transitions: LifecycleTransition[]): string[] {
  const lines = [
    "| # | czas | gen | z → do | aktor | powód | 👤 |",
    "|---:|---|---:|---|---|---|:---:|",
  ];
  for (const transition of transitions) {
    lines.push(`${[
      `| ${transition.id}`,
      cell(transition.createdAt),
      String(transition.generation),
      cell(`${transitionState(transition.fromStage, transition.fromStatus)} → ${transitionState(transition.toStage, transition.toStatus)}`),
      cell(transition.actor),
      cell(clippedReason(transition.reason)),
      isHumanTransition(transition) ? "👤" : "—",
    ].join(" | ")} |`);
  }
  return lines;
}

function aggregateStages(attempts: StageAttempt[]): Map<string, StageSummary> {
  const stages = new Map<string, StageSummary>();
  const firstAttempts = new Map<string, StageAttempt>();
  for (const attempt of attempts) {
    const summary = stages.get(attempt.stage) ?? {
      attempts: 0,
      usd: 0,
      minutes: 0,
      firstTryOk: false,
    };
    summary.attempts += 1;
    summary.usd += attempt.costUsd ?? 0;
    summary.minutes += (attempt.durationMs ?? 0) / 60_000;
    summary.signature = attempt.signature ?? summary.signature;
    stages.set(attempt.stage, summary);

    const first = firstAttempts.get(attempt.stage);
    if (!first || attempt.attempt < first.attempt) firstAttempts.set(attempt.stage, attempt);
  }
  for (const [stage, first] of firstAttempts) {
    stages.get(stage)!.firstTryOk = first.status === "success";
  }
  return stages;
}

function artifactLinks(root: string, ticketId: string, attempt: StageAttempt): string {
  if (!attempt.jobRunId) return "— brak artefaktów";
  const dir = join(root, "runs", ticketId, attempt.jobRunId);
  try {
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    if (files.length === 0) return "— brak artefaktów";
    const encodedRunId = encodeURIComponent(attempt.jobRunId);
    const directoryLink = `[./${cell(attempt.jobRunId)}/](./${encodedRunId}/)`;
    const fileLinks = files.map((file) =>
      `[${cell(file)}](./${encodedRunId}/${encodeURIComponent(file)})`
    );
    return [directoryLink, ...fileLinks].join("<br>");
  } catch {
    return "— brak artefaktów";
  }
}

function attemptError(attempt: StageAttempt): string {
  if (!attempt.errorCode && !attempt.errorMessage) return "—";
  return [attempt.errorCode, attempt.errorMessage].filter(Boolean).join(": ");
}

/** Składa pełny, tylko-do-odczytu widok historii ticketu z trwałego store. */
export function buildRunLog(store: LifecycleStore, run: LifecycleRun): string {
  const root = dirname(findUpFile("package.json"));
  const transitions = store.listTransitions(run.ticketId);
  const attempts = store.listAttempts(run.ticketId);
  const usage = store.totalUsage(run.ticketId);
  const humanTransitions = transitions.filter(isHumanTransition);
  const generations = new Set(transitions.map((transition) => transition.generation)).size;
  const stages = [...aggregateStages(attempts).entries()]
    .sort(([leftStage, left], [rightStage, right]) =>
      right.usd - left.usd || leftStage.localeCompare(rightStage)
    );
  const score = run.score === undefined
    ? "—"
    : `${run.score}/5${run.scoreComment ? ` — ${run.scoreComment}` : ""}`;

  const lines = [
    `# ${flatText(run.ticketId)} — przebieg ticketu`,
    "",
    `- Tytuł: ${flatText(run.manifest.title) || "—"}`,
    `- Projekt: ${flatText(run.project) || "—"}`,
    `- Status: ${finalStatus(run)}`,
    ...(run.errorCode ? [`- Kod błędu: \`${flatText(run.errorCode)}\``] : []),
    ...(run.errorMessage ? [`- Błąd: ${flatText(run.errorMessage)}`] : []),
    ...(run.manifest.url ? [`- Ticket: [${flatText(run.ticketId)}](${run.manifest.url})`] : []),
    ...(run.prUrl ? [`- Pull request: [${flatText(run.prUrl)}](${run.prUrl})`] : []),
    ...(run.mergedSha ? [`- Merge SHA: \`${flatText(run.mergedSha)}\``] : []),
    `- Wygenerowano: ${new Date().toISOString()}`,
    "",
    "## Podsumowanie",
    "",
    "| metryka | wartość |",
    "|---|---:|",
    `| koszt łączny | ${usd(usage.usd)} |`,
    `| czas prób łącznie | ${minutes(usage.minutes)} |`,
    `| liczba generacji | ${generations} |`,
    `| liczba przejść | ${transitions.length} |`,
    `| przejścia wywołane przez człowieka | ${humanTransitions.length} |`,
    `| lead time | ${minutes(leadTimeMinutes(run))} |`,
    `| ocena /score | ${cell(score)} |`,
    "",
    "## Koszt per etap",
    "",
    "| etap | prób | koszt | % kosztu | czas | 1. próba OK | podpis ostatniej próby |",
    "|---|---:|---:|---:|---:|:---:|---|",
  ];

  for (const [stage, summary] of stages) {
    const share = usage.usd > 0 ? summary.usd / usage.usd * 100 : 0;
    lines.push(
      `| ${cell(stage)} | ${summary.attempts} | ${usd(summary.usd)} | ${share.toFixed(1)}% | ${minutes(summary.minutes)} | ${summary.firstTryOk ? "tak" : "nie"} | ${cell(summary.signature)} |`
    );
  }
  lines.push(
    `| RAZEM | ${attempts.length} | ${usd(usage.usd)} | 100.0% | ${minutes(usage.minutes)} | — | — |`,
    "",
    `## Decyzje człowieka (${humanTransitions.length})`,
    "",
    ...renderTransitionTable(humanTransitions),
    "",
    "## Oś czasu",
    "",
    ...renderTransitionTable(transitions),
    "",
    "## Próby etapów",
    "",
    "> Próby są uporządkowane po czasie rozpoczęcia. Baza nie przypisuje prób do generacji.",
    "",
    "| czas | etap | próba | status / outcome | koszt | czas | faktyczny podpis modelu | błąd | artefakty |",
    "|---|---|---:|---|---|---:|---|---|---|",
  );

  for (const attempt of attempts) {
    const outcome = attempt.outcome ? `${attempt.status} / ${attempt.outcome}` : attempt.status;
    const attemptCost = attempt.costUsd === undefined
      ? "—"
      : `${usd(attempt.costUsd)}${attempt.costSource ? ` (${attempt.costSource})` : ""}`;
    lines.push(`${[
      `| ${cell(attempt.startedAt)}`,
      cell(attempt.stage),
      String(attempt.attempt),
      cell(outcome),
      cell(attemptCost),
      attempt.durationMs === undefined ? "—" : minutes(attempt.durationMs / 60_000),
      cell(attempt.signature),
      cell(attemptError(attempt)),
      artifactLinks(root, run.ticketId, attempt),
    ].join(" | ")} |`);
  }
  if (attempts.length === 0) {
    lines.push("| — | — | — | — | — | — | — | — | — brak prób |");
  }

  return `${lines.join("\n")}\n`;
}

/** Nadpisuje lokalny punkt wejścia do artefaktów; błąd zawsze jest fail-open. */
export function writeRunLog(store: LifecycleStore, run: LifecycleRun): void {
  try {
    const root = dirname(findUpFile("package.json"));
    const dir = join(root, "runs", run.ticketId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "przebieg.md"), buildRunLog(store, run));
  } catch (error) {
    console.error(
      `Przebieg ${run.ticketId} nie zapisany:`,
      error instanceof Error ? error.message : error
    );
  }
}
