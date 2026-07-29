import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { engines } from "../engines";
import type { EngineAdapter } from "../engines/types";
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

interface RoutingFile {
  defaults?: Record<string, string>;
  projects?: Record<string, Record<string, string>>;
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
 */
export async function resolveRoute(
  stage: Stage,
  ticket: { project: string; labels?: string[] },
  domain?: string,
  options: RouteOptions = {}
): Promise<Route> {
  const raw = await readFile(findUpFile("routing.yaml"), "utf8");
  const cfg = parse(raw) as RoutingFile;

  // label wybiera BUILDERA; role read-only (plan/verify/review) idą wg configu —
  // nie każdy silnik ma read-only (kimi-code), a override "wszystkiego" nie ma sensownego użycia
  const label = stage === "build" ? (ticket.labels ?? []).find((l) => l.startsWith("engine:")) : undefined;
  const projectCfg = cfg.projects?.[ticket.project];

  let spec =
    label?.slice("engine:".length) ??
    (domain ? projectCfg?.[`${stage}.${domain}`] : undefined) ??
    projectCfg?.[stage] ??
    (domain ? cfg.defaults?.[`${stage}.${domain}`] : undefined) ??
    cfg.defaults?.[stage];

  if (!spec) {
    throw new Error(`Brak routingu dla etapu "${stage}" (projekt: ${ticket.project}) w routing.yaml`);
  }

  if (options.excludeEngine && parseSpec(spec).engineName === options.excludeEngine) {
    const diverse = projectCfg?.[`${stage}.diverse`] ?? cfg.defaults?.[`${stage}.diverse`];
    if (!diverse) {
      throw new Error(
        `Routing ${stage}: silnik "${options.excludeEngine}" jest wykluczony (ten sam co builder), ` +
        `a routing.yaml nie ma fallbacku "${stage}.diverse".`
      );
    }
    if (parseSpec(diverse).engineName === options.excludeEngine) {
      throw new Error(`Routing ${stage}.diverse wskazuje wykluczony silnik "${options.excludeEngine}".`);
    }
    spec = diverse;
  }

  const { engineName, model, effort } = parseSpec(spec);
  const engine = engines[engineName];
  if (!engine) {
    throw new Error(
      `Nieznany silnik "${engineName}" w routingu (dostępne: ${Object.keys(engines).join(", ")})`
    );
  }
  const cliVersion = engine.version ? await engine.version() : undefined;
  return { engine, model, effort, spec, cliVersion };
}
