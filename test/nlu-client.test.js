import assert from "node:assert/strict";
import test from "node:test";
import { classifyMessage, classifyOrderIntent } from "../src/nlu-client.js";

function toolCallResponse(toolCalls) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { tool_calls: toolCalls } }] }),
  };
}

function searchFoodToolCall(args) {
  return [{ function: { name: "search_food", arguments: JSON.stringify(args) } }];
}

test("classifyMessage returns a search_food intent for a matching tool call", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return toolCallResponse(searchFoodToolCall({ query: "biryani" }));
  };

  const result = await classifyMessage({
    text: "I want biryani",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.deepEqual(result, { type: "search_food", query: "biryani" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.test/v1/chat/completions");
  assert.equal(requests[0].options.headers.authorization, "Bearer test-key");

  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.model, "test-model");
  assert.equal(body.messages[1].content, "I want biryani");
  assert.equal(body.tools[0].function.name, "search_food");
});

test("classifyMessage returns a reorder_usual intent for a matching tool call", async () => {
  const fetchImpl = async () =>
    toolCallResponse([{ function: { name: "reorder_usual", arguments: "{}" } }]);

  const result = await classifyMessage({
    text: "get me my usual",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.deepEqual(result, { type: "reorder_usual" });
});

test("classifyMessage does not offer reorder_usual when hasActiveCart is true", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(options);
    return toolCallResponse(undefined);
  };

  await classifyMessage({
    text: "get me my usual",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    hasActiveCart: true,
    fetchImpl,
  });

  const body = JSON.parse(requests[0].body);
  const toolNames = body.tools.map((tool) => tool.function.name);
  assert.deepEqual(toolNames, ["search_food"]);
});

test("classifyMessage returns a recommend intent for a matching tool call", async () => {
  const fetchImpl = async () =>
    toolCallResponse([{ function: { name: "recommend", arguments: "{}" } }]);

  const result = await classifyMessage({
    text: "recommend me something",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.deepEqual(result, { type: "recommend" });
});

test("classifyMessage does not offer recommend when hasActiveCart is true", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(options);
    return toolCallResponse(undefined);
  };

  await classifyMessage({
    text: "recommend me something",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    hasActiveCart: true,
    fetchImpl,
  });

  const body = JSON.parse(requests[0].body);
  const toolNames = body.tools.map((tool) => tool.function.name);
  assert.deepEqual(toolNames, ["search_food"]);
});

test("classifyMessage uses a cart-aware system prompt when hasActiveCart is true", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(options);
    return toolCallResponse(undefined);
  };

  await classifyMessage({
    text: "add a margherita pizza",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    hasActiveCart: true,
    fetchImpl,
  });

  const body = JSON.parse(requests[0].body);
  assert.match(body.messages[0].content, /already has an active cart/);
});

test("classifyMessage returns undefined when the model calls no tool", async () => {
  const fetchImpl = async () => toolCallResponse(undefined);

  const result = await classifyMessage({
    text: "hello there",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.equal(result, undefined);
});

test("classifyMessage returns undefined for an unrecognized tool name", async () => {
  const fetchImpl = async () =>
    toolCallResponse([{ function: { name: "some_other_tool", arguments: "{}" } }]);

  const result = await classifyMessage({
    text: "hello",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.equal(result, undefined);
});

test("classifyMessage returns undefined for malformed tool call arguments", async () => {
  const fetchImpl = async () =>
    toolCallResponse([{ function: { name: "search_food", arguments: "not json" } }]);

  const result = await classifyMessage({
    text: "hello",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.equal(result, undefined);
});

test("classifyMessage returns undefined for an empty query", async () => {
  const fetchImpl = async () => toolCallResponse(searchFoodToolCall({ query: "   " }));

  const result = await classifyMessage({
    text: "hello",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.equal(result, undefined);
});

test("classifyMessage returns undefined on a non-2xx response instead of throwing", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });

  const result = await classifyMessage({
    text: "hello",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.equal(result, undefined);
});

test("classifyMessage returns undefined when the request throws instead of propagating", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };

  const result = await classifyMessage({
    text: "hello",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.equal(result, undefined);
});

function orderToolCall(name, args) {
  return [{ function: { name, arguments: JSON.stringify(args) } }];
}

test("classifyOrderIntent returns add_to_cart with a default quantity", async () => {
  const fetchImpl = async () => toolCallResponse(orderToolCall("add_to_cart", { query: "margherita pizza" }));

  const result = await classifyOrderIntent({
    text: "add a margherita pizza",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.deepEqual(result, { type: "add_to_cart", query: "margherita pizza", quantity: 1, restaurantName: undefined });
});

test("classifyOrderIntent returns add_to_cart with an explicit quantity", async () => {
  const fetchImpl = async () =>
    toolCallResponse(orderToolCall("add_to_cart", { query: "garlic bread", quantity: 3 }));

  const result = await classifyOrderIntent({
    text: "add 3 garlic breads",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.deepEqual(result, { type: "add_to_cart", query: "garlic bread", quantity: 3, restaurantName: undefined });
});

test("classifyOrderIntent returns add_to_cart with a named restaurant", async () => {
  const fetchImpl = async () =>
    toolCallResponse(orderToolCall("add_to_cart", { query: "margherita pizza", restaurantName: "Pizza Hut" }));

  const result = await classifyOrderIntent({
    text: "from Pizza Hut add a margherita pizza",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.deepEqual(result, {
    type: "add_to_cart",
    query: "margherita pizza",
    quantity: 1,
    restaurantName: "Pizza Hut",
  });
});

test("classifyOrderIntent returns remove_from_cart with no quantity when the user didn't give a count", async () => {
  const fetchImpl = async () => toolCallResponse(orderToolCall("remove_from_cart", { query: "margherita pizza" }));

  const result = await classifyOrderIntent({
    text: "remove the margherita pizza",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.deepEqual(result, { type: "remove_from_cart", query: "margherita pizza", quantity: undefined });
});

test("classifyOrderIntent returns remove_from_cart with an explicit quantity", async () => {
  const fetchImpl = async () =>
    toolCallResponse(orderToolCall("remove_from_cart", { query: "garlic bread", quantity: 1 }));

  const result = await classifyOrderIntent({
    text: "remove 1 garlic bread",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.deepEqual(result, { type: "remove_from_cart", query: "garlic bread", quantity: 1 });
});

test("classifyOrderIntent returns view_cart, find_coupons, and checkout with no args", async () => {
  for (const name of ["view_cart", "find_coupons", "checkout"]) {
    const fetchImpl = async () => toolCallResponse(orderToolCall(name, {}));

    const result = await classifyOrderIntent({
      text: "whatever",
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      fetchImpl,
    });

    assert.deepEqual(result, { type: name });
  }
});

test("classifyOrderIntent returns apply_coupon with the coupon code", async () => {
  const fetchImpl = async () => toolCallResponse(orderToolCall("apply_coupon", { couponCode: "SWIGGYIT" }));

  const result = await classifyOrderIntent({
    text: "apply SWIGGYIT",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.deepEqual(result, { type: "apply_coupon", couponCode: "SWIGGYIT" });
});

test("classifyOrderIntent returns undefined when no tool is called", async () => {
  const fetchImpl = async () => toolCallResponse(undefined);

  const result = await classifyOrderIntent({
    text: "what's the weather",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.equal(result, undefined);
});

test("classifyOrderIntent returns undefined on a non-2xx response instead of throwing", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });

  const result = await classifyOrderIntent({
    text: "checkout",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
  });

  assert.equal(result, undefined);
});

test("classifyMessage aborts and returns undefined on timeout", async () => {
  const fetchImpl = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      });
    });

  const result = await classifyMessage({
    text: "hello",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    fetchImpl,
    timeoutMs: 10,
  });

  assert.equal(result, undefined);
});
