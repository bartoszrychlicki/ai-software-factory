import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GithubCheckRun {
  name: string;
  status: string;
  conclusion: string;
  workflowName?: string;
}

export interface GithubCheckSnapshot {
  headSha: string;
  checks: GithubCheckRun[];
}

export interface GithubCheckEvaluation {
  outcome: "pass" | "pending" | "fail";
  report: string;
}

interface RawCheckRun {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  state?: string;
  conclusion?: string;
  workflowName?: string;
}

export function evaluateGithubChecks(
  snapshot: GithubCheckSnapshot,
  requiredChecks: string[]
): GithubCheckEvaluation {
  const required = [...new Set(requiredChecks.map((name) => name.trim()).filter(Boolean))];
  if (!required.length) {
    return { outcome: "fail", report: "Brak skonfigurowanych wymaganych GitHub checks." };
  }

  const lines: string[] = [];
  let pending = false;
  let failed = false;
  for (const requiredName of required) {
    const matching = snapshot.checks.filter((check) => check.name === requiredName);
    if (!matching.length) {
      pending = true;
      lines.push(`⏳ ${requiredName}: check jeszcze nie istnieje`);
      continue;
    }
    for (const check of matching) {
      const status = check.status.toUpperCase();
      const conclusion = check.conclusion.toUpperCase();
      if (status !== "COMPLETED") {
        pending = true;
        lines.push(`⏳ ${requiredName}: ${status || "PENDING"}`);
      } else if (conclusion === "SUCCESS") {
        lines.push(`✅ ${requiredName}: SUCCESS`);
      } else {
        failed = true;
        lines.push(`❌ ${requiredName}: ${conclusion || "BRAK WERDYKTU"}`);
      }
    }
  }
  return { outcome: failed ? "fail" : pending ? "pending" : "pass", report: lines.join("\n") };
}

export async function inspectPullRequestChecks(cwd: string, pr: string): Promise<GithubCheckSnapshot> {
  const { stdout } = await exec(
    "gh",
    ["pr", "view", pr, "--json", "headRefOid,statusCheckRollup"],
    { cwd, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 }
  );
  const raw = JSON.parse(stdout) as { headRefOid?: string; statusCheckRollup?: RawCheckRun[] };
  return {
    headSha: raw.headRefOid ?? "",
    checks: (raw.statusCheckRollup ?? []).map((check) => {
      const legacyState = check.state?.toUpperCase() ?? "";
      const legacyPending = legacyState === "PENDING" || legacyState === "EXPECTED";
      return {
        name: check.name ?? check.context ?? "",
        status: check.status ?? (legacyPending ? "IN_PROGRESS" : legacyState ? "COMPLETED" : ""),
        conclusion: check.conclusion ?? (legacyPending ? "" : legacyState),
        workflowName: check.workflowName,
      };
    }),
  };
}

export async function waitForGithubChecks(options: {
  cwd: string;
  pr: string;
  expectedSha: string;
  requiredChecks: string[];
  timeoutMs: number;
  pollMs?: number;
  inspect?: (cwd: string, pr: string) => Promise<GithubCheckSnapshot>;
  pause?: (ms: number) => Promise<void>;
}): Promise<GithubCheckEvaluation> {
  const inspect = options.inspect ?? inspectPullRequestChecks;
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + options.timeoutMs;
  let last: GithubCheckEvaluation = { outcome: "pending", report: "GitHub CI jeszcze nie wystartowało." };

  while (true) {
    const snapshot = await inspect(options.cwd, options.pr);
    if (!snapshot.headSha) throw new Error(`GitHub nie zwrócił head SHA dla PR ${options.pr}.`);
    if (snapshot.headSha !== options.expectedSha) {
      throw new Error(
        `PR head zmienił się podczas gate'u CI: oczekiwano ${options.expectedSha}, GitHub ma ${snapshot.headSha}.`
      );
    }
    last = evaluateGithubChecks(snapshot, options.requiredChecks);
    if (last.outcome === "pass") return last;
    if (last.outcome === "fail") throw new Error(`GitHub CI nie przeszło dla ${options.expectedSha}:\n${last.report}`);
    if (Date.now() >= deadline) {
      throw new Error(`Timeout GitHub CI dla ${options.expectedSha}:\n${last.report}`);
    }
    await pause(options.pollMs ?? 10_000);
  }
}
