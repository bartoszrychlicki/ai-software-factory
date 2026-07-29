import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCommentContextSnapshot,
  extractRelevantComments,
} from "../sources/comment-context";

test("kontekst intake zachowuje komentarze autora, ale odrzuca audit i komendy sterujące", () => {
  const comments = [
    { body: "Pierwsza decyzja", createdAt: "2026-07-28T08:00:00.000Z" },
    { body: "🤖 start [linear:BAR-168:v1]", createdAt: "2026-07-28T08:01:00.000Z" },
    { body: "/approve", createdAt: "2026-07-28T08:02:00.000Z" },
    { body: "/answer 1A, podpis także w pytaniach", createdAt: "2026-07-28T08:03:00.000Z" },
    { body: "/reject brakuje testu regresji", createdAt: "2026-07-28T08:04:00.000Z" },
    { body: "/restart", createdAt: "2026-07-28T08:05:00.000Z" },
  ];

  assert.deepEqual(extractRelevantComments(comments, "BAR-168"), [
    { body: "Pierwsza decyzja", createdAt: "2026-07-28T08:00:00.000Z" },
    { body: "1A, podpis także w pytaniach", createdAt: "2026-07-28T08:03:00.000Z" },
    { body: "brakuje testu regresji", createdAt: "2026-07-28T08:04:00.000Z" },
  ]);
});

test("snapshot jest deterministyczny, zachowuje najnowsze komentarze i zmienia hash wejścia", () => {
  const base = [
    { body: "stara decyzja", createdAt: "2026-07-28T08:00:00.000Z" },
    { body: "nowsza decyzja", createdAt: "2026-07-28T09:00:00.000Z" },
    { body: "najnowsza decyzja", createdAt: "2026-07-28T10:00:00.000Z" },
  ];
  const first = buildCommentContextSnapshot(
    "BAR-168",
    "Podpisy agentów",
    "Opis",
    base,
    { maxComments: 2, maxChars: 10_000 }
  );
  const same = buildCommentContextSnapshot(
    "BAR-168",
    "Podpisy agentów",
    "Opis",
    [...base].reverse(),
    { maxComments: 2, maxChars: 10_000 }
  );
  const changed = buildCommentContextSnapshot(
    "BAR-168",
    "Podpisy agentów",
    "Opis",
    [...base, { body: "rozszerz scope", createdAt: "2026-07-28T11:00:00.000Z" }],
    { maxComments: 2, maxChars: 10_000 }
  );

  assert.equal(first.truncated, true);
  assert.doesNotMatch(first.context, /stara decyzja/);
  assert.match(first.context, /nowsza decyzja/);
  assert.match(first.context, /najnowsza decyzja/);
  assert.equal(first.effectiveInputHash, same.effectiveInputHash);
  assert.notEqual(first.effectiveInputHash, changed.effectiveInputHash);
});

test("nieudane próby komend nie zmieniają snapshotu ani effectiveInputHash", () => {
  const withoutComments = buildCommentContextSnapshot(
    "BAR-184",
    "Bramki odporne na literówki",
    "Opis",
    []
  );
  const withTypo = buildCommentContextSnapshot(
    "BAR-184",
    "Bramki odporne na literówki",
    "Opis",
    [{ body: "/anwser cokolwiek", createdAt: "2026-07-29T10:00:00.000Z" }]
  );
  const withInvalidPayload = buildCommentContextSnapshot(
    "BAR-184",
    "Bramki odporne na literówki",
    "Opis",
    [{ body: "/approve tak", createdAt: "2026-07-29T10:00:00.000Z" }]
  );

  assert.equal(withTypo.effectiveInputHash, withoutComments.effectiveInputHash);
  assert.equal(withInvalidPayload.effectiveInputHash, withoutComments.effectiveInputHash);
  assert.deepEqual(withTypo.comments, []);
  assert.deepEqual(withInvalidPayload.comments, []);
});

test("zwykły komentarz i ścieżka pliku pozostają treścią planistyczną", () => {
  const withoutComments = buildCommentContextSnapshot(
    "BAR-184",
    "Bramki odporne na literówki",
    "Opis",
    []
  );
  const ordinary = buildCommentContextSnapshot(
    "BAR-184",
    "Bramki odporne na literówki",
    "Opis",
    [{ body: "Dodaj też test regresji", createdAt: "2026-07-29T10:00:00.000Z" }]
  );
  const filePath = buildCommentContextSnapshot(
    "BAR-184",
    "Bramki odporne na literówki",
    "Opis",
    [{ body: "/src/x.ts wymaga poprawki", createdAt: "2026-07-29T10:01:00.000Z" }]
  );

  assert.notEqual(ordinary.effectiveInputHash, withoutComments.effectiveInputHash);
  assert.notEqual(filePath.effectiveInputHash, withoutComments.effectiveInputHash);
  assert.equal(ordinary.comments[0]?.body, "Dodaj też test regresji");
  assert.equal(filePath.comments[0]?.body, "/src/x.ts wymaga poprawki");
});
