import { dirname, join } from "node:path";
import { findUpFile } from "./projects";

/** Wspólny katalog wszystkich trwałych artefaktów runtime fabryki. */
export function runsRoot(): string {
  const configured = process.env.FACTORY_RUNS_ROOT?.trim();
  return configured ? configured : join(dirname(findUpFile("package.json")), "runs");
}

export function ticketRunsDir(ticketId: string): string {
  return join(runsRoot(), ticketId);
}

export function jobArtifactsDir(ticketId: string, jobRunId: string): string {
  return join(ticketRunsDir(ticketId), jobRunId);
}
