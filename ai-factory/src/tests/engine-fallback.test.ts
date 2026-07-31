import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EngineAdapter, EngineRunResult } from "../engines/types";
import {
  classifyEngineFailure,
  classifyEngineRunFailure,
} from "../pipeline/failure-classes";
import {
  executeFactoryJobInput,
  type FactoryJobRuntime,
} from "../pipeline/factory-job";
import type { Route } from "../pipeline/routing";
import { createTestGitRepo, useTestWorktrees } from "./git-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const factoryDir = join(here, "../..");

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
  result: EngineRunResult | ((
    workspace: string,
    budgetMinutes: number
  ) => Promise<EngineRunResult>),
  calls: { count: number }
): EngineAdapter {
  return {
    name,
    async run(input) {
      calls.count += 1;
      return typeof result === "function"
        ? result(input.workspace, input.budget.minutes)
        : result;
    },
  };
}

function runAdapterInChild(
  moduleName: "codex" | "claude-code",
  exportName: "codex" | "claudeCode",
  binEnv: "CODEX_BIN" | "CLAUDE_BIN",
  bin: string,
  workspace: string
): EngineRunResult {
  const moduleUrl = pathToFileURL(
    join(factoryDir, "src", "engines", `${moduleName}.ts`)
  ).href;
  const source = [
    `const { ${exportName} } = await import(${JSON.stringify(moduleUrl)});`,
    `const result = await ${exportName}.run(${JSON.stringify({
      role: "plan",
      instructions: "instrukcje",
      context: "kontekst",
      workspace,
      budget: { minutes: 1 },
    })});`,
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: factoryDir,
      env: { ...process.env, [binEnv]: bin },
      encoding: "utf8",
    }
  );
  return JSON.parse(stdout) as EngineRunResult;
}

test("infra-pad głównego przechodzi na zapas z jawną metryką, artefaktem i podpisem", async () => {
  await withFixture("success", async ({ root, repo }) => {
    const primaryCalls = { count: 0 };
    const fallbackCalls = { count: 0 };
    const budgets: number[] = [];
    const runtime = runtimeWith(
      repo,
      adapter("primary", async (_workspace, budgetMinutes) => {
        budgets.push(budgetMinutes);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          ok: false,
          report: "failed to lookup address information",
          stderr: "failed to lookup address information",
          terminationReason: "process-error",
          costUsd: 1,
        };
      }, primaryCalls),
      adapter("fallback", async (_workspace, budgetMinutes) => {
        budgets.push(budgetMinutes);
        return { ok: true, report: validPlan, costUsd: 2 };
      }, fallbackCalls)
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
    // Zapas dostaje PEŁNY budżet roli, nie resztę po próbie głównej. Dzielenie
    // budżetu dawało po timeoucie głównego silnika ułamek sekundy na drugą
    // próbę — czyli gwarantowaną porażkę i podwójny rachunek. Poller wpuszcza
    // zapas dopiero przy miejscu na dwie pełne rezerwacje, a lease liczy je obie.
    assert.equal(budgets[0], 20);
    assert.equal(budgets[1], 20);
    assert.deepEqual(output.engineFallback, {
      from: "primary/primary-model@high",
      to: "fallback/fallback-model@high",
      reason: "failed to lookup address information\nprocess-error",
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
        ["fallback/fallback-model@high", 2, "used"],
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
    const primaryArtifact = await readFile(
      join(root, "runs", ticket.id, "run-success", "plan-attempt-1-primary.md"),
      "utf8"
    );
    assert.match(primaryArtifact, /^engine: primary\/primary-model@high$/m);
    assert.match(primaryArtifact, /failed to lookup address information/);
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
      {
        name: "proza modelu o awariach",
        kind: "plan",
        result: {
          ok: false,
          report: "Plan opisuje timeout, 429 rate limit i websocket jako wymagania systemu.",
        },
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
      adapter("primary", {
        ok: false,
        report: "getaddrinfo ENOTFOUND primary",
        stderr: "getaddrinfo ENOTFOUND primary",
        terminationReason: "process-error",
        costUsd: 1,
      }, primaryCalls),
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
    assert.equal(metric.outcome, "failed");
    assert.equal(metric.humanSummary, "summary-missing");
    assert.equal(metric.resumed, false);
  });
});

test("awaria bez kandydata zachowuje bogatą metrykę etapu planu", async () => {
  await withFixture("no-candidate-metric", async ({ root, repo }) => {
    const primaryCalls = { count: 0 };
    const primary = adapter("primary", {
      ok: false,
      report: "",
      terminationReason: "empty-report",
      costUsd: 1,
    }, primaryCalls);
    const primaryRoute = route(primary, "primary/primary-model@high", "primary-model");
    const runtime: FactoryJobRuntime = {
      async route() {
        return primaryRoute;
      },
      async routeCandidates() {
        return [primaryRoute];
      },
      async project() {
        return { repo, default_branch: "main", checks: ["true"] };
      },
    };

    const output = await executeFactoryJobInput(
      { kind: "plan", attempt: 1, ticket, planFiles: [] },
      "run-no-candidate",
      undefined,
      runtime
    );

    assert.equal(output.outcome, "failed");
    assert.equal(primaryCalls.count, 1);
    const rows = (await readFile(join(root, "runs", "metrics.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "failed");
    assert.equal(rows[0].fallbackDecision, "no-candidate");
    assert.equal(rows[0].humanSummary, "summary-missing");
    assert.equal(rows[0].resumed, false);
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
        return {
          ok: false,
          report: "failed to connect to websocket",
          stderr: "failed to connect to websocket",
          terminationReason: "process-error",
          costUsd: 1,
        };
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
    "Proces codex zakończył się błędem (process-error)",
    "insufficient permissions do pliku roboczego",
  ]) {
    assert.equal(classifyEngineFailure(message), "work", message);
  }
});

test("klasyfikacja wyniku nie traktuje prozy modelu jak diagnostyki", () => {
  assert.equal(classifyEngineRunFailure({
    report: "Plan opisuje 429 rate limit, timeout uwierzytelniania i websocket.",
  }), "work");
  assert.equal(classifyEngineRunFailure({ report: "" }), "work");
  assert.equal(classifyEngineRunFailure({
    report: "",
    stderr: "nieznany komunikat diagnostyczny",
  }), "work");
  assert.equal(classifyEngineRunFailure({
    report: "Model zdążył opisać timeout jako wymaganie.",
    stderr: "failed to connect to websocket",
    terminationReason: "process-error",
  }), "infra");
  assert.equal(classifyEngineRunFailure({
    report: "Proces codex zakończył się błędem (process-error).",
    stderr: "warning: insufficient permissions in a tool subprocess",
    terminationReason: "process-error",
  }), "work");
  assert.equal(classifyEngineRunFailure({
    report: "Model nie zwrócił werdyktu.",
    stderr: [
      "failed to connect to websocket",
      ...Array.from({ length: 9 }, (_, index) => `warning ${index}`),
    ].join("\n"),
    terminationReason: "process-error",
  }), "work");
  assert.equal(classifyEngineRunFailure({
    report: [
      "Proces codex zakończył się błędem (process-error). stderr:",
      "failed to connect to websocket",
      ...Array.from({ length: 9 }, (_, index) => `warning ${index}`),
    ].join("\n"),
    terminationReason: "process-error",
  }), "work");
  assert.equal(classifyEngineRunFailure({
    report: "",
    stderr: "failed to connect to websocket",
    terminationReason: "empty-report",
  }), "work");
  assert.equal(classifyEngineRunFailure({
    report: "",
    stderr: "SIGTERM",
    terminationReason: "abort",
  }), "work");
});

test("codex i claude-code wystawiają stderr oraz przyczynę zakończenia poza raportem modelu", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-engine-adapter-errors-"));
  const fakeCodex = join(root, "codex");
  const silentCodex = join(root, "codex-silent");
  const fakeClaude = join(root, "claude");
  try {
    await writeFile(fakeCodex, [
      "#!/usr/bin/env node",
      'const { writeFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const outputIndex = args.indexOf("--output-last-message");',
      "process.stdin.resume();",
      'process.stdin.on("end", () => {',
      '  writeFileSync(args[outputIndex + 1], "Plan opisuje timeout i 429 jako wymagania.");',
      '  process.stderr.write("failed to connect to websocket\\n");',
      "  process.exit(1);",
      "});",
    ].join("\n"));
    await writeFile(silentCodex, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      'process.stdin.on("end", () => process.exit(0));',
    ].join("\n"));
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      `process.stdout.write(${JSON.stringify(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "text",
            text: "Recenzja omawia authentication, quota i timeout jako część projektu.",
          }],
        },
      }) + "\n")});`,
      'process.stderr.write("failed to lookup address information\\n");',
      "process.exit(1);",
    ].join("\n"));
    chmodSync(fakeCodex, 0o755);
    chmodSync(silentCodex, 0o755);
    chmodSync(fakeClaude, 0o755);

    const codexResult = runAdapterInChild(
      "codex",
      "codex",
      "CODEX_BIN",
      fakeCodex,
      root
    );
    assert.equal(codexResult.ok, false);
    assert.match(codexResult.report, /Plan opisuje timeout/);
    assert.match(codexResult.stderr ?? "", /failed to connect to websocket/);
    assert.equal(codexResult.terminationReason, "process-error");
    assert.equal(classifyEngineRunFailure(codexResult), "infra");

    const claudeResult = runAdapterInChild(
      "claude-code",
      "claudeCode",
      "CLAUDE_BIN",
      fakeClaude,
      root
    );
    assert.equal(claudeResult.ok, false);
    assert.match(claudeResult.report, /Recenzja omawia authentication/);
    assert.match(claudeResult.stderr ?? "", /failed to lookup address information/);
    assert.equal(claudeResult.terminationReason, "process-error");
    assert.equal(classifyEngineRunFailure(claudeResult), "infra");

    const silentResult = runAdapterInChild(
      "codex",
      "codex",
      "CODEX_BIN",
      silentCodex,
      root
    );
    assert.equal(silentResult.ok, false);
    assert.equal(silentResult.report, "");
    assert.equal(silentResult.terminationReason, "empty-report");
    assert.equal(classifyEngineRunFailure(silentResult), "work");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lease obejmuje obie próby, gdy zapas jest dozwolony", async () => {
  const { jobLeaseMinutes } = await import("../sources/poll-linear-v2");
  const previousGrace = process.env.FACTORY_JOB_GRACE_MIN;
  process.env.FACTORY_JOB_GRACE_MIN = "10";
  try {
    // Bez zgody na zapas — jak dotąd: budżet roli + grace.
    assert.equal(jobLeaseMinutes("plan", false), 30);
    assert.equal(jobLeaseMinutes("build", false), 35);

    // Ze zgodą — dwie pełne role, bo tyle job faktycznie może zużyć.
    // Kluczowy scenariusz: timeout próby głównej zjada cały budżet roli,
    // a zapas dostaje własny pełny budżet. Przy pojedynczym lease strażnik
    // zabiłby go w locie i ticket zapłaciłby za obie próby bez wyniku.
    assert.equal(jobLeaseMinutes("plan", true), 50);
    assert.equal(jobLeaseMinutes("build", true), 60);

    // Role researchu dziedziczą budżet po etapie bazowym.
    assert.equal(jobLeaseMinutes("research-recon", true), 30);
    // Nieznany rodzaj joba zachowuje historyczne 25 min.
    assert.equal(jobLeaseMinutes("nieznany", false), 35);
  } finally {
    if (previousGrace === undefined) delete process.env.FACTORY_JOB_GRACE_MIN;
    else process.env.FACTORY_JOB_GRACE_MIN = previousGrace;
  }
});
