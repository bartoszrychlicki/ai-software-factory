import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LifecycleStore,
  type LifecycleRun,
  type TicketManifestV2,
} from "../pipeline/lifecycle-store";
import {
  reduceLifecycle,
  type CoordinatorEvent,
} from "../pipeline/coordinator";
import {
  createWorkspace,
  removeWorkspace,
  type Workspace,
} from "../pipeline/workspace";
import { runDetachedTests } from "../pipeline/test-runner";
import {
  dispatchOutbox,
  type PollerDependencies,
} from "../sources/poll-linear-v2";

const prUrl = "https://github.test/o/r/pull/191";
let fixtureCounter = 0;

const manifest: TicketManifestV2 = {
  title: "Fix publish",
  description: "Poprawka po review aktualizuje ten sam PR.",
  labels: [],
  inputHash: "fix-publish-input",
};

interface GitFixture {
  root: string;
  repo: string;
  origin: string;
  branch: string;
  oldSha: string;
  ghLog: string;
  gitLog: string;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function createGitFixture(): GitFixture {
  fixtureCounter += 1;
  const root = mkdtempSync(join(tmpdir(), "factory-fix-publish-"));
  const repo = join(root, `repo-${process.pid}-${fixtureCounter}`);
  const origin = join(root, "origin.git");
  const bin = join(root, "bin");
  const ghLog = join(root, "gh.log");
  const gitLog = join(root, "git.log");
  const branch = "agent/BAR-199-fix-publish";

  execFileSync("git", ["init", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["clone", origin, repo]);
  git(repo, "config", "user.email", "factory@example.test");
  git(repo, "config", "user.name", "Factory Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "push", "-u", "origin", "main");

  git(repo, "switch", "-c", branch);
  writeFileSync(join(repo, "published.txt"), "published\n");
  git(repo, "add", "published.txt");
  git(repo, "commit", "-m", "published checkpoint");
  const oldSha = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "-u", "origin", branch);
  git(repo, "switch", "main");

  mkdirSync(bin);
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$FACTORY_TEST_GIT_LOG\"",
    `exec ${JSON.stringify(realGit)} "$@"`,
  ].join("\n"));
  chmodSync(join(bin, "git"), 0o755);

  writeFileSync(join(bin, "gh"), [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$FACTORY_TEST_GH_LOG\"",
    "if [ \"$1 $2\" = \"pr list\" ]; then",
    `  printf '[{\"url\":\"${prUrl}\"}]\\n'`,
    "elif [ \"$1 $2\" = \"pr view\" ]; then",
    "  printf '{\"comments\":[]}\\n'",
    "elif [ \"$1 $2\" = \"pr create\" ]; then",
    "  printf 'https://github.test/o/r/pull/NEW\\n'",
    "fi",
  ].join("\n"));
  chmodSync(join(bin, "gh"), 0o755);

  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "projects.yaml"), [
    "harness:",
    `  repo: ${JSON.stringify(repo)}`,
    "  github: o/r",
    "  default_branch: main",
    "  checks:",
    "    - \"true\"",
    "  ci:",
    "    requiredChecks:",
    "      - test",
  ].join("\n"));

  return { root, repo, origin, branch, oldSha, ghLog, gitLog };
}

async function withFixture(
  runTest: (
    fixture: GitFixture,
    store: LifecycleStore,
    deps: PollerDependencies
  ) => Promise<void>
): Promise<void> {
  const fixture = createGitFixture();
  const previousRoot = process.env.FACTORY_ROOT;
  const previousPath = process.env.PATH;
  const previousGhLog = process.env.FACTORY_TEST_GH_LOG;
  const previousGitLog = process.env.FACTORY_TEST_GIT_LOG;
  const store = new LifecycleStore(join(fixture.root, "registry.db"));
  try {
    process.env.FACTORY_ROOT = fixture.root;
    process.env.PATH = `${join(fixture.root, "bin")}:${previousPath ?? ""}`;
    process.env.FACTORY_TEST_GH_LOG = fixture.ghLog;
    process.env.FACTORY_TEST_GIT_LOG = fixture.gitLog;
    const source = {
      async listComments() { return []; },
      async comment() {},
      async setStateByName() {},
    };
    const deps: PollerDependencies = {
      store,
      mastra: {} as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async () => {},
    };
    await runTest(fixture, store, deps);
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousGhLog === undefined) delete process.env.FACTORY_TEST_GH_LOG;
    else process.env.FACTORY_TEST_GH_LOG = previousGhLog;
    if (previousGitLog === undefined) delete process.env.FACTORY_TEST_GIT_LOG;
    else process.env.FACTORY_TEST_GIT_LOG = previousGitLog;
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function apply(
  store: LifecycleStore,
  run: LifecycleRun,
  event: CoordinatorEvent,
  acknowledgeCommandKey?: string
): LifecycleRun {
  const decision = reduceLifecycle(run, event);
  return store.transition(run.ticketId, {
    ...decision.transition,
    commands: decision.commands,
    acknowledgeCommandKey,
  });
}

function seedMergeRun(
  store: LifecycleStore,
  fixture: GitFixture,
  ticketId: string
): LifecycleRun {
  const run = store.createRun(ticketId, "harness", manifest);
  return store.transition(ticketId, {
    stage: "merge",
    status: "waiting_human",
    actor: "test",
    reason: "review-advisory-fix",
    patch: {
      plan: "Popraw kod według uwag review.",
      planFiles: ["published.txt", "fix-1.txt", "fix-2.txt", "fix-main.txt"],
      branch: fixture.branch,
      headSha: fixture.oldSha,
      testedSha: fixture.oldSha,
      prUrl,
      reviewStatus: "advisory-fix",
      reviewReport: "Popraw szczegół wskazany przez review.",
    },
  });
}

async function runFixRound(
  store: LifecycleStore,
  deps: PollerDependencies,
  fixture: GitFixture,
  run: LifecycleRun,
  round: number
): Promise<{ run: LifecycleRun; workspace: Workspace; previousSha: string; sha: string }> {
  const previousSha = run.headSha!;
  run = apply(store, run, {
    type: "fix",
    commentId: `fix-${round}`,
    nextAttempt: round,
  });
  const buildCommand = store.outstandingCommands(20).find((command) =>
    command.kind === "run-job" &&
    command.payload.kind === "build" &&
    command.payload.attempt === round
  )!;
  assert.equal(buildCommand.payload.buildBase, "continue-branch");
  assert.equal(buildCommand.payload.branch, fixture.branch);
  assert.equal(buildCommand.payload.headSha, previousSha);

  const workspace = await createWorkspace(
    fixture.repo,
    run.ticketId,
    "title-may-have-changed",
    "main",
    previousSha,
    { mode: "continue-branch", branch: fixture.branch }
  );
  const changedFile = `fix-${round}.txt`;
  writeFileSync(join(workspace.dir, changedFile), `fix round ${round}\n`);
  git(workspace.dir, "add", changedFile);
  git(workspace.dir, "commit", "-m", `fix round ${round}`);
  const sha = git(workspace.dir, "rev-parse", "HEAD");

  run = apply(store, run, {
    type: "job-finished",
    attempt: round,
    output: {
      kind: "build",
      outcome: "success",
      report: `round ${round} fixed`,
      signature: "ai-factory · test · builder",
      durationMs: 1,
      files: run.planFiles,
      branch: fixture.branch,
      workspaceDir: workspace.dir,
      headSha: sha,
      changedFiles: [changedFile],
      scopeWarnings: [],
    },
  }, buildCommand.key);
  assert.deepEqual([run.stage, run.status, run.headSha], ["test", "pending", sha]);

  run = apply(store, run, {
    type: "test-result",
    ok: true,
    sha,
    report: "exact-SHA pass",
  });
  await dispatchOutbox(deps);
  run = store.getRun(run.ticketId)!;
  return { run, workspace, previousSha, sha };
}

function assertFastForward(
  fixture: GitFixture,
  ancestor: string,
  descendant: string
): void {
  assert.doesNotThrow(() =>
    git(fixture.repo, "merge-base", "--is-ancestor", ancestor, descendant)
  );
  assert.equal(
    git(fixture.repo, "ls-remote", "--heads", "origin", fixture.branch).split(/\s+/)[0],
    descendant
  );
}

function assertNoForce(fixture: GitFixture): void {
  const pushes = readFileSync(fixture.gitLog, "utf8")
    .split(/\r?\n/)
    .filter((line) => /\spush\s/.test(line))
    .join("\n");
  assert.doesNotMatch(pushes, /(?:^|\s)--force(?:-with-lease)?(?:\s|$)/m);
}

test("/fix publikuje się fast-forward na tym samym PR", async () => {
  await withFixture(async (fixture, store, deps) => {
    const seeded = seedMergeRun(store, fixture, "BAR-199-ONE");
    const result = await runFixRound(store, deps, fixture, seeded, 1);
    try {
      assert.deepEqual(
        [result.run.stage, result.run.status, result.run.prUrl, result.run.fixRound],
        ["ci", "waiting_external", prUrl, 1]
      );
      assertFastForward(fixture, result.previousSha, result.sha);
      const ghLog = readFileSync(fixture.ghLog, "utf8");
      assert.match(ghLog, /pr list .*--head agent\/BAR-199-fix-publish/);
      assert.doesNotMatch(ghLog, /pr create/);
      assertNoForce(fixture);
    } finally {
      await removeWorkspace(result.workspace);
    }
  });
});

test("dwie rundy /fix pod rząd publikują się bez interwencji", async () => {
  await withFixture(async (fixture, store, deps) => {
    let run = seedMergeRun(store, fixture, "BAR-199-TWO");
    const first = await runFixRound(store, deps, fixture, run, 1);
    assertFastForward(fixture, first.previousSha, first.sha);

    run = store.transition(run.ticketId, {
      stage: "merge",
      status: "waiting_human",
      actor: "test",
      reason: "second-review-advisory-fix",
      patch: {
        reviewStatus: "advisory-fix",
        reviewReport: "Druga uwaga review.",
      },
    });
    const second = await runFixRound(store, deps, fixture, run, 2);
    try {
      assert.deepEqual(
        [second.run.stage, second.run.status, second.run.fixRound, second.run.prUrl],
        ["ci", "waiting_external", 2, prUrl]
      );
      assertFastForward(fixture, first.sha, second.sha);
      const ghLog = readFileSync(fixture.ghLog, "utf8");
      assert.equal((ghLog.match(/pr list/g) ?? []).length, 2);
      assert.doesNotMatch(ghLog, /pr create/);
      assertNoForce(fixture);
    } finally {
      await removeWorkspace(second.workspace);
    }
  });
});

test("obcy commit na gałęzi zatrzymuje /fix przed uruchomieniem buildera", async () => {
  await withFixture(async (fixture, store, deps) => {
    git(fixture.repo, "switch", "-c", "candidate-fix", fixture.oldSha);
    writeFileSync(join(fixture.repo, "candidate.txt"), "candidate\n");
    git(fixture.repo, "add", "candidate.txt");
    git(fixture.repo, "commit", "-m", "candidate fix");
    const candidateSha = git(fixture.repo, "rev-parse", "HEAD");
    git(fixture.repo, "switch", "main");

    const other = join(fixture.root, "other-clone");
    execFileSync("git", ["clone", fixture.origin, other]);
    git(other, "config", "user.email", "other@example.test");
    git(other, "config", "user.name", "Other Test");
    git(other, "switch", fixture.branch);
    writeFileSync(join(other, "foreign.txt"), "foreign\n");
    git(other, "add", "foreign.txt");
    git(other, "commit", "-m", "foreign change");
    const foreignSha = git(other, "rev-parse", "HEAD");
    git(other, "push", "origin", fixture.branch);

    await assert.rejects(
      createWorkspace(
        fixture.repo,
        "BAR-199-DIVERGED",
        "ignored",
        "main",
        fixture.oldSha,
        { mode: "continue-branch", branch: fixture.branch }
      ),
      (error: unknown) => {
        assert.match(String(error), /BRANCH_DIVERGED/);
        assert.match(String(error), new RegExp(foreignSha.slice(0, 7)));
        assert.match(String(error), new RegExp(fixture.oldSha.slice(0, 7)));
        return true;
      }
    );

    const created = store.createRun("BAR-199-DIVERGED", "harness", manifest);
    store.transition(created.ticketId, {
      stage: "publish",
      status: "pending",
      actor: "test",
      reason: "publish-diverged",
      patch: {
        plan: "plan",
        planFiles: ["published.txt", "candidate.txt"],
        branch: fixture.branch,
        headSha: candidateSha,
        testedSha: candidateSha,
        prUrl,
      },
      command: {
        key: "BAR-199-DIVERGED:g1:publish",
        ticketId: created.ticketId,
        kind: "publish-pr",
        stage: "publish",
        payload: { branch: fixture.branch, sha: candidateSha },
      },
    });
    await dispatchOutbox(deps);

    const failed = store.getCommand("BAR-199-DIVERGED:g1:publish")!;
    assert.deepEqual([failed.state, failed.attempts], ["failed", 1]);
    assert.match(failed.lastError ?? "", /BRANCH_DIVERGED/);
    assert.deepEqual(
      [store.getRun(created.ticketId)?.status, store.getRun(created.ticketId)?.errorCode],
      ["blocked", "OUTBOX_FAILED"]
    );
    assertNoForce(fixture);
  });
});

test("main ruszył po publikacji — etap testów synchronizuje, a publikacja przechodzi", async () => {
  await withFixture(async (fixture, store, deps) => {
    const ticketId = "BAR-199-MAIN-SYNC";
    const workspace = await createWorkspace(
      fixture.repo,
      ticketId,
      "ignored",
      "main",
      fixture.oldSha,
      { mode: "continue-branch", branch: fixture.branch }
    );
    try {
      writeFileSync(join(workspace.dir, "fix-main.txt"), "fix before main sync\n");
      git(workspace.dir, "add", "fix-main.txt");
      git(workspace.dir, "commit", "-m", "fix before main sync");
      const buildSha = git(workspace.dir, "rev-parse", "HEAD");

      writeFileSync(join(fixture.repo, "main-only.txt"), "new main\n");
      git(fixture.repo, "add", "main-only.txt");
      git(fixture.repo, "commit", "-m", "main advances");
      const mainSha = git(fixture.repo, "rev-parse", "HEAD");
      git(fixture.repo, "push", "origin", "main");

      const tested = await runDetachedTests({
        ticketId,
        project: "harness",
        sha: buildSha,
        attempt: 1,
        planFiles: ["published.txt", "fix-main.txt"],
      });
      assert.equal(tested.ok, true, tested.report);
      assert.notEqual(tested.finalSha, buildSha);
      assert.doesNotThrow(() =>
        git(fixture.repo, "merge-base", "--is-ancestor", mainSha, tested.finalSha)
      );

      const created = store.createRun(ticketId, "harness", manifest);
      let run = store.transition(ticketId, {
        stage: "test",
        status: "pending",
        actor: "test",
        reason: "checkpoint-created",
        patch: {
          plan: "plan",
          planFiles: ["published.txt", "fix-main.txt"],
          branch: fixture.branch,
          workspaceDir: workspace.dir,
          headSha: buildSha,
          testedSha: undefined,
          prUrl,
        },
      });
      run = apply(store, run, {
        type: "branch-synchronized",
        previousSha: buildSha,
        sha: tested.finalSha,
      });
      run = apply(store, run, {
        type: "test-result",
        ok: true,
        sha: tested.finalSha,
        report: tested.report,
      });
      await dispatchOutbox(deps);
      run = store.getRun(created.ticketId)!;

      assert.deepEqual(
        [run.stage, run.status, run.prUrl, run.headSha],
        ["ci", "waiting_external", prUrl, tested.finalSha]
      );
      assertFastForward(fixture, fixture.oldSha, tested.finalSha);
      assertNoForce(fixture);
    } finally {
      await removeWorkspace(workspace);
    }
  });
});
