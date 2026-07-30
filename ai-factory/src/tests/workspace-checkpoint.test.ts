import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointWithinScope,
  createWorkspace,
  removeWorkspace,
} from "../pipeline/workspace";
import { useTestWorktrees } from "./git-fixture";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

test("checkpoint przechodzi tylko gdy cały diff mieści się w nowym factory.files", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-checkpoint-"));
  const restoreWorktrees = useTestWorktrees(root);
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  try {
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, "config", "user.email", "factory@example.test");
    git(repo, "config", "user.name", "Factory Test");
    writeFileSync(join(repo, "declared.ts"), "base\n");
    writeFileSync(join(repo, "outside.ts"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");

    writeFileSync(join(repo, "declared.ts"), "changed\n");
    writeFileSync(join(repo, "outside.ts"), "changed\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "candidate");
    const checkpoint = git(repo, "rev-parse", "HEAD");

    assert.equal(
      await checkpointWithinScope(repo, checkpoint, ["declared.ts"], "main"),
      undefined
    );
    assert.equal(
      await checkpointWithinScope(repo, checkpoint, ["declared.ts", "outside.ts"], "main"),
      checkpoint
    );
  } finally {
    restoreWorktrees();
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace nakłada checkpoint na świeży main i bezpiecznie odrzuca konflikt", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-checkpoint-main-"));
  const restoreWorktrees = useTestWorktrees(root);
  const remote = join(root, "remote.git");
  const repo = join(root, "source-repo");
  const ticketId = `CHECKPOINT-FRESH-${process.pid}`;
  let workspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
  try {
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, "config", "user.email", "factory@example.test");
    git(repo, "config", "user.name", "Factory Test");
    writeFileSync(join(repo, "declared.ts"), "base\n");
    writeFileSync(join(repo, "main-only.ts"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");

    git(repo, "switch", "-c", "candidate");
    writeFileSync(join(repo, "declared.ts"), "candidate\n");
    git(repo, "add", "declared.ts");
    git(repo, "commit", "-m", "candidate");
    const checkpoint = git(repo, "rev-parse", "HEAD");

    git(repo, "switch", "main");
    writeFileSync(join(repo, "main-only.ts"), "fresh main\n");
    git(repo, "add", "main-only.ts");
    git(repo, "commit", "-m", "main advances");
    git(repo, "push", "origin", "main");

    workspace = await createWorkspace(repo, ticketId, "clean", "main", checkpoint);
    assert.ok(workspace.checkpointSha);
    assert.notEqual(workspace.checkpointSha, checkpoint);
    assert.equal(readFileSync(join(workspace.dir, "declared.ts"), "utf8"), "candidate\n");
    assert.equal(readFileSync(join(workspace.dir, "main-only.ts"), "utf8"), "fresh main\n");
    await removeWorkspace(workspace);
    workspace = undefined;

    writeFileSync(join(repo, "declared.ts"), "conflicting main\n");
    git(repo, "add", "declared.ts");
    git(repo, "commit", "-m", "main conflicts");
    git(repo, "push", "origin", "main");

    workspace = await createWorkspace(repo, ticketId, "conflict", "main", checkpoint);
    assert.equal(workspace.checkpointSha, undefined);
    assert.equal(readFileSync(join(workspace.dir, "declared.ts"), "utf8"), "conflicting main\n");
  } finally {
    if (workspace) await removeWorkspace(workspace);
    restoreWorktrees();
    rmSync(root, { recursive: true, force: true });
  }
});

test("continue-branch buduje na wierzchołku opublikowanej gałęzi zamiast cherry-picka na świeży main", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-continue-branch-"));
  const restoreWorktrees = useTestWorktrees(root);
  const remote = join(root, "remote.git");
  const repo = join(root, "source-repo");
  const ticketId = `CONTINUE-BRANCH-${process.pid}`;
  const branch = `agent/${ticketId}-published`;
  let workspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, "config", "user.email", "factory@example.test");
    git(repo, "config", "user.name", "Factory Test");
    writeFileSync(join(repo, "declared.ts"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");

    git(repo, "switch", "-c", branch);
    writeFileSync(join(repo, "declared.ts"), "published fix base\n");
    git(repo, "add", "declared.ts");
    git(repo, "commit", "-m", "published checkpoint");
    const oldSha = git(repo, "rev-parse", "HEAD");
    git(repo, "push", "-u", "origin", branch);

    git(repo, "switch", "main");
    writeFileSync(join(repo, "main-only.ts"), "fresh main\n");
    git(repo, "add", "main-only.ts");
    git(repo, "commit", "-m", "main advances");
    git(repo, "push", "origin", "main");

    workspace = await createWorkspace(
      repo,
      ticketId,
      "ignored-slug",
      "main",
      oldSha,
      { mode: "continue-branch", branch }
    );
    assert.equal(workspace.branch, branch);
    assert.equal(workspace.checkpointSha, oldSha);
    assert.equal(git(workspace.dir, "rev-parse", "HEAD"), oldSha);
    assert.equal(existsSync(join(workspace.dir, "main-only.ts")), false);

    writeFileSync(join(workspace.dir, "fix.ts"), "fixed\n");
    git(workspace.dir, "add", "fix.ts");
    git(workspace.dir, "commit", "-m", "fix in place");
    const newSha = git(workspace.dir, "rev-parse", "HEAD");
    assert.doesNotThrow(() =>
      git(workspace!.dir, "merge-base", "--is-ancestor", oldSha, newSha)
    );
  } finally {
    if (workspace) await removeWorkspace(workspace);
    restoreWorktrees();
    rmSync(root, { recursive: true, force: true });
  }
});

test("continue-branch odmawia, gdy zdalny wierzchołek nie jest opublikowanym SHA", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-continue-diverged-"));
  const restoreWorktrees = useTestWorktrees(root);
  const remote = join(root, "remote.git");
  const repo = join(root, "source-repo");
  const ticketId = `CONTINUE-DIVERGED-${process.pid}`;
  const branch = `agent/${ticketId}-published`;
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, "config", "user.email", "factory@example.test");
    git(repo, "config", "user.name", "Factory Test");
    writeFileSync(join(repo, "base.ts"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");

    git(repo, "switch", "-c", branch);
    writeFileSync(join(repo, "published.ts"), "factory\n");
    git(repo, "add", "published.ts");
    git(repo, "commit", "-m", "published checkpoint");
    const expectedSha = git(repo, "rev-parse", "HEAD");
    git(repo, "push", "-u", "origin", branch);

    writeFileSync(join(repo, "foreign.ts"), "foreign\n");
    git(repo, "add", "foreign.ts");
    git(repo, "commit", "-m", "foreign commit");
    const remoteTip = git(repo, "rev-parse", "HEAD");
    git(repo, "push", "origin", branch);

    await assert.rejects(
      createWorkspace(
        repo,
        ticketId,
        "ignored-slug",
        "main",
        expectedSha,
        { mode: "continue-branch", branch }
      ),
      (error: unknown) => {
        assert.match(String(error), /BRANCH_DIVERGED/);
        assert.match(String(error), new RegExp(expectedSha.slice(0, 7)));
        assert.match(String(error), new RegExp(remoteTip.slice(0, 7)));
        return true;
      }
    );
    const worktreesRoot = process.env.FACTORY_WORKTREES ??
      join(homedir(), ".ai-factory", "worktrees");
    assert.equal(
      existsSync(join(worktreesRoot, "source-repo", ticketId)),
      false
    );
  } finally {
    restoreWorktrees();
    rmSync(root, { recursive: true, force: true });
  }
});

test("continue-branch odmawia, gdy zdalna gałąź nie istnieje", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-continue-missing-"));
  const restoreWorktrees = useTestWorktrees(root);
  const remote = join(root, "remote.git");
  const repo = join(root, "source-repo");
  const ticketId = `CONTINUE-MISSING-${process.pid}`;
  const branch = `agent/${ticketId}-missing`;
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, "config", "user.email", "factory@example.test");
    git(repo, "config", "user.name", "Factory Test");
    writeFileSync(join(repo, "base.ts"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    const expectedSha = git(repo, "rev-parse", "HEAD");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");

    await assert.rejects(
      createWorkspace(
        repo,
        ticketId,
        "ignored-slug",
        "main",
        expectedSha,
        { mode: "continue-branch", branch }
      ),
      /FIX_BASE_MISSING/
    );
  } finally {
    restoreWorktrees();
    rmSync(root, { recursive: true, force: true });
  }
});
