import test from "node:test";
import assert from "node:assert/strict";
import { planFileCollisions } from "../pipeline/serialization";
import type { LifecycleRun } from "../pipeline/lifecycle-store";

function makeRun(overrides: Partial<LifecycleRun> & { ticketId: string }): LifecycleRun {
  return {
    project: "demo",
    generation: 1,
    stage: "build",
    status: "running",
    manifest: { title: "t", description: "d", labels: [], inputHash: "h" },
    planFiles: [],
    clarifyRound: 0,
    critiqueRound: 0,
    approvedAt: "2026-07-29T10:00:00Z",
    createdAt: "2026-07-29T09:00:00Z",
    updatedAt: "2026-07-29T09:00:00Z",
    ...overrides,
  };
}

test("kolizja plikowa: overlap i wildcard trzymają, rozłączne pliki nie", () => {
  const candidate = makeRun({ ticketId: "B", planFiles: ["src/a.ts", "src/b.ts"], approvedAt: "2026-07-29T11:00:00Z" });
  const holder = makeRun({ ticketId: "A", stage: "ci", status: "waiting_external", planFiles: ["src/b.ts"] });
  assert.deepEqual(planFileCollisions(candidate, [holder]), [{ ticketId: "A", files: ["src/b.ts"] }]);

  const disjoint = makeRun({ ticketId: "C", stage: "ci", status: "waiting_external", planFiles: ["src/c.ts"] });
  assert.deepEqual(planFileCollisions(candidate, [disjoint]), []);

  const wildcard = makeRun({ ticketId: "D", stage: "test", status: "pending", planFiles: [] });
  assert.deepEqual(planFileCollisions(candidate, [wildcard]), [{ ticketId: "D", files: ["*"] }]);
});

test("nie trzymają: inny projekt, niezatwierdzony, zablokowany, plan/approval", () => {
  const candidate = makeRun({ ticketId: "B", planFiles: ["src/a.ts"], approvedAt: "2026-07-29T11:00:00Z" });
  const otherProject = makeRun({ ticketId: "A", project: "inny", planFiles: ["src/a.ts"] });
  const unapproved = makeRun({ ticketId: "C", planFiles: ["src/a.ts"], approvedAt: undefined });
  const blocked = makeRun({ ticketId: "D", planFiles: ["src/a.ts"], status: "blocked" });
  const planning = makeRun({ ticketId: "E", planFiles: ["src/a.ts"], stage: "plan", status: "running" });
  assert.deepEqual(planFileCollisions(candidate, [otherProject, unapproved, blocked, planning]), []);
});

test("tie-break dwóch buildów: wcześniejsza aprobata jedzie, późniejsza czeka — bez deadlocka", () => {
  const early = makeRun({ ticketId: "A", planFiles: ["src/x.ts"], approvedAt: "2026-07-29T10:00:00Z" });
  const late = makeRun({ ticketId: "B", planFiles: ["src/x.ts"], approvedAt: "2026-07-29T10:05:00Z" });
  assert.deepEqual(planFileCollisions(late, [early]).map((c) => c.ticketId), ["A"]);
  assert.deepEqual(planFileCollisions(early, [late]), []);

  // Remis czasowy: niższy ticketId wygrywa.
  const twinA = makeRun({ ticketId: "A", planFiles: ["src/x.ts"] });
  const twinB = makeRun({ ticketId: "B", planFiles: ["src/x.ts"] });
  assert.equal(planFileCollisions(twinB, [twinA]).length, 1);
  assert.equal(planFileCollisions(twinA, [twinB]).length, 0);

  // Holder dalej w pipeline (test/ci) trzyma niezależnie od kolejności aprobat.
  const laterButAhead = makeRun({ ticketId: "C", stage: "ci", status: "waiting_external", planFiles: ["src/x.ts"], approvedAt: "2026-07-29T12:00:00Z" });
  assert.equal(planFileCollisions(early, [laterButAhead]).length, 1);
});
