import test from "node:test";
import assert from "node:assert/strict";
import {
  isCommandAttempt,
  parseCommand,
  unknownCommandHint,
} from "../sources/commands";
import { signatureHeader } from "../pipeline/signature";

test("parser toleruje autoformat Lineara wyłącznie na tokenie komendy", () => {
  for (const body of [
    "/`approve`",
    "/*approve*",
    "/**approve**",
    "/_approve_",
    "/~approve~",
    "/approve.",
    "/`approve`.",
    "/approve!",
  ]) {
    assert.deepEqual(parseCommand(body), { kind: "approve", payload: undefined });
  }

  assert.deepEqual(parseCommand("/`reject` za szeroki"), {
    kind: "reject",
    payload: "za szeroki",
  });
  assert.deepEqual(parseCommand("/`answer` 1A"), {
    kind: "answer",
    payload: "1A",
  });
  assert.deepEqual(parseCommand("/`answer` 1`A`"), {
    kind: "answer",
    payload: "1`A`",
  });
  assert.deepEqual(parseCommand("/`score` 4 solidny plan"), {
    kind: "score",
    payload: "4 solidny plan",
  });
});

test("parser nie zgaduje komend bez ukośnika ani nieznanych nazw", () => {
  for (const body of [
    "approve",
    "restart fabryki pomógł",
    "score 5 gwiazdek",
    "/restartuj",
    "proszę /restart",
  ]) {
    assert.equal(parseCommand(body), undefined);
  }

  for (const body of [
    "approve",
    "restart fabryki pomógł",
    "score 5 gwiazdek",
    "restartuj",
    "proszę restart",
  ]) {
    assert.equal(isCommandAttempt(body), false);
  }
});

test("autoformatowana nieznana komenda pozostaje próbą i ma czysty hint", () => {
  assert.equal(isCommandAttempt("/`nieznane`"), true);
  const hint = unknownCommandHint({
    firstToken: "/`nieznane`",
    stage: "approval",
    status: "waiting_human",
  });
  assert.match(hint, /^ℹ️ Nieznana komenda `\/nieznane`\./);
  assert.doesNotMatch(hint, /Nieznana komenda `\/`nieznane``\./);
});

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

test("hint bramki merge rozróżnia aktywny /fix, limit, lgtm i stan po merge", () => {
  const available = unknownCommandHint({
    firstToken: "/fiz",
    stage: "merge",
    status: "waiting_human",
    reviewStatus: "advisory-fix",
    fixRound: 1,
  });
  assert.match(available, /`\/fix \[wskazówki\]` \(poprawka 2\/2\)/);
  assert.match(available, /`\/replan <powód>`.*`\/score 1-5`/);

  const exhausted = unknownCommandHint({
    firstToken: "/fiz",
    stage: "merge",
    status: "waiting_human",
    reviewStatus: "advisory-fix",
    fixRound: 2,
  });
  assert.match(exhausted, /Limit `\/fix` wyczerpany \(2\/2\)/);
  assert.doesNotMatch(exhausted, /`\/fix \[wskazówki\]`/);

  const lgtm = unknownCommandHint({
    firstToken: "/fiz",
    stage: "merge",
    status: "waiting_human",
    reviewStatus: "lgtm",
    fixRound: 0,
  });
  assert.match(lgtm, /Review: lgtm — `\/fix` niedostępny/);
  assert.match(lgtm, /Merge robisz w GitHubie/);

  const merged = unknownCommandHint({
    firstToken: "/fiz",
    stage: "merge",
    status: "waiting_human",
    reviewStatus: "advisory-fix",
    fixRound: 0,
    mergedSha: "a".repeat(40),
  });
  assert.match(merged, /PR zmergowany.*`\/score 1-5`/);
  assert.doesNotMatch(merged, /`\/fix \[wskazówki\]`/);
});

test("isCommandAttempt odróżnia ścisły token komendy od treści i ścieżek", () => {
  assert.equal(isCommandAttempt("/anwser cokolwiek"), true);
  assert.equal(isCommandAttempt("  /approve tak"), true);
  assert.equal(isCommandAttempt("/score 9"), true);
  assert.equal(isCommandAttempt("/src/x.ts wymaga poprawki"), false);
  assert.equal(isCommandAttempt("Sprawdź /answer w dokumentacji"), false);
  assert.equal(isCommandAttempt("https://example.test/path"), false);
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
