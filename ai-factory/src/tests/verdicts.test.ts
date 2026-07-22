import test from "node:test";
import assert from "node:assert/strict";
import {
  formatClarifyQuestions,
  parsePlanVerdict,
  parseReviewVerdict,
  parseVerifyVerdict,
} from "../pipeline/verdicts";

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

  const compatible = parsePlanVerdict(factory({
    verdict: "ok",
    questions: "",
    screenshots: [],
    files: ["src/counter.ts"],
    domain: "frontend",
  }));
  assert.equal(compatible.ok, true);

  assert.equal(parsePlanVerdict(factory({ verdict: "ok", files: [], domain: "frontend", screenshots: [] })).ok, false);
  assert.equal(parsePlanVerdict(factory({ verdict: "ok", files: ["../secret"], domain: "ops", screenshots: [] })).ok, false);
  assert.equal(parsePlanVerdict(factory({ verdict: "ok", questions: "pytanie", files: ["x"], domain: "ops", screenshots: [] })).ok, false);
  assert.equal(parsePlanVerdict(factory({ verdict: "ok", files: ["x"], domain: "ops", screenshots: [], extra: true })).ok, false);
});

test("brak lub nieznany werdykt zawsze zamyka bramkę fail-closed", () => {
  assert.equal(parseVerifyVerdict("wygląda dobrze").pass, false);
  assert.equal(parseReviewVerdict(factory({ verdict: "unknown" })).needsFix, true);
  assert.equal(parseReviewVerdict(factory({ verdict: "lgtm" })).needsFix, false);
});

test("formatClarifyQuestions formatuje pytania zlepione w jednej linii", () => {
  assert.equal(
    formatClarifyQuestions("1. Czy wdrożyć zmianę? A) tak B) nie C) później (REKOMENDACJA)"),
    [
      "1. **Czy wdrożyć zmianę?**",
      "",
      "- A) tak",
      "- B) nie",
      "- C) później — **REKOMENDACJA**",
    ].join("\n"),
  );
});

test("formatClarifyQuestions normalizuje pytania wieloliniowe", () => {
  const raw = [
    "1. Czy wdrożyć zmianę?",
    "A) tak",
    "B) nie",
    "C) później (REKOMENDACJA)",
  ].join("\n");

  assert.equal(
    formatClarifyQuestions(raw),
    [
      "1. **Czy wdrożyć zmianę?**",
      "",
      "- A) tak",
      "- B) nie",
      "- C) później — **REKOMENDACJA**",
    ].join("\n"),
  );
});

test("formatClarifyQuestions wyróżnia rekomendację przy dowolnej opcji", () => {
  for (const recommended of ["A", "B", "C"]) {
    const raw = `1. Którą opcję wybrać? A) pierwszą${recommended === "A" ? " (rekomendacja)" : ""} ` +
      `B) drugą${recommended === "B" ? " (rekomendacja)" : ""} ` +
      `C) trzecią${recommended === "C" ? " (rekomendacja)" : ""}`;
    const formatted = formatClarifyQuestions(raw);

    assert.match(formatted, new RegExp(`- ${recommended}\\) [^\\n]+ — \\*\\*REKOMENDACJA\\*\\*`));
    assert.equal((formatted.match(/\*\*REKOMENDACJA\*\*/g) ?? []).length, 1);
  }
});

test("formatClarifyQuestions zachowuje preambułę przed listą pytań", () => {
  const raw = [
    "PLAN: BLOCKED",
    "## Pytania do autora ticketu",
    "",
    "1. Czy wdrożyć zmianę? A) tak (REKOMENDACJA) B) nie C) później",
  ].join("\n");

  assert.equal(
    formatClarifyQuestions(raw),
    [
      "PLAN: BLOCKED",
      "## Pytania do autora ticketu",
      "",
      "1. **Czy wdrożyć zmianę?**",
      "",
      "- A) tak — **REKOMENDACJA**",
      "- B) nie",
      "- C) później",
    ].join("\n"),
  );
});

test("formatClarifyQuestions nie zmienia tekstu bez rozpoznawalnych opcji", () => {
  const raw = "Planner potrzebuje dodatkowych informacji od autora ticketu.";
  assert.equal(formatClarifyQuestions(raw), raw);
});

test("formatClarifyQuestions obsługuje pusty tekst", () => {
  assert.equal(formatClarifyQuestions(""), "");
});
