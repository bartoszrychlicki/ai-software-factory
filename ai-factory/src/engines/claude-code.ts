import type { EngineAdapter, EngineRunInput, EngineRunResult } from "./types";
import { engineEnv } from "./env";
import { execFileControlled } from "../pipeline/process-control";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

export const claudeCode: EngineAdapter = {
  name: "claude-code",

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    // handoff: rola dostaje instrukcje + kontekst poprzednika, nie cały transcript
    const prompt = `${input.instructions}\n\n${input.context}`;

    // stream-json: dostajemy KAŻDĄ wiadomość agenta, nie tylko ostatnią — inaczej
    // werdykt oddany w wiadomości pośredniej przepada (BAR-108/130/150)
    const args = input.sessionId
      ? ["--resume", input.sessionId, "-p", prompt, "--output-format", "stream-json", "--verbose"]
      : ["-p", prompt, "--output-format", "stream-json", "--verbose"];

    // najmniejsze uprawnienia: plan i verify nie mogą pisać
    if (input.role === "build") {
      args.push("--permission-mode", "acceptEdits");
    } else {
      args.push("--allowedTools", "Read,Glob,Grep");
    }

    if (input.model) {
      args.push("--model", input.model);
    }
    if (input.effort) {
      args.push("--effort", input.effort);
    }

    let stdout = "";
    let stderr = "";
    let processError: unknown;
    try {
      ({ stdout, stderr } = await execFileControlled(CLAUDE_BIN, args, {
        cwd: input.workspace,
        env: engineEnv(),
        signal: input.signal,
        timeoutMs: input.budget.minutes * 60_000,
      }));
    } catch (error) {
      processError = error;
      const detail = error as { stdout?: string; stderr?: string };
      stdout = detail.stdout ?? "";
      stderr = detail.stderr ?? "";
    }
    if (processError && !stdout) {
      return {
        ok: false,
        report: `Proces zakończył się błędem: ${processError instanceof Error ? processError.message : processError}\n${stderr}`,
        raw: { error: String(processError) },
      };
    }
    const texts: string[] = [];
    let sessionId: string | undefined;
    let final: { is_error?: boolean; result?: string; total_cost_usd?: number; session_id?: string } | undefined;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as {
          type?: string;
          message?: { content?: { type?: string; text?: string }[] };
          is_error?: boolean;
          result?: string;
          total_cost_usd?: number;
          subtype?: string;
          session_id?: string;
        };
        if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
          sessionId = ev.session_id;
        } else if (ev.type === "assistant") {
          const text = (ev.message?.content ?? [])
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text as string)
            .join("\n");
          if (text.trim()) texts.push(text);
        } else if (ev.type === "result") {
          final = ev;
          if (ev.session_id) sessionId = ev.session_id;
        }
      } catch {
        // linia nie-JSON
      }
    }
    const report = final?.result ?? texts.at(-1) ?? "";
    if (!report && !texts.length) {
      return { ok: false, report: `Brak treści od agenta:\n${stdout.slice(0, 2000)}`, raw: { stderr } };
    }
    return {
      ok: !processError && !!final && !final.is_error,
      report,
      transcript: texts.join("\n\n"),
      costUsd: final?.total_cost_usd,
      sessionId,
      raw: { events: texts.length, error: processError ? String(processError) : undefined },
    };
  },
};
