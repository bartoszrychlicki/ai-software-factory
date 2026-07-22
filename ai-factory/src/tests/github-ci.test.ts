import test from "node:test";
import assert from "node:assert/strict";
import { evaluateGithubChecks, waitForGithubChecks, type GithubCheckSnapshot } from "../pipeline/github-ci";

const snapshot = (status: string, conclusion: string): GithubCheckSnapshot => ({
  headSha: "abc123",
  checks: [{ name: "quality", status, conclusion, workflowName: "CI" }],
});

test("GitHub CI gate rozróżnia brak, pending, success i failure wymaganego checka", () => {
  assert.equal(evaluateGithubChecks({ headSha: "abc123", checks: [] }, ["quality"]).outcome, "pending");
  assert.equal(evaluateGithubChecks(snapshot("IN_PROGRESS", ""), ["quality"]).outcome, "pending");
  assert.equal(evaluateGithubChecks(snapshot("COMPLETED", "SUCCESS"), ["quality"]).outcome, "pass");
  assert.equal(evaluateGithubChecks(snapshot("COMPLETED", "FAILURE"), ["quality"]).outcome, "fail");
  assert.equal(evaluateGithubChecks(snapshot("COMPLETED", "SUCCESS"), []).outcome, "fail");
});

test("GitHub CI gate czeka na check i akceptuje wyłącznie dokładny PR head SHA", async () => {
  let calls = 0;
  const result = await waitForGithubChecks({
    cwd: process.cwd(),
    pr: "1",
    expectedSha: "abc123",
    requiredChecks: ["quality"],
    timeoutMs: 1_000,
    inspect: async () => {
      calls += 1;
      return calls === 1 ? snapshot("IN_PROGRESS", "") : snapshot("COMPLETED", "SUCCESS");
    },
    pause: async () => {},
  });
  assert.equal(result.outcome, "pass");
  assert.equal(calls, 2);

  await assert.rejects(
    waitForGithubChecks({
      cwd: process.cwd(),
      pr: "1",
      expectedSha: "expected",
      requiredChecks: ["quality"],
      timeoutMs: 0,
      inspect: async () => snapshot("COMPLETED", "SUCCESS"),
    }),
    /PR head zmienił się.*oczekiwano expected.*abc123/
  );
});
