import {
  RESEARCH_ROLES,
  researchAttemptStage,
  type AttemptStage,
  type LifecycleCommand,
  type LifecycleRun,
  type LifecycleStage,
  type ResearchRole,
  type TransitionInput,
} from "./lifecycle-store";
import {
  BRIEF_CLIP_CHARS,
  clip,
  CRITIQUE_CLIP_CHARS,
  FIX_HINTS_CLIP_CHARS,
  REVIEW_CLIP_CHARS,
  type FactoryJobOutput,
} from "./factory-job";
import { authorizeScopePaths } from "./scope";

type NewCommand = Omit<
  LifecycleCommand,
  "state" | "attempts" | "createdAt" | "updatedAt" | "availableAt"
> & { availableAt?: string };

/**
 * Numery kolejnych prób per stage (liczone przez poller z rejestru) — reducer
 * jest czysty i nie może ich sam odczytać, a reużycie numeru z INSERT OR
 * IGNORE po cichu zjada joba (incydent BAR-177).
 */
export type NextAttempts = Partial<Record<AttemptStage, number>>;

export type CoordinatorEvent =
  | { type: "start"; entry?: "plan" | "triage"; forcedVariant?: "solo" | "deep"; nextAttempt?: number }
  | { type: "job-finished"; attempt: number; output: FactoryJobOutput; nextAttempts?: NextAttempts; usage?: { usd: number; minutes: number } }
  | { type: "approve"; commentId: string; nextAttempt?: number }
  | { type: "answer"; commentId: string; answer: string; inputHash?: string; commentContext?: string; nextAttempt?: number }
  | { type: "ops-done"; commentId: string }
  | { type: "reject"; commentId: string; reason: string }
  | { type: "retry"; commentId: string; nextAttempt?: number; nextAttempts?: NextAttempts }
  | { type: "scope"; commentId: string; paths: string[]; nextAttempt?: number }
  | { type: "fix"; commentId: string; hints?: string; nextAttempt?: number }
  | { type: "replan"; commentId: string; reason: string; nextAttempt?: number; nextAttempts?: NextAttempts }
  | { type: "input-changed"; inputHash: string; commentContext?: string; title?: string; description?: string; labels?: string[]; nextAttempt?: number; nextAttempts?: NextAttempts }
  | { type: "test-result"; ok: boolean; sha: string; report: string }
  | { type: "branch-synchronized"; previousSha: string; sha: string }
  | { type: "published"; prUrl: string; branch: string; sha: string }
  | { type: "ci-result"; outcome: "pass" | "pending" | "fail"; sha: string; report: string; nextReviewAttempt?: number }
  | { type: "pr-head-changed"; sha: string }
  | { type: "pr-state"; state: "open" | "closed" | "merged"; sha: string }
  | { type: "smoke-result"; outcome: "pass" | "fail" | "skipped-not-configured"; report: string }
  | { type: "cancel" };

export interface CoordinatorDecision {
  transition: TransitionInput;
  commands: NewCommand[];
}

function key(run: LifecycleRun, suffix: string): string {
  return `${run.ticketId}:g${run.generation}:${suffix}`;
}

function plannedBranch(run: LifecycleRun): string {
  const slug = run.manifest.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `agent/${run.ticketId}-${slug}`;
}

function jobCommand(
  run: LifecycleRun,
  kind: "plan" | "build" | "review" | "triage" | "research" | "synthesis" | "critique",
  stage: AttemptStage,
  attempt: number,
  extra: Record<string, unknown> = {},
  /**
   * Dodatkowy dyskryminator klucza dla jobów z /retry. Komenda anulowana PRZED
   * dispatchem (np. INPUT_CHANGED_AFTER_BUILD tuż po /approve) nie zostawia
   * próby w rejestrze, więc nextAttempt liczy ten sam numer — bez suffixu
   * INSERT OR IGNORE po cichu zjadłby retry i run wisiałby jako zombie
   * (incydent BAR-177, 2026-07-29).
   */
  keySuffix = ""
): NewCommand {
  return {
    key: key(run, `job:${kind}:${stage}:a${attempt}${keySuffix}`),
    ticketId: run.ticketId,
    kind: "run-job",
    stage,
    payload: {
      kind,
      attempt,
      ticket: {
        id: run.ticketId,
        title: run.manifest.title,
        description: run.manifest.description,
        project: run.project,
        labels: run.manifest.labels,
        inputHash: run.manifest.inputHash,
        commentContext: run.manifest.commentContext,
      },
      plan: run.plan,
      planFiles: run.planFiles,
      planDomain: run.planDomain,
      headSha: run.headSha,
      feedback: run.feedback,
      briefs: run.briefs,
      triageSummary: run.triageSummary,
      critique: run.critiqueReport,
      ...extra,
    },
  };
}

/** Komenda joba research dla konkretnej roli (osobny stage prób per rola). */
function researchCommand(
  run: LifecycleRun,
  role: ResearchRole,
  attempt: number,
  keySuffix = ""
): NewCommand {
  return jobCommand(run, "research", researchAttemptStage(role), attempt, { researchRole: role }, keySuffix);
}

/** Wejście pipeline'u planowania po replan/edycji: triage, chyba że label wymusza solo. */
function planEntryOf(run: LifecycleRun, labels?: string[]): "plan" | "triage" {
  const effective = labels ?? run.manifest.labels;
  if (effective.includes("plan:solo")) return "plan";
  return run.planEntry ?? "plan";
}

/** Reset pól planowania v3 przy nowej generacji (replan / zmiana inputu). */
const PLAN_RESET_PATCH = {
  plan: undefined,
  planFiles: [] as string[],
  planDomain: undefined,
  approvedAt: undefined,
  clarifyRound: 0,
  feedback: undefined,
  planVariant: undefined,
  triageSummary: undefined,
  briefs: undefined,
  researchFailures: undefined,
  critiqueRound: 0,
  reviewReport: undefined,
  fixRound: 0,
  critiqueVerdict: undefined,
  critiqueReport: undefined,
  degradations: undefined,
  // Ocena /score dotyczy generacji, którą oceniano — nowa generacja startuje
  // bez niej (inaczej summary N+1 dziedziczyłoby rating generacji N).
  score: undefined,
  scoreComment: undefined,
  scoredAt: undefined,
};

function linearComment(
  run: LifecycleRun,
  suffix: string,
  body: string,
  stage: LifecycleStage,
  signature?: string
): NewCommand {
  return {
    key: key(run, `linear-comment:${suffix}`),
    ticketId: run.ticketId,
    kind: "linear-comment",
    stage,
    payload: {
      body,
      ...(signature ? { signature } : {}),
    },
  };
}

/**
 * Sprzątanie artefaktów GitHub poprzedniej generacji.
 * MUSI być wywołane na runie SPRZED patcha czyszczącego prUrl.
 */
function retireGenerationCommand(run: LifecycleRun, reason: string): NewCommand | undefined {
  if (!run.prUrl || !run.branch || run.mergedSha) return undefined;
  return {
    key: key(run, "retire"),
    ticketId: run.ticketId,
    kind: "retire-generation",
    stage: run.stage,
    payload: {
      prUrl: run.prUrl,
      branch: run.branch,
      headSha: run.headSha,
      generation: run.generation,
      reason,
    },
  };
}

/**
 * Komentarz bramki aprobat: plan + werdykt krytyki + jawne degradacje + koszt.
 * Człowiek decyduje z pełnym obrazem; mechanika /approve i /reject bez zmian.
 */
function approvalGateComment(
  run: LifecycleRun,
  suffix: string,
  opts: { signature?: string; usage?: { usd: number; minutes: number } } = {}
): NewCommand {
  const header = run.planVariant === "deep"
    ? "🧠 **Plan gotowy (deep: research ×3 → synteza → krytyka)**"
    : "🧠 **Plan gotowy**";
  const critiqueSection = run.critiqueVerdict === "ok"
    ? "✅ **Krytyka planu** (niezależny silnik): bez zastrzeżeń."
    : run.critiqueVerdict === "issues"
      ? `⚠️ **Krytyka planu — uwagi (advisory, po ${run.critiqueRound ? "1 rewizji" : "0 rewizjach"}):**\n\n${run.critiqueReport ?? ""}`
      : run.critiqueVerdict === "unavailable"
        ? "⚠️ **Krytyka planu niedostępna** — plan idzie na bramkę bez adwersaryjnego sprawdzenia."
        : "";
  const degradations = run.degradations?.length
    ? `⚠️ **Degradacje:**\n${run.degradations.map((note) => `- ${note}`).join("\n")}`
    : "";
  const cost = opts.usage
    ? `Koszt planowania dotychczas: $${opts.usage.usd.toFixed(2)} (${opts.usage.minutes.toFixed(1)} min sumy jobów).`
    : "";
  const body = [
    header,
    run.triageSummary ? `> Triage: ${run.triageSummary}` : "",
    run.plan ?? "",
    "---",
    critiqueSection,
    degradations,
    cost,
    "Zatwierdź wyłącznie komendą `/approve` albo odrzuć: `/reject <powód>`.",
  ].filter(Boolean).join("\n\n");
  return linearComment(run, suffix, body, "approval", opts.signature);
}

function blocked(
  run: LifecycleRun,
  stage: LifecycleStage,
  code: string,
  message: string,
  signature?: string
): CoordinatorDecision {
  return {
    transition: {
      stage,
      status: "blocked",
      actor: "coordinator",
      reason: code,
      patch: { blockedStage: stage, errorCode: code, errorMessage: message },
    },
    commands: [
      linearComment(
        run,
        `${stage}:${code}`,
        `❌ **Proces zatrzymany (${stage})**\n\n${message}\n\nWznowienie tylko przez \`/retry\` albo \`/replan <powód>\`.`,
        stage,
        signature
      ),
    ],
  };
}

function assertStage(run: LifecycleRun, expected: LifecycleStage, event: string): void {
  if (run.stage !== expected) {
    throw new Error(`${event} jest niedozwolone w etapie ${run.stage}; oczekiwano ${expected}.`);
  }
}

export function reduceLifecycle(run: LifecycleRun, event: CoordinatorEvent): CoordinatorDecision {
  if (event.type === "cancel") {
    return {
      transition: {
        stage: run.stage,
        status: "done",
        actor: "linear",
        reason: "canceled",
        patch: { errorCode: "CANCELED", errorMessage: "Ticket anulowany przez człowieka." },
      },
      commands: [],
    };
  }

  if (event.type === "start") {
    assertStage(run, "plan", event.type);
    const entry = event.entry ?? "plan";
    if (entry === "triage") {
      return {
        transition: {
          stage: "triage",
          status: "running",
          actor: "coordinator",
          reason: "triage-dispatched",
          patch: { planEntry: "triage", planVariant: event.forcedVariant },
        },
        commands: [jobCommand(run, "triage", "triage", event.nextAttempt ?? 1)],
      };
    }
    return {
      transition: {
        stage: "plan",
        status: "running",
        actor: "coordinator",
        reason: "plan-dispatched",
        patch: { planEntry: "plan", planVariant: event.forcedVariant },
      },
      commands: [jobCommand(run, "plan", "plan", event.nextAttempt ?? 1)],
    };
  }

  if (event.type === "input-changed") {
    if (event.inputHash === run.manifest.inputHash) {
      throw new Error("input-changed bez zmiany input hash.");
    }
    const PRE_BUILD_STAGES: LifecycleStage[] = [
      "plan", "triage", "research", "synthesis", "critique", "approval",
    ];
    if (PRE_BUILD_STAGES.includes(run.stage)) {
      const manifest = {
        ...run.manifest,
        title: event.title ?? run.manifest.title,
        description: event.description ?? run.manifest.description,
        labels: event.labels ?? run.manifest.labels,
        inputHash: event.inputHash,
        commentContext: event.commentContext,
      };
      const entry = planEntryOf(run, manifest.labels);
      const nextRun: LifecycleRun = {
        ...run,
        generation: run.generation + 1,
        manifest,
        ...PLAN_RESET_PATCH,
        critiqueRound: 0,
      };
      const retire = retireGenerationCommand(
        run,
        "zastąpione nową generacją po zmianie wejścia ticketu"
      );
      return {
        transition: {
          stage: entry,
          status: "pending",
          actor: "linear",
          reason: "input-changed-before-build",
          incrementGeneration: true,
          cancelOutstandingRunJobs: true,
          patch: { manifest, ...PLAN_RESET_PATCH },
        },
        commands: [
          ...(retire ? [retire] : []),
          jobCommand(
            nextRun,
            entry,
            entry,
            (entry === "triage" ? event.nextAttempts?.triage : event.nextAttempts?.plan)
              ?? event.nextAttempt ?? 1
          ),
        ],
      };
    }
    const decision = blocked(
      run,
      run.stage,
      "INPUT_CHANGED_AFTER_BUILD",
      "Autor zmienił wejście po rozpoczęciu builda. Branch i checkpoint zostały zachowane; wymagane jest świadome `/replan <powód>`."
    );
    decision.transition.patch = {
      ...decision.transition.patch,
      manifest: {
        ...run.manifest,
        title: event.title ?? run.manifest.title,
        description: event.description ?? run.manifest.description,
        labels: event.labels ?? run.manifest.labels,
        inputHash: event.inputHash,
        commentContext: event.commentContext,
      },
    };
    decision.transition.cancelOutstandingRunJobs = true;
    return decision;
  }

  if (event.type === "approve") {
    assertStage(run, "approval", event.type);
    if (run.status !== "waiting_human") throw new Error("/approve wymaga oczekującej bramki approval.");
    if (run.planDomain === "ops") {
      return {
        transition: {
          stage: "approval",
          status: "waiting_human",
          actor: "human",
          reason: `/approve ${event.commentId}: ops-checklist`,
          patch: {
            approvedAt: new Date().toISOString(),
            blockedStage: undefined,
            errorCode: undefined,
            errorMessage: undefined,
          },
        },
        commands: [linearComment(
          run,
          "ops-checklist",
          "🧾 **Plan ops zatwierdzony.** Wykonaj checklistę ręcznie, a następnie potwierdź wyłącznie komendą `/done`.",
          "approval"
        )],
      };
    }
    return {
      transition: {
        stage: "build",
        status: "running",
        actor: "human",
        reason: `/approve ${event.commentId}`,
        patch: {
          approvedAt: new Date().toISOString(),
          branch: run.branch ?? plannedBranch(run),
          blockedStage: undefined,
          errorCode: undefined,
          errorMessage: undefined,
        },
      },
      commands: [jobCommand(run, "build", "build", event.nextAttempt ?? 1)],
    };
  }

  if (event.type === "ops-done") {
    assertStage(run, "approval", event.type);
    if (run.planDomain !== "ops" || !run.approvedAt) {
      throw new Error("/done dotyczy wyłącznie zatwierdzonej checklisty ops.");
    }
    return {
      transition: {
        stage: "smoke",
        status: "pending",
        actor: "human",
        reason: `/done ${event.commentId}: ops-checklist-complete`,
      },
      commands: [],
    };
  }

  if (event.type === "answer") {
    // Pytania zadaje triage (runda 1), planner solo albo synteza (runda 2).
    const CLARIFY_STAGES: LifecycleStage[] = ["plan", "triage", "synthesis"];
    if (!CLARIFY_STAGES.includes(run.stage)) {
      throw new Error(`answer jest niedozwolone w etapie ${run.stage}; oczekiwano plan/triage/synthesis.`);
    }
    if (run.status !== "waiting_human" || run.clarifyRound < 1 || run.clarifyRound > 2) {
      throw new Error("/answer wymaga aktywnej rundy pytań planera.");
    }
    const kind = run.stage as "plan" | "triage" | "synthesis";
    const patchedRun: LifecycleRun = {
      ...run,
      feedback: event.answer,
      manifest: event.inputHash
        ? {
          ...run.manifest,
          inputHash: event.inputHash,
          commentContext: event.commentContext,
        }
        : run.manifest,
    };
    return {
      transition: {
        stage: run.stage,
        status: "running",
        actor: "human",
        reason: `/answer ${event.commentId}`,
        patch: {
          feedback: event.answer,
          manifest: patchedRun.manifest,
        },
      },
      commands: [jobCommand(
        patchedRun,
        kind,
        run.stage,
        event.nextAttempt ?? run.clarifyRound + 1,
        { feedback: event.answer }
      )],
    };
  }

  if (event.type === "reject") {
    assertStage(run, "approval", event.type);
    return blocked(run, "approval", "PLAN_REJECTED", event.reason || "Plan odrzucony bez powodu.");
  }

  if (event.type === "replan") {
    const entry = planEntryOf(run);
    const nextRun: LifecycleRun = {
      ...run,
      generation: run.generation + 1,
      ...PLAN_RESET_PATCH,
      feedback: event.reason,
    };
    const retire = retireGenerationCommand(
      run,
      "zastąpione nową generacją planu po /replan"
    );
    return {
      transition: {
        stage: entry,
        status: "running",
        actor: "human",
        reason: `/replan ${event.commentId}`,
        incrementGeneration: true,
        cancelOutstandingRunJobs: true,
        patch: {
          ...PLAN_RESET_PATCH,
          feedback: event.reason,
          blockedStage: undefined,
          errorCode: undefined,
          errorMessage: undefined,
          prUrl: undefined,
          mergedSha: undefined,
          testedSha: undefined,
          reviewStatus: undefined,
          smokeStatus: undefined,
        },
      },
      commands: [
        ...(retire ? [retire] : []),
        jobCommand(
          nextRun,
          entry,
          entry,
          (entry === "triage" ? event.nextAttempts?.triage : event.nextAttempts?.plan)
            ?? event.nextAttempt ?? 1,
          { feedback: event.reason }
        ),
      ],
    };
  }

  if (event.type === "fix") {
    if (run.mergedSha) {
      throw new Error("PR jest już zmergowany — praca jest w main; /fix nic nie poprawi.");
    }
    if (run.stage !== "merge" || run.status !== "waiting_human") {
      throw new Error(
        `/fix działa wyłącznie na bramce merge (etap ${run.stage}, status ${run.status}).`
      );
    }
    if (run.reviewStatus !== "advisory-fix") {
      throw new Error(
        `Review dało \`${run.reviewStatus ?? "brak werdyktu"}\` — nie ma uwag do poprawki.`
      );
    }
    if (run.fixRound >= 2) {
      throw new Error(
        "Wyczerpano 2/2 poprawki w tej generacji; dalsza korekta wymaga /replan <powód>."
      );
    }
    if (
      !run.reviewReport?.trim() ||
      !run.prUrl ||
      !run.headSha ||
      !run.branch ||
      !run.plan
    ) {
      throw new Error("Brak raportu review dla bieżącego head SHA — /fix nie ma wejścia.");
    }

    const round = run.fixRound + 1;
    const feedback = [
      [
        "# Instrukcja",
        "Poprawiaj wyłącznie w granicach zatwierdzonego planu; nie rozszerzaj zakresu.",
        "Nie zmieniaj plików spoza planu, nie refaktoruj przy okazji.",
        "Uwagi review są advisory — oceń każdą i odrzuć w raporcie tę, która jest błędna.",
      ].join("\n"),
      `# Uwagi review do naprawy (runda ${round}/2)`,
      clip(run.reviewReport, REVIEW_CLIP_CHARS),
      event.hints?.trim()
        ? `# Dodatkowe wskazówki człowieka\n${clip(event.hints.trim(), FIX_HINTS_CLIP_CHARS)}`
        : "",
    ].filter(Boolean).join("\n\n");
    const prBody =
      `🔧 Poprawka po review (runda ${round}/2) — inicjowana przez człowieka`;

    return {
      transition: {
        stage: "build",
        status: "running",
        actor: "human",
        reason: `/fix ${event.commentId}: fix-after-review`,
        patch: {
          fixRound: round,
          feedback,
          blockedStage: undefined,
          errorCode: undefined,
          errorMessage: undefined,
        },
      },
      commands: [
        jobCommand(
          run,
          "build",
          "build",
          event.nextAttempt ?? 1,
          { feedback, headSha: run.headSha },
          `:fix:${event.commentId}`
        ),
        {
          key: key(run, `pr-comment:fix:${round}`),
          ticketId: run.ticketId,
          kind: "comment-pr",
          stage: "merge",
          payload: { prUrl: run.prUrl, body: prBody, outcome: "fix-dispatched" },
        },
      ],
    };
  }

  if (event.type === "scope") {
    if (
      run.status !== "blocked" ||
      run.blockedStage !== "build" ||
      run.errorCode !== "SCOPE_BLOCKED"
    ) {
      throw new Error(
        "/scope rozszerza zakres wyłącznie dla runu zatrzymanego przez audyt zakresu (SCOPE_BLOCKED)."
      );
    }
    const authorization = authorizeScopePaths(event.paths, run.planFiles);
    if (authorization.accepted.length !== event.paths.length) {
      const details = [
        ...authorization.rejected.map(({ path, reason }) => `${path || "(pusta)"}: ${reason}`),
        ...authorization.alreadyDeclared.map((path) => `${path}: ścieżka jest już w planFiles`),
      ].join("; ");
      throw new Error(`/scope zawiera niedozwolone ścieżki${details ? `: ${details}` : "."}`);
    }
    const planFiles = [...run.planFiles, ...authorization.accepted];
    const feedback =
      `Zakres rozszerzony przez człowieka o: ${authorization.accepted.join(", ")}.\n\n` +
      "Poprzednia próba została zatrzymana przez audyt zakresu:\n" +
      clip(run.errorMessage ?? "Brak raportu poprzedniej blokady.", 4000);
    const nextRun: LifecycleRun = { ...run, planFiles, feedback };
    return {
      transition: {
        stage: "build",
        status: "running",
        actor: "human",
        reason: `/scope ${event.commentId}: ${authorization.accepted.join(", ")}`,
        patch: {
          planFiles,
          feedback,
          blockedStage: undefined,
          errorCode: undefined,
          errorMessage: undefined,
        },
      },
      commands: [jobCommand(
        nextRun,
        "build",
        "build",
        event.nextAttempt ?? 2,
        { feedback },
        `:scope:${event.commentId}`
      )],
    };
  }

  if (event.type === "retry") {
    if (run.status !== "blocked" || !run.blockedStage) {
      throw new Error("/retry ponawia wyłącznie zatrzymany etap.");
    }
    if (run.blockedStage === "test") {
      const attempt = event.nextAttempt ?? 2;
      return {
        transition: {
          stage: "build",
          status: "running",
          actor: "human",
          reason: `/retry ${event.commentId}: fix-after-test`,
          patch: { blockedStage: undefined, errorCode: undefined, errorMessage: undefined },
        },
        commands: [jobCommand(run, "build", "build", attempt, {
          feedback: run.errorMessage,
          headSha: run.headSha,
        }, `:retry:${event.commentId}`)],
      };
    }
    if (run.blockedStage === "review") {
      // Ludzki /retry jest świadomy — dopuszczamy go także po wyczerpaniu
      // pojedynczego automatycznego ponowienia (REVIEW_UNAVAILABLE) i po stallu.
      const retryable = ["OUTBOX_FAILED", "REVIEW_UNAVAILABLE", "JOB_STALLED", "JOB_MISSING"];
      if (!retryable.includes(run.errorCode ?? "") || !run.prUrl || !run.headSha) {
        throw new Error("Review nie ma bezpiecznej operacji do ponowienia.");
      }
      // Werdykt już jest → brakuje tylko zdjęcia draftu; bez werdyktu → sam job.
      if (run.reviewStatus === "lgtm" || run.reviewStatus === "advisory-fix") {
        return {
          transition: {
            stage: "merge",
            status: "waiting_human",
            actor: "human",
            reason: `/retry ${event.commentId}: mark-ready-only`,
            patch: { blockedStage: undefined, errorCode: undefined, errorMessage: undefined },
          },
          commands: [{
            key: key(run, `ready:${run.headSha}:retry:${event.commentId}`),
            ticketId: run.ticketId,
            kind: "mark-pr-ready",
            stage: "review",
            payload: { prUrl: run.prUrl, sha: run.headSha },
          }],
        };
      }
      return {
        transition: {
          stage: "review",
          status: "running",
          actor: "human",
          reason: `/retry ${event.commentId}: review-job`,
          patch: { blockedStage: undefined, errorCode: undefined, errorMessage: undefined },
        },
        commands: [jobCommand(run, "review", "review", event.nextAttempt ?? 1, {}, `:retry:${event.commentId}`)],
      };
    }
    if (
      run.blockedStage === "build" ||
      run.blockedStage === "plan" ||
      run.blockedStage === "triage" ||
      run.blockedStage === "synthesis" ||
      run.blockedStage === "critique"
    ) {
      const kind = run.blockedStage;
      return {
        transition: {
          stage: run.blockedStage,
          status: "running",
          actor: "human",
          reason: `/retry ${event.commentId}: stage-only`,
          patch: { blockedStage: undefined, errorCode: undefined, errorMessage: undefined },
        },
        commands: [jobCommand(run, kind, run.blockedStage, event.nextAttempt ?? 2, {}, `:retry:${event.commentId}`)],
      };
    }
    if (run.blockedStage === "research") {
      // Ponawiamy wyłącznie role bez briefu; reset liczników porażek daje im
      // ponownie jeden auto-retry. Human /retry jest świadomy.
      const missing = RESEARCH_ROLES.filter((role) => !run.briefs?.[role]);
      if (!missing.length) throw new Error("Research ma komplet briefów — nie ma czego ponawiać.");
      return {
        transition: {
          stage: "research",
          status: "running",
          actor: "human",
          reason: `/retry ${event.commentId}: research-roles`,
          patch: {
            blockedStage: undefined,
            errorCode: undefined,
            errorMessage: undefined,
            researchFailures: undefined,
          },
        },
        commands: missing.map((role) => researchCommand(
          run,
          role,
          event.nextAttempts?.[researchAttemptStage(role)] ?? 2,
          `:retry:${event.commentId}`
        )),
      };
    }
    if (run.blockedStage === "approval") {
      throw new Error("Odrzucony plan wymaga `/replan <powód>`, a nie `/retry`.");
    }
    if (run.blockedStage === "publish") {
      return {
        transition: {
          stage: "publish",
          status: "pending",
          actor: "human",
          reason: `/retry ${event.commentId}: publish`,
          patch: { blockedStage: undefined, errorCode: undefined, errorMessage: undefined },
        },
        commands: [{
          key: key(run, `publish:${run.headSha}:retry:${event.commentId}`),
          ticketId: run.ticketId,
          kind: "publish-pr",
          stage: "publish",
          payload: { branch: run.branch, workspaceDir: run.workspaceDir, sha: run.headSha },
        }],
      };
    }
    const retryStatus = run.blockedStage === "ci"
      ? "waiting_external"
      : run.blockedStage === "merge"
        ? "waiting_human"
        : "pending";
    return {
      transition: {
        stage: run.blockedStage,
        status: retryStatus,
        actor: "human",
        reason: `/retry ${event.commentId}: deterministic-stage`,
        patch: { blockedStage: undefined, errorCode: undefined, errorMessage: undefined },
      },
      commands: [],
    };
  }

  if (event.type === "job-finished") {
    if (event.output.kind === "plan") {
      assertStage(run, "plan", event.type);
      if (event.output.outcome === "questions") {
        if (run.clarifyRound >= 2) {
          return blocked(
            run,
            "plan",
            "PLAN_MAX_QUESTIONS",
            "Planner wyczerpał dwie rundy pytań.",
            event.output.signature
          );
        }
        return {
          transition: {
            stage: "plan",
            status: "waiting_human",
            actor: "planner",
            reason: "questions",
            patch: { clarifyRound: run.clarifyRound + 1 },
          },
          commands: [linearComment(
            run,
            `questions:${run.clarifyRound + 1}`,
            `❓ **Pytania do planu — runda ${run.clarifyRound + 1}/2**\n\n${event.output.questions}\n\nOdpowiedz: \`/answer <odpowiedź>\`.`,
            "plan",
            event.output.signature
          )],
        };
      }
      if (event.output.outcome === "failed" || !event.output.plan) {
        return blocked(
          run,
          "plan",
          event.output.errorCode ?? "PLAN_FAILED",
          event.output.report.slice(0, 6000),
          event.output.signature
        );
      }
      const planPatch = {
        plan: event.output.plan,
        planFiles: event.output.files,
        planDomain: event.output.domain,
        feedback: undefined,
      };
      return {
        transition: {
          stage: "approval",
          status: "waiting_human",
          actor: "planner",
          reason: "plan-ready",
          patch: planPatch,
        },
        commands: [approvalGateComment(
          { ...run, ...planPatch },
          `plan:${event.attempt}`,
          { signature: event.output.signature, usage: event.usage }
        )],
      };
    }

    if (event.output.kind === "triage") {
      assertStage(run, "triage", event.type);
      const forcedDeep = run.manifest.labels.includes("plan:deep");
      if (event.output.outcome === "questions" && run.clarifyRound === 0) {
        return {
          transition: {
            stage: "triage",
            status: "waiting_human",
            actor: "planner",
            reason: "triage-questions",
            patch: { clarifyRound: 1 },
          },
          commands: [linearComment(
            run,
            "questions:1",
            `❓ **Pytania do ticketu (triage) — runda 1/2**\n\n${event.output.questions}\n\nOdpowiedz: \`/answer <odpowiedź>\`.`,
            "triage",
            event.output.signature
          )],
        };
      }
      // Budżet to jedyna twarda blokada triage — reszta degraduje do ścieżki solo.
      if (event.output.errorCode === "BUDGET_EXHAUSTED") {
        return blocked(run, "triage", "BUDGET_EXHAUSTED", event.output.report.slice(0, 6000), event.output.signature);
      }
      const degraded = event.output.outcome !== "success" || !event.output.triagePath;
      const path: "solo" | "deep" = forcedDeep
        ? "deep"
        : degraded
          ? "solo"
          : event.output.triagePath!;
      const degradations = degraded
        ? [
          ...(run.degradations ?? []),
          event.output.outcome === "questions"
            ? `triage nie rozstrzygnął po odpowiedzi autora — ścieżka ${path}`
            : `triage niedostępny (${event.output.errorCode ?? "brak werdyktu"}) — ścieżka ${path}`,
        ]
        : run.degradations;
      const triagePatch = {
        planVariant: path,
        triageSummary: event.output.triageSummary ?? run.triageSummary,
        degradations,
      };
      const nextRun: LifecycleRun = { ...run, ...triagePatch };
      if (path === "deep") {
        return {
          transition: {
            stage: "research",
            status: "running",
            actor: "planner",
            reason: degraded ? "triage-degraded-deep" : "triage-deep",
            patch: triagePatch,
          },
          commands: RESEARCH_ROLES.map((role) => researchCommand(
            nextRun,
            role,
            event.nextAttempts?.[researchAttemptStage(role)] ?? 1
          )),
        };
      }
      return {
        transition: {
          stage: "plan",
          status: "running",
          actor: "planner",
          reason: degraded ? "triage-degraded-solo" : "triage-solo",
          patch: triagePatch,
        },
        commands: [jobCommand(nextRun, "plan", "plan", event.nextAttempts?.plan ?? 1)],
      };
    }

    if (event.output.kind === "research") {
      assertStage(run, "research", event.type);
      const role = event.output.researchRole;
      if (!role) throw new Error("Wynik research bez researchRole.");
      const briefs = { ...(run.briefs ?? {}) };
      const failures = { ...(run.researchFailures ?? {}) };
      let degradations = run.degradations ?? [];
      const commands: NewCommand[] = [];
      const briefText = (event.output.brief ?? event.output.report).trim();
      if (event.output.outcome === "success" && briefText) {
        briefs[role] = clip(briefText, BRIEF_CLIP_CHARS);
      } else {
        const attemptsSoFar = (failures[role] ?? 0) + 1;
        const retryable = attemptsSoFar === 1 && event.output.errorCode !== "BUDGET_EXHAUSTED";
        if (retryable) {
          failures[role] = 1;
          commands.push(researchCommand(
            run,
            role,
            event.nextAttempts?.[researchAttemptStage(role)] ?? 2,
            ":auto2"
          ));
        } else {
          // Sentinel 2 = wyczerpane ponowienia; rola rozstrzygnięta jako porażka.
          failures[role] = 2;
          degradations = [
            ...degradations,
            `research ${role}: niedostępny (${event.output.errorCode ?? "porażka"}) — synteza bez tego briefu`,
          ];
        }
      }
      const researchPatch = {
        briefs,
        researchFailures: failures,
        degradations: degradations.length ? degradations : undefined,
      };
      const resolved = RESEARCH_ROLES.every(
        (candidate) => briefs[candidate] !== undefined || (failures[candidate] ?? 0) >= 2
      );
      if (!resolved) {
        return {
          transition: {
            stage: "research",
            status: "running",
            actor: "researcher",
            reason: `research-${role}-${event.output.outcome}`,
            patch: researchPatch,
          },
          commands,
        };
      }
      const briefCount = RESEARCH_ROLES.filter((candidate) => briefs[candidate]).length;
      if (!briefCount) {
        const decision = blocked(
          run,
          "research",
          "RESEARCH_FAILED",
          "Wszystkie joby researchu zakończyły się porażką (po jednym auto-retry na rolę).",
          event.output.signature
        );
        decision.transition.patch = { ...decision.transition.patch, ...researchPatch };
        return decision;
      }
      const nextRun: LifecycleRun = { ...run, ...researchPatch };
      return {
        transition: {
          stage: "synthesis",
          status: "running",
          actor: "researcher",
          reason: `research-complete-${briefCount}/3`,
          patch: researchPatch,
        },
        commands: [jobCommand(nextRun, "synthesis", "synthesis", event.nextAttempts?.synthesis ?? 1)],
      };
    }

    if (event.output.kind === "synthesis") {
      assertStage(run, "synthesis", event.type);
      if (event.output.outcome === "questions") {
        if (run.clarifyRound >= 2) {
          return blocked(
            run,
            "synthesis",
            "PLAN_MAX_QUESTIONS",
            "Planner wyczerpał dwie rundy pytań.",
            event.output.signature
          );
        }
        return {
          transition: {
            stage: "synthesis",
            status: "waiting_human",
            actor: "planner",
            reason: "questions",
            patch: { clarifyRound: run.clarifyRound + 1 },
          },
          commands: [linearComment(
            run,
            `questions:${run.clarifyRound + 1}`,
            `❓ **Pytania do planu (synteza) — runda ${run.clarifyRound + 1}/2**\n\n${event.output.questions}\n\nOdpowiedz: \`/answer <odpowiedź>\`.`,
            "synthesis",
            event.output.signature
          )],
        };
      }
      if (event.output.outcome === "failed" || !event.output.plan) {
        return blocked(
          run,
          "synthesis",
          event.output.errorCode ?? "SYNTHESIS_FAILED",
          event.output.report.slice(0, 6000),
          event.output.signature
        );
      }
      const synthesisPatch = {
        plan: event.output.plan,
        planFiles: event.output.files,
        planDomain: event.output.domain,
        feedback: undefined,
      };
      const nextRun: LifecycleRun = { ...run, ...synthesisPatch };
      return {
        transition: {
          stage: "critique",
          status: "running",
          actor: "planner",
          reason: run.critiqueRound ? "synthesis-revised" : "synthesis-ready",
          patch: synthesisPatch,
        },
        commands: [jobCommand(
          nextRun,
          "critique",
          "critique",
          event.nextAttempts?.critique ?? run.critiqueRound + 1,
          {},
          run.critiqueRound ? ":r2" : ""
        )],
      };
    }

    if (event.output.kind === "critique") {
      assertStage(run, "critique", event.type);
      const verdict = event.output.critiqueVerdict ?? "unavailable";
      const issues = event.output.critiqueIssues
        ?? (verdict === "issues" ? clip(event.output.report, CRITIQUE_CLIP_CHARS) : undefined);
      if (verdict === "issues" && run.critiqueRound === 0) {
        const revisionPatch = {
          critiqueRound: 1,
          critiqueVerdict: verdict,
          critiqueReport: issues,
          feedback: issues,
        };
        const nextRun: LifecycleRun = { ...run, ...revisionPatch };
        return {
          transition: {
            stage: "synthesis",
            status: "running",
            actor: "critic",
            reason: "critique-issues-revision",
            patch: revisionPatch,
          },
          commands: [jobCommand(
            nextRun,
            "synthesis",
            "synthesis",
            event.nextAttempts?.synthesis ?? 2,
            { feedback: issues },
            ":rev1"
          )],
        };
      }
      const degradations = verdict === "unavailable"
        ? [...(run.degradations ?? []), `krytyka planu niedostępna (${event.output.errorCode ?? "brak werdyktu"})`]
        : run.degradations;
      const gatePatch = {
        critiqueVerdict: verdict,
        critiqueReport: issues ?? run.critiqueReport,
        degradations,
      };
      return {
        transition: {
          stage: "approval",
          status: "waiting_human",
          actor: verdict === "unavailable" ? "coordinator" : "critic",
          reason: `critique-${verdict}`,
          patch: gatePatch,
        },
        commands: [approvalGateComment(
          { ...run, ...gatePatch },
          `plan:critique:${event.attempt}`,
          { signature: event.output.signature, usage: event.usage }
        )],
      };
    }

    if (event.output.kind === "build") {
      assertStage(run, "build", event.type);
      if (event.output.outcome === "failed" || !event.output.headSha) {
        const decision = blocked(
          run,
          "build",
          event.output.errorCode ?? "BUILD_FAILED",
          event.output.report.slice(0, 6000),
          event.output.signature
        );
        decision.transition.patch = {
          ...decision.transition.patch,
          branch: event.output.branch ?? run.branch,
          workspaceDir: event.output.workspaceDir ?? run.workspaceDir,
          headSha: event.output.headSha ?? run.headSha,
        };
        return decision;
      }
      return {
        transition: {
          stage: "test",
          status: "pending",
          actor: "builder",
          reason: "checkpoint-created",
          patch: {
            branch: event.output.branch,
            workspaceDir: event.output.workspaceDir,
            headSha: event.output.headSha,
            feedback: event.output.scopeWarnings.join("\n"),
          },
        },
        commands: [],
      };
    }

    assertStage(run, "review", event.type);
    if (event.output.reviewVerdict === "unavailable" && run.reviewStatus !== "unavailable") {
      return {
        transition: {
          stage: "review",
          status: "running",
          actor: "reviewer",
          reason: "review-verdict-missing-retry-once",
          patch: { reviewStatus: "unavailable" },
        },
        commands: [jobCommand(run, "review", "review", event.attempt + 1)],
      };
    }
    if (event.output.reviewVerdict === "unavailable") {
      return blocked(
        run,
        "review",
        "REVIEW_UNAVAILABLE",
        event.output.report.slice(0, 6000),
        event.output.signature
      );
    }
    // Advisory zostaje advisory: lgtm i advisory-fix odblokowują ready, ale
    // komentarz recenzenta jest dispatchowany PRZED zdjęciem draftu.
    return {
      transition: {
        stage: "merge",
        status: "waiting_human",
        actor: "reviewer",
        reason: event.output.reviewVerdict ?? "advisory-review",
        patch: {
          reviewStatus: event.output.reviewVerdict ?? "unavailable",
          reviewReport: clip(event.output.report, REVIEW_CLIP_CHARS),
        },
      },
      commands: [
        {
          key: key(run, `pr-comment:review:${event.attempt}`),
          ticketId: run.ticketId,
          kind: "comment-pr",
          stage: "review",
          payload: { prUrl: run.prUrl, body: event.output.report, signature: event.output.signature },
        },
        {
          key: key(run, `ready:${run.headSha}`),
          ticketId: run.ticketId,
          kind: "mark-pr-ready",
          stage: "review",
          payload: { prUrl: run.prUrl, sha: run.headSha },
        },
      ],
    };
  }

  if (event.type === "test-result") {
    assertStage(run, "test", event.type);
    if (event.sha !== run.headSha) throw new Error("Wynik testów dotyczy innego SHA niż checkpoint.");
    if (!event.ok) return blocked(run, "test", "TEST_FAILED", event.report);
    return {
      transition: {
        stage: "publish",
        status: "pending",
        actor: "test-runner",
        reason: "exact-sha-tests-pass",
        patch: { testedSha: event.sha, errorCode: undefined, errorMessage: undefined },
      },
      commands: [{
        key: key(run, `publish:${event.sha}`),
        ticketId: run.ticketId,
        kind: "publish-pr",
        stage: "publish",
        payload: { branch: run.branch, workspaceDir: run.workspaceDir, sha: event.sha },
      }],
    };
  }

  if (event.type === "branch-synchronized") {
    assertStage(run, "test", event.type);
    if (run.headSha !== event.previousSha) throw new Error("Synchronizacja dotyczy nieaktualnego SHA.");
    return {
      transition: {
        stage: "test",
        status: "running",
        actor: "git",
        reason: "main-synchronized",
        patch: {
          headSha: event.sha,
          testedSha: undefined,
          reviewStatus: run.prUrl ? "pending" : run.reviewStatus,
        },
      },
      commands: [],
    };
  }

  if (event.type === "pr-head-changed") {
    if (!run.prUrl) throw new Error("Zmiana PR head bez śledzonego PR.");
    if (event.sha === run.headSha) throw new Error("PR head nie zmienił się.");
    return {
      transition: {
        stage: "test",
        status: "pending",
        actor: "github",
        reason: "pr-head-changed",
        cancelOutstandingRunJobs: true,
        patch: {
          headSha: event.sha,
          testedSha: undefined,
          reviewStatus: "pending",
          blockedStage: undefined,
          errorCode: undefined,
          errorMessage: undefined,
        },
      },
      commands: [],
    };
  }

  if (event.type === "published") {
    assertStage(run, "publish", event.type);
    if (event.sha !== run.testedSha) throw new Error("Publikacja dotyczy SHA bez testów.");
    return {
      transition: {
        stage: "ci",
        status: "waiting_external",
        actor: "github",
        reason: "draft-pr-recorded",
        patch: { prUrl: event.prUrl, branch: event.branch, headSha: event.sha },
      },
      commands: [linearComment(
        run,
        `pr:${event.prUrl}`,
        `🔗 **Draft PR gotowy:** ${event.prUrl}\n\nFabryka czeka na CI dla dokładnego SHA \`${event.sha}\`.`,
        "ci"
      )],
    };
  }

  if (event.type === "ci-result") {
    assertStage(run, "ci", event.type);
    if (event.sha !== run.headSha) throw new Error("CI dotyczy innego PR head SHA.");
    if (event.outcome === "pending") {
      return {
        transition: {
          stage: "ci",
          status: "waiting_external",
          actor: "github",
          reason: "ci-pending",
        },
        commands: [],
      };
    }
    if (event.outcome === "fail") return blocked(run, "ci", "CI_FAILED", event.report);
    // PR zostaje draftem do werdyktu review — mark-pr-ready enqueue'uje dopiero
    // gałąź werdyktu, żeby komentarz recenzenta istniał zanim PR wyjdzie z draftu.
    return {
      transition: {
        stage: "review",
        status: "running",
        actor: "github",
        reason: "ci-pass",
        patch: { reviewStatus: "running" },
      },
      commands: [jobCommand(run, "review", "review", event.nextReviewAttempt ?? 1)],
    };
  }

  if (event.type === "pr-state") {
    if (!run.prUrl) throw new Error("Stan PR bez zapisanego prUrl jest ignorowany.");
    if (event.state === "closed") {
      const decision = blocked(
        run,
        "merge",
        "PR_CLOSED_UNMERGED",
        `Śledzony PR ${run.prUrl} zamknięto bez merge.`
      );
      decision.transition.cancelOutstandingRunJobs = true;
      return decision;
    }
    if (event.state === "merged") {
      return {
        transition: {
          stage: "smoke",
          status: "pending",
          actor: "github",
          reason: "tracked-pr-merged",
          cancelOutstandingRunJobs: true,
          patch: { mergedSha: event.sha },
        },
        commands: [],
      };
    }
    return {
      transition: {
        stage: "merge",
        status: "waiting_human",
        actor: "github",
        reason: "pr-open",
      },
      commands: [],
    };
  }

  if (event.type === "smoke-result") {
    assertStage(run, "smoke", event.type);
    if (event.outcome === "fail") return blocked(run, "smoke", "SMOKE_FAILED", event.report);
    return {
      transition: {
        stage: "smoke",
        status: "done",
        actor: "smoke-runner",
        reason: event.outcome,
        patch: { smokeStatus: event.outcome },
      },
      commands: [
        linearComment(
          run,
          `done:${run.mergedSha ?? "ops"}`,
          run.planDomain === "ops"
            ? `✅ **Checklista ops ukończona**\n\nWeryfikacja: **${event.outcome}**\n\n${event.report}`
            : `✅ **Ticket ukończony**\n\nPR: ${run.prUrl}\nMerge SHA: \`${run.mergedSha}\`\nProd smoke: **${event.outcome}**\n\n${event.report}`,
          "smoke"
        ),
        {
          key: key(run, `cleanup:${run.mergedSha ?? "ops"}`),
          ticketId: run.ticketId,
          kind: "cleanup-workspace",
          stage: "smoke",
          payload: { workspaceDir: run.workspaceDir, branch: run.branch },
        },
      ],
    };
  }

  throw new Error(`Nieobsługiwane zdarzenie: ${(event as { type: string }).type}`);
}
