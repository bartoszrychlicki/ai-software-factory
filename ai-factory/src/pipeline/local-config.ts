import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse } from "yaml";

/**
 * Konfiguracja lokalna per host: obok bazowego <plik>.yaml może istnieć
 * gitignorowany <plik>.local.yaml z nadpisaniami maszyny (ścieżki repo,
 * lokalne eksperymenty budżetowe/modelowe). Semantyka: płytki merge per
 * sekcję/klucz, local wygrywa; klucz z .local zastępuje klucz bazowy W CAŁOŚCI
 * (także obiekty). Fail-closed: brak pliku = brak nadpisań, ale plik
 * istniejący a nieparsowalny/o złym kształcie = twardy błąd — nigdy ciche
 * zignorowanie części konfiguracji.
 */

export type YamlMapping = Record<string, unknown>;

/** `projects.yaml` → `projects.local.yaml`; plik lokalny leży zawsze obok bazowego. */
export function localConfigPath(basePath: string): string {
  return basePath.replace(/\.yaml$/, ".local.yaml");
}

export function ensureMapping(value: unknown, context: string): YamlMapping {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${context}: oczekiwana mapa YAML (klucz → wartość), a jest ${Array.isArray(value) ? "lista" : typeof value}.`
    );
  }
  return value as YamlMapping;
}

export function parseYamlMapping(raw: string, sourcePath: string): YamlMapping {
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new Error(`Uszkodzony YAML w ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return ensureMapping(parsed, sourcePath);
}

export async function readYamlMapping(path: string): Promise<YamlMapping> {
  return parseYamlMapping(await readFile(path, "utf8"), path);
}

/** `undefined` wyłącznie gdy pliku .local nie ma — jedyny przypadek „brak nadpisań". */
export async function readLocalOverride(basePath: string): Promise<YamlMapping | undefined> {
  const localPath = localConfigPath(basePath);
  if (!existsSync(localPath)) return undefined;
  return readYamlMapping(localPath);
}

/** Płytki merge jednej sekcji: klucze z .local wygrywają w całości, reszta bazowa zostaje. */
export function mergeSection(base: unknown, override: unknown, context: string): YamlMapping {
  return {
    ...ensureMapping(base, `${context} (baza)`),
    ...ensureMapping(override, `${context} (.local)`),
  };
}
