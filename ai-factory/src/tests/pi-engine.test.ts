import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pi } from "../engines/pi";
import { resolveRoute } from "../pipeline/routing";
import type { EngineRunInput, Role } from "../engines/types";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

test("pi przekazuje dokładny argv i pełny prompt wyłącznie przez stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-pi-"));
  const fakePi = join(root, "pi");
  const argvLog = join(root, "argv.log");
  const stdinLog = join(root, "stdin.log");
  const originalPath = process.env.PATH;

  try {
    writeFileSync(fakePi, [
      "#!/bin/sh",
      `printf '%s\\n' \"$@\" > ${shellQuote(argvLog)}`,
      `cat > ${shellQuote(stdinLog)}`,
      "printf 'PI_OK\\n'",
    ].join("\n"));
    chmodSync(fakePi, 0o755);
    process.env.PATH = `${root}:${originalPath ?? ""}`;

    const result = await pi.run({
      role: "verify",
      instructions: "Zweryfikuj zmianę.",
      context: "diff --git a/file.ts b/file.ts\n+const value = 1;",
      workspace: process.cwd(),
      budget: { minutes: 1 },
      model: "qwen/qwen3.6-27b",
    });

    assert.equal(result.ok, true);
    assert.equal(result.report, "PI_OK");
    assert.deepEqual(readFileSync(argvLog, "utf8").trimEnd().split("\n"), [
      "-p",
      "--provider",
      "lm-studio",
      "--model",
      "qwen/qwen3.6-27b",
      "--no-session",
      "--tools",
      "read,grep,find,ls",
      "--exclude-tools",
      "ask_question",
    ]);
    assert.equal(
      readFileSync(stdinLog, "utf8"),
      "Zweryfikuj zmianę.\n\ndiff --git a/file.ts b/file.ts\n+const value = 1;"
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("pi odmawia ról innych niż verify bez uruchamiania procesu", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-pi-roles-"));
  const fakePi = join(root, "pi");
  const spawnLog = join(root, "spawn.log");
  const originalPath = process.env.PATH;

  try {
    writeFileSync(fakePi, [
      "#!/bin/sh",
      `touch ${shellQuote(spawnLog)}`,
    ].join("\n"));
    chmodSync(fakePi, 0o755);
    process.env.PATH = `${root}:${originalPath ?? ""}`;

    for (const role of ["plan", "build", "review"] satisfies Role[]) {
      const input: EngineRunInput = {
        role,
        instructions: "Nie uruchamiaj procesu.",
        context: "",
        workspace: process.cwd(),
        budget: { minutes: 1 },
        model: "qwen/qwen3.6-27b",
      };
      const result = await pi.run(input);
      assert.equal(result.ok, false);
      assert.equal(result.report, "pi engine: rola nieobsługiwana (tylko verify)");
    }

    assert.equal(existsSync(spawnLog), false);
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("pi wymaga jawnego modelu bez uruchamiania procesu", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-pi-model-"));
  const fakePi = join(root, "pi");
  const spawnLog = join(root, "spawn.log");
  const originalPath = process.env.PATH;

  try {
    writeFileSync(fakePi, [
      "#!/bin/sh",
      `touch ${shellQuote(spawnLog)}`,
    ].join("\n"));
    chmodSync(fakePi, 0o755);
    process.env.PATH = `${root}:${originalPath ?? ""}`;

    const result = await pi.run({
      role: "verify",
      instructions: "Nie uruchamiaj procesu.",
      context: "",
      workspace: process.cwd(),
      budget: { minutes: 1 },
    });

    assert.equal(result.ok, false);
    assert.equal(result.report, "pi engine: wymagany jawny model");
    assert.equal(existsSync(spawnLog), false);
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("routing pilot-app verify wskazuje pi i jawny lokalny model", async () => {
  const route = await resolveRoute("verify", { project: "pilot-app" });

  assert.equal(route.engine.name, "pi");
  assert.equal(route.model, "qwen/qwen3.6-27b");
  assert.equal(route.spec, "pi/qwen/qwen3.6-27b");
});
