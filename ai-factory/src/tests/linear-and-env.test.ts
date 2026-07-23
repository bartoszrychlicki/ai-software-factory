import test from "node:test";
import assert from "node:assert/strict";
import { pickState } from "../sources/linear";
import { engineEnv } from "../engines/env";
import { parseCommand } from "../sources/commands";
import { decisionOfState, LINEAR_STATE_MAP, validateStateMap } from "../sources/state-map";

test("needs_clarification preferuje dokładnie Todo, nie pierwszy stan unstarted", () => {
  const states = [
    { id: "backlog", name: "Backlog", type: "unstarted" },
    { id: "todo", name: "Todo", type: "unstarted" },
  ];
  assert.equal(pickState(states, "unstarted", "Todo").id, "todo");
});

test("adapter silnika nie dziedziczy sekretów aplikacji", () => {
  const env = engineEnv({
    PATH: "/bin",
    HOME: "/tmp/fake-home",
    LINEAR_API_KEY: "secret",
    TURSO_AUTH_TOKEN: "secret",
    FACTORY_CB_USD_PER_H: "25",
    HTTPS_PROXY: "http://proxy",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HTTPS_PROXY, "http://proxy");
  assert.equal(env.LINEAR_API_KEY, undefined);
  assert.equal(env.TURSO_AUTH_TOKEN, undefined);
  assert.equal(env.FACTORY_CB_USD_PER_H, undefined);
});

test("bramka ops przyjmuje ruch do Weryfikacji i ścisłą komendę /done", () => {
  assert.equal(decisionOfState(LINEAR_STATE_MAP, "ops-checklist", "🧪 Weryfikacja"), "done");
  assert.deepEqual(parseCommand("/done"), { kind: "done", payload: undefined });
});

test("walidator mapy stanów fail-closed wykrywa brak stanu checklisty", () => {
  const complete = [
    LINEAR_STATE_MAP.ready,
    ...Object.values(LINEAR_STATE_MAP.phases),
    ...Object.values(LINEAR_STATE_MAP.decisions).flatMap((byDecision) =>
      Object.values(byDecision ?? {}).flatMap((states) => states ?? [])
    ),
  ];
  assert.deepEqual(validateStateMap(LINEAR_STATE_MAP, complete), []);
  assert.deepEqual(
    validateStateMap(LINEAR_STATE_MAP, complete.filter((name) => name !== "👤 🔧 Wykonaj checklistę")),
    ["👤 🔧 Wykonaj checklistę"]
  );
});
