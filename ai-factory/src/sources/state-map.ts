import type { FactoryPhase, Gate, DecisionKind } from "../pipeline/run-registry";
import type { LifecycleStage } from "../pipeline/lifecycle-store";

/**
 * Deklaratywna mapa: fazy fabryki i decyzje człowieka ↔ prymitywy trackera.
 *
 * Rdzeń mówi wyłącznie o fazach ("build") i bramkach ("plan-approval"); nazwy
 * stanów żyją TU. Adapter Jiry/GitHuba wypełnia te same klucze swoimi nazwami,
 * więc zmiana trackera nie dotyka pipeline'u ani pollera.
 *
 * Konwencja: stany zaczynające się od 👤 = piłka po stronie człowieka.
 */
export interface StateMap {
  /** Stan, w którym człowiek oddaje ticket fabryce (trigger claimu). */
  ready: string;
  phases: Record<FactoryPhase, string>;
  /**
   * Stany końcowe — fabryka ich NIGDY nie nadpisuje. Wyjątkiem jest własne
   * przejście fabryki ze stanu nieterminalnego do terminalnego.
   */
  terminal: string[];
  /** Przejście do jednego z tych stanów = decyzja człowieka na danej bramce. */
  decisions: Partial<Record<Gate, Partial<Record<DecisionKind, string[]>>>>;
  /** Whitelist prefiksów labeli-parametrów (czytane RAZ przy claimie). */
  labelParams: Record<string, string>;
}

export const LINEAR_STATE_MAP: StateMap = {
  ready: "Todo",
  phases: {
    planning: "🧠 Planowanie",
    questions: "👤 ❓ Pytania do autora",
    "plan-approval": "👤 🚦 Plan do akceptacji",
    "ops-checklist": "👤 🔧 Wykonaj checklistę",
    build: "🔨 Build",
    verify: "🧪 Weryfikacja",
    review: "👀 Code review",
    "pr-ready": "👤 ✅ PR do merge",
    blocked: "👤 ⛔ Zablokowany",
  },
  terminal: ["Done", "Canceled", "Duplicate"],
  decisions: {
    "plan-approval": {
      approve: ["🔨 Build"],
      reject: ["Backlog", "Canceled", "👤 ⛔ Zablokowany"],
    },
    clarify: {
      answer: ["🧠 Planowanie"],
    },
    "ops-checklist": {
      done: ["🧪 Weryfikacja"],
    },
  },
  labelParams: { engine: "engine:", domain: "domain:", planMode: "plan:" },
};

/** Czy stan jest końcową decyzją człowieka, której fabryka nie może nadpisać. */
export function isTerminalState(map: StateMap, stateName: string): boolean {
  return map.terminal.includes(stateName);
}

export interface ExtendedStatusRun {
  stage: LifecycleStage;
  status: string;
  errorCode?: string;
  planDomain?: string;
  approvedAt?: string;
}

const EXTENDED_STAGE_STATUS: Record<LifecycleStage, string> = {
  triage: LINEAR_STATE_MAP.phases.planning,
  research: LINEAR_STATE_MAP.phases.planning,
  synthesis: LINEAR_STATE_MAP.phases.planning,
  critique: LINEAR_STATE_MAP.phases.planning,
  plan: LINEAR_STATE_MAP.phases.planning,
  approval: LINEAR_STATE_MAP.phases["plan-approval"],
  build: LINEAR_STATE_MAP.phases.build,
  test: LINEAR_STATE_MAP.phases.verify,
  publish: LINEAR_STATE_MAP.phases.verify,
  ci: LINEAR_STATE_MAP.phases.verify,
  review: LINEAR_STATE_MAP.phases.review,
  merge: LINEAR_STATE_MAP.phases["pr-ready"],
  smoke: LINEAR_STATE_MAP.phases.verify,
};

const CLARIFY_STAGES = new Set<LifecycleStage>(["triage", "plan", "synthesis"]);

/** Projekcja durable lifecycle v2/v3 na rozszerzone kolumny tablicy Linear. */
export function extendedStatusName(run: ExtendedStatusRun): string {
  if (run.errorCode === "CANCELED") return "Canceled";
  if (run.status === "blocked") return LINEAR_STATE_MAP.phases.blocked;
  if (run.status === "done") return "Done";
  if (run.status === "waiting_human" && CLARIFY_STAGES.has(run.stage)) {
    return LINEAR_STATE_MAP.phases.questions;
  }
  if (
    run.stage === "approval" &&
    run.status === "waiting_human" &&
    run.planDomain === "ops" &&
    run.approvedAt
  ) {
    return LINEAR_STATE_MAP.phases["ops-checklist"];
  }
  return EXTENDED_STAGE_STATUS[run.stage];
}

/** Wszystkie stany, których może użyć projekcja `statuses: extended`. */
export function extendedRequiredStateNames(): string[] {
  return [...new Set([
    "Canceled",
    LINEAR_STATE_MAP.phases.blocked,
    "Done",
    LINEAR_STATE_MAP.phases.questions,
    LINEAR_STATE_MAP.phases["ops-checklist"],
    ...Object.values(EXTENDED_STAGE_STATUS),
  ])];
}

/** Faza odpowiadająca nazwie stanu (odwrotność phases) — do zapisu w rejestrze. */
export function phaseOfState(map: StateMap, stateName: string): FactoryPhase | undefined {
  return (Object.entries(map.phases) as [FactoryPhase, string][]).find(([, n]) => n === stateName)?.[0];
}

/** Decyzja wynikająca z przejścia do danego stanu na danej bramce (null = brak decyzji). */
export function decisionOfState(map: StateMap, gate: Gate, stateName: string): DecisionKind | undefined {
  const forGate = map.decisions[gate];
  if (!forGate) return undefined;
  return (Object.entries(forGate) as [DecisionKind, string[]][])
    .find(([, states]) => states.includes(stateName))?.[0];
}

/** Wszystkie nazwy stanów, od których zależy sterowanie fabryką, muszą istnieć w trackerze. */
export function validateStateMap(map: StateMap, existingStateNames: string[]): string[] {
  const existing = new Set(existingStateNames);
  const required = new Set([
    map.ready,
    ...Object.values(map.phases),
    ...Object.values(map.decisions).flatMap((byDecision) =>
      Object.values(byDecision ?? {}).flatMap((states) => states ?? [])
    ),
  ]);
  return [...required].filter((stateName) => !existing.has(stateName));
}
