/**
 * Kanał agent → fabryka: JEDEN punkt parsowania werdyktu.
 *
 * Agent kończy raport blokiem `​```factory` z JSON-em. Parsujemy go RAZ, tutaj.
 * Markerów tekstowych (`PLAN: OK`, `VERDICT: PASS`, `REVIEW: FIX`, nagłówki sekcji
 * pytań, linie `SCREENSHOT:`) NIE ma — były bezpiecznikiem okresu przejściowego
 * i zostały wycięte w BAR-147, gdy dane potwierdziły 100% werdyktów strukturalnych
 * po naprawie transkryptu (BAR-130). Rozpoznawanie przepływu po swobodnym tekście
 * kosztowało nas BAR-101, BAR-108 i klasę cichych fail-openów — nie wraca.
 *
 * Fail-closed: brak parsowalnego bloku = wynik NEGATYWNY, oznaczony `source: "missing"`,
 * żeby wywołujący mógł to zaraportować jako awarię kontraktu, a nie ciszę.
 */

/** `structured` = agent dotrzymał kontraktu; `missing` = nie oddał bloku (fail-closed). */
export type VerdictSource = "structured" | "missing";

export interface PlanVerdict {
  kind: "plan";
  ok: boolean;
  /** Pytania do autora (gdy !ok i ticket wymaga doprecyzowania). */
  questions?: string;
  /** Ścieżki widoków do zrzutów ekranu. */
  screenshots: string[];
  /** Domena pracy — routing buildu (BAR-133). */
  domain?: string;
  /** Pliki, które ticket zmieni — serializacja kolizji (BAR-141). */
  files: string[];
  source: VerdictSource;
}

export interface VerifyVerdict {
  kind: "verify";
  pass: boolean;
  source: VerdictSource;
}

export interface ReviewVerdict {
  kind: "review";
  /** true = są uwagi do poprawy. FAIL-CLOSED: brak werdyktu ⇒ true. */
  needsFix: boolean;
  source: VerdictSource;
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

/** Komunikat dla człowieka i buildera, gdy agent nie dotrzymał kontraktu wyjścia. */
export const MISSING_VERDICT =
  "Agent nie oddał bloku ```factory z werdyktem (kontrakt wyjścia). " +
  "Traktuję to fail-closed jako wynik negatywny — sprawdź pełny raport w artefaktach runu.";

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
    "Bez tego bloku Twoja praca zostanie odrzucona: fabryka nie zgaduje werdyktu z treści raportu.",
  ].join("\n");
}

export function parsePlanVerdict(report: string): PlanVerdict {
  const b = structuredBlock(report);
  if (!b || typeof b.verdict !== "string") {
    return { kind: "plan", ok: false, questions: undefined, screenshots: [], files: [], source: "missing" };
  }
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

export function parseVerifyVerdict(report: string): VerifyVerdict {
  const b = structuredBlock(report);
  if (!b || typeof b.verdict !== "string") return { kind: "verify", pass: false, source: "missing" };
  return { kind: "verify", pass: b.verdict === "pass", source: "structured" };
}

export function parseReviewVerdict(report: string): ReviewVerdict {
  const b = structuredBlock(report);
  if (!b || typeof b.verdict !== "string") return { kind: "review", needsFix: true, source: "missing" };
  return { kind: "review", needsFix: b.verdict === "fix", source: "structured" };
}
