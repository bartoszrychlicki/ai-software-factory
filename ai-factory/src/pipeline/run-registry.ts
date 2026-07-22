import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { findUpFile } from "./projects";

/**
 * Rejestr runów: TRWAŁY stan fabryki per ticket.
 *
 * Zastępuje odtwarzanie stanu z własnych komentarzy w trackerze (runId z tekstu,
 * "Aprobata przyjęta", "[auto-retry]", URL PR regexem...) — źródło całej klasy
 * bugów nocnej zmiany 2026-07-22 (BAR-104: 2h bez opiekuna, dublet egzekucji).
 *
 * Zasady:
 * - jeden plik per ticket (zero kontencji przy równoległych ticketach),
 * - zapis atomowy (tmp → fsync → rename) + kopia .bak (uszkodzony JSON nie kasuje stanu),
 * - znaczniki decyzji są MONOTONICZNE (observed → consumed → resumeSent → resumeAcked),
 * - start/resume przechodzą przez trwały outbox; odpowiedź HTTP Mastry jest
 *   potwierdzeniem przyjęcia, a snapshot potwierdzeniem postępu wykonania.
 */

export type FactoryPhase =
  | "planning"
  | "questions"
  | "plan-approval"
  | "build"
  | "verify"
  | "review"
  | "pr-ready"
  | "blocked";

export type Gate = "claim" | "plan-approval" | "clarify";
export type DecisionKind = "start" | "approve" | "reject" | "answer";
export type OutboxCommandKind = "start" | "resume";

export interface OutboxCommand {
  id: string;
  kind: OutboxCommandKind;
  state: "pending" | "dispatched" | "acknowledged";
  body: Record<string, unknown>;
  /** Docelowa ścieżka suspendu; służy do potwierdzenia, że snapshot ruszył dalej. */
  step?: string | string[];
  gate?: Gate;
  round?: number;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string;
  acknowledgedAt?: string;
  lastError?: string;
}

export interface GateRecord {
  kind: Gate;
  round: number;
  openedAt: string;
  /** Stan trackera w chwili otwarcia bramki — odchylenie = ruch człowieka. */
  expectedState?: string;
  decision?: {
    kind: DecisionKind;
    payload?: string;
    via: "state" | "command";
    observedAt: string;
    consumedAt?: string;
    resumeSentAt?: string;
    resumeAckedAt?: string;
  };
}

export interface TicketState {
  v: 1;
  ticketId: string;
  project: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
  lifecycle: "running" | "awaiting_decision" | "finalized";
  phase?: FactoryPhase;
  /** Ostatni stan zapisany przez fabrykę — baza atrybucji „kto ruszył kartę". */
  expectedState?: string;
  /** Ostatnie zapisy faz (do okna tłumienia, gdy tracker nie daje atrybucji autora). */
  phaseWrites: { phase: FactoryPhase; state?: string; at: string }[];
  gates: Record<string, GateRecord>;
  /** Trwały outbox komend do Mastry. Brak odpowiedzi HTTP nigdy nie gubi start/resume. */
  outbox: Record<string, OutboxCommand>;
  /** Parametry zlecenia z labeli — czytane RAZ przy claimie, potem niezmienne. */
  manifest?: { labels: string[]; engine?: string; domain?: string; planMode?: string };
  autoRetry: { count: number; lastAt?: string };
  /**
   * Pliki zadeklarowane przez plannera (BAR-141). Ticket „trzyma" je od aprobaty
   * planu do merge'a PR-a — w tym oknie żaden inny ticket nie rusza tych plików.
   */
  files?: string[];
  prUrl?: string;
  /** Ostatni pre-merge re-verify (BAR-124) — raz na przesunięcie maina, nie co tick. */
  preMerge?: { mainSha: string; headSha: string; ok: boolean; at: string };
  mergeHandledAt?: string;
  prodSmokeAt?: string;
  finalized?: {
    outcome: "success" | "blocked" | "failed" | "rejected" | "orphan";
    /** Klasyfikacja przyczyny — decyduje o reuse planu i o serii bezpiecznika. */
    reason?: FailureReason;
    at: string;
  };
}

function runsRoot(): string {
  return process.env.FACTORY_RUNS_ROOT ?? join(dirname(findUpFile("package.json")), "runs");
}

function statePath(ticketId: string): string {
  return join(runsRoot(), ticketId, "state.json");
}

export const gateId = (gate: Gate, round: number) => `${gate}:${round}`;

/** Odczyt; przy uszkodzonym pliku sięga po .bak, nigdy nie rzuca. */
export function readState(ticketId: string): TicketState | undefined {
  for (const p of [statePath(ticketId), `${statePath(ticketId)}.bak`]) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as TicketState;
      if (parsed?.v === 1 && parsed.ticketId) return parsed;
    } catch {
      /* następny kandydat */
    }
  }
  return undefined;
}

/** Zapis atomowy: kopia poprzedniej wersji → tmp → fsync → rename. */
function writeState(state: TicketState): void {
  const p = statePath(state.ticketId);
  mkdirSync(dirname(p), { recursive: true });
  if (existsSync(p)) {
    try {
      writeFileSync(`${p}.bak`, readFileSync(p));
    } catch {
      /* kopia jest opcjonalna */
    }
  }
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, p);
}

/**
 * Czyta stan, przepuszcza przez mutator i zapisuje. Zwraca zapisany stan.
 * Awaria zapisu NIGDY nie wywala pollera — logujemy i jedziemy dalej.
 */
export function updateState(
  ticketId: string,
  seed: { project: string; runId: string },
  mutate: (s: TicketState) => void
): TicketState | undefined {
  try {
    const now = new Date().toISOString();
    const state: TicketState = readState(ticketId) ?? {
      v: 1,
      ticketId,
      project: seed.project,
      runId: seed.runId,
      createdAt: now,
      updatedAt: now,
      lifecycle: "running",
      phaseWrites: [],
      gates: {},
      outbox: {},
      autoRetry: { count: 0 },
    };
    state.outbox ??= {};
    state.autoRetry ??= { count: 0 };
    // nowy run tego samego ticketu = czysty przebieg (bramki starych runów nie mogą zatruwać guardów)
    if (state.runId !== seed.runId) {
      state.runId = seed.runId;
      state.gates = {};
      state.outbox = {};
      state.phase = undefined;
      state.expectedState = undefined;
      state.phaseWrites = [];
      state.lifecycle = "running";
      state.finalized = undefined;
      state.prUrl = undefined;
      state.mergeHandledAt = undefined;
      state.files = undefined;
      state.preMerge = undefined;
      state.prodSmokeAt = undefined;
      state.createdAt = now;
    }
    mutate(state);
    state.updatedAt = now;
    state.phaseWrites = state.phaseWrites.slice(-20);
    writeState(state);
    return state;
  } catch (err) {
    console.error(`[${ticketId}] rejestr runów — zapis nieudany:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Dodaje komendę idempotentnie. Ten sam identyfikator nigdy nie tworzy drugiego side-effectu. */
export function enqueueOutbox(
  ticketId: string,
  seed: { project: string; runId: string },
  command: Pick<OutboxCommand, "id" | "kind" | "body" | "step" | "gate" | "round">
): OutboxCommand | undefined {
  let saved: OutboxCommand | undefined;
  updateState(ticketId, seed, (s) => {
    const now = new Date().toISOString();
    s.outbox ??= {};
    saved = s.outbox[command.id] ?? {
      ...command,
      state: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    s.outbox[command.id] = saved;
  });
  return saved;
}

export function markOutboxAttempt(
  ticketId: string,
  seed: { project: string; runId: string },
  commandId: string,
  result: { dispatched: boolean; error?: string }
): void {
  updateState(ticketId, seed, (s) => {
    const command = s.outbox?.[commandId];
    if (!command || command.state === "acknowledged") return;
    command.attempts += 1;
    command.updatedAt = new Date().toISOString();
    command.lastError = result.error;
    if (result.dispatched) {
      command.state = "dispatched";
      command.dispatchedAt = command.updatedAt;
    }
  });
}

export function acknowledgeOutbox(
  ticketId: string,
  seed: { project: string; runId: string },
  commandId: string
): void {
  updateState(ticketId, seed, (s) => {
    const command = s.outbox?.[commandId];
    if (!command) return;
    command.state = "acknowledged";
    command.acknowledgedAt = new Date().toISOString();
    command.updatedAt = command.acknowledgedAt;
    command.lastError = undefined;
  });
}

export function pendingOutbox(ticketId: string): OutboxCommand[] {
  return Object.values(readState(ticketId)?.outbox ?? {}).filter((command) => command.state === "pending");
}

export function recordPhase(
  ticketId: string,
  seed: { project: string; runId: string },
  phase: FactoryPhase,
  state?: string
): void {
  updateState(ticketId, seed, (s) => {
    s.phase = phase;
    if (state) s.expectedState = state;
    s.phaseWrites.push({ phase, state, at: new Date().toISOString() });
  });
}

export function openGateRecord(
  ticketId: string,
  seed: { project: string; runId: string },
  gate: Gate,
  round: number,
  expectedState?: string
): void {
  updateState(ticketId, seed, (s) => {
    const id = gateId(gate, round);
    if (!s.gates[id]) {
      s.gates[id] = { kind: gate, round, openedAt: new Date().toISOString(), expectedState };
    }
    s.lifecycle = "awaiting_decision";
  });
}

export function recordDecision(
  ticketId: string,
  seed: { project: string; runId: string },
  gate: Gate,
  round: number,
  decision: NonNullable<GateRecord["decision"]>
): void {
  updateState(ticketId, seed, (s) => {
    const id = gateId(gate, round);
    const rec = s.gates[id] ?? { kind: gate, round, openedAt: decision.observedAt };
    rec.decision = { ...rec.decision, ...decision };
    s.gates[id] = rec;
    s.lifecycle = "running";
  });
}

/** Znacznik etapu konsumpcji decyzji i dostarczenia komendy przez trwały outbox. */
export function markDecisionStep(
  ticketId: string,
  seed: { project: string; runId: string },
  gate: Gate,
  round: number,
  step: "consumedAt" | "resumeSentAt" | "resumeAckedAt"
): void {
  updateState(ticketId, seed, (s) => {
    const rec = s.gates[gateId(gate, round)];
    if (rec?.decision && !rec.decision[step]) rec.decision[step] = new Date().toISOString();
  });
}

/**
 * Przyczyny porażki runa. Klasyfikowane RAZ, przy finalizacji, z komunikatu
 * rzuconego przez NASZ pipeline (protokół wewnętrzny, nie swobodny tekst).
 * - plan-gate: bramka planu (ticket zrobiony / pytania) — tanie i pożądane,
 *   nie nabija serii bezpiecznika i NIE unieważnia zatwierdzonego planu,
 * - verify: merytoryczna porażka po próbach — plan wymaga przemyślenia,
 * - budget / infra: nic nie mówi o jakości planu — reuse jak najbardziej,
 * - rejected: decyzja człowieka.
 */
export type FailureReason = "plan-gate" | "verify" | "budget" | "infra" | "rejected";

export function classifyFailure(message: string): FailureReason {
  if (/odrzucony przez człowieka|Plan odrzucony/i.test(message)) return "rejected";
  if (/budżet ticketu wyczerpany/i.test(message)) return "budget";
  if (/plan bez werdyktu ok|nie oddał bloku|niejasności blokujące|Pytania do autora|JUŻ ISTNIEJE|już istnieje/i.test(message)) return "plan-gate";
  if (/BLOCKED po \d+\/\d+ próbach|konflikt semantyczny|konflikt z /i.test(message)) return "verify";
  return "infra";
}

export function finalize(
  ticketId: string,
  seed: { project: string; runId: string },
  outcome: NonNullable<TicketState["finalized"]>["outcome"],
  reason?: FailureReason
): void {
  updateState(ticketId, seed, (s) => {
    s.lifecycle = "finalized";
    s.finalized = { outcome, reason, at: new Date().toISOString() };
  });
}

function listAll(): TicketState[] {
  try {
    return readdirSync(runsRoot())
      .map((t) => readState(t))
      .filter((s): s is TicketState => !!s);
  } catch {
    return [];
  }
}

/** Tickety z niedokończonym runem — podstawa adopcji sierot po restarcie. */
export function listUnfinished(): TicketState[] {
  // mergeHandledAt jest dodatkowym terminalnym bezpiecznikiem dla rekordów
  // historycznych utworzonych dopiero przez merge-watchera (bez runu Mastry).
  return listAll().filter((s) => s.lifecycle !== "finalized" && !s.mergeHandledAt);
}

/** Atomowo domyka stan po decyzji człowieka o PR, także dla ticketu sprzed rejestru runów. */
export function recordMergeHandled(
  ticketId: string,
  seed: { project: string; runId: string },
  outcome: "merged" | "closed"
): void {
  updateState(ticketId, seed, (s) => {
    const at = new Date().toISOString();
    s.mergeHandledAt = at;
    s.lifecycle = "finalized";
    s.finalized = outcome === "merged"
      ? { outcome: "success", at }
      : { outcome: "failed", reason: "infra", at };
  });
}

/** Ścieżka porównywalna: bez `./`, bez wiodącego `/`, bez ogona `/`. */
export const normalizePath = (p: string): string => p.trim().replace(/^\.?\//, "").replace(/\/+$/, "");

export function recordFiles(ticketId: string, seed: { project: string; runId: string }, files: string[]): void {
  const clean = [...new Set(files.map(normalizePath).filter(Boolean))].slice(0, 200);
  if (clean.length) updateState(ticketId, seed, (s) => void (s.files = clean));
}

/**
 * Okno trzymania plików: od aprobaty planu do domknięcia PR-a. Zwolnienie:
 * merge/zamknięcie PR-a (`mergeHandledAt`) albo finał bez PR-a (blocked/failed).
 * Twardy limit wieku chroni przed wiecznym blokowaniem przez zapomniany stan.
 */
const HOLD_MAX_MS = 24 * 3600_000;

function holdsFiles(s: TicketState): boolean {
  if (!s.files?.length || s.mergeHandledAt) return false;
  if (s.finalized && s.finalized.outcome !== "success") return false;
  return Date.now() - Date.parse(s.updatedAt) < HOLD_MAX_MS;
}

/**
 * Kolizje plikowe (BAR-141): pliki, o które nowy ticket zahacza o inny aktywny run.
 * Serializacja zamiast równoległych PR-ów na tym samym pliku — źródło 6 konfliktów
 * i jednego konfliktu semantycznego z nocnej zmiany 2026-07-22.
 */
export function fileCollisions(ticketId: string, files: string[]): { ticketId: string; files: string[] }[] {
  const wanted = new Set(files.map(normalizePath).filter(Boolean));
  if (!wanted.size) return [];
  return listAll()
    .filter((s) => s.ticketId !== ticketId && holdsFiles(s))
    .map((s) => {
      const held = s.files ?? [];
      const wildcard = wanted.has("*") || held.includes("*");
      return {
        ticketId: s.ticketId,
        files: wildcard ? ["*"] : held.filter((f) => wanted.has(f)),
      };
    })
    .filter((c) => c.files.length > 0);
}
