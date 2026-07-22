import test from "node:test";
import assert from "node:assert/strict";
import { pickState } from "../sources/linear";
import { engineEnv } from "../engines/env";

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
