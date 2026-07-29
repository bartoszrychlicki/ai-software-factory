import type {
  LifecycleCommand,
  LifecycleRun,
  LifecycleStage,
  TransitionInput,
} from "./lifecycle-store";
import type { FactoryJobOutput } from "./factory-job";

type NewCommand = Omit<
  LifecycleCommand,
  "state" | "attempts" | "createdAt" | "updatedAt" | "availableAt"
> & { availableAt?: string };

export type CoordinatorEvent =
  | { type: "start"; nextAttempt?: number }
  | { type: "job-finished"; attempt: number; output: FactoryJobOutput }
  | { type: "approve"; commentId: string; nextAttempt?: number }
  | { type: "answer"; commentId: string; answer: string; inputHash?: string; commentContext?: string; nextAttempt?: number }
  | { type: "ops-done"; commentId: string }
  | { type: "reject"; commentId: string; reason: string }
  | { type: "retry"; commentId: string; nextAttempt?: number }
  | { type: "replan"; commentId: string; reason: string; nextAttempt?: number }
  | { type: "input-changed"; inputHash: string; commentContext?: string; title?: string; description?: string; labels?: string[]; nextAttempt?: number }
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
  kind: "plan" | "build" | "review",
  stage: LifecycleStage,
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
      ...extra,
    },
  };
}

function linearComment(
  run: LifecycleRun,
  suffix: string,
  body: string,
  stage: LifecycleStage
): NewCommand {
  return {
    key: key(run, `linear-comment:${suffix}`),
    ticketId: run.ticketId,
    kind: "linear-comment",
    stage,
    payload: { body },
  };
}

function blocked(
  run: LifecycleRun,
  stage: LifecycleStage,
  code: string,
  message: string
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
        stage
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
    return {
      transition: {
        stage: "plan",
        status: "running",
        actor: "coordinator",
        reason: "plan-dispatched",
      },
      commands: [jobCommand(run, "plan", "plan", event.nextAttempt ?? 1)],
    };
  }

  if (event.type === "input-changed") {
    if (event.inputHash === run.manifest.inputHash) {
      throw new Error("input-changed bez zmiany input hash.");
    }
    if (run.stage === "plan" || run.stage === "approval") {
      return {
        transition: {
          stage: "plan",
          status: "pending",
          actor: "linear",
          reason: "input-changed-before-build",
          incrementGeneration: true,
          cancelOutstandingRunJobs: true,
          patch: {
            manifest: {
              ...run.manifest,
              title: event.title ?? run.manifest.title,
              description: event.description ?? run.manifest.description,
              labels: event.labels ?? run.manifest.labels,
              inputHash: event.inputHash,
              commentContext: event.commentContext,
            },
            plan: undefined,
            planFiles: [],
            planDomain: undefined,
            approvedAt: undefined,
            clarifyRound: 0,
            feedback: undefined,
          },
        },
        commands: [jobCommand({
          ...run,
          generation: run.generation + 1,
          manifest: {
            ...run.manifest,
            title: event.title ?? run.manifest.title,
            description: event.description ?? run.manifest.description,
            labels: event.labels ?? run.manifest.labels,
            inputHash: event.inputHash,
            commentContext: event.commentContext,
          },
          plan: undefined,
          planFiles: [],
          planDomain: undefined,
        }, "plan", "plan", event.nextAttempt ?? 1)],
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
    assertStage(run, "plan", event.type);
    if (run.status !== "waiting_human" || run.clarifyRound < 1 || run.clarifyRound > 2) {
      throw new Error("/answer wymaga aktywnej rundy pytań planera.");
    }
    return {
      transition: {
        stage: "plan",
        status: "running",
        actor: "human",
        reason: `/answer ${event.commentId}`,
        patch: {
          feedback: event.answer,
          manifest: event.inputHash
            ? {
              ...run.manifest,
              inputHash: event.inputHash,
              commentContext: event.commentContext,
            }
            : run.manifest,
        },
      },
      commands: [jobCommand(
        {
          ...run,
          feedback: event.answer,
          manifest: event.inputHash
            ? {
              ...run.manifest,
              inputHash: event.inputHash,
              commentContext: event.commentContext,
            }
            : run.manifest,
        },
        "plan",
        "plan",
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
    return {
      transition: {
        stage: "plan",
        status: "running",
        actor: "human",
        reason: `/replan ${event.commentId}`,
        incrementGeneration: true,
        cancelOutstandingRunJobs: true,
        patch: {
          plan: undefined,
          planFiles: [],
          planDomain: undefined,
          approvedAt: undefined,
          clarifyRound: 0,
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
      commands: [jobCommand({
        ...run,
        generation: run.generation + 1,
        plan: undefined,
        planFiles: [],
        planDomain: undefined,
        feedback: event.reason,
      }, "plan", "plan", event.nextAttempt ?? 1, { feedback: event.reason })],
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
    if (run.blockedStage === "build" || run.blockedStage === "plan") {
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
          return blocked(run, "plan", "PLAN_MAX_QUESTIONS", "Planner wyczerpał dwie rundy pytań.");
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
            "plan"
          )],
        };
      }
      if (event.output.outcome === "failed" || !event.output.plan) {
        return blocked(
          run,
          "plan",
          event.output.errorCode ?? "PLAN_FAILED",
          event.output.report.slice(0, 6000)
        );
      }
      return {
        transition: {
          stage: "approval",
          status: "waiting_human",
          actor: "planner",
          reason: "plan-ready",
          patch: {
            plan: event.output.plan,
            planFiles: event.output.files,
            planDomain: event.output.domain,
            feedback: undefined,
          },
        },
        commands: [linearComment(
          run,
          `plan:${event.attempt}`,
          `🧠 **Plan gotowy**\n\n${event.output.plan}\n\nZatwierdź wyłącznie komendą \`/approve\` albo odrzuć: \`/reject <powód>\`.`,
          "approval"
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
          event.output.report.slice(0, 6000)
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
      return blocked(run, "review", "REVIEW_UNAVAILABLE", event.output.report.slice(0, 6000));
    }
    // Advisory zostaje advisory: lgtm i advisory-fix odblokowują ready, ale
    // komentarz recenzenta jest dispatchowany PRZED zdjęciem draftu.
    return {
      transition: {
        stage: "merge",
        status: "waiting_human",
        actor: "reviewer",
        reason: event.output.reviewVerdict ?? "advisory-review",
        patch: { reviewStatus: event.output.reviewVerdict ?? "unavailable" },
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
