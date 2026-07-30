import test from "node:test";
import assert from "node:assert/strict";
import {
  CRITIQUE_MEANING_CLIP_CHARS,
  CRITIQUE_MEANING_HEADING,
  HUMAN_SUMMARY_HEADING,
  critiqueMeaningOf,
  extractSection,
  humanSummaryOf,
  stripSection,
} from "../pipeline/human-summary";

test("extractSection zwraca ciało jawnej sekcji bez następnego nagłówka", () => {
  const report = [
    "## Podsumowanie dla człowieka",
    "",
    "**Co dostaniesz** — szybszy start.",
    "",
    "**Dlaczego tak** — usuwamy zbędne oczekiwanie.",
    "",
    "## Zakres",
    "",
    "Techniczna treść.",
  ].join("\n");

  const section = extractSection(report, HUMAN_SUMMARY_HEADING);
  assert.equal(
    section?.body,
    "**Co dostaniesz** — szybszy start.\n\n**Dlaczego tak** — usuwamy zbędne oczekiwanie."
  );
  assert.equal(humanSummaryOf(report), section?.body);
});

test("brak i nierozpoznane warianty nagłówka są traktowane jako brak sekcji", () => {
  const malformed = [
    "Plan bez streszczenia.",
    "## Podsumowanie dla czlowieka\nTreść",
    "**Podsumowanie dla człowieka**\nTreść",
    "Akapit z ## Podsumowanie dla człowieka pośrodku.",
  ];

  for (const report of malformed) {
    assert.equal(humanSummaryOf(report), undefined, report);
  }
});

test("blok factory kończy sekcję streszczenia", () => {
  const report = [
    "## Podsumowanie dla człowieka",
    "",
    "**Co dostaniesz** — efekt.",
    "",
    "```factory",
    '{"verdict":"ok","screenshots":[],"files":["src/a.ts"],"domain":"backend"}',
    "```",
  ].join("\n");

  assert.equal(humanSummaryOf(report), "**Co dostaniesz** — efekt.");
  assert.doesNotMatch(humanSummaryOf(report) ?? "", /verdict/);
});

test("pusta sekcja jest traktowana jak brak", () => {
  const report = "## Podsumowanie dla człowieka\n \n\t\n## Zakres\nTreść";
  assert.equal(extractSection(report, HUMAN_SUMMARY_HEADING), undefined);
  assert.equal(humanSummaryOf(report), undefined);
});

test("stripSection usuwa tylko rozpoznaną sekcję i zachowuje resztę raportu", () => {
  const report = [
    "# Plan",
    "",
    "## Podsumowanie dla człowieka",
    "",
    "Krótko po ludzku.",
    "",
    "## Zakres",
    "",
    "Pełny plan.",
    "",
    "```factory",
    '{"verdict":"ok","screenshots":[],"files":["src/a.ts"],"domain":"backend"}',
    "```",
  ].join("\n");
  const expected = [
    "# Plan",
    "",
    "## Zakres",
    "",
    "Pełny plan.",
    "",
    "```factory",
    '{"verdict":"ok","screenshots":[],"files":["src/a.ts"],"domain":"backend"}',
    "```",
  ].join("\n");

  assert.equal(stripSection(report, HUMAN_SUMMARY_HEADING), expected);
  assert.equal(stripSection(report, "Nieistniejąca sekcja"), report);
});

test("critiqueMeaningOf spłaszcza wieloliniową sekcję do jednego zdania i clipuje", () => {
  const multiline = [
    `## ${CRITIQUE_MEANING_HEADING}`,
    "",
    "Plan może przejść testy,",
    "ale nie potwierdza efektu dla autora.",
    "",
    "## Uwagi",
    "1. Brak kryterium.",
  ].join("\n");
  assert.equal(
    critiqueMeaningOf(multiline),
    "Plan może przejść testy, ale nie potwierdza efektu dla autora."
  );

  const oversized = `## ${CRITIQUE_MEANING_HEADING}\n\n${"x".repeat(700)}`;
  const clipped = critiqueMeaningOf(oversized);
  assert.equal(clipped?.length, CRITIQUE_MEANING_CLIP_CHARS);
  assert.match(clipped ?? "", /…$/);
});
