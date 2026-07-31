import type { EngineRunResult } from "../engines/types";

export type EngineFailureClass = "infra" | "work";

/**
 * Znane awarie INFRASTRUKTURY silnika. Lista jest celowo jawna i zamknięta:
 * nieznany komunikat nie uruchamia płatnej próby zapasowej (fail-closed).
 * Po nowym incydencie dopisz tutaj możliwie wąski wzorzec oraz test regresyjny.
 */
const INFRA_PATTERNS: RegExp[] = [
  /ENOENT|EACCES|spawn .* failed/i,
  // Timeout PO STRONIE DOSTAWCY (żądanie HTTP, brama) to tania awaria: model
  // nie zdążył nawet zacząć, więc zapas kosztuje tyle co zwykła próba.
  // NIE ma tu naszego własnego zabicia po limicie czasu roli — to obsługuje
  // `classifyEngineRunFailure` przez `terminationReason`, bo tam spalony jest
  // pełny budżet i druga próba płaci drugi raz za tę samą porażkę.
  /ETIMEDOUT|request timed? ?out|gateway time-?out/i,
  /getaddrinfo|failed to lookup address information|ENOTFOUND|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network error|websocket/i,
  // Statusy HTTP wyłącznie w kontekście odpowiedzi API. Gołe liczby trafiały
  // w ogon stderr buildera (log narzędzia, curl, asercja testu) i kupowały
  // płatną drugą próbę przy zwykłym niezerowym exit code.
  /(?:API |HTTP |status(?:[ :]code)?[ :]|Error[ :]+)\b(?:401|403)\b|unauthorized|authentication|invalid api key|not logged in|please (re)?login/i,
  /(?:API |HTTP |status(?:[ :]code)?[ :]|Error[ :]+)\b(?:429|50[0234])\b|rate limit|quota|credit balance|usage limit|insufficient (?:credits?|quota|balance|funds)|out of credits|overloaded/i,
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
  // TIMEOUT NIE JEST AWARIĄ DOSTAWCY — decyzja z danych (2026-07-31).
  //
  // Wszystkie realne pady silników w historii fabryki poza jednym kosztowały
  // grosze, bo model umierał na starcie (brak kredytów, DNS, zerwany websocket):
  // krytyka BAR-183 padła po 0,7 min za $0,11. Jedyny drogi przypadek to
  // timeout buildera: 25 min i $3,75 — pełny budżet roli spalony bez wyniku.
  //
  // Timeout znaczy „zadanie było za duże albo za trudne", a nie „padła sieć".
  // Drugi model najpewniej też nie zdąży, więc ratowanie go zawsze kosztuje
  // podwójnie za tę samą porażkę. Zostawiamy timeout człowiekowi — to sygnał
  // do zawężenia ticketu, zgodny z najdroższą lekcją tego okresu.
  //
  // Konsekwencja projektowa: skoro zapas uruchamiają wyłącznie tanie, wczesne
  // pady, druga próba mieści się w budżecie i lease pierwszej. Dlatego bramka
  // budżetu i lease pozostają BEZ ZMIAN względem stanu sprzed tego ticketu.
  if (failure.terminationReason === "timeout") return "work";
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
