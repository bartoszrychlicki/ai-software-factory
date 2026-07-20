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
  /** Opcjonalny podgląd wyniku: fabryka stawia serwer, robi screenshot i dołącza do raportu. */
  screenshot?: { start: string; url: string };
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
  return project;
}