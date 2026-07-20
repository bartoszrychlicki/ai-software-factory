import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { engines } from "../engines";
import type { EngineAdapter } from "../engines/types";
import { findUpFile } from "./projects";

export type Stage = "plan" | "build" | "verify" | "review";

interface RoutingFile {
  defaults?: Record<string, string>;
  projects?: Record<string, Record<string, string>>;
}

export interface Route {
  engine: EngineAdapter;
  model?: string;
  spec: string; // np. "claude-code/sonnet" — do logów/raportów
}

/** "claude-code/sonnet" -> { engineName: "claude-code", model: "sonnet" } */
function parseSpec(spec: string): { engineName: string; model?: string } {
  const [engineName, ...rest] = spec.split("/");
  return { engineName, model: rest.length ? rest.join("/") : undefined };
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
  domain?: string
): Promise<Route> {
  const raw = await readFile(findUpFile("routing.yaml"), "utf8");
  const cfg = parse(raw) as RoutingFile;

  // label wybiera BUILDERA; role read-only (plan/verify/review) idą wg configu —
  // nie każdy silnik ma read-only (kimi-code), a override "wszystkiego" nie ma sensownego użycia
  const label = stage === "build" ? (ticket.labels ?? []).find((l) => l.startsWith("engine:")) : undefined;
  const projectCfg = cfg.projects?.[ticket.project];

  const spec =
    label?.slice("engine:".length) ??
    (domain ? projectCfg?.[`${stage}.${domain}`] : undefined) ??
    projectCfg?.[stage] ??
    (domain ? cfg.defaults?.[`${stage}.${domain}`] : undefined) ??
    cfg.defaults?.[stage];

  if (!spec) {
    throw new Error(`Brak routingu dla etapu "${stage}" (projekt: ${ticket.project}) w routing.yaml`);
  }

  const { engineName, model } = parseSpec(spec);
  const engine = engines[engineName];
  if (!engine) {
    throw new Error(
      `Nieznany silnik "${engineName}" w routingu (dostępne: ${Object.keys(engines).join(", ")})`
    );
  }
  return { engine, model, spec };
}
