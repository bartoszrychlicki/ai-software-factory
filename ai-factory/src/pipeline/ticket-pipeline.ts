import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, createCheckout, removeCheckout } from "./workspace";
import { getProject } from "./projects";
import { resolveRoute } from "./routing";
import { saveArtifact, artifactHeader } from "./artifacts";
import { buildSignature, signatureLine, signatureMeta, signatureTrailer } from "./signature";
import { takeScreenshot } from "./screenshot";
import { recordMetric } from "./metrics";
import { budgetExceeded } from "./budget";
import {
  formatClarifyQuestions,
  parsePlanVerdict,
  parseVerifyVerdict,
  parseReviewVerdict,
  resolveDomain,
  verdictInstruction,
  MISSING_VERDICT,
} from "./verdicts";
import { allQualityCommands, cleanExecutionEnv, fullBranchDiff, QualityGateError, runQualityCommands } from "./quality";
import { changedFilesInWorkspace, undeclaredChangedFiles } from "./scope";
import { waitForGithubChecks } from "./github-ci";

const exec = promisify(execFile);

const ticketSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  project: z.string(), // klucz z rejestru — potrzebny też routingowi
  repoPath: z.string(),
  github: z.string().optional(),
  checks: z.array(z.string()).optional(),
  githubCi: z.object({
    requiredChecks: z.array(z.string()).min(1),
    timeoutMinutes: z.number().positive(),
  }).optional(),
  screenshot: z.object({ start: z.string(), url: z.string() }).optional(),
  e2e: z.string().optional(), // komenda QA rundy 1 (uruchamiana w verify na świeżym checkoutcie)
  labels: z.array(z.string()).optional(), // m.in. override engine:*
  /** Plan-reuse: zatwierdzony plan z poprzedniego runu (porażka infra/budżet) — pomija planner i bramkę. */
  reusePlan: z.string().optional(),
});

const intakeInputSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  project: z.string(),
  labels: z.array(z.string()).optional(),
  reusePlan: z.string().optional(),
});

const planOutputSchema = z.object({
  ticket: ticketSchema,
  plan: z.string(),
  planCostUsd: z.number().optional(),
});

const opsResultSchema = z.object({
  kind: z.literal("ops"),
  ticketId: z.string(),
  plan: z.string(),
  planCostUsd: z.number().optional(),
});

/**
 * Stan pętli build→verify. Wejście == wyjście, bo dountil karmi
 * output cyklu z powrotem na jego wejście przy kolejnej iteracji.
 */
const cycleSchema = z.object({
  ticket: ticketSchema,
  plan: z.string(),
  attempt: z.number(),
  maxAttempts: z.number(),
  verdict: z.enum(["pending", "pass", "fail"]),
  feedback: z.string(), // strukturalny feedback dla NASTĘPNEJ próby buildera
  branch: z.string(),
  workspaceDir: z.string(),
  sha: z.string(),
  /** Dokładny SHA, który przeszedł pełne checks/e2e i acceptance verification. */
  verifiedSha: z.string(),
  changedFiles: z.array(z.string()),
  buildReport: z.string(),
  buildSignatureLine: z.string(),
  verifyReport: z.string(),
});

/**
 * Domena buildu → routing `build.<domena>` (BAR-133).
 *
 * Kolejność: label `domain:*` = ręczny override człowieka, dalej deklaracja
 * plannera z bloku `factory`. Bez tego frontend leciał defaultowym silnikiem,
 * dopóki ktoś nie pamiętał o labelu (BAR-92 run 1 poszedł w codex zamiast Opusa).
 * Nieznana wartość jest ignorowana — routing spada na default, nigdy nie wybucha.
 */
const ticketDomain = (ticket: { labels?: string[] }, plan?: string): string | undefined =>
  resolveDomain(ticket.labels, plan);

/** Metryka rozróżnia „planner zablokował" od „planner nie dotrzymał kontraktu" (BAR-147). */
const planOutcome = (v: { ok: boolean; source: string }) =>
  v.source === "missing" ? "verdict-missing" : v.ok ? "ok" : "blocked";

const PLAN_INSTRUCTIONS = [
  "Jesteś plannerem w fabryce software.",
  "Przygotuj implementowalny plan dla poniższego ticketu:",
  "- zakres i poza zakresem",
  "- kryteria akceptacji i sposób weryfikacji każdego",
  "- plan zmian plik po pliku",
  "- plan testów",
  "Decyzje kosmetyczne (separator, nazewnictwo, drobny format) podejmij SAM i odnotuj w planie — nie są niejasnością.",
  "Jeśli zmiana dotyka UI: podaj w bloku factory 1-4 ścieżki widoków w polu \"screenshots\" — fabryka zrobi z nich zrzuty do oceny przez człowieka.",
  "Jeśli ticketu NIE DA SIĘ bezpiecznie zaplanować bez odpowiedzi człowieka: verdict \"blocked\" i pytania w polu \"questions\" — ponumerowane, każde z opcjami A)/B)/C) i dopiskiem (REKOMENDACJA) przy tej, którą byś wybrał. Autor odpowie krótko (np. \"1A, 2C\") i doplanujesz z odpowiedziami w kontekście.",
  "Jeśli masz już odpowiedzi autora (sekcja poniżej ticketu) — potraktuj je jako wiążące decyzje i NIE zadawaj tych samych pytań ponownie.",
  "Jeśli stan opisany w tickecie JUŻ ISTNIEJE w kodzie (ticket spełniony): verdict \"blocked\" i wyjaśnienie w raporcie, BEZ pytań — nie planuj pustej pracy.",
  `W bloku factory wypełnij "files" KOMPLETNĄ listą plików, które ticket zmieni (ścieżki względem repo) — fabryka serializuje na ich podstawie równoległe tickety, więc pominięty plik grozi konfliktem merge'a.`,
  `Ticket klasy ops/infra bez zmian w repo może zwrócić pustą listę "files" — checklista jest wynikiem, nie lista plików kodu.`,
  `Oraz "domain": frontend | backend | fullstack | ops — na podstawie zakresu zmian; od tego zależy dobór silnika buildu.`,
  "Jeśli ticket jest klasy ops/infra: checklista opisuje bezpieczne kroki, lokalizacje i oczekiwany stan końcowy — NIGDY nie wpisuj wartości sekretów (haseł, tokenów ani kluczy).",
  verdictInstruction("plan"),
].join("\n");

interface PlanPromptState {
  ticket: { id: string; title: string; description: string };
  clarifyRound: number;
  answers: readonly string[];
  sessionId?: string;
}

/** Jeden builder promptu dla pipeline'u i kontrolowanego benchmarku A/B. */
export function buildPlanEnginePrompt(input: PlanPromptState): {
  instructions: string;
  context: string;
  sessionId?: string;
  resumed: boolean;
} {
  const resumed = input.clarifyRound > 0 && !!input.sessionId;
  if (resumed) {
    return {
      instructions: [
        "Wznawiasz wcześniejszą sesję planowania tego samego ticketu.",
        "Uwzględnij wiążącą odpowiedź autora poniżej i zwróć zaktualizowany, kompletny plan.",
        verdictInstruction("plan"),
      ].join("\n"),
      context: `# Odpowiedź autora ticketu — runda ${input.clarifyRound}\n\n${input.answers.at(-1) ?? ""}`,
      sessionId: input.sessionId,
      resumed: true,
    };
  }

  const answersBlock = input.answers.length
    ? "\n\n# Odpowiedzi autora ticketu na Twoje wcześniejsze pytania\n" +
      input.answers.map((answer, index) => `\n## Runda ${index + 1}\n${answer}`).join("\n")
    : "";
  return {
    instructions: PLAN_INSTRUCTIONS,
    context: `# Ticket ${input.ticket.id}: ${input.ticket.title}\n\n${input.ticket.description}${answersBlock}`,
    resumed: false,
  };
}

const intakeStep = createStep({
  id: "intake",
  description: "Intake: rozwiązanie projektu z rejestru (deterministyczny kod)",
  inputSchema: intakeInputSchema,
  outputSchema: ticketSchema,
  execute: async ({ inputData }) => {
    const project = await getProject(inputData.project);
    return {
      id: inputData.id,
      title: inputData.title,
      description: inputData.description,
      project: inputData.project,
      repoPath: project.repo,
      github: project.github,
      checks: project.checks,
      githubCi: project.ci
        ? { requiredChecks: project.ci.requiredChecks, timeoutMinutes: project.ci.timeoutMinutes ?? 20 }
        : undefined,
      screenshot: project.screenshot,
      e2e: project.qa?.e2e,
      labels: inputData.labels,
      reusePlan: inputData.reusePlan,
    };
  },
});

/**
 * Stan pętli plan↔dopytywanie: planner pyta autora (ABCD + rekomendacje) zamiast
 * twardego BLOCKED; odpowiedzi wracają komentarzem i doplanowuje w tym samym runie.
 */
const planCycleSchema = z.object({
  ticket: ticketSchema,
  plan: z.string(),
  planCostUsd: z.number().optional(),
  clarifyRound: z.number(),
  maxClarifyRounds: z.number(),
  answers: z.array(z.string()),
  sessionId: z.string().optional(),
});

const initPlanCycleStep = createStep({
  id: "init-plan-cycle",
  description: "Inicjalizacja pętli plan↔dopytywanie (deterministyczny kod)",
  inputSchema: ticketSchema,
  outputSchema: planCycleSchema,
  execute: async ({ inputData }) => ({
    ticket: inputData,
    plan: "",
    clarifyRound: 0,
    maxClarifyRounds: 2,
    answers: [],
    sessionId: undefined,
  }),
});

const planStep = createStep({
  id: "plan",
  description: "Planner: zamienia ticket (+ ew. odpowiedzi autora) w implementowalny plan",
  inputSchema: planCycleSchema,
  outputSchema: planCycleSchema,
  execute: async ({ inputData, runId }) => {
    const ticket = inputData.ticket;

    // plan-reuse: retry po porażce infra/budżetu nie pali tokenów na replan zatwierdzonej treści
    if (ticket.reusePlan && !inputData.plan) {
      const signature = {
        agent: "ai-factory",
        harness: "reuse",
        model: "reuse",
        profile: "planner" as const,
      };
      await recordMetric({ ticket: ticket.id, runId, stage: "plan", engine: "reuse", ok: true, outcome: "reused", costUsd: 0, durationMs: 0, resumed: false });
      await saveArtifact(ticket.id, runId, "plan.md",
        artifactHeader({ step: "plan", ...signatureMeta(signature), engine: "reuse", reused: "true", resumed: "false" }) + ticket.reusePlan);
      return { ...inputData, plan: ticket.reusePlan };
    }
    // plan już OK (wejście kolejnej iteracji) — nie przeplanowujemy
    if (inputData.plan && parsePlanVerdict(inputData.plan).ok) return inputData;

    const route = await resolveRoute("plan", ticket);
    const signature = buildSignature("plan", route);
    const attemptCosts: number[] = [];
    const runPlanner = async (candidate: ReturnType<typeof buildPlanEnginePrompt>) => {
      const startedAt = Date.now();
      const attempt = await route.engine.run({
        role: "plan",
        model: route.model,
        effort: route.effort,
        instructions: candidate.instructions,
        context: candidate.context,
        sessionId: candidate.sessionId,
        workspace: ticket.repoPath,
        // 5 min ubiło Fable@high na produkcyjnym repo (BAR-91: kill w 301 s) — mocne modele myślą dłużej
        budget: { minutes: 20 },
      });
      if (attempt.costUsd !== undefined) attemptCosts.push(attempt.costUsd);
      await recordMetric({
        ticket: ticket.id, runId, stage: "plan", engine: route.spec,
        ok: attempt.ok,
        outcome: attempt.ok ? planOutcome(parsePlanVerdict(attempt.transcript ?? attempt.report)) : "engine-fail",
        costUsd: attempt.costUsd, durationMs: Date.now() - startedAt,
        resumed: candidate.resumed,
      });
      return attempt;
    };

    let prompt = buildPlanEnginePrompt(inputData);
    let result = await runPlanner(prompt);
    const resumeFallback = prompt.resumed && !result.ok;
    if (resumeFallback) {
      // Sesja CLI mogła wygasnąć podczas wielogodzinnego oczekiwania na odpowiedź autora.
      // Pełny cold prompt pozwala dokończyć rundę bez zależności od tej sesji.
      prompt = buildPlanEnginePrompt({ ...inputData, sessionId: undefined });
      result = await runPlanner(prompt);
    }

    const totalCostUsd = attemptCosts.length
      ? attemptCosts.reduce((sum, cost) => sum + cost, 0)
      : undefined;
    await saveArtifact(
      ticket.id,
      runId,
      "plan.md",
      artifactHeader({
        step: "plan",
        ...signatureMeta(signature),
        engine: route.spec,
        costUsd: totalCostUsd,
        ok: String(result.ok),
        round: inputData.clarifyRound,
        resumed: String(prompt.resumed),
        resumeFallback: String(resumeFallback),
      }) + (result.transcript ?? result.report)
    );
    if (!result.ok) throw new Error(`Planner (${route.spec}) nie dostarczył planu: ${result.report}`);

    // do dalszych kroków idzie PEŁNY transkrypt: werdykt/pytania mogą siedzieć w wiadomości pośredniej
    return {
      ...inputData,
      plan: result.transcript ?? result.report,
      planCostUsd: (inputData.planCostUsd ?? 0) + (totalCostUsd ?? 0),
      sessionId: result.sessionId ?? (resumeFallback ? undefined : inputData.sessionId),
    };
  },
});

const clarifyGateStep = createStep({
  id: "clarify-ticket",
  description: "Dopytywanie: pytania ABCD do autora ticketu zamiast twardego BLOCKED (max 2 rundy)",
  inputSchema: planCycleSchema,
  outputSchema: planCycleSchema,
  suspendSchema: z.object({ questions: z.string() }),
  resumeSchema: z.object({ answers: z.string() }),
  execute: async ({ inputData, resumeData, suspend, runId }) => {
    const verdict = parsePlanVerdict(inputData.plan);
    if (verdict.ok) return inputData;
    const questions = verdict.questions ? formatClarifyQuestions(verdict.questions) : undefined;
    // BLOCKED bez pytań (np. ticket już zrealizowany) → finalize zablokuje twardo
    if (!questions || inputData.clarifyRound >= inputData.maxClarifyRounds) return inputData;
    if (!resumeData) {
      await saveArtifact(inputData.ticket.id, runId, `questions-round-${inputData.clarifyRound + 1}.md`,
        artifactHeader({ step: "clarify", round: inputData.clarifyRound + 1 }) + questions);
      await suspend({ questions });
      return inputData;
    }
    return {
      ...inputData,
      answers: [...inputData.answers, resumeData.answers],
      clarifyRound: inputData.clarifyRound + 1,
    };
  },
});

/** Zagnieżdżona pętla plan↔pytania — jednostka dountil (jak build-verify-cycle). */
const planClarifyCycle = createWorkflow({
  id: "plan-clarify-cycle",
  inputSchema: planCycleSchema,
  outputSchema: planCycleSchema,
})
  .then(planStep)
  .then(clarifyGateStep);
planClarifyCycle.commit();

const finalizePlanStep = createStep({
  id: "finalize-plan",
  description: "Bramka: plan bez werdyktu ok po rundach dopytywania = twardy BLOCKED (fail-closed)",
  inputSchema: planCycleSchema,
  outputSchema: planOutputSchema,
  execute: async ({ inputData }) => {
    const planVerdict = parsePlanVerdict(inputData.plan);
    const effectiveDomain = resolveDomain(inputData.ticket.labels, inputData.plan);
    const filesRequired = effectiveDomain !== "ops";
    if (!planVerdict.ok || (filesRequired && !planVerdict.files.length)) {
      const detail =
        planVerdict.source === "missing"
          ? `${MISSING_VERDICT}\n\n${inputData.plan.slice(0, 2000)}`
          : filesRequired && !planVerdict.files.length
            ? `Plan nie deklaruje żadnych plików w polu factory.files (wymagane poza domeną ops).\n\n${inputData.plan.slice(0, 2000)}`
            : (planVerdict.questions ? formatClarifyQuestions(planVerdict.questions) : inputData.plan.slice(0, 2000));
      throw new Error(
        `BLOCKED: plan bez kompletnego kontraktu factory${inputData.clarifyRound > 0 ? ` po ${inputData.clarifyRound} rundach dopytywania` : ""}. ` +
          `Uzupełnij ticket i przenieś go na Todo, żeby fabryka spróbowała ponownie.\n\n${detail}`
      );
    }
    return { ticket: inputData.ticket, plan: inputData.plan, planCostUsd: inputData.planCostUsd };
  },
});

const approvePlanStep = createStep({
  id: "approve-plan",
  description: "Human gate: akceptacja planu przed buildem (reuse = plan już raz zatwierdzony)",
  inputSchema: planOutputSchema,
  outputSchema: planOutputSchema,
  suspendSchema: z.object({
    plan: z.string(),
  }),
  resumeSchema: z.object({
    approved: z.boolean(),
    feedback: z.string().optional(),
  }),
  execute: async ({ inputData, resumeData, suspend, runId }) => {
    if (!resumeData) {
      // plan-reuse: treść była już zatwierdzona przez człowieka w poprzednim runie — druga bramka byłaby teatrem
      if (inputData.ticket.reusePlan) {
        await saveArtifact(inputData.ticket.id, runId, "approval.json",
          JSON.stringify({ approved: true, reused: true, at: new Date().toISOString(),
            descriptionHash: createHash("sha256").update(inputData.ticket.description).digest("hex") }, null, 2));
        return inputData;
      }
      await suspend({ plan: inputData.plan });
      return inputData;
    }
    await saveArtifact(
      inputData.ticket.id,
      runId,
      "approval.json",
      JSON.stringify({ approved: resumeData.approved, feedback: resumeData.feedback ?? null, at: new Date().toISOString(),
        // edycja ticketu po aprobacie unieważnia reuse (hash porównywany przy claimie)
        descriptionHash: createHash("sha256").update(inputData.ticket.description).digest("hex") }, null, 2)
    );
    if (!resumeData.approved) {
      throw new Error(`Plan odrzucony przez człowieka: ${resumeData.feedback ?? "bez uzasadnienia"}`);
    }
    return inputData;
  },
});

const awaitChecklistStep = createStep({
  id: "await-checklist",
  description: "Human gate ops: ręczne wykonanie checklisty przed read-only prodChecks",
  inputSchema: planOutputSchema,
  outputSchema: planOutputSchema,
  suspendSchema: z.object({ checklist: z.string() }),
  resumeSchema: z.object({ checklistDone: z.boolean() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      await suspend({ checklist: inputData.plan });
      return inputData;
    }
    if (!resumeData.checklistDone) {
      throw new Error("BLOCKED: checklista ops nie została potwierdzona jako wykonana.");
    }
    return inputData;
  },
});

const finalizeOpsStep = createStep({
  id: "finalize-ops",
  description: "Jawny wynik ops dla pollera — bez builda, PR, CI i code review",
  inputSchema: planOutputSchema,
  outputSchema: opsResultSchema,
  execute: async ({ inputData }) => ({
    kind: "ops" as const,
    ticketId: inputData.ticket.id,
    plan: inputData.plan,
    planCostUsd: inputData.planCostUsd,
  }),
});

const initCycleStep = createStep({
  id: "init-cycle",
  description: "Inicjalizacja pętli build→verify (deterministyczny kod)",
  inputSchema: planOutputSchema,
  outputSchema: cycleSchema,
  execute: async ({ inputData }) => ({
    ticket: inputData.ticket,
    plan: inputData.plan,
    attempt: 0,
    maxAttempts: 2,
    verdict: "pending" as const,
    feedback: "",
    branch: "",
    workspaceDir: "",
    sha: "",
    verifiedSha: "",
    changedFiles: [],
    buildReport: "",
    buildSignatureLine: "",
    verifyReport: "",
  }),
});

const buildStep = createStep({
  id: "build",
  description: "Builder: implementuje plan w izolowanym worktree (z feedbackiem poprzedniej próby)",
  inputSchema: cycleSchema,
  outputSchema: cycleSchema,
  execute: async ({ inputData, runId }) => {
    const { ticket, plan } = inputData;
    const attempt = inputData.attempt + 1;

    // twardy budżet ticketu — deterministyczny kod, nie agent (fail-closed = BLOCKED)
    const overBudget = await budgetExceeded(ticket, runId);
    if (overBudget) throw new Error(`BLOCKED: budżet ticketu wyczerpany przed próbą ${attempt} builda — ${overBudget}`);

    const slug = ticket.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30);
    // świeży worktree per próba — retry to nowa próba, nie grzebanie w brudzie
    const project = await getProject(ticket.project).catch(() => undefined);
    const ws = await createWorkspace(ticket.repoPath, ticket.id, slug, project?.default_branch ?? "main");

    // clip: raporty błędów bywają ogromne (echo komend) — nieprzycięte rozdęły prompt próby 2 do spawn E2BIG (BAR-91)
    const feedbackBlock = inputData.feedback
      ? `\n\n# FEEDBACK Z ODRZUCONEJ PRÓBY #${inputData.attempt}\nPoprzednia implementacja została odrzucona. Napraw wskazane problemy:\n${inputData.feedback.slice(0, 12_000)}`
      : "";

    const route = await resolveRoute("build", ticket, ticketDomain(ticket, inputData.plan));
    const signature = buildSignature("build", route);
    const saveBuild = (meta: Record<string, string | number | undefined>, body: string) =>
      saveArtifact(
        ticket.id,
        runId,
        `build-attempt-${attempt}.md`,
        artifactHeader({ step: "build", attempt, ...signatureMeta(signature), ...meta }) + body
      );
    const t0 = Date.now();
    const buildMetric = (ok: boolean, outcome: string, costUsd?: number) =>
      recordMetric({ ticket: ticket.id, runId, stage: "build", engine: route.spec, attempt, ok, outcome, costUsd, durationMs: Date.now() - t0 });
    const result = await route.engine.run({
      role: "build",
      model: route.model,
      effort: route.effort,
      instructions: [
        "Jesteś builderem. Zaimplementuj DOKŁADNIE poniższy plan w bieżącym katalogu.",
        "Nie wykraczaj poza zakres planu.",
        "NIE commituj zmian — commit wykonuje fabryka.",
        "Na końcu wypisz raport: co zmieniłeś i jak to zweryfikować.",
      ].join("\n"),
      context: `# Ticket ${ticket.id}: ${ticket.title}\n\n${ticket.description}\n\n# Plan\n\n${plan}${feedbackBlock}`,
      workspace: ws.dir,
      // 15 min ubiło Sol@xhigh na BAR-91 (Krok 0 + duża implementacja) — premium modele na złożonych ticketach potrzebują więcej
      budget: { minutes: 25 },
    });

    if (!result.ok) {
      await buildMetric(false, "engine-fail", result.costUsd);
      await saveBuild({ engine: route.spec, costUsd: result.costUsd, outcome: "engine-fail" }, result.report);
      return {
        ...inputData,
        attempt,
        verdict: "fail" as const,
        feedback: `Builder (${route.spec}) padł: ${result.report}`,
      };
    }

    // dowód pracy: git status, nie deklaracja agenta
    const changedFiles = await changedFilesInWorkspace(ws.dir);
    if (changedFiles.length === 0) {
      await buildMetric(false, "no-changes", result.costUsd);
      await saveBuild({ engine: route.spec, costUsd: result.costUsd, outcome: "no-changes" }, result.report);
      return {
        ...inputData,
        attempt,
        verdict: "fail" as const,
        feedback: "Builder nie zmienił żadnego pliku mimo deklaracji ukończenia.",
      };
    }

    const declaredFiles = parsePlanVerdict(plan).files;
    const undeclared = undeclaredChangedFiles(declaredFiles, changedFiles);
    if (undeclared.length) {
      await buildMetric(false, "scope-violation", result.costUsd);
      await saveBuild(
        { engine: route.spec, costUsd: result.costUsd, outcome: "scope-violation", files: undeclared.join(", ") },
        `${result.report}\n\nPliki spoza zatwierdzonego planu:\n${undeclared.map((file) => `- ${file}`).join("\n")}`
      );
      return {
        ...inputData,
        attempt,
        verdict: "fail" as const,
        feedback:
          `Builder zmienił pliki spoza zatwierdzonego kontraktu: ${undeclared.join(", ")}. ` +
          "Nie commituję zmian. Planner musi jawnie rozszerzyć zakres albo builder ma pozostać w zadeklarowanych plikach.",
      };
    }

    await exec("git", ["-C", ws.dir, "add", "-A"]);
    await exec("git", ["-C", ws.dir, "commit", "-m",
      `feat(${ticket.id}): ${ticket.title} (próba ${attempt})\n\n[ai-factory build]\n\n${signatureTrailer(signature)}`]);
    const { stdout: sha } = await exec("git", ["-C", ws.dir, "rev-parse", "HEAD"]);
    await buildMetric(true, "committed", result.costUsd);
    await saveBuild(
      { engine: route.spec, costUsd: result.costUsd, outcome: "committed", sha: sha.trim(), files: changedFiles.join(", ") },
      result.report
    );

    return {
      ...inputData,
      attempt,
      verdict: "pending" as const,
      feedback: "",
      branch: ws.branch,
      workspaceDir: ws.dir,
      sha: sha.trim(),
      verifiedSha: "",
      changedFiles,
      buildReport: result.report,
      buildSignatureLine: signatureLine(signature),
    };
  },
});

const verifyStep = createStep({
  id: "verify",
  description: "Verifier: świeży checkout SHA + checks projektu + niezależny werdykt",
  inputSchema: cycleSchema,
  outputSchema: cycleSchema,
  execute: async ({ inputData, runId }) => {
    // build padł — nie ma czego weryfikować, pętla zdecyduje o kolejnej próbie
    if (inputData.verdict === "fail") return inputData;

    const { ticket, sha } = inputData;
    let verifySignature: ReturnType<typeof buildSignature> | undefined;
    const saveVerify = (meta: Record<string, string | number | undefined>, body: string) =>
      saveArtifact(ticket.id, runId, `verify-attempt-${inputData.attempt}.md`,
        artifactHeader({
          step: "verify",
          attempt: inputData.attempt,
          sha,
          ...(verifySignature ? signatureMeta(verifySignature) : {}),
          ...meta,
        }) + body);
    const co = await createCheckout(ticket.repoPath, sha, `${ticket.id}-verify`);

    try {
      const route = await resolveRoute("verify", ticket);
      verifySignature = buildSignature("verify", route);
      // 1) Deterministycznie: checks PROJEKTU (z rejestru) na czystym env.
      const checks = ticket.checks ?? [];
      const checkResults: string[] = [];
      const cleanEnv = cleanExecutionEnv();

      for (const cmd of checks) {
        try {
          await runQualityCommands(co.dir, [cmd], { env: cleanEnv, timeoutMs: 10 * 60_000 });
        } catch (err) {
          const e = err instanceof QualityGateError ? err : new QualityGateError(cmd, String(err), 0, err);
          const tail = e.outputTail.slice(-3000);
          await recordMetric({
            ticket: ticket.id, runId, stage: "verify-checks", attempt: inputData.attempt,
            ok: false, outcome: `check-fail: ${cmd}`,
          });
          await saveVerify({ outcome: "check-fail", check: cmd }, `${e.message}\n\n${tail}`);
          return {
            ...inputData,
            verdict: "fail" as const,
            feedback: `Check "${cmd}" nie przeszedł na świeżym checkoutcie:\n${e.message}\n${tail}\n(checkout: ${co.dir})`,
          };
        }
        checkResults.push(`- \`${cmd}\` → OK`);
      }
      // QA runda 1: pełne e2e projektu na tym samym świeżym checkoutcie (po tanich checks — fail fast)
      if (ticket.e2e) {
        // screenshoty widoków wskazanych przez plannera (pole "screenshots" w bloku factory)
        // dziedziczy z configu repo zalogowaną sesję i seedowane dane; sprzątany PRZED werdyktem agenta
        const shotTargets = parsePlanVerdict(inputData.plan).screenshots.slice(0, 4);
        const shotsDir = join(co.dir, ".factory-shots");
        const shotSpec = join(co.dir, "e2e", "__factory-screens.spec.ts");
        if (shotTargets.length) {
          await mkdir(shotsDir, { recursive: true });
          await writeFile(shotSpec, [
            `import { test } from "@playwright/test";`,
            `const targets: string[] = ${JSON.stringify(shotTargets)};`,
            `for (const [i, path] of targets.entries()) {`,
            `  test(\`factory screenshot \${i + 1}: \${path}\`, async ({ page }) => {`,
            `    await page.goto(path);`,
            `    await page.waitForLoadState("networkidle");`,
            `    await page.screenshot({ path: \`${shotsDir}/screenshot-\${i + 1}.png\`, fullPage: true });`,
            `  });`,
            `}`,
          ].join("\n"));
        }
        const t0e2e = Date.now();
        try {
          await runQualityCommands(co.dir, [ticket.e2e], { env: cleanEnv, timeoutMs: 20 * 60_000 });
          for (const [i] of shotTargets.entries()) {
            const png = await readFile(join(shotsDir, `screenshot-${i + 1}.png`)).catch(() => undefined);
            if (png) await saveArtifact(ticket.id, runId, `screenshot-${i + 1}.png`, png);
          }
          await rm(shotSpec, { force: true }).catch(() => {});
          await rm(shotsDir, { recursive: true, force: true }).catch(() => {});
          await recordMetric({
            ticket: ticket.id, runId, stage: "verify-e2e", attempt: inputData.attempt,
            ok: true, outcome: "pass", durationMs: Date.now() - t0e2e,
          });
          checkResults.push(`- e2e (\`${ticket.e2e}\`) → OK`);
        } catch (err) {
          await rm(shotSpec, { force: true }).catch(() => {});
          await rm(shotsDir, { recursive: true, force: true }).catch(() => {});
          const e = err instanceof QualityGateError ? err : new QualityGateError(ticket.e2e, String(err), 0, err);
          const tail = e.outputTail.slice(-4000);
          await recordMetric({
            ticket: ticket.id, runId, stage: "verify-e2e", attempt: inputData.attempt,
            ok: false, outcome: "fail", durationMs: Date.now() - t0e2e,
          });
          await saveVerify({ outcome: "e2e-fail" }, `${e.message}\n\n${tail}`);
          return {
            ...inputData,
            verdict: "fail" as const,
            feedback: `Testy e2e nie przeszły na świeżym checkoutcie:\n${tail}\n(checkout: ${co.dir})`,
          };
        }
      }

      const checksSummary = checkResults.join("\n");

      // 2) Diff dla agenta-werdyktu
      const project = await getProject(ticket.project);
      const diff = await fullBranchDiff(co.dir, project.default_branch ?? "main");

      // 3) Niezależny werdykt: osobny run, read-only, czysty katalog
      const overBudget = await budgetExceeded(ticket, runId);
      if (overBudget) throw new Error(`BLOCKED: budżet ticketu wyczerpany przed werdyktem verify — ${overBudget}`);
      const t0 = Date.now();
      const result = await route.engine.run({
        role: "verify",
        model: route.model,
      effort: route.effort,
        instructions: [
          "Jesteś niezależnym weryfikatorem w ai fabryce software.",
          "Oceń, czy diff realizuje ticket zgodnie z planem:",
          "- każde kryterium akceptacji ma pokrycie w zmianach?",
          "- brak zmian poza zakresem planu?",
          "- jakość: oczywiste błędy, regresje, edge case'y?",
          verdictInstruction("verify"),
          "Potem uzasadnienie punktowo. Bądź surowy — wątpliwość = FAIL.",
        ].join("\n"),
        context: [
          `# Ticket ${ticket.id}: ${ticket.title}`,
          ticket.description,
          "",
          "# Plan",
          inputData.plan,
          "",
          "# Pełny diff brancha względem aktualnej bazy",
          diff.slice(0, 60_000),
          "",
          "# Checks projektu wykonane przez fabrykę na świeżym checkoutcie:",
          checksSummary,
        ].join("\n"),
        workspace: co.dir,
        budget: { minutes: 5 },
      });

      if (!result.ok) {
        await recordMetric({
          ticket: ticket.id, runId, stage: "verify", engine: route.spec, attempt: inputData.attempt,
          ok: false, outcome: "engine-fail", costUsd: result.costUsd, durationMs: Date.now() - t0,
        });
        await saveVerify({ engine: route.spec, costUsd: result.costUsd, outcome: "engine-fail" }, result.report);
        return {
          ...inputData,
          verdict: "fail" as const,
          feedback: `Verifier (${route.spec}) padł: ${result.report}`,
        };
      }

      const verifyVerdict = parseVerifyVerdict(result.transcript ?? result.report);
      const pass = verifyVerdict.pass;
      if (verifyVerdict.source === "missing") console.warn(`[${ticket.id}] verify: ${MISSING_VERDICT}`);
      await recordMetric({
        ticket: ticket.id, runId, stage: "verify", engine: route.spec, attempt: inputData.attempt,
        ok: true, outcome: verifyVerdict.source === "missing" ? "verdict-missing" : pass ? "pass" : "fail",
        costUsd: result.costUsd, durationMs: Date.now() - t0,
      });
      await saveVerify(
        { engine: route.spec, costUsd: result.costUsd, outcome: pass ? "pass" : "fail", checks: checksSummary.replace(/\n/g, "; ") },
        result.report
      );
      if (!pass) {
        return {
          ...inputData,
          verdict: "fail" as const,
          feedback: (verifyVerdict.source === "missing" ? `${MISSING_VERDICT}\n\n` : "") + result.report, // pełny raport FAIL = feedback dla następnej próby
          verifyReport: result.report,
        };
      }

      // podgląd wyniku dla człowieka — doradczy, nie blokuje (checkout ma już node_modules po npm ci)
      if (ticket.screenshot) {
        const png = await takeScreenshot(co.dir, ticket.screenshot, cleanEnv);
        if (png) await saveArtifact(ticket.id, runId, "screenshot.png", png);
      }

      return { ...inputData, verdict: "pass" as const, verifiedSha: sha, verifyReport: result.report };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ...inputData,
        verdict: "fail" as const,
        feedback: `Błąd infrastruktury verify: ${msg}\n(checkout: ${co.dir})`,
      };
    } finally {
      await removeCheckout(ticket.repoPath, co.dir);
    }
  },
});

type CycleState = z.infer<typeof cycleSchema>;

/**
 * Każdy SHA utworzony po pierwotnym verify (merge z mainem albo review-fix)
 * ponownie przechodzi pełne checks/e2e i acceptance verification na czystym checkoutcie.
 */
async function reverifyExactSha(
  inputData: CycleState,
  runId: string,
  reason: string
): Promise<CycleState> {
  if (inputData.sha === inputData.verifiedSha) return inputData;
  const { ticket, sha } = inputData;
  let verifySignature: ReturnType<typeof buildSignature> | undefined;
  const co = await createCheckout(ticket.repoPath, sha, `${ticket.id}-final-${reason}`);
  const artifactName = `verify-final-${reason}-${sha.slice(0, 8)}.md`;
  try {
    const route = await resolveRoute("verify", ticket);
    const signature = buildSignature("verify", route);
    verifySignature = signature;
    const cleanEnv = cleanExecutionEnv();
    const commands = allQualityCommands(ticket);
    await runQualityCommands(co.dir, commands, { env: cleanEnv, timeoutMs: 20 * 60_000 });
    const checksSummary = commands.map((command) => `- \`${command}\` → OK`).join("\n");
    const project = await getProject(ticket.project);
    const diff = await fullBranchDiff(co.dir, project.default_branch ?? "main");
    const overBudget = await budgetExceeded(ticket, runId);
    if (overBudget) throw new Error(`budżet ticketu wyczerpany przed finalnym verify — ${overBudget}`);

    const startedAt = Date.now();
    const result = await route.engine.run({
      role: "verify",
      model: route.model,
      effort: route.effort,
      instructions: [
        "Jesteś niezależnym weryfikatorem finalnego SHA w fabryce software.",
        `Powód ponownej weryfikacji: ${reason}.`,
        "Oceń pełny diff aktualnego SHA względem main:",
        "- każde kryterium akceptacji ticketu nadal ma pokrycie?",
        "- poprawka lub merge nie zmieniły zachowania poza zakresem?",
        "- checks i e2e dotyczą dokładnie tego SHA?",
        verdictInstruction("verify"),
        "Wątpliwość = FAIL.",
      ].join("\n"),
      context: [
        `# Ticket ${ticket.id}: ${ticket.title}`,
        ticket.description,
        "",
        "# Plan",
        inputData.plan,
        "",
        `# Finalny SHA: ${sha}`,
        diff.slice(0, 60_000),
        "",
        "# Checks na czystym checkoutcie",
        checksSummary,
      ].join("\n"),
      workspace: co.dir,
      budget: { minutes: 5 },
    });
    const verdict = result.ok ? parseVerifyVerdict(result.transcript ?? result.report) : undefined;
    const pass = !!result.ok && !!verdict?.pass;
    await recordMetric({
      ticket: ticket.id,
      runId,
      stage: "verify",
      engine: route.spec,
      attempt: inputData.attempt,
      ok: result.ok,
      outcome: pass ? `final-pass:${reason}` : `final-fail:${reason}`,
      costUsd: result.costUsd,
      durationMs: Date.now() - startedAt,
    });
    await saveArtifact(
      ticket.id,
      runId,
      artifactName,
      artifactHeader({
        step: "verify-final",
        reason,
        sha,
        ...signatureMeta(signature),
        engine: route.spec,
        outcome: pass ? "pass" : "fail",
      }) +
        `${result.report}\n\n# Checks\n${checksSummary}`
    );
    if (!pass) {
      const detail = !result.ok
        ? `Verifier (${route.spec}) padł: ${result.report}`
        : verdict?.source === "missing"
          ? `${MISSING_VERDICT}\n\n${result.report}`
          : result.report;
      throw new Error(`Finalny SHA ${sha} nie przeszedł acceptance verification (${reason}):\n${detail}`);
    }
    return {
      ...inputData,
      verdict: "pass" as const,
      verifiedSha: sha,
      verifyReport: result.report,
    };
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("Finalny SHA"))) {
      await saveArtifact(
        ticket.id,
        runId,
        artifactName,
        artifactHeader({
          step: "verify-final",
          reason,
          sha,
          ...(verifySignature ? signatureMeta(verifySignature) : {}),
          outcome: "infra-error",
        }) +
          (err instanceof Error ? err.message : String(err))
      ).catch(() => {});
    }
    throw err;
  } finally {
    await removeCheckout(ticket.repoPath, co.dir);
  }
}

/** Zagnieżdżony cykl build→verify — jednostka pętli dountil. */
const buildVerifyCycle = createWorkflow({
  id: "build-verify-cycle",
  inputSchema: cycleSchema,
  outputSchema: cycleSchema,
})
  .then(buildStep)
  .then(verifyStep);
buildVerifyCycle.commit();

const assertVerifiedStep = createStep({
  id: "assert-verified",
  description: "Bramka: bez PASS nie ma publikacji (fail-closed)",
  inputSchema: cycleSchema,
  outputSchema: cycleSchema,
  execute: async ({ inputData }) => {
    if (inputData.verdict !== "pass") {
      throw new Error(
        `BLOCKED po ${inputData.attempt}/${inputData.maxAttempts} próbach. Ostatni feedback:\n${inputData.feedback}`
      );
    }
    return inputData;
  },
});

const publishOutputSchema = cycleSchema.extend({ prUrl: z.string() });

const publishStep = createStep({
  id: "publish",
  description: "Publish: push brancha + draft PR (deterministyczny kod)",
  inputSchema: cycleSchema,
  outputSchema: publishOutputSchema,
  execute: async ({ inputData, runId }) => {
    let { ticket, branch, workspaceDir } = inputData;
    if (!ticket.github) {
      throw new Error("Projekt nie ma repo GitHub w rejestrze — publish niemożliwy");
    }

    // MERGE-QUEUE (BAR-123): publikujemy wyłącznie gałąź zsynchronizowaną z mainem i przechodzącą
    // checks NA SCALONYM drzewie — inaczej PR ląduje w konflikcie albo wnosi konflikt semantyczny
    // (dwie gałęzie zielone osobno, po scaleniu czerwone — BAR-106+BAR-111, noc 2026-07-22)
    const project = await getProject(ticket.project).catch(() => undefined);
    const def = project?.default_branch ?? "main";
    await exec("git", ["-C", workspaceDir, "fetch", "origin", def]);
    const { stdout: behind } = await exec("git", ["-C", workspaceDir, "rev-list", "--count", `HEAD..origin/${def}`]);

    if (Number(behind.trim()) > 0) {
      try {
        await exec("git", ["-C", workspaceDir, "merge", `origin/${def}`, "--no-edit"]);
      } catch {
        const { stdout: conflicted } = await exec("git", ["-C", workspaceDir, "diff", "--diff-filter=U", "--name-only"]).catch(() => ({ stdout: "" }));
        await exec("git", ["-C", workspaceDir, "merge", "--abort"]).catch(() => {});
        throw new Error(
          `BLOCKED: konflikt z ${def} przy publikacji (pliki: ${conflicted.trim().split("\n").filter(Boolean).join(", ") || "?"}). ` +
            `Main przesunął się w trakcie builda. Nadaj label ponownie — reuse planu zbuduje na świeżym mainie.`
        );
      }

      const t0mq = Date.now();
      const { stdout: newSha } = await exec("git", ["-C", workspaceDir, "rev-parse", "HEAD"]);
      inputData = { ...inputData, sha: newSha.trim(), verifiedSha: "" };
      try {
        inputData = await reverifyExactSha(inputData, runId, "merge-main");
      } catch (err) {
        await recordMetric({ ticket: ticket.id, runId, stage: "merge-queue", ok: false, outcome: "recheck-fail", durationMs: Date.now() - t0mq });
        await saveArtifact(
          ticket.id,
          runId,
          "merge-queue.md",
          artifactHeader({ step: "merge-queue", outcome: "recheck-fail", behind: behind.trim() }) +
            (err instanceof Error ? err.message : String(err))
        );
        throw new Error(`BLOCKED: scalony SHA nie przeszedł pełnej weryfikacji.\n${err instanceof Error ? err.message : err}`);
      }
      await recordMetric({ ticket: ticket.id, runId, stage: "merge-queue", ok: true, outcome: "rebased", durationMs: Date.now() - t0mq });
      await saveArtifact(
        ticket.id,
        runId,
        "merge-queue.md",
        artifactHeader({ step: "merge-queue", outcome: "rebased", behind: behind.trim(), sha: inputData.sha }) +
          `Gałąź zaktualizowana o ${behind.trim()} commit(ów) z ${def}; checks, e2e i acceptance verify: OK.`
      );
    }

    if (!inputData.verifiedSha || inputData.verifiedSha !== inputData.sha) {
      throw new Error(`BLOCKED: publish odrzucony — SHA ${inputData.sha} nie ma zgodnego verifiedSha.`);
    }

    await exec("git", ["-C", workspaceDir, "push", "-u", "--force-with-lease", "origin", branch]);

    // opis PR przez plik — omijamy limity długości i escapowanie argumentów
    const bodyFile = join(tmpdir(), `pr-${ticket.id}.md`);
    await writeFile(bodyFile, [
      `Ticket: ${ticket.id} — ${ticket.title}`,
      `Próby build→verify: ${inputData.attempt}/${inputData.maxAttempts}`,
      "",
      "## Plan",
      inputData.plan,
      "",
      "## Raport buildera",
      inputData.buildReport,
      "",
      "## Raport verifiera (świeży checkout, checks projektu: OK)",
      inputData.verifyReport,
      "",
      "## Zmienione pliki",
      ...inputData.changedFiles.map((f) => `- ${f}`),
      "",
      "## Podpis",
      `Etap build: ${inputData.buildSignatureLine}`,
      "",
      "_Wygenerowane przez ai-factory._",
    ].join("\n"));

    // PR może już istnieć po poprzednim runie tego ticketu — wtedy tylko aktualizujemy branch
    let prUrl = "";
    try {
      const { stdout } = await exec(
        "gh",
        ["pr", "create", "--draft", "--head", branch,
         "--title", `feat(${ticket.id}): ${ticket.title}`,
         "--body-file", bodyFile],
        { cwd: workspaceDir }
      );
      prUrl = stdout.trim();
    } catch {
      const { stdout } = await exec(
        "gh",
        ["pr", "view", branch, "--json", "url", "--jq", ".url"],
        { cwd: workspaceDir }
      );
      prUrl = stdout.trim();
    }

    await saveArtifact(ticket.id, runId, "result.json", JSON.stringify({
      prUrl,
      branch,
      sha: inputData.sha,
      verifiedSha: inputData.verifiedSha,
      attempt: inputData.attempt,
      maxAttempts: inputData.maxAttempts,
      changedFiles: inputData.changedFiles,
      at: new Date().toISOString(),
    }, null, 2));
    return { ...inputData, prUrl };
  },
});

async function runGithubCiGate(
  inputData: z.infer<typeof publishOutputSchema>,
  runId: string,
  reason: string
): Promise<z.infer<typeof publishOutputSchema>> {
  const { ticket } = inputData;
  if (!ticket.githubCi) throw new Error(`BLOCKED: projekt ${ticket.project} nie ma konfiguracji GitHub CI.`);
  if (inputData.sha !== inputData.verifiedSha) {
    throw new Error(`BLOCKED: GitHub CI nie może zatwierdzić niezweryfikowanego SHA ${inputData.sha}.`);
  }
  const startedAt = Date.now();
  try {
    const result = await waitForGithubChecks({
      cwd: inputData.workspaceDir,
      pr: inputData.prUrl,
      expectedSha: inputData.sha,
      requiredChecks: ticket.githubCi.requiredChecks,
      timeoutMs: ticket.githubCi.timeoutMinutes * 60_000,
    });
    await recordMetric({
      ticket: ticket.id,
      runId,
      stage: "github-ci",
      ok: true,
      outcome: `pass:${reason}`,
      durationMs: Date.now() - startedAt,
    });
    await saveArtifact(
      ticket.id,
      runId,
      `github-ci-${reason}-${inputData.sha.slice(0, 8)}.md`,
      artifactHeader({ step: "github-ci", reason, sha: inputData.sha, outcome: "pass" }) + result.report
    );
    return inputData;
  } catch (err) {
    await recordMetric({
      ticket: ticket.id,
      runId,
      stage: "github-ci",
      ok: false,
      outcome: `fail:${reason}`,
      durationMs: Date.now() - startedAt,
    });
    await saveArtifact(
      ticket.id,
      runId,
      `github-ci-${reason}-${inputData.sha.slice(0, 8)}.md`,
      artifactHeader({ step: "github-ci", reason, sha: inputData.sha, outcome: "fail" }) +
        (err instanceof Error ? err.message : String(err))
    );
    throw new Error(`BLOCKED: GitHub CI gate nie przeszedł dla ${inputData.sha}.\n${err instanceof Error ? err.message : err}`);
  }
}

const githubCiStep = createStep({
  id: "github-ci",
  description: "GitHub CI: wymagane checks muszą przejść dla dokładnego PR head SHA",
  inputSchema: publishOutputSchema,
  outputSchema: publishOutputSchema,
  execute: async ({ inputData, runId }) => runGithubCiGate(inputData, runId, "publish"),
});

/**
 * Pętla review→fix: recenzja PR z werdyktem; przy uwagach builder poprawia
 * w tym samym worktree, checks pilnują regresji, push aktualizuje PR — aż do
 * werdyktu lgtm albo wyczerpania rund. Werdykt doradczy: po rundach z uwagami
 * PR zostaje, decyzja przy merge jest ludzka.
 */
const reviewCycleSchema = publishOutputSchema.extend({
  reviewRound: z.number(),
  maxReviewRounds: z.number(),
  reviewVerdict: z.enum(["pending", "lgtm", "fix", "skipped"]),
  reviewSummary: z.string(),
  /** Pamięć pętli (BAR-125): werdykty i uwagi poprzednich rund — trafiają do promptów. */
  reviewHistory: z.array(z.object({ round: z.number(), verdict: z.string(), notes: z.string() })),
  /** Ta sama uwaga wróciła = pętla się kręci w kółko; kończymy zamiast palić rundy. */
  oscillation: z.boolean(),
});

const codeResultSchema = reviewCycleSchema.extend({ kind: z.literal("code") });
const workflowResultSchema = z.discriminatedUnion("kind", [codeResultSchema, opsResultSchema]);
export type TicketWorkflowResult = z.infer<typeof workflowResultSchema>;

/**
 * Uwagi review jako porównywalny zbiór (BAR-125). Normalizacja zdejmuje numery
 * linii, wielkość liter i interpunkcję — ta sama uwaga sformułowana inaczej
 * w kolejnej rundzie nadal ma się dopasować.
 */
export function noteKeys(report: string): Set<string>[] {
  return report
    .replace(/```factory[\s\S]*?```/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*\d]/.test(l) && l.length > 15)
    .map(
      (l) =>
        new Set(
          l
            .toLowerCase()
            .normalize("NFD")
            .replace(/\p{M}/gu, "") // bez ogonków: „źródło" i „zrodlo" to ta sama uwaga
            .replace(/:\d+/g, "") // numer linii się przesuwa między rundami
            .replace(/[^\p{L}\p{N} ]+/gu, " ")
            .split(/\s+/)
            .filter((w) => w.length > 2)
        )
    )
    .filter((s) => s.size >= 3);
}

/** Jaccard na słowach — dwie uwagi o tym samym, inaczej sformułowane, nadal się dopasowują. */
function sameNote(a: Set<string>, b: Set<string>): boolean {
  const inter = [...a].filter((w) => b.has(w)).length;
  return inter / Math.min(a.size, b.size) >= 0.5;
}

/** Ile uwag z mniejszej rundy ma odpowiednik w drugiej — odporne na rundę z jedną uwagą. */
export function noteOverlap(a: Set<string>[], b: Set<string>[]): number {
  if (!a.length || !b.length) return 0;
  const matched = a.filter((n) => b.some((m) => sameNote(n, m))).length;
  return matched / Math.min(a.length, b.length);
}

const OSCILLATION_THRESHOLD = 0.6;

/** Skrót poprzednich rund doklejany do promptu recenzenta i buildera. */
function historyBlock(history: { round: number; verdict: string; notes: string }[]): string {
  if (!history.length) return "";
  return (
    "\n\n# Historia poprzednich rund review (kontekst — NIE cofaj wprowadzonych na ich podstawie poprawek)\n" +
    history.map((h) => `\n## Runda ${h.round} — werdykt: ${h.verdict}\n${h.notes.slice(0, 2500)}`).join("\n")
  );
}

const initReviewCycleStep = createStep({
  id: "init-review-cycle",
  description: "Inicjalizacja pętli review→fix (deterministyczny kod)",
  inputSchema: publishOutputSchema,
  outputSchema: reviewCycleSchema,
  execute: async ({ inputData }) => ({
    ...inputData,
    reviewRound: 0,
    maxReviewRounds: 3,
    reviewVerdict: "pending" as const,
    reviewSummary: "",
    reviewHistory: [],
    oscillation: false,
  }),
});

const prReviewStep = createStep({
  id: "pr-review",
  description: "Code review PR-a z werdyktem lgtm / fix w bloku factory",
  inputSchema: reviewCycleSchema,
  outputSchema: reviewCycleSchema,
  execute: async ({ inputData, runId }) => {
    const { ticket, workspaceDir, branch, sha } = inputData;
    const round = inputData.reviewRound + 1;

    // review jest doradcze — brak budżetu nie wywala runu, tylko kończy pętlę (PR zostaje draftem)
    const overBudget = await budgetExceeded(ticket, runId);
    if (overBudget) {
      return {
        ...inputData,
        reviewRound: round,
        reviewVerdict: "skipped" as const,
        reviewSummary: `(review pominięte: budżet ticketu wyczerpany — ${overBudget})`,
      };
    }

    try {
      const route = await resolveRoute("review", ticket);
      const signature = buildSignature("review", route);
      const project = await getProject(ticket.project);
      const diff = await fullBranchDiff(workspaceDir, project.default_branch ?? "main");

      const t0 = Date.now();
      const result = await route.engine.run({
        role: "review", // read-only w obu adapterach
        model: route.model,
      effort: route.effort,
        instructions: [
          "Jesteś recenzentem kodu w fabryce software.",
          "NIE oceniaj zgodności z ticketem ani kryteriów akceptacji — to zrobił już niezależny verifier.",
          "Skup się wyłącznie na jakości: czytelność, nazewnictwo, struktura, bezpieczeństwo,",
          "wydajność, obsługa błędów, brakujące testy, przyszła utrzymywalność.",
          "Przy werdykcie \"fix\" wypisz uwagi: zwięzłe punkty `plik:linia — uwaga`, od najważniejszej, max 8.",
          "Przy werdykcie \"lgtm\" jedno zdanie podsumowania. Zgłaszaj fix tylko dla uwag wartych iteracji buildera.",
          // BAR-125: bez historii runda 3 cofała poprawkę z rundy 2 i sama zgłaszała to jako uwagę (BAR-110)
          ...(inputData.reviewHistory.length
            ? [
                "Poniżej masz historię poprzednich rund. Zmiany wprowadzone na ich prośbę są ZAAKCEPTOWANE:",
                "nie zgłaszaj ich cofnięcia jako uwagi i nie powtarzaj uwag, które builder już zaadresował.",
                "Jeśli uważasz wcześniejszą decyzję za błędną, napisz wprost `REGRESJA rundy N:` i uzasadnij, dlaczego mimo to trzeba ją odwrócić.",
              ]
            : []),
          verdictInstruction("review"),
        ].join("\n"),
        context:
          `# Diff (git show ${sha.slice(0, 8)}, runda review ${round}/${inputData.maxReviewRounds})\n${diff.slice(0, 60_000)}` +
          historyBlock(inputData.reviewHistory),
        workspace: workspaceDir,
        budget: { minutes: 5 },
      });

      if (!result.ok) {
        await recordMetric({
          ticket: ticket.id, runId, stage: "review", engine: route.spec, round,
          ok: false, outcome: "engine-fail", costUsd: result.costUsd, durationMs: Date.now() - t0,
        });
        return {
          ...inputData,
          reviewRound: round,
          reviewVerdict: "skipped" as const,
          reviewSummary: `(review pominięte: ${result.report.slice(0, 300)})`,
        };
      }

      // FAIL-CLOSED: brak jednoznacznego LGTM = są uwagi (dotąd fail-open zdejmował draft
      // z PR-a, gdy agent zgubił marker w wiadomości pośredniej)
      const reviewVerdict = parseReviewVerdict(result.transcript ?? result.report);
      const fix = reviewVerdict.needsFix;
      if (reviewVerdict.source === "missing") console.warn(`[${ticket.id}] review runda ${round}: ${MISSING_VERDICT}`);
      const verdict = fix ? ("fix" as const) : ("lgtm" as const);

      // BAR-125: uwagi powtórzone z wcześniejszej rundy = pętla nie zbiega. Dalsze rundy
      // to spalony budżet i ryzyko cofania poprawek — kończymy i zostawiamy decyzję człowiekowi.
      const keys = noteKeys(result.report);
      const repeat = fix
        ? inputData.reviewHistory.find((h) => noteOverlap(keys, noteKeys(h.notes)) >= OSCILLATION_THRESHOLD)
        : undefined;
      await recordMetric({
        ticket: ticket.id, runId, stage: "review", engine: route.spec, round,
        ok: true, outcome: reviewVerdict.source === "missing" ? "verdict-missing" : verdict,
        costUsd: result.costUsd, durationMs: Date.now() - t0,
      });

      await saveArtifact(ticket.id, runId, `review-round-${round}.md`,
        artifactHeader({
          step: "review",
          round,
          ...signatureMeta(signature),
          engine: route.spec,
          costUsd: result.costUsd,
          verdict,
        }) + result.report);

      // recenzja trafia tam, gdzie czyta ją człowiek: do PR-a (comment, nie approve/reject)
      const reviewFile = join(tmpdir(), `review-${ticket.id}-${round}.md`);
      await writeFile(reviewFile,
        `## AI code review — runda ${round}/${inputData.maxReviewRounds} (${signatureLine(signature)} — doradczo)\n\n${result.report}`);
      await exec(
        "gh",
        ["pr", "review", branch, "--comment", "--body-file", reviewFile],
        { cwd: workspaceDir }
      ).catch(() => {}); // brak review w PR nie może wywalić pipeline'u

      if (repeat) {
        await recordMetric({
          ticket: ticket.id, runId, stage: "review", engine: route.spec, round,
          ok: true, outcome: "oscillation", durationMs: 0,
        });
        console.warn(`[${ticket.id}] oscylacja pętli review: uwagi z rundy ${round} powtarzają rundę ${repeat.round} — kończę pętlę`);
      }

      return {
        ...inputData,
        reviewRound: round,
        reviewVerdict: verdict,
        reviewSummary: repeat
          ? `${result.report}\n\n---\n⚠️ Pętla review zatrzymana: uwagi z rundy ${round} powtarzają uwagi z rundy ${repeat.round} ` +
            `(builder ich nie domyka). Dalsze rundy tylko paliłyby budżet — ocena należy do człowieka.`
          : result.report,
        reviewHistory: [...inputData.reviewHistory, { round, verdict, notes: result.report.slice(0, 6000) }],
        oscillation: !!repeat,
      };
    } catch (err) {
      // review jest doradcze — każdy błąd degraduje się do notki, nie porażki
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ...inputData,
        reviewRound: round,
        reviewVerdict: "skipped" as const,
        reviewSummary: `(review pominięte: ${msg.slice(0, 300)})`,
      };
    }
  },
});

const remediateStep = createStep({
  id: "remediate",
  description: "Builder poprawia kod po uwagach review; checks pilnują regresji; push aktualizuje PR",
  inputSchema: reviewCycleSchema,
  outputSchema: reviewCycleSchema,
  execute: async ({ inputData, runId }) => {
    // poprawiamy tylko przy werdykcie fix i dopóki są rundy
    if (inputData.reviewVerdict !== "fix" || inputData.reviewRound >= inputData.maxReviewRounds || inputData.oscillation) {
      return inputData;
    }
    const { ticket, workspaceDir, branch } = inputData;
    const round = inputData.reviewRound;

    // brak budżetu = koniec iteracji naprawczych; uwagi zostają jawnie nierozwiązane (draft + ⚠️)
    const overBudgetFix = await budgetExceeded(ticket, runId);
    if (overBudgetFix) {
      return {
        ...inputData,
        reviewRound: inputData.maxReviewRounds, // wymusza wyjście z pętli z werdyktem "fix"
        reviewSummary: `${inputData.reviewSummary}\n\n(iteracje naprawcze przerwane: budżet ticketu wyczerpany — ${overBudgetFix})`,
      };
    }
    let fixSignature: ReturnType<typeof buildSignature> | undefined;
    const saveFix = (meta: Record<string, string | number | undefined>, body: string) =>
      saveArtifact(
        ticket.id,
        runId,
        `fix-round-${round}.md`,
        artifactHeader({
          step: "fix",
          round,
          ...(fixSignature ? signatureMeta(fixSignature) : {}),
          ...meta,
        }) + body
      );

    try {
      const route = await resolveRoute("build", ticket, ticketDomain(ticket, inputData.plan));
      const signature = buildSignature("build", route);
      fixSignature = signature;
      const t0 = Date.now();
      const fixMetric = (ok: boolean, outcome: string, costUsd?: number) =>
        recordMetric({ ticket: ticket.id, runId, stage: "fix", engine: route.spec, round, ok, outcome, costUsd, durationMs: Date.now() - t0 });
      const result = await route.engine.run({
        role: "build",
        model: route.model,
      effort: route.effort,
        instructions: [
          "Jesteś builderem. Kod w bieżącym katalogu przeszedł werdykt zgodności z ticketem,",
          "ale code review zgłosiło uwagi jakościowe. Zaadresuj WYŁĄCZNIE poniższe uwagi.",
          "Nie zmieniaj zachowania funkcjonalności, nie wykraczaj poza uwagi.",
          // BAR-125: bez tego zakazu runda 3 potrafiła cofnąć poprawkę z rundy 2 (BAR-110)
          "NIE cofaj zmian wprowadzonych w poprzednich rundach (historia poniżej). Jeśli uwaga tego wprost wymaga,",
          "zrób to świadomie i wyjaśnij w raporcie, którą wcześniejszą decyzję odwracasz i dlaczego.",
          "NIE commituj zmian — commit wykonuje fabryka.",
        ].join("\n"),
        context:
          `# Ticket ${ticket.id}: ${ticket.title}\n\n# Uwagi z code review (runda ${round})\n\n${inputData.reviewSummary}` +
          historyBlock(inputData.reviewHistory.slice(0, -1)),
        workspace: workspaceDir,
        budget: { minutes: 10 },
      });

      if (!result.ok) {
        await fixMetric(false, "engine-fail", result.costUsd);
        await saveFix({ engine: route.spec, outcome: "engine-fail" }, result.report);
        return inputData; // następna runda zrecenzuje ten sam SHA — rundy i tak są policzalne
      }

      const changed = await changedFilesInWorkspace(workspaceDir);
      if (changed.length === 0) {
        await fixMetric(false, "no-changes", result.costUsd);
        await saveFix({ engine: route.spec, costUsd: result.costUsd, outcome: "no-changes" }, result.report);
        return inputData;
      }

      const undeclared = undeclaredChangedFiles(parsePlanVerdict(inputData.plan).files, changed);
      if (undeclared.length) {
        await exec("git", ["-C", workspaceDir, "reset", "--hard", "HEAD"]);
        await exec("git", ["-C", workspaceDir, "clean", "-fd"]);
        await fixMetric(false, "scope-violation-reverted", result.costUsd);
        await saveFix(
          { engine: route.spec, costUsd: result.costUsd, outcome: "scope-violation-reverted", files: undeclared.join(", ") },
          `${result.report}\n\nPliki spoza zatwierdzonego planu:\n${undeclared.map((file) => `- ${file}`).join("\n")}`
        );
        return {
          ...inputData,
          oscillation: true,
          reviewSummary:
            `${inputData.reviewSummary}\n\n⚠️ Poprawka review próbowała zmienić pliki spoza planu: ${undeclared.join(", ")}. ` +
            "Zmiany wycofano; PR pozostaje draftem.",
        };
      }

      await exec("git", ["-C", workspaceDir, "add", "-A"]);
      await exec("git", ["-C", workspaceDir, "commit", "-m",
        `fix(${ticket.id}): poprawki po code review (runda ${round})\n\n[ai-factory review-fix]\n\n${signatureTrailer(signature)}`]);
      const { stdout: newShaRaw } = await exec("git", ["-C", workspaceDir, "rev-parse", "HEAD"]);
      const newSha = newShaRaw.trim();

      let nextState: z.infer<typeof reviewCycleSchema> = {
        ...inputData,
        sha: newSha,
        verifiedSha: "",
        changedFiles: Array.from(new Set([...inputData.changedFiles, ...changed])),
        reviewVerdict: "pending" as const,
      };
      try {
        nextState = { ...nextState, ...(await reverifyExactSha(nextState, runId, `review-fix-${round}`)) };
      } catch (err) {
        await exec("git", ["-C", workspaceDir, "reset", "--hard", "HEAD~1"]);
        await fixMetric(false, "final-verify-fail-reverted", result.costUsd);
        await saveFix({ engine: route.spec, costUsd: result.costUsd, outcome: "checks-fail-reverted", sha: newSha },
          err instanceof Error ? err.message : String(err));
        return {
          ...inputData,
          oscillation: true,
          reviewSummary:
            `${inputData.reviewSummary}\n\n⚠️ Poprawka review nie przeszła pełnego final-SHA gate i została wycofana:\n` +
            (err instanceof Error ? err.message : String(err)),
        };
      }

      await exec("git", ["-C", workspaceDir, "push", "--force-with-lease", "origin", branch]);
      nextState = await runGithubCiGate(nextState, runId, `review-fix-${round}`) as z.infer<typeof reviewCycleSchema>;
      await fixMetric(true, "pushed", result.costUsd);
      await saveFix(
        { engine: route.spec, costUsd: result.costUsd, outcome: "pushed", sha: newSha, files: changed.join(", ") },
        result.report
      );
      return nextState;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await saveFix({ outcome: "infra-error" }, msg);
      if (msg.startsWith("BLOCKED:")) throw err;
      return inputData;
    }
  },
});

const reviewFixCycle = createWorkflow({
  id: "review-fix-cycle",
  inputSchema: reviewCycleSchema,
  outputSchema: reviewCycleSchema,
})
  .then(prReviewStep)
  .then(remediateStep);
reviewFixCycle.commit();

const finalizeReviewStep = createStep({
  id: "finalize-review",
  description: "Zamknięcie pętli review: LGTM → PR ready for review; nierozwiązane uwagi → zostaje draft z ⚠️",
  inputSchema: reviewCycleSchema,
  outputSchema: codeResultSchema,
  execute: async ({ inputData, runId }) => {
    if (inputData.reviewVerdict === "lgtm") {
      if (!inputData.verifiedSha || inputData.sha !== inputData.verifiedSha) {
        throw new Error(
          `BLOCKED: PR nie może zostać oznaczony ready — sha=${inputData.sha}, verifiedSha=${inputData.verifiedSha || "brak"}.`
        );
      }
      await runGithubCiGate(inputData, runId, "finalize");
      // czysta recenzja = koniec pracy maszyn; draft → ready, merge nadal ludzki
      await exec("gh", ["pr", "ready", inputData.branch], { cwd: inputData.workspaceDir });
    } else if (inputData.reviewVerdict === "fix") {
      await exec(
        "gh",
        ["pr", "comment", inputData.branch, "--body",
         `⚠️ AI review: uwagi pozostały nierozwiązane po ${inputData.reviewRound}/${inputData.maxReviewRounds} rundach review→fix. PR zostaje draftem — oceń uwagi przy merge.`],
        { cwd: inputData.workspaceDir }
      ).catch(() => {});
    }
    // "skipped" (recenzja się nie odbyła) → też zostaje draft: brak czystej recenzji = brak awansu
    return { ...inputData, kind: "code" as const };
  },
});

const codePath = createWorkflow({
  id: "code-path",
  inputSchema: planOutputSchema,
  outputSchema: codeResultSchema,
})
  .then(initCycleStep)
  .dountil(
    buildVerifyCycle,
    async ({ inputData }) =>
      inputData.verdict === "pass" || inputData.attempt >= inputData.maxAttempts
  )
  .then(assertVerifiedStep)
  .then(publishStep)
  .then(githubCiStep)
  .then(initReviewCycleStep)
  .dountil(
    reviewFixCycle,
    async ({ inputData }) =>
      inputData.reviewVerdict !== "pending" &&
      (inputData.reviewVerdict !== "fix" || inputData.reviewRound >= inputData.maxReviewRounds || inputData.oscillation)
  )
  .then(finalizeReviewStep);
codePath.commit();

const opsPath = createWorkflow({
  id: "ops-path",
  inputSchema: planOutputSchema,
  outputSchema: opsResultSchema,
})
  .then(awaitChecklistStep)
  .then(finalizeOpsStep);
opsPath.commit();

const branchResultSchema = z.object({
  "code-path": codeResultSchema.optional(),
  "ops-path": opsResultSchema.optional(),
});

const unwrapWorkflowResultStep = createStep({
  id: "unwrap-workflow-result",
  description: "Rozpakowanie wyniku wybranej gałęzi do jawnej unii code/ops",
  inputSchema: branchResultSchema,
  outputSchema: workflowResultSchema,
  execute: async ({ inputData }) => {
    const result = inputData["ops-path"] ?? inputData["code-path"];
    if (!result) throw new Error("Workflow nie zwrócił jawnego wyniku gałęzi code/ops.");
    return result;
  },
});

export const ticketPipeline = createWorkflow({
  id: "ticket-pipeline",
  inputSchema: intakeInputSchema,
  outputSchema: workflowResultSchema,
})
  .then(intakeStep)
  .then(initPlanCycleStep)
  .dountil(
    planClarifyCycle,
    async ({ inputData }) => {
      if (!inputData.plan) return false;
      const v = parsePlanVerdict(inputData.plan);
      return v.ok || !v.questions || inputData.clarifyRound >= inputData.maxClarifyRounds;
    }
  )
  .then(finalizePlanStep)
  .then(approvePlanStep)
  .branch([
    [async ({ inputData }) => ticketDomain(inputData.ticket, inputData.plan) === "ops", opsPath],
    [async ({ inputData }) => ticketDomain(inputData.ticket, inputData.plan) !== "ops", codePath],
  ])
  .then(unwrapWorkflowResultStep);
ticketPipeline.commit();
