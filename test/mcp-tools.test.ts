import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinearSource } from "../src/adapters/linear/client";
import type { ProjectConfig } from "../src/config/projects";
import type { LifecycleRun, StageAttempt } from "../src/lifecycle/store";
import {
  breakerOpen,
  breakerSnapshot,
  type BreakerSnapshot,
} from "../src/observability/breaker";
import { unknownCommandHint } from "../src/lifecycle/commands";
import { loadDotEnv } from "../src/mcp/server";
import { clip, openGate, planView } from "../src/mcp/projection";
import {
  createFactoryTools,
  type FactoryToolDependencies,
  type McpLifecycleReader,
  type McpLinearClient,
} from "../src/mcp/tools";

const project: ProjectConfig = {
  repo: "/repos/harness",
  github: "acme/harness",
  checks: ["npm test"],
  ci: { requiredChecks: ["test"] },
  planPipeline: "v3",
  budget: { maxMinutes: 30, maxUsd: 2 },
  max_concurrent_tickets: 2,
  statuses: "extended",
  progress: "verbose",
};

function run(patch: Partial<LifecycleRun> = {}): LifecycleRun {
  return {
    ticketId: "BAR-200",
    project: "harness",
    generation: 1,
    stage: "approval",
    status: "waiting_human",
    manifest: {
      title: "MCP dla fabryki",
      description: "",
      labels: [],
      inputHash: "hash",
    },
    plan: "## Podsumowanie dla człowieka\nKrótko.\n\n## Plan\nSzczegóły",
    planFiles: ["src/mcp/server.ts"],
    clarifyRound: 0,
    critiqueRound: 0,
    fixRound: 0,
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T11:00:00.000Z",
    ...patch,
  };
}

class FakeStore implements McpLifecycleReader {
  runs = new Map<string, LifecycleRun>();
  attempts = new Map<string, StageAttempt[]>();
  lease: ReturnType<McpLifecycleReader["readLease"]>;

  getRun(ticketId: string) { return this.runs.get(ticketId); }
  listActive() { return [...this.runs.values()].filter((item) => item.status !== "done"); }
  listAttempts(ticketId: string) { return this.attempts.get(ticketId) ?? []; }
  readLease() { return this.lease; }
  totalUsage() { return { usd: 0.75, minutes: 12 }; }
  usageSinceForProjects(iso: string, projects: string[]) {
    const since = Date.parse(iso);
    const visibleProjects = new Set(projects);
    let total = 0;
    for (const [ticketId, attempts] of this.attempts) {
      const projectKey = this.runs.get(ticketId)?.project;
      if (!projectKey || !visibleProjects.has(projectKey)) continue;
      total += attempts.reduce((sum, attempt) => {
        const finishedAt = attempt.finishedAt ? Date.parse(attempt.finishedAt) : Number.NaN;
        return Number.isFinite(finishedAt) && finishedAt >= since
          ? sum + (attempt.costUsd ?? 0)
          : sum;
      }, 0);
    }
    return total;
  }
}

class FakeLinear implements McpLinearClient {
  comments: { id: string; body: string }[] = [];
  projectName: string | null = "harness";
  state = { stateName: "Backlog", stateType: "backlog" };
  moved: { id: string; state: string }[] = [];
  creates: { title: string; description?: string; labels?: string[] }[] = [];

  async createIssue(input: { title: string; description?: string; labels?: string[] }) {
    this.creates.push(input);
    return { identifier: "BAR-201", url: "https://linear.app/acme/issue/BAR-201" };
  }
  async getTicket() { return { ...this.state, projectName: this.projectName }; }
  async resolveIssue(id: string) { return { id, projectName: this.projectName }; }
  async setStateByName(id: string, state: string) { this.moved.push({ id, state }); }
  async commentByIssueId(id: string, body: string) { this.comments.push({ id, body }); }
}

function deps(options: {
  store?: FakeStore;
  linear?: McpLinearClient;
  linearForCalls?: string[];
  allowEnqueue?: boolean;
  breaker?: BreakerSnapshot;
  projects?: Record<string, ProjectConfig>;
} = {}): FactoryToolDependencies {
  return {
    store: options.store ?? new FakeStore(),
    projects: options.projects ?? { harness: project },
    linearFor: (projectKey) => {
      options.linearForCalls?.push(projectKey);
      return options.linear;
    },
    breaker: async () => options.breaker ?? {
      open: false,
      cooldownMinutes: 360,
      cooldownRemainingMinutes: 0,
    },
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    allowEnqueue: options.allowEnqueue ?? false,
  };
}

test("ticket_comment odrzuca komendy i przepuszcza slash wewnątrz komentarza", async () => {
  const linear = new FakeLinear();
  const tools = createFactoryTools(deps({ linear }));
  for (const body of ["/approve", "/`approve`", "/approve.", "/fix zrób X"]) {
    await assert.rejects(
      tools.ticketComment({ project: "harness", ticket: "BAR-200", body }),
      /decyzje i komendy bramkowe należą wyłącznie do człowieka/
    );
  }
  assert.equal(linear.comments.length, 0);

  await tools.ticketComment({
    project: "harness",
    ticket: "BAR-200",
    body: "patrz src/x.ts",
  });
  assert.deepEqual(linear.comments, [{ id: "BAR-200", body: "patrz src/x.ts" }]);
});

test("ticket_comment rozstrzyga projekt raz i komentuje po wewnętrznym issue id", async () => {
  const originalFetch = globalThis.fetch;
  const requests: {
    query: string;
    variables?: { id?: string; input?: { issueId?: string; body?: string } };
  }[] = [];
  globalThis.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: { id?: string; input?: { issueId?: string; body?: string } };
    };
    requests.push(request);
    if (request.query.includes("commentCreate")) {
      return new Response(JSON.stringify({
        data: { commentCreate: { success: true } },
      }));
    }
    return new Response(JSON.stringify({
      data: {
        issue: {
          id: "issue-id",
          project: { name: "harness" },
        },
      },
    }));
  }) as typeof fetch;
  try {
    const linear = new LinearSource("test-key", "harness");
    await createFactoryTools(deps({ linear })).ticketComment({
      project: "harness",
      ticket: "BAR-200",
      body: "Komentarz asystenta",
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].variables?.id, "BAR-200");
    assert.match(requests[0].query, /issue\(id: \$id\) \{ id project \{ name \} \}/);
    assert.doesNotMatch(requests[0].query, /team|state|labels/);
    assert.equal(requests[1].variables?.input?.issueId, "issue-id");
    assert.equal(
      requests[1].variables?.input?.body,
      "Komentarz asystenta\n\n> 🖋️ ai-factory · mcp · — · orchestrator"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("nieznany projekt i klucze prototypu są fail-closed we wszystkich zapisach", async () => {
  const projectKeys = [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
    "nieznany",
  ];
  const linear = new FakeLinear();
  const linearForCalls: string[] = [];
  const tools = createFactoryTools(deps({ linear, linearForCalls, allowEnqueue: true }));

  for (const projectKey of projectKeys) {
    const expected = new RegExp(`Nieznany projekt "${projectKey}" w konfiguracji fabryki`);
    await assert.rejects(
      tools.ticketCreate({ project: projectKey, title: "Nie twórz" }),
      expected
    );
    await assert.rejects(
      tools.ticketEnqueue({ project: projectKey, ticket: "BAR-200" }),
      expected
    );
    await assert.rejects(
      tools.ticketComment({ project: projectKey, ticket: "BAR-200", body: "Nie komentuj" }),
      expected
    );
  }

  assert.deepEqual(linearForCalls, []);
  assert.deepEqual(linear.creates, []);
  assert.deepEqual(linear.moved, []);
  assert.deepEqual(linear.comments, []);
});

test("ticket_enqueue jest fail-closed bez flagi i przenosi wyłącznie backlog do Todo", async () => {
  const linear = new FakeLinear();
  await assert.rejects(
    createFactoryTools(deps({ linear })).ticketEnqueue({ project: "harness", ticket: "BAR-200" }),
    /FACTORY_MCP_ALLOW_ENQUEUE=on/
  );
  assert.deepEqual(linear.moved, []);

  const result = await createFactoryTools(deps({ linear, allowEnqueue: true }))
    .ticketEnqueue({ project: "harness", ticket: "BAR-200" });
  assert.equal(result.to, "Todo");
  assert.deepEqual(linear.moved, [{ id: "BAR-200", state: "Todo" }]);

  linear.state = { stateName: "In Progress", stateType: "started" };
  await assert.rejects(
    createFactoryTools(deps({ linear, allowEnqueue: true }))
      .ticketEnqueue({ project: "harness", ticket: "BAR-200" }),
    /Backlog → Todo/
  );
});

test("zapisy odrzucają ticket z obcego projektu", async () => {
  const linear = new FakeLinear();
  const tools = createFactoryTools(deps({ linear, allowEnqueue: true }));

  linear.projectName = "other";
  await assert.rejects(
    tools.ticketEnqueue({ project: "harness", ticket: "BAR-200" }),
    /oczekiwany projekt "harness".*faktyczny projekt w Linearze: "other"/
  );
  await assert.rejects(
    tools.ticketComment({ project: "harness", ticket: "BAR-200", body: "Komentarz" }),
    /oczekiwany projekt "harness".*faktyczny projekt w Linearze: "other"/
  );
  assert.deepEqual(linear.moved, []);
  assert.deepEqual(linear.comments, []);

  linear.projectName = null;
  await assert.rejects(
    tools.ticketEnqueue({ project: "harness", ticket: "BAR-200" }),
    /oczekiwany projekt "harness".*faktyczny projekt w Linearze: brak projektu/
  );
  await assert.rejects(
    tools.ticketComment({ project: "harness", ticket: "BAR-200", body: "Komentarz" }),
    /oczekiwany projekt "harness".*faktyczny projekt w Linearze: brak projektu/
  );
  assert.deepEqual(linear.moved, []);
  assert.deepEqual(linear.comments, []);
});

test("brak LINEAR_API_KEY blokuje tylko zapisy, nie projekcje odczytu", async () => {
  const store = new FakeStore();
  store.runs.set("BAR-200", run());
  const tools = createFactoryTools(deps({ store }));
  assert.equal((await tools.ticketStatus({ ticket: "BAR-200" })).found, true);
  await assert.rejects(
    tools.ticketCreate({ project: "harness", title: "Nowy ticket" }),
    /Brak LINEAR_API_KEY/
  );
});

test("jawnie pusty LINEAR_API_KEY nie jest uzupełniany z .env", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-mcp-env-"));
  const path = join(root, ".env");
  const previousKey = process.env.LINEAR_API_KEY;
  const previousMarker = process.env.FACTORY_MCP_ENV_MARKER;
  try {
    await writeFile(path, [
      "LINEAR_API_KEY=wartosc-z-pliku",
      "FACTORY_MCP_ENV_MARKER=uzupelnione",
    ].join("\n"));
    process.env.LINEAR_API_KEY = "";
    delete process.env.FACTORY_MCP_ENV_MARKER;

    loadDotEnv(path);

    assert.equal(process.env.LINEAR_API_KEY, "");
    assert.equal(process.env.FACTORY_MCP_ENV_MARKER, "uzupelnione");
    const store = new FakeStore();
    store.runs.set("BAR-200", run());
    const tools = createFactoryTools(deps({ store }));
    assert.equal((await tools.ticketStatus({ ticket: "BAR-200" })).found, true);
    await assert.rejects(
      tools.ticketCreate({ project: "harness", title: "Nie zapisuj" }),
      /Brak LINEAR_API_KEY/
    );
  } finally {
    if (previousKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = previousKey;
    if (previousMarker === undefined) delete process.env.FACTORY_MCP_ENV_MARKER;
    else process.env.FACTORY_MCP_ENV_MARKER = previousMarker;
    await rm(root, { recursive: true, force: true });
  }
});

test("ticket_status zwraca jawny brak runu zamiast wyjątku", async () => {
  const result = await createFactoryTools(deps()).ticketStatus({ ticket: "BAR-404" });
  assert.deepEqual(result, {
    found: false,
    ticket: "BAR-404",
    message: "Brak runu fabryki dla ticketu BAR-404",
  });
});

test("LINEAR_PROJECTS ukrywa runy obcych projektów we wszystkich projekcjach", async () => {
  const store = new FakeStore();
  store.runs.set("BAR-200", run());
  const hiddenRun = run({
    ticketId: "OTHER-5",
    project: "other",
    plan: "tajny-plan-obcego-projektu",
  });
  hiddenRun.manifest.title = "tajny-tytuł-obcego-projektu";
  store.runs.set("OTHER-5", hiddenRun);
  store.attempts.set("OTHER-5", [{
    ticketId: "OTHER-5",
    stage: "build",
    attempt: 1,
    status: "failed",
    report: "tajny-raport-obcego-projektu",
    startedAt: "2026-08-10T10:00:00.000Z",
  }]);
  const tools = createFactoryTools(deps({ store }));

  const overview = await tools.queueOverview();
  assert.deepEqual(overview.runs.map((item) => item.ticket), ["BAR-200"]);
  assert.equal((await tools.factoryHealth()).activeRuns, 1);

  const expectedHidden = {
    found: false,
    ticket: "OTHER-5",
    message: "Brak runu fabryki dla ticketu OTHER-5",
  };
  assert.deepEqual(await tools.ticketStatus({ ticket: "OTHER-5" }), expectedHidden);
  assert.deepEqual(await tools.ticketPlan({ ticket: "OTHER-5" }), expectedHidden);
  assert.deepEqual(
    await tools.ticketAttempts({ ticket: "OTHER-5", includeReportTail: true }),
    expectedHidden
  );

  const output = JSON.stringify([
    overview,
    await tools.ticketStatus({ ticket: "OTHER-5" }),
    await tools.ticketPlan({ ticket: "OTHER-5" }),
    await tools.ticketAttempts({ ticket: "OTHER-5", includeReportTail: true }),
  ]);
  assert.doesNotMatch(output, /tajny-(tytuł|plan|raport)-obcego-projektu/);
});

test("factory_health liczy koszt tylko widocznych projektów", async () => {
  const store = new FakeStore();
  store.runs.set("BAR-200", run());
  store.runs.set("SECRET-1", run({ ticketId: "SECRET-1", project: "secret" }));
  store.attempts.set("BAR-200", [{
    ticketId: "BAR-200",
    stage: "build",
    attempt: 1,
    status: "success",
    costUsd: 1.25,
    startedAt: "2026-08-10T11:15:00.000Z",
    finishedAt: "2026-08-10T11:30:00.000Z",
  }]);
  store.attempts.set("SECRET-1", [{
    ticketId: "SECRET-1",
    stage: "build",
    attempt: 1,
    status: "success",
    costUsd: 9,
    startedAt: "2026-08-10T11:15:00.000Z",
    finishedAt: "2026-08-10T11:30:00.000Z",
  }]);

  const health = await createFactoryTools(deps({ store })).factoryHealth();
  assert.equal(health.costUsdLastHour, 1.25);
  assert.equal(health.activeRuns, 1);
});

test("openGate odwzorowuje approval, advisory-fix, blocked i done", () => {
  assert.deepEqual(openGate(run()), {
    gate: "plan-approval",
    waitingOn: "human",
    humanCommands: ["/approve", "/reject <powód>"],
  });
  assert.deepEqual(openGate(run({
    stage: "merge",
    reviewStatus: "advisory-fix",
    fixRound: 1,
  })), {
    gate: "merge",
    waitingOn: "human",
    humanCommands: ["/fix [wskazówki]", "/replan <powód>", "/score 1-5"],
  });
  assert.deepEqual(openGate(run({
    stage: "build",
    status: "blocked",
    errorCode: "SCOPE_BLOCKED",
  })), {
    gate: "blocked",
    waitingOn: "human",
    humanCommands: ["/retry", "/replan <powód>", "/scope <ścieżka>"],
  });
  assert.deepEqual(openGate(run({ stage: "smoke", status: "done" })), {
    gate: "score",
    waitingOn: "human",
    humanCommands: ["/score 1-5 [komentarz]"],
  });
  assert.deepEqual(openGate(run({ stage: "smoke", status: "done", score: 5 })), {
    gate: null,
    waitingOn: "factory",
    humanCommands: [],
  });
  assert.deepEqual(openGate(run({
    stage: "merge",
    status: "waiting_human",
    mergedSha: "a".repeat(40),
  })), {
    gate: "score",
    waitingOn: "human",
    humanCommands: ["/score 1-5"],
  });
  assert.deepEqual(openGate(run({
    stage: "merge",
    status: "waiting_human",
    mergedSha: "a".repeat(40),
    score: 4,
  })), {
    gate: null,
    waitingOn: "human",
    humanCommands: [],
  });

  const scoredHint = unknownCommandHint({
    firstToken: "/scroe",
    stage: "merge",
    status: "waiting_human",
    mergedSha: "a".repeat(40),
    score: 4,
  });
  assert.match(scoredHint, /Żadna komenda decyzyjna nie jest teraz otwarta/);
  assert.doesNotMatch(scoredHint, /\/score/);
});

test("fallbacki budżetu są walidowane i wspólne dla projektów oraz statusu", async () => {
  const previousMinutes = process.env.FACTORY_BUDGET_MAX_MIN;
  const previousUsd = process.env.FACTORY_BUDGET_MAX_USD;
  const noBudgetProject = { ...project };
  delete noBudgetProject.budget;
  const store = new FakeStore();
  store.runs.set("BAR-200", run());
  const tools = createFactoryTools(deps({
    store,
    projects: { harness: noBudgetProject },
  }));
  try {
    for (const invalid of ["abc", "0", "-1"]) {
      process.env.FACTORY_BUDGET_MAX_MIN = invalid;
      process.env.FACTORY_BUDGET_MAX_USD = invalid;
      const projects = await tools.factoryProjects();
      const status = await tools.ticketStatus({ ticket: "BAR-200" });
      assert.deepEqual(projects.projects[0]?.budget, { maxMinutes: 45, maxUsd: 3 });
      assert.equal(status.found, true);
      if (status.found) {
        assert.equal(status.budgetMaxMinutes, 45);
        assert.equal(status.budgetMaxUsd, 3);
      }
    }

    process.env.FACTORY_BUDGET_MAX_MIN = "60";
    process.env.FACTORY_BUDGET_MAX_USD = "5.5";
    const projects = await tools.factoryProjects();
    const status = await tools.ticketStatus({ ticket: "BAR-200" });
    assert.deepEqual(projects.projects[0]?.budget, { maxMinutes: 60, maxUsd: 5.5 });
    assert.equal(status.found, true);
    if (status.found) {
      assert.equal(status.budgetMaxMinutes, 60);
      assert.equal(status.budgetMaxUsd, 5.5);
    }
  } finally {
    if (previousMinutes === undefined) delete process.env.FACTORY_BUDGET_MAX_MIN;
    else process.env.FACTORY_BUDGET_MAX_MIN = previousMinutes;
    if (previousUsd === undefined) delete process.env.FACTORY_BUDGET_MAX_USD;
    else process.env.FACTORY_BUDGET_MAX_USD = previousUsd;
  }
});

test("plan i raporty mają jawną flagę truncated", () => {
  assert.deepEqual(clip("abcdef", 4), { text: "abc…", truncated: true });
  assert.deepEqual(clip("abc", 4), { text: "abc", truncated: false });
  const view = planView(run({
    plan: `## Podsumowanie dla człowieka\n${"S".repeat(2_100)}\n\n## Plan\n${"P".repeat(12_100)}`,
    critiqueReport: "C".repeat(4_100),
    briefs: { recon: "R".repeat(4_100) },
  }));
  assert.equal(view.plan?.truncated, true);
  assert.equal(view.humanSummary?.truncated, true);
  assert.equal(view.critiqueNotes?.truncated, true);
  assert.equal(view.researchBriefs.recon?.truncated, true);
});

test("factory_projects i factory_health nie ujawniają sekretu środowiska", async () => {
  const previous = process.env.LINEAR_API_KEY;
  const secret = "linear-secret-sentinel-BAR-200";
  process.env.LINEAR_API_KEY = secret;
  try {
    const store = new FakeStore();
    store.runs.set("BAR-200", run());
    store.lease = {
      pid: 123,
      hostname: "factory-host",
      heartbeatAt: "2026-08-10T11:59:30.000Z",
    };
    const tools = createFactoryTools(deps({ store, linear: new FakeLinear() }));
    const output = JSON.stringify([
      await tools.factoryProjects(),
      await tools.factoryHealth(),
    ]);
    assert.equal(output.includes(secret), false);
    assert.match(output, /factory-host/);
  } finally {
    if (previous === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = previous;
  }
});

test("snapshot breakera jest zgodny z breakerOpen, waliduje cooldown i nie mutuje stanu", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-mcp-breaker-"));
  const previousRoot = process.env.FACTORY_ROOT;
  const previousCooldown = process.env.FACTORY_CB_COOLDOWN_MIN;
  const path = join(root, "runs", "circuit-breaker.json");
  try {
    await writeFile(join(root, "package.json"), "{}");
    await mkdir(join(root, "runs"), { recursive: true });
    process.env.FACTORY_ROOT = root;
    process.env.FACTORY_CB_COOLDOWN_MIN = "10";

    const now = Date.now();
    const activeState = JSON.stringify({
      openedAt: new Date(now - 5 * 60_000).toISOString(),
      reason: "koszt $12.34/h > limit $10/h",
      failStreak: 3,
    });
    await writeFile(path, activeState);
    const active = await breakerSnapshot(now);
    assert.equal(active.open, true);
    assert.equal(active.reasonCode, "cost-per-hour");
    assert.equal(active.cooldownMinutes, 10);
    assert.equal(active.cooldownRemainingMinutes, 5);
    assert.equal(await readFile(path, "utf8"), activeState);
    assert.match(await breakerOpen() ?? "", /koszt \$12\.34\/h.*cooldown 10 min/);

    const health = await createFactoryTools({
      ...deps(),
      breaker: async () => breakerSnapshot(now),
    }).factoryHealth();
    const healthOutput = JSON.stringify(health.breaker);
    assert.equal(health.breaker.reasonCode, "cost-per-hour");
    assert.doesNotMatch(healthOutput, /\$|12\.34|limit/);

    await writeFile(path, JSON.stringify({
      openedAt: new Date(now - 5 * 60_000).toISOString(),
      reason: "3 nieudane runy z rzędu",
      failStreak: 3,
    }));
    assert.equal((await breakerSnapshot(now)).reasonCode, "blocked-streak");

    await writeFile(path, JSON.stringify({
      openedAt: new Date(now - 5 * 60_000).toISOString(),
      reason: "nierozpoznany powód",
      failStreak: 3,
    }));
    assert.equal((await breakerSnapshot(now)).reasonCode, "unknown");

    const expiredState = JSON.stringify({
      openedAt: new Date(now - 20 * 60_000).toISOString(),
      reason: "test wygasłego breakera",
      failStreak: 3,
    });
    await writeFile(path, expiredState);
    const expired = await breakerSnapshot(now);
    assert.equal(expired.open, false);
    assert.equal(expired.cooldownRemainingMinutes, 0);
    assert.equal(await readFile(path, "utf8"), expiredState);
    assert.equal(await breakerOpen(), null);
    assert.notEqual(await readFile(path, "utf8"), expiredState);

    process.env.FACTORY_CB_COOLDOWN_MIN = "nie-liczba";
    await writeFile(path, activeState);
    const fallback = await breakerSnapshot(now);
    assert.equal(fallback.cooldownMinutes, 360);
    assert.equal(fallback.open, true);
    assert.match(await breakerOpen() ?? "", /cooldown 360 min/);
  } finally {
    if (previousRoot === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previousRoot;
    if (previousCooldown === undefined) delete process.env.FACTORY_CB_COOLDOWN_MIN;
    else process.env.FACTORY_CB_COOLDOWN_MIN = previousCooldown;
    await rm(root, { recursive: true, force: true });
  }
});

test("ticket_create deleguje utworzenie issue w backlogu", async () => {
  const linear = new FakeLinear();
  const result = await createFactoryTools(deps({ linear })).ticketCreate({
    project: "harness",
    title: "Nowy ticket",
    description: "Opis",
    labels: ["bug"],
  });
  assert.equal(result.stateType, "backlog");
  assert.deepEqual(linear.creates, [{ title: "Nowy ticket", description: "Opis", labels: ["bug"] }]);
});

test("LinearSource.resolveIssue zwraca czytelny błąd dla nieistniejącego issue", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: { issue: null },
  }))) as typeof fetch;
  try {
    await assert.rejects(
      new LinearSource("test-key", "harness").resolveIssue("BAR-NIE-MA"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Linear nie zna issue "BAR-NIE-MA"/);
        assert.doesNotMatch(error.message, /TypeError/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LinearSource.createIssue wybiera stan typu backlog i mapuje wszystkie labele", async () => {
  const originalFetch = globalThis.fetch;
  let createInput: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: { input?: Record<string, unknown> };
    };
    if (request.query.includes("issueCreate")) {
      createInput = request.variables?.input;
      return new Response(JSON.stringify({
        data: {
          issueCreate: {
            success: true,
            issue: { identifier: "BAR-201", url: "https://linear.app/acme/issue/BAR-201" },
          },
        },
      }));
    }
    return new Response(JSON.stringify({
      data: {
        projects: {
          nodes: [{
            id: "project-id",
            name: "harness",
            teams: {
              nodes: [{
                id: "team-id",
                name: "BAR",
                states: { nodes: [
                  { id: "todo-id", name: "Todo", type: "unstarted" },
                  { id: "backlog-id", name: "Backlog", type: "backlog" },
                ] },
                labels: { nodes: [{ id: "bug-id", name: "bug" }] },
              }],
            },
          }],
        },
      },
    }));
  }) as typeof fetch;
  try {
    const issue = await new LinearSource("test-key", "harness").createIssue({
      title: "Nowy ticket",
      labels: ["bug"],
    });
    assert.equal(issue.identifier, "BAR-201");
    assert.equal(createInput?.stateId, "backlog-id");
    assert.notEqual(createInput?.stateId, "todo-id");
    assert.deepEqual(createInput?.labelIds, ["bug-id"]);

    await assert.rejects(
      new LinearSource("test-key", "harness").createIssue({
        title: "Nieznany label",
        labels: ["missing"],
      }),
      /Nieznane labele/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LinearSource odrzuca success:false i null we wszystkich objętych mutacjach", async () => {
  const originalFetch = globalThis.fetch;
  const mutationResponses = [
    { issueUpdate: { success: false } },
    { issueUpdate: null },
    { commentCreate: { success: false } },
    { commentCreate: null },
    { issueUpdate: { success: false } },
    { issueUpdate: null },
    { issueUpdate: { success: false } },
    { issueUpdate: null },
  ];
  globalThis.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { query: string };
    if (request.query.includes("query($id: String!)")) {
      return new Response(JSON.stringify({
        data: {
          issue: {
            id: "issue-id",
            identifier: "BAR-200",
            title: "MCP dla fabryki",
            description: "",
            url: "https://linear.app/acme/issue/BAR-200",
            priorityLabel: null,
            labels: { nodes: [] },
            project: { id: "project-id", name: "harness" },
            state: { id: "backlog-id", name: "Backlog", type: "backlog" },
            team: { states: { nodes: [
              { id: "todo-id", name: "Todo", type: "unstarted" },
              { id: "progress-id", name: "In Progress", type: "started" },
              { id: "done-id", name: "Done", type: "completed" },
            ] } },
          },
        },
      }));
    }
    return new Response(JSON.stringify({ data: mutationResponses.shift() }));
  }) as typeof fetch;
  try {
    const linear = new LinearSource("test-key", "harness");
    await assert.rejects(linear.setStateByName("BAR-200", "Todo"), /nie potwierdził zapisu/);
    await assert.rejects(linear.setStateByName("BAR-200", "Todo"), /nie potwierdził zapisu/);
    await assert.rejects(linear.comment("BAR-200", "Komentarz"), /nie potwierdził zapisu/);
    await assert.rejects(linear.comment("BAR-200", "Komentarz"), /nie potwierdził zapisu/);
    await assert.rejects(linear.claim("BAR-200"), /nie potwierdził zapisu/);
    await assert.rejects(linear.claim("BAR-200"), /nie potwierdził zapisu/);
    await assert.rejects(linear.setStatus("BAR-200", "done"), /nie potwierdził zapisu/);
    await assert.rejects(linear.setStatus("BAR-200", "done"), /nie potwierdził zapisu/);
    assert.equal(mutationResponses.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
