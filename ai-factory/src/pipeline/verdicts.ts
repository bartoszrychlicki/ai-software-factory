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

import { z } from "zod";

/** `structured` = agent dotrzymał kontraktu; `missing` = nie oddał bloku (fail-closed). */
export type VerdictSource = "structured" | "missing";

const domainSchema = z.enum(["frontend", "backend", "fullstack", "ops"]);
const pathSchema = z.string().trim().min(1).refine((value) => !value.startsWith("/") && !value.includes(".."), {
  message: "ścieżka musi być względna wobec repo i nie może zawierać '..'",
});

const planContractSchema = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.literal("ok"),
    // Starsze prompty pokazywały pole `questions` także dla verdict=ok, więc
    // poprawny agent potrafił zwrócić pusty string. Akceptujemy wyłącznie tę
    // pustą wartość; każde realne pytanie przy `ok` nadal łamie kontrakt.
    questions: z.literal("").optional(),
    screenshots: z.array(z.string().trim().min(1)).max(4).default([]),
    files: z.array(pathSchema).min(1).max(200),
    domain: domainSchema,
  }).strict(),
  z.object({
    verdict: z.literal("blocked"),
    questions: z.string().trim().min(1).optional(),
    screenshots: z.array(z.string().trim().min(1)).max(4).default([]),
    files: z.array(pathSchema).max(200).default([]),
    domain: domainSchema.optional(),
  }).strict(),
]);

const verifyContractSchema = z.object({ verdict: z.enum(["pass", "fail"]) }).strict();
const reviewContractSchema = z.object({ verdict: z.enum(["lgtm", "fix"]) }).strict();

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

/** Komunikat dla człowieka i buildera, gdy agent nie dotrzymał kontraktu wyjścia. */
export const MISSING_VERDICT =
  "Agent nie oddał bloku ```factory z werdyktem (kontrakt wyjścia). " +
  "Traktuję to fail-closed jako wynik negatywny — sprawdź pełny raport w artefaktach runu.";

/** Instrukcja doklejana do promptu roli — kontrakt wyjścia agenta. */
export function verdictInstruction(kind: "plan" | "verify" | "review"): string {
  const shapes =
    kind === "plan"
      ? [
          `Gdy plan jest gotowy: {"verdict":"ok","screenshots":["/sciezka"],"files":["src/x.ts"],"domain":"frontend|backend|fullstack|ops"}`,
          `Gdy potrzebujesz odpowiedzi człowieka: {"verdict":"blocked","questions":"<pytania A/B/C>","screenshots":[],"files":[],"domain":"frontend|backend|fullstack|ops"}`,
          "Przy verdict=ok pomiń pole questions.",
        ]
      : [kind === "verify" ? `{"verdict":"pass"|"fail"}` : `{"verdict":"lgtm"|"fix"}`];
  return [
    "ZAKOŃCZ odpowiedź blokiem kodu (dokładnie taki nagłówek) z werdyktem maszynowym:",
    "```factory",
    ...shapes,
    "```",
    "Blok MUSI być ostatnim elementem odpowiedzi — po nim NIE dopisuj komentarzy, podsumowań ani uwag o agentach pomocniczych.",
    "Bez tego bloku Twoja praca zostanie odrzucona: fabryka nie zgaduje werdyktu z treści raportu.",
  ].join("\n");
}

export function parsePlanVerdict(report: string): PlanVerdict {
  const b = structuredBlock(report);
  const parsed = planContractSchema.safeParse(b);
  if (!parsed.success) {
    return { kind: "plan", ok: false, questions: undefined, screenshots: [], files: [], source: "missing" };
  }
  const contract = parsed.data;
  return {
    kind: "plan",
    ok: contract.verdict === "ok",
    questions: contract.questions,
    screenshots: contract.screenshots,
    domain: contract.domain,
    files: contract.files,
    source: "structured",
  };
}

export function parseVerifyVerdict(report: string): VerifyVerdict {
  const b = structuredBlock(report);
  const parsed = verifyContractSchema.safeParse(b);
  if (!parsed.success) return { kind: "verify", pass: false, source: "missing" };
  return { kind: "verify", pass: parsed.data.verdict === "pass", source: "structured" };
}

export function parseReviewVerdict(report: string): ReviewVerdict {
  const b = structuredBlock(report);
  const parsed = reviewContractSchema.safeParse(b);
  if (!parsed.success) return { kind: "review", needsFix: true, source: "missing" };
  return { kind: "review", needsFix: parsed.data.verdict === "fix", source: "structured" };
}
