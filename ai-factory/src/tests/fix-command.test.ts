import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  dispatchOutbox,
  reconcileRun,
  type PollerDependencies,
} from "../sources/poll-linear-v2";
import { buildCommentContextSnapshot } from "../sources/comment-context";
import { parseCommand } from "../sources/commands";
import {
  FIX_HINTS_CLIP_CHARS,
  REVIEW_CLIP_CHARS,
} from "../pipeline/factory-job";
import { POLLER_SIGNATURE, signatureLine } from "../pipeline/signature";

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

function mergeGateRun(patch: Partial<LifecycleRun> = {}): LifecycleRun {
  return {
    ticketId: "BAR-FIX-UNIT",
    project: "br-factory",
    generation: 3,
    stage: "merge",
    status: "waiting_human",
    manifest,
    plan: "zatwierdzony plan",
    planFiles: ["src/a.ts", "src/b.ts"],
    clarifyRound: 0,
    critiqueRound: 0,
    fixRound: 0,
    branch: "agent/BAR-FIX-UNIT",
    workspaceDir: "/tmp/BAR-FIX-UNIT",
    headSha: "a".repeat(40),
    testedSha: "a".repeat(40),
    prUrl: "https://github.test/o/r/pull/191",
    reviewStatus: "advisory-fix",
    reviewReport: "BUG: hash nie obejmuje executedCommandIds.",
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    ...patch,
  };
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
        reviewReport: "BUG: claimReady pomija executedCommandIds.",
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

    run = apply(store, run, {
      type: "fix",
      commentId: "comment-fix-1",
      hints: "Zachowaj istniejący kontrakt.",
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
    assert.equal(buildCommand.payload.buildBase, "continue-branch");
    assert.equal(buildCommand.payload.branch, branch);
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
    assert.equal(run.reviewReport, "BUG: claimReady pomija executedCommandIds.");
    run = apply(store, run, { type: "pr-head-changed", sha: externalSha });
    assert.deepEqual(
      [
        run.stage,
        run.status,
        run.headSha,
        run.testedSha,
        run.reviewStatus,
        run.reviewReport,
      ],
      ["test", "pending", externalSha, undefined, "pending", undefined]
    );
    assert.equal(run.testedSha, undefined);
    assert.equal(run.reviewStatus, "pending");
    assert.equal(
      store.getCommand(reviewCommand.key)?.lastError,
      "canceled-by-replan"
    );

    store.close();
    store = new LifecycleStore(db);
    assert.equal(store.getRun("BAR-FIX-1")?.fixRound, 1);
    assert.equal(store.getRun("BAR-FIX-1")?.reviewReport, undefined);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("branch-synchronized czyści review tylko dla istniejącego PR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-fix-branch-sync-"));
  const store = new LifecycleStore(join(dir, "registry.db"));
  try {
    const previousSha = "a".repeat(40);
    const synchronizedSha = "b".repeat(40);
    const createTestRun = (
      ticketId: string,
      prUrl: string | undefined
    ): LifecycleRun => {
      store.createRun(ticketId, "br-factory", manifest);
      return store.transition(ticketId, {
        stage: "test",
        status: "running",
        actor: "test",
        reason: "fixture-branch-synchronized",
        patch: {
          headSha: previousSha,
          prUrl,
          reviewStatus: "advisory-fix",
          reviewReport: "BUG",
        },
      });
    };

    let withPr = createTestRun(
      "BAR-FIX-BRANCH-SYNC-PR",
      "https://github.test/o/r/pull/198"
    );
    withPr = apply(store, withPr, {
      type: "branch-synchronized",
      previousSha,
      sha: synchronizedSha,
    });
    assert.equal(withPr.reviewStatus, "pending");
    assert.equal(withPr.reviewReport, undefined);

    let withoutPr = createTestRun("BAR-FIX-BRANCH-SYNC-NO-PR", undefined);
    withoutPr = apply(store, withoutPr, {
      type: "branch-synchronized",
      previousSha,
      sha: synchronizedSha,
    });
    assert.equal(withoutPr.reviewStatus, "advisory-fix");
    assert.equal(withoutPr.reviewReport, "BUG");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("feedback /fix zaczyna się od guardrailu i mieści pełny payload przed limitem runBuild", () => {
  const hints = "H".repeat(10_000);
  const reviewReport = "R".repeat(12_000);
  const decision = reduceLifecycle(mergeGateRun({ reviewReport }), {
    type: "fix",
    commentId: "comment-long-feedback",
    hints,
    nextAttempt: 7,
  });
  const build = decision.commands.find((command) =>
    command.kind === "run-job" && command.payload.kind === "build"
  );
  const feedback = String(build?.payload.feedback);
  const instruction = [
    "# Instrukcja",
    "Poprawiaj wyłącznie w granicach zatwierdzonego planu; nie rozszerzaj zakresu.",
    "Nie zmieniaj plików spoza planu, nie refaktoruj przy okazji.",
    "Uwagi review są advisory — oceń każdą i odrzuć w raporcie tę, która jest błędna.",
  ].join("\n");

  assert.equal(feedback.indexOf("# Instrukcja"), 0);
  assert.ok(feedback.startsWith(instruction));
  assert.equal(feedback.slice(0, 16_000), feedback);
  assert.match(feedback, new RegExp(`obcięte do ${REVIEW_CLIP_CHARS} znaków`));
  assert.match(feedback, new RegExp(`obcięte do ${FIX_HINTS_CLIP_CHARS} znaków`));
  assert.ok(feedback.includes("H".repeat(FIX_HINTS_CLIP_CHARS)));
  assert.ok(!feedback.includes("H".repeat(FIX_HINTS_CLIP_CHARS + 1)));
});

test("/fix odmawia dla lgtm, poza bramką merge i bez raportu bieżącego review", () => {
  assert.throws(
    () => reduceLifecycle(mergeGateRun({ reviewStatus: "lgtm" }), {
      type: "fix",
      commentId: "comment-lgtm",
    }),
    /Review dało `lgtm`/
  );
  for (const run of [
    mergeGateRun({ stage: "approval", status: "waiting_human" }),
    mergeGateRun({ stage: "build", status: "running" }),
  ]) {
    assert.throws(
      () => reduceLifecycle(run, { type: "fix", commentId: "comment-wrong-stage" }),
      /wyłącznie na bramce merge/
    );
  }
  assert.throws(
    () => reduceLifecycle(mergeGateRun({ reviewReport: undefined }), {
      type: "fix",
      commentId: "comment-no-report",
    }),
    /Brak raportu review dla bieżącego head SHA/
  );
});

test("drugi /fix przechodzi, trzeci odsyła do /replan, a nowa generacja resetuje licznik i raport", () => {
  const second = reduceLifecycle(mergeGateRun({ fixRound: 1 }), {
    type: "fix",
    commentId: "comment-fix-2",
  });
  assert.equal(second.transition.patch?.fixRound, 2);
  const secondBuild = second.commands.find((command) =>
    command.kind === "run-job" && command.payload.kind === "build"
  );
  assert.equal(secondBuild?.payload.buildBase, "continue-branch");
  assert.equal(secondBuild?.payload.branch, "agent/BAR-FIX-UNIT");

  assert.throws(
    () => reduceLifecycle(mergeGateRun({ fixRound: 2 }), {
      type: "fix",
      commentId: "comment-fix-3",
    }),
    /Wyczerpano 2\/2.*\/replan/
  );

  const replanned = reduceLifecycle(mergeGateRun({ fixRound: 2 }), {
    type: "replan",
    commentId: "comment-replan",
    reason: "trzecia korekta wymaga nowego planu",
  });
  assert.equal(replanned.transition.incrementGeneration, true);
  assert.equal(replanned.transition.patch?.fixRound, 0);
  assert.equal(replanned.transition.patch?.reviewReport, undefined);
});

test("/fix po merge odmawia przed pozostałymi guardami", () => {
  assert.throws(
    () => reduceLifecycle(mergeGateRun({
      stage: "smoke",
      status: "pending",
      mergedSha: "b".repeat(40),
    }), {
      type: "fix",
      commentId: "comment-after-merge",
    }),
    /PR jest już zmergowany/
  );
});

test("review advisory-fix utrwala clipowany raport, ale nigdy samo nie dispatchuje buildera", () => {
  const report = "B".repeat(REVIEW_CLIP_CHARS + 100);
  const decision = reduceLifecycle(mergeGateRun({
    stage: "review",
    status: "running",
    reviewStatus: "running",
    reviewReport: undefined,
  }), {
    type: "job-finished",
    attempt: 1,
    output: {
      kind: "review",
      outcome: "success",
      report,
      signature: "ai-factory · claude · opus · reviewer",
      durationMs: 1,
      files: [],
      changedFiles: [],
      scopeWarnings: [],
      headSha: "a".repeat(40),
      reviewVerdict: "advisory-fix",
    },
  });

  assert.deepEqual(
    [decision.transition.stage, decision.transition.status],
    ["merge", "waiting_human"]
  );
  assert.equal(
    decision.commands.some((command) =>
      command.kind === "run-job" && command.payload.kind === "build"
    ),
    false
  );
  assert.match(String(decision.transition.patch?.reviewReport), /obcięte do 8000 znaków/);

  const lgtm = reduceLifecycle(mergeGateRun({
    stage: "review",
    status: "running",
    reviewStatus: "running",
  }), {
    type: "job-finished",
    attempt: 2,
    output: {
      kind: "review",
      outcome: "success",
      report: "LGTM",
      signature: "ai-factory · claude · opus · reviewer",
      durationMs: 1,
      files: [],
      changedFiles: [],
      scopeWarnings: [],
      headSha: "a".repeat(40),
      reviewVerdict: "lgtm",
    },
  });
  assert.equal(
    lgtm.commands.some((command) =>
      command.kind === "run-job" && command.payload.kind === "build"
    ),
    false
  );
});

test("parser normalizuje /fix, a komenda nie zmienia effectiveInputHash", () => {
  assert.deepEqual(parseCommand("/fix"), { kind: "fix", payload: undefined });
  assert.deepEqual(parseCommand("/fix zrób X"), { kind: "fix", payload: "zrób X" });
  assert.deepEqual(parseCommand("/`fix`"), { kind: "fix", payload: undefined });
  assert.deepEqual(parseCommand("/fix."), { kind: "fix", payload: undefined });

  const before = buildCommentContextSnapshot(
    "BAR-FIX-HASH",
    manifest.title,
    manifest.description,
    []
  );
  const after = buildCommentContextSnapshot(
    "BAR-FIX-HASH",
    manifest.title,
    manifest.description,
    [{
      body: "/fix zachowaj kontrakt",
      createdAt: "2026-07-30T12:00:00.000Z",
    }]
  );
  assert.equal(after.effectiveInputHash, before.effectiveInputHash);
  assert.equal(after.totalRelevant, 0);
});

test("poller używa raportu review z runu i ignoruje stary PR head podczas builda", async () => {
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
        reviewReport: "BUG: form znika po structuredClone.",
      },
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

test("reconcilePullRequest nie cofa świeżego checkpointu do starego PR head w etapie test", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-fix-test-head-guard-"));
  const bin = join(root, "bin");
  const previousRoot = process.env.FACTORY_ROOT;
  const previousPath = process.env.PATH;
  const store = new LifecycleStore(join(root, "registry.db"));
  const ticket = {
    id: "BAR-FIX-TEST-GUARD",
    title: "Guard starego PR head",
    description: "Lokalny checkpoint jest nowszy od PR.",
    labels: [] as string[],
  };
  try {
    await mkdir(bin);
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(root)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    const oldPrSha = "a".repeat(40);
    const freshCheckpointSha = "b".repeat(40);
    const gh = join(bin, "gh");
    await writeFile(gh, [
      "#!/bin/sh",
      `printf '%s\\n' '${JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeCommit: null,
        headRefOid: oldPrSha,
      })}'`,
    ].join("\n"));
    await chmod(gh, 0o755);
    process.env.FACTORY_ROOT = root;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;

    const inputHash = buildCommentContextSnapshot(
      ticket.id,
      ticket.title,
      ticket.description,
      []
    ).effectiveInputHash;
    store.createRun(ticket.id, "harness", { ...ticket, inputHash });
    store.transition(ticket.id, {
      stage: "test",
      status: "running",
      actor: "test",
      reason: "fresh-checkpoint-testing",
      patch: {
        plan: "zatwierdzony plan",
        planFiles: ["src/a.ts"],
        branch: "agent/BAR-FIX-TEST-GUARD",
        headSha: freshCheckpointSha,
        testedSha: undefined,
        prUrl: "https://github.test/o/r/pull/194",
        reviewStatus: "advisory-fix",
        reviewReport: "BUG",
      },
    });
    const source = {
      async listComments() { return []; },
      async getTicket() {
        return {
          ...ticket,
          source: "linear",
          stateName: "In Progress",
          url: `https://linear.test/${ticket.id}`,
        };
      },
      async getStateName() { return "In Progress"; },
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
    const guarded = store.getRun(ticket.id)!;
    assert.deepEqual(
      [guarded.stage, guarded.status, guarded.headSha, guarded.reviewStatus],
      ["test", "running", freshCheckpointSha, "advisory-fix"]
    );
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("comment-pr /fix podpisuje orkiestrator, nie poprzedni build", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-fix-pr-comment-"));
  const bin = join(root, "bin");
  const capture = join(root, "comment-body.txt");
  const previousRoot = process.env.FACTORY_ROOT;
  const previousPath = process.env.PATH;
  const previousCapture = process.env.BAR191_GH_CAPTURE;
  const store = new LifecycleStore(join(root, "registry.db"));
  try {
    await mkdir(bin);
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(root)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    const gh = join(bin, "gh");
    await writeFile(gh, [
      "#!/bin/sh",
      "if [ \"$2\" = \"view\" ]; then",
      "  printf '%s\\n' '{\"comments\":[]}'",
      "elif [ \"$2\" = \"comment\" ]; then",
      "  printf '%s' \"$5\" > \"$BAR191_GH_CAPTURE\"",
      "else",
      "  exit 1",
      "fi",
    ].join("\n"));
    await chmod(gh, 0o755);
    process.env.FACTORY_ROOT = root;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.BAR191_GH_CAPTURE = capture;

    const sha = "a".repeat(40);
    store.createRun("BAR-FIX-COMMENT", "harness", manifest);
    store.transition("BAR-FIX-COMMENT", {
      stage: "merge",
      status: "waiting_human",
      actor: "test",
      reason: "fixture-review",
      patch: {
        plan: "plan",
        planFiles: ["src/a.ts"],
        branch: "agent/BAR-FIX-COMMENT",
        headSha: sha,
        prUrl: "https://github.test/o/r/pull/195",
        reviewStatus: "advisory-fix",
        reviewReport: "BUG",
      },
    });
    const buildSignature = "ai-factory · codex@0.145.0 · gpt-5.6-sol@xhigh · builder";
    store.startAttempt("BAR-FIX-COMMENT", "build", 2, "build-comment-signature", { sha });
    store.finishAttempt("BAR-FIX-COMMENT", "build", 2, {
      status: "success",
      outcome: "success",
      report: "poprawiono",
      signature: buildSignature,
      sha,
      durationMs: 1,
    });
    store.enqueue({
      key: "BAR-FIX-COMMENT:g1:pr-comment:fix:1",
      ticketId: "BAR-FIX-COMMENT",
      kind: "comment-pr",
      stage: "merge",
      payload: {
        prUrl: "https://github.test/o/r/pull/195",
        body: "🔧 Poprawka po review (runda 1/2) — inicjowana przez człowieka",
        outcome: "fix-dispatched",
      },
    });
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", {} as never]]),
      notifier: async () => {},
    };

    await dispatchOutbox(deps);
    const body = await readFile(capture, "utf8");
    const pollerSignature = signatureLine(POLLER_SIGNATURE);
    assert.match(
      body,
      new RegExp(`Signature: ${pollerSignature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.doesNotMatch(body, /builder/);
    assert.match(body, /Outcome: fix-dispatched/);
    assert.doesNotMatch(body, /undefined/);
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCapture === undefined) delete process.env.BAR191_GH_CAPTURE;
    else process.env.BAR191_GH_CAPTURE = previousCapture;
    await rm(root, { recursive: true, force: true });
  }
});
