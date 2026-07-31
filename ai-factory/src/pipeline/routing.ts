import { engines } from "../engines";
import type { EngineAdapter } from "../engines/types";
import { ensureMapping, localConfigPath, mergeSection, readLocalOverride, readYamlMapping } from "./local-config";
import { findUpFile } from "./projects";

export type Stage =
  | "plan"
  | "build"
  | "verify"
  | "review"
  // v3 deep-plan; research rozstrzyga się per rola przez slot domeny:
  // research.recon / research.solution-a / research.solution-b.
  | "triage"
  | "research"
  | "synthesis"
  | "critique";

type RouteSpec = string | string[];

interface RoutingFile {
  defaults?: Record<string, RouteSpec>;
  projects?: Record<string, Record<string, RouteSpec>>;
}

export interface Route {
  engine: EngineAdapter;
  model?: string;
  effort?: string;
  spec: string; // np. "claude-code/claude-fable-5@high" — do logów/raportów
  /** Wersja binarium CLI ("unknown" gdy nieodczytywalna) — trafia do podpisu akcji. */
  cliVersion?: string;
}

/** "claude-code/claude-fable-5@high" -> { engineName, model: "claude-fable-5", effort: "high" } */
function parseSpec(spec: string): { engineName: string; model?: string; effort?: string } {
  const [engineName, ...rest] = spec.split("/");
  const modelPart = rest.length ? rest.join("/") : undefined;
  if (!modelPart) return { engineName };
  const [model, effort] = modelPart.split("@");
  return { engineName, model: model || undefined, effort: effort || undefined };
}

function normalizeSpecs(value: unknown, context: string): string[] {
  const specs = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value
      : undefined;
  if (!specs) {
    throw new Error(`${context}: oczekiwano specyfikacji silnika albo listy specyfikacji.`);
  }
  if (!specs.length) {
    throw new Error(`${context}: lista specyfikacji nie może być pusta.`);
  }
  if (specs.length > 2) {
    throw new Error(
      `${context}: maksymalnie dwie specyfikacje (główna + jeden zapas) — ` +
      "kaskada jest świadomie niewspierana."
    );
  }
  if (specs.some((spec) => typeof spec !== "string" || !spec.trim())) {
    throw new Error(`${context}: każda specyfikacja musi być niepustym stringiem.`);
  }
  const normalized = specs.map((spec) => (spec as string).trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${context}: zapas identyczny z głównym jest niedozwolony.`);
  }
  return normalized;
}

/**
 * routing.yaml + opcjonalny, gitignorowany routing.local.yaml per host.
 * Merge jest płytki per klucz: defaults klucz-po-kluczu, projects per
 * projekt/klucz — local wygrywa, klucze niewymienione zostają z bazy.
 */
async function loadRoutingConfig(): Promise<RoutingFile> {
  const basePath = findUpFile("routing.yaml");
  const base = await readYamlMapping(basePath);
  const local = await readLocalOverride(basePath);
  if (!local) return base as RoutingFile;

  const localPath = localConfigPath(basePath);
  const unknownSections = Object.keys(local).filter((section) => section !== "defaults" && section !== "projects");
  if (unknownSections.length) {
    throw new Error(
      `${localPath}: nieznane sekcje "${unknownSections.join('", "')}" — dozwolone są wyłącznie "defaults" i "projects".`
    );
  }

  const defaults = mergeSection(base.defaults, local.defaults, `${localPath}: defaults`) as Record<string, RouteSpec>;
  const baseProjects = ensureMapping(base.projects, `${basePath}: projects`);
  const localProjects = ensureMapping(local.projects, `${localPath}: projects`);
  const projects = { ...baseProjects } as Record<string, Record<string, RouteSpec>>;
  for (const [projectKey, override] of Object.entries(localProjects)) {
    if (override === null || override === undefined) continue; // pusty stub sekcji = brak nadpisań
    projects[projectKey] = mergeSection(
      baseProjects[projectKey],
      override,
      `${localPath}: projects.${projectKey}`
    ) as Record<string, RouteSpec>;
  }
  return { defaults, projects };
}

export interface RouteOptions {
  /**
   * Dywersyfikacja cross-engine: jeżeli rozstrzygnięty silnik jest równy
   * wykluczonemu (np. reviewer == builder), routing przechodzi na
   * `<etap>.diverse`; brak fallbacku = fail-closed.
   */
  excludeEngine?: string;
}

/**
 * Kolejność rozstrzygania (od najbardziej szczegółowego):
 * 1. label `engine:<silnik[/model]>` na tickecie (ręczne wskazanie),
 * 2. projects.<projekt>.<etap[.domena]> w routing.yaml,
 * 3. defaults.<etap.domena>,
 * 4. defaults.<etap>.
 *
 * Wynik jest uporządkowany: główny, potem opcjonalny zapas. Wywołujący może
 * przejść na zapas wyłącznie po rozpoznanej awarii infrastruktury silnika.
 */
export async function resolveRouteCandidates(
  stage: Stage,
  ticket: { project: string; labels?: string[] },
  domain?: string,
  options: RouteOptions = {}
): Promise<Route[]> {
  const cfg = await loadRoutingConfig();

  // label wybiera BUILDERA; role read-only (plan/verify/review) idą wg configu —
  // nie każdy silnik ma read-only (kimi-code), a override "wszystkiego" nie ma sensownego użycia
  const label = stage === "build" ? (ticket.labels ?? []).find((l) => l.startsWith("engine:")) : undefined;
  const projectCfg = cfg.projects?.[ticket.project];

  let value: RouteSpec | undefined =
    label?.slice("engine:".length) ??
    (domain ? projectCfg?.[`${stage}.${domain}`] : undefined) ??
    projectCfg?.[stage] ??
    (domain ? cfg.defaults?.[`${stage}.${domain}`] : undefined) ??
    cfg.defaults?.[stage];

  if (!value) {
    throw new Error(`Brak routingu dla etapu "${stage}" (projekt: ${ticket.project}) w routing.yaml`);
  }

  let context = label
    ? `Routing label ${label}`
    : `Routing ${ticket.project}.${domain ? `${stage}.${domain}` : stage}`;
  let specs = normalizeSpecs(value, context);

  if (options.excludeEngine && parseSpec(specs[0]).engineName === options.excludeEngine) {
    const diverse = projectCfg?.[`${stage}.diverse`] ?? cfg.defaults?.[`${stage}.diverse`];
    if (!diverse) {
      throw new Error(
        `Routing ${stage}: silnik "${options.excludeEngine}" jest wykluczony (ten sam co builder), ` +
        `a routing.yaml nie ma fallbacku "${stage}.diverse".`
      );
    }
    value = diverse;
    context = `Routing ${stage}.diverse`;
    specs = normalizeSpecs(value, context);
  }

  const candidates = specs.map((spec) => {
    const { engineName, model, effort } = parseSpec(spec);
    const engine = engines[engineName];
    if (!engine) {
      throw new Error(
        `Nieznany silnik "${engineName}" w routingu (dostępne: ${Object.keys(engines).join(", ")})`
      );
    }
    return { engine, model, effort, spec };
  });

  const allowed = options.excludeEngine
    ? candidates.filter((candidate) => candidate.engine.name !== options.excludeEngine)
    : candidates;
  if (!allowed.length) {
    throw new Error(`Routing ${stage}.diverse wskazuje wykluczony silnik "${options.excludeEngine}".`);
  }
  return Promise.all(allowed.map(async (candidate) => ({
    ...candidate,
    cliVersion: candidate.engine.version ? await candidate.engine.version() : undefined,
  })));
}

/** Kompatybilny wrapper dla wywołujących, którzy znają tylko jedną trasę. */
export async function resolveRoute(
  stage: Stage,
  ticket: { project: string; labels?: string[] },
  domain?: string,
  options: RouteOptions = {}
): Promise<Route> {
  return (await resolveRouteCandidates(stage, ticket, domain, options))[0];
}
