import type { DecisionKind } from "../pipeline/run-registry";

/**
 * Komendy jako JEDYNY tekstowy kanał decyzji — furtka z telefonu, gdy
 * przeciągnięcie karty jest niewygodne.
 *
 * To NIE jest rozpoznawanie języka naturalnego: liczy się wyłącznie pierwszy
 * token linii, dokładnie równy jednej z komend. Wszystko inne = brak decyzji
 * (i podpowiedź od fabryki), nigdy „chyba chodziło mu o…".
 */
export const COMMANDS: Record<string, DecisionKind> = {
  "/approve": "approve",
  "/reject": "reject",
  "/answer": "answer",
};

export interface ParsedCommand {
  kind: DecisionKind;
  /** Reszta komentarza po komendzie — DANE (powód, odpowiedzi), nie sterowanie. */
  payload?: string;
}

/** Zwraca komendę tylko dla dokładnego dopasowania pierwszego tokenu. */
export function parseCommand(body: string): ParsedCommand | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [first, ...rest] = trimmed.split(/\s+/);
  const kind = COMMANDS[first.toLowerCase()];
  if (!kind) return undefined;
  const payload = rest.join(" ").trim() || trimmed.slice(first.length).trim();
  return { kind, payload: payload || undefined };
}

/** Podpowiedź wysyłana, gdy przy otwartej bramce przyjdzie komentarz bez sygnału. */
export function hintFor(gate: "plan-approval" | "clarify", states: { approve?: string; answer?: string }): string {
  return gate === "plan-approval"
    ? `ℹ️ To nie jest decyzja — przeciągnij kartę na **${states.approve ?? "Build"}** (zgoda) albo na Backlog/Canceled (odrzucenie), ` +
        "ewentualnie napisz komendę `/approve` lub `/reject <powód>`."
    : `ℹ️ Odpowiedzi zapisane. Żeby fabryka doplanowała, przeciągnij kartę na **${states.answer ?? "Planowanie"}** ` +
        "albo napisz `/answer <odpowiedzi>`.";
}
