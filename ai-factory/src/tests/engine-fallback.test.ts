import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineAdapter, EngineRunResult } from "../engines/types";
import { classifyEngineFailure } from "../pipeline/failure-classes";
import {
  executeFactoryJobInput,
  type FactoryJobRuntime,
} from "../pipeline/factory-job";
import type { Route } from "../pipeline/routing";
import { createTestGitRepo, useTestWorktrees } from "./git-fixture";

const validPlan = [
  "# Plan",
  "```factory",
  '{"verdict":"ok","screenshots":[],"files":["src/a.ts"],"domain":"backend"}',
  "```",
].join("\n");

const ticket = {
  id: "BAR-FB",
  title: "Fallback",
  description: "Sprawdź fallback silnika.",
  project: "fake",
  labels: [] as string[],
  inputHash: "hash-fallback",
};

function route(engine: EngineAdapter, spec: string, model: string): Route {
  return { engine, spec, model, effort: "high", cliVersion: "1.0" };
}

function runtimeWith(
  repo: string,
  primary: EngineAdapter,
  fallback: EngineAdapter
): FactoryJobRuntime {
  const primaryRoute = route(primary, "primary/primary-model@high", "primary-model");
  const fallbackRoute = route(fallback, "fallback/fallback-model@high", "fallback-model");
  return {
    async route() {
      return primaryRoute;
    },
    async routeCandidates() {
      return [primaryRoute, fallbackRoute];
    },
    async project() {
      return { repo, default_branch: "main", checks: ["true"] };
    },
  };
}

async function withFixture(
  name: string,
  run: (fixture: { root: string; repo: string }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `factory-engine-fallback-${name}-`));
  const previousRoot = process.env.FACTORY_ROOT;
  const restoreWorktrees = useTestWorktrees(root);
  process.env.FACTORY_ROOT = root;
  await writeFile(join(root, "package.json"), "{}");
  const repo = createTestGitRepo(root);
  try {
    await run({ root, repo });
  } finally {
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    restoreWorktrees();
    await rm(root, { recursive: true, force: true });
  }
}

function adapter(
  name: string,
  result: EngineRunResult | ((workspace: string) => Promise<EngineRunResult>),
  calls: { count: number }
): EngineAdapter {
  return {
    name,
    async run(input) {
      calls.count += 1;
      return typeof result === "function" ? result(input.workspace) : result;
    },
  };
}

test("infra-pad głównego przechodzi na zapas z jawną metryką, artefaktem i podpisem", async () => {
  await withFixture("success", async ({ root, repo }) => {
    const primaryCalls = { count: 0 };
    const fallbackCalls = { count: 0 };
    const runtime = runtimeWith(
      repo,
      adapter("primary", {
        ok: false,
        report: "failed to lookup address information",
        costUsd: 1,
      }, primaryCalls),
      adapter("fallback", { ok: true, report: validPlan, costUsd: 2 }, fallbackCalls)
    );

    const output = await executeFactoryJobInput(
      { kind: "plan", attempt: 1, ticket, planFiles: [] },
      "run-success",
      undefined,
      runtime
    );

    assert.equal(output.outcome, "success");
    assert.equal(output.costUsd, 3);
    assert.deepEqual([primaryCalls.count, fallbackCalls.count], [1, 1]);
    assert.deepEqual(output.engineFallback, {
      from: "primary/primary-model@high",
      to: "fallback/fallback-model@high",
      reason: "failed to lookup address information",
    });
    assert.match(output.signature, /fallback.*fallback-model@high.*planner/);

    const rows = (await readFile(join(root, "runs", "metrics.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => [row.engine, row.costUsd, row.fallbackDecision]),
      [
        ["primary/primary-model@high", 1, "used"],
        ["fallback/fallback-model@high", 2, undefined],
      ]
    );
    assert.equal(rows[1].engineFallback, "primary/primary-model@high → fallback/fallback-model@high");
    assert.equal(rows.reduce((sum, row) => sum + Number(row.costUsd), 0), output.costUsd);

    const artifact = await readFile(
      join(root, "runs", ticket.id, "run-success", "plan-attempt-1.md"),
      "utf8"
    );
    assert.match(artifact, /^model: fallback-model@high$/m);
    assert.match(artifact, /^engine: fallback\/fallback-model@high$/m);
    assert.match(
      artifact,
      /^engineFallback: primary\/primary-model@high → fallback\/fallback-model@high$/m
    );
  });
});

test("wyniki merytoryczne nie uruchamiają zapasu", async () => {
  await withFixture("work-results", async ({ repo }) => {
    const cases: Array<{
      name: string;
      kind: "plan" | "review";
      result: EngineRunResult;
      expected: string;
    }> = [
      { name: "brak werdyktu", kind: "plan", result: { ok: true, report: "raport bez kontraktu" }, expected: "failed" },
      {
        name: "plan blocked",
        kind: "plan",
        result: {
          ok: true,
          report: '```factory\n{"verdict":"blocked","questions":"1. Zakres? A) mały B) duży","screenshots":[],"files":[]}\n```',
        },
        expected: "questions",
      },
      {
        name: "review fix",
        kind: "review",
        result: { ok: true, report: '```factory\n{"verdict":"fix"}\n```' },
        expected: "success",
      },
      {
        name: "nieznany błąd pracy",
        kind: "plan",
        result: { ok: false, report: "PLAN: BLOCKED — wymagania są sprzeczne" },
        expected: "failed",
      },
    ];
    const headSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    for (const [index, testCase] of cases.entries()) {
      const primaryCalls = { count: 0 };
      const fallbackCalls = { count: 0 };
      const runtime = runtimeWith(
        repo,
        adapter(`primary-${index}`, testCase.result, primaryCalls),
        adapter(`fallback-${index}`, { ok: true, report: validPlan }, fallbackCalls)
      );
      const output = await executeFactoryJobInput(
        {
          kind: testCase.kind,
          attempt: index + 1,
          ticket: { ...ticket, id: `BAR-FB-W${index}` },
          planFiles: [],
          headSha: testCase.kind === "review" ? headSha : undefined,
        },
        `run-work-${index}`,
        undefined,
        runtime
      );
      assert.equal(output.outcome, testCase.expected, testCase.name);
      assert.deepEqual([primaryCalls.count, fallbackCalls.count], [1, 0], testCase.name);
      if (testCase.kind === "review") assert.equal(output.reviewVerdict, "advisory-fix");
    }
  });
});

test("pad zapasu kończy etap bez trzeciej próby", async () => {
  await withFixture("double-fail", async ({ repo }) => {
    const primaryCalls = { count: 0 };
    const fallbackCalls = { count: 0 };
    const runtime = runtimeWith(
      repo,
      adapter("primary", { ok: false, report: "getaddrinfo ENOTFOUND primary", costUsd: 1 }, primaryCalls),
      adapter("fallback", { ok: false, report: "getaddrinfo ENOTFOUND fallback", costUsd: 2 }, fallbackCalls)
    );
    const output = await executeFactoryJobInput(
      { kind: "plan", attempt: 1, ticket, planFiles: [] },
      "run-double-fail",
      undefined,
      runtime
    );
    assert.deepEqual([output.outcome, output.errorCode, output.costUsd], ["failed", "PLAN_ENGINE_FAILED", 3]);
    assert.deepEqual([primaryCalls.count, fallbackCalls.count], [1, 1]);
    assert.equal(output.engineFallback?.to, "fallback/fallback-model@high");
  });
});

test("brak headroomu budżetu blokuje zapas", async () => {
  await withFixture("budget", async ({ root, repo }) => {
    const primaryCalls = { count: 0 };
    const fallbackCalls = { count: 0 };
    const runtime = runtimeWith(
      repo,
      adapter("primary", { ok: false, report: "429 rate limit", costUsd: 1 }, primaryCalls),
      adapter("fallback", { ok: true, report: validPlan, costUsd: 2 }, fallbackCalls)
    );
    const output = await executeFactoryJobInput(
      { kind: "plan", attempt: 1, ticket, planFiles: [], allowEngineFallback: false },
      "run-budget",
      undefined,
      runtime
    );
    assert.deepEqual([output.outcome, primaryCalls.count, fallbackCalls.count], ["failed", 1, 0]);
    const metric = JSON.parse(
      (await readFile(join(root, "runs", "metrics.jsonl"), "utf8")).trim()
    ) as Record<string, unknown>;
    assert.equal(metric.fallbackDecision, "budget");
  });
});

test("build czyści częściową pracę głównego silnika przed zapasem", async () => {
  await withFixture("build-reset", async ({ repo }) => {
    const primaryCalls = { count: 0 };
    const fallbackCalls = { count: 0 };
    const runtime = runtimeWith(
      repo,
      adapter("primary", async (workspace) => {
        await writeFile(join(workspace, "partial.txt"), "częściowa praca\n");
        return { ok: false, report: "failed to connect to websocket", costUsd: 1 };
      }, primaryCalls),
      adapter("fallback", async (workspace) => {
        assert.equal(existsSync(join(workspace, "partial.txt")), false);
        await writeFile(join(workspace, "fallback.txt"), "gotowe\n");
        return { ok: true, report: "Fallback zbudował zmianę.", costUsd: 2 };
      }, fallbackCalls)
    );
    const output = await executeFactoryJobInput(
      {
        kind: "build",
        attempt: 1,
        ticket: { ...ticket, id: "BAR-FB-BUILD" },
        plan: "zatwierdzony plan",
        planFiles: ["fallback.txt"],
      },
      "run-build-reset",
      undefined,
      runtime
    );
    assert.equal(output.outcome, "success");
    assert.deepEqual([primaryCalls.count, fallbackCalls.count], [1, 1]);
    assert.deepEqual(output.changedFiles, ["fallback.txt"]);
    assert.ok(output.headSha);
    assert.match(output.signature, /fallback.*fallback-model@high.*builder/);
  });
});

test("classifyEngineFailure rozdziela awarie infrastruktury od wyników pracy", () => {
  for (const message of [
    "failed to lookup address information",
    "failed to connect to websocket",
    "credit balance is too low",
    "429 rate limit",
    "spawn claude ENOENT",
    "request timeout",
  ]) {
    assert.equal(classifyEngineFailure(message), "infra", message);
  }
  for (const message of [
    "PLAN: BLOCKED",
    "brak werdyktu",
    "recenzja z uwagami",
    "budżet ticketu wyczerpany",
  ]) {
    assert.equal(classifyEngineFailure(message), "work", message);
  }
});
