import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineAdapter } from "../engines/types";
import { reduceLifecycle } from "../pipeline/coordinator";
import {
  executeFactoryJobInput,
  type FactoryJobOutput,
  type FactoryJobRuntime,
} from "../pipeline/factory-job";
import {
  LifecycleStore,
  type LifecycleRun,
  type TicketManifestV2,
} from "../pipeline/lifecycle-store";
import { parseCritiqueVerdict, parsePlanVerdict } from "../pipeline/verdicts";

const manifest: TicketManifestV2 = {
  title: "Czytelna bramka",
  description: "Pokaż plan po ludzku",
  labels: [],
  inputHash: "hash-summary",
};

const baseOutput = {
  report: "raport",
  signature: "ai-factory · fake@1.0 · model@high · planner",
  durationMs: 1,
  files: [] as string[],
  changedFiles: [] as string[],
  scopeWarnings: [] as string[],
};

function planReport(withSummary = true): string {
  return [
    withSummary ? "## Podsumowanie dla człowieka" : "",
    withSummary ? "" : "",
    withSummary ? "**Co dostaniesz** — czytelną bramkę." : "",
    withSummary ? "**Dlaczego tak** — najważniejsze decyzje są na górze." : "",
    withSummary ? "**Czego świadomie NIE robimy** — nie skracamy planu." : "",
    withSummary ? "**Kompromisy i czego to nie naprawi** — brak sekcji nie blokuje planu." : "",
    withSummary ? "**Jak poznasz, że działa** — decyzję podejmiesz bez czytania całości." : "",
    "## Zakres techniczny",
    "",
    "Pełny plan techniczny.",
    "",
    "```factory",
    '{"verdict":"ok","screenshots":[],"files":["src/a.ts"],"domain":"backend"}',
    "```",
  ].filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== "")).join("\n");
}

function runAt(stage: LifecycleRun["stage"], overrides: Partial<LifecycleRun> = {}): LifecycleRun {
  return {
    ticketId: "BAR-187-T",
    project: "fake",
    generation: 1,
    stage,
    status: "running",
    manifest,
    plan: planReport(),
    planFiles: ["src/a.ts"],
    clarifyRound: 0,
    critiqueRound: 0,
    fixRound: 0,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function critiqueOutput(overrides: Partial<FactoryJobOutput> = {}): FactoryJobOutput {
  return {
    kind: "critique",
    outcome: "success",
    critiqueVerdict: "issues",
    critiqueIssues: "1. P1: brakuje kryterium regresji.",
    ...baseOutput,
    ...overrides,
  };
}

test("bramka deep renderuje streszczenie, znaczenie krytyki, degradacje, koszt i plan w tej kolejności", () => {
  const run = runAt("critique", {
    planVariant: "deep",
    critiqueRound: 1,
    triageSummary: "typ: feature · rozmiar: M",
    degradations: ["solution-b niedostępny"],
  });
  const decision = reduceLifecycle(run, {
    type: "job-finished",
    attempt: 2,
    output: critiqueOutput({
      critiqueMeaning: "Plan może przejść testy bez potwierdzenia efektu dla autora.",
    }),
    usage: { usd: 4.21, minutes: 31.5 },
  });
  const body = String(decision.commands[0].payload.body);
  const markers = [
    "📋 **Podsumowanie dla człowieka**",
    "⚠️ **Krytyka planu",
    "⚠️ **Degradacje:**",
    "Koszt planowania dotychczas:",
    "🔧 **Plan techniczny**",
  ];
  const offsets = markers.map((marker) => body.indexOf(marker));

  assert.equal(decision.transition.stage, "approval");
  assert.ok(offsets.every((offset) => offset >= 0), body);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  assert.ok(
    body.indexOf("> Plan może przejść testy") < body.indexOf("1. P1: brakuje kryterium"),
    body
  );
  assert.match(body, /## Zakres techniczny/);
  assert.equal((body.match(/Podsumowanie dla człowieka/g) ?? []).length, 1);
});

test("ścieżka solo także pokazuje streszczenie przed pełnym planem", () => {
  const decision = reduceLifecycle(runAt("plan", { plan: undefined, planVariant: "solo" }), {
    type: "job-finished",
    attempt: 1,
    output: {
      kind: "plan",
      outcome: "success",
      ...baseOutput,
      plan: planReport(),
      files: ["src/a.ts"],
      domain: "backend",
    },
  });
  const body = String(decision.commands[0].payload.body);

  assert.equal(decision.transition.stage, "approval");
  assert.ok(body.indexOf("📋 **Podsumowanie dla człowieka**") < body.indexOf("🔧 **Plan techniczny**"));
  assert.doesNotMatch(body, /Plan gotowy \(deep/);
});

test("brak zdania krytyka nie blokuje bramki i zachowuje listę uwag", () => {
  const decision = reduceLifecycle(runAt("critique", { critiqueRound: 1 }), {
    type: "job-finished",
    attempt: 2,
    output: critiqueOutput({ critiqueMeaning: undefined }),
  });
  const body = String(decision.commands[0].payload.body);

  assert.equal(decision.transition.status, "waiting_human");
  assert.equal(decision.transition.patch?.critiqueMeaning, undefined);
  assert.match(body, /1\. P1: brakuje kryterium regresji/);
});

test("critiqueMeaning przechodzi przez addytywną kolumnę SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-critique-meaning-"));
  const db = join(root, "lifecycle.db");
  let store: LifecycleStore | undefined = new LifecycleStore(db);
  try {
    let run = store.createRun("BAR-187-SQL", "fake", manifest);
    run = store.transition(run.ticketId, {
      stage: "critique",
      status: "running",
      actor: "test",
      reason: "seed-critique",
      patch: {
        plan: planReport(),
        planFiles: ["src/a.ts"],
        planVariant: "deep",
        critiqueRound: 1,
      },
    });
    const decision = reduceLifecycle(run, {
      type: "job-finished",
      attempt: 2,
      output: critiqueOutput({
        critiqueMeaning: "Uwagi oznaczają ryzyko pozornego sukcesu.",
      }),
    });
    store.transition(run.ticketId, {
      ...decision.transition,
      commands: decision.commands,
    });
    store.close();
    store = undefined;

    store = new LifecycleStore(db);
    assert.equal(
      store.getRun("BAR-187-SQL")?.critiqueMeaning,
      "Uwagi oznaczają ryzyko pozornego sukcesu."
    );
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("brak streszczenia jest fail-open i zapisuje summary-missing w metryce planu", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-summary-missing-"));
  const previousRoot = process.env.FACTORY_ROOT;
  process.env.FACTORY_ROOT = root;
  await writeFile(join(root, "package.json"), "{}");
  const report = planReport(false);
  const engine: EngineAdapter = {
    name: "fake",
    async run(input) {
      assert.match(input.instructions, /ZACZNIJ raport sekcją `## Podsumowanie dla człowieka`/);
      assert.ok(
        input.instructions.lastIndexOf("```") > input.instructions.indexOf("Podsumowanie dla człowieka"),
        "kontrakt factory powinien pozostać ostatnią częścią instrukcji"
      );
      return { ok: true, report };
    },
  };
  const runtime: FactoryJobRuntime = {
    async route() {
      return { engine, model: "fake-model", spec: "fake/fake-model" };
    },
    async project() {
      return { repo: root, checks: ["true"] };
    },
  };

  try {
    const output = await executeFactoryJobInput(
      {
        kind: "plan",
        attempt: 1,
        ticket: {
          id: "BAR-187-MISSING",
          title: manifest.title,
          description: manifest.description,
          project: "fake",
          labels: [],
          inputHash: manifest.inputHash,
        },
        planFiles: [],
      },
      "job-summary-missing",
      undefined,
      runtime
    );
    assert.deepEqual([output.outcome, output.errorCode], ["success", undefined]);

    const metricRows = (await readFile(join(root, "runs", "metrics.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const metric = metricRows.find((row) => row.stage === "plan");
    assert.equal(metric?.humanSummary, "summary-missing");

    const decision = reduceLifecycle(runAt("plan", { plan: undefined }), {
      type: "job-finished",
      attempt: 1,
      output,
    });
    const body = String(decision.commands[0].payload.body);
    assert.doesNotMatch(body, /📋 \*\*Podsumowanie dla człowieka/);
    assert.match(body, /Pełny plan techniczny/);
    assert.match(body, /Zatwierdź wyłącznie komendą `\/approve`/);
  } finally {
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("synteza wymaga pięciu bloków, zapisuje summary-present, a krytyka ekstrahuje zdanie", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-summary-deep-jobs-"));
  const previousRoot = process.env.FACTORY_ROOT;
  process.env.FACTORY_ROOT = root;
  await writeFile(join(root, "package.json"), "{}");
  const ticket = {
    id: "BAR-187-DEEP",
    title: manifest.title,
    description: manifest.description,
    project: "fake",
    labels: [],
    inputHash: manifest.inputHash,
  };

  try {
    const synthesisEngine: EngineAdapter = {
      name: "fake",
      async run(input) {
        assert.match(input.instructions, /ZACZNIJ raport sekcją `## Podsumowanie dla człowieka`/);
        for (const label of [
          "Co dostaniesz",
          "Dlaczego tak",
          "Czego świadomie NIE robimy",
          "Kompromisy i czego to nie naprawi",
          "Jak poznasz, że działa",
        ]) {
          assert.match(input.instructions, new RegExp(label));
        }
        return { ok: true, report: planReport() };
      },
    };
    const synthesisRuntime: FactoryJobRuntime = {
      async route() {
        return { engine: synthesisEngine, model: "fake-model", spec: "fake/fake-model" };
      },
      async project() {
        return { repo: root, checks: ["true"] };
      },
    };
    const synthesis = await executeFactoryJobInput(
      { kind: "synthesis", attempt: 1, ticket, planFiles: [], briefs: { recon: "mapa" } },
      "job-summary-synthesis",
      undefined,
      synthesisRuntime
    );
    assert.equal(synthesis.outcome, "success");

    const critiqueEngine: EngineAdapter = {
      name: "fake",
      async run(input) {
        assert.match(input.instructions, /`## Co to znaczy dla autora` — JEDNO zdanie/);
        return {
          ok: true,
          report: [
            "## Co to znaczy dla autora",
            "",
            "Plan może przejść testy,",
            "nie rozwiązując problemu autora.",
            "",
            "```factory",
            '{"verdict":"issues","issues":"1. Brak definicji gotowości."}',
            "```",
          ].join("\n"),
        };
      },
    };
    const critiqueRuntime: FactoryJobRuntime = {
      async route() {
        return { engine: critiqueEngine, model: "fake-model", spec: "fake/fake-model" };
      },
      async project() {
        return { repo: root, checks: ["true"] };
      },
    };
    const critique = await executeFactoryJobInput(
      {
        kind: "critique",
        attempt: 1,
        ticket,
        planFiles: synthesis.files,
        plan: synthesis.plan,
      },
      "job-summary-critique",
      undefined,
      critiqueRuntime
    );
    assert.equal(
      critique.critiqueMeaning,
      "Plan może przejść testy, nie rozwiązując problemu autora."
    );

    const metrics = (await readFile(join(root, "runs", "metrics.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(
      metrics.find((row) => row.stage === "synthesis")?.humanSummary,
      "summary-present"
    );
  } finally {
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("sekcje po ludzku nie zmieniają ścisłych kontraktów planu i krytyki", () => {
  const plan = parsePlanVerdict(planReport());
  assert.deepEqual(
    [plan.source, plan.ok, plan.files, plan.domain],
    ["structured", true, ["src/a.ts"], "backend"]
  );
  assert.equal(
    parsePlanVerdict("## Podsumowanie dla człowieka\n\n**Co dostaniesz** — efekt.").source,
    "missing"
  );

  const critiqueReport = [
    "## Co to znaczy dla autora",
    "",
    "Plan może przejść testy, nie rozwiązując problemu.",
    "",
    "```factory",
    '{"verdict":"issues","issues":"1. Brak definicji gotowości."}',
    "```",
  ].join("\n");
  const critique = parseCritiqueVerdict(critiqueReport);
  assert.deepEqual(
    [critique.source, critique.verdict, critique.issues],
    ["structured", "issues", "1. Brak definicji gotowości."]
  );
  assert.equal(
    parseCritiqueVerdict("## Co to znaczy dla autora\n\nPlan ma ryzyko.").source,
    "missing"
  );
});

test("zdanie krytyka z rundy 1 NIE przechodzi na uwagi rundy 2", () => {
  // Regresja: dziedziczenie `?? run.critiqueMeaning` stawiało zdanie opisujące
  // uwagi rundy 1 nad świeżymi uwagami rundy 2 — bramka mówiłaby człowiekowi
  // co innego, niż jest pod spodem.
  const run = runAt("critique", {
    critiqueRound: 1,
    critiqueMeaning: "Zdanie z rundy 1: plan pomija migrację danych.",
    critiqueReport: "1. P1: brak migracji.",
  });
  const decision = reduceLifecycle(run, {
    type: "job-finished",
    attempt: 2,
    output: critiqueOutput({
      critiqueMeaning: undefined,
      critiqueIssues: "1. P2: literówka w nazwie kolumny.",
    }),
  });
  const body = String(decision.commands[0].payload.body);

  assert.equal(decision.transition.patch?.critiqueMeaning, undefined);
  assert.doesNotMatch(body, /rundy 1/);
  assert.match(body, /literówka w nazwie kolumny/);
});

test("świeże zdanie krytyka rundy 2 zastępuje poprzednie", () => {
  const run = runAt("critique", {
    critiqueRound: 1,
    critiqueMeaning: "Zdanie z rundy 1.",
  });
  const decision = reduceLifecycle(run, {
    type: "job-finished",
    attempt: 2,
    output: critiqueOutput({ critiqueMeaning: "Zdanie z rundy 2." }),
  });

  assert.equal(decision.transition.patch?.critiqueMeaning, "Zdanie z rundy 2.");
  assert.doesNotMatch(String(decision.commands[0].payload.body), /rundy 1/);
});
