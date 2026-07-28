import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Mastra uruchamia factoryJob jako jeden zakończony job planowania bez suspend/resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-job-workflow-"));
  const repo = join(root, "repo");
  const fakeClaude = join(root, "fake-claude");
  const previousFactoryRoot = process.env.FACTORY_ROOT;
  const previousClaudeBin = process.env.CLAUDE_BIN;

  try {
    await mkdir(repo);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "factory-job-harness" }));
    await writeFile(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(repo)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    await writeFile(join(root, "routing.yaml"), [
      "defaults:",
      "  plan: claude-code/fake-model@low",
      "  build: claude-code/fake-model@low",
      "  review: claude-code/fake-model@low",
    ].join("\n"));
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "const report = [",
      "  '# Plan harnessu',",
      "  '```factory',",
      "  JSON.stringify({ verdict: 'ok', screenshots: [], files: ['src/a.ts'], domain: 'backend' }),",
      "  '```',",
      "].join('\\n');",
      "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session' }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: report }] } }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'result', result: report, is_error: false, total_cost_usd: 0.01 }) + '\\n');",
    ].join("\n"));
    await chmod(fakeClaude, 0o755);

    process.env.FACTORY_ROOT = root;
    process.env.CLAUDE_BIN = fakeClaude;
    const { factoryJob } = await import("../pipeline/factory-job");
    const run = await factoryJob.createRun({ runId: "factory-job-harness-run" });
    const result = await run.start({
      inputData: {
        kind: "plan",
        attempt: 1,
        ticket: {
          id: "BAR-H2",
          title: "Workflow harness",
          description: "Sprawdź rzeczywisty workflow Mastry.",
          project: "harness",
          labels: [],
          inputHash: "hash-h2",
        },
        planFiles: [],
      },
    });

    assert.equal(result.status, "success");
    assert.equal(result.result?.kind, "plan");
    assert.equal(result.result?.outcome, "success");
    assert.deepEqual(result.result?.files, ["src/a.ts"]);
    assert.match(result.result?.signature ?? "", /claude-code.*fake-model.*planner/);
  } finally {
    if (previousFactoryRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousFactoryRoot;
    if (previousClaudeBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousClaudeBin;
    await rm(root, { recursive: true, force: true });
  }
});
