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

export type OpenGateName =
  | "score"
  | "blocked"
  | "ops-checklist"
  | "plan-approval"
  | "clarify"
  | "merge"
  | null;

export interface OpenGateInput {
  stage: string;
  status: string;
  errorCode?: string;
  planDomain?: string;
  approvedAt?: string;
  reviewStatus?: string;
  fixRound?: number;
  mergedSha?: string;
}

export interface OpenGateView {
  gate: OpenGateName;
  waitingOn: "human" | "factory";
  humanCommands: string[];
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

/** Jedno źródło prawdy o otwartej bramce i komendach dostępnych wyłącznie człowiekowi. */
export function openGate(run: OpenGateInput): OpenGateView {
  if (run.status === "done") {
    return {
      gate: "score",
      waitingOn: "human",
      humanCommands: ["/score 1-5 [komentarz]"],
    };
  }
  if (run.status === "blocked") {
    const humanCommands = ["/retry", "/replan <powód>"];
    if (run.errorCode === "SCOPE_BLOCKED") humanCommands.push("/scope <ścieżka>");
    return { gate: "blocked", waitingOn: "human", humanCommands };
  }
  if (
    run.stage === "approval" &&
    run.status === "waiting_human" &&
    run.planDomain === "ops" &&
    run.approvedAt
  ) {
    return {
      gate: "ops-checklist",
      waitingOn: "human",
      humanCommands: ["/done"],
    };
  }
  if (run.stage === "approval" && run.status === "waiting_human") {
    return {
      gate: "plan-approval",
      waitingOn: "human",
      humanCommands: ["/approve", "/reject <powód>"],
    };
  }
  if (
    ["plan", "triage", "synthesis"].includes(run.stage) &&
    run.status === "waiting_human"
  ) {
    return {
      gate: "clarify",
      waitingOn: "human",
      humanCommands: ["/answer <odpowiedzi>"],
    };
  }
  if (run.stage === "merge" && run.status === "waiting_human") {
    if (run.mergedSha) {
      return {
        gate: "score",
        waitingOn: "human",
        humanCommands: ["/score 1-5"],
      };
    }
    const humanCommands = ["/replan <powód>", "/score 1-5"];
    if (run.reviewStatus === "advisory-fix" && (run.fixRound ?? 0) < 2) {
      humanCommands.unshift("/fix [wskazówki]");
    }
    return { gate: "merge", waitingOn: "human", humanCommands };
  }
  return {
    gate: null,
    waitingOn: run.status === "waiting_human" ? "human" : "factory",
    humanCommands: [],
  };
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
