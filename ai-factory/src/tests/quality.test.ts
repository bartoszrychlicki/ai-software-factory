import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullBranchDiff, QualityGateError, runQualityCommands } from "../pipeline/quality";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

test("review otrzymuje pełny diff brancha, nie tylko ostatni commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-diff-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");
  try {
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["clone", bare, repo]);
    git(repo, "config", "user.email", "factory@example.test");
    git(repo, "config", "user.name", "Factory Test");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "base");
    git(repo, "branch", "-M", "main"); git(repo, "push", "-u", "origin", "main");
    git(repo, "checkout", "-b", "agent/test");
    writeFileSync(join(repo, "first.txt"), "first\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "first");
    writeFileSync(join(repo, "second.txt"), "second\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "second");

    const diff = await fullBranchDiff(repo, "main");
    assert.match(diff, /first\.txt/);
    assert.match(diff, /second\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wspólny runner jakości zwraca komendę i ogon błędu", async () => {
  await assert.rejects(
    runQualityCommands(process.cwd(), ["echo quality-failed >&2; exit 7"]),
    (error: unknown) => error instanceof QualityGateError &&
      error.command.includes("quality-failed") && error.outputTail.includes("quality-failed")
  );
});
