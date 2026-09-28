import assert from "node:assert/strict";
import test from "node:test";
import {
  matchAddressByName,
  parseAddressSelectionReply,
  resolvePendingAddressReply,
  searchFood,
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
};

const ambiguousAddresses = {
  addresses: [
    { id: "addr-1", addressLine: "123 Main St", addressTag: "Home", addressCategory: "Home" },
    { id: "addr-2", addressLine: "456 Other Rd", addressTag: "Other", addressCategory: "Other" },
  ],
  total: 2,
};

const noAddresses = { addresses: [], total: 0 };

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

// --- searchFood (the agent's search_food tool implementation) ---

test("searchFood searches immediately with a single unambiguous address", async () => {
  const pending = new PendingAddressSelections();
  const searchCalls = [];
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(singleAddress),
    searchRestaurants: async (params) => {
      searchCalls.push(params);
      return payload({ restaurants: [restaurant({ name: "Behrouz Biryani" })] });
    },
  });

  const reply = await searchFood("sender-1", "biryani", client, pending, undefined);

  assert.deepEqual(searchCalls, [{ query: "biryani", addressId: "addr-1" }]);
  assert.match(reply, /Behrouz Biryani/);
  assert.match(reply, /⭐4.5/);
});

test("searchFood keeps the record of which restaurant the live cart holds", async () => {
  const pending = new PendingAddressSelections();
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantId: "r-biryani",
    restaurantName: "Biryani House",
    cartRestaurantId: "r-biryani",
  });

  for (const restaurants of [[], [restaurant({ id: "r-thai", name: "Thai Place" })]]) {
    await searchFood(
      "sender-1",
      "pad thai",
      fakeSwiggyFoodClient({ searchRestaurants: async () => payload({ restaurants }) }),
      pending,
      pendingCartSessions,
    );

    assert.equal(pendingCartSessions.peek("sender-1").cartRestaurantId, "r-biryani");
  }
});

test("searchFood records the shown restaurant list as selectable candidates on the cart session", async () => {
  const pending = new PendingAddressSelections();
  const pendingCartSessions = new PendingCartSessions();
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(singleAddress),
    searchRestaurants: async () =>
      payload({
        restaurants: [
          restaurant({ id: "r-1", name: "Louis Burger" }),
          restaurant({ id: "r-2", name: "KFC" }),
        ],
      }),
  });

  await searchFood("sender-1", "chicken wings", client, pending, pendingCartSessions);

  // A bare number reply should be able to pick straight off this list, the
  // same way a bare number already picks an address - see
  // food-order-orchestrator.js's resolvePendingCartCandidateReply, which
  // reads this field.
  assert.deepEqual(pendingCartSessions.peek("sender-1"), {
    addressId: "addr-1",
    cartRestaurantId: undefined,
    searchTerm: "chicken wings",
    restaurantCandidates: [
      { id: "r-1", name: "Louis Burger" },
      { id: "r-2", name: "KFC" },
    ],
  });
});

test("searchFood prompts and does not search when addresses are ambiguous", async () => {
  const pending = new PendingAddressSelections();
  let searchCalled = false;
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(ambiguousAddresses),
    searchRestaurants: async () => {
      searchCalled = true;
      return payload({ restaurants: [] });
    },
  });

  const reply = await searchFood("sender-1", "biryani", client, pending, undefined);

  assert.equal(searchCalled, false);
  assert.match(reply, /1\. Home/);
  assert.match(reply, /2\. Other/);
  assert.ok(pending.peek("sender-1"));
});

test("searchFood reuses an address already established this session instead of asking again", async () => {
  const pending = new PendingAddressSelections();
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-known" });

  let getAddressesCalled = false;
  const searchCalls = [];
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => {
      getAddressesCalled = true;
      return payload(ambiguousAddresses);
    },
    searchRestaurants: async (params) => {
      searchCalls.push(params);
      return payload({ restaurants: [restaurant()] });
    },
  });

  const reply = await searchFood("sender-1", "biryani", client, pending, pendingCartSessions);

  assert.equal(getAddressesCalled, false);
  assert.deepEqual(searchCalls, [{ query: "biryani", addressId: "addr-known" }]);
  assert.equal(pending.peek("sender-1"), undefined);
  assert.match(reply, /Test Restaurant/);
});

test("searchFood tells the user to add an address when they have none", async () => {
  const pending = new PendingAddressSelections();
  let searchCalled = false;
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(noAddresses),
    searchRestaurants: async () => {
      searchCalled = true;
      return payload({ restaurants: [] });
    },
  });

  const reply = await searchFood("sender-1", "biryani", client, pending, undefined);

  assert.equal(searchCalled, false);
  assert.match(reply, /add one in the Swiggy app/i);
});

test("searchFood uses the address directly when there's only one saved", async () => {
  const pending = new PendingAddressSelections();
  const searchCalls = [];
  const client = fakeSwiggyFoodClient({
    getAddresses: async () =>
      payload({
        addresses: [{ id: "addr-9", addressLine: "9 Confirmed Ave" }],
        total: 1,
      }),
    searchRestaurants: async (params) => {
      searchCalls.push(params);
      return payload({ restaurants: [restaurant()] });
    },
  });

  await searchFood("sender-1", "biryani", client, pending, undefined);

  assert.deepEqual(searchCalls, [{ query: "biryani", addressId: "addr-9" }]);
});

test("searchFood falls back to a generic reply when getAddresses throws", async () => {
  const pending = new PendingAddressSelections();
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => {
      throw new Error("boom");
    },
  });

  const reply = await searchFood("sender-1", "biryani", client, pending, undefined);

  assert.match(reply, /couldn't complete that search/i);
});

test("searchFood falls back to a generic reply when searchRestaurants throws", async () => {
  const pending = new PendingAddressSelections();
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(singleAddress),
    searchRestaurants: async () => {
      throw new Error("boom");
    },
  });

  const reply = await searchFood("sender-1", "biryani", client, pending, undefined);

  assert.match(reply, /couldn't complete that search/i);
});

test("searchFood falls back to a generic reply on an unparseable payload", async () => {
  const pending = new PendingAddressSelections();
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => ({ text: "not json", structured: null }),
  });

  const reply = await searchFood("sender-1", "biryani", client, pending, undefined);

  assert.match(reply, /couldn't complete that search/i);
});

test("searchFood only shows OPEN restaurants", async () => {
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

  const reply = await searchFood("sender-1", "biryani", client, pending, undefined);

  assert.match(reply, /Open Place/);
  assert.doesNotMatch(reply, /Closed Place/);
  assert.doesNotMatch(reply, /Unavailable Place/);
});

test("searchFood reports no open restaurants when all are filtered out", async () => {
  const pending = new PendingAddressSelections();
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(singleAddress),
    searchRestaurants: async () =>
      payload({ restaurants: [restaurant({ availabilityStatus: "CLOSED" })] }),
  });

  const reply = await searchFood("sender-1", "biryani", client, pending, undefined);

  assert.match(reply, /couldn't find any open restaurants/i);
});

test("searchFood caps restaurant results to the top 5", async () => {
  const pending = new PendingAddressSelections();
  const restaurants = Array.from({ length: 10 }, (_, index) =>
    restaurant({ id: `r-${index}`, name: `Restaurant ${index}` }),
  );
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(singleAddress),
    searchRestaurants: async () => payload({ restaurants }),
  });

  const reply = await searchFood("sender-1", "biryani", client, pending, undefined);

  assert.match(reply, /Restaurant 4/);
  assert.doesNotMatch(reply, /Restaurant 5/);
});

test("searchFood caps address candidates to the top 5", async () => {
  const pending = new PendingAddressSelections();
  const addresses = Array.from({ length: 8 }, (_, index) => ({
    id: `addr-${index}`,
    addressLine: `${index} Some Street`,
    addressTag: `Tag${index}`,
  }));
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload({ addresses, total: addresses.length }),
  });

  await searchFood("sender-1", "biryani", client, pending, undefined);

  assert.equal(pending.peek("sender-1").candidates.length, 5);
});

test("searchFood never leaks raw ids, tool names, or JSON artifacts", async () => {
  const pending = new PendingAddressSelections();
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(singleAddress),
    searchRestaurants: async () => payload({ restaurants: [restaurant({ id: "super-secret-id" })] }),
  });

  const reply = await searchFood("sender-1", "biryani", client, pending, undefined);

  assert.doesNotMatch(reply, /super-secret-id/);
  assert.doesNotMatch(reply, /addr-1/);
  assert.doesNotMatch(reply, /search_restaurants|get_addresses/);
  assert.doesNotMatch(reply, /[{}]/);
});

// --- resolvePendingAddressReply (the deterministic pre-agent short-circuit) ---

test("resolvePendingAddressReply reports unhandled when there's no pending address selection", async () => {
  const pending = new PendingAddressSelections();
  const client = fakeSwiggyFoodClient({});

  const outcome = await resolvePendingAddressReply({
    message: message("2"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
    pendingCartSessions: undefined,
  });

  assert.deepEqual(outcome, { handled: false });
});

test("resolvePendingAddressReply resolves a valid follow-up reply and clears pending state", async () => {
  const pending = new PendingAddressSelections();
  const searchCalls = [];
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(ambiguousAddresses),
    searchRestaurants: async (params) => {
      searchCalls.push(params);
      return payload({ restaurants: [restaurant()] });
    },
  });

  await searchFood("sender-1", "biryani", client, pending, undefined);

  const outcome = await resolvePendingAddressReply({
    message: message("2"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
    pendingCartSessions: undefined,
  });

  assert.deepEqual(searchCalls, [{ query: "biryani", addressId: "addr-2" }]);
  assert.equal(outcome.handled, true);
  assert.match(outcome.replyText, /Test Restaurant/);
  assert.equal(pending.peek("sender-1"), undefined);
});

// A non-numeric reply while an address prompt is pending must NOT be
// trapped in an infinite re-prompt loop - it clears the stale prompt and
// reports unhandled, so the caller hands the message to the agent fresh
// (e.g. "actually, find pizza instead" needs a way out, not a forced number
// pick for the OLD search). Confirmed against the old classifier-driven
// dispatch's behavior: a genuinely new request there overrode a stale
// address prompt via the NLU classifier's own judgment; this is the
// equivalent without a classifier to consult.
test("resolvePendingAddressReply clears stale pending state and reports unhandled on a non-numeric reply", async () => {
  const pending = new PendingAddressSelections();
  let searchCalled = false;
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(ambiguousAddresses),
    searchRestaurants: async () => {
      searchCalled = true;
      return payload({ restaurants: [] });
    },
  });

  await searchFood("sender-1", "biryani", client, pending, undefined);

  const outcome = await resolvePendingAddressReply({
    message: message("actually, find pizza instead"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
    pendingCartSessions: undefined,
  });

  assert.equal(searchCalled, false);
  assert.deepEqual(outcome, { handled: false });
  assert.equal(pending.peek("sender-1"), undefined);
});

test("resolvePendingAddressReply records the address and steps aside (does not call recommendSimilar itself) for a 'recommend' kind pending selection", async () => {
  // recommendSimilar's own return value is LLM-facing instructional text,
  // never meant to reach the user directly - calling it here and returning
  // its text as replyText would leak that raw text straight to WhatsApp.
  // The correct resume is handled: false, letting the bare number reach the
  // agent through the normal runAgentTurn path (buildReplyText in
  // server.js), which has enough context (pendingConversationHistory) to
  // infer the picked address and call recommend_similar itself.
  const pending = new PendingAddressSelections();
  const pendingCartSessions = new PendingCartSessions();
  pending.set("sender-1", {
    kind: "recommend",
    craving: "chicken tikka masala",
    candidates: [
      { id: "addr-1", label: "Home — 1 Main St" },
      { id: "addr-2", label: "Work — 2 Other St" },
    ],
  });

  const outcome = await resolvePendingAddressReply({
    message: message("2"),
    swiggyFoodClient: fakeSwiggyFoodClient({}),
    pendingAddressSelections: pending,
    pendingCartSessions,
  });

  assert.deepEqual(outcome, { handled: false });
  assert.equal(pendingCartSessions.peek("sender-1").addressId, "addr-2");
  assert.equal(pending.peek("sender-1"), undefined);
});

// --- picking an address by name ---

const homeWorkOther = [
  { id: "a", label: "Home — 1 Main St", tag: "Home" },
  { id: "b", label: "Work — 2 Office Rd", tag: "Work" },
  { id: "c", label: "Mom's place — 3 Lane", tag: "Mom's place" },
];

test("matchAddressByName picks an address by its tag or a common synonym", () => {
  assert.equal(matchAddressByName("Home", homeWorkOther), 0);
  assert.equal(matchAddressByName("home please", homeWorkOther), 0);
  assert.equal(matchAddressByName("ghar pe", homeWorkOther), 0);
  assert.equal(matchAddressByName("घर", homeWorkOther), 0);
  assert.equal(matchAddressByName("WORK", homeWorkOther), 1);
  assert.equal(matchAddressByName("office", homeWorkOther), 1);
  assert.equal(matchAddressByName("mom's place", homeWorkOther), 2);
});

test("matchAddressByName leaves unclear or longer replies to the agent", () => {
  assert.equal(matchAddressByName("Mars", homeWorkOther), undefined);
  assert.equal(matchAddressByName("actually find me pizza near home instead", homeWorkOther), undefined);
  assert.equal(
    matchAddressByName("other", [
      { id: "x", label: "Other — A", tag: "Other" },
      { id: "y", label: "Other — B", tag: "Other" },
    ]),
    undefined,
  );
});

test("resolvePendingAddressReply accepts the address's name instead of its number", async () => {
  const pending = new PendingAddressSelections();
  const searchCalls = [];
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(ambiguousAddresses),
    searchRestaurants: async (params) => {
      searchCalls.push(params);
      return payload({ restaurants: [restaurant()] });
    },
  });

  await searchFood("sender-1", "biryani", client, pending, undefined);

  const outcome = await resolvePendingAddressReply({
    message: message("other"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
    pendingCartSessions: undefined,
  });

  assert.deepEqual(searchCalls, [{ query: "biryani", addressId: "addr-2" }]);
  assert.equal(outcome.handled, true);
});

test("parseAddressSelectionReply accepts position words as well as numbers", () => {
  assert.equal(parseAddressSelectionReply("First", 2), 0);
  assert.equal(parseAddressSelectionReply("the first one", 2), 0);
  assert.equal(parseAddressSelectionReply("1st", 2), 0);
  assert.equal(parseAddressSelectionReply("option 2", 2), 1);
  assert.equal(parseAddressSelectionReply("pehla wala", 2), 0);
  assert.equal(parseAddressSelectionReply("पहला", 2), 0);
  assert.equal(parseAddressSelectionReply("dusra", 2), 1);
  assert.equal(parseAddressSelectionReply("last", 3), 2);
});

test("parseAddressSelectionReply leaves sentences and out-of-range picks to the agent", () => {
  assert.equal(parseAddressSelectionReply("First I want pizza", 2), undefined);
  assert.equal(parseAddressSelectionReply("third", 2), undefined);
  assert.equal(parseAddressSelectionReply("one", 2), undefined);
});

test("resolvePendingAddressReply accepts 'First' for the address prompt", async () => {
  const pending = new PendingAddressSelections();
  const searchCalls = [];
  const client = fakeSwiggyFoodClient({
    getAddresses: async () => payload(ambiguousAddresses),
    searchRestaurants: async (params) => {
      searchCalls.push(params);
      return payload({ restaurants: [restaurant()] });
    },
  });

  await searchFood("sender-1", "pasta", client, pending, undefined);
  const outcome = await resolvePendingAddressReply({
    message: message("First"),
    swiggyFoodClient: client,
    pendingAddressSelections: pending,
    pendingCartSessions: undefined,
  });

  assert.equal(outcome.handled, true);
  assert.deepEqual(searchCalls, [{ query: "pasta", addressId: "addr-1" }]);
});

test("parseAddressSelectionReply accepts common spellings of pehla", () => {
  assert.equal(parseAddressSelectionReply("Pehela", 2), 0);
  assert.equal(parseAddressSelectionReply("pahela wala", 2), 0);
  assert.equal(parseAddressSelectionReply("pehle", 2), 0);
});
