import type { EngineAdapter, EngineRunInput, EngineRunResult } from "./types";
import { engineEnv } from "./env";
import { cliVersion } from "./version";
import { execFileControlled } from "../pipeline/process-control";

const PI_BIN = process.env.PI_BIN ?? "pi";
const PI_PROVIDER = "lm-studio";

/**
 * Pi z lokalnym modelem przez LM Studio. Adapter obsługuje wyłącznie verify,
 * wymaga jawnego modelu i udostępnia agentowi tylko narzędzia read-only.
 */
export const pi: EngineAdapter = {
  name: "pi",
  verifyContextMode: "workspace",

  version: () => cliVersion(PI_BIN),

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    if (input.role !== "verify") {
      return {
        ok: false,
        report: "pi engine: rola nieobsługiwana (tylko verify)",
      };
    }
    if (!input.model) {
      return {
        ok: false,
        report: "pi engine: wymagany jawny model",
      };
    }

    const prompt = `${input.instructions}\n\n${input.context}`;
    const args = [
      "-p",
      "--provider",
      PI_PROVIDER,
      "--model",
      input.model,
      "--no-session",
      "--tools",
      "read,grep,find,ls",
      "--exclude-tools",
      "ask_question",
    ];

    try {
      const { stdout, stderr } = await execFileControlled(PI_BIN, args, {
        cwd: input.workspace,
        env: engineEnv(),
        input: prompt,
        signal: input.signal,
        timeoutMs: input.budget.minutes * 60_000,
      });
      const report = stdout.trim();
      return { ok: report.length > 0, report, raw: { stderr } };
    } catch (error) {
      const detail = error as Error & {
        stdout?: string;
        stderr?: string;
        terminationReason?: "abort" | "timeout";
      };
      const timedOut = detail.terminationReason === "timeout";
      const report = detail.stdout?.trim() ?? "";
      return {
        ok: false,
        report: timedOut
          ? `Pi: timeout po budżecie ${input.budget.minutes} min (grupa procesów zakończona)`
          : report || `Proces pi zakończył się błędem: ${detail.message}\n${detail.stderr ?? ""}`,
        raw: {
          stdout: detail.stdout,
          stderr: detail.stderr,
          errorKind: timedOut ? "timeout" : detail.terminationReason === "abort" ? "abort" : "process-error",
          budgetMinutes: input.budget.minutes,
          errorCode: null,
          signal: detail.terminationReason ? "SIGTERM" : null,
        },
      };
    }
  },
};
