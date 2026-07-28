import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parsePlanVerdict } from "./verdicts";
import { LifecycleStore, type TicketManifestV2 } from "./lifecycle-store";

interface LegacyState {
  v?: number;
  ticketId?: string;
  project?: string;
  runId?: string;
  lifecycle?: string;
  manifest?: { labels?: string[]; url?: string; effectiveInputHash?: string };
  outbox?: Record<string, { body?: Record<string, unknown> }>;
}

export interface LegacyMigrationCandidate {
  ticketId: string;
  project: string;
  manifest: TicketManifestV2;
  plan: string;
  planFiles: string[];
  planDomain?: string;
  checkpointSha?: string;
  prUrl?: string;
  sourceRunId: string;
  resumeFrom: "test";
}

function artifactBody(raw: string): string {
  const parts = raw.split(/^---\s*$/m);
  return parts.length >= 3 ? parts.slice(2).join("---").trim() : raw.trim();
}

function artifactMeta(raw: string): Record<string, string> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  return Object.fromEntries(match[1].split("\n").flatMap((line) => {
    const index = line.indexOf(":");
    return index > 0 ? [[line.slice(0, index).trim(), line.slice(index + 1).trim()]] : [];
  }));
}

/**
 * Buduje propozycję importu wyłącznie z trwałych danych v1. Nigdy nie
 * rekonstruuje bieżącego PR-a z komentarzy Lineara.
 */
export function inspectLegacyV1(
  runsRoot: string,
  ticketId: string,
  options: { explicitPrUrl?: string } = {}
): LegacyMigrationCandidate {
  const state = JSON.parse(
    readFileSync(join(runsRoot, ticketId, "state.json"), "utf8")
  ) as LegacyState;
  if (state.v !== 1 || state.ticketId !== ticketId || !state.project || !state.runId) {
    throw new Error(`${ticketId}: nieprawidłowy snapshot registry v1.`);
  }
  const runDir = join(runsRoot, ticketId, state.runId);
  const planPath = join(runDir, "plan.md");
  const approval = JSON.parse(readFileSync(join(runDir, "approval.json"), "utf8")) as {
    approved?: boolean;
  };
  if (!approval.approved) throw new Error(`${ticketId}: plan v1 nie ma trwałej aprobaty.`);
  const plan = artifactBody(readFileSync(planPath, "utf8"));
  const verdict = parsePlanVerdict(plan);
  if (!verdict.ok) throw new Error(`${ticketId}: zatwierdzony plan nie ma kompletnego kontraktu factory.`);

  let checkpointSha: string | undefined;
  const builds = readdirSync(runDir)
    .filter((name) => /^build-attempt-\d+\.md$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)?.[0] ?? 0) - Number(a.match(/\d+/)?.[0] ?? 0));
  for (const file of builds) {
    const meta = artifactMeta(readFileSync(join(runDir, file), "utf8"));
    if (meta.outcome === "committed" && /^[0-9a-f]{40}$/i.test(meta.sha ?? "")) {
      checkpointSha = meta.sha;
      break;
    }
  }
  if (!checkpointSha && !options.explicitPrUrl) {
    throw new Error(`${ticketId}: brak jednoznacznego checkpointu lub jawnie przypiętego PR-a.`);
  }

  const startBody = Object.values(state.outbox ?? {})
    .map((item) => item.body)
    .find((body) => body?.id === ticketId);
  const title = typeof startBody?.title === "string" ? startBody.title : ticketId;
  const description = typeof startBody?.description === "string" ? startBody.description : "";
  const labels = Array.isArray(state.manifest?.labels)
    ? state.manifest.labels.filter((label): label is string => typeof label === "string")
    : [];
  const inputHash = state.manifest?.effectiveInputHash;
  if (!inputHash) throw new Error(`${ticketId}: brak trwałego effectiveInputHash.`);

  return {
    ticketId,
    project: state.project,
    manifest: {
      title,
      description,
      labels,
      url: state.manifest?.url,
      inputHash,
      commentContext: typeof startBody?.commentContext === "string"
        ? startBody.commentContext
        : undefined,
    },
    plan,
    planFiles: verdict.files,
    planDomain: verdict.domain,
    checkpointSha,
    prUrl: options.explicitPrUrl,
    sourceRunId: state.runId,
    resumeFrom: "test",
  };
}

export interface LiveMigrationFacts {
  linearState: string;
  pr?: { url: string; state: "OPEN" | "CLOSED" | "MERGED"; headSha: string; branch: string };
  checkpointExists: boolean;
  /** Komendy istniejące w chwili live read stają się watermarkiem importu. */
  historicalCommands: { id: string; command: string }[];
}

export function importLegacyCandidate(
  store: LifecycleStore,
  candidate: LegacyMigrationCandidate,
  facts: LiveMigrationFacts
): void {
  validateLiveMigration(candidate, facts);
  const initial = store.createRun(candidate.ticketId, candidate.project, candidate.manifest);
  const headSha = facts.pr?.headSha ?? candidate.checkpointSha;
  if (!headSha) throw new Error(`${candidate.ticketId}: import nie ma head SHA.`);
  store.transition(candidate.ticketId, {
    stage: "test",
    status: "pending",
    actor: "migration-v1",
    reason: `import:${candidate.sourceRunId}`,
    patch: {
      plan: candidate.plan,
      planFiles: candidate.planFiles,
      planDomain: candidate.planDomain,
      approvedAt: initial.createdAt,
      branch: facts.pr?.branch ?? `agent/${candidate.ticketId}-migrated`,
      headSha,
      prUrl: candidate.prUrl,
      reviewStatus: candidate.prUrl ? "pending" : undefined,
    },
  });
  for (const command of facts.historicalCommands) {
    store.markCommentProcessed(candidate.ticketId, command.id, command.command);
  }
}

/**
 * Gate przed apply: caller musi wykonać świeży odczyt Lineara, GitHuba i repo.
 */
export function validateLiveMigration(
  candidate: LegacyMigrationCandidate,
  facts: LiveMigrationFacts
): void {
  if (!Array.isArray(facts.historicalCommands)) {
    throw new Error(`${candidate.ticketId}: live read nie dostarczył watermarku komend Lineara.`);
  }
  if (facts.linearState === "Canceled") throw new Error(`${candidate.ticketId}: ticket jest Canceled.`);
  if (candidate.prUrl) {
    if (!facts.pr || facts.pr.url !== candidate.prUrl) {
      throw new Error(`${candidate.ticketId}: live read nie potwierdził jawnie przypiętego PR-a.`);
    }
    if (facts.pr.state !== "OPEN") {
      throw new Error(`${candidate.ticketId}: przypięty PR nie jest otwarty (${facts.pr.state}).`);
    }
  } else if (!candidate.checkpointSha || !facts.checkpointExists) {
    throw new Error(`${candidate.ticketId}: checkpoint nie istnieje w repo podczas live read.`);
  }
}
