import { createDurabilityRuntime } from "./mastra-durability-fixture";

const [mode, databaseFile, runId, effectFile, crashMarker, crashPoint] = process.argv.slice(2);
if (!mode || !databaseFile || !runId || !effectFile) {
  throw new Error("usage: worker <suspend|crash> <db> <runId> <effectFile> [crashMarker] [crashPoint]");
}

const runtime = createDurabilityRuntime(databaseFile);

if (mode === "suspend") {
  const workflow = runtime.getWorkflow("durabilityGateWorkflow");
  const run = await workflow.createRun({ runId });
  const result = await run.start({ inputData: { effectFile } });
  process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
  await runtime.shutdown();
} else if (mode === "crash") {
  if (!crashMarker || (crashPoint !== "before-effect" && crashPoint !== "after-effect")) {
    throw new Error("crash mode requires crashMarker and crashPoint");
  }
  const workflow = runtime.getWorkflow("durabilityCrashWorkflow");
  const run = await workflow.createRun({ runId });
  await run.start({ inputData: { effectFile, crashMarker, crashPoint } });
} else {
  throw new Error(`unknown mode: ${mode}`);
}
