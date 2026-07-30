import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditScope,
  authorizeScopePaths,
  changedFilesInWorkspace,
  isProtectedPath,
  undeclaredChangedFiles,
} from "../pipeline/scope";

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

test("autoryzacja /scope normalizuje bezpieczne ścieżki i nie duplikuje planFiles", () => {
  assert.deepEqual(
    authorizeScopePaths(
      ["./e2e/scripts/run-e2e.ts", "e2e/scripts/run-e2e.ts", "src/already.ts"],
      ["src/already.ts"]
    ),
    {
      accepted: ["e2e/scripts/run-e2e.ts"],
      alreadyDeclared: ["e2e/scripts/run-e2e.ts", "src/already.ts"],
      rejected: [],
    }
  );
  assert.deepEqual(authorizeScopePaths([".env.example"], []), {
    accepted: [".env.example"],
    alreadyDeclared: [],
    rejected: [],
  });
});

test("autoryzacja /scope odrzuca absolutne ścieżki, traversal i wildcardy", () => {
  const result = authorizeScopePaths(
    ["", "./", "/etc/passwd", "\\server\\share", "C:\\secret.txt", "../outside", "src/../ops/x", "src/*.ts"],
    []
  );

  assert.deepEqual(result.accepted, []);
  assert.equal(result.rejected.length, 8);
  assert.match(result.rejected[0].reason, /pusta/);
  assert.match(result.rejected[1].reason, /pusta/);
  for (const index of [2, 3, 4]) {
    assert.match(result.rejected[index].reason, /względna/);
  }
  for (const index of [5, 6]) {
    assert.match(result.rejected[index].reason, /segment `\.\.`/);
  }
  assert.match(result.rejected[7].reason, /wildcardy/);
});

test("autoryzacja /scope zawsze odrzuca sekrety, ale dopuszcza przykłady env", () => {
  const result = authorizeScopePaths(
    [".env", "config/.env.production", "deploy.pem", "private.key", "credentials.json"],
    []
  );

  assert.deepEqual(result.accepted, []);
  assert.equal(result.rejected.length, 5);
  assert.ok(result.rejected.every(({ reason }) =>
    reason.includes("nieodwracalna szkoda") && reason.includes("człowiek")
  ));
  assert.deepEqual(authorizeScopePaths(["config/.env.sample"], []).accepted, [
    "config/.env.sample",
  ]);
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
