import test from "node:test";
import assert from "node:assert/strict";
import { reduceLifecycle } from "../pipeline/coordinator";
import type { LifecycleRun, TicketManifestV2 } from "../pipeline/lifecycle-store";
import { auditScope } from "../pipeline/scope";
import { parseCommand, unknownCommandHint } from "../sources/commands";

const manifest: TicketManifestV2 = {
  title: "Autoryzacja zakresu",
  description: "BAR-190",
  labels: [],
  inputHash: "hash-scope",
};

function scopeBlockedRun(patch: Partial<LifecycleRun> = {}): LifecycleRun {
  return {
    ticketId: "BAR-190",
    project: "harness",
    generation: 3,
    stage: "build",
    status: "blocked",
    manifest,
    plan: "zatwierdzony plan",
    planFiles: ["e2e/foo.spec.ts"],
    planDomain: "backend",
    clarifyRound: 0,
    critiqueRound: 0,
    fixRound: 0,
    approvedAt: "2026-07-30T10:00:00.000Z",
    branch: "agent/BAR-190",
    blockedStage: "build",
    errorCode: "SCOPE_BLOCKED",
    errorMessage:
      "e2e/scripts/run-e2e.ts: chroniona ścieżka nie została zatwierdzona w planie",
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:01:00.000Z",
    ...patch,
  };
}

test("/scope rozszerza planFiles tej samej generacji i uruchamia buildera z feedbackiem", () => {
  const run = scopeBlockedRun();
  assert.deepEqual(
    auditScope(run.planFiles, ["e2e/foo.spec.ts", "e2e/scripts/run-e2e.ts"]).blocked,
    ["e2e/scripts/run-e2e.ts: chroniona ścieżka nie została zatwierdzona w planie"]
  );

  const decision = reduceLifecycle(run, {
    type: "scope",
    commentId: "c-1",
    paths: ["e2e/scripts/run-e2e.ts"],
    nextAttempt: 4,
  });
  const after: LifecycleRun = {
    ...run,
    ...decision.transition.patch,
    stage: decision.transition.stage,
    status: decision.transition.status,
  };
  const build = decision.commands[0];

  assert.deepEqual([after.stage, after.status], ["build", "running"]);
  assert.equal(after.generation, run.generation);
  assert.equal(after.plan, run.plan);
  assert.deepEqual(after.planFiles, ["e2e/foo.spec.ts", "e2e/scripts/run-e2e.ts"]);
  assert.equal(decision.transition.actor, "human");
  assert.equal(
    decision.transition.reason,
    "/scope c-1: e2e/scripts/run-e2e.ts"
  );
  assert.equal(build.kind, "run-job");
  assert.equal(build.payload.kind, "build");
  assert.equal(build.payload.attempt, 4);
  assert.equal(build.payload.plan, run.plan);
  assert.deepEqual(build.payload.planFiles, after.planFiles);
  assert.match(String(build.payload.feedback), /Zakres rozszerzony przez człowieka/);
  assert.match(String(build.payload.feedback), /Poprzednia próba/);
  assert.match(String(build.payload.feedback), /chroniona ścieżka/);
  assert.match(build.key, /:scope:c-1$/);
  assert.deepEqual(
    auditScope(after.planFiles, ["e2e/foo.spec.ts", "e2e/scripts/run-e2e.ts"]).blocked,
    []
  );
});

test("/scope odmawia poza dokładną blokadą build/SCOPE_BLOCKED bez mutacji planFiles", () => {
  const variants: LifecycleRun[] = [
    scopeBlockedRun({ status: "running", blockedStage: undefined, errorCode: undefined }),
    scopeBlockedRun({
      stage: "test",
      blockedStage: "test",
      errorCode: "TEST_FAILED",
    }),
    scopeBlockedRun({
      stage: "approval",
      status: "waiting_human",
      blockedStage: undefined,
      errorCode: undefined,
    }),
    scopeBlockedRun({ errorCode: "BUILD_ENGINE_FAILED" }),
  ];

  for (const run of variants) {
    const before = [...run.planFiles];
    assert.throws(
      () => reduceLifecycle(run, {
        type: "scope",
        commentId: "c-state",
        paths: ["e2e/scripts/run-e2e.ts"],
      }),
      /wyłącznie.*SCOPE_BLOCKED/
    );
    assert.deepEqual(run.planFiles, before);
  }
});

test("/scope defensywnie odrzuca sekret, traversal i ścieżkę już zadeklarowaną", () => {
  for (const path of [".env", "../outside.ts", "e2e/foo.spec.ts"]) {
    const run = scopeBlockedRun();
    assert.throws(
      () => reduceLifecycle(run, {
        type: "scope",
        commentId: "c-invalid",
        paths: [path],
      }),
      /\/scope zawiera niedozwolone ścieżki/
    );
    assert.deepEqual(run.planFiles, ["e2e/foo.spec.ts"]);
  }
});

test("wynik buildera nie ma żadnej drogi zapisu do planFiles", () => {
  const run = scopeBlockedRun({
    status: "running",
    blockedStage: undefined,
    errorCode: undefined,
    errorMessage: undefined,
  });
  const decision = reduceLifecycle(run, {
    type: "job-finished",
    attempt: 4,
    output: {
      kind: "build",
      outcome: "success",
      report: "builder zakończony",
      signature: "builder",
      durationMs: 1,
      files: ["src/inne.ts"],
      branch: "agent/BAR-190",
      workspaceDir: "/tmp/BAR-190",
      headSha: "a".repeat(40),
      changedFiles: ["src/inne.ts"],
      scopeWarnings: [],
    },
  });
  const after = { ...run, ...decision.transition.patch };

  assert.equal(decision.transition.patch?.planFiles, undefined);
  assert.deepEqual(after.planFiles, run.planFiles);
});

test("parser i hint obsługują ścisłą komendę /scope", () => {
  assert.equal(parseCommand("/scope"), undefined);
  assert.deepEqual(parseCommand("/scope a.ts b.ts"), {
    kind: "scope",
    payload: "a.ts b.ts",
  });
  assert.deepEqual(parseCommand("/`scope` e2e/x.ts"), {
    kind: "scope",
    payload: "e2e/x.ts",
  });
  assert.deepEqual(parseCommand("/scope. e2e/x.ts"), {
    kind: "scope",
    payload: "e2e/x.ts",
  });
  assert.match(
    unknownCommandHint({
      firstToken: "/skope",
      stage: "build",
      status: "blocked",
      blockedStage: "build",
      errorCode: "SCOPE_BLOCKED",
    }),
    /`\/retry`.*`\/replan <powód>`.*`\/scope <ścieżka>`/
  );
});
