import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findUpFile } from "./projects";

/**
 * Trwały audit trail runa poza Studio: runs/<ticket>/<runId>/<plik>.
 * Zapis NIGDY nie wywala pipeline'u — audit trail jest dodatkiem, nie bramką.
 */
export async function saveArtifact(
  ticketId: string,
  runId: string,
  name: string,
  content: string
): Promise<void> {
  try {
    const root = dirname(findUpFile("package.json"));
    const dir = join(root, "runs", ticketId, runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), content);
  } catch (err) {
    console.error(`Artefakt ${ticketId}/${name} nie zapisany:`, err instanceof Error ? err.message : err);
  }
}

/** Nagłówek YAML-owy artefaktu: metadane (silnik, koszt, czas) czytelne i grepowalne. */
export function artifactHeader(meta: Record<string, string | number | undefined>): string {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\ntimestamp: ${new Date().toISOString()}\n---\n\n`;
}
