export type Role = "plan" | "build" | "verify" | "review";

export interface EngineRunInput {
  role: Role;
  instructions: string;   // prompt roli (z profiles/)
  workspace: string;      // ścieżka worktree
  context: string;        // handoff od poprzedniego etapu
  budget: { minutes: number };
  model?: string;          // np. claude-fable-5, gpt-5.6-sol
  effort?: string;         // reasoning effort: low/medium/high/xhigh (mapowany per CLI)
}

export interface EngineRunResult {
  ok: boolean;
  report: string;         // plan / raport buildu / werdykt verify
  costUsd?: number;
  raw?: unknown;
}

/** Silnik = headless CLI (subskrypcja). Nowy silnik = nowy adapter, zero zmian w pipeline. */
export interface EngineAdapter {
  name: string;           // claude-code | codex | kimi-code | lmstudio
  run(input: EngineRunInput): Promise<EngineRunResult>;
}