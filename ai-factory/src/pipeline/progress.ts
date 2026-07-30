import { createHash } from "node:crypto";
import {
  RESEARCH_ROLES,
  type LifecycleRun,
  type LifecycleStage,
  type ResearchRole,
} from "./lifecycle-store";

export type ProgressLevel = "off" | "milestones" | "verbose";

export interface ProgressCommentContext {
  buildSignature?: string;
  reviewSignature?: string;
  triageSignature?: string;
  synthesisSignature?: string;
  critiqueSignature?: string;
  researchSignature?: string;
  researchSignatures?: Partial<Record<ResearchRole, string>>;
}

export interface ProgressComment {
  key: string;
  body: string;
  level: Exclude<ProgressLevel, "off">;
  stage: LifecycleStage;
  signature?: string;
  enrich?: "approve-route" | "review-route";
}

interface ProgressDraft {
  body: string;
  level: ProgressComment["level"];
  signature?: string;
  enrich?: ProgressComment["enrich"];
}

const REVIEW_VERDICTS = new Set(["lgtm", "advisory-fix", "advisory-review"]);

function transitionKey(before: LifecycleRun, after: LifecycleRun, reason: string): string {
  const transitionId = createHash("sha256")
    .update(`${before.stage}:${before.status}:${after.stage}:${after.status}:${reason}`)
    .digest("hex")
    .slice(0, 12);
  return `${after.ticketId}:g${after.generation}:progress:${transitionId}`;
}

function milestoneComment(
  before: LifecycleRun,
  after: LifecycleRun,
  reason: string,
  context: ProgressCommentContext
): ProgressDraft | undefined {
  if (reason === "input-changed-before-build") {
    return {
      body:
        `🔁 **Wykryto edycję treści/nowy komentarz — planuję od nowa ` +
        `(generacja ${after.generation}).** Twój komentarz jest w kontekście plannera.`,
      level: "milestones",
    };
  }

  if (reason.startsWith("/replan")) {
    return {
      body:
        `🔁 **\`/replan\` przyjęty → planowanie startuje od nowa ` +
        `(generacja ${after.generation}).**`,
      level: "milestones",
    };
  }

  if (reason.startsWith("/fix")) {
    return {
      body:
        `🔧 **Poprawka po review (runda ${after.fixRound}/2) — inicjowana przez człowieka.** ` +
        "Ten sam plan i branch; po buildzie testy exact-SHA i ponowne review.",
      level: "milestones",
    };
  }

  if (
    reason.startsWith("/approve") &&
    before.stage === "approval" &&
    before.status === "waiting_human" &&
    after.stage === "build" &&
    after.status === "running"
  ) {
    return {
      body: "✅ **Plan zatwierdzony → 🔨 build startuje.**",
      level: "milestones",
      enrich: "approve-route",
    };
  }

  if (
    reason === "checkpoint-created" &&
    before.stage === "build" &&
    after.stage === "test" &&
    after.status === "pending"
  ) {
    const sha = after.headSha?.slice(0, 7) ?? "brak SHA";
    return {
      body:
        `🔨 **Build zakończony → checkpoint utworzony.** ` +
        `SHA: \`${sha}\`; zakres: ${after.planFiles.length} plików. Dalej: testy exact-SHA.`,
      level: "milestones",
      signature: context.buildSignature,
    };
  }

  if (
    reason === "exact-sha-tests-pass" &&
    before.stage === "test" &&
    after.stage === "publish"
  ) {
    const sha = after.testedSha?.slice(0, 7) ?? after.headSha?.slice(0, 7) ?? "brak SHA";
    return {
      body: `🧪 **Testy zielone dla \`${sha}\` → publikuję draft PR.**`,
      level: "milestones",
    };
  }

  if (
    reason === "draft-pr-recorded" &&
    before.stage === "publish" &&
    after.stage === "ci"
  ) {
    return {
      body: `🔗 **Draft PR zapisany:** ${after.prUrl ?? "URL niedostępny"} → czekam na CI.`,
      level: "milestones",
    };
  }

  if (
    reason === "ci-pass" &&
    before.stage === "ci" &&
    after.stage === "review" &&
    after.status === "running"
  ) {
    return {
      body: "✅ **CI zielone → 👀 review startuje.**",
      level: "milestones",
      enrich: "review-route",
    };
  }

  if (
    REVIEW_VERDICTS.has(reason) &&
    before.stage === "review" &&
    after.stage === "merge" &&
    after.status === "waiting_human"
  ) {
    const verdict = reason === "lgtm"
      ? "LGTM"
      : reason === "advisory-fix"
        ? "advisory-fix — uwagi nie blokują merge"
        : "advisory";
    return {
      body: `👀 **Review zakończony: ${verdict}.** PR jest gotowy do decyzji o merge.`,
      level: "milestones",
      signature: context.reviewSignature,
    };
  }

  if (
    reason === "tracked-pr-merged" &&
    before.stage === "merge" &&
    after.stage === "smoke" &&
    after.status === "pending"
  ) {
    const sha = after.mergedSha?.slice(0, 7);
    return {
      body: `🔀 **Merge wykryty${sha ? ` (\`${sha}\`)` : ""} → uruchamiam smoke produkcyjny.**`,
      level: "milestones",
    };
  }

  return undefined;
}

function verboseComment(
  before: LifecycleRun,
  after: LifecycleRun,
  reason: string,
  context: ProgressCommentContext
): ProgressDraft | undefined {
  if (reason.startsWith("/retry")) {
    return {
      body: `🔁 **\`/retry\` przyjęty → ponawiam etap ${after.stage}.**`,
      level: "verbose",
    };
  }

  if (reason === "triage-dispatched") {
    return {
      body: "🧭 **Triage startuje.** Klasyfikuję rozmiar, ryzyko i ścieżkę planowania.",
      level: "verbose",
    };
  }

  const triagePath = reason.match(/^triage-(degraded-)?(solo|deep)$/);
  if (triagePath) {
    const degraded = Boolean(triagePath[1]);
    const path = triagePath[2];
    return {
      body: path === "deep"
        ? `${degraded ? "⚠️ " : ""}**Triage zakończony → research startuje:** ${RESEARCH_ROLES.join(", ")}.`
        : `${degraded ? "⚠️ " : ""}**Triage zakończony → planowanie solo startuje.**`,
      level: "verbose",
      signature: context.triageSignature,
    };
  }

  const researchResult = reason.match(
    /^research-(recon|solution-a|solution-b)-(success|questions|failed)$/
  );
  if (researchResult) {
    const role = researchResult[1] as ResearchRole;
    const outcome = researchResult[2];
    const next = outcome === "success"
      ? "czekam na pozostałe role"
      : "automatyczny retry lub degradacja";
    return {
      body: `🔎 **Research ${role} zakończony: ${outcome}.** Dalej: ${next}.`,
      level: "verbose",
      signature: context.researchSignatures?.[role],
    };
  }

  const researchComplete = reason.match(/^research-complete-(\d+)\/3$/);
  if (researchComplete) {
    return {
      body: `🔎 **Research zakończony (${researchComplete[1]}/3 briefów) → synteza startuje.**`,
      level: "verbose",
      signature: context.researchSignature,
    };
  }

  if (reason === "synthesis-ready" || reason === "synthesis-revised") {
    return {
      body: reason === "synthesis-revised"
        ? "📝 **Synteza poprawiona po krytyce → ponowna krytyka startuje.**"
        : "📝 **Synteza gotowa → krytyka planu startuje.**",
      level: "verbose",
      signature: context.synthesisSignature,
    };
  }

  if (reason === "critique-issues-revision") {
    return {
      body: "🧪 **Krytyka wykryła istotne uwagi → uruchamiam jedną rewizję syntezy.**",
      level: "verbose",
      signature: context.critiqueSignature,
    };
  }

  const critiqueVerdict = reason.match(/^critique-(ok|issues|unavailable)$/);
  if (critiqueVerdict) {
    return {
      body: `🧪 **Krytyka zakończona: ${critiqueVerdict[1]} → plan trafia do bramki aprobaty.**`,
      level: "verbose",
      signature: context.critiqueSignature,
    };
  }

  return undefined;
}

function degradationDetails(before: LifecycleRun, after: LifecycleRun): string[] {
  const previous = new Set(before.degradations ?? []);
  const notes = (after.degradations ?? []).filter((note) => !previous.has(note));

  for (const role of RESEARCH_ROLES) {
    const priorFailures = before.researchFailures?.[role] ?? 0;
    const currentFailures = after.researchFailures?.[role] ?? 0;
    if (currentFailures > priorFailures && !notes.some((note) => note.includes(`research ${role}`))) {
      notes.push(`research ${role}: nieudana próba ${currentFailures}`);
    }
  }
  return notes;
}

export function progressComment(
  before: LifecycleRun,
  after: LifecycleRun,
  reason: string,
  context: ProgressCommentContext = {}
): ProgressComment | undefined {
  let draft = milestoneComment(before, after, reason, context)
    ?? verboseComment(before, after, reason, context);
  const degradations = degradationDetails(before, after);

  if (!draft && degradations.length) {
    draft = {
      body: "⚠️ **Pipeline działa w trybie zdegradowanym.**",
      level: "verbose",
    };
  }
  if (!draft) return undefined;

  const body = degradations.length
    ? `${draft.body}\n\n⚠️ ${degradations.join("\n⚠️ ")}`
    : draft.body;
  return {
    key: transitionKey(before, after, reason),
    body,
    level: draft.level,
    stage: after.stage,
    signature: draft.signature,
    enrich: draft.enrich,
  };
}
