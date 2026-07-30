import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LifecycleStore,
  type AttemptStage,
  type LifecycleRun,
  type LifecycleStage,
  type LifecycleStatus,
} from "../pipeline/lifecycle-store";
import { reduceLifecycle } from "../pipeline/coordinator";
import { buildCommentContextSnapshot } from "../sources/comment-context";
import {
  ALL_COMMAND_KINDS,
  bareCommandsFor,
  isCommandAttempt,
  parseCommand,
  type CommandKind,
} from "../sources/commands";
import type { LinearComment, LinearSource } from "../sources/linear";
import {
  pollOnce,
  reconcileRun,
  sweepScores,
  type PollerDependencies,
} from "../sources/poll-linear-v2";

const ticket = {
  title: "Gołe komendy",
  description: "BAR-185",
  labels: [] as string[],
};

function sourceFor(
  ticketId: string,
  comments: LinearComment[]
): LinearSource {
  return {
    async listComments() {
      return comments;
    },
    async getTicket() {
      return {
        id: ticketId,
        source: "linear",
        ...ticket,
        stateName: "In Progress",
        url: `https://linear.test/${ticketId}`,
      };
    },
    async getStateName() {
      return "In Progress";
    },
    async comment(_ticketId: string, body: string) {
      comments.push({
        id: `factory-${comments.length}`,
        body,
        createdAt: "2026-07-30T10:10:00.000Z",
      });
    },
  } as unknown as LinearSource;
}

function depsFor(
  store: LifecycleStore,
  project: string,
  source: LinearSource
): PollerDependencies {
  return {
    store,
    mastra: {} as PollerDependencies["mastra"],
    sources: new Map([[project, source]]),
    notifier: async () => {},
  };
}

function createRunAt(
  store: LifecycleStore,
  ticketId: string,
  project: string,
  stage: LifecycleStage,
  status: LifecycleStatus,
  patch: Partial<LifecycleRun> = {}
): LifecycleRun {
  const inputHash = buildCommentContextSnapshot(
    ticketId,
    ticket.title,
    ticket.description,
    []
  ).effectiveInputHash;
  store.createRun(ticketId, project, { ...ticket, inputHash });
  return store.transition(ticketId, {
    stage,
    status,
    actor: "test",
    reason: "fixture",
    patch,
  });
}

function runState(
  stage: LifecycleStage,
  status: LifecycleStatus,
  patch: Partial<LifecycleRun> = {}
): LifecycleRun {
  return {
    ticketId: "BAR-STATE",
    project: "test",
    generation: 1,
    stage,
    status,
    manifest: { ...ticket, inputHash: "hash" },
    planFiles: [],
    clarifyRound: 0,
    critiqueRound: 0,
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    ...patch,
  };
}

const sorted = (set: ReadonlySet<CommandKind>) => [...set].sort();

test("parseCommand obsługuje obie ścisłe formy bez zmiany domyślnej semantyki slash-only", () => {
  const approval = new Set<CommandKind>(["approve", "reject"]);
  const active = new Set<CommandKind>(["retry", "replan", "restart", "score"]);

  assert.equal(parseCommand("approve"), undefined);
  assert.equal(parseCommand("answer 1A, 2B"), undefined);
  assert.equal(parseCommand("done", new Set(["done"]))?.form, "bare");
  assert.equal(parseCommand("Approve", approval)?.kind, "approve");
  assert.equal(parseCommand("Approve", approval)?.form, "bare");
  assert.equal(parseCommand("/approve")?.form, "slash");
  assert.equal(parseCommand("approve x", approval), undefined);
  assert.equal(parseCommand("reject", approval), undefined);
  assert.equal(parseCommand("retry teraz", active), undefined);
  assert.equal(parseCommand("replan", active), undefined);
  assert.equal(parseCommand("restart", active), undefined);
  assert.equal(parseCommand("restart stary klient", active)?.payload, "stary klient");
  assert.equal(parseCommand("/restart")?.kind, "restart");
  assert.equal(parseCommand("score 9", active), undefined);
  assert.equal(parseCommand("score tego podejścia jest niski", active), undefined);
  assert.equal(parseCommand("score 4 solidny", active)?.payload, "4 solidny");
  assert.equal(parseCommand("done deal, róbmy tak", ALL_COMMAND_KINDS), undefined);
});

test("form jest zwykłym enumerowalnym polem i przeżywa kopiowanie oraz serializację", () => {
  const parsed = parseCommand("approve", new Set(["approve"]));
  assert.ok(parsed);
  assert.deepEqual(parsed, {
    kind: "approve",
    payload: undefined,
    form: "bare",
  });
  assert.equal(Object.keys(parsed ?? {}).includes("form"), true);
  assert.equal(({ ...parsed }).form, "bare");
  assert.equal(JSON.parse(JSON.stringify(parsed)).form, "bare");
  assert.equal(structuredClone(parsed).form, "bare");
});

test("bareCommandsFor odzwierciedla guardy approval, pytań, ops, blokady i aktywnego runu", () => {
  assert.deepEqual(
    sorted(bareCommandsFor(runState("approval", "waiting_human"))),
    ["approve", "reject", "replan", "restart", "score"]
  );
  assert.deepEqual(
    sorted(bareCommandsFor(runState("approval", "waiting_human", {
      planDomain: "ops",
      approvedAt: "2026-07-30T10:00:00.000Z",
    }))),
    ["done", "replan", "restart", "score"]
  );
  assert.deepEqual(
    sorted(bareCommandsFor(runState("synthesis", "waiting_human", { clarifyRound: 2 }))),
    ["answer", "replan", "restart", "score"]
  );
  assert.deepEqual(
    sorted(bareCommandsFor(runState("test", "blocked", { blockedStage: "test" }))),
    ["replan", "restart", "retry", "score"]
  );
  assert.deepEqual(
    sorted(bareCommandsFor(runState("build", "running"))),
    ["replan", "restart", "score"]
  );
  assert.deepEqual(
    sorted(bareCommandsFor(runState("smoke", "done"))),
    ["score"]
  );
});

test("approve bez ukośnika przechodzi pełną ścieżkę processCommands i nie zmienia input hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-bare-approve-"));
  const store = new LifecycleStore(join(root, "registry.db"));
  try {
    for (const [index, body] of ["approve", "Approve"].entries()) {
      const ticketId = `BAR-APPROVE-${index}`;
      const comments: LinearComment[] = [{
        id: `comment-approve-${index}`,
        body,
        createdAt: "2026-07-30T10:00:00.000Z",
      }];
      const run = createRunAt(
        store,
        ticketId,
        "harness",
        "approval",
        "waiting_human",
        { plan: "plan", planFiles: ["src/a.ts"], planDomain: "backend" }
      );
      const initialHash = run.manifest.inputHash;

      await reconcileRun(
        depsFor(store, "harness", sourceFor(ticketId, comments)),
        run
      );

      const current = store.getRun(ticketId)!;
      assert.deepEqual([current.stage, current.status], ["build", "running"]);
      assert.ok(current.approvedAt);
      assert.equal(current.generation, 1);
      assert.equal(current.manifest.inputHash, initialHash);
      assert.equal(store.isCommentProcessed(`comment-approve-${index}`), true);
      assert.equal(
        store.processedCommandIds(ticketId).has(`comment-approve-${index}`),
        true
      );
      assert.ok(store.outstandingCommands(100).some((command) =>
        command.ticketId === ticketId &&
        command.kind === "run-job" &&
        command.stage === "build"
      ));
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("reopen liczy claim i detectInputChange z tego samego zbioru wykonanych komend", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-bare-reopen-"));
  const bin = join(root, "bin");
  const store = new LifecycleStore(join(root, "registry.db"));
  const previousRoot = process.env.FACTORY_ROOT;
  const previousPath = process.env.PATH;
  const ticketId = "BAR-REOPEN";
  const comments: LinearComment[] = [{
    id: "comment-approve-reopen",
    body: "approve",
    createdAt: "2026-07-30T10:00:00.000Z",
  }];
  let ready = false;
  try {
    const gitRoot = join(process.cwd(), "..");
    await mkdir(bin);
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(gitRoot)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    await writeFile(join(root, "routing.yaml"), [
      "defaults:",
      "  plan: codex",
      "  build: codex",
      "  review: codex",
    ].join("\n"));
    for (const executable of ["codex", "gh"]) {
      const path = join(bin, executable);
      await writeFile(path, [
        "#!/bin/sh",
        `if [ "$1" = "--version" ]; then echo "${executable} 1.0.0"; fi`,
        "exit 0",
      ].join("\n"));
      await chmod(path, 0o755);
    }
    process.env.FACTORY_ROOT = root;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;

    const source = {
      async listComments() {
        return comments;
      },
      async getTicket() {
        return {
          id: ticketId,
          source: "linear",
          ...ticket,
          stateName: "In Progress",
          url: `https://linear.test/${ticketId}`,
        };
      },
      async getStateName() {
        return "In Progress";
      },
      async listStateNames() {
        return ["Todo", "In Progress", "In Review", "Done", "Canceled", "👤 ⛔ Zablokowany"];
      },
      async listReady() {
        return ready
          ? [{
            id: ticketId,
            source: "linear",
            ...ticket,
            stateName: "Todo",
            url: `https://linear.test/${ticketId}`,
          }]
          : [];
      },
      async claim() {
        ready = false;
      },
      async setStateByName() {},
      async comment() {},
    } as unknown as LinearSource;
    const deps: PollerDependencies = {
      store,
      mastra: {
        async serverUp() {
          return true;
        },
        async getRun() {
          return { status: "running" };
        },
        async createRun(runId?: string) {
          return runId ?? "run";
        },
        async startRun() {},
        async cancelRun() {},
      } as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source]]),
      notifier: async () => {},
    };

    const run = createRunAt(
      store,
      ticketId,
      "harness",
      "approval",
      "waiting_human",
      { plan: "plan", planFiles: ["src/a.ts"], planDomain: "backend" }
    );
    await reconcileRun(deps, run);
    assert.equal(store.isCommentProcessed("comment-approve-reopen"), true);

    store.transition(ticketId, {
      stage: "smoke",
      status: "done",
      actor: "test",
      reason: "fixture-done",
      patch: { smokeStatus: "pass" },
    });
    for (const command of store.outstandingCommands(100)) {
      store.markCommand(command.key, "done");
    }

    ready = true;
    await pollOnce(deps);

    const claimed = store.getRun(ticketId)!;
    const reconciledSnapshot = buildCommentContextSnapshot(
      ticketId,
      ticket.title,
      ticket.description,
      comments,
      { executedCommandIds: store.processedCommandIds(ticketId) }
    );
    assert.equal(claimed.generation, 2);
    assert.equal(claimed.manifest.inputHash, reconciledSnapshot.effectiveInputHash);

    await reconcileRun(deps, claimed);
    assert.equal(store.getRun(ticketId)?.generation, 2);
    assert.equal(store.getRun(ticketId)?.errorCode, undefined);
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("gołe zdania poza bramką pozostają treścią i nie są oznaczane jako komendy", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-bare-content-"));
  const store = new LifecycleStore(join(root, "registry.db"));
  const ticketId = "BAR-CONTENT";
  const comments: LinearComment[] = [
    {
      id: "comment-done-sentence",
      body: "done deal, róbmy tak",
      createdAt: "2026-07-30T10:00:00.000Z",
    },
    {
      id: "comment-score-sentence",
      body: "score tego podejścia jest niski",
      createdAt: "2026-07-30T10:01:00.000Z",
    },
  ];
  try {
    const run = createRunAt(store, ticketId, "harness", "build", "running", {
      plan: "plan",
      planFiles: ["src/a.ts"],
      branch: "agent/BAR-CONTENT",
    });
    const initialHash = run.manifest.inputHash;

    await reconcileRun(
      depsFor(store, "harness", sourceFor(ticketId, comments)),
      run
    );

    const current = store.getRun(ticketId)!;
    assert.equal(current.status, "blocked");
    assert.equal(current.errorCode, "INPUT_CHANGED_AFTER_BUILD");
    assert.notEqual(current.manifest.inputHash, initialHash);
    assert.equal(store.isCommentProcessed("comment-done-sentence"), false);
    assert.equal(store.isCommentProcessed("comment-score-sentence"), false);
    assert.match(current.manifest.commentContext ?? "", /done deal, róbmy tak/);
    assert.match(current.manifest.commentContext ?? "", /score tego podejścia jest niski/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("answer jest komendą tylko podczas otwartej rundy pytań", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-bare-answer-"));
  const store = new LifecycleStore(join(root, "registry.db"));
  try {
    const openId = "BAR-ANSWER-OPEN";
    const openComments: LinearComment[] = [{
      id: "comment-answer-open",
      body: "answer 1A, 2B",
      createdAt: "2026-07-30T10:00:00.000Z",
    }];
    const openRun = createRunAt(
      store,
      openId,
      "harness",
      "plan",
      "waiting_human",
      { clarifyRound: 1 }
    );
    await reconcileRun(
      depsFor(store, "harness", sourceFor(openId, openComments)),
      openRun
    );
    const answered = store.getRun(openId)!;
    assert.deepEqual([answered.stage, answered.status], ["plan", "running"]);
    assert.equal(answered.feedback, "1A, 2B");
    assert.equal(store.isCommentProcessed("comment-answer-open"), true);
    assert.match(answered.manifest.commentContext ?? "", /1A, 2B/);
    assert.doesNotMatch(answered.manifest.commentContext ?? "", /answer 1A/);

    const closedId = "BAR-ANSWER-CLOSED";
    const closedComments: LinearComment[] = [{
      id: "comment-answer-closed",
      body: "answer 1A, 2B",
      createdAt: "2026-07-30T10:00:00.000Z",
    }];
    const closedRun = createRunAt(store, closedId, "harness", "plan", "running");
    const initialHash = closedRun.manifest.inputHash;
    await reconcileRun(
      depsFor(store, "harness", sourceFor(closedId, closedComments)),
      closedRun
    );
    const treatedAsContent = store.getRun(closedId)!;
    assert.equal(store.isCommentProcessed("comment-answer-closed"), false);
    assert.notEqual(treatedAsContent.manifest.inputHash, initialHash);
    assert.match(treatedAsContent.manifest.commentContext ?? "", /answer 1A, 2B/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("odrzucona goła komenda pozostaje treścią i nie powtarza efektów w kolejnych cyklach", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-bare-rejected-"));
  const store = new LifecycleStore(join(root, "registry.db"));
  const ticketId = "BAR-REJECTED-BARE";
  const comments: LinearComment[] = [{
    id: "comment-retry-rejected",
    body: "retry",
    createdAt: "2026-07-30T10:00:00.000Z",
  }];
  let nextAttemptCalls = 0;
  let getTicketCalls = 0;
  let commentCalls = 0;
  let cancelCalls = 0;
  const originalNextAttempt = store.nextAttempt.bind(store);
  store.nextAttempt = (id: string, stage: AttemptStage) => {
    nextAttemptCalls += 1;
    return originalNextAttempt(id, stage);
  };
  try {
    const inputHash = buildCommentContextSnapshot(
      ticketId,
      ticket.title,
      ticket.description,
      comments
    ).effectiveInputHash;
    store.createRun(ticketId, "harness", { ...ticket, inputHash });
    store.transition(ticketId, {
      stage: "approval",
      status: "blocked",
      actor: "test",
      reason: "rejected-plan",
      patch: {
        plan: "plan",
        planFiles: ["src/a.ts"],
        blockedStage: "approval",
        errorCode: "PLAN_REJECTED",
      },
    });
    const source = {
      async listComments() {
        return comments;
      },
      async getTicket() {
        getTicketCalls += 1;
        return {
          id: ticketId,
          source: "linear",
          ...ticket,
          stateName: "In Progress",
          url: `https://linear.test/${ticketId}`,
        };
      },
      async getStateName() {
        return "In Progress";
      },
      async comment() {
        commentCalls += 1;
      },
    } as unknown as LinearSource;
    const deps: PollerDependencies = {
      store,
      mastra: {
        async cancelRun() {
          cancelCalls += 1;
        },
      } as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source]]),
      notifier: async () => {},
    };

    await reconcileRun(deps, store.getRun(ticketId)!);
    const nextAttemptCallsAfterFirstCycle = nextAttemptCalls;
    await reconcileRun(deps, store.getRun(ticketId)!);

    assert.equal(store.isCommentProcessed("comment-retry-rejected"), false);
    assert.deepEqual(
      [store.getRun(ticketId)?.generation, store.getRun(ticketId)?.status],
      [1, "blocked"]
    );
    assert.equal(commentCalls, 0);
    assert.equal(cancelCalls, 0);
    assert.ok(nextAttemptCallsAfterFirstCycle > 0);
    assert.equal(
      nextAttemptCalls,
      nextAttemptCallsAfterFirstCycle,
      "drugi cykl ma pominąć odrzuconą komendę przed budową eventu"
    );
    assert.equal(getTicketCalls, 2, "pozostaje wyłącznie zwykły odczyt detectInputChange per cykl");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("autoformat /`approve` dostaje hint, a kolejne approve działa", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-bare-autoformat-"));
  const store = new LifecycleStore(join(root, "registry.db"));
  const ticketId = "BAR-AUTOFORMAT";
  const comments: LinearComment[] = [
    {
      id: "comment-autoformat",
      body: "/`approve`",
      createdAt: "2026-07-30T10:00:00.000Z",
    },
    {
      id: "comment-bare-approve",
      body: "approve",
      createdAt: "2026-07-30T10:01:00.000Z",
    },
  ];
  try {
    assert.equal(parseCommand("/`approve`"), undefined);
    assert.equal(isCommandAttempt("/`approve`"), true);
    const run = createRunAt(
      store,
      ticketId,
      "harness",
      "approval",
      "waiting_human",
      { plan: "plan", planFiles: ["src/a.ts"], planDomain: "backend" }
    );
    await reconcileRun(
      depsFor(store, "harness", sourceFor(ticketId, comments)),
      run
    );

    assert.equal(store.isCommentProcessed("comment-autoformat"), true);
    assert.equal(store.isCommentProcessed("comment-bare-approve"), true);
    assert.deepEqual(
      [store.getRun(ticketId)?.stage, store.getRun(ticketId)?.status],
      ["build", "running"]
    );
    const hint = store.outstandingCommands(100).find((command) =>
      command.key === `${ticketId}:g1:unknown-command:comment-autoformat`
    );
    assert.match(String(hint?.payload.body), /Nieznana komenda/);
    assert.match(String(hint?.payload.body), /`approve`/);
    assert.match(String(hint?.payload.body), /`\/approve`/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("score bez ukośnika działa także dla ukończonego runu", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-bare-score-"));
  const store = new LifecycleStore(join(root, "registry.db"));
  const ticketId = "BAR-SCORE-DONE";
  const comments: LinearComment[] = [{
    id: "comment-bare-score",
    body: "score 5 bardzo dobrze",
    createdAt: "2026-07-30T10:00:00.000Z",
  }];
  try {
    createRunAt(store, ticketId, "harness", "smoke", "done");
    await sweepScores(
      depsFor(store, "harness", sourceFor(ticketId, comments))
    );

    const current = store.getRun(ticketId)!;
    assert.equal(current.score, 5);
    assert.equal(current.scoreComment, "bardzo dobrze");
    assert.equal(store.isCommentProcessed("comment-bare-score"), true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot wyklucza wykonaną gołą komendę po ID, ale zachowuje payload answer", () => {
  const empty = buildCommentContextSnapshot(
    "BAR-HASH",
    ticket.title,
    ticket.description,
    []
  );
  const approve = {
    id: "comment-approve",
    body: "approve",
    createdAt: "2026-07-30T10:00:00.000Z",
  };
  const beforeExecution = buildCommentContextSnapshot(
    "BAR-HASH",
    ticket.title,
    ticket.description,
    [approve]
  );
  const afterExecution = buildCommentContextSnapshot(
    "BAR-HASH",
    ticket.title,
    ticket.description,
    [approve],
    { executedCommandIds: new Set([approve.id]) }
  );
  assert.notEqual(beforeExecution.effectiveInputHash, empty.effectiveInputHash);
  assert.equal(afterExecution.effectiveInputHash, empty.effectiveInputHash);

  const answer = buildCommentContextSnapshot(
    "BAR-HASH",
    ticket.title,
    ticket.description,
    [{
      id: "comment-answer",
      body: "answer 1A, 2B",
      createdAt: "2026-07-30T10:01:00.000Z",
    }],
    { executedCommandIds: new Set(["comment-answer"]) }
  );
  assert.equal(answer.comments[0]?.body, "1A, 2B");
});

test("komentarze bramek wymieniają formę gołą i slash", () => {
  const plan = runState("plan", "running");
  const approval = reduceLifecycle(plan, {
    type: "job-finished",
    attempt: 1,
    output: {
      kind: "plan",
      outcome: "success",
      report: "plan",
      signature: "planner",
      durationMs: 1,
      plan: "plan",
      files: ["src/a.ts"],
      domain: "backend",
      changedFiles: [],
      scopeWarnings: [],
    },
  });
  assert.match(String(approval.commands[0].payload.body), /`approve`.*`\/approve`/);
  assert.match(String(approval.commands[0].payload.body), /`reject <powód>`.*`\/reject <powód>`/);

  const questions = reduceLifecycle(plan, {
    type: "job-finished",
    attempt: 1,
    output: {
      kind: "plan",
      outcome: "questions",
      report: "questions",
      signature: "planner",
      durationMs: 1,
      questions: "A czy B?",
      files: [],
      changedFiles: [],
      scopeWarnings: [],
    },
  });
  assert.match(String(questions.commands[0].payload.body), /`answer <odpowiedź>`.*`\/answer <odpowiedź>`/);

  const ops = reduceLifecycle(runState("approval", "waiting_human", {
    planDomain: "ops",
  }), {
    type: "approve",
    commentId: "comment-ops-approve",
  });
  assert.match(String(ops.commands[0].payload.body), /`done`.*`\/done`/);

  const blocked = reduceLifecycle(plan, {
    type: "job-finished",
    attempt: 1,
    output: {
      kind: "plan",
      outcome: "failed",
      report: "awaria",
      signature: "planner",
      durationMs: 1,
      files: [],
      changedFiles: [],
      scopeWarnings: [],
    },
  });
  assert.match(String(blocked.commands[0].payload.body), /`retry`.*`\/retry`/);
  assert.match(String(blocked.commands[0].payload.body), /`replan <powód>`.*`\/replan <powód>`/);
});
