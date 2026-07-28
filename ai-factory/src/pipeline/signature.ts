import type { Route, Stage } from "./routing";

export type ActionProfile = "planner" | "builder" | "verifier" | "reviewer" | "orchestrator";

export interface ActionSignature {
  agent: string;
  harness: string;
  model: string;
  profile: ActionProfile;
}

export const POLLER_SIGNATURE: ActionSignature = {
  agent: "ai-factory",
  harness: "poller",
  model: "—",
  profile: "orchestrator",
};

const ACTION_PROFILES = {
  planner: true,
  builder: true,
  verifier: true,
  reviewer: true,
  orchestrator: true,
} satisfies Record<ActionProfile, true>;

const PROFILE_BY_STAGE: Record<Stage, ActionProfile> = {
  plan: "planner",
  build: "builder",
  verify: "verifier",
  review: "reviewer",
};

export function buildSignature(stage: Stage, route: Route): ActionSignature {
  // harness niesie wersję CLI — regresja po cichym auto-update harnessu jest
  // widoczna w metrykach i grepowalna w podpisach commitów/PR-ów.
  const harness = route.cliVersion && route.cliVersion !== "unknown"
    ? `${route.engine.name}@${route.cliVersion}`
    : route.engine.name;
  return {
    agent: "ai-factory",
    harness,
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

export function signatureFooter(signature: ActionSignature): string {
  return `\n\n> 🖋️ ${signatureLine(signature)}`;
}

export function signatureMeta(signature: ActionSignature): Record<string, string> {
  return {
    agent: signature.agent,
    harness: signature.harness,
    model: signature.model,
    profile: signature.profile,
  };
}

export function parseSignatureMeta(raw: string): ActionSignature | undefined {
  const header = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!header) return undefined;

  const field = (name: string) =>
    header.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
  const agent = field("agent");
  const harness = field("harness");
  const model = field("model");
  const profile = field("profile");

  if (
    !agent ||
    !harness ||
    !model ||
    !profile ||
    !Object.prototype.hasOwnProperty.call(ACTION_PROFILES, profile)
  ) {
    return undefined;
  }

  return {
    agent,
    harness,
    model,
    profile: profile as ActionProfile,
  };
}
