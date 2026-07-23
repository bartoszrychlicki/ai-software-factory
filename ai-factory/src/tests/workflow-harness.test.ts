import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

async function runDomainOverrideHarness(input: {
  ticketId: string;
  declaredDomain: "frontend" | "ops";
  files: string[];
  labels: string[];
  approvePlan?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "factory-workflow-domain-override-"));
  const fakeBin = join(root, "bin");
  const ghCalls = join(root, "gh-calls.log");
  const previousFactoryRoot = process.env.FACTORY_ROOT;
  const previousWorktrees = process.env.FACTORY_WORKTREES;
  const previousPath = process.env.PATH;
  mkdirSync(fakeBin, { recursive: true });

  try {
    const gh = join(fakeBin, "gh");
    writeFileSync(gh, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(ghCalls)}`,
      "exit 99",
    ].join("\n"));
    chmodSync(gh, 0o755);

    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "factory-domain-override-harness" }));
    writeFileSync(join(root, "projects.yaml"), [
      "domain-override-harness:",
      `  repo: ${JSON.stringify(root)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    writeFileSync(join(root, "routing.yaml"), [
      "defaults:",
      "  plan: fake",
      "  build: fake",
      "  verify: fake",
      "  review: fake",
    ].join("\n"));

    process.env.FACTORY_ROOT = root;
    process.env.FACTORY_WORKTREES = join(root, "worktrees");
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;

    const [{ engines }, { ticketPipeline }, { Mastra }, { LibSQLStore }, { applyWorkflowPersistencePatch }] = await Promise.all([
      import("../engines"),
      import("../pipeline/ticket-pipeline"),
      import("@mastra/core/mastra"),
      import("@mastra/libsql"),
      import("../mastra/workflow-persistence-patch"),
    ]);
    const calls = { plan: 0, build: 0, verify: 0, review: 0 };
    engines.fake = {
      name: "fake",
      async run(engineInput) {
        calls[engineInput.role] += 1;
        if (engineInput.role !== "plan") {
          throw new Error(`Nieoczekiwana rola ${engineInput.role} dla testu domain override`);
        }
        return {
          ok: true,
          report: "Plan testu domain override.\n\n```factory\n" + JSON.stringify({
            verdict: "ok",
            screenshots: [],
            files: input.files,
            domain: input.declaredDomain,
          }) + "\n```",
        };
      },
    };

    applyWorkflowPersistencePatch();
    const runtime = new Mastra({
      workflows: { ticketPipeline },
      storage: new LibSQLStore({ id: `${input.ticketId}-storage`, url: `file:${join(root, "harness.db")}` }),
    });
    const run = await runtime.getWorkflow("ticketPipeline").createRun({ runId: `${input.ticketId}-run` });
    const planGate = await run.start({
      inputData: {
        id: input.ticketId,
        title: "Domain override",
        description: "Sprawdź efektywną domenę planu.",
        project: "domain-override-harness",
        labels: input.labels,
      },
    });
    const checklistGate = input.approvePlan && planGate.status === "suspended"
      ? await run.resume({ step: "approve-plan", resumeData: { approved: true } })
      : undefined;

    return {
      planGate,
      checklistGate,
      calls,
      ghCalled: existsSync(ghCalls),
    };
  } finally {
    if (previousFactoryRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousFactoryRoot;
    if (previousWorktrees === undefined) delete process.env.FACTORY_WORKTREES;
    else process.env.FACTORY_WORKTREES = previousWorktrees;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
}

test("deterministyczny harness prowadzi ticket przez plan, human gate, build, verify, publish i review", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-workflow-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");
  const fakeBin = join(root, "bin");
  const worktrees = join(root, "worktrees");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(worktrees, { recursive: true });

  try {
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["clone", bare, repo]);
    git(repo, "config", "user.email", "factory@example.test");
    git(repo, "config", "user.name", "Factory Test");
    writeFileSync(join(repo, "README.md"), "# Harness\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "base");
    git(repo, "branch", "-M", "main"); git(repo, "push", "-u", "origin", "main");

    const gh = join(fakeBin, "gh");
    writeFileSync(gh, [
      "#!/bin/sh",
      "if [ \"$1 $2\" = \"pr create\" ]; then",
      "  echo https://github.test/factory/pilot/pull/1",
      "elif [ \"$1 $2\" = \"pr view\" ] && echo \"$*\" | grep -q 'headRefOid,statusCheckRollup'; then",
      "  sha=$(git rev-parse HEAD)",
      "  printf '{\"headRefOid\":\"%s\",\"statusCheckRollup\":[{\"name\":\"quality\",\"status\":\"COMPLETED\",\"conclusion\":\"SUCCESS\",\"workflowName\":\"CI\"}]}\\n' \"$sha\"",
      "elif [ \"$1 $2\" = \"pr view\" ]; then",
      "  echo https://github.test/factory/pilot/pull/1",
      "fi",
      "exit 0",
    ].join("\n"));
    chmodSync(gh, 0o755);

    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "factory-harness" }));
    writeFileSync(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(repo)}`,
      "  github: factory/pilot",
      "  default_branch: main",
      "  checks:",
      "    - test -f feature.txt",
      "  ci:",
      "    requiredChecks:",
      "      - quality",
    ].join("\n"));
    writeFileSync(join(root, "routing.yaml"), [
      "defaults:",
      "  plan: fake",
      "  build: fake",
      "  verify: fake",
      "  review: fake",
    ].join("\n"));

    process.env.FACTORY_ROOT = root;
    process.env.FACTORY_WORKTREES = worktrees;
    process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;

    const [{ engines }, { ticketPipeline }, { Mastra }, { LibSQLStore }, { applyWorkflowPersistencePatch }] = await Promise.all([
      import("../engines"),
      import("../pipeline/ticket-pipeline"),
      import("@mastra/core/mastra"),
      import("@mastra/libsql"),
      import("../mastra/workflow-persistence-patch"),
    ]);
    let reviewCalls = 0;
    let verifyCalls = 0;
    engines.fake = {
      name: "fake",
      async run(input) {
        if (input.role === "plan") {
          return {
            ok: true,
            report: "Plan harnessu\n\n```factory\n" + JSON.stringify({
              verdict: "ok", screenshots: [], files: ["feature.txt"], domain: "fullstack",
            }) + "\n```",
          };
        }
        if (input.role === "build") {
          const feature = join(input.workspace, "feature.txt");
          const content = input.context.includes("Uwagi z code review")
            ? "implemented by deterministic harness\nreview fix verified\n"
            : "implemented by deterministic harness\n";
          writeFileSync(feature, content);
          return { ok: true, report: "Zapisano feature.txt" };
        }
        if (input.role === "verify") {
          verifyCalls += 1;
          return { ok: true, report: "Kryteria spełnione\n\n```factory\n{\"verdict\":\"pass\"}\n```" };
        }
        reviewCalls += 1;
        return reviewCalls === 1
          ? { ok: true, report: "- Brakuje jawnego potwierdzenia finalnego SHA po poprawce\n\n```factory\n{\"verdict\":\"fix\"}\n```" }
          : { ok: true, report: "Kod czytelny\n\n```factory\n{\"verdict\":\"lgtm\"}\n```" };
      },
    };

    applyWorkflowPersistencePatch();
    const runtime = new Mastra({
      workflows: { ticketPipeline },
      storage: new LibSQLStore({ id: "harness-storage", url: `file:${join(root, "harness.db")}` }),
    });
    const workflow = runtime.getWorkflow("ticketPipeline");
    const run = await workflow.createRun({ runId: "harness-run" });
    const suspended = await run.start({
      inputData: {
        id: "HARNESS-1",
        title: "Deterministic workflow",
        description: "Dodaj feature.txt z tekstem harnessu.",
        project: "harness",
        labels: [],
      },
    });
    assert.equal(suspended.status, "suspended");

    const completed = await run.resume({
      step: "approve-plan",
      resumeData: { approved: true },
    });
    assert.equal(completed.status, "success");
    assert.equal(completed.result?.kind, "code");
    assert.equal(completed.result?.reviewVerdict, "lgtm");
    assert.equal(completed.result?.verifiedSha, completed.result?.sha);
    assert.equal(verifyCalls, 2, "review-fix wymaga drugiego acceptance verify dla nowego SHA");
    assert.equal(reviewCalls, 2);
    assert.equal(completed.result?.prUrl, "https://github.test/factory/pilot/pull/1");
    assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# Harness\n");
    assert.match(
      readFileSync(join(root, "runs", "HARNESS-1", "harness-run", "result.json"), "utf8"),
      /github\.test\/factory\/pilot\/pull\/1/
    );
  } finally {
    delete process.env.FACTORY_ROOT;
    delete process.env.FACTORY_WORKTREES;
    rmSync(root, { recursive: true, force: true });
  }
});

test("domain=ops omija build, verify, publish, CI i review oraz kończy jawnym wynikiem ops", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-workflow-ops-"));
  const fakeBin = join(root, "bin");
  const ghCalls = join(root, "gh-calls.log");
  const previousPath = process.env.PATH;
  mkdirSync(fakeBin, { recursive: true });

  try {
    const gh = join(fakeBin, "gh");
    writeFileSync(gh, [
      "#!/bin/sh",
      `printf '%s\\n' \"$*\" >> ${JSON.stringify(ghCalls)}`,
      "exit 99",
    ].join("\n"));
    chmodSync(gh, 0o755);

    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "factory-ops-harness" }));
    writeFileSync(join(root, "projects.yaml"), [
      "ops-harness:",
      `  repo: ${JSON.stringify(root)}`,
      "  checks:",
      "    - \"true\"",
    ].join("\n"));
    writeFileSync(join(root, "routing.yaml"), [
      "defaults:",
      "  plan: fake",
      "  build: fake",
      "  verify: fake",
      "  review: fake",
    ].join("\n"));

    process.env.FACTORY_ROOT = root;
    process.env.FACTORY_WORKTREES = join(root, "worktrees");
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;

    const [{ engines }, { ticketPipeline }, { Mastra }, { LibSQLStore }, { applyWorkflowPersistencePatch }] = await Promise.all([
      import("../engines"),
      import("../pipeline/ticket-pipeline"),
      import("@mastra/core/mastra"),
      import("@mastra/libsql"),
      import("../mastra/workflow-persistence-patch"),
    ]);
    const calls = { plan: 0, build: 0, verify: 0, review: 0 };
    engines.fake = {
      name: "fake",
      async run(input) {
        calls[input.role] += 1;
        if (input.role !== "plan") throw new Error(`Nieoczekiwana rola ${input.role} dla ops`);
        return {
          ok: true,
          report: "Checklista: ustaw rekord DNS w panelu i sprawdź oczekiwany stan.\n\n```factory\n" + JSON.stringify({
            verdict: "ok", screenshots: [], files: [], domain: "ops",
          }) + "\n```",
        };
      },
    };

    applyWorkflowPersistencePatch();
    const runtime = new Mastra({
      workflows: { ticketPipeline },
      storage: new LibSQLStore({ id: "ops-harness-storage", url: `file:${join(root, "harness.db")}` }),
    });
    const run = await runtime.getWorkflow("ticketPipeline").createRun({ runId: "ops-harness-run" });
    const planGate = await run.start({
      inputData: {
        id: "OPS-1",
        title: "Ręczny cutover DNS",
        description: "Przygotuj bezpieczną checklistę cutoveru.",
        project: "ops-harness",
        labels: [],
      },
    });
    assert.equal(planGate.status, "suspended");

    const checklistGate = await run.resume({
      step: "approve-plan",
      resumeData: { approved: true },
    });
    assert.equal(checklistGate.status, "suspended");

    const completed = await run.resume({
      step: ["ops-path", "await-checklist"],
      resumeData: { checklistDone: true },
    });
    assert.equal(completed.status, "success");
    assert.equal(completed.result?.kind, "ops");
    assert.equal(completed.result?.ticketId, "OPS-1");
    assert.deepEqual(calls, { plan: 1, build: 0, verify: 0, review: 0 });
    assert.equal(existsSync(ghCalls), false, "ścieżka ops nie może wywołać gh/utworzyć PR");
  } finally {
    delete process.env.FACTORY_ROOT;
    delete process.env.FACTORY_WORKTREES;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("label domain:frontend wymaga plików mimo deklaracji domain=ops", async () => {
  const result = await runDomainOverrideHarness({
    ticketId: "OVERRIDE-FRONTEND",
    declaredDomain: "ops",
    files: [],
    labels: ["domain:frontend"],
  });

  assert.equal(result.planGate.status, "failed");
  assert.match(JSON.stringify(result.planGate), /factory\.files \(wymagane poza domeną ops\)/);
  assert.deepEqual(result.calls, { plan: 1, build: 0, verify: 0, review: 0 });
  assert.equal(result.ghCalled, false);
});

test("label domain:ops kieruje plan deklarowany jako frontend do bramki checklisty", async () => {
  const result = await runDomainOverrideHarness({
    ticketId: "OVERRIDE-OPS",
    declaredDomain: "frontend",
    files: ["src/x.ts"],
    labels: ["domain:ops"],
    approvePlan: true,
  });

  assert.equal(result.planGate.status, "suspended");
  assert.equal(result.checklistGate?.status, "suspended");
  assert.deepEqual(result.calls, { plan: 1, build: 0, verify: 0, review: 0 });
  assert.equal(result.ghCalled, false);
});
