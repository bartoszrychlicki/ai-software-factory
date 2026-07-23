import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { engineEnv } from "../engines/env";

const exec = promisify(execFile);

export interface QualityCommandResult {
  command: string;
  durationMs: number;
}

export class QualityGateError extends Error {
  constructor(
    readonly command: string,
    readonly outputTail: string,
    readonly durationMs: number,
    cause?: unknown
  ) {
    super(`Check "${command}" nie przeszedł${outputTail ? `:\n${outputTail}` : ""}`, { cause });
    this.name = "QualityGateError";
  }
}

export function cleanExecutionEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...engineEnv(source), CI: source.CI ?? "true" };
}

/** Jedno wykonanie deterministycznych checks; ten sam runner jest używany w verify, merge-queue i remediation. */
export async function runQualityCommands(
  cwd: string,
  commands: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<QualityCommandResult[]> {
  const results: QualityCommandResult[] = [];
  for (const command of commands) {
    const startedAt = Date.now();
    try {
      await exec("bash", ["-c", command], {
        cwd,
        env: options.env ?? cleanExecutionEnv(),
        timeout: options.timeoutMs ?? 20 * 60_000,
        maxBuffer: 50 * 1024 * 1024,
      });
      results.push({ command, durationMs: Date.now() - startedAt });
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string };
      const tail = [e.stdout, e.stderr].filter(Boolean).join("\n").slice(-4000);
      throw new QualityGateError(command, tail, Date.now() - startedAt, err);
    }
  }
  return results;
}

export function allQualityCommands(ticket: { checks?: string[]; e2e?: string }): string[] {
  return [...(ticket.checks ?? []), ...(ticket.e2e ? [ticket.e2e] : [])];
}

async function mergeBaseWith(workspaceDir: string, defaultBranch: string): Promise<string> {
  await exec("git", ["-C", workspaceDir, "fetch", "origin", defaultBranch]);
  const { stdout } = await exec("git", [
    "-C",
    workspaceDir,
    "merge-base",
    "HEAD",
    `origin/${defaultBranch}`,
  ]);
  return stdout.trim();
}

/** Pełny diff PR-a względem aktualnej bazy, niezależnie od liczby fix commitów i merge commitów. */
export async function fullBranchDiff(workspaceDir: string, defaultBranch: string): Promise<string> {
  const base = await mergeBaseWith(workspaceDir, defaultBranch);
  const { stdout: diff } = await exec(
    "git",
    ["-C", workspaceDir, "diff", "--no-ext-diff", "--find-renames", `${base}...HEAD`],
    { maxBuffer: 20 * 1024 * 1024 }
  );
  return diff;
}

export interface ChangeManifest {
  base: string;
  nameStatus: string;
  diffStat: string;
}

/** Kompaktowy, kompletny manifest zmian dla verifiera czytającego pliki z checkoutu. */
export async function changeManifest(
  workspaceDir: string,
  defaultBranch: string
): Promise<ChangeManifest> {
  const base = await mergeBaseWith(workspaceDir, defaultBranch);
  const diffRange = `${base}...HEAD`;
  const [{ stdout: nameStatus }, { stdout: diffStat }] = await Promise.all([
    exec(
      "git",
      ["-C", workspaceDir, "diff", "--no-ext-diff", "--find-renames", "--name-status", diffRange],
      { maxBuffer: 20 * 1024 * 1024 }
    ),
    exec(
      "git",
      ["-C", workspaceDir, "diff", "--no-ext-diff", "--find-renames", "--stat", diffRange],
      { maxBuffer: 20 * 1024 * 1024 }
    ),
  ]);
  return {
    base,
    nameStatus: nameStatus.trimEnd(),
    diffStat: diffStat.trimEnd(),
  };
}
