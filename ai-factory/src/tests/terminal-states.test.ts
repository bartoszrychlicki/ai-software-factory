import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LifecycleStore,
  type LifecycleRun,
  type TicketManifestV2,
} from "../pipeline/lifecycle-store";
import { buildCommentContextSnapshot } from "../sources/comment-context";
import type { LinearSource } from "../sources/linear";
import {
  applyDecision,
  dispatchOutbox,
  reconcileRun,
  type PollerDependencies,
} from "../sources/poll-linear-v2";
import { extendedStatusName, LINEAR_STATE_MAP } from "../sources/state-map";

interface HarnessTicket {
  id: string;
  title: string;
  description: string;
  labels: string[];
}

interface HarnessComment {
  id: string;
  body: string;
  createdAt: string;
}

const ticket = (id: string): HarnessTicket => ({
  id,
  title: `Terminal state ${id}`,
  description: "Test ochrony decyzji człowieka.",
  labels: [],
});

function manifestFor(item: HarnessTicket): TicketManifestV2 {
  return {
    title: item.title,
    description: item.description,
    labels: item.labels,
    inputHash: buildCommentContextSnapshot(
      item.id,
      item.title,
      item.description,
      []
    ).effectiveInputHash,
  };
}

function linearHarness(
  item: HarnessTicket,
  initialState: string,
  initialComments: HarnessComment[] = []
): {
  source: LinearSource;
  writes: string[];
  comments: HarnessComment[];
  setState: (state: string) => void;
  getTicketCalls: () => number;
} {
  let currentState = initialState;
  let ticketReads = 0;
  const writes: string[] = [];
  const comments = [...initialComments];
  const source = {
    async listComments() {
      return comments;
    },
    async getTicket() {
      ticketReads += 1;
      return {
        ...item,
        source: "linear",
        stateName: currentState,
        url: `https://linear.test/${item.id}`,
      };
    },
    async getStateName() {
      return currentState;
    },
    async setStateByName(_ticketId: string, state: string) {
      writes.push(state);
      currentState = state;
    },
    async comment(_ticketId: string, body: string) {
      comments.push({
        id: `factory-${comments.length + 1}`,
        body,
        createdAt: new Date(Date.now() + comments.length).toISOString(),
      });
    },
  } as unknown as LinearSource;
  return {
    source,
    writes,
    comments,
    setState: (state: string) => {
      currentState = state;
    },
    getTicketCalls: () => ticketReads,
  };
}

function depsFor(
  store: LifecycleStore,
  source: LinearSource,
  options: { extended?: boolean } = {}
): PollerDependencies {
  return {
    store,
    mastra: {
      async cancelRun() {},
    } as unknown as PollerDependencies["mastra"],
    sources: new Map([["harness", source]]),
    extendedStatuses: options.extended ? new Set(["harness"]) : undefined,
    notifier: async () => {},
  };
}

async function withHarness(
  prefix: string,
  run: (context: { root: string; store: LifecycleStore }) => Promise<void>
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
    await run({ root, store });
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("aktywny run kończy się po Canceled bez nadpisania stanu człowieka", async () => {
  await withHarness("factory-terminal-canceled-", async ({ store }) => {
    const item = ticket("BAR-TERM-1");
    const linear = linearHarness(item, "Canceled");
    store.createRun(item.id, "harness", manifestFor(item));
    store.transition(item.id, {
      stage: "approval",
      status: "waiting_human",
      actor: "test",
      reason: "plan-ready",
      patch: { plan: "plan", planFiles: ["src/a.ts"], planDomain: "backend" },
    });
    const deps = depsFor(store, linear.source);

    await reconcileRun(deps, store.getRun(item.id)!);
    await dispatchOutbox(deps);

    assert.deepEqual(
      [store.getRun(item.id)?.status, store.getRun(item.id)?.errorCode],
      ["done", "CANCELED"]
    );
    assert.deepEqual(linear.writes, []);
  });
});

test("zablokowany run z zamkniętym PR-em kończy się po Canceled i zwalnia slot", async () => {
  await withHarness("factory-terminal-incident-", async ({ store }) => {
    const item = ticket("BAR-TERM-2");
    const linear = linearHarness(item, "Canceled");
    store.createRun(item.id, "harness", manifestFor(item));
    store.transition(item.id, {
      stage: "review",
      status: "blocked",
      actor: "test",
      reason: "review-failed",
      patch: {
        plan: "plan",
        planFiles: ["src/a.ts"],
        planDomain: "backend",
        prUrl: "https://github.test/o/r/pull/closed",
        headSha: "a".repeat(40),
        blockedStage: "review",
        errorCode: "REVIEW_FAILED",
        errorMessage: "PR jest już zamknięty.",
      },
    });
    const staleStatusKey = `${item.id}:g1:linear-status:stale-blocked`;
    store.enqueue({
      key: staleStatusKey,
      ticketId: item.id,
      kind: "linear-status",
      stage: "review",
      payload: { state: "👤 ⛔ Zablokowany" },
    });
    const deps = depsFor(store, linear.source);

    await reconcileRun(deps, store.getRun(item.id)!);
    const blockingCommands = store.outstandingCommands(100).filter((command) =>
      command.ticketId === item.id &&
      command.kind === "linear-status" &&
      command.payload.state === "👤 ⛔ Zablokowany"
    );
    assert.deepEqual(blockingCommands.map((command) => command.key), [staleStatusKey]);
    assert.equal(linear.getTicketCalls(), 0, "Canceled musi zostać obsłużony przed detectInputChange");
    await dispatchOutbox(deps);

    assert.deepEqual(
      [store.getRun(item.id)?.status, store.getRun(item.id)?.errorCode],
      ["done", "CANCELED"]
    );
    assert.equal(store.listActive().some((run) => run.ticketId === item.id), false);
    assert.deepEqual(linear.writes, []);
    assert.equal(store.getCommand(staleStatusKey)?.state, "done");
    assert.equal(
      store.outstandingCommands(100).some((command) =>
        command.ticketId === item.id &&
        command.kind === "linear-status" &&
        command.payload.state === "👤 ⛔ Zablokowany"
      ),
      false
    );

    const commandCount = store.outstandingCommands(100).length;
    await reconcileRun(deps, store.getRun(item.id)!);
    assert.equal(store.outstandingCommands(100).length, commandCount);
  });
});

test("Duplicate kończy run tak samo jak Canceled", async () => {
  await withHarness("factory-terminal-duplicate-", async ({ store }) => {
    const item = ticket("BAR-TERM-3");
    const linear = linearHarness(item, "Duplicate");
    store.createRun(item.id, "harness", manifestFor(item));
    store.transition(item.id, {
      stage: "build",
      status: "running",
      actor: "test",
      reason: "build-running",
      patch: { plan: "plan", planFiles: ["src/a.ts"], planDomain: "backend" },
    });
    const deps = depsFor(store, linear.source);

    await reconcileRun(deps, store.getRun(item.id)!);
    await dispatchOutbox(deps);

    assert.deepEqual(
      [store.getRun(item.id)?.status, store.getRun(item.id)?.errorCode],
      ["done", "CANCELED"]
    );
    assert.deepEqual(linear.writes, []);
  });
});

test("Done przed merge zachowuje PREMATURE_DONE i nie nadpisuje Linear", async () => {
  await withHarness("factory-terminal-done-", async ({ root, store }) => {
    const previousPath = process.env.PATH;
    const bin = join(root, "bin");
    const gh = join(bin, "gh");
    try {
      await mkdir(bin);
      await writeFile(gh, [
        "#!/bin/sh",
        `printf '%s\\n' '${JSON.stringify({
          state: "OPEN",
          mergedAt: null,
          mergeCommit: null,
          headRefOid: "a".repeat(40),
        })}'`,
      ].join("\n"));
      await chmod(gh, 0o755);
      process.env.PATH = `${bin}:${previousPath ?? ""}`;

      const item = ticket("BAR-TERM-4");
      const linear = linearHarness(item, "Done");
      store.createRun(item.id, "harness", manifestFor(item));
      store.transition(item.id, {
        stage: "merge",
        status: "waiting_human",
        actor: "test",
        reason: "pr-ready",
        patch: {
          plan: "plan",
          planFiles: ["src/a.ts"],
          planDomain: "backend",
          prUrl: "https://github.test/o/r/pull/1",
          headSha: "a".repeat(40),
          testedSha: "a".repeat(40),
        },
      });
      const deps = depsFor(store, linear.source);

      await reconcileRun(deps, store.getRun(item.id)!);
      await dispatchOutbox(deps);

      assert.deepEqual(
        [
          store.getRun(item.id)?.status,
          store.getRun(item.id)?.errorCode,
          store.getRun(item.id)?.blockedStage,
        ],
        ["blocked", "PREMATURE_DONE", "merge"]
      );
      assert.deepEqual(linear.writes, []);
      assert.ok(linear.comments.some((comment) =>
        comment.body.includes("Done jest przedwczesne")
      ));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test("stan nieterminalny zachowuje prostą i rozszerzoną projekcję statusu", async () => {
  await withHarness("factory-terminal-projection-", async ({ store }) => {
    const item = ticket("BAR-TERM-5");
    const linear = linearHarness(item, "🔨 Build");
    store.createRun(item.id, "harness", manifestFor(item));
    store.transition(item.id, {
      stage: "build",
      status: "running",
      actor: "test",
      reason: "build-running",
      patch: { plan: "plan", planFiles: ["src/a.ts"], planDomain: "backend" },
    });

    const simpleDeps = depsFor(store, linear.source);
    applyDecision(simpleDeps, item.id, {
      transition: {
        stage: "build",
        status: "running",
        actor: "test",
        reason: "simple-projection",
      },
      commands: [],
    });
    await dispatchOutbox(simpleDeps);
    assert.deepEqual(linear.writes, ["In Progress"]);

    const extendedDeps = depsFor(store, linear.source, { extended: true });
    const current = store.getRun(item.id)!;
    applyDecision(extendedDeps, item.id, {
      transition: {
        stage: current.stage,
        status: current.status,
        actor: "test",
        reason: "extended-projection",
      },
      commands: [],
    });
    await dispatchOutbox(extendedDeps);

    assert.deepEqual(linear.writes, ["In Progress", extendedStatusName(current)]);
  });
});

test("guard czyta wszystkie stany terminalne wyłącznie z LINEAR_STATE_MAP", async () => {
  await withHarness("factory-terminal-map-", async ({ store }) => {
    const item = ticket("BAR-TERM-6");
    const linear = linearHarness(item, LINEAR_STATE_MAP.terminal[0]);
    store.createRun(item.id, "harness", manifestFor(item));
    const deps = depsFor(store, linear.source);

    for (const [index, state] of LINEAR_STATE_MAP.terminal.entries()) {
      linear.setState(state);
      store.enqueue({
        key: `${item.id}:g1:linear-status:terminal-${index}`,
        ticketId: item.id,
        kind: "linear-status",
        stage: "plan",
        payload: { state: "In Progress" },
      });
      await dispatchOutbox(deps);
    }
    assert.deepEqual(linear.writes, []);

    linear.setState("🔨 Build");
    store.enqueue({
      key: `${item.id}:g1:linear-status:non-terminal`,
      ticketId: item.id,
      kind: "linear-status",
      stage: "plan",
      payload: { state: "In Progress" },
    });
    await dispatchOutbox(deps);
    assert.deepEqual(linear.writes, ["In Progress"]);
  });
});

test("/replan na zakończonym runie nie jest przetwarzany przez aktywny cykl", async () => {
  await withHarness("factory-terminal-done-command-", async ({ store }) => {
    const item = ticket("BAR-TERM-7");
    const linear = linearHarness(item, "Done", [{
      id: "human-replan",
      body: "/replan bo tak",
      createdAt: "2026-07-30T12:00:00.000Z",
    }]);
    store.createRun(item.id, "harness", manifestFor(item));
    store.transition(item.id, {
      stage: "smoke",
      status: "done",
      actor: "test",
      reason: "smoke-passed",
      patch: { mergedSha: "b".repeat(40), smokeStatus: "pass" },
    });
    const deps = depsFor(store, linear.source);
    const generation = store.getRun(item.id)!.generation;

    for (const active of store.listActive()) {
      await reconcileRun(deps, active);
    }

    const after = store.getRun(item.id)!;
    assert.deepEqual([after.status, after.generation], ["done", generation]);
    assert.equal(
      store.outstandingCommands(100).some((command) => command.kind === "run-job"),
      false
    );
    assert.equal(store.isCommentProcessed("human-replan"), false);
  });
});
