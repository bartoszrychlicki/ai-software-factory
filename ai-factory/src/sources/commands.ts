import type { DecisionKind } from "../pipeline/run-registry";

export type OperatorCommandKind = "retry" | "replan" | "restart" | "score";
export type CommandKind = DecisionKind | OperatorCommandKind;

/**
 * Komendy jako JEDYNY tekstowy kanał decyzji — furtka z telefonu, gdy
 * przeciągnięcie karty jest niewygodne.
 *
 * To NIE jest rozpoznawanie języka naturalnego: liczy się wyłącznie pierwszy
 * token linii, dokładnie równy jednej z komend. Wszystko inne = brak decyzji
 * (i podpowiedź od fabryki), nigdy „chyba chodziło mu o…".
 */
export const COMMANDS: Record<string, CommandKind> = {
  "/approve": "approve",
  "/reject": "reject",
  "/answer": "answer",
  "/done": "done",
  "/retry": "retry",
  "/replan": "replan",
  "/restart": "restart",
  "/score": "score",
};

export interface ParsedCommand {
  kind: CommandKind;
  /** Reszta komentarza po komendzie — DANE (powód, odpowiedzi), nie sterowanie. */
  payload?: string;
}

const DECISION_COMMANDS = new Set<DecisionKind>(["start", "approve", "reject", "answer", "done"]);

export function isDecisionCommand(kind: CommandKind): kind is DecisionKind {
  return DECISION_COMMANDS.has(kind as DecisionKind);
}

/** Zwraca komendę tylko dla dokładnego dopasowania pierwszego tokenu. */
export function parseCommand(body: string): ParsedCommand | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [first, ...rest] = trimmed.split(/\s+/);
  const kind = COMMANDS[first.toLowerCase()];
  if (!kind) return undefined;
  const payload = rest.join(" ").trim() || trimmed.slice(first.length).trim();
  if (["reject", "answer", "replan"].includes(kind) && !payload) return undefined;
  if (["approve", "retry", "done"].includes(kind) && payload) return undefined;
  // /score wymaga oceny 1-5 jako pierwszego tokenu payloadu; reszta = komentarz.
  if (kind === "score" && !/^[1-5](\s|$)/.test(payload)) return undefined;
  return { kind, payload: payload || undefined };
}

export interface ParsedScore {
  value: number;
  comment?: string;
}

/** Payload komendy /score: "4 solidny plan" → { value: 4, comment: "solidny plan" }. */
export function parseScorePayload(payload: string | undefined): ParsedScore | undefined {
  const match = payload?.trim().match(/^([1-5])(?:\s+([\s\S]+))?$/);
  if (!match) return undefined;
  return { value: Number(match[1]), comment: match[2]?.trim() || undefined };
}

/** Podpowiedź wysyłana, gdy przy otwartej bramce przyjdzie komentarz bez sygnału. */
export function hintFor(
  gate: "plan-approval" | "clarify" | "ops-checklist",
  states: { approve?: string; answer?: string; done?: string }
): string {
  if (gate === "plan-approval") {
    return "ℹ️ To nie jest decyzja. Zatwierdź wyłącznie komendą `/approve` albo odrzuć: `/reject <powód>`.";
  }
  if (gate === "ops-checklist") {
    return "ℹ️ To nie jest potwierdzenie wykonania checklisty — użyj wyłącznie komendy `/done`.";
  }
  return "ℹ️ Odpowiedzi są wejściem dopiero po ścisłej komendzie `/answer <odpowiedzi>`.";
}
