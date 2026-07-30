import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    claims: [] as string[],
    comments: [] as string[],
    incomingComments: [] as { id: string; body: string; createdAt: string }[],
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
    async claim(id: string) {
      control.claims.push(id);
      control.state = "In Progress";
    },
    async listComments() {
      control.commentReads += 1;
      return control.incomingComments;
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
    store.enqueue({
      key: `${ticketId}:g1:linear-status:t3:stale-blocked`,
      ticketId,
      kind: "linear-status",
      stage: "build",
      payload: { state: "👤 ⛔ Zablokowany" },
    });

    await reconcileRun(deps, store.getRun(ticketId)!);

    assert.deepEqual(
      [store.getRun(ticketId)?.status, store.getRun(ticketId)?.errorCode],
      ["done", "CANCELED"]
    );
    assert.equal(store.listActive().some((run) => run.ticketId === ticketId), false);
    assert.equal(control.commentReads, 1, "processCommands pozostaje pierwszym krokiem reconcile");
    assert.equal(control.ticketReads, 0, "Canceled musi być sprawdzone przed zmianą inputu");

    finishCommentCommands(store, ticketId);
    const statuses = statusCommands(store, ticketId);
    assert.deepEqual(statuses.map((command) => command.payload.state), [
      "👤 ⛔ Zablokowany",
      "Canceled",
    ]);
    await dispatchOutbox(deps);

    assert.deepEqual(control.writes, []);
    assert.deepEqual(
      statuses.map((command) => store.getCommand(command.key)?.lastError),
      ["superseded", "noop"]
    );
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

    const transitions = store.countTransitions(ticketId);
    await reconcileRun(deps, store.getRun(ticketId)!);
    assert.equal(store.countTransitions(ticketId), transitions);
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

test("Duplicate kończy aktywny run jak Canceled i zwalnia slot", async () => {
  const store = new LifecycleStore(":memory:");
  const ticketId = "BAR-DUPLICATE";
  const manifest = manifestFor(ticketId);
  const { source, control } = fakeLinear(ticketId, manifest, "Duplicate");
  const deps = depsFor(store, source, { extended: true });
  try {
    store.createRun(ticketId, "demo", manifest);
    store.transition(ticketId, {
      stage: "review",
      status: "running",
      actor: "test",
      reason: "review-running",
    });

    await reconcileRun(deps, store.getRun(ticketId)!);

    assert.deepEqual(
      [store.getRun(ticketId)?.status, store.getRun(ticketId)?.errorCode],
      ["done", "CANCELED"]
    );
    assert.equal(store.listActive().some((run) => run.ticketId === ticketId), false);
    finishCommentCommands(store, ticketId);
    await dispatchOutbox(deps);
    assert.deepEqual(control.writes, []);
    assert.equal(control.state, "Duplicate");
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

test("stara projekcja jest superseded przy nowszej done i przy obu pending", async () => {
  const store = new LifecycleStore(":memory:");
  const ticketId = "BAR-SUPERSESSION";
  const manifest = manifestFor(ticketId);
  const { source, control } = fakeLinear(ticketId, manifest, "Todo");
  const deps = depsFor(store, source, { extended: true });
  try {
    store.createRun(ticketId, "demo", manifest);
    store.transition(ticketId, {
      stage: "review",
      status: "running",
      actor: "test",
      reason: "review-running",
    });

    const oldBeforeDone = `${ticketId}:g1:linear-status:t2:old-before-done`;
    const newerDone = `${ticketId}:g1:linear-status:t3:newer-done`;
    store.enqueue({
      key: oldBeforeDone,
      ticketId,
      kind: "linear-status",
      stage: "build",
      payload: { state: "🔨 Build" },
    });
    store.enqueue({
      key: newerDone,
      ticketId,
      kind: "linear-status",
      stage: "review",
      payload: { state: "👀 Code review" },
    });
    store.markCommand(newerDone, "done");

    await dispatchOutbox(deps);

    assert.equal(store.getCommand(oldBeforeDone)?.lastError, "superseded");
    assert.equal(control.stateReads, 0, "supersesja nie wymaga odczytu Lineara");
    assert.deepEqual(control.writes, []);

    const oldPending = `${ticketId}:g1:linear-status:t4:old-pending`;
    const newerPending = `${ticketId}:g1:linear-status:t5:newer-pending`;
    store.enqueue({
      key: oldPending,
      ticketId,
      kind: "linear-status",
      stage: "build",
      payload: { state: "🔨 Build" },
    });
    store.enqueue({
      key: newerPending,
      ticketId,
      kind: "linear-status",
      stage: "review",
      payload: { state: "👀 Code review" },
    });

    await dispatchOutbox(deps);

    assert.equal(store.getCommand(oldPending)?.lastError, "superseded");
    assert.equal(store.getCommand(newerPending)?.state, "done");
    assert.deepEqual(control.writes, ["👀 Code review"]);
  } finally {
    store.close();
  }
});

test("processCommands obsługuje /score dla done runu z otwartym PR-em", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-score-done-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(":memory:");
  const ticketId = "BAR-DONE-SCORE";
  const manifest = manifestFor(ticketId);
  const { source, control } = fakeLinear(ticketId, manifest, "Done");
  const deps = depsFor(store, source);
  try {
    await writeFile(join(root, "package.json"), "{}");
    process.env.FACTORY_ROOT = root;
    store.createRun(ticketId, "demo", manifest);
    store.transition(ticketId, {
      stage: "merge",
      status: "done",
      actor: "test",
      reason: "done-with-open-pr",
      patch: { prUrl: "https://github.test/o/r/pull/194" },
    });
    control.incomingComments.push({
      id: "score-comment",
      body: "/score 5 regresja pokryta",
      createdAt: "2026-07-30T12:00:00.000Z",
    });
    assert.equal(store.listActive().some((run) => run.ticketId === ticketId), true);

    await reconcileRun(deps, store.getRun(ticketId)!);

    assert.equal(store.isCommentProcessed("score-comment"), true);
    assert.equal(store.getRun(ticketId)?.score, 5);
    assert.equal(control.stateReads, 0, "done wraca po processCommands bez reconcile PR");
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelActiveJobs zatrzymuje run-job i run-tests przez właściwe killery", async () => {
  const store = new LifecycleStore(":memory:");
  const ticketId = "BAR-CANCEL-JOBS";
  const manifest = manifestFor(ticketId);
  const { source } = fakeLinear(ticketId, manifest, "Canceled");
  const canceledRuns: string[] = [];
  const killedPids: number[] = [];
  const deps = depsFor(store, source);
  deps.mastra = {
    async cancelRun(runId: string) {
      canceledRuns.push(runId);
    },
  } as PollerDependencies["mastra"];
  deps.killProcessGroup = (pid) => killedPids.push(pid);
  try {
    store.createRun(ticketId, "demo", manifest);
    store.transition(ticketId, {
      stage: "test",
      status: "running",
      actor: "test",
      reason: "jobs-running",
    });
    const jobKey = `${ticketId}:g1:job`;
    const testsKey = `${ticketId}:g1:tests`;
    store.enqueue({
      key: jobKey,
      ticketId,
      kind: "run-job",
      stage: "build",
      payload: { kind: "build", attempt: 1 },
    });
    store.enqueue({
      key: testsKey,
      ticketId,
      kind: "run-tests",
      stage: "test",
      payload: { attempt: 1 },
    });
    store.markCommand(jobKey, "dispatched", { externalId: "mastra-run-194" });
    store.markCommand(testsKey, "dispatched", { externalId: "4194" });

    await reconcileRun(deps, store.getRun(ticketId)!);

    assert.deepEqual(canceledRuns, ["mastra-run-194"]);
    assert.deepEqual(killedPids, [4194]);
    assert.equal(store.getRun(ticketId)?.errorCode, "CANCELED");
  } finally {
    store.close();
  }
});

function stripCommentsAndStrings(source: string): string {
  let result = "";
  let state: "code" | "line" | "block" | "single" | "double" | "template" | "regex" = "code";
  let previousSignificant = "";
  let regexCharClass = false;
  const templateExpressionDepths: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "{" && templateExpressionDepths.length) {
        templateExpressionDepths[templateExpressionDepths.length - 1] += 1;
        result += char;
        previousSignificant = char;
      } else if (char === "}" && templateExpressionDepths.length) {
        const depthIndex = templateExpressionDepths.length - 1;
        templateExpressionDepths[depthIndex] -= 1;
        if (templateExpressionDepths[depthIndex] === 0) {
          templateExpressionDepths.pop();
          state = "template";
          result += " ";
        } else {
          result += char;
          previousSignificant = char;
        }
      } else if (char === "/" && next === "/") {
        state = "line";
        result += "  ";
        index += 1;
      } else if (char === "/" && next === "*") {
        state = "block";
        result += "  ";
        index += 1;
      } else if (char === "'") {
        state = "single";
        result += " ";
      } else if (char === "\"") {
        state = "double";
        result += " ";
      } else if (char === "`") {
        state = "template";
        result += " ";
      } else if (char === "/" && "([{:;,=!?&|+-*%^~<>".includes(previousSignificant)) {
        state = "regex";
        regexCharClass = false;
        result += " ";
      } else {
        result += char;
        if (!/\s/.test(char)) previousSignificant = char;
      }
      continue;
    }
    if (state === "template") {
      if (char === "\\") {
        result += "  ";
        index += 1;
      } else if (char === "$" && next === "{") {
        templateExpressionDepths.push(1);
        state = "code";
        result += "  ";
        index += 1;
        previousSignificant = "{";
      } else if (char === "`") {
        state = "code";
        result += " ";
      } else {
        result += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "regex") {
      if (char === "\\") {
        result += "  ";
        index += 1;
      } else if (char === "[") {
        regexCharClass = true;
        result += " ";
      } else if (char === "]") {
        regexCharClass = false;
        result += " ";
      } else if (char === "/" && !regexCharClass) {
        state = "code";
        previousSignificant = "/";
        result += " ";
      } else {
        result += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "line" && char === "\n") {
      state = "code";
      result += "\n";
    } else if (state === "block" && char === "*" && next === "/") {
      state = "code";
      result += "  ";
      index += 1;
    } else if (
      (state === "single" && char === "'") ||
      (state === "double" && char === "\"")
    ) {
      state = "code";
      result += " ";
    } else if (
      (state === "single" || state === "double") &&
      char === "\\"
    ) {
      result += "  ";
      index += 1;
    } else {
      result += char === "\n" ? "\n" : " ";
    }
  }
  return result;
}

test("poller v2 ma tylko zatwierdzone call-site'y zapisu stanu Lineara", async () => {
  const sourceCode = await readFile(
    new URL("../sources/poll-linear-v2.ts", import.meta.url),
    "utf8"
  );
  const code = stripCommentsAndStrings(sourceCode);
  const callSites = (pattern: RegExp) => code.match(pattern)?.length ?? 0;
  const setStateLines = [...code.matchAll(/\.setStateByName\s*\(/g)].map(
    (match) => sourceCode.slice(0, match.index).split("\n").length
  );

  assert.equal(callSites(/\.setStateByName\s*\(/g), 2, `linie: ${setStateLines.join(", ")}`);
  assert.equal(callSites(/\.claim\s*\(/g), 1);
});
