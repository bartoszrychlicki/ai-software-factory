/**
 * Kanał agent → fabryka: JEDEN punkt parsowania werdyktu.
 *
 * Problem: dziś werdykty żyją jako markery rozsiane po tekście raportu
 * (`PLAN: OK`, `VERDICT: PASS`, `REVIEW: FIX`, sekcje `## Pytania do autora`,
 * linie `SCREENSHOT:`), parsowane regexami w 15 miejscach. To ta sama choroba
 * co sterowanie komentarzami: BAR-101 (marker w backtickach), BAR-108 (pytania
 * w zgubionej wiadomości pośredniej), fail-open `REVIEW: FIX`.
 *
 * Rozwiązanie: agent kończy raport blokiem `​```factory` z JSON-em. Parsujemy go
 * RAZ, tutaj, do typu. Markery tekstowe zostają wyłącznie jako fallback okresu
 * przejściowego — i są jawnie oznaczone w wyniku (`source: "legacy"`), żeby
 * dało się zmierzyć, kiedy można je wyciąć.
 *
 * Fail-closed: brak parsowalnego werdyktu = NEGATYWNY wynik (nie „przepuść").
 */

export interface PlanVerdict {
  kind: "plan";
  ok: boolean;
  /** Pytania do autora (gdy !ok i ticket wymaga doprecyzowania). */
  questions?: string;
  /** Ścieżki widoków do zrzutów ekranu (dawne linie `SCREENSHOT:`). */
  screenshots: string[];
  /** Domena pracy — pod BAR-133 (routing bez ręcznego labela). */
  domain?: string;
  /** Pliki, które ticket zmieni — pod BAR-141 (kolizje plikowe). */
  files: string[];
  source: "structured" | "legacy";
}

export interface VerifyVerdict {
  kind: "verify";
  pass: boolean;
  source: "structured" | "legacy";
}

export interface ReviewVerdict {
  kind: "review";
  /** true = są uwagi do poprawy. FAIL-CLOSED: brak werdyktu ⇒ true. */
  needsFix: boolean;
  source: "structured" | "legacy";
}

/** Blok `​```factory {...}​``` z końca raportu — ostatni wygrywa. */
function structuredBlock(report: string): Record<string, unknown> | undefined {
  const blocks = [...report.matchAll(/```factory\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return undefined;
  try {
    const parsed = JSON.parse(last.trim()) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Instrukcja doklejana do promptu roli — kontrakt wyjścia agenta. */
export function verdictInstruction(kind: "plan" | "verify" | "review"): string {
  const shape =
    kind === "plan"
      ? `{"verdict":"ok"|"blocked","questions":"<pytania A/B/C gdy blocked>","screenshots":["/sciezka"],"files":["src/x.ts"],"domain":"frontend|backend|fullstack|ops"}`
      : kind === "verify"
        ? `{"verdict":"pass"|"fail"}`
        : `{"verdict":"lgtm"|"fix"}`;
  return [
    "ZAKOŃCZ odpowiedź blokiem kodu (dokładnie taki nagłówek) z werdyktem maszynowym:",
    "```factory",
    shape,
    "```",
    "Blok MUSI być ostatnim elementem odpowiedzi — po nim NIE dopisuj komentarzy, podsumowań ani uwag o agentach pomocniczych.",
  ].join("\n");
}

export function parsePlanVerdict(report: string): PlanVerdict {
  const b = structuredBlock(report);
  if (b && typeof b.verdict === "string") {
    return {
      kind: "plan",
      ok: b.verdict === "ok",
      questions: typeof b.questions === "string" && b.questions.trim() ? b.questions : undefined,
      screenshots: asStringArray(b.screenshots),
      domain: typeof b.domain === "string" ? b.domain : undefined,
      files: asStringArray(b.files),
      source: "structured",
    };
  }
  // fallback okresu przejściowego: markery tekstowe
  const ok = /^[`*\s]*PLAN:\s*OK\b/m.test(report);
  const questions =
    report.match(/^##\s*(Pytania do autora|Niejasności blokujące)[\s\S]*?(?=\n##\s|$)/m)?.[0] ??
    // bez nagłówka: struktura pytań (numeracja + warianty A)/B) + REKOMENDACJA) — lekcja z BAR-108
    (/^\s*\d+\.[\s\S]*?^\s*[A-D]\)/m.test(report) && /REKOMENDACJA/i.test(report) ? report : undefined);
  return {
    kind: "plan",
    ok,
    questions: ok ? undefined : questions,
    screenshots: [...report.matchAll(/^SCREENSHOT:\s*(\/\S*)/gm)].map((m) => m[1]),
    files: [],
    source: "legacy",
  };
}

export function parseVerifyVerdict(report: string): VerifyVerdict {
  const b = structuredBlock(report);
  if (b && typeof b.verdict === "string") return { kind: "verify", pass: b.verdict === "pass", source: "structured" };
  return { kind: "verify", pass: /^VERDICT:\s*PASS/m.test(report), source: "legacy" };
}

export function parseReviewVerdict(report: string): ReviewVerdict {
  const b = structuredBlock(report);
  if (b && typeof b.verdict === "string") return { kind: "review", needsFix: b.verdict === "fix", source: "structured" };
  // FAIL-CLOSED (zmiana względem starego zachowania): brak jednoznacznego LGTM = są uwagi.
  // Dotąd brak markera znaczył „przepuść", więc zgubiona wiadomość agenta cicho zdejmowała draft z PR-a.
  const lgtm = /^REVIEW:\s*LGTM/m.test(report);
  return { kind: "review", needsFix: !lgtm, source: "legacy" };
}
