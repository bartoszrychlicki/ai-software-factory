import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFilesInWorkspace, undeclaredChangedFiles } from "../pipeline/scope";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

test("scope gate wskazuje każdą zmianę spoza planu", () => {
  assert.deepEqual(
    undeclaredChangedFiles(["src/ok.ts", "./docs/plan.md"], ["src/ok.ts", "docs/plan.md", "src/leak.ts"]),
    ["src/leak.ts"]
  );
});

test("odczyt zmian obsługuje spacje, pliki nieśledzone i rename", async () => {
  const repo = mkdtempSync(join(tmpdir(), "factory-scope-"));
  try {
    git(repo, "init");
    git(repo, "config", "user.email", "factory@example.test");
    git(repo, "config", "user.name", "Factory Test");
    writeFileSync(join(repo, "old name.txt"), "old\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    git(repo, "mv", "old name.txt", "new name.txt");
    writeFileSync(join(repo, "untracked file.txt"), "new\n");

    const changed = await changedFilesInWorkspace(repo);
    assert.deepEqual(new Set(changed), new Set(["new name.txt", "old name.txt", "untracked file.txt"]));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
