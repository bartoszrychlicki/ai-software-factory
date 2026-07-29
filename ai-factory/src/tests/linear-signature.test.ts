import test from "node:test";
import assert from "node:assert/strict";
import { LinearSource } from "../sources/linear";
import {
  POLLER_SIGNATURE,
  signatureFooter,
  signatureHeader,
  type ActionSignature,
} from "../pipeline/signature";

async function captureCommentBody(
  body: string,
  signature?: ActionSignature,
): Promise<string> {
  const originalFetch = globalThis.fetch;
  let sentBody: string | undefined;

  globalThis.fetch = (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: { input?: { body?: string } };
    };

    if (request.query.includes("commentCreate")) {
      sentBody = request.variables?.input?.body;
      return new Response(JSON.stringify({
        data: { commentCreate: { success: true } },
      }));
    }

    return new Response(JSON.stringify({
      data: { issue: { id: "issue-uuid" } },
    }));
  }) as typeof fetch;

  try {
    await new LinearSource("test-key", "pilot-app").comment("BAR-168", body, signature);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(sentBody);
  return sentBody;
}

test("LinearSource.comment dokleja domyślny podpis pollera bez zmiany treści", async () => {
  const body = "🤖 komentarz [linear:BAR-168:v1]\n❓ Pytania do Ciebie (runda 1)";

  assert.equal(
    await captureCommentBody(body),
    body + signatureFooter(POLLER_SIGNATURE),
  );
});

test("LinearSource.comment dokleja przekazany podpis etapu", async () => {
  const signature: ActionSignature = {
    agent: "ai-factory",
    harness: "claude-code",
    model: "sonnet",
    profile: "planner",
  };
  const body = "📋 Plan gotowy";

  assert.equal(
    await captureCommentBody(body, signature),
    `${signatureHeader(signature)}\n\n${body}${signatureFooter(signature)}`,
  );
});

test("sygnatura joba AI jest pierwszą linią, a komentarz pollera nie dostaje nagłówka", async () => {
  const planner: ActionSignature = {
    agent: "ai-factory",
    harness: "codex@0.44",
    model: "gpt-5.6-terra@high",
    profile: "planner",
  };
  const jobBody = await captureCommentBody("❓ Pytania do planu", planner);
  const pollerBody = await captureCommentBody("🔁 Planowanie od nowa");

  assert.match(jobBody.split("\n")[0], /^🖋️ .+ · planner$/);
  assert.equal(pollerBody.split("\n")[0], "🔁 Planowanie od nowa");
});
