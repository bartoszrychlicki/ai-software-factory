import { execFile } from "node:child_process";
import type { EngineAdapter, EngineRunInput, EngineRunResult } from "./types";

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

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    if (input.role !== "build") {
      return {
        ok: false,
        report: `kimi-code obsługuje wyłącznie rolę build — tryb headless nie ma read-only, a rola "${input.role}" go wymaga. Popraw routing.`,
      };
    }
    const prompt = `${input.instructions}\n\n${input.context}`;

    const args: string[] = [];
    if (input.model) args.push("-m", input.model);
    args.push("--output-format", "text", "-p", prompt);

    return new Promise((resolve) => {
      const child = execFile(
        KIMI_BIN,
        args,
        {
          cwd: input.workspace,
          timeout: input.budget.minutes * 60_000,
          maxBuffer: 50 * 1024 * 1024,
          env: process.env,
        },
        (error, stdout, stderr) => {
          const report = stdout.trim();
          if (error) {
            resolve({
              ok: false,
              report: report || `Proces zakończył się błędem: ${error.message}\n${stderr}`,
              raw: { stdout, stderr },
            });
            return;
          }
          resolve({ ok: report.length > 0, report, raw: { stderr } });
        }
      );

      // defensywnie jak codex: bez EOF na stdin niektóre CLI czekają w nieskończoność
      child.stdin?.end();
    });
  },
};
