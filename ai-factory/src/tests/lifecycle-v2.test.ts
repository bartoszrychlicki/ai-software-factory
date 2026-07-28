import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LifecycleStore,
  type LifecycleRun,
  type TicketManifestV2,
} from "../pipeline/lifecycle-store";
import { reduceLifecycle, type CoordinatorEvent } from "../pipeline/coordinator";
import { auditScope } from "../pipeline/scope";
import {
  executeFactoryJobInput,
  type FactoryJobOutput,
  type FactoryJobRuntime,
} from "../pipeline/factory-job";
import type { EngineAdapter } from "../engines/types";
import {
  importLegacyCandidate,
  inspectLegacyV1,
  validateLiveMigration,
} from "../pipeline/legacy-migration";
import { runPreflight } from "../pipeline/preflight";
import { parseCommand } from "../sources/commands";
import {
  applyDecision,
  dispatchOutbox,
  localExactShaCiResult,
  reconcileRun,
  type PollerDependencies,
} from "../sources/poll-linear-v2";
import { MastraHttpError } from "../sources/mastra-client";
import { buildCommentContextSnapshot } from "../sources/comment-context";

const manifest: TicketManifestV2 = {
  title: "Lifecycle v2",
  description: "Implementacja",
  labels: [],
  inputHash: "hash-1",
};

function apply(store: LifecycleStore, run: LifecycleRun, event: CoordinatorEvent): LifecycleRun {
  const decision = reduceLifecycle(run, event);
  return store.transition(run.ticketId, {
    ...decision.transition,
    commands: decision.commands,
  });
}

const planOutput: FactoryJobOutput = {
  kind: "plan",
  outcome: "success",
  report: "plan",
  signature: "ai-factory · fake · model · planner",
  durationMs: 1,
  plan: "plan",
  files: ["src/a.ts"],
  domain: "backend",
  changedFiles: [],
  scopeWarnings: [],
};

test("registry v2 atomowo zachowuje stan, próbę i idempotentny outbox po restarcie", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-lifecycle-"));
  const db = join(dir, "registry.db");
  try {
    let store = new LifecycleStore(db);
    let run = store.createRun("BAR-T1", "br-factory", manifest);
    run = apply(store, run, { type: "start" });
    const command = store.outstandingCommands()[0];
    assert.equal(command.kind, "run-job");
    store.startAttempt(run.ticketId, "plan", 1, "job-1", {
      inputHash: "hash-1",
      sha: "a".repeat(40),
      budgetMaxMinutes: 45,
      budgetMaxUsd: 3,
      budgetUsedMinutes: 2,
      budgetUsedUsd: 0.1,
    });
    store.finishAttempt(run.ticketId, "plan", 1, {
      status: "failed",
      outcome: "PLAN_FAILED",
      report: "ok",
      signature: "sig",
      errorCode: "PLAN_FAILED",
      errorMessage: "planner failed",
      costUsd: 0.25,
      durationMs: 2000,
    });
    store.close();

    store = new LifecycleStore(db);
    assert.equal(store.getRun("BAR-T1")?.status, "running");
    assert.equal(store.outstandingCommands().length, 1);
    assert.deepEqual(store.latestAttempt("BAR-T1", "plan"), {
      ticketId: "BAR-T1",
      stage: "plan",
      attempt: 1,
      jobRunId: "job-1",
      inputHash: "hash-1",
      sha: "a".repeat(40),
      status: "failed",
      outcome: "PLAN_FAILED",
      report: "ok",
      signature: "sig",
      errorCode: "PLAN_FAILED",
      errorMessage: "planner failed",
      costUsd: 0.25,
      durationMs: 2000,
      budgetMaxMinutes: 45,
      budgetMaxUsd: 3,
      budgetUsedMinutes: 2,
      budgetUsedUsd: 0.1,
      startedAt: store.latestAttempt("BAR-T1", "plan")?.startedAt,
      finishedAt: store.latestAttempt("BAR-T1", "plan")?.finishedAt,
    });
    assert.deepEqual(store.totalUsage("BAR-T1"), { usd: 0.25, minutes: 2 / 60 });
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("happy path przechodzi tylko przez krótkie joby i kończy się po merge + smoke", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-happy-"));
  const store = new LifecycleStore(join(dir, "registry.db"));
  try {
    let run = store.createRun("BAR-T2", "br-factory", manifest);
    run = apply(store, run, { type: "start" });
    run = apply(store, run, { type: "job-finished", attempt: 1, output: planOutput });
    assert.deepEqual([run.stage, run.status], ["approval", "waiting_human"]);
    run = apply(store, run, { type: "approve", commentId: "c1" });
    run = apply(store, run, {
      type: "job-finished",
      attempt: 1,
      output: {
        kind: "build",
        outcome: "success",
        report: "build",
        signature: "builder",
        durationMs: 1,
        files: ["src/a.ts"],
        branch: "agent/BAR-T2",
        workspaceDir: "/tmp/worktree",
        headSha: "a".repeat(40),
        changedFiles: ["src/a.ts"],
        scopeWarnings: [],
      },
    });
    run = apply(store, run, {
      type: "test-result", ok: true, sha: "a".repeat(40), report: "pass",
    });
    run = apply(store, run, {
      type: "published",
      prUrl: "https://github.com/o/r/pull/1",
      branch: "agent/BAR-T2",
      sha: "a".repeat(40),
    });
    run = apply(store, run, {
      type: "ci-result", outcome: "pass", sha: "a".repeat(40), report: "quality",
    });
    run = apply(store, run, {
      type: "job-finished",
      attempt: 1,
      output: {
        kind: "review",
        outcome: "success",
        report: "LGTM",
        signature: "reviewer",
        durationMs: 1,
        files: ["src/a.ts"],
        changedFiles: [],
        scopeWarnings: [],
        headSha: "a".repeat(40),
        reviewVerdict: "lgtm",
      },
    });
    assert.deepEqual([run.stage, run.status], ["merge", "waiting_human"]);
    run = apply(store, run, { type: "pr-state", state: "merged", sha: "b".repeat(40) });
    run = apply(store, run, { type: "smoke-result", outcome: "pass", report: "prod ok" });
    assert.deepEqual([run.stage, run.status, run.smokeStatus], ["smoke", "done", "pass"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("test FAIL zachowuje checkpoint, a /retry uruchamia wyłącznie buildera naprawczego", async () => {
  const run: LifecycleRun = {
    ticketId: "BAR-T3",
    project: "br-budget",
    generation: 1,
    stage: "test",
    status: "pending",
    manifest,
    plan: "plan",
    planFiles: ["src/a.ts"],
    clarifyRound: 0,
    branch: "agent/BAR-T3",
    headSha: "c".repeat(40),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const failed = reduceLifecycle(run, {
    type: "test-result", ok: false, sha: run.headSha!, report: "e2e failed",
  });
  const blocked = { ...run, ...failed.transition.patch, stage: "test" as const, status: "blocked" as const };
  const retry = reduceLifecycle(blocked, { type: "retry", commentId: "c2" });
  assert.equal(retry.transition.stage, "build");
  assert.equal(retry.commands.length, 1);
  assert.equal(retry.commands[0].payload.kind, "build");
  assert.equal(retry.commands[0].payload.headSha, run.headSha);
  assert.match(String(retry.commands[0].payload.feedback), /e2e failed/);
});

test("zmiana inputu przed buildem replanuje z nową generacją, po buildzie blokuje bez kasowania brancha", () => {
  const approval: LifecycleRun = {
    ticketId: "BAR-T4",
    project: "br-factory",
    generation: 2,
    stage: "approval",
    status: "waiting_human",
    manifest,
    plan: "plan",
    planFiles: ["a"],
    clarifyRound: 0,
    createdAt: "x",
    updatedAt: "x",
  };
  const replan = reduceLifecycle(approval, {
    type: "input-changed", inputHash: "hash-2", commentContext: "nowy komentarz",
  });
  assert.equal(replan.transition.incrementGeneration, true);
  assert.match(replan.commands[0].key, /g3/);
  assert.equal(replan.transition.stage, "plan");

  const build = { ...approval, stage: "build" as const, status: "running" as const, branch: "agent/keep" };
  const stopped = reduceLifecycle(build, { type: "input-changed", inputHash: "hash-3" });
  assert.equal(stopped.transition.status, "blocked");
  assert.equal(stopped.transition.patch?.branch, undefined);
  assert.equal(build.branch, "agent/keep");
});

test("brak werdyktu review ponawia tylko review raz w generacji, niezależnie od globalnego numeru próby", () => {
  const run: LifecycleRun = {
    ticketId: "BAR-T5",
    project: "br-factory",
    generation: 1,
    stage: "review",
    status: "running",
    manifest,
    planFiles: [],
    clarifyRound: 0,
    headSha: "d".repeat(40),
    prUrl: "https://github.com/o/r/pull/5",
    createdAt: "x",
    updatedAt: "x",
  };
  const unavailable: FactoryJobOutput = {
    kind: "review",
    outcome: "failed",
    report: "missing",
    signature: "reviewer",
    durationMs: 1,
    files: [],
    changedFiles: [],
    scopeWarnings: [],
    reviewVerdict: "unavailable",
  };
  const first = reduceLifecycle(run, { type: "job-finished", attempt: 7, output: unavailable });
  assert.equal(first.commands[0].payload.kind, "review");
  const second = reduceLifecycle(
    { ...run, reviewStatus: "unavailable" },
    { type: "job-finished", attempt: 8, output: unavailable }
  );
  assert.equal(second.transition.status, "blocked");
});

test("ścisłe komendy odrzucają brak wymaganej treści i nadmiarowe argumenty", () => {
  assert.deepEqual(parseCommand("/approve"), { kind: "approve", payload: undefined });
  assert.equal(parseCommand("/approve proszę"), undefined);
  assert.deepEqual(parseCommand("/reject plan jest zbyt szeroki"), {
    kind: "reject",
    payload: "plan jest zbyt szeroki",
  });
  assert.equal(parseCommand("/reject"), undefined);
  assert.equal(parseCommand("/retry teraz"), undefined);
  assert.deepEqual(parseCommand("/restart"), { kind: "restart", payload: undefined });
  assert.deepEqual(parseCommand("/restart stary klient"), {
    kind: "restart",
    payload: "stary klient",
  });
  assert.equal(parseCommand("/replan"), undefined);
});

test("/retry odtwarza tylko zatrzymany deterministyczny etap", () => {
  const base: LifecycleRun = {
    ticketId: "BAR-T6",
    project: "br-factory",
    generation: 1,
    stage: "publish",
    status: "blocked",
    manifest,
    planFiles: ["src/a.ts"],
    clarifyRound: 0,
    branch: "agent/BAR-T6",
    headSha: "f".repeat(40),
    blockedStage: "publish",
    errorCode: "OUTBOX_FAILED",
    createdAt: "x",
    updatedAt: "x",
  };
  const publishRetry = reduceLifecycle(base, { type: "retry", commentId: "c-publish" });
  assert.equal(publishRetry.transition.stage, "publish");
  assert.equal(publishRetry.commands[0].kind, "publish-pr");

  const ciRetry = reduceLifecycle({
    ...base,
    stage: "ci",
    blockedStage: "ci",
    prUrl: "https://github.test/pr/1",
  }, { type: "retry", commentId: "c-ci" });
  assert.equal(ciRetry.transition.status, "waiting_external");
  assert.equal(ciRetry.commands.length, 0);
});

test("br-budget używa lokalnego exact-SHA jako jedynego fallbacku CI", () => {
  const sha = "1".repeat(40);
  assert.equal(localExactShaCiResult("br-factory", sha, sha), undefined);
  assert.equal(localExactShaCiResult("br-budget", sha, sha)?.outcome, "pass");
  assert.equal(localExactShaCiResult("br-budget", "2".repeat(40), sha)?.outcome, "fail");
});

test("Linear Done nadal pozwala rozpoznać merge śledzonego PR-a i wykonać smoke", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-done-merge-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const gh = join(bin, "gh");
  const previousRoot = process.env.FACTORY_ROOT;
  const previousPath = process.env.PATH;
  const previousPrState = process.env.FACTORY_TEST_PR_STATE;
  const store = new LifecycleStore(join(root, "registry.db"));
  try {
    await mkdir(repo);
    await mkdir(bin);
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(repo)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    await writeFile(gh, [
      "#!/bin/sh",
      "if [ \"$FACTORY_TEST_PR_STATE\" = \"merged\" ]; then",
      `  printf '%s\\n' '${JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-07-28T12:00:00Z",
        mergeCommit: { oid: "b".repeat(40) },
        headRefOid: "a".repeat(40),
      })}'`,
      "else",
      `  printf '%s\\n' '${JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeCommit: null,
        headRefOid: "a".repeat(40),
      })}'`,
      "fi",
    ].join("\n"));
    await chmod(gh, 0o755);
    process.env.FACTORY_ROOT = root;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;

    const ticket = {
      id: "BAR-H3",
      title: "Done merge",
      description: "Śledź merge mimo Done.",
      labels: [] as string[],
    };
    const inputHash = buildCommentContextSnapshot(
      ticket.id,
      ticket.title,
      ticket.description,
      []
    ).effectiveInputHash;
    store.createRun(ticket.id, "harness", { ...ticket, inputHash });
    store.transition(ticket.id, {
      stage: "merge",
      status: "waiting_human",
      actor: "test",
      reason: "ready",
      patch: {
        plan: "plan",
        planFiles: ["src/a.ts"],
        headSha: "a".repeat(40),
        testedSha: "a".repeat(40),
        prUrl: "https://github.test/o/r/pull/1",
      },
    });
    const tickets = new Map([["BAR-H3", ticket]]);
    const source = {
      async listComments() { return []; },
      async getTicket(id: string) {
        const currentTicket = tickets.get(id) ?? ticket;
        return {
          ...currentTicket,
          source: "linear",
          stateName: id === "BAR-H3" ? "Done" : "In Review",
          url: `https://linear.test/${id}`,
        };
      },
      async getStateName(id: string) { return id === "BAR-H3" ? "Done" : "In Review"; },
    };
    const deps = {
      store,
      mastra: {
        async cancelRun() {},
      } as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
    };

    process.env.FACTORY_TEST_PR_STATE = "merged";
    await reconcileRun(deps, store.getRun(ticket.id)!);
    assert.deepEqual(
      [
        store.getRun(ticket.id)?.status,
        store.getRun(ticket.id)?.mergedSha,
        store.getRun(ticket.id)?.smokeStatus,
      ],
      ["done", "b".repeat(40), "skipped-not-configured"]
    );

    const reviewTicket = { ...ticket, id: "BAR-H4", title: "Review stays review" };
    tickets.set(reviewTicket.id, reviewTicket);
    const reviewHash = buildCommentContextSnapshot(
      reviewTicket.id,
      reviewTicket.title,
      reviewTicket.description,
      []
    ).effectiveInputHash;
    store.createRun(reviewTicket.id, "harness", { ...reviewTicket, inputHash: reviewHash });
    store.transition(reviewTicket.id, {
      stage: "review",
      status: "running",
      actor: "test",
      reason: "review-running",
      patch: {
        plan: "plan",
        planFiles: ["src/a.ts"],
        headSha: "a".repeat(40),
        testedSha: "a".repeat(40),
        prUrl: "https://github.test/o/r/pull/2",
      },
    });
    process.env.FACTORY_TEST_PR_STATE = "open";
    await reconcileRun(deps, store.getRun(reviewTicket.id)!);
    assert.deepEqual(
      [store.getRun(reviewTicket.id)?.stage, store.getRun(reviewTicket.id)?.status],
      ["review", "running"]
    );
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPrState === undefined) delete process.env.FACTORY_TEST_PR_STATE;
    else process.env.FACTORY_TEST_PR_STATE = previousPrState;
    await rm(root, { recursive: true, force: true });
  }
});

test("scope: zwykły dodatkowy plik ostrzega, protected i sekrety blokują", () => {
  assert.deepEqual(auditScope(["src/a.ts"], ["src/a.ts", "src/b.ts"]), {
    warnings: ["src/b.ts: poza oczekiwaną listą factory.files"],
    blocked: [],
  });
  assert.equal(auditScope([], [".github/workflows/ci.yml"]).blocked.length, 1);
  assert.equal(auditScope([".env"], [".env"]).blocked.length, 1);
  assert.equal(auditScope(["credentials.json"], ["credentials.json"]).blocked.length, 1);
  assert.equal(auditScope([], ["ops/deploy.sh"]).blocked.length, 1);
  assert.equal(auditScope([".github/workflows/ci.yml"], [".github/workflows/ci.yml"]).blocked.length, 0);
  assert.equal(auditScope(["ops/deploy.sh"], ["ops/deploy.sh"]).blocked.length, 0);
});

test("factoryJob plan działa z fałszywym adapterem jako jeden bezstanowy job", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-job-"));
  const previousRoot = process.env.FACTORY_ROOT;
  process.env.FACTORY_ROOT = root;
  await writeFile(join(root, "package.json"), "{}");
  const fakeEngine: EngineAdapter = {
    name: "fake",
    async run(input) {
      assert.equal(input.sessionId, undefined);
      return {
        ok: true,
        report: [
          "# Plan",
          "```factory",
          '{"verdict":"ok","screenshots":[],"files":["src/a.ts"],"domain":"backend"}',
          "```",
        ].join("\n"),
        costUsd: 0.01,
      };
    },
  };
  const runtime: FactoryJobRuntime = {
    async route() {
      return { engine: fakeEngine, model: "fake-model", spec: "fake/fake-model" };
    },
    async project() {
      return { repo: root, checks: ["true"] };
    },
  };
  try {
    const output = await executeFactoryJobInput({
      kind: "plan",
      attempt: 1,
      ticket: {
        id: "BAR-H1",
        title: "Harness",
        description: "Plan",
        project: "fake",
        labels: [],
        inputHash: "hash",
      },
      planFiles: [],
    }, "job-h1", undefined, runtime);
    assert.equal(output.outcome, "success");
    assert.deepEqual(output.files, ["src/a.ts"]);
    assert.match(output.signature, /fake-model/);
  } finally {
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("migracja v1 importuje zatwierdzony plan/checkpoint i wymaga live read", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-v1-"));
  const ticketDir = join(root, "BAR-M1");
  const runDir = join(ticketDir, "run-1");
  await mkdir(runDir, { recursive: true });
  const plan = [
    "# Plan",
    "```factory",
    '{"verdict":"ok","screenshots":[],"files":["src/a.ts"],"domain":"backend"}',
    "```",
  ].join("\n");
  await writeFile(join(ticketDir, "state.json"), JSON.stringify({
    v: 1,
    ticketId: "BAR-M1",
    project: "br-factory",
    runId: "run-1",
    manifest: { effectiveInputHash: "hash", labels: [] },
    outbox: { start: { body: { id: "BAR-M1", title: "Migrate", description: "D" } } },
  }));
  await writeFile(join(runDir, "approval.json"), JSON.stringify({ approved: true }));
  await writeFile(join(runDir, "plan.md"), plan);
  await writeFile(
    join(runDir, "build-attempt-1.md"),
    `---\noutcome: committed\nsha: ${"e".repeat(40)}\n---\n\nbuild`
  );
  const dbPath = join(root, "v2.db");
  const store = new LifecycleStore(dbPath);
  try {
    const candidate = inspectLegacyV1(root, "BAR-M1");
    assert.equal(candidate.checkpointSha, "e".repeat(40));
    assert.throws(() => validateLiveMigration(candidate, {
      linearState: "In Progress",
      checkpointExists: false,
      historicalCommands: [],
    }), /checkpoint/);
    importLegacyCandidate(store, candidate, {
      linearState: "In Progress",
      checkpointExists: true,
      historicalCommands: [
        { id: "old-approve", command: "approve" },
        { id: "old-restart", command: "restart" },
      ],
    });
    const imported = store.getRun("BAR-M1");
    assert.deepEqual([imported?.stage, imported?.status, imported?.headSha], [
      "test", "pending", "e".repeat(40),
    ]);
    assert.equal(store.isCommentProcessed("old-approve"), true);
    assert.equal(store.isCommentProcessed("old-restart"), true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight przed claimem sprawdza stany, CLI, Mastrę i strict quality", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-preflight-"));
  const previousRoot = process.env.FACTORY_ROOT;
  process.env.FACTORY_ROOT = root;
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "projects.yaml"), [
    "demo:",
    `  repo: ${root}`,
    "  github: owner/repo",
    "  default_branch: main",
    "  checks:",
    "    - npm test",
    "  ci:",
    "    requiredChecks:",
    "      - quality",
  ].join("\n"));
  await writeFile(join(root, "routing.yaml"), [
    "defaults:",
    "  plan: claude-code/sonnet",
    "  build: codex",
    "  review: claude-code/sonnet",
  ].join("\n"));
  try {
    const report = await runPreflight("demo", {
      async linearStateNames() {
        return ["Todo", "In Progress", "In Review", "Done", "Canceled", "👤 ⛔ Zablokowany"];
      },
      async mastraUp() {
        return true;
      },
      async exec(file, args) {
        if (file === "gh" && args[0] === "api") {
          return { stdout: JSON.stringify({ strict: true, contexts: ["quality"] }), stderr: "" };
        }
        if (file === "claude") return { stdout: '{"loggedIn":true}', stderr: "" };
        return { stdout: "/fake/bin\n", stderr: "" };
      },
    });
    assert.equal(report.ok, true);

    const missingLogin = await runPreflight("demo", {
      async linearStateNames() {
        return ["Todo", "In Progress", "In Review", "Done", "Canceled", "👤 ⛔ Zablokowany"];
      },
      async mastraUp() {
        return true;
      },
      async exec(file, args) {
        if (file === "gh" && args[0] === "auth") throw new Error("not logged in");
        if (file === "gh" && args[0] === "api") {
          return { stdout: JSON.stringify({ strict: true, contexts: ["quality"] }), stderr: "" };
        }
        if (file === "claude") return { stdout: '{"loggedIn":true}', stderr: "" };
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(missingLogin.ok, false);
    assert.match(missingLogin.errors.join("\n"), /gh auth/);
  } finally {
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

async function writeHarnessFixture(root: string, extraProjectYaml: string[] = []): Promise<void> {
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "projects.yaml"), [
    "harness:",
    `  repo: ${JSON.stringify(root)}`,
    "  checks:",
    "    - \"true\"",
    ...extraProjectYaml,
  ].join("\n"));
}

test("stall lease: wiszący job Mastry kończy się JOB_STALLED i pozwala na /retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-stall-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const previousGrace = process.env.FACTORY_JOB_GRACE_MIN;
  const store = new LifecycleStore(join(root, "registry.db"));
  const notifications: { title: string; message: string }[] = [];
  const canceled: string[] = [];
  try {
    await writeHarnessFixture(root);
    process.env.FACTORY_ROOT = root;
    // lease = budżet planu (20) + grace (-30) < 0 → natychmiastowy stall bez czekania w teście
    process.env.FACTORY_JOB_GRACE_MIN = "-30";
    let getRunCalls = 0;
    const mastra = {
      async getRun(runId: string) {
        getRunCalls += 1;
        if (getRunCalls === 1) {
          throw new MastraHttpError(404, `/workflows/factoryJob/runs/${runId}`, "missing");
        }
        return { status: "running" };
      },
      async createRun() {},
      async startRun() {},
      async cancelRun(runId: string) { canceled.push(runId); },
    };
    const source = {
      async setStateByName() {},
      async listComments() { return []; },
      async comment() {},
    };
    const deps: PollerDependencies = {
      store,
      mastra: mastra as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async (title, message) => { notifications.push({ title, message }); },
    };
    const run = store.createRun("BAR-S1", "harness", manifest);
    applyDecision(deps, run.ticketId, reduceLifecycle(run, { type: "start" }));
    await dispatchOutbox(deps); // pierwszy tick: create-run + start, komenda dispatched
    await dispatchOutbox(deps); // drugi tick: snapshot "running" po lease → JOB_STALLED
    const blocked = store.getRun("BAR-S1")!;
    assert.deepEqual(
      [blocked.status, blocked.errorCode, blocked.blockedStage],
      ["blocked", "JOB_STALLED", "plan"]
    );
    assert.equal(canceled.length, 1);
    assert.ok(notifications.some(({ title }) => title.includes("zablokowany")));
    assert.equal(store.latestAttempt("BAR-S1", "plan")?.errorCode, "JOB_STALLED");
    const retried = reduceLifecycle(blocked, { type: "retry", commentId: "c1", nextAttempt: 2 });
    assert.equal(retried.transition.stage, "plan");
    assert.equal(retried.commands[0]?.payload.kind, "plan");
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    if (previousGrace === undefined) delete process.env.FACTORY_JOB_GRACE_MIN;
    else process.env.FACTORY_JOB_GRACE_MIN = previousGrace;
    await rm(root, { recursive: true, force: true });
  }
});

test("wyczerpany budżet blokuje ticket z BUDGET_EXHAUSTED i powiadamia", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-budget-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const notifications: { title: string; message: string }[] = [];
  try {
    await writeHarnessFixture(root, ["  budget:", "    maxUsd: 1", "    maxMinutes: 45"]);
    process.env.FACTORY_ROOT = root;
    const source = {
      async setStateByName() {},
      async listComments() { return []; },
      async comment() {},
    };
    const deps: PollerDependencies = {
      store,
      mastra: {
        async getRun() { throw new Error("mastra nie powinna być wołana przy wyczerpanym budżecie"); },
      } as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async (title, message) => { notifications.push({ title, message }); },
    };
    const run = store.createRun("BAR-B1", "harness", manifest);
    applyDecision(deps, run.ticketId, reduceLifecycle(run, { type: "start" }));
    store.startAttempt("BAR-B1", "build", 1, "job-cost");
    store.finishAttempt("BAR-B1", "build", 1, {
      status: "success", outcome: "committed", costUsd: 5, durationMs: 1000,
    });
    await dispatchOutbox(deps);
    const blocked = store.getRun("BAR-B1")!;
    assert.deepEqual([blocked.status, blocked.errorCode], ["blocked", "BUDGET_EXHAUSTED"]);
    assert.ok(notifications.some(({ message }) => message.includes("BUDGET_EXHAUSTED")));
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("outbox: transient dostaje backoff, dead-letter zawsze powiadamia", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-outbox-retry-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const notifications: { title: string; message: string }[] = [];
  let failure: Error = new Error("connect ECONNREFUSED 127.0.0.1:443");
  try {
    await writeHarnessFixture(root);
    process.env.FACTORY_ROOT = root;
    const source = {
      async setStateByName() {},
      async listComments(): Promise<never> { throw failure; },
      async comment() {},
    };
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async (title, message) => { notifications.push({ title, message }); },
    };
    store.createRun("BAR-D1", "harness", manifest);
    const key = "BAR-D1:g1:linear-comment:x";
    store.enqueue({ key, ticketId: "BAR-D1", kind: "linear-comment", stage: "plan", payload: { body: "hi" } });

    await dispatchOutbox(deps);
    const afterTransient = store.getCommand(key)!;
    assert.equal(afterTransient.state, "pending");
    assert.ok(
      Date.parse(afterTransient.availableAt) > Date.now() + 20_000,
      `backoff powinien odsunąć availableAt: ${afterTransient.availableAt}`
    );
    assert.equal(store.outstandingCommands().some((command) => command.key === key), false);
    assert.equal(notifications.length, 0);

    // Wymuś dostępność + drugi (ostatni) permanentny błąd → dead-letter z alertem.
    failure = new Error("walidacja: brak treści komentarza");
    store.markCommand(key, "pending", { retryAt: new Date(Date.now() - 1000).toISOString() });
    await dispatchOutbox(deps);
    assert.equal(store.getCommand(key)!.state, "failed");
    assert.ok(notifications.some(({ title }) => title.includes("dead-letter")));
    // linear-comment nie jest lifecycle-critical: run nie może być zablokowany.
    assert.notEqual(store.getRun("BAR-D1")!.status, "blocked");
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("notyfikacje: plan-ready przechodzi przez lejek applyDecision dokładnie raz", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-notify-"));
  const store = new LifecycleStore(join(dir, "registry.db"));
  const notifications: { title: string; message: string }[] = [];
  try {
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map(),
      notifier: async (title, message) => { notifications.push({ title, message }); },
    };
    const run = store.createRun("BAR-N1", "harness", manifest);
    applyDecision(deps, run.ticketId, reduceLifecycle(run, { type: "start" }));
    assert.equal(notifications.length, 0);
    applyDecision(deps, run.ticketId, reduceLifecycle(store.getRun("BAR-N1")!, {
      type: "job-finished", attempt: 1, output: planOutput,
    }));
    assert.equal(notifications.length, 1);
    assert.ok(notifications[0].title.includes("plan do akceptacji"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
