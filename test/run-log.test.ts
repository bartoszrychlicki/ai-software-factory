import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildCommentContextSnapshot } from "../src/adapters/linear/comment-context";
import type { LinearSource } from "../src/adapters/linear/client";
import {
  applyDecision,
  pollOnce,
  reconcileRun,
  sweepScores,
  type PollerDependencies,
} from "../src/app/poller";
import { saveArtifact } from "../src/execution/artifacts";
import { runsRoot } from "../src/config/paths";
import { reduceLifecycle } from "../src/lifecycle/coordinator";
import {
  lifecycleDbPath,
  LifecycleStore,
  type LifecycleRun,
  type TicketManifestV2,
  type TransitionInput,
} from "../src/lifecycle/store";
import { buildRunLog, writeRunLog } from "../src/observability/run-log";

const manifest: TicketManifestV2 = {
  title: "Jeden log przebiegu",
  description: "Fake run BAR-208",
  labels: ["backend"],
  url: "https://linear.test/BAR-208",
  inputHash: "input-1",
};

interface Harness {
  root: string;
  runsRoot: string;
  dbPath: string;
  store: LifecycleStore;
  deps: PollerDependencies;
}

async function withHarness(
  prefix: string,
  run: (harness: Harness) => Promise<void>,
  beforeStore?: (paths: Omit<Harness, "store" | "deps">) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const previousRoot = process.env.FACTORY_ROOT;
  const previousRunsRoot = process.env.FACTORY_RUNS_ROOT;
  const previousLifecycleDb = process.env.FACTORY_LIFECYCLE_DB;
  const configuredRunsRoot = join(root, "runs");
  const dbPath = join(configuredRunsRoot, "lifecycle.db");
  let store: LifecycleStore | undefined;
  try {
    process.env.FACTORY_ROOT = root;
    process.env.FACTORY_RUNS_ROOT = configuredRunsRoot;
    process.env.FACTORY_LIFECYCLE_DB = dbPath;
    await writeFile(join(root, "package.json"), "{}");
    await beforeStore?.({ root, runsRoot: configuredRunsRoot, dbPath });
    store = new LifecycleStore();
    const source = {} as LinearSource;
    const deps: PollerDependencies = {
      store,
      mastra: {} as PollerDependencies["mastra"],
      sources: new Map([["harness", source]]),
      notifier: async () => {},
    };
    await run({ root, runsRoot: configuredRunsRoot, dbPath, store, deps });
  } finally {
    try {
      store?.close();
    } catch {}
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    if (previousRunsRoot === undefined) delete process.env.FACTORY_RUNS_ROOT;
    else process.env.FACTORY_RUNS_ROOT = previousRunsRoot;
    if (previousLifecycleDb === undefined) delete process.env.FACTORY_LIFECYCLE_DB;
    else process.env.FACTORY_LIFECYCLE_DB = previousLifecycleDb;
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

async function addArtifact(ticketId: string, jobRunId: string, name: string): Promise<void> {
  await saveArtifact(ticketId, jobRunId, name, `${jobRunId}:${name}`);
}

async function seedCompletedRun(harness: Harness, ticketId: string): Promise<LifecycleRun> {
  const { store, deps } = harness;
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
  await addArtifact(ticketId, "job-plan-g1", "plan.md");
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
  await addArtifact(ticketId, "job-plan-g2", "plan.md");
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
  await addArtifact(ticketId, "job-build-g2", "build-report.md");
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
  await addArtifact(ticketId, "job-review-g2", "review.md");
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
      const share = usage.usd > 0 ? value.usd / usage.usd * 100 : 0;
      assert.match(
        log,
        new RegExp(
          `\\| ${stage} \\| ${value.count} \\| \\$${value.usd.toFixed(4)} \\| ${share.toFixed(1)}% \\|`
        )
      );
    }
    assert.match(
      log,
      new RegExp(`\\| RAZEM \\| 4 \\| \\$${usage.usd.toFixed(4)} \\| 100\\.0% \\| ${usage.minutes.toFixed(2)} min \\|`)
    );
  });
});

test("zerowy koszt pokazuje 0.0% w etapach i wierszu RAZEM", async () => {
  await withHarness("factory-run-log-zero-cost-", async ({ store }) => {
    const ticketId = "BAR-LOG-ZERO";
    store.createRun(ticketId, "harness", manifest);

    store.startAttempt(ticketId, "plan", 1, "job-plan-zero");
    store.finishAttempt(ticketId, "plan", 1, {
      status: "success",
      outcome: "success",
      signature: "planner · model-zero@high",
      costUsd: 0,
      costSource: "reported",
      durationMs: 30_000,
    });
    store.startAttempt(ticketId, "build", 1, "job-build-zero");
    store.finishAttempt(ticketId, "build", 1, {
      status: "success",
      outcome: "success",
      signature: "builder · model-zero@medium",
      costUsd: 0,
      costSource: "reported",
      durationMs: 60_000,
    });

    const run = store.getRun(ticketId)!;
    const log = buildRunLog(store, run);
    assert.match(log, /\| build \| 1 \| \$0\.0000 \| 0\.0% \|/);
    assert.match(log, /\| plan \| 1 \| \$0\.0000 \| 0\.0% \|/);
    assert.match(log, /\| RAZEM \| 2 \| \$0\.0000 \| 0\.0% \| 1\.50 min \|/);
    assert.doesNotMatch(log, /\| RAZEM \|[^\n]*\| 100\.0% \|/);
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
    assert.match(afterReplan, /- Status: w toku — generacja 2, etap plan\/running/);
    assert.match(afterReplan, /\| liczba generacji \| 2 \|/);
    assert.match(afterReplan, /\| porzucone generacje \| 1 \|/);
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

test("realny saveArtifact używa FACTORY_RUNS_ROOT, a przebieg linkuje artefakt", async () => {
  await withHarness("factory-run-log-artifact-", async ({ runsRoot, store, deps }) => {
    const ticketId = "BAR-LOG-6";
    const jobRunId = "job-review-shared-root";
    store.createRun(ticketId, "harness", manifest);
    store.startAttempt(ticketId, "review", 1, jobRunId);
    await saveArtifact(ticketId, jobRunId, "review.md", "realny artefakt review");
    store.finishAttempt(ticketId, "review", 1, {
      status: "success",
      outcome: "lgtm",
      signature: "reviewer · model-real@high",
      costUsd: 0.75,
      durationMs: 15_000,
    });
    applyTransition(deps, ticketId, {
      stage: "smoke",
      status: "done",
      actor: "coordinator",
      reason: "done-with-real-artifact",
    });

    assert.equal(
      await readFile(join(runsRoot, ticketId, jobRunId, "review.md"), "utf8"),
      "realny artefakt review"
    );
    const log = await readFile(join(runsRoot, ticketId, "przebieg.md"), "utf8");
    assert.match(log, /\.\/job-review-shared-root\/review\.md/);
  });
});

test("lokalna próba testów linkuje płaskie artefakty test-runnera", async () => {
  await withHarness("factory-run-log-local-test-", async ({ runsRoot, store, deps }) => {
    const ticketId = "BAR-LOG-LOCAL-TEST";
    const ticketDir = join(runsRoot, ticketId);
    const jobRunId = `local-test:${"a".repeat(40)}:2`;
    await mkdir(ticketDir, { recursive: true });
    await Promise.all([
      writeFile(join(ticketDir, "test-result-g1-a2.json"), "{}"),
      writeFile(join(ticketDir, "test-result-g1-a2.json.input.json"), "{}"),
      writeFile(join(ticketDir, "test-runner-a2.log"), "ok"),
      writeFile(join(ticketDir, "test-runner-a1.log"), "inna próba"),
    ]);

    store.createRun(ticketId, "harness", manifest);
    store.startAttempt(ticketId, "test", 2, jobRunId);
    store.finishAttempt(ticketId, "test", 2, {
      status: "success",
      outcome: "pass",
      signature: "test-runner · deterministic",
      durationMs: 2_000,
    });
    applyTransition(deps, ticketId, {
      stage: "smoke",
      status: "done",
      actor: "coordinator",
      reason: "local-tests-passed",
    });

    const log = await readFile(join(ticketDir, "przebieg.md"), "utf8");
    assert.match(log, /\.\/test-result-g1-a2\.json/);
    assert.match(log, /\.\/test-result-g1-a2\.json\.input\.json/);
    assert.match(log, /\.\/test-runner-a2\.log/);
    assert.doesNotMatch(log, /test-runner-a1\.log/);
    assert.doesNotMatch(log, /\.\/local-test%3A|\.\/local-test:/);
  });
});

test("pusty FACTORY_RUNS_ROOT używa katalogu runs obok package.json", async () => {
  await withHarness("factory-run-log-empty-root-", async ({ root }) => {
    process.env.FACTORY_RUNS_ROOT = "";
    assert.equal(runsRoot(), join(root, "runs"));
    process.env.FACTORY_RUNS_ROOT = "  \t  ";
    assert.equal(runsRoot(), join(root, "runs"));
  });
});

test("lifecycleDbPath trimuje FACTORY_LIFECYCLE_DB", async () => {
  await withHarness("factory-run-log-db-path-", async ({ root, runsRoot: configuredRunsRoot }) => {
    process.env.FACTORY_LIFECYCLE_DB = "";
    assert.equal(lifecycleDbPath(), join(configuredRunsRoot, "lifecycle.db"));

    process.env.FACTORY_LIFECYCLE_DB = "  \t  ";
    assert.equal(lifecycleDbPath(), join(configuredRunsRoot, "lifecycle.db"));

    const override = join(root, "custom-lifecycle.db");
    process.env.FACTORY_LIFECYCLE_DB = `  ${override}  `;
    assert.equal(lifecycleDbPath(), override);
  });
});

test("harness sprząta env i katalog, gdy LifecycleStore nie może wystartować", async () => {
  const originalRoot = process.env.FACTORY_ROOT;
  const originalRunsRoot = process.env.FACTORY_RUNS_ROOT;
  const originalLifecycleDb = process.env.FACTORY_LIFECYCLE_DB;
  const sentinelRoot = "/sentinel/factory-root";
  const sentinelRunsRoot = "/sentinel/runs-root";
  const sentinelLifecycleDb = "/sentinel/lifecycle.db";
  let failedRoot: string | undefined;
  process.env.FACTORY_ROOT = sentinelRoot;
  process.env.FACTORY_RUNS_ROOT = sentinelRunsRoot;
  process.env.FACTORY_LIFECYCLE_DB = sentinelLifecycleDb;

  try {
    await assert.rejects(
      withHarness(
        "factory-run-log-constructor-failure-",
        async () => assert.fail("callback nie może wystartować"),
        async ({ root, dbPath }) => {
          failedRoot = root;
          await mkdir(dbPath, { recursive: true });
        }
      )
    );
    assert.equal(process.env.FACTORY_ROOT, sentinelRoot);
    assert.equal(process.env.FACTORY_RUNS_ROOT, sentinelRunsRoot);
    assert.equal(process.env.FACTORY_LIFECYCLE_DB, sentinelLifecycleDb);
    assert.ok(failedRoot);
    await assert.rejects(access(failedRoot), { code: "ENOENT" });
  } finally {
    if (originalRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = originalRoot;
    if (originalRunsRoot === undefined) delete process.env.FACTORY_RUNS_ROOT;
    else process.env.FACTORY_RUNS_ROOT = originalRunsRoot;
    if (originalLifecycleDb === undefined) delete process.env.FACTORY_LIFECYCLE_DB;
    else process.env.FACTORY_LIFECYCLE_DB = originalLifecycleDb;
    if (failedRoot) {
      await rm(failedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

test("ponowny claim zamkniętego ticketu od razu odświeża przebieg", async () => {
  await withHarness("factory-run-log-reopen-", async (harness) => {
    const ticketId = "BAR-LOG-REOPEN";
    const binDir = join(harness.root, "bin");
    const previousPath = process.env.PATH;
    await mkdir(binDir);
    for (const binary of ["codex", "gh", "git"]) {
      const executable = join(binDir, binary);
      await writeFile(executable, [
        "#!/bin/sh",
        "printf '%s\\n' 'fake-tool 1.0.0'",
      ].join("\n"));
      await chmod(executable, 0o755);
    }
    await writeFile(join(harness.root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(harness.root)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    await writeFile(join(harness.root, "routing.yaml"), [
      "defaults:",
      "  plan: codex",
      "  build: codex",
      "  review: codex",
    ].join("\n"));

    let currentState = "Todo";
    const claims: string[] = [];
    const ticket = {
      id: ticketId,
      source: "linear",
      title: manifest.title,
      description: manifest.description,
      labels: manifest.labels,
      url: manifest.url,
    };
    const source = {
      listReady: async () => [ticket],
      listComments: async () => [],
      listStateNames: async () => [
        "Todo", "In Progress", "In Review", "Done", "Canceled", "👤 ⛔ Zablokowany",
      ],
      claim: async (id: string) => {
        claims.push(id);
        currentState = "In Progress";
      },
      getStateName: async () => currentState,
      setStateByName: async (_id: string, state: string) => { currentState = state; },
      comment: async () => {},
    } as unknown as LinearSource;
    harness.deps.sources.set("harness", source);
    harness.deps.mastra = {
      serverUp: async () => true,
      createRun: async (runId?: string) => runId ?? "fake-run",
      startRun: async () => {},
      resumeRun: async () => {},
      getRun: async () => ({ status: "pending" }),
      cancelRun: async () => {},
    } as unknown as PollerDependencies["mastra"];

    harness.store.createRun(ticketId, "harness", manifest);
    applyTransition(harness.deps, ticketId, {
      stage: "smoke",
      status: "done",
      actor: "coordinator",
      reason: "first-generation-done",
    });
    const path = join(harness.runsRoot, ticketId, "przebieg.md");
    assert.match(await readFile(path, "utf8"), /- Status: done/);

    try {
      process.env.PATH = `${binDir}:${previousPath ?? ""}`;
      await pollOnce(harness.deps);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    const reopened = await readFile(path, "utf8");
    assert.equal(harness.store.getRun(ticketId)?.generation, 2);
    assert.match(reopened, /- Status: w toku — generacja 2, etap plan\/running/);
    assert.match(reopened, /\| liczba generacji \| 2 \|/);
    assert.doesNotMatch(reopened, /- Status: done/);
    assert.deepEqual(claims, [ticketId]);
  });
});

test("reopen zachowuje pełny lead time i nie porzuca zakończonej generacji", async () => {
  await withHarness("factory-run-log-reopen-lead-time-", async (harness) => {
    const ticketId = "BAR-LOG-REOPEN-LEAD-TIME";
    harness.store.createRun(ticketId, "harness", manifest);
    applyDecision(
      harness.deps,
      ticketId,
      reduceLifecycle(harness.store.getRun(ticketId)!, { type: "start", nextAttempt: 1 })
    );
    applyTransition(harness.deps, ticketId, {
      stage: "smoke",
      status: "done",
      actor: "coordinator",
      reason: "first-generation-done",
    });

    const clock = Date.now();
    const firstTransitionAt = new Date(clock - 120 * 60_000).toISOString();
    const firstTerminalAt = new Date(clock - 90 * 60_000).toISOString();
    const firstActiveEndAt = new Date(clock - 30 * 60_000).toISOString();
    const db = new DatabaseSync(harness.dbPath);
    try {
      db.prepare(`
        UPDATE lifecycle_transitions SET created_at=?
        WHERE id=(
          SELECT id FROM lifecycle_transitions
          WHERE ticket_id=? ORDER BY id ASC LIMIT 1
        )
      `).run(firstTransitionAt, ticketId);
      db.prepare(`
        UPDATE lifecycle_transitions SET created_at=?
        WHERE id=(
          SELECT id FROM lifecycle_transitions
          WHERE ticket_id=? AND to_status='done' ORDER BY id DESC LIMIT 1
        )
      `).run(firstTerminalAt, ticketId);
      db.prepare(
        "UPDATE lifecycle_runs SET created_at=?, updated_at=? WHERE ticket_id=?"
      ).run(firstTransitionAt, firstTerminalAt, ticketId);
    } finally {
      db.close();
    }

    harness.store.createRun(ticketId, "harness", manifest);
    applyDecision(
      harness.deps,
      ticketId,
      reduceLifecycle(harness.store.getRun(ticketId)!, { type: "start", nextAttempt: 2 })
    );

    const reopenedDb = new DatabaseSync(harness.dbPath);
    try {
      reopenedDb.prepare(
        "UPDATE lifecycle_runs SET updated_at=? WHERE ticket_id=?"
      ).run(firstActiveEndAt, ticketId);
    } finally {
      reopenedDb.close();
    }

    const path = join(harness.runsRoot, ticketId, "przebieg.md");
    writeRunLog(harness.store, harness.store.getRun(ticketId)!);
    const reopened = await readFile(path, "utf8");
    const reopenedLead = Number(
      reopened.match(/\| lead time \(w toku\) \| ([\d.]+) min \|/)?.[1]
    );
    assert.match(reopened, /\| liczba generacji \| 2 \|/);
    assert.doesNotMatch(reopened, /porzucone generacje/);
    assert.ok(reopenedLead >= 90, `${reopenedLead} powinno obejmować pierwszą generację`);

    applyTransition(harness.deps, ticketId, {
      stage: "approval",
      status: "waiting_human",
      actor: "coordinator",
      reason: "second-generation-plan-ready",
    });
    writeRunLog(harness.store, harness.store.getRun(ticketId)!);
    const advanced = await readFile(path, "utf8");
    const advancedLead = Number(
      advanced.match(/\| lead time \(w toku\) \| ([\d.]+) min \|/)?.[1]
    );
    assert.ok(advancedLead > reopenedLead, `${advancedLead} powinno być większe od ${reopenedLead}`);
  });
});

test("/reject zachowuje skrócone uzasadnienie po /replan i jest decyzją człowieka", async () => {
  await withHarness("factory-run-log-reject-", async ({ runsRoot, store, deps }) => {
    const ticketId = "BAR-LOG-7";
    const operatorReason = "regresja na starym imporcie X | `wariant`\n trzeba poprawić";
    store.createRun(ticketId, "harness", manifest);
    applyTransition(deps, ticketId, {
      stage: "approval",
      status: "waiting_human",
      actor: "coordinator",
      reason: "plan-ready",
    });
    applyDecision(deps, ticketId, reduceLifecycle(store.getRun(ticketId)!, {
      type: "reject",
      commentId: "c-reject",
      reason: operatorReason,
    }));

    const rejected = store.getRun(ticketId)!;
    assert.equal(rejected.errorMessage, operatorReason, "pełny powód pozostaje w stanie runu");
    assert.match(
      buildRunLog(store, rejected),
      /- Status: zablokowany \(PLAN_REJECTED\) — generacja 1 aktywna/
    );
    const rejectTransition = store.listTransitions(ticketId).find((transition) =>
      transition.reason.startsWith("PLAN_REJECTED /reject ")
    );
    assert.equal(
      rejectTransition?.reason,
      "PLAN_REJECTED /reject c-reject: regresja na starym imporcie X wariant trzeba poprawić"
    );

    applyDecision(deps, ticketId, reduceLifecycle(rejected, {
      type: "replan",
      commentId: "c-replan-after-reject",
      reason: "uwzględnij regresję",
      nextAttempt: 1,
    }));
    const log = await readFile(join(runsRoot, ticketId, "przebieg.md"), "utf8");
    assert.match(log, /regresja na starym imporcie X wariant trzeba poprawić/);
    assert.match(log, /\| przejścia wywołane przez człowieka \| 2 \|/);
    assert.match(log, /## Decyzje człowieka \(2\)/);
    assert.match(log, /\| porzucone generacje \| 1 \|/);
  });
});

test("powody i błędy z pipe oraz nową linią nie psują tabel markdown", async () => {
  await withHarness("factory-run-log-escape-", async ({ store }) => {
    const ticketId = "BAR-LOG-8";
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

test("/score po Done zachowuje terminalny lead time i nadpisuje świeżą oceną", async () => {
  await withHarness("factory-run-log-score-", async (harness) => {
    const ticketId = "BAR-LOG-9";
    await seedCompletedRun(harness, ticketId);
    const path = join(harness.runsRoot, ticketId, "przebieg.md");
    const clock = Date.now();
    const createdAt = new Date(clock - 60 * 60_000).toISOString();
    const terminalAt = new Date(clock - 30 * 60_000).toISOString();
    const db = new DatabaseSync(harness.dbPath);
    try {
      db.prepare(
        "UPDATE lifecycle_runs SET created_at=?, updated_at=? WHERE ticket_id=?"
      ).run(createdAt, terminalAt, ticketId);
      db.prepare(`
        UPDATE lifecycle_transitions SET created_at=?
        WHERE id=(
          SELECT id FROM lifecycle_transitions
          WHERE ticket_id=? AND to_status='done' ORDER BY id DESC LIMIT 1
        )
      `).run(terminalAt, ticketId);
    } finally {
      db.close();
    }
    assert.equal(harness.store.terminalTransitionAt(ticketId), terminalAt);
    writeRunLog(harness.store, harness.store.getRun(ticketId)!);
    const beforeScore = await readFile(path, "utf8");
    assert.match(beforeScore, /\| lead time \| 30\.00 min \|/);
    assert.match(beforeScore, /\| ocena \/score \| — \|/);

    const comments: string[] = [];
    const source = {
      listComments: async () => [{
        id: "c-score",
        body: "/score 4 solidnie",
        createdAt: new Date().toISOString(),
      }],
      comment: async (_ticket: string, body: string) => { comments.push(body); },
    } as unknown as LinearSource;
    harness.deps.sources.set("harness", source);

    await sweepScores(harness.deps);

    assert.equal(harness.store.getRun(ticketId)?.score, 4);
    const log = await readFile(path, "utf8");
    assert.equal(
      log.split("\n").find((line) => line.startsWith("| lead time |")),
      beforeScore.split("\n").find((line) => line.startsWith("| lead time |"))
    );
    assert.match(log, /\| ocena \/score \| 4\/5 — solidnie \|/);
    assert.match(log, /## Oś czasu/);
    assert.match(log, /\.\/job-review-g2\/review\.md/);
    assert.equal(comments.length, 1);
  });
});

test("/score aktywnego runu zapisuje przebieg bez fałszywie porzuconej generacji", async () => {
  await withHarness("factory-run-log-active-score-", async ({ runsRoot, store, deps }) => {
    const ticketId = "BAR-LOG-10";
    const scoreComment = {
      id: "c-active-score",
      body: "/score 5 trafna diagnoza",
      createdAt: new Date().toISOString(),
    };
    const ticket = {
      id: ticketId,
      source: "linear",
      title: manifest.title,
      description: manifest.description,
      labels: manifest.labels,
      url: manifest.url,
      stateName: "In Progress",
    };
    const snapshot = buildCommentContextSnapshot(
      ticketId,
      ticket.title,
      ticket.description,
      [scoreComment]
    );
    store.createRun(ticketId, "harness", {
      ...manifest,
      inputHash: snapshot.effectiveInputHash,
    });
    applyTransition(deps, ticketId, {
      stage: "approval",
      status: "waiting_human",
      actor: "coordinator",
      reason: "plan-ready-active",
    });
    const clock = Date.now();
    const createdAt = new Date(clock - 60 * 60_000).toISOString();
    const beforeScoreAt = new Date(clock - 50 * 60_000).toISOString();
    const db = new DatabaseSync(join(runsRoot, "lifecycle.db"));
    try {
      db.prepare(
        "UPDATE lifecycle_runs SET created_at=?, updated_at=? WHERE ticket_id=?"
      ).run(createdAt, beforeScoreAt, ticketId);
    } finally {
      db.close();
    }
    const path = join(runsRoot, ticketId, "przebieg.md");
    writeRunLog(store, store.getRun(ticketId)!);
    const beforeScore = await readFile(path, "utf8");
    const beforeLead = Number(
      beforeScore.match(/\| lead time \(w toku\) \| ([\d.]+) min \|/)?.[1]
    );

    const acknowledgements: string[] = [];
    const source = {
      listComments: async () => [scoreComment],
      comment: async (_ticket: string, body: string) => { acknowledgements.push(body); },
      getStateName: async () => "In Progress",
      getTicket: async () => ticket,
    } as unknown as LinearSource;
    deps.sources.set("harness", source);

    await reconcileRun(deps, store.getRun(ticketId)!);

    assert.equal(store.getRun(ticketId)?.score, 5);
    const activeLog = await readFile(path, "utf8");
    const afterLead = Number(
      activeLog.match(/\| lead time \(w toku\) \| ([\d.]+) min \|/)?.[1]
    );
    assert.equal(beforeLead, 10);
    assert.ok(afterLead > beforeLead, `${afterLead} powinno być większe od ${beforeLead}`);
    assert.match(activeLog, /- Status: w toku — generacja 1, etap approval\/waiting_human/);
    assert.match(activeLog, /\| lead time \(w toku\) \|/);
    assert.match(activeLog, /\| ocena \/score \| 5\/5 — trafna diagnoza \|/);
    assert.doesNotMatch(activeLog, /porzucon/);
    assert.equal(acknowledgements.length, 1);

    applyDecision(deps, ticketId, reduceLifecycle(store.getRun(ticketId)!, {
      type: "replan",
      commentId: "c-active-replan",
      reason: "nowa generacja",
      nextAttempt: 1,
    }));
    const replannedLog = await readFile(path, "utf8");
    assert.match(replannedLog, /\| porzucone generacje \| 1 \|/);
    assert.match(replannedLog, /- Status: w toku — generacja 2, etap plan\/running/);
  });
});

test("INPUT_CHANGED_AFTER_BUILD jest oznaczone i liczone jako decyzja człowieka", async () => {
  await withHarness("factory-run-log-input-changed-after-build-", async ({ store, deps }) => {
    const ticketId = "BAR-LOG-ICAB";
    store.createRun(ticketId, "harness", manifest);
    const current = applyTransition(deps, ticketId, {
      stage: "approval",
      status: "waiting_human",
      actor: "coordinator",
      reason: "plan-ready",
    });
    const blocked = applyTransition(deps, ticketId, {
      stage: current.stage,
      status: "blocked",
      actor: "coordinator",
      reason: "INPUT_CHANGED_AFTER_BUILD",
      patch: {
        errorCode: "INPUT_CHANGED_AFTER_BUILD",
        errorMessage: "Autor zmienił wejście po rozpoczęciu builda.",
      },
    });

    const log = buildRunLog(store, blocked);
    assert.match(log, /\| przejścia wywołane przez człowieka \| 1 \|/);
    assert.match(log, /## Decyzje człowieka \(1\)/);

    const humanSection = log.split("## Decyzje człowieka (1)")[1].split("## Oś czasu")[0];
    assert.match(humanSection, /INPUT_CHANGED_AFTER_BUILD/);
    assert.equal(humanSection.split("\n").filter((line) => /^\| \d+/.test(line)).length, 1);

    const timeline = log.split("## Oś czasu")[1].split("## Próby etapów")[0];
    assert.match(
      timeline.split("\n").find((line) => line.includes("INPUT_CHANGED_AFTER_BUILD"))!,
      /👤 \|$/
    );
    assert.match(
      timeline.split("\n").find((line) => line.includes("plan-ready"))!,
      /— \|$/
    );
  });
});
