import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { execFileControlled } from "./process-control";
import {
  createBaseCheckout,
  createCheckout,
  createWorkspace,
  removeCheckout,
} from "./workspace";
import { getProject } from "./projects";
import { resolveRoute } from "./routing";
import { artifactHeader, saveArtifact } from "./artifacts";
import {
  buildSignature,
  signatureLine,
  signatureMeta,
  signatureTrailer,
} from "./signature";
import { recordMetric } from "./metrics";
import {
  formatClarifyQuestions,
  parseCritiqueVerdict,
  parsePlanVerdict,
  parseReviewVerdict,
  parseTriageVerdict,
  resolveDomain,
  verdictInstruction,
} from "./verdicts";
import { changeManifest } from "./quality";
import { auditScope, changedFilesInWorkspace } from "./scope";
import { critiqueMeaningOf, humanSummaryOf } from "./human-summary";
import type { Route, Stage } from "./routing";
import type { ProjectConfig } from "./projects";
import type { ActionSignature } from "./signature";

const ticketSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  project: z.string(),
  labels: z.array(z.string()).default([]),
  inputHash: z.string(),
  commentContext: z.string().optional(),
});

const briefsSchema = z.object({
  recon: z.string().optional(),
  "solution-a": z.string().optional(),
  "solution-b": z.string().optional(),
});

export const factoryJobInputSchema = z.object({
  kind: z.enum(["plan", "build", "review", "triage", "research", "synthesis", "critique"]),
  attempt: z.number().int().positive(),
  ticket: ticketSchema,
  plan: z.string().optional(),
  planFiles: z.array(z.string()).default([]),
  planDomain: z.string().optional(),
  feedback: z.string().optional(),
  headSha: z.string().optional(),
  /** Baza buildera: świeży main z cherry-pickiem albo opublikowana gałąź (/fix). */
  buildBase: z.enum(["fresh-main", "continue-branch"]).default("fresh-main").optional(),
  /** Dokładna nazwa opublikowanej gałęzi — wymagana dla continue-branch. */
  branch: z.string().optional(),
  /** Harness buildera tego ticketu — review wyklucza go w routingu (dywersyfikacja). */
  buildHarness: z.string().optional(),
  /** Rola joba research (wymagana dla kind=research). */
  researchRole: z.enum(["recon", "solution-a", "solution-b"]).optional(),
  /** Briefy researchu — wejście syntezy/krytyki i dodatkowy kontekst build/review. */
  briefs: briefsSchema.optional(),
  /** Klasyfikacja triage — kontekst syntezy i krytyki. */
  triageSummary: z.string().optional(),
  /** Uwagi krytyka planu — kontekst reviewera. */
  critique: z.string().optional(),
  /** Harness syntezy — krytyka wyklucza go w routingu (dywersyfikacja). */
  synthesisHarness: z.string().optional(),
});

export const factoryJobOutputSchema = z.object({
  kind: z.enum(["plan", "build", "review", "triage", "research", "synthesis", "critique"]),
  outcome: z.enum(["success", "questions", "failed"]),
  report: z.string(),
  errorCode: z.string().optional(),
  signature: z.string(),
  costUsd: z.number().optional(),
  durationMs: z.number(),
  plan: z.string().optional(),
  questions: z.string().optional(),
  files: z.array(z.string()).default([]),
  domain: z.string().optional(),
  branch: z.string().optional(),
  workspaceDir: z.string().optional(),
  headSha: z.string().optional(),
  /** SHA kodu, który agent faktycznie widział w swoim checkoutcie. */
  baseSha: z.string().optional(),
  changedFiles: z.array(z.string()).default([]),
  scopeWarnings: z.array(z.string()).default([]),
  reviewVerdict: z.enum(["lgtm", "advisory-fix", "unavailable"]).optional(),
  costSource: z.enum(["reported", "estimated-tokens", "estimated-time"]).optional(),
  /** Rekomendacja triage: ścieżka planowania. */
  triagePath: z.enum(["solo", "deep"]).optional(),
  /** Krótka klasyfikacja triage (typ/rozmiar/ryzyko). */
  triageSummary: z.string().optional(),
  /** Echo roli joba research — koordynator przypisuje brief/porażkę do roli. */
  researchRole: z.enum(["recon", "solution-a", "solution-b"]).optional(),
  /** Brief researchu (pełny raport agenta). */
  brief: z.string().optional(),
  critiqueVerdict: z.enum(["ok", "issues", "unavailable"]).optional(),
  /** Skoncentrowane uwagi krytyka — feedback rewizji syntezy i sekcja bramki. */
  critiqueIssues: z.string().optional(),
  /** Jedno zdanie dla autora ticketu; tekst prezentacyjny poza kontraktem `factory`. */
  critiqueMeaning: z.string().optional(),
});

export type FactoryJobInput = z.infer<typeof factoryJobInputSchema>;
export type FactoryJobOutput = z.infer<typeof factoryJobOutputSchema>;

/** Budżety wall-clock jobów; poller liczy z nich lease stall-detection. */
export const JOB_BUDGET_MINUTES = {
  plan: 20,
  build: 25,
  review: 10,
  triage: 5,
  research: 10,
  synthesis: 15,
  critique: 8,
} as const;

/** Twarde clipy tekstów przekazywanych między jobami (lekcja E2BIG, BAR-91). */
export const BRIEF_CLIP_CHARS = 24_000;
export const CRITIQUE_CLIP_CHARS = 6_000;
export const REVIEW_CLIP_CHARS = 8_000;
export const FIX_HINTS_CLIP_CHARS = 2_000;

export function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length <= max ? text : `${text.slice(0, max)}\n\n[…] (obcięte do ${max} znaków)`;
}

/**
 * Koszt efektywny próby: raport CLI > estymata tokenowa adaptera > estymata
 * czasowa (FACTORY_SYNTH_USD_PER_MIN). Budżet USD ticketu przestaje być ślepy
 * na silniki bez raportu kosztów (codex/kimi/pi).
 */
function effectiveCost(
  result: { costUsd?: number; costSource?: FactoryJobOutput["costSource"] },
  durationMs: number
): { costUsd: number; costSource: NonNullable<FactoryJobOutput["costSource"]> } {
  if (result.costUsd !== undefined) {
    return { costUsd: result.costUsd, costSource: result.costSource ?? "reported" };
  }
  const perMinute = Number(process.env.FACTORY_SYNTH_USD_PER_MIN ?? 0.15);
  return { costUsd: (durationMs / 60_000) * perMinute, costSource: "estimated-time" };
}

export interface FactoryJobRuntime {
  route(
    stage: Stage,
    ticket: { project: string; labels?: string[] },
    domain?: string,
    options?: { excludeEngine?: string }
  ): Promise<Route>;
  project(key: string): Promise<ProjectConfig>;
}

const defaultRuntime: FactoryJobRuntime = {
  route: resolveRoute,
  project: getProject,
};

type ReadOnlyJobKind = "plan" | "triage" | "research" | "synthesis" | "critique";
type ReadOnlyMetricStage =
  | "plan"
  | "triage"
  | "research-recon"
  | "research-solution-a"
  | "research-solution-b"
  | "synthesis"
  | "critique";

class BaseCheckoutUnavailableError extends Error {
  constructor(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    const detail = typeof stderr === "string" && stderr.trim() && !message.includes(stderr.trim())
      ? `${message}\nstderr: ${stderr.trim()}`
      : message;
    super(
      detail.startsWith("BASE_UNAVAILABLE:")
        ? detail
        : `BASE_UNAVAILABLE: nie udało się przygotować świeżego checkoutu bazy. ` +
          `Przyczyna: ${detail}`,
      { cause: error }
    );
    this.name = "BaseCheckoutUnavailableError";
  }
}

async function withBaseCheckout<T>(
  runtime: FactoryJobRuntime,
  ticket: FactoryJobInput["ticket"],
  kind: string,
  runId: string,
  signal: AbortSignal | undefined,
  fn: (base: { dir: string; sha: string }) => Promise<T>
): Promise<T> {
  const project = await runtime.project(ticket.project);
  let base: { dir: string; sha: string };
  try {
    base = await createBaseCheckout(
      project.repo,
      project.default_branch ?? "main",
      `${ticket.id}-${kind}-${runId}`,
      signal
    );
  } catch (error) {
    const terminationReason = (error as { terminationReason?: unknown } | null)
      ?.terminationReason;
    if (
      signal?.aborted ||
      terminationReason === "abort" ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw error;
    }
    throw new BaseCheckoutUnavailableError(error);
  }

  try {
    return await fn(base);
  } finally {
    await removeCheckout(project.repo, base.dir);
  }
}

async function baseUnavailableOutput(
  input: FactoryJobInput,
  runId: string,
  kind: ReadOnlyJobKind,
  stage: ReadOnlyMetricStage,
  artifactName: string,
  route: Route,
  signature: ActionSignature,
  startedAt: number,
  error: BaseCheckoutUnavailableError
): Promise<FactoryJobOutput> {
  const durationMs = Date.now() - startedAt;
  const errorCode = `${kind.toUpperCase()}_BASE_UNAVAILABLE`;
  const report = error.message;
  await recordMetric({
    ticket: input.ticket.id,
    runId,
    stage,
    engine: route.spec,
    attempt: input.attempt,
    ok: false,
    outcome: "base-unavailable",
    costUsd: 0,
    durationMs,
  });
  await saveArtifact(
    input.ticket.id,
    runId,
    artifactName,
    artifactHeader({
      jobId: runId,
      ticket: input.ticket.id,
      step: stage,
      attempt: input.attempt,
      outcome: "base-unavailable",
      ...signatureMeta(signature),
      engine: route.spec,
      costUsd: 0,
    }) + report
  );
  return {
    kind,
    outcome: "failed",
    report,
    errorCode,
    signature: signatureLine(signature),
    costUsd: 0,
    durationMs,
    researchRole: kind === "research" ? input.researchRole : undefined,
    critiqueVerdict: kind === "critique" ? "unavailable" : undefined,
    files: [],
    changedFiles: [],
    scopeWarnings: [],
  };
}

const planInstructions = [
  "Jesteś plannerem w fabryce software. Przygotuj implementowalny plan dla ticketu.",
  "Opisz zakres, poza zakresem, kryteria akceptacji, zmiany plik po pliku i testy.",
  "factory.files jest oczekiwaną listą zmian i wejściem do audytu ryzyka, nie blokadą zwykłych dodatkowych plików.",
  "Każda zmiana .github/, katalogu ops lub migracji musi być jawnie wymieniona.",
  "Jeżeli potrzebujesz odpowiedzi człowieka, zadaj ponumerowane pytania z A/B/C i rekomendacją.",
  "Nie używaj sesji ani suspend/resume. Każdy job planowania jest bezstanowy.",
  "ZACZNIJ raport sekcją `## Podsumowanie dla człowieka` — językiem product managera, bez nazw plików, bez API, bez żargonu.",
  "Sekcja ma zawierać pięć krótkich bloków: `**Co dostaniesz**`, `**Dlaczego tak**`, `**Czego świadomie NIE robimy**`, `**Kompromisy i czego to nie naprawi**`, `**Jak poznasz, że działa**`.",
  "Bloki `Czego świadomie NIE robimy` i `Kompromisy i czego to nie naprawi` są OBOWIĄZKOWE; jawnie wymień kompromisy bezpieczeństwa, wydajności i UX, jeżeli plan je zawiera.",
  "Ta sekcja NIE jest częścią kontraktu maszynowego — nie wstawiaj jej do bloku ```factory.",
  verdictInstruction("plan"),
].join("\n");

function planContext(input: FactoryJobInput): string {
  return [
    `# Ticket ${input.ticket.id}: ${input.ticket.title}`,
    input.ticket.description,
    input.ticket.commentContext ? `# Komentarze autora\n${input.ticket.commentContext}` : "",
    input.feedback ? `# Wiążąca odpowiedź/feedback\n${input.feedback}` : "",
  ].filter(Boolean).join("\n\n");
}

async function runPlan(
  input: FactoryJobInput,
  runId: string,
  signal?: AbortSignal,
  runtime: FactoryJobRuntime = defaultRuntime
): Promise<FactoryJobOutput> {
  const route = await runtime.route("plan", input.ticket);
  const signature = buildSignature("plan", route);
  const startedAt = Date.now();
  try {
    return await withBaseCheckout(runtime, input.ticket, "plan", runId, signal, async (base) => {
      const result = await route.engine.run({
        role: "plan",
        model: route.model,
        effort: route.effort,
        instructions: planInstructions,
        context: planContext(input),
        workspace: base.dir,
        budget: { minutes: JOB_BUDGET_MINUTES.plan },
        signal,
      });
      const durationMs = Date.now() - startedAt;
      const { costUsd, costSource } = effectiveCost(result, durationMs);
      const report = result.transcript ?? result.report;
      const summary = humanSummaryOf(report);
      const verdict = parsePlanVerdict(report);
      const outcome = !result.ok || verdict.source === "missing"
        ? "failed"
        : verdict.ok
          ? "success"
          : verdict.questions
            ? "questions"
            : "failed";
      const questions = verdict.questions ? formatClarifyQuestions(verdict.questions) : undefined;
      await recordMetric({
        ticket: input.ticket.id,
        runId,
        stage: "plan",
        engine: route.spec,
        attempt: input.attempt,
        ok: outcome !== "failed",
        outcome,
        costUsd,
        durationMs,
        baseSha: base.sha,
        resumed: false,
        humanSummary: summary ? "summary-present" : "summary-missing",
      });
      await saveArtifact(
        input.ticket.id,
        runId,
        `plan-attempt-${input.attempt}.md`,
        artifactHeader({
          jobId: runId,
          ticket: input.ticket.id,
          sha: base.sha,
          step: "plan",
          attempt: input.attempt,
          outcome,
          ...signatureMeta(signature),
          engine: route.spec,
          costUsd,
        }) + report
      );
      return {
        kind: "plan",
        outcome,
        report,
        errorCode: outcome === "failed"
          ? result.ok ? "PLAN_CONTRACT_MISSING" : "PLAN_ENGINE_FAILED"
          : undefined,
        signature: signatureLine(signature),
        costUsd,
        costSource,
        durationMs,
        plan: outcome === "success" ? report : undefined,
        questions,
        files: verdict.files,
        domain: verdict.domain,
        baseSha: base.sha,
        changedFiles: [],
        scopeWarnings: [],
      };
    });
  } catch (error) {
    if (!(error instanceof BaseCheckoutUnavailableError)) throw error;
    return baseUnavailableOutput(
      input,
      runId,
      "plan",
      "plan",
      `plan-attempt-${input.attempt}.md`,
      route,
      signature,
      startedAt,
      error
    );
  }
}

const triageInstructions = [
  "Jesteś triage'em fabryki software: TANIM, szybkim klasyfikatorem przed drogim planowaniem.",
  "Masz dostęp read-only do repo. Nie planuj implementacji — sklasyfikuj ticket.",
  "Oceń: typ (feature/bug/refactor/analytical/ops), rozmiar (S/M/L), domenę, flagi ryzyka",
  "(ścieżki chronione, migracje, auth, dane produkcyjne).",
  "Sprawdź, czy ticket nie jest duplikatem albo czy żądana zmiana już nie istnieje w kodzie —",
  "podejrzenie zgłoś jako pytanie z DOWODEM (plik/commit), nie jako pewnik.",
  "Jeżeli w tickecie brakuje informacji koniecznych do planowania, zadaj ponumerowane pytania A/B/C z rekomendacją.",
  "Rekomendacja ścieżki: solo = mały, dobrze określony ticket (1 job planu); deep = M/L albo flagi ryzyka",
  "(równoległy research → synteza → krytyka).",
  verdictInstruction("triage"),
].join("\n");

async function runTriage(
  input: FactoryJobInput,
  runId: string,
  signal?: AbortSignal,
  runtime: FactoryJobRuntime = defaultRuntime
): Promise<FactoryJobOutput> {
  const route = await runtime.route("triage", input.ticket);
  const signature = buildSignature("triage", route);
  const startedAt = Date.now();
  try {
    return await withBaseCheckout(runtime, input.ticket, "triage", runId, signal, async (base) => {
      const result = await route.engine.run({
        role: "plan",
        model: route.model,
        effort: route.effort,
        instructions: triageInstructions,
        context: planContext(input),
        workspace: base.dir,
        budget: { minutes: JOB_BUDGET_MINUTES.triage },
        signal,
      });
      const durationMs = Date.now() - startedAt;
      const { costUsd, costSource } = effectiveCost(result, durationMs);
      const report = result.transcript ?? result.report;
      const verdict = parseTriageVerdict(report);
      const outcome = !result.ok || verdict.source === "missing"
        ? "failed"
        : verdict.questions
          ? "questions"
          : "success";
      await recordMetric({
        ticket: input.ticket.id,
        runId,
        stage: "triage",
        engine: route.spec,
        attempt: input.attempt,
        ok: outcome !== "failed",
        outcome,
        costUsd,
        durationMs,
        baseSha: base.sha,
      });
      await saveArtifact(
        input.ticket.id,
        runId,
        `triage-attempt-${input.attempt}.md`,
        artifactHeader({
          jobId: runId,
          ticket: input.ticket.id,
          sha: base.sha,
          step: "triage",
          attempt: input.attempt,
          outcome: outcome === "success" ? `path:${verdict.path}` : outcome,
          ...signatureMeta(signature),
          engine: route.spec,
          costUsd,
        }) + report
      );
      return {
        kind: "triage",
        outcome,
        report,
        errorCode: outcome === "failed"
          ? result.ok ? "TRIAGE_CONTRACT_MISSING" : "TRIAGE_ENGINE_FAILED"
          : undefined,
        signature: signatureLine(signature),
        costUsd,
        costSource,
        durationMs,
        questions: verdict.questions ? formatClarifyQuestions(verdict.questions) : undefined,
        triagePath: verdict.path,
        triageSummary: verdict.summary,
        domain: verdict.domain,
        baseSha: base.sha,
        files: [],
        changedFiles: [],
        scopeWarnings: [],
      };
    });
  } catch (error) {
    if (!(error instanceof BaseCheckoutUnavailableError)) throw error;
    return baseUnavailableOutput(
      input,
      runId,
      "triage",
      "triage",
      `triage-attempt-${input.attempt}.md`,
      route,
      signature,
      startedAt,
      error
    );
  }
}

const researchInstructions: Record<"recon" | "solution-a" | "solution-b", string> = {
  recon: [
    "Jesteś researcherem RECON w fabryce software (read-only). NIE pisz planu ani kodu.",
    "Zmapuj teren pod implementację ticketu: pliki, które trzeba zmienić (konkretne ścieżki),",
    "istniejące wzorce i utilsy do reużycia, testy pokrywające okolicę, sprzężenia i konsumentów,",
    "implikacje ścieżek chronionych (.github/, ops/, migracje, konfiguracja testów).",
    "Wynik: zwięzły brief w Markdown z sekcjami: Pliki do zmiany · Wzorce do reużycia ·",
    "Testy okolicy · Sprzężenia/ryzyka strukturalne. Cytuj realne ścieżki z repo — nie zgaduj.",
  ].join("\n"),
  "solution-a": [
    "Jesteś researcherem ROZWIĄZANIA w fabryce software (read-only). NIE pisz finalnego planu ani kodu.",
    "Zaproponuj 2–3 warianty rozwiązania ticketu z trade-offami (złożoność, ryzyko, utrzymanie)",
    "i wskaż JEDNĄ rekomendację z uzasadnieniem.",
    "Wynik: zwięzły brief w Markdown: Warianty (A/B/C z trade-offami) · Rekomendacja · Założenia.",
  ].join("\n"),
  "solution-b": [
    "Jesteś NIEZALEŻNYM drugim researcherem rozwiązania w fabryce software (read-only). NIE pisz finalnego planu ani kodu.",
    "Nie zakładaj niczego o pracy innych agentów. Skup się na tym, co najłatwiej przeoczyć:",
    "edge case'y, tryby awarii, wpływ na istniejące zachowania, kompatybilność wsteczna,",
    "strategia testów (co MUSI być pokryte, żeby zmiana była bezpieczna).",
    "Wynik: zwięzły brief w Markdown: Edge case'y i ryzyka · Strategia testów · Pułapki implementacyjne.",
  ].join("\n"),
};

async function runResearch(
  input: FactoryJobInput,
  runId: string,
  signal?: AbortSignal,
  runtime: FactoryJobRuntime = defaultRuntime
): Promise<FactoryJobOutput> {
  const role = input.researchRole;
  if (!role) throw new Error("Research wymaga researchRole (recon | solution-a | solution-b).");
  const route = await runtime.route("research", input.ticket, role);
  const signature = buildSignature("research", route);
  const startedAt = Date.now();
  const stage = `research-${role}` as const;
  const artifactName = `${stage}-attempt-${input.attempt}.md`;
  try {
    return await withBaseCheckout(runtime, input.ticket, stage, runId, signal, async (base) => {
      const result = await route.engine.run({
        role: "plan",
        model: route.model,
        effort: route.effort,
        instructions: researchInstructions[role],
        context: [
          planContext(input),
          input.triageSummary ? `# Klasyfikacja triage\n${input.triageSummary}` : "",
        ].filter(Boolean).join("\n\n"),
        workspace: base.dir,
        budget: { minutes: JOB_BUDGET_MINUTES.research },
        signal,
      });
      const durationMs = Date.now() - startedAt;
      const { costUsd, costSource } = effectiveCost(result, durationMs);
      const brief = (result.transcript ?? result.report).trim();
      const outcome = result.ok && brief ? "success" : "failed";
      await recordMetric({
        ticket: input.ticket.id,
        runId,
        stage,
        engine: route.spec,
        attempt: input.attempt,
        ok: outcome === "success",
        outcome,
        costUsd,
        durationMs,
        baseSha: base.sha,
      });
      await saveArtifact(
        input.ticket.id,
        runId,
        artifactName,
        artifactHeader({
          jobId: runId,
          ticket: input.ticket.id,
          sha: base.sha,
          step: stage,
          attempt: input.attempt,
          outcome,
          ...signatureMeta(signature),
          engine: route.spec,
          costUsd,
        }) + (brief || result.report)
      );
      return {
        kind: "research",
        outcome,
        report: brief || result.report,
        errorCode: outcome === "failed"
          ? result.ok ? "RESEARCH_EMPTY" : "RESEARCH_ENGINE_FAILED"
          : undefined,
        signature: signatureLine(signature),
        costUsd,
        costSource,
        durationMs,
        researchRole: role,
        brief: outcome === "success" ? clip(brief, BRIEF_CLIP_CHARS) : undefined,
        baseSha: base.sha,
        files: [],
        changedFiles: [],
        scopeWarnings: [],
      };
    });
  } catch (error) {
    if (!(error instanceof BaseCheckoutUnavailableError)) throw error;
    return baseUnavailableOutput(
      input,
      runId,
      "research",
      stage,
      artifactName,
      route,
      signature,
      startedAt,
      error
    );
  }
}

function briefsContext(briefs: FactoryJobInput["briefs"]): string {
  if (!briefs) return "";
  const sections = [
    briefs.recon ? `## Brief RECON (mapa kodu)\n${briefs.recon}` : "",
    briefs["solution-a"] ? `## Brief ROZWIĄZANIE A (warianty + rekomendacja)\n${briefs["solution-a"]}` : "",
    briefs["solution-b"] ? `## Brief ROZWIĄZANIE B (edge case'y + strategia testów)\n${briefs["solution-b"]}` : "",
  ].filter(Boolean);
  return sections.length ? `# Briefy researchu\n\n${sections.join("\n\n")}` : "";
}

const synthesisInstructions = [
  "Jesteś syntezatorem planu w fabryce software. Z briefów researchu i ticketu złóż JEDEN implementowalny plan.",
  "Opisz zakres, poza zakresem, kryteria akceptacji, zmiany plik po pliku i testy.",
  "Tam, gdzie briefy się różnią albo przeczą, dodaj sekcję `## Rozstrzygnięcia` i jawnie uzasadnij wybór.",
  "factory.files jest oczekiwaną listą zmian i wejściem do audytu ryzyka, nie blokadą zwykłych dodatkowych plików.",
  "Każda zmiana .github/, katalogu ops lub migracji musi być jawnie wymieniona.",
  "Jeżeli mimo briefów potrzebujesz odpowiedzi człowieka, zadaj ponumerowane pytania z A/B/C i rekomendacją.",
  "Nie używaj sesji ani suspend/resume. Każdy job syntezy jest bezstanowy.",
  "ZACZNIJ raport sekcją `## Podsumowanie dla człowieka` — językiem product managera, bez nazw plików, bez API, bez żargonu.",
  "Sekcja ma zawierać pięć krótkich bloków: `**Co dostaniesz**`, `**Dlaczego tak**`, `**Czego świadomie NIE robimy**`, `**Kompromisy i czego to nie naprawi**`, `**Jak poznasz, że działa**`.",
  "Bloki `Czego świadomie NIE robimy` i `Kompromisy i czego to nie naprawi` są OBOWIĄZKOWE; jawnie wymień kompromisy bezpieczeństwa, wydajności i UX, jeżeli plan je zawiera.",
  "Ta sekcja NIE jest częścią kontraktu maszynowego — nie wstawiaj jej do bloku ```factory.",
  verdictInstruction("plan"),
].join("\n");

async function runSynthesis(
  input: FactoryJobInput,
  runId: string,
  signal?: AbortSignal,
  runtime: FactoryJobRuntime = defaultRuntime
): Promise<FactoryJobOutput> {
  const route = await runtime.route("synthesis", input.ticket);
  const signature = buildSignature("synthesis", route);
  const startedAt = Date.now();
  try {
    return await withBaseCheckout(runtime, input.ticket, "synthesis", runId, signal, async (base) => {
      const result = await route.engine.run({
        role: "plan",
        model: route.model,
        effort: route.effort,
        instructions: synthesisInstructions,
        context: [
          planContext(input),
          input.triageSummary ? `# Klasyfikacja triage\n${input.triageSummary}` : "",
          briefsContext(input.briefs),
        ].filter(Boolean).join("\n\n"),
        workspace: base.dir,
        budget: { minutes: JOB_BUDGET_MINUTES.synthesis },
        signal,
      });
      const durationMs = Date.now() - startedAt;
      const { costUsd, costSource } = effectiveCost(result, durationMs);
      const report = result.transcript ?? result.report;
      const summary = humanSummaryOf(report);
      const verdict = parsePlanVerdict(report);
      const outcome = !result.ok || verdict.source === "missing"
        ? "failed"
        : verdict.ok
          ? "success"
          : verdict.questions
            ? "questions"
            : "failed";
      await recordMetric({
        ticket: input.ticket.id,
        runId,
        stage: "synthesis",
        engine: route.spec,
        attempt: input.attempt,
        ok: outcome !== "failed",
        outcome,
        costUsd,
        durationMs,
        baseSha: base.sha,
        humanSummary: summary ? "summary-present" : "summary-missing",
      });
      await saveArtifact(
        input.ticket.id,
        runId,
        `synthesis-attempt-${input.attempt}.md`,
        artifactHeader({
          jobId: runId,
          ticket: input.ticket.id,
          sha: base.sha,
          step: "synthesis",
          attempt: input.attempt,
          outcome,
          ...signatureMeta(signature),
          engine: route.spec,
          costUsd,
        }) + report
      );
      return {
        kind: "synthesis",
        outcome,
        report,
        errorCode: outcome === "failed"
          ? result.ok ? "SYNTHESIS_CONTRACT_MISSING" : "SYNTHESIS_ENGINE_FAILED"
          : undefined,
        signature: signatureLine(signature),
        costUsd,
        costSource,
        durationMs,
        plan: outcome === "success" ? report : undefined,
        questions: verdict.questions ? formatClarifyQuestions(verdict.questions) : undefined,
        files: verdict.files,
        domain: verdict.domain,
        baseSha: base.sha,
        changedFiles: [],
        scopeWarnings: [],
      };
    });
  } catch (error) {
    if (!(error instanceof BaseCheckoutUnavailableError)) throw error;
    return baseUnavailableOutput(
      input,
      runId,
      "synthesis",
      "synthesis",
      `synthesis-attempt-${input.attempt}.md`,
      route,
      signature,
      startedAt,
      error
    );
  }
}

const critiqueInstructions = [
  "Jesteś krytykiem planu w fabryce software (read-only, silnik inny niż autor planu). NIE przepisuj planu.",
  "Sprawdź plan checklistą i spróbuj go ZŁAMAĆ:",
  "1. Czy kryteria akceptacji są testowalne i kompletne względem ticketu?",
  "2. Czy lista files jest kompletna vs brief RECON i realny kod (spot-check w repo)?",
  "3. Czy zmiany ścieżek chronionych (.github/, ops/, migracje) są jawnie zadeklarowane?",
  "4. Czy założenia planu zgadzają się ze stanem repo (nazwy, API, istniejące zachowania)?",
  "5. Czy zakres jest minimalny — bez zmian niewynikających z ticketu?",
  "Uwagi podawaj ponumerowane, z priorytetem i konkretną poprawką.",
  "Dodaj przed werdyktem sekcję `## Co to znaczy dla autora` — JEDNO zdanie po ludzku, co uwagi oznaczają dla autora ticketu (np. „Plan może przejść testy, nie rozwiązując zgłoszonego problemu”).",
  verdictInstruction("critique"),
].join("\n");

async function runCritique(
  input: FactoryJobInput,
  runId: string,
  signal?: AbortSignal,
  runtime: FactoryJobRuntime = defaultRuntime
): Promise<FactoryJobOutput> {
  if (!input.plan) throw new Error("Krytyka wymaga planu z syntezy.");
  const startedAt = Date.now();
  let route: Route;
  try {
    route = await runtime.route("critique", input.ticket, undefined, {
      excludeEngine: input.synthesisHarness,
    });
  } catch (error) {
    // Advisory: brak trasy/dywersyfikacji nie blokuje bramki — koordynator
    // pokaże ⚠️ "krytyka niedostępna" człowiekowi przy aprobacie.
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startedAt;
    await recordMetric({
      ticket: input.ticket.id,
      runId,
      stage: "critique",
      attempt: input.attempt,
      ok: false,
      outcome: "unavailable",
      durationMs,
    });
    return {
      kind: "critique",
      outcome: "failed",
      report: `Krytyka planu niedostępna: ${message}`,
      errorCode: "CRITIQUE_ROUTE_FAILED",
      signature: signatureLine({
        agent: "ai-factory",
        harness: "unavailable",
        model: "unavailable",
        profile: "critic",
      }),
      durationMs,
      critiqueVerdict: "unavailable",
      files: [],
      changedFiles: [],
      scopeWarnings: [],
    };
  }
  const signature = buildSignature("critique", route);
  try {
    return await withBaseCheckout(runtime, input.ticket, "critique", runId, signal, async (base) => {
      const result = await route.engine.run({
        role: "plan",
        model: route.model,
        effort: route.effort,
        instructions: critiqueInstructions,
        context: [
          `# Ticket ${input.ticket.id}: ${input.ticket.title}`,
          input.ticket.description,
          `# Plan do krytyki\n${input.plan}`,
          input.planFiles.length ? `# Zadeklarowane files\n${input.planFiles.join("\n")}` : "",
          input.briefs?.recon ? `# Brief RECON (do cross-checku files)\n${input.briefs.recon}` : "",
        ].filter(Boolean).join("\n\n"),
        workspace: base.dir,
        budget: { minutes: JOB_BUDGET_MINUTES.critique },
        signal,
      });
      const durationMs = Date.now() - startedAt;
      const { costUsd, costSource } = effectiveCost(result, durationMs);
      const report = result.transcript ?? result.report;
      const critiqueMeaning = critiqueMeaningOf(report);
      const verdict = parseCritiqueVerdict(report);
      const critiqueVerdict = !result.ok || verdict.source === "missing" ? "unavailable" : verdict.verdict;
      await recordMetric({
        ticket: input.ticket.id,
        runId,
        stage: "critique",
        engine: route.spec,
        attempt: input.attempt,
        ok: critiqueVerdict !== "unavailable",
        outcome: critiqueVerdict,
        costUsd,
        durationMs,
        baseSha: base.sha,
      });
      await saveArtifact(
        input.ticket.id,
        runId,
        `critique-attempt-${input.attempt}.md`,
        artifactHeader({
          jobId: runId,
          ticket: input.ticket.id,
          sha: base.sha,
          step: "critique",
          attempt: input.attempt,
          outcome: critiqueVerdict,
          ...signatureMeta(signature),
          engine: route.spec,
          costUsd,
        }) + report
      );
      return {
        kind: "critique",
        outcome: critiqueVerdict === "unavailable" ? "failed" : "success",
        report,
        errorCode: critiqueVerdict === "unavailable"
          ? result.ok ? "CRITIQUE_VERDICT_MISSING" : "CRITIQUE_ENGINE_FAILED"
          : undefined,
        signature: signatureLine(signature),
        costUsd,
        costSource,
        durationMs,
        critiqueVerdict,
        critiqueIssues: critiqueVerdict === "issues"
          ? clip(verdict.issues, CRITIQUE_CLIP_CHARS)
          : undefined,
        critiqueMeaning,
        baseSha: base.sha,
        files: [],
        changedFiles: [],
        scopeWarnings: [],
      };
    });
  } catch (error) {
    if (!(error instanceof BaseCheckoutUnavailableError)) throw error;
    return baseUnavailableOutput(
      input,
      runId,
      "critique",
      "critique",
      `critique-attempt-${input.attempt}.md`,
      route,
      signature,
      startedAt,
      error
    );
  }
}

async function runBuild(
  input: FactoryJobInput,
  runId: string,
  signal?: AbortSignal,
  runtime: FactoryJobRuntime = defaultRuntime
): Promise<FactoryJobOutput> {
  if (!input.plan) throw new Error("Build wymaga zatwierdzonego planu.");
  const project = await runtime.project(input.ticket.project);
  const domain = input.planDomain ?? resolveDomain(input.ticket.labels, input.plan);
  const route = await runtime.route("build", input.ticket, domain);
  const signature = buildSignature("build", route);
  const defaultBranch = project.default_branch ?? "main";
  const continueBranch = input.buildBase === "continue-branch";
  if (continueBranch && (!input.headSha || !input.branch)) {
    return {
      kind: "build",
      outcome: "failed",
      report:
        "FIX_BASE_INVALID: /fix wymaga SHA i nazwy ostatnio opublikowanej gałęzi. " +
        "Zamknij PR i użyj /replan.",
      errorCode: "FIX_BASE_INVALID",
      signature: signatureLine(signature),
      costUsd: 0,
      durationMs: 0,
      files: input.planFiles,
      changedFiles: [],
      scopeWarnings: [],
    };
  }
  let checkpointRef: string | undefined;
  if (input.headSha) {
    const verified = await execFileControlled(
      "git",
      ["-C", project.repo, "rev-parse", "--verify", `${input.headSha}^{commit}`]
    ).then(({ stdout }) => stdout.trim()).catch(() => undefined);
    if (verified) {
      await execFileControlled("git", ["-C", project.repo, "fetch", "origin", defaultBranch])
        .catch(() => {});
      const { stdout: base } = await execFileControlled(
        "git",
        ["-C", project.repo, "merge-base", verified, `origin/${defaultBranch}`]
      );
      const { stdout: names } = await execFileControlled(
        "git",
        ["-C", project.repo, "diff", "--name-only", "-z", `${base.trim()}...${verified}`]
      );
      const checkpointAudit = auditScope(
        input.planFiles,
        names.split("\0").filter(Boolean),
        project.scope?.protected ?? []
      );
      if (checkpointAudit.blocked.length) {
        throw new Error(`Checkpoint narusza aktualny plan:\n${checkpointAudit.blocked.join("\n")}`);
      }
      checkpointRef = verified;
    }
  }
  const slug = input.ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  const workspaceStartedAt = Date.now();
  let workspace: Awaited<ReturnType<typeof createWorkspace>>;
  try {
    workspace = await createWorkspace(
      project.repo,
      input.ticket.id,
      slug,
      defaultBranch,
      checkpointRef,
      continueBranch
        ? { mode: "continue-branch", branch: input.branch }
        : {}
    );
  } catch (error) {
    if (!continueBranch) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "build",
      outcome: "failed",
      report:
        `${message}\n\nBuilder nie został uruchomiony. ` +
        "Zamknij poprzedni PR i użyj /replan.",
      errorCode: "FIX_BASE_DIVERGED",
      signature: signatureLine(signature),
      costUsd: 0,
      durationMs: Date.now() - workspaceStartedAt,
      files: input.planFiles,
      branch: input.branch,
      headSha: input.headSha,
      changedFiles: [],
      scopeWarnings: [],
    };
  }
  const startedAt = Date.now();
  const feedback = input.feedback
    ? `\n\n# Raport zatrzymanego etapu do jawnej poprawki\n${input.feedback.slice(0, 16_000)}`
    : "";
  const result = await route.engine.run({
    role: "build",
    model: route.model,
    effort: route.effort,
    instructions: [
      "Zaimplementuj dokładnie zatwierdzony plan w bieżącym worktree.",
      "Nie commituj i nie publikuj zmian; checkpoint tworzy fabryka.",
      "Zwykły dodatkowy plik jest dozwolony, ale opisz go w raporcie.",
      "Nie zapisuj sekretów, kluczy ani lokalnych plików .env.",
      continueBranch
        ? "Worktree zawiera już opublikowaną pracę tego PR-a — popraw ją w miejscu, nie odtwarzaj planu od zera."
        : "",
    ].filter(Boolean).join("\n"),
    context: [
      `# Ticket ${input.ticket.id}: ${input.ticket.title}`,
      input.ticket.description,
      `# Zatwierdzony plan\n${input.plan}`,
      input.briefs?.recon
        ? `# Brief RECON (mapa kodu z researchu — pliki, wzorce, testy okolicy)\n${clip(input.briefs.recon, 16_000)}`
        : "",
      feedback,
    ].filter(Boolean).join("\n\n"),
    workspace: workspace.dir,
    budget: { minutes: JOB_BUDGET_MINUTES.build },
    signal,
  });
  const durationMs = Date.now() - startedAt;
  const { costUsd, costSource } = effectiveCost(result, durationMs);
  if (!result.ok) {
    await recordMetric({
      ticket: input.ticket.id,
      runId,
      stage: "build",
      engine: route.spec,
      attempt: input.attempt,
      ok: false,
      outcome: "engine-fail",
      costUsd,
      durationMs,
    });
    await saveArtifact(
      input.ticket.id,
      runId,
      `build-attempt-${input.attempt}.md`,
      artifactHeader({
        jobId: runId,
        ticket: input.ticket.id,
        step: "build",
        attempt: input.attempt,
        outcome: "engine-fail",
        ...signatureMeta(signature),
      }) + result.report
    );
    return {
      kind: "build",
      outcome: "failed",
      report: result.report,
      errorCode: "BUILD_ENGINE_FAILED",
      signature: signatureLine(signature),
      costUsd,
      costSource,
      durationMs,
      files: input.planFiles,
      branch: workspace.branch,
      workspaceDir: workspace.dir,
      headSha: workspace.checkpointSha,
      changedFiles: [],
      scopeWarnings: [],
    };
  }

  const changedFiles = await changedFilesInWorkspace(workspace.dir);
  if (!changedFiles.length) {
    return {
      kind: "build",
      outcome: "failed",
      report: `${result.report}\n\nBuilder nie pozostawił zmian do checkpointu.`,
      errorCode: "BUILD_NO_CHANGES",
      signature: signatureLine(signature),
      costUsd,
      costSource,
      durationMs,
      files: input.planFiles,
      branch: workspace.branch,
      workspaceDir: workspace.dir,
      headSha: workspace.checkpointSha,
      changedFiles: [],
      scopeWarnings: [],
    };
  }

  const audit = auditScope(input.planFiles, changedFiles, project.scope?.protected ?? []);
  if (audit.blocked.length) {
    return {
      kind: "build",
      outcome: "failed",
      report: `${result.report}\n\nPublikacja zablokowana:\n${audit.blocked.map((line) => `- ${line}`).join("\n")}`,
      errorCode: "SCOPE_BLOCKED",
      signature: signatureLine(signature),
      costUsd,
      costSource,
      durationMs,
      files: input.planFiles,
      branch: workspace.branch,
      workspaceDir: workspace.dir,
      headSha: workspace.checkpointSha,
      changedFiles,
      scopeWarnings: audit.warnings,
    };
  }

  await execFileControlled("git", ["-C", workspace.dir, "add", "-A"], { signal });
  await execFileControlled("git", [
    "-C",
    workspace.dir,
    "commit",
    "-m",
    [
      `feat(${input.ticket.id}): ${input.ticket.title}`,
      "",
      `[ai-factory job ${runId}]`,
      "",
      signatureTrailer(signature),
    ].join("\n"),
  ], { signal });
  const { stdout } = await execFileControlled(
    "git",
    ["-C", workspace.dir, "rev-parse", "HEAD"],
    { signal }
  );
  const headSha = stdout.trim();
  await recordMetric({
    ticket: input.ticket.id,
    runId,
    stage: "build",
    engine: route.spec,
    attempt: input.attempt,
    ok: true,
    outcome: "committed",
    costUsd,
    durationMs,
  });
  await saveArtifact(
    input.ticket.id,
    runId,
    `build-attempt-${input.attempt}.md`,
    artifactHeader({
      jobId: runId,
      ticket: input.ticket.id,
      sha: headSha,
      step: "build",
      attempt: input.attempt,
      outcome: "committed",
      ...signatureMeta(signature),
      warnings: audit.warnings.length,
    }) + result.report
  );
  return {
    kind: "build",
    outcome: "success",
    report: result.report,
    signature: signatureLine(signature),
    costUsd,
    costSource,
    durationMs,
    files: input.planFiles,
    branch: workspace.branch,
    workspaceDir: workspace.dir,
    headSha,
    changedFiles,
    scopeWarnings: audit.warnings,
  };
}

async function runReview(
  input: FactoryJobInput,
  runId: string,
  signal?: AbortSignal,
  runtime: FactoryJobRuntime = defaultRuntime
): Promise<FactoryJobOutput> {
  if (!input.headSha) throw new Error("Review wymaga dokładnego PR head SHA.");
  const project = await runtime.project(input.ticket.project);
  const route = await runtime.route("review", input.ticket, input.planDomain, {
    excludeEngine: input.buildHarness,
  });
  const signature = buildSignature("review", route);
  const checkout = await createCheckout(project.repo, input.headSha, `${input.ticket.id}-review-${runId}`);
  const startedAt = Date.now();
  try {
    const manifest = await changeManifest(checkout.dir, project.default_branch ?? "main");
    const result = await route.engine.run({
      role: "review",
      model: route.model,
      effort: route.effort,
      instructions: [
        "Wykonaj advisory code review dokładnego SHA. Nie zmieniaj plików.",
        "Zwróć konkretne uwagi z priorytetem. Ten job nigdy nie uruchamia buildera.",
        verdictInstruction("review"),
      ].join("\n"),
      context: [
        `# Ticket ${input.ticket.id}: ${input.ticket.title}`,
        `# SHA\n${input.headSha}`,
        `# Zatwierdzony plan\n${input.plan ?? "(brak)"}`,
        input.briefs?.["solution-b"]
          ? `# Brief ryzyk z researchu (edge case'y, strategia testów)\n${clip(input.briefs["solution-b"], 8_000)}`
          : "",
        input.critique
          ? `# Uwagi krytyka planu (advisory — sprawdź, czy zaadresowane)\n${clip(input.critique, CRITIQUE_CLIP_CHARS)}`
          : "",
        `# Zmiany\n${manifest.nameStatus}\n\n${manifest.diffStat}`,
      ].filter(Boolean).join("\n\n"),
      workspace: checkout.dir,
      budget: { minutes: JOB_BUDGET_MINUTES.review },
      signal,
    });
    const durationMs = Date.now() - startedAt;
    const { costUsd, costSource } = effectiveCost(result, durationMs);
    const report = result.transcript ?? result.report;
    const verdict = parseReviewVerdict(report);
    const reviewVerdict = !result.ok || verdict.source === "missing"
      ? "unavailable"
      : verdict.needsFix
        ? "advisory-fix"
        : "lgtm";
    await recordMetric({
      ticket: input.ticket.id,
      runId,
      stage: "review",
      engine: route.spec,
      attempt: input.attempt,
      ok: reviewVerdict !== "unavailable",
      outcome: reviewVerdict,
      costUsd,
      durationMs,
      baseSha: input.headSha,
    });
    await saveArtifact(
      input.ticket.id,
      runId,
      `review-attempt-${input.attempt}.md`,
      artifactHeader({
        jobId: runId,
        ticket: input.ticket.id,
        sha: input.headSha,
        step: "review",
        outcome: reviewVerdict,
        ...signatureMeta(signature),
      }) + report
    );
    return {
      kind: "review",
      outcome: reviewVerdict === "unavailable" ? "failed" : "success",
      report,
      errorCode: reviewVerdict === "unavailable" ? "REVIEW_VERDICT_MISSING" : undefined,
      signature: signatureLine(signature),
      costUsd,
      costSource,
      durationMs,
      files: input.planFiles,
      headSha: input.headSha,
      baseSha: input.headSha,
      changedFiles: [],
      scopeWarnings: [],
      reviewVerdict,
    };
  } finally {
    await removeCheckout(project.repo, checkout.dir);
  }
}

export async function executeFactoryJobInput(
  input: FactoryJobInput,
  runId: string,
  signal?: AbortSignal,
  runtime: FactoryJobRuntime = defaultRuntime
): Promise<FactoryJobOutput> {
  if (input.kind === "plan") return runPlan(input, runId, signal, runtime);
  if (input.kind === "triage") return runTriage(input, runId, signal, runtime);
  if (input.kind === "research") return runResearch(input, runId, signal, runtime);
  if (input.kind === "synthesis") return runSynthesis(input, runId, signal, runtime);
  if (input.kind === "critique") return runCritique(input, runId, signal, runtime);
  if (input.kind === "build") return runBuild(input, runId, signal, runtime);
  return runReview(input, runId, signal, runtime);
}

const executeFactoryJob = createStep({
  id: "execute-factory-job",
  inputSchema: factoryJobInputSchema,
  outputSchema: factoryJobOutputSchema,
  execute: async ({ inputData, runId, abortSignal }) =>
    executeFactoryJobInput(inputData, runId, abortSignal),
});

/**
 * Jedyny workflow Mastry używany przez fabrykę. Kończy się po jednym krótkim
 * zadaniu AI; nie czeka na człowieka, CI, merge ani smoke.
 */
export const factoryJob = createWorkflow({
  id: "factory-job",
  inputSchema: factoryJobInputSchema,
  outputSchema: factoryJobOutputSchema,
}).then(executeFactoryJob);

factoryJob.commit();
