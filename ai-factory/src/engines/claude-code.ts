import { execFile } from "node:child_process";
import type { EngineAdapter, EngineRunInput, EngineRunResult } from "./types";
import { engineEnv } from "./env";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

export const claudeCode: EngineAdapter = {
  name: "claude-code",

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    // handoff: rola dostaje instrukcje + kontekst poprzednika, nie cały transcript
    const prompt = `${input.instructions}\n\n${input.context}`;

    // stream-json: dostajemy KAŻDĄ wiadomość agenta, nie tylko ostatnią — inaczej
    // werdykt oddany w wiadomości pośredniej przepada (BAR-108/130/150)
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];

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

    return new Promise((resolve) => {
      execFile(
        CLAUDE_BIN,
        args,
        {
          cwd: input.workspace,                    // świat agenta = worktree
          timeout: input.budget.minutes * 60_000,  // budżet = twardy limit
          maxBuffer: 50 * 1024 * 1024,             // JSON bywa duży
          env: engineEnv(),
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
          // JSONL: zbieramy tekst wszystkich wiadomości agenta + zdarzenie końcowe
          const texts: string[] = [];
          let final: { is_error?: boolean; result?: string; total_cost_usd?: number } | undefined;
          for (const line of stdout.split("\n")) {
            if (!line.trim()) continue;
            try {
              const ev = JSON.parse(line) as {
                type?: string;
                message?: { content?: { type?: string; text?: string }[] };
                is_error?: boolean;
                result?: string;
                total_cost_usd?: number;
              };
              if (ev.type === "assistant") {
                const text = (ev.message?.content ?? [])
                  .filter((c) => c.type === "text" && c.text)
                  .map((c) => c.text as string)
                  .join("\n");
                if (text.trim()) texts.push(text);
              } else if (ev.type === "result") {
                final = ev;
              }
            } catch {
              /* linia nie-JSON — pomijamy */
            }
          }
          const report = final?.result ?? texts.at(-1) ?? "";
          if (!report && !texts.length) {
            resolve({ ok: false, report: `Brak treści od agenta:\n${stdout.slice(0, 2000)}`, raw: { stderr } });
            return;
          }
          // Sam częściowy stdout NIE jest sukcesem. Timeout/buffer overflow potrafi
          // zostawić kilka wiadomości bez końcowego eventu `result` (BAR-28); dawniej
          // `!final?.is_error` dawało wtedy true i builder commitował pół implementacji.
          const ok = !error && !!final && !final.is_error;
          resolve({
            ok,
            report,
            transcript: texts.join("\n\n"),
            costUsd: final?.total_cost_usd,
            raw: { events: texts.length, error: error ? String(error) : undefined },
          });
        }
      );
    });
  },
};
