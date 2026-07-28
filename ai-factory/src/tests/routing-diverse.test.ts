import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRoute } from "../pipeline/routing";

async function withRoutingFixture(
  routingYaml: string[],
  run: () => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "factory-routing-"));
  const previousRoot = process.env.FACTORY_ROOT;
  try {
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "routing.yaml"), routingYaml.join("\n"));
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
