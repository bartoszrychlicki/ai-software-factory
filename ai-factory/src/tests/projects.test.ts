import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProject, verifyBudgetMinutes } from "../pipeline/projects";

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

test("verify ma domyślny budżet 5 minut bez override projektu", async () => {
  await withProjectsYaml("demo:\n  repo: /tmp/demo\n  checks:\n    - npm test\n", async () => {
    const project = await getProject("demo");
    assert.equal(verifyBudgetMinutes(project), 5);
  });
});

test("pilot-app nadpisuje budżet verify na 15 minut", async () => {
  const project = await getProject("pilot-app");
  assert.equal(verifyBudgetMinutes(project), 15);
});

test("br-factory jest bezpiecznie zarejestrowany jako projekt self-hosted", async () => {
  const project = await getProject("br-factory");
  assert.equal(project.repo, "/Users/senioraiconsultant/Development/Edu/ai-sdlc");
  assert.equal(project.github, "bartoszrychlicki/ai-software-factory");
  assert.equal(project.default_branch, "main");
  assert.equal(project.statuses, "extended");
  assert.equal(project.max_concurrent_tickets, 1);
  assert.deepEqual(project.ci?.requiredChecks, ["quality"]);
  assert.deepEqual(project.checks, [
    "npm --prefix ai-factory ci",
    "npm --prefix ai-factory run check",
    "npm --prefix ai-factory test",
    "npm --prefix ai-factory run build",
  ]);
});
