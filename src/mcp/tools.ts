import type { ProjectConfig } from "../config/projects";
import { isCommandAttempt, parseCommand } from "../lifecycle/commands";
import { LINEAR_STATE_MAP } from "../lifecycle/state-map";
import type { LifecycleRun, LifecycleStore, StageAttempt } from "../lifecycle/store";
import { attemptRow, planView, runSummary } from "./projection";

const DEFAULT_BUDGET_MAX_MINUTES = 45;
const DEFAULT_BUDGET_MAX_USD = 3;
const LEASE_STALE_MS = 90_000;

export interface McpLinearClient {
  createIssue(input: {
    title: string;
    description?: string;
    labels?: string[];
  }): Promise<{ identifier: string; url: string }>;
  getTicket(id: string): Promise<{
    stateName: string;
    stateType: string;
    projectName: string | null;
  }>;
  projectNameOf(id: string): Promise<string | null>;
  setStateByName(id: string, stateName: string): Promise<void>;
  comment(id: string, body: string): Promise<void>;
}

export interface BreakerSnapshot {
  open: boolean;
  reason?: string;
  openedAt?: string;
  cooldownMinutes: number;
  cooldownRemainingMinutes: number;
}

export type McpLifecycleReader = Pick<
  LifecycleStore,
  "getRun" | "listActive" | "listAttempts" | "readLease" | "totalUsage" | "usageSince"
>;

export interface FactoryToolDependencies {
  store: McpLifecycleReader;
  projects: Record<string, ProjectConfig>;
  linearFor(project: string): McpLinearClient | undefined;
  breaker(): Promise<BreakerSnapshot>;
  now(): Date;
  allowEnqueue: boolean;
}

export interface TicketCreateInput {
  project: string;
  title: string;
  description?: string;
  labels?: string[];
}

export interface TicketInput {
  ticket: string;
}

export interface ProjectTicketInput extends TicketInput {
  project: string;
}

export interface TicketCommentInput extends ProjectTicketInput {
  body: string;
}

function assertProject(deps: FactoryToolDependencies, key: string): ProjectConfig {
  const project = deps.projects[key];
  if (!project) throw new Error(`Nieznany projekt "${key}" w konfiguracji fabryki`);
  return project;
}

export function assertWriteEnabled(client: McpLinearClient | undefined): McpLinearClient {
  if (!client) {
    throw new Error(
      "Brak LINEAR_API_KEY: narzędzia odczytu działają, ale zapisy do Lineara są wyłączone"
    );
  }
  return client;
}

export function assertNotCommand(body: string): void {
  if (parseCommand(body) || isCommandAttempt(body)) {
    throw new Error(
      "Komentarz odrzucony: decyzje i komendy bramkowe należą wyłącznie do człowieka w Linearze"
    );
  }
}

export function assertEnqueueAllowed(allowEnqueue: boolean): void {
  if (!allowEnqueue) {
    throw new Error(
      "ticket_enqueue jest wyłączone; ustaw FACTORY_MCP_ALLOW_ENQUEUE=on, aby jawnie oddawać tickety fabryce"
    );
  }
}

export function assertSameProject(
  expected: string,
  actual: string | null,
  ticket: string
): void {
  if (actual === null || actual !== expected) {
    const actualProject = actual === null ? "brak projektu" : `"${actual}"`;
    throw new Error(
      `Ticket ${ticket}: oczekiwany projekt "${expected}", ` +
        `faktyczny projekt w Linearze: ${actualProject}`
    );
  }
}

function projectUsage(
  store: McpLifecycleReader,
  run: LifecycleRun,
  project: ProjectConfig | undefined
) {
  const usage = store.totalUsage(run.ticketId);
  return {
    ...usage,
    budgetMaxMinutes: project?.budget?.maxMinutes ?? DEFAULT_BUDGET_MAX_MINUTES,
    budgetMaxUsd: project?.budget?.maxUsd ?? DEFAULT_BUDGET_MAX_USD,
  };
}

function ageMinutes(updatedAt: string, now: Date): number | null {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.round(((now.getTime() - timestamp) / 60_000) * 10) / 10);
}

export function createFactoryTools(deps: FactoryToolDependencies) {
  return {
    async factoryProjects() {
      return {
        projects: Object.entries(deps.projects)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, project]) => ({
            key,
            repo: project.repo,
            github: project.github,
            planPipeline: project.planPipeline ?? "v2",
            budget: {
              maxMinutes: project.budget?.maxMinutes ?? DEFAULT_BUDGET_MAX_MINUTES,
              maxUsd: project.budget?.maxUsd ?? DEFAULT_BUDGET_MAX_USD,
            },
            maxConcurrentTickets: project.max_concurrent_tickets,
            statuses: project.statuses ?? "standard",
            progress: project.progress ?? "milestones",
          })),
      };
    },

    async factoryHealth() {
      const now = deps.now();
      const oneHourAgo = new Date(now.getTime() - 60 * 60_000).toISOString();
      const lease = deps.store.readLease();
      const heartbeatMs = lease ? Date.parse(lease.heartbeatAt) : Number.NaN;
      const leaseAgeMs = Number.isFinite(heartbeatMs) ? now.getTime() - heartbeatMs : Number.NaN;
      return {
        breaker: await deps.breaker(),
        lease: lease
          ? {
              pid: lease.pid,
              hostname: lease.hostname,
              heartbeatAt: lease.heartbeatAt,
              stale: !Number.isFinite(leaseAgeMs) || leaseAgeMs >= LEASE_STALE_MS,
              ageSeconds: Number.isFinite(leaseAgeMs)
                ? Math.max(0, Math.round(leaseAgeMs / 1_000))
                : null,
            }
          : null,
        activeRuns: deps.store.listActive().length,
        costUsdLastHour: deps.store.usageSince(oneHourAgo),
      };
    },

    async queueOverview() {
      const now = deps.now();
      return {
        runs: deps.store.listActive().map((run) => {
          const summary = runSummary(
            run,
            projectUsage(deps.store, run, deps.projects[run.project])
          );
          return {
            ticket: summary.ticket,
            title: summary.title,
            project: summary.project,
            stage: summary.stage,
            status: summary.status,
            waitingOn: summary.waitingOn,
            gate: summary.gate,
            ageMinutes: ageMinutes(summary.updatedAt, now),
          };
        }),
      };
    },

    async ticketStatus({ ticket }: TicketInput) {
      const run = deps.store.getRun(ticket);
      if (!run) {
        return {
          found: false,
          ticket,
          message: `Brak runu fabryki dla ticketu ${ticket}`,
        };
      }
      return {
        found: true,
        ...runSummary(run, projectUsage(deps.store, run, deps.projects[run.project])),
      };
    },

    async ticketPlan({ ticket }: TicketInput) {
      const run = deps.store.getRun(ticket);
      if (!run) {
        return {
          found: false,
          ticket,
          message: `Brak runu fabryki dla ticketu ${ticket}`,
        };
      }
      return { found: true, ...planView(run) };
    },

    async ticketAttempts(input: TicketInput & { includeReportTail?: boolean }) {
      const run = deps.store.getRun(input.ticket);
      if (!run) {
        return {
          found: false,
          ticket: input.ticket,
          message: `Brak runu fabryki dla ticketu ${input.ticket}`,
        };
      }
      const attempts: StageAttempt[] = deps.store.listAttempts(input.ticket);
      return {
        found: true,
        ticket: input.ticket,
        generation: run.generation,
        attempts: attempts.map((attempt) => attemptRow(attempt, input.includeReportTail ?? false)),
      };
    },

    async ticketCreate(input: TicketCreateInput) {
      assertProject(deps, input.project);
      const linear = assertWriteEnabled(deps.linearFor(input.project));
      const issue = await linear.createIssue({
        title: input.title,
        description: input.description,
        labels: input.labels,
      });
      return {
        created: true,
        project: input.project,
        stateType: "backlog",
        ...issue,
      };
    },

    async ticketEnqueue(input: ProjectTicketInput) {
      assertEnqueueAllowed(deps.allowEnqueue);
      assertProject(deps, input.project);
      const linear = assertWriteEnabled(deps.linearFor(input.project));
      const issue = await linear.getTicket(input.ticket);
      assertSameProject(input.project, issue.projectName, input.ticket);
      if (issue.stateType !== "backlog") {
        throw new Error(
          `Ticket ${input.ticket} nie jest w Backlogu (aktualny stan: ${issue.stateName}); ` +
          "dozwolone jest wyłącznie przejście Backlog → Todo"
        );
      }
      await linear.setStateByName(input.ticket, LINEAR_STATE_MAP.ready);
      return {
        enqueued: true,
        ticket: input.ticket,
        project: input.project,
        from: issue.stateName,
        to: LINEAR_STATE_MAP.ready,
      };
    },

    async ticketComment(input: TicketCommentInput) {
      assertNotCommand(input.body);
      assertProject(deps, input.project);
      const linear = assertWriteEnabled(deps.linearFor(input.project));
      const projectName = await linear.projectNameOf(input.ticket);
      assertSameProject(input.project, projectName, input.ticket);
      await linear.comment(input.ticket, input.body);
      return { commented: true, ticket: input.ticket, project: input.project };
    },
  };
}

export type FactoryTools = ReturnType<typeof createFactoryTools>;
