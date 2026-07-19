import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineAdapter, EngineRunInput, EngineRunResult } from "./types";

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";

export const codex: EngineAdapter = {
  name: "codex",

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    const prompt = `${input.instructions}\n\n${input.context}`;

    // codex pisze finalną odpowiedź do pliku — czystszy odbiór niż parsowanie stdout
    const outDir = await mkdtemp(join(tmpdir(), "codex-run-"));
    const lastMsg = join(outDir, "last.txt");

    // mapowanie ról na wbudowany sandbox Codexa
    const sandbox = input.role === "build" ? "workspace-write" : "read-only";

    const args = ["exec", "--sandbox", sandbox, "--output-last-message", lastMsg];
    if (input.model) args.push("--model", input.model);
    args.push(prompt);

    return new Promise((resolve) => {
      const child = execFile(
        CODEX_BIN,
        args,
        {
          cwd: input.workspace,
          timeout: input.budget.minutes * 60_000,
          maxBuffer: 50 * 1024 * 1024,
        },
        async (error, stdout, stderr) => {
          let report = "";
          try {
            report = await readFile(lastMsg, "utf8");
          } catch {}
          await rm(outDir, { recursive: true, force: true });

          if (error) {
            resolve({
              ok: false,
              report: report || `Proces zakończył się błędem: ${error.message}\n${stderr}`,
              raw: { stdout, stderr },
            });
            return;
          }
          resolve({ ok: report.trim().length > 0, report, raw: { stdout } });
        }
      );

      // codex exec czyta stdin, gdy jest pipe — bez EOF czekałby aż ubije go timeout
      child.stdin?.end();
    });
  },
};