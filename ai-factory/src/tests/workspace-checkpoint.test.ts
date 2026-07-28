import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointWithinScope } from "../pipeline/workspace";

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
