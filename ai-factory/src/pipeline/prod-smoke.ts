/**
 * Prod smoke po merge'u (QA runda 2): fabryka nie kończy odpowiedzialności na PR —
 * sprawdza, czy zmiana FAKTYCZNIE żyje na produkcji (lekcja z BAR-101/102:
 * verify PASS + LGTM, a funkcja martwa, bo domena serwowała stary hosting).
 * Checki deklaratywne per projekt w projects.yaml (qa.prodChecks).
 */
export interface ProdCheck {
  name: string;
  url: string;
  /** Oczekiwany status HTTP (default 200). */
  status?: number;
  /** Substring wymagany w body odpowiedzi. */
  textIncludes?: string;
  /** Substring wymagany w nagłówkach (np. "x-vercel-id" = deploy faktycznie z Vercela). */
  headerIncludes?: string;
}

export interface SmokeResult {
  ok: boolean;
  report: string; // linia per check: ✅/❌ + powód
}

export async function runProdChecks(checks: ProdCheck[]): Promise<SmokeResult> {
  const lines: string[] = [];
  let ok = true;

  for (const check of checks) {
    try {
      const res = await fetch(check.url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
      const problems: string[] = [];

      const wantStatus = check.status ?? 200;
      if (res.status !== wantStatus) problems.push(`status ${res.status} ≠ ${wantStatus}`);

      if (check.headerIncludes) {
        const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n").toLowerCase();
        if (!headers.includes(check.headerIncludes.toLowerCase())) {
          problems.push(`brak "${check.headerIncludes}" w nagłówkach`);
        }
      }
      if (check.textIncludes) {
        const body = await res.text();
        if (!body.includes(check.textIncludes)) problems.push(`brak "${check.textIncludes}" w treści`);
      }

      if (problems.length) {
        ok = false;
        lines.push(`❌ ${check.name} (${check.url}): ${problems.join("; ")}`);
      } else {
        lines.push(`✅ ${check.name}`);
      }
    } catch (err) {
      ok = false;
      lines.push(`❌ ${check.name} (${check.url}): ${err instanceof Error ? err.message : err}`);
    }
  }
  return { ok, report: lines.join("\n") };
}
