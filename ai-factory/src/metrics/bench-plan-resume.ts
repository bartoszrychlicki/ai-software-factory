/**
 * Kontrolowany A/B planera Claude na identycznym repo, tickecie i odpowiedzi:
 *   npx tsx src/metrics/bench-plan-resume.ts BAR-136 ./scenario.json
 *
 * scenario.json:
 * {
 *   "title": "Prompt caching / optymalizacja tokenów per projekt",
 *   "description": "Pełny opis ticketu",
 *   "answer": "1A, 2C",
 *   "workspace": "/absolutna/lub/względna/ścieżka/repo",
 *   "model": "sonnet",
 *   "effort": "high",
 *   "differenceExplanation": "Opcjonalne, wymagane tylko gdy domain/files świadomie się różnią"
 * }
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { claudeCode } from "../engines/claude-code";
import type { EngineRunResult } from "../engines/types";
import { buildPlanEnginePrompt } from "../pipeline/ticket-pipeline";
import { findUpFile } from "../pipeline/projects";
import { parsePlanVerdict } from "../pipeline/verdicts";

const scenarioSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  answer: z.string().min(1),
  workspace: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1).optional(),
  budgetMinutes: z.number().positive().default(20),
  differenceExplanation: z.string().trim().min(1).optional(),
}).strict();

type Prompt = ReturnType<typeof buildPlanEnginePrompt>;

interface MeasuredRun {
  result: EngineRunResult;
  durationMs: number;
  promptBytes: number;
  startedAt: number;
}

const promptBytes = (prompt: Prompt) =>
  Buffer.byteLength(`${prompt.instructions}\n\n${prompt.context}`, "utf8");

async function measure(
  prompt: Prompt,
  scenario: z.infer<typeof scenarioSchema>,
  workspace: string
): Promise<MeasuredRun> {
  const startedAt = Date.now();
  const result = await claudeCode.run({
    role: "plan",
    instructions: prompt.instructions,
    context: prompt.context,
    sessionId: prompt.sessionId,
    workspace,
    budget: { minutes: scenario.budgetMinutes },
    model: scenario.model,
    effort: scenario.effort,
  });
  return {
    result,
    durationMs: Date.now() - startedAt,
    promptBytes: promptBytes(prompt),
    startedAt,
  };
}

function verdictOf(result: EngineRunResult) {
  const parsed = parsePlanVerdict(result.transcript ?? result.report);
  return {
    verdict: parsed.source === "missing" ? "missing" as const : parsed.ok ? "ok" as const : "blocked" as const,
    parseSource: parsed.source,
    domain: parsed.domain ?? null,
    files: [...new Set(parsed.files)].sort(),
  };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function main(): Promise<void> {
  const [ticket, scenarioArg] = process.argv.slice(2);
  if (!ticket || !scenarioArg) {
    throw new Error("Użycie: npx tsx src/metrics/bench-plan-resume.ts <ticket> <scenario.json>");
  }

  const scenarioPath = resolve(process.cwd(), scenarioArg);
  const scenario = scenarioSchema.parse(JSON.parse(await readFile(scenarioPath, "utf8")));
  const workspace = resolve(dirname(scenarioPath), scenario.workspace);
  const ticketInput = { id: ticket, title: scenario.title, description: scenario.description };

  // B potrzebuje wyłącznie sesji utworzonej na pełnym, bez-odpowiedziowym promptcie rundy 1.
  // Jej koszt nie wchodzi do wyniku B: runda 1 występuje w obu realnych przebiegach ticketu.
  const primePrompt = buildPlanEnginePrompt({
    ticket: ticketInput,
    clarifyRound: 0,
    answers: [],
  });
  const prime = await measure(primePrompt, scenario, workspace);
  if (!prime.result.ok || !prime.result.sessionId) {
    throw new Error(
      `Nie udało się utworzyć sesji bazowej Claude: ${prime.result.report.slice(0, 500)}`
    );
  }
  const primeParsed = parsePlanVerdict(prime.result.transcript ?? prime.result.report);
  if (primeParsed.source === "missing" || primeParsed.ok || !primeParsed.questions) {
    throw new Error(
      "Sesja bazowa nie zakończyła się parsowalnym verdict=blocked z pytaniami; " +
        "scenariusz nie odtwarza pętli plan↔clarify."
    );
  }
  const primeVerdict = verdictOf(prime.result);

  const answers = [scenario.answer];
  const coldPrompt = buildPlanEnginePrompt({
    ticket: ticketInput,
    clarifyRound: 1,
    answers,
  });
  const cold = await measure(coldPrompt, scenario, workspace);

  const resumedPrompt = buildPlanEnginePrompt({
    ticket: ticketInput,
    clarifyRound: 1,
    answers,
    sessionId: prime.result.sessionId,
  });
  const resumed = await measure(resumedPrompt, scenario, workspace);

  const coldVerdict = verdictOf(cold.result);
  const resumedVerdict = verdictOf(resumed.result);
  const domainMatches = coldVerdict.domain === resumedVerdict.domain;
  const filesMatch = JSON.stringify(coldVerdict.files) === JSON.stringify(resumedVerdict.files);
  const parseValid = coldVerdict.parseSource !== "missing" && resumedVerdict.parseSource !== "missing";
  const outputsMatch = domainMatches && filesMatch;
  const qualityPassed =
    cold.result.ok &&
    resumed.result.ok &&
    parseValid &&
    (outputsMatch || !!scenario.differenceExplanation);

  const onlyCold = coldVerdict.files.filter((file) => !resumedVerdict.files.includes(file));
  const onlyResumed = resumedVerdict.files.filter((file) => !coldVerdict.files.includes(file));
  const roundAStartedAt = cold.startedAt;
  const resultRows = [
    {
      mode: "cold" as const,
      model: scenario.model,
      costUsd: cold.result.costUsd ?? null,
      durationMs: cold.durationMs,
      promptBytes: cold.promptBytes,
      sessionId: cold.result.sessionId ?? null,
      elapsedMsSinceRoundA: 0,
      ok: cold.result.ok,
      ...coldVerdict,
    },
    {
      mode: "resumed" as const,
      model: scenario.model,
      costUsd: resumed.result.costUsd ?? null,
      durationMs: resumed.durationMs,
      promptBytes: resumed.promptBytes,
      sessionId: resumed.result.sessionId ?? prime.result.sessionId,
      elapsedMsSinceRoundA: resumed.startedAt - roundAStartedAt,
      ok: resumed.result.ok,
      ...resumedVerdict,
    },
  ];

  const artifact = {
    schemaVersion: 1,
    ticket,
    createdAt: new Date().toISOString(),
    control: {
      workspace,
      title: scenario.title,
      descriptionSha256: sha256(scenario.description),
      answerSha256: sha256(scenario.answer),
      identicalRepositoryTicketAndAnswers: true,
    },
    setup: {
      model: scenario.model,
      costUsd: prime.result.costUsd ?? null,
      durationMs: prime.durationMs,
      promptBytes: prime.promptBytes,
      sessionId: prime.result.sessionId,
      ok: prime.result.ok,
      ...primeVerdict,
    },
    results: resultRows,
    quality: {
      passed: qualityPassed,
      parsePlanVerdict: {
        cold: coldVerdict.parseSource,
        resumed: resumedVerdict.parseSource,
      },
      domainMatches,
      filesMatch,
      differences: outputsMatch
        ? null
        : {
            domain: domainMatches ? null : { cold: coldVerdict.domain, resumed: resumedVerdict.domain },
            files: filesMatch ? null : { onlyCold, onlyResumed },
          },
      differenceExplanation: outputsMatch ? null : scenario.differenceExplanation ?? null,
      requiresDifferenceExplanation: !outputsMatch && !scenario.differenceExplanation,
    },
  };

  const root = dirname(findUpFile("package.json"));
  const outputDir = join(root, "runs", "bench");
  await mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeTicket = ticket.replace(/[^a-zA-Z0-9._-]/g, "-");
  const outputPath = join(outputDir, `plan-resume-${safeTicket}-${timestamp}.json`);
  await writeFile(outputPath, JSON.stringify(artifact, null, 2) + "\n");
  console.log(outputPath);

  if (!qualityPassed) {
    process.exitCode = 2;
    console.error(
      "Benchmark nie przeszedł proxy jakości: oba wyniki muszą być parsowalne, a domain/files zgodne lub różnica jawnie wyjaśniona."
    );
  }
}

await main();
