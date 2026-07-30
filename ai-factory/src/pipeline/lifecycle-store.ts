import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findUpFile } from "./projects";

export type LifecycleStage =
  | "plan"
  | "triage"
  | "research"
  | "synthesis"
  | "critique"
  | "approval"
  | "build"
  | "test"
  | "publish"
  | "ci"
  | "review"
  | "merge"
  | "smoke";

/**
 * Klucz prób i komend. Research prowadzi trzy równoległe joby w jednym etapie
 * runu ("research"), ale próby są śledzone per rola — PK (ticket, stage,
 * attempt) wymusza osobne stage stringi, inaczej role nadpisywałyby sobie
 * próby.
 */
export type AttemptStage =
  | LifecycleStage
  | "research-recon"
  | "research-solution-a"
  | "research-solution-b";

export type LifecycleStatus =
  | "pending"
  | "running"
  | "waiting_human"
  | "waiting_external"
  | "blocked"
  | "done";

export type JobKind =
  | "plan"
  | "build"
  | "review"
  | "triage"
  | "research"
  | "synthesis"
  | "critique";

export type ResearchRole = "recon" | "solution-a" | "solution-b";

export const RESEARCH_ROLES: ResearchRole[] = ["recon", "solution-a", "solution-b"];

export function researchAttemptStage(role: ResearchRole): AttemptStage {
  return `research-${role}` as AttemptStage;
}

/** Etap runu odpowiadający stage'owi próby/komendy (role researchu → "research"). */
export function runStageOf(stage: AttemptStage): LifecycleStage {
  return stage.startsWith("research-") ? "research" : (stage as LifecycleStage);
}

export interface TicketManifestV2 {
  title: string;
  description: string;
  labels: string[];
  url?: string;
  inputHash: string;
  commentContext?: string;
}

export interface LifecycleRun {
  ticketId: string;
  project: string;
  generation: number;
  stage: LifecycleStage;
  status: LifecycleStatus;
  manifest: TicketManifestV2;
  plan?: string;
  planFiles: string[];
  planDomain?: string;
  clarifyRound: number;
  approvedAt?: string;
  branch?: string;
  workspaceDir?: string;
  headSha?: string;
  testedSha?: string;
  prUrl?: string;
  mergedSha?: string;
  reviewStatus?: "pending" | "running" | "lgtm" | "advisory-fix" | "unavailable";
  smokeStatus?: "pending" | "pass" | "fail" | "skipped-not-configured";
  blockedStage?: LifecycleStage;
  errorCode?: string;
  errorMessage?: string;
  feedback?: string;
  /** Wejście pipeline'u planowania: "triage" (v3 deep-plan) albo klasyczne "plan". */
  planEntry?: "plan" | "triage";
  /** Wariant procesu do eksperymentu kosztowego: solo (1 job planu) vs deep (research→synteza→krytyka). */
  planVariant?: "solo" | "deep";
  /** Krótka klasyfikacja triage (typ/rozmiar/ryzyko) — do komentarza bramki i eksperymentu. */
  triageSummary?: string;
  /** Briefy researchu (clipowane przy zapisie) — wejście syntezy, krytyki, buildera i reviewera. */
  briefs?: Partial<Record<ResearchRole, string>>;
  /** Liczba nieudanych prób per rola researchu (1 auto-retry, potem degradacja). */
  researchFailures?: Partial<Record<ResearchRole, number>>;
  /** Ile rewizji syntezy po krytyce już było (limit: 1). */
  critiqueRound: number;
  critiqueVerdict?: "ok" | "issues" | "unavailable";
  /** Treść uwag krytyka (clipowana) — sekcja komentarza bramki i kontekst reviewera. */
  critiqueReport?: string;
  /** Jawne noty degradacji (⚠️) pokazywane człowiekowi na bramce aprobat. */
  degradations?: string[];
  /** Ocena jakości od człowieka (/score 1-5) — cel badawczy eksperymentu. */
  score?: number;
  scoreComment?: string;
  scoredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type CommandKind =
  | "run-job"
  | "run-tests"
  | "linear-status"
  | "linear-comment"
  | "publish-pr"
  | "mark-pr-ready"
  | "comment-pr"
  | "cleanup-workspace";

export interface LifecycleCommand {
  key: string;
  ticketId: string;
  kind: CommandKind;
  stage: AttemptStage;
  payload: Record<string, unknown>;
  state: "pending" | "dispatched" | "done" | "failed";
  attempts: number;
  externalId?: string;
  lastError?: string;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface StageAttempt {
  ticketId: string;
  stage: AttemptStage;
  attempt: number;
  jobRunId?: string;
  inputHash?: string;
  sha?: string;
  status: "pending" | "running" | "success" | "failed" | "canceled";
  outcome?: string;
  report?: string;
  signature?: string;
  errorCode?: string;
  errorMessage?: string;
  costUsd?: number;
  /** Pochodzenie kosztu: reported | estimated-tokens | estimated-time. */
  costSource?: string;
  durationMs?: number;
  budgetMaxMinutes?: number;
  budgetMaxUsd?: number;
  budgetUsedMinutes?: number;
  budgetUsedUsd?: number;
  startedAt: string;
  finishedAt?: string;
}

export interface TransitionInput {
  stage: LifecycleStage;
  status: LifecycleStatus;
  actor: string;
  reason: string;
  /** Nowy input/świadomy replan tworzy nową generację kluczy idempotencji. */
  incrementGeneration?: boolean;
  patch?: Partial<Omit<LifecycleRun, "ticketId" | "project" | "generation" | "createdAt" | "updatedAt">>;
  command?: Omit<LifecycleCommand, "state" | "attempts" | "createdAt" | "updatedAt" | "availableAt"> & {
    availableAt?: string;
  };
  commands?: (Omit<LifecycleCommand, "state" | "attempts" | "createdAt" | "updatedAt" | "availableAt"> & {
    availableAt?: string;
  })[];
  /** Potwierdzenie joba i przejście lifecycle zapisują się w tej samej transakcji. */
  acknowledgeCommandKey?: string;
  cancelOutstandingRunJobs?: boolean;
}

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value ?? null);
const parseJson = <T>(value: unknown, fallback: T): T => {
  try {
    return value == null ? fallback : JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};

export function lifecycleDbPath(): string {
  return process.env.FACTORY_LIFECYCLE_DB ??
    join(dirname(findUpFile("package.json")), "runs", "lifecycle.db");
}

/**
 * Kanoniczny lifecycle store. Stan runu, transition i enqueue side effectu
 * zapisują się w jednej transakcji SQLite.
 */
export class LifecycleStore {
  private readonly db: DatabaseSync;

  constructor(path = lifecycleDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS lifecycle_runs (
        ticket_id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        generation INTEGER NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        plan TEXT,
        plan_files_json TEXT NOT NULL DEFAULT '[]',
        plan_domain TEXT,
        clarify_round INTEGER NOT NULL DEFAULT 0,
        approved_at TEXT,
        branch TEXT,
        workspace_dir TEXT,
        head_sha TEXT,
        tested_sha TEXT,
        pr_url TEXT,
        merged_sha TEXT,
        review_status TEXT,
        smoke_status TEXT,
        blocked_stage TEXT,
        error_code TEXT,
        error_message TEXT,
        feedback TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lifecycle_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        from_stage TEXT,
        from_status TEXT,
        to_stage TEXT NOT NULL,
        to_status TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(ticket_id) REFERENCES lifecycle_runs(ticket_id)
      );

      CREATE TABLE IF NOT EXISTS lifecycle_commands (
        idempotency_key TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        stage TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        external_id TEXT,
        last_error TEXT,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(ticket_id) REFERENCES lifecycle_runs(ticket_id)
      );

      CREATE INDEX IF NOT EXISTS lifecycle_commands_due
        ON lifecycle_commands(state, available_at);

      CREATE TABLE IF NOT EXISTS lifecycle_stage_attempts (
        ticket_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        job_run_id TEXT UNIQUE,
        input_hash TEXT,
        sha TEXT,
        status TEXT NOT NULL,
        outcome TEXT,
        report TEXT,
        signature TEXT,
        error_code TEXT,
        error_message TEXT,
        cost_usd REAL,
        duration_ms INTEGER,
        budget_max_minutes REAL,
        budget_max_usd REAL,
        budget_used_minutes REAL,
        budget_used_usd REAL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY(ticket_id, stage, attempt),
        FOREIGN KEY(ticket_id) REFERENCES lifecycle_runs(ticket_id)
      );

      CREATE TABLE IF NOT EXISTS lifecycle_processed_comments (
        comment_id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        command TEXT,
        processed_at TEXT NOT NULL,
        FOREIGN KEY(ticket_id) REFERENCES lifecycle_runs(ticket_id)
      );

      CREATE TABLE IF NOT EXISTS lifecycle_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pid INTEGER NOT NULL,
        hostname TEXT,
        heartbeat_at TEXT NOT NULL
      );
    `);
    const attemptColumns = this.db.prepare("PRAGMA table_info(lifecycle_stage_attempts)").all() as {
      name: string;
    }[];
    const attemptMigrations: Record<string, string> = {
      signature: "TEXT",
      input_hash: "TEXT",
      sha: "TEXT",
      error_code: "TEXT",
      error_message: "TEXT",
      cost_source: "TEXT",
      budget_max_minutes: "REAL",
      budget_max_usd: "REAL",
      budget_used_minutes: "REAL",
      budget_used_usd: "REAL",
    };
    for (const [column, type] of Object.entries(attemptMigrations)) {
      if (!attemptColumns.some((existing) => existing.name === column)) {
        this.db.exec(`ALTER TABLE lifecycle_stage_attempts ADD COLUMN ${column} ${type}`);
      }
    }
    // Deep-plan v3 + eksperyment kosztowy: kolumny addytywne na żywej bazie.
    const runColumns = this.db.prepare("PRAGMA table_info(lifecycle_runs)").all() as {
      name: string;
    }[];
    const runMigrations: Record<string, string> = {
      plan_entry: "TEXT",
      plan_variant: "TEXT",
      triage_summary: "TEXT",
      briefs_json: "TEXT",
      research_failures_json: "TEXT",
      critique_round: "INTEGER NOT NULL DEFAULT 0",
      critique_verdict: "TEXT",
      critique_report: "TEXT",
      degradations_json: "TEXT",
      score: "INTEGER",
      score_comment: "TEXT",
      scored_at: "TEXT",
    };
    for (const [column, type] of Object.entries(runMigrations)) {
      if (!runColumns.some((existing) => existing.name === column)) {
        this.db.exec(`ALTER TABLE lifecycle_runs ADD COLUMN ${column} ${type}`);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createRun(ticketId: string, project: string, manifest: TicketManifestV2): LifecycleRun {
    return this.transaction(() => {
      const previous = this.getRun(ticketId);
      const timestamp = now();
      const generation = (previous?.generation ?? 0) + 1;
      const run: LifecycleRun = {
        ticketId,
        project,
        generation,
        stage: "plan",
        status: "pending",
        manifest,
        planFiles: [],
        clarifyRound: 0,
        critiqueRound: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.db.prepare(`
        INSERT INTO lifecycle_runs (
          ticket_id, project, generation, stage, status, manifest_json,
          plan_files_json, clarify_round, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '[]', 0, ?, ?)
        ON CONFLICT(ticket_id) DO UPDATE SET
          project=excluded.project,
          generation=excluded.generation,
          stage=excluded.stage,
          status=excluded.status,
          manifest_json=excluded.manifest_json,
          plan=NULL,
          plan_files_json='[]',
          plan_domain=NULL,
          clarify_round=0,
          approved_at=NULL,
          branch=NULL,
          workspace_dir=NULL,
          head_sha=NULL,
          tested_sha=NULL,
          pr_url=NULL,
          merged_sha=NULL,
          review_status=NULL,
          smoke_status=NULL,
          blocked_stage=NULL,
          error_code=NULL,
          error_message=NULL,
          feedback=NULL,
          plan_entry=NULL,
          plan_variant=NULL,
          triage_summary=NULL,
          briefs_json=NULL,
          research_failures_json=NULL,
          critique_round=0,
          critique_verdict=NULL,
          critique_report=NULL,
          degradations_json=NULL,
          score=NULL,
          score_comment=NULL,
          scored_at=NULL,
          created_at=excluded.created_at,
          updated_at=excluded.updated_at
      `).run(ticketId, project, generation, "plan", "pending", json(manifest), timestamp, timestamp);
      this.db.prepare(`
        INSERT INTO lifecycle_transitions (
          ticket_id, generation, from_stage, from_status, to_stage, to_status, actor, reason, created_at
        ) VALUES (?, ?, NULL, NULL, 'plan', 'pending', 'coordinator', 'claim', ?)
      `).run(ticketId, generation, timestamp);
      return run;
    });
  }

  getRun(ticketId: string): LifecycleRun | undefined {
    const row = this.db.prepare("SELECT * FROM lifecycle_runs WHERE ticket_id = ?").get(ticketId) as
      Record<string, unknown> | undefined;
    return row ? this.hydrateRun(row) : undefined;
  }

  listActive(): LifecycleRun[] {
    return (this.db.prepare(`
      SELECT * FROM lifecycle_runs
      WHERE (status <> 'done' OR (pr_url IS NOT NULL AND merged_sha IS NULL))
        AND (error_code IS NULL OR error_code <> 'CANCELED')
      ORDER BY updated_at
    `).all() as Record<string, unknown>[]).map((row) => this.hydrateRun(row));
  }

  listPrCandidates(): LifecycleRun[] {
    return (this.db.prepare(`
      SELECT * FROM lifecycle_runs
      WHERE pr_url IS NOT NULL AND merged_sha IS NULL
      ORDER BY updated_at
    `).all() as Record<string, unknown>[]).map((row) => this.hydrateRun(row));
  }

  transition(ticketId: string, input: TransitionInput): LifecycleRun {
    return this.transaction(() => {
      const current = this.getRun(ticketId);
      if (!current) throw new Error(`Brak lifecycle run dla ${ticketId}`);
      const timestamp = now();
      const next: LifecycleRun = {
        ...current,
        ...input.patch,
        generation: current.generation + (input.incrementGeneration ? 1 : 0),
        stage: input.stage,
        status: input.status,
        updatedAt: timestamp,
      };
      this.writeRun(next);
      this.db.prepare(`
        INSERT INTO lifecycle_transitions (
          ticket_id, generation, from_stage, from_status, to_stage, to_status, actor, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ticketId,
        next.generation,
        current.stage,
        current.status,
        next.stage,
        next.status,
        input.actor,
        input.reason,
        timestamp
      );
      // Cancel MUSI iść PRZED insertem nowych komend: replan/input-changed
      // anuluje joby POPRZEDNIEJ generacji i w tej samej decyzji enqueue'uje
      // joba nowej. W odwrotnej kolejności UPDATE 'canceled-by-replan' zjadał
      // świeżo dodaną komendę i run rodził się jako zombie
      // (incydent BAR-180 g2, JOB_MISSING sekundę po /replan).
      if (input.cancelOutstandingRunJobs) {
        this.db.prepare(`
          UPDATE lifecycle_commands
          SET state='done', last_error='canceled-by-replan', updated_at=?
          WHERE ticket_id=? AND kind IN ('run-job', 'run-tests') AND state IN ('pending', 'dispatched')
        `).run(timestamp, ticketId);
        this.db.prepare(`
          UPDATE lifecycle_stage_attempts
          SET status='canceled', outcome='canceled-by-replan', finished_at=?
          WHERE ticket_id=? AND status IN ('pending', 'running')
        `).run(timestamp, ticketId);
      }
      if (input.command) this.insertCommand(input.command, timestamp);
      for (const command of input.commands ?? []) this.insertCommand(command, timestamp);
      if (input.acknowledgeCommandKey) {
        this.db.prepare(`
          UPDATE lifecycle_commands
          SET state='done', last_error=NULL, updated_at=?
          WHERE idempotency_key=?
        `).run(timestamp, input.acknowledgeCommandKey);
      }
      return next;
    });
  }

  enqueue(command: Omit<LifecycleCommand, "state" | "attempts" | "createdAt" | "updatedAt" | "availableAt"> & {
    availableAt?: string;
  }): void {
    this.transaction(() => this.insertCommand(command, now()));
  }

  pendingCommands(limit = 25): LifecycleCommand[] {
    return (this.db.prepare(`
      SELECT * FROM lifecycle_commands
      WHERE state = 'pending' AND available_at <= ?
      ORDER BY created_at, rowid
      LIMIT ?
    `).all(now(), limit) as Record<string, unknown>[]).map((row) => this.hydrateCommand(row));
  }

  outstandingCommands(limit = 50): LifecycleCommand[] {
    return (this.db.prepare(`
      SELECT * FROM lifecycle_commands
      WHERE state IN ('pending', 'dispatched') AND available_at <= ?
      ORDER BY created_at, rowid
      LIMIT ?
    `).all(now(), limit) as Record<string, unknown>[]).map((row) => this.hydrateCommand(row));
  }

  /**
   * Czy ticket ma jakikolwiek niedokończony job (run-job/run-tests)?
   * CELOWO bez filtra available_at — build odsunięty serializacją planFiles
   * to nadal żywy job, nie zombie.
   */
  hasOutstandingJob(ticketId: string): boolean {
    return !!this.db.prepare(`
      SELECT 1 FROM lifecycle_commands
      WHERE ticket_id=? AND kind IN ('run-job', 'run-tests') AND state IN ('pending', 'dispatched')
      LIMIT 1
    `).get(ticketId);
  }

  /**
   * Odsuwa dostępność komendy bez zużywania budżetu prób (markCommand
   * inkrementuje attempts) — używane przy serializacji kolizji plikowych.
   */
  deferCommand(key: string, availableAt: string): void {
    this.db.prepare(`
      UPDATE lifecycle_commands SET available_at=?, updated_at=?
      WHERE idempotency_key=? AND state='pending'
    `).run(availableAt, now(), key);
  }

  getCommand(key: string): LifecycleCommand | undefined {
    const row = this.db.prepare(
      "SELECT * FROM lifecycle_commands WHERE idempotency_key = ?"
    ).get(key) as Record<string, unknown> | undefined;
    return row ? this.hydrateCommand(row) : undefined;
  }

  markCommand(
    key: string,
    state: LifecycleCommand["state"],
    options: { externalId?: string; error?: string; retryAt?: string } = {}
  ): void {
    const retry = state === "pending";
    this.db.prepare(`
      UPDATE lifecycle_commands
      SET state = ?,
          attempts = attempts + 1,
          external_id = COALESCE(?, external_id),
          last_error = ?,
          available_at = ?,
          updated_at = ?
      WHERE idempotency_key = ?
    `).run(
      state,
      options.externalId ?? null,
      options.error ?? null,
      options.retryAt ?? now(),
      now(),
      key
    );
    if (!retry && state !== "failed") return;
  }

  startAttempt(
    ticketId: string,
    stage: AttemptStage,
    attempt: number,
    jobRunId: string,
    details: Pick<
      StageAttempt,
      | "inputHash"
      | "sha"
      | "budgetMaxMinutes"
      | "budgetMaxUsd"
      | "budgetUsedMinutes"
      | "budgetUsedUsd"
    > = {}
  ): StageAttempt {
    const startedAt = now();
    this.db.prepare(`
      INSERT INTO lifecycle_stage_attempts (
        ticket_id, stage, attempt, job_run_id, input_hash, sha, status,
        budget_max_minutes, budget_max_usd, budget_used_minutes, budget_used_usd,
        started_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
      ON CONFLICT(ticket_id, stage, attempt) DO UPDATE SET
        job_run_id=excluded.job_run_id,
        input_hash=excluded.input_hash,
        sha=excluded.sha,
        status='running',
        budget_max_minutes=excluded.budget_max_minutes,
        budget_max_usd=excluded.budget_max_usd,
        budget_used_minutes=excluded.budget_used_minutes,
        budget_used_usd=excluded.budget_used_usd,
        started_at=excluded.started_at,
        finished_at=NULL
    `).run(
      ticketId,
      stage,
      attempt,
      jobRunId,
      details.inputHash ?? null,
      details.sha ?? null,
      details.budgetMaxMinutes ?? null,
      details.budgetMaxUsd ?? null,
      details.budgetUsedMinutes ?? null,
      details.budgetUsedUsd ?? null,
      startedAt
    );
    return {
      ticketId,
      stage,
      attempt,
      jobRunId,
      ...details,
      status: "running",
      startedAt,
    };
  }

  finishAttempt(
    ticketId: string,
    stage: AttemptStage,
    attempt: number,
    result: Pick<
      StageAttempt,
      | "status"
      | "outcome"
      | "report"
      | "signature"
      | "sha"
      | "errorCode"
      | "errorMessage"
      | "costUsd"
      | "costSource"
      | "durationMs"
    >
  ): void {
    this.db.prepare(`
      UPDATE lifecycle_stage_attempts
      SET status=?, outcome=?, report=?, signature=?, sha=COALESCE(?, sha),
          error_code=?, error_message=?, cost_usd=?, cost_source=?, duration_ms=?, finished_at=?
      WHERE ticket_id=? AND stage=? AND attempt=?
    `).run(
      result.status,
      result.outcome ?? null,
      result.report ?? null,
      result.signature ?? null,
      result.sha ?? null,
      result.errorCode ?? null,
      result.errorMessage ?? null,
      result.costUsd ?? null,
      result.costSource ?? null,
      result.durationMs ?? null,
      now(),
      ticketId,
      stage,
      attempt
    );
  }

  latestAttempt(ticketId: string, stage: AttemptStage): StageAttempt | undefined {
    const row = this.db.prepare(`
      SELECT * FROM lifecycle_stage_attempts
      WHERE ticket_id=? AND stage=?
      ORDER BY attempt DESC LIMIT 1
    `).get(ticketId, stage) as Record<string, unknown> | undefined;
    return row ? this.hydrateAttempt(row) : undefined;
  }

  nextAttempt(ticketId: string, stage: AttemptStage): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(attempt), 0) AS value
      FROM lifecycle_stage_attempts WHERE ticket_id=? AND stage=?
    `).get(ticketId, stage) as { value: number };
    return Number(row.value) + 1;
  }

  /** Suma kosztów (ekwiwalent API) zakończonych prób od podanego ISO — druga przesłanka breakera. */
  usageSince(iso: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS usd
      FROM lifecycle_stage_attempts WHERE finished_at >= ?
    `).get(iso) as { usd: number };
    return Number(row.usd);
  }

  /**
   * Atomowa kopia bazy na żywo: checkpoint WAL + VACUUM INTO. Ścieżka docelowa
   * nie może istnieć (SQLite odmówi nadpisania istniejącego pliku).
   */
  backupTo(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  readLease(): { pid: number; hostname?: string; heartbeatAt: string } | undefined {
    const row = this.db.prepare("SELECT * FROM lifecycle_lease WHERE id = 1").get() as
      Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      pid: Number(row.pid),
      hostname: row.hostname == null ? undefined : String(row.hostname),
      heartbeatAt: String(row.heartbeat_at),
    };
  }

  claimLease(pid: number, hostname?: string): void {
    this.db.prepare(`
      INSERT INTO lifecycle_lease (id, pid, hostname, heartbeat_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        pid=excluded.pid, hostname=excluded.hostname, heartbeat_at=excluded.heartbeat_at
    `).run(pid, hostname ?? null, now());
  }

  renewLease(pid: number): void {
    this.db.prepare("UPDATE lifecycle_lease SET heartbeat_at=? WHERE id=1 AND pid=?").run(now(), pid);
  }

  releaseLease(pid: number): void {
    this.db.prepare("DELETE FROM lifecycle_lease WHERE id=1 AND pid=?").run(pid);
  }

  totalUsage(ticketId: string): { usd: number; minutes: number } {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS usd,
             COALESCE(SUM(duration_ms), 0) AS duration_ms
      FROM lifecycle_stage_attempts WHERE ticket_id=?
    `).get(ticketId) as { usd: number; duration_ms: number };
    return { usd: Number(row.usd), minutes: Number(row.duration_ms) / 60_000 };
  }

  /** Wszystkie próby ticketu (chronologicznie) — wejście wiersza eksperymentu. */
  listAttempts(ticketId: string): StageAttempt[] {
    return (this.db.prepare(`
      SELECT * FROM lifecycle_stage_attempts
      WHERE ticket_id=? ORDER BY started_at, stage, attempt
    `).all(ticketId) as Record<string, unknown>[]).map((row) => this.hydrateAttempt(row));
  }

  /**
   * Próby w toku (status running) — rezerwacja budżetu przed dispatchem
   * kolejnego joba: totalUsage widzi tylko koszty ZAKOŃCZONYCH prób, więc
   * równoległy fan-out (research ×3) mógłby przekroczyć limit wielokrotnie.
   */
  listRunningAttempts(ticketId: string): StageAttempt[] {
    return (this.db.prepare(`
      SELECT * FROM lifecycle_stage_attempts
      WHERE ticket_id=? AND status='running'
      ORDER BY started_at
    `).all(ticketId) as Record<string, unknown>[]).map((row) => this.hydrateAttempt(row));
  }

  /** Ocena jakości od człowieka (/score) — zapis przy runie, bez przejścia lifecycle. */
  setScore(ticketId: string, score: number, comment?: string): void {
    this.db.prepare(`
      UPDATE lifecycle_runs SET score=?, score_comment=?, scored_at=?, updated_at=?
      WHERE ticket_id=?
    `).run(score, comment ?? null, now(), now(), ticketId);
  }

  /** Ukończone (nie Canceled) runy bez oceny — cel sweepa komendy /score. */
  listScoreCandidates(sinceIso: string): LifecycleRun[] {
    return (this.db.prepare(`
      SELECT * FROM lifecycle_runs
      WHERE status='done'
        AND (error_code IS NULL OR error_code <> 'CANCELED')
        AND scored_at IS NULL
        AND updated_at >= ?
      ORDER BY updated_at
    `).all(sinceIso) as Record<string, unknown>[]).map((row) => this.hydrateRun(row));
  }

  /** Ile przetworzonych komend danego rodzaju ma ticket (np. retry/replan do eksperymentu). */
  countProcessedCommands(ticketId: string, kinds: string[]): number {
    if (!kinds.length) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    const row = this.db.prepare(`
      SELECT COUNT(*) AS value FROM lifecycle_processed_comments
      WHERE ticket_id=? AND command IN (${placeholders})
    `).get(ticketId, ...kinds) as { value: number };
    return Number(row.value);
  }

  isCommentProcessed(commentId: string): boolean {
    return !!this.db.prepare(
      "SELECT 1 FROM lifecycle_processed_comments WHERE comment_id=?"
    ).get(commentId);
  }

  processedCommandIds(ticketId: string): Set<string> {
    const rows = this.db.prepare(`
      SELECT comment_id FROM lifecycle_processed_comments
      WHERE ticket_id=?
    `).all(ticketId) as { comment_id: string }[];
    return new Set(rows.map((row) => row.comment_id));
  }

  markCommentProcessed(ticketId: string, commentId: string, command?: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO lifecycle_processed_comments (
        comment_id, ticket_id, command, processed_at
      ) VALUES (?, ?, ?, ?)
    `).run(commentId, ticketId, command ?? null, now());
  }

  /**
   * Legacy v1 pozostaje źródłem importu read-only. Funkcja nie usuwa ani nie
   * modyfikuje state.json; zwraca tylko bezpieczne checkpointy.
   */
  readLegacy(ticketId: string): {
    runId?: string;
    prUrl?: string;
    files: string[];
    outcome?: string;
  } | undefined {
    const root = process.env.FACTORY_RUNS_ROOT ??
      join(dirname(findUpFile("package.json")), "runs");
    try {
      const raw = JSON.parse(readFileSync(join(root, ticketId, "state.json"), "utf8")) as {
        runId?: string;
        prUrl?: string;
        files?: string[];
        finalized?: { outcome?: string };
      };
      return {
        runId: raw.runId,
        prUrl: raw.prUrl,
        files: raw.files ?? [],
        outcome: raw.finalized?.outcome,
      };
    } catch {
      return undefined;
    }
  }

  private insertCommand(
    command: Omit<LifecycleCommand, "state" | "attempts" | "createdAt" | "updatedAt" | "availableAt"> & {
      availableAt?: string;
    },
    timestamp: string
  ): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO lifecycle_commands (
        idempotency_key, ticket_id, kind, stage, payload_json, state,
        attempts, external_id, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
    `).run(
      command.key,
      command.ticketId,
      command.kind,
      command.stage,
      json(command.payload),
      command.externalId ?? null,
      command.availableAt ?? timestamp,
      timestamp,
      timestamp
    );
  }

  private writeRun(run: LifecycleRun): void {
    this.db.prepare(`
      UPDATE lifecycle_runs SET
        project=?, generation=?, stage=?, status=?, manifest_json=?, plan=?,
        plan_files_json=?, plan_domain=?, clarify_round=?, approved_at=?,
        branch=?, workspace_dir=?, head_sha=?, tested_sha=?, pr_url=?,
        merged_sha=?, review_status=?, smoke_status=?, blocked_stage=?,
        error_code=?, error_message=?, feedback=?,
        plan_entry=?, plan_variant=?, triage_summary=?, briefs_json=?,
        research_failures_json=?, critique_round=?, critique_verdict=?,
        critique_report=?, degradations_json=?, score=?, score_comment=?,
        scored_at=?, updated_at=?
      WHERE ticket_id=?
    `).run(
      run.project,
      run.generation,
      run.stage,
      run.status,
      json(run.manifest),
      run.plan ?? null,
      json(run.planFiles),
      run.planDomain ?? null,
      run.clarifyRound,
      run.approvedAt ?? null,
      run.branch ?? null,
      run.workspaceDir ?? null,
      run.headSha ?? null,
      run.testedSha ?? null,
      run.prUrl ?? null,
      run.mergedSha ?? null,
      run.reviewStatus ?? null,
      run.smokeStatus ?? null,
      run.blockedStage ?? null,
      run.errorCode ?? null,
      run.errorMessage ?? null,
      run.feedback ?? null,
      run.planEntry ?? null,
      run.planVariant ?? null,
      run.triageSummary ?? null,
      run.briefs ? json(run.briefs) : null,
      run.researchFailures ? json(run.researchFailures) : null,
      run.critiqueRound,
      run.critiqueVerdict ?? null,
      run.critiqueReport ?? null,
      run.degradations?.length ? json(run.degradations) : null,
      run.score ?? null,
      run.scoreComment ?? null,
      run.scoredAt ?? null,
      run.updatedAt,
      run.ticketId
    );
  }

  private hydrateRun(row: Record<string, unknown>): LifecycleRun {
    return {
      ticketId: String(row.ticket_id),
      project: String(row.project),
      generation: Number(row.generation),
      stage: String(row.stage) as LifecycleStage,
      status: String(row.status) as LifecycleStatus,
      manifest: parseJson<TicketManifestV2>(row.manifest_json, {
        title: "",
        description: "",
        labels: [],
        inputHash: "",
      }),
      plan: row.plan == null ? undefined : String(row.plan),
      planFiles: parseJson<string[]>(row.plan_files_json, []),
      planDomain: row.plan_domain == null ? undefined : String(row.plan_domain),
      clarifyRound: Number(row.clarify_round),
      approvedAt: row.approved_at == null ? undefined : String(row.approved_at),
      branch: row.branch == null ? undefined : String(row.branch),
      workspaceDir: row.workspace_dir == null ? undefined : String(row.workspace_dir),
      headSha: row.head_sha == null ? undefined : String(row.head_sha),
      testedSha: row.tested_sha == null ? undefined : String(row.tested_sha),
      prUrl: row.pr_url == null ? undefined : String(row.pr_url),
      mergedSha: row.merged_sha == null ? undefined : String(row.merged_sha),
      reviewStatus: row.review_status == null ? undefined : String(row.review_status) as LifecycleRun["reviewStatus"],
      smokeStatus: row.smoke_status == null ? undefined : String(row.smoke_status) as LifecycleRun["smokeStatus"],
      blockedStage: row.blocked_stage == null ? undefined : String(row.blocked_stage) as LifecycleStage,
      errorCode: row.error_code == null ? undefined : String(row.error_code),
      errorMessage: row.error_message == null ? undefined : String(row.error_message),
      feedback: row.feedback == null ? undefined : String(row.feedback),
      planEntry: row.plan_entry == null ? undefined : String(row.plan_entry) as LifecycleRun["planEntry"],
      planVariant: row.plan_variant == null ? undefined : String(row.plan_variant) as LifecycleRun["planVariant"],
      triageSummary: row.triage_summary == null ? undefined : String(row.triage_summary),
      briefs: row.briefs_json == null
        ? undefined
        : parseJson<Partial<Record<ResearchRole, string>>>(row.briefs_json, {}),
      researchFailures: row.research_failures_json == null
        ? undefined
        : parseJson<Partial<Record<ResearchRole, number>>>(row.research_failures_json, {}),
      critiqueRound: Number(row.critique_round ?? 0),
      critiqueVerdict: row.critique_verdict == null
        ? undefined
        : String(row.critique_verdict) as LifecycleRun["critiqueVerdict"],
      critiqueReport: row.critique_report == null ? undefined : String(row.critique_report),
      degradations: row.degradations_json == null
        ? undefined
        : parseJson<string[]>(row.degradations_json, []),
      score: row.score == null ? undefined : Number(row.score),
      scoreComment: row.score_comment == null ? undefined : String(row.score_comment),
      scoredAt: row.scored_at == null ? undefined : String(row.scored_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private hydrateCommand(row: Record<string, unknown>): LifecycleCommand {
    return {
      key: String(row.idempotency_key),
      ticketId: String(row.ticket_id),
      kind: String(row.kind) as CommandKind,
      stage: String(row.stage) as AttemptStage,
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
      state: String(row.state) as LifecycleCommand["state"],
      attempts: Number(row.attempts),
      externalId: row.external_id == null ? undefined : String(row.external_id),
      lastError: row.last_error == null ? undefined : String(row.last_error),
      availableAt: String(row.available_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private hydrateAttempt(row: Record<string, unknown>): StageAttempt {
    return {
      ticketId: String(row.ticket_id),
      stage: String(row.stage) as AttemptStage,
      attempt: Number(row.attempt),
      jobRunId: row.job_run_id == null ? undefined : String(row.job_run_id),
      inputHash: row.input_hash == null ? undefined : String(row.input_hash),
      sha: row.sha == null ? undefined : String(row.sha),
      status: String(row.status) as StageAttempt["status"],
      outcome: row.outcome == null ? undefined : String(row.outcome),
      report: row.report == null ? undefined : String(row.report),
      signature: row.signature == null ? undefined : String(row.signature),
      errorCode: row.error_code == null ? undefined : String(row.error_code),
      errorMessage: row.error_message == null ? undefined : String(row.error_message),
      costUsd: row.cost_usd == null ? undefined : Number(row.cost_usd),
      costSource: row.cost_source == null ? undefined : String(row.cost_source),
      durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
      budgetMaxMinutes: row.budget_max_minutes == null ? undefined : Number(row.budget_max_minutes),
      budgetMaxUsd: row.budget_max_usd == null ? undefined : Number(row.budget_max_usd),
      budgetUsedMinutes: row.budget_used_minutes == null ? undefined : Number(row.budget_used_minutes),
      budgetUsedUsd: row.budget_used_usd == null ? undefined : Number(row.budget_used_usd),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at == null ? undefined : String(row.finished_at),
    };
  }
}
