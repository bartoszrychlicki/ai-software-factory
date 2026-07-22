import type { Route, Stage } from "./routing";

export type ActionProfile = "planner" | "builder" | "verifier" | "reviewer";

export interface ActionSignature {
  agent: string;
  harness: string;
  model: string;
  profile: ActionProfile;
}

const PROFILE_BY_STAGE: Record<Stage, ActionProfile> = {
  plan: "planner",
  build: "builder",
  verify: "verifier",
  review: "reviewer",
};

export function buildSignature(stage: Stage, route: Route): ActionSignature {
  return {
    agent: "ai-factory",
    harness: route.engine.name,
    model: route.model ?? "(domyślny CLI)",
    profile: PROFILE_BY_STAGE[stage],
  };
}

export function signatureTrailer(signature: ActionSignature): string {
  return [
    `Agent: ${signature.agent}`,
    `Harness: ${signature.harness}`,
    `Model: ${signature.model}`,
    `Profile: ${signature.profile}`,
  ].join("\n");
}

export function signatureLine(signature: ActionSignature): string {
  return `${signature.agent} · ${signature.harness} · ${signature.model} · ${signature.profile}`;
}

export function signatureMeta(signature: ActionSignature): Record<string, string> {
  return {
    agent: signature.agent,
    harness: signature.harness,
    model: signature.model,
    profile: signature.profile,
  };
}
