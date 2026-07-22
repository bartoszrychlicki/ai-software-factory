import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProject } from "../pipeline/projects";

async function withProjectsYaml(yaml: string, run: () => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "factory-projects-"));
  const previous = process.env.FACTORY_ROOT;
  try {
    writeFileSync(join(root, "projects.yaml"), yaml);
    process.env.FACTORY_ROOT = root;
    await run();
  } finally {
    if (previous === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("projekt bez deterministycznych checks jest odrzucany fail-closed", async () => {
  await withProjectsYaml("demo:\n  repo: /tmp/demo\n", async () => {
    await assert.rejects(getProject("demo"), /nie ma deterministycznych checks/);
  });
});

test("projekt GitHub bez required checks jest odrzucany fail-closed", async () => {
  await withProjectsYaml("demo:\n  repo: /tmp/demo\n  github: owner/demo\n  checks:\n    - npm test\n", async () => {
    await assert.rejects(getProject("demo"), /nie ma ci\.requiredChecks/);
  });
});

test("poprawna konfiguracja normalizuje checks i wymagane GitHub checks", async () => {
  await withProjectsYaml([
    "demo:",
    "  repo: /tmp/demo",
    "  github: owner/demo",
    "  checks:",
    "    - ' npm test '",
    "  ci:",
    "    requiredChecks:",
    "      - ' quality '",
  ].join("\n"), async () => {
    const project = await getProject("demo");
    assert.deepEqual(project.checks, ["npm test"]);
    assert.deepEqual(project.ci?.requiredChecks, ["quality"]);
  });
});
