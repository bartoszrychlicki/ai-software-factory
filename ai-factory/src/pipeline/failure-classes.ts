import type { EngineRunResult } from "../engines/types";

export type EngineFailureClass = "infra" | "work";

/**
 * Znane awarie INFRASTRUKTURY silnika. Lista jest celowo jawna i zamknięta:
 * nieznany komunikat nie uruchamia płatnej próby zapasowej (fail-closed).
 * Po nowym incydencie dopisz tutaj możliwie wąski wzorzec oraz test regresyjny.
 */
const INFRA_PATTERNS: RegExp[] = [
  /ENOENT|EACCES|spawn .* failed/i,
  /timed? ?out|timeout|SIGKILL|SIGTERM|przekroczono limit czasu/i,
  /getaddrinfo|failed to lookup address information|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network error|websocket/i,
  /\b401\b|\b403\b|unauthorized|authentication|invalid api key|not logged in|please (re)?login/i,
  /\b429\b|rate limit|quota|credit balance|usage limit|insufficient (?:credits?|quota|balance|funds)|out of credits|overloaded|\b50[0234]\b/i,
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

const DIAGNOSTIC_TAIL_LINES = 8;

function diagnosticTail(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .slice(-DIAGNOSTIC_TAIL_LINES)
    .join("\n");
}

function generatedReportDiagnostic(report: string): string {
  const lines = report.trim().split(/\r?\n/);
  if (lines.length <= DIAGNOSTIC_TAIL_LINES + 1) return lines.join("\n");
  return [lines[0], ...lines.slice(-DIAGNOSTIC_TAIL_LINES)].join("\n");
}

/**
 * Wybiera wyłącznie diagnostykę adaptera. Swobodny raport modelu jest
 * dołączany tylko wtedy, gdy adapter oznaczył go jako błąd strukturalny albo
 * sam wygenerował komunikat procesu. stderr bierzemy wyłącznie z wyniku,
 * który ma jawną przyczynę zakończenia, i tylko z końca logu. Dzięki temu
 * ostrzeżenie CLI lub plan opisujący "429", "timeout" czy "websocket" nie
 * uruchamia płatnej drugiej próby.
 */
export function engineFailureDiagnostic(failure: EngineFailureDetails): string {
  const report = failure.report.trim();
  const reportDiagnostic = failure.terminationReason === "engine-error-result"
    ? report
    : GENERATED_FAILURE_REPORT.test(report)
      ? generatedReportDiagnostic(report)
      : "";
  const stderr = failure.terminationReason
    ? diagnosticTail(failure.stderr ?? "")
    : "";
  return [
    reportDiagnostic,
    stderr,
    failure.terminationReason ?? "",
  ].filter(Boolean).join("\n");
}

/** Klasyfikacja wyniku adaptera używana przez bramkę fallbacku. */
export function classifyEngineRunFailure(
  failure: EngineFailureDetails
): EngineFailureClass {
  if (failure.terminationReason === "abort") return "work";
  if (failure.terminationReason === "timeout") return "infra";
  // Pusty output jest brakiem wyniku pracy, nie dowodem awarii dostawcy.
  // Nie płacimy za zapas bez znanego sygnału infrastrukturalnego.
  if (
    failure.terminationReason === "empty-report" ||
    (!failure.report.trim() && !failure.stderr?.trim())
  ) {
    return "work";
  }
  return classifyEngineFailure(engineFailureDiagnostic(failure));
}
