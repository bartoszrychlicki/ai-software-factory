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
 *   co daje at-most-once resume bez czytania czegokolwiek z trackera.
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
  preMerge?: { mainSha: string; ok: boolean; at: string };
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
  return join(dirname(findUpFile("package.json")), "runs");
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
      autoRetry: { count: 0 },
    };
    // nowy run tego samego ticketu = czysty przebieg (bramki starych runów nie mogą zatruwać guardów)
    if (state.runId !== seed.runId) {
      state.runId = seed.runId;
      state.gates = {};
      state.phase = undefined;
      state.expectedState = undefined;
      state.phaseWrites = [];
      state.lifecycle = "running";
      state.finalized = undefined;
      state.prUrl = undefined;
      state.mergeHandledAt = undefined;
      state.files = undefined;
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

/** Znacznik etapu konsumpcji — daje at-most-once resume po restarcie. */
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
  return listAll().filter((s) => s.lifecycle !== "finalized");
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
    .map((s) => ({ ticketId: s.ticketId, files: (s.files ?? []).filter((f) => wanted.has(f)) }))
    .filter((c) => c.files.length > 0);
}
