import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyIncomingMessage,
  getFoodSearchReply,
  matchFoodSearchTrigger,
  parseAddressSelectionReply,
} from "../src/food-search-orchestrator.js";
import { PendingAddressSelections } from "../src/pending-address-selection.js";
import { PendingCartSessions } from "../src/pending-cart-sessions.js";

function message(text, from = "sender-1") {
  return { from, id: "wamid.1", phoneNumberId: "pn-1", text };
}

function payload(data) {
  return { text: "", structured: data };
}

function fakeSwiggyFoodClient({ getAddresses, searchRestaurants }) {
  return {
    getAddresses: getAddresses ?? (async () => payload({ addresses: [], total: 0 })),
    searchRestaurants:
      searchRestaurants ?? (async () => payload({ restaurants: [] })),
  };
}

function restaurant(overrides) {
  return {
    id: "r-1",
    name: "Test Restaurant",
    avgRating: 4.5,
    distanceKm: 2.1,
    deliveryTimeRange: "20-25 MINS",
    costForTwo: "₹300 for two",
    availabilityStatus: "OPEN",
    ...overrides,
  };
}

const singleAddress = {
  addresses: [
    { id: "addr-1", addressLine: "123 Main St", addressTag: "Home", addressCategory: "Home" },
  ],
  total: 1,
  resolution: { needsUserClarification: false, defaultAddressId: "addr-1" },
};

const ambiguousAddresses = {
  addresses: [
    { id: "addr-1", addressLine: "123 Main St", addressTag: "Home", addressCategory: "Home" },
    { id: "addr-2", addressLine: "456 Other Rd", addressTag: "Other", addressCategory: "Other" },
  ],
  total: 2,
  resolution: { needsUserClarification: true, defaultAddressId: "addr-1" },
};

const noAddresses = { addresses: [], total: 0, resolution: {} };

// --- matchFoodSearchTrigger ---

test("matchFoodSearchTrigger matches find/search case-insensitively", () => {
  assert.equal(matchFoodSearchTrigger("find biryani"), "biryani");
  assert.equal(matchFoodSearchTrigger("Search Pizza Places"), "Pizza Places");
});

test("matchFoodSearchTrigger returns undefined when there's no search term", () => {
  assert.equal(matchFoodSearchTrigger("find"), undefined);
  assert.equal(matchFoodSearchTrigger("find   "), undefined);
});

test("matchFoodSearchTrigger returns undefined for ordinary messages", () => {
  assert.equal(matchFoodSearchTrigger("hello there"), undefined);
});

// --- parseAddressSelectionReply ---

test("parseAddressSelectionReply returns a valid 0-based index", () => {
  assert.equal(parseAddressSelectionReply("1", 2), 0);
  assert.equal(parseAddressSelectionReply("2", 2), 1);
});

test("parseAddressSelectionReply returns undefined when out of range", () => {
  assert.equal(parseAddressSelectionReply("3", 2), undefined);
  assert.equal(parseAddressSelectionReply("0", 2), undefined);
});

test("parseAddressSelectionReply returns undefined for non-numeric text", () => {
  assert.equal(parseAddressSelectionReply("abc", 2), undefined);
});

// --- classifyIncomingMessage ---

test("classifyIncomingMessage: trigger with no pending state is a new search", async () => {
  const pending = new PendingAddressSelections();
  assert.deepEqual(await classifyIncomingMessage(message("find biryani"), pending), {
    type: "new_search",
    searchTerm: "biryani",
  });
});

test("classifyIncomingMessage: no trigger and no pending state is no_trigger", async () => {
  const pending = new PendingAddressSelections();
  assert.deepEqual(await classifyIncomingMessage(message("hello"), pending), { type: "no_trigger" });
});

test("classifyIncomingMessage: valid numeric reply while pending answers the prompt", async () => {
  const pending = new PendingAddressSelections();
  const candidates = [{ id: "addr-1", label: "Home" }, { id: "addr-2", label: "Other" }];
  pending.set("sender-1", { searchTerm: "biryani", candidates });

  assert.deepEqual(await classifyIncomingMessage(message("2"), pending), {
    type: "address_selection_answer",
    pending: { searchTerm: "biryani", candidates },
    selectedCandidate: candidates[1],
  });
});

test("classifyIncomingMessage: a new trigger overrides a stale pending prompt", async () => {
  const pending = new PendingAddressSelections();
  pending.set("sender-1", { searchTerm: "biryani", candidates: [{ id: "addr-1", label: "Home" }] });

  assert.deepEqual(await classifyIncomingMessage(message("find pizza"), pending), {
    type: "new_search",
    searchTerm: "pizza",
  });
});

test("classifyIncomingMessage: unrelated text while pending is unrecognized", async () => {
  const pending = new PendingAddressSelections();
  const candidates = [{ id: "addr-1", label: "Home" }];
  pending.set("sender-1", { searchTerm: "biryani", candidates });

  assert.deepEqual(await classifyIncomingMessage(message("no thanks"), pending), {
    type: "unrecognized_pending_reply",
    pending: { searchTerm: "biryani", candidates },
  });
});

test("classifyIncomingMessage: falls back to NIM classification when there's no literal trigger", async () => {
  const pending = new PendingAddressSelections();
  const calls = [];
  const classifyMessage = async (params) => {
    calls.push(params);
    return { type: "search_food", query: "biryani" };
  };

  const result = await classifyIncomingMessage(message("I want biryani"), pending, {
    nvidiaNim: { enabled: true, apiKey: "key", baseUrl: "https://example.test", model: "test-model" },
    classifyMessage,
  });

  assert.deepEqual(result, { type: "new_search", searchTerm: "biryani" });
  assert.deepEqual(calls, [
    {
      text: "I want biryani",
      apiKey: "key",
      baseUrl: "https://example.test",
      model: "test-model",
      hasActiveCart: false,
    },
  ]);
});

test("classifyIncomingMessage: does not call NIM when the literal trigger already matched", async () => {
  const pending = new PendingAddressSelections();
  let called = false;
  const classifyMessage = async () => {
    called = true;
    return { type: "search_food", query: "should not be used" };
  };

  const result = await classifyIncomingMessage(message("find biryani"), pending, {
    nvidiaNim: { enabled: true, apiKey: "key", baseUrl: "https://example.test", model: "test-model" },
    classifyMessage,
  });

  assert.equal(called, false);
  assert.deepEqual(result, { type: "new_search", searchTerm: "biryani" });
});

test("classifyIncomingMessage: NIM classification failure falls back to no_trigger", async () => {
  const pending = new PendingAddressSelections();
  const classifyMessage = async () => undefined;

  const result = await classifyIncomingMessage(message("I want biryani"), pending, {
    nvidiaNim: { enabled: true, apiKey: "key", baseUrl: "https://example.test", model: "test-model" },
    classifyMessage,
  });

  assert.deepEqual(result, { type: "no_trigger" });
});

test("classifyIncomingMessage: tells the classifier about an active cart session (regression - without this, cart-related messages like \"from Pizza Hut add a margherita pizza\" get misread as a brand new search)", async () => {
  const pending = new PendingAddressSelections();
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });

  const calls = [];
  const classifyMessage = async (params) => {
    calls.push(params);
    return undefined;
  };

  await classifyIncomingMessage(message("from Pizza Hut add a margherita pizza"), pending, {
    nvidiaNim: { enabled: true, apiKey: "key", baseUrl: "https://example.test", model: "test-model" },
    pendingCartSessions,
    classifyMessage,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].hasActiveCart, true);
});

test("classifyIncomingMessage: reports no active cart when there isn't one", async () => {
  const pending = new PendingAddressSelections();
  const pendingCartSessions = new PendingCartSessions();

  const calls = [];
  const classifyMessage = async (params) => {
    calls.push(params);
    return undefined;
  };

  await classifyIncomingMessage(message("I want biryani"), pending, {
    nvidiaNim: { enabled: true, apiKey: "key", baseUrl: "https://example.test", model: "test-model" },
    pendingCartSessions,
    classifyMessage,
  });

  assert.equal(calls[0].hasActiveCart, false);
});

test("classifyIncomingMessage: NIM is skipped entirely when not enabled", async () => {
  const pending = new PendingAddressSelections();
  let called = false;
  const classifyMessage = async () => {
    called = true;
    return { type: "search_food", query: "biryani" };
  };

  const result = await classifyIncomingMessage(message("I want biryani"), pending, {
    nvidiaNim: { enabled: false },
    classifyMessage,
  });

  assert.equal(called, false);
  assert.deepEqual(result, { type: "no_trigger" });
});

// --- getFoodSearchReply ---

test("getFoodSearchReply returns undefined for ordinary messages", async () => {
  const pending = new PendingAddressSelections();
  const client = fakeSwiggyFoodClient({});

  const reply = await getFoodSearchReply({
    message: message("hello there"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.equal(reply, undefined);
});

test("getFoodSearchReply searches immediately with a single unambiguous address", async () => {
  const pending = new PendingAddressSelections();
  const searchCalls = [];
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(singleAddress),
    searchRestaurants: async (params) => {
      searchCalls.push(params);
      return payload({ restaurants: [restaurant({ name: "Behrouz Biryani" })] });
    },
  });

  const reply = await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.deepEqual(searchCalls, [{ query: "biryani", addressId: "addr-1" }]);
  assert.match(reply, /Behrouz Biryani/);
  assert.match(reply, /⭐4.5/);
});

test("getFoodSearchReply prompts and does not search when addresses are ambiguous", async () => {
  const pending = new PendingAddressSelections();
  let searchCalled = false;
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(ambiguousAddresses),
    searchRestaurants: async () => {
      searchCalled = true;
      return payload({ restaurants: [] });
    },
  });

  const reply = await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.equal(searchCalled, false);
  assert.match(reply, /1\. Home/);
  assert.match(reply, /2\. Other/);
  assert.ok(pending.peek("sender-1"));
});

test("getFoodSearchReply resolves a valid follow-up reply and clears pending state", async () => {
  const pending = new PendingAddressSelections();
  const searchCalls = [];
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(ambiguousAddresses),
    searchRestaurants: async (params) => {
      searchCalls.push(params);
      return payload({ restaurants: [restaurant()] });
    },
  });

  await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  const reply = await getFoodSearchReply({
    message: message("2"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.deepEqual(searchCalls, [{ query: "biryani", addressId: "addr-2" }]);
  assert.match(reply, /Test Restaurant/);
  assert.equal(pending.peek("sender-1"), undefined);
});

test("getFoodSearchReply re-prompts on an invalid follow-up and keeps pending state", async () => {
  const pending = new PendingAddressSelections();
  let searchCalled = false;
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(ambiguousAddresses),
    searchRestaurants: async () => {
      searchCalled = true;
      return payload({ restaurants: [] });
    },
  });

  await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  const reply = await getFoodSearchReply({
    message: message("what?"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.equal(searchCalled, false);
  assert.match(reply, /1\. Home/);
  assert.ok(pending.peek("sender-1"));
});

test("getFoodSearchReply starts a fresh search when a new trigger arrives while pending", async () => {
  const pending = new PendingAddressSelections();
  const searchCalls = [];
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(singleAddress),
    searchRestaurants: async (params) => {
      searchCalls.push(params);
      return payload({ restaurants: [restaurant()] });
    },
  });

  await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: fakeSwiggyFoodClient({ getAddresses: async () => payload(ambiguousAddresses) }),
    pendingAddressSelections: pending,
  });

  await getFoodSearchReply({
    message: message("find pizza"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.deepEqual(searchCalls, [{ query: "pizza", addressId: "addr-1" }]);
});

test("getFoodSearchReply tells the user to add an address when they have none", async () => {
  const pending = new PendingAddressSelections();
  let searchCalled = false;
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(noAddresses),
    searchRestaurants: async () => {
      searchCalled = true;
      return payload({ restaurants: [] });
    },
  });

  const reply = await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.equal(searchCalled, false);
  assert.match(reply, /add one in the Swiggy app/i);
});

test("getFoodSearchReply uses defaultAddressId directly when clarification isn't needed", async () => {
  const pending = new PendingAddressSelections();
  const searchCalls = [];
  const client = fakeSwiggyFoodClient({
    getAddresses: async () =>
      payload({
        addresses: [{ id: "addr-9", addressLine: "9 Confirmed Ave" }],
        total: 1,
        resolution: { needsUserClarification: false, defaultAddressId: "addr-9" },
      }),
    searchRestaurants: async (params) => {
      searchCalls.push(params);
      return payload({ restaurants: [restaurant()] });
    },
  });

  await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.deepEqual(searchCalls, [{ query: "biryani", addressId: "addr-9" }]);
});

test("getFoodSearchReply falls back to a generic reply when getAddresses throws", async () => {
  const pending = new PendingAddressSelections();
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => {
      throw new Error("boom");
    },
  });

  const reply = await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.match(reply, /couldn't complete that search/i);
});

test("getFoodSearchReply falls back to a generic reply when searchRestaurants throws", async () => {
  const pending = new PendingAddressSelections();
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(singleAddress),
    searchRestaurants: async () => {
      throw new Error("boom");
    },
  });

  const reply = await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.match(reply, /couldn't complete that search/i);
});

test("getFoodSearchReply falls back to a generic reply on an unparseable payload", async () => {
  const pending = new PendingAddressSelections();
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => ({ text: "not json", structured: null }),
  });

  const reply = await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.match(reply, /couldn't complete that search/i);
});

test("getFoodSearchReply only shows OPEN restaurants", async () => {
  const pending = new PendingAddressSelections();
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(singleAddress),
    searchRestaurants: async () =>
      payload({
        restaurants: [
          restaurant({ name: "Closed Place", availabilityStatus: "CLOSED" }),
          restaurant({ name: "Unavailable Place", availabilityStatus: "UNAVAILABLE" }),
          restaurant({ name: "Open Place", availabilityStatus: "OPEN" }),
        ],
      }),
  });

  const reply = await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.match(reply, /Open Place/);
  assert.doesNotMatch(reply, /Closed Place/);
  assert.doesNotMatch(reply, /Unavailable Place/);
});

test("getFoodSearchReply reports no open restaurants when all are filtered out", async () => {
  const pending = new PendingAddressSelections();
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(singleAddress),
    searchRestaurants: async () =>
      payload({ restaurants: [restaurant({ availabilityStatus: "CLOSED" })] }),
  });

  const reply = await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.match(reply, /couldn't find any open restaurants/i);
});

test("getFoodSearchReply caps restaurant results to the top 5", async () => {
  const pending = new PendingAddressSelections();
  const restaurants = Array.from({ length: 10 }, (_, index) =>
    restaurant({ id: `r-${index}`, name: `Restaurant ${index}` }),
  );
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(singleAddress),
    searchRestaurants: async () => payload({ restaurants }),
  });

  const reply = await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.match(reply, /Restaurant 4/);
  assert.doesNotMatch(reply, /Restaurant 5/);
});

test("getFoodSearchReply caps address candidates to the top 5", async () => {
  const pending = new PendingAddressSelections();
  const addresses = Array.from({ length: 8 }, (_, index) => ({
    id: `addr-${index}`,
    addressLine: `${index} Some Street`,
    addressTag: `Tag${index}`,
  }));
  const client = fakeSwiggyFoodClient({
    getAddresses: async () =>
      payload({
        addresses,
        total: addresses.length,
        resolution: { needsUserClarification: true, defaultAddressId: "addr-0" },
      }),
  });

  await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.equal(pending.peek("sender-1").candidates.length, 5);
});

test("getFoodSearchReply never leaks raw ids, tool names, or JSON artifacts", async () => {
  const pending = new PendingAddressSelections();
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(singleAddress),
    searchRestaurants: async () => payload({ restaurants: [restaurant({ id: "super-secret-id" })] }),
  });

  const reply = await getFoodSearchReply({
    message: message("find biryani"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
  });

  assert.doesNotMatch(reply, /super-secret-id/);
  assert.doesNotMatch(reply, /addr-1/);
  assert.doesNotMatch(reply, /search_restaurants|get_addresses/);
  assert.doesNotMatch(reply, /[{}]/);
});
