import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { execFileControlled } from "./process-control";
import { createCheckout, createWorkspace, removeCheckout } from "./workspace";
import { getProject } from "./projects";
import { resolveRoute } from "./routing";
import { artifactHeader, saveArtifact } from "./artifacts";
import {
  buildSignature,
  signatureLine,
  signatureMeta,
  signatureTrailer,
} from "./signature";
import { recordMetric } from "./metrics";
import {
  formatClarifyQuestions,
  parsePlanVerdict,
  parseReviewVerdict,
  resolveDomain,
  verdictInstruction,
} from "./verdicts";
import { changeManifest } from "./quality";
import { auditScope, changedFilesInWorkspace } from "./scope";
import type { Route, Stage } from "./routing";
import type { ProjectConfig } from "./projects";

const ticketSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  project: z.string(),
  labels: z.array(z.string()).default([]),
  inputHash: z.string(),
  commentContext: z.string().optional(),
});

export const factoryJobInputSchema = z.object({
  kind: z.enum(["plan", "build", "review"]),
  attempt: z.number().int().positive(),
  ticket: ticketSchema,
  plan: z.string().optional(),
  planFiles: z.array(z.string()).default([]),
  planDomain: z.string().optional(),
  feedback: z.string().optional(),
  headSha: z.string().optional(),
  /** Harness buildera tego ticketu — review wyklucza go w routingu (dywersyfikacja). */
  buildHarness: z.string().optional(),
});

export const factoryJobOutputSchema = z.object({
  kind: z.enum(["plan", "build", "review"]),
  outcome: z.enum(["success", "questions", "failed"]),
  report: z.string(),
  errorCode: z.string().optional(),
  signature: z.string(),
  costUsd: z.number().optional(),
  durationMs: z.number(),
  plan: z.string().optional(),
  questions: z.string().optional(),
  files: z.array(z.string()).default([]),
  domain: z.string().optional(),
  branch: z.string().optional(),
  workspaceDir: z.string().optional(),
  headSha: z.string().optional(),
  changedFiles: z.array(z.string()).default([]),
  scopeWarnings: z.array(z.string()).default([]),
  reviewVerdict: z.enum(["lgtm", "advisory-fix", "unavailable"]).optional(),
  costSource: z.enum(["reported", "estimated-tokens", "estimated-time"]).optional(),
});

export type FactoryJobInput = z.infer<typeof factoryJobInputSchema>;
export type FactoryJobOutput = z.infer<typeof factoryJobOutputSchema>;

/** Budżety wall-clock jobów; poller liczy z nich lease stall-detection. */
export const JOB_BUDGET_MINUTES = { plan: 20, build: 25, review: 10 } as const;

/**
 * Koszt efektywny próby: raport CLI > estymata tokenowa adaptera > estymata
 * czasowa (FACTORY_SYNTH_USD_PER_MIN). Budżet USD ticketu przestaje być ślepy
 * na silniki bez raportu kosztów (codex/kimi/pi).
 */
function effectiveCost(
  result: { costUsd?: number; costSource?: FactoryJobOutput["costSource"] },
  durationMs: number
): { costUsd: number; costSource: NonNullable<FactoryJobOutput["costSource"]> } {
  if (result.costUsd !== undefined) {
    return { costUsd: result.costUsd, costSource: result.costSource ?? "reported" };
  }
  const perMinute = Number(process.env.FACTORY_SYNTH_USD_PER_MIN ?? 0.15);
  return { costUsd: (durationMs / 60_000) * perMinute, costSource: "estimated-time" };
}

export interface FactoryJobRuntime {
  route(
    stage: Stage,
    ticket: { project: string; labels?: string[] },
    domain?: string,
    options?: { excludeEngine?: string }
  ): Promise<Route>;
  project(key: string): Promise<ProjectConfig>;
}

const defaultRuntime: FactoryJobRuntime = {
  route: resolveRoute,
  project: getProject,
};

const planInstructions = [
  "Jesteś plannerem w fabryce software. Przygotuj implementowalny plan dla ticketu.",
  "Opisz zakres, poza zakresem, kryteria akceptacji, zmiany plik po pliku i testy.",
  "factory.files jest oczekiwaną listą zmian i wejściem do audytu ryzyka, nie blokadą zwykłych dodatkowych plików.",
  "Każda zmiana .github/, katalogu ops lub migracji musi być jawnie wymieniona.",
  "Jeżeli potrzebujesz odpowiedzi człowieka, zadaj ponumerowane pytania z A/B/C i rekomendacją.",
  "Nie używaj sesji ani suspend/resume. Każdy job planowania jest bezstanowy.",
  verdictInstruction("plan"),
].join("\n");

function planContext(input: FactoryJobInput): string {
  return [
    `# Ticket ${input.ticket.id}: ${input.ticket.title}`,
    input.ticket.description,
    input.ticket.commentContext ? `# Komentarze autora\n${input.ticket.commentContext}` : "",
    input.feedback ? `# Wiążąca odpowiedź/feedback\n${input.feedback}` : "",
  ].filter(Boolean).join("\n\n");
}

async function runPlan(
  input: FactoryJobInput,
  runId: string,
  signal?: AbortSignal,
  runtime: FactoryJobRuntime = defaultRuntime
): Promise<FactoryJobOutput> {
  const route = await runtime.route("plan", input.ticket);
  const signature = buildSignature("plan", route);
  const startedAt = Date.now();
  const result = await route.engine.run({
    role: "plan",
    model: route.model,
    effort: route.effort,
    instructions: planInstructions,
    context: planContext(input),
    workspace: (await runtime.project(input.ticket.project)).repo,
    budget: { minutes: JOB_BUDGET_MINUTES.plan },
    signal,
  });
  const durationMs = Date.now() - startedAt;
  const { costUsd, costSource } = effectiveCost(result, durationMs);
  const report = result.transcript ?? result.report;
  const verdict = parsePlanVerdict(report);
  const outcome = !result.ok || verdict.source === "missing"
    ? "failed"
    : verdict.ok
      ? "success"
      : verdict.questions
        ? "questions"
        : "failed";
  const questions = verdict.questions ? formatClarifyQuestions(verdict.questions) : undefined;
  await recordMetric({
    ticket: input.ticket.id,
    runId,
    stage: "plan",
    engine: route.spec,
    attempt: input.attempt,
    ok: outcome !== "failed",
    outcome,
    costUsd,
    durationMs,
    resumed: false,
  });
  await saveArtifact(
    input.ticket.id,
    runId,
    `plan-attempt-${input.attempt}.md`,
    artifactHeader({
      jobId: runId,
      ticket: input.ticket.id,
      step: "plan",
      attempt: input.attempt,
      outcome,
      ...signatureMeta(signature),
      engine: route.spec,
      costUsd,
    }) + report
  );
  return {
    kind: "plan",
    outcome,
    report,
    errorCode: outcome === "failed"
      ? result.ok ? "PLAN_CONTRACT_MISSING" : "PLAN_ENGINE_FAILED"
      : undefined,
    signature: signatureLine(signature),
    costUsd,
    costSource,
    durationMs,
    plan: outcome === "success" ? report : undefined,
    questions,
    files: verdict.files,
    domain: verdict.domain,
    changedFiles: [],
    scopeWarnings: [],
  };
}

async function runBuild(
  input: FactoryJobInput,
  runId: string,
  signal?: AbortSignal,
  runtime: FactoryJobRuntime = defaultRuntime
): Promise<FactoryJobOutput> {
  if (!input.plan) throw new Error("Build wymaga zatwierdzonego planu.");
  const project = await runtime.project(input.ticket.project);
  const domain = input.planDomain ?? resolveDomain(input.ticket.labels, input.plan);
  const route = await runtime.route("build", input.ticket, domain);
  const signature = buildSignature("build", route);
  const defaultBranch = project.default_branch ?? "main";
  let checkpointRef: string | undefined;
  if (input.headSha) {
    const verified = await execFileControlled(
      "git",
      ["-C", project.repo, "rev-parse", "--verify", `${input.headSha}^{commit}`]
    ).then(({ stdout }) => stdout.trim()).catch(() => undefined);
    if (verified) {
      await execFileControlled("git", ["-C", project.repo, "fetch", "origin", defaultBranch])
        .catch(() => {});
      const { stdout: base } = await execFileControlled(
        "git",
        ["-C", project.repo, "merge-base", verified, `origin/${defaultBranch}`]
      );
      const { stdout: names } = await execFileControlled(
        "git",
        ["-C", project.repo, "diff", "--name-only", "-z", `${base.trim()}...${verified}`]
      );
      const checkpointAudit = auditScope(
        input.planFiles,
        names.split("\0").filter(Boolean),
        project.scope?.protected ?? []
      );
      if (checkpointAudit.blocked.length) {
        throw new Error(`Checkpoint narusza aktualny plan:\n${checkpointAudit.blocked.join("\n")}`);
      }
      checkpointRef = verified;
    }
  }
  const slug = input.ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  const workspace = await createWorkspace(
    project.repo,
    input.ticket.id,
    slug,
    defaultBranch,
    checkpointRef
  );
  const startedAt = Date.now();
  const feedback = input.feedback
    ? `\n\n# Raport zatrzymanego etapu do jawnej poprawki\n${input.feedback.slice(0, 16_000)}`
    : "";
  const result = await route.engine.run({
    role: "build",
    model: route.model,
    effort: route.effort,
    instructions: [
      "Zaimplementuj dokładnie zatwierdzony plan w bieżącym worktree.",
      "Nie commituj i nie publikuj zmian; checkpoint tworzy fabryka.",
      "Zwykły dodatkowy plik jest dozwolony, ale opisz go w raporcie.",
      "Nie zapisuj sekretów, kluczy ani lokalnych plików .env.",
    ].join("\n"),
    context: [
      `# Ticket ${input.ticket.id}: ${input.ticket.title}`,
      input.ticket.description,
      `# Zatwierdzony plan\n${input.plan}`,
      feedback,
    ].filter(Boolean).join("\n\n"),
    workspace: workspace.dir,
    budget: { minutes: JOB_BUDGET_MINUTES.build },
    signal,
  });
  const durationMs = Date.now() - startedAt;
  const { costUsd, costSource } = effectiveCost(result, durationMs);
  if (!result.ok) {
    await recordMetric({
      ticket: input.ticket.id,
      runId,
      stage: "build",
      engine: route.spec,
      attempt: input.attempt,
      ok: false,
      outcome: "engine-fail",
      costUsd,
      durationMs,
    });
    await saveArtifact(
      input.ticket.id,
      runId,
      `build-attempt-${input.attempt}.md`,
      artifactHeader({
        jobId: runId,
        ticket: input.ticket.id,
        step: "build",
        attempt: input.attempt,
        outcome: "engine-fail",
        ...signatureMeta(signature),
      }) + result.report
    );
    return {
      kind: "build",
      outcome: "failed",
      report: result.report,
      errorCode: "BUILD_ENGINE_FAILED",
      signature: signatureLine(signature),
      costUsd,
      costSource,
      durationMs,
      files: input.planFiles,
      branch: workspace.branch,
      workspaceDir: workspace.dir,
      headSha: workspace.checkpointSha,
      changedFiles: [],
      scopeWarnings: [],
    };
  }

  const changedFiles = await changedFilesInWorkspace(workspace.dir);
  if (!changedFiles.length) {
    return {
      kind: "build",
      outcome: "failed",
      report: `${result.report}\n\nBuilder nie pozostawił zmian do checkpointu.`,
      errorCode: "BUILD_NO_CHANGES",
      signature: signatureLine(signature),
      costUsd,
      costSource,
      durationMs,
      files: input.planFiles,
      branch: workspace.branch,
      workspaceDir: workspace.dir,
      headSha: workspace.checkpointSha,
      changedFiles: [],
      scopeWarnings: [],
    };
  }

  const audit = auditScope(input.planFiles, changedFiles, project.scope?.protected ?? []);
  if (audit.blocked.length) {
    return {
      kind: "build",
      outcome: "failed",
      report: `${result.report}\n\nPublikacja zablokowana:\n${audit.blocked.map((line) => `- ${line}`).join("\n")}`,
      errorCode: "SCOPE_BLOCKED",
      signature: signatureLine(signature),
      costUsd,
      costSource,
      durationMs,
      files: input.planFiles,
      branch: workspace.branch,
      workspaceDir: workspace.dir,
      headSha: workspace.checkpointSha,
      changedFiles,
      scopeWarnings: audit.warnings,
    };
  }

  await execFileControlled("git", ["-C", workspace.dir, "add", "-A"], { signal });
  await execFileControlled("git", [
    "-C",
    workspace.dir,
    "commit",
    "-m",
    [
      `feat(${input.ticket.id}): ${input.ticket.title}`,
      "",
      `[ai-factory job ${runId}]`,
      "",
      signatureTrailer(signature),
    ].join("\n"),
  ], { signal });
  const { stdout } = await execFileControlled(
    "git",
    ["-C", workspace.dir, "rev-parse", "HEAD"],
    { signal }
  );
  const headSha = stdout.trim();
  await recordMetric({
    ticket: input.ticket.id,
    runId,
    stage: "build",
    engine: route.spec,
    attempt: input.attempt,
    ok: true,
    outcome: "committed",
    costUsd,
    durationMs,
  });
  await saveArtifact(
    input.ticket.id,
    runId,
    `build-attempt-${input.attempt}.md`,
    artifactHeader({
      jobId: runId,
      ticket: input.ticket.id,
      sha: headSha,
      step: "build",
      attempt: input.attempt,
      outcome: "committed",
      ...signatureMeta(signature),
      warnings: audit.warnings.length,
    }) + result.report
  );
  return {
    kind: "build",
    outcome: "success",
    report: result.report,
    signature: signatureLine(signature),
    costUsd,
    costSource,
    durationMs,
    files: input.planFiles,
    branch: workspace.branch,
    workspaceDir: workspace.dir,
    headSha,
    changedFiles,
    scopeWarnings: audit.warnings,
  };
}

async function runReview(
  input: FactoryJobInput,
  runId: string,
  signal?: AbortSignal,
  runtime: FactoryJobRuntime = defaultRuntime
): Promise<FactoryJobOutput> {
  if (!input.headSha) throw new Error("Review wymaga dokładnego PR head SHA.");
  const project = await runtime.project(input.ticket.project);
  const route = await runtime.route("review", input.ticket, input.planDomain, {
    excludeEngine: input.buildHarness,
  });
  const signature = buildSignature("review", route);
  const checkout = await createCheckout(project.repo, input.headSha, `${input.ticket.id}-review-${runId}`);
  const startedAt = Date.now();
  try {
    const manifest = await changeManifest(checkout.dir, project.default_branch ?? "main");
    const result = await route.engine.run({
      role: "review",
      model: route.model,
      effort: route.effort,
      instructions: [
        "Wykonaj advisory code review dokładnego SHA. Nie zmieniaj plików.",
        "Zwróć konkretne uwagi z priorytetem. Ten job nigdy nie uruchamia buildera.",
        verdictInstruction("review"),
      ].join("\n"),
      context: [
        `# Ticket ${input.ticket.id}: ${input.ticket.title}`,
        `# SHA\n${input.headSha}`,
        `# Zatwierdzony plan\n${input.plan ?? "(brak)"}`,
        `# Zmiany\n${manifest.nameStatus}\n\n${manifest.diffStat}`,
      ].join("\n\n"),
      workspace: checkout.dir,
      budget: { minutes: JOB_BUDGET_MINUTES.review },
      signal,
    });
    const durationMs = Date.now() - startedAt;
    const { costUsd, costSource } = effectiveCost(result, durationMs);
    const report = result.transcript ?? result.report;
    const verdict = parseReviewVerdict(report);
    const reviewVerdict = !result.ok || verdict.source === "missing"
      ? "unavailable"
      : verdict.needsFix
        ? "advisory-fix"
        : "lgtm";
    await recordMetric({
      ticket: input.ticket.id,
      runId,
      stage: "review",
      engine: route.spec,
      attempt: input.attempt,
      ok: reviewVerdict !== "unavailable",
      outcome: reviewVerdict,
      costUsd,
      durationMs,
    });
    await saveArtifact(
      input.ticket.id,
      runId,
      `review-attempt-${input.attempt}.md`,
      artifactHeader({
        jobId: runId,
        ticket: input.ticket.id,
        sha: input.headSha,
        step: "review",
        outcome: reviewVerdict,
        ...signatureMeta(signature),
      }) + report
    );
    return {
      kind: "review",
      outcome: reviewVerdict === "unavailable" ? "failed" : "success",
      report,
      errorCode: reviewVerdict === "unavailable" ? "REVIEW_VERDICT_MISSING" : undefined,
      signature: signatureLine(signature),
      costUsd,
      costSource,
      durationMs,
      files: input.planFiles,
      headSha: input.headSha,
      changedFiles: [],
      scopeWarnings: [],
      reviewVerdict,
    };
  } finally {
    await removeCheckout(project.repo, checkout.dir);
  }
}

export async function executeFactoryJobInput(
  input: FactoryJobInput,
  runId: string,
  signal?: AbortSignal,
  runtime: FactoryJobRuntime = defaultRuntime
): Promise<FactoryJobOutput> {
  if (input.kind === "plan") return runPlan(input, runId, signal, runtime);
  if (input.kind === "build") return runBuild(input, runId, signal, runtime);
  return runReview(input, runId, signal, runtime);
}

const executeFactoryJob = createStep({
  id: "execute-factory-job",
  inputSchema: factoryJobInputSchema,
  outputSchema: factoryJobOutputSchema,
  execute: async ({ inputData, runId, abortSignal }) =>
    executeFactoryJobInput(inputData, runId, abortSignal),
});

/**
 * Jedyny workflow Mastry używany przez fabrykę. Kończy się po jednym krótkim
 * zadaniu AI; nie czeka na człowieka, CI, merge ani smoke.
 */
export const factoryJob = createWorkflow({
  id: "factory-job",
  inputSchema: factoryJobInputSchema,
  outputSchema: factoryJobOutputSchema,
}).then(executeFactoryJob);

factoryJob.commit();
