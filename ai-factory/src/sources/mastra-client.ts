import type { OutboxCommand } from "../pipeline/run-registry";
import * as registry from "../pipeline/run-registry";

export interface MastraRunSnapshot {
  status?: string;
  snapshot?: { status?: string };
  suspended?: unknown;
  result?: unknown;
  [key: string]: unknown;
}

export interface WorkflowControlClient {
  serverUp(): Promise<boolean>;
  createRun(): Promise<string>;
  startRun(runId: string, inputData: Record<string, unknown>): Promise<void>;
  resumeRun(runId: string, step: string | string[], resumeData: Record<string, unknown>): Promise<void>;
  getRun(runId: string): Promise<MastraRunSnapshot>;
  cancelRun(runId: string): Promise<void>;
}

/**
 * Wersjoodporny klient HTTP Mastry.
 *
 * Mastra 1.51 rozróżnia myląco nazwane endpointy:
 * - `start-async` i `resume-async` czekają na wynik całego workflow,
 * - `start` i `resume-no-wait` jedynie przyjmują komendę i od razu odpowiadają.
 * Poller używa wyłącznie drugiej pary i zawsze sprawdza status HTTP.
 */
export class MastraWorkflowClient implements WorkflowControlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly workflow: string,
    private readonly timeoutMs = 15_000
  ) {}

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Mastra HTTP ${res.status} ${path}: ${text.slice(0, 1000)}`);
    }
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Mastra zwróciła nie-JSON dla ${path}: ${text.slice(0, 300)}`);
    }
  }

  async serverUp(): Promise<boolean> {
    try {
      await this.request("/workflows");
      return true;
    } catch {
      return false;
    }
  }

  async createRun(): Promise<string> {
    const data = await this.request(`/workflows/${this.workflow}/create-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }) as { runId?: string };
    if (!data?.runId) throw new Error("Mastra create-run nie zwróciła runId");
    return data.runId;
  }

  async startRun(runId: string, inputData: Record<string, unknown>): Promise<void> {
    await this.request(`/workflows/${this.workflow}/start?runId=${encodeURIComponent(runId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputData }),
    });
  }

  async resumeRun(runId: string, step: string | string[], resumeData: Record<string, unknown>): Promise<void> {
    await this.request(`/workflows/${this.workflow}/resume-no-wait?runId=${encodeURIComponent(runId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, resumeData }),
    });
  }

  async getRun(runId: string): Promise<MastraRunSnapshot> {
    return await this.request(`/workflows/${this.workflow}/runs/${encodeURIComponent(runId)}`) as MastraRunSnapshot;
  }

  async cancelRun(runId: string): Promise<void> {
    await this.request(
      `/workflows/${this.workflow}/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST" }
    );
  }
}

export function runStatus(run: MastraRunSnapshot): string {
  return run.status ?? run.snapshot?.status ?? "unknown";
}

/** Odczytuje ścieżkę suspendu z publicznego kształtu API, także dla nested workflow. */
export function suspendedPath(run: MastraRunSnapshot): string[] | undefined {
  const candidates: unknown[] = [run.suspended, (run.snapshot as { suspended?: unknown } | undefined)?.suspended];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || !candidate.length) continue;
    const first = candidate[0];
    if (Array.isArray(first) && first.every((part) => typeof part === "string")) return first as string[];
    if (typeof first === "string") return [first];
  }
  return undefined;
}

const samePath = (a: string | string[] | undefined, b: string[] | undefined): boolean => {
  const left = Array.isArray(a) ? a : a ? [a] : [];
  return !!b && left.length === b.length && left.every((part, index) => part === b[index]);
};

/**
 * Flush trwałego outboxu. Komenda pozostaje `pending`, dopóki Mastra nie potwierdzi
 * jej przyjęcia odpowiedzią 2xx; kolejny tick lub restart pollera ponowi ją.
 */
export async function dispatchPendingOutbox(
  client: WorkflowControlClient,
  ticketId: string,
  seed: { project: string; runId: string }
): Promise<void> {
  for (const command of registry.pendingOutbox(ticketId)) {
    try {
      if (command.kind === "start") {
        await client.startRun(seed.runId, command.body);
      } else {
        if (!command.step) throw new Error(`Komenda ${command.id} resume nie ma ścieżki kroku`);
        await client.resumeRun(seed.runId, command.step, command.body);
      }
      registry.markOutboxAttempt(ticketId, seed, command.id, { dispatched: true });
      if (command.gate !== undefined && command.round !== undefined) {
        registry.markDecisionStep(ticketId, seed, command.gate, command.round, "resumeSentAt");
      }
    } catch (err) {
      registry.markOutboxAttempt(ticketId, seed, command.id, {
        dispatched: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Potwierdza wykonanie komendy zmianą snapshotu, nie samym faktem wywołania fetch. */
export function acknowledgeOutboxFromRun(
  ticketId: string,
  seed: { project: string; runId: string },
  run: MastraRunSnapshot
): void {
  const state = registry.readState(ticketId);
  if (!state) return;
  const status = runStatus(run);
  const currentPath = suspendedPath(run);
  for (const command of Object.values(state.outbox ?? {})) {
    if (command.state !== "dispatched") continue;
    const acknowledged = command.kind === "start"
      ? status !== "pending" && status !== "unknown"
      : status !== "suspended" || !samePath(command.step, currentPath);
    if (!acknowledged) continue;
    registry.acknowledgeOutbox(ticketId, seed, command.id);
    if (command.gate !== undefined && command.round !== undefined) {
      registry.markDecisionStep(ticketId, seed, command.gate, command.round, "resumeAckedAt");
    }
  }
}

export function outboxId(kind: OutboxCommand["kind"], suffix: string): string {
  return `${kind}:${suffix}`;
}
