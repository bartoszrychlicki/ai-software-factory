/**
 * Poller v2: cienki koordynator durable lifecycle.
 *
 * Mastra wykonuje tylko pojedyncze factoryJob. Oczekiwanie na człowieka, testy,
 * GitHub, merge i smoke żyją tutaj i w SQLite, bez workflow resume.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCommentContextSnapshot } from "./comment-context";
import { parseCommand } from "./commands";
import { LinearSource } from "./linear";
import {
  isWorkflowRunMissing,
  MastraWorkflowClient,
  runStatus,
  type MastraRunSnapshot,
} from "./mastra-client";
import {
  LifecycleStore,
  type LifecycleCommand,
  type LifecycleRun,
} from "../pipeline/lifecycle-store";
import {
  reduceLifecycle,
  type CoordinatorDecision,
  type CoordinatorEvent,
} from "../pipeline/coordinator";
import {
  factoryJobOutputSchema,
  type FactoryJobOutput,
} from "../pipeline/factory-job";
import { runPreflight } from "../pipeline/preflight";
import { getProject } from "../pipeline/projects";
import {
  allQualityCommands,
  cleanExecutionEnv,
  runQualityCommands,
} from "../pipeline/quality";
import { createCheckout, removeCheckout } from "../pipeline/workspace";
import { auditScope } from "../pipeline/scope";
import { execFileControlled } from "../pipeline/process-control";
import { evaluateGithubChecks, inspectPullRequestChecks } from "../pipeline/github-ci";
import { runProdChecks } from "../pipeline/prod-smoke";
import { notify } from "../pipeline/notify";

const POLL_INTERVAL_MS = Number(process.env.FACTORY_POLL_INTERVAL_MS ?? 60_000);
const marker = (ticketId: string) => `[linear:${ticketId}:v2]`;
const reportedPreflight = new Map<string, string>();

export interface PollerDependencies {
  store: LifecycleStore;
  mastra: MastraWorkflowClient;
  sources: Map<string, LinearSource>;
}

function stableRunId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function sourceFor(deps: PollerDependencies, run: LifecycleRun): LinearSource {
  const source = deps.sources.get(run.project);
  if (!source) throw new Error(`Brak LinearSource dla projektu ${run.project}`);
  return source;
}

function statusName(run: LifecycleRun): string {
  if (run.errorCode === "CANCELED") return "Canceled";
  if (run.status === "blocked") return "👤 ⛔ Zablokowany";
  if (run.status === "done") return "Done";
  if (run.stage === "review" || run.stage === "merge") return "In Review";
  return "In Progress";
}

function statusCommand(run: LifecycleRun, reason: string): Omit<
  LifecycleCommand,
  "state" | "attempts" | "createdAt" | "updatedAt" | "availableAt"
> {
  const state = statusName(run);
  const transitionId = createHash("sha256")
    .update(`${run.stage}:${run.status}:${state}:${reason}`)
    .digest("hex")
    .slice(0, 12);
  return {
    key: `${run.ticketId}:g${run.generation}:linear-status:${transitionId}`,
    ticketId: run.ticketId,
    kind: "linear-status",
    stage: run.stage,
    payload: { state },
  };
}

export function applyDecision(
  deps: PollerDependencies,
  ticketId: string,
  decision: CoordinatorDecision,
  acknowledgeCommandKey?: string
): LifecycleRun {
  const current = deps.store.getRun(ticketId);
  if (!current) throw new Error(`Brak lifecycle run dla ${ticketId}`);
  const projected: LifecycleRun = {
    ...current,
    ...decision.transition.patch,
    generation: current.generation + (decision.transition.incrementGeneration ? 1 : 0),
    stage: decision.transition.stage,
    status: decision.transition.status,
    updatedAt: current.updatedAt,
  };
  return deps.store.transition(ticketId, {
    ...decision.transition,
    commands: [
      ...decision.commands,
      statusCommand(projected, decision.transition.reason),
    ],
    acknowledgeCommandKey,
  });
}

function findFactoryOutput(value: unknown): FactoryJobOutput | undefined {
  const parsed = factoryJobOutputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!value || typeof value !== "object") return undefined;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    const found = findFactoryOutput(nested);
    if (found) return found;
  }
  return undefined;
}

function runError(snapshot: MastraRunSnapshot): string {
  const seen = new Set<unknown>();
  const walk = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/error|message/i.test(key) && typeof nested === "string" && nested.trim()) return nested;
      const result = walk(nested);
      if (result) return result;
    }
    return undefined;
  };
  return walk(snapshot) ?? "Mastra job zakończył się bez wyniku.";
}

function failedJobOutput(command: LifecycleCommand, report: string): FactoryJobOutput {
  const kind = String(command.payload.kind) as FactoryJobOutput["kind"];
  return {
    kind,
    outcome: "failed",
    report,
    errorCode: `${kind.toUpperCase()}_JOB_FAILED`,
    signature: "ai-factory · unavailable · unavailable · unavailable",
    durationMs: 0,
    files: Array.isArray(command.payload.planFiles)
      ? command.payload.planFiles.filter((file): file is string => typeof file === "string")
      : [],
    changedFiles: [],
    scopeWarnings: [],
    reviewVerdict: kind === "review" ? "unavailable" : undefined,
  };
}

async function dispatchJob(
  deps: PollerDependencies,
  command: LifecycleCommand,
  run: LifecycleRun
): Promise<void> {
  const attempt = Number(command.payload.attempt ?? 1);
  const project = await getProject(run.project);
  const usage = deps.store.totalUsage(run.ticketId);
  const maxMinutes = project.budget?.maxMinutes ?? Number(process.env.FACTORY_BUDGET_MAX_MIN ?? 45);
  const maxUsd = project.budget?.maxUsd ?? Number(process.env.FACTORY_BUDGET_MAX_USD ?? 3);
  const attemptDetails = {
    inputHash: run.manifest.inputHash,
    sha: typeof command.payload.headSha === "string" ? command.payload.headSha : run.headSha,
    budgetMaxMinutes: maxMinutes,
    budgetMaxUsd: maxUsd,
    budgetUsedMinutes: usage.minutes,
    budgetUsedUsd: usage.usd,
  };
  if (usage.minutes >= maxMinutes || usage.usd >= maxUsd) {
    const output = failedJobOutput(
      command,
      `Budżet ticketu wyczerpany: ${usage.minutes.toFixed(1)}/${maxMinutes} min, $${usage.usd.toFixed(2)}/$${maxUsd}.`
    );
    deps.store.startAttempt(
      run.ticketId,
      command.stage,
      attempt,
      `budget-blocked:${command.key}`,
      attemptDetails
    );
    deps.store.finishAttempt(run.ticketId, command.stage, attempt, {
      status: "failed",
      outcome: output.errorCode,
      report: output.report,
      signature: output.signature,
      errorCode: output.errorCode,
      errorMessage: output.report,
    });
    applyDecision(
      deps,
      run.ticketId,
      reduceLifecycle(run, { type: "job-finished", attempt, output }),
      command.key
    );
    return;
  }

  let jobRunId = command.externalId;
  if (!jobRunId) {
    jobRunId = stableRunId(command.key);
    let existing: MastraRunSnapshot | undefined;
    try {
      existing = await deps.mastra.getRun(jobRunId);
    } catch (error) {
      if (!isWorkflowRunMissing(error)) throw error;
      await deps.mastra.createRun(jobRunId);
    }
    deps.store.startAttempt(run.ticketId, command.stage, attempt, jobRunId, attemptDetails);
    deps.store.markCommand(command.key, "dispatched", { externalId: jobRunId });
    if (!existing || runStatus(existing) === "pending") {
      await deps.mastra.startRun(jobRunId, command.payload);
    }
    return;
  }

  const snapshot = await deps.mastra.getRun(jobRunId);
  const status = runStatus(snapshot);
  if (status === "pending") {
    await deps.mastra.startRun(jobRunId, command.payload);
    return;
  }
  if (status === "running") return;

  const output = findFactoryOutput(snapshot.result ?? snapshot);
  if (!output || status === "failed" || status === "canceled") {
    const fallback = failedJobOutput(command, runError(snapshot));
    deps.store.finishAttempt(run.ticketId, command.stage, attempt, {
      status: status === "canceled" ? "canceled" : "failed",
      outcome: fallback.errorCode,
      report: fallback.report,
      signature: fallback.signature,
      errorCode: fallback.errorCode,
      errorMessage: fallback.report,
    });
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "job-finished",
      attempt,
      output: fallback,
    }), command.key);
    return;
  }

  deps.store.finishAttempt(run.ticketId, command.stage, attempt, {
    status: output.outcome === "failed" ? "failed" : "success",
    outcome: output.outcome,
    report: output.report,
    signature: output.signature,
    sha: output.headSha,
    errorCode: output.errorCode,
    errorMessage: output.outcome === "failed" ? output.report : undefined,
    costUsd: output.costUsd,
    durationMs: output.durationMs,
  });
  applyDecision(deps, run.ticketId, reduceLifecycle(run, {
    type: "job-finished",
    attempt,
    output,
  }), command.key);
}

async function changedFilesAtSha(
  repo: string,
  sha: string,
  defaultBranch: string,
  signal?: AbortSignal
): Promise<string[]> {
  await execFileControlled("git", ["-C", repo, "fetch", "origin", defaultBranch], {
    timeoutMs: 60_000,
    signal,
  });
  const { stdout: base } = await execFileControlled(
    "git",
    ["-C", repo, "merge-base", sha, `origin/${defaultBranch}`],
    { signal }
  );
  const { stdout } = await execFileControlled(
    "git",
    ["-C", repo, "diff", "--name-only", "-z", `${base.trim()}...${sha}`],
    { signal }
  );
  return stdout.split("\0").filter(Boolean);
}

export async function publishDraftPullRequest(
  run: LifecycleRun,
  project: Awaited<ReturnType<typeof getProject>>,
  buildMeta?: { jobRunId?: string; signature?: string; outcome?: string }
): Promise<{ prUrl: string; branch: string; sha: string }> {
  if (!run.branch || !run.headSha || !project.github) {
    throw new Error("Publish wymaga branch, SHA i konfiguracji GitHub.");
  }
  const branch = run.branch;
  const sha = run.headSha;
  const defaultBranch = project.default_branch ?? "main";
  await execFileControlled("git", ["-C", project.repo, "fetch", "origin", defaultBranch], { timeoutMs: 60_000 });

  const behind = await execFileControlled(
    "git",
    ["-C", project.repo, "merge-base", "--is-ancestor", `origin/${defaultBranch}`, sha]
  ).then(() => false).catch(() => true);
  if (behind) {
    const mergeTree = await execFileControlled(
      "git",
      ["-C", project.repo, "merge-tree", `origin/${defaultBranch}`, sha],
      { timeoutMs: 60_000 }
    ).catch((error) => ({ stdout: String(error), stderr: "" }));
    const conflict = /<<<<<<<|changed in both|CONFLICT/i.test(mergeTree.stdout);
    throw new Error(conflict
      ? "BRANCH_CONFLICT: checkpoint koliduje z aktualnym main."
      : "BRANCH_BEHIND: checkpoint nie zawiera aktualnego main; wymaga synchronizacji i ponownych testów exact-SHA.");
  }

  await execFileControlled(
    "git",
    ["-C", project.repo, "push", "origin", `${sha}:refs/heads/${branch}`],
    { timeoutMs: 120_000 }
  );
  const existing = await execFileControlled(
    "gh",
    ["pr", "list", "--repo", project.github, "--head", branch, "--state", "open", "--json", "url", "--limit", "1"],
    { cwd: project.repo, timeoutMs: 30_000 }
  );
  const rows = JSON.parse(existing.stdout) as { url?: string }[];
  let prUrl = rows[0]?.url;
  if (!prUrl) {
    const body = [
      `Ticket: ${run.ticketId}`,
      `SHA: ${sha}`,
      `Job ID: ${buildMeta?.jobRunId ?? "unavailable"}`,
      "Role: builder",
      `Engine/model: ${buildMeta?.signature ?? "unavailable"}`,
      `Outcome: ${buildMeta?.outcome ?? "committed"}; exact-SHA tests passed`,
      "",
      run.feedback ? `Scope warnings:\n${run.feedback}` : "Scope warnings: none",
      "",
      "Generated by ai-factory lifecycle v2.",
    ].join("\n");
    const created = await execFileControlled(
      "gh",
      [
        "pr", "create", "--draft", "--repo", project.github,
        "--head", branch, "--base", defaultBranch,
        "--title", `${run.ticketId}: ${run.manifest.title}`,
        "--body", body,
      ],
      { cwd: project.repo, timeoutMs: 60_000 }
    );
    prUrl = created.stdout.trim().split("\n").find((line) => line.startsWith("http"));
  }
  if (!prUrl) throw new Error("Nie udało się odczytać URL draft PR.");
  return { prUrl, branch, sha };
}

async function dispatchExternal(
  deps: PollerDependencies,
  command: LifecycleCommand,
  run: LifecycleRun
): Promise<void> {
  const source = sourceFor(deps, run);
  const project = await getProject(run.project);
  if (command.kind === "linear-status") {
    await source.setStateByName(run.ticketId, String(command.payload.state));
  } else if (command.kind === "linear-comment") {
    const tag = `[factory-outbox:${command.key}]`;
    const exists = (await source.listComments(run.ticketId)).some((comment) => comment.body.includes(tag));
    if (!exists) {
      await source.comment(
        run.ticketId,
        `${String(command.payload.body)}\n\n${marker(run.ticketId)} ${tag}`
      );
    }
  } else if (command.kind === "publish-pr") {
    const buildAttempt = deps.store.latestAttempt(run.ticketId, "build");
    const published = await publishDraftPullRequest(run, project, {
      jobRunId: buildAttempt?.jobRunId,
      signature: buildAttempt?.signature,
      outcome: buildAttempt?.outcome,
    });
    applyDecision(
      deps,
      run.ticketId,
      reduceLifecycle(run, { type: "published", ...published }),
      command.key
    );
  } else if (command.kind === "mark-pr-ready") {
    await execFileControlled("gh", ["pr", "ready", String(command.payload.prUrl)], {
      cwd: project.repo,
      timeoutMs: 30_000,
    });
  } else if (command.kind === "comment-pr") {
    const tag = `<!-- factory-outbox:${command.key} -->`;
    const existing = await execFileControlled(
      "gh",
      ["pr", "view", String(command.payload.prUrl), "--json", "comments"],
      { cwd: project.repo, timeoutMs: 30_000 }
    );
    const comments = JSON.parse(existing.stdout) as { comments?: { body?: string }[] };
    if ((comments.comments ?? []).some((comment) => comment.body?.includes(tag))) {
      deps.store.markCommand(command.key, "done");
      return;
    }
    const body = [
      String(command.payload.body),
      "",
      `Signature: ${String(command.payload.signature)}`,
      `Ticket: ${run.ticketId}`,
      `SHA: ${run.headSha}`,
      `Outcome: ${run.reviewStatus ?? "advisory"}`,
      tag,
    ].join("\n");
    await execFileControlled(
      "gh",
      ["pr", "comment", String(command.payload.prUrl), "--body", body],
      { cwd: project.repo, timeoutMs: 30_000 }
    );
  } else if (command.kind === "cleanup-workspace") {
    // Cleanup jest celowo osobną komendą po finale; implementacja nie usuwa
    // śledzonego brancha przed merge/smoke.
    if (run.workspaceDir) {
      await execFileControlled("git", ["-C", project.repo, "worktree", "remove", "--force", run.workspaceDir])
        .catch(() => {});
    }
  }
  if (command.kind !== "publish-pr") deps.store.markCommand(command.key, "done");
}

export async function dispatchOutbox(deps: PollerDependencies): Promise<void> {
  for (const queuedCommand of deps.store.outstandingCommands()) {
    const command = deps.store.getCommand(queuedCommand.key);
    if (!command || !["pending", "dispatched"].includes(command.state)) continue;
    const run = deps.store.getRun(command.ticketId);
    if (!run) {
      deps.store.markCommand(command.key, "failed", { error: "Brak lifecycle run." });
      continue;
    }
    try {
      if (command.kind === "run-job") await dispatchJob(deps, command, run);
      else if (command.state === "pending") await dispatchExternal(deps, command, run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.store.markCommand(command.key, command.attempts >= 2 ? "failed" : "pending", {
        error: message,
      });
      const lifecycleCritical = ["run-job", "publish-pr", "mark-pr-ready"].includes(command.kind);
      if (command.attempts >= 2 && lifecycleCritical) {
        applyDecision(deps, run.ticketId, {
          transition: {
            stage: command.stage,
            status: "blocked",
            actor: "outbox",
            reason: "side-effect-failed",
            patch: {
              blockedStage: command.stage,
              errorCode: "OUTBOX_FAILED",
              errorMessage: message,
            },
            cancelOutstandingRunJobs: true,
          },
          commands: [],
        });
      }
    }
  }
}

async function runExactShaTests(
  deps: PollerDependencies,
  originalRun: LifecycleRun
): Promise<void> {
  if (!originalRun.headSha) throw new Error("Etap test nie ma head SHA.");
  let run = originalRun;
  const project = await getProject(run.project);
  const attempt = deps.store.nextAttempt(run.ticketId, "test");
  const usage = deps.store.totalUsage(run.ticketId);
  deps.store.startAttempt(run.ticketId, "test", attempt, `local-test:${run.headSha}:${attempt}`, {
    inputHash: run.manifest.inputHash,
    sha: run.headSha,
    budgetMaxMinutes: project.budget?.maxMinutes ??
      Number(process.env.FACTORY_BUDGET_MAX_MIN ?? 45),
    budgetMaxUsd: project.budget?.maxUsd ??
      Number(process.env.FACTORY_BUDGET_MAX_USD ?? 3),
    budgetUsedMinutes: usage.minutes,
    budgetUsedUsd: usage.usd,
  });
  const checkout = await createCheckout(
    project.repo,
    run.headSha!,
    `${run.ticketId}-test-${attempt}`
  );
  const controller = new AbortController();
  const source = sourceFor(deps, run);
  let cancellationCheckRunning = false;
  const cancellationWatch = setInterval(async () => {
    if (cancellationCheckRunning || controller.signal.aborted) return;
    cancellationCheckRunning = true;
    try {
      if (await source.getStateName(run.ticketId) === "Canceled") controller.abort();
    } catch {
      // Błąd odczytu nie anuluje deterministycznych testów.
    } finally {
      cancellationCheckRunning = false;
    }
  }, 2_000);
  cancellationWatch.unref();
  try {
    const defaultBranch = project.default_branch ?? "main";
    await execFileControlled("git", ["-C", project.repo, "fetch", "origin", defaultBranch], {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    const behind = await execFileControlled(
      "git",
      ["-C", checkout.dir, "merge-base", "--is-ancestor", `origin/${defaultBranch}`, "HEAD"],
      { signal: controller.signal }
    ).then(() => false).catch(() => true);
    if (behind) {
      await execFileControlled(
        "git",
        [
          "-C", checkout.dir,
          "-c", "user.name=ai-factory",
          "-c", "user.email=ai-factory@local.invalid",
          "merge", "--no-edit", `origin/${defaultBranch}`,
        ],
        { timeoutMs: 120_000, signal: controller.signal }
      ).catch((error) => {
        throw new Error(`BRANCH_CONFLICT: nie można zsynchronizować checkpointu z main.\n${error instanceof Error ? error.message : error}`);
      });
      const { stdout } = await execFileControlled(
        "git",
        ["-C", checkout.dir, "rev-parse", "HEAD"],
        { signal: controller.signal }
      );
      const synchronizedSha = stdout.trim();
      run = applyDecision(deps, run.ticketId, reduceLifecycle(run, {
        type: "branch-synchronized",
        previousSha: run.headSha!,
        sha: synchronizedSha,
      }));
    }
    const changedFiles = await changedFilesAtSha(
      project.repo,
      run.headSha!,
      project.default_branch ?? "main",
      controller.signal
    );
    const scope = auditScope(run.planFiles, changedFiles);
    if (scope.blocked.length) throw new Error(`Scope audit:\n${scope.blocked.join("\n")}`);
    const commands = allQualityCommands({ checks: project.checks, e2e: project.qa?.e2e });
    const results = await runQualityCommands(checkout.dir, commands, {
      env: cleanExecutionEnv(),
      timeoutMs: 20 * 60_000,
      signal: controller.signal,
    });
    const report = [
      `Exact SHA: ${run.headSha}`,
      ...results.map((result) => `✅ ${result.command} (${result.durationMs} ms)`),
      ...scope.warnings.map((warning) => `⚠️ ${warning}`),
    ].join("\n");
    deps.store.finishAttempt(run.ticketId, "test", attempt, {
      status: "success",
      outcome: "pass",
      report,
      durationMs: results.reduce((sum, item) => sum + item.durationMs, 0),
    });
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "test-result",
      ok: true,
      sha: run.headSha!,
      report,
    }));
  } catch (error) {
    const report = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted) {
      deps.store.finishAttempt(run.ticketId, "test", attempt, {
        status: "canceled",
        outcome: "canceled",
        report: "Testy przerwane po anulowaniu ticketu w Linear.",
        errorCode: "CANCELED",
        errorMessage: report,
      });
      applyDecision(deps, run.ticketId, reduceLifecycle(run, { type: "cancel" }));
      return;
    }
    deps.store.finishAttempt(run.ticketId, "test", attempt, {
      status: "failed",
      outcome: "fail",
      report,
      errorCode: "TEST_FAILED",
      errorMessage: report,
    });
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "test-result",
      ok: false,
      sha: run.headSha!,
      report,
    }));
  } finally {
    clearInterval(cancellationWatch);
    await removeCheckout(project.repo, checkout.dir);
  }
}

export function localExactShaCiResult(
  project: string,
  testedSha: string | undefined,
  headSha: string
): { outcome: "pass" | "fail"; report: string } | undefined {
  if (project !== "br-budget") return undefined;
  const passed = testedSha === headSha;
  return {
    outcome: passed ? "pass" : "fail",
    report: passed
      ? `br-budget: lokalny exact-SHA check przeszedł dla ${headSha}; branch protection jest niedostępna.`
      : `br-budget: brak lokalnego wyniku testów dla aktualnego PR head ${headSha}.`,
  };
}

async function reconcileCi(deps: PollerDependencies, run: LifecycleRun): Promise<void> {
  if (!run.prUrl || !run.headSha) return;
  const project = await getProject(run.project);
  const snapshot = await inspectPullRequestChecks(project.repo, run.prUrl);
  if (snapshot.headSha !== run.headSha) {
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "pr-head-changed",
      sha: snapshot.headSha,
    }));
    return;
  }
  const localCi = localExactShaCiResult(run.project, run.testedSha, run.headSha);
  if (localCi) {
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "ci-result",
      outcome: localCi.outcome,
      sha: run.headSha,
      report: localCi.report,
      nextReviewAttempt: deps.store.nextAttempt(run.ticketId, "review"),
    }));
    return;
  }
  const evaluation = evaluateGithubChecks(snapshot, project.ci?.requiredChecks ?? []);
  applyDecision(deps, run.ticketId, reduceLifecycle(run, {
    type: "ci-result",
    outcome: evaluation.outcome,
    sha: run.headSha,
    report: evaluation.report,
    nextReviewAttempt: deps.store.nextAttempt(run.ticketId, "review"),
  }));
}

async function reconcilePullRequest(deps: PollerDependencies, run: LifecycleRun): Promise<void> {
  if (!run.prUrl) return;
  const project = await getProject(run.project);
  const { stdout } = await execFileControlled(
    "gh",
    ["pr", "view", run.prUrl, "--json", "state,mergedAt,mergeCommit,headRefOid"],
    { cwd: project.repo, timeoutMs: 30_000 }
  );
  const pr = JSON.parse(stdout) as {
    state?: string;
    mergedAt?: string | null;
    mergeCommit?: { oid?: string } | null;
    headRefOid?: string;
  };
  if (pr.mergedAt) {
    await cancelActiveJobs(deps, run.ticketId);
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "pr-state",
      state: "merged",
      sha: pr.mergeCommit?.oid ?? pr.headRefOid ?? run.headSha ?? "",
    }));
  } else if (pr.state === "CLOSED") {
    await cancelActiveJobs(deps, run.ticketId);
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "pr-state",
      state: "closed",
      sha: pr.headRefOid ?? run.headSha ?? "",
    }));
  } else if (pr.headRefOid && pr.headRefOid !== run.headSha) {
    await cancelActiveJobs(deps, run.ticketId);
    applyDecision(deps, run.ticketId, reduceLifecycle(run, {
      type: "pr-head-changed",
      sha: pr.headRefOid,
    }));
  }
}

async function runSmoke(deps: PollerDependencies, run: LifecycleRun): Promise<void> {
  const project = await getProject(run.project);
  const checks = project.qa?.prodChecks;
  const result = checks?.length
    ? await runProdChecks(checks)
    : { ok: true, report: "Brak skonfigurowanego prod smoke.", skipped: true };
  applyDecision(deps, run.ticketId, reduceLifecycle(run, {
    type: "smoke-result",
    outcome: "skipped" in result && result.skipped
      ? "skipped-not-configured"
      : result.ok ? "pass" : "fail",
    report: result.report,
  }));
}

async function processCommands(deps: PollerDependencies, run: LifecycleRun): Promise<void> {
  const source = sourceFor(deps, run);
  const comments = await source.listComments(run.ticketId);
  for (const comment of comments) {
    if (deps.store.isCommentProcessed(comment.id) || comment.body.includes(marker(run.ticketId))) continue;
    const parsed = parseCommand(comment.body);
    if (!parsed) continue;
    let event: CoordinatorEvent | undefined;
    if (parsed.kind === "approve") event = {
      type: "approve",
      commentId: comment.id,
      nextAttempt: deps.store.nextAttempt(run.ticketId, "build"),
    };
    else if (parsed.kind === "reject") event = {
      type: "reject", commentId: comment.id, reason: parsed.payload ?? "bez powodu",
    };
    else if (parsed.kind === "answer" && parsed.payload) event = {
      type: "answer", commentId: comment.id, answer: parsed.payload,
    };
    else if (parsed.kind === "retry") {
      const blockedStage = run.blockedStage;
      const attemptStage = blockedStage === "test" ? "build" : blockedStage;
      event = {
        type: "retry",
        commentId: comment.id,
        nextAttempt: attemptStage
          ? deps.store.nextAttempt(run.ticketId, attemptStage)
          : undefined,
      };
    }
    else if (parsed.kind === "replan" || parsed.kind === "restart") event = {
      type: "replan", commentId: comment.id, reason: parsed.payload ?? "operator requested replan",
    };
    else if (parsed.kind === "done") event = { type: "ops-done", commentId: comment.id };
    if (!event) continue;
    try {
      if (event.type === "answer") {
        const ticket = await source.getTicket(run.ticketId);
        const snapshot = buildCommentContextSnapshot(
          run.ticketId,
          ticket.title,
          ticket.description,
          comments
        );
        event.inputHash = snapshot.effectiveInputHash;
        event.commentContext = snapshot.context || undefined;
        event.nextAttempt = deps.store.nextAttempt(run.ticketId, "plan");
      }
      if (event.type === "replan") {
        event.nextAttempt = deps.store.nextAttempt(run.ticketId, "plan");
        await cancelActiveJobs(deps, run.ticketId);
      }
      applyDecision(deps, run.ticketId, reduceLifecycle(run, event));
      deps.store.markCommentProcessed(run.ticketId, comment.id, parsed.kind);
      return;
    } catch (error) {
      await source.comment(
        run.ticketId,
        `ℹ️ Komenda \`${comment.body.split(/\s+/)[0]}\` jest teraz niedozwolona: ${error instanceof Error ? error.message : error}\n\n${marker(run.ticketId)}`
      );
      deps.store.markCommentProcessed(run.ticketId, comment.id, parsed.kind);
    }
  }
}

async function cancelActiveJobs(deps: PollerDependencies, ticketId: string): Promise<void> {
  for (const command of deps.store.outstandingCommands().filter(
    (item) => item.ticketId === ticketId && item.kind === "run-job" && item.externalId
  )) {
    await deps.mastra.cancelRun(command.externalId!).catch(() => {});
  }
}

async function detectInputChange(
  deps: PollerDependencies,
  run: LifecycleRun
): Promise<LifecycleRun> {
  const source = sourceFor(deps, run);
  const [ticket, comments] = await Promise.all([
    source.getTicket(run.ticketId),
    source.listComments(run.ticketId),
  ]);
  const snapshot = buildCommentContextSnapshot(
    run.ticketId,
    ticket.title,
    ticket.description,
    comments
  );
  if (snapshot.effectiveInputHash === run.manifest.inputHash) return run;
  await cancelActiveJobs(deps, run.ticketId);
  return applyDecision(deps, run.ticketId, reduceLifecycle(run, {
    type: "input-changed",
    inputHash: snapshot.effectiveInputHash,
    commentContext: snapshot.context || undefined,
    title: ticket.title,
    description: ticket.description,
    labels: ticket.labels,
    nextAttempt: deps.store.nextAttempt(run.ticketId, "plan"),
  }));
}

export async function reconcileRun(deps: PollerDependencies, run: LifecycleRun): Promise<void> {
  await processCommands(deps, run);
  let current = deps.store.getRun(run.ticketId);
  if (!current || current.status === "done") return;
  current = await detectInputChange(deps, current);
  const source = sourceFor(deps, current);
  const linearState = await source.getStateName(current.ticketId).catch(() => undefined);
  if (linearState === "Canceled") {
    const ticketId = current.ticketId;
    for (const command of deps.store.outstandingCommands().filter((item) => item.ticketId === ticketId)) {
      if (command.externalId) await deps.mastra.cancelRun(command.externalId).catch(() => {});
    }
    applyDecision(deps, current.ticketId, reduceLifecycle(current, { type: "cancel" }));
    return;
  }
  if (linearState === "Done" && !current.mergedSha && current.planDomain !== "ops") {
    if (current.prUrl) {
      await reconcilePullRequest(deps, current);
      const reconciled = deps.store.getRun(current.ticketId);
      if (reconciled?.mergedSha) {
        if (reconciled.stage === "smoke" && reconciled.status === "pending") {
          await runSmoke(deps, reconciled);
        }
        return;
      }
      if (reconciled?.errorCode === "PR_CLOSED_UNMERGED") return;
      if (reconciled) current = reconciled;
    }
    if (current.errorCode === "PREMATURE_DONE" && current.status === "blocked") return;
    applyDecision(deps, current.ticketId, {
      transition: {
        stage: current.stage,
        status: "blocked",
        actor: "linear",
        reason: "premature-done",
        patch: {
          blockedStage: current.stage,
          errorCode: "PREMATURE_DONE",
          errorMessage: "Linear ustawiono na Done przed merge śledzonego PR.",
        },
      },
      commands: [{
        key: `${current.ticketId}:g${current.generation}:premature-done`,
        ticketId: current.ticketId,
        kind: "linear-comment",
        stage: current.stage,
        payload: {
          body: "❌ **Done jest przedwczesne.** Śledzony PR nie został zmergowany; ticket został zablokowany bez utraty brancha.",
        },
      }],
    });
    return;
  }
  if (current.stage === "smoke" && current.status === "pending") await runSmoke(deps, current);
  else if (current.stage === "test" && current.status === "pending") await runExactShaTests(deps, current);
  else if (current.stage === "ci" && current.status === "waiting_external") await reconcileCi(deps, current);
  else if (current.prUrl) await reconcilePullRequest(deps, current);
}

async function claimReady(deps: PollerDependencies): Promise<void> {
  for (const [projectKey, source] of deps.sources) {
    const preflight = await runPreflight(projectKey, {
      linearStateNames: () => source.listStateNames(),
      mastraUp: () => deps.mastra.serverUp(),
    });
    if (!preflight.ok) {
      const message = preflight.errors.join("; ");
      if (reportedPreflight.get(projectKey) !== message) {
        console.error(`[${projectKey}] preflight failed: ${message}`);
        await notify(`🛑 ${projectKey}: preflight fabryki`, message).catch(() => {});
        reportedPreflight.set(projectKey, message);
      }
      continue;
    }
    reportedPreflight.delete(projectKey);
    const project = await getProject(projectKey);
    const active = deps.store.listActive().filter((run) => run.project === projectKey).length;
    const free = Math.max(0, (project.max_concurrent_tickets ?? Number.POSITIVE_INFINITY) - active);
    if (free <= 0) continue;
    const tickets = (await source.listReady()).slice(0, free);
    for (const ticket of tickets) {
      const existing = deps.store.getRun(ticket.id);
      if (existing && existing.status !== "done") {
        await source.claim(ticket.id);
        continue;
      }
      const comments = await source.listComments(ticket.id);
      const snapshot = buildCommentContextSnapshot(ticket.id, ticket.title, ticket.description, comments);
      const run = deps.store.createRun(ticket.id, projectKey, {
        title: ticket.title,
        description: ticket.description,
        labels: ticket.labels,
        url: ticket.url,
        inputHash: snapshot.effectiveInputHash,
        commentContext: snapshot.context || undefined,
      });
      await source.claim(ticket.id);
      applyDecision(deps, ticket.id, reduceLifecycle(run, {
        type: "start",
        nextAttempt: deps.store.nextAttempt(ticket.id, "plan"),
      }));
    }
  }
}

export async function pollOnce(deps: PollerDependencies): Promise<void> {
  await dispatchOutbox(deps);
  for (const run of deps.store.listActive()) {
    await reconcileRun(deps, run).catch((error) =>
      console.error(`[${run.ticketId}] reconcile:`, error instanceof Error ? error.message : error)
    );
  }
  await claimReady(deps);
  await dispatchOutbox(deps);
}

function loadDotEnv(): void {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // env procesu jest wystarczający.
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error("Brak LINEAR_API_KEY.");
  const projects = (process.env.LINEAR_PROJECTS ?? process.env.LINEAR_PROJECT ?? "pilot-app")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const deps: PollerDependencies = {
    store: new LifecycleStore(),
    mastra: new MastraWorkflowClient(process.env.FACTORY_API ?? "http://localhost:4111/api", "factoryJob"),
    sources: new Map(projects.map((project) => [project, new LinearSource(apiKey, project)])),
  };
  const once = process.argv.includes("--once");
  do {
    await pollOnce(deps).catch((error) =>
      console.error("Poll v2 nieudany:", error instanceof Error ? error.message : error)
    );
    if (!once) await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  } while (!once);
  deps.store.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
