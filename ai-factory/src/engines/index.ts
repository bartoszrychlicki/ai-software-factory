import { claudeCode } from "./claude-code";
import { codex } from "./codex";
import type { EngineAdapter } from "./types";

/**
 * Rejestr silników. Nowy silnik (kimi-code, lmstudio, manual...) =
 * nowy adapter + jeden wpis tutaj + linijka w routing.yaml.
 */
export const engines: Record<string, EngineAdapter> = {
  [claudeCode.name]: claudeCode,
  [codex.name]: codex,
};
