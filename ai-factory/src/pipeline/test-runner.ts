/**
 * Detached runner testów exact-SHA: osobny proces, żeby 20-minutowe checks
 * nie blokowały pętli pollera. Zero dostępu do Lineara i lifecycle.db —
 * wejście z pliku JSON, wynik atomowo (tmp+rename) do pliku JSON; poller
 * czyta wynik w swoim tempie i aplikuje przejścia.
 *
 * CLI: tsx src/pipeline/test-runner.ts <inputPath> <resultPath>
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { getProject } from "./projects";
import { createCheckout, removeCheckout } from "./workspace";
import { auditScope, changedFilesAtSha } from "./scope";
import { allQualityCommands, cleanExecutionEnv, runQualityCommands } from "./quality";
import { execFileControlled } from "./process-control";

export interface TestRunnerInput {
  ticketId: string;
  project: string;
  sha: string;
  attempt: number;
  planFiles: string[];
}

export interface TestRunnerResult {
  ok: boolean;
  requestedSha: string;
  /** SHA po ewentualnej synchronizacji z origin/<default> (merge main → branch). */
  finalSha: string;
  report: string;
  durationMs: number;
}

export async function runDetachedTests(input: TestRunnerInput): Promise<TestRunnerResult> {
  const startedAt = Date.now();
  const project = await getProject(input.project);
  const defaultBranch = project.default_branch ?? "main";
  const checkout = await createCheckout(
    project.repo,
    input.sha,
    `${input.ticketId}-test-${input.attempt}`
  );
  let finalSha = input.sha;
  try {
    await execFileControlled("git", ["-C", project.repo, "fetch", "origin", defaultBranch], {
      timeoutMs: 60_000,
    });
    const behind = await execFileControlled(
      "git",
      ["-C", checkout.dir, "merge-base", "--is-ancestor", `origin/${defaultBranch}`, "HEAD"]
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
        { timeoutMs: 120_000 }
      ).catch((error) => {
        throw new Error(`BRANCH_CONFLICT: nie można zsynchronizować checkpointu z main.\n${error instanceof Error ? error.message : error}`);
      });
      const { stdout } = await execFileControlled("git", ["-C", checkout.dir, "rev-parse", "HEAD"]);
      finalSha = stdout.trim();
    }
    const changedFiles = await changedFilesAtSha(
      checkout.dir,
      finalSha,
      defaultBranch
    );
    const scope = auditScope(input.planFiles, changedFiles, project.scope?.protected ?? []);
    if (scope.blocked.length) throw new Error(`Scope audit:\n${scope.blocked.join("\n")}`);
    const commands = allQualityCommands({
      checks: project.checks,
      e2e: project.qa?.e2e,
      semgrep: project.security?.semgrep,
    });
    const results = await runQualityCommands(checkout.dir, commands, {
      env: cleanExecutionEnv(),
      timeoutMs: 20 * 60_000,
    });
    const report = [
      `Exact SHA: ${finalSha}`,
      ...results.map((result) => `✅ ${result.command} (${result.durationMs} ms)`),
      ...scope.warnings.map((warning) => `⚠️ ${warning}`),
    ].join("\n");
    return {
      ok: true,
      requestedSha: input.sha,
      finalSha,
      report,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      requestedSha: input.sha,
      finalSha,
      report: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await removeCheckout(project.repo, checkout.dir);
  }
}

export function writeResultAtomically(resultPath: string, result: TestRunnerResult): void {
  mkdirSync(dirname(resultPath), { recursive: true });
  const tmp = `${resultPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(result, null, 2));
  renameSync(tmp, resultPath);
}

async function main(): Promise<void> {
  const [inputPath, resultPath] = process.argv.slice(2);
  if (!inputPath || !resultPath) {
    throw new Error("Użycie: test-runner.ts <inputPath> <resultPath>");
  }
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as TestRunnerInput;
  const result = await runDetachedTests(input);
  writeResultAtomically(resultPath, result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
