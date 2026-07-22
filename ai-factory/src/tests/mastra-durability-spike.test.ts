import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDurabilityRuntime } from "./fixtures/mastra-durability-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "fixtures/mastra-durability-worker.ts");
const tsxCli = join(here, "../../node_modules/tsx/dist/cli.mjs");

async function runWorker(args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [tsxCli, worker, ...args], {
    cwd: join(here, "../.."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`worker timeout; stdout=${stdout}; stderr=${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  return { ...result, stdout, stderr };
}

function effects(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
}

test("publiczne API Mastry wznawia suspend po restarcie procesu bez prywatnego patcha", async () => {
  const root = mkdtempSync(join(tmpdir(), "mastra-suspend-spike-"));
  let runtimeAfterRestart: ReturnType<typeof createDurabilityRuntime> | undefined;
  try {
    const databaseFile = join(root, "mastra.db");
    const effectFile = join(root, "effects.log");
    const runId = "suspend-across-process";
    const workerResult = await runWorker(["suspend", databaseFile, runId, effectFile]);
    assert.equal(workerResult.code, 0, workerResult.stderr);
    assert.match(workerResult.stdout, /"status":"suspended"/);

    runtimeAfterRestart = createDurabilityRuntime(databaseFile);
    const workflow = runtimeAfterRestart.getWorkflow("durabilityGateWorkflow");
    const persisted = await workflow.getWorkflowRunById(runId);
    assert.equal(persisted?.status, "suspended");

    const runAfterRestart = await workflow.createRun({ runId });
    const completed = await runAfterRestart.resume({
      step: "wait-for-approval",
      resumeData: { approved: true },
    });
    assert.equal(completed.status, "success");
    assert.equal(effects(effectFile), 1);
  } finally {
    await runtimeAfterRestart?.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart przed efektem kontynuuje run i wykonuje efekt jeden raz", async () => {
  const root = mkdtempSync(join(tmpdir(), "mastra-before-effect-spike-"));
  let runtimeAfterRestart: ReturnType<typeof createDurabilityRuntime> | undefined;
  try {
    const databaseFile = join(root, "mastra.db");
    const effectFile = join(root, "effects.log");
    const crashMarker = join(root, "crashed.marker");
    const runId = "crash-before-effect";
    const workerResult = await runWorker([
      "crash", databaseFile, runId, effectFile, crashMarker, "before-effect",
    ]);
    assert.ok(
      workerResult.signal === "SIGKILL" || workerResult.code === 137,
      `worker nie został przerwany w punkcie awarii: ${workerResult.stderr}`,
    );

    runtimeAfterRestart = createDurabilityRuntime(databaseFile);
    const workflow = runtimeAfterRestart.getWorkflow("durabilityCrashWorkflow");
    const persisted = await workflow.getWorkflowRunById(runId);
    assert.equal(persisted?.status, "running");
    const runAfterRestart = await workflow.createRun({ runId });
    const completed = await runAfterRestart.restart();
    assert.equal(completed.status, "success");
    assert.equal(effects(effectFile), 1);
  } finally {
    await runtimeAfterRestart?.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CHARACTERIZATION: restart po efekcie powtarza efekt bez transactional outbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "mastra-after-effect-spike-"));
  let runtimeAfterRestart: ReturnType<typeof createDurabilityRuntime> | undefined;
  try {
    const databaseFile = join(root, "mastra.db");
    const effectFile = join(root, "effects.log");
    const crashMarker = join(root, "crashed.marker");
    const runId = "crash-after-effect";
    const workerResult = await runWorker([
      "crash", databaseFile, runId, effectFile, crashMarker, "after-effect",
    ]);
    assert.ok(
      workerResult.signal === "SIGKILL" || workerResult.code === 137,
      `worker nie został przerwany w punkcie awarii: ${workerResult.stderr}`,
    );
    assert.equal(effects(effectFile), 1);

    runtimeAfterRestart = createDurabilityRuntime(databaseFile);
    const workflow = runtimeAfterRestart.getWorkflow("durabilityCrashWorkflow");
    const runAfterRestart = await workflow.createRun({ runId });
    const completed = await runAfterRestart.restart();
    assert.equal(completed.status, "success");

    // To jest oczekiwany negatywny wynik spike'a: snapshot kroku i zewnętrzny
    // efekt nie są atomowe, więc publiczny restart Mastry wykonuje efekt ponownie.
    assert.equal(effects(effectFile), 2);
  } finally {
    await runtimeAfterRestart?.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay jest nowym runem i zachowuje jawne powiązanie z poprzednim", async () => {
  const root = mkdtempSync(join(tmpdir(), "mastra-replay-spike-"));
  let runtime: ReturnType<typeof createDurabilityRuntime> | undefined;
  try {
    const databaseFile = join(root, "mastra.db");
    const effectFile = join(root, "effects.log");
    runtime = createDurabilityRuntime(databaseFile);
    const workflow = runtime.getWorkflow("durabilityGateWorkflow");

    const original = await workflow.createRun({ runId: "original-run" });
    await original.start({ inputData: { effectFile } });
    await original.resume({ step: "wait-for-approval", resumeData: { approved: true } });

    const replay = await workflow.createRun({ runId: "replay-run" });
    await replay.start({ inputData: { effectFile, parentRunId: "original-run" } });
    const replayResult = await replay.resume({
      step: "wait-for-approval",
      resumeData: { approved: true },
    });

    assert.notEqual(replay.runId, original.runId);
    assert.equal(replayResult.status, "success");
    assert.equal(replayResult.result?.parentRunId, original.runId);
    assert.equal(effects(effectFile), 2);
  } finally {
    await runtime?.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CHARACTERIZATION: równoległe dostarczenie resume nie deduplikuje efektu", async () => {
  const root = mkdtempSync(join(tmpdir(), "mastra-duplicate-resume-spike-"));
  let runtime: ReturnType<typeof createDurabilityRuntime> | undefined;
  try {
    const databaseFile = join(root, "mastra.db");
    const effectFile = join(root, "effects.log");
    runtime = createDurabilityRuntime(databaseFile);
    const workflow = runtime.getWorkflow("durabilityGateWorkflow");
    const initial = await workflow.createRun({ runId: "duplicate-resume" });
    await initial.start({ inputData: { effectFile } });

    const deliveryA = await workflow.createRun({ runId: "duplicate-resume" });
    const deliveryB = await workflow.createRun({ runId: "duplicate-resume" });
    const results = await Promise.allSettled([
      deliveryA.resume({ step: "wait-for-approval", resumeData: { approved: true } }),
      deliveryB.resume({ step: "wait-for-approval", resumeData: { approved: true } }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
    assert.equal(effects(effectFile), 2);
  } finally {
    await runtime?.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
