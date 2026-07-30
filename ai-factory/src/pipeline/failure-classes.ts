import type { EngineRunResult } from "../engines/types";

export type EngineFailureClass = "infra" | "work";

/**
 * Znane awarie INFRASTRUKTURY silnika. Lista jest celowo jawna i zamknięta:
 * nieznany komunikat nie uruchamia płatnej próby zapasowej (fail-closed).
 * Po nowym incydencie dopisz tutaj możliwie wąski wzorzec oraz test regresyjny.
 */
const INFRA_PATTERNS: RegExp[] = [
  /ENOENT|EACCES|spawn .* failed|Proces(\s+\w+)? zakończył się błędem/i,
  /timed? ?out|timeout|SIGKILL|SIGTERM|przekroczono limit czasu/i,
  /getaddrinfo|failed to lookup address information|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network error|websocket/i,
  /\b401\b|\b403\b|unauthorized|authentication|invalid api key|not logged in|please (re)?login/i,
  /\b429\b|rate limit|quota|credit balance|usage limit|insufficient|out of credits|overloaded|\b50[0234]\b/i,
  /internal server error|service unavailable|bad gateway/i,
];

export function classifyEngineFailure(report: string): EngineFailureClass {
  return INFRA_PATTERNS.some((pattern) => pattern.test(report)) ? "infra" : "work";
}

type EngineFailureDetails = Pick<
  EngineRunResult,
  "report" | "stderr" | "terminationReason"
>;

const GENERATED_FAILURE_REPORT =
  /^(?:Proces(?:\s+\w+)? zakończył się błędem|Brak treści od agenta:)/i;

/**
 * Wybiera wyłącznie diagnostykę adaptera. Swobodny raport modelu jest
 * dołączany tylko wtedy, gdy adapter oznaczył go jako błąd strukturalny albo
 * sam wygenerował komunikat procesu. Dzięki temu plan opisujący "429",
 * "timeout" czy "websocket" nie uruchamia płatnej drugiej próby.
 */
export function engineFailureDiagnostic(failure: EngineFailureDetails): string {
  const report = failure.report.trim();
  const includeReport =
    failure.terminationReason === "engine-error-result" ||
    GENERATED_FAILURE_REPORT.test(report);
  return [
    includeReport ? report : "",
    failure.stderr?.trim() ?? "",
    failure.terminationReason ?? "",
  ].filter(Boolean).join("\n");
}

/** Klasyfikacja wyniku adaptera używana przez bramkę fallbacku. */
export function classifyEngineRunFailure(
  failure: EngineFailureDetails
): EngineFailureClass {
  if (failure.terminationReason === "abort") return "work";
  if (!failure.report.trim()) return "infra";
  if (
    failure.terminationReason === "process-error" ||
    failure.terminationReason === "timeout" ||
    failure.terminationReason === "empty-report"
  ) {
    return "infra";
  }
  return classifyEngineFailure(engineFailureDiagnostic(failure));
}
