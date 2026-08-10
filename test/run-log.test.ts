import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinearSource } from "../src/adapters/linear/client";
import { applyDecision, sweepScores, type PollerDependencies } from "../src/app/poller";
import { reduceLifecycle } from "../src/lifecycle/coordinator";
import {
  LifecycleStore,
  type LifecycleRun,
  type TicketManifestV2,
  type TransitionInput,
} from "../src/lifecycle/store";
import { buildRunLog } from "../src/observability/run-log";

const manifest: TicketManifestV2 = {
  title: "Jeden log przebiegu",
  description: "Fake run BAR-208",
  labels: ["backend"],
  url: "https://linear.test/BAR-208",
  inputHash: "input-1",
};

interface Harness {
  root: string;
  store: LifecycleStore;
  deps: PollerDependencies;
}

async function withHarness(
  prefix: string,
  run: (harness: Harness) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  try {
    await writeFile(join(root, "package.json"), "{}");
    process.env.FACTORY_ROOT = root;
    const source = {} as LinearSource;
    const deps: PollerDependencies = {
      store,
      mastra: {} as PollerDependencies["mastra"],
      sources: new Map([["harness", source]]),
      notifier: async () => {},
    };
    await run({ root, store, deps });
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function applyTransition(
  deps: PollerDependencies,
  ticketId: string,
  transition: TransitionInput
): LifecycleRun {
  return applyDecision(deps, ticketId, { transition, commands: [] });
}

async function addArtifact(
  root: string,
  ticketId: string,
  jobRunId: string,
  name: string
): Promise<void> {
  const dir = join(root, "runs", ticketId, jobRunId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `${jobRunId}:${name}`);
}

async function seedCompletedRun(harness: Harness, ticketId: string): Promise<LifecycleRun> {
  const { root, store, deps } = harness;
  store.createRun(ticketId, "harness", manifest);

  store.startAttempt(ticketId, "plan", 1, "job-plan-g1");
  store.finishAttempt(ticketId, "plan", 1, {
    status: "failed",
    outcome: "PLAN_FAILED",
    signature: "planner · model-a@high",
    errorCode: "PLAN_FAILED",
    errorMessage: "pierwsza próba nieudana",
    costUsd: 1,
    costSource: "reported",
    durationMs: 60_000,
  });
  await addArtifact(root, ticketId, "job-plan-g1", "plan.md");
  applyTransition(deps, ticketId, {
    stage: "approval",
    status: "waiting_human",
    actor: "coordinator",
    reason: "plan-ready-g1",
  });

  applyDecision(
    deps,
    ticketId,
    reduceLifecycle(store.getRun(ticketId)!, {
      type: "replan",
      commentId: "c-replan",
      reason: "zbierz uwagi w jedną rundę",
      nextAttempt: 2,
    })
  );

  store.startAttempt(ticketId, "plan", 2, "job-plan-g2");
  store.finishAttempt(ticketId, "plan", 2, {
    status: "success",
    outcome: "success",
    signature: "planner · model-b@high",
    costUsd: 0.5,
    costSource: "reported",
    durationMs: 30_000,
  });
  await addArtifact(root, ticketId, "job-plan-g2", "plan.md");
  applyTransition(deps, ticketId, {
    stage: "build",
    status: "running",
    actor: "linear",
    reason: "operator-updated-ticket",
  });

  store.startAttempt(ticketId, "build", 1, "job-build-g2");
  store.finishAttempt(ticketId, "build", 1, {
    status: "success",
    outcome: "success",
    signature: "builder · model-c@medium",
    costUsd: 2.5,
    costSource: "estimated-time",
    durationMs: 120_000,
  });
  await addArtifact(root, ticketId, "job-build-g2", "build-report.md");
  applyTransition(deps, ticketId, {
    stage: "review",
    status: "waiting_external",
    actor: "builder",
    reason: "build-finished",
  });

  store.startAttempt(ticketId, "review", 1, "job-review-g2");
  store.finishAttempt(ticketId, "review", 1, {
    status: "success",
    outcome: "lgtm",
    signature: "reviewer · model-d@xhigh",
    costUsd: 4,
    costSource: "estimated-tokens",
    durationMs: 180_000,
  });
  await addArtifact(root, ticketId, "job-review-g2", "review.md");
  applyTransition(deps, ticketId, {
    stage: "review",
    status: "pending",
    actor: "github",
    reason: "pr-head-changed",
  });

  return applyTransition(deps, ticketId, {
    stage: "smoke",
    status: "done",
    actor: "coordinator",
    reason: "smoke-passed-final",
    patch: {
      prUrl: "https://github.test/o/r/pull/208",
      mergedSha: "a".repeat(40),
      smokeStatus: "pass",
    },
  });
}

test("Done zapisuje pełną oś czasu wielu generacji i linki do prób", async () => {
  await withHarness("factory-run-log-done-", async (harness) => {
    const ticketId = "BAR-LOG-1";
    await seedCompletedRun(harness, ticketId);

    const log = await readFile(join(harness.root, "runs", ticketId, "przebieg.md"), "utf8");
    assert.match(log, /^# BAR-LOG-1 — przebieg ticketu/m);
    assert.match(log, /- Status: done/);
    assert.match(log, /## Oś czasu/);
    assert.match(log, /## Próby etapów/);
    assert.match(log, /\.\/job-plan-g1\/plan\.md/);
    assert.match(log, /\.\/job-build-g2\/build-report\.md/);
    assert.match(log, /\.\/job-review-g2\/review\.md/);
    assert.match(log, /reviewer · model-d@xhigh/);

    let previousIndex = -1;
    for (const transition of harness.store.listTransitions(ticketId)) {
      const index = log.indexOf(cellReason(transition.reason), previousIndex + 1);
      assert.ok(index > previousIndex, `brak przejścia #${transition.id}: ${transition.reason}`);
      previousIndex = index;
    }
    assert.equal(harness.store.getRun(ticketId)?.generation, 2);
  });
});

function cellReason(reason: string): string {
  return reason.replace(/\r\n?|\n/g, " ").replace(/\|/g, "\\|");
}

test("koszt per etap i RAZEM zgadzają się z lifecycle_stage_attempts", async () => {
  await withHarness("factory-run-log-cost-", async (harness) => {
    const ticketId = "BAR-LOG-2";
    await seedCompletedRun(harness, ticketId);
    const log = await readFile(join(harness.root, "runs", ticketId, "przebieg.md"), "utf8");
    const usage = harness.store.totalUsage(ticketId);
    const expected = new Map<string, { count: number; usd: number; minutes: number }>();
    for (const attempt of harness.store.listAttempts(ticketId)) {
      const stage = expected.get(attempt.stage) ?? { count: 0, usd: 0, minutes: 0 };
      stage.count += 1;
      stage.usd += attempt.costUsd ?? 0;
      stage.minutes += (attempt.durationMs ?? 0) / 60_000;
      expected.set(attempt.stage, stage);
    }

    for (const [stage, value] of expected) {
      assert.match(
        log,
        new RegExp(`\\| ${stage} \\| ${value.count} \\| \\$${value.usd.toFixed(4)} \\|`)
      );
    }
    assert.match(
      log,
      new RegExp(`\\| RAZEM \\| 4 \\| \\$${usage.usd.toFixed(4)} \\| 100\\.0% \\| ${usage.minutes.toFixed(2)} min \\|`)
    );
  });
});

test("przejścia human, linear i pr-head-changed są oznaczone i liczone osobno", async () => {
  await withHarness("factory-run-log-human-", async (harness) => {
    const ticketId = "BAR-LOG-3";
    await seedCompletedRun(harness, ticketId);
    const log = await readFile(join(harness.root, "runs", ticketId, "przebieg.md"), "utf8");
    assert.match(log, /\| przejścia wywołane przez człowieka \| 3 \|/);
    assert.match(log, /## Decyzje człowieka \(3\)/);

    const humanSection = log.split("## Decyzje człowieka (3)")[1].split("## Oś czasu")[0];
    assert.match(humanSection, /\/replan c-replan/);
    assert.match(humanSection, /operator-updated-ticket/);
    assert.match(humanSection, /pr-head-changed/);
    assert.doesNotMatch(humanSection, /build-finished|plan-ready-g1|smoke-passed-final/);
    assert.equal(humanSection.split("\n").filter((line) => /^\| \d+/.test(line)).length, 3);

    const timeline = log.split("## Oś czasu")[1].split("## Próby etapów")[0];
    assert.match(timeline.split("\n").find((line) => line.includes("pr-head-changed"))!, /👤 \|$/);
    assert.match(timeline.split("\n").find((line) => line.includes("build-finished"))!, /— \|$/);
  });
});

test("Canceled dostaje plik, a /replan zapisuje i później nadpisuje pełną historię", async () => {
  await withHarness("factory-run-log-terminal-", async ({ root, store, deps }) => {
    const canceledId = "BAR-LOG-4A";
    store.createRun(canceledId, "harness", manifest);
    applyDecision(deps, canceledId, reduceLifecycle(store.getRun(canceledId)!, { type: "cancel" }));
    const canceled = await readFile(join(root, "runs", canceledId, "przebieg.md"), "utf8");
    assert.match(canceled, /- Status: anulowany/);
    assert.match(canceled, /canceled/);

    const replanId = "BAR-LOG-4B";
    store.createRun(replanId, "harness", manifest);
    applyDecision(deps, replanId, reduceLifecycle(store.getRun(replanId)!, {
      type: "replan",
      commentId: "c-live",
      reason: "nowy plan",
      nextAttempt: 1,
    }));
    const path = join(root, "runs", replanId, "przebieg.md");
    const afterReplan = await readFile(path, "utf8");
    assert.match(afterReplan, /w toku — generacja 1 porzucona/);
    assert.match(afterReplan, /\| liczba generacji \| 2 \|/);
    assert.match(afterReplan, /\/replan c-live/);

    applyTransition(deps, replanId, {
      stage: "build",
      status: "running",
      actor: "builder",
      reason: "later-build",
    });
    assert.equal(await readFile(path, "utf8"), afterReplan, "zwykłe przejście nie nadpisuje pliku");
    applyTransition(deps, replanId, {
      stage: "smoke",
      status: "done",
      actor: "coordinator",
      reason: "later-final",
    });
    const afterDone = await readFile(path, "utf8");
    assert.notEqual(afterDone, afterReplan);
    assert.match(afterDone, /\/replan c-live/);
    assert.match(afterDone, /later-build/);
    assert.match(afterDone, /later-final/);
  });
});

test("awaria zapisu przebiegu ostrzega, ale nie blokuje domknięcia", async () => {
  await withHarness("factory-run-log-fail-open-", async ({ root, store, deps }) => {
    const ticketId = "BAR-LOG-5";
    store.createRun(ticketId, "harness", manifest);
    await mkdir(join(root, "runs"), { recursive: true });
    await writeFile(join(root, "runs", ticketId), "kolizja: to jest zwykły plik");
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      assert.doesNotThrow(() => {
        applyDecision(deps, ticketId, reduceLifecycle(store.getRun(ticketId)!, { type: "cancel" }));
      });
    } finally {
      console.error = originalError;
    }

    assert.equal(store.getRun(ticketId)?.status, "done");
    assert.ok(errors.some((args) => String(args[0]).includes(`Przebieg ${ticketId} nie zapisany`)));
  });
});

test("powody i błędy z pipe oraz nową linią nie psują tabel markdown", async () => {
  await withHarness("factory-run-log-escape-", async ({ store }) => {
    const ticketId = "BAR-LOG-6";
    store.createRun(ticketId, "harness", manifest);
    store.transition(ticketId, {
      stage: "review",
      status: "blocked",
      actor: "human",
      reason: "operator | split\nnext",
    });
    store.startAttempt(ticketId, "review", 1, "missing-artifacts");
    store.finishAttempt(ticketId, "review", 1, {
      status: "failed",
      outcome: "bad | outcome\ncontinued",
      errorMessage: "bad | pipe\nline",
      costUsd: 0.25,
      durationMs: 1_000,
    });

    const log = buildRunLog(store, store.getRun(ticketId)!);
    assert.equal(log.split("operator \\| split next").length - 1, 2);
    assert.match(log, /bad \\| outcome continued/);
    assert.match(log, /bad \\| pipe line/);
    assert.equal(log.split("\n").some((line) => line === "next" || line === "continued"), false);
  });
});

test("/score po Done nadpisuje przebieg świeżą oceną", async () => {
  await withHarness("factory-run-log-score-", async (harness) => {
    const ticketId = "BAR-LOG-7";
    await seedCompletedRun(harness, ticketId);
    const path = join(harness.root, "runs", ticketId, "przebieg.md");
    assert.match(await readFile(path, "utf8"), /\| ocena \/score \| — \|/);

    const comments: string[] = [];
    const source = {
      listComments: async () => [{ id: "c-score", body: "/score 4 solidnie" }],
      comment: async (_ticket: string, body: string) => { comments.push(body); },
    } as unknown as LinearSource;
    harness.deps.sources.set("harness", source);

    await sweepScores(harness.deps);

    assert.equal(harness.store.getRun(ticketId)?.score, 4);
    const log = await readFile(path, "utf8");
    assert.match(log, /\| ocena \/score \| 4\/5 — solidnie \|/);
    assert.match(log, /## Oś czasu/);
    assert.match(log, /\.\/job-review-g2\/review\.md/);
    assert.equal(comments.length, 1);
  });
});
