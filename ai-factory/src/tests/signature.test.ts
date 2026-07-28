import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineAdapter } from "../engines/types";
import { artifactHeader } from "../pipeline/artifacts";
import type { Route, Stage } from "../pipeline/routing";
import { questionsArtifactMarkdown } from "../pipeline/ticket-pipeline";
import {
  buildSignature,
  parseSignatureMeta,
  POLLER_SIGNATURE,
  signatureFooter,
  signatureLine,
  signatureMeta,
  signatureTrailer,
} from "../pipeline/signature";

const engine: EngineAdapter = {
  name: "codex",
  run: async () => ({ ok: true, report: "ok" }),
};

const route = (model?: string): Route => ({
  engine,
  model,
  spec: model ? `${engine.name}/${model}` : engine.name,
});

test("buildSignature mapuje każdy etap na właściwy profil", () => {
  const profiles: Record<Stage, string> = {
    plan: "planner",
    build: "builder",
    verify: "verifier",
    review: "reviewer",
  };

  for (const [stage, profile] of Object.entries(profiles) as [Stage, string][]) {
    assert.deepEqual(buildSignature(stage, route("gpt-5.6-sol")), {
      agent: "ai-factory",
      harness: "codex",
      model: "gpt-5.6-sol",
      profile,
    });
  }
});

test("buildSignature jawnie oznacza model domyślny CLI", () => {
  assert.equal(buildSignature("build", route()).model, "(domyślny CLI)");
});

test("harness niesie wersję CLI, a 'unknown' nie brudzi podpisu", () => {
  const versioned = buildSignature("build", { ...route("gpt-5.6-sol"), cliVersion: "0.44.0" });
  assert.equal(versioned.harness, "codex@0.44.0");
  assert.equal(signatureLine(versioned), "ai-factory · codex@0.44.0 · gpt-5.6-sol · builder");

  const unknown = buildSignature("build", { ...route("gpt-5.6-sol"), cliVersion: "unknown" });
  assert.equal(unknown.harness, "codex");
});

test("formaty podpisu są stabilne i grepowalne", () => {
  const signature = buildSignature("build", route("gpt-5.6-sol"));

  assert.equal(
    signatureTrailer(signature),
    [
      "Agent: ai-factory",
      "Harness: codex",
      "Model: gpt-5.6-sol",
      "Profile: builder",
    ].join("\n"),
  );
  assert.equal(signatureLine(signature), "ai-factory · codex · gpt-5.6-sol · builder");
  assert.equal(signatureFooter(signature), "\n\n> 🖋️ ai-factory · codex · gpt-5.6-sol · builder");
  assert.deepEqual(signatureMeta(signature), {
    agent: "ai-factory",
    harness: "codex",
    model: "gpt-5.6-sol",
    profile: "builder",
  });
});

test("signatureMeta rozszerza nagłówek YAML artefaktu", () => {
  const header = artifactHeader({
    step: "build",
    ...signatureMeta(buildSignature("build", route("gpt-5.6-sol"))),
  });

  assert.match(header, /\nagent: ai-factory\n/);
  assert.match(header, /\nharness: codex\n/);
  assert.match(header, /\nmodel: gpt-5\.6-sol\n/);
  assert.match(header, /\nprofile: builder\n/);
});

test("parseSignatureMeta odtwarza podpis z nagłówka artefaktu", () => {
  const signature = buildSignature("build", route("gpt-5.6-sol"));
  const artifact = artifactHeader({
    step: "build",
    ...signatureMeta(signature),
  }) + "raport";

  assert.deepEqual(parseSignatureMeta(artifact), signature);
});

test("parseSignatureMeta odrzuca śmieci i niepełny nagłówek", () => {
  assert.equal(parseSignatureMeta("bez nagłówka"), undefined);
  assert.equal(parseSignatureMeta("---\nagent: ai-factory\nharness: codex\n---\n"), undefined);
  assert.equal(
    parseSignatureMeta("---\nagent: ai-factory\nharness: codex\nmodel: sol\nprofile: unknown\n---\n"),
    undefined,
  );
  assert.equal(
    parseSignatureMeta("---\nagent: ai-factory\nharness: codex\nmodel: sol\nprofile: toString\n---\n"),
    undefined,
  );
});

test("POLLER_SIGNATURE identyfikuje orkiestrator pollera", () => {
  assert.deepEqual(POLLER_SIGNATURE, {
    agent: "ai-factory",
    harness: "poller",
    model: "—",
    profile: "orchestrator",
  });
});

test("questionsArtifactMarkdown zachowuje podpis plannera i bezpiecznie dopuszcza jego brak", () => {
  const plannerSignature = {
    agent: "ai-factory",
    harness: "claude-code",
    model: "test-planner-model",
    profile: "planner" as const,
  };

  assert.deepEqual(
    parseSignatureMeta(questionsArtifactMarkdown(1, "1. Tryb? A) Tak B) Nie", plannerSignature)),
    plannerSignature,
  );
  assert.equal(
    parseSignatureMeta(questionsArtifactMarkdown(1, "1. Tryb? A) Tak B) Nie")),
    undefined,
  );
});

test("plan→clarify zapisuje artefakt pytań z podpisem faktycznego plannera", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-clarify-signature-"));
  const repo = join(root, "repo");
  const originalFactoryRoot = process.env.FACTORY_ROOT;
  mkdirSync(repo, { recursive: true });
  let runtime: { shutdown(): Promise<void> } | undefined;
  let restoreEngine: (() => void) | undefined;

  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "clarify-signature-test" }));
    writeFileSync(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(repo)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    writeFileSync(join(root, "routing.yaml"), [
      "defaults:",
      "  plan: signature-fake/test-planner-model",
    ].join("\n"));
    process.env.FACTORY_ROOT = root;

    const [{ engines }, { ticketPipeline }, { Mastra }, { LibSQLStore }, { applyWorkflowPersistencePatch }] = await Promise.all([
      import("../engines"),
      import("../pipeline/ticket-pipeline"),
      import("@mastra/core/mastra"),
      import("@mastra/libsql"),
      import("../mastra/workflow-persistence-patch"),
    ]);
    const previousEngine = engines["signature-fake"];
    restoreEngine = () => {
      if (previousEngine) engines["signature-fake"] = previousEngine;
      else delete engines["signature-fake"];
    };
    engines["signature-fake"] = {
      name: "claude-code",
      async run() {
        return {
          ok: true,
          report: "Potrzebuję decyzji.\n\n```factory\n" + JSON.stringify({
            verdict: "blocked",
            questions: "1. Tryb? A) Szybki (REKOMENDACJA) B) Pełny C) Ręczny",
            screenshots: [],
            files: [],
            domain: "backend",
          }) + "\n```",
        };
      },
    };

    applyWorkflowPersistencePatch();
    const mastra = new Mastra({
      workflows: { ticketPipeline },
      storage: new LibSQLStore({
        id: "clarify-signature-storage",
        url: `file:${join(root, "mastra.db")}`,
      }),
    });
    runtime = mastra;
    const workflow = mastra.getWorkflow("ticketPipeline");
    const run = await workflow.createRun({ runId: "clarify-signature-run" });
    const result = await run.start({
      inputData: {
        id: "BAR-168",
        title: "Podpis pytań",
        description: "Opis wymagający doprecyzowania",
        project: "harness",
        labels: [],
      },
    });

    assert.equal(result.status, "suspended");
    const artifact = readFileSync(
      join(root, "runs", "BAR-168", "clarify-signature-run", "questions-round-1.md"),
      "utf8",
    );
    assert.deepEqual(parseSignatureMeta(artifact), {
      agent: "ai-factory",
      harness: "claude-code",
      model: "test-planner-model",
      profile: "planner",
    });
  } finally {
    restoreEngine?.();
    await runtime?.shutdown();
    if (originalFactoryRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = originalFactoryRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
