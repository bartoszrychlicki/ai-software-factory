import { join } from "node:path";

/**
 * Lokalna baza workflow musi żyć poza `.mastra/output`, bo `mastra build`
 * regeneruje ten katalog destrukcyjnie. Absolutna ścieżka pod FACTORY_ROOT
 * zachowuje runy między buildami i restartami launchd.
 */
export function resolveMastraStorageUrl(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): string {
  if (env.TURSO_DATABASE_URL) return env.TURSO_DATABASE_URL;
  if (env.FACTORY_MASTRA_DB_URL) return env.FACTORY_MASTRA_DB_URL;
  return `file:${join(env.FACTORY_ROOT ?? cwd, "runs", "mastra.db")}`;
}
