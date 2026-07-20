export type Role = "plan" | "build" | "verify" | "review";

export interface EngineRunInput {
  role: Role;
  instructions: string;   // prompt roli (z profiles/)
  workspace: string;      // ścieżka worktree
  context: string;        // handoff od poprzedniego etapu
  budget: { minutes: number };
  model?: string;          // np. claude-2.0, codex-002, lmstudio-13b
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