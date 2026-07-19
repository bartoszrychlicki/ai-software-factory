import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export interface ProjectConfig {
  repo: string;
  github?: string;
  default_branch?: string;
  routing?: Record<string, string>; // per-projektowe nadpisania silników/modeli
}

const ROOT = process.env.FACTORY_ROOT ?? process.cwd();

export async function getProject(key: string): Promise<ProjectConfig> {
  const raw = await readFile(join(ROOT, "projects.yaml"), "utf8");
  const all = parse(raw) as Record<string, ProjectConfig>;
  const project = all[key];
  if (!project) throw new Error(`Nieznany projekt "${key}" — brak wpisu w projects.yaml`);
  return project;
}