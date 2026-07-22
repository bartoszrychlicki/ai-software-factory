import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineRunInput } from "../engines/types";

const here = dirname(fileURLToPath(import.meta.url));
const factoryDir = join(here, "../..");
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const argvLog = (path: string) =>
  readFileSync(path).toString("utf8").split("\0").filter(Boolean);

const validPlan = (file = "src/example.ts") =>
  "Plan testowy\n\n```factory\n" + JSON.stringify({
    verdict: "ok",
    screenshots: [],
    files: [file],
    domain: "backend",
  }) + "\n```";

test("claude-code zachowuje cold argv, dodaje --resume i czyta session_id z init/result", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-claude-session-"));
  const fakeClaude = join(root, "claude");
  const coldArgv = join(root, "cold.argv");
  const resumedArgv = join(root, "resumed.argv");
  const originalPath = process.env.PATH;
  const originalClaudeBin = process.env.CLAUDE_BIN;

  try {
    writeFileSync(fakeClaude, [
      "#!/bin/sh",
      "if [ \"$1\" = \"--resume\" ]; then",
      `  printf '%s\\0' \"$@\" > ${shellQuote(resumedArgv)}`,
      `  printf '%s\\n' '${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: validPlan() }] } })}'`,
      `  printf '%s\\n' '${JSON.stringify({ type: "result", is_error: false, result: validPlan(), total_cost_usd: 0.02, session_id: "result-session" })}'`,
      "else",
      `  printf '%s\\0' \"$@\" > ${shellQuote(coldArgv)}`,
      `  printf '%s\\n' '${JSON.stringify({ type: "system", subtype: "init", session_id: "init-session" })}'`,
      `  printf '%s\\n' '${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: validPlan() }] } })}'`,
      `  printf '%s\\n' '${JSON.stringify({ type: "result", is_error: false, result: validPlan(), total_cost_usd: 0.1 })}'`,
      "fi",
    ].join("\n"));
    chmodSync(fakeClaude, 0o755);
    delete process.env.CLAUDE_BIN;
    process.env.PATH = `${root}:${originalPath ?? ""}`;

    const { claudeCode } = await import("../engines/claude-code");
    const cold = await claudeCode.run({
      role: "plan",
      instructions: "INSTRUKCJE_COLD",
      context: "KONTEKST_COLD",
      workspace: root,
      budget: { minutes: 1 },
      model: "test-model",
      effort: "high",
    });
    assert.equal(cold.ok, true);
    assert.equal(cold.sessionId, "init-session");
    assert.deepEqual(argvLog(coldArgv), [
      "-p",
      "INSTRUKCJE_COLD\n\nKONTEKST_COLD",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      "Read,Glob,Grep",
      "--model",
      "test-model",
      "--effort",
      "high",
    ]);

    const resumed = await claudeCode.run({
      role: "plan",
      instructions: "KONTRAKT_RESUME",
      context: "ODPOWIEDŹ_RESUME",
      sessionId: "init-session",
      workspace: root,
      budget: { minutes: 1 },
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.sessionId, "result-session");
    const resumedArgs = argvLog(resumedArgv);
    assert.deepEqual(resumedArgs.slice(0, 4), [
      "--resume",
      "init-session",
      "-p",
      "KONTRAKT_RESUME\n\nODPOWIEDŹ_RESUME",
    ]);
    assert.equal(resumedArgs.join("\n").includes("KONTEKST_COLD"), false);
  } finally {
    process.env.PATH = originalPath;
    if (originalClaudeBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = originalClaudeBin;
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt rundy resumed zawiera tylko ostatnią odpowiedź, a brak sesji zachowuje pełny fallback", async () => {
  const { buildPlanEnginePrompt } = await import("../pipeline/ticket-pipeline");
  const ticket = {
    id: "BAR-136",
    title: "Prompt caching",
    description: "UNIKALNY_PEŁNY_OPIS_TICKETU",
  };
  const answers = ["PIERWSZA_ODPOWIEDŹ", "OSTATNIA_ODPOWIEDŹ"];
  const cold = buildPlanEnginePrompt({ ticket, clarifyRound: 2, answers });
  const resumed = buildPlanEnginePrompt({ ticket, clarifyRound: 2, answers, sessionId: "session-136" });

  assert.equal(cold.resumed, false);
  assert.equal(cold.sessionId, undefined);
  assert.match(cold.context, /UNIKALNY_PEŁNY_OPIS_TICKETU/);
  assert.match(cold.context, /PIERWSZA_ODPOWIEDŹ/);
  assert.match(cold.context, /OSTATNIA_ODPOWIEDŹ/);

  assert.equal(resumed.resumed, true);
  assert.equal(resumed.sessionId, "session-136");
  assert.doesNotMatch(resumed.context, /UNIKALNY_PEŁNY_OPIS_TICKETU/);
  assert.doesNotMatch(resumed.context, /PIERWSZA_ODPOWIEDŹ/);
  assert.match(resumed.context, /OSTATNIA_ODPOWIEDŹ/);
  assert.ok(
    Buffer.byteLength(`${resumed.instructions}\n\n${resumed.context}`) <
      Buffer.byteLength(`${cold.instructions}\n\n${cold.context}`)
  );
});

test("planStep przenosi sessionId przez suspend/resume i zapisuje metryki cold/resumed", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-plan-cycle-session-"));
  const repo = join(root, "repo");
  const originalFactoryRoot = process.env.FACTORY_ROOT;
  mkdirSync(repo, { recursive: true });
  let runtime: { shutdown(): Promise<void> } | undefined;

  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "plan-cycle-session-test" }));
    writeFileSync(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(repo)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    writeFileSync(join(root, "routing.yaml"), [
      "defaults:",
      "  plan: fake/test-model",
    ].join("\n"));
    process.env.FACTORY_ROOT = root;

    const [{ engines }, { ticketPipeline }, { Mastra }, { LibSQLStore }, { applyWorkflowPersistencePatch }] = await Promise.all([
      import("../engines"),
      import("../pipeline/ticket-pipeline"),
      import("@mastra/core/mastra"),
      import("@mastra/libsql"),
      import("../mastra/workflow-persistence-patch"),
    ]);
    const calls: EngineRunInput[] = [];
    engines.fake = {
      name: "claude-code",
      async run(input) {
        calls.push(input);
        if (calls.length === 1) {
          return {
            ok: true,
            report: "Potrzebuję decyzji.\n\n```factory\n" + JSON.stringify({
              verdict: "blocked",
              questions: "1. Tryb? A) Szybki (REKOMENDACJA) B) Pełny C) Ręczny",
              screenshots: [],
              files: [],
              domain: "backend",
            }) + "\n```",
            costUsd: 0.1,
            sessionId: "plan-session",
          };
        }
        return { ok: true, report: validPlan(), costUsd: 0.02, sessionId: "plan-session" };
      },
    };

    applyWorkflowPersistencePatch();
    const mastra = new Mastra({
      workflows: { ticketPipeline },
      storage: new LibSQLStore({ id: "plan-session-storage", url: `file:${join(root, "mastra.db")}` }),
    });
    runtime = mastra;
    const workflow = mastra.getWorkflow("ticketPipeline");
    const run = await workflow.createRun({ runId: "plan-session-run" });
    const first = await run.start({
      inputData: {
        id: "BAR-136",
        title: "Prompt caching",
        description: "UNIKALNY_OPIS_DO_PIERWSZEJ_RUNDY",
        project: "harness",
        labels: [],
      },
    });
    assert.equal(first.status, "suspended");

    const second = await run.resume({
      step: ["plan-clarify-cycle", "clarify-ticket"],
      resumeData: { answers: "1A" },
    });
    assert.equal(second.status, "suspended", "po doplanowaniu workflow ma czekać na approve-plan");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].sessionId, undefined);
    assert.match(calls[0].context, /UNIKALNY_OPIS_DO_PIERWSZEJ_RUNDY/);
    assert.equal(calls[1].sessionId, "plan-session");
    assert.doesNotMatch(calls[1].context, /UNIKALNY_OPIS_DO_PIERWSZEJ_RUNDY/);
    assert.match(calls[1].context, /1A/);
    assert.ok(
      Buffer.byteLength(`${calls[1].instructions}\n\n${calls[1].context}`) <
        Buffer.byteLength(`${calls[0].instructions}\n\n${calls[0].context}`)
    );

    const metrics = readFileSync(join(root, "runs", "metrics.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { stage: string; resumed?: boolean });
    assert.deepEqual(
      metrics.filter((row) => row.stage === "plan").map((row) => row.resumed),
      [false, true]
    );
    assert.match(
      readFileSync(join(root, "runs", "BAR-136", "plan-session-run", "plan.md"), "utf8"),
      /resumed: true/
    );
    delete engines.fake;
  } finally {
    await runtime?.shutdown();
    if (originalFactoryRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = originalFactoryRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("planStep po błędzie --resume ponawia cold z pełnym kontekstem", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-plan-resume-fallback-"));
  const repo = join(root, "repo");
  const originalFactoryRoot = process.env.FACTORY_ROOT;
  mkdirSync(repo, { recursive: true });
  let runtime: { shutdown(): Promise<void> } | undefined;
  let restoreEngine: (() => void) | undefined;

  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "plan-resume-fallback-test" }));
    writeFileSync(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(repo)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    writeFileSync(join(root, "routing.yaml"), [
      "defaults:",
      "  plan: fake/test-model",
    ].join("\n"));
    process.env.FACTORY_ROOT = root;

    const [{ engines }, { ticketPipeline }, { Mastra }, { LibSQLStore }, { applyWorkflowPersistencePatch }] = await Promise.all([
      import("../engines"),
      import("../pipeline/ticket-pipeline"),
      import("@mastra/core/mastra"),
      import("@mastra/libsql"),
      import("../mastra/workflow-persistence-patch"),
    ]);
    const previousEngine = engines.fake;
    restoreEngine = () => {
      if (previousEngine) engines.fake = previousEngine;
      else delete engines.fake;
    };
    const calls: EngineRunInput[] = [];
    engines.fake = {
      name: "claude-code",
      async run(input) {
        calls.push(input);
        if (calls.length === 1) {
          return {
            ok: true,
            report: "Potrzebuję decyzji.\n\n```factory\n" + JSON.stringify({
              verdict: "blocked",
              questions: "1. Tryb? A) Szybki (REKOMENDACJA) B) Pełny C) Ręczny",
              screenshots: [],
              files: [],
              domain: "backend",
            }) + "\n```",
            costUsd: 0.1,
            sessionId: "expired-session",
          };
        }
        if (calls.length === 2) {
          return {
            ok: false,
            report: "Proces zakończył się błędem: sesja nie istnieje",
            costUsd: 0.01,
          };
        }
        return { ok: true, report: validPlan(), costUsd: 0.2, sessionId: "fresh-session" };
      },
    };

    applyWorkflowPersistencePatch();
    const mastra = new Mastra({
      workflows: { ticketPipeline },
      storage: new LibSQLStore({ id: "plan-fallback-storage", url: `file:${join(root, "mastra.db")}` }),
    });
    runtime = mastra;
    const workflow = mastra.getWorkflow("ticketPipeline");
    const run = await workflow.createRun({ runId: "plan-fallback-run" });
    const first = await run.start({
      inputData: {
        id: "BAR-136",
        title: "Prompt caching",
        description: "UNIKALNY_PEŁNY_OPIS_FALLBACKU",
        project: "harness",
        labels: [],
      },
    });
    assert.equal(first.status, "suspended");

    const second = await run.resume({
      step: ["plan-clarify-cycle", "clarify-ticket"],
      resumeData: { answers: "1A" },
    });
    assert.equal(second.status, "suspended", "cold fallback ma doprowadzić workflow do approve-plan");
    assert.equal(calls.length, 3);
    assert.equal(calls[1].sessionId, "expired-session");
    assert.doesNotMatch(calls[1].context, /UNIKALNY_PEŁNY_OPIS_FALLBACKU/);
    assert.equal(calls[2].sessionId, undefined);
    assert.match(calls[2].context, /UNIKALNY_PEŁNY_OPIS_FALLBACKU/);
    assert.match(calls[2].context, /1A/);

    const metrics = readFileSync(join(root, "runs", "metrics.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { stage: string; resumed?: boolean; ok: boolean });
    assert.deepEqual(
      metrics.filter((row) => row.stage === "plan").map((row) => ({ resumed: row.resumed, ok: row.ok })),
      [
        { resumed: false, ok: true },
        { resumed: true, ok: false },
        { resumed: false, ok: true },
      ]
    );
    const artifact = readFileSync(join(root, "runs", "BAR-136", "plan-fallback-run", "plan.md"), "utf8");
    assert.match(artifact, /costUsd: 0\.21/);
    assert.match(artifact, /resumed: false/);
    assert.match(artifact, /resumeFallback: true/);
  } finally {
    restoreEngine?.();
    await runtime?.shutdown();
    if (originalFactoryRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = originalFactoryRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("report pokazuje rozbicie planu na resumed=false i resumed=true", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-plan-report-"));
  try {
    mkdirSync(join(root, "runs"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "report-test" }));
    writeFileSync(join(root, "runs", "metrics.jsonl"), [
      JSON.stringify({ ts: "2026-07-23T10:00:00Z", ticket: "A", runId: "1", stage: "plan", ok: true, outcome: "ok", costUsd: 1, durationMs: 2000, resumed: false }),
      JSON.stringify({ ts: "2026-07-23T10:00:01Z", ticket: "A", runId: "1", stage: "plan", ok: true, outcome: "ok", costUsd: 0.2, durationMs: 500, resumed: true }),
    ].join("\n") + "\n");

    const output = execFileSync(process.execPath, ["--import", "tsx", join(factoryDir, "src/metrics/report.ts")], {
      cwd: factoryDir,
      encoding: "utf8",
      env: { ...process.env, FACTORY_ROOT: root },
    });
    assert.match(output, /Plan: cold vs resumed/);
    assert.match(output, /resumed=false\s+1\s+100%\s+\$1\.000\s+\$1\.000\s+2s/);
    assert.match(output, /resumed=true\s+1\s+100%\s+\$0\.200\s+\$0\.200\s+1s/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake-CLI benchmark zapisuje kontrolowany artefakt A/B z proxy jakości", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-plan-bench-"));
  const repo = join(root, "repo");
  const fakeClaude = join(root, "fake-claude");
  const primeMarker = join(root, "prime.marker");
  const scenarioPath = join(root, "scenario.json");
  try {
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "bench-test" }));
    const blocked = "Potrzebuję odpowiedzi.\n\n```factory\n" + JSON.stringify({
      verdict: "blocked",
      questions: "1. Wariant? A) Jeden (REKOMENDACJA) B) Dwa C) Trzy",
      screenshots: [],
      files: [],
      domain: "backend",
    }) + "\n```";
    writeFileSync(fakeClaude, [
      "#!/bin/sh",
      "first=0",
      "if [ \"$1\" = \"--resume\" ]; then",
      "  cost=0.02",
      `elif [ ! -f ${shellQuote(primeMarker)} ]; then`,
      "  cost=0.10",
      "  first=1",
      `  touch ${shellQuote(primeMarker)}`,
      "else",
      "  cost=0.10",
      "fi",
      `printf '%s\\n' '${JSON.stringify({ type: "system", subtype: "init", session_id: "bench-session" })}'`,
      "if [ \"$first\" = \"1\" ]; then",
      `  printf '%s\\n' '${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: blocked }] } })}'`,
      `  printf '{\"type\":\"result\",\"is_error\":false,\"result\":%s,\"total_cost_usd\":%s,\"session_id\":\"bench-session\"}\\n' '${JSON.stringify(blocked)}' \"$cost\"`,
      "else",
      `  printf '%s\\n' '${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: validPlan("src/bench.ts") }] } })}'`,
      `  printf '{\"type\":\"result\",\"is_error\":false,\"result\":%s,\"total_cost_usd\":%s,\"session_id\":\"bench-session\"}\\n' '${JSON.stringify(validPlan("src/bench.ts"))}' \"$cost\"`,
      "fi",
    ].join("\n"));
    chmodSync(fakeClaude, 0o755);
    writeFileSync(scenarioPath, JSON.stringify({
      title: "Kontrolowany benchmark",
      description: "Pełny opis identycznego ticketu dla obu wariantów.",
      answer: "1A, 2C",
      workspace: "./repo",
      model: "test-model",
      effort: "high",
    }));

    execFileSync(
      process.execPath,
      ["--import", "tsx", join(factoryDir, "src/metrics/bench-plan-resume.ts"), "BAR-136", scenarioPath],
      {
        cwd: factoryDir,
        encoding: "utf8",
        env: { ...process.env, FACTORY_ROOT: root, CLAUDE_BIN: fakeClaude },
      }
    );

    const benchDir = join(root, "runs", "bench");
    const files = readdirSync(benchDir).filter((file) => file.startsWith("plan-resume-BAR-136-"));
    assert.equal(files.length, 1);
    const artifact = JSON.parse(readFileSync(join(benchDir, files[0]), "utf8")) as {
      setup: { verdict: string; parseSource: string };
      results: Array<{
        mode: string;
        model: string;
        costUsd: number;
        durationMs: number;
        promptBytes: number;
        sessionId: string;
        elapsedMsSinceRoundA: number;
        verdict: string;
        domain: string;
        files: string[];
      }>;
      quality: { passed: boolean; domainMatches: boolean; filesMatch: boolean };
    };
    assert.deepEqual(
      { verdict: artifact.setup.verdict, parseSource: artifact.setup.parseSource },
      { verdict: "blocked", parseSource: "structured" }
    );
    assert.deepEqual(artifact.results.map((row) => row.mode), ["cold", "resumed"]);
    assert.deepEqual(artifact.results.map((row) => row.model), ["test-model", "test-model"]);
    assert.deepEqual(artifact.results.map((row) => row.costUsd), [0.1, 0.02]);
    assert.ok(artifact.results.every((row) => Number.isFinite(row.durationMs)));
    assert.ok(artifact.results[1].promptBytes < artifact.results[0].promptBytes);
    assert.deepEqual(artifact.results.map((row) => row.sessionId), ["bench-session", "bench-session"]);
    assert.equal(artifact.results[0].elapsedMsSinceRoundA, 0);
    assert.ok(artifact.results[1].elapsedMsSinceRoundA >= 0);
    assert.deepEqual(artifact.results.map((row) => row.verdict), ["ok", "ok"]);
    assert.deepEqual(artifact.results.map((row) => row.domain), ["backend", "backend"]);
    assert.deepEqual(artifact.results.map((row) => row.files), [["src/bench.ts"], ["src/bench.ts"]]);
    assert.deepEqual(artifact.quality, {
      passed: true,
      parsePlanVerdict: { cold: "structured", resumed: "structured" },
      domainMatches: true,
      filesMatch: true,
      differences: null,
      differenceExplanation: null,
      requiresDifferenceExplanation: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
