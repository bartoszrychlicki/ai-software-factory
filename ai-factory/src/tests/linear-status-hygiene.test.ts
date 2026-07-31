import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LifecycleStore,
  type LifecycleRun,
  type TicketManifestV2,
} from "../pipeline/lifecycle-store";
import { LinearSource } from "../sources/linear";
import {
  applyDecision,
  claimStateName,
  dispatchOutbox,
  type PollerDependencies,
} from "../sources/poll-linear-v2";
import { LINEAR_STATE_MAP } from "../sources/state-map";

const manifest: TicketManifestV2 = {
  title: "Linear status hygiene",
  description: "Test zapisu stanów.",
  labels: [],
  inputHash: "status-hygiene",
};

function runAtBuild(): LifecycleRun {
  return {
    ticketId: "BAR-HYGIENE",
    project: "harness",
    generation: 1,
    stage: "build",
    status: "running",
    manifest,
    planFiles: ["src/a.ts"],
    clarifyRound: 0,
    critiqueRound: 0,
    fixRound: 0,
    createdAt: "2026-07-31T08:00:00.000Z",
    updatedAt: "2026-07-31T08:00:00.000Z",
  };
}

async function claimStateId(preferredStateName?: string): Promise<string> {
  const originalFetch = globalThis.fetch;
  let stateId = "";
  const issue = {
    id: "linear-uuid",
    identifier: "BAR-HYGIENE",
    title: "Linear status hygiene",
    description: "Test zapisu stanów.",
    url: "https://linear.test/BAR-HYGIENE",
    priorityLabel: null,
    labels: { nodes: [] },
    state: { id: "state-todo", name: "Todo", type: "unstarted" },
    team: {
      states: {
        nodes: [
          { id: "state-todo", name: "Todo", type: "unstarted" },
          { id: "state-progress", name: "In Progress", type: "started" },
          {
            id: "state-planning",
            name: LINEAR_STATE_MAP.phases.planning,
            type: "started",
          },
        ],
      },
    },
  };
  globalThis.fetch = (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: { input?: { stateId?: string } };
    };
    if (request.query.includes("query(")) {
      return {
        ok: true,
        json: async () => ({ data: { issue } }),
      } as Response;
    }
    stateId = request.variables?.input?.stateId ?? "";
    return {
      ok: true,
      json: async () => ({ data: { issueUpdate: { success: true } } }),
    } as Response;
  }) as typeof fetch;
  try {
    await new LinearSource("test-key", "harness").claim(
      "BAR-HYGIENE",
      preferredStateName
    );
    return stateId;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

interface HarnessComment {
  id: string;
  body: string;
  createdAt: string;
}

function linearHarness(initialState: string): {
  source: LinearSource;
  writes: string[];
} {
  let currentState = initialState;
  const writes: string[] = [];
  const comments: HarnessComment[] = [];
  const source = {
    async getStateName() {
      return currentState;
    },
    async setStateByName(_ticketId: string, state: string) {
      writes.push(state);
      currentState = state;
    },
    async listComments() {
      return comments;
    },
    async comment(_ticketId: string, body: string) {
      comments.push({
        id: `factory-${comments.length + 1}`,
        body,
        createdAt: new Date(Date.now() + comments.length).toISOString(),
      });
    },
  } as unknown as LinearSource;
  return { source, writes };
}

function depsFor(store: LifecycleStore, source: LinearSource): PollerDependencies {
  return {
    store,
    mastra: {} as PollerDependencies["mastra"],
    sources: new Map([["harness", source]]),
    extendedStatuses: new Set(["harness"]),
    notifier: async () => {},
  };
}

async function withHarness(
  prefix: string,
  run: (context: { store: LifecycleStore }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  try {
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(root)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    process.env.FACTORY_ROOT = root;
    await run({ store });
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function captureWarnings(
  run: (warnings: string[]) => Promise<void>
): Promise<void> {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await run(warnings);
  } finally {
    console.warn = originalWarn;
  }
}

test("claim w projekcie extended idzie wprost do Planowania", async () => {
  assert.equal(
    claimStateName(undefined, true),
    LINEAR_STATE_MAP.phases.planning
  );
  assert.equal(
    await claimStateId(LINEAR_STATE_MAP.phases.planning),
    "state-planning"
  );
});

test("re-claim runu w toku używa projekcji jego fazy", () => {
  assert.equal(claimStateName(runAtBuild(), true), LINEAR_STATE_MAP.phases.build);
});

test("projekt bez extended claimuje jak dotąd", async () => {
  assert.equal(claimStateName(runAtBuild(), false), undefined);
  assert.equal(await claimStateId(), "state-progress");
});

test("stara pending vs nowsza done — spóźniony zapis jest odrzucony", async () => {
  await withHarness("factory-status-superseded-", async ({ store }) => {
    const ticketId = "BAR-HYGIENE-SUPERSEDED";
    const linear = linearHarness(LINEAR_STATE_MAP.phases.review);
    store.createRun(ticketId, "harness", manifest);
    store.transition(ticketId, {
      stage: "review",
      status: "running",
      actor: "test",
      reason: "review-running",
      patch: { plan: "plan", planFiles: ["src/a.ts"], planDomain: "backend" },
    });
    const oldKey = `${ticketId}:g1:linear-status:1:old`;
    const newKey = `${ticketId}:g1:linear-status:2:new`;
    store.enqueue({
      key: oldKey,
      ticketId,
      kind: "linear-status",
      stage: "build",
      payload: { state: LINEAR_STATE_MAP.phases.build },
    });
    store.enqueue({
      key: newKey,
      ticketId,
      kind: "linear-status",
      stage: "review",
      payload: { state: LINEAR_STATE_MAP.phases.review },
    });
    store.markCommand(newKey, "done");

    await captureWarnings(async (warnings) => {
      await dispatchOutbox(depsFor(store, linear.source));

      assert.deepEqual(linear.writes, []);
      assert.deepEqual(
        [store.getCommand(oldKey)?.state, store.getCommand(oldKey)?.lastError],
        ["done", "superseded"]
      );
      assert.equal(store.getCommand(newKey)?.state, "done");
      assert.ok(warnings.some((warning) =>
        warning.includes("(superseded)") &&
        warning.includes(`bieżący "${LINEAR_STATE_MAP.phases.review}"`) &&
        warning.includes(`docelowy "${LINEAR_STATE_MAP.phases.build}"`)
      ));
    });
  });
});

test("dwie identyczne blokady w jednej generacji zapisują stan dwa razy", async () => {
  await withHarness("factory-status-repeat-", async ({ store }) => {
    const ticketId = "BAR-HYGIENE-REPEAT";
    const linear = linearHarness(LINEAR_STATE_MAP.phases.build);
    const deps = depsFor(store, linear.source);
    store.createRun(ticketId, "harness", manifest);
    store.transition(ticketId, {
      stage: "build",
      status: "running",
      actor: "test",
      reason: "build-running",
      patch: { plan: "plan", planFiles: ["src/a.ts"], planDomain: "backend" },
    });

    applyDecision(deps, ticketId, {
      transition: {
        stage: "build",
        status: "blocked",
        actor: "test",
        reason: "scope-blocked",
        patch: {
          blockedStage: "build",
          errorCode: "SCOPE_BLOCKED",
          errorMessage: "Poza zakresem.",
        },
      },
      commands: [],
    });
    const firstBlockedKey = store.outstandingCommands(100).find((command) =>
      command.kind === "linear-status" &&
      command.payload.state === LINEAR_STATE_MAP.phases.blocked
    )?.key;
    await dispatchOutbox(deps);

    applyDecision(deps, ticketId, {
      transition: {
        stage: "build",
        status: "running",
        actor: "test",
        reason: "scope-retry",
        patch: {
          blockedStage: undefined,
          errorCode: undefined,
          errorMessage: undefined,
        },
      },
      commands: [],
    });
    await dispatchOutbox(deps);

    applyDecision(deps, ticketId, {
      transition: {
        stage: "build",
        status: "blocked",
        actor: "test",
        reason: "scope-blocked",
        patch: {
          blockedStage: "build",
          errorCode: "SCOPE_BLOCKED",
          errorMessage: "Poza zakresem.",
        },
      },
      commands: [],
    });
    const secondBlockedKey = store.outstandingCommands(100).find((command) =>
      command.kind === "linear-status" &&
      command.payload.state === LINEAR_STATE_MAP.phases.blocked
    )?.key;
    await dispatchOutbox(deps);

    assert.ok(firstBlockedKey);
    assert.ok(secondBlockedKey);
    assert.notEqual(firstBlockedKey, secondBlockedKey);
    assert.equal(store.countCommands(ticketId, "linear-status"), 3);
    assert.equal(
      linear.writes.filter((state) => state === LINEAR_STATE_MAP.phases.blocked).length,
      2
    );
    assert.deepEqual(linear.writes, [
      LINEAR_STATE_MAP.phases.blocked,
      LINEAR_STATE_MAP.phases.build,
      LINEAR_STATE_MAP.phases.blocked,
    ]);
  });
});

test("pominięcie noop zapisuje powód i oba stany w logu", async () => {
  await withHarness("factory-status-noop-", async ({ store }) => {
    const ticketId = "BAR-HYGIENE-NOOP";
    const linear = linearHarness(LINEAR_STATE_MAP.phases.build);
    store.createRun(ticketId, "harness", manifest);
    store.transition(ticketId, {
      stage: "build",
      status: "running",
      actor: "test",
      reason: "build-running",
      patch: { plan: "plan", planFiles: ["src/a.ts"], planDomain: "backend" },
    });
    const key = `${ticketId}:g1:linear-status:1:noop`;
    store.enqueue({
      key,
      ticketId,
      kind: "linear-status",
      stage: "build",
      payload: { state: LINEAR_STATE_MAP.phases.build },
    });

    await captureWarnings(async (warnings) => {
      await dispatchOutbox(depsFor(store, linear.source));

      assert.deepEqual(linear.writes, []);
      assert.deepEqual(
        [store.getCommand(key)?.state, store.getCommand(key)?.lastError],
        ["done", "noop"]
      );
      assert.ok(warnings.some((warning) =>
        warning.includes("(noop)") &&
        warning.includes(`bieżący "${LINEAR_STATE_MAP.phases.build}"`) &&
        warning.includes(`docelowy "${LINEAR_STATE_MAP.phases.build}"`)
      ));
    });
  });
});
