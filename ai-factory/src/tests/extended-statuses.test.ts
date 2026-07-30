import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LifecycleStore,
  type LifecycleRun,
  type LifecycleStage,
  type LifecycleStatus,
  type TicketManifestV2,
} from "../pipeline/lifecycle-store";
import { reduceLifecycle, type CoordinatorDecision } from "../pipeline/coordinator";
import { runPreflight } from "../pipeline/preflight";
import { buildCommentContextSnapshot } from "../sources/comment-context";
import { LinearSource } from "../sources/linear";
import {
  extendedRequiredStateNames,
  extendedStatusName,
} from "../sources/state-map";
import {
  applyDecision,
  dispatchOutbox,
  reconcileRun,
  writeLinearState,
  type PollerDependencies,
} from "../sources/poll-linear-v2";

const manifest: TicketManifestV2 = {
  title: "Extended statuses",
  description: "Lifecycle projection",
  labels: [],
  inputHash: "hash-1",
};

function runAt(
  stage: LifecycleStage,
  status: LifecycleStatus,
  patch: Partial<LifecycleRun> = {}
): LifecycleRun {
  return {
    ticketId: "BAR-EXT",
    project: "demo",
    generation: 1,
    stage,
    status,
    manifest,
    planFiles: [],
    clarifyRound: 0,
    critiqueRound: 0,
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    ...patch,
  };
}

function depsFor(
  store: LifecycleStore,
  options: {
    extended?: boolean;
    source?: LinearSource;
  } = {}
): PollerDependencies {
  return {
    store,
    mastra: {} as PollerDependencies["mastra"],
    sources: options.source
      ? new Map([["demo", options.source]])
      : new Map(),
    extendedStatuses: options.extended ? new Set(["demo"]) : undefined,
    notifier: async () => {},
  };
}

function projectedStates(store: LifecycleStore, ticketId: string): string[] {
  return store.outstandingCommands(200)
    .filter((command) => command.ticketId === ticketId && command.kind === "linear-status")
    .map((command) => String(command.payload.state));
}

test("extendedStatusName mapuje wszystkie fazy lifecycle v2 i v3", () => {
  const cases: [LifecycleStage, string][] = [
    ["plan", "🧠 Planowanie"],
    ["triage", "🧠 Planowanie"],
    ["research", "🧠 Planowanie"],
    ["synthesis", "🧠 Planowanie"],
    ["critique", "🧠 Planowanie"],
    ["approval", "👤 🚦 Plan do akceptacji"],
    ["build", "🔨 Build"],
    ["test", "🧪 Weryfikacja"],
    ["publish", "🧪 Weryfikacja"],
    ["ci", "🧪 Weryfikacja"],
    ["review", "👀 Code review"],
    ["merge", "👤 ✅ PR do merge"],
    ["smoke", "🧪 Weryfikacja"],
  ];

  for (const [stage, expected] of cases) {
    assert.equal(extendedStatusName(runAt(stage, "running")), expected, stage);
  }
});

test("pełny cykl deep przechodzi przez rozszerzone kolumny aż do Done", () => {
  const cycle = [
    runAt("triage", "running"),
    runAt("research", "running"),
    runAt("approval", "waiting_human"),
    runAt("build", "running"),
    runAt("test", "pending"),
    runAt("publish", "waiting_external"),
    runAt("ci", "waiting_external"),
    runAt("review", "running"),
    runAt("merge", "waiting_human"),
    runAt("smoke", "done"),
  ];

  assert.deepEqual(cycle.map(extendedStatusName), [
    "🧠 Planowanie",
    "🧠 Planowanie",
    "👤 🚦 Plan do akceptacji",
    "🔨 Build",
    "🧪 Weryfikacja",
    "🧪 Weryfikacja",
    "🧪 Weryfikacja",
    "👀 Code review",
    "👤 ✅ PR do merge",
    "Done",
  ]);
});

test("pytania trafiają do autora, a /answer wraca do planowania", () => {
  const store = new LifecycleStore(":memory:");
  try {
    const deps = depsFor(store, { extended: true });
    store.createRun("BAR-Q1", "demo", manifest);
    let run = store.transition("BAR-Q1", {
      stage: "plan",
      status: "running",
      actor: "test",
      reason: "planner-started",
    });

    run = applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "job-finished",
      attempt: 1,
      output: {
        kind: "plan",
        outcome: "questions",
        report: "Potrzebuję odpowiedzi.",
        questions: "1. Który wariant?",
        signature: "ai-factory · fake · model · planner",
        durationMs: 1,
        files: [],
        changedFiles: [],
        scopeWarnings: [],
      },
    }));
    assert.equal(run.status, "waiting_human");
    assert.equal(projectedStates(store, run.ticketId).at(-1), "👤 ❓ Pytania do autora");

    run = applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "answer",
      commentId: "comment-answer",
      answer: "Wariant A",
      nextAttempt: 2,
    }));
    assert.equal(run.status, "running");
    assert.equal(projectedStates(store, run.ticketId).at(-1), "🧠 Planowanie");

    for (const stage of ["triage", "plan", "synthesis"] as const) {
      assert.equal(
        extendedStatusName(runAt(stage, "waiting_human")),
        "👤 ❓ Pytania do autora"
      );
    }
  } finally {
    store.close();
  }
});

test("projekt bez statuses: extended zachowuje prostą projekcję bez zmian", () => {
  const store = new LifecycleStore(":memory:");
  try {
    const deps = depsFor(store);
    const cases: {
      id: string;
      stage: LifecycleStage;
      status: LifecycleStatus;
      errorCode?: string;
      expected: string;
    }[] = [
      { id: "BAR-SIMPLE-1", stage: "plan", status: "running", expected: "In Progress" },
      { id: "BAR-SIMPLE-2", stage: "review", status: "running", expected: "In Review" },
      { id: "BAR-SIMPLE-3", stage: "build", status: "blocked", expected: "👤 ⛔ Zablokowany" },
      { id: "BAR-SIMPLE-4", stage: "smoke", status: "done", expected: "Done" },
      {
        id: "BAR-SIMPLE-5",
        stage: "build",
        status: "done",
        errorCode: "CANCELED",
        expected: "Canceled",
      },
    ];

    for (const item of cases) {
      store.createRun(item.id, "demo", manifest);
      store.transition(item.id, {
        stage: item.stage,
        status: item.status,
        actor: "test",
        reason: `prepare-${item.id}`,
        patch: { errorCode: item.errorCode },
      });
      const decision: CoordinatorDecision = {
        transition: {
          stage: item.stage,
          status: item.status,
          actor: "test",
          reason: `simple-${item.id}`,
        },
        commands: [],
      };
      applyDecision(deps, item.id, decision);
      assert.equal(projectedStates(store, item.id).at(-1), item.expected, item.id);
    }
  } finally {
    store.close();
  }
});

test("nieterminalny stan przyjmuje prostą i rozszerzoną projekcję", async () => {
  for (const extended of [false, true]) {
    const store = new LifecycleStore(":memory:");
    const ticketId = extended ? "BAR-WRITE-EXTENDED" : "BAR-WRITE-SIMPLE";
    const writes: string[] = [];
    let linearState = "Todo";
    const source = {
      async getStateName() { return linearState; },
      async setStateByName(_id: string, state: string) {
        writes.push(state);
        linearState = state;
      },
    } as unknown as LinearSource;
    try {
      const deps = depsFor(store, { extended, source });
      store.createRun(ticketId, "demo", manifest);
      store.transition(ticketId, {
        stage: "build",
        status: "running",
        actor: "test",
        reason: "prepare-build",
      });
      applyDecision(deps, ticketId, {
        transition: {
          stage: "build",
          status: "running",
          actor: "test",
          reason: "project-build-state",
        },
        commands: [],
      });
      for (const command of store.outstandingCommands(200)) {
        if (command.kind === "linear-comment") store.markCommand(command.key, "done");
      }

      await dispatchOutbox(deps);

      assert.deepEqual(writes, [extended ? "🔨 Build" : "In Progress"]);
    } finally {
      store.close();
    }
  }
});

test("claim używa projekcji projektu, a poller ma jeden korytarz zapisu", async () => {
  for (const extended of [false, true]) {
    const store = new LifecycleStore(":memory:");
    const claims: (string | undefined)[] = [];
    const writes: string[] = [];
    let linearState = "Todo";
    const source = {
      async getStateName() { return linearState; },
      async claim(_id: string, preferredStateName?: string) {
        claims.push(preferredStateName);
        linearState = preferredStateName ?? "In Progress";
      },
      async setStateByName(_id: string, state: string) {
        writes.push(state);
        linearState = state;
      },
    } as unknown as LinearSource;
    try {
      const deps = depsFor(store, { extended, source });
      const run = store.createRun(
        extended ? "BAR-CLAIM-EXTENDED" : "BAR-CLAIM-SIMPLE",
        "demo",
        manifest
      );
      const target = extended ? "🧠 Planowanie" : "In Progress";

      assert.equal(await writeLinearState(deps, run, target, undefined, true), "written");
      assert.deepEqual(claims, [extended ? "🧠 Planowanie" : undefined]);

      if (extended) {
        linearState = "Todo";
        assert.equal(await writeLinearState(deps, run, "🔨 Build"), "written");
        assert.deepEqual(writes, ["🔨 Build"]);
      }
    } finally {
      store.close();
    }
  }

  const sourceCode = await readFile(
    new URL("../sources/poll-linear-v2.ts", import.meta.url),
    "utf8"
  );
  const writerStart = sourceCode.indexOf("export async function writeLinearState(");
  const writerEnd = sourceCode.indexOf("\nasync function dispatchExternal", writerStart);
  assert.ok(writerStart >= 0 && writerEnd > writerStart);
  const outsideWriter = sourceCode.slice(0, writerStart) + sourceCode.slice(writerEnd);
  assert.doesNotMatch(outsideWriter, /\.setStateByName\(|\.claim\(/);
});

test("LinearSource.claim wybiera dokładny stan extended i zachowuje fallback prosty", async () => {
  const originalFetch = globalThis.fetch;
  const stateIds: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: { input?: { stateId?: string } };
    };
    if (request.query.includes("issueUpdate")) {
      stateIds.push(String(request.variables?.input?.stateId));
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }));
    }
    return new Response(JSON.stringify({
      data: {
        issue: {
          id: "issue-id",
          identifier: "BAR-CLAIM",
          title: "Claim",
          description: "",
          url: "https://linear.test/BAR-CLAIM",
          priorityLabel: null,
          labels: { nodes: [] },
          state: { id: "todo", name: "Todo", type: "unstarted" },
          team: {
            states: {
              nodes: [
                { id: "started-first", name: "Started", type: "started" },
                { id: "in-progress", name: "In Progress", type: "started" },
                { id: "planning", name: "🧠 Planowanie", type: "started" },
              ],
            },
          },
        },
      },
    }));
  }) as typeof fetch;

  try {
    const source = new LinearSource("test-key", "demo");
    await source.claim("BAR-CLAIM", "🧠 Planowanie");
    await source.claim("BAR-CLAIM");
    assert.deepEqual(stateIds, ["planning", "in-progress"]);
    await assert.rejects(source.claim("BAR-CLAIM", "Brakujący"), /Brak stanu "Brakujący"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ręczne przeciągnięcie do stanu fazy nie steruje lifecycle i jest nadpisywane", async () => {
  const store = new LifecycleStore(":memory:");
  const ticket = {
    id: "BAR-DRAG",
    title: "Manual drag",
    description: "Nie steruje fabryką",
    labels: [] as string[],
  };
  const inputHash = buildCommentContextSnapshot(
    ticket.id,
    ticket.title,
    ticket.description,
    []
  ).effectiveInputHash;
  const source = {
    async listComments() { return []; },
    async getTicket() {
      return {
        ...ticket,
        source: "linear",
        stateName: "🔨 Build",
        url: "https://linear.test/BAR-DRAG",
      };
    },
    async getStateName() { return "🔨 Build"; },
  } as unknown as LinearSource;

  try {
    const deps = depsFor(store, { extended: true, source });
    store.createRun(ticket.id, "demo", { ...ticket, inputHash });
    store.transition(ticket.id, {
      stage: "plan",
      status: "running",
      actor: "test",
      reason: "planner-running",
    });
    store.enqueue({
      key: `${ticket.id}:g1:job:plan:plan:a1`,
      ticketId: ticket.id,
      kind: "run-job",
      stage: "plan",
      payload: { kind: "plan", attempt: 1 },
    });
    const commandsBefore = store.outstandingCommands().length;

    await reconcileRun(deps, store.getRun(ticket.id)!);

    assert.deepEqual(
      [store.getRun(ticket.id)?.stage, store.getRun(ticket.id)?.status],
      ["plan", "running"]
    );
    assert.equal(store.outstandingCommands().length, commandsBefore);
    assert.deepEqual(projectedStates(store, ticket.id), []);

    applyDecision(deps, ticket.id, {
      transition: {
        stage: "plan",
        status: "running",
        actor: "coordinator",
        reason: "next-lifecycle-transition",
      },
      commands: [],
    });
    assert.equal(projectedStates(store, ticket.id).at(-1), "🧠 Planowanie");
  } finally {
    store.close();
  }
});

test("preflight fail-closed wymaga pełnego zestawu tylko dla statuses: extended", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-extended-preflight-"));
  const previousRoot = process.env.FACTORY_ROOT;
  process.env.FACTORY_ROOT = root;
  try {
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "projects.yaml"), [
      "extended:",
      `  repo: ${JSON.stringify(root)}`,
      "  statuses: extended",
      "  checks:",
      "    - \"true\"",
      "simple:",
      `  repo: ${JSON.stringify(root)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    await writeFile(join(root, "routing.yaml"), [
      "defaults:",
      "  plan: claude-code/sonnet",
      "  build: codex",
      "  review: claude-code/sonnet",
    ].join("\n"));

    const stateNames = [...new Set([
      "Todo",
      "In Progress",
      "In Review",
      ...extendedRequiredStateNames(),
    ])].filter((name) => name !== "👀 Code review");
    const dependencies = {
      async linearStateNames() { return stateNames; },
      async mastraUp() { return true; },
      async exec(file: string, args: readonly string[]) {
        if (file === "claude" && args[0] === "auth") {
          return { stdout: "{\"loggedIn\":true}", stderr: "" };
        }
        if (args[0] === "--version") {
          return { stdout: "cli 1.0.0\n", stderr: "" };
        }
        return { stdout: "/fake/bin\n", stderr: "" };
      },
    };

    const extended = await runPreflight("extended", dependencies);
    assert.equal(extended.ok, false);
    assert.ok(extended.errors.includes(
      "Linear: brak stanu \"👀 Code review\" wymaganego przez statuses: extended"
    ));

    const simple = await runPreflight("simple", dependencies);
    assert.equal(simple.ok, true, simple.errors.join(" | "));
  } finally {
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("ops po /approve pokazuje checklistę, przed akceptacją bramkę planu", () => {
  assert.equal(
    extendedStatusName(runAt("approval", "waiting_human", { planDomain: "ops" })),
    "👤 🚦 Plan do akceptacji"
  );
  assert.equal(
    extendedStatusName(runAt("approval", "waiting_human", {
      planDomain: "ops",
      approvedAt: "2026-07-29T10:00:00.000Z",
    })),
    "👤 🔧 Wykonaj checklistę"
  );
});

test("blocked i terminalne stany mają pierwszeństwo przed mapą faz", () => {
  assert.equal(
    extendedStatusName(runAt("review", "blocked")),
    "👤 ⛔ Zablokowany"
  );
  assert.equal(
    extendedStatusName(runAt("plan", "done")),
    "Done"
  );
  assert.equal(
    extendedStatusName(runAt("build", "blocked", { errorCode: "CANCELED" })),
    "Canceled"
  );
});
