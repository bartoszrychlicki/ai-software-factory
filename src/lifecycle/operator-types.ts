/** Shared lifecycle vocabulary used by the active runtime and the v1 reader. */
export type FactoryPhase =
  | "planning"
  | "questions"
  | "plan-approval"
  | "ops-checklist"
  | "build"
  | "verify"
  | "review"
  | "pr-ready"
  | "blocked";

export type Gate = "claim" | "plan-approval" | "clarify" | "ops-checklist";
export type DecisionKind = "start" | "approve" | "reject" | "answer" | "done";
