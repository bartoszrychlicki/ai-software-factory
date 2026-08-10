import { createRequire } from "node:module";
import { DefaultExecutionEngine } from "@mastra/core/workflows";

const PATCHED_CORE_VERSIONS = new Set(["1.51.0"]);

/**
 * Ograniczona wersją łatka błędu snapshotu po resume.
 *
 * Monkey patch jest celowo fail-closed: upgrade Mastry wymaga najpierw ponownego
 * testu reprodukcyjnego i jawnego rozszerzenia listy wersji. Dzięki temu zmiana
 * prywatnego zachowania upstreamu nie przejdzie niezauważona na produkcję.
 */
export function applyWorkflowPersistencePatch(): string {
  const require = createRequire(import.meta.url);
  const version = (require("@mastra/core/package.json") as { version?: string }).version ?? "unknown";
  if (!PATCHED_CORE_VERSIONS.has(version)) {
    throw new Error(
      `Niezweryfikowana wersja @mastra/core ${version}; nie stosuję łatki snapshotu. ` +
      `Uruchom test resume i zaktualizuj PATCHED_CORE_VERSIONS.`
    );
  }
  const prototype = DefaultExecutionEngine.prototype as {
    getLastPersistedStatus?: (runId: string) => unknown;
  };
  if (typeof prototype.getLastPersistedStatus !== "function") {
    throw new Error("@mastra/core nie udostępnia oczekiwanej metody getLastPersistedStatus");
  }
  prototype.getLastPersistedStatus = () => undefined;
  return version;
}
