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
import {
  reduceLifecycle,
  type CoordinatorEvent,
} from "../pipeline/coordinator";
import {
  reconcileRun,
  type PollerDependencies,
} from "../sources/poll-linear-v2";
import { buildCommentContextSnapshot } from "../sources/comment-context";

const manifest: TicketManifestV2 = {
  title: "Komenda fix",
  description: "Builder poprawia kod według uwag review.",
  labels: [],
  inputHash: "fix-input-hash",
};

function apply(
  store: LifecycleStore,
  run: LifecycleRun,
  event: CoordinatorEvent,
  acknowledgeCommandKey?: string
): LifecycleRun {
  const decision = reduceLifecycle(run, event);
  return store.transition(run.ticketId, {
    ...decision.transition,
    commands: decision.commands,
    acknowledgeCommandKey,
  });
}

test("/fix przechodzi pełną ścieżkę na tym samym planie, branchu i PR oraz trwa w SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-fix-command-"));
  const db = join(dir, "registry.db");
  let store = new LifecycleStore(db);
  try {
    const oldSha = "a".repeat(40);
    const newSha = "b".repeat(40);
    const prUrl = "https://github.test/o/r/pull/191";
    const branch = "agent/BAR-FIX-1-komenda-fix";
    let run = store.createRun("BAR-FIX-1", "br-factory", manifest);
    run = store.transition(run.ticketId, {
      stage: "merge",
      status: "waiting_human",
      actor: "test",
      reason: "review-advisory-fix",
      patch: {
        plan: "zatwierdzony plan",
        planFiles: ["src/a.ts", "src/b.ts"],
        planDomain: "backend",
        approvedAt: "2026-07-30T10:00:00.000Z",
        branch,
        workspaceDir: "/tmp/BAR-FIX-1",
        headSha: oldSha,
        testedSha: oldSha,
        prUrl,
        reviewStatus: "advisory-fix",
      },
    });
    store.startAttempt(run.ticketId, "review", 1, "review-job-1", { sha: oldSha });
    store.finishAttempt(run.ticketId, "review", 1, {
      status: "success",
      outcome: "advisory-fix",
      report: "BUG: claimReady pomija executedCommandIds.",
      signature: "ai-factory · claude · opus · reviewer",
      sha: oldSha,
      durationMs: 1,
    });
    const reviewAttempt = store.latestAttempt(run.ticketId, "review")!;

    run = apply(store, run, {
      type: "fix",
      commentId: "comment-fix-1",
      hints: "Zachowaj istniejący kontrakt.",
      reviewReport: reviewAttempt.report,
      reviewSha: reviewAttempt.sha,
      nextAttempt: store.nextAttempt(run.ticketId, "build"),
    });
    assert.deepEqual([run.stage, run.status, run.fixRound], ["build", "running", 1]);
    assert.equal(run.generation, 1);
    assert.equal(run.plan, "zatwierdzony plan");
    assert.deepEqual(run.planFiles, ["src/a.ts", "src/b.ts"]);
    assert.equal(run.branch, branch);
    assert.equal(run.prUrl, prUrl);
    const buildCommand = store.outstandingCommands(20).find((command) =>
      command.kind === "run-job" && command.payload.kind === "build"
    )!;
    assert.equal(buildCommand.payload.headSha, oldSha);
    assert.match(String(buildCommand.payload.feedback), /claimReady pomija executedCommandIds/);
    assert.match(String(buildCommand.payload.feedback), /Zachowaj istniejący kontrakt/);

    store.startAttempt(run.ticketId, "build", 1, "build-job-1", { sha: oldSha });
    store.finishAttempt(run.ticketId, "build", 1, {
      status: "success",
      outcome: "success",
      report: "poprawiono",
      signature: "ai-factory · codex · gpt · builder",
      sha: newSha,
      durationMs: 1,
    });
    run = apply(store, run, {
      type: "job-finished",
      attempt: 1,
      output: {
        kind: "build",
        outcome: "success",
        report: "poprawiono",
        signature: "ai-factory · codex · gpt · builder",
        durationMs: 1,
        files: ["src/a.ts", "src/b.ts"],
        branch,
        workspaceDir: "/tmp/BAR-FIX-1",
        headSha: newSha,
        changedFiles: ["src/a.ts"],
        scopeWarnings: [],
      },
    }, buildCommand.key);
    assert.deepEqual([run.stage, run.status, run.headSha], ["test", "pending", newSha]);

    run = apply(store, run, {
      type: "test-result",
      ok: true,
      sha: newSha,
      report: "exact-SHA pass",
    });
    const publishCommand = store.outstandingCommands(20).find((command) =>
      command.kind === "publish-pr" && command.payload.sha === newSha
    )!;
    assert.equal(publishCommand.payload.branch, branch);

    run = apply(store, run, {
      type: "published",
      prUrl,
      branch,
      sha: newSha,
    }, publishCommand.key);
    assert.deepEqual(
      [run.stage, run.status, run.prUrl, run.branch, run.headSha, run.testedSha],
      ["ci", "waiting_external", prUrl, branch, newSha, newSha]
    );

    run = apply(store, run, {
      type: "ci-result",
      outcome: "pass",
      sha: newSha,
      report: "CI pass",
      nextReviewAttempt: store.nextAttempt(run.ticketId, "review"),
    });
    const reviewCommand = store.outstandingCommands(20).find((command) =>
      command.kind === "run-job" && command.payload.kind === "review"
    )!;
    assert.deepEqual([run.stage, run.status, run.reviewStatus], ["review", "running", "running"]);
    assert.equal(reviewCommand.payload.attempt, 2);
    assert.equal(reviewCommand.payload.headSha, newSha);

    const externalSha = "c".repeat(40);
    let changed = store.createRun("BAR-FIX-HEAD", "br-factory", {
      ...manifest,
      inputHash: "head-change",
    });
    changed = store.transition(changed.ticketId, {
      stage: "ci",
      status: "waiting_external",
      actor: "test",
      reason: "fixture-ci",
      patch: {
        plan: "plan",
        planFiles: ["src/a.ts"],
        branch: "agent/BAR-FIX-HEAD",
        headSha: newSha,
        testedSha: newSha,
        prUrl: "https://github.test/o/r/pull/192",
        reviewStatus: "lgtm",
      },
    });
    store.enqueue({
      key: "BAR-FIX-HEAD:g1:job:review:review:a1",
      ticketId: changed.ticketId,
      kind: "run-job",
      stage: "review",
      payload: { kind: "review", attempt: 1 },
    });
    changed = apply(store, changed, { type: "pr-head-changed", sha: externalSha });
    assert.deepEqual(
      [changed.stage, changed.status, changed.headSha, changed.testedSha, changed.reviewStatus],
      ["test", "pending", externalSha, undefined, "pending"]
    );
    assert.equal(
      store.getCommand("BAR-FIX-HEAD:g1:job:review:review:a1")?.lastError,
      "canceled-by-replan"
    );

    store.close();
    store = new LifecycleStore(db);
    assert.equal(store.getRun("BAR-FIX-1")?.fixRound, 1);
    assert.equal(store.getRun("BAR-FIX-HEAD")?.fixRound, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("poller pobiera raport bieżącego review dla /fix i ignoruje stary PR head podczas builda", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-fix-poller-"));
  const bin = join(root, "bin");
  const previousRoot = process.env.FACTORY_ROOT;
  const previousPath = process.env.PATH;
  const store = new LifecycleStore(join(root, "registry.db"));
  const ticket = {
    id: "BAR-FIX-POLLER",
    title: "Fix z pollera",
    description: "Pobierz raport review z trwałego rejestru.",
    labels: [] as string[],
  };
  const comments = [{
    id: "comment-fix-poller",
    body: "/fix zachowaj kompatybilność",
    createdAt: "2026-07-30T12:00:00.000Z",
  }];
  try {
    await mkdir(bin);
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(root)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    const stalePrSha = "d".repeat(40);
    const gh = join(bin, "gh");
    await writeFile(gh, [
      "#!/bin/sh",
      `printf '%s\\n' '${JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeCommit: null,
        headRefOid: stalePrSha,
      })}'`,
    ].join("\n"));
    await chmod(gh, 0o755);
    process.env.FACTORY_ROOT = root;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;

    const headSha = "a".repeat(40);
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
      reason: "review-advisory-fix",
      patch: {
        plan: "zatwierdzony plan",
        planFiles: ["src/a.ts"],
        branch: "agent/BAR-FIX-POLLER",
        workspaceDir: "/tmp/BAR-FIX-POLLER",
        headSha,
        testedSha: headSha,
        prUrl: "https://github.test/o/r/pull/193",
        reviewStatus: "advisory-fix",
      },
    });
    store.startAttempt(ticket.id, "review", 1, "review-job-poller", { sha: headSha });
    store.finishAttempt(ticket.id, "review", 1, {
      status: "success",
      outcome: "advisory-fix",
      report: "BUG: form znika po structuredClone.",
      signature: "ai-factory · claude · opus · reviewer",
      sha: headSha,
      durationMs: 1,
    });

    const source = {
      async listComments() { return comments; },
      async getTicket() {
        return {
          ...ticket,
          source: "linear",
          stateName: "In Review",
          url: `https://linear.test/${ticket.id}`,
        };
      },
      async getStateName() { return "In Review"; },
      async comment() {},
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
    const fixed = store.getRun(ticket.id)!;
    const buildCommand = store.outstandingCommands(30).find((command) =>
      command.kind === "run-job" && command.payload.kind === "build"
    )!;
    assert.deepEqual([fixed.stage, fixed.status, fixed.fixRound], ["build", "running", 1]);
    assert.equal(fixed.headSha, headSha);
    assert.notEqual(fixed.headSha, stalePrSha);
    assert.match(String(buildCommand.payload.feedback), /form znika po structuredClone/);
    assert.match(String(buildCommand.payload.feedback), /zachowaj kompatybilność/);
    assert.equal(store.isCommentProcessed("comment-fix-poller"), true);
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
