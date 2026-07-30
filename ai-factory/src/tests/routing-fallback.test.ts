import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRoute, resolveRouteCandidates } from "../pipeline/routing";

async function withRoutingFixture(
  routingYaml: string[],
  run: () => Promise<void>,
  localYaml?: string[]
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "factory-routing-fallback-"));
  const previousRoot = process.env.FACTORY_ROOT;
  try {
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "routing.yaml"), routingYaml.join("\n"));
    if (localYaml) await writeFile(join(root, "routing.local.yaml"), localYaml.join("\n"));
    process.env.FACTORY_ROOT = root;
    await run();
  } finally {
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}

test("routing skalarny zachowuje jednego kandydata i wynik resolveRoute", async () => {
  await withRoutingFixture([
    "defaults:",
    "  plan: claude-code/sonnet",
  ], async () => {
    const candidates = await resolveRouteCandidates("plan", { project: "demo" });
    const route = await resolveRoute("plan", { project: "demo" });
    assert.equal(candidates.length, 1);
    assert.deepEqual(
      {
        spec: candidates[0].spec,
        model: candidates[0].model,
        effort: candidates[0].effort,
        engine: candidates[0].engine.name,
      },
      { spec: route.spec, model: route.model, effort: route.effort, engine: route.engine.name }
    );
  });
});

test("routing listowy zwraca główny i zapas w kolejności", async () => {
  await withRoutingFixture([
    "defaults:",
    "  plan:",
    "    - claude-code/sonnet",
    "    - codex/gpt-5.6-sol@high",
  ], async () => {
    const candidates = await resolveRouteCandidates("plan", { project: "demo" });
    assert.deepEqual(candidates.map((route) => route.spec), [
      "claude-code/sonnet",
      "codex/gpt-5.6-sol@high",
    ]);
    assert.equal((await resolveRoute("plan", { project: "demo" })).spec, candidates[0].spec);
  });
});

test("routing odrzuca listę dłuższą niż główny plus jeden zapas", async () => {
  await withRoutingFixture([
    "defaults:",
    "  plan:",
    "    - claude-code/sonnet",
    "    - codex",
    "    - pi/qwen",
  ], async () => {
    await assert.rejects(
      resolveRouteCandidates("plan", { project: "demo" }),
      /maksymalnie dwie specyfikacje/
    );
  });
});

test("routing odrzuca zapas identyczny z głównym", async () => {
  await withRoutingFixture([
    "defaults:",
    "  plan:",
    "    - claude-code/sonnet",
    "    - claude-code/sonnet",
  ], async () => {
    await assert.rejects(
      resolveRouteCandidates("plan", { project: "demo" }),
      /zapas identyczny z głównym/
    );
  });
});

test("nieznany silnik w zapasie jest twardym błędem", async () => {
  await withRoutingFixture([
    "defaults:",
    "  plan:",
    "    - claude-code/sonnet",
    "    - brak-takiego-silnika/model",
  ], async () => {
    await assert.rejects(
      resolveRouteCandidates("plan", { project: "demo" }),
      /Nieznany silnik "brak-takiego-silnika"/
    );
  });
});

test("wykluczony główny przełącza cały wpis na stage.diverse", async () => {
  await withRoutingFixture([
    "defaults:",
    "  review:",
    "    - claude-code/sonnet",
    "    - codex/gpt-5.6-sol",
    "  review.diverse:",
    "    - codex/gpt-5.6-terra",
    "    - pi/qwen",
  ], async () => {
    const candidates = await resolveRouteCandidates(
      "review",
      { project: "demo" },
      undefined,
      { excludeEngine: "claude-code" }
    );
    assert.deepEqual(candidates.map((route) => route.spec), [
      "codex/gpt-5.6-terra",
      "pi/qwen",
    ]);
  });
});

test("wykluczony wyłącznie zapas jest odfiltrowany bez zmiany głównego", async () => {
  await withRoutingFixture([
    "defaults:",
    "  review:",
    "    - claude-code/sonnet",
    "    - codex/gpt-5.6-sol",
  ], async () => {
    const candidates = await resolveRouteCandidates(
      "review",
      { project: "demo" },
      undefined,
      { excludeEngine: "codex" }
    );
    assert.deepEqual(candidates.map((route) => route.spec), ["claude-code/sonnet"]);
  });
});

test("routing.local.yaml zastępuje skalar i listę w całości", async () => {
  await withRoutingFixture([
    "defaults:",
    "  plan: claude-code/sonnet",
    "  review:",
    "    - claude-code/sonnet",
    "    - codex",
  ], async () => {
    assert.deepEqual(
      (await resolveRouteCandidates("plan", { project: "demo" })).map((route) => route.spec),
      ["codex/gpt-5.6-sol", "claude-code/opus"]
    );
    assert.deepEqual(
      (await resolveRouteCandidates("review", { project: "demo" })).map((route) => route.spec),
      ["pi/qwen"]
    );
  }, [
    "defaults:",
    "  plan:",
    "    - codex/gpt-5.6-sol",
    "    - claude-code/opus",
    "  review: pi/qwen",
  ]);
});
