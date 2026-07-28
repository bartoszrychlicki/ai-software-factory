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
