import assert from "node:assert/strict";
import test from "node:test";
import {
  createSwiggyFoodClient,
  parseStructuredPayload,
  parseToolResult,
  SwiggyFoodToolError,
} from "../src/swiggy-food-client.js";
import { configureStatusReporter } from "../src/status-reporter.js";

function fakeClient({ callTool, close = async () => {} }) {
  return { connect: async () => {}, callTool, close };
}

test("parseToolResult joins text blocks and passes through structuredContent", () => {
  const result = {
    content: [
      { type: "text", text: "Biryani House" },
      { type: "text", text: "Pizza Place" },
      { type: "image", data: "ignored" },
    ],
    structuredContent: { restaurants: [{ id: "r1" }] },
  };

  assert.deepEqual(parseToolResult(result), {
    text: "Biryani House\nPizza Place",
    structured: { restaurants: [{ id: "r1" }] },
  });
});

test("parseToolResult tolerates missing content and structuredContent", () => {
  assert.deepEqual(parseToolResult({}), { text: "", structured: null });
});

test("searchRestaurants calls the search_restaurants tool with the given arguments", async () => {
  const calls = [];
  const client = createSwiggyFoodClient({
    mcpUrl: "https://example.invalid/food",
    token: "test-token",
    createClient: () =>
      fakeClient({
        callTool: async (request) => {
          calls.push(request);
          return { content: [{ type: "text", text: "ok" }] };
        },
      }),
    createTransport: () => ({}),
  });

  const result = await client.searchRestaurants({ query: "biryani", addressId: "addr-1" });

  assert.deepEqual(calls, [
    { name: "search_restaurants", arguments: { query: "biryani", addressId: "addr-1" } },
  ]);
  assert.equal(result.text, "ok");
});

test("getAddresses calls the get_addresses tool with the given arguments", async () => {
  const calls = [];
  const client = createSwiggyFoodClient({
    mcpUrl: "https://example.invalid/food",
    token: "test-token",
    createClient: () =>
      fakeClient({
        callTool: async (request) => {
          calls.push(request);
          return { content: [{ type: "text", text: "ok" }] };
        },
      }),
    createTransport: () => ({}),
  });

  await client.getAddresses({ page: 1 });

  assert.deepEqual(calls, [{ name: "get_addresses", arguments: { page: 1 } }]);
});

test("getFoodOrders calls the get_food_orders tool with the given arguments", async () => {
  const calls = [];
  const client = createSwiggyFoodClient({
    mcpUrl: "https://example.invalid/food",
    token: "test-token",
    createClient: () =>
      fakeClient({
        callTool: async (request) => {
          calls.push(request);
          return { content: [{ type: "text", text: "ok" }] };
        },
      }),
    createTransport: () => ({}),
  });

  await client.getFoodOrders({ addressId: "addr-1" });

  assert.deepEqual(calls, [{ name: "get_food_orders", arguments: { addressId: "addr-1" } }]);
});

test("getFoodOrderDetails calls the get_food_order_details tool with the given arguments", async () => {
  const calls = [];
  const client = createSwiggyFoodClient({
    mcpUrl: "https://example.invalid/food",
    token: "test-token",
    createClient: () =>
      fakeClient({
        callTool: async (request) => {
          calls.push(request);
          return { content: [{ type: "text", text: "ok" }] };
        },
      }),
    createTransport: () => ({}),
  });

  await client.getFoodOrderDetails({ orderId: "order-1" });

  assert.deepEqual(calls, [{ name: "get_food_order_details", arguments: { orderId: "order-1" } }]);
});

test("parseStructuredPayload prefers a non-null structured object", () => {
  const payload = parseStructuredPayload({
    text: "ignored",
    structured: { addresses: [] },
  });

  assert.deepEqual(payload, { addresses: [] });
});

test("parseStructuredPayload falls back to parsing text as JSON", () => {
  const payload = parseStructuredPayload({
    text: JSON.stringify({ restaurants: [] }),
    structured: null,
  });

  assert.deepEqual(payload, { restaurants: [] });
});

test("parseStructuredPayload returns undefined for unparseable text", () => {
  assert.equal(parseStructuredPayload({ text: "not json", structured: null }), undefined);
});

test("parseStructuredPayload returns undefined when both fields are absent", () => {
  assert.equal(parseStructuredPayload({ text: "", structured: null }), undefined);
});

test("reuses a single connection across multiple tool calls", async () => {
  let createClientCount = 0;
  const client = createSwiggyFoodClient({
    mcpUrl: "https://example.invalid/food",
    token: "test-token",
    createClient: () => {
      createClientCount += 1;
      return fakeClient({ callTool: async () => ({ content: [] }) });
    },
    createTransport: () => ({}),
  });

  await client.searchRestaurants({ query: "pizza" });
  await client.searchMenu({ query: "margherita" });

  assert.equal(createClientCount, 1);
});

test("wraps a tool-level error response in SwiggyFoodToolError without leaking it", async () => {
  const client = createSwiggyFoodClient({
    mcpUrl: "https://example.invalid/food",
    token: "test-token",
    createClient: () =>
      fakeClient({
        callTool: async () => ({ isError: true, content: [{ type: "text", text: "boom" }] }),
      }),
    createTransport: () => ({}),
  });

  await assert.rejects(client.searchRestaurants({ query: "pizza" }), (error) => {
    assert.ok(error instanceof SwiggyFoodToolError);
    assert.equal(error.toolName, "search_restaurants");
    assert.equal(error.message, 'Swiggy Food tool "search_restaurants" failed.');
    return true;
  });
});

test("wraps a transport-level failure in SwiggyFoodToolError", async () => {
  const transportError = new Error("connection reset");
  const client = createSwiggyFoodClient({
    mcpUrl: "https://example.invalid/food",
    token: "test-token",
    createClient: () =>
      fakeClient({
        callTool: async () => {
          throw transportError;
        },
      }),
    createTransport: () => ({}),
  });

  await assert.rejects(client.searchMenu({ query: "biryani" }), (error) => {
    assert.ok(error instanceof SwiggyFoodToolError);
    assert.equal(error.cause, transportError);
    return true;
  });
});

test("close() closes an established connection and allows reconnecting", async () => {
  let closeCount = 0;
  let connectCount = 0;
  const client = createSwiggyFoodClient({
    mcpUrl: "https://example.invalid/food",
    token: "test-token",
    createClient: () => {
      connectCount += 1;
      return fakeClient({
        callTool: async () => ({ content: [] }),
        close: async () => {
          closeCount += 1;
        },
      });
    },
    createTransport: () => ({}),
  });

  await client.searchRestaurants({ query: "pizza" });
  await client.close();
  await client.close();
  await client.searchRestaurants({ query: "pizza" });

  assert.equal(closeCount, 1);
  assert.equal(connectCount, 2);
});

test("reports Swiggy health, but never counts one user's expired login as an outage", async () => {
  const outcomes = [];
  configureStatusReporter({ success: (component) => outcomes.push([component, "ok"]), failure: (component) => outcomes.push([component, "fail"]) });

  try {
    const ok = createSwiggyFoodClient({
      mcpUrl: "https://example.invalid/food",
      token: "test-token",
      createClient: () => fakeClient({ callTool: async () => ({ content: [] }) }),
      createTransport: () => ({}),
    });
    await ok.searchRestaurants({ query: "biryani" });

    const expired = createSwiggyFoodClient({
      mcpUrl: "https://example.invalid/food",
      token: "test-token",
      createClient: () =>
        fakeClient({
          callTool: async () => {
            throw Object.assign(new Error("No or invalid session credentials"), { code: 401 });
          },
        }),
      createTransport: () => ({}),
    });
    await assert.rejects(expired.searchRestaurants({ query: "biryani" }));

    assert.deepEqual(outcomes, [["swiggy", "ok"]]);
  } finally {
    configureStatusReporter(undefined);
  }
});
