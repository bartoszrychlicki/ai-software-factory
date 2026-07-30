import test from "node:test";
import assert from "node:assert/strict";
import {
  isCommandAttempt,
  unknownCommandHint,
} from "../sources/commands";
import { signatureHeader } from "../pipeline/signature";

test("hint pokazuje komendy adekwatne do approval, pytań i blokady", () => {
  assert.match(
    unknownCommandHint({
      firstToken: "/aprove",
      stage: "approval",
      status: "waiting_human",
    }),
    /`\/approve`.*`\/reject <powód>`/
  );
  assert.match(
    unknownCommandHint({
      firstToken: "/anwser",
      stage: "plan",
      status: "waiting_human",
    }),
    /`\/answer <odpowiedzi>`/
  );
  assert.match(
    unknownCommandHint({
      firstToken: "/rettry",
      stage: "test",
      status: "blocked",
      blockedStage: "test",
    }),
    /`\/retry`.*`\/replan <powód>`/
  );
});

test("hint obejmuje checklistę ops, score po Done i stan bez otwartej bramki", () => {
  assert.match(
    unknownCommandHint({
      firstToken: "/dne",
      stage: "approval",
      status: "waiting_human",
      planDomain: "ops",
      approvedAt: "2026-07-29T10:00:00.000Z",
    }),
    /`\/done`/
  );
  assert.match(
    unknownCommandHint({
      firstToken: "/scroe",
      stage: "smoke",
      status: "done",
    }),
    /`\/score 1-5 \[komentarz\]`/
  );
  assert.match(
    unknownCommandHint({
      firstToken: "/aprove",
      stage: "build",
      status: "running",
    }),
    /Żadna komenda decyzyjna nie jest teraz otwarta/
  );
});

test("isCommandAttempt odróżnia ścisły token komendy od treści i ścieżek", () => {
  assert.equal(isCommandAttempt("/anwser cokolwiek"), true);
  assert.equal(isCommandAttempt("  /approve tak"), true);
  assert.equal(isCommandAttempt("/score 9"), true);
  assert.equal(isCommandAttempt("/`approve`"), true);
  assert.equal(isCommandAttempt("/src/x.ts wymaga poprawki"), false);
  assert.equal(isCommandAttempt("Sprawdź /answer w dokumentacji"), false);
  assert.equal(isCommandAttempt("https://example.test/path"), false);
});

test("hint dla autoformatu Lineara używa bezpiecznego code spanu bez trzech backticków", () => {
  const hint = unknownCommandHint({
    firstToken: "/`approve`",
    stage: "approval",
    status: "waiting_human",
  });

  assert.match(hint, /`` \/`approve` ``/);
  assert.doesNotMatch(hint, /```/);
  assert.match(hint, /`approve`.*`\/approve`/);
});

test("krótka sygnatura joba AI ma format nagłówka pierwszej linii", () => {
  assert.match(
    signatureHeader({
      agent: "ai-factory",
      harness: "codex@0.44",
      model: "gpt-5.6-terra@high",
      profile: "planner",
    }),
    /^🖋️ .+ · planner$/
  );
});
