import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LifecycleStore,
  RESEARCH_ROLES,
  researchAttemptStage,
  runStageOf,
  type LifecycleRun,
  type TicketManifestV2,
} from "../pipeline/lifecycle-store";
import { reduceLifecycle, type CoordinatorEvent, type NextAttempts } from "../pipeline/coordinator";
import {
  executeFactoryJobInput,
  type FactoryJobOutput,
  type FactoryJobRuntime,
} from "../pipeline/factory-job";
import { parseCritiqueVerdict, parseTriageVerdict } from "../pipeline/verdicts";
import { parseCommand, parseScorePayload } from "../sources/commands";
import { dispatchOutbox, type PollerDependencies } from "../sources/poll-linear-v2";
import type { EngineAdapter } from "../engines/types";

const manifest: TicketManifestV2 = {
  title: "Deep plan",
  description: "Implementacja v3",
  labels: [],
  inputHash: "hash-1",
};

function apply(store: LifecycleStore, run: LifecycleRun, event: CoordinatorEvent): LifecycleRun {
  const decision = reduceLifecycle(run, event);
  return store.transition(run.ticketId, {
    ...decision.transition,
    commands: decision.commands,
  });
}

const baseOutput = {
  report: "raport",
  signature: "ai-factory · fake@1.0 · model@high · planner",
  durationMs: 1,
  files: [] as string[],
  changedFiles: [] as string[],
  scopeWarnings: [] as string[],
};

function triageOutput(overrides: Partial<FactoryJobOutput> = {}): FactoryJobOutput {
  return { kind: "triage", outcome: "success", triagePath: "deep", triageSummary: "typ: feature · rozmiar: M", ...baseOutput, ...overrides };
}

function researchOutput(role: "recon" | "solution-a" | "solution-b", overrides: Partial<FactoryJobOutput> = {}): FactoryJobOutput {
  return { kind: "research", outcome: "success", researchRole: role, brief: `brief-${role}`, ...baseOutput, ...overrides };
}

function synthesisOutput(overrides: Partial<FactoryJobOutput> = {}): FactoryJobOutput {
  return {
    kind: "synthesis",
    outcome: "success",
    ...baseOutput,
    plan: "plan z sekcją ## Rozstrzygnięcia",
    files: ["src/a.ts"],
    domain: "backend",
    ...overrides,
  };
}

function critiqueOutput(overrides: Partial<FactoryJobOutput> = {}): FactoryJobOutput {
  return { kind: "critique", outcome: "success", critiqueVerdict: "ok", ...baseOutput, ...overrides };
}

const NEXT: NextAttempts = {
  plan: 1,
  triage: 2,
  synthesis: 1,
  critique: 1,
  "research-recon": 1,
  "research-solution-a": 1,
  "research-solution-b": 1,
};

test("deep path: triage → research ×3 → synteza → krytyka → bramka z pełnym komentarzem", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-v3-happy-"));
  const store = new LifecycleStore(join(dir, "registry.db"));
  try {
    let run = store.createRun("BAR-V1", "br-factory", manifest);
    run = apply(store, run, { type: "start", entry: "triage" });
    assert.deepEqual([run.stage, run.status, run.planEntry], ["triage", "running", "triage"]);
    assert.equal(store.outstandingCommands()[0].payload.kind, "triage");

    run = apply(store, run, { type: "job-finished", attempt: 1, output: triageOutput(), nextAttempts: NEXT });
    assert.deepEqual([run.stage, run.planVariant], ["research", "deep"]);
    const researchCommands = store.outstandingCommands().filter((c) => c.payload.kind === "research");
    assert.equal(researchCommands.length, 3);
    assert.deepEqual(
      researchCommands.map((c) => c.stage).sort(),
      ["research-recon", "research-solution-a", "research-solution-b"]
    );

    run = apply(store, run, { type: "job-finished", attempt: 1, output: researchOutput("recon"), nextAttempts: NEXT });
    assert.deepEqual([run.stage, run.status], ["research", "running"]);
    run = apply(store, run, { type: "job-finished", attempt: 1, output: researchOutput("solution-a"), nextAttempts: NEXT });

    // solution-b: pierwsza porażka → auto-retry, druga → degradacja i przejście do syntezy
    run = apply(store, run, {
      type: "job-finished",
      attempt: 1,
      output: researchOutput("solution-b", { outcome: "failed", brief: undefined, errorCode: "RESEARCH_ENGINE_FAILED" }),
      nextAttempts: { ...NEXT, "research-solution-b": 2 },
    });
    assert.equal(run.stage, "research");
    assert.equal(run.researchFailures?.["solution-b"], 1);
    const retryCommand = store.outstandingCommands().find((c) => c.key.includes("research-solution-b") && c.key.includes("auto2"));
    assert.ok(retryCommand, "auto-retry roli solution-b powinien być w outboxie");

    run = apply(store, run, {
      type: "job-finished",
      attempt: 2,
      output: researchOutput("solution-b", { outcome: "failed", brief: undefined, errorCode: "RESEARCH_ENGINE_FAILED" }),
      nextAttempts: NEXT,
    });
    assert.equal(run.stage, "synthesis");
    assert.equal(run.researchFailures?.["solution-b"], 2);
    assert.match(run.degradations?.join("\n") ?? "", /solution-b/);
    assert.equal(run.briefs?.recon, "brief-recon");

    run = apply(store, run, { type: "job-finished", attempt: 1, output: synthesisOutput(), nextAttempts: NEXT });
    assert.deepEqual([run.stage, run.plan !== undefined, run.planFiles], ["critique", true, ["src/a.ts"]]);
    const critiqueCommand = store.outstandingCommands().find((c) => c.payload.kind === "critique");
    assert.ok(critiqueCommand);
    assert.equal((critiqueCommand!.payload.briefs as Record<string, string>).recon, "brief-recon");

    // krytyka: issues → dokładnie jedna rewizja syntezy
    run = apply(store, run, {
      type: "job-finished",
      attempt: 1,
      output: critiqueOutput({ critiqueVerdict: "issues", critiqueIssues: "1. brak testu regresji" }),
      nextAttempts: { ...NEXT, synthesis: 2 },
    });
    assert.deepEqual([run.stage, run.critiqueRound], ["synthesis", 1]);
    const revision = store.outstandingCommands().find((c) => c.payload.kind === "synthesis" && c.key.includes("rev1"));
    assert.ok(revision, "rewizja syntezy powinna być w outboxie");
    assert.match(String(revision!.payload.feedback), /brak testu regresji/);

    run = apply(store, run, { type: "job-finished", attempt: 2, output: synthesisOutput(), nextAttempts: { ...NEXT, critique: 2 } });
    assert.equal(run.stage, "critique");

    // druga krytyka z uwagami NIE robi kolejnej rewizji — idzie na bramkę z ⚠️
    run = apply(store, run, {
      type: "job-finished",
      attempt: 2,
      output: critiqueOutput({ critiqueVerdict: "issues", critiqueIssues: "2. nadal ryzyko X" }),
      nextAttempts: NEXT,
      usage: { usd: 4.21, minutes: 31.5 },
    });
    assert.deepEqual([run.stage, run.status, run.critiqueVerdict], ["approval", "waiting_human", "issues"]);
    const gateComment = store.outstandingCommands().find((c) => c.kind === "linear-comment");
    const body = String(gateComment!.payload.body);
    assert.match(body, /Plan gotowy \(deep/);
    assert.match(body, /Krytyka planu — uwagi/);
    assert.match(body, /nadal ryzyko X/);
    assert.match(body, /Degradacje/);
    assert.match(body, /\$4\.21/);
    assert.match(body, /Triage: typ: feature/);

    // /approve → build dostaje brief recon w payloadzie
    run = apply(store, run, { type: "approve", commentId: "c-approve", nextAttempt: 1 });
    const buildCommand = store.outstandingCommands().find((c) => c.payload.kind === "build");
    assert.equal((buildCommand!.payload.briefs as Record<string, string>).recon, "brief-recon");

    // review (po CI) dostaje uwagi krytyka
    const ciRun: LifecycleRun = {
      ...run,
      stage: "ci",
      status: "waiting_external",
      headSha: "a".repeat(40),
      testedSha: "a".repeat(40),
      prUrl: "https://github.test/o/r/pull/1",
    };
    const reviewDecision = reduceLifecycle(ciRun, {
      type: "ci-result", outcome: "pass", sha: ciRun.headSha!, report: "quality", nextReviewAttempt: 1,
    });
    assert.match(String(reviewDecision.commands[0].payload.critique), /nadal ryzyko X/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("krytyka ok → bramka bez rewizji; krytyka niedostępna → bramka z ⚠️ degradacją", () => {
  const run: LifecycleRun = {
    ticketId: "BAR-V2",
    project: "br-factory",
    generation: 1,
    stage: "critique",
    status: "running",
    manifest,
    plan: "plan",
    planFiles: ["src/a.ts"],
    clarifyRound: 0,
    critiqueRound: 0,
    planVariant: "deep",
    createdAt: "x",
    updatedAt: "x",
  };
  const ok = reduceLifecycle(run, { type: "job-finished", attempt: 1, output: critiqueOutput() });
  assert.deepEqual([ok.transition.stage, ok.transition.status], ["approval", "waiting_human"]);
  assert.match(String(ok.commands[0].payload.body), /bez zastrzeżeń/);

  const unavailable = reduceLifecycle(run, {
    type: "job-finished",
    attempt: 1,
    output: critiqueOutput({ outcome: "failed", critiqueVerdict: "unavailable", errorCode: "CRITIQUE_VERDICT_MISSING" }),
  });
  assert.deepEqual([unavailable.transition.stage, unavailable.transition.status], ["approval", "waiting_human"]);
  assert.match(String(unavailable.commands[0].payload.body), /Krytyka planu niedostępna/);
  assert.match((unavailable.transition.patch?.degradations ?? []).join("\n"), /krytyka planu niedostępna/);
});

test("triage: awaria degraduje do solo, budżet blokuje, label plan:deep wymusza research", () => {
  const run: LifecycleRun = {
    ticketId: "BAR-V3",
    project: "br-factory",
    generation: 1,
    stage: "triage",
    status: "running",
    manifest,
    planFiles: [],
    clarifyRound: 0,
    critiqueRound: 0,
    planEntry: "triage",
    createdAt: "x",
    updatedAt: "x",
  };
  const degraded = reduceLifecycle(run, {
    type: "job-finished",
    attempt: 1,
    output: triageOutput({ outcome: "failed", triagePath: undefined, errorCode: "TRIAGE_ENGINE_FAILED" }),
    nextAttempts: NEXT,
  });
  assert.deepEqual([degraded.transition.stage, degraded.transition.status], ["plan", "running"]);
  assert.equal(degraded.commands[0].payload.kind, "plan");
  assert.match((degraded.transition.patch?.degradations ?? []).join("\n"), /triage niedostępny/);
  assert.equal(degraded.transition.patch?.planVariant, "solo");

  const budget = reduceLifecycle(run, {
    type: "job-finished",
    attempt: 1,
    output: triageOutput({ outcome: "failed", triagePath: undefined, errorCode: "BUDGET_EXHAUSTED" }),
  });
  assert.equal(budget.transition.status, "blocked");

  const forced = reduceLifecycle(
    { ...run, manifest: { ...manifest, labels: ["plan:deep"] } },
    {
      type: "job-finished",
      attempt: 1,
      output: triageOutput({ outcome: "failed", triagePath: undefined, errorCode: "TRIAGE_ENGINE_FAILED" }),
      nextAttempts: NEXT,
    }
  );
  assert.equal(forced.transition.stage, "research");
  assert.equal(forced.commands.length, 3);
});

test("triage: pytania rundy 1, /answer wraca do triage, ponowne pytania degradują do solo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-v3-questions-"));
  const store = new LifecycleStore(join(dir, "registry.db"));
  try {
    let run = store.createRun("BAR-V4", "br-factory", manifest);
    run = apply(store, run, { type: "start", entry: "triage" });
    run = apply(store, run, {
      type: "job-finished",
      attempt: 1,
      output: triageOutput({ outcome: "questions", triagePath: undefined, questions: "1. Zakres? A) mały B) duży" }),
      nextAttempts: NEXT,
    });
    assert.deepEqual([run.stage, run.status, run.clarifyRound], ["triage", "waiting_human", 1]);
    const questionComment = store.outstandingCommands().find((c) => c.kind === "linear-comment");
    assert.match(String(questionComment!.payload.body), /triage.*runda 1\/2/s);

    run = apply(store, run, { type: "answer", commentId: "c-answer", answer: "1A", nextAttempt: 2 });
    assert.deepEqual([run.stage, run.status], ["triage", "running"]);
    const retriage = store.outstandingCommands().filter((c) => c.payload.kind === "triage");
    assert.equal(retriage.length, 2, "odpowiedź powinna dołożyć drugi job triage");

    run = apply(store, run, {
      type: "job-finished",
      attempt: 2,
      output: triageOutput({ outcome: "questions", triagePath: undefined, questions: "wciąż niejasne" }),
      nextAttempts: NEXT,
    });
    assert.deepEqual([run.stage, run.status, run.planVariant], ["plan", "running", "solo"]);
    assert.match(run.degradations?.join("\n") ?? "", /nie rozstrzygnął/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("wszystkie role researchu padły → RESEARCH_FAILED; /retry ponawia tylko brakujące role", () => {
  const run: LifecycleRun = {
    ticketId: "BAR-V5",
    project: "br-factory",
    generation: 1,
    stage: "research",
    status: "running",
    manifest,
    planFiles: [],
    clarifyRound: 0,
    critiqueRound: 0,
    planEntry: "triage",
    planVariant: "deep",
    briefs: {},
    // recon i solution-a już wyczerpały ponowienia; solution-b po auto-retry.
    researchFailures: { recon: 2, "solution-a": 2, "solution-b": 1 },
    createdAt: "x",
    updatedAt: "x",
  };
  const allFailed = reduceLifecycle(run, {
    type: "job-finished",
    attempt: 2,
    output: researchOutput("solution-b", { outcome: "failed", brief: undefined, errorCode: "RESEARCH_ENGINE_FAILED" }),
    nextAttempts: NEXT,
  });
  assert.equal(allFailed.transition.status, "blocked");
  assert.equal(allFailed.transition.patch?.errorCode, "RESEARCH_FAILED");

  const blockedRun: LifecycleRun = {
    ...run,
    status: "blocked",
    blockedStage: "research",
    errorCode: "RESEARCH_FAILED",
    briefs: { recon: "brief" },
  };
  const retry = reduceLifecycle(blockedRun, {
    type: "retry",
    commentId: "c-r",
    nextAttempts: { "research-solution-a": 3, "research-solution-b": 3 },
  });
  assert.equal(retry.commands.length, 2);
  assert.deepEqual(
    retry.commands.map((c) => c.stage).sort(),
    ["research-solution-a", "research-solution-b"]
  );
  assert.equal(retry.transition.patch?.researchFailures, undefined);
});

test("zmiana inputu w trakcie researchu wraca do triage z nową generacją i czystym stanem", () => {
  const run: LifecycleRun = {
    ticketId: "BAR-V6",
    project: "br-factory",
    generation: 1,
    stage: "research",
    status: "running",
    manifest,
    planFiles: [],
    clarifyRound: 0,
    critiqueRound: 1,
    planEntry: "triage",
    planVariant: "deep",
    briefs: { recon: "stary brief" },
    degradations: ["stara degradacja"],
    createdAt: "x",
    updatedAt: "x",
  };
  const decision = reduceLifecycle(run, {
    type: "input-changed",
    inputHash: "hash-2",
    nextAttempts: { triage: 2 },
  });
  assert.deepEqual([decision.transition.stage, decision.transition.incrementGeneration], ["triage", true]);
  assert.equal(decision.transition.patch?.briefs, undefined);
  assert.equal(decision.transition.patch?.degradations, undefined);
  assert.equal(decision.commands[0].payload.kind, "triage");
  assert.match(decision.commands[0].key, /g2/);

  // label plan:solo w edytowanym tickecie wymusza klasyczne wejście
  const soloDecision = reduceLifecycle(run, {
    type: "input-changed",
    inputHash: "hash-3",
    labels: ["plan:solo"],
    nextAttempts: { plan: 1 },
  });
  assert.equal(soloDecision.transition.stage, "plan");
  assert.equal(soloDecision.commands[0].payload.kind, "plan");
});

test("solo start (v2) pozostaje bez zmian i dostaje koszt w komentarzu bramki", () => {
  const run: LifecycleRun = {
    ticketId: "BAR-V7",
    project: "br-factory",
    generation: 1,
    stage: "plan",
    status: "running",
    manifest,
    planFiles: [],
    clarifyRound: 0,
    critiqueRound: 0,
    createdAt: "x",
    updatedAt: "x",
  };
  const ready = reduceLifecycle(run, {
    type: "job-finished",
    attempt: 1,
    output: {
      kind: "plan",
      outcome: "success",
      ...baseOutput,
      plan: "plan solo",
      files: ["src/a.ts"],
      domain: "backend",
    },
    usage: { usd: 1.5, minutes: 8 },
  });
  assert.deepEqual([ready.transition.stage, ready.transition.status], ["approval", "waiting_human"]);
  const body = String(ready.commands[0].payload.body);
  assert.match(body, /Plan gotowy/);
  assert.doesNotMatch(body, /deep/);
  assert.match(body, /\$1\.50/);
});

test("attempt stages ról researchu nie kolidują w rejestrze prób", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-v3-attempts-"));
  const store = new LifecycleStore(join(dir, "registry.db"));
  try {
    store.createRun("BAR-V8", "br-factory", manifest);
    for (const role of RESEARCH_ROLES) {
      store.startAttempt("BAR-V8", researchAttemptStage(role), 1, `job-${role}`);
      store.finishAttempt("BAR-V8", researchAttemptStage(role), 1, {
        status: "success",
        outcome: "success",
        costUsd: 0.5,
        durationMs: 60_000,
      });
    }
    for (const role of RESEARCH_ROLES) {
      assert.equal(store.latestAttempt("BAR-V8", researchAttemptStage(role))?.jobRunId, `job-${role}`);
    }
    assert.equal(store.totalUsage("BAR-V8").usd, 1.5);
    assert.equal(runStageOf("research-recon"), "research");
    assert.equal(runStageOf("build"), "build");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rezerwacja budżetu: job w toku blokuje start kolejnego przy limicie (fan-out nie przekracza budżetu)", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-v3-reserve-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const store = new LifecycleStore(join(root, "registry.db"));
  try {
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "projects.yaml"), [
      "harness:",
      `  repo: ${JSON.stringify(root)}`,
      "  checks:",
      "    - \"true\"",
      "  budget:",
      "    maxUsd: 3",
      "    maxMinutes: 90",
    ].join("\n"));
    process.env.FACTORY_ROOT = root;
    const deps: PollerDependencies = {
      store,
      mastra: {
        async getRun() { throw new Error("rezerwacja powinna zablokować dispatch przed Mastrą"); },
      } as unknown as PollerDependencies["mastra"],
      sources: new Map([["harness", {
        async setStateByName() {},
        async listComments() { return []; },
        async comment() {},
      } as never]]),
      notifier: async () => {},
    };
    store.createRun("BAR-RES", "harness", manifest);
    store.transition("BAR-RES", {
      stage: "research",
      status: "running",
      actor: "test",
      reason: "fan-out",
      patch: { planEntry: "triage", planVariant: "deep" },
    });
    // Build w toku (bez wyniku) rezerwuje 25 min × $0.15/min = $3.75 ≥ limitu $3.
    store.startAttempt("BAR-RES", "build", 1, "job-live");
    store.enqueue({
      key: "BAR-RES:g1:job:research:research-recon:a1",
      ticketId: "BAR-RES",
      kind: "run-job",
      stage: "research-recon",
      payload: { kind: "research", researchRole: "recon", attempt: 1 },
    });
    await dispatchOutbox(deps);
    const attempt = store.latestAttempt("BAR-RES", "research-recon");
    assert.equal(attempt?.errorCode, "BUDGET_EXHAUSTED");
    assert.equal(store.getRun("BAR-RES")?.researchFailures?.recon, 2, "budżet nie dostaje auto-retry");
    assert.match(attempt?.report ?? "", /rezerwacja za joby w toku/);
  } finally {
    store.close();
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("komendy /score: ścisła walidacja i parsowanie payloadu", () => {
  assert.deepEqual(parseCommand("/score 4 solidny plan"), { kind: "score", payload: "4 solidny plan" });
  assert.deepEqual(parseCommand("/score 5"), { kind: "score", payload: "5" });
  assert.equal(parseCommand("/score"), undefined);
  assert.equal(parseCommand("/score 9"), undefined);
  assert.equal(parseCommand("/score świetne"), undefined);
  assert.deepEqual(parseScorePayload("4 solidny plan"), { value: 4, comment: "solidny plan" });
  assert.deepEqual(parseScorePayload("5"), { value: 5, comment: undefined });
  assert.equal(parseScorePayload("6"), undefined);
});

test("verdictInstruction każe umieścić w bloku wyłącznie goły JSON (incydent BAR-180)", async () => {
  const { verdictInstruction } = await import("../pipeline/verdicts");
  for (const kind of ["plan", "triage", "critique", "review"] as const) {
    assert.match(verdictInstruction(kind), /WYŁĄCZNIE goły JSON/);
  }
  // Dokładna reprodukcja błędu haiku: etykieta z instrukcji wklejona do bloku
  // przed JSON-em = kontrakt złamany, fail-closed (nigdy zgadywanie).
  const prefixed = [
    "```factory",
    'Rekomendacja ścieżki planowania: {"verdict":"deep","risk":[]}',
    "```",
  ].join("\n");
  assert.equal(parseTriageVerdict(prefixed).source, "missing");
});

test("kontrakty triage i krytyki parsują się fail-closed", () => {
  const triage = parseTriageVerdict([
    "analiza…",
    "```factory",
    '{"verdict":"deep","type":"feature","size":"L","risk":["migracje"],"domain":"backend"}',
    "```",
  ].join("\n"));
  assert.deepEqual([triage.path, triage.domain, triage.source], ["deep", "backend", "structured"]);
  assert.match(triage.summary ?? "", /typ: feature/);
  assert.match(triage.summary ?? "", /ryzyko: migracje/);

  const questions = parseTriageVerdict('```factory\n{"verdict":"questions","questions":"1. A czy B?"}\n```');
  assert.equal(questions.questions, "1. A czy B?");
  assert.equal(parseTriageVerdict("bez bloku").source, "missing");

  const issues = parseCritiqueVerdict('```factory\n{"verdict":"issues","issues":"1. brak testów"}\n```');
  assert.deepEqual([issues.verdict, issues.issues], ["issues", "1. brak testów"]);
  assert.equal(parseCritiqueVerdict("bez bloku").verdict, "unavailable");
  assert.equal(parseCritiqueVerdict('```factory\n{"verdict":"ok"}\n```').verdict, "ok");
});

function fakeRuntime(engine: EngineAdapter, routeSpec = "fake/fake-model"): FactoryJobRuntime {
  return {
    async route() {
      return { engine, model: "fake-model", spec: routeSpec };
    },
    async project() {
      return { repo: "/tmp", checks: ["true"] };
    },
  };
}

test("factoryJob: triage, research, synteza i krytyka działają jako bezstanowe joby", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-v3-jobs-"));
  const previousRoot = process.env.FACTORY_ROOT;
  process.env.FACTORY_ROOT = root;
  await writeFile(join(root, "package.json"), "{}");
  const ticket = {
    id: "BAR-V9",
    title: "Jobs",
    description: "opis",
    project: "fake",
    labels: [],
    inputHash: "hash",
  };
  try {
    const triageEngine: EngineAdapter = {
      name: "fake",
      async run() {
        return {
          ok: true,
          report: '```factory\n{"verdict":"deep","type":"refactor","size":"M","risk":[]}\n```',
        };
      },
    };
    const triage = await executeFactoryJobInput(
      { kind: "triage", attempt: 1, ticket, planFiles: [] },
      "job-t1",
      undefined,
      fakeRuntime(triageEngine)
    );
    assert.deepEqual([triage.outcome, triage.triagePath], ["success", "deep"]);

    const researchEngine: EngineAdapter = {
      name: "fake",
      async run(input) {
        assert.equal(input.role, "plan");
        return { ok: true, report: "## Pliki do zmiany\n- src/a.ts" };
      },
    };
    const research = await executeFactoryJobInput(
      { kind: "research", researchRole: "recon", attempt: 1, ticket, planFiles: [] },
      "job-r1",
      undefined,
      fakeRuntime(researchEngine)
    );
    assert.deepEqual([research.outcome, research.researchRole], ["success", "recon"]);
    assert.match(research.brief ?? "", /src\/a\.ts/);

    await assert.rejects(
      executeFactoryJobInput(
        { kind: "research", attempt: 1, ticket, planFiles: [] },
        "job-r2",
        undefined,
        fakeRuntime(researchEngine)
      ),
      /researchRole/
    );

    const synthesisEngine: EngineAdapter = {
      name: "fake",
      async run(input) {
        assert.match(input.context, /Brief RECON/);
        return {
          ok: true,
          report: [
            "# Plan",
            "## Rozstrzygnięcia",
            "```factory",
            '{"verdict":"ok","screenshots":[],"files":["src/a.ts"],"domain":"backend"}',
            "```",
          ].join("\n"),
        };
      },
    };
    const synthesis = await executeFactoryJobInput(
      {
        kind: "synthesis",
        attempt: 1,
        ticket,
        planFiles: [],
        briefs: { recon: "mapa", "solution-a": "warianty" },
      },
      "job-s1",
      undefined,
      fakeRuntime(synthesisEngine)
    );
    assert.deepEqual([synthesis.outcome, synthesis.files], ["success", ["src/a.ts"]]);

    const critiqueEngine: EngineAdapter = {
      name: "fake",
      async run() {
        return { ok: true, report: '```factory\n{"verdict":"issues","issues":"1. brak testów"}\n```' };
      },
    };
    const critique = await executeFactoryJobInput(
      { kind: "critique", attempt: 1, ticket, planFiles: [], plan: "plan" },
      "job-c1",
      undefined,
      fakeRuntime(critiqueEngine)
    );
    assert.deepEqual([critique.critiqueVerdict, critique.critiqueIssues], ["issues", "1. brak testów"]);

    // routing krytyki pada (np. brak dywersyfikacji) → advisory unavailable, nie throw
    const failingRoute: FactoryJobRuntime = {
      async route() {
        throw new Error("Routing critique.diverse wskazuje wykluczony silnik");
      },
      async project() {
        return { repo: root, checks: ["true"] };
      },
    };
    const unavailable = await executeFactoryJobInput(
      { kind: "critique", attempt: 1, ticket, planFiles: [], plan: "plan" },
      "job-c2",
      undefined,
      failingRoute
    );
    assert.deepEqual(
      [unavailable.outcome, unavailable.critiqueVerdict, unavailable.errorCode],
      ["failed", "unavailable", "CRITIQUE_ROUTE_FAILED"]
    );
  } finally {
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
