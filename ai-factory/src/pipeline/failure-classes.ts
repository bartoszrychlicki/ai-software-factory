export type EngineFailureClass = "infra" | "work";

/**
 * Znane awarie INFRASTRUKTURY silnika. Lista jest celowo jawna i zamknięta:
 * nieznany komunikat nie uruchamia płatnej próby zapasowej (fail-closed).
 * Po nowym incydencie dopisz tutaj możliwie wąski wzorzec oraz test regresyjny.
 */
const INFRA_PATTERNS: RegExp[] = [
  /ENOENT|EACCES|spawn .* failed|Proces zakończył się błędem/i,
  /timed? ?out|timeout|SIGKILL|SIGTERM|przekroczono limit czasu/i,
  /getaddrinfo|failed to lookup address information|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network error|websocket/i,
  /\b401\b|\b403\b|unauthorized|authentication|invalid api key|not logged in|please (re)?login/i,
  /\b429\b|rate limit|quota|credit balance|usage limit|insufficient|out of credits|overloaded|\b50[0234]\b/i,
  /internal server error|service unavailable|bad gateway/i,
];

export function classifyEngineFailure(report: string): EngineFailureClass {
  return INFRA_PATTERNS.some((pattern) => pattern.test(report)) ? "infra" : "work";
}

export function isInfraFailureMessage(message: string): boolean {
  return classifyEngineFailure(message) === "infra";
}
