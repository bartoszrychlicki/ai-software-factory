import test from "node:test";
import assert from "node:assert/strict";
import { LinearSource } from "../src/adapters/linear/client";
import type { ProjectConfig } from "../src/config/projects";
import type { LifecycleRun, StageAttempt } from "../src/lifecycle/store";
import { clip, openGate, planView } from "../src/mcp/projection";
import {
  createFactoryTools,
  type BreakerSnapshot,
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
  usageSince() { return 1.25; }
}

class FakeLinear implements McpLinearClient {
  comments: { id: string; body: string }[] = [];
  state = { stateName: "Backlog", stateType: "backlog" };
  moved: { id: string; state: string }[] = [];
  creates: { title: string; description?: string; labels?: string[] }[] = [];

  async createIssue(input: { title: string; description?: string; labels?: string[] }) {
    this.creates.push(input);
    return { identifier: "BAR-201", url: "https://linear.app/acme/issue/BAR-201" };
  }
  async getTicket() { return this.state; }
  async setStateByName(id: string, state: string) { this.moved.push({ id, state }); }
  async comment(id: string, body: string) { this.comments.push({ id, body }); }
}

function deps(options: {
  store?: FakeStore;
  linear?: FakeLinear;
  allowEnqueue?: boolean;
  breaker?: BreakerSnapshot;
} = {}): FactoryToolDependencies {
  return {
    store: options.store ?? new FakeStore(),
    projects: { harness: project },
    linearFor: () => options.linear,
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

test("ticket_status zwraca jawny brak runu zamiast wyjątku", async () => {
  const result = await createFactoryTools(deps()).ticketStatus({ ticket: "BAR-404" });
  assert.deepEqual(result, {
    found: false,
    ticket: "BAR-404",
    message: "Brak runu fabryki dla ticketu BAR-404",
  });
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
