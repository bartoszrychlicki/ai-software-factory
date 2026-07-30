import type { DecisionKind } from "../pipeline/run-registry";
import type { LifecycleRun } from "../pipeline/lifecycle-store";

export type OperatorCommandKind = "retry" | "replan" | "restart" | "score";
export type CommandKind = DecisionKind | OperatorCommandKind;

/**
 * Komendy jako JEDYNY tekstowy kanał decyzji — furtka z telefonu, gdy
 * przeciągnięcie karty jest niewygodne.
 *
 * To NIE jest rozpoznawanie języka naturalnego: liczy się wyłącznie pierwszy
 * token linii, dokładnie równy jednej z komend. Goła forma wymaga dodatkowo,
 * by komenda była ważna dla bieżącego stanu runu. Wszystko inne = brak decyzji
 * (dla gołej formy: zwykła treść), nigdy „chyba chodziło mu o…".
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

/** Gołe odpowiedniki COMMANDS; nadal dokładne tokeny, bez fuzzy matchingu. */
export const BARE_COMMANDS: Readonly<Record<string, CommandKind>> = Object.fromEntries(
  Object.entries(COMMANDS).map(([command, kind]) => [command.slice(1), kind])
) as Readonly<Record<string, CommandKind>>;

/** Pełny zbiór kindów do odtworzenia semantyki już wykonanej komendy. */
export const ALL_COMMAND_KINDS: ReadonlySet<CommandKind> = new Set(Object.values(COMMANDS));

export interface ParsedCommand {
  kind: CommandKind;
  /** Reszta komentarza po komendzie — DANE (powód, odpowiedzi), nie sterowanie. */
  payload?: string;
  form: "slash" | "bare";
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

function finalize(
  kind: CommandKind,
  first: string,
  trimmed: string,
  form: ParsedCommand["form"]
): ParsedCommand | undefined {
  const [, ...rest] = trimmed.split(/\s+/);
  const payload = rest.join(" ").trim() || trimmed.slice(first.length).trim();
  if (["reject", "answer", "replan"].includes(kind) && !payload) return undefined;
  if (kind === "restart" && form === "bare" && !payload) return undefined;
  if (["approve", "retry", "done"].includes(kind) && payload) return undefined;
  // score wymaga oceny 1-5 jako pierwszego tokenu payloadu; reszta = komentarz.
  if (kind === "score" && !/^[1-5](\s|$)/.test(payload)) return undefined;
  return { kind, payload: payload || undefined, form };
}

/**
 * Zwraca komendę tylko dla dokładnego dopasowania pierwszego tokenu.
 * Bez allowedBare zachowuje dotychczasową semantykę: rozpoznaje wyłącznie `/`.
 */
export function parseCommand(
  body: string,
  allowedBare?: ReadonlySet<CommandKind>
): ParsedCommand | undefined {
  const trimmed = body.trim();
  const [first = ""] = trimmed.split(/\s+/);
  if (trimmed.startsWith("/")) {
    const kind = COMMANDS[first.toLowerCase()];
    return kind ? finalize(kind, first, trimmed, "slash") : undefined;
  }
  if (!allowedBare?.size) return undefined;
  const kind = BARE_COMMANDS[first.toLowerCase()];
  if (!kind || !allowedBare.has(kind)) return undefined;
  return finalize(kind, first, trimmed, "bare");
}

/**
 * Gate-aware allowlista gołych komend. Coordinator zachowuje własne guardy
 * jako ostateczną obronę, ale poller nie dispatchuje gołego tokenu bez bramki.
 */
export function bareCommandsFor(
  run: Pick<
    LifecycleRun,
    "stage" | "status" | "planDomain" | "approvedAt" | "clarifyRound" | "blockedStage"
  >
): Set<CommandKind> {
  const allowed = new Set<CommandKind>();
  if (
    run.stage === "approval" &&
    run.status === "waiting_human" &&
    !run.approvedAt
  ) {
    allowed.add("approve");
    allowed.add("reject");
  }
  if (
    run.planDomain === "ops" &&
    run.stage === "approval" &&
    run.status === "waiting_human" &&
    !!run.approvedAt
  ) {
    allowed.add("done");
  }
  if (
    (run.stage === "plan" || run.stage === "triage" || run.stage === "synthesis") &&
    run.status === "waiting_human" &&
    run.clarifyRound >= 1 &&
    run.clarifyRound <= 2
  ) {
    allowed.add("answer");
  }
  if (run.status === "blocked" && !!run.blockedStage) allowed.add("retry");
  if (run.status !== "done") {
    allowed.add("replan");
    allowed.add("restart");
  }
  // Aktywny run trafia tu z reconcileRun, a done z listScoreCandidates.
  allowed.add("score");
  return allowed;
}

/**
 * Wąska klasyfikacja próby komendy: pierwszy token musi wyglądać jak
 * `/slowo`, `/slowo-zlozone` albo slash + słowo w backtickach (autoformat
 * Lineara). Ścieżki (np. `/src/x.ts`) pozostają treścią.
 */
export function isCommandAttempt(body: string): boolean {
  const [firstToken = ""] = body.trim().split(/\s+/);
  return /^\/(?:[a-z][a-z-]*|`[a-z][a-z-]*`)$/i.test(firstToken);
}

/** Podpowiedź dla ścisłej, ale nierozpoznanej próby komendy. */
export function unknownCommandHint(input: UnknownCommandContext): string {
  const [firstToken = input.firstToken.trim()] = input.firstToken.trim().split(/\s+/);
  const formattedToken = firstToken.includes("`")
    ? `\`\` ${firstToken} \`\``
    : `\`${firstToken}\``;
  const prefix = `ℹ️ Nieznana komenda ${formattedToken}.`;

  if (input.status === "done") {
    return `${prefix} Dostępne teraz: \`score 1-5 [komentarz]\` (albo \`/score 1-5 [komentarz]\`).`;
  }
  if (input.status === "blocked") {
    return `${prefix} Dostępne teraz: \`retry\` (albo \`/retry\`), \`replan <powód>\` (albo \`/replan <powód>\`).`;
  }
  if (
    input.stage === "approval" &&
    input.status === "waiting_human" &&
    input.planDomain === "ops" &&
    input.approvedAt
  ) {
    return `${prefix} Dostępne teraz: \`done\` (albo \`/done\`).`;
  }
  if (input.stage === "approval" && input.status === "waiting_human") {
    return `${prefix} Dostępne teraz: \`approve\` (albo \`/approve\`), \`reject <powód>\` (albo \`/reject <powód>\`).`;
  }
  if (
    (input.stage === "plan" || input.stage === "triage" || input.stage === "synthesis") &&
    input.status === "waiting_human"
  ) {
    return `${prefix} Dostępne teraz: \`answer <odpowiedzi>\` (albo \`/answer <odpowiedzi>\`).`;
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
