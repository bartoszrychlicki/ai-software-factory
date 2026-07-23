import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pi } from "../engines/pi";
import type { EngineAdapter } from "../engines/types";
import type { ProjectConfig } from "../pipeline/projects";
import { fullBranchDiff } from "../pipeline/quality";
import {
  buildFinalVerifyContextBlock,
  buildVerifyContextSection,
} from "../pipeline/verify-context";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const workspaceEngine: EngineAdapter = {
  name: "workspace-fixture",
  verifyContextMode: "workspace",
  async run() {
    return { ok: true, report: "unused" };
  },
};

const classicEngine: EngineAdapter = {
  name: "claude-fixture",
  async run() {
    return { ok: true, report: "unused" };
  },
};

interface GitFixture {
  root: string;
  repo: string;
  baseSha: string;
  featureSha: string;
}

function createGitFixture(
  prefix: string,
  prepareBase: (repo: string) => void,
  prepareFeature: (repo: string) => void
): GitFixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");
  execFileSync("git", ["init", "--bare", "--quiet", bare]);
  execFileSync("git", ["clone", "--quiet", bare, repo]);
  git(repo, "config", "user.email", "factory@example.test");
  git(repo, "config", "user.name", "Factory Test");
  prepareBase(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "base");
  git(repo, "branch", "-M", "main");
  git(repo, "push", "--quiet", "-u", "origin", "main");
  const baseSha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "--quiet", "-b", "agent/test");
  prepareFeature(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "feature");
  return { root, repo, baseSha, featureSha: git(repo, "rev-parse", "HEAD") };
}

const project = (repo: string): ProjectConfig => ({
  repo,
  default_branch: "main",
  checks: ["npm test"],
});

test("workspace verify dostaje SHA, manifest, diffstat i checks bez treści diffu", async () => {
  const fixture = createGitFixture(
    "factory-workspace-context-",
    (repo) => {
      writeFileSync(join(repo, "critical.ts"), "export const value = 'before';\n");
      writeFileSync(join(repo, "deleted.ts"), "export const removed = true;\n");
    },
    (repo) => {
      writeFileSync(join(repo, "critical.ts"), "export const value = 'after';\n");
      writeFileSync(join(repo, "added.ts"), "export const added = true;\n");
      unlinkSync(join(repo, "deleted.ts"));
    }
  );

  try {
    assert.equal(pi.verifyContextMode, "workspace");
    const section = await buildVerifyContextSection(pi, {
      co: { dir: fixture.repo },
      project: project(fixture.repo),
      sha: fixture.featureSha,
    });
    const context = [
      section.block,
      "",
      "# Checks projektu wykonane przez fabrykę na świeżym checkoutcie:",
      "- `npm test` → OK",
    ].join("\n");

    assert.match(section.block, new RegExp(fixture.featureSha));
    assert.match(section.block, new RegExp(fixture.baseSha));
    assert.match(section.block, /^M\tcritical\.ts$/m);
    assert.match(section.block, /^A\tadded\.ts$/m);
    assert.match(section.block, /^D\tdeleted\.ts$/m);
    assert.match(section.block, /3 files changed/);
    assert.match(context, /`npm test` → OK/);
    assert.doesNotMatch(section.block, /export const value = 'after'/);
    for (const tool of ["read", "grep", "find", "ls"]) {
      assert.match(section.extraInstruction ?? "", new RegExp(`\\b${tool}\\b`));
    }
    assert.match(section.extraInstruction ?? "", /krytyczne zmienione pliki/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("adapter bez capability zachowuje klasyczny pełny inline diff", async () => {
  const fixture = createGitFixture(
    "factory-full-diff-context-",
    (repo) => writeFileSync(join(repo, "feature.ts"), "export const value = 'before';\n"),
    (repo) => writeFileSync(join(repo, "feature.ts"), "export const value = 'after';\n")
  );

  try {
    const diff = await fullBranchDiff(fixture.repo, "main");
    const section = await buildVerifyContextSection(classicEngine, {
      co: { dir: fixture.repo },
      project: project(fixture.repo),
      sha: fixture.featureSha,
    });

    assert.equal(
      section.block,
      `# Pełny diff brancha względem aktualnej bazy\n${diff.slice(0, 60_000)}`
    );
    assert.equal(
      buildFinalVerifyContextBlock(fixture.featureSha, section),
      [
        `# Finalny SHA: ${fixture.featureSha}`,
        "# Pełny diff brancha względem aktualnej bazy",
        diff.slice(0, 60_000),
      ].join("\n")
    );
    assert.equal(section.extraInstruction, undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("workspace context redukuje duży prompt o co najmniej 50% i zachowuje 63 zmiany", async () => {
  const fixture = createGitFixture(
    "factory-large-context-",
    (repo) => {
      mkdirSync(join(repo, "src"));
      for (let file = 0; file < 55; file += 1) {
        const lines = Array.from(
          { length: 180 },
          (_, line) => `export const base_${file}_${line} = "base-${file}-${line}";`
        );
        writeFileSync(join(repo, "src", `file-${file}.ts`), `${lines.join("\n")}\n`);
      }
    },
    (repo) => {
      for (let file = 0; file < 50; file += 1) {
        const lines = Array.from(
          { length: 180 },
          (_, line) => `export const feature_${file}_${line} = "feature-${file}-${line}";`
        );
        writeFileSync(join(repo, "src", `file-${file}.ts`), `${lines.join("\n")}\n`);
      }
      for (let file = 50; file < 55; file += 1) {
        unlinkSync(join(repo, "src", `file-${file}.ts`));
      }
      for (let file = 55; file < 63; file += 1) {
        const lines = Array.from(
          { length: 180 },
          (_, line) => `export const added_${file}_${line} = "added-${file}-${line}";`
        );
        writeFileSync(join(repo, "src", `file-${file}.ts`), `${lines.join("\n")}\n`);
      }
    }
  );

  try {
    const rawDiff = await fullBranchDiff(fixture.repo, "main");
    assert.ok(rawDiff.length > 60_000, `fixture diff ma tylko ${rawDiff.length} znaków`);

    const [workspaceSection, fullDiffSection] = await Promise.all([
      buildVerifyContextSection(workspaceEngine, {
        co: { dir: fixture.repo },
        project: project(fixture.repo),
        sha: fixture.featureSha,
      }),
      buildVerifyContextSection(classicEngine, {
        co: { dir: fixture.repo },
        project: project(fixture.repo),
        sha: fixture.featureSha,
      }),
    ]);

    assert.ok(
      workspaceSection.block.length <= fullDiffSection.block.length * 0.5,
      `workspace=${workspaceSection.block.length}, full-diff=${fullDiffSection.block.length}`
    );
    const statusLines = workspaceSection.block
      .split("\n")
      .filter((line) => /^(?:A|M|D|R\d+)\t/.test(line));
    assert.equal(statusLines.length, 63);
    assert.ok(statusLines.some((line) => line.startsWith("D\t")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
