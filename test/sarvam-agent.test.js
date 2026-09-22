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
    // A non-terminal tool (see TERMINAL_TOOLS in sarvam-agent.js) - the
    // point of this test is the round cap on genuine looping, which a
    // terminal tool would never reach (it short-circuits on round 1).
    return toolCallResponse([
      {
        id: `call_${callCount}`,
        function: { name: "search_menu", arguments: JSON.stringify({ restaurantName: "Test Biryani House", query: "biryani" }) },
      },
    ]);
  });

  const ctx = newContext();
  ctx.pendingCartSessions.set("sender-1", { addressId: "addr-1" });
  const result = await runAgentTurn({
    message: { from: "sender-1", text: "keep going" },
    swiggyFoodClient: fakeSwiggyClient(),
    ...ctx,
    nlu,
    client,
  });

  assert.equal(result, undefined);
  assert.equal(callCount, 8);
});

test("runAgentTurn survives a Swiggy call throwing inside a non-terminal tool, feeding back a fallback for the agent to phrase", async () => {
  const calls = [];
  const client = fakeClient(async ({ messages }) => {
    calls.push(messages);

    if (calls.length === 1) {
      return toolCallResponse([
        {
          id: "call_1",
          function: { name: "search_menu", arguments: JSON.stringify({ restaurantName: "Test Biryani House", query: "biryani" }) },
        },
      ]);
    }

    return textResponse("Sorry, something went wrong - want to try again?");
  });

  const ctx = newContext();
  const throwingSwiggyClient = {
    searchMenu: async () => {
      throw new Error("boom");
    },
  };

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "what's on the menu" },
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

// --- Terminal tools (checkout, view_cart, find_coupons, apply_coupon,
// search_food's address-disambiguation prompt): 2026-09-21 product
// decision - the agent only ever DECIDES to call these, it never phrases,
// translates, or adds commentary to what they say. See TERMINAL_TOOLS in
// sarvam-agent.js and AGENTS.md's hallucinated-order-confirmation gotcha.

test("runAgentTurn returns a terminal tool's own result directly, with no second completions call to phrase it", async () => {
  let completionsCallCount = 0;
  const client = fakeClient(async () => {
    completionsCallCount += 1;
    return toolCallResponse([{ id: "call_1", function: { name: "view_cart", arguments: "{}" } }]);
  });

  const ctx = newContext();
  ctx.pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantName: "Test Biryani House" });

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "what's in my cart" },
    swiggyFoodClient: fakeSwiggyClient({ getFoodCart: async () => ({ structured: { statusCode: 0, data: { items: [] } } }) }),
    ...ctx,
    nlu,
    client,
  });

  assert.equal(completionsCallCount, 1);
  assert.match(result, /empty|cart/i);
});

test("runAgentTurn threads lang through to a terminal tool's result", async () => {
  const client = fakeClient(async () =>
    toolCallResponse([{ id: "call_1", function: { name: "view_cart", arguments: "{}" } }]),
  );

  const ctx = newContext();
  ctx.pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantName: "Test Biryani House" });

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "mera cart dikhao" },
    swiggyFoodClient: fakeSwiggyClient({ getFoodCart: async () => ({ structured: { statusCode: 0, data: { items: [] } } }) }),
    ...ctx,
    nlu,
    client,
    lang: "hi",
  });

  assert.match(result, /आपकी कार्ट खाली है/);
});

test("runAgentTurn returns checkout's own result directly, unphrased, even when it's just a refusal", async () => {
  let completionsCallCount = 0;
  const client = fakeClient(async () => {
    completionsCallCount += 1;
    return toolCallResponse([{ id: "call_1", function: { name: "checkout", arguments: "{}" } }]);
  });

  const ctx = newContext();

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "checkout" },
    swiggyFoodClient: fakeSwiggyClient(),
    ...ctx,
    nlu,
    client,
  });

  assert.equal(completionsCallCount, 1);
  assert.match(result, /don't have an order in progress/);
});

test("runAgentTurn treats every result from checkout/view_cart/find_coupons/apply_coupon as terminal", async () => {
  for (const toolName of ["checkout", "view_cart", "find_coupons", "apply_coupon"]) {
    const client = fakeClient(async () =>
      toolCallResponse([
        {
          id: "call_1",
          function: { name: toolName, arguments: toolName === "apply_coupon" ? JSON.stringify({ couponCode: "SAVE10" }) : "{}" },
        },
      ]),
    );

    const ctx = newContext();
    const result = await runAgentTurn({
      message: { from: "sender-1", text: "go" },
      swiggyFoodClient: fakeSwiggyClient(),
      ...ctx,
      nlu,
      client,
    });

    assert.ok(typeof result === "string" && result.length > 0, `${toolName} should return a terminal result`);
  }
});

test("runAgentTurn appends a terminal tool's result to conversation history, same as a normal phrased reply", async () => {
  const client = fakeClient(async () => toolCallResponse([{ id: "call_1", function: { name: "checkout", arguments: "{}" } }]));

  const ctx = newContext();
  const result = await runAgentTurn({
    message: { from: "sender-1", text: "checkout" },
    swiggyFoodClient: fakeSwiggyClient(),
    ...ctx,
    nlu,
    client,
  });

  const history = ctx.pendingConversationHistory.peek("sender-1");
  assert.deepEqual(
    history.map((turn) => ({ role: turn.role, content: turn.content })),
    [
      { role: "user", content: "checkout" },
      { role: "assistant", content: result },
    ],
  );
});

test("runAgentTurn treats an ordinary search_food restaurant list as non-terminal (still agent-phrased)", async () => {
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
  // Exactly one saved address (fakeSwiggyClient's default), so search_food
  // resolves straight to a restaurant list - no address prompt this call.
  const result = await runAgentTurn({
    message: { from: "sender-1", text: "I want biryani" },
    swiggyFoodClient: fakeSwiggyClient(),
    ...ctx,
    nlu,
    client,
  });

  assert.equal(calls.length, 2);
  assert.equal(result, "Found a place for you!");
});

test("runAgentTurn treats search_food's address-disambiguation prompt as terminal (skips agent phrasing)", async () => {
  let completionsCallCount = 0;
  const client = fakeClient(async () => {
    completionsCallCount += 1;
    return toolCallResponse([
      { id: "call_1", function: { name: "search_food", arguments: JSON.stringify({ query: "biryani" }) } },
    ]);
  });

  const ctx = newContext();
  const swiggyFoodClient = fakeSwiggyClient({
    getAddresses: async () => ({
      structured: {
        addresses: [
          { id: "addr-1", addressTag: "Home", addressLine: "1 Main St" },
          { id: "addr-2", addressTag: "Work", addressLine: "2 Other St" },
        ],
        total: 2,
      },
    }),
  });

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "I want biryani" },
    swiggyFoodClient,
    ...ctx,
    nlu,
    client,
  });

  assert.equal(completionsCallCount, 1);
  assert.match(result, /which one should I use/i);
  assert.ok(ctx.pendingAddressSelections.peek("sender-1"), "should have recorded the pending address selection");
});

test("runAgentTurn treats recommend_similar's address-disambiguation prompt as terminal too", async () => {
  let completionsCallCount = 0;
  const client = fakeClient(async () => {
    completionsCallCount += 1;
    return toolCallResponse([{ id: "call_1", function: { name: "recommend_similar", arguments: "{}" } }]);
  });

  const ctx = newContext();
  const swiggyFoodClient = fakeSwiggyClient({
    getAddresses: async () => ({
      structured: {
        addresses: [
          { id: "addr-1", addressTag: "Home", addressLine: "1 Main St" },
          { id: "addr-2", addressTag: "Work", addressLine: "2 Other St" },
        ],
        total: 2,
      },
    }),
  });

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "suggest something" },
    swiggyFoodClient,
    ...ctx,
    nlu,
    client,
  });

  assert.equal(completionsCallCount, 1);
  assert.match(result, /which one should I use/i);
  const pending = ctx.pendingAddressSelections.peek("sender-1");
  assert.ok(pending, "should have recorded the pending address selection");
  assert.equal(pending.kind, "recommend");
});

// Structural guard against the "consolation hallucination" incidents
// AGENTS.md documents live: once recommend_similar genuinely finds nothing
// (no craving match, no usable order history), the model must not be
// trusted to write its own "nothing found" answer - it could invent a
// consolation restaurant/cuisine/dish instead (confirmed live twice: fake
// "Chinese places", a fabricated "Sushi platter / Ramen / Truffle pasta"
// menu). This mocked completions client deliberately simulates exactly that
// - a free-text final reply inventing a cuisine no tool ever returned -
// to prove runAgentTurn discards it and relays recommendSimilar's own
// honest dead-end text instead.
test("runAgentTurn discards a hallucinated final reply and relays recommend_similar's own honest dead end when it finds nothing", async () => {
  const client = fakeClient(async ({ messages }) => {
    const toolResultAlreadySeen = messages.some((message) => message.role === "tool");

    if (!toolResultAlreadySeen) {
      return toolCallResponse([{ id: "call_1", function: { name: "recommend_similar", arguments: "{}" } }]);
    }

    // Simulates the documented hallucination: inventing a cuisine no real
    // tool result this turn ever mentioned.
    return textResponse("No luck with your usual spots, but there were some great Chinese places around though!");
  });

  const ctx = newContext();
  ctx.pendingCartSessions.set("sender-1", { addressId: "addr-1" });
  // fakeSwiggyClient only forwards a fixed allowlist of override keys and
  // has no getFoodOrders slot of its own - build the client directly so the
  // empty-history mock actually takes effect (recommendSimilar's own
  // no-craving path calls getFoodOrders, not any of fakeSwiggyClient's
  // defaults).
  const swiggyFoodClient = { ...fakeSwiggyClient(), getFoodOrders: async () => ({ structured: { orders: [] } }) };

  const result = await runAgentTurn({
    message: { from: "sender-1", text: "suggest something" },
    swiggyFoodClient,
    ...ctx,
    nlu,
    client,
  });

  assert.match(result, /don't have any past orders/i);
  assert.doesNotMatch(result, /chinese/i);
});

// Structural guard against a fabricated order-summary-shaped reply -
// confirmed live (2026-09-22, sender 919289388564): "I want a pepsi" then
// "Yes" produced a full fake order summary (an item that doesn't exist
// anywhere in the catalog, internally-inconsistent pricing) ending in the
// exact "Reply YES to place this order, or NO to cancel." wording, with
// ZERO Swiggy tool calls fired that turn (confirmed via Render's trace).
// General on purpose: this doesn't mention any specific item - it proves
// the guard fires on the reserved YES/NO confirmation wording itself,
// regardless of what invented item/price surrounds it, since checking for
// that reserved wording is what makes this catchable at all without
// parsing arbitrary free text for "is this a hallucination."
test("runAgentTurn discards a fabricated order-summary reply that never came from a real checkout call this turn", async () => {
  const client = fakeClient(async () =>
    // No tool call at all - simulates the model answering purely from
    // invented text, the exact shape of the confirmed live incident.
    textResponse(
      "Here's your updated order summary:\n\nMock Place:\n1x Imaginary Item (Mock)\n\nTotal to pay: ₹999\n\nReply YES to place this order, or NO to cancel.",
    ),
  );

  const ctx = newContext();
  const result = await runAgentTurn({
    message: { from: "sender-1", text: "yes" },
    swiggyFoodClient: fakeSwiggyClient(),
    ...ctx,
    nlu,
    client,
  });

  assert.doesNotMatch(result, /Imaginary Item/);
  assert.doesNotMatch(result, /999/);
  assert.match(result, /check.?out/i);
});

// Structural guard closing the OTHER half of the same 2026-09-22 incident:
// the upstream "Done — Pepsi added too" claim itself (the item doesn't
// exist in the catalog - add_to_cart's own real result says so - but the
// model claimed success anyway). Generic fake item name on purpose, same
// reason as the test above: proves the guard fires because add_to_cart's
// own meta.hasData came back false, not because of anything item-specific.
test("runAgentTurn discards a fabricated 'added to cart' claim when add_to_cart's own real result found nothing", async () => {
  const calls = [];
  const client = fakeClient(async ({ messages }) => {
    calls.push(messages);

    if (calls.length === 1) {
      return toolCallResponse([
        {
          id: "call_1",
          function: { name: "add_to_cart", arguments: JSON.stringify({ query: "Nonexistent Snack" }) },
        },
      ]);
    }

    // The model ignores its own tool's honest "couldn't find" result and
    // claims success anyway - the exact live shape of the incident.
    return textResponse("Done — Nonexistent Snack added to your cart!");
  });

  const ctx = newContext();
  const result = await runAgentTurn({
    message: { from: "sender-1", text: "add a nonexistent snack" },
    swiggyFoodClient: fakeSwiggyClient({ searchMenu: async () => ({ structured: { items: [] } }) }),
    ...ctx,
    nlu,
    client,
  });

  assert.doesNotMatch(result, /Done/);
  assert.match(result, /couldn't find/i);
});

// Companion to the test above, checking the OTHER branch of the same guard:
// a thrown Swiggy call (network blip, not a real "item not found" business
// result) must NOT force GENERIC_FALLBACK_REPLY's English-only text onto
// the reply - the agent should still get to phrase its own apology, same
// precedent already established for search_food/search_menu's thrown-call
// case just above in this file. Caught in review before shipping: an
// earlier draft of this guard marked hasData:false on every
// GENERIC_FALLBACK_REPLY path indiscriminately, which would have made this
// test fail (forcing the generic English fallback instead of letting the
// model's own apology through).
test("runAgentTurn lets the agent phrase its own apology when add_to_cart throws, rather than forcing the generic fallback", async () => {
  const calls = [];
  const client = fakeClient(async ({ messages }) => {
    calls.push(messages);

    if (calls.length === 1) {
      return toolCallResponse([
        { id: "call_1", function: { name: "add_to_cart", arguments: JSON.stringify({ query: "Chicken Biryani" }) } },
      ]);
    }

    return textResponse("Sorry, something went wrong adding that — want to try again?");
  });

  const ctx = newContext();
  const result = await runAgentTurn({
    message: { from: "sender-1", text: "add chicken biryani" },
    swiggyFoodClient: {
      ...fakeSwiggyClient(),
      flushFoodCart: async () => ({}),
      updateFoodCart: async () => {
        throw new Error("network blip");
      },
    },
    ...ctx,
    nlu,
    client,
  });

  assert.equal(result, "Sorry, something went wrong adding that — want to try again?");
});
