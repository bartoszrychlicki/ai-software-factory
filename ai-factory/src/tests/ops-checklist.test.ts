import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyOpsVerification,
  isOpsWorkflowResult,
  OPS_VERIFY_MAX_RETRIES,
  opsTrackerStatus,
  runProdChecksWithRetry,
} from "../pipeline/ops-checklist";

const checks = [{ name: "production", url: "https://example.test" }];

test("ops prodChecks PASS kończy się Done bez human_review", () => {
  const result = classifyOpsVerification(checks, { ok: true, report: "✅ production" });
  assert.equal(result.status, "pass");
  assert.equal(opsTrackerStatus(result), "done");
  assert.notEqual(opsTrackerStatus(result), "human_review");
});

test("ops prodChecks FAIL pozostaje blocked z raportem", () => {
  const result = classifyOpsVerification(checks, { ok: false, report: "❌ production" });
  assert.equal(result.status, "fail");
  assert.equal(result.report, "❌ production");
  assert.equal(opsTrackerStatus(result), "blocked");
});

test("brak lub pusta lista prodChecks jest fail-closed", () => {
  for (const missing of [undefined, []]) {
    const result = classifyOpsVerification(missing);
    assert.equal(result.status, "no-checks");
    assert.equal(opsTrackerStatus(result), "blocked");
  }
});

test("retry prodChecks zatrzymuje się po maksymalnej liczbie powtórzeń", async () => {
  let attempts = 0;
  let waits = 0;
  const result = await runProdChecksWithRetry(
    checks,
    async () => {
      attempts += 1;
      return { ok: false, report: `fail ${attempts}` };
    },
    async () => {
      waits += 1;
    }
  );

  assert.equal(result.ok, false);
  assert.equal(attempts, 1 + OPS_VERIFY_MAX_RETRIES);
  assert.equal(waits, OPS_VERIFY_MAX_RETRIES);
});

test("guard rozpoznaje wyłącznie jawny wynik workflow kind=ops", () => {
  assert.equal(isOpsWorkflowResult({ kind: "ops", ticketId: "BAR-134", plan: "checklista" }), true);
  assert.equal(isOpsWorkflowResult({ ticketId: "BAR-134", plan: "checklista" }), false);
  assert.equal(isOpsWorkflowResult({ kind: "code", ticketId: "BAR-134", plan: "checklista" }), false);
});
