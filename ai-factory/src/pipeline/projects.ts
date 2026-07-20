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
}

/** mastra dev uruchamia kod z .mastra/output — szukamy projects.yaml w górę drzewa */
function findConfigPath(): string {
  if (process.env.FACTORY_ROOT) return join(process.env.FACTORY_ROOT, "projects.yaml");
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, "projects.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Nie znaleziono projects.yaml — ustaw FACTORY_ROOT albo uruchamiaj z katalogu ai-factory");
    }
    dir = parent;
  }
}

export async function getProject(key: string): Promise<ProjectConfig> {
  const raw = await readFile(findConfigPath(), "utf8");
  const all = parse(raw) as Record<string, ProjectConfig>;
  const project = all[key];
  if (!project) throw new Error(`Nieznany projekt "${key}" — brak wpisu w projects.yaml`);
  return project;
}