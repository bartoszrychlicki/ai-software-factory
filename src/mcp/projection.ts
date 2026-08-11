import {
  HUMAN_SUMMARY_HEADING,
  extractSection,
  humanSummaryOf,
} from "../lifecycle/human-summary";
import {
  RESEARCH_ROLES,
  type LifecycleRun,
  type StageAttempt,
} from "../lifecycle/store";
import { openGate } from "../lifecycle/gates";

export {
  openGate,
  type OpenGateInput,
  type OpenGateName,
  type OpenGateView,
} from "../lifecycle/gates";

export interface UsageView {
  usd: number;
  minutes: number;
  budgetMaxUsd?: number;
  budgetMaxMinutes?: number;
}

export interface ClippedText {
  text: string;
  truncated: boolean;
}

export function clip(text: string, max: number): ClippedText {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error("Limit clipowania musi być dodatnią liczbą całkowitą");
  }
  if (text.length <= max) return { text, truncated: false };
  return {
    text: max === 1 ? "…" : `${text.slice(0, max - 1)}…`,
    truncated: true,
  };
}

function clipTail(text: string, max: number): ClippedText {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error("Limit clipowania musi być dodatnią liczbą całkowitą");
  }
  if (text.length <= max) return { text, truncated: false };
  return {
    text: max === 1 ? "…" : `…${text.slice(-(max - 1))}`,
    truncated: true,
  };
}

function optionalClip(text: string | undefined, max: number): ClippedText | null {
  return text === undefined ? null : clip(text, max);
}

/** Płaska, stabilna projekcja durable runu przeznaczona dla klientów MCP. */
export function runSummary(run: LifecycleRun, usage: UsageView) {
  const gate = openGate(run);
  return {
    ticket: run.ticketId,
    title: run.manifest.title,
    project: run.project,
    generation: run.generation,
    stage: run.stage,
    status: run.status,
    planDomain: run.planDomain,
    planFiles: run.planFiles,
    prUrl: run.prUrl,
    reviewStatus: run.reviewStatus,
    mergedSha: run.mergedSha,
    smokeStatus: run.smokeStatus,
    blockedStage: run.blockedStage,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    degradations: run.degradations ?? [],
    score: run.score,
    usageUsd: usage.usd,
    usageMinutes: usage.minutes,
    budgetMaxUsd: usage.budgetMaxUsd,
    budgetMaxMinutes: usage.budgetMaxMinutes,
    budgetUsdPercent: usage.budgetMaxUsd
      ? Math.round((usage.usd / usage.budgetMaxUsd) * 1_000) / 10
      : undefined,
    budgetMinutesPercent: usage.budgetMaxMinutes
      ? Math.round((usage.minutes / usage.budgetMaxMinutes) * 1_000) / 10
      : undefined,
    gate: gate.gate,
    waitingOn: gate.waitingOn,
    humanCommands: gate.humanCommands,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function planView(run: LifecycleRun) {
  const rawHumanSummary = extractSection(run.plan, HUMAN_SUMMARY_HEADING)?.body;
  const humanSummary = humanSummaryOf(run.plan);
  const summaryView = humanSummary === undefined
    ? null
    : {
        text: humanSummary,
        truncated: rawHumanSummary !== undefined && rawHumanSummary.length > humanSummary.length,
      };
  return {
    ticket: run.ticketId,
    generation: run.generation,
    plan: optionalClip(run.plan, 12_000),
    humanSummary: summaryView,
    triageSummary: optionalClip(run.triageSummary, 2_000),
    critiqueNotes: optionalClip(run.critiqueReport, 4_000),
    critiqueMeaning: optionalClip(run.critiqueMeaning, 1_000),
    researchBriefs: Object.fromEntries(
      RESEARCH_ROLES.map((role) => [role, optionalClip(run.briefs?.[role], 4_000)])
    ),
  };
}

export function attemptRow(attempt: StageAttempt, includeReportTail = false) {
  return {
    stage: attempt.stage,
    attempt: attempt.attempt,
    status: attempt.status,
    outcome: attempt.outcome,
    modelSignature: attempt.signature,
    costUsd: attempt.costUsd,
    durationMs: attempt.durationMs,
    errorCode: attempt.errorCode,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    ...(includeReportTail
      ? { reportTail: optionalClipTail(attempt.report, 2_000) }
      : {}),
  };
}

function optionalClipTail(text: string | undefined, max: number): ClippedText | null {
  return text === undefined ? null : clipTail(text, max);
}
