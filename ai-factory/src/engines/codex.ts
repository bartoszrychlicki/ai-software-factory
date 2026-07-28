import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineAdapter, EngineRunInput, EngineRunResult } from "./types";
import { engineEnv } from "./env";
import { execFileControlled } from "../pipeline/process-control";

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

    // prompt przez STDIN, nie argv — argv ma limit (~1 MB) i spawn E2BIG ubił BAR-91,
    // gdy feedback z poprzedniej próby rozdął prompt
    const args = ["exec", "--sandbox", sandbox, "--output-last-message", lastMsg];
    if (input.model) args.push("--model", input.model);
    if (input.effort) args.push("-c", `model_reasoning_effort="${input.effort}"`);
    args.push("-"); // czytaj prompt ze stdin

    let stdout = "";
    let stderr = "";
    let processError: unknown;
    try {
      ({ stdout, stderr } = await execFileControlled(CODEX_BIN, args, {
        cwd: input.workspace,
        env: engineEnv(),
        input: prompt,
        signal: input.signal,
        timeoutMs: input.budget.minutes * 60_000,
      }));
    } catch (error) {
      processError = error;
      const detail = error as { stdout?: string; stderr?: string };
      stdout = detail.stdout ?? "";
      stderr = detail.stderr ?? "";
    }
    let report = "";
    try {
      report = await readFile(lastMsg, "utf8");
    } catch {}
    await rm(outDir, { recursive: true, force: true });
    if (processError) {
      const reason = (processError as { terminationReason?: string }).terminationReason ?? "process-error";
      return {
        ok: false,
        report: report || `Proces codex zakończył się błędem (${reason}). stderr:\n${stderr.slice(-2000)}`,
        raw: { stderr: stderr.slice(-5000) },
      };
    }
    return { ok: report.trim().length > 0, report, raw: { stdout: stdout.slice(-5000) } };
  },
};
