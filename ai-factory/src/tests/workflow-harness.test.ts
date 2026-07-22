import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

test("deterministyczny harness prowadzi ticket przez plan, human gate, build, verify, publish i review", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-workflow-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");
  const fakeBin = join(root, "bin");
  const worktrees = join(root, "worktrees");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(worktrees, { recursive: true });

  try {
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["clone", bare, repo]);
    git(repo, "config", "user.email", "factory@example.test");
    git(repo, "config", "user.name", "Factory Test");
    writeFileSync(join(repo, "README.md"), "# Harness\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "base");
    git(repo, "branch", "-M", "main"); git(repo, "push", "-u", "origin", "main");

    const gh = join(fakeBin, "gh");
    writeFileSync(gh, [
      "#!/bin/sh",
      "if [ \"$1 $2\" = \"pr create\" ]; then",
      "  echo https://github.test/factory/pilot/pull/1",
      "fi",
      "exit 0",
    ].join("\n"));
    chmodSync(gh, 0o755);

    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "factory-harness" }));
    writeFileSync(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(repo)}`,
      "  github: factory/pilot",
      "  default_branch: main",
      "  checks:",
      "    - test -f feature.txt",
    ].join("\n"));
    writeFileSync(join(root, "routing.yaml"), [
      "defaults:",
      "  plan: fake",
      "  build: fake",
      "  verify: fake",
      "  review: fake",
    ].join("\n"));

    process.env.FACTORY_ROOT = root;
    process.env.FACTORY_WORKTREES = worktrees;
    process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;

    const [{ engines }, { ticketPipeline }, { Mastra }, { LibSQLStore }, { applyWorkflowPersistencePatch }] = await Promise.all([
      import("../engines"),
      import("../pipeline/ticket-pipeline"),
      import("@mastra/core/mastra"),
      import("@mastra/libsql"),
      import("../mastra/workflow-persistence-patch"),
    ]);
    engines.fake = {
      name: "fake",
      async run(input) {
        if (input.role === "plan") {
          return {
            ok: true,
            report: "Plan harnessu\n\n```factory\n" + JSON.stringify({
              verdict: "ok", screenshots: [], files: ["feature.txt"], domain: "fullstack",
            }) + "\n```",
          };
        }
        if (input.role === "build") {
          writeFileSync(join(input.workspace, "feature.txt"), "implemented by deterministic harness\n");
          return { ok: true, report: "Zapisano feature.txt" };
        }
        if (input.role === "verify") {
          return { ok: true, report: "Kryteria spełnione\n\n```factory\n{\"verdict\":\"pass\"}\n```" };
        }
        return { ok: true, report: "Kod czytelny\n\n```factory\n{\"verdict\":\"lgtm\"}\n```" };
      },
    };

    applyWorkflowPersistencePatch();
    const runtime = new Mastra({
      workflows: { ticketPipeline },
      storage: new LibSQLStore({ id: "harness-storage", url: `file:${join(root, "harness.db")}` }),
    });
    const workflow = runtime.getWorkflow("ticketPipeline");
    const run = await workflow.createRun({ runId: "harness-run" });
    const suspended = await run.start({
      inputData: {
        id: "HARNESS-1",
        title: "Deterministic workflow",
        description: "Dodaj feature.txt z tekstem harnessu.",
        project: "harness",
        labels: [],
      },
    });
    assert.equal(suspended.status, "suspended");

    const completed = await run.resume({
      step: "approve-plan",
      resumeData: { approved: true },
    });
    assert.equal(completed.status, "success");
    assert.equal(completed.result?.reviewVerdict, "lgtm");
    assert.equal(completed.result?.prUrl, "https://github.test/factory/pilot/pull/1");
    assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# Harness\n");
    assert.match(
      readFileSync(join(root, "runs", "HARNESS-1", "harness-run", "result.json"), "utf8"),
      /github\.test\/factory\/pilot\/pull\/1/
    );
  } finally {
    delete process.env.FACTORY_ROOT;
    delete process.env.FACTORY_WORKTREES;
    rmSync(root, { recursive: true, force: true });
  }
});
