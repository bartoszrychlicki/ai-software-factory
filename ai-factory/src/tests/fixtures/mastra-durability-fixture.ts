import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { LibSQLStore } from "@mastra/libsql";
import { z } from "zod";

const gateInput = z.object({
  effectFile: z.string(),
  parentRunId: z.string().optional(),
});

const gateOutput = z.object({
  effectFile: z.string(),
  parentRunId: z.string().optional(),
  approved: z.boolean(),
});

const waitForApproval = createStep({
  id: "wait-for-approval",
  inputSchema: gateInput,
  outputSchema: gateOutput,
  suspendSchema: z.object({ reason: z.string() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      await suspend({ reason: "approval-required" });
    }
    return { ...inputData, approved: resumeData?.approved ?? false };
  },
});

const approvedEffect = createStep({
  id: "approved-effect",
  inputSchema: gateOutput,
  outputSchema: z.object({ approved: z.boolean(), parentRunId: z.string().optional() }),
  execute: async ({ inputData }) => {
    appendFileSync(inputData.effectFile, "effect\n", "utf8");
    return { approved: inputData.approved, parentRunId: inputData.parentRunId };
  },
});

export const durabilityGateWorkflow = createWorkflow({
  id: "durability-gate-spike",
  inputSchema: gateInput,
  outputSchema: z.object({ approved: z.boolean(), parentRunId: z.string().optional() }),
})
  .then(waitForApproval)
  .then(approvedEffect)
  .commit();

const crashInput = z.object({
  effectFile: z.string(),
  crashMarker: z.string(),
  crashPoint: z.enum(["before-effect", "after-effect"]),
});

const crashableEffect = createStep({
  id: "crashable-effect",
  inputSchema: crashInput,
  outputSchema: z.object({ executed: z.boolean() }),
  execute: async ({ inputData }) => {
    const shouldCrash = !existsSync(inputData.crashMarker);
    if (shouldCrash && inputData.crashPoint === "before-effect") {
      writeFileSync(inputData.crashMarker, "crashed-before-effect\n", "utf8");
      process.kill(process.pid, "SIGKILL");
      await new Promise<never>(() => undefined);
    }

    appendFileSync(inputData.effectFile, "effect\n", "utf8");

    if (shouldCrash && inputData.crashPoint === "after-effect") {
      writeFileSync(inputData.crashMarker, "crashed-after-effect\n", "utf8");
      process.kill(process.pid, "SIGKILL");
      await new Promise<never>(() => undefined);
    }
    return { executed: true };
  },
});

export const durabilityCrashWorkflow = createWorkflow({
  id: "durability-crash-spike",
  inputSchema: crashInput,
  outputSchema: z.object({ executed: z.boolean() }),
})
  .then(crashableEffect)
  .commit();

export function createDurabilityRuntime(databaseFile: string): Mastra {
  return new Mastra({
    workflows: { durabilityGateWorkflow, durabilityCrashWorkflow },
    storage: new LibSQLStore({
      id: "durability-spike-storage",
      url: `file:${databaseFile}`,
    }),
  });
}
