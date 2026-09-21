import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTurn, TOOLS } from "../src/sarvam-agent.js";
import { PendingAddressSelections } from "../src/pending-address-selection.js";
import { PendingCartSessions } from "../src/pending-cart-sessions.js";
import { PendingConversationHistory } from "../src/pending-conversation-history.js";
import { PendingOrderConfirmations } from "../src/pending-order-confirmations.js";

const nlu = Object.freeze({ apiKey: "test-key", baseUrl: "https://example.test", model: "sarvam-105b", timeoutMs: 1000, reasoningEffort: "low" });

function toolCallResponse(toolCalls) {
  return { choices: [{ message: { tool_calls: toolCalls } }] };
}

function textResponse(content) {
  return { choices: [{ message: { content } }] };
}

function fakeClient(completionsImpl) {
  return { chat: { completions: completionsImpl } };
}

function fakeSwiggyClient(overrides = {}) {
  return {
    getAddresses:
      overrides.getAddresses ??
      (async () => ({ structured: { addresses: [{ id: "addr-1", addressTag: "Home", addressLine: "1 Main St" }], total: 1 } })),
    searchRestaurants:
      overrides.searchRestaurants ??
      (async () => ({ structured: { restaurants: [{ id: "r1", name: "Test Biryani House", availabilityStatus: "OPEN" }] } })),
    searchMenu:
      overrides.searchMenu ??
      (async () => ({ structured: { items: [{ name: "Chicken Biryani", price: 249, inStock: 1 }] } })),
    getFoodCart: overrides.getFoodCart ?? (async () => ({ structured: { statusCode: 0, data: { items: [] } } })),
  };
}

function newContext(overrides = {}) {
  return {
    pendingCartSessions: new PendingCartSessions(),
    pendingOrderConfirmations: new PendingOrderConfirmations(),
    pendingAddressSelections: new PendingAddressSelections(),
    pendingConversationHistory: new PendingConversationHistory(),
    ...overrides,
  };
}

// Structural safety net: the agent must never be able to place or confirm
// an order directly - see AGENTS.md's Commerce Safety rule and the comment
// on CHECKOUT_TOOL in src/sarvam-agent.js.
test("TOOLS never exposes place_food_order or confirm_order", () => {
  const names = TOOLS.map((tool) => tool.function.name);
  assert.ok(!names.includes("place_food_order"));
  assert.ok(!names.includes("confirm_order"));
});

test("runAgentTurn returns the model's final content when it calls no tool", async () => {
  const client = fakeClient(async () => textResponse("Hello there!"));
  const ctx = newContext();

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "hi" },
    swiggyFoodClient: fakeSwiggyClient(),
    ...ctx,
    nlu,
    client,
  });

  assert.equal(result, "Hello there!");
});

test("runAgentTurn returns undefined when the model returns empty content and no tool calls", async () => {
  const client = fakeClient(async () => textResponse(""));
  const ctx = newContext();

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "whatever" },
    swiggyFoodClient: fakeSwiggyClient(),
    ...ctx,
    nlu,
    client,
  });

  assert.equal(result, undefined);
});

test("runAgentTurn executes a tool call and feeds the result back for the final reply", async () => {
  const calls = [];
  const client = fakeClient(async ({ messages }) => {
    calls.push(messages);

    if (calls.length === 1) {
      return toolCallResponse([
        { id: "call_1", function: { name: "search_food", arguments: JSON.stringify({ query: "biryani" }) } },
      ]);
    }

    return textResponse("Found a place for you!");
  });

  const ctx = newContext();
  const result = await runAgentTurn({
    message: { from: "sender-1", text: "I want biryani" },
    swiggyFoodClient: fakeSwiggyClient(),
    ...ctx,
    nlu,
    client,
  });

  assert.equal(result, "Found a place for you!");
  assert.equal(calls.length, 2);
  // The second call's messages must include the tool result from the first.
  const toolMessages = calls[1].filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 1);
  assert.match(toolMessages[0].content, /Test Biryani House/);
});

test("runAgentTurn routes a search_menu tool call without touching the cart", async () => {
  const calls = [];
  const client = fakeClient(async ({ messages }) => {
    calls.push(messages);

    if (calls.length === 1) {
      return toolCallResponse([
        {
          id: "call_1",
          function: {
            name: "search_menu",
            arguments: JSON.stringify({ restaurantName: "Test Biryani House", query: "chicken biryani" }),
          },
        },
      ]);
    }

    return textResponse("Chicken Biryani from Test Biryani House is ₹249 - want me to add it?");
  });

  const ctx = newContext();
  ctx.pendingCartSessions.set("sender-1", { addressId: "addr-1" });

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "what should I get" },
    swiggyFoodClient: fakeSwiggyClient(),
    ...ctx,
    nlu,
    client,
  });

  assert.match(result, /want me to add it/);
  const toolMessages = calls[1].filter((m) => m.role === "tool");
  assert.match(toolMessages[0].content, /Chicken Biryani — ₹249/);
  // search_menu must never touch the cart.
  assert.equal(ctx.pendingCartSessions.peek("sender-1").cartRestaurantId, undefined);
});

test("runAgentTurn short-circuits a second search_menu call once the first already found a real match", async () => {
  const calls = [];
  const client = fakeClient(async ({ messages }) => {
    calls.push(messages);

    if (calls.length === 1) {
      return toolCallResponse([
        {
          id: "call_1",
          function: {
            name: "search_menu",
            arguments: JSON.stringify({ restaurantName: "Test Biryani House", query: "chicken biryani" }),
          },
        },
      ]);
    }

    if (calls.length === 2) {
      // The model tries a second restaurant/dish even though the first
      // search_menu call already found something real - this must be
      // short-circuited without a real Swiggy call, not executed again.
      return toolCallResponse([
        {
          id: "call_2",
          function: {
            name: "search_menu",
            arguments: JSON.stringify({ restaurantName: "Some Other Place", query: "something else" }),
          },
        },
      ]);
    }

    return textResponse("Chicken Biryani from Test Biryani House is ₹249 - want me to add it?");
  });

  const ctx = newContext();
  ctx.pendingCartSessions.set("sender-1", { addressId: "addr-1" });

  let searchMenuCallCount = 0;
  const swiggyFoodClient = fakeSwiggyClient({
    searchMenu: async () => {
      searchMenuCallCount += 1;
      return { structured: { items: [{ name: "Chicken Biryani", price: 249, inStock: 1 }] } };
    },
  });

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "what should I get" },
    swiggyFoodClient,
    ...ctx,
    nlu,
    client,
  });

  assert.match(result, /want me to add it/);
  assert.equal(calls.length, 3);
  assert.equal(searchMenuCallCount, 1);
  const toolMessagesSoFar = calls[2].filter((m) => m.role === "tool");
  assert.match(toolMessagesSoFar.at(-1).content, /already found a real, in-stock item/);
});

test("runAgentTurn short-circuits a search_food call too once search_menu already found a real match", async () => {
  const calls = [];
  const client = fakeClient(async ({ messages }) => {
    calls.push(messages);

    if (calls.length === 1) {
      return toolCallResponse([
        {
          id: "call_1",
          function: {
            name: "search_menu",
            arguments: JSON.stringify({ restaurantName: "Test Biryani House", query: "chicken biryani" }),
          },
        },
      ]);
    }

    if (calls.length === 2) {
      // Confirmed live: the model doesn't necessarily retry via ANOTHER
      // search_menu call - it can call search_food again instead, with a
      // different query. This must be short-circuited the same way.
      return toolCallResponse([
        { id: "call_2", function: { name: "search_food", arguments: JSON.stringify({ query: "pasta" }) } },
      ]);
    }

    return textResponse("Chicken Biryani from Test Biryani House is ₹249 - want me to add it?");
  });

  const ctx = newContext();
  ctx.pendingCartSessions.set("sender-1", { addressId: "addr-1" });

  let searchMenuCallCount = 0;
  let searchRestaurantsCallCount = 0;
  const swiggyFoodClient = fakeSwiggyClient({
    searchMenu: async () => {
      searchMenuCallCount += 1;
      return { structured: { items: [{ name: "Chicken Biryani", price: 249, inStock: 1 }] } };
    },
    searchRestaurants: async () => {
      searchRestaurantsCallCount += 1;
      return { structured: { restaurants: [{ id: "r1", name: "Test Biryani House", availabilityStatus: "OPEN" }] } };
    },
  });

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "what should I get" },
    swiggyFoodClient,
    ...ctx,
    nlu,
    client,
  });

  assert.match(result, /want me to add it/);
  assert.equal(searchMenuCallCount, 1);
  // Exactly 1: the first search_menu call's own restaurant-name resolution
  // (no restaurantCandidates seeded here to fuzzy-match against first) -
  // the short-circuited search_food attempt must never add a second.
  assert.equal(searchRestaurantsCallCount, 1);
  const toolMessagesSoFar = calls[2].filter((m) => m.role === "tool");
  assert.match(toolMessagesSoFar.at(-1).content, /already found a real, in-stock item/);
});

test("runAgentTurn short-circuits ANY tool call once search_menu already found a real match, not just search_food/search_menu", async () => {
  const calls = [];
  const client = fakeClient(async ({ messages }) => {
    calls.push(messages);

    if (calls.length === 1) {
      return toolCallResponse([
        {
          id: "call_1",
          function: {
            name: "search_menu",
            arguments: JSON.stringify({ restaurantName: "Test Biryani House", query: "chicken biryani" }),
          },
        },
      ]);
    }

    if (calls.length === 2) {
      // A third, previously-untested tool - proves the guard is general,
      // not a per-tool patch that happens to cover the two tools already
      // seen failing live.
      return toolCallResponse([{ id: "call_2", function: { name: "view_cart", arguments: "{}" } }]);
    }

    return textResponse("Chicken Biryani from Test Biryani House is ₹249 - want me to add it?");
  });

  const ctx = newContext();
  ctx.pendingCartSessions.set("sender-1", { addressId: "addr-1" });

  let getFoodCartCallCount = 0;
  const swiggyFoodClient = fakeSwiggyClient({
    searchMenu: async () => ({ structured: { items: [{ name: "Chicken Biryani", price: 249, inStock: 1 }] } }),
    getFoodCart: async () => {
      getFoodCartCallCount += 1;
      return { structured: { statusCode: 0, data: { items: [] } } };
    },
  });

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "what should I get" },
    swiggyFoodClient,
    ...ctx,
    nlu,
    client,
  });

  assert.match(result, /want me to add it/);
  assert.equal(getFoodCartCallCount, 0);
  const toolMessagesAfterViewCart = calls[2].filter((m) => m.role === "tool");
  assert.match(toolMessagesAfterViewCart.at(-1).content, /already found a real, in-stock item/);
});

test("runAgentTurn appends the exchange to conversation history on success", async () => {
  const client = fakeClient(async () => textResponse("Sure thing!"));
  const ctx = newContext();

  await runAgentTurn({
    message: { from: "sender-1", text: "hi" },
    swiggyFoodClient: fakeSwiggyClient(),
    ...ctx,
    nlu,
    client,
  });

  const history = ctx.pendingConversationHistory.peek("sender-1");
  assert.deepEqual(
    history.map((turn) => ({ role: turn.role, content: turn.content })),
    [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Sure thing!" },
    ],
  );
});

test("runAgentTurn does not touch conversation history when the model returns nothing usable", async () => {
  const client = fakeClient(async () => textResponse(""));
  const ctx = newContext();

  await runAgentTurn({
    message: { from: "sender-1", text: "hi" },
    swiggyFoodClient: fakeSwiggyClient(),
    ...ctx,
    nlu,
    client,
  });

  assert.deepEqual(ctx.pendingConversationHistory.peek("sender-1"), []);
});

test("runAgentTurn caps tool-call rounds and returns undefined rather than looping forever", async () => {
  let callCount = 0;
  const client = fakeClient(async () => {
    callCount += 1;
    return toolCallResponse([{ id: `call_${callCount}`, function: { name: "view_cart", arguments: "{}" } }]);
  });

  const ctx = newContext();
  const result = await runAgentTurn({
    message: { from: "sender-1", text: "keep going" },
    swiggyFoodClient: fakeSwiggyClient(),
    ...ctx,
    nlu,
    client,
  });

  assert.equal(result, undefined);
  assert.equal(callCount, 6);
});

test("runAgentTurn survives a tool implementation throwing, feeding back an apologetic tool result", async () => {
  const calls = [];
  const client = fakeClient(async ({ messages }) => {
    calls.push(messages);

    if (calls.length === 1) {
      return toolCallResponse([{ id: "call_1", function: { name: "view_cart", arguments: "{}" } }]);
    }

    return textResponse("Sorry, something went wrong - want to try again?");
  });

  const ctx = newContext();
  const throwingSwiggyClient = {
    getFoodCart: async () => {
      throw new Error("boom");
    },
  };

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "show my cart" },
    swiggyFoodClient: throwingSwiggyClient,
    pendingCartSessions: (() => {
      const store = new PendingCartSessions();
      store.set("sender-1", { addressId: "addr-1", restaurantId: "r1", restaurantName: "Test Biryani House", cartRestaurantId: "r1" });
      return store;
    })(),
    pendingOrderConfirmations: ctx.pendingOrderConfirmations,
    pendingAddressSelections: ctx.pendingAddressSelections,
    pendingConversationHistory: ctx.pendingConversationHistory,
    nlu,
    client,
  });

  assert.equal(result, "Sorry, something went wrong - want to try again?");
});
