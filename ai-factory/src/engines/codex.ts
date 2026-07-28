import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineAdapter, EngineRunInput, EngineRunResult } from "./types";
import { engineEnv } from "./env";
import { estimateCostUsd, type TokenUsage } from "./pricing";
import { cliVersion } from "./version";
import { execFileControlled } from "../pipeline/process-control";

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";

/**
 * Zużycie tokenów ze strumienia `codex exec --json` — jedyne źródło; codex
 * nie raportuje kosztu wprost. Obsługiwane kształty eventów:
 *  - `turn.completed` z per-turnowym `usage` (codex-cli ≥0.145, zweryfikowane
 *    2026-07-29) — sumujemy po turach,
 *  - `token_count` z kumulatywnym `info.total_token_usage` (starszy strumień
 *    protokołowy) — bierzemy ostatni.
 */
export function extractTokenUsage(stdout: string): TokenUsage | undefined {
  let cumulative: TokenUsage | undefined;
  let summed: TokenUsage | undefined;
  const addTurn = (usage: TokenUsage) => {
    summed = {
      input_tokens: (summed?.input_tokens ?? 0) + (usage.input_tokens ?? 0),
      cached_input_tokens: (summed?.cached_input_tokens ?? 0) + (usage.cached_input_tokens ?? 0),
      output_tokens: (summed?.output_tokens ?? 0) + (usage.output_tokens ?? 0),
    };
  };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        usage?: TokenUsage;
        info?: { total_token_usage?: TokenUsage };
        msg?: { type?: string; info?: { total_token_usage?: TokenUsage } };
      };
      if (event.type === "turn.completed" && event.usage) {
        addTurn(event.usage);
        continue;
      }
      const total = event.type === "token_count"
        ? event.info?.total_token_usage
        : event.msg?.type === "token_count"
          ? event.msg.info?.total_token_usage
          : undefined;
      if (total) cumulative = total;
    } catch {
      // linia nie-JSON (np. banner CLI)
    }
  }
  return cumulative ?? summed;
}

export const codex: EngineAdapter = {
  name: "codex",

  version: () => cliVersion(CODEX_BIN),

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    const prompt = `${input.instructions}\n\n${input.context}`;

    // codex pisze finalną odpowiedź do pliku — czystszy odbiór niż parsowanie stdout
    const outDir = await mkdtemp(join(tmpdir(), "codex-run-"));
    const lastMsg = join(outDir, "last.txt");

    // mapowanie ról na wbudowany sandbox Codexa
    const sandbox = input.role === "build" ? "workspace-write" : "read-only";

    // prompt przez STDIN, nie argv — argv ma limit (~1 MB) i spawn E2BIG ubił BAR-91,
    // gdy feedback z poprzedniej próby rozdął prompt.
    // --json: eventy token_count dają zużycie tokenów do estymaty kosztu.
    const args = ["exec", "--json", "--sandbox", sandbox, "--output-last-message", lastMsg];
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
    const usage = extractTokenUsage(stdout);
    const costUsd = usage ? estimateCostUsd(input.model, usage) : undefined;
    const costSource = costUsd !== undefined ? "estimated-tokens" as const : undefined;
    if (processError) {
      const reason = (processError as { terminationReason?: string }).terminationReason ?? "process-error";
      return {
        ok: false,
        report: report || `Proces codex zakończył się błędem (${reason}). stderr:\n${stderr.slice(-2000)}`,
        costUsd,
        costSource,
        raw: { stderr: stderr.slice(-5000) },
      };
    }
    return {
      ok: report.trim().length > 0,
      report,
      costUsd,
      costSource,
      raw: { stdout: stdout.slice(-5000), tokenUsage: usage },
    };
  },
};
