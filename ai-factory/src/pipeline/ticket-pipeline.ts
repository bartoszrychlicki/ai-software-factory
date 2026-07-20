import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode } from "../engines/claude-code";
import { codex } from "../engines/codex";
import { createWorkspace } from "./workspace";
import { getProject } from "./projects";

const exec = promisify(execFile);

const ticketSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  repoPath: z.string(),
  github: z.string().optional(), // owner/repo z rejestru projektów
});

// ticket płynie przez cały pipeline (passthrough) — każdy krok go dokleja do outputu
const planOutputSchema = z.object({
  ticket: ticketSchema,
  plan: z.string(),
  planCostUsd: z.number().optional(),
});

const buildOutputSchema = z.object({
  ticket: ticketSchema,
  plan: z.string(),
  branch: z.string(),
  workspaceDir: z.string(),
  changedFiles: z.array(z.string()),
  buildReport: z.string(),
});

const intakeInputSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  project: z.string(), // klucz z rejestru, nie ścieżka!
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
      repoPath: project.repo,
      github: project.github,
    };
  },
});

const planStep = createStep({
  id: "plan",
  description: "Planner: zamienia ticket w implementowalny plan",
  inputSchema: ticketSchema,
  outputSchema: planOutputSchema,
  execute: async ({ inputData }) => {
    const result = await claudeCode.run({
      role: "plan",
      model: "sonnet",
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

    if (!result.ok) throw new Error(`Planner nie dostarczył planu: ${result.report}`);

    return { ticket: inputData, plan: result.report, planCostUsd: result.costUsd };
  },
});

const approvePlanStep = createStep({
  id: "approve-plan",
  description: "Human gate: akceptacja planu przed buildem",
  inputSchema: planOutputSchema,
  outputSchema: planOutputSchema,
  suspendSchema: z.object({
    plan: z.string(), // to zobaczy człowiek przy wznowieniu
  }),
  resumeSchema: z.object({
    approved: z.boolean(),
    feedback: z.string().optional(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      // zawieś run i pokaż człowiekowi plan; stan trwale zapisany w storage
      await suspend({ plan: inputData.plan });
      return inputData; // formalność dla typów — po suspend krok wykona się od nowa z resumeData
    }
    if (!resumeData.approved) {
      throw new Error(`Plan odrzucony przez człowieka: ${resumeData.feedback ?? "bez uzasadnienia"}`);
    }
    return inputData;
  },
});

const buildStep = createStep({
  id: "build",
  description: "Builder: implementuje plan w izolowanym worktree",
  inputSchema: planOutputSchema,
  outputSchema: buildOutputSchema,
  execute: async ({ inputData }) => {
    const { ticket, plan } = inputData;

    const slug = ticket.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30);
    const ws = await createWorkspace(ticket.repoPath, ticket.id, slug);

    const result = await codex.run({
      role: "build", // -> sandbox workspace-write
      instructions: [
        "Jesteś builderem. Zaimplementuj DOKŁADNIE poniższy plan w bieżącym katalogu.",
        "Nie wykraczaj poza zakres planu.",
        "NIE commituj zmian — commit wykonuje fabryka.",
        "Na końcu wypisz raport: co zmieniłeś i jak to zweryfikować.",
      ].join("\n"),
      context: `# Ticket ${ticket.id}: ${ticket.title}\n\n${ticket.description}\n\n# Plan\n\n${plan}`,
      workspace: ws.dir,
      budget: { minutes: 15 },
    });

    if (!result.ok) throw new Error(`Builder padł: ${result.report}`);

    // dowód pracy: git status, nie deklaracja agenta
    const { stdout: status } = await exec("git", ["-C", ws.dir, "status", "--porcelain"]);
    const changedFiles = status.split("\n").filter(Boolean).map((l) => l.slice(3));
    if (changedFiles.length === 0) throw new Error("Builder nie zmienił żadnego pliku");

    await exec("git", ["-C", ws.dir, "add", "-A"]);
    await exec("git", ["-C", ws.dir, "commit", "-m",
      `feat(${ticket.id}): ${ticket.title}\n\n[ai-factory build]`]);

    return {
      ticket,
      plan,
      branch: ws.branch,
      workspaceDir: ws.dir,
      changedFiles,
      buildReport: result.report,
    };
  },
});

const publishOutputSchema = buildOutputSchema.extend({ prUrl: z.string() });

const publishStep = createStep({
  id: "publish",
  description: "Publish: push brancha + draft PR (deterministyczny kod)",
  inputSchema: buildOutputSchema,
  outputSchema: publishOutputSchema,
  execute: async ({ inputData }) => {
    const { ticket, branch, workspaceDir } = inputData;
    if (!ticket.github) {
      throw new Error("Projekt nie ma repo GitHub w rejestrze — publish niemożliwy");
    }

    await exec("git", ["-C", workspaceDir, "push", "-u", "origin", branch]);

    // opis PR przez plik — omijamy limity długości i escapowanie argumentów
    const bodyFile = join(tmpdir(), `pr-${ticket.id}.md`);
    await writeFile(bodyFile, [
      `Ticket: ${ticket.id} — ${ticket.title}`,
      "",
      "## Plan",
      inputData.plan,
      "",
      "## Raport buildera",
      inputData.buildReport,
      "",
      "## Zmienione pliki",
      ...inputData.changedFiles.map((f) => `- ${f}`),
      "",
      "_Wygenerowane przez ai-factory._",
    ].join("\n"));

    const { stdout } = await exec(
      "gh",
      ["pr", "create", "--draft", "--head", branch,
       "--title", `feat(${ticket.id}): ${ticket.title}`,
       "--body-file", bodyFile],
      { cwd: workspaceDir } // gh pozna repo po remote origin worktree
    );

    return { ...inputData, prUrl: stdout.trim() };
  },
});

export const ticketPipeline = createWorkflow({
  id: "ticket-pipeline",
  inputSchema: intakeInputSchema,   // <- już bez repoPath
  outputSchema: publishOutputSchema,
})
  .then(intakeStep)
  .then(planStep)
  .then(approvePlanStep)
  .then(buildStep)
  .then(publishStep);
ticketPipeline.commit();