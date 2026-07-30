import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LifecycleStore,
  type LifecycleRun,
  type TicketManifestV2,
} from "../pipeline/lifecycle-store";
import type { CoordinatorDecision } from "../pipeline/coordinator";
import { buildCommentContextSnapshot } from "../sources/comment-context";
import type { LinearSource } from "../sources/linear";
import {
  applyDecision,
  dispatchOutbox,
  reconcileRun,
  writeLinearState,
  type PollerDependencies,
} from "../sources/poll-linear-v2";

function manifestFor(ticketId: string): TicketManifestV2 {
  const title = `Ticket ${ticketId}`;
  const description = "Terminal state regression";
  return {
    title,
    description,
    labels: [],
    inputHash: buildCommentContextSnapshot(ticketId, title, description, []).effectiveInputHash,
  };
}

function fakeLinear(ticketId: string, manifest: TicketManifestV2, initialState: string) {
  const control = {
    state: initialState,
    writes: [] as string[],
    claims: [] as (string | undefined)[],
    comments: [] as string[],
    stateReads: 0,
    ticketReads: 0,
    commentReads: 0,
    failStateRead: false,
  };
  const source = {
    name: "linear",
    async getStateName() {
      control.stateReads += 1;
      if (control.failStateRead) throw new Error("Linear read failed");
      return control.state;
    },
    async setStateByName(_id: string, state: string) {
      control.writes.push(state);
      control.state = state;
    },
    async claim(_id: string, preferredStateName?: string) {
      control.claims.push(preferredStateName);
      control.state = preferredStateName ?? "In Progress";
    },
    async listComments() {
      control.commentReads += 1;
      return [];
    },
    async getTicket() {
      control.ticketReads += 1;
      return {
        id: ticketId,
        source: "linear",
        title: manifest.title,
        description: manifest.description,
        labels: manifest.labels,
        stateName: control.state,
      };
    },
    async comment(_id: string, body: string) {
      control.comments.push(body);
    },
  } as unknown as LinearSource;
  return { source, control };
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
    sources: new Map([["demo", source]]),
    extendedStatuses: options.extended ? new Set(["demo"]) : undefined,
    notifier: async () => {},
  };
}

function finishCommentCommands(store: LifecycleStore, ticketId: string): void {
  for (const command of store.outstandingCommands(200)) {
    if (command.ticketId === ticketId && command.kind === "linear-comment") {
      store.markCommand(command.key, "done");
    }
  }
}

function statusCommands(store: LifecycleStore, ticketId: string) {
  return store.outstandingCommands(200).filter(
    (command) => command.ticketId === ticketId && command.kind === "linear-status"
  );
}

test("aktywny run respektuje ręczne Canceled i zwalnia slot w jednym reconcile", async () => {
  const store = new LifecycleStore(":memory:");
  const ticketId = "BAR-CANCEL-ACTIVE";
  const manifest = manifestFor(ticketId);
  const { source, control } = fakeLinear(ticketId, manifest, "Canceled");
  const deps = depsFor(store, source);
  try {
    store.createRun(ticketId, "demo", manifest);
    store.transition(ticketId, {
      stage: "build",
      status: "running",
      actor: "test",
      reason: "builder-running",
    });

    await reconcileRun(deps, store.getRun(ticketId)!);

    assert.deepEqual(
      [store.getRun(ticketId)?.status, store.getRun(ticketId)?.errorCode],
      ["done", "CANCELED"]
    );
    assert.equal(store.listActive().some((run) => run.ticketId === ticketId), false);
    assert.equal(control.commentReads, 0, "Canceled musi być sprawdzone przed komendami");
    assert.equal(control.ticketReads, 0, "Canceled musi być sprawdzone przed zmianą inputu");

    finishCommentCommands(store, ticketId);
    const [status] = statusCommands(store, ticketId);
    assert.equal(status?.payload.state, "Canceled");
    await dispatchOutbox(deps);

    assert.deepEqual(control.writes, []);
    assert.equal(store.getCommand(status.key)?.state, "done");
    assert.equal(store.getCommand(status.key)?.lastError, "skipped-terminal");
  } finally {
    store.close();
  }
});

test("BAR-185: blocked + zamknięty PR + Canceled kończy run bez re-blokowania i gh", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-bar-185-"));
  const bin = join(root, "bin");
  const ghMarker = join(root, "gh-invoked");
  const previousPath = process.env.PATH;
  const previousMarker = process.env.FAKE_GH_MARKER;
  await mkdir(bin);
  await writeFile(
    join(bin, "gh"),
    "#!/bin/sh\nprintf 'invoked\\n' >> \"$FAKE_GH_MARKER\"\nexit 0\n"
  );
  await chmod(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_GH_MARKER = ghMarker;

  const store = new LifecycleStore(":memory:");
  const ticketId = "BAR-185";
  const manifest = manifestFor(ticketId);
  const { source, control } = fakeLinear(ticketId, manifest, "Canceled");
  const deps = depsFor(store, source, { extended: true });
  try {
    store.createRun(ticketId, "demo", manifest);
    store.transition(ticketId, {
      stage: "merge",
      status: "blocked",
      actor: "github",
      reason: "PR_CLOSED_UNMERGED",
      patch: {
        prUrl: "https://github.test/o/r/pull/185",
        blockedStage: "merge",
        errorCode: "PR_CLOSED_UNMERGED",
      },
      commands: [{
        key: `${ticketId}:g1:linear-status:t2:blocked`,
        ticketId,
        kind: "linear-status",
        stage: "merge",
        payload: { state: "👤 ⛔ Zablokowany" },
      }],
    });

    await dispatchOutbox(deps);
    assert.deepEqual(control.writes, [], "stara komenda outboxa nie może nadpisać Canceled");

    await reconcileRun(deps, store.getRun(ticketId)!);
    assert.deepEqual(
      [store.getRun(ticketId)?.status, store.getRun(ticketId)?.errorCode],
      ["done", "CANCELED"]
    );
    assert.equal(store.listActive().some((run) => run.ticketId === ticketId), false);
    assert.equal(existsSync(ghMarker), false, "reconcilePullRequest nie może wystartować po Canceled");

    const transitions = store.transitionCount(ticketId);
    for (const active of store.listActive()) await reconcileRun(deps, active);
    assert.equal(store.transitionCount(ticketId), transitions);
    assert.equal(store.getRun(ticketId)?.errorCode, "CANCELED");
  } finally {
    store.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.FAKE_GH_MARKER;
    else process.env.FAKE_GH_MARKER = previousMarker;
    await rm(root, { recursive: true, force: true });
  }
});

test("przedwczesne Done blokuje run bez nadpisywania Done w Linear", async () => {
  const store = new LifecycleStore(":memory:");
  const ticketId = "BAR-PREMATURE-DONE";
  const manifest = manifestFor(ticketId);
  const { source, control } = fakeLinear(ticketId, manifest, "Done");
  const deps = depsFor(store, source, { extended: true });
  try {
    store.createRun(ticketId, "demo", manifest);
    store.transition(ticketId, {
      stage: "build",
      status: "running",
      actor: "test",
      reason: "builder-running",
    });

    await reconcileRun(deps, store.getRun(ticketId)!);

    assert.deepEqual(
      [store.getRun(ticketId)?.status, store.getRun(ticketId)?.errorCode],
      ["blocked", "PREMATURE_DONE"]
    );
    assert.ok(
      statusCommands(store, ticketId).some(
        (command) => command.payload.state === "👤 ⛔ Zablokowany"
      )
    );
    finishCommentCommands(store, ticketId);
    await dispatchOutbox(deps);
    assert.deepEqual(control.writes, []);
    assert.equal(control.state, "Done");
  } finally {
    store.close();
  }
});

test("powtórzone identyczne SCOPE_BLOCKED ma nowy klucz i ponownie zapisuje stan", async () => {
  const store = new LifecycleStore(":memory:");
  const ticketId = "BAR-REPEATED-BLOCK";
  const manifest = manifestFor(ticketId);
  const { source, control } = fakeLinear(ticketId, manifest, "In Progress");
  const deps = depsFor(store, source);
  const decision: CoordinatorDecision = {
    transition: {
      stage: "build",
      status: "blocked",
      actor: "coordinator",
      reason: "SCOPE_BLOCKED",
      patch: {
        blockedStage: "build",
        errorCode: "SCOPE_BLOCKED",
        errorMessage: "Scope blocked",
      },
    },
    commands: [],
  };
  try {
    store.createRun(ticketId, "demo", manifest);
    store.transition(ticketId, {
      stage: "build",
      status: "blocked",
      actor: "test",
      reason: "prepare-blocked",
    });

    applyDecision(deps, ticketId, decision);
    finishCommentCommands(store, ticketId);
    const firstKey = statusCommands(store, ticketId)[0]?.key;
    assert.match(firstKey, /:linear-status:t3:/);
    await dispatchOutbox(deps);

    control.state = "In Progress";
    applyDecision(deps, ticketId, decision);
    finishCommentCommands(store, ticketId);
    const secondKey = statusCommands(store, ticketId)[0]?.key;
    assert.match(secondKey, /:linear-status:t4:/);
    assert.notEqual(secondKey, firstKey);
    await dispatchOutbox(deps);

    assert.deepEqual(control.writes, ["👤 ⛔ Zablokowany", "👤 ⛔ Zablokowany"]);
  } finally {
    store.close();
  }
});

test("writeLinearState obsługuje zapis, terminal, no-op, supersession i błąd odczytu", async () => {
  const store = new LifecycleStore(":memory:");
  const ticketId = "BAR-WRITER";
  const manifest = manifestFor(ticketId);
  const { source, control } = fakeLinear(ticketId, manifest, "In Progress");
  const deps = depsFor(store, source, { extended: true });
  try {
    const run = store.createRun(ticketId, "demo", manifest);

    assert.equal(await writeLinearState(deps, run, "Done"), "written");
    assert.deepEqual(control.writes, ["Done"]);

    for (const terminalState of ["Done", "Canceled", "Duplicate"]) {
      control.state = terminalState;
      assert.equal(
        await writeLinearState(deps, run, "👤 ⛔ Zablokowany"),
        "skipped-terminal",
        terminalState
      );
    }

    control.state = "🧠 Planowanie";
    assert.equal(
      await writeLinearState(deps, run, "🧠 Planowanie"),
      "skipped-noop"
    );

    control.state = "Todo";
    const currentKey = `${ticketId}:g1:linear-status:t2:old`;
    const newerKey = `${ticketId}:g1:linear-status:t3:new`;
    store.enqueue({
      key: currentKey,
      ticketId,
      kind: "linear-status",
      stage: "plan",
      payload: { state: "In Progress" },
    });
    store.enqueue({
      key: newerKey,
      ticketId,
      kind: "linear-status",
      stage: "build",
      payload: { state: "🔨 Build" },
    });
    assert.equal(
      await writeLinearState(deps, run, "In Progress", currentKey),
      "skipped-superseded"
    );

    control.failStateRead = true;
    await assert.rejects(
      writeLinearState(deps, run, "In Review"),
      /Linear read failed/
    );
    assert.deepEqual(control.writes, ["Done"]);
  } finally {
    store.close();
  }
});
