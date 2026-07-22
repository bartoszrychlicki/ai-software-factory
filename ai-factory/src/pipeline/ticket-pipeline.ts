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
import { takeScreenshot } from "./screenshot";
import { recordMetric } from "./metrics";
import { budgetExceeded } from "./budget";
import { parsePlanVerdict, parseVerifyVerdict, parseReviewVerdict, verdictInstruction, MISSING_VERDICT } from "./verdicts";

const exec = promisify(execFile);

const ticketSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  project: z.string(), // klucz z rejestru — potrzebny też routingowi
  repoPath: z.string(),
  github: z.string().optional(),
  checks: z.array(z.string()).optional(),
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
  changedFiles: z.array(z.string()),
  buildReport: z.string(),
  verifyReport: z.string(),
});

const KNOWN_DOMAINS = ["frontend", "backend", "fullstack", "ops"];

/**
 * Domena buildu → routing `build.<domena>` (BAR-133).
 *
 * Kolejność: label `domain:*` = ręczny override człowieka, dalej deklaracja
 * plannera z bloku `factory`. Bez tego frontend leciał defaultowym silnikiem,
 * dopóki ktoś nie pamiętał o labelu (BAR-92 run 1 poszedł w codex zamiast Opusa).
 * Nieznana wartość jest ignorowana — routing spada na default, nigdy nie wybucha.
 */
const ticketDomain = (ticket: { labels?: string[] }, plan?: string): string | undefined => {
  const fromLabel = ticket.labels?.find((l) => l.startsWith("domain:"))?.slice("domain:".length);
  if (fromLabel) return fromLabel;
  const declared = plan ? parsePlanVerdict(plan).domain?.trim().toLowerCase() : undefined;
  if (declared && !KNOWN_DOMAINS.includes(declared)) {
    console.warn(`[routing] planner zadeklarował nieznaną domenę "${declared}" — używam defaultu`);
    return undefined;
  }
  return declared;
};

/** Metryka rozróżnia „planner zablokował" od „planner nie dotrzymał kontraktu" (BAR-147). */
const planOutcome = (v: { ok: boolean; source: string }) =>
  v.source === "missing" ? "verdict-missing" : v.ok ? "ok" : "blocked";

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
      await recordMetric({ ticket: ticket.id, runId, stage: "plan", engine: "reuse", ok: true, outcome: "reused", costUsd: 0, durationMs: 0 });
      await saveArtifact(ticket.id, runId, "plan.md",
        artifactHeader({ step: "plan", engine: "reuse", reused: "true" }) + ticket.reusePlan);
      return { ...inputData, plan: ticket.reusePlan };
    }
    // plan już OK (wejście kolejnej iteracji) — nie przeplanowujemy
    if (inputData.plan && parsePlanVerdict(inputData.plan).ok) return inputData;

    const route = await resolveRoute("plan", ticket);
    const t0 = Date.now();
    const answersBlock = inputData.answers.length
      ? "\n\n# Odpowiedzi autora ticketu na Twoje wcześniejsze pytania\n" +
        inputData.answers.map((a, i) => `\n## Runda ${i + 1}\n${a}`).join("\n")
      : "";
    const result = await route.engine.run({
      role: "plan",
      model: route.model,
      effort: route.effort,
      instructions: [
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
        `Oraz "domain": frontend | backend | fullstack | ops — na podstawie zakresu zmian; od tego zależy dobór silnika buildu.`,
        verdictInstruction("plan"),
      ].join("\n"),
      context: `# Ticket ${ticket.id}: ${ticket.title}\n\n${ticket.description}${answersBlock}`,
      workspace: ticket.repoPath,
      // 5 min ubiło Fable@high na produkcyjnym repo (BAR-91: kill w 301 s) — mocne modele myślą dłużej
      budget: { minutes: 20 },
    });

    await recordMetric({
      ticket: ticket.id, runId, stage: "plan", engine: route.spec,
      ok: result.ok,
      outcome: result.ok ? planOutcome(parsePlanVerdict(result.transcript ?? result.report)) : "engine-fail",
      costUsd: result.costUsd, durationMs: Date.now() - t0,
    });
    await saveArtifact(
      ticket.id,
      runId,
      "plan.md",
      artifactHeader({ step: "plan", engine: route.spec, costUsd: result.costUsd, ok: String(result.ok), round: inputData.clarifyRound }) + (result.transcript ?? result.report)
    );
    if (!result.ok) throw new Error(`Planner (${route.spec}) nie dostarczył planu: ${result.report}`);

    // do dalszych kroków idzie PEŁNY transkrypt: werdykt/pytania mogą siedzieć w wiadomości pośredniej
    return { ...inputData, plan: result.transcript ?? result.report, planCostUsd: (inputData.planCostUsd ?? 0) + (result.costUsd ?? 0) };
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
    const questions = verdict.questions;
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
    // plan-reuse: treść była już zatwierdzona przez człowieka. Stare plany (sprzed
    // kontraktu ```factory) nie mają bloku — ponowne sądzenie ich werdyktem zablokowałoby
    // ticket, którego plan jest ważny. Bramka dotyczy planów ŚWIEŻO wygenerowanych.
    if (!inputData.ticket.reusePlan) {
      const planVerdict = parsePlanVerdict(inputData.plan);
      if (!planVerdict.ok) {
        const detail =
          planVerdict.source === "missing"
            ? `${MISSING_VERDICT}\n\n${inputData.plan.slice(0, 2000)}`
            : (planVerdict.questions ?? inputData.plan.slice(0, 2000));
        throw new Error(
          `BLOCKED: plan bez werdyktu ok${inputData.clarifyRound > 0 ? ` po ${inputData.clarifyRound} rundach dopytywania` : ""}. ` +
            `Uzupełnij ticket i przenieś go na Todo, żeby fabryka spróbowała ponownie.\n\n${detail}`
        );
      }
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
    changedFiles: [],
    buildReport: "",
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
    const saveBuild = (meta: Record<string, string | number | undefined>, body: string) =>
      saveArtifact(ticket.id, runId, `build-attempt-${attempt}.md`, artifactHeader({ step: "build", attempt, ...meta }) + body);

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
    const { stdout: status } = await exec("git", ["-C", ws.dir, "status", "--porcelain"]);
    const changedFiles = status.split("\n").filter(Boolean).map((l) => l.slice(3));
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

    await exec("git", ["-C", ws.dir, "add", "-A"]);
    await exec("git", ["-C", ws.dir, "commit", "-m",
      `feat(${ticket.id}): ${ticket.title} (próba ${attempt})\n\n[ai-factory build]`]);
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
      changedFiles,
      buildReport: result.report,
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
    const saveVerify = (meta: Record<string, string | number | undefined>, body: string) =>
      saveArtifact(ticket.id, runId, `verify-attempt-${inputData.attempt}.md`,
        artifactHeader({ step: "verify", attempt: inputData.attempt, sha, ...meta }) + body);
    const co = await createCheckout(ticket.repoPath, sha, `${ticket.id}-verify`);

    try {
      // 1) Deterministycznie: checks PROJEKTU (z rejestru) na czystym env.
      const checks = ticket.checks ?? [];
      const checkResults: string[] = [];
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => !k.startsWith("npm_") && k !== "NODE_ENV"
        )
      ) as NodeJS.ProcessEnv;

      for (const cmd of checks) {
        try {
          await exec("bash", ["-c", cmd], {
            cwd: co.dir,
            env: cleanEnv,
            timeout: 10 * 60_000,
            maxBuffer: 50 * 1024 * 1024,
          });
        } catch (err) {
          const e = err as Error & { stdout?: string; stderr?: string };
          const tail = [e.stdout, e.stderr].filter(Boolean).join("\n").slice(-3000);
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
          await exec("bash", ["-c", ticket.e2e], {
            cwd: co.dir,
            env: cleanEnv,
            timeout: 20 * 60_000,
            maxBuffer: 50 * 1024 * 1024,
          });
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
          const e = err as Error & { stdout?: string; stderr?: string };
          const tail = [e.stdout, e.stderr].filter(Boolean).join("\n").slice(-4000);
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

      const checksSummary = checks.length
        ? checkResults.join("\n")
        : "- (brak checks w rejestrze projektu — tylko werdykt agenta)";

      // 2) Diff dla agenta-werdyktu
      const { stdout: diff } = await exec("git", ["-C", co.dir, "show", sha], {
        maxBuffer: 10 * 1024 * 1024,
      });

      // 3) Niezależny werdykt: osobny run, read-only, czysty katalog
      const overBudget = await budgetExceeded(ticket, runId);
      if (overBudget) throw new Error(`BLOCKED: budżet ticketu wyczerpany przed werdyktem verify — ${overBudget}`);
      const route = await resolveRoute("verify", ticket);
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
          "# Diff (git show)",
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

      await removeCheckout(ticket.repoPath, co.dir);
      return { ...inputData, verdict: "pass" as const, verifyReport: result.report };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ...inputData,
        verdict: "fail" as const,
        feedback: `Błąd infrastruktury verify: ${msg}\n(checkout: ${co.dir})`,
      };
    }
  },
});

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

      // re-verify na scalonym drzewie: checks projektu + e2e (jeśli skonfigurowane)
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith("npm_") && k !== "NODE_ENV")
      ) as NodeJS.ProcessEnv;
      const t0mq = Date.now();
      for (const cmd of [...(ticket.checks ?? []), ...(ticket.e2e ? [ticket.e2e] : [])]) {
        try {
          await exec("bash", ["-c", cmd], { cwd: workspaceDir, env: cleanEnv, timeout: 20 * 60_000, maxBuffer: 50 * 1024 * 1024 });
        } catch (err) {
          const e = err as Error & { stdout?: string; stderr?: string };
          const tail = [e.stdout, e.stderr].filter(Boolean).join("\n").slice(-3000);
          await recordMetric({ ticket: ticket.id, runId, stage: "merge-queue", ok: false, outcome: "recheck-fail", durationMs: Date.now() - t0mq });
          await saveArtifact(ticket.id, runId, "merge-queue.md",
            artifactHeader({ step: "merge-queue", outcome: "recheck-fail", check: cmd }) + tail);
          throw new Error(
            `BLOCKED: po scaleniu z ${def} check "${cmd}" nie przechodzi — konflikt semantyczny. ` +
              `Nadaj label ponownie (reuse planu zbuduje na świeżym mainie).\n\n${tail}`
          );
        }
      }
      await recordMetric({ ticket: ticket.id, runId, stage: "merge-queue", ok: true, outcome: "rebased", durationMs: Date.now() - t0mq });
      await saveArtifact(ticket.id, runId, "merge-queue.md",
        artifactHeader({ step: "merge-queue", outcome: "rebased", behind: behind.trim() }) +
        `Gałąź zaktualizowana o ${behind.trim()} commit(ów) z ${def}; checks na scalonym drzewie: OK.`);
      const { stdout: newSha } = await exec("git", ["-C", workspaceDir, "rev-parse", "HEAD"]);
      inputData = { ...inputData, sha: newSha.trim() };
    }

    await exec("git", ["-C", workspaceDir, "push", "-u", "--force", "origin", branch]);

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
      attempt: inputData.attempt,
      maxAttempts: inputData.maxAttempts,
      changedFiles: inputData.changedFiles,
      at: new Date().toISOString(),
    }, null, 2));
    return { ...inputData, prUrl };
  },
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
      const { stdout: diff } = await exec("git", ["-C", workspaceDir, "show", sha], {
        maxBuffer: 10 * 1024 * 1024,
      });

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
        artifactHeader({ step: "review", round, engine: route.spec, costUsd: result.costUsd, verdict }) + result.report);

      // recenzja trafia tam, gdzie czyta ją człowiek: do PR-a (comment, nie approve/reject)
      const reviewFile = join(tmpdir(), `review-${ticket.id}-${round}.md`);
      await writeFile(reviewFile,
        `## AI code review — runda ${round}/${inputData.maxReviewRounds} (${route.spec} — doradczo)\n\n${result.report}`);
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
    const saveFix = (meta: Record<string, string | number | undefined>, body: string) =>
      saveArtifact(ticket.id, runId, `fix-round-${round}.md`, artifactHeader({ step: "fix", round, ...meta }) + body);

    try {
      const route = await resolveRoute("build", ticket, ticketDomain(ticket, inputData.plan));
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

      const { stdout: status } = await exec("git", ["-C", workspaceDir, "status", "--porcelain"]);
      const changed = status.split("\n").filter(Boolean).map((l) => l.slice(3));
      if (changed.length === 0) {
        await fixMetric(false, "no-changes", result.costUsd);
        await saveFix({ engine: route.spec, costUsd: result.costUsd, outcome: "no-changes" }, result.report);
        return inputData;
      }

      await exec("git", ["-C", workspaceDir, "add", "-A"]);
      await exec("git", ["-C", workspaceDir, "commit", "-m",
        `fix(${ticket.id}): poprawki po code review (runda ${round})\n\n[ai-factory review-fix]`]);
      const { stdout: newShaRaw } = await exec("git", ["-C", workspaceDir, "rev-parse", "HEAD"]);
      const newSha = newShaRaw.trim();

      // fail-closed na regresję: checks projektu na świeżym checkoutcie poprawki
      const co = await createCheckout(ticket.repoPath, newSha, `${ticket.id}-fixcheck`);
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith("npm_") && k !== "NODE_ENV")
      ) as NodeJS.ProcessEnv;
      try {
        for (const cmd of ticket.checks ?? []) {
          await exec("bash", ["-c", cmd], { cwd: co.dir, env: cleanEnv, timeout: 10 * 60_000, maxBuffer: 50 * 1024 * 1024 });
        }
      } catch (err) {
        const e = err as Error & { stdout?: string; stderr?: string };
        const tail = [e.stdout, e.stderr].filter(Boolean).join("\n").slice(-3000);
        await exec("git", ["-C", workspaceDir, "reset", "--hard", "HEAD~1"]); // poprawka psuje build → wycofujemy
        await removeCheckout(ticket.repoPath, co.dir);
        await fixMetric(false, "checks-fail-reverted", result.costUsd);
        await saveFix({ engine: route.spec, costUsd: result.costUsd, outcome: "checks-fail-reverted", sha: newSha },
          `${e.message}\n\n${tail}`);
        return inputData;
      }
      await removeCheckout(ticket.repoPath, co.dir);

      await exec("git", ["-C", workspaceDir, "push", "--force", "origin", branch]);
      await fixMetric(true, "pushed", result.costUsd);
      await saveFix(
        { engine: route.spec, costUsd: result.costUsd, outcome: "pushed", sha: newSha, files: changed.join(", ") },
        result.report
      );
      return {
        ...inputData,
        sha: newSha,
        changedFiles: Array.from(new Set([...inputData.changedFiles, ...changed])),
        reviewVerdict: "pending" as const, // nowy SHA → potrzebna świeża recenzja
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await saveFix({ outcome: "infra-error" }, msg);
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
  outputSchema: reviewCycleSchema,
  execute: async ({ inputData }) => {
    if (inputData.reviewVerdict === "lgtm") {
      // czysta recenzja = koniec pracy maszyn; draft → ready, merge nadal ludzki
      await exec("gh", ["pr", "ready", inputData.branch], { cwd: inputData.workspaceDir }).catch(() => {});
    } else if (inputData.reviewVerdict === "fix") {
      await exec(
        "gh",
        ["pr", "comment", inputData.branch, "--body",
         `⚠️ AI review: uwagi pozostały nierozwiązane po ${inputData.reviewRound}/${inputData.maxReviewRounds} rundach review→fix. PR zostaje draftem — oceń uwagi przy merge.`],
        { cwd: inputData.workspaceDir }
      ).catch(() => {});
    }
    // "skipped" (recenzja się nie odbyła) → też zostaje draft: brak czystej recenzji = brak awansu
    return inputData;
  },
});

export const ticketPipeline = createWorkflow({
  id: "ticket-pipeline",
  inputSchema: intakeInputSchema,
  outputSchema: reviewCycleSchema,
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
  .then(initCycleStep)
  .dountil(
    buildVerifyCycle,
    async ({ inputData }) =>
      inputData.verdict === "pass" || inputData.attempt >= inputData.maxAttempts
  )
  .then(assertVerifiedStep)
  .then(publishStep)
  .then(initReviewCycleStep)
  .dountil(
    reviewFixCycle,
    async ({ inputData }) =>
      inputData.reviewVerdict !== "pending" &&
      (inputData.reviewVerdict !== "fix" || inputData.reviewRound >= inputData.maxReviewRounds || inputData.oscillation)
  )
  .then(finalizeReviewStep);
ticketPipeline.commit();
