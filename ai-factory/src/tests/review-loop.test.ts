import test from "node:test";
import assert from "node:assert/strict";
import { noteKeys, noteOverlap } from "../pipeline/ticket-pipeline";

test("detektor oscylacji rozpoznaje tę samą uwagę po zmianie numeru linii", () => {
  const first = noteKeys("- src/a.ts:12 — Brak obsługi błędu odpowiedzi API w tej funkcji");
  const second = noteKeys("- src/a.ts:87 — W tej funkcji nadal brak obsługi błędu odpowiedzi API");
  assert.ok(noteOverlap(first, second) >= 0.6);
});
