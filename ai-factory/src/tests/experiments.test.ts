import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifecycleStore, type TicketManifestV2 } from "../pipeline/lifecycle-store";
import { reduceLifecycle } from "../pipeline/coordinator";
import {
  buildExperimentSummary,
  type ExperimentRow,
  type ExperimentSummaryRow,
} from "../metrics/experiments";
import { loadExperimentRows, mergeRows, renderReport } from "../metrics/experiment-report";
import { applyDecision, sweepScores, type PollerDependencies } from "../sources/poll-linear-v2";

const manifest: TicketManifestV2 = {
  title: "Eksperyment",
  description: "opis",
  labels: [],
  inputHash: "hash-1",
};

/** Zapisy eksperymentu są fire-and-forget — polluj plik zamiast stałego sleepa. */
async function readWhenReady(path: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const raw = await readFile(path, "utf8");
      if (raw.trim()) return raw;
    } catch {
      // plik jeszcze nie istnieje
    }
    if (Date.now() > deadline) throw new Error(`Brak pliku ${path} w limicie ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("buildExperimentSummary agreguje próby, koszty, first-pass i wariant procesu", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-exp-summary-"));
  const store = new LifecycleStore(join(dir, "registry.db"));
  try {
    store.createRun("BAR-E1", "br-budget", manifest);
    // plan/test: pierwsza próba nieudana, druga udana → firstTryOk false
    store.startAttempt("BAR-E1", "synthesis", 1, "job-s1");
    store.finishAttempt("BAR-E1", "synthesis", 1, {
      status: "failed", outcome: "SYNTHESIS_ENGINE_FAILED", costUsd: 1, durationMs: 120_000,
      signature: "ai-factory · claude-code@2.1 · claude-opus-5@xhigh · planner",
    });
    store.startAttempt("BAR-E1", "synthesis", 2, "job-s2");
    store.finishAttempt("BAR-E1", "synthesis", 2, {
      status: "success", outcome: "success", costUsd: 2, durationMs: 300_000,
      signature: "ai-factory · claude-code@2.1 · claude-opus-5@xhigh · planner",
    });
    store.startAttempt("BAR-E1", "research-recon", 1, "job-rr1");
    store.finishAttempt("BAR-E1", "research-recon", 1, {
      status: "success", outcome: "success", costUsd: 0.7, durationMs: 240_000,
      signature: "ai-factory · claude-code@2.1 · claude-opus-5@high · researcher",
    });
    store.markCommentProcessed("BAR-E1", "c1", "retry");
    store.markCommentProcessed("BAR-E1", "c2", "replan");
    store.markCommentProcessed("BAR-E1", "c3", "approve");
    const run = store.transition("BAR-E1", {
      stage: "smoke",
      status: "done",
      actor: "test",
      reason: "done",
      patch: {
        planEntry: "triage",
        planVariant: "deep",
        degradations: ["research solution-b: niedostępny"],
        critiqueVerdict: "ok",
        reviewStatus: "lgtm",
        smokeStatus: "pass",
        prUrl: "https://github.test/o/r/pull/9",
        score: 4,
        scoreComment: "dobry plan",
      },
    });
    const summary = buildExperimentSummary(store, run);
    assert.equal(summary.variant, "deep");
    assert.equal(summary.totalUsd, 3.7);
    assert.equal(summary.stages.synthesis.attempts, 2);
    assert.equal(summary.stages.synthesis.firstTryOk, false);
    assert.equal(summary.stages["research-recon"].firstTryOk, true);
    assert.match(summary.stages["research-recon"].signature ?? "", /claude-opus-5@high/);
    assert.deepEqual([summary.retries, summary.replans], [1, 1]);
    assert.deepEqual([summary.score, summary.critiqueVerdict], [4, "ok"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ukończenie ticketu przez applyDecision zapisuje wiersz summary do experiments.jsonl", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-exp-done-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  try {
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(root)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    process.env.FACTORY_ROOT = root;
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map(),
      notifier: async () => {},
    };
    store.createRun("BAR-E2", "harness", manifest);
    store.transition("BAR-E2", {
      stage: "smoke",
      status: "pending",
      actor: "test",
      reason: "post-merge",
      patch: { planVariant: "solo", mergedSha: "b".repeat(40), prUrl: "https://github.test/pr/1" },
    });
    applyDecision(deps, "BAR-E2", reduceLifecycle(store.getRun("BAR-E2")!, {
      type: "smoke-result",
      outcome: "skipped-not-configured",
      report: "brak checków",
    }));
    const raw = await readWhenReady(join(root, "runs", "experiments.jsonl"));
    const rows = raw.trim().split("\n").map((line) => JSON.parse(line) as ExperimentRow);
    const summary = rows.find((row) => row.kind === "summary") as ExperimentSummaryRow;
    assert.equal(summary.ticket, "BAR-E2");
    assert.equal(summary.variant, "solo");
    assert.equal(summary.smokeStatus, "skipped-not-configured");
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("sweepScores: /score na ukończonym tickecie zapisuje ocenę, potwierdza i nie dubluje", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-exp-score-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  const confirmations: string[] = [];
  let scoreComment = { id: "c-score", body: "/score 4 solidnie", createdAt: "2026-07-29T10:00:00Z" };
  try {
    await writeFile(join(root, "package.json"), "{}");
    process.env.FACTORY_ROOT = root;
    store.createRun("BAR-E3", "harness", manifest);
    store.transition("BAR-E3", {
      stage: "smoke", status: "done", actor: "test", reason: "done",
      patch: { planVariant: "deep", smokeStatus: "pass" },
    });
    const source = {
      async listComments() { return [scoreComment]; },
      async comment(_id: string, body: string) { confirmations.push(body); },
    };
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async () => {},
    };
    await sweepScores(deps);
    const run = store.getRun("BAR-E3")!;
    assert.deepEqual([run.score, run.scoreComment], [4, "solidnie"]);
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0], /4\/5/);
    assert.equal(store.isCommentProcessed("c-score"), true);

    // Oceniony run znika z kandydatów — kolejny sweep nic nie robi.
    scoreComment = { ...scoreComment, id: "c-score-2" };
    await sweepScores(deps);
    assert.equal(confirmations.length, 1);

    const raw = await readWhenReady(join(root, "runs", "experiments.jsonl"));
    const scoreRows = raw.trim().split("\n")
      .map((line) => JSON.parse(line) as ExperimentRow)
      .filter((row) => row.kind === "score");
    assert.equal(scoreRows.length, 1);
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("/replan kasuje ocenę /score poprzedniej generacji (rating jest per generacja)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-exp-score-gen-"));
  const store = new LifecycleStore(join(dir, "registry.db"));
  try {
    store.createRun("BAR-E4", "harness", manifest);
    store.transition("BAR-E4", {
      stage: "approval",
      status: "waiting_human",
      actor: "test",
      reason: "plan-ready",
      patch: { plan: "plan", planFiles: ["src/a.ts"] },
    });
    store.setScore("BAR-E4", 5, "przedwczesna ocena");
    assert.equal(store.getRun("BAR-E4")?.score, 5);
    const decision = reduceLifecycle(store.getRun("BAR-E4")!, {
      type: "replan",
      commentId: "c-replan",
      reason: "zmiana koncepcji",
    });
    const run = store.transition("BAR-E4", {
      ...decision.transition,
      commands: decision.commands,
    });
    assert.deepEqual(
      [run.generation, run.score, run.scoreComment, run.scoredAt],
      [2, undefined, undefined, undefined]
    );
    // Wyczyszczony scoredAt przywraca ticket do sweepa po ukończeniu nowej generacji.
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("raport eksperymentu łączy summary ze score i grupuje per wariant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-exp-report-"));
  const path = join(dir, "experiments.jsonl");
  try {
    const rows: ExperimentRow[] = [
      {
        kind: "summary", ticket: "BAR-1", generation: 1, project: "br-budget", variant: "deep",
        totalUsd: 9, totalMinutes: 60, leadTimeMs: 3_600_000,
        stages: { test: { attempts: 1, usd: 0, minutes: 10, firstTryOk: true } },
        reviewStatus: "lgtm", retries: 0, replans: 0,
      },
      {
        kind: "summary", ticket: "BAR-2", generation: 1, project: "br-budget", variant: "solo",
        totalUsd: 5, totalMinutes: 40, leadTimeMs: 7_200_000,
        stages: { test: { attempts: 2, usd: 0, minutes: 20, firstTryOk: false } },
        reviewStatus: "advisory-fix", retries: 1, replans: 0,
      },
      { kind: "score", ticket: "BAR-1", generation: 1, project: "br-budget", score: 5 },
    ];
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const merged = mergeRows(loadExperimentRows(path));
    assert.equal(merged.find((row) => row.ticket === "BAR-1")?.score, 5);
    const report = renderReport(merged);
    assert.match(report, /\| deep \| 1 \| 9\.00 /);
    assert.match(report, /\| solo \| 1 \| 5\.00 /);
    assert.match(report, /100% \(1\/1\)/);
    assert.match(report, /5\.0 \(n=1\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
