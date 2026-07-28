import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditScope, changedFilesInWorkspace, isProtectedPath, undeclaredChangedFiles } from "../pipeline/scope";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

test("scope gate wskazuje każdą zmianę spoza planu", () => {
  assert.deepEqual(
    undeclaredChangedFiles(["src/ok.ts", "./docs/plan.md"], ["src/ok.ts", "docs/plan.md", "src/leak.ts"]),
    ["src/leak.ts"]
  );
});

test("pliki wykonywane przez etap test są chronione: niezadeklarowana zmiana blokuje", () => {
  for (const path of [
    "package.json",
    "web/package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    ".npmrc",
    "tsconfig.json",
    "tsconfig.build.json",
    "vitest.config.ts",
    "playwright.config.mjs",
    "scripts/deploy.sh",
    "tools/scripts/gen.js",
  ]) {
    assert.equal(isProtectedPath(path), true, `${path} powinien być chroniony`);
    assert.equal(auditScope([], [path]).blocked.length, 1, `${path} powinien blokować`);
    assert.equal(auditScope([path], [path]).blocked.length, 0, `${path} zadeklarowany przechodzi`);
  }
  for (const path of ["src/config.ts", "src/scripts.ts", "docs/package.md", "README.md"]) {
    assert.equal(isProtectedPath(path), false, `${path} nie powinien być chroniony`);
  }
});

test("per-projektowe scope.protected: prefiks katalogu i basename blokują", () => {
  assert.equal(auditScope([], ["infra/main.tf"], ["infra/"]).blocked.length, 1);
  assert.equal(auditScope([], ["infra/main.tf"], ["infra"]).blocked.length, 1);
  assert.equal(auditScope([], ["app/Dockerfile"], ["Dockerfile"]).blocked.length, 1);
  assert.equal(auditScope([], ["docs/readme.md"], ["infra/"]).blocked.length, 0);
  assert.equal(auditScope(["infra/main.tf"], ["infra/main.tf"], ["infra/"]).blocked.length, 0);
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
