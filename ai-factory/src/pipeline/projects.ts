import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";

export interface ProjectConfig {
  repo: string;
  github?: string;
  default_branch?: string;
  routing?: Record<string, string>; // per-projektowe nadpisania silników/modeli
  checks?: string[]; // komendy weryfikacyjne projektu (uruchamiane na świeżym checkoutcie)
  /** GitHub checks wymagane dla dokładnego PR head SHA przed review i zdjęciem draftu. */
  ci?: { requiredChecks: string[]; timeoutMinutes?: number };
  /** Opcjonalny podgląd wyniku: fabryka stawia serwer, robi screenshot i dołącza do raportu. */
  screenshot?: { start: string; url: string };
  /** Limit równolegle prowadzonych ticketów projektu (BAR-122). Domyślnie bez limitu. */
  max_concurrent_tickets?: number;
  /** "extended" = fabryka pisze stany procesu w Linear (🧠❓🚦🔨🧪👀✅) zamiast prostego In Progress/In Review. */
  statuses?: "extended";
  /** Budżet per ticket-run (nadpisuje globalne defaulty FACTORY_BUDGET_*). */
  budget?: { maxMinutes?: number; maxUsd?: number };
  /** QA: runda 1 = e2e w verify (komenda na świeżym checkoutcie); runda 2 = prod smoke po merge'u. */
  qa?: {
    e2e?: string;
    prodChecks?: { name: string; url: string; status?: number; textIncludes?: string; headerIncludes?: string }[];
  };
}

/** mastra dev uruchamia kod z .mastra/output — szukamy pliku konfiguracyjnego w górę drzewa */
export function findUpFile(name: string): string {
  if (process.env.FACTORY_ROOT) return join(process.env.FACTORY_ROOT, name);
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Nie znaleziono ${name} — ustaw FACTORY_ROOT albo uruchamiaj z katalogu ai-factory`);
    }
    dir = parent;
  }
}

export async function getProject(key: string): Promise<ProjectConfig> {
  const raw = await readFile(findUpFile("projects.yaml"), "utf8");
  const all = parse(raw) as Record<string, ProjectConfig>;
  const project = all[key];
  if (!project) throw new Error(`Nieznany projekt "${key}" — brak wpisu w projects.yaml`);
  const checks = project.checks?.map((command) => command.trim()).filter(Boolean) ?? [];
  if (!checks.length) {
    throw new Error(`Projekt "${key}" nie ma deterministycznych checks — rejestracja jest fail-closed.`);
  }
  const requiredChecks = project.ci?.requiredChecks?.map((name) => name.trim()).filter(Boolean) ?? [];
  if (project.github && !requiredChecks.length) {
    throw new Error(`Projekt "${key}" ma GitHub, ale nie ma ci.requiredChecks — PR nie może być bezpiecznie opublikowany.`);
  }
  project.checks = checks;
  if (project.ci) project.ci.requiredChecks = requiredChecks;
  return project;
}
