import test from "node:test";
import assert from "node:assert/strict";
import type { EngineAdapter } from "../engines/types";
import { artifactHeader } from "../pipeline/artifacts";
import type { Route, Stage } from "../pipeline/routing";
import {
  buildSignature,
  signatureLine,
  signatureMeta,
  signatureTrailer,
} from "../pipeline/signature";

const engine: EngineAdapter = {
  name: "codex",
  run: async () => ({ ok: true, report: "ok" }),
};

const route = (model?: string): Route => ({
  engine,
  model,
  spec: model ? `${engine.name}/${model}` : engine.name,
});

test("buildSignature mapuje każdy etap na właściwy profil", () => {
  const profiles: Record<Stage, string> = {
    plan: "planner",
    build: "builder",
    verify: "verifier",
    review: "reviewer",
  };

  for (const [stage, profile] of Object.entries(profiles) as [Stage, string][]) {
    assert.deepEqual(buildSignature(stage, route("gpt-5.6-sol")), {
      agent: "ai-factory",
      harness: "codex",
      model: "gpt-5.6-sol",
      profile,
    });
  }
});

test("buildSignature jawnie oznacza model domyślny CLI", () => {
  assert.equal(buildSignature("build", route()).model, "(domyślny CLI)");
});

test("formaty podpisu są stabilne i grepowalne", () => {
  const signature = buildSignature("build", route("gpt-5.6-sol"));

  assert.equal(
    signatureTrailer(signature),
    [
      "Agent: ai-factory",
      "Harness: codex",
      "Model: gpt-5.6-sol",
      "Profile: builder",
    ].join("\n"),
  );
  assert.equal(signatureLine(signature), "ai-factory · codex · gpt-5.6-sol · builder");
  assert.deepEqual(signatureMeta(signature), {
    agent: "ai-factory",
    harness: "codex",
    model: "gpt-5.6-sol",
    profile: "builder",
  });
});

test("signatureMeta rozszerza nagłówek YAML artefaktu", () => {
  const header = artifactHeader({
    step: "build",
    ...signatureMeta(buildSignature("build", route("gpt-5.6-sol"))),
  });

  assert.match(header, /\nagent: ai-factory\n/);
  assert.match(header, /\nharness: codex\n/);
  assert.match(header, /\nmodel: gpt-5\.6-sol\n/);
  assert.match(header, /\nprofile: builder\n/);
});
