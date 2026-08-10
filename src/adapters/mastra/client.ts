export interface MastraRunSnapshot {
  status?: string;
  snapshot?: { status?: string };
  suspended?: unknown;
  result?: unknown;
  [key: string]: unknown;
}

export interface WorkflowControlClient {
  serverUp(): Promise<boolean>;
  createRun(requestedRunId?: string): Promise<string>;
  startRun(runId: string, inputData: Record<string, unknown>): Promise<void>;
  resumeRun(runId: string, step: string | string[], resumeData: Record<string, unknown>): Promise<void>;
  getRun(runId: string): Promise<MastraRunSnapshot>;
  cancelRun(runId: string): Promise<void>;
}

export class MastraHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly responseBody: string
  ) {
    super(`Mastra HTTP ${status} ${path}: ${responseBody.slice(0, 1000)}`);
    this.name = "MastraHttpError";
  }
}

export function isWorkflowRunMissing(error: unknown): error is MastraHttpError {
  return error instanceof MastraHttpError &&
    error.status === 404 &&
    /\/runs\//.test(error.path);
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
    if (!res.ok) throw new MastraHttpError(res.status, path, text);
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

  async createRun(requestedRunId?: string): Promise<string> {
    const suffix = requestedRunId ? `?runId=${encodeURIComponent(requestedRunId)}` : "";
    const data = await this.request(`/workflows/${this.workflow}/create-run${suffix}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }) as { runId?: string };
    if (!data?.runId) throw new Error("Mastra create-run nie zwróciła runId");
    if (requestedRunId && data.runId !== requestedRunId) {
      throw new Error(`Mastra nie zachowała żądanego runId: ${requestedRunId} != ${data.runId}`);
    }
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
