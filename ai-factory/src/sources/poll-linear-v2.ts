/**
 * Poller v2: cienki koordynator durable lifecycle.
 *
 * Mastra wykonuje tylko pojedyncze factoryJob. Oczekiwanie na człowieka, testy,
 * GitHub, merge i smoke żyją tutaj i w SQLite, bez workflow resume.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCommentContextSnapshot } from "./comment-context";
import {
  isCommandAttempt,
  parseCommand,
  parseScorePayload,
  unknownCommandHint,
} from "./commands";
import { LinearSource } from "./linear";
import {
  isWorkflowRunMissing,
  MastraWorkflowClient,
  runStatus,
  type MastraRunSnapshot,
} from "./mastra-client";
import {
  LifecycleStore,
  RESEARCH_ROLES,
  researchAttemptStage,
  runStageOf,
  type AttemptStage,
  type LifecycleCommand,
  type LifecycleRun,
} from "../pipeline/lifecycle-store";
import {
  reduceLifecycle,
  type CoordinatorDecision,
  type CoordinatorEvent,
  type NextAttempts,
} from "../pipeline/coordinator";
import { appendExperimentRow, buildExperimentSummary } from "../metrics/experiments";
import {
  factoryJobOutputSchema,
  JOB_BUDGET_MINUTES,
  type FactoryJobOutput,
} from "../pipeline/factory-job";
import {
  backoffAt,
  classifyDispatchError,
  FatalDispatchError,
  maxDispatchAttempts,
} from "../pipeline/retry-policy";
import { runPreflight } from "../pipeline/preflight";
import { breakerOpen, checkHourlySpend, recordRunOutcome } from "../pipeline/breaker";
import { findUpFile, getProject, progressLevel, type ProjectConfig } from "../pipeline/projects";
import { planFileCollisions } from "../pipeline/serialization";
import type { TestRunnerInput, TestRunnerResult } from "../pipeline/test-runner";
import { execFileControlled } from "../pipeline/process-control";
import { evaluateGithubChecks, inspectPullRequestChecks } from "../pipeline/github-ci";
import { runProdChecks } from "../pipeline/prod-smoke";
import { notify } from "../pipeline/notify";
import {
  parseSignatureLine,
  POLLER_SIGNATURE,
  signatureLine,
} from "../pipeline/signature";
import { progressComment, type ProgressCommentContext } from "../pipeline/progress";
import { resolveRoute } from "../pipeline/routing";
import { authorizeScopePaths, parseScopePaths, scopeBlockedPaths } from "../pipeline/scope";
import { extendedStatusName, LINEAR_STATE_MAP } from "./state-map";

const POLL_INTERVAL_MS = Number(process.env.FACTORY_POLL_INTERVAL_MS ?? 60_000);
const marker = (ticketId: string) => `[linear:${ticketId}:v2]`;
const reportedPreflight = new Map<string, string>();
const reportedWarnings = new Map<string, string>();

export interface TestRunnerSpawn extends TestRunnerInput {
  resultPath: string;
}

export interface PollerDependencies {
  store: LifecycleStore;
  mastra: MastraWorkflowClient;
  sources: Map<string, LinearSource>;
  /** Projekty, dla których kolumna Linear odzwierciedla dokładną fazę lifecycle. */
  extendedStatuses?: Set<string>;
  /** Kanał powiadomień; testy wstrzykują rejestrator zamiast realnego notify. */
  notifier?: typeof notify;
  /** Start detached runnera testów; testy wstrzykują stub zwracający PID. */
  spawnTestRunner?: (input: TestRunnerSpawn) => number;
}

function stableRunId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function sourceFor(deps: PollerDependencies, run: LifecycleRun): LinearSource {
  const source = deps.sources.get(run.project);
  if (!source) throw new Error(`Brak LinearSource dla projektu ${run.project}`);
  return source;
}

function statusName(run: LifecycleRun, extended: boolean): string {
  if (extended) return extendedStatusName(run);
  if (run.errorCode === "CANCELED") return "Canceled";
  if (run.status === "blocked") return "👤 ⛔ Zablokowany";
  if (run.status === "done") return "Done";
  if (run.stage === "review" || run.stage === "merge") return "In Review";
  return "In Progress";
}

function statusCommand(run: LifecycleRun, reason: string, extended: boolean): Omit<
  LifecycleCommand,
  "state" | "attempts" | "createdAt" | "updatedAt" | "availableAt"
> {
  const state = statusName(run, extended);
  const transitionId = createHash("sha256")
    .update(`${run.stage}:${run.status}:${state}:${reason}`)
    .digest("hex")
    .slice(0, 12);
  return {
    key: `${run.ticketId}:g${run.generation}:linear-status:${transitionId}`,
    ticketId: run.ticketId,
    kind: "linear-status",
    stage: run.stage,
    payload: { state },
  };
}

export function applyDecision(
  deps: PollerDependencies,
  ticketId: string,
  decision: CoordinatorDecision,
  acknowledgeCommandKey?: string
): LifecycleRun {
  const current = deps.store.getRun(ticketId);
  if (!current) throw new Error(`Brak lifecycle run dla ${ticketId}`);
  const projected: LifecycleRun = {
    ...current,
    ...decision.transition.patch,
    generation: current.generation + (decision.transition.incrementGeneration ? 1 : 0),
    stage: decision.transition.stage,
    status: decision.transition.status,
    updatedAt: current.updatedAt,
  };
  const researchAttempts = RESEARCH_ROLES
    .map((role) => deps.store.latestAttempt(ticketId, researchAttemptStage(role)))
    .filter((attempt) => attempt?.signature)
    .sort((left, right) =>
      (right?.finishedAt ?? right?.startedAt ?? "")
        .localeCompare(left?.finishedAt ?? left?.startedAt ?? "")
    );
  const progressContext: ProgressCommentContext = {
    buildSignature: deps.store.latestAttempt(ticketId, "build")?.signature,
    reviewSignature: deps.store.latestAttempt(ticketId, "review")?.signature,
    triageSignature: deps.store.latestAttempt(ticketId, "triage")?.signature,
    synthesisSignature: deps.store.latestAttempt(ticketId, "synthesis")?.signature,
    critiqueSignature: deps.store.latestAttempt(ticketId, "critique")?.signature,
    researchSignature: researchAttempts[0]?.signature,
    researchSignatures: Object.fromEntries(
      RESEARCH_ROLES.map((role) => [
        role,
        deps.store.latestAttempt(ticketId, researchAttemptStage(role))?.signature,
      ])
    ),
  };
  const progress = progressComment(
    current,
    projected,
    decision.transition.reason,
    progressContext
  );
  const updated = deps.store.transition(ticketId, {
    ...decision.transition,
    commands: [
      ...decision.commands,
      statusCommand(
        projected,
        decision.transition.reason,
        deps.extendedStatuses?.has(projected.project) ?? false
      ),
      ...(progress ? [{
        key: progress.key,
        ticketId,
        kind: "linear-comment" as const,
        stage: progress.stage,
        payload: {
          body: progress.body,
          progress: progress.level,
          ...(progress.signature ? { signature: progress.signature } : {}),
          ...(progress.enrich ? { enrich: progress.enrich } : {}),
        },
      }] : []),
    ],
    acknowledgeCommandKey,
  });
  emitTransitionNotification(deps, current, updated, decision.transition.reason);
  recordBreakerOutcome(current, updated);
  recordExperimentOutcome(deps, current, updated);
  return updated;
}

/**
 * Wiersz eksperymentu przy ukończeniu ticketu (fire-and-forget) — porównanie
 * kosztów/jakości wariantów procesu (solo vs deep) i konfiguracji modeli.
 */
function recordExperimentOutcome(
  deps: PollerDependencies,
  before: LifecycleRun,
  after: LifecycleRun
): void {
  if (before.status === "done" || after.status !== "done" || after.errorCode === "CANCELED") return;
  try {
    void appendExperimentRow(buildExperimentSummary(deps.store, after)).catch(() => {});
  } catch (error) {
    console.error("Wiersz eksperymentu nie zapisany:", error instanceof Error ? error.message : error);
  }
}

/** Decyzje człowieka nie nabijają serii breakera — tylko realne porażki fabryki. */
const HUMAN_CAUSED_BLOCKS = new Set([
  "PLAN_REJECTED",
  "CANCELED",
  "PREMATURE_DONE",
  "INPUT_CHANGED_AFTER_BUILD",
  "PLAN_MAX_QUESTIONS",
]);

function recordBreakerOutcome(before: LifecycleRun, after: LifecycleRun): void {
  if (before.status !== "blocked" && after.status === "blocked") {
    if (!HUMAN_CAUSED_BLOCKS.has(after.errorCode ?? "")) {
      void recordRunOutcome(false).catch(() => {});
    }
    return;
  }
  if (before.status !== "done" && after.status === "done" && after.errorCode !== "CANCELED") {
    void recordRunOutcome(true).catch(() => {});
  }
}

/**
 * Jedyny lejek powiadomień o przejściach lifecycle. Fire-and-forget — błąd
 * kanału nigdy nie wywala pollera ani nie cofa transakcji.
 */
function emitTransitionNotification(
  deps: PollerDependencies,
  before: LifecycleRun,
  after: LifecycleRun,
  reason: string
): void {
  if (
    before.stage === after.stage &&
    before.status === after.status &&
    before.errorCode === after.errorCode
  ) return;
  const notifier = deps.notifier ?? notify;
  const url = after.manifest.url;
  let title: string | undefined;
  let message: string | undefined;
  if (after.status === "blocked") {
    title = `🛑 ${after.ticketId} zablokowany (${after.blockedStage ?? after.stage})`;
    message = `${after.errorCode ?? reason}: ${(after.errorMessage ?? "").slice(0, 300)}`;
  } else if (after.stage === "approval" && after.status === "waiting_human") {
    title = `⏳ ${after.ticketId}: plan do akceptacji`;
    message = "Zatwierdź `/approve` albo odrzuć `/reject <powód>`.";
  } else if (
    (after.stage === "plan" || after.stage === "triage" || after.stage === "synthesis") &&
    after.status === "waiting_human"
  ) {
    title = `❓ ${after.ticketId}: pytania planera`;
    message = `Runda ${after.clarifyRound}/2 — odpowiedz \`/answer <treść>\`.`;
  } else if (after.stage === "merge" && after.status === "waiting_human" && before.stage !== "merge") {
    title = `✅ ${after.ticketId}: PR gotowy do merge`;
    message = `Review: ${after.reviewStatus ?? "advisory"} — ${after.prUrl ?? ""}`;
  } else if (after.status === "done" && after.errorCode !== "CANCELED" && before.status !== "done") {
    title = `✅ ${after.ticketId} ukończony`;
    message = after.prUrl
      ? `PR zmergowany (${after.prUrl}); smoke: ${after.smokeStatus ?? "-"}.`
      : "Ticket zakończony.";
  }
  if (!title || !message) return;
  void notifier(title, message, url).catch(() => {});
}

function findFactoryOutput(value: unknown): FactoryJobOutput | undefined {
  const parsed = factoryJobOutputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!value || typeof value !== "object") return undefined;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    const found = findFactoryOutput(nested);
    if (found) return found;
  }
  return undefined;
}

function runError(snapshot: MastraRunSnapshot): string {
  const seen = new Set<unknown>();
  const walk = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/error|message/i.test(key) && typeof nested === "string" && nested.trim()) return nested;
      const result = walk(nested);
      if (result) return result;
    }
    return undefined;
  };
  return walk(snapshot) ?? "Mastra job zakończył się bez wyniku.";
}

function failedJobOutput(command: LifecycleCommand, report: string): FactoryJobOutput {
  const kind = String(command.payload.kind) as FactoryJobOutput["kind"];
  const researchRole = command.payload.researchRole;
  return {
    kind,
    outcome: "failed",
    report,
    errorCode: `${kind.toUpperCase()}_JOB_FAILED`,
    signature: "ai-factory · unavailable · unavailable · unavailable",
    durationMs: 0,
    files: Array.isArray(command.payload.planFiles)
      ? command.payload.planFiles.filter((file): file is string => typeof file === "string")
      : [],
    changedFiles: [],
    scopeWarnings: [],
    reviewVerdict: kind === "review" ? "unavailable" : undefined,
    critiqueVerdict: kind === "critique" ? "unavailable" : undefined,
    // Echo roli — koordynator musi wiedzieć, KTÓRY job researchu padł.
    researchRole: kind === "research" && typeof researchRole === "string"
      ? researchRole as FactoryJobOutput["researchRole"]
      : undefined,
  };
}

/** Kolejne numery prób per stage — reducer nie może ich liczyć sam (czysty). */
function followUpAttempts(store: LifecycleStore, ticketId: string): NextAttempts {
  const stages: AttemptStage[] = [
    "plan",
    "build",
    "review",
    "triage",
    "synthesis",
    "critique",
    ...RESEARCH_ROLES.map((role) => researchAttemptStage(role)),
  ];
  return Object.fromEntries(stages.map((stage) => [stage, store.nextAttempt(ticketId, stage)]));
}

/**
 * Payload joba wzbogacony poller-side: review dostaje harness buildera z
 * podpisu ostatniej próby build, żeby routing mógł wykluczyć ten sam silnik
 * (dywersyfikacja reviewer ≠ builder). Klucz idempotencji i zapisany payload
 * komendy pozostają nietknięte.
 */
function jobInputData(
  deps: PollerDependencies,
  command: LifecycleCommand,
  run: LifecycleRun,
  allowEngineFallback: boolean
): Record<string, unknown> {
  // Format podpisu: "ai-factory · <harness> · <model> · <profil>"; harness może
  // nieść wersję CLI ("codex@0.44") — do wykluczenia liczy się sama nazwa.
  const harnessOf = (stage: AttemptStage): string | undefined => {
    const signature = deps.store.latestAttempt(run.ticketId, stage)?.signature;
    const harness = signature?.split(" · ")[1]?.split("@")[0]?.trim();
    return harness && harness !== "unavailable" ? harness : undefined;
  };
  const payload = { ...command.payload, allowEngineFallback };
  if (command.payload.kind === "review") {
    const buildHarness = harnessOf("build");
    return buildHarness ? { ...payload, buildHarness } : payload;
  }
  if (command.payload.kind === "critique") {
    const synthesisHarness = harnessOf("synthesis");
    return synthesisHarness ? { ...payload, synthesisHarness } : payload;
  }
  return payload;
}

/**
 * Stall lease: job Mastry, który wisi w pending/running dłużej niż budżet roli
 * + grace, jest anulowany i kończy się JOB_STALLED zamiast wisieć bez końca
 * (np. po SIGKILL serwera Mastry snapshot zostaje "running" na zawsze).
 */
async function handleStalledJob(
  deps: PollerDependencies,
  command: LifecycleCommand,
  run: LifecycleRun,
  attempt: number,
  jobRunId: string,
  mastraStatus: string
): Promise<boolean> {
  const kind = String(command.payload.kind) as keyof typeof JOB_BUDGET_MINUTES;
  const leaseMinutes = jobLeaseMinutes(kind, command.payload.allowEngineFallback === true);
  const latest = deps.store.latestAttempt(run.ticketId, command.stage);
  const startedAt = latest?.jobRunId === jobRunId ? latest.startedAt : command.updatedAt;
  const elapsedMinutes = (Date.now() - Date.parse(startedAt)) / 60_000;
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes <= leaseMinutes) return false;
  await deps.mastra.cancelRun(jobRunId).catch(() => {});
  const message =
    `Job ${kind} przekroczył lease ${leaseMinutes} min bez wyniku ` +
    `(Mastra status: ${mastraStatus}). Wznowienie: /retry.`;
  const output = { ...failedJobOutput(command, message), errorCode: "JOB_STALLED" };
  deps.store.finishAttempt(run.ticketId, command.stage, attempt, {
    status: "failed",
    outcome: "JOB_STALLED",
    report: message,
    signature: output.signature,
    errorCode: "JOB_STALLED",
    errorMessage: message,
  });
  applyDecision(
    deps,
    run.ticketId,
    reduceLifecycle(run, {
      type: "job-finished",
      attempt,
      output,
      nextAttempts: followUpAttempts(deps.store, run.ticketId),
      usage: deps.store.totalUsage(run.ticketId),
    }),
    command.key
  );
  return true;
}

/**
 * Rezerwacja budżetu za próby W TOKU: totalUsage widzi wyłącznie koszty
 * zakończonych prób, więc równoległy fan-out (research ×3) przy prawie
 * wyczerpanym budżecie przepuściłby wszystkie joby na tym samym odczycie.
 * Rezerwujemy budżet czasowy roli (górna granica lease) + estymatę USD dla
 * jobów AI; deterministyczny runner testów rezerwuje tylko minuty.
 */
export function jobBudgetMinutes(stage: string): number {
  const kind = stage.startsWith("research-") ? "research" : stage;
  return kind in JOB_BUDGET_MINUTES
    ? JOB_BUDGET_MINUTES[kind as keyof typeof JOB_BUDGET_MINUTES]
    : 25; // zachowaj historyczny lease nieznanego rodzaju joba
}

/**
 * Ile minut job ma na oddanie wyniku, zanim strażnik uzna go za wiszący.
 *
 * Gdy job dostał zgodę na silnik zapasowy, może wykonać DWIE pełne próby
 * w jednym runie Mastry — lease musi je obie objąć. Inaczej najczęstsza awaria
 * z allowlisty (timeout próby głównej, który z definicji zjada cały budżet roli)
 * gwarantowałaby zabicie zapasu w locie: ticket płaci za obie próby i nie
 * dostaje wyniku, czyli dokładnie odwrotnie do celu fallbacku. Bramka budżetu
 * w `dispatchJob` rezerwuje symetrycznie dwie pełne role.
 */
export function jobLeaseMinutes(stage: string, fallbackAllowed: boolean): number {
  const graceMinutes = Number(process.env.FACTORY_JOB_GRACE_MIN ?? 10);
  return jobBudgetMinutes(stage) * (fallbackAllowed ? 2 : 1) + graceMinutes;
}

function reservedUsage(
  store: LifecycleStore,
  ticketId: string
): { usd: number; minutes: number } {
  const perMinute = Number(process.env.FACTORY_SYNTH_USD_PER_MIN ?? 0.15);
  let minutes = 0;
  let usd = 0;
  for (const attempt of store.listRunningAttempts(ticketId)) {
    if (attempt.stage === "test") {
      minutes += 20; // bazowy lease detached runnera
      continue;
    }
    const budget = jobBudgetMinutes(attempt.stage);
    minutes += budget;
    usd += budget * perMinute;
  }
  return { minutes, usd };
}

async function dispatchJob(
  deps: PollerDependencies,
  command: LifecycleCommand,
  run: LifecycleRun
): Promise<void> {
  const attempt = Number(command.payload.attempt ?? 1);
  const project = await getProject(run.project);
  const usage = deps.store.totalUsage(run.ticketId);
  const reserved = reservedUsage(deps.store, run.ticketId);
  const maxMinutes = project.budget?.maxMinutes ?? Number(process.env.FACTORY_BUDGET_MAX_MIN ?? 45);
  const maxUsd = project.budget?.maxUsd ?? Number(process.env.FACTORY_BUDGET_MAX_USD ?? 3);
  const attemptDetails = {
    inputHash: run.manifest.inputHash,
    sha: typeof command.payload.headSha === "string" ? command.payload.headSha : run.headSha,
    budgetMaxMinutes: maxMinutes,
    budgetMaxUsd: maxUsd,
    budgetUsedMinutes: usage.minutes,
    budgetUsedUsd: usage.usd,
  };
  // Bramka budżetu dotyczy wyłącznie STARTU nowego joba: komenda z externalId
  // ma już próbę w toku i sama figuruje w rezerwacji — nie może się nią
  // samoblokować podczas pollingu statusu.
  if (
    !command.externalId &&
    (usage.minutes + reserved.minutes >= maxMinutes ||
      usage.usd + reserved.usd >= maxUsd)
  ) {
    const reservedNote = reserved.minutes
      ? ` (w tym rezerwacja za joby w toku: ${reserved.minutes.toFixed(0)} min / $${reserved.usd.toFixed(2)})`
      : "";
    const output = {
      ...failedJobOutput(
        command,
        `Budżet ticketu wyczerpany: ${(usage.minutes + reserved.minutes).toFixed(1)}/${maxMinutes} min, ` +
        `$${(usage.usd + reserved.usd).toFixed(2)}/$${maxUsd}${reservedNote}.`
      ),
      errorCode: "BUDGET_EXHAUSTED",
    };
    deps.store.startAttempt(
      run.ticketId,
      command.stage,
      attempt,
      `budget-blocked:${command.key}`,
      attemptDetails
    );
    deps.store.finishAttempt(run.ticketId, command.stage, attempt, {
      status: "failed",
      outcome: output.errorCode,
      report: output.report,
      signature: output.signature,
      errorCode: output.errorCode,
      errorMessage: output.report,
    });
    applyDecision(
      deps,
      run.ticketId,
      reduceLifecycle(run, {
        type: "job-finished",
        attempt,
        output,
        nextAttempts: followUpAttempts(deps.store, run.ticketId),
        usage: deps.store.totalUsage(run.ticketId),
      }),
      command.key
    );
    return;
  }

  const jobMinutes = jobBudgetMinutes(String(command.payload.kind));
  const perMinute = Number(process.env.FACTORY_SYNTH_USD_PER_MIN ?? 0.15);
  // Bieżący job nie figuruje jeszcze w reservedUsage. Zapas wpuszczamy tylko,
  // gdy budżet mieści DWIE pełne rezerwacje roli — bo tyle druga próba naprawdę
  // może zużyć (dostaje pełny budżet roli, a lease w handleStalledJob liczy się
  // wtedy podwójnie). Skutek uboczny jest zamierzony: przy ciasnym budżecie
  // ticketu zapas nie ruszy, zamiast wystartować i przekroczyć limit.
  const allowEngineFallback =
    usage.minutes + reserved.minutes + 2 * jobMinutes < maxMinutes &&
    usage.usd + reserved.usd + 2 * jobMinutes * perMinute < maxUsd;
  const inputData = jobInputData(deps, command, run, allowEngineFallback);
  let jobRunId = command.externalId;
  if (!jobRunId) {
    jobRunId = stableRunId(command.key);
    let existing: MastraRunSnapshot | undefined;
    try {
      existing = await deps.mastra.getRun(jobRunId);
    } catch (error) {
      if (!isWorkflowRunMissing(error)) throw error;
      await deps.mastra.createRun(jobRunId);
    }
    deps.store.startAttempt(run.ticketId, command.stage, attempt, jobRunId, attemptDetails);
    deps.store.markCommand(command.key, "dispatched", { externalId: jobRunId });
    if (!existing || runStatus(existing) === "pending") {
      await deps.mastra.startRun(jobRunId, inputData);
    }
    return;
  }

  const snapshot = await deps.mastra.getRun(jobRunId);
  const status = runStatus(snapshot);
  if (status === "pending" || status === "running") {
    if (await handleStalledJob(deps, command, run, attempt, jobRunId, status)) return;
    if (status === "pending") await deps.mastra.startRun(jobRunId, inputData);
    return;
  }

  const output = findFactoryOutput(snapshot.result ?? snapshot);
  if (!output || status === "failed" || status === "canceled") {
    const fallback = failedJobOutput(command, runError(snapshot));
    deps.store.finishAttempt(run.ticketId, command.stage, attempt, {
      status: status === "canceled" ? "canceled" : "failed",
      outcome: fallback.errorCode,
      report: fallback.report,
      signature: fallback.signature,
      errorCode: fallback.errorCode,
      errorMessage: fallback.report,
    });
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "job-finished",
      attempt,
      output: fallback,
      nextAttempts: followUpAttempts(deps.store, run.ticketId),
      usage: deps.store.totalUsage(run.ticketId),
    }), command.key);
    return;
  }

  deps.store.finishAttempt(run.ticketId, command.stage, attempt, {
    status: output.outcome === "failed" ? "failed" : "success",
    outcome: output.outcome,
    report: output.report,
    signature: output.signature,
    sha: output.headSha,
    errorCode: output.errorCode,
    errorMessage: output.outcome === "failed" ? output.report : undefined,
    costUsd: output.costUsd,
    costSource: output.costSource,
    durationMs: output.durationMs,
  });
  applyDecision(deps, run.ticketId, reduceLifecycle(run, {
    type: "job-finished",
    attempt,
    output,
    nextAttempts: followUpAttempts(deps.store, run.ticketId),
    usage: deps.store.totalUsage(run.ticketId),
  }), command.key);
}

export async function publishDraftPullRequest(
  run: LifecycleRun,
  project: Awaited<ReturnType<typeof getProject>>,
  buildMeta?: { jobRunId?: string; signature?: string; outcome?: string }
): Promise<{ prUrl: string; branch: string; sha: string }> {
  if (!run.branch || !run.headSha || !project.github) {
    throw new Error("Publish wymaga branch, SHA i konfiguracji GitHub.");
  }
  const branch = run.branch;
  const sha = run.headSha;
  const defaultBranch = project.default_branch ?? "main";
  await execFileControlled("git", ["-C", project.repo, "fetch", "origin", defaultBranch], { timeoutMs: 60_000 });

  const behind = await execFileControlled(
    "git",
    ["-C", project.repo, "merge-base", "--is-ancestor", `origin/${defaultBranch}`, sha]
  ).then(() => false).catch(() => true);
  if (behind) {
    const mergeTree = await execFileControlled(
      "git",
      ["-C", project.repo, "merge-tree", `origin/${defaultBranch}`, sha],
      { timeoutMs: 60_000 }
    ).catch((error) => ({ stdout: String(error), stderr: "" }));
    const conflict = /<<<<<<<|changed in both|CONFLICT/i.test(mergeTree.stdout);
    throw new Error(conflict
      ? "BRANCH_CONFLICT: checkpoint koliduje z aktualnym main."
      : "BRANCH_BEHIND: checkpoint nie zawiera aktualnego main; wymaga synchronizacji i ponownych testów exact-SHA.");
  }

  const remoteBranchSha = async (): Promise<string | undefined> => {
    const remote = await execFileControlled(
      "git",
      ["-C", project.repo, "ls-remote", "--heads", "origin", branch],
      { timeoutMs: 60_000 }
    );
    return remote.stdout.trim().split(/\s+/)[0] || undefined;
  };
  const branchDiverged = (remoteSha?: string) => new FatalDispatchError(
    `BRANCH_DIVERGED: gałąź ${branch} wskazuje inną generację ` +
      `(${remoteSha?.slice(0, 7) ?? "nieznany commit"}) niż checkpoint (${sha.slice(0, 7)}). ` +
      "Wymagane sprzątanie poprzedniej generacji: zamknij jej PR i usuń gałąź " +
      "(/replan robi to automatycznie), potem /retry.",
    "BRANCH_DIVERGED"
  );
  const existingRemoteSha = await remoteBranchSha();
  if (existingRemoteSha) {
    const fetchedRemoteBranch = await execFileControlled(
      "git",
      ["-C", project.repo, "fetch", "origin", branch],
      { timeoutMs: 60_000 }
    ).then(() => true).catch(() => false);
    if (fetchedRemoteBranch) {
      const remoteIsAncestor = await execFileControlled(
        "git",
        ["-C", project.repo, "merge-base", "--is-ancestor", existingRemoteSha, sha]
      ).then(() => true).catch(() => false);
      if (!remoteIsAncestor) throw branchDiverged(existingRemoteSha);
    }
  }

  try {
    await execFileControlled(
      "git",
      ["-C", project.repo, "push", "origin", `${sha}:refs/heads/${branch}`],
      { timeoutMs: 120_000 }
    );
  } catch (error) {
    const details = processErrorDetails(error);
    if (/non-fast-forward|fetch first|\[rejected\]/i.test(details)) {
      throw branchDiverged(await remoteBranchSha().catch(() => existingRemoteSha));
    }
    throw error;
  }
  const existing = await execFileControlled(
    "gh",
    ["pr", "list", "--repo", project.github, "--head", branch, "--state", "open", "--json", "url", "--limit", "1"],
    { cwd: project.repo, timeoutMs: 30_000 }
  );
  const rows = JSON.parse(existing.stdout) as { url?: string }[];
  let prUrl = rows[0]?.url;
  if (!prUrl) {
    const body = [
      `Ticket: ${run.ticketId}`,
      `SHA: ${sha}`,
      `Job ID: ${buildMeta?.jobRunId ?? "unavailable"}`,
      "Role: builder",
      `Engine/model: ${buildMeta?.signature ?? "unavailable"}`,
      `Outcome: ${buildMeta?.outcome ?? "committed"}; exact-SHA tests passed`,
      "",
      run.feedback ? `Scope warnings:\n${run.feedback}` : "Scope warnings: none",
      "",
      "Generated by ai-factory lifecycle v2.",
    ].join("\n");
    const created = await execFileControlled(
      "gh",
      [
        "pr", "create", "--draft", "--repo", project.github,
        "--head", branch, "--base", defaultBranch,
        "--title", `${run.ticketId}: ${run.manifest.title}`,
        "--body", body,
      ],
      { cwd: project.repo, timeoutMs: 60_000 }
    );
    prUrl = created.stdout.trim().split("\n").find((line) => line.startsWith("http"));
  }
  if (!prUrl) throw new Error("Nie udało się odczytać URL draft PR.");
  return { prUrl, branch, sha };
}

function processErrorDetails(error: unknown): string {
  return error instanceof Error
    ? `${error.message}\n${String((error as Error & { stderr?: string }).stderr ?? "")}`
    : String(error);
}

async function cleanupLocalWorkspace(
  repo: string,
  workspaceDir: string | undefined,
  branch: string | undefined
): Promise<void> {
  if (workspaceDir && existsSync(workspaceDir)) {
    await execFileControlled("git", ["-C", repo, "worktree", "remove", "--force", workspaceDir])
      .catch(() => {});
  }
  await execFileControlled("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
  if (branch) {
    await execFileControlled("git", ["-C", repo, "branch", "-D", branch]).catch(() => {});
  }
}

async function dispatchExternal(
  deps: PollerDependencies,
  command: LifecycleCommand,
  run: LifecycleRun
): Promise<void> {
  const source = sourceFor(deps, run);
  const project = await getProject(run.project);
  if (command.kind === "linear-status") {
    // Stan końcowy ustawiony przez człowieka jest ostateczny (BAR-127/BAR-185):
    // payload komendy powstał przed jego decyzją, więc czytamy stan świeżo tuż
    // przed mutacją. Lista wyłącznie z mapy stanów — bez drugiej kopii w kodzie.
    const currentState = await source.getStateName(run.ticketId);
    if (LINEAR_STATE_MAP.terminal.includes(currentState)) {
      console.log(
        `[${run.ticketId}] pomijam zapis stanu ${String(command.payload.state)} — ` +
          `ticket w stanie końcowym (${currentState}).`
      );
    } else {
      await source.setStateByName(run.ticketId, String(command.payload.state));
    }
  } else if (command.kind === "linear-comment") {
    const requestedProgress = command.payload.progress;
    if (requestedProgress === "milestones" || requestedProgress === "verbose") {
      const configuredProgress = progressLevel(project);
      if (
        configuredProgress === "off" ||
        (configuredProgress === "milestones" && requestedProgress === "verbose")
      ) {
        deps.store.markCommand(command.key, "done");
        return;
      }
    }
    const tag = `[factory-outbox:${command.key}]`;
    const exists = (await source.listComments(run.ticketId)).some((comment) => comment.body.includes(tag));
    if (!exists) {
      const signature = typeof command.payload.signature === "string"
        ? parseSignatureLine(command.payload.signature)
        : undefined;
      await source.comment(
        run.ticketId,
        `${await enrichProgressBody(deps, command, run, project)}\n\n${marker(run.ticketId)} ${tag}`,
        signature ?? POLLER_SIGNATURE
      );
    }
  } else if (command.kind === "publish-pr") {
    const buildAttempt = deps.store.latestAttempt(run.ticketId, "build");
    const published = await publishDraftPullRequest(run, project, {
      jobRunId: buildAttempt?.jobRunId,
      signature: buildAttempt?.signature,
      outcome: buildAttempt?.outcome,
    });
    applyDecision(
      deps,
      run.ticketId,
      reduceLifecycle(run, { type: "published", ...published }),
      command.key
    );
  } else if (command.kind === "mark-pr-ready") {
    await execFileControlled("gh", ["pr", "ready", String(command.payload.prUrl)], {
      cwd: project.repo,
      timeoutMs: 30_000,
    });
  } else if (command.kind === "comment-pr") {
    const tag = `<!-- factory-outbox:${command.key} -->`;
    const existing = await execFileControlled(
      "gh",
      ["pr", "view", String(command.payload.prUrl), "--json", "comments"],
      { cwd: project.repo, timeoutMs: 30_000 }
    );
    const comments = JSON.parse(existing.stdout) as { comments?: { body?: string }[] };
    if ((comments.comments ?? []).some((comment) => comment.body?.includes(tag))) {
      deps.store.markCommand(command.key, "done");
      return;
    }
    const signature = command.payload.signature
      ?? deps.store.latestAttempt(run.ticketId, "build")?.signature
      ?? signatureLine(POLLER_SIGNATURE);
    const outcome = command.payload.outcome ?? run.reviewStatus ?? "advisory";
    const body = [
      String(command.payload.body),
      "",
      `Signature: ${String(signature)}`,
      `Ticket: ${run.ticketId}`,
      `SHA: ${run.headSha}`,
      `Outcome: ${String(outcome)}`,
      tag,
    ].join("\n");
    await execFileControlled(
      "gh",
      ["pr", "comment", String(command.payload.prUrl), "--body", body],
      { cwd: project.repo, timeoutMs: 30_000 }
    );
  } else if (command.kind === "retire-generation") {
    const branch = String(command.payload.branch ?? "");
    const prUrl = String(command.payload.prUrl ?? "");
    const headSha = typeof command.payload.headSha === "string" &&
      command.payload.headSha.length
      ? command.payload.headSha
      : undefined;
    const generation = Number(command.payload.generation ?? run.generation);
    if (!branch.startsWith(`agent/${run.ticketId}-`)) {
      deps.store.markCommand(command.key, "done", { error: "branch-not-owned" });
      return;
    }

    const errors: string[] = [];
    const skips: string[] = [];
    const retireSkip = (message: string): void => {
      skips.push(message);
      console.warn(`retire-generation: ${message}`);
    };
    let pr: {
      state?: string;
      url?: string;
      headRefName?: string;
      headRefOid?: string;
    } | undefined;
    try {
      const viewed = await execFileControlled(
        "gh",
        ["pr", "view", prUrl, "--json", "state,url,headRefName,headRefOid"],
        { cwd: project.repo, timeoutMs: 30_000 }
      );
      pr = JSON.parse(viewed.stdout) as typeof pr;
    } catch (error) {
      errors.push(`remote-pr-view: ${processErrorDetails(error)}`);
    }

    if (pr?.state === "MERGED") {
      retireSkip(`PR ${prUrl} jest zmergowany; zdalne artefakty pozostają bez zmian`);
    } else if (pr && pr.headRefName !== branch) {
      retireSkip(
        `PR ${prUrl} wskazuje ${pr.headRefName ?? "brak gałęzi"}, nie ${branch}`
      );
    } else if (pr) {
      const tag = `<!-- factory-outbox:${command.key} -->`;
      try {
        const existing = await execFileControlled(
          "gh",
          ["pr", "view", prUrl, "--json", "comments"],
          { cwd: project.repo, timeoutMs: 30_000 }
        );
        const comments = JSON.parse(existing.stdout) as { comments?: { body?: string }[] };
        if (!(comments.comments ?? []).some((comment) => comment.body?.includes(tag))) {
          const reason = String(
            command.payload.reason ?? "zastąpione nową generacją planu"
          );
          const replacement = reason.includes("/replan")
            ? "została zastąpiona nowym planem (`/replan`)"
            : `została ${reason.replace(/^zastąpione/, "zastąpiona")}`;
          const body = [
            `♻️ Generacja **g${generation}** ${replacement}. Ten PR jest zamykany, ` +
              "prace kontynuuje kolejna generacja tego ticketu.",
            "",
            tag,
          ].join("\n");
          await execFileControlled(
            "gh",
            ["pr", "comment", prUrl, "--body", body],
            { cwd: project.repo, timeoutMs: 30_000 }
          );
        }
      } catch (error) {
        errors.push(`remote-pr-comment: ${processErrorDetails(error)}`);
      }

      if (pr.state === "OPEN") {
        try {
          await execFileControlled(
            "gh",
            ["pr", "close", prUrl],
            { cwd: project.repo, timeoutMs: 30_000 }
          );
        } catch (error) {
          errors.push(`remote-pr-close: ${processErrorDetails(error)}`);
        }
      }

      try {
        const remote = await execFileControlled(
          "git",
          ["-C", project.repo, "ls-remote", "--heads", "origin", branch],
          { timeoutMs: 60_000 }
        );
        const remoteSha = remote.stdout.trim().split(/\s+/)[0] || undefined;
        if (remoteSha && !headSha) {
          retireSkip(
            `legacy-payload-bez-headSha: pomijam usunięcie gałęzi ${branch}`
          );
        } else if (remoteSha && headSha) {
          const fetched = await execFileControlled(
            "git",
            ["-C", project.repo, "fetch", "origin", branch],
            { timeoutMs: 60_000 }
          ).then(() => true).catch((error) => {
            retireSkip(`fetch-failed: ${processErrorDetails(error)}`);
            return false;
          });
          if (fetched) {
            const sameGeneration = await execFileControlled(
              "git",
              ["-C", project.repo, "merge-base", "--is-ancestor", headSha, remoteSha]
            ).then(() => true).catch(() => false);
            if (sameGeneration) {
              try {
                await execFileControlled(
                  "git",
                  ["-C", project.repo, "push", "origin", "--delete", branch],
                  { timeoutMs: 120_000 }
                );
              } catch (error) {
                const details = processErrorDetails(error);
                if (!/remote ref does not exist|unable to delete/i.test(details)) {
                  throw error;
                }
              }
            } else {
              retireSkip(
                `branch-moved: ${remoteSha.slice(0, 7)} nie jest potomkiem ${headSha.slice(0, 7)}`
              );
            }
          }
        }
      } catch (error) {
        errors.push(`remote-branch-delete: ${processErrorDetails(error)}`);
      }
    }

    // Lokalne artefakty usuwa createWorkspace przy starcie nowej generacji
    // oraz cleanup-workspace po merge.

    if (errors.length) {
      throw new Error(`retire-generation niepełne: ${errors.join(" | ")}`);
    }
    deps.store.markCommand(
      command.key,
      "done",
      skips.length ? { error: `retire-skip: ${skips.join(" | ")}` } : {}
    );
    return;
  } else if (command.kind === "cleanup-workspace") {
    // Cleanup jest celowo osobną komendą po finale; implementacja nie usuwa
    // śledzonego brancha przed merge/smoke.
    const workspaceDir = typeof command.payload.workspaceDir === "string"
      ? command.payload.workspaceDir
      : run.workspaceDir;
    const branch = typeof command.payload.branch === "string"
      ? command.payload.branch
      : run.branch;
    await cleanupLocalWorkspace(project.repo, workspaceDir, branch);
  }
  if (command.kind !== "publish-pr") deps.store.markCommand(command.key, "done");
}

async function enrichProgressBody(
  deps: PollerDependencies,
  command: LifecycleCommand,
  run: LifecycleRun,
  project: ProjectConfig
): Promise<string> {
  const body = String(command.payload.body);
  if (command.payload.enrich !== "approve-route" && command.payload.enrich !== "review-route") {
    return body;
  }
  try {
    const ticket = { project: run.project, labels: run.manifest.labels };
    if (command.payload.enrich === "approve-route") {
      const route = await resolveRoute("build", ticket, run.planDomain);
      const maxMinutes = project.budget?.maxMinutes
        ?? Number(process.env.FACTORY_BUDGET_MAX_MIN ?? 45);
      const maxUsd = project.budget?.maxUsd
        ?? Number(process.env.FACTORY_BUDGET_MAX_USD ?? 3);
      return [
        body,
        `Wykonawca: \`${route.spec}\` · budżet roli: ${JOB_BUDGET_MINUTES.build} min · ` +
          `budżet ticketu: ${maxMinutes} min / $${maxUsd}.`,
      ].join("\n\n");
    }

    const signature = deps.store.latestAttempt(run.ticketId, "build")?.signature;
    const buildHarness = signature?.split(" · ")[1]?.split("@")[0]?.trim();
    const route = await resolveRoute(
      "review",
      ticket,
      run.planDomain,
      buildHarness && buildHarness !== "unavailable"
        ? { excludeEngine: buildHarness }
        : {}
    );
    return [
      body,
      `Wykonawca review: \`${route.spec}\` · budżet roli: ${JOB_BUDGET_MINUTES.review} min.`,
    ].join("\n\n");
  } catch {
    // Komentarz postępu jest informacyjny: błąd wzbogacenia nie steruje lifecycle.
    return body;
  }
}

export async function dispatchOutbox(deps: PollerDependencies): Promise<void> {
  for (const queuedCommand of deps.store.outstandingCommands()) {
    const command = deps.store.getCommand(queuedCommand.key);
    if (!command || !["pending", "dispatched"].includes(command.state)) continue;
    const run = deps.store.getRun(command.ticketId);
    if (!run) {
      deps.store.markCommand(command.key, "failed", { error: "Brak lifecycle run." });
      continue;
    }
    // Joby zakończonego runu (cancel/done) nie mogą się już odpalić.
    if ((command.kind === "run-job" || command.kind === "run-tests") && run.status === "done") {
      deps.store.markCommand(command.key, "done", { error: "run-already-done" });
      continue;
    }
    // Serializacja plikowa (BAR-141): build czeka, gdy inny zatwierdzony run
    // projektu trzyma te same pliki. Odsuwamy dostępność zamiast palić próby.
    if (command.kind === "run-job" && command.payload.kind === "build" && !command.externalId) {
      const collisions = planFileCollisions(run, deps.store.listActive());
      if (collisions.length) {
        deps.store.deferCommand(command.key, new Date(Date.now() + 5 * 60_000).toISOString());
        const holder = collisions[0];
        deps.store.enqueue({
          key: `${run.ticketId}:g${run.generation}:defer:${holder.ticketId}`,
          ticketId: run.ticketId,
          kind: "linear-comment",
          stage: "build",
          payload: {
            body: `⏸️ Build czeka na ${holder.ticketId} — kolizja plików: ${holder.files.slice(0, 10).join(", ")}. Start automatyczny po domknięciu tamtego PR-a.`,
          },
        });
        continue;
      }
    }
    try {
      if (command.kind === "run-job") await dispatchJob(deps, command, run);
      else if (command.kind === "run-tests") await dispatchTestRun(deps, command, run);
      else if (command.state === "pending") await dispatchExternal(deps, command, run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorClass = classifyDispatchError(error);
      const deadLettered = command.attempts >= maxDispatchAttempts(errorClass);
      deps.store.markCommand(command.key, deadLettered ? "failed" : "pending", {
        error: message,
        retryAt: deadLettered ? undefined : backoffAt(command.attempts + 1),
      });
      if (deadLettered) {
        const notifier = deps.notifier ?? notify;
        void notifier(
          `💀 ${run.ticketId}: dead-letter ${command.kind}`,
          `${errorClass}: ${message.slice(0, 400)}`,
          run.manifest.url
        ).catch(() => {});
        if (command.kind === "retire-generation") {
          const retiredGeneration = Number(command.payload.generation ?? run.generation);
          deps.store.enqueue({
            key: `${run.ticketId}:g${retiredGeneration}:retire-failed`,
            ticketId: run.ticketId,
            kind: "linear-comment",
            stage: command.stage,
            payload: {
              body: [
                "⚠️ Automatyczne sprzątanie poprzedniej generacji nie powiodło się.",
                `PR: ${String(command.payload.prUrl ?? "brak")}`,
                `Gałąź: \`${String(command.payload.branch ?? "brak")}\``,
                `Błąd: ${message}`,
                "Zamknij stary PR i usuń jego gałąź ręcznie przed publikacją nowej generacji.",
              ].join("\n"),
            },
          });
        }
      }
      // Dead-letter joba domyka jego próbę — wisząca próba 'running' na zawsze
      // rezerwowałaby budżet i fałszowała wiersz eksperymentu.
      if (deadLettered && (command.kind === "run-job" || command.kind === "run-tests")) {
        deps.store.finishAttempt(
          run.ticketId,
          command.stage,
          Number(command.payload.attempt ?? 1),
          {
            status: "failed",
            outcome: "OUTBOX_FAILED",
            errorCode: "OUTBOX_FAILED",
            errorMessage: message,
          }
        );
      }
      // run-tests też jest lifecycle-critical: dead-letter spawnu (np. PATH)
      // zostawiałby run w test/pending bez żadnej komendy — cichy stuck.
      const lifecycleCritical = ["run-job", "run-tests", "publish-pr", "mark-pr-ready"].includes(command.kind);
      if (deadLettered && lifecycleCritical) {
        const stage = runStageOf(command.stage);
        applyDecision(deps, run.ticketId, {
          transition: {
            stage,
            status: "blocked",
            actor: "outbox",
            reason: "side-effect-failed",
            patch: {
              blockedStage: stage,
              errorCode: "OUTBOX_FAILED",
              errorMessage: message,
            },
            cancelOutstandingRunJobs: true,
          },
          commands: [],
        });
      }
    }
  }
}

function runsRoot(): string {
  return process.env.FACTORY_RUNS_ROOT ??
    join(dirname(findUpFile("package.json")), "runs");
}

function testResultPath(ticketId: string, generation: number, attempt: number): string {
  return join(runsRoot(), ticketId, `test-result-g${generation}-a${attempt}.json`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killPidGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch { /* proces już nie istnieje */ }
  }
  setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* grupa już nie istnieje */ }
  }, 5_000).unref();
}

/** Produkcyjny spawn detached runnera testów (testy wstrzykują stub przez deps). */
function spawnTestRunnerProcess(input: TestRunnerSpawn): number {
  const rootDir = dirname(findUpFile("package.json"));
  const runnerPath = join(rootDir, "src", "pipeline", "test-runner.ts");
  const tsxBin = join(rootDir, "node_modules", ".bin", "tsx");
  const inputPath = `${input.resultPath}.input.json`;
  mkdirSync(dirname(inputPath), { recursive: true });
  writeFileSync(inputPath, JSON.stringify(input));
  const log = openSync(join(dirname(input.resultPath), `test-runner-a${input.attempt}.log`), "a");
  try {
    const child = spawn(tsxBin, [runnerPath, inputPath, input.resultPath], {
      cwd: rootDir,
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.unref();
    if (!child.pid) throw new Error("Nie udało się uruchomić runnera testów (brak PID).");
    return child.pid;
  } finally {
    closeSync(log);
  }
}

/** Idempotentny enqueue testów exact-SHA dla runu w stanie test/pending. */
function enqueueTestRun(deps: PollerDependencies, run: LifecycleRun): void {
  if (!run.headSha) return;
  deps.store.enqueue({
    key: `${run.ticketId}:g${run.generation}:run-tests:${run.headSha}`,
    ticketId: run.ticketId,
    kind: "run-tests",
    stage: "test",
    payload: {
      sha: run.headSha,
      attempt: deps.store.nextAttempt(run.ticketId, "test"),
    },
  });
}

/**
 * Testy exact-SHA w osobnym, detached procesie: pętla pollera nie stoi 20 min
 * na `npm ci && test`, a restart pollera nie zabija biegnących testów.
 * Wynik wraca plikiem JSON; stan przechodzi wyłącznie przez reduceLifecycle.
 */
async function dispatchTestRun(
  deps: PollerDependencies,
  command: LifecycleCommand,
  run: LifecycleRun
): Promise<void> {
  const attempt = Number(command.payload.attempt ?? 1);
  const sha = String(command.payload.sha);
  const resultPath = testResultPath(run.ticketId, run.generation, attempt);

  if (existsSync(resultPath)) {
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as TestRunnerResult;
    let current = run;
    if (result.finalSha !== result.requestedSha && current.headSha === result.requestedSha) {
      current = applyDecision(deps, run.ticketId, reduceLifecycle(current, {
        type: "branch-synchronized",
        previousSha: result.requestedSha,
        sha: result.finalSha,
      }));
    }
    deps.store.finishAttempt(run.ticketId, "test", attempt, {
      status: result.ok ? "success" : "failed",
      outcome: result.ok ? "pass" : "fail",
      report: result.report,
      durationMs: result.durationMs,
      errorCode: result.ok ? undefined : "TEST_FAILED",
      errorMessage: result.ok ? undefined : result.report,
    });
    applyDecision(deps, run.ticketId, reduceLifecycle(current, {
      type: "test-result",
      ok: result.ok,
      sha: result.finalSha,
      report: result.report,
    }), command.key);
    return;
  }

  if (!command.externalId) {
    const project = await getProject(run.project);
    const usage = deps.store.totalUsage(run.ticketId);
    deps.store.startAttempt(run.ticketId, "test", attempt, `local-test:${sha}:${attempt}`, {
      inputHash: run.manifest.inputHash,
      sha,
      budgetMaxMinutes: project.budget?.maxMinutes ??
        Number(process.env.FACTORY_BUDGET_MAX_MIN ?? 45),
      budgetMaxUsd: project.budget?.maxUsd ??
        Number(process.env.FACTORY_BUDGET_MAX_USD ?? 3),
      budgetUsedMinutes: usage.minutes,
      budgetUsedUsd: usage.usd,
    });
    const pid = (deps.spawnTestRunner ?? spawnTestRunnerProcess)({
      ticketId: run.ticketId,
      project: run.project,
      sha,
      attempt,
      planFiles: run.planFiles,
      resultPath,
    });
    deps.store.markCommand(command.key, "dispatched", { externalId: String(pid) });
    return;
  }

  // Runner wystartował, wyniku nie ma: liveness + lease (20 min testów + grace).
  const pid = Number(command.externalId);
  const alive = pidAlive(pid);
  const latest = deps.store.latestAttempt(run.ticketId, "test");
  const startedAt = latest?.startedAt ?? command.updatedAt;
  const leaseMinutes = 20 + Number(process.env.FACTORY_JOB_GRACE_MIN ?? 10);
  const elapsedMinutes = (Date.now() - Date.parse(startedAt)) / 60_000;
  if (alive && elapsedMinutes <= leaseMinutes) return;
  if (alive) killPidGroup(pid);
  const errorCode = alive ? "TEST_STALLED" : "TEST_RUNNER_DIED";
  const message = alive
    ? `Runner testów przekroczył lease ${leaseMinutes} min bez wyniku.`
    : "Runner testów zakończył się bez pliku wyniku (crash?). Wznowienie: /retry.";
  deps.store.finishAttempt(run.ticketId, "test", attempt, {
    status: "failed",
    outcome: errorCode,
    report: message,
    errorCode,
    errorMessage: message,
  });
  applyDecision(deps, run.ticketId, {
    transition: {
      stage: "test",
      status: "blocked",
      actor: "test-runner",
      reason: errorCode,
      patch: { blockedStage: "test", errorCode, errorMessage: message },
    },
    commands: [],
  }, command.key);
}

export function localExactShaCiResult(
  project: string,
  testedSha: string | undefined,
  headSha: string
): { outcome: "pass" | "fail"; report: string } | undefined {
  if (project !== "br-budget") return undefined;
  const passed = testedSha === headSha;
  return {
    outcome: passed ? "pass" : "fail",
    report: passed
      ? `br-budget: lokalny exact-SHA check przeszedł dla ${headSha}; branch protection jest niedostępna.`
      : `br-budget: brak lokalnego wyniku testów dla aktualnego PR head ${headSha}.`,
  };
}

async function reconcileCi(deps: PollerDependencies, run: LifecycleRun): Promise<void> {
  if (!run.prUrl || !run.headSha) return;
  const project = await getProject(run.project);
  const snapshot = await inspectPullRequestChecks(project.repo, run.prUrl);
  if (snapshot.headSha !== run.headSha) {
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "pr-head-changed",
      sha: snapshot.headSha,
    }));
    return;
  }
  const localCi = localExactShaCiResult(run.project, run.testedSha, run.headSha);
  if (localCi) {
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "ci-result",
      outcome: localCi.outcome,
      sha: run.headSha,
      report: localCi.report,
      nextReviewAttempt: deps.store.nextAttempt(run.ticketId, "review"),
    }));
    return;
  }
  const evaluation = evaluateGithubChecks(snapshot, project.ci?.requiredChecks ?? []);
  applyDecision(deps, run.ticketId, reduceLifecycle(run, {
    type: "ci-result",
    outcome: evaluation.outcome,
    sha: run.headSha,
    report: evaluation.report,
    nextReviewAttempt: deps.store.nextAttempt(run.ticketId, "review"),
  }));
}

async function reconcilePullRequest(deps: PollerDependencies, run: LifecycleRun): Promise<void> {
  if (!run.prUrl) return;
  const project = await getProject(run.project);
  const { stdout } = await execFileControlled(
    "gh",
    ["pr", "view", run.prUrl, "--json", "state,mergedAt,mergeCommit,headRefOid"],
    { cwd: project.repo, timeoutMs: 30_000 }
  );
  const pr = JSON.parse(stdout) as {
    state?: string;
    mergedAt?: string | null;
    mergeCommit?: { oid?: string } | null;
    headRefOid?: string;
  };
  if (pr.mergedAt) {
    await cancelActiveJobs(deps, run.ticketId);
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "pr-state",
      state: "merged",
      sha: pr.mergeCommit?.oid ?? pr.headRefOid ?? run.headSha ?? "",
    }));
  } else if (pr.state === "CLOSED") {
    await cancelActiveJobs(deps, run.ticketId);
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "pr-state",
      state: "closed",
      sha: pr.headRefOid ?? run.headSha ?? "",
    }));
  } else if (
    pr.headRefOid &&
    pr.headRefOid !== run.headSha &&
    ["ci", "review", "merge"].includes(run.stage)
  ) {
    // W build/test/publish lokalny pipeline jest z przodu: świeży checkpoint
    // nie został jeszcze wypchnięty, więc źródłem prawdy nie jest stary PR head.
    await cancelActiveJobs(deps, run.ticketId);
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "pr-head-changed",
      sha: pr.headRefOid,
    }));
  }
}

async function runSmoke(deps: PollerDependencies, run: LifecycleRun): Promise<void> {
  const project = await getProject(run.project);
  const checks = project.qa?.prodChecks;
  const result = checks?.length
    ? await runProdChecks(checks)
    : { ok: true, report: "Brak skonfigurowanego prod smoke.", skipped: true };
  applyDecision(deps, run.ticketId, reduceLifecycle(run, {
    type: "smoke-result",
    outcome: "skipped" in result && result.skipped
      ? "skipped-not-configured"
      : result.ok ? "pass" : "fail",
    report: result.report,
  }));
}

/** Zapis oceny /score (aktywny albo ukończony run) + wiersz eksperymentu + potwierdzenie. */
async function recordScore(
  deps: PollerDependencies,
  run: LifecycleRun,
  source: LinearSource,
  commentId: string,
  payload: string | undefined
): Promise<void> {
  const parsed = parseScorePayload(payload);
  if (!parsed) return;
  deps.store.setScore(run.ticketId, parsed.value, parsed.comment);
  deps.store.markCommentProcessed(run.ticketId, commentId, "score");
  void appendExperimentRow({
    kind: "score",
    ticket: run.ticketId,
    generation: run.generation,
    project: run.project,
    score: parsed.value,
    comment: parsed.comment,
  }).catch(() => {});
  await source.comment(
    run.ticketId,
    `✅ Zapisano ocenę **${parsed.value}/5**${parsed.comment ? ` („${parsed.comment}")` : ""} do danych eksperymentu.\n\n${marker(run.ticketId)}`
  ).catch(() => {});
}

async function applyScopeGrant(
  deps: PollerDependencies,
  run: LifecycleRun,
  source: LinearSource,
  commentId: string,
  payload: string | undefined
): Promise<boolean> {
  const blockedPaths = scopeBlockedPaths(run.errorMessage);
  const authorization = authorizeScopePaths(
    parseScopePaths(payload, blockedPaths),
    run.planFiles,
    blockedPaths
  );
  const rejected = authorization.rejected.map(({ path, reason }) =>
    `- \`${path || "(pusta ścieżka)"}\`: ${reason}`
  );
  const alreadyDeclared = authorization.alreadyDeclared.map((path) =>
    `- \`${path}\`: ścieżka jest już w zatwierdzonym planie`
  );
  const notes = [...rejected, ...alreadyDeclared];

  if (authorization.accepted.length === 0) {
    const delivered = await source.comment(
      run.ticketId,
      [
        "⛔ **Zakres nie został rozszerzony.**",
        ...notes,
        "Sekretów nie można autoryzować; jeśli plan wymaga innej bezpiecznej ścieżki, użyj `/replan <powód>`.",
        marker(run.ticketId),
      ].join("\n\n")
    ).then(() => true).catch(() => false);
    if (delivered) {
      deps.store.markCommentProcessed(run.ticketId, commentId, "scope");
    }
    return false;
  }

  applyDecision(deps, run.ticketId, reduceLifecycle(run, {
    type: "scope",
    commentId,
    paths: authorization.accepted,
    nextAttempt: deps.store.nextAttempt(run.ticketId, "build"),
  }));
  deps.store.markCommentProcessed(run.ticketId, commentId, "scope");

  if (notes.length) {
    await source.comment(
      run.ticketId,
      [
        "ℹ️ **Część argumentów `/scope` nie zmieniła zakresu:**",
        ...notes,
        marker(run.ticketId),
      ].join("\n\n")
    ).catch(() => {});
  }
  return true;
}

function enqueueUnknownCommandHint(
  deps: PollerDependencies,
  run: LifecycleRun,
  comment: { id: string; body: string }
): void {
  const [firstToken = comment.body.trim()] = comment.body.trim().split(/\s+/);
  deps.store.enqueue({
    key: `${run.ticketId}:g${run.generation}:unknown-command:${comment.id}`,
    ticketId: run.ticketId,
    kind: "linear-comment",
    stage: run.stage,
    payload: {
      body: unknownCommandHint({
        firstToken,
        stage: run.stage,
        status: run.status,
        blockedStage: run.blockedStage,
        errorCode: run.errorCode,
        planDomain: run.planDomain,
        approvedAt: run.approvedAt,
        reviewStatus: run.reviewStatus,
        fixRound: run.fixRound,
        mergedSha: run.mergedSha,
      }),
    },
  });
  deps.store.markCommentProcessed(run.ticketId, comment.id, "unknown-command");
}

async function processCommands(deps: PollerDependencies, run: LifecycleRun): Promise<void> {
  const source = sourceFor(deps, run);
  const comments = await source.listComments(run.ticketId);
  for (const comment of comments) {
    if (deps.store.isCommentProcessed(comment.id) || comment.body.includes(marker(run.ticketId))) continue;
    const parsed = parseCommand(comment.body);
    if (!parsed) {
      if (isCommandAttempt(comment.body)) enqueueUnknownCommandHint(deps, run, comment);
      continue;
    }
    if (parsed.kind === "score") {
      await recordScore(deps, run, source, comment.id, parsed.payload);
      continue;
    }
    if (parsed.kind === "scope") {
      try {
        const transitioned = await applyScopeGrant(
          deps,
          run,
          source,
          comment.id,
          parsed.payload
        );
        if (!transitioned) continue;
      } catch (error) {
        await source.comment(
          run.ticketId,
          `ℹ️ Komenda \`${comment.body.split(/\s+/)[0]}\` jest teraz niedozwolona: ${error instanceof Error ? error.message : error}\n\n${marker(run.ticketId)}`
        );
        deps.store.markCommentProcessed(run.ticketId, comment.id, parsed.kind);
      }
      return;
    }
    let event: CoordinatorEvent | undefined;
    if (parsed.kind === "approve") event = {
      type: "approve",
      commentId: comment.id,
      nextAttempt: deps.store.nextAttempt(run.ticketId, "build"),
    };
    else if (parsed.kind === "reject") event = {
      type: "reject", commentId: comment.id, reason: parsed.payload ?? "bez powodu",
    };
    else if (parsed.kind === "answer" && parsed.payload) event = {
      type: "answer", commentId: comment.id, answer: parsed.payload,
    };
    else if (parsed.kind === "retry") {
      const blockedStage = run.blockedStage;
      const attemptStage = blockedStage === "test" ? "build" : blockedStage;
      event = {
        type: "retry",
        commentId: comment.id,
        nextAttempt: attemptStage && attemptStage !== "research"
          ? deps.store.nextAttempt(run.ticketId, attemptStage)
          : undefined,
        nextAttempts: followUpAttempts(deps.store, run.ticketId),
      };
    }
    else if (parsed.kind === "fix") {
      event = {
        type: "fix",
        commentId: comment.id,
        hints: parsed.payload,
        nextAttempt: deps.store.nextAttempt(run.ticketId, "build"),
      };
    }
    else if (parsed.kind === "replan" || parsed.kind === "restart") event = {
      type: "replan", commentId: comment.id, reason: parsed.payload ?? "operator requested replan",
    };
    else if (parsed.kind === "done") event = { type: "ops-done", commentId: comment.id };
    if (!event) continue;
    try {
      if (event.type === "answer") {
        const ticket = await source.getTicket(run.ticketId);
        const snapshot = buildCommentContextSnapshot(
          run.ticketId,
          ticket.title,
          ticket.description,
          comments
        );
        event.inputHash = snapshot.effectiveInputHash;
        event.commentContext = snapshot.context || undefined;
        // Pytania zadaje etap, na którym run czeka (plan | triage | synthesis).
        const clarifyStage = run.stage === "triage" || run.stage === "synthesis" ? run.stage : "plan";
        event.nextAttempt = deps.store.nextAttempt(run.ticketId, clarifyStage);
      }
      if (event.type === "replan") {
        event.nextAttempts = followUpAttempts(deps.store, run.ticketId);
        await cancelActiveJobs(deps, run.ticketId);
      }
      applyDecision(deps, run.ticketId, reduceLifecycle(run, event));
      deps.store.markCommentProcessed(run.ticketId, comment.id, parsed.kind);
      return;
    } catch (error) {
      await source.comment(
        run.ticketId,
        `ℹ️ Komenda \`${comment.body.split(/\s+/)[0]}\` jest teraz niedozwolona: ${error instanceof Error ? error.message : error}\n\n${marker(run.ticketId)}`
      );
      deps.store.markCommentProcessed(run.ticketId, comment.id, parsed.kind);
    }
  }
}

async function cancelActiveJobs(deps: PollerDependencies, ticketId: string): Promise<void> {
  for (const command of deps.store.outstandingCommands().filter(
    (item) => item.ticketId === ticketId && item.kind === "run-job" && item.externalId
  )) {
    await deps.mastra.cancelRun(command.externalId!).catch(() => {});
  }
}

async function detectInputChange(
  deps: PollerDependencies,
  run: LifecycleRun
): Promise<LifecycleRun> {
  const source = sourceFor(deps, run);
  const [ticket, comments] = await Promise.all([
    source.getTicket(run.ticketId),
    source.listComments(run.ticketId),
  ]);
  const snapshot = buildCommentContextSnapshot(
    run.ticketId,
    ticket.title,
    ticket.description,
    comments
  );
  if (snapshot.effectiveInputHash === run.manifest.inputHash) return run;
  await cancelActiveJobs(deps, run.ticketId);
  return applyDecision(deps, run.ticketId, reduceLifecycle(run, {
    type: "input-changed",
    inputHash: snapshot.effectiveInputHash,
    commentContext: snapshot.context || undefined,
    title: ticket.title,
    description: ticket.description,
    labels: ticket.labels,
    nextAttempts: followUpAttempts(deps.store, run.ticketId),
  }));
}

export async function reconcileRun(deps: PollerDependencies, run: LifecycleRun): Promise<void> {
  await processCommands(deps, run);
  let current = deps.store.getRun(run.ticketId);
  if (!current || current.status === "done") return;
  const source = sourceFor(deps, current);
  // Decyzja człowieka o zamknięciu ticketu ma pierwszeństwo przed KAŻDĄ ścieżką
  // mogącą wygenerować nowe przejście blokujące (input-changed, PR, zombie).
  const linearState = await source.getStateName(current.ticketId).catch(() => undefined);
  if (linearState === "Canceled" || linearState === "Duplicate") {
    const ticketId = current.ticketId;
    for (const command of deps.store.outstandingCommands().filter((item) => item.ticketId === ticketId)) {
      if (!command.externalId) continue;
      if (command.kind === "run-tests") killPidGroup(Number(command.externalId));
      else if (command.kind === "run-job") await deps.mastra.cancelRun(command.externalId).catch(() => {});
    }
    applyDecision(deps, current.ticketId, reduceLifecycle(current, { type: "cancel" }));
    return;
  }
  current = await detectInputChange(deps, current);
  if (linearState === "Done" && !current.mergedSha && current.planDomain !== "ops") {
    if (current.prUrl) {
      await reconcilePullRequest(deps, current);
      const reconciled = deps.store.getRun(current.ticketId);
      if (reconciled?.mergedSha) {
        if (reconciled.stage === "smoke" && reconciled.status === "pending") {
          await runSmoke(deps, reconciled);
        }
        return;
      }
      if (reconciled?.errorCode === "PR_CLOSED_UNMERGED") return;
      if (reconciled) current = reconciled;
    }
    if (current.errorCode === "PREMATURE_DONE" && current.status === "blocked") return;
    applyDecision(deps, current.ticketId, {
      transition: {
        stage: current.stage,
        status: "blocked",
        actor: "linear",
        reason: "premature-done",
        patch: {
          blockedStage: current.stage,
          errorCode: "PREMATURE_DONE",
          errorMessage: "Linear ustawiono na Done przed merge śledzonego PR.",
        },
      },
      commands: [{
        key: `${current.ticketId}:g${current.generation}:premature-done`,
        ticketId: current.ticketId,
        kind: "linear-comment",
        stage: current.stage,
        payload: {
          body: "❌ **Done jest przedwczesne.** Śledzony PR nie został zmergowany; ticket został zablokowany bez utraty brancha.",
        },
      }],
    });
    return;
  }
  // Strażnik zombie: run "running" bez żadnego niedokończonego joba w outboxie
  // nie ma się z czego wznowić (incydent BAR-177: retry-key kolidował z komendą
  // anulowaną przed dispatchem i INSERT OR IGNORE zjadł joba po cichu).
  if (
    current.status === "running" &&
    ["plan", "triage", "research", "synthesis", "critique", "build", "review"].includes(current.stage) &&
    !deps.store.hasOutstandingJob(current.ticketId)
  ) {
    applyDecision(deps, current.ticketId, {
      transition: {
        stage: current.stage,
        status: "blocked",
        actor: "coordinator",
        reason: "job-missing",
        patch: {
          blockedStage: current.stage,
          errorCode: "JOB_MISSING",
          errorMessage: "Run w stanie running nie ma żadnego joba w outboxie. Wznowienie: /retry.",
        },
      },
      commands: [],
    });
    return;
  }
  if (current.stage === "smoke" && current.status === "pending") await runSmoke(deps, current);
  else if (current.stage === "test" && current.status === "pending") enqueueTestRun(deps, current);
  else if (current.stage === "ci" && current.status === "waiting_external") await reconcileCi(deps, current);
  else if (current.prUrl) await reconcilePullRequest(deps, current);
}

let reportedBreaker: string | undefined;

async function claimReady(deps: PollerDependencies): Promise<void> {
  // Circuit breaker: seria porażek albo koszt/h zatrzymują CLAIM nowych
  // ticketów; aktywne runy reconcilują się dalej (semantyka v1).
  const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  await checkHourlySpend(deps.store.usageSince(hourAgo)).catch(() => {});
  const open = await breakerOpen().catch(() => null);
  if (open) {
    if (reportedBreaker !== open) {
      console.error(`Circuit breaker otwarty: ${open}`);
      const notifier = deps.notifier ?? notify;
      await notifier("🔌 Circuit breaker otwarty", open).catch(() => {});
      reportedBreaker = open;
    }
    return;
  }
  reportedBreaker = undefined;
  for (const [projectKey, source] of deps.sources) {
    const preflight = await runPreflight(projectKey, {
      linearStateNames: () => source.listStateNames(),
      mastraUp: () => deps.mastra.serverUp(),
    });
    if (!preflight.ok) {
      const message = preflight.errors.join("; ");
      if (reportedPreflight.get(projectKey) !== message) {
        console.error(`[${projectKey}] preflight failed: ${message}`);
        await notify(`🛑 ${projectKey}: preflight fabryki`, message).catch(() => {});
        reportedPreflight.set(projectKey, message);
      }
      continue;
    }
    reportedPreflight.delete(projectKey);
    // Warningi preflightu (np. zmiana wersji harnessu CLI) raportujemy raz.
    const warningMessage = preflight.warnings.join("; ");
    if (warningMessage && reportedWarnings.get(projectKey) !== warningMessage) {
      console.warn(`[${projectKey}] preflight: ${warningMessage}`);
      const notifier = deps.notifier ?? notify;
      await notifier(`⚠️ ${projectKey}: preflight`, warningMessage).catch(() => {});
      reportedWarnings.set(projectKey, warningMessage);
    }
    const project = await getProject(projectKey);
    const active = deps.store.listActive().filter((run) => run.project === projectKey).length;
    const free = Math.max(0, (project.max_concurrent_tickets ?? Number.POSITIVE_INFINITY) - active);
    if (free <= 0) continue;
    const tickets = (await source.listReady()).slice(0, free);
    for (const ticket of tickets) {
      const existing = deps.store.getRun(ticket.id);
      if (existing && existing.status !== "done") {
        await source.claim(ticket.id);
        continue;
      }
      const comments = await source.listComments(ticket.id);
      const snapshot = buildCommentContextSnapshot(ticket.id, ticket.title, ticket.description, comments);
      const run = deps.store.createRun(ticket.id, projectKey, {
        title: ticket.title,
        description: ticket.description,
        labels: ticket.labels,
        url: ticket.url,
        inputHash: snapshot.effectiveInputHash,
        commentContext: snapshot.context || undefined,
      });
      await source.claim(ticket.id);
      // v3 deep-plan: wejściem jest triage, chyba że label plan:solo wymusza
      // klasyczną ścieżkę. Projekty bez planPipeline zostają na v2.
      const soloForced = ticket.labels.includes("plan:solo");
      const entry = project.planPipeline === "v3" && !soloForced ? "triage" : "plan";
      applyDecision(deps, ticket.id, reduceLifecycle(run, {
        type: "start",
        entry,
        forcedVariant: project.planPipeline === "v3" && soloForced ? "solo" : undefined,
        nextAttempt: deps.store.nextAttempt(ticket.id, entry),
      }));
    }
  }
}

/**
 * Sweep ocen: ukończone tickety nie przechodzą przez reconcileRun, więc /score
 * po Done czytamy osobno (okno 14 dni; po zapisaniu oceny run znika z listy).
 */
export async function sweepScores(deps: PollerDependencies): Promise<void> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60_000).toISOString();
  for (const run of deps.store.listScoreCandidates(since)) {
    const source = deps.sources.get(run.project);
    if (!source) continue;
    const comments = await source.listComments(run.ticketId).catch(() => []);
    for (const comment of comments) {
      if (deps.store.isCommentProcessed(comment.id) || comment.body.includes(marker(run.ticketId))) continue;
      const parsed = parseCommand(comment.body);
      if (!parsed && isCommandAttempt(comment.body)) {
        enqueueUnknownCommandHint(deps, run, comment);
        continue;
      }
      if (parsed?.kind !== "score") continue;
      await recordScore(deps, run, source, comment.id, parsed.payload);
      break;
    }
  }
}

/** Throttle sweepa ocen: fan-out do API Lineara nie musi biec co cykl pollera. */
const SCORE_SWEEP_INTERVAL_MS = Number(process.env.FACTORY_SCORE_SWEEP_MS ?? 10 * 60_000);
let lastScoreSweepAt = 0;

export async function pollOnce(deps: PollerDependencies): Promise<void> {
  await dispatchOutbox(deps);
  for (const run of deps.store.listActive()) {
    await reconcileRun(deps, run).catch((error) =>
      console.error(`[${run.ticketId}] reconcile:`, error instanceof Error ? error.message : error)
    );
  }
  if (Date.now() - lastScoreSweepAt >= SCORE_SWEEP_INTERVAL_MS) {
    lastScoreSweepAt = Date.now();
    await sweepScores(deps).catch((error) =>
      console.error("Sweep ocen nieudany:", error instanceof Error ? error.message : error)
    );
  }
  await claimReady(deps);
  await dispatchOutbox(deps);
}

/**
 * Backup lifecycle.db: najwyżej raz na 24 h, retencja FACTORY_BACKUP_KEEP
 * najnowszych kopii. Błąd backupu nigdy nie zatrzymuje pętli pollera.
 */
export function maybeBackupLifecycleDb(
  store: LifecycleStore,
  dir = join(dirname(findUpFile("package.json")), "runs", "backups")
): void {
  try {
    mkdirSync(dir, { recursive: true });
    const listBackups = () => readdirSync(dir)
      .filter((name) => name.startsWith("lifecycle-") && name.endsWith(".db"))
      .sort();
    const newest = listBackups().at(-1);
    const ageMs = newest
      ? Date.now() - statSync(join(dir, newest)).mtimeMs
      : Number.POSITIVE_INFINITY;
    if (ageMs < 24 * 60 * 60_000) return;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    store.backupTo(join(dir, `lifecycle-${stamp}.db`));
    const keep = Math.max(1, Number(process.env.FACTORY_BACKUP_KEEP ?? 7));
    const backups = listBackups();
    for (const stale of backups.slice(0, Math.max(0, backups.length - keep))) {
      unlinkSync(join(dir, stale));
    }
  } catch (error) {
    console.error("Backup lifecycle.db nieudany:", error instanceof Error ? error.message : error);
  }
}

/**
 * Single-writer lease: drugi poller (np. ręczny `--once` obok usługi launchd)
 * nie może pisać do tej samej bazy — obie instancje zdispatchowałyby te same
 * komendy outboxu. Martwy PID albo przeterminowany heartbeat można przejąć.
 */
export function ensureSingleWriter(
  store: LifecycleStore,
  pid = process.pid,
  isAlive: (pid: number) => boolean = (candidate) => {
    try {
      process.kill(candidate, 0);
      return true;
    } catch {
      return false;
    }
  }
): void {
  const lease = store.readLease();
  const fresh = lease && Date.now() - Date.parse(lease.heartbeatAt) < 90_000;
  if (lease && lease.pid !== pid && fresh && isAlive(lease.pid)) {
    throw new Error(
      `Inny poller (PID ${lease.pid}, ${lease.hostname ?? "?"}) trzyma lease na lifecycle.db — zatrzymaj go przed startem.`
    );
  }
  store.claimLease(pid, hostname());
}

function loadDotEnv(): void {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // env procesu jest wystarczający.
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error("Brak LINEAR_API_KEY.");
  const projects = (process.env.LINEAR_PROJECTS ?? process.env.LINEAR_PROJECT ?? "pilot-app")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const sources = new Map(projects.map((project) => [project, new LinearSource(apiKey, project)]));
  const extendedStatuses = new Set<string>();
  for (const projectKey of projects) {
    const project = await getProject(projectKey);
    if (project.statuses === "extended") extendedStatuses.add(projectKey);
  }
  const deps: PollerDependencies = {
    store: new LifecycleStore(),
    mastra: new MastraWorkflowClient(process.env.FACTORY_API ?? "http://localhost:4111/api", "factoryJob"),
    sources,
    extendedStatuses,
  };
  ensureSingleWriter(deps.store);
  const release = () => {
    try {
      deps.store.releaseLease(process.pid);
      deps.store.close();
    } catch {
      // zamknięcie w trakcie zamykania — nic do zrobienia
    }
  };
  process.once("SIGINT", () => { release(); process.exit(130); });
  process.once("SIGTERM", () => { release(); process.exit(143); });
  const once = process.argv.includes("--once");
  do {
    deps.store.renewLease(process.pid);
    maybeBackupLifecycleDb(deps.store);
    await pollOnce(deps).catch((error) =>
      console.error("Poll v2 nieudany:", error instanceof Error ? error.message : error)
    );
    if (!once) await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  } while (!once);
  release();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
