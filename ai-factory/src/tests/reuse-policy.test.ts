import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TicketState } from "../pipeline/run-registry";
import {
  approvalMatchesInput,
  decideMergeReopenOutcome,
  lostRunReapprovalAt,
} from "../sources/reuse-policy";

test("nowy effectiveInputHash unieważnia zatwierdzony plan", () => {
  assert.equal(
    approvalMatchesInput(
      { approved: true, effectiveInputHash: "old" },
      "bez zmian",
      "new",
      []
    ),
    false
  );
  assert.equal(
    approvalMatchesInput(
      { approved: true, effectiveInputHash: "same" },
      "bez zmian",
      "same",
      []
    ),
    true
  );
});

test("utracony run wymaga świeżej, ścisłej komendy /approve", () => {
  const lostAt = "2026-07-28T10:00:00.000Z";
  const comments = [
    { body: "/approve", createdAt: "2026-07-28T09:00:00.000Z" },
    { body: "approve", createdAt: "2026-07-28T11:00:00.000Z" },
    { body: "/approve", createdAt: "2026-07-28T12:00:00.000Z" },
  ];
  assert.equal(lostRunReapprovalAt(comments, lostAt), "2026-07-28T12:00:00.000Z");
  assert.equal(lostRunReapprovalAt(comments.slice(0, 2), lostAt), undefined);
});

test("legacy approval jest ważny tylko bez nowszych komentarzy autora", () => {
  const description = "opis";
  const descriptionHash = createHash("sha256").update(description).digest("hex");
  assert.equal(
    approvalMatchesInput(
      { approved: true, at: "2026-07-28T10:00:00.000Z", descriptionHash },
      description,
      "ignored",
      [{ body: "wcześniej", createdAt: "2026-07-28T09:00:00.000Z" }]
    ),
    true
  );
  assert.equal(
    approvalMatchesInput(
      { approved: true, at: "2026-07-28T10:00:00.000Z", descriptionHash },
      description,
      "ignored",
      [{ body: "nowy scope", createdAt: "2026-07-28T11:00:00.000Z" }]
    ),
    false
  );
});

test("reopen po merge bez zmiany wejścia nie uruchamia pustego buildera", () => {
  const state = {
    mergeHandledAt: "2026-07-28T10:00:00.000Z",
    finalized: { outcome: "success", at: "2026-07-28T10:00:00.000Z" },
  } as TicketState;

  assert.equal(decideMergeReopenOutcome(state, "same", "same"), "no-scope");
  assert.equal(decideMergeReopenOutcome(state, "new", "same"), "proceed");
  assert.equal(decideMergeReopenOutcome(undefined, "same", "same"), "proceed");
});
