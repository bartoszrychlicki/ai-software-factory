import test from "node:test";
import assert from "node:assert/strict";
import { parsePlanVerdict, parseReviewVerdict, parseVerifyVerdict } from "../pipeline/verdicts";

const factory = (value: unknown) => `raport\n\n\`\`\`factory\n${JSON.stringify(value)}\n\`\`\``;

test("plan wymaga kompletnego, ścisłego kontraktu", () => {
  const valid = parsePlanVerdict(factory({
    verdict: "ok",
    screenshots: ["/"],
    files: ["src/App.tsx"],
    domain: "frontend",
  }));
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.files, ["src/App.tsx"]);

  assert.equal(parsePlanVerdict(factory({ verdict: "ok", files: [], domain: "frontend", screenshots: [] })).ok, false);
  assert.equal(parsePlanVerdict(factory({ verdict: "ok", files: ["../secret"], domain: "ops", screenshots: [] })).ok, false);
  assert.equal(parsePlanVerdict(factory({ verdict: "ok", files: ["x"], domain: "ops", screenshots: [], extra: true })).ok, false);
});

test("brak lub nieznany werdykt zawsze zamyka bramkę fail-closed", () => {
  assert.equal(parseVerifyVerdict("wygląda dobrze").pass, false);
  assert.equal(parseReviewVerdict(factory({ verdict: "unknown" })).needsFix, true);
  assert.equal(parseReviewVerdict(factory({ verdict: "lgtm" })).needsFix, false);
});
