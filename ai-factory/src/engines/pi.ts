import { execFile } from "node:child_process";
import type { EngineAdapter, EngineRunInput, EngineRunResult } from "./types";
import { engineEnv } from "./env";

const PI_BIN = process.env.PI_BIN ?? "pi";
const PI_PROVIDER = "lm-studio";

/**
 * Pi z lokalnym modelem przez LM Studio. Adapter obsługuje wyłącznie verify,
 * wymaga jawnego modelu i udostępnia agentowi tylko narzędzia read-only.
 */
export const pi: EngineAdapter = {
  name: "pi",

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

    return new Promise((resolve) => {
      const child = execFile(
        PI_BIN,
        args,
        {
          cwd: input.workspace,
          timeout: input.budget.minutes * 60_000,
          maxBuffer: 50 * 1024 * 1024,
          env: engineEnv(),
        },
        (error, stdout, stderr) => {
          const report = stdout.trim();
          if (error) {
            resolve({
              ok: false,
              report: report || `Proces pi zakończył się błędem: ${error.message}\n${stderr}`,
              raw: { stdout, stderr },
            });
            return;
          }
          resolve({ ok: report.length > 0, report, raw: { stderr } });
        }
      );

      child.stdin?.write(prompt);
      child.stdin?.end();
    });
  },
};
