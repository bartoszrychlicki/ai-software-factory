import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, createCheckout, removeCheckout } from "./workspace";
import { getProject } from "./projects";
import { resolveRoute } from "./routing";
import { saveArtifact, artifactHeader } from "./artifacts";
import { takeScreenshot } from "./screenshot";
import { recordMetric } from "./metrics";

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
  labels: z.array(z.string()).optional(), // m.in. override engine:*
});

const intakeInputSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  project: z.string(),
  labels: z.array(z.string()).optional(),
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
      labels: inputData.labels,
    };
  },
});

const planStep = createStep({
  id: "plan",
  description: "Planner: zamienia ticket w implementowalny plan",
  inputSchema: ticketSchema,
  outputSchema: planOutputSchema,
  execute: async ({ inputData, runId }) => {
    const route = await resolveRoute("plan", inputData);
    const t0 = Date.now();
    const result = await route.engine.run({
      role: "plan",
      model: route.model,
      instructions: [
        "Jesteś plannerem w fabryce software.",
        "Przygotuj implementowalny plan dla poniższego ticketu:",
        "- zakres i poza zakresem",
        "- kryteria akceptacji i sposób weryfikacji każdego",
        "- plan zmian plik po pliku",
        "- plan testów",
        "Decyzje kosmetyczne (separator, nazewnictwo, drobny format) podejmij SAM i odnotuj w planie — nie są niejasnością.",
        "Jeśli ticketu NIE DA SIĘ bezpiecznie zaimplementować bez odpowiedzi człowieka (sprzeczne wymagania, brakujący precondition w kodzie, niejednoznaczny zakres), wypisz pytania w sekcji `## Niejasności blokujące`.",
        "Jeśli stan opisany w tickecie JUŻ ISTNIEJE w kodzie (ticket spełniony), to też jest blokujące — napisz to wprost zamiast planować pustą pracę.",
        "PIERWSZA linia odpowiedzi: `PLAN: OK` albo `PLAN: BLOCKED` (gdy są niejasności blokujące).",
      ].join("\n"),
      context: `# Ticket ${inputData.id}: ${inputData.title}\n\n${inputData.description}`,
      workspace: inputData.repoPath,
      budget: { minutes: 5 },
    });

    await recordMetric({
      ticket: inputData.id, runId, stage: "plan", engine: route.spec,
      ok: result.ok, outcome: result.ok ? (/^PLAN:\s*OK/m.test(result.report) ? "ok" : "blocked") : "engine-fail",
      costUsd: result.costUsd, durationMs: Date.now() - t0,
    });
    await saveArtifact(
      inputData.id,
      runId,
      "plan.md",
      artifactHeader({ step: "plan", engine: route.spec, costUsd: result.costUsd, ok: String(result.ok) }) + result.report
    );
    if (!result.ok) throw new Error(`Planner (${route.spec}) nie dostarczył planu: ${result.report}`);

    return { ticket: inputData, plan: result.report, planCostUsd: result.costUsd };
  },
});

const assertPlanClearStep = createStep({
  id: "assert-plan-clear",
  description: "Bramka: niejasności blokujące w planie = BLOCKED przed ludzką aprobatą (fail-closed)",
  inputSchema: planOutputSchema,
  outputSchema: planOutputSchema,
  execute: async ({ inputData }) => {
    if (!/^PLAN:\s*OK\b/m.test(inputData.plan)) {
      const questions =
        inputData.plan.match(/^##\s*Niejasności blokujące[\s\S]*?(?=\n##\s|$)/m)?.[0] ??
        inputData.plan.slice(0, 2000);
      throw new Error(
        `BLOCKED: plan zawiera niejasności blokujące (lub brak markera \`PLAN: OK\`). ` +
          `Odpowiedz na pytania w tickecie i uruchom ponownie.\n\n${questions}`
      );
    }
    return inputData;
  },
});

const approvePlanStep = createStep({
  id: "approve-plan",
  description: "Human gate: akceptacja planu przed buildem",
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
      await suspend({ plan: inputData.plan });
      return inputData;
    }
    await saveArtifact(
      inputData.ticket.id,
      runId,
      "approval.json",
      JSON.stringify({ approved: resumeData.approved, feedback: resumeData.feedback ?? null, at: new Date().toISOString() }, null, 2)
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
    const saveBuild = (meta: Record<string, string | number | undefined>, body: string) =>
      saveArtifact(ticket.id, runId, `build-attempt-${attempt}.md`, artifactHeader({ step: "build", attempt, ...meta }) + body);

    const slug = ticket.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30);
    // świeży worktree per próba — retry to nowa próba, nie grzebanie w brudzie
    const ws = await createWorkspace(ticket.repoPath, ticket.id, slug);

    const feedbackBlock = inputData.feedback
      ? `\n\n# FEEDBACK Z ODRZUCONEJ PRÓBY #${inputData.attempt}\nPoprzednia implementacja została odrzucona. Napraw wskazane problemy:\n${inputData.feedback}`
      : "";

    const route = await resolveRoute("build", ticket);
    const t0 = Date.now();
    const buildMetric = (ok: boolean, outcome: string, costUsd?: number) =>
      recordMetric({ ticket: ticket.id, runId, stage: "build", engine: route.spec, attempt, ok, outcome, costUsd, durationMs: Date.now() - t0 });
    const result = await route.engine.run({
      role: "build",
      model: route.model,
      instructions: [
        "Jesteś builderem. Zaimplementuj DOKŁADNIE poniższy plan w bieżącym katalogu.",
        "Nie wykraczaj poza zakres planu.",
        "NIE commituj zmian — commit wykonuje fabryka.",
        "Na końcu wypisz raport: co zmieniłeś i jak to zweryfikować.",
      ].join("\n"),
      context: `# Ticket ${ticket.id}: ${ticket.title}\n\n${ticket.description}\n\n# Plan\n\n${plan}${feedbackBlock}`,
      workspace: ws.dir,
      budget: { minutes: 15 },
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
      const checksSummary = checks.length
        ? checkResults.join("\n")
        : "- (brak checks w rejestrze projektu — tylko werdykt agenta)";

      // 2) Diff dla agenta-werdyktu
      const { stdout: diff } = await exec("git", ["-C", co.dir, "show", sha], {
        maxBuffer: 10 * 1024 * 1024,
      });

      // 3) Niezależny werdykt: osobny run, read-only, czysty katalog
      const route = await resolveRoute("verify", ticket);
      const t0 = Date.now();
      const result = await route.engine.run({
        role: "verify",
        model: route.model,
        instructions: [
          "Jesteś niezależnym weryfikatorem w fabryce software.",
          "Oceń, czy diff realizuje ticket zgodnie z planem:",
          "- każde kryterium akceptacji ma pokrycie w zmianach?",
          "- brak zmian poza zakresem planu?",
          "- jakość: oczywiste błędy, regresje, edge case'y?",
          "PIERWSZA linia odpowiedzi: `VERDICT: PASS` albo `VERDICT: FAIL`.",
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

      const pass = /^VERDICT:\s*PASS/m.test(result.report);
      await recordMetric({
        ticket: ticket.id, runId, stage: "verify", engine: route.spec, attempt: inputData.attempt,
        ok: true, outcome: pass ? "pass" : "fail", costUsd: result.costUsd, durationMs: Date.now() - t0,
      });
      await saveVerify(
        { engine: route.spec, costUsd: result.costUsd, outcome: pass ? "pass" : "fail", checks: checksSummary.replace(/\n/g, "; ") },
        result.report
      );
      if (!pass) {
        return {
          ...inputData,
          verdict: "fail" as const,
          feedback: result.report, // pełny raport FAIL = feedback dla następnej próby
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
    const { ticket, branch, workspaceDir } = inputData;
    if (!ticket.github) {
      throw new Error("Projekt nie ma repo GitHub w rejestrze — publish niemożliwy");
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
 * REVIEW: LGTM albo wyczerpania rund. Werdykt doradczy: po rundach z uwagami
 * PR zostaje, decyzja przy merge jest ludzka.
 */
const reviewCycleSchema = publishOutputSchema.extend({
  reviewRound: z.number(),
  maxReviewRounds: z.number(),
  reviewVerdict: z.enum(["pending", "lgtm", "fix", "skipped"]),
  reviewSummary: z.string(),
});

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
  }),
});

const prReviewStep = createStep({
  id: "pr-review",
  description: "Code review PR-a z werdyktem REVIEW: LGTM / REVIEW: FIX",
  inputSchema: reviewCycleSchema,
  outputSchema: reviewCycleSchema,
  execute: async ({ inputData, runId }) => {
    const { ticket, workspaceDir, branch, sha } = inputData;
    const round = inputData.reviewRound + 1;

    try {
      const route = await resolveRoute("review", ticket);
      const { stdout: diff } = await exec("git", ["-C", workspaceDir, "show", sha], {
        maxBuffer: 10 * 1024 * 1024,
      });

      const t0 = Date.now();
      const result = await route.engine.run({
        role: "review", // read-only w obu adapterach
        model: route.model,
        instructions: [
          "Jesteś recenzentem kodu w fabryce software.",
          "NIE oceniaj zgodności z ticketem ani kryteriów akceptacji — to zrobił już niezależny verifier.",
          "Skup się wyłącznie na jakości: czytelność, nazewnictwo, struktura, bezpieczeństwo,",
          "wydajność, obsługa błędów, brakujące testy, przyszła utrzymywalność.",
          "PIERWSZA linia odpowiedzi: `REVIEW: LGTM` (kod w porządku) albo `REVIEW: FIX` (są uwagi do poprawy).",
          "Po REVIEW: FIX wypisz uwagi: zwięzłe punkty `plik:linia — uwaga`, od najważniejszej, max 8.",
          "Po REVIEW: LGTM jedno zdanie podsumowania. Zgłaszaj FIX tylko dla uwag wartych iteracji buildera.",
        ].join("\n"),
        context: `# Diff (git show ${sha.slice(0, 8)}, runda review ${round}/${inputData.maxReviewRounds})\n${diff.slice(0, 60_000)}`,
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

      const fix = /^REVIEW:\s*FIX/m.test(result.report);
      // fail-open na brak markera: recenzja bez werdyktu nie może zapętlić fabryki — traktujemy jak LGTM z notką
      const verdict = fix ? ("fix" as const) : ("lgtm" as const);
      await recordMetric({
        ticket: ticket.id, runId, stage: "review", engine: route.spec, round,
        ok: true, outcome: verdict, costUsd: result.costUsd, durationMs: Date.now() - t0,
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

      return { ...inputData, reviewRound: round, reviewVerdict: verdict, reviewSummary: result.report };
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
    // poprawiamy tylko przy REVIEW: FIX i dopóki są rundy
    if (inputData.reviewVerdict !== "fix" || inputData.reviewRound >= inputData.maxReviewRounds) {
      return inputData;
    }
    const { ticket, workspaceDir, branch } = inputData;
    const round = inputData.reviewRound;
    const saveFix = (meta: Record<string, string | number | undefined>, body: string) =>
      saveArtifact(ticket.id, runId, `fix-round-${round}.md`, artifactHeader({ step: "fix", round, ...meta }) + body);

    try {
      const route = await resolveRoute("build", ticket);
      const t0 = Date.now();
      const fixMetric = (ok: boolean, outcome: string, costUsd?: number) =>
        recordMetric({ ticket: ticket.id, runId, stage: "fix", engine: route.spec, round, ok, outcome, costUsd, durationMs: Date.now() - t0 });
      const result = await route.engine.run({
        role: "build",
        model: route.model,
        instructions: [
          "Jesteś builderem. Kod w bieżącym katalogu przeszedł werdykt zgodności z ticketem,",
          "ale code review zgłosiło uwagi jakościowe. Zaadresuj WYŁĄCZNIE poniższe uwagi.",
          "Nie zmieniaj zachowania funkcjonalności, nie wykraczaj poza uwagi.",
          "NIE commituj zmian — commit wykonuje fabryka.",
        ].join("\n"),
        context: `# Ticket ${ticket.id}: ${ticket.title}\n\n# Uwagi z code review (runda ${round})\n\n${inputData.reviewSummary}`,
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
  description: "Zamknięcie pętli review: nierozwiązane uwagi jawnie odnotowane w PR (decyzja przy merge ludzka)",
  inputSchema: reviewCycleSchema,
  outputSchema: reviewCycleSchema,
  execute: async ({ inputData }) => {
    if (inputData.reviewVerdict === "fix") {
      await exec(
        "gh",
        ["pr", "comment", inputData.branch, "--body",
         `⚠️ AI review: uwagi pozostały nierozwiązane po ${inputData.reviewRound}/${inputData.maxReviewRounds} rundach review→fix. Oceń je przy merge.`],
        { cwd: inputData.workspaceDir }
      ).catch(() => {});
    }
    return inputData;
  },
});

export const ticketPipeline = createWorkflow({
  id: "ticket-pipeline",
  inputSchema: intakeInputSchema,
  outputSchema: reviewCycleSchema,
})
  .then(intakeStep)
  .then(planStep)
  .then(assertPlanClearStep)
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
      (inputData.reviewVerdict !== "fix" || inputData.reviewRound >= inputData.maxReviewRounds)
  )
  .then(finalizeReviewStep);
ticketPipeline.commit();
