export type OpenGateName =
  | "score"
  | "blocked"
  | "ops-checklist"
  | "plan-approval"
  | "clarify"
  | "merge"
  | null;

export interface OpenGateInput {
  stage: string;
  status: string;
  errorCode?: string;
  planDomain?: string;
  approvedAt?: string;
  reviewStatus?: string;
  fixRound?: number;
  mergedSha?: string;
}

export interface OpenGateView {
  gate: OpenGateName;
  waitingOn: "human" | "factory";
  humanCommands: string[];
}

/** Jedno źródło prawdy o otwartej bramce i komendach dostępnych wyłącznie człowiekowi. */
export function openGate(run: OpenGateInput): OpenGateView {
  if (run.status === "done") {
    return {
      gate: "score",
      waitingOn: "human",
      humanCommands: ["/score 1-5 [komentarz]"],
    };
  }
  if (run.status === "blocked") {
    const humanCommands = ["/retry", "/replan <powód>"];
    if (run.errorCode === "SCOPE_BLOCKED") humanCommands.push("/scope <ścieżka>");
    return { gate: "blocked", waitingOn: "human", humanCommands };
  }
  if (
    run.stage === "approval" &&
    run.status === "waiting_human" &&
    run.planDomain === "ops" &&
    run.approvedAt
  ) {
    return {
      gate: "ops-checklist",
      waitingOn: "human",
      humanCommands: ["/done"],
    };
  }
  if (run.stage === "approval" && run.status === "waiting_human") {
    return {
      gate: "plan-approval",
      waitingOn: "human",
      humanCommands: ["/approve", "/reject <powód>"],
    };
  }
  if (
    ["plan", "triage", "synthesis"].includes(run.stage) &&
    run.status === "waiting_human"
  ) {
    return {
      gate: "clarify",
      waitingOn: "human",
      humanCommands: ["/answer <odpowiedzi>"],
    };
  }
  if (run.stage === "merge" && run.status === "waiting_human") {
    if (run.mergedSha) {
      return {
        gate: "score",
        waitingOn: "human",
        humanCommands: ["/score 1-5"],
      };
    }
    const humanCommands = ["/replan <powód>", "/score 1-5"];
    if (run.reviewStatus === "advisory-fix" && (run.fixRound ?? 0) < 2) {
      humanCommands.unshift("/fix [wskazówki]");
    }
    return { gate: "merge", waitingOn: "human", humanCommands };
  }
  return {
    gate: null,
    waitingOn: run.status === "waiting_human" ? "human" : "factory",
    humanCommands: [],
  };
}
