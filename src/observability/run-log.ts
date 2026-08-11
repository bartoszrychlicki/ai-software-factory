import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jobArtifactsDir, ticketRunsDir } from "../config/paths";
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
// head PR-a ma aktora `github`. Blokada po /reject i zmiana treści ticketu po
// starcie builda mają aktora `coordinator`, choć pochodzą odpowiednio od operatora
// i autora — wszystkie liczymy jako decyzje wywołane przez człowieka.
const HUMAN_TRANSITION_ACTORS = new Set(["human", "linear"]);

function isHumanTransition(transition: LifecycleTransition): boolean {
  return HUMAN_TRANSITION_ACTORS.has(transition.actor) ||
    transition.reason === "pr-head-changed" ||
    transition.reason === "INPUT_CHANGED_AFTER_BUILD" ||
    transition.reason.startsWith("PLAN_REJECTED /reject ");
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
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function minutes(value: number): string {
  return `${value.toFixed(2)} min`;
}

function leadTimeMinutes(store: LifecycleStore, run: LifecycleRun): number {
  const finishedAt = run.status === "done"
    ? (store.terminalTransitionAt(run.ticketId) ?? run.updatedAt)
    : run.updatedAt;
  const runStartedAt = Date.parse(run.createdAt);
  const persistedStartedAt = Date.parse(store.firstTransitionAt(run.ticketId) ?? "");
  const startedAt = Number.isFinite(persistedStartedAt) && persistedStartedAt < runStartedAt
    ? persistedStartedAt
    : runStartedAt;
  const elapsed = Date.parse(finishedAt) - startedAt;
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) / 60_000 : 0;
}

function finalStatus(run: LifecycleRun): string {
  if (run.status === "done" && run.errorCode === "CANCELED") return "anulowany";
  if (run.status === "done") return "done";
  if (run.status === "blocked") {
    return `zablokowany (${run.errorCode ?? "brak kodu"}) — generacja ${run.generation} aktywna`;
  }
  return `w toku — generacja ${run.generation}, etap ${run.stage}/${run.status}`;
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

function artifactLinks(ticketId: string, attempt: StageAttempt): string {
  if (!attempt.jobRunId) return "— brak artefaktów";
  const localTest = attempt.jobRunId.startsWith("local-test:");
  const dir = localTest
    ? ticketRunsDir(ticketId)
    : jobArtifactsDir(ticketId, attempt.jobRunId);
  try {
    let files = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    if (localTest) {
      const number = String(attempt.attempt);
      const patterns = [
        new RegExp(`^test-result-g\\d+-a${number}\\.json$`),
        new RegExp(`^test-result-g\\d+-a${number}\\.json\\.input\\.json$`),
        new RegExp(`^test-runner-a${number}\\.log$`),
      ];
      files = files.filter((file) => patterns.some((pattern) => pattern.test(file)));
    }
    files.sort((left, right) => left.localeCompare(right));
    if (files.length === 0) return "— brak artefaktów";
    if (localTest) {
      return files.map((file) => `[${cell(file)}](./${encodeURIComponent(file)})`).join("<br>");
    }
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
  const transitions = store.listTransitions(run.ticketId);
  const attempts = store.listAttempts(run.ticketId);
  const usage = store.totalUsage(run.ticketId);
  const retiredGenerations = store.countRetiredGenerations(run.ticketId);
  const humanTransitions = transitions.filter(isHumanTransition);
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
    `| liczba generacji | ${run.generation} |`,
    ...(retiredGenerations > 0 ? [`| porzucone generacje | ${retiredGenerations} |`] : []),
    `| liczba przejść | ${transitions.length} |`,
    `| przejścia wywołane przez człowieka | ${humanTransitions.length} |`,
    `| lead time${run.status === "done" ? "" : " (w toku)"} | ${minutes(leadTimeMinutes(store, run))} |`,
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
    `| RAZEM | ${attempts.length} | ${usd(usage.usd)} | ${usage.usd > 0 ? "100.0%" : "0.0%"} | ${minutes(usage.minutes)} | — | — |`,
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
      artifactLinks(run.ticketId, attempt),
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
    const dir = ticketRunsDir(run.ticketId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "przebieg.md"), buildRunLog(store, run));
  } catch (error) {
    console.error(
      `Przebieg ${run.ticketId} nie zapisany:`,
      error instanceof Error ? error.message : error
    );
  }
}
