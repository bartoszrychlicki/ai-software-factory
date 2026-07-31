import type { EngineAdapter, EngineRunInput, EngineRunResult } from "./types";
import { engineEnv } from "./env";
import { cliVersion } from "./version";
import { execFileControlled } from "../pipeline/process-control";

const KIMI_BIN = process.env.KIMI_BIN ?? "kimi";

/**
 * Kimi Code CLI (subskrypcja) w trybie headless: `kimi -p <prompt>`.
 * UWAGA: tryb -p ZAWSZE auto-zatwierdza akcje (w tym zapisy plików) i nie łączy
 * się z --plan/--yolo/--auto — nie istnieje read-only. Dlatego kimi-code
 * obsługuje WYŁĄCZNIE rolę build (fail-closed dla pozostałych).
 * Kosztu nie raportujemy — text mode Kimi nie zwraca usage.
 */
export const kimiCode: EngineAdapter = {
  name: "kimi-code",

  version: () => cliVersion(KIMI_BIN),

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    if (input.role !== "build") {
      return {
        ok: false,
        report: `kimi-code obsługuje wyłącznie rolę build — tryb headless nie ma read-only, a rola "${input.role}" go wymaga. Popraw routing.`,
      };
    }
    if (process.env.FACTORY_ALLOW_UNSANDBOXED_KIMI !== "1") {
      return {
        ok: false,
        report:
          "kimi-code jest niesandboxowany i domyślnie wyłączony. Użyj sandboxowanego buildera albo ustaw świadomie FACTORY_ALLOW_UNSANDBOXED_KIMI=1 dla zaufanego projektu.",
      };
    }
    const prompt = `${input.instructions}\n\n${input.context}`;

    const args: string[] = [];
    if (input.model) args.push("-m", input.model);
    args.push("--output-format", "text", "-p", prompt);

    try {
      const { stdout, stderr } = await execFileControlled(KIMI_BIN, args, {
        cwd: input.workspace,
        env: engineEnv(),
        signal: input.signal,
        timeoutMs: input.budget.minutes * 60_000,
      });
      const report = stdout.trim();
      const ok = report.length > 0;
      return {
        ok,
        report,
        stderr,
        terminationReason: ok ? undefined : "empty-report",
        raw: { stderr },
      };
    } catch (error) {
      const detail = error as Error & {
        stdout?: string;
        stderr?: string;
        terminationReason?: "abort" | "timeout";
      };
      const report = detail.stdout?.trim() ?? "";
      return {
        ok: false,
        report: report || `Proces zakończył się błędem: ${detail.message}\n${detail.stderr ?? ""}`,
        stderr: detail.stderr,
        terminationReason: detail.terminationReason ?? "process-error",
        raw: { stdout: detail.stdout, stderr: detail.stderr },
      };
    }
  },
};
