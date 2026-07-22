export type Role = "plan" | "build" | "verify" | "review";

export interface EngineRunInput {
  role: Role;
  instructions: string;   // prompt roli (z profiles/)
  workspace: string;      // ścieżka worktree
  context: string;        // handoff od poprzedniego etapu
  budget: { minutes: number };
  model?: string;          // np. claude-fable-5, gpt-5.6-sol
  effort?: string;         // reasoning effort: low/medium/high/xhigh (mapowany per CLI)
  /** Wznowienie bieżącej sesji CLI; w MVP obsługiwane tylko przez claude-code w roli plan. */
  sessionId?: string;
}

export interface EngineRunResult {
  ok: boolean;
  report: string;         // plan / raport buildu / werdykt verify (ostatnia wiadomość — dla człowieka)
  /**
   * PEŁNY tekst wszystkich wiadomości agenta. Werdykty parsujemy STĄD, bo agent
   * potrafi oddać werdykt we wcześniejszej wiadomości i dokleić meta-komentarz
   * na końcu (BAR-108, BAR-130, BAR-150) — wtedy `report` go nie zawiera.
   */
  transcript?: string;
  costUsd?: number;
  /** Id sesji zwrócone przez CLI; inne adaptery mogą je pominąć. */
  sessionId?: string;
  raw?: unknown;
}

/** Silnik = headless CLI (subskrypcja). Nowy silnik = nowy adapter, zero zmian w pipeline. */
export interface EngineAdapter {
  name: string;           // claude-code | codex | kimi-code | lmstudio
  run(input: EngineRunInput): Promise<EngineRunResult>;
}
