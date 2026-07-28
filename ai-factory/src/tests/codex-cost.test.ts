import test from "node:test";
import assert from "node:assert/strict";
import { extractTokenUsage } from "../engines/codex";
import { estimateCostUsd } from "../engines/pricing";

test("extractTokenUsage bierze OSTATNI token_count ze strumienia --json", () => {
  const stdout = [
    "banner codex cli",
    JSON.stringify({ type: "session_start", info: {} }),
    JSON.stringify({ type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } } }),
    "not json line",
    JSON.stringify({ msg: { type: "token_count", info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 2000, output_tokens: 400 } } } }),
    JSON.stringify({ type: "turn_complete" }),
  ].join("\n");
  assert.deepEqual(extractTokenUsage(stdout), {
    input_tokens: 5000,
    cached_input_tokens: 2000,
    output_tokens: 400,
  });
  assert.equal(extractTokenUsage("no json at all"), undefined);
});

test("extractTokenUsage sumuje usage z turn.completed (realny strumień codex-cli 0.145)", () => {
  // Kształt zweryfikowany na żywym `codex exec --json` 2026-07-29.
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "019f" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "OK" } }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 22_356, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1_000, cached_input_tokens: 500, output_tokens: 50 },
    }),
  ].join("\n");
  assert.deepEqual(extractTokenUsage(stdout), {
    input_tokens: 23_356,
    cached_input_tokens: 500,
    output_tokens: 55,
  });
});

test("estimateCostUsd: najdłuższy prefiks modelu, cached taniej, brak modelu = undefined", () => {
  const usage = { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 };
  const base = estimateCostUsd("gpt-5.5-turbo", usage);
  const newer = estimateCostUsd("gpt-5.6-sol", usage);
  assert.ok(base !== undefined && newer !== undefined);
  assert.ok(newer > base, "gpt-5.6 ma wyższą stawkę niż gpt-5.5 w tabeli defaultowej");

  const cached = estimateCostUsd("gpt-5.6-sol", {
    input_tokens: 1_000_000,
    cached_input_tokens: 1_000_000,
    output_tokens: 0,
  });
  assert.ok(cached !== undefined && cached < newer, "pełny cache hit jest tańszy");

  assert.equal(estimateCostUsd(undefined, usage), undefined);
  assert.equal(estimateCostUsd("nieznany-model", usage), undefined);
});

test("FACTORY_PRICING_JSON nadpisuje tabelę cen", () => {
  const previous = process.env.FACTORY_PRICING_JSON;
  try {
    process.env.FACTORY_PRICING_JSON = JSON.stringify({
      "custom-llm": { inputPerMTok: 2, outputPerMTok: 4 },
    });
    const usd = estimateCostUsd("custom-llm-v1", {
      input_tokens: 500_000,
      output_tokens: 250_000,
    });
    assert.equal(usd, 500_000 * 2 / 1e6 + 250_000 * 4 / 1e6);
  } finally {
    if (previous === undefined) delete process.env.FACTORY_PRICING_JSON;
    else process.env.FACTORY_PRICING_JSON = previous;
  }
});
