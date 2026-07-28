import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const normalize = (path: string) => path.trim().replace(/^\.\//, "").replace(/\\/g, "/");

/** Odczyt statusu NUL-separated nie psuje ścieżek ze spacjami ani rename'ów. */
export async function changedFilesInWorkspace(cwd: string): Promise<string[]> {
  const { stdout } = await exec(
    "git",
    ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  const records = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    paths.push(normalize(record.slice(3)));
    if (/[RC]/.test(code) && records[i + 1]) paths.push(normalize(records[++i]));
  }
  return [...new Set(paths.filter(Boolean))];
}

export function undeclaredChangedFiles(declaredFiles: string[], changedFiles: string[]): string[] {
  const declared = new Set(declaredFiles.map(normalize).filter(Boolean));
  return [...new Set(changedFiles.map(normalize).filter((path) => path && !declared.has(path)))];
}

export interface ScopeAudit {
  warnings: string[];
  blocked: string[];
}

const basename = (path: string) => normalize(path).split("/").at(-1)?.toLowerCase() ?? "";

export function isSecretPath(path: string): boolean {
  const name = basename(path);
  const normalized = normalize(path).toLowerCase();
  if (
    name.startsWith(".env") &&
    (name.endsWith(".example") || name.endsWith(".sample"))
  ) return false;
  return name === ".env" ||
    name.startsWith(".env.") ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    name.endsWith(".p12") ||
    name.endsWith(".pfx") ||
    name.endsWith(".jks") ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    name === "id_ecdsa" ||
    /^secrets?\.(json|ya?ml|toml|ini)$/.test(name) ||
    /^credentials?\.(json|ya?ml|toml|ini)$/.test(name) ||
    /(^|\/)service-account[^/]*\.json$/.test(normalized);
}

/**
 * Pliki, których niezadeklarowana zmiana blokuje: etap test WYKONUJE je
 * (npm ci → lifecycle scripts, configi testów/buildu) z uprawnieniami
 * użytkownika, więc "warning w PR" to za mało (wektor postinstall → RCE).
 */
const PROTECTED_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
]);

const PROTECTED_BASENAME_PATTERNS = [
  /^tsconfig[^/]*\.json$/,
  /^(vitest|vite|next|playwright|jest|babel|eslint|webpack|rollup|tsup)\.config\.[a-z]+$/,
];

export function isProtectedPath(path: string): boolean {
  const normalized = normalize(path);
  const name = basename(path);
  return normalized.startsWith(".github/") ||
    normalized.startsWith("ai-factory/ops/") ||
    normalized === "ops" ||
    normalized.startsWith("ops/") ||
    normalized === "migrations" ||
    normalized.startsWith("migrations/") ||
    normalized.includes("/migrations/") ||
    normalized === "scripts" ||
    normalized.startsWith("scripts/") ||
    normalized.includes("/scripts/") ||
    PROTECTED_BASENAMES.has(name) ||
    PROTECTED_BASENAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * `factory.files` jest oczekiwaniem, nie kruchą allowlistą.
 * Sekrety są zawsze blokowane, a niezadeklarowane ścieżki o wysokim ryzyku
 * wymagają jawnej aprobaty w planie. Pozostałe odchylenia trafiają do PR-a.
 * `extraProtected` to per-projektowe ścieżki z projects.yaml (scope.protected):
 * dopasowanie po pełnej ścieżce, prefiksie katalogu albo basename.
 */
export function auditScope(
  declaredFiles: string[],
  changedFiles: string[],
  extraProtected: string[] = []
): ScopeAudit {
  const declared = new Set(declaredFiles.map(normalize).filter(Boolean));
  const extras = extraProtected.map(normalize).filter(Boolean);
  const isExtraProtected = (path: string) => extras.some((entry) =>
    path === entry ||
    path.startsWith(`${entry.replace(/\/+$/, "")}/`) ||
    basename(path) === entry.toLowerCase()
  );
  const warnings: string[] = [];
  const blocked: string[] = [];

  for (const raw of [...new Set(changedFiles.map(normalize).filter(Boolean))]) {
    if (isSecretPath(raw)) {
      blocked.push(`${raw}: plik sekretu/klucza`);
    } else if ((isProtectedPath(raw) || isExtraProtected(raw)) && !declared.has(raw)) {
      blocked.push(`${raw}: chroniona ścieżka nie została zatwierdzona w planie`);
    } else if (!declared.has(raw)) {
      warnings.push(`${raw}: poza oczekiwaną listą factory.files`);
    }
  }
  return { warnings, blocked };
}
