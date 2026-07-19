import { execFile } from "node:child_process";
import type { EngineAdapter, EngineRunInput, EngineRunResult } from "./types";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

export const claudeCode: EngineAdapter = {
  name: "claude-code",

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    // handoff: rola dostaje instrukcje + kontekst poprzednika, nie cały transcript
    const prompt = `${input.instructions}\n\n${input.context}`;

    const args = ["-p", prompt, "--output-format", "json"];

    // najmniejsze uprawnienia: plan i verify nie mogą pisać
    if (input.role === "build") {
      args.push("--permission-mode", "acceptEdits");
    } else {
      args.push("--allowedTools", "Read,Glob,Grep");
    }

    if (input.model) {
      args.push("--model", input.model);
    }

    return new Promise((resolve) => {
      execFile(
        CLAUDE_BIN,
        args,
        {
          cwd: input.workspace,                    // świat agenta = worktree
          timeout: input.budget.minutes * 60_000,  // budżet = twardy limit
          maxBuffer: 50 * 1024 * 1024,             // JSON bywa duży
        },
        (error, stdout, stderr) => {
          if (error && !stdout) {
            resolve({
              ok: false,
              report: `Proces zakończył się błędem: ${error.message}\n${stderr}`,
              raw: { error: String(error) },
            });
            return;
          }
          try {
            const out = JSON.parse(stdout);
            resolve({
              ok: !out.is_error,
              report: out.result ?? "",
              costUsd: out.total_cost_usd,
              raw: out,
            });
          } catch {
            resolve({
              ok: false,
              report: `Nieparsowalny output:\n${stdout.slice(0, 2000)}`,
              raw: { stdout, stderr },
            });
          }
        }
      );
    });
  },
};