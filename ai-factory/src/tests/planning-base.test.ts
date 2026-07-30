import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { EngineAdapter } from "../engines/types";
import {
  executeFactoryJobInput,
  type FactoryJobRuntime,
} from "../pipeline/factory-job";
import type { Stage } from "../pipeline/routing";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

interface Fixture {
  root: string;
  factoryRoot: string;
  worktreesRoot: string;
  remote: string;
  repo: string;
  oldSha: string;
  freshSha: string;
}

let fixtureQueue = Promise.resolve();

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "factory-planning-base-"));
  const factoryRoot = join(root, "factory");
  const worktreesRoot = join(root, "worktrees");
  const remote = join(root, "origin.git");
  const repo = join(root, "source-repo");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
  execFileSync("git", ["clone", remote, repo]);
  git(repo, "config", "user.email", "factory@example.test");
  git(repo, "config", "user.name", "Factory Test");

  writeFileSync(join(repo, "observed.txt"), "stary lokalny stan\n");
  git(repo, "add", "observed.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "push", "-u", "origin", "main");
  const oldSha = git(repo, "rev-parse", "HEAD");

  writeFileSync(join(repo, "observed.txt"), "świeży origin main\n");
  git(repo, "add", "observed.txt");
  git(repo, "commit", "-m", "origin advances");
  git(repo, "push", "origin", "main");
  const freshSha = git(repo, "rev-parse", "HEAD");
  git(repo, "reset", "--hard", oldSha);

  mkdirSync(factoryRoot, { recursive: true });
  writeFileSync(join(factoryRoot, "package.json"), "{}");
  return { root, factoryRoot, worktreesRoot, remote, repo, oldSha, freshSha };
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const previous = fixtureQueue;
  let release!: () => void;
  fixtureQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const fixture = createFixture();
  const previousFactoryRoot = process.env.FACTORY_ROOT;
  const previousWorktreesRoot = process.env.FACTORY_WORKTREES;
  process.env.FACTORY_ROOT = fixture.factoryRoot;
  process.env.FACTORY_WORKTREES = fixture.worktreesRoot;
  try {
    await fn(fixture);
  } finally {
    if (previousFactoryRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousFactoryRoot;
    if (previousWorktreesRoot === undefined) delete process.env.FACTORY_WORKTREES;
    else process.env.FACTORY_WORKTREES = previousWorktreesRoot;
    rmSync(fixture.root, { recursive: true, force: true });
    release();
  }
}

function reportFor(stage: Stage): string {
  if (stage === "triage") {
    return '```factory\n{"verdict":"solo","type":"bug","size":"S","risk":[]}\n```';
  }
  return [
    "# Plan",
    "```factory",
    '{"verdict":"ok","screenshots":[],"files":["observed.txt"],"domain":"backend"}',
    "```",
  ].join("\n");
}

function runtimeFor(
  repo: string,
  onRun?: (stage: Stage, workspace: string, content: string) => Promise<void> | void
): FactoryJobRuntime {
  return {
    async route(stage) {
      const engine: EngineAdapter = {
        name: `fake-${stage}`,
        async run(input) {
          const content = readFileSync(join(input.workspace, "observed.txt"), "utf8");
          await onRun?.(stage, input.workspace, content);
          return { ok: true, report: reportFor(stage) };
        },
      };
      return { engine, model: "fake-model", spec: `fake/${stage}` };
    },
    async project() {
      return { repo, default_branch: "main", checks: ["true"] };
    },
  };
}

function ticket(id = "BAR-196-TEST") {
  return {
    id,
    title: "Świeża baza planowania",
    description: "Plan ma czytać origin/main.",
    project: "fake",
    labels: [],
    inputHash: "hash",
  };
}

test("plan job czyta świeży origin/main mimo cofniętego lokalnego HEAD", async () => {
  await withFixture(async ({ repo, oldSha, freshSha }) => {
    const beforeHead = git(repo, "rev-parse", "HEAD");
    const beforeContent = readFileSync(join(repo, "observed.txt"), "utf8");
    const beforeStatus = git(repo, "status", "--porcelain=v1", "--untracked-files=all");
    let seenContent = "";
    let seenWorkspace = "";
    const output = await executeFactoryJobInput(
      { kind: "plan", attempt: 1, ticket: ticket(), planFiles: [] },
      "plan-fresh",
      undefined,
      runtimeFor(repo, (_stage, workspace, content) => {
        seenWorkspace = workspace;
        seenContent = content;
      })
    );

    assert.equal(output.outcome, "success");
    assert.equal(output.baseSha, freshSha);
    assert.equal(seenContent, "świeży origin main\n");
    assert.notEqual(seenWorkspace, repo);
    assert.equal(git(repo, "rev-parse", "HEAD"), beforeHead);
    assert.equal(beforeHead, oldSha);
    assert.equal(readFileSync(join(repo, "observed.txt"), "utf8"), beforeContent);
    assert.equal(git(repo, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
  });
});

test("artefakt joba planistycznego i metryka zawierają SHA bazy", async () => {
  await withFixture(async ({ factoryRoot, repo, freshSha }) => {
    const output = await executeFactoryJobInput(
      { kind: "plan", attempt: 1, ticket: ticket(), planFiles: [] },
      "plan-artifact",
      undefined,
      runtimeFor(repo)
    );
    assert.equal(output.baseSha, freshSha);

    const artifact = readFileSync(
      join(factoryRoot, "runs", "BAR-196-TEST", "plan-artifact", "plan-attempt-1.md"),
      "utf8"
    );
    assert.match(artifact, new RegExp(`^sha: ${freshSha}$`, "m"));
    const metrics = readFileSync(join(factoryRoot, "runs", "metrics.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(metrics.at(-1)?.baseSha, freshSha);
  });
});

test("niezacommitowane zmiany w repo człowieka nie blokują planowania", async () => {
  await withFixture(async ({ repo }) => {
    writeFileSync(join(repo, "observed.txt"), "lokalna niezacommitowana zmiana\n");
    writeFileSync(join(repo, "local-only.txt"), "nieśledzony plik\n");
    const beforeStatus = git(repo, "status", "--porcelain=v1", "--untracked-files=all");

    const output = await executeFactoryJobInput(
      { kind: "plan", attempt: 1, ticket: ticket(), planFiles: [] },
      "plan-dirty",
      undefined,
      runtimeFor(repo)
    );

    assert.equal(output.outcome, "success");
    assert.equal(git(repo, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
    assert.equal(
      readFileSync(join(repo, "observed.txt"), "utf8"),
      "lokalna niezacommitowana zmiana\n"
    );
    assert.equal(readFileSync(join(repo, "local-only.txt"), "utf8"), "nieśledzony plik\n");
  });
});

test("dwa równoległe joby planistyczne dostają rozłączne katalogi", async () => {
  await withFixture(async ({ repo }) => {
    const workspaces: string[] = [];
    const contents: string[] = [];
    let release!: () => void;
    const bothRunning = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = runtimeFor(repo, async (_stage, workspace, content) => {
      workspaces.push(workspace);
      contents.push(content);
      if (workspaces.length === 2) release();
      await bothRunning;
      assert.equal(existsSync(workspace), true);
    });

    const [plan, triage] = await Promise.all([
      executeFactoryJobInput(
        { kind: "plan", attempt: 1, ticket: ticket("BAR-196-PARALLEL"), planFiles: [] },
        "parallel-plan",
        undefined,
        runtime
      ),
      executeFactoryJobInput(
        { kind: "triage", attempt: 1, ticket: ticket("BAR-196-PARALLEL"), planFiles: [] },
        "parallel-triage",
        undefined,
        runtime
      ),
    ]);

    assert.deepEqual([plan.outcome, triage.outcome], ["success", "success"]);
    assert.equal(new Set(workspaces).size, 2);
    assert.deepEqual(contents, ["świeży origin main\n", "świeży origin main\n"]);
  });
});

test("seria jobów nie zostawia katalogów ani rejestracji worktree", async () => {
  await withFixture(async ({ repo, worktreesRoot }) => {
    for (let index = 1; index <= 3; index += 1) {
      const output = await executeFactoryJobInput(
        { kind: "plan", attempt: index, ticket: ticket(), planFiles: [] },
        `cleanup-${index}`,
        undefined,
        runtimeFor(repo)
      );
      assert.equal(output.outcome, "success");
    }

    const repoWorktreesDir = join(worktreesRoot, basename(repo));
    const leakedDirectories = existsSync(repoWorktreesDir) ? readdirSync(repoWorktreesDir) : [];
    assert.deepEqual(leakedDirectories, []);
    const registered = git(repo, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    assert.deepEqual(registered, [`worktree ${realpathSync(repo)}`]);
  });
});

test("fetch niemożliwy zatrzymuje planowanie bez dotykania lokalnego repo", async () => {
  await withFixture(async ({ remote, repo }) => {
    const beforeHead = git(repo, "rev-parse", "HEAD");
    const beforeContent = readFileSync(join(repo, "observed.txt"), "utf8");
    const beforeStatus = git(repo, "status", "--porcelain=v1", "--untracked-files=all");
    rmSync(remote, { recursive: true, force: true });
    let engineRuns = 0;

    const output = await executeFactoryJobInput(
      { kind: "plan", attempt: 1, ticket: ticket(), planFiles: [] },
      "plan-no-origin",
      undefined,
      runtimeFor(repo, () => {
        engineRuns += 1;
      })
    );

    assert.equal(output.outcome, "failed");
    assert.equal(output.errorCode, "PLAN_BASE_UNAVAILABLE");
    assert.match(output.report, /BASE_UNAVAILABLE/);
    assert.equal(output.costUsd, 0);
    assert.equal(engineRuns, 0);
    assert.equal(git(repo, "rev-parse", "HEAD"), beforeHead);
    assert.equal(readFileSync(join(repo, "observed.txt"), "utf8"), beforeContent);
    assert.equal(git(repo, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
  });
});
