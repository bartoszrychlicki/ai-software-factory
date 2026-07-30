import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
import { reduceLifecycle } from "../pipeline/coordinator";
import {
  dispatchOutbox,
  type PollerDependencies,
} from "../sources/poll-linear-v2";

const manifest: TicketManifestV2 = {
  title: "Cleanup after replan",
  description: "Retire previous generation",
  labels: [],
  inputHash: "hash-1",
};

interface GitFixture {
  root: string;
  repo: string;
  origin: string;
  workspace: string;
  ghLog: string;
  branch: string;
  oldSha: string;
  newSha: string;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function createGitFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "factory-replan-cleanup-"));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  const workspace = join(root, "old-worktree");
  const bin = join(root, "bin");
  const ghLog = join(root, "gh.log");
  const branch = "agent/BAR-192-cleanup-after-replan";

  execFileSync("git", ["init", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["clone", origin, repo]);
  git(repo, "config", "user.email", "factory@example.test");
  git(repo, "config", "user.name", "Factory Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "push", "-u", "origin", "main");

  git(repo, "switch", "-c", branch);
  writeFileSync(join(repo, "old.txt"), "old generation\n");
  git(repo, "add", "old.txt");
  git(repo, "commit", "-m", "old generation");
  const oldSha = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "-u", "origin", branch);
  git(repo, "switch", "main");
  git(repo, "worktree", "add", workspace, branch);

  writeFileSync(join(repo, "new.txt"), "new generation\n");
  git(repo, "add", "new.txt");
  git(repo, "commit", "-m", "new generation");
  const newSha = git(repo, "rev-parse", "HEAD");

  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(gh, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$FACTORY_TEST_GH_LOG\"",
    "if [ \"$1 $2\" = \"pr view\" ]; then",
    "  case \" $* \" in",
    "    *\" --json state,url \"*)",
    "      case \"$FACTORY_TEST_PR_STATE\" in",
    "        merged) state=MERGED ;;",
    "        closed) state=CLOSED ;;",
    "        *) state=OPEN ;;",
    "      esac",
    "      printf '{\"state\":\"%s\",\"url\":\"https://github.test/o/r/pull/1\"}\\n' \"$state\"",
    "      ;;",
    "    *\" --json comments \"*) printf '{\"comments\":[]}\\n' ;;",
    "  esac",
    "elif [ \"$1 $2\" = \"pr list\" ]; then",
    "  printf '[]\\n'",
    "elif [ \"$1 $2\" = \"pr create\" ]; then",
    "  printf 'https://github.test/o/r/pull/2\\n'",
    "fi",
  ].join("\n"));
  chmodSync(gh, 0o755);

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

  return { root, repo, origin, workspace, ghLog, branch, oldSha, newSha };
}

async function withFixture(
  prState: "open" | "merged" | "closed",
  runTest: (
    fixture: GitFixture,
    store: LifecycleStore,
    deps: PollerDependencies,
    notifications: string[]
  ) => Promise<void> | void
): Promise<void> {
  const fixture = createGitFixture();
  const previousRoot = process.env.FACTORY_ROOT;
  const previousPath = process.env.PATH;
  const previousState = process.env.FACTORY_TEST_PR_STATE;
  const previousLog = process.env.FACTORY_TEST_GH_LOG;
  const store = new LifecycleStore(join(fixture.root, "registry.db"));
  const notifications: string[] = [];
  try {
    process.env.FACTORY_ROOT = fixture.root;
    process.env.PATH = `${join(fixture.root, "bin")}:${previousPath ?? ""}`;
    process.env.FACTORY_TEST_PR_STATE = prState;
    process.env.FACTORY_TEST_GH_LOG = fixture.ghLog;
    const source = {
      async listComments() { return []; },
      async comment() {},
      async setStateByName() {},
    };
    const deps: PollerDependencies = {
      store,
      mastra: {} as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", source as never]]),
      notifier: async (title, message) => { notifications.push(`${title}: ${message}`); },
    };
    await runTest(fixture, store, deps, notifications);
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.FACTORY_TEST_PR_STATE;
    else process.env.FACTORY_TEST_PR_STATE = previousState;
    if (previousLog === undefined) delete process.env.FACTORY_TEST_GH_LOG;
    else process.env.FACTORY_TEST_GH_LOG = previousLog;
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function seedPreviousGeneration(
  store: LifecycleStore,
  fixture: GitFixture,
  options: { prUrl?: string; mergedSha?: string } = { prUrl: "https://github.test/o/r/pull/1" }
): LifecycleRun {
  const run = store.createRun("BAR-192", "harness", manifest);
  return store.transition(run.ticketId, {
    stage: "merge",
    status: "waiting_human",
    actor: "test",
    reason: "old-pr-open",
    patch: {
      plan: "old plan",
      planFiles: ["old.txt"],
      branch: fixture.branch,
      workspaceDir: fixture.workspace,
      headSha: fixture.oldSha,
      testedSha: fixture.oldSha,
      prUrl: options.prUrl,
      mergedSha: options.mergedSha,
    },
  });
}

function applyReplan(store: LifecycleStore, run: LifecycleRun): LifecycleRun {
  const decision = reduceLifecycle(run, {
    type: "replan",
    commentId: "comment-replan",
    reason: "nowy plan",
    nextAttempt: 2,
  });
  const updated = store.transition(run.ticketId, {
    ...decision.transition,
    commands: decision.commands,
  });
  for (const command of decision.commands.filter((candidate) => candidate.kind === "run-job")) {
    store.markCommand(command.key, "done", { error: "test-skips-planner" });
  }
  return updated;
}

test("/replan zamyka stary PR, usuwa jego branch/worktree i pozwala opublikować nową generację", async () => {
  await withFixture("open", async (fixture, store, deps) => {
    const oldRun = seedPreviousGeneration(store, fixture);
    const decision = reduceLifecycle(oldRun, {
      type: "replan",
      commentId: "comment-replan",
      reason: "nowy plan",
      nextAttempt: 2,
    });
    assert.deepEqual(decision.commands.map((command) => command.kind), [
      "retire-generation",
      "run-job",
    ]);
    assert.deepEqual(decision.commands[0].payload, {
      prUrl: "https://github.test/o/r/pull/1",
      branch: fixture.branch,
      workspaceDir: fixture.workspace,
      generation: 1,
      reason: "zastąpione nową generacją planu po /replan",
    });

    let run = applyReplan(store, oldRun);
    assert.equal(run.prUrl, undefined);
    await dispatchOutbox(deps);

    const ghAfterRetire = readFileSync(fixture.ghLog, "utf8");
    assert.match(ghAfterRetire, /pr comment https:\/\/github\.test\/o\/r\/pull\/1/);
    assert.match(ghAfterRetire, /Zastąpione nową generacją planu po \/replan/);
    assert.match(ghAfterRetire, /pr close https:\/\/github\.test\/o\/r\/pull\/1/);
    assert.equal(git(fixture.repo, "ls-remote", "--heads", "origin", fixture.branch), "");
    assert.equal(existsSync(fixture.workspace), false);
    assert.equal(git(fixture.repo, "branch", "--list", fixture.branch), "");

    run = store.transition(run.ticketId, {
      stage: "test",
      status: "running",
      actor: "test",
      reason: "new-checkpoint",
      patch: {
        branch: fixture.branch,
        workspaceDir: undefined,
        headSha: fixture.newSha,
        testedSha: undefined,
      },
    });
    const publish = reduceLifecycle(run, {
      type: "test-result",
      ok: true,
      sha: fixture.newSha,
      report: "pass",
    });
    store.transition(run.ticketId, {
      ...publish.transition,
      commands: publish.commands,
    });
    await dispatchOutbox(deps);

    const published = store.getRun(run.ticketId)!;
    assert.deepEqual([published.stage, published.status], ["ci", "waiting_external"]);
    assert.equal(published.prUrl, "https://github.test/o/r/pull/2");
    assert.equal(
      git(fixture.repo, "ls-remote", "--heads", "origin", fixture.branch).split(/\s+/)[0],
      fixture.newSha
    );
  });
});

test("/replan bez prUrl nie enqueue'uje retire-generation i nie wywołuje GitHuba", async () => {
  await withFixture("open", async (fixture, store, deps) => {
    const oldRun = seedPreviousGeneration(store, fixture, { prUrl: undefined });
    const decision = reduceLifecycle(oldRun, {
      type: "replan",
      commentId: "comment-replan",
      reason: "nowy plan",
      nextAttempt: 2,
    });
    assert.deepEqual(decision.commands.map((command) => command.kind), ["run-job"]);
    applyReplan(store, oldRun);
    await dispatchOutbox(deps);
    assert.equal(existsSync(fixture.ghLog), false);
    assert.notEqual(git(fixture.repo, "ls-remote", "--heads", "origin", fixture.branch), "");
  });
});

test("retire-generation nie dotyka zmergowanego PR-a ani jego zdalnej gałęzi", async () => {
  await withFixture("merged", async (fixture, store, deps) => {
    const oldRun = seedPreviousGeneration(store, fixture);
    applyReplan(store, oldRun);
    await dispatchOutbox(deps);

    const ghLog = readFileSync(fixture.ghLog, "utf8");
    assert.match(ghLog, /pr view .* --json state,url/);
    assert.doesNotMatch(ghLog, /pr comment|pr close/);
    assert.notEqual(git(fixture.repo, "ls-remote", "--heads", "origin", fixture.branch), "");
    assert.equal(existsSync(fixture.workspace), false);
    assert.equal(git(fixture.repo, "branch", "--list", fixture.branch), "");

    const knownMerged = seedPreviousGeneration(
      store,
      fixture,
      { prUrl: "https://github.test/o/r/pull/1", mergedSha: fixture.oldSha }
    );
    const knownMergedDecision = reduceLifecycle(knownMerged, {
      type: "replan",
      commentId: "known-merged",
      reason: "nie sprzątaj",
      nextAttempt: 3,
    });
    assert.equal(
      knownMergedDecision.commands.some((command) => command.kind === "retire-generation"),
      false
    );
  });
});

test("rozjechana zdalna gałąź kończy publish-pr po jednej próbie czytelnym błędem terminalnym", async () => {
  await withFixture("open", async (fixture, store, deps, notifications) => {
    const run = store.createRun("BAR-192", "harness", manifest);
    store.transition(run.ticketId, {
      stage: "publish",
      status: "pending",
      actor: "test",
      reason: "publish-diverged",
      patch: {
        branch: fixture.branch,
        headSha: fixture.newSha,
        testedSha: fixture.newSha,
      },
      command: {
        key: "BAR-192:g1:publish:diverged",
        ticketId: run.ticketId,
        kind: "publish-pr",
        stage: "publish",
        payload: { branch: fixture.branch, sha: fixture.newSha },
      },
    });

    await dispatchOutbox(deps);
    const failed = store.getCommand("BAR-192:g1:publish:diverged")!;
    assert.deepEqual([failed.state, failed.attempts], ["failed", 1]);
    assert.match(failed.lastError ?? "", /BRANCH_DIVERGED/);
    assert.match(failed.lastError ?? "", /wskazuje inną generację/);
    assert.match(failed.lastError ?? "", /Wymagane sprzątanie poprzedniej generacji/);
    assert.deepEqual(
      [store.getRun(run.ticketId)?.status, store.getRun(run.ticketId)?.errorCode],
      ["blocked", "OUTBOX_FAILED"]
    );
    assert.equal(
      notifications.filter((message) => message.includes("dead-letter publish-pr")).length,
      1
    );
    assert.equal(existsSync(fixture.ghLog), false);

    await dispatchOutbox(deps);
    assert.equal(store.getCommand("BAR-192:g1:publish:diverged")?.attempts, 1);
  });
});

test("retire-generation odrzuca gałąź innego ticketu bez wywołań GitHuba", async () => {
  await withFixture("open", async (fixture, store, deps) => {
    const foreignBranch = "agent/BAR-OTHER-foreign";
    git(fixture.repo, "push", "origin", `${fixture.oldSha}:refs/heads/${foreignBranch}`);
    const run = store.createRun("BAR-192", "harness", manifest);
    store.enqueue({
      key: "BAR-192:g1:retire:1",
      ticketId: run.ticketId,
      kind: "retire-generation",
      stage: "merge",
      payload: {
        prUrl: "https://github.test/o/r/pull/1",
        branch: foreignBranch,
        generation: 1,
        reason: "test",
      },
    });

    await dispatchOutbox(deps);
    const command = store.getCommand("BAR-192:g1:retire:1")!;
    assert.deepEqual([command.state, command.lastError], ["done", "branch-not-owned"]);
    assert.equal(existsSync(fixture.ghLog), false);
    assert.notEqual(git(fixture.repo, "ls-remote", "--heads", "origin", foreignBranch), "");
  });
});

test("input-changed-before-build również kopiuje dane starej generacji do retire-generation", () => {
  const run: LifecycleRun = {
    ticketId: "BAR-192",
    project: "harness",
    generation: 4,
    stage: "approval",
    status: "waiting_human",
    manifest,
    plan: "plan",
    planFiles: ["src/a.ts"],
    clarifyRound: 0,
    critiqueRound: 0,
    branch: "agent/BAR-192-cleanup-after-replan",
    workspaceDir: "/tmp/BAR-192-old",
    prUrl: "https://github.test/o/r/pull/4",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
  const decision = reduceLifecycle(run, {
    type: "input-changed",
    inputHash: "hash-2",
    nextAttempt: 2,
  });
  assert.equal(decision.transition.reason, "input-changed-before-build");
  assert.deepEqual(decision.commands.map((command) => command.kind), [
    "retire-generation",
    "run-job",
  ]);
  assert.deepEqual(decision.commands[0].payload, {
    prUrl: run.prUrl,
    branch: run.branch,
    workspaceDir: run.workspaceDir,
    generation: 4,
    reason: "zastąpione nową generacją po zmianie wejścia ticketu",
  });
});
