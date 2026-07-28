import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointWithinScope,
  createWorkspace,
  removeWorkspace,
} from "../pipeline/workspace";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

test("checkpoint przechodzi tylko gdy cały diff mieści się w nowym factory.files", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-checkpoint-"));
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace nakłada checkpoint na świeży main i bezpiecznie odrzuca konflikt", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-checkpoint-main-"));
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
    rmSync(root, { recursive: true, force: true });
  }
});
