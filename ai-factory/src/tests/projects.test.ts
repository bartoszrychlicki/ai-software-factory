import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getProject, verifyBudgetMinutes } from "../pipeline/projects";

const here = dirname(fileURLToPath(import.meta.url));
const committedProjectsYaml = join(here, "../../projects.yaml");

/**
 * Testy MUSZĄ być hermetyczne względem hosta: katalog tymczasowy bez
 * projects.local.yaml (chyba że test jawnie go poda), bo realny host może
 * trzymać własne nadpisania. base === undefined kopiuje commitowany plik.
 */
async function withProjectsRoot(
  files: { base?: string; local?: string },
  run: () => Promise<void>
) {
  const root = mkdtempSync(join(tmpdir(), "factory-projects-"));
  const previous = process.env.FACTORY_ROOT;
  try {
    if (files.base === undefined) copyFileSync(committedProjectsYaml, join(root, "projects.yaml"));
    else writeFileSync(join(root, "projects.yaml"), files.base);
    if (files.local !== undefined) writeFileSync(join(root, "projects.local.yaml"), files.local);
    process.env.FACTORY_ROOT = root;
    await run();
  } finally {
    if (previous === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

async function withProjectsYaml(yaml: string, run: () => Promise<void>) {
  await withProjectsRoot({ base: yaml }, run);
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

test("pilot-app nadpisuje budżet verify na 15 minut (commitowany projects.yaml)", async () => {
  await withProjectsRoot({}, async () => {
    const project = await getProject("pilot-app");
    assert.equal(verifyBudgetMinutes(project), 15);
  });
});

test("br-factory jest bezpiecznie zarejestrowany jako projekt self-hosted (commitowany projects.yaml)", async () => {
  await withProjectsRoot({}, async () => {
    const project = await getProject("br-factory");
    assert.equal(project.repo, "/Users/bartoszrychlicki/Dev/ai-software-factory");
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
});

test("projects.local.yaml wygrywa płytkim merge'em per projekt/klucz", async () => {
  await withProjectsRoot({
    base: [
      "demo:",
      "  repo: /base/demo",
      "  checks:",
      "    - npm test",
      "  budget:",
      "    maxUsd: 12",
      "    maxMinutes: 90",
    ].join("\n"),
    local: [
      "demo:",
      "  repo: /local/demo",
      "  planPipeline: v3",
      "  budget:",
      "    maxUsd: 15",
    ].join("\n"),
  }, async () => {
    const project = await getProject("demo");
    assert.equal(project.repo, "/local/demo"); // local wygrywa
    assert.equal(project.planPipeline, "v3"); // klucz dodany lokalnie
    assert.deepEqual(project.checks, ["npm test"]); // klucz bazowy zostaje
    // merge jest PŁYTKI: lokalny obiekt budget zastępuje bazowy w całości
    assert.deepEqual(project.budget, { maxUsd: 15 });
  });
});

test("projekt zdefiniowany wyłącznie w projects.local.yaml jest dostępny", async () => {
  await withProjectsRoot({
    base: "demo:\n  repo: /base/demo\n  checks:\n    - npm test\n",
    local: "local-only:\n  repo: /local/only\n  checks:\n    - npm run lint\n",
  }, async () => {
    const localOnly = await getProject("local-only");
    assert.equal(localOnly.repo, "/local/only");
    const demo = await getProject("demo");
    assert.equal(demo.repo, "/base/demo");
  });
});

test("pusty stub sekcji w projects.local.yaml niczego nie zmienia", async () => {
  await withProjectsRoot({
    base: "demo:\n  repo: /base/demo\n  checks:\n    - npm test\n",
    local: "demo:\n",
  }, async () => {
    const project = await getProject("demo");
    assert.equal(project.repo, "/base/demo");
  });
});

test("uszkodzony projects.local.yaml to twardy błąd, nie ciche zignorowanie", async () => {
  await withProjectsRoot({
    base: "demo:\n  repo: /base/demo\n  checks:\n    - npm test\n",
    local: "demo: [niedomknięta",
  }, async () => {
    await assert.rejects(getProject("demo"), /Uszkodzony YAML .*projects\.local\.yaml/);
  });
});

test("sekcja projektu w projects.local.yaml musi być mapą", async () => {
  await withProjectsRoot({
    base: "demo:\n  repo: /base/demo\n  checks:\n    - npm test\n",
    local: "demo: tekst zamiast mapy",
  }, async () => {
    await assert.rejects(getProject("demo"), /oczekiwana mapa YAML/);
  });
});

test("projects.local.yaml nie obchodzi fail-closed walidacji checks", async () => {
  await withProjectsRoot({
    base: "demo:\n  repo: /base/demo\n  checks:\n    - npm test\n",
    local: "demo:\n  checks:\n",
  }, async () => {
    await assert.rejects(getProject("demo"), /nie ma deterministycznych checks/);
  });
});
