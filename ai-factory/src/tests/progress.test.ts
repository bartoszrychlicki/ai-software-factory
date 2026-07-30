import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduceLifecycle } from "../pipeline/coordinator";
import {
  LifecycleStore,
  type LifecycleRun,
  type TicketManifestV2,
} from "../pipeline/lifecycle-store";
import { progressComment } from "../pipeline/progress";
import { getProject, progressLevel } from "../pipeline/projects";
import { buildCommentContextSnapshot } from "../sources/comment-context";
import {
  applyDecision,
  dispatchOutbox,
  type PollerDependencies,
} from "../sources/poll-linear-v2";

const manifest: TicketManifestV2 = {
  title: "Komentarze postępu",
  description: "BAR-181",
  labels: [],
  inputHash: "hash-progress",
};

function runAt(
  stage: LifecycleRun["stage"],
  status: LifecycleRun["status"],
  patch: Partial<LifecycleRun> = {}
): LifecycleRun {
  return {
    ticketId: "BAR-PROGRESS",
    project: "harness",
    generation: 1,
    stage,
    status,
    manifest,
    plan: "plan",
    planFiles: ["src/a.ts", "src/b.ts"],
    clarifyRound: 0,
    critiqueRound: 0,
    fixRound: 0,
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    ...patch,
  };
}

test("mapa milestones obejmuje siedem przejść pełnego cyklu kodowego", () => {
  const transitions: [LifecycleRun, LifecycleRun, string][] = [
    [
      runAt("approval", "waiting_human"),
      runAt("build", "running"),
      "/approve comment-1",
    ],
    [
      runAt("build", "running"),
      runAt("test", "pending", { headSha: "a".repeat(40) }),
      "checkpoint-created",
    ],
    [
      runAt("test", "pending", { headSha: "a".repeat(40) }),
      runAt("publish", "pending", { headSha: "a".repeat(40), testedSha: "a".repeat(40) }),
      "exact-sha-tests-pass",
    ],
    [
      runAt("publish", "pending"),
      runAt("ci", "waiting_external", { prUrl: "https://github.com/o/r/pull/1" }),
      "draft-pr-recorded",
    ],
    [
      runAt("ci", "waiting_external"),
      runAt("review", "running"),
      "ci-pass",
    ],
    [
      runAt("review", "running"),
      runAt("merge", "waiting_human", { reviewStatus: "lgtm" }),
      "lgtm",
    ],
    [
      runAt("merge", "waiting_human"),
      runAt("smoke", "pending", { mergedSha: "b".repeat(40) }),
      "tracked-pr-merged",
    ],
  ];

  const comments = transitions.map(([before, after, reason]) =>
    progressComment(before, after, reason, {
      buildSignature: "ai-factory · codex@1.0 · gpt@high · builder",
      reviewSignature: "ai-factory · claude@2.0 · sonnet · reviewer",
    })
  );
  assert.equal(comments.length, 7);
  assert.ok(comments.every((comment) => comment?.level === "milestones"));
  assert.equal(new Set(comments.map((comment) => comment?.key)).size, 7);
  assert.match(comments[0]!.body, /build startuje/);
  assert.match(comments[1]!.body, /a{7}/);
  assert.match(comments[1]!.body, /2 plików/);
  assert.equal(
    comments[1]!.signature,
    "ai-factory · codex@1.0 · gpt@high · builder"
  );
  assert.equal(
    comments[5]!.signature,
    "ai-factory · claude@2.0 · sonnet · reviewer"
  );
});

test("verbose dodaje research, krytykę, retry i degradacje w chwili wystąpienia", () => {
  const triageStart = progressComment(
    runAt("plan", "pending"),
    runAt("triage", "running"),
    "triage-dispatched"
  );
  const researchStart = progressComment(
    runAt("triage", "running"),
    runAt("research", "running"),
    "triage-deep",
    { triageSignature: "ai-factory · codex · terra · planner" }
  );
  const researchFailure = progressComment(
    runAt("research", "running", { researchFailures: { recon: 0 } }),
    runAt("research", "running", { researchFailures: { recon: 1 } }),
    "research-recon-failed",
    { researchSignatures: { recon: "ai-factory · codex · sol · researcher" } }
  );
  const revision = progressComment(
    runAt("critique", "running"),
    runAt("synthesis", "running", { critiqueRound: 1 }),
    "critique-issues-revision",
    { critiqueSignature: "ai-factory · codex · sol · critic" }
  );
  const retry = progressComment(
    runAt("test", "blocked"),
    runAt("build", "running"),
    "/retry c-retry: fix-after-test"
  );
  for (const comment of [triageStart, researchStart, researchFailure, revision, retry]) {
    assert.equal(comment?.level, "verbose");
  }
  assert.match(researchStart!.body, /recon, solution-a, solution-b/);
  assert.match(researchFailure!.body, /nieudana próba 1/);
  assert.equal(
    researchFailure!.signature,
    "ai-factory · codex · sol · researcher"
  );
  assert.match(revision!.body, /rewizję syntezy/);
  assert.match(retry!.body, /retry/);
});

test("input-changed i /replan emitują idempotentny milestone nowej generacji", () => {
  const before = runAt("approval", "waiting_human");
  const afterInputChange = runAt("plan", "pending", { generation: 2 });
  const inputChange = progressComment(
    before,
    afterInputChange,
    "input-changed-before-build"
  );
  const inputChangeRepeated = progressComment(
    before,
    afterInputChange,
    "input-changed-before-build"
  );
  const replan = progressComment(
    before,
    runAt("triage", "running", { generation: 2 }),
    "/replan c-replan"
  );

  assert.equal(inputChange?.level, "milestones");
  assert.match(inputChange!.body, /Wykryto edycję treści\/nowy komentarz/);
  assert.match(inputChange!.body, /generacja 2/);
  assert.match(inputChange!.body, /komentarz jest w kontekście plannera/);
  assert.equal(inputChange?.key, inputChangeRepeated?.key);
  assert.equal(replan?.level, "milestones");
  assert.match(replan!.body, /`\/replan` przyjęty/);
  assert.match(replan!.body, /generacja 2/);
});

test("/fix emituje milestone z rundą i zachowaniem planu oraz brancha", () => {
  const fix = progressComment(
    runAt("merge", "waiting_human", { fixRound: 0 }),
    runAt("build", "running", { fixRound: 1 }),
    "/fix comment-fix-1"
  );

  assert.equal(fix?.level, "milestones");
  assert.match(fix!.body, /Poprawka po review/);
  assert.match(fix!.body, /runda 1\/2/);
  assert.match(fix!.body, /Ten sam plan i branch/);
  assert.match(fix!.body, /testy exact-SHA i ponowne review/);
});

test("applyDecision zapisuje 7 idempotentnych kluczy progress i nie dubluje merge po restarcie", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-progress-cycle-"));
  const db = join(root, "registry.db");
  let store = new LifecycleStore(db);
  try {
    const deps = (): PollerDependencies => ({
      store,
      mastra: {} as PollerDependencies["mastra"],
      sources: new Map(),
      notifier: async () => {},
    });
    let run = store.createRun("BAR-P-CYCLE", "harness", manifest);
    run = store.transition(run.ticketId, {
      stage: "approval",
      status: "waiting_human",
      actor: "test",
      reason: "fixture-plan-ready",
      patch: { plan: "plan", planFiles: ["src/a.ts", "src/b.ts"], planDomain: "backend" },
    });
    run = applyDecision(
      deps(),
      run.ticketId,
      reduceLifecycle(run, { type: "approve", commentId: "c-approve" })
    );

    store.startAttempt(run.ticketId, "build", 1, "build-job");
    store.finishAttempt(run.ticketId, "build", 1, {
      status: "success",
      outcome: "success",
      report: "build",
      signature: "ai-factory · codex@1.0 · gpt@high · builder",
      durationMs: 1,
    });
    run = applyDecision(deps(), run.ticketId, reduceLifecycle(run, {
      type: "job-finished",
      attempt: 1,
      output: {
        kind: "build",
        outcome: "success",
        report: "build",
        signature: "ai-factory · codex@1.0 · gpt@high · builder",
        durationMs: 1,
        files: ["src/a.ts", "src/b.ts"],
        branch: "agent/BAR-P-CYCLE",
        workspaceDir: "/tmp/BAR-P-CYCLE",
        headSha: "a".repeat(40),
        changedFiles: ["src/a.ts", "src/b.ts"],
        scopeWarnings: [],
      },
    }));
    run = applyDecision(deps(), run.ticketId, reduceLifecycle(run, {
      type: "test-result",
      ok: true,
      sha: "a".repeat(40),
      report: "green",
    }));
    run = applyDecision(deps(), run.ticketId, reduceLifecycle(run, {
      type: "published",
      prUrl: "https://github.com/o/r/pull/1",
      branch: "agent/BAR-P-CYCLE",
      sha: "a".repeat(40),
    }));
    run = applyDecision(deps(), run.ticketId, reduceLifecycle(run, {
      type: "ci-result",
      outcome: "pass",
      sha: "a".repeat(40),
      report: "quality",
    }));

    store.startAttempt(run.ticketId, "review", 1, "review-job");
    store.finishAttempt(run.ticketId, "review", 1, {
      status: "success",
      outcome: "lgtm",
      report: "LGTM",
      signature: "ai-factory · claude@2.0 · sonnet · reviewer",
      durationMs: 1,
    });
    run = applyDecision(deps(), run.ticketId, reduceLifecycle(run, {
      type: "job-finished",
      attempt: 1,
      output: {
        kind: "review",
        outcome: "success",
        report: "LGTM",
        signature: "ai-factory · claude@2.0 · sonnet · reviewer",
        durationMs: 1,
        files: ["src/a.ts", "src/b.ts"],
        changedFiles: [],
        scopeWarnings: [],
        headSha: "a".repeat(40),
        reviewVerdict: "lgtm",
      },
    }));
    const mergeDecision = reduceLifecycle(run, {
      type: "pr-state",
      state: "merged",
      sha: "b".repeat(40),
    });
    run = applyDecision(deps(), run.ticketId, mergeDecision);
    applyDecision(deps(), run.ticketId, mergeDecision);

    const progressCommands = store.outstandingCommands(200)
      .filter((command) => command.kind === "linear-comment" && command.payload.progress);
    assert.equal(progressCommands.length, 7);
    assert.equal(new Set(progressCommands.map((command) => command.key)).size, 7);
    assert.equal(
      progressCommands.find((command) => String(command.payload.body).includes("checkpoint"))
        ?.payload.signature,
      "ai-factory · codex@1.0 · gpt@high · builder"
    );
    assert.equal(
      progressCommands.find((command) => String(command.payload.body).includes("Review zakończony"))
        ?.payload.signature,
      "ai-factory · claude@2.0 · sonnet · reviewer"
    );
    const keysBeforeRestart = progressCommands.map((command) => command.key).sort();

    store.close();
    store = new LifecycleStore(db);
    const keysAfterRestart = store.outstandingCommands(200)
      .filter((command) => command.kind === "linear-comment" && command.payload.progress)
      .map((command) => command.key)
      .sort();
    assert.deepEqual(keysAfterRestart, keysBeforeRestart);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch respektuje off, milestones, verbose i domyślny milestones", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-progress-levels-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const received = new Map<string, string[]>();
  try {
    writeFileSync(join(root, "projects.yaml"), [
      "off-project:",
      "  repo: /tmp/off",
      "  checks: [npm-test]",
      "  progress: off",
      "milestones-project:",
      "  repo: /tmp/milestones",
      "  checks: [npm-test]",
      "  progress: milestones",
      "verbose-project:",
      "  repo: /tmp/verbose",
      "  checks: [npm-test]",
      "  progress: verbose",
      "default-project:",
      "  repo: /tmp/default",
      "  checks: [npm-test]",
    ].join("\n"));
    process.env.FACTORY_ROOT = root;

    const sources = new Map<string, never>();
    for (const project of ["off-project", "milestones-project", "verbose-project", "default-project"]) {
      const bodies: string[] = [];
      received.set(project, bodies);
      sources.set(project, {
        async setStateByName() {},
        async listComments() {
          return bodies.map((body, index) => ({
            id: String(index),
            body,
            createdAt: new Date(index).toISOString(),
          }));
        },
        async comment(_ticketId: string, body: string) {
          bodies.push(body);
        },
      } as never);
      store.createRun(`BAR-${project}`, project, manifest);
      for (const level of ["milestones", "verbose"] as const) {
        store.enqueue({
          key: `BAR-${project}:g1:progress:${level}`,
          ticketId: `BAR-${project}`,
          kind: "linear-comment",
          stage: "plan",
          payload: { body: `${project}-${level}`, progress: level },
        });
      }
    }

    await dispatchOutbox({
      store,
      mastra: {} as PollerDependencies["mastra"],
      sources,
      notifier: async () => {},
    });

    assert.equal(received.get("off-project")?.length, 0);
    assert.equal(received.get("milestones-project")?.length, 1);
    assert.equal(received.get("verbose-project")?.length, 2);
    assert.equal(received.get("default-project")?.length, 1);
    assert.ok(received.get("verbose-project")?.every((body) =>
      body.includes("[linear:BAR-verbose-project:v2]") &&
      body.includes("[factory-outbox:")
    ));
    assert.ok(store.outstandingCommands(100).every((command) =>
      command.kind !== "linear-comment" || !command.payload.progress
    ));
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch wzbogaca approve i start review o routing oraz budżet", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-progress-enrichment-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const bodies: string[] = [];
  try {
    writeFileSync(join(root, "projects.yaml"), [
      "harness:",
      "  repo: /tmp/harness",
      "  checks: [npm-test]",
      "  progress: milestones",
      "  budget:",
      "    maxMinutes: 90",
      "    maxUsd: 12",
    ].join("\n"));
    writeFileSync(join(root, "routing.yaml"), [
      "defaults:",
      "  build: codex/gpt-builder@high",
      "  review: claude-code/reviewer-model@medium",
      "  review.diverse: codex/reviewer-fallback@medium",
    ].join("\n"));
    process.env.FACTORY_ROOT = root;

    const run = store.createRun("BAR-ENRICH", "harness", manifest);
    store.startAttempt(run.ticketId, "build", 1, "build-job");
    store.finishAttempt(run.ticketId, "build", 1, {
      status: "success",
      outcome: "success",
      signature: "ai-factory · codex@1.0 · gpt-builder@high · builder",
      durationMs: 1,
    });
    store.enqueue({
      key: "BAR-ENRICH:g1:progress:approve",
      ticketId: run.ticketId,
      kind: "linear-comment",
      stage: "build",
      payload: {
        body: "approve",
        progress: "milestones",
        enrich: "approve-route",
      },
    });
    store.enqueue({
      key: "BAR-ENRICH:g1:progress:review",
      ticketId: run.ticketId,
      kind: "linear-comment",
      stage: "review",
      payload: {
        body: "review",
        progress: "milestones",
        enrich: "review-route",
      },
    });
    const source = {
      async setStateByName() {},
      async listComments() {
        return bodies.map((body, index) => ({
          id: String(index),
          body,
          createdAt: new Date(index).toISOString(),
        }));
      },
      async comment(_ticketId: string, body: string) {
        bodies.push(body);
      },
    };

    await dispatchOutbox({
      store,
      mastra: {} as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async () => {},
    });

    assert.match(bodies[0], /codex\/gpt-builder@high/);
    assert.match(bodies[0], /budżet roli: 25 min/);
    assert.match(bodies[0], /budżet ticketu: 90 min \/ \$12/);
    assert.match(bodies[1], /claude-code\/reviewer-model@medium/);
    assert.match(bodies[1], /budżet roli: 10 min/);
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("progressLevel czyta local override, ma default milestones i odrzuca nieznaną wartość", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-progress-config-"));
  const previousRoot = process.env.FACTORY_ROOT;
  try {
    writeFileSync(join(root, "projects.yaml"), [
      "default-project:",
      "  repo: /tmp/default",
      "  checks: [npm-test]",
      "override-project:",
      "  repo: /tmp/override",
      "  checks: [npm-test]",
      "  progress: off",
      "invalid-project:",
      "  repo: /tmp/invalid",
      "  checks: [npm-test]",
      "  progress: noisy",
    ].join("\n"));
    writeFileSync(join(root, "projects.local.yaml"), [
      "override-project:",
      "  progress: verbose",
    ].join("\n"));
    process.env.FACTORY_ROOT = root;

    assert.equal(progressLevel(await getProject("default-project")), "milestones");
    assert.equal(progressLevel(await getProject("override-project")), "verbose");
    await assert.rejects(getProject("invalid-project"), /Nieznany poziom progress "noisy"/);
  } finally {
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("marker komentarza progress wyklucza go z effectiveInputHash", () => {
  const authorComment = {
    body: "Komentarz autora",
    createdAt: "2026-07-29T10:00:00.000Z",
  };
  const before = buildCommentContextSnapshot(
    "BAR-PROGRESS",
    manifest.title,
    manifest.description,
    [authorComment]
  );
  const progress = progressComment(
    runAt("approval", "waiting_human"),
    runAt("build", "running"),
    "/approve c-approve"
  );
  assert.ok(progress);
  const after = buildCommentContextSnapshot(
    "BAR-PROGRESS",
    manifest.title,
    manifest.description,
    [
      authorComment,
      {
        body:
          `${progress.body}\n\n[linear:BAR-PROGRESS:v2] ` +
          `[factory-outbox:${progress.key}]`,
        createdAt: "2026-07-29T10:01:00.000Z",
      },
    ]
  );

  assert.equal(after.effectiveInputHash, before.effectiveInputHash);
  assert.equal(after.totalRelevant, before.totalRelevant);
});
