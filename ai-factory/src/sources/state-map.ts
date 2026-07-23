import type { FactoryPhase, Gate, DecisionKind } from "../pipeline/run-registry";

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
  /** Stany końcowe — fabryka ich NIE nadpisuje i nie czyta jako decyzji. */
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
