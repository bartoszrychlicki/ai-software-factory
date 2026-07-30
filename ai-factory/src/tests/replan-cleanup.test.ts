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
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const gitShim = join(bin, "git");
  writeFileSync(gitShim, [
    "#!/bin/sh",
    "if [ \"$FACTORY_TEST_GIT_FAIL\" = \"fetch\" ] &&",
    "   [ \"$3\" = \"fetch\" ] && [ \"$4\" = \"origin\" ] &&",
    "   [ \"$5\" = \"$FACTORY_TEST_PR_HEAD_NAME\" ]; then",
    "  printf 'sterowana awaria git fetch\\n' >&2",
    "  exit 1",
    "fi",
    `exec ${JSON.stringify(realGit)} "$@"`,
  ].join("\n"));
  chmodSync(gitShim, 0o755);

  const gh = join(bin, "gh");
  writeFileSync(gh, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$FACTORY_TEST_GH_LOG\"",
    "if [ \"$1 $2\" = \"pr view\" ]; then",
    "  if [ \"$FACTORY_TEST_GH_FAIL\" = \"pr-view\" ]; then",
    "    printf 'sterowana awaria pr view\\n' >&2",
    "    exit 1",
    "  fi",
    "  case \" $* \" in",
    "    *\" --json state,url,headRefName,headRefOid \"*)",
    "      case \"$FACTORY_TEST_PR_STATE\" in",
    "        merged) state=MERGED ;;",
    "        closed) state=CLOSED ;;",
    "        *) state=OPEN ;;",
    "      esac",
    "      printf '{\"state\":\"%s\",\"url\":\"https://github.test/o/r/pull/1\",\"headRefName\":\"%s\",\"headRefOid\":\"%s\"}\\n' \"$state\" \"$FACTORY_TEST_PR_HEAD_NAME\" \"$FACTORY_TEST_PR_HEAD_OID\"",
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
  const previousHeadName = process.env.FACTORY_TEST_PR_HEAD_NAME;
  const previousHeadOid = process.env.FACTORY_TEST_PR_HEAD_OID;
  const previousGhFail = process.env.FACTORY_TEST_GH_FAIL;
  const previousGitFail = process.env.FACTORY_TEST_GIT_FAIL;
  const store = new LifecycleStore(join(fixture.root, "registry.db"));
  const notifications: string[] = [];
  try {
    process.env.FACTORY_ROOT = fixture.root;
    process.env.PATH = `${join(fixture.root, "bin")}:${previousPath ?? ""}`;
    process.env.FACTORY_TEST_PR_STATE = prState;
    process.env.FACTORY_TEST_GH_LOG = fixture.ghLog;
    process.env.FACTORY_TEST_PR_HEAD_NAME = fixture.branch;
    process.env.FACTORY_TEST_PR_HEAD_OID = fixture.oldSha;
    delete process.env.FACTORY_TEST_GH_FAIL;
    delete process.env.FACTORY_TEST_GIT_FAIL;
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
    if (previousHeadName === undefined) delete process.env.FACTORY_TEST_PR_HEAD_NAME;
    else process.env.FACTORY_TEST_PR_HEAD_NAME = previousHeadName;
    if (previousHeadOid === undefined) delete process.env.FACTORY_TEST_PR_HEAD_OID;
    else process.env.FACTORY_TEST_PR_HEAD_OID = previousHeadOid;
    if (previousGhFail === undefined) delete process.env.FACTORY_TEST_GH_FAIL;
    else process.env.FACTORY_TEST_GH_FAIL = previousGhFail;
    if (previousGitFail === undefined) delete process.env.FACTORY_TEST_GIT_FAIL;
    else process.env.FACTORY_TEST_GIT_FAIL = previousGitFail;
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

function applyReplan(
  store: LifecycleStore,
  run: LifecycleRun,
  options: { deferPlanningJob?: boolean } = {}
): LifecycleRun {
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
  if (options.deferPlanningJob !== false) {
    for (const command of decision.commands.filter((candidate) => candidate.kind === "run-job")) {
      store.deferCommand(command.key, new Date(Date.now() + 60_000).toISOString());
    }
  }
  return updated;
}

function pushUnseenDivergedBranch(fixture: GitFixture): string {
  const other = join(fixture.root, "other-clone");
  execFileSync("git", ["clone", fixture.origin, other]);
  git(other, "config", "user.email", "other@example.test");
  git(other, "config", "user.name", "Other Test");
  writeFileSync(join(other, "remote-only.txt"), "remote generation\n");
  git(other, "add", "remote-only.txt");
  git(other, "commit", "-m", "remote-only generation");
  const sha = git(other, "rev-parse", "HEAD");
  git(other, "push", "--force", "origin", `${sha}:refs/heads/${fixture.branch}`);
  return sha;
}

function pushDescendantOfOldGeneration(fixture: GitFixture): string {
  writeFileSync(join(fixture.workspace, "follow-up.txt"), "follow-up commit\n");
  git(fixture.workspace, "add", "follow-up.txt");
  git(fixture.workspace, "commit", "-m", "follow-up on old generation");
  const sha = git(fixture.workspace, "rev-parse", "HEAD");
  git(fixture.workspace, "push", "origin", fixture.branch);
  return sha;
}

function startNewGenerationWorkspace(
  fixture: GitFixture,
  worktreesRoot: string
): { branch: string; dir: string } {
  const workspaceModule = new URL("../pipeline/workspace.ts", import.meta.url).href;
  const tsxLoader = process.env.FACTORY_TEST_TSX_LOADER ??
    fileURLToPath(new URL("../../node_modules/tsx/dist/esm/index.mjs", import.meta.url));
  const script = [
    `import { createWorkspace } from ${JSON.stringify(workspaceModule)};`,
    `createWorkspace(${JSON.stringify(fixture.repo)}, "BAR-192", ` +
      `"cleanup-after-replan", "main").then(`,
    "  (workspace) => process.stdout.write(JSON.stringify(workspace)),",
    "  (error) => { console.error(error); process.exitCode = 1; }",
    ");",
  ].join("\n");
  const stdout = execFileSync(
    process.execPath,
    ["--import", tsxLoader, "--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      env: { ...process.env, FACTORY_WORKTREES: worktreesRoot },
    }
  );
  return JSON.parse(stdout) as { branch: string; dir: string };
}

test("/replan zamyka stary PR, usuwa jego zdalny branch i pozwala opublikować nową generację", async () => {
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
      headSha: fixture.oldSha,
      generation: 1,
      reason: "zastąpione nową generacją planu po /replan",
    });

    let run = applyReplan(store, oldRun);
    assert.equal(run.prUrl, undefined);
    await dispatchOutbox(deps);

    const ghAfterRetire = readFileSync(fixture.ghLog, "utf8");
    assert.match(ghAfterRetire, /pr comment https:\/\/github\.test\/o\/r\/pull\/1/);
    assert.match(ghAfterRetire, /Generacja \*\*g1\*\* została zastąpiona nowym planem/);
    assert.match(ghAfterRetire, /pr close https:\/\/github\.test\/o\/r\/pull\/1/);
    assert.equal(git(fixture.repo, "ls-remote", "--heads", "origin", fixture.branch), "");
    assert.equal(existsSync(fixture.workspace), true);
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.branch), "");
    assert.equal(store.hasOutstandingJob(run.ticketId), true);

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

test("createWorkspace po /replan odtwarza worktree i branch od świeżego origin/main", async () => {
  await withFixture("open", async (fixture, store) => {
    const oldRun = seedPreviousGeneration(store, fixture);
    applyReplan(store, oldRun);
    const worktreesRoot = join(fixture.root, "worktrees");
    const expectedDir = join(worktreesRoot, basename(fixture.repo), "BAR-192");
    mkdirSync(join(worktreesRoot, basename(fixture.repo)), { recursive: true });
    git(fixture.repo, "worktree", "remove", "--force", fixture.workspace);
    git(fixture.repo, "worktree", "add", expectedDir, fixture.branch);
    assert.equal(git(expectedDir, "rev-parse", "HEAD"), fixture.oldSha);

    const freshBase = git(fixture.repo, "rev-parse", "origin/main");
    const workspace = startNewGenerationWorkspace(fixture, worktreesRoot);

    assert.equal(workspace.dir, expectedDir);
    assert.equal(workspace.branch, fixture.branch);
    assert.equal(git(workspace.dir, "rev-parse", "HEAD"), freshBase);
    assert.equal(git(fixture.repo, "rev-parse", `refs/heads/${fixture.branch}`), freshBase);
    assert.equal(existsSync(join(workspace.dir, "old.txt")), false);
    assert.equal(store.hasOutstandingJob(oldRun.ticketId), true);
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
    assert.equal(existsSync(fixture.workspace), true);
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.branch), "");
    assert.match(
      store.getCommand("BAR-192:g1:retire")?.lastError ?? "",
      /retire-skip: PR .* jest zmergowany/
    );

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

test("retire-generation usuwa zdalny tip będący potomkiem headSha payloadu", async () => {
  await withFixture("open", async (fixture, store, deps) => {
    const oldRun = seedPreviousGeneration(store, fixture);
    applyReplan(store, oldRun);
    const descendantSha = pushDescendantOfOldGeneration(fixture);
    process.env.FACTORY_TEST_PR_HEAD_OID = descendantSha;

    await dispatchOutbox(deps);

    const ghLog = readFileSync(fixture.ghLog, "utf8");
    assert.match(ghLog, /pr comment https:\/\/github\.test\/o\/r\/pull\/1/);
    assert.match(ghLog, /pr close https:\/\/github\.test\/o\/r\/pull\/1/);
    assert.equal(git(fixture.repo, "ls-remote", "--heads", "origin", fixture.branch), "");
    assert.equal(store.getCommand("BAR-192:g1:retire")?.lastError, undefined);
  });
});

test("legacy retire bez headSha zamyka PR, ale jawnie pomija usunięcie brancha", async () => {
  await withFixture("open", async (fixture, store, deps) => {
    const created = store.createRun("BAR-192", "harness", manifest);
    const legacyRun = store.transition(created.ticketId, {
      stage: "merge",
      status: "waiting_human",
      actor: "test",
      reason: "legacy-pr-open",
      patch: {
        plan: "old plan",
        planFiles: ["old.txt"],
        branch: fixture.branch,
        workspaceDir: fixture.workspace,
        prUrl: "https://github.test/o/r/pull/1",
      },
    });
    const decision = reduceLifecycle(legacyRun, {
      type: "replan",
      commentId: "legacy-replan",
      reason: "nowy plan",
      nextAttempt: 2,
    });
    assert.deepEqual(decision.commands.map((command) => command.kind), [
      "retire-generation",
      "run-job",
    ]);
    const updated = store.transition(legacyRun.ticketId, {
      ...decision.transition,
      commands: decision.commands,
    });
    const runJob = decision.commands.find((command) => command.kind === "run-job")!;
    store.deferCommand(runJob.key, new Date(Date.now() + 60_000).toISOString());
    const retireBeforeDispatch = store.getCommand("BAR-192:g1:retire")!;
    assert.equal(Object.hasOwn(retireBeforeDispatch.payload, "headSha"), false);

    await dispatchOutbox(deps);

    const ghLog = readFileSync(fixture.ghLog, "utf8");
    assert.match(ghLog, /pr comment https:\/\/github\.test\/o\/r\/pull\/1/);
    assert.match(ghLog, /pr close https:\/\/github\.test\/o\/r\/pull\/1/);
    assert.notEqual(git(fixture.repo, "ls-remote", "--heads", "origin", fixture.branch), "");
    const retired = store.getCommand("BAR-192:g1:retire")!;
    assert.equal(retired.state, "done");
    assert.match(
      retired.lastError ?? "",
      /retire-skip: legacy-payload-bez-headSha: pomijam usunięcie gałęzi/
    );
    assert.equal(store.hasOutstandingJob(updated.ticketId), true);
  });
});

test("nieudany fetch bezpiecznie zostawia branch i zapisuje skip", async () => {
  await withFixture("open", async (fixture, store, deps) => {
    const oldRun = seedPreviousGeneration(store, fixture);
    applyReplan(store, oldRun);
    process.env.FACTORY_TEST_GIT_FAIL = "fetch";

    await dispatchOutbox(deps);

    const ghLog = readFileSync(fixture.ghLog, "utf8");
    assert.match(ghLog, /pr comment https:\/\/github\.test\/o\/r\/pull\/1/);
    assert.match(ghLog, /pr close https:\/\/github\.test\/o\/r\/pull\/1/);
    assert.notEqual(git(fixture.repo, "ls-remote", "--heads", "origin", fixture.branch), "");
    const retire = store.getCommand("BAR-192:g1:retire")!;
    assert.equal(retire.state, "done");
    assert.match(
      retire.lastError ?? "",
      /retire-skip: fetch-failed: .*sterowana awaria git fetch/s
    );
  });
});

test("inne headRefName pomija cały blok zdalny i zapisuje przyczynę", async () => {
  await withFixture("open", async (fixture, store, deps) => {
    const oldRun = seedPreviousGeneration(store, fixture);
    applyReplan(store, oldRun);
    process.env.FACTORY_TEST_PR_HEAD_NAME = "agent/BAR-192-inna-galaz";

    await dispatchOutbox(deps);

    const ghLog = readFileSync(fixture.ghLog, "utf8");
    assert.doesNotMatch(ghLog, /pr comment|pr close/);
    assert.notEqual(git(fixture.repo, "ls-remote", "--heads", "origin", fixture.branch), "");
    const retire = store.getCommand("BAR-192:g1:retire")!;
    assert.equal(retire.state, "done");
    assert.match(
      retire.lastError ?? "",
      /retire-skip: PR .* wskazuje agent\/BAR-192-inna-galaz/
    );
  });
});

test("rozjechana zdalna gałąź kończy publish-pr po jednej próbie czytelnym błędem terminalnym", async () => {
  await withFixture("open", async (fixture, store, deps, notifications) => {
    const remoteSha = pushUnseenDivergedBranch(fixture);
    assert.throws(
      () => git(fixture.repo, "cat-file", "-e", `${remoteSha}^{commit}`),
      /Command failed/
    );
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
    assert.match(failed.lastError ?? "", new RegExp(remoteSha.slice(0, 7)));
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
        headSha: fixture.oldSha,
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
    headSha: "1111111111111111111111111111111111111111",
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
    headSha: run.headSha,
    generation: 4,
    reason: "zastąpione nową generacją po zmianie wejścia ticketu",
  });
});

test("inne headRefOid nie blokuje zamknięcia PR-a, ale chroni przesuniętą gałąź", async () => {
  await withFixture("open", async (fixture, store, deps) => {
    const oldRun = seedPreviousGeneration(store, fixture);
    applyReplan(store, oldRun);
    const replacementSha = pushUnseenDivergedBranch(fixture);
    process.env.FACTORY_TEST_PR_HEAD_OID = replacementSha;

    await dispatchOutbox(deps);

    const ghLog = readFileSync(fixture.ghLog, "utf8");
    assert.match(ghLog, /pr comment https:\/\/github\.test\/o\/r\/pull\/1/);
    assert.match(ghLog, /pr close https:\/\/github\.test\/o\/r\/pull\/1/);
    assert.equal(existsSync(fixture.workspace), true);
    assert.equal(
      git(fixture.repo, "rev-parse", `refs/heads/${fixture.branch}`),
      fixture.oldSha
    );
    assert.equal(
      git(fixture.repo, "ls-remote", "--heads", "origin", fixture.branch).split(/\s+/)[0],
      replacementSha
    );
    const retire = store.getCommand("BAR-192:g1:retire")!;
    assert.equal(retire.state, "done");
    assert.match(
      retire.lastError ?? "",
      new RegExp(
        `retire-skip: branch-moved: ${replacementSha.slice(0, 7)} ` +
          `nie jest potomkiem ${fixture.oldSha.slice(0, 7)}`
      )
    );
  });
});

test("żywy job nowej generacji chroni lokalne artefakty i retire jest pierwszy w outboxie", async () => {
  await withFixture("open", async (fixture, store, deps) => {
    const oldRun = seedPreviousGeneration(store, fixture);
    applyReplan(store, oldRun, { deferPlanningJob: false });

    const pending = store.pendingCommands();
    assert.deepEqual(pending.slice(0, 2).map((command) => command.kind), [
      "retire-generation",
      "run-job",
    ]);
    const planningJob = pending[1];
    store.deferCommand(planningJob.key, new Date(Date.now() + 60_000).toISOString());

    await dispatchOutbox(deps);

    assert.equal(store.getCommand("BAR-192:g1:retire")?.state, "done");
    assert.equal(existsSync(fixture.workspace), true);
    assert.equal(
      git(fixture.repo, "rev-parse", `refs/heads/${fixture.branch}`),
      fixture.oldSha
    );
  });
});

test("awaria gh pr view pozostawia lokalne artefakty dla createWorkspace", async () => {
  await withFixture("open", async (fixture, store, deps) => {
    const oldRun = seedPreviousGeneration(store, fixture);
    applyReplan(store, oldRun);
    process.env.FACTORY_TEST_GH_FAIL = "pr-view";

    await dispatchOutbox(deps);

    const retire = store.getCommand("BAR-192:g1:retire")!;
    assert.deepEqual([retire.state, retire.attempts], ["pending", 1]);
    assert.match(retire.lastError ?? "", /remote-pr-view/);
    assert.match(retire.lastError ?? "", /sterowana awaria pr view/);
    assert.equal(existsSync(fixture.workspace), true);
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.branch), "");
    assert.notEqual(git(fixture.repo, "ls-remote", "--heads", "origin", fixture.branch), "");
  });
});
