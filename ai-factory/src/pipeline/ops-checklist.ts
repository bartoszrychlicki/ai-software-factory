import type { ProdCheck, SmokeResult } from "./prod-smoke";

export const OPS_VERIFY_MAX_RETRIES = 4;
export const OPS_VERIFY_RETRY_INTERVAL_MS = 60_000;

export interface OpsVerificationResult {
  status: "pass" | "fail" | "no-checks";
  message: string;
  report?: string;
}

export interface OpsWorkflowResult {
  kind: "ops";
  ticketId: string;
  plan: string;
  planCostUsd?: number;
}

/** Fail-closed: sam brak checków nigdy nie jest sukcesem. */
export function classifyOpsVerification(
  checks: ProdCheck[] | undefined,
  smoke?: SmokeResult
): OpsVerificationResult {
  if (!checks?.length) {
    return {
      status: "no-checks",
      message:
        "Brak project.qa.prodChecks — automatyczna weryfikacja checklisty ops jest niemożliwa. " +
        "Ticket pozostaje BLOCKED / Needs Human (fail-closed).",
    };
  }
  if (!smoke?.ok) {
    return {
      status: "fail",
      message: "Deklaratywne prodChecks nie przeszły po ograniczonej liczbie prób.",
      report: smoke?.report ?? "Brak wyniku prodChecks.",
    };
  }
  return {
    status: "pass",
    message: "Deklaratywne prodChecks potwierdziły oczekiwany stan końcowy.",
    report: smoke.report,
  };
}

/** Decyzja pollera pozostaje czysta i testowalna; `human_review` nie jest możliwym wynikiem ops. */
export function opsTrackerStatus(result: OpsVerificationResult): "done" | "blocked" {
  return result.status === "pass" ? "done" : "blocked";
}

/**
 * Wspólna, ograniczona pętla retry dla QA rundy 2 i weryfikacji ops.
 * Efekty (HTTP i zegar) są wstrzykiwane, dzięki czemu limit prób da się testować bez sieci i czekania.
 */
export async function runProdChecksWithRetry(
  checks: ProdCheck[],
  runChecks: (checks: ProdCheck[]) => Promise<SmokeResult>,
  wait: (ms: number) => Promise<void>,
  maxRetries = OPS_VERIFY_MAX_RETRIES,
  retryIntervalMs = OPS_VERIFY_RETRY_INTERVAL_MS
): Promise<SmokeResult> {
  let result = await runChecks(checks);
  for (let retry = 0; !result.ok && retry < maxRetries; retry += 1) {
    await wait(retryIntervalMs);
    result = await runChecks(checks);
  }
  return result;
}

/** Guard trwałego, jawnego rezultatu workflow — bez zgadywania pól snapshotu. */
export function isOpsWorkflowResult(result: unknown): result is OpsWorkflowResult {
  if (typeof result !== "object" || result === null) return false;
  const candidate = result as Record<string, unknown>;
  return candidate.kind === "ops" &&
    typeof candidate.ticketId === "string" &&
    typeof candidate.plan === "string" &&
    (candidate.planCostUsd === undefined || typeof candidate.planCostUsd === "number");
}
