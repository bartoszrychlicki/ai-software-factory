import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  ensureSingleWriter,
  localExactShaCiResult,
  maybeBackupLifecycleDb,
  pollOnce,
  reconcileRun,
  sweepScores,
  type PollerDependencies,
} from "../sources/poll-linear-v2";
import { MastraHttpError } from "../sources/mastra-client";
import { buildCommentContextSnapshot } from "../sources/comment-context";
import {
  POLLER_SIGNATURE,
  type ActionSignature,
} from "../pipeline/signature";
import { createTestGitRepo, useTestWorktrees } from "./git-fixture";

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
      costSource: undefined,
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
    critiqueRound: 0,
    fixRound: 0,
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
    critiqueRound: 0,
    fixRound: 0,
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

test("literówka komendy dostaje dokładnie jeden hint bez replanu i zmiany input hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-unknown-command-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const ticket = {
    id: "BAR-184",
    title: "Bramki odporne na literówki",
    description: "Opis",
    labels: [] as string[],
  };
  const comments = [{
    id: "comment-typo",
    body: "/anwser cokolwiek",
    createdAt: "2026-07-29T10:00:00.000Z",
  }];
  try {
    await writeHarnessFixture(root);
    process.env.FACTORY_ROOT = root;
    const inputHash = buildCommentContextSnapshot(
      ticket.id,
      ticket.title,
      ticket.description,
      []
    ).effectiveInputHash;
    store.createRun(ticket.id, "harness", { ...ticket, inputHash });
    store.transition(ticket.id, {
      stage: "approval",
      status: "waiting_human",
      actor: "test",
      reason: "plan-ready",
      patch: { plan: "plan", planFiles: ["src/a.ts"], planDomain: "backend" },
    });

    const source = {
      async listComments() { return comments; },
      async getTicket() {
        return {
          ...ticket,
          source: "linear",
          stateName: "In Progress",
          url: `https://linear.test/${ticket.id}`,
        };
      },
      async getStateName() { return "In Progress"; },
      async setStateByName() {},
      async comment(_ticketId: string, body: string) {
        comments.push({
          id: `factory-${comments.length}`,
          body,
          createdAt: "2026-07-29T10:01:00.000Z",
        });
      },
    };
    const deps: PollerDependencies = {
      store,
      mastra: {
        async cancelRun() {},
      } as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async () => {},
    };

    await reconcileRun(deps, store.getRun(ticket.id)!);
    const hintCommands = store.outstandingCommands(100).filter((command) =>
      command.kind === "linear-comment" &&
      command.key === `${ticket.id}:g1:unknown-command:comment-typo`
    );
    assert.equal(hintCommands.length, 1);
    assert.match(String(hintCommands[0].payload.body), /Nieznana komenda `\/anwser`/);
    assert.equal(hintCommands[0].payload.progress, undefined);
    assert.equal(store.isCommentProcessed("comment-typo"), true);
    assert.equal(store.getRun(ticket.id)?.generation, 1);
    assert.equal(store.getRun(ticket.id)?.manifest.inputHash, inputHash);

    await dispatchOutbox(deps);
    const postedHints = comments.filter((comment) => comment.body.includes("Nieznana komenda"));
    assert.equal(postedHints.length, 1);
    assert.match(postedHints[0].body, /\[linear:BAR-184:v2\]/);
    assert.match(
      postedHints[0].body,
      /\[factory-outbox:BAR-184:g1:unknown-command:comment-typo\]/
    );
    const snapshotWithHint = buildCommentContextSnapshot(
      ticket.id,
      ticket.title,
      ticket.description,
      comments
    );
    assert.equal(snapshotWithHint.effectiveInputHash, inputHash);

    await reconcileRun(deps, store.getRun(ticket.id)!);
    assert.equal(comments.filter((comment) => comment.body.includes("Nieznana komenda")).length, 1);
    assert.equal(store.getRun(ticket.id)?.generation, 1);
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("autoformatowane /approve przechodzi przez processCommands do builda", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-formatted-approve-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const ticket = {
    id: "BAR-193",
    title: "Parser toleruje autoformat Lineara",
    description: "Opis",
    labels: [] as string[],
  };
  const comments = [{
    id: "comment-formatted-approve",
    body: "/`approve`",
    createdAt: "2026-07-30T10:00:00.000Z",
  }];
  try {
    await writeHarnessFixture(root);
    process.env.FACTORY_ROOT = root;
    const inputHash = buildCommentContextSnapshot(
      ticket.id,
      ticket.title,
      ticket.description,
      []
    ).effectiveInputHash;
    store.createRun(ticket.id, "harness", { ...ticket, inputHash });
    store.transition(ticket.id, {
      stage: "approval",
      status: "waiting_human",
      actor: "test",
      reason: "plan-ready",
      patch: { plan: "plan", planFiles: ["src/a.ts"], planDomain: "backend" },
    });
    const source = {
      async listComments() { return comments; },
      async getTicket() {
        return {
          ...ticket,
          source: "linear",
          stateName: "In Progress",
          url: `https://linear.test/${ticket.id}`,
        };
      },
      async getStateName() { return "In Progress"; },
    };
    const deps: PollerDependencies = {
      store,
      mastra: {
        async cancelRun() {},
      } as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async () => {},
    };

    await reconcileRun(deps, store.getRun(ticket.id)!);
    const approved = store.getRun(ticket.id)!;
    assert.deepEqual([approved.stage, approved.status], ["build", "running"]);
    assert.equal(store.hasOutstandingJob(ticket.id), true);
    assert.equal(store.isCommentProcessed("comment-formatted-approve"), true);
    assert.equal(
      store.outstandingCommands(100).some((command) =>
        command.key.includes(":unknown-command:")
      ),
      false
    );
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

async function exerciseScopeCommand(
  body: string,
  ticketId: string,
  options: { extraBodies?: string[]; commentFailures?: number } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "factory-scope-command-"));
  const dbPath = join(root, "registry.db");
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(dbPath);
  const ticket = {
    id: ticketId,
    title: "Autoryzacja chronionej ścieżki",
    description: "Opis",
    labels: [] as string[],
  };
  const comments = [body, ...(options.extraBodies ?? [])].map((commentBody, index) => ({
    id: index === 0 ? `comment-${ticketId}` : `comment-${ticketId}-${index}`,
    body: commentBody,
    createdAt: `2026-07-30T10:00:0${index}.000Z`,
  }));
  let commentFailures = options.commentFailures ?? 0;
  try {
    await writeHarnessFixture(root);
    process.env.FACTORY_ROOT = root;
    const inputHash = buildCommentContextSnapshot(
      ticket.id,
      ticket.title,
      ticket.description,
      []
    ).effectiveInputHash;
    store.createRun(ticket.id, "harness", { ...ticket, inputHash });
    store.transition(ticket.id, {
      stage: "build",
      status: "blocked",
      actor: "builder",
      reason: "SCOPE_BLOCKED",
      patch: {
        plan: "zatwierdzony plan",
        planFiles: ["e2e/foo.spec.ts"],
        planDomain: "backend",
        approvedAt: "2026-07-30T09:55:00.000Z",
        blockedStage: "build",
        errorCode: "SCOPE_BLOCKED",
        // Format 1:1 jak w factory-job.ts — marker audytu jest jedynym źródłem
        // autoryzowalnych ścieżek (raport agenta powyżej nie jest zaufany).
        errorMessage:
          "Raport buildera\n\nPublikacja zablokowana:\n" +
          "- e2e/scripts/run-e2e.ts: chroniona ścieżka nie została zatwierdzona w planie",
      },
    });
    const source = {
      async listComments() { return comments; },
      async getTicket() {
        return {
          ...ticket,
          source: "linear",
          stateName: "In Progress",
          url: `https://linear.test/${ticket.id}`,
        };
      },
      async getStateName() { return "In Progress"; },
      async comment(_commentTicketId: string, commentBody: string) {
        if (commentFailures > 0) {
          commentFailures -= 1;
          throw new Error("LINEAR_COMMENT_FAILED");
        }
        comments.push({
          id: `factory-${comments.length}`,
          body: commentBody,
          createdAt: "2026-07-30T10:01:00.000Z",
        });
      },
    };
    const deps: PollerDependencies = {
      store,
      mastra: {
        async cancelRun() {},
      } as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async () => {},
    };

    await reconcileRun(deps, store.getRun(ticket.id)!);
    const after = store.getRun(ticket.id)!;
    const commands = store.outstandingCommands(100);
    const build = commands.find((command) =>
      command.kind === "run-job" && command.payload.kind === "build"
    );
    const milestone = commands.find((command) =>
      command.kind === "linear-comment" && command.payload.progress === "milestones"
    );
    const auditDb = new DatabaseSync(dbPath);
    const lastTransition = auditDb.prepare(`
      SELECT reason
      FROM lifecycle_transitions
      WHERE ticket_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(ticket.id) as { reason: string };
    auditDb.close();
    const snapshot = buildCommentContextSnapshot(
      ticket.id,
      ticket.title,
      ticket.description,
      comments
    );

    return {
      after,
      build,
      milestone,
      transitionReason: lastTransition.reason,
      processed: store.isCommentProcessed(`comment-${ticketId}`),
      processedExtra: (options.extraBodies ?? []).map((_, index) =>
        store.isCommentProcessed(`comment-${ticketId}-${index + 1}`)
      ),
      comments: comments.map((comment) => comment.body),
      inputHash,
      effectiveInputHash: snapshot.effectiveInputHash,
    };
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}

test("/scope przechodzi przez processCommands, zapisuje audyt i nie zmienia input hash", async () => {
  const result = await exerciseScopeCommand(
    "/scope e2e/scripts/run-e2e.ts",
    "BAR-SCOPE-OK"
  );

  assert.deepEqual([result.after.stage, result.after.status], ["build", "running"]);
  assert.deepEqual(result.after.planFiles, [
    "e2e/foo.spec.ts",
    "e2e/scripts/run-e2e.ts",
  ]);
  assert.equal(
    result.transitionReason,
    "/scope comment-BAR-SCOPE-OK: e2e/scripts/run-e2e.ts"
  );
  assert.deepEqual(result.build?.payload.planFiles, result.after.planFiles);
  assert.match(String(result.build?.payload.feedback), /chroniona ścieżka/);
  assert.match(String(result.build?.key), /:scope:comment-BAR-SCOPE-OK$/);
  assert.equal(result.milestone?.payload.progress, "milestones");
  assert.match(String(result.milestone?.payload.body), /🔓.*e2e\/scripts\/run-e2e\.ts/);
  assert.equal(result.processed, true);
  assert.equal(result.effectiveInputHash, result.inputHash);
});

test("/scope sekretu pozostawia blokadę, odmawia z wyjaśnieniem i nie zmienia input hash", async () => {
  const result = await exerciseScopeCommand("/scope .env", "BAR-SCOPE-SECRET");

  assert.deepEqual([result.after.stage, result.after.status], ["build", "blocked"]);
  assert.deepEqual(result.after.planFiles, ["e2e/foo.spec.ts"]);
  assert.equal(result.build, undefined);
  assert.equal(result.transitionReason, "SCOPE_BLOCKED");
  assert.ok(result.comments.some((body) =>
    body.includes("Zakres nie został rozszerzony") &&
    body.includes("nieodwracalna szkoda") &&
    body.includes("/replan <powód>") &&
    body.includes("[linear:BAR-SCOPE-SECRET:v2]")
  ));
  assert.equal(result.processed, true);
  assert.equal(result.effectiveInputHash, result.inputHash);
});

test("/scope odrzuca skopiowaną linię raportu zamiast wykonywać pozorne przejście", async () => {
  const result = await exerciseScopeCommand(
    "/scope - e2e/scripts/run-e2e.ts: chroniona ścieżka nie została zatwierdzona w planie",
    "BAR-SCOPE-NOISE"
  );

  assert.deepEqual([result.after.stage, result.after.status], ["build", "blocked"]);
  assert.deepEqual(result.after.planFiles, ["e2e/foo.spec.ts"]);
  assert.equal(result.build, undefined);
  assert.equal(result.transitionReason, "SCOPE_BLOCKED");
  assert.ok(result.comments.some((body) =>
    body.includes("Zakres nie został rozszerzony") &&
    body.includes("e2e/scripts/run-e2e.ts:") &&
    body.includes("chroniona") &&
    body.includes("bieżącym raporcie SCOPE_BLOCKED")
  ));
  assert.equal(result.processed, true);
});

test("/scope bez przejścia nie zatrzymuje kolejnej komendy w tym samym cyklu", async () => {
  const result = await exerciseScopeCommand(
    "/scope .env",
    "BAR-SCOPE-CONTINUE",
    { extraBodies: ["/replan popraw listę plików"] }
  );

  assert.equal(result.after.status, "running");
  assert.equal(result.after.generation, 2);
  assert.equal(result.transitionReason, "/replan comment-BAR-SCOPE-CONTINUE-1");
  assert.equal(result.processed, true);
  assert.deepEqual(result.processedExtra, [true]);
});

test("/scope ponawia odmowę po błędzie komentarza bez mylącego komunikatu", async () => {
  const result = await exerciseScopeCommand(
    "/scope .env",
    "BAR-SCOPE-COMMENT-FAIL",
    { commentFailures: 1 }
  );

  assert.deepEqual([result.after.stage, result.after.status], ["build", "blocked"]);
  assert.deepEqual(result.after.planFiles, ["e2e/foo.spec.ts"]);
  assert.equal(result.transitionReason, "SCOPE_BLOCKED");
  assert.equal(result.processed, false);
  assert.equal(result.comments.some((body) => body.includes("jest teraz niedozwolona")), false);
});

test("sweep Done odpowiada hintem /score na nierozpoznaną próbę komendy", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-unknown-score-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const comments = [{
    id: "comment-score-typo",
    body: "/scroe 5",
    createdAt: "2026-07-29T10:00:00.000Z",
  }];
  try {
    await writeHarnessFixture(root);
    process.env.FACTORY_ROOT = root;
    store.createRun("BAR-SCORE-TYPO", "harness", manifest);
    store.transition("BAR-SCORE-TYPO", {
      stage: "smoke",
      status: "done",
      actor: "test",
      reason: "done",
    });
    const source = {
      async listComments() { return comments; },
      async setStateByName() {},
      async comment(_ticketId: string, body: string) {
        comments.push({
          id: `factory-${comments.length}`,
          body,
          createdAt: "2026-07-29T10:01:00.000Z",
        });
      },
    };
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async () => {},
    };

    await sweepScores(deps);
    assert.equal(store.isCommentProcessed("comment-score-typo"), true);
    const hint = store.outstandingCommands(100).find((command) =>
      command.key === "BAR-SCORE-TYPO:g1:unknown-command:comment-score-typo"
    );
    assert.match(String(hint?.payload.body), /`\/score 1-5 \[komentarz\]`/);

    await dispatchOutbox(deps);
    assert.equal(comments.filter((comment) => comment.body.includes("Nieznana komenda")).length, 1);
    assert.match(comments[1].body, /\[linear:BAR-SCORE-TYPO:v2\]/);
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
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
    critiqueRound: 0,
    fixRound: 0,
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

test("komentarze wynikające z joba zachowują podpis jego faktycznej roli", () => {
  const plannerSignature = "ai-factory · claude-code@2.1 · claude-fable-5@high · planner";
  const builderSignature = "ai-factory · codex@0.44 · gpt-5.6-sol@high · builder";
  const reviewerSignature = "ai-factory · claude-code@2.1 · claude-opus-4@high · reviewer";
  const planRun: LifecycleRun = {
    ticketId: "BAR-SIG1",
    project: "br-factory",
    generation: 1,
    stage: "plan",
    status: "running",
    manifest,
    planFiles: [],
    clarifyRound: 0,
    critiqueRound: 0,
    fixRound: 0,
    createdAt: "x",
    updatedAt: "x",
  };
  const questionsOutput: FactoryJobOutput = {
    kind: "plan",
    outcome: "questions",
    report: "potrzebuję odpowiedzi",
    questions: "1. Tryb?",
    signature: plannerSignature,
    durationMs: 1,
    files: [],
    changedFiles: [],
    scopeWarnings: [],
  };
  const questions = reduceLifecycle(planRun, {
    type: "job-finished",
    attempt: 1,
    output: questionsOutput,
  });
  assert.equal(questions.commands[0].payload.signature, plannerSignature);

  const maxQuestions = reduceLifecycle(
    { ...planRun, clarifyRound: 2 },
    { type: "job-finished", attempt: 3, output: questionsOutput }
  );
  assert.equal(maxQuestions.commands[0].payload.signature, plannerSignature);

  const ready = reduceLifecycle(planRun, {
    type: "job-finished",
    attempt: 2,
    output: {
      ...planOutput,
      signature: plannerSignature,
    },
  });
  assert.equal(ready.commands[0].payload.signature, plannerSignature);

  const failedPlan = reduceLifecycle(planRun, {
    type: "job-finished",
    attempt: 1,
    output: {
      ...questionsOutput,
      outcome: "failed",
      questions: undefined,
      errorCode: "PLAN_ENGINE_FAILED",
    },
  });
  assert.equal(failedPlan.commands[0].payload.signature, plannerSignature);

  const buildRun: LifecycleRun = {
    ...planRun,
    ticketId: "BAR-SIG2",
    stage: "build",
    plan: "plan",
  };
  const failedBuild = reduceLifecycle(buildRun, {
    type: "job-finished",
    attempt: 1,
    output: {
      kind: "build",
      outcome: "failed",
      report: "builder failed",
      errorCode: "BUILD_ENGINE_FAILED",
      signature: builderSignature,
      durationMs: 1,
      files: ["src/a.ts"],
      changedFiles: [],
      scopeWarnings: [],
    },
  });
  assert.equal(failedBuild.commands[0].payload.signature, builderSignature);

  const reviewRun: LifecycleRun = {
    ...planRun,
    ticketId: "BAR-SIG3",
    stage: "review",
    headSha: "a".repeat(40),
    prUrl: "https://github.test/o/r/pull/1",
    reviewStatus: "unavailable",
  };
  const unavailableReview: FactoryJobOutput = {
    kind: "review",
    outcome: "failed",
    report: "review unavailable",
    signature: reviewerSignature,
    durationMs: 1,
    files: [],
    changedFiles: [],
    scopeWarnings: [],
    reviewVerdict: "unavailable",
  };
  const failedReview = reduceLifecycle(reviewRun, {
    type: "job-finished",
    attempt: 2,
    output: unavailableReview,
  });
  assert.equal(failedReview.commands[0].payload.signature, reviewerSignature);

  const advisory = reduceLifecycle(
    { ...reviewRun, reviewStatus: "running" },
    {
      type: "job-finished",
      attempt: 3,
      output: {
        ...unavailableReview,
        outcome: "success",
        reviewVerdict: "advisory-fix",
      },
    }
  );
  assert.equal(advisory.commands[0].payload.signature, reviewerSignature);
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
  assert.deepEqual(parseCommand("/fix"), { kind: "fix", payload: undefined });
  assert.deepEqual(parseCommand("/fix popraw oba race condition"), {
    kind: "fix",
    payload: "popraw oba race condition",
  });
  assert.equal(parseCommand("/replan"), undefined);
});

function reviewFixRun(patch: Partial<LifecycleRun> = {}): LifecycleRun {
  return {
    ticketId: "BAR-FIX",
    project: "br-factory",
    generation: 4,
    stage: "merge",
    status: "waiting_human",
    manifest,
    plan: "zatwierdzony plan",
    planFiles: ["src/a.ts", "src/b.ts"],
    clarifyRound: 0,
    critiqueRound: 0,
    fixRound: 0,
    branch: "agent/BAR-FIX-lifecycle-v2",
    workspaceDir: "/tmp/BAR-FIX",
    headSha: "a".repeat(40),
    testedSha: "a".repeat(40),
    prUrl: "https://github.test/o/r/pull/191",
    reviewStatus: "advisory-fix",
    reviewReport: "BUG: hash nie obejmuje executedCommandIds.",
    createdAt: "x",
    updatedAt: "x",
    ...patch,
  };
}

test("/fix zachowuje plan, branch i generację oraz przekazuje review z podpowiedzią do buildera", () => {
  const run = reviewFixRun();
  const decision = reduceLifecycle(run, {
    type: "fix",
    commentId: "comment-fix-1",
    hints: "Najpierw zabezpiecz hash.",
    nextAttempt: 7,
  });
  const after = {
    ...run,
    ...decision.transition.patch,
    stage: decision.transition.stage,
    status: decision.transition.status,
  };
  const build = decision.commands.find((command) =>
    command.kind === "run-job" && command.payload.kind === "build"
  );
  const prComment = decision.commands.find((command) => command.kind === "comment-pr");

  assert.deepEqual([after.stage, after.status], ["build", "running"]);
  assert.equal(after.generation, run.generation);
  assert.equal(after.plan, run.plan);
  assert.deepEqual(after.planFiles, run.planFiles);
  assert.equal(after.branch, run.branch);
  assert.equal(after.fixRound, 1);
  assert.equal(after.reviewStatus, "advisory-fix");
  assert.equal(decision.transition.incrementGeneration, undefined);
  assert.equal(build?.payload.attempt, 7);
  assert.equal(build?.payload.plan, run.plan);
  assert.deepEqual(build?.payload.planFiles, run.planFiles);
  assert.equal(build?.payload.headSha, run.headSha);
  assert.match(String(build?.payload.feedback), /hash nie obejmuje executedCommandIds/);
  assert.match(String(build?.payload.feedback), /Najpierw zabezpiecz hash/);
  assert.match(String(build?.key), /:fix:comment-fix-1$/);
  assert.match(String(prComment?.payload.body), /runda 1\/2/);
  assert.match(String(prComment?.payload.body), /inicjowana przez człowieka/);
});

test("/fix odmawia bez advisory-fix i poza bramką merge", () => {
  assert.throws(
    () => reduceLifecycle(reviewFixRun({ reviewStatus: "lgtm" }), {
      type: "fix",
      commentId: "comment-lgtm",
    }),
    /Review dało `lgtm`/
  );
  assert.throws(
    () => reduceLifecycle(reviewFixRun({ stage: "review", status: "running" }), {
      type: "fix",
      commentId: "comment-review",
    }),
    /wyłącznie na bramce merge/
  );
});

test("/fix ma limit dwóch rund w generacji i odsyła do /replan", () => {
  const first = reduceLifecycle(reviewFixRun(), {
    type: "fix",
    commentId: "comment-fix-1",
  });
  assert.equal(first.transition.patch?.fixRound, 1);

  const secondRun = reviewFixRun({ fixRound: 1 });
  const second = reduceLifecycle(secondRun, {
    type: "fix",
    commentId: "comment-fix-2",
  });
  assert.equal(second.transition.patch?.fixRound, 2);

  assert.throws(
    () => reduceLifecycle(reviewFixRun({ fixRound: 2 }), {
      type: "fix",
      commentId: "comment-fix-3",
    }),
    /Wyczerpano 2\/2.*\/replan/
  );

  const replanned = reduceLifecycle(reviewFixRun({ fixRound: 2 }), {
    type: "replan",
    commentId: "comment-replan",
    reason: "potrzebna trzecia korekta",
  });
  assert.equal(replanned.transition.incrementGeneration, true);
  assert.equal(replanned.transition.patch?.fixRound, 0);
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
    critiqueRound: 0,
    fixRound: 0,
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

test("mark-pr-ready dopiero po werdykcie review; komentarz przed zdjęciem draftu", () => {
  const base: LifecycleRun = {
    ticketId: "BAR-R1",
    project: "br-factory",
    generation: 1,
    stage: "ci",
    status: "waiting_external",
    manifest,
    planFiles: ["src/a.ts"],
    clarifyRound: 0,
    critiqueRound: 0,
    fixRound: 0,
    branch: "agent/BAR-R1",
    headSha: "a".repeat(40),
    testedSha: "a".repeat(40),
    prUrl: "https://github.test/o/r/pull/9",
    createdAt: "x",
    updatedAt: "x",
  };
  const ciPass = reduceLifecycle(base, {
    type: "ci-result", outcome: "pass", sha: base.headSha!, report: "quality", nextReviewAttempt: 1,
  });
  assert.deepEqual(ciPass.commands.map((command) => command.kind), ["run-job"]);

  const reviewRun: LifecycleRun = { ...base, stage: "review", status: "running", reviewStatus: "running" };
  const verdict = reduceLifecycle(reviewRun, {
    type: "job-finished",
    attempt: 1,
    output: {
      kind: "review",
      outcome: "success",
      report: "uwagi doradcze",
      signature: "reviewer",
      durationMs: 1,
      files: [],
      changedFiles: [],
      scopeWarnings: [],
      headSha: base.headSha,
      reviewVerdict: "advisory-fix",
    },
  });
  // Komentarz recenzenta istnieje ZANIM PR wyjdzie z draftu; advisory nadal nie blokuje.
  assert.deepEqual(verdict.commands.map((command) => command.kind), ["comment-pr", "mark-pr-ready"]);
  assert.equal(
    verdict.commands.some((command) =>
      command.kind === "run-job" && command.payload.kind === "build"
    ),
    false
  );
  assert.deepEqual([verdict.transition.stage, verdict.transition.status], ["merge", "waiting_human"]);
});

test("/retry review: bez werdyktu ponawia joba, z werdyktem tylko mark-pr-ready", () => {
  const blockedReview: LifecycleRun = {
    ticketId: "BAR-R2",
    project: "br-factory",
    generation: 1,
    stage: "review",
    status: "blocked",
    manifest,
    planFiles: [],
    clarifyRound: 0,
    critiqueRound: 0,
    fixRound: 0,
    headSha: "b".repeat(40),
    prUrl: "https://github.test/o/r/pull/10",
    blockedStage: "review",
    errorCode: "REVIEW_UNAVAILABLE",
    reviewStatus: "unavailable",
    createdAt: "x",
    updatedAt: "x",
  };
  const jobRetry = reduceLifecycle(blockedReview, { type: "retry", commentId: "c1", nextAttempt: 3 });
  assert.deepEqual(jobRetry.commands.map((command) => command.kind), ["run-job"]);
  assert.deepEqual([jobRetry.transition.stage, jobRetry.transition.status], ["review", "running"]);

  const readyRetry = reduceLifecycle(
    { ...blockedReview, errorCode: "OUTBOX_FAILED", reviewStatus: "lgtm" },
    { type: "retry", commentId: "c2" }
  );
  assert.deepEqual(readyRetry.commands.map((command) => command.kind), ["mark-pr-ready"]);
  assert.deepEqual([readyRetry.transition.stage, readyRetry.transition.status], ["merge", "waiting_human"]);

  const stalled = reduceLifecycle(
    { ...blockedReview, errorCode: "JOB_STALLED", reviewStatus: "running" },
    { type: "retry", commentId: "c3", nextAttempt: 2 }
  );
  assert.deepEqual(stalled.commands.map((command) => command.kind), ["run-job"]);
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
    // Realny stan review/running zawsze ma job w outboxie — bez niego strażnik
    // zombie słusznie by zablokował (JOB_MISSING).
    store.enqueue({
      key: `${reviewTicket.id}:g1:job:review:review:a1`,
      ticketId: reviewTicket.id,
      kind: "run-job",
      stage: "review",
      payload: { kind: "review", attempt: 1 },
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
    // recordRunOutcome (fire-and-forget) może jeszcze dopisywać stan breakera.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
  const restoreWorktrees = useTestWorktrees(root);
  process.env.FACTORY_ROOT = root;
  await writeFile(join(root, "package.json"), "{}");
  const repo = createTestGitRepo(root);
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
      return { repo, default_branch: "main", checks: ["true"] };
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
    restoreWorktrees();
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

test("linear-comment zachowuje podpis plannera po retry outboxu i restarcie store", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-signature-retry-"));
  const db = join(root, "registry.db");
  const previousRoot = process.env.FACTORY_ROOT;
  let store = new LifecycleStore(db);
  const signatureLine = "ai-factory · claude-code@2.1 · claude-fable-5@high · planner";
  const expectedSignature: ActionSignature = {
    agent: "ai-factory",
    harness: "claude-code@2.1",
    model: "claude-fable-5@high",
    profile: "planner",
  };
  const received: (ActionSignature | undefined)[] = [];
  let commentAttempts = 0;
  try {
    await writeHarnessFixture(root);
    process.env.FACTORY_ROOT = root;
    let run = store.createRun("BAR-SIG4", "harness", manifest);
    run = apply(store, run, {
      type: "job-finished",
      attempt: 1,
      output: {
        kind: "plan",
        outcome: "questions",
        report: "potrzebuję odpowiedzi",
        questions: "1. Tryb?",
        signature: signatureLine,
        durationMs: 1,
        files: [],
        changedFiles: [],
        scopeWarnings: [],
      },
    });
    const key = "BAR-SIG4:g1:linear-comment:questions:1";
    assert.equal(store.getCommand(key)?.payload.signature, signatureLine);

    const source = {
      async setStateByName() {},
      async listComments() { return []; },
      async comment(_id: string, _body: string, signature?: ActionSignature) {
        received.push(signature);
        commentAttempts += 1;
        if (commentAttempts === 1) {
          throw new Error("connect ECONNRESET 127.0.0.1:443");
        }
      },
    };
    let deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async () => {},
    };

    await dispatchOutbox(deps);
    assert.equal(store.getCommand(key)?.state, "pending");
    assert.equal(store.getCommand(key)?.payload.signature, signatureLine);

    store.close();
    store = new LifecycleStore(db);
    assert.equal(store.getCommand(key)?.payload.signature, signatureLine);
    store.markCommand(key, "pending", {
      retryAt: new Date(Date.now() - 1000).toISOString(),
    });
    deps = { ...deps, store };
    await dispatchOutbox(deps);

    assert.equal(store.getCommand(key)?.state, "done");
    assert.deepEqual(received, [expectedSignature, expectedSignature]);
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("komentarz spoza joba i niepoprawny podpis próby dostają podpis pollera", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-signature-fallback-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const received: (ActionSignature | undefined)[] = [];
  try {
    await writeHarnessFixture(root);
    process.env.FACTORY_ROOT = root;
    store.createRun("BAR-SIG5", "harness", manifest);
    const run = store.transition("BAR-SIG5", {
      stage: "test",
      status: "pending",
      actor: "test",
      reason: "checkpoint",
      patch: {
        plan: "plan",
        planFiles: ["src/a.ts"],
        headSha: "a".repeat(40),
      },
    });
    const decision = reduceLifecycle(run, {
      type: "test-result",
      ok: false,
      sha: run.headSha!,
      report: "e2e failed",
    });
    store.transition(run.ticketId, {
      ...decision.transition,
      commands: decision.commands,
    });
    const commentCommand = decision.commands.find((command) => command.kind === "linear-comment");
    assert.equal(commentCommand?.payload.signature, undefined);
    store.enqueue({
      key: "BAR-SIG5:g1:linear-comment:invalid-signature",
      ticketId: run.ticketId,
      kind: "linear-comment",
      stage: "plan",
      payload: {
        body: "job zakończył się przed zbudowaniem podpisu",
        signature: "ai-factory · unavailable · unavailable · unavailable",
      },
    });

    const source = {
      async setStateByName() {},
      async listComments() { return []; },
      async comment(_id: string, _body: string, signature?: ActionSignature) {
        received.push(signature);
      },
    };
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async () => {},
    };
    await dispatchOutbox(deps);

    assert.deepEqual(received, [POLLER_SIGNATURE, POLLER_SIGNATURE]);
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

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

async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("warunek nie został spełniony w czasie");
}

test("backupTo tworzy spójną kopię na żywo, a usageSince liczy koszt godzinowy", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-backup-"));
  const store = new LifecycleStore(join(root, "registry.db"));
  try {
    store.createRun("BAR-K1", "harness", manifest);
    store.startAttempt("BAR-K1", "plan", 1, "job-k1");
    store.finishAttempt("BAR-K1", "plan", 1, {
      status: "success", outcome: "ok", costUsd: 2.5, durationMs: 1000,
    });
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    assert.equal(store.usageSince(hourAgo), 2.5);
    assert.equal(store.usageSince(new Date(Date.now() + 60_000).toISOString()), 0);

    const backupPath = join(root, "backups", "lifecycle-copy.db");
    store.backupTo(backupPath);
    const copy = new LifecycleStore(backupPath);
    try {
      assert.equal(copy.getRun("BAR-K1")?.ticketId, "BAR-K1");
      assert.equal(copy.latestAttempt("BAR-K1", "plan")?.costUsd, 2.5);
    } finally {
      copy.close();
    }

    // maybeBackupLifecycleDb: pierwszy przebieg tworzy plik, drugi w tym samym dniu nie.
    const dir = join(root, "auto-backups");
    maybeBackupLifecycleDb(store, dir);
    maybeBackupLifecycleDb(store, dir);
    const { readdirSync } = await import("node:fs");
    assert.equal(readdirSync(dir).filter((name) => name.endsWith(".db")).length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("single-writer lease: żywy cudzy poller blokuje start, martwy jest przejmowany", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-lease-"));
  const store = new LifecycleStore(join(root, "registry.db"));
  try {
    ensureSingleWriter(store, 11111, () => true);
    assert.equal(store.readLease()?.pid, 11111);

    assert.throws(
      () => ensureSingleWriter(store, 22222, () => true),
      /PID 11111/
    );
    // Ten sam PID może odnowić własny lease.
    ensureSingleWriter(store, 11111, () => true);
    // Martwy właściciel jest przejmowany mimo świeżego heartbeatu.
    ensureSingleWriter(store, 22222, () => false);
    assert.equal(store.readLease()?.pid, 22222);

    store.renewLease(22222);
    store.releaseLease(11111); // zły PID nie zwalnia
    assert.equal(store.readLease()?.pid, 22222);
    store.releaseLease(22222);
    assert.equal(store.readLease(), undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("otwarty circuit breaker zatrzymuje claim nowych ticketów i powiadamia raz", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-breaker-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const notifications: string[] = [];
  let listReadyCalls = 0;
  try {
    await writeHarnessFixture(root);
    await mkdir(join(root, "runs"), { recursive: true });
    await writeFile(join(root, "runs", "circuit-breaker.json"), JSON.stringify({
      openedAt: new Date().toISOString(),
      reason: "3 nieudane runy z rzędu",
      failStreak: 3,
    }));
    process.env.FACTORY_ROOT = root;
    const source = {
      async listReady() { listReadyCalls += 1; return []; },
      async listStateNames() { return []; },
    };
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async (title) => { notifications.push(title); },
    };
    await pollOnce(deps);
    await pollOnce(deps);
    assert.equal(listReadyCalls, 0);
    assert.equal(notifications.filter((title) => title.includes("Circuit breaker")).length, 1);
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("porażka fabryki nabija serię breakera, decyzja człowieka nie", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-streak-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const breakerFile = join(root, "runs", "circuit-breaker.json");
  const failedPlan: FactoryJobOutput = {
    kind: "plan",
    outcome: "failed",
    report: "engine down",
    errorCode: "PLAN_ENGINE_FAILED",
    signature: "sig",
    durationMs: 1,
    files: [],
    changedFiles: [],
    scopeWarnings: [],
  };
  try {
    await writeHarnessFixture(root);
    process.env.FACTORY_ROOT = root;
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map(),
      notifier: async () => {},
    };
    const run = store.createRun("BAR-CB1", "harness", manifest);
    applyDecision(deps, run.ticketId, reduceLifecycle(run, { type: "start" }));
    applyDecision(deps, run.ticketId, reduceLifecycle(store.getRun("BAR-CB1")!, {
      type: "job-finished", attempt: 1, output: failedPlan,
    }));
    await eventually(async () => {
      try {
        return (JSON.parse(await readFile(breakerFile, "utf8")) as { failStreak: number }).failStreak === 1;
      } catch {
        return false;
      }
    });

    // PLAN_REJECTED (decyzja człowieka) nie zwiększa serii.
    const run2 = store.createRun("BAR-CB2", "harness", manifest);
    applyDecision(deps, run2.ticketId, reduceLifecycle(run2, { type: "start" }));
    applyDecision(deps, run2.ticketId, reduceLifecycle(store.getRun("BAR-CB2")!, {
      type: "job-finished", attempt: 1, output: planOutput,
    }));
    applyDecision(deps, run2.ticketId, reduceLifecycle(store.getRun("BAR-CB2")!, {
      type: "reject", commentId: "c-rej", reason: "nie teraz",
    }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      (JSON.parse(await readFile(breakerFile, "utf8")) as { failStreak: number }).failStreak,
      1
    );
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("detached test runner: wynik z synchronizacją main przechodzi do publish", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-runner-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  try {
    await writeHarnessFixture(root);
    process.env.FACTORY_ROOT = root;
    const source = {
      async setStateByName() {},
      async listComments() { return []; },
      async comment() {},
    };
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async () => {},
      spawnTestRunner: (input) => {
        mkdirSync(join(root, "runs", input.ticketId), { recursive: true });
        writeFileSync(input.resultPath, JSON.stringify({
          ok: true,
          requestedSha: input.sha,
          finalSha: shaB,
          report: "checks ok po merge z main",
          durationMs: 12,
        }));
        return process.pid;
      },
    };
    store.createRun("BAR-TR1", "harness", manifest);
    store.transition("BAR-TR1", {
      stage: "test",
      status: "pending",
      actor: "test",
      reason: "checkpoint",
      patch: {
        plan: "plan",
        planFiles: ["src/a.ts"],
        branch: "agent/BAR-TR1",
        headSha: shaA,
        approvedAt: "2026-07-29T10:00:00Z",
      },
    });
    store.enqueue({
      key: `BAR-TR1:g1:run-tests:${shaA}`,
      ticketId: "BAR-TR1",
      kind: "run-tests",
      stage: "test",
      payload: { sha: shaA, attempt: 1 },
    });
    await dispatchOutbox(deps); // spawn (stub zapisuje wynik natychmiast)
    await dispatchOutbox(deps); // odczyt wyniku → branch-synchronized + test-result
    const run = store.getRun("BAR-TR1")!;
    assert.deepEqual(
      [run.stage, run.status, run.headSha, run.testedSha],
      ["publish", "pending", shaB, shaB]
    );
    assert.equal(store.getCommand(`BAR-TR1:g1:run-tests:${shaA}`)?.state, "done");
    assert.equal(store.latestAttempt("BAR-TR1", "test")?.outcome, "pass");
    assert.ok(store.getCommand(`BAR-TR1:g1:publish:${shaB}`), "publish-pr powinien być w outboxie");
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("martwy runner testów bez pliku wyniku blokuje z TEST_RUNNER_DIED", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-runner-dead-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const notifications: string[] = [];
  try {
    await writeHarnessFixture(root);
    process.env.FACTORY_ROOT = root;
    const source = {
      async setStateByName() {},
      async listComments() { return []; },
      async comment() {},
    };
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async (title) => { notifications.push(title); },
      spawnTestRunner: () => 999_999, // PID spoza zakresu = natychmiast martwy
    };
    store.createRun("BAR-TR2", "harness", manifest);
    store.transition("BAR-TR2", {
      stage: "test",
      status: "pending",
      actor: "test",
      reason: "checkpoint",
      patch: { plan: "plan", planFiles: [], headSha: "c".repeat(40), approvedAt: "2026-07-29T10:00:00Z" },
    });
    store.enqueue({
      key: `BAR-TR2:g1:run-tests:${"c".repeat(40)}`,
      ticketId: "BAR-TR2",
      kind: "run-tests",
      stage: "test",
      payload: { sha: "c".repeat(40), attempt: 1 },
    });
    await dispatchOutbox(deps); // spawn martwego PID-a
    await dispatchOutbox(deps); // brak wyniku + martwy PID → blocked
    const run = store.getRun("BAR-TR2")!;
    assert.deepEqual([run.status, run.errorCode], ["blocked", "TEST_RUNNER_DIED"]);
    assert.ok(notifications.some((title) => title.includes("zablokowany")));
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("kolizja planFiles odsuwa build drugiego ticketu bez zużywania prób", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-defer-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  try {
    await writeHarnessFixture(root);
    process.env.FACTORY_ROOT = root;
    const deps: PollerDependencies = {
      store,
      mastra: {
        async getRun() { return { status: "running" }; },
      } as unknown as PollerDependencies["mastra"],
      sources: new Map(),
      notifier: async () => {},
    };
    // Ticket A: wcześniej zatwierdzony build w toku (dispatched job).
    store.createRun("BAR-A", "harness", manifest);
    store.transition("BAR-A", {
      stage: "build", status: "running", actor: "test", reason: "building",
      patch: { plan: "plan", planFiles: ["src/shared.ts"], approvedAt: "2026-07-29T10:00:00Z" },
    });
    store.enqueue({
      key: "BAR-A:g1:job:build:build:a1",
      ticketId: "BAR-A",
      kind: "run-job",
      stage: "build",
      payload: { kind: "build", attempt: 1 },
      externalId: "job-a",
    });
    store.startAttempt("BAR-A", "build", 1, "job-a");
    // Ticket B: później zatwierdzony, build jeszcze nie wystartował.
    store.createRun("BAR-B", "harness", manifest);
    store.transition("BAR-B", {
      stage: "build", status: "running", actor: "test", reason: "building",
      patch: { plan: "plan", planFiles: ["src/shared.ts", "src/b.ts"], approvedAt: "2026-07-29T10:05:00Z" },
    });
    const keyB = "BAR-B:g1:job:build:build:a1";
    store.enqueue({
      key: keyB,
      ticketId: "BAR-B",
      kind: "run-job",
      stage: "build",
      payload: { kind: "build", attempt: 1 },
    });
    await dispatchOutbox(deps);
    const deferred = store.getCommand(keyB)!;
    assert.equal(deferred.state, "pending");
    assert.equal(deferred.attempts, 0, "defer nie zużywa prób");
    assert.ok(
      Date.parse(deferred.availableAt) > Date.now() + 4 * 60_000,
      `availableAt powinno być odsunięte: ${deferred.availableAt}`
    );
    assert.ok(store.getCommand("BAR-B:g1:defer:BAR-A"), "komentarz o kolizji powinien być w outboxie");
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight rejestruje wersje CLI i ostrzega przy zmianie harnessu", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-versions-"));
  const previousRoot = process.env.FACTORY_ROOT;
  process.env.FACTORY_ROOT = root;
  try {
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "projects.yaml"), [
      "demo:",
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
    const preflightDeps = (version: string) => ({
      async linearStateNames() {
        return ["Todo", "In Progress", "In Review", "Done", "Canceled", "👤 ⛔ Zablokowany"];
      },
      async mastraUp() { return true; },
      async exec(file: string, args: readonly string[]) {
        if (args[0] === "--version") return { stdout: `cli ${version} (build abc)\n`, stderr: "" };
        if (file === "claude") return { stdout: '{"loggedIn":true}', stderr: "" };
        return { stdout: "/fake/bin\n", stderr: "" };
      },
    });
    const first = await runPreflight("demo", preflightDeps("0.44.0"));
    assert.equal(first.warnings.some((warning) => warning.includes("zmienił wersję")), false);
    assert.equal(existsSync(join(root, "runs", "cli-versions.json")), true);

    const second = await runPreflight("demo", preflightDeps("0.45.0"));
    assert.ok(
      second.warnings.some((warning) => /zmienił wersję: 0\.44\.0 → 0\.45\.0/.test(warning)),
      `oczekiwano warninga o zmianie wersji, dostałem: ${second.warnings.join(" | ")}`
    );
  } finally {
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("incydent BAR-177: /retry po komendzie anulowanej przed dispatchem tworzy NOWY job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-retry-key-"));
  const store = new LifecycleStore(join(dir, "registry.db"));
  try {
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map(),
      notifier: async () => {},
    };
    let run = store.createRun("BAR-RK1", "harness", manifest);
    applyDecision(deps, run.ticketId, reduceLifecycle(run, { type: "start" }));
    applyDecision(deps, run.ticketId, reduceLifecycle(store.getRun("BAR-RK1")!, {
      type: "job-finished", attempt: 1, output: planOutput,
    }));
    // /approve enqueue'uje build a1...
    applyDecision(deps, run.ticketId, reduceLifecycle(store.getRun("BAR-RK1")!, {
      type: "approve", commentId: "c-approve", nextAttempt: 1,
    }));
    assert.equal(store.hasOutstandingJob("BAR-RK1"), true);
    assert.ok(
      store.outstandingCommands(100).some((command) =>
        command.kind === "linear-comment" &&
        command.payload.progress === "milestones" &&
        String(command.payload.body).includes("build startuje")
      ),
      "/approve musi atomowo enqueue'ować milestone startu builda"
    );
    // ...ale sekundę później wejście się zmienia: blokada + cancel PRZED dispatchem
    // (zero prób w rejestrze → nextAttempt dalej zwróci 1).
    applyDecision(deps, run.ticketId, reduceLifecycle(store.getRun("BAR-RK1")!, {
      type: "input-changed", inputHash: "hash-2",
    }));
    assert.equal(store.getRun("BAR-RK1")!.errorCode, "INPUT_CHANGED_AFTER_BUILD");
    assert.equal(store.hasOutstandingJob("BAR-RK1"), false);
    // /retry z tym samym numerem próby NIE może kolidować z anulowaną komendą.
    applyDecision(deps, run.ticketId, reduceLifecycle(store.getRun("BAR-RK1")!, {
      type: "retry", commentId: "c-retry", nextAttempt: 1,
    }));
    run = store.getRun("BAR-RK1")!;
    assert.deepEqual([run.stage, run.status], ["build", "running"]);
    assert.equal(store.hasOutstandingJob("BAR-RK1"), true, "retry musi zostawić żywy job w outboxie");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("incydent BAR-180 g2: /replan anuluje joby starej generacji, NIE zjadając joba nowej", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-replan-order-"));
  const store = new LifecycleStore(join(dir, "registry.db"));
  try {
    const deps: PollerDependencies = {
      store,
      mastra: {
        async cancelRun() {},
      } as unknown as PollerDependencies["mastra"],
      sources: new Map(),
      notifier: async () => {},
    };
    let run = store.createRun("BAR-RO1", "harness", manifest);
    applyDecision(deps, run.ticketId, reduceLifecycle(run, { type: "start" }));
    store.markCommand("BAR-RO1:g1:job:plan:plan:a1", "dispatched", { externalId: "job-old" });
    assert.equal(store.hasOutstandingJob("BAR-RO1"), true);

    applyDecision(deps, run.ticketId, reduceLifecycle(store.getRun("BAR-RO1")!, {
      type: "replan",
      commentId: "c-replan",
      reason: "nowa koncepcja",
      nextAttempts: { plan: 2 },
    }));
    run = store.getRun("BAR-RO1")!;
    assert.deepEqual([run.generation, run.stage, run.status], [2, "plan", "running"]);
    // Stary job anulowany, nowy PRZEŻYŁ tę samą transakcję.
    assert.equal(store.getCommand("BAR-RO1:g1:job:plan:plan:a1")?.lastError, "canceled-by-replan");
    assert.equal(store.getCommand("BAR-RO1:g2:job:plan:plan:a2")?.state, "pending");
    assert.equal(store.hasOutstandingJob("BAR-RO1"), true, "run nowej generacji nie może rodzić się jako zombie");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("strażnik zombie: running bez joba w outboxie blokuje z JOB_MISSING", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-zombie-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const notifications: string[] = [];
  try {
    await writeHarnessFixture(root);
    process.env.FACTORY_ROOT = root;
    const ticket = { id: "BAR-Z1", title: "Zombie", description: "opis", labels: [] as string[] };
    const inputHash = buildCommentContextSnapshot(ticket.id, ticket.title, ticket.description, [])
      .effectiveInputHash;
    store.createRun(ticket.id, "harness", { ...ticket, inputHash });
    store.transition(ticket.id, {
      stage: "build", status: "running", actor: "test", reason: "zombie-setup",
      patch: { plan: "plan", planFiles: [], approvedAt: "2026-07-29T10:00:00Z" },
    });
    const source = {
      async listComments() { return []; },
      async getTicket() { return { ...ticket, source: "linear", stateName: "In Progress", url: "" }; },
      async getStateName() { return "In Progress"; },
    };
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async (title) => { notifications.push(title); },
    };
    await reconcileRun(deps, store.getRun(ticket.id)!);
    const run = store.getRun(ticket.id)!;
    assert.deepEqual([run.status, run.errorCode], ["blocked", "JOB_MISSING"]);
    assert.ok(notifications.some((title) => title.includes("zablokowany")));
    // /retry po JOB_MISSING enqueue'uje świeży job (unikalny klucz).
    applyDecision(deps, ticket.id, reduceLifecycle(run, { type: "retry", commentId: "c-z", nextAttempt: 1 }));
    assert.equal(store.hasOutstandingJob(ticket.id), true);
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

test("fallback planu zapisuje degradację i renderuje ją na bramce", () => {
  const run: LifecycleRun = {
    ticketId: "BAR-FB-GATE",
    project: "harness",
    generation: 1,
    stage: "plan",
    status: "running",
    manifest,
    planFiles: [],
    clarifyRound: 0,
    critiqueRound: 0,
    fixRound: 0,
    createdAt: "x",
    updatedAt: "x",
  };
  const decision = reduceLifecycle(run, {
    type: "job-finished",
    attempt: 1,
    output: {
      ...planOutput,
      signature: "ai-factory · fallback@1.0 · backup-model@high · planner",
      engineFallback: {
        from: "primary/primary-model@high",
        to: "fallback/backup-model@high",
        reason: "failed to lookup address information",
      },
    },
  });
  const degradations = decision.transition.patch?.degradations ?? [];
  assert.match(degradations.join("\n"), /plan \(próba \d+\) wykonany silnikiem zapasowym fallback\/backup-model@high/);
  assert.match(String(decision.commands[0].payload.body), /Degradacje/);
  assert.match(String(decision.commands[0].payload.body), /failed to lookup address information/);
});

test("fallback buildu dodaje jawny komentarz Linear z podpisem użytego modelu", () => {
  const run: LifecycleRun = {
    ticketId: "BAR-FB-BUILD-COMMENT",
    project: "harness",
    generation: 1,
    stage: "build",
    status: "running",
    manifest,
    plan: "plan",
    planFiles: ["src/a.ts"],
    clarifyRound: 0,
    critiqueRound: 0,
    fixRound: 0,
    createdAt: "x",
    updatedAt: "x",
  };
  const signature = "ai-factory · fallback@1.0 · backup-model@high · builder";
  const decision = reduceLifecycle(run, {
    type: "job-finished",
    attempt: 2,
    output: {
      kind: "build",
      outcome: "success",
      report: "build",
      signature,
      durationMs: 2,
      files: ["src/a.ts"],
      branch: "agent/BAR-FB-BUILD-COMMENT",
      workspaceDir: "/tmp/worktree",
      headSha: "a".repeat(40),
      changedFiles: ["src/a.ts"],
      scopeWarnings: [],
      engineFallback: {
        from: "primary/primary-model@high",
        to: "fallback/backup-model@high",
        reason: "failed to connect to websocket",
      },
    },
  });
  const comment = decision.commands.find((command) => command.kind === "linear-comment");
  assert.ok(comment);
  assert.match(String(comment.payload.body), /^⚠️ build \(próba \d+\) wykonany silnikiem zapasowym/);
  assert.equal(comment.payload.signature, signature);
  assert.match((decision.transition.patch?.degradations ?? []).join("\n"), /websocket/);
});

test("job-finished bez fallbacku nie zmienia degradacji", () => {
  const run: LifecycleRun = {
    ticketId: "BAR-FB-NONE",
    project: "harness",
    generation: 1,
    stage: "plan",
    status: "running",
    manifest,
    planFiles: [],
    clarifyRound: 0,
    critiqueRound: 0,
    fixRound: 0,
    degradations: ["istniejąca degradacja"],
    createdAt: "x",
    updatedAt: "x",
  };
  const decision = reduceLifecycle(run, {
    type: "job-finished",
    attempt: 1,
    output: planOutput,
  });
  assert.equal(decision.transition.patch?.degradations, undefined);
});

test("zapas nie ma osobnej bramki budżetu; chroni bramka zlecenia joba", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-fallback-budget-headroom-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const captured = new Map<string, boolean>();
  try {
    await writeHarnessFixture(root, [
      "  budget:",
      "    maxUsd: 100",
      // plan ma 20 min: pusty ticket mieści dwie próby (40 < 45), a ticket
      // z 10 min użycia mieści główną (30 < 45), lecz nie zapas (50 >= 45).
      "    maxMinutes: 45",
    ]);
    process.env.FACTORY_ROOT = root;
    const mastra = {
      async getRun(runId: string) {
        throw new MastraHttpError(404, `/workflows/factoryJob/runs/${runId}`, "missing");
      },
      async createRun() {},
      async startRun(_runId: string, inputData: Record<string, unknown>) {
        const inputTicket = inputData.ticket as { id?: string };
        captured.set(String(inputTicket.id), inputData.allowEngineFallback === true);
      },
    };
    const deps: PollerDependencies = {
      store,
      mastra: mastra as unknown as PollerDependencies["mastra"],
      sources: new Map(),
      notifier: async () => {},
    };

    for (const id of ["BAR-FB-ROOM", "BAR-FB-TIGHT"]) {
      store.createRun(id, "harness", { ...manifest, inputHash: `hash-${id}` });
      store.transition(id, {
        stage: "plan",
        status: "running",
        actor: "test",
        reason: "budget-fixture",
      });
      if (id === "BAR-FB-TIGHT") {
        // Budżet ticketu już wyczerpany (50 >= 45): job nie zostanie zlecony,
        // więc pytanie o zapas w ogóle nie powstaje.
        store.startAttempt(id, "build", 1, `historic-${id}`);
        store.finishAttempt(id, "build", 1, {
          status: "success",
          outcome: "committed",
          costUsd: 0,
          durationMs: 50 * 60_000,
        });
      }
      store.enqueue({
        key: `${id}:g1:job:plan:plan:a1`,
        ticketId: id,
        kind: "run-job",
        stage: "plan",
        payload: {
          kind: "plan",
          attempt: 1,
          ticket: {
            id,
            title: manifest.title,
            description: manifest.description,
            project: "harness",
            labels: [],
            inputHash: `hash-${id}`,
          },
          planFiles: [],
        },
      });
    }

    await dispatchOutbox(deps);
    // Zapas nie ma osobnej bramki budżetu: uruchamiają go wyłącznie tanie,
    // wczesne pady, więc druga próba mieści się w rezerwacji pierwszej.
    // Ochroną pozostaje istniejąca bramka na poziomie zlecenia joba.
    assert.equal(captured.get("BAR-FB-ROOM"), true);
    assert.equal(captured.has("BAR-FB-TIGHT"), false, "ticket bez miejsca na jedną próbę nie startuje");
    assert.equal(store.getRun("BAR-FB-TIGHT")?.errorCode, "BUDGET_EXHAUSTED");
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
