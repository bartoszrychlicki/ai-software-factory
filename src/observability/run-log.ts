import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { jobArtifactsDir, ticketRunsDir } from "../config/paths";
import type {
  LifecycleRun,
  LifecycleStore,
  LifecycleTransition,
  StageAttempt,
} from "../lifecycle/store";
import {
  PLAN_REJECTED_HUMAN_REASON_PREFIX,
  PLAN_REJECTED_REASON,
} from "../lifecycle/transition-reasons";

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

export function isHumanTransition(transition: LifecycleTransition): boolean {
  return HUMAN_TRANSITION_ACTORS.has(transition.actor) ||
    transition.reason === "pr-head-changed" ||
    transition.reason === "INPUT_CHANGED_AFTER_BUILD" ||
    transition.reason === PLAN_REJECTED_REASON ||
    transition.reason.startsWith(PLAN_REJECTED_HUMAN_REASON_PREFIX);
}

function flatText(value: unknown): string {
  return String(value ?? "").replace(/\r\n?|\n/g, " ");
}

function cell(value: unknown): string {
  const text = flatText(value).replace(/\|/g, "\\|").trim();
  return text || "—";
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
      cell(transition.reason),
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

function artifactLinks(
  run: LifecycleRun,
  attempt: StageAttempt,
  retiredGenerations: number,
  directoryCache: Map<string, string[] | undefined>
): string {
  if (!attempt.jobRunId) return "— brak artefaktów";
  const localTest = attempt.jobRunId.startsWith("local-test:");
  if (localTest && attempt.generation === undefined) {
    return "— brak artefaktów (nieznana generacja)";
  }
  const dir = localTest
    ? ticketRunsDir(run.ticketId)
    : jobArtifactsDir(run.ticketId, attempt.jobRunId);
  try {
    let directoryFiles = directoryCache.get(dir);
    if (!directoryCache.has(dir)) {
      directoryFiles = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
      directoryCache.set(dir, directoryFiles);
    }
    if (!directoryFiles) return "— brak artefaktów";
    if (localTest) {
      const generation = attempt.generation!;
      const number = attempt.attempt;
      const exactFiles = [
        `test-result-g${generation}-a${number}.json`,
        `test-result-g${generation}-a${number}.json.input.json`,
        `test-runner-g${generation}-a${number}.log`,
      ];
      const files = exactFiles.filter((file) => directoryFiles.includes(file));
      const legacyName = `test-runner-a${number}.log`;
      const legacyExists = directoryFiles.includes(legacyName);
      const legacyUnambiguous = run.generation === 1 &&
        retiredGenerations === 0 &&
        generation === 1;
      if (legacyExists && legacyUnambiguous) files.push(legacyName);

      const links = files.map((file) =>
        `[${cell(file)}](./${markdownUrlSegment(file)})`
      );
      if (legacyExists && !legacyUnambiguous) {
        links.push("(pominięto legacy log runnera — niejednoznaczna generacja)");
      }
      return links.length > 0 ? links.join("<br>") : "— brak artefaktów";
    }

    const files = directoryFiles.sort((left, right) => left.localeCompare(right));
    if (files.length === 0) return "— brak artefaktów";
    const encodedRunId = markdownUrlSegment(attempt.jobRunId);
    const directoryLink = `[./${cell(attempt.jobRunId)}/](./${encodedRunId}/)`;
    const fileLinks = files.map((file) =>
      `[${cell(file)}](./${encodedRunId}/${markdownUrlSegment(file)})`
    );
    return [directoryLink, ...fileLinks].join("<br>");
  } catch {
    directoryCache.set(dir, undefined);
    return "— brak artefaktów";
  }
}

function markdownUrlSegment(value: string): string {
  return encodeURIComponent(value).replace(/\(/g, "%28").replace(/\)/g, "%29");
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
  const artifactDirectoryCache = new Map<string, string[] | undefined>();
  const humanTransitions = transitions.filter(isHumanTransition);
  const stages = [...aggregateStages(attempts).entries()]
    .sort(([leftStage, left], [rightStage, right]) =>
      right.usd - left.usd || leftStage.localeCompare(rightStage)
    );
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
    "> Próby są uporządkowane po czasie rozpoczęcia. Starsze wpisy mogą nie mieć przypisanej generacji; wtedy lokalne artefakty testów są pomijane zamiast zgadywane.",
    "",
    "| czas | gen | etap | próba | status / outcome | koszt | czas | faktyczny podpis modelu | błąd | artefakty |",
    "|---|---:|---|---:|---|---|---:|---|---|---|",
  );

  for (const attempt of attempts) {
    const outcome = attempt.outcome ? `${attempt.status} / ${attempt.outcome}` : attempt.status;
    const attemptCost = attempt.costUsd === undefined
      ? "—"
      : `${usd(attempt.costUsd)}${attempt.costSource ? ` (${attempt.costSource})` : ""}`;
    lines.push(`${[
      `| ${cell(attempt.startedAt)}`,
      attempt.generation === undefined ? "—" : String(attempt.generation),
      cell(attempt.stage),
      String(attempt.attempt),
      cell(outcome),
      cell(attemptCost),
      attempt.durationMs === undefined ? "—" : minutes(attempt.durationMs / 60_000),
      cell(attempt.signature),
      cell(attemptError(attempt)),
      artifactLinks(run, attempt, retiredGenerations, artifactDirectoryCache),
    ].join(" | ")} |`);
  }
  if (attempts.length === 0) {
    lines.push("| — | — | — | — | — | — | — | — | — | — brak prób |");
  }

  return `${lines.join("\n")}\n`;
}

export interface RunLogIo {
  mkdir(path: string): void;
  /** Implementacja domyślna zapisuje, fsyncuje i zamyka unikalny plik tymczasowy. */
  writeFileSync(path: string, content: string): void;
  rename(source: string, destination: string): void;
  unlink(path: string): void;
}

function writeFileWithFsync(path: string, content: string): void {
  const descriptor = openSync(path, "wx");
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export const defaultRunLogIo: RunLogIo = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  writeFileSync: writeFileWithFsync,
  rename: renameSync,
  unlink: unlinkSync,
};

let temporaryFileSequence = 0;

/** Atomowo nadpisuje lokalny punkt wejścia do artefaktów; błąd zawsze jest fail-open. */
export function writeRunLog(
  store: LifecycleStore,
  run: LifecycleRun,
  io: RunLogIo = defaultRunLogIo
): void {
  const dir = ticketRunsDir(run.ticketId);
  const target = join(dir, "przebieg.md");
  const temporary = join(
    dir,
    `przebieg.md.tmp-${process.pid}-${++temporaryFileSequence}`
  );
  try {
    io.mkdir(dir);
    io.writeFileSync(temporary, buildRunLog(store, run));
    io.rename(temporary, target);
  } catch (error) {
    try {
      io.unlink(temporary);
    } catch {
      // Brak tmp albo błąd sprzątania nie może przykryć pierwotnej awarii zapisu.
    }
    console.error(
      `Przebieg ${run.ticketId} nie zapisany:`,
      error
    );
  }
}
