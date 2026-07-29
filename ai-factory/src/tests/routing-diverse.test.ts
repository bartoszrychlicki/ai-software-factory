import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRoute } from "../pipeline/routing";

async function withRoutingFixture(
  routingYaml: string[],
  run: () => Promise<void>,
  localYaml?: string[]
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "factory-routing-"));
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

test("review z wykluczonym silnikiem buildera przechodzi na review.diverse", async () => {
  await withRoutingFixture([
    "defaults:",
    "  review: claude-code/sonnet",
    "  review.diverse: codex",
  ], async () => {
    const normal = await resolveRoute("review", { project: "demo" });
    assert.equal(normal.engine.name, "claude-code");

    const diverse = await resolveRoute("review", { project: "demo" }, undefined, {
      excludeEngine: "claude-code",
    });
    assert.equal(diverse.engine.name, "codex");

    // Wykluczenie innego silnika niż rozstrzygnięty nie zmienia trasy.
    const untouched = await resolveRoute("review", { project: "demo" }, undefined, {
      excludeEngine: "codex",
    });
    assert.equal(untouched.engine.name, "claude-code");
  });
});

test("brak review.diverse przy kolizji reviewer==builder jest fail-closed", async () => {
  await withRoutingFixture([
    "defaults:",
    "  review: claude-code/sonnet",
  ], async () => {
    await assert.rejects(
      resolveRoute("review", { project: "demo" }, undefined, { excludeEngine: "claude-code" }),
      /review\.diverse/
    );
  });
});

test("review.diverse wskazujący wykluczony silnik jest błędem konfiguracji", async () => {
  await withRoutingFixture([
    "defaults:",
    "  review: claude-code/sonnet",
    "  review.diverse: claude-code/opus",
  ], async () => {
    await assert.rejects(
      resolveRoute("review", { project: "demo" }, undefined, { excludeEngine: "claude-code" }),
      /wyklucz/
    );
  });
});

test("routing.local.yaml nadpisuje pojedyncze klucze projektu, reszta zostaje z bazy", async () => {
  await withRoutingFixture([
    "defaults:",
    "  plan: claude-code/sonnet",
    "projects:",
    "  demo:",
    "    plan: claude-code/claude-fable-5@high",
    "    build: codex",
  ], async () => {
    const plan = await resolveRoute("plan", { project: "demo" });
    assert.equal(plan.spec, "claude-code/claude-fable-5@medium"); // local wygrywa
    assert.equal(plan.model, "claude-fable-5");
    assert.equal(plan.effort, "medium");
    const build = await resolveRoute("build", { project: "demo" });
    assert.equal(build.engine.name, "codex"); // klucz bazowy przetrwał merge
  }, [
    "projects:",
    "  demo:",
    "    plan: claude-code/claude-fable-5@medium",
  ]);
});

test("routing.local.yaml dokłada nową sekcję projektu i nadpisuje defaults", async () => {
  await withRoutingFixture([
    "defaults:",
    "  plan: claude-code/sonnet",
    "  review: claude-code/sonnet",
  ], async () => {
    const plan = await resolveRoute("plan", { project: "gdziekolwiek" });
    assert.equal(plan.engine.name, "codex"); // defaults nadpisane lokalnie
    const review = await resolveRoute("review", { project: "gdziekolwiek" });
    assert.equal(review.engine.name, "claude-code"); // pozostałe defaults z bazy
    const verify = await resolveRoute("verify", { project: "extra" });
    assert.equal(verify.spec, "claude-code/opus"); // projekt istniejący tylko w .local
  }, [
    "defaults:",
    "  plan: codex",
    "projects:",
    "  extra:",
    "    verify: claude-code/opus",
  ]);
});

test("uszkodzony routing.local.yaml jest twardym błędem, nie cichym zignorowaniem", async () => {
  await withRoutingFixture([
    "defaults:",
    "  plan: claude-code/sonnet",
  ], async () => {
    await assert.rejects(
      resolveRoute("plan", { project: "demo" }),
      /Uszkodzony YAML .*routing\.local\.yaml/
    );
  }, [
    "projects: [niedomknięta",
  ]);
});

test("nieznana sekcja w routing.local.yaml jest błędem konfiguracji (literówka nie znika po cichu)", async () => {
  await withRoutingFixture([
    "defaults:",
    "  plan: claude-code/sonnet",
  ], async () => {
    await assert.rejects(
      resolveRoute("plan", { project: "demo" }),
      /nieznane sekcje "defaultz"/
    );
  }, [
    "defaultz:",
    "  plan: codex",
  ]);
});
