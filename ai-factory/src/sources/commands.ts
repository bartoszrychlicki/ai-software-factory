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

export interface UnknownCommandContext {
  firstToken: string;
  stage: string;
  status: string;
  blockedStage?: string;
  planDomain?: string;
  approvedAt?: string;
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

/**
 * Wąska klasyfikacja próby komendy: pierwszy token musi wyglądać jak
 * `/slowo` lub `/slowo-zlozone`. Ścieżki (np. `/src/x.ts`) pozostają treścią.
 */
export function isCommandAttempt(body: string): boolean {
  const [firstToken = ""] = body.trim().split(/\s+/);
  return /^\/[a-z][a-z-]*$/i.test(firstToken);
}

/** Podpowiedź dla ścisłej, ale nierozpoznanej próby komendy. */
export function unknownCommandHint(input: UnknownCommandContext): string {
  const [firstToken = input.firstToken.trim()] = input.firstToken.trim().split(/\s+/);
  const prefix = `ℹ️ Nieznana komenda \`${firstToken}\`.`;

  if (input.status === "done") {
    return `${prefix} Dostępne teraz: \`/score 1-5 [komentarz]\`.`;
  }
  if (input.status === "blocked") {
    return `${prefix} Dostępne teraz: \`/retry\`, \`/replan <powód>\`.`;
  }
  if (
    input.stage === "approval" &&
    input.status === "waiting_human" &&
    input.planDomain === "ops" &&
    input.approvedAt
  ) {
    return `${prefix} Dostępne teraz: \`/done\`.`;
  }
  if (input.stage === "approval" && input.status === "waiting_human") {
    return `${prefix} Dostępne teraz: \`/approve\`, \`/reject <powód>\`.`;
  }
  if (
    (input.stage === "plan" || input.stage === "triage" || input.stage === "synthesis") &&
    input.status === "waiting_human"
  ) {
    return `${prefix} Dostępne teraz: \`/answer <odpowiedzi>\`.`;
  }
  return (
    `${prefix} Żadna komenda decyzyjna nie jest teraz otwarta; ` +
    "komentarz nie został potraktowany jako komenda."
  );
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
