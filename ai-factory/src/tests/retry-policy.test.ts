import test from "node:test";
import assert from "node:assert/strict";
import {
  backoffAt,
  classifyDispatchError,
  maxDispatchAttempts,
} from "../pipeline/retry-policy";
import { MastraHttpError } from "../sources/mastra-client";

test("klasyfikacja: 5xx/429/sieć/timeout są transient, walidacja jest permanent", () => {
  assert.equal(classifyDispatchError(new MastraHttpError(503, "/workflows", "boom")), "transient");
  assert.equal(classifyDispatchError(new MastraHttpError(429, "/workflows", "rate")), "transient");
  assert.equal(classifyDispatchError(new MastraHttpError(400, "/workflows", "bad input")), "permanent");
  assert.equal(classifyDispatchError(new MastraHttpError(404, "/runs/x", "missing")), "permanent");
  assert.equal(classifyDispatchError(new Error("connect ECONNREFUSED 127.0.0.1:4111")), "transient");
  assert.equal(classifyDispatchError(new Error("Request timed out after 30000ms")), "transient");
  const abort = new Error("This operation was aborted");
  abort.name = "AbortError";
  assert.equal(classifyDispatchError(abort), "transient");
  const fetchFailed = new TypeError("fetch failed");
  (fetchFailed as { cause?: unknown }).cause = new Error("getaddrinfo ENOTFOUND api.linear.app");
  assert.equal(classifyDispatchError(fetchFailed), "transient");
  assert.equal(classifyDispatchError(new Error("Publish wymaga branch, SHA i konfiguracji GitHub.")), "permanent");
  assert.equal(classifyDispatchError("string error"), "permanent");
});

test("maxDispatchAttempts: transient ma wyższy limit, env nadpisuje", () => {
  const previous = process.env.FACTORY_OUTBOX_MAX_TRANSIENT;
  try {
    delete process.env.FACTORY_OUTBOX_MAX_TRANSIENT;
    assert.equal(maxDispatchAttempts("transient"), 8);
    assert.equal(maxDispatchAttempts("permanent"), 2);
    process.env.FACTORY_OUTBOX_MAX_TRANSIENT = "3";
    assert.equal(maxDispatchAttempts("transient"), 3);
  } finally {
    if (previous === undefined) delete process.env.FACTORY_OUTBOX_MAX_TRANSIENT;
    else process.env.FACTORY_OUTBOX_MAX_TRANSIENT = previous;
  }
});

test("backoff rośnie wykładniczo z jitterem i jest ograniczony do 30 minut", () => {
  const from = new Date("2026-07-29T00:00:00Z");
  const delayMs = (attempts: number) => Date.parse(backoffAt(attempts, from)) - from.getTime();
  const first = delayMs(1);
  assert.ok(first >= 30_000 && first <= 39_000, `attempt 1: ${first}`);
  const third = delayMs(3);
  assert.ok(third >= 120_000 && third <= 156_000, `attempt 3: ${third}`);
  const capped = delayMs(20);
  assert.ok(capped >= 30 * 60_000 && capped <= 39 * 60_000, `attempt 20: ${capped}`);
});
