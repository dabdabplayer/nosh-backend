import assert from "node:assert/strict";
import test from "node:test";
import { collectSamples, collectServiceSamples } from "../scripts/swiggy-latency-report.js";
import { LATENCY_TARGETS_MS, percentile, toolClass } from "../scripts/swiggy-latency-targets.js";

test("toolClass groups tools the way Swiggy's latency targets do", () => {
  assert.equal(toolClass("search_restaurants"), "read");
  assert.equal(toolClass("get_food_cart"), "read");
  assert.equal(toolClass("update_food_cart"), "write");
  assert.equal(toolClass("apply_food_coupon"), "write");
  assert.equal(toolClass("place_food_order"), "order");
  assert.deepEqual(LATENCY_TARGETS_MS.order, { p50: 800, p95: 2000, p99: 4000 });
});

test("percentile uses the nearest-rank method", () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(percentile(values, 50), 50);
  assert.equal(percentile(values, 95), 95);
  assert.equal(percentile(values, 99), 99);
  assert.equal(percentile([], 50), undefined);
});

test("collectSamples reads Nosh's Swiggy call log lines and ignores everything else", () => {
  const samples = collectSamples(
    [
      "2026-09-28T14:46:35Z Swiggy Food tool call succeeded. { toolName: 'search_restaurants', durationMs: 90 }",
      "Swiggy Food tool call failed. { toolName: 'update_food_cart', durationMs: 3000, errorName: 'Error' }",
      "Swiggy Food tool call returned an error result. { toolName: 'update_food_cart', durationMs: 120 }",
      "Swiggy Food tool call succeeded. { toolName: 'update_food_cart', durationMs: 400 }",
      "Received WhatsApp webhook POST.",
    ].join("\n"),
  );

  assert.deepEqual(samples, {
    search_restaurants: { durations: [90], failures: 0 },
    update_food_cart: { durations: [400], failures: 2 },
  });
});

test("collectServiceSamples reads Gemini and Sarvam timing lines", () => {
  const samples = collectServiceSamples(
    [
      "Gemini call succeeded. { durationMs: 1840, attempts: 1, inputTokens: 5210, outputTokens: 180 }",
      "Gemini call failed. { durationMs: 35100, attempts: 1, errorName: 'TimeoutError' }",
      "Sarvam translation succeeded. { durationMs: 420, direction: 'to-english', chunks: 1 }",
      "Sarvam translation failed; using the untranslated text. { durationMs: 900, direction: 'from-english', name: 'Error' }",
    ].join("\n"),
  );

  assert.deepEqual(samples.gemini, { durations: [1840], failures: 1, inputTokens: 5210, outputTokens: 180 });
  assert.deepEqual(samples["sarvam to-english"].durations, [420]);
  assert.equal(samples["sarvam from-english"].failures, 1);
});
