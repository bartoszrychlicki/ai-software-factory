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

const exec = promisify(execFile);

const ticketSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  project: z.string(), // klucz z rejestru — potrzebny też routingowi
  repoPath: z.string(),
  github: z.string().optional(),
  checks: z.array(z.string()).optional(),
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
      labels: inputData.labels,
    };
  },
});

const planStep = createStep({
  id: "plan",
  description: "Planner: zamienia ticket w implementowalny plan",
  inputSchema: ticketSchema,
  outputSchema: planOutputSchema,
  execute: async ({ inputData }) => {
    const route = await resolveRoute("plan", inputData);
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
        "- niejasności (jeśli są, wypisz jawnie)",
      ].join("\n"),
      context: `# Ticket ${inputData.id}: ${inputData.title}\n\n${inputData.description}`,
      workspace: inputData.repoPath,
      budget: { minutes: 5 },
    });

    if (!result.ok) throw new Error(`Planner (${route.spec}) nie dostarczył planu: ${result.report}`);

    return { ticket: inputData, plan: result.report, planCostUsd: result.costUsd };
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
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      await suspend({ plan: inputData.plan });
      return inputData;
    }
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
  execute: async ({ inputData }) => {
    const { ticket, plan } = inputData;
    const attempt = inputData.attempt + 1;

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
  execute: async ({ inputData }) => {
    // build padł — nie ma czego weryfikować, pętla zdecyduje o kolejnej próbie
    if (inputData.verdict === "fail") return inputData;

    const { ticket, sha } = inputData;
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
        return {
          ...inputData,
          verdict: "fail" as const,
          feedback: `Verifier (${route.spec}) padł: ${result.report}`,
        };
      }

      if (!/^VERDICT:\s*PASS/m.test(result.report)) {
        return {
          ...inputData,
          verdict: "fail" as const,
          feedback: result.report, // pełny raport FAIL = feedback dla następnej próby
          verifyReport: result.report,
        };
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
  execute: async ({ inputData }) => {
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

    return { ...inputData, prUrl };
  },
});

export const ticketPipeline = createWorkflow({
  id: "ticket-pipeline",
  inputSchema: intakeInputSchema,
  outputSchema: publishOutputSchema,
})
  .then(intakeStep)
  .then(planStep)
  .then(approvePlanStep)
  .then(initCycleStep)
  .dountil(
    buildVerifyCycle,
    async ({ inputData }) =>
      inputData.verdict === "pass" || inputData.attempt >= inputData.maxAttempts
  )
  .then(assertVerifiedStep)
  .then(publishStep);
ticketPipeline.commit();
