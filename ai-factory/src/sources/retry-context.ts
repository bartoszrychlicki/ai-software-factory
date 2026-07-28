import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RetryEvidence {
  context: string;
  baseSha?: string;
  requiresChanges: boolean;
}

function artifactMeta(path: string): Record<string, string> {
  try {
    const raw = readFileSync(path, "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    return Object.fromEntries(
      match[1]
        .split("\n")
        .map((line) => line.match(/^([^:]+):\s*(.*)$/))
        .filter((item): item is RegExpMatchArray => !!item)
        .map((item) => [item[1].trim(), item[2].trim()])
    );
  } catch {
    return {};
  }
}

function artifactBody(path: string): string {
  try {
    const raw = readFileSync(path, "utf8");
    return raw.split(/^---\s*$/m).slice(2).join("---").trim() || raw;
  } catch {
    return "";
  }
}

function orderedArtifacts(runDir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(runDir)
      .filter((file) => pattern.test(file))
      .map((file) => ({ file, mtime: statSync(join(runDir, file)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ file }) => file);
  } catch {
    return [];
  }
}

/**
 * Poprzedni verifier/scope gate jest dowodem wejściowym dla kolejnego planera,
 * a ostatni commit buildera jest opcjonalnym checkpointem. Nie przenosimy
 * swobodnych komentarzy fabryki ani całej historii runa.
 */
export function readRetryEvidence(runDir: string): RetryEvidence | undefined {
  const verifyFiles = orderedArtifacts(runDir, /^verify-attempt-\d+\.md$/);
  const buildFiles = orderedArtifacts(runDir, /^build-attempt-\d+\.md$/);
  const latestVerify = verifyFiles[0] ? artifactBody(join(runDir, verifyFiles[0])) : "";
  const latestVerifyMeta = verifyFiles[0] ? artifactMeta(join(runDir, verifyFiles[0])) : {};
  const latestBuild = buildFiles[0] ? artifactBody(join(runDir, buildFiles[0])) : "";
  const latestBuildMeta = buildFiles[0] ? artifactMeta(join(runDir, buildFiles[0])) : {};

  let baseSha: string | undefined;
  for (const file of buildFiles) {
    const meta = artifactMeta(join(runDir, file));
    if (meta.outcome === "committed" && /^[0-9a-f]{40}$/i.test(meta.sha ?? "")) {
      baseSha = meta.sha;
      break;
    }
  }

  const sections: string[] = [];
  const verifyFailed = !!latestVerify && latestVerifyMeta.outcome !== "pass";
  const scopeViolated = latestBuildMeta.outcome === "scope-violation";
  if (verifyFailed) {
    sections.push(`## Ostatni raport verifiera\n${latestVerify.slice(0, 9_000)}`);
  }
  if (scopeViolated && latestBuild) {
    sections.push(`## Ostatnia propozycja buildera zatrzymana przez scope gate\n${latestBuild.slice(0, 6_000)}`);
  }
  if (!sections.length && !baseSha) return undefined;

  return {
    context: sections.length
      ? [
          "# Dowody z poprzedniego nieudanego runu",
          "To jest wiążący kontekst naprawczy. Zaktualizuj plan i factory.files tak, aby usunąć wykazane przyczyny bez obchodzenia scope gate.",
          "",
          sections.join("\n\n"),
        ].join("\n")
      : "",
    baseSha,
    requiresChanges: verifyFailed || scopeViolated,
  };
}
