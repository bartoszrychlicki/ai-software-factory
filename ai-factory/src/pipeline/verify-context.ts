import type { EngineAdapter } from "../engines/types";
import type { ProjectConfig } from "./projects";
import { changeManifest, fullBranchDiff } from "./quality";

const FULL_DIFF_CONTEXT_LIMIT = 60_000;

export interface VerifyContextSection {
  block: string;
  extraInstruction?: string;
}

/** Zachowuje historyczny nagłówek SHA finalnego reverify niezależnie od trybu kontekstu. */
export function buildFinalVerifyContextBlock(
  sha: string,
  section: VerifyContextSection
): string {
  return [`# Finalny SHA: ${sha}`, section.block].join("\n");
}

interface VerifyContextArgs {
  co: { dir: string };
  project: ProjectConfig;
  sha: string;
}

/**
 * Buduje część kontekstu opisującą zmiany. Tryb wynika wyłącznie z capability
 * adaptera; route projektu/modelu jedynie wybiera adapter przed tym wywołaniem.
 */
export async function buildVerifyContextSection(
  engine: EngineAdapter,
  { co, project, sha }: VerifyContextArgs
): Promise<VerifyContextSection> {
  if (engine.verifyContextMode === "workspace") {
    const manifest = await changeManifest(co.dir, project.default_branch ?? "main");
    return {
      block: [
        "# Kompaktowy kontekst zmian — workspace read-only",
        "",
        "## Weryfikowany SHA",
        sha,
        "",
        "## Bazowy SHA",
        manifest.base,
        "",
        "## Kompletny manifest zmian (git diff --name-status; D = usunięcie)",
        manifest.nameStatus || "(brak zmian)",
        "",
        "## Diffstat",
        manifest.diffStat || "(brak zmian)",
      ].join("\n"),
      extraInstruction:
        "Tryb workspace/read-only: przed werdyktem MUSISZ z checkoutu sprawdzić krytyczne zmienione pliki " +
        "narzędziami read, grep, find i ls. Nie wydawaj werdyktu wyłącznie na podstawie manifestu, diffstatu ani checks.",
    };
  }

  const diff = await fullBranchDiff(co.dir, project.default_branch ?? "main");
  return {
    block: [
      "# Pełny diff brancha względem aktualnej bazy",
      diff.slice(0, FULL_DIFF_CONTEXT_LIMIT),
    ].join("\n"),
  };
}
