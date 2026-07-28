import { execFileControlled } from "../pipeline/process-control";

/**
 * Memoizowana wersja binarium CLI. Harness aktualizuje się sam (subskrypcje),
 * więc każda próba zapisuje wersję w podpisie — regresja first-pass-rate po
 * cichym auto-update przestaje być niewidzialna w metrykach.
 */
const cache = new Map<string, Promise<string>>();

export function cliVersion(bin: string): Promise<string> {
  if (!cache.has(bin)) {
    cache.set(
      bin,
      execFileControlled(bin, ["--version"], { timeoutMs: 5_000 })
        .then(({ stdout }) => {
          const line = stdout.trim().split("\n")[0] ?? "";
          return line.match(/\d+\.\d+[^\s)]*/)?.[0] ?? (line || "unknown");
        })
        .catch(() => "unknown")
    );
  }
  return cache.get(bin)!;
}
