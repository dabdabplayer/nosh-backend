import assert from "node:assert/strict";
import test from "node:test";
import {
  addToCart,
  applyCoupon,
  buildReorderUsualReply,
  checkout,
  findCoupons,
  findUsualOrder,
  noActiveOrderReply,
  parseOrderConfirmationReply,
  placeConfirmedOrder,
  recommendSimilar,
  removeFromCart,
  resolvePendingCartCandidateReply,
  searchMenu,
  showRestaurantMenu,
  viewCart,
  viewOrders,
} from "../src/food-order-orchestrator.js";
import { PendingAddressSelections } from "../src/pending-address-selection.js";
import { SwiggyFoodToolError } from "../src/swiggy-food-client.js";
import { PendingCartSessions } from "../src/pending-cart-sessions.js";
import { PendingOrderConfirmations } from "../src/pending-order-confirmations.js";

function message(text, from = "sender-1") {
  return { from, id: "wamid.1", phoneNumberId: "pn-1", text };
}

function payload(data) {
  return { text: "", structured: data };
}

function cartPayload(data) {
  return payload({ statusCode: 0, statusMessage: "CART_UPDATED_SUCCESSFULLY", data });
}

// A failed mutation can still surface with a non-zero statusCode while
// echoing back a data object (e.g. the cart unchanged) - confirmed via the
// real envelope shape, { statusCode, statusMessage, data }, live.
function cartFailurePayload(data) {
  return payload({ statusCode: 1, statusMessage: "FAILED", data });
}

function fakeClient(overrides = {}) {
  return {
    searchRestaurants: overrides.searchRestaurants ?? (async () => payload({ restaurants: [] })),
    searchMenu: overrides.searchMenu ?? (async () => payload({ items: [] })),
    updateFoodCart: overrides.updateFoodCart ?? (async () => cartPayload({ items: [] })),
    getFoodCart: overrides.getFoodCart ?? (async () => cartPayload({ items: [] })),
    fetchFoodCoupons: overrides.fetchFoodCoupons ?? (async () => payload({ coupon_sections: [] })),
    applyFoodCoupon:
      overrides.applyFoodCoupon ?? (async () => cartPayload({ items: [], offers: { coupon_discount: 0 } })),
    getPaymentOptions:
      overrides.getPaymentOptions ??
      (async () => payload({ cod: { available: true, displayName: "Cash on Delivery" } })),
    placeFoodOrder: overrides.placeFoodOrder,
    confirmOrder: overrides.confirmOrder,
    getAddresses:
      overrides.getAddresses ??
      (async () =>
        payload({
          addresses: [{ id: "addr-1", addressLine: "123 Main St" }],
          total: 1,
        })),
    getFoodOrders: overrides.getFoodOrders ?? (async () => payload({ orders: [] })),
    getFoodOrderDetails: overrides.getFoodOrderDetails,
    flushFoodCart: overrides.flushFoodCart ?? (async () => payload({ success: true })),
    getRestaurantMenu: overrides.getRestaurantMenu ?? (async () => payload({ items: [] })),
  };
}

function menuItem(overrides) {
  return {
    name: "Margherita Pizza",
    price: 119,
    menu_item_id: "item-1",
    inStock: 1,
    variantsV2: [
      {
        groupId: "g-crust",
        variations: [
          { name: "Hand Tossed", id: "v-crust-default", default: 1 },
          { name: "Thin Crust", id: "v-crust-other" },
        ],
      },
    ],
    ...overrides,
  };
}

function cartData(overrides) {
  return {
    cart_id: 1,
    restaurant: { name: "Test Restaurant" },
    items: [{ name: "Margherita Pizza", quantity: 1, total: 119, variants: [{ name: "Hand Tossed" }] }],
    item_count: 1,
    pricing: { item_total: 119, to_pay: 187 },
    offers: { coupon_applied: null, coupon_discount: 0 },
    ...overrides,
  };
}

function orderSummary(overrides) {
  return {
    orderId: "order-1",
    restaurantId: "rest-1",
    restaurantName: "Test Restaurant",
    orderTotal: "301",
    orderStatus: "DELIVERED",
    orderedItems: "1x Chicken Biryani",
    orderedTime: "September 8, 3:59 PM",
    isActiveOrder: false,
    actions: [],
    ...overrides,
  };
}

function orderDetailsPayload(overrides) {
  return payload({
    order: {
      order_id: 1,
      restaurant_id: "rest-1",
      restaurant_name: "Test Restaurant",
      is_reorderable_order: true,
      order_items: [
        {
          item_id: "item-1",
          name: "Chicken Biryani",
          quantity: "1",
          variants: [{ variation_id: 10, group_id: 1, name: "Half", price: 0 }],
        },
      ],
      ...overrides,
    },
  });
}

// --- parseOrderConfirmationReply ---

test("parseOrderConfirmationReply recognizes common affirmative replies", () => {
  for (const text of ["yes", "YES", "y", "confirm", "place it", "proceed"]) {
    assert.equal(parseOrderConfirmationReply(text), "confirm");
  }
});

test("parseOrderConfirmationReply recognizes common negative replies", () => {
  for (const text of ["no", "NO", "n", "cancel", "stop"]) {
    assert.equal(parseOrderConfirmationReply(text), "cancel");
  }
});

test("parseOrderConfirmationReply returns undefined for anything else", () => {
  assert.equal(parseOrderConfirmationReply("maybe later"), undefined);
});

// --- resolvePendingCartCandidateReply: restaurant/item selection by number ---

test("resolvePendingCartCandidateReply: a bare number picks the restaurant off the shown list, deterministically", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantCandidates: [
      { id: "r-billu", name: "Billu's Pasta Hut (Ad)" },
      { id: "r-kfc", name: "KFC (Ad)" },
    ],
  });

  const outcome = await resolvePendingCartCandidateReply({
    message: message("2"),
    swiggyFoodClient: fakeClient(),
    pendingCartSessions,
  });

  assert.equal(outcome.handled, true);
  assert.equal(outcome.replyText, "Got it — what would you like from KFC (Ad)?");
  assert.deepEqual(pendingCartSessions.peek("sender-1"), {
    addressId: "addr-1",
    cartRestaurantId: undefined,
    restaurantId: "r-kfc",
    restaurantName: "KFC (Ad)",
  });
});

test("resolvePendingCartCandidateReply: picking a restaurant looks up items matching the original search term and lists them instead of asking freeform", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    searchTerm: "pizza",
    restaurantCandidates: [{ id: "r-kfc", name: "KFC" }, { id: "r-pizza", name: "Fake Pizza Co" }],
  });

  const menuSearchCalls = [];
  const client = fakeClient({
    searchMenu: async (params) => {
      menuSearchCalls.push(params);
      return payload({ items: [menuItem({ name: "Margherita Pizza", price: 219 })] });
    },
  });

  const outcome = await resolvePendingCartCandidateReply({ message: message("2"), swiggyFoodClient: client, pendingCartSessions });

  assert.deepEqual(menuSearchCalls, [{ query: "pizza", addressId: "addr-1", restaurantIdOfAddedItem: "r-pizza" }]);
  assert.match(outcome.replyText, /"pizza" at Fake Pizza Co/);
  assert.match(outcome.replyText, /1\. Margherita Pizza — ₹219/);
  assert.match(outcome.replyText, /Reply with the number/);

  const session = pendingCartSessions.peek("sender-1");
  assert.equal(session.restaurantId, "r-pizza");
  assert.equal(session.restaurantCandidates, undefined);
  assert.equal(session.itemCandidates.length, 1);
});

test("resolvePendingCartCandidateReply: a bare number then picks the item straight off that list and adds it to the cart, deterministically", async () => {
  const pendingCartSessions = new PendingCartSessions();
  const item = menuItem({ name: "Margherita Pizza", menu_item_id: "item-margherita" });
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantId: "r-pizza",
    restaurantName: "Fake Pizza Co",
    itemCandidates: [item],
  });

  const updateFoodCartCalls = [];
  let flushCalled = false;
  const client = fakeClient({
    flushFoodCart: async () => {
      flushCalled = true;
      return payload({ success: true });
    },
    updateFoodCart: async (params) => {
      updateFoodCartCalls.push(params);
      return cartPayload(cartData());
    },
  });

  const outcome = await resolvePendingCartCandidateReply({ message: message("1"), swiggyFoodClient: client, pendingCartSessions });

  // Regression coverage for a real bug found in manual testing: the cart
  // may already hold leftover items (and an already-applied coupon) from
  // an earlier restaurant, since nothing had touched the live cart yet at
  // restaurant-selection time (see the restaurantCandidates branch above) -
  // this must flush before adding, not merge onto whatever was already
  // there.
  assert.equal(flushCalled, true);
  assert.equal(updateFoodCartCalls.length, 1);
  assert.equal(updateFoodCartCalls[0].cartItems[0].menu_item_id, "item-margherita");
  assert.match(outcome.replyText, /Added Margherita Pizza to your cart/);
  assert.deepEqual(pendingCartSessions.peek("sender-1"), {
    restaurantId: "r-pizza",
    restaurantName: "Fake Pizza Co",
    addressId: "addr-1",
    cartRestaurantId: "r-pizza",
  });
});

test("resolvePendingCartCandidateReply: falls back to the freeform prompt when nothing matches the search term at the chosen restaurant", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    searchTerm: "sushi",
    restaurantCandidates: [{ id: "r-kfc", name: "KFC" }],
  });

  const client = fakeClient({ searchMenu: async () => payload({ items: [] }) });

  const outcome = await resolvePendingCartCandidateReply({ message: message("1"), swiggyFoodClient: client, pendingCartSessions });

  assert.equal(outcome.replyText, "Got it — what would you like from KFC?");
  assert.equal(pendingCartSessions.peek("sender-1").itemCandidates, undefined);
});

test("resolvePendingCartCandidateReply: falls back to the freeform prompt when the menu lookup for the chosen restaurant throws", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    searchTerm: "pizza",
    restaurantCandidates: [{ id: "r-kfc", name: "KFC" }],
  });

  const client = fakeClient({
    searchMenu: async () => {
      throw new Error("boom");
    },
  });

  const outcome = await resolvePendingCartCandidateReply({ message: message("1"), swiggyFoodClient: client, pendingCartSessions });

  assert.equal(outcome.replyText, "Got it — what would you like from KFC?");
});

test("resolvePendingCartCandidateReply: an out-of-range or non-numeric reply reports unhandled, so the caller falls through to the agent", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantCandidates: [{ id: "r-kfc", name: "KFC" }],
  });

  const outcome = await resolvePendingCartCandidateReply({
    message: message("from KFC add wings"),
    swiggyFoodClient: fakeClient(),
    pendingCartSessions,
  });

  assert.deepEqual(outcome, { handled: false });
});

test("resolvePendingCartCandidateReply: reports unhandled when there's no session at all", async () => {
  const outcome = await resolvePendingCartCandidateReply({
    message: message("2"),
    swiggyFoodClient: fakeClient(),
    pendingCartSessions: new PendingCartSessions(),
  });

  assert.deepEqual(outcome, { handled: false });
});

test("resolvePendingCartCandidateReply: a session with only an addressId (the recommend address-pick resume state) never matches a bare number - the reply must reach the agent, not be hijacked here", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-2" });

  const outcome = await resolvePendingCartCandidateReply({
    message: message("2"),
    swiggyFoodClient: fakeClient(),
    pendingCartSessions,
  });

  assert.deepEqual(outcome, { handled: false });
  assert.equal(pendingCartSessions.peek("sender-1").addressId, "addr-2");
});

// --- addToCart ---

test("addToCart bootstraps a session via cross-restaurant search", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });

  const searchCalls = [];
  const item = menuItem();
  const client = fakeClient({
    searchMenu: async (params) => {
      searchCalls.push(params);
      if (!params.restaurantIdOfAddedItem) {
        return payload({ items: [{ ...item, restaurant_id: "r-1", restaurant_name: "Test Restaurant" }] });
      }
      return payload({ items: [item] });
    },
    updateFoodCart: async () => cartPayload(cartData()),
  });

  const reply = await addToCart({
    senderId: "sender-1",
    query: "margherita pizza",
    quantity: 1,
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.equal(searchCalls.length, 2);
  assert.equal(searchCalls[0].restaurantIdOfAddedItem, undefined);
  assert.equal(searchCalls[1].restaurantIdOfAddedItem, "r-1");
  assert.match(reply, /Added Margherita Pizza to your cart/);
  assert.deepEqual(pendingCartSessions.peek("sender-1"), {
    restaurantId: "r-1",
    restaurantName: "Test Restaurant",
    addressId: "addr-1",
    cartRestaurantId: "r-1",
  });
});

test("addToCart reuses the existing restaurant, skips cross-restaurant search, and doesn't re-flush an already-correct cart", async () => {
  const pendingCartSessions = new PendingCartSessions();
  // cartRestaurantId already matches restaurantId - this session's own
  // prior add already confirmed the live cart is scoped to r-1, so this
  // second add must not flush it away.
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantId: "r-1",
    restaurantName: "Test Restaurant",
    cartRestaurantId: "r-1",
  });

  const searchCalls = [];
  let flushCalled = false;
  const client = fakeClient({
    searchMenu: async (params) => {
      searchCalls.push(params);
      return payload({ items: [menuItem()] });
    },
    updateFoodCart: async () => cartPayload(cartData()),
    flushFoodCart: async () => {
      flushCalled = true;
      return payload({ success: true });
    },
  });

  await addToCart({ senderId: "sender-1", query: "margherita pizza", quantity: 1, swiggyFoodClient: client, pendingCartSessions });

  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].restaurantIdOfAddedItem, "r-1");
  assert.equal(flushCalled, false);
});

test("addToCart flushes the cart first when it's not yet confirmed to match this restaurant (fresh session)", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test Restaurant" });

  const calls = [];
  const client = fakeClient({
    searchMenu: async () => payload({ items: [menuItem()] }),
    flushFoodCart: async () => {
      calls.push("flush");
      return payload({ success: true });
    },
    updateFoodCart: async () => {
      calls.push("update");
      return cartPayload(cartData());
    },
  });

  await addToCart({ senderId: "sender-1", query: "margherita pizza", quantity: 1, swiggyFoodClient: client, pendingCartSessions });

  // Flush must happen BEFORE the add, not after - otherwise it would wipe
  // out the item this same call just added.
  assert.deepEqual(calls, ["flush", "update"]);
});

test("addToCart honors an explicit restaurant name instead of the cross-restaurant search result", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });

  const restaurantSearchCalls = [];
  const menuSearchCalls = [];
  const client = fakeClient({
    searchRestaurants: async (params) => {
      restaurantSearchCalls.push(params);
      return payload({
        restaurants: [{ id: "r-pizzahut", name: "Pizza Hut", availabilityStatus: "OPEN" }],
      });
    },
    searchMenu: async (params) => {
      menuSearchCalls.push(params);
      return payload({ items: [menuItem({ name: "Margherita Ultimate Cheese Pizza" })] });
    },
    updateFoodCart: async () => cartPayload(cartData({ restaurant: { name: "Pizza Hut" } })),
  });

  const reply = await addToCart({
    senderId: "sender-1",
    query: "margherita pizza",
    quantity: 1,
    restaurantNameHint: "Pizza Hut",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.deepEqual(restaurantSearchCalls, [{ query: "Pizza Hut", addressId: "addr-1" }]);
  // Only the scoped search should run - never an unscoped cross-restaurant
  // search once the restaurant is already known from the hint.
  assert.equal(menuSearchCalls.length, 1);
  assert.equal(menuSearchCalls[0].restaurantIdOfAddedItem, "r-pizzahut");
  assert.match(reply, /Added Margherita Ultimate Cheese Pizza to your cart/);
  assert.deepEqual(pendingCartSessions.peek("sender-1"), {
    restaurantId: "r-pizzahut",
    restaurantName: "Pizza Hut",
    addressId: "addr-1",
    cartRestaurantId: "r-pizzahut",
  });
});

test("addToCart switches to a named restaurant that differs from the session's current one", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantId: "r-biryani",
    restaurantName: "Test Kitchen Biryani House",
    cartRestaurantId: "r-biryani",
  });

  const calls = [];
  const menuSearchCalls = [];
  const client = fakeClient({
    searchRestaurants: async () =>
      payload({ restaurants: [{ id: "r-taco", name: "Taco Fiesta (Mock)", availabilityStatus: "OPEN" }] }),
    searchMenu: async (params) => {
      menuSearchCalls.push(params);
      return payload({ items: [menuItem({ name: "Nachos Supreme" })] });
    },
    flushFoodCart: async () => {
      calls.push("flush");
      return payload({ success: true });
    },
    updateFoodCart: async (params) => {
      calls.push(`update:${params.restaurantId}`);
      return cartPayload(cartData({ restaurant: { name: "Taco Fiesta (Mock)" } }));
    },
  });

  const meta = {};
  const reply = await addToCart({
    senderId: "sender-1",
    query: "nachos supreme",
    quantity: 1,
    restaurantNameHint: "Taco Fiesta",
    swiggyFoodClient: client,
    pendingCartSessions,
    meta,
  });

  assert.equal(menuSearchCalls[0].restaurantIdOfAddedItem, "r-taco");
  assert.deepEqual(calls, ["flush", "update:r-taco"]);
  assert.match(reply, /^Added Nachos Supreme to your cart\./);
  assert.equal(meta.replacedEarlierCart, true);
  assert.equal(pendingCartSessions.peek("sender-1").cartRestaurantId, "r-taco");
});

test("addToCart doesn't re-resolve a named restaurant that matches the session's current one", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantId: "r-1",
    restaurantName: "Test Restaurant (Mock)",
    cartRestaurantId: "r-1",
  });

  let restaurantSearchCalled = false;
  const client = fakeClient({
    searchRestaurants: async () => {
      restaurantSearchCalled = true;
      return payload({ restaurants: [] });
    },
    searchMenu: async () => payload({ items: [menuItem()] }),
    updateFoodCart: async () => cartPayload(cartData()),
  });

  const reply = await addToCart({
    senderId: "sender-1",
    query: "margherita pizza",
    quantity: 1,
    restaurantNameHint: "Test Restaurant",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.equal(restaurantSearchCalled, false);
  assert.match(reply, /^Added .* to your cart\./);
});

test("addToCart skips a sponsored ad ranked ahead of the actual named restaurant", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });

  const menuSearchCalls = [];
  const updateFoodCartCalls = [];
  const client = fakeClient({
    searchRestaurants: async () =>
      payload({
        restaurants: [
          { id: "r-ad", name: "Billu's Food Hut (Ad)", availabilityStatus: "OPEN" },
          { id: "r-kfc", name: "KFC", availabilityStatus: "OPEN" },
        ],
      }),
    searchMenu: async (params) => {
      menuSearchCalls.push(params);
      return payload({ items: [menuItem({ name: "Zinger Burger" })] });
    },
    updateFoodCart: async (params) => {
      updateFoodCartCalls.push(params);
      return cartPayload(cartData({ restaurant: { name: "KFC" } }));
    },
  });

  const reply = await addToCart({
    senderId: "sender-1",
    query: "zinger burger",
    quantity: 1,
    restaurantNameHint: "KFC",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.equal(menuSearchCalls.length, 1);
  assert.equal(menuSearchCalls[0].restaurantIdOfAddedItem, "r-kfc");
  // The actual mutation must target the real restaurant, not the ad -
  // asserting the reply text alone wouldn't catch a wrong restaurantId
  // reaching Swiggy.
  assert.equal(updateFoodCartCalls.length, 1);
  assert.equal(updateFoodCartCalls[0].restaurantId, "r-kfc");
  assert.match(reply, /Added Zinger Burger to your cart/);
  assert.deepEqual(pendingCartSessions.peek("sender-1"), {
    restaurantId: "r-kfc",
    restaurantName: "KFC",
    addressId: "addr-1",
    cartRestaurantId: "r-kfc",
  });
});

test("addToCart reports a friendly message when the named restaurant can't be found", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });

  let updateCartCalled = false;
  const client = fakeClient({
    searchRestaurants: async () => payload({ restaurants: [] }),
    updateFoodCart: async () => {
      updateCartCalled = true;
      return cartPayload(cartData());
    },
  });

  const reply = await addToCart({
    senderId: "sender-1",
    query: "margherita pizza",
    quantity: 1,
    restaurantNameHint: "Nonexistent Place",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.match(reply, /couldn't find a restaurant called "Nonexistent Place"/);
  assert.equal(updateCartCalled, false);
});

test("addToCart names the restaurant when the dish isn't on its menu", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });

  const client = fakeClient({
    searchRestaurants: async () =>
      payload({ restaurants: [{ id: "r-pizzahut", name: "Pizza Hut", availabilityStatus: "OPEN" }] }),
    searchMenu: async () => payload({ items: [] }),
  });

  const reply = await addToCart({
    senderId: "sender-1",
    query: "sushi",
    quantity: 1,
    restaurantNameHint: "Pizza Hut",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.match(reply, /couldn't find "sushi" at Pizza Hut/);
});

// Confirmed live (2026-09-22, sender 919289388564): "Add items 1-9" right
// after Nosh itself listed all 9 as real, in-stock - only the one item
// already used earlier in conversation actually got added; the other 8
// (freshly-seen names reproduced across 8 rapid tool calls) all missed
// search_menu's own substring match, and the model fabricated a stock
// excuse for what was really its own near-miss. See resolveMenuItem's own
// comment in food-order-orchestrator.js.
test("addToCart falls back to a fuzzy match against the full menu when the exact query misses search_menu's own match", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Sushi Central" });

  const searchMenuCalls = [];
  const client = fakeClient({
    searchMenu: async (params) => {
      searchMenuCalls.push(params);
      // First call is the model's own (slightly off) query - misses. Second
      // call is the fallback's corrected query (the real item name, found
      // via getRestaurantMenu below) - succeeds.
      return searchMenuCalls.length === 1
        ? payload({ items: [] })
        : payload({ items: [menuItem({ name: "Chicken Katsu Curry", menu_item_id: "item-katsu" })] });
    },
    getRestaurantMenu: async () =>
      payload({ items: [{ id: "item-katsu", name: "Chicken Katsu Curry", price: 419, inStock: 1 }] }),
    updateFoodCart: async () => cartPayload(cartData({ restaurant: { name: "Sushi Central" } })),
  });

  const reply = await addToCart({
    senderId: "sender-1",
    query: "Katsu Curry",
    quantity: 1,
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.equal(searchMenuCalls.length, 2);
  assert.equal(searchMenuCalls[1].query, "Chicken Katsu Curry");
  assert.match(reply, /Added Chicken Katsu Curry to your cart/);
});

// The exact dangerous shape caught in review before shipping: a real
// restaurant (Taco Fiesta) whose real menu has "Veg Tacos (Mock)" but
// genuinely nothing called "taco" - the live transcript's actual query.
// A naive substring match (either direction) would silently add Veg Tacos
// instead of reporting the honest not-found this test locks in.
test("addToCart still reports not-found for a generic query that loosely matches an unrelated real item - no false positives", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Taco Fiesta" });

  const client = fakeClient({
    searchMenu: async () => payload({ items: [] }),
    getRestaurantMenu: async () =>
      payload({
        items: [
          { id: "item-1", name: "Veg Tacos (Mock)", price: 219, inStock: 1 },
          { id: "item-2", name: "Chicken Burrito (Mock)", price: 289, inStock: 1 },
        ],
      }),
  });

  const reply = await addToCart({
    senderId: "sender-1",
    query: "taco",
    quantity: 1,
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.match(reply, /couldn't find "taco"/);
});

// Ambiguity must also fail closed even when EVERY match is a real,
// legitimate substring hit (not just an accidental short-query one) -
// e.g. two size variants of the same dish. Guessing which one the user
// meant is exactly the kind of invented specificity this file's other
// hallucination guards already refuse to do.
test("addToCart reports not-found rather than guessing between two equally-valid fuzzy matches", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test Place" });

  const client = fakeClient({
    searchMenu: async () => payload({ items: [] }),
    getRestaurantMenu: async () =>
      payload({
        items: [
          { id: "item-1", name: "Chicken Katsu Curry (Small)", price: 349, inStock: 1 },
          { id: "item-2", name: "Chicken Katsu Curry (Large)", price: 449, inStock: 1 },
        ],
      }),
  });

  const reply = await addToCart({
    senderId: "sender-1",
    query: "Katsu Curry",
    quantity: 1,
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.match(reply, /couldn't find "Katsu Curry"/);
});

test("addToCart never calls the fuzzy-fallback menu lookup when the exact query already matched", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Sushi Central" });

  let getRestaurantMenuCalled = false;
  const client = fakeClient({
    searchMenu: async () => payload({ items: [menuItem({ name: "Miso Ramen" })] }),
    getRestaurantMenu: async () => {
      getRestaurantMenuCalled = true;
      return payload({ items: [] });
    },
    updateFoodCart: async () => cartPayload(cartData({ restaurant: { name: "Sushi Central" } })),
  });

  await addToCart({ senderId: "sender-1", query: "miso ramen", quantity: 1, swiggyFoodClient: client, pendingCartSessions });

  assert.equal(getRestaurantMenuCalled, false);
});

test("addToCart sends the default variant selection, not an invented one", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });

  let cartItemsSent;
  const client = fakeClient({
    searchMenu: async () => payload({ items: [menuItem()] }),
    updateFoodCart: async (params) => {
      cartItemsSent = params.cartItems;
      return cartPayload(cartData());
    },
  });

  await addToCart({ senderId: "sender-1", query: "pizza", quantity: 2, swiggyFoodClient: client, pendingCartSessions });

  assert.deepEqual(cartItemsSent, [
    {
      menu_item_id: "item-1",
      quantity: 2,
      variantsV2: [{ group_id: "g-crust", variation_id: "v-crust-default" }],
    },
  ]);
});

test("addToCart does not report success when update_food_cart returns a non-zero statusCode", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });

  const client = fakeClient({
    searchMenu: async () => payload({ items: [menuItem()] }),
    // A failed mutation can still echo back a data object (e.g. the
    // unchanged cart) - a non-zero statusCode must never be read as "added".
    updateFoodCart: async () => cartFailurePayload(cartData()),
  });

  const reply = await addToCart({
    senderId: "sender-1",
    query: "margherita pizza",
    quantity: 1,
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.doesNotMatch(reply, /Added/);
  // Session must stay exactly as it was before the failed attempt - no
  // restaurantName should get written in from a failed mutation's echo.
  assert.deepEqual(pendingCartSessions.peek("sender-1"), { addressId: "addr-1", restaurantId: "r-1" });
});

test("addToCart reports a friendly message when nothing matches", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });

  const client = fakeClient({ searchMenu: async () => payload({ items: [] }) });

  const reply = await addToCart({
    senderId: "sender-1",
    query: "unobtainium roll",
    quantity: 1,
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.match(reply, /couldn't find "unobtainium roll"/);
});

// --- searchMenu ---

test("searchMenu looks up a real item and price at a named restaurant without touching the cart", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });

  const restaurantSearchCalls = [];
  const menuSearchCalls = [];
  let updateFoodCartCalled = false;
  const client = fakeClient({
    searchRestaurants: async (params) => {
      restaurantSearchCalls.push(params);
      return payload({ restaurants: [{ id: "r-pizzahut", name: "Pizza Hut", availabilityStatus: "OPEN" }] });
    },
    searchMenu: async (params) => {
      menuSearchCalls.push(params);
      return payload({ items: [menuItem({ name: "Margherita Pizza", price: 249 })] });
    },
    updateFoodCart: async () => {
      updateFoodCartCalled = true;
      return cartPayload(cartData());
    },
  });

  const reply = await searchMenu({
    senderId: "sender-1",
    restaurantName: "Pizza Hut",
    query: "margherita pizza",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.deepEqual(restaurantSearchCalls, [{ query: "Pizza Hut", addressId: "addr-1" }]);
  assert.equal(menuSearchCalls[0].restaurantIdOfAddedItem, "r-pizzahut");
  assert.match(reply, /Margherita Pizza — ₹249/);
  assert.match(reply, /at Pizza Hut/);
  assert.equal(updateFoodCartCalled, false);
});

test("searchMenu reports no active order when search_food was never called for this sender", async () => {
  const pendingCartSessions = new PendingCartSessions();
  const client = fakeClient();

  const reply = await searchMenu({
    senderId: "sender-1",
    restaurantName: "Pizza Hut",
    query: "pizza",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.equal(reply, noActiveOrderReply());
});

test("searchMenu fuzzy-matches against search_food's own candidate list instead of a fresh Swiggy name search", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantCandidates: [
      { id: "r-biryani", name: "Test Kitchen Biryani House (Mock)" },
      { id: "r-pizza", name: "Fake Pizza Co (Mock)" },
    ],
  });

  let restaurantSearchCalled = false;
  const menuSearchCalls = [];
  const client = fakeClient({
    searchRestaurants: async () => {
      restaurantSearchCalled = true;
      return payload({ restaurants: [] });
    },
    searchMenu: async (params) => {
      menuSearchCalls.push(params);
      return payload({ items: [menuItem({ name: "Chicken Tikka Masala", price: 260 })] });
    },
  });

  // A paraphrased/approximate name, not the exact "(Mock)"-suffixed string
  // search_food actually returned.
  const reply = await searchMenu({
    senderId: "sender-1",
    restaurantName: "Test Kitchen Biryani House",
    query: "spicy",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.equal(restaurantSearchCalled, false);
  assert.equal(menuSearchCalls[0].restaurantIdOfAddedItem, "r-biryani");
  assert.match(reply, /Chicken Tikka Masala — ₹260/);
  assert.match(reply, /at Test Kitchen Biryani House \(Mock\)/);
});

// --- showRestaurantMenu (backs the agent's get_restaurant_menu tool) ---

function restaurantMenu(items, restaurant = { id: "r-1", name: "Burger Barn" }) {
  return payload({ restaurant, items });
}

test("showRestaurantMenu lists the session restaurant's real in-stock dishes with real prices, numbered", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Burger Barn" });

  const menuCalls = [];
  const client = fakeClient({
    getRestaurantMenu: async (params) => {
      menuCalls.push(params);
      return restaurantMenu([
        { id: "i-1", name: "Classic Cheeseburger", price: 219, inStock: 1 },
        { id: "i-2", name: "Sold Out Shake", price: 149, inStock: 0 },
        { id: "i-3", name: "Loaded Fries", price: 179, inStock: 1 },
      ]);
    },
  });

  const reply = await showRestaurantMenu({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions });

  assert.deepEqual(menuCalls, [{ addressId: "addr-1", restaurantId: "r-1" }]);
  assert.match(reply, /Burger Barn menu:/);
  assert.match(reply, /1\. Classic Cheeseburger — ₹219/);
  assert.match(reply, /2\. Loaded Fries — ₹179/);
  assert.doesNotMatch(reply, /Sold Out Shake/);
});

test("showRestaurantMenu resolves a named restaurant from search_food's candidates and makes it the session restaurant", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantId: "r-old",
    restaurantName: "Old Place",
    cartRestaurantId: "r-old",
    restaurantCandidates: [{ id: "r-sushi", name: "Sushi Central (Mock)" }],
    itemCandidates: [menuItem()],
    searchTerm: "sushi",
  });

  const menuCalls = [];
  const client = fakeClient({
    getRestaurantMenu: async (params) => {
      menuCalls.push(params);
      return restaurantMenu([{ id: "i-1", name: "Miso Ramen", price: 329, inStock: 1 }], {
        id: "r-sushi",
        name: "Sushi Central (Mock)",
      });
    },
  });

  const reply = await showRestaurantMenu({
    senderId: "sender-1",
    restaurantName: "Sushi Central",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.equal(menuCalls[0].restaurantId, "r-sushi");
  assert.match(reply, /1\. Miso Ramen — ₹329/);
  // A later add targets the menu's restaurant; the stale numbered lists are
  // dropped so a bare "1" can't be misread against them; cartRestaurantId is
  // kept so the cart only flushes on a real restaurant switch.
  assert.deepEqual(pendingCartSessions.peek("sender-1"), {
    addressId: "addr-1",
    restaurantId: "r-sushi",
    restaurantName: "Sushi Central (Mock)",
    cartRestaurantId: "r-old",
  });
});

test("showRestaurantMenu caps a long menu and says more dishes exist", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Burger Barn" });

  const items = Array.from({ length: 45 }, (_, index) => ({ id: `i-${index}`, name: `Dish ${index + 1}`, price: 100, inStock: 1 }));
  const client = fakeClient({ getRestaurantMenu: async () => restaurantMenu(items) });

  const reply = await showRestaurantMenu({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions });

  assert.match(reply, /40\. Dish 40 — ₹100/);
  assert.doesNotMatch(reply, /41\. Dish 41/);
  assert.match(reply, /Showing 40 dishes/);
});

test("showRestaurantMenu asks which restaurant when none is established or named, without calling Swiggy", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });

  let menuCalled = false;
  const client = fakeClient({
    getRestaurantMenu: async () => {
      menuCalled = true;
      return restaurantMenu([]);
    },
  });

  const reply = await showRestaurantMenu({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions });

  assert.match(reply, /Which restaurant's menu/);
  assert.equal(menuCalled, false);
});

test("showRestaurantMenu reports no active order when no address has been established", async () => {
  const pendingCartSessions = new PendingCartSessions();

  const reply = await showRestaurantMenu({ senderId: "sender-1", swiggyFoodClient: fakeClient(), pendingCartSessions });

  assert.equal(reply, noActiveOrderReply());
});

test("showRestaurantMenu never invents a menu when the lookup fails or comes back empty", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Burger Barn" });

  const throwingClient = fakeClient({
    getRestaurantMenu: async () => {
      throw new Error("boom");
    },
  });
  const failed = await showRestaurantMenu({ senderId: "sender-1", swiggyFoodClient: throwingClient, pendingCartSessions });
  assert.doesNotMatch(failed, /\d\. /);

  const emptyClient = fakeClient({ getRestaurantMenu: async () => restaurantMenu([]) });
  const empty = await showRestaurantMenu({ senderId: "sender-1", swiggyFoodClient: emptyClient, pendingCartSessions });
  assert.match(empty, /couldn't load Burger Barn's menu/);
});

test("searchMenu reports a friendly message when the named restaurant can't be found", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });
  const client = fakeClient({ searchRestaurants: async () => payload({ restaurants: [] }) });

  const reply = await searchMenu({
    senderId: "sender-1",
    restaurantName: "Nonexistent Place",
    query: "pizza",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.match(reply, /couldn't find a restaurant called "Nonexistent Place"/);
});

test("searchMenu reports when nothing matches at the resolved restaurant", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });
  const client = fakeClient({
    searchRestaurants: async () => payload({ restaurants: [{ id: "r-1", name: "Pizza Hut", availabilityStatus: "OPEN" }] }),
    searchMenu: async () => payload({ items: [] }),
  });

  const reply = await searchMenu({
    senderId: "sender-1",
    restaurantName: "Pizza Hut",
    query: "unobtainium roll",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.match(reply, /Couldn't find "unobtainium roll" at Pizza Hut/);
});

test("searchMenu reuses the session's already-established restaurant when no name hint is given", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-known", restaurantName: "Known Place" });

  let restaurantSearchCalled = false;
  const menuSearchCalls = [];
  const client = fakeClient({
    searchRestaurants: async () => {
      restaurantSearchCalled = true;
      return payload({ restaurants: [] });
    },
    searchMenu: async (params) => {
      menuSearchCalls.push(params);
      return payload({ items: [menuItem({ name: "Cheese Naan", price: 89 })] });
    },
  });

  const reply = await searchMenu({
    senderId: "sender-1",
    query: "naan",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.equal(restaurantSearchCalled, false);
  assert.equal(menuSearchCalls[0].restaurantIdOfAddedItem, "r-known");
  assert.match(reply, /Cheese Naan — ₹89/);
  assert.match(reply, /at Known Place/);
});

// --- viewCart / findCoupons / checkout without a session ---

test("non-add tools without an active session report no active order", async () => {
  const pendingCartSessions = new PendingCartSessions();
  const pendingOrderConfirmations = new PendingOrderConfirmations();
  const client = fakeClient();

  assert.equal(await viewCart({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions }), noActiveOrderReply());
  assert.equal(await findCoupons({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions }), noActiveOrderReply());
  assert.equal(
    await checkout({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions, pendingOrderConfirmations }),
    noActiveOrderReply(),
  );
});

test("viewCart/findCoupons/applyCoupon/checkout pass real lang through to noActiveOrderReply when there's no session", async () => {
  const pendingCartSessions = new PendingCartSessions();
  const pendingOrderConfirmations = new PendingOrderConfirmations();
  const client = fakeClient();

  assert.equal(
    await viewCart({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions, lang: "hi" }),
    noActiveOrderReply("hi"),
  );
  assert.equal(
    await findCoupons({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions, lang: "hinglish" }),
    noActiveOrderReply("hinglish"),
  );
  assert.equal(
    await applyCoupon({ senderId: "sender-1", couponCode: "X", swiggyFoodClient: client, pendingCartSessions, lang: "hi" }),
    noActiveOrderReply("hi"),
  );
  assert.equal(
    await checkout({
      senderId: "sender-1",
      swiggyFoodClient: client,
      pendingCartSessions,
      pendingOrderConfirmations,
      lang: "hinglish",
    }),
    noActiveOrderReply("hinglish"),
  );
  // Distinct per language, and distinct from English, so this test would
  // actually fail if lang weren't wired through.
  assert.notEqual(noActiveOrderReply("hi"), noActiveOrderReply());
  assert.notEqual(noActiveOrderReply("hinglish"), noActiveOrderReply());
});

test("checkout reports no active order when there's no session at all for the sender (not just a missing cartRestaurantId)", async () => {
  const reply = await checkout({
    senderId: "sender-1",
    swiggyFoodClient: fakeClient(),
    pendingCartSessions: new PendingCartSessions(),
    pendingOrderConfirmations: new PendingOrderConfirmations(),
  });

  assert.equal(reply, noActiveOrderReply());
});

// --- viewCart ---

test("viewCart formats the cart contents", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test Restaurant" });

  const client = fakeClient({ getFoodCart: async () => cartPayload(cartData()) });

  const reply = await viewCart({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions });

  assert.match(reply, /Test Restaurant/);
  assert.match(reply, /1x Margherita Pizza \(Hand Tossed\) — ₹119/);
  assert.match(reply, /Total: ₹187/);
});

test("viewCart reports an empty cart", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });

  const client = fakeClient({ getFoodCart: async () => cartPayload(cartData({ items: [] })) });

  const reply = await viewCart({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions });

  assert.match(reply, /cart is empty/);
});

// --- removeFromCart ---

test("removeFromCart removes the item entirely when no count is given", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test Restaurant" });

  const updateFoodCartCalls = [];
  const client = fakeClient({
    getFoodCart: async () =>
      cartPayload(
        cartData({
          items: [
            {
              menu_item_id: "item-1",
              name: "Margherita Pizza",
              quantity: 2,
              total: 238,
              variants: [{ group_id: "g-crust", variation_id: "v-crust-default", name: "Hand Tossed" }],
            },
          ],
        }),
      ),
    updateFoodCart: async (params) => {
      updateFoodCartCalls.push(params);
      return cartPayload(cartData({ items: [] }));
    },
  });

  const reply = await removeFromCart({ senderId: "sender-1", query: "pizza", swiggyFoodClient: client, pendingCartSessions });

  assert.equal(updateFoodCartCalls.length, 1);
  assert.equal(updateFoodCartCalls[0].cartItems[0].menu_item_id, "item-1");
  assert.equal(updateFoodCartCalls[0].cartItems[0].quantity, 0);
  // No variantsV2 on a full removal - that reconstructed field mapping is
  // unverified and serves no purpose when the whole point of the call is
  // to make the line disappear.
  assert.equal(updateFoodCartCalls[0].cartItems[0].variantsV2, undefined);
  assert.match(reply, /Removed Margherita Pizza from your cart/);
});

test("removeFromCart reduces the quantity when a count is given, preserving existing customization", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test Restaurant" });

  const updateFoodCartCalls = [];
  const client = fakeClient({
    getFoodCart: async () =>
      cartPayload(
        cartData({
          items: [
            {
              menu_item_id: "item-1",
              name: "Garlic Bread",
              quantity: 3,
              total: 150,
              variants: [{ group_id: "g-size", variation_id: "v-large", name: "Large" }],
            },
          ],
        }),
      ),
    updateFoodCart: async (params) => {
      updateFoodCartCalls.push(params);
      return cartPayload(cartData());
    },
  });

  const reply = await removeFromCart({
    senderId: "sender-1",
    query: "garlic bread",
    quantity: 1,
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.equal(updateFoodCartCalls[0].cartItems[0].quantity, 2);
  assert.deepEqual(updateFoodCartCalls[0].cartItems[0].variantsV2, [{ group_id: "g-size", variation_id: "v-large" }]);
  assert.match(reply, /Updated Garlic Bread to 2x/);
});

test("removeFromCart asks which item when the query matches more than one cart line, instead of guessing", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Fake Pizza Co" });

  let updateFoodCartCalled = false;
  const client = fakeClient({
    getFoodCart: async () =>
      cartPayload(
        cartData({
          items: [
            { menu_item_id: "item-margherita", name: "Margherita Pizza", quantity: 1, total: 219 },
            { menu_item_id: "item-pepperoni", name: "Pepperoni Pizza", quantity: 1, total: 269 },
          ],
        }),
      ),
    updateFoodCart: async () => {
      updateFoodCartCalled = true;
      return cartPayload(cartData());
    },
  });

  const reply = await removeFromCart({ senderId: "sender-1", query: "pizza", swiggyFoodClient: client, pendingCartSessions });

  assert.equal(updateFoodCartCalled, false);
  assert.match(reply, /Margherita Pizza/);
  assert.match(reply, /Pepperoni Pizza/);
  assert.match(reply, /Which one did you mean/);
});

test("removeFromCart clamps at zero rather than going negative", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test Restaurant" });

  const updateFoodCartCalls = [];
  const client = fakeClient({
    getFoodCart: async () =>
      cartPayload(cartData({ items: [{ menu_item_id: "item-1", name: "Garlic Bread", quantity: 1, total: 50 }] })),
    updateFoodCart: async (params) => {
      updateFoodCartCalls.push(params);
      return cartPayload(cartData({ items: [] }));
    },
  });

  await removeFromCart({ senderId: "sender-1", query: "garlic bread", quantity: 5, swiggyFoodClient: client, pendingCartSessions });

  assert.equal(updateFoodCartCalls[0].cartItems[0].quantity, 0);
});

test("removeFromCart reports when the dish isn't in the cart", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test Restaurant" });

  let updateFoodCartCalled = false;
  const client = fakeClient({
    getFoodCart: async () =>
      cartPayload(cartData({ items: [{ menu_item_id: "item-1", name: "Margherita Pizza", quantity: 1, total: 119 }] })),
    updateFoodCart: async () => {
      updateFoodCartCalled = true;
      return cartPayload(cartData());
    },
  });

  const reply = await removeFromCart({ senderId: "sender-1", query: "biryani", swiggyFoodClient: client, pendingCartSessions });

  assert.equal(updateFoodCartCalled, false);
  assert.match(reply, /couldn't find "biryani" in your cart/);
});

test("removeFromCart reports an empty cart", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test Restaurant" });

  const client = fakeClient({ getFoodCart: async () => cartPayload(cartData({ items: [] })) });

  const reply = await removeFromCart({ senderId: "sender-1", query: "pizza", swiggyFoodClient: client, pendingCartSessions });

  assert.match(reply, /cart is empty/);
});

test("removeFromCart falls back to a generic reply when update_food_cart throws", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test Restaurant" });

  const client = fakeClient({
    getFoodCart: async () =>
      cartPayload(cartData({ items: [{ menu_item_id: "item-1", name: "Margherita Pizza", quantity: 1, total: 119 }] })),
    updateFoodCart: async () => {
      throw new Error("boom");
    },
  });

  const reply = await removeFromCart({ senderId: "sender-1", query: "pizza", swiggyFoodClient: client, pendingCartSessions });

  assert.match(reply, /couldn't do that right now/);
});

// --- findCoupons / applyCoupon ---

test("findCoupons lists each coupon's code as the title field", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });

  const client = fakeClient({
    fetchFoodCoupons: async () =>
      payload({
        coupon_sections: [
          { coupons: [{ title: "SWIGGYIT", description: "20% off orders above ₹189" }] },
        ],
      }),
  });

  const reply = await findCoupons({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions });

  assert.match(reply, /SWIGGYIT — 20% off orders above ₹189/);
});

test("findCoupons reports when there are none", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });

  const client = fakeClient({ fetchFoodCoupons: async () => payload({ coupon_sections: [] }) });

  const reply = await findCoupons({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions });

  assert.match(reply, /No coupons available/);
});

test("applyCoupon reports success only when coupon_discount is greater than zero", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });

  const client = fakeClient({
    applyFoodCoupon: async () => cartPayload(cartData({ offers: { coupon_discount: 50 } })),
  });

  const reply = await applyCoupon({ senderId: "sender-1", couponCode: "SWIGGYIT", swiggyFoodClient: client, pendingCartSessions });

  assert.match(reply, /Applied SWIGGYIT — you saved ₹50/);
});

test("applyCoupon never claims a discount when coupon_discount is 0 (suggested, not applied)", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });

  const client = fakeClient({
    applyFoodCoupon: async () => cartPayload(cartData({ offers: { coupon_discount: 0 } })),
  });

  const reply = await applyCoupon({ senderId: "sender-1", couponCode: "SWIGGYIT", swiggyFoodClient: client, pendingCartSessions });

  assert.doesNotMatch(reply, /Applied/);
  assert.match(reply, /isn't giving a discount/);
});

test("applyCoupon degrades gracefully when the tool rejects the code", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });

  const client = fakeClient({
    applyFoodCoupon: async () => {
      throw new Error("not valid in this time slot");
    },
  });

  const reply = await applyCoupon({ senderId: "sender-1", couponCode: "BADCODE", swiggyFoodClient: client, pendingCartSessions });

  assert.match(reply, /couldn't apply "BADCODE"/);
});

// --- checkout ---

test("checkout builds a summary and stores a pending confirmation", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantId: "r-1",
    restaurantName: "Test Restaurant",
    cartRestaurantId: "r-1",
  });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const getFoodCartCalls = [];
  const client = fakeClient({
    getFoodCart: async (params) => {
      getFoodCartCalls.push(params);
      return cartPayload(cartData());
    },
    getPaymentOptions: async () => payload({ cod: { available: true, displayName: "Cash on Delivery" } }),
  });

  const reply = await checkout({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions, pendingOrderConfirmations });

  // get_food_cart doesn't always return the restaurant name unless it's
  // passed in (confirmed live) - checkout must carry it forward from the
  // session, not just get_food_cart's own response.
  assert.deepEqual(getFoodCartCalls, [{ addressId: "addr-1", restaurantName: "Test Restaurant" }]);
  assert.match(reply, /Order summary — Test Restaurant/);
  assert.match(reply, /Total to pay: ₹187/);
  assert.match(reply, /Reply YES to place this order, or NO to cancel/);
  assert.deepEqual(pendingOrderConfirmations.peek("sender-1"), {
    addressId: "addr-1",
    cartId: 1,
    paymentMethod: "Cash",
  });
});

test("checkout refuses an empty cart", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", cartRestaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({ getFoodCart: async () => cartPayload(cartData({ items: [] })) });

  const reply = await checkout({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions, pendingOrderConfirmations });

  assert.match(reply, /cart is empty/);
  assert.equal(pendingOrderConfirmations.peek("sender-1"), undefined);
});

test("checkout reports no active order rather than building a summary from a cart this session never established", async () => {
  const pendingCartSessions = new PendingCartSessions();
  // restaurantId is set (e.g. from a numbered restaurant pick) but nothing
  // has actually been added yet, so cartRestaurantId is unset - the live
  // cart could still hold leftover items from an earlier session/restaurant.
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test Restaurant" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  let getFoodCartCalled = false;
  const client = fakeClient({
    getFoodCart: async () => {
      getFoodCartCalled = true;
      return cartPayload(cartData());
    },
  });

  const reply = await checkout({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions, pendingOrderConfirmations });

  assert.equal(getFoodCartCalled, false);
  assert.equal(reply, noActiveOrderReply());
  assert.equal(pendingOrderConfirmations.peek("sender-1"), undefined);
});

test("checkout never guesses a payment method when COD isn't available", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", cartRestaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({
    getFoodCart: async () => cartPayload(cartData()),
    getPaymentOptions: async () => payload({ cod: { available: false } }),
  });

  const reply = await checkout({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions, pendingOrderConfirmations });

  assert.match(reply, /Cash on Delivery isn't available/);
  assert.equal(pendingOrderConfirmations.peek("sender-1"), undefined);
});

// Real Swiggy Builders Club platform rule (verified against
// docs/build/recipes/order-food.md, not invented) - see
// BUILDERS_CLUB_CART_CAP's own comment in food-order-orchestrator.js.
test("checkout refuses a cart over the ₹1000 Builders Club cap without spending a getPaymentOptions call", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", cartRestaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  let getPaymentOptionsCalled = false;
  const client = fakeClient({
    getFoodCart: async () => cartPayload(cartData({ pricing: { item_total: 950, to_pay: 1050 } })),
    getPaymentOptions: async () => {
      getPaymentOptionsCalled = true;
      return payload({ cod: { available: true, displayName: "Cash on Delivery" } });
    },
  });

  const reply = await checkout({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions, pendingOrderConfirmations });

  assert.match(reply, /₹1050/);
  assert.match(reply, /₹1000/);
  assert.equal(getPaymentOptionsCalled, false);
  assert.equal(pendingOrderConfirmations.peek("sender-1"), undefined);
});

test("checkout allows a cart exactly at the ₹1000 cap (strictly-greater-than, not greater-or-equal)", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", cartRestaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({
    getFoodCart: async () => cartPayload(cartData({ pricing: { item_total: 900, to_pay: 1000 } })),
    getPaymentOptions: async () => payload({ cod: { available: true, displayName: "Cash on Delivery" } }),
  });

  const reply = await checkout({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions, pendingOrderConfirmations });

  assert.match(reply, /Reply YES to place this order, or NO to cancel/);
  assert.ok(pendingOrderConfirmations.peek("sender-1"));
});

test("checkout's order summary keeps the literal uppercase YES/NO tokens in every language - parseOrderConfirmationReply and server.js's own backstop are both English-only by design", async () => {
  for (const lang of ["en", "hi", "hinglish"]) {
    const pendingCartSessions = new PendingCartSessions();
    pendingCartSessions.set("sender-1", {
      addressId: "addr-1",
      restaurantId: "r-1",
      restaurantName: "Test Restaurant",
      cartRestaurantId: "r-1",
    });
    const pendingOrderConfirmations = new PendingOrderConfirmations();
    const client = fakeClient({
      getFoodCart: async () => cartPayload(cartData()),
      getPaymentOptions: async () => payload({ cod: { available: true, displayName: "Cash on Delivery" } }),
    });

    const reply = await checkout({
      senderId: "sender-1",
      swiggyFoodClient: client,
      pendingCartSessions,
      pendingOrderConfirmations,
      lang,
    });

    assert.match(reply, /\bYES\b/, `lang=${lang} must contain a literal YES`);
    assert.match(reply, /\bNO\b/, `lang=${lang} must contain a literal NO`);
  }
});

test("checkout translates the order summary for hi/hinglish while keeping YES/NO literal", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantId: "r-1",
    restaurantName: "Test Restaurant",
    cartRestaurantId: "r-1",
  });
  const pendingOrderConfirmations = new PendingOrderConfirmations();
  const client = fakeClient({
    getFoodCart: async () => cartPayload(cartData()),
    getPaymentOptions: async () => payload({ cod: { available: true, displayName: "Cash on Delivery" } }),
  });

  const reply = await checkout({
    senderId: "sender-1",
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    lang: "hi",
  });

  assert.match(reply, /ऑर्डर सारांश/);
  assert.match(reply, /YES लिखें/);
  assert.match(reply, /NO लिखें/);
});

// --- placeConfirmedOrder ---

test("placeConfirmedOrder places and confirms on the happy path", async () => {
  const calls = [];
  const client = {
    placeFoodOrder: async (params) => {
      calls.push(["place", params]);
      return payload({ orderId: "order-1", lat: 1.1, lng: 2.2 });
    },
    confirmOrder: async (params) => {
      calls.push(["confirm", params]);
      return payload({ result: "success" });
    },
    flushFoodCart: async (params) => {
      calls.push(["flush", params]);
      return payload({ success: true });
    },
  };

  const result = await placeConfirmedOrder({
    swiggyFoodClient: client,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
  });

  assert.deepEqual(result, { status: "confirmed", replyText: "Your order has been placed! You'll get delivery updates from Swiggy." });
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], "place");
  assert.deepEqual(calls[1][1], { orderId: "order-1", addressId: "addr-1", cartId: 1, lat: 1.1, lng: 2.2 });
  assert.equal(calls[2][0], "flush");
});

test("placeConfirmedOrder still reports confirmed when flushFoodCart fails after a successful confirm", async () => {
  const client = {
    placeFoodOrder: async () => payload({ orderId: "order-1", lat: 1.1, lng: 2.2 }),
    confirmOrder: async () => payload({ result: "success" }),
    flushFoodCart: async () => {
      throw new Error("boom");
    },
  };

  const result = await placeConfirmedOrder({
    swiggyFoodClient: client,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
  });

  assert.deepEqual(result, { status: "confirmed", replyText: "Your order has been placed! You'll get delivery updates from Swiggy." });
});

test("placeConfirmedOrder reports failure without throwing when placeFoodOrder rejects", async () => {
  const client = {
    placeFoodOrder: async () => {
      throw new Error("boom");
    },
  };

  const result = await placeConfirmedOrder({
    swiggyFoodClient: client,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
  });

  assert.equal(result.status, "failed");
});

test("placeConfirmedOrder reports failure when the response has no orderId", async () => {
  const client = { placeFoodOrder: async () => payload({}) };

  const result = await placeConfirmedOrder({
    swiggyFoodClient: client,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
  });

  assert.equal(result.status, "failed");
});

test("placeConfirmedOrder reports placed_not_confirmed when confirmOrder fails, without losing the orderId", async () => {
  const client = {
    placeFoodOrder: async () => payload({ orderId: "order-1", lat: 1.1, lng: 2.2 }),
    confirmOrder: async () => {
      throw new Error("boom");
    },
  };

  const result = await placeConfirmedOrder({
    swiggyFoodClient: client,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
  });

  assert.equal(result.status, "placed_not_confirmed");
  assert.equal(result.orderId, "order-1");
});

test("placeConfirmedOrder's placed_not_confirmed re-prompt keeps the literal uppercase YES token in every language", async () => {
  for (const lang of ["en", "hi", "hinglish"]) {
    const client = {
      placeFoodOrder: async () => payload({ orderId: "order-1", lat: 1.1, lng: 2.2 }),
      confirmOrder: async () => {
        throw new Error("boom");
      },
    };

    const result = await placeConfirmedOrder({
      swiggyFoodClient: client,
      confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
      lang,
    });

    assert.equal(result.status, "placed_not_confirmed");
    assert.match(result.replyText, /\bYES\b/, `lang=${lang} must contain a literal YES`);
  }
});

test("placeConfirmedOrder translates its outcomes for hi/hinglish", async () => {
  const failClient = {
    placeFoodOrder: async () => {
      throw new Error("boom");
    },
    getFoodOrders: async () => payload({ orders: [] }),
  };

  const failResult = await placeConfirmedOrder({
    swiggyFoodClient: failClient,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
    lang: "hinglish",
  });
  assert.equal(failResult.status, "failed");
  assert.match(failResult.replyText, /order place nahi kar saka/);

  const confirmedClient = {
    placeFoodOrder: async () => payload({ orderId: "order-1" }),
    confirmOrder: async () => payload({ result: "success" }),
    flushFoodCart: async () => payload({}),
  };

  const confirmedResult = await placeConfirmedOrder({
    swiggyFoodClient: confirmedClient,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
    lang: "hi",
  });
  assert.equal(confirmedResult.status, "confirmed");
  assert.match(confirmedResult.replyText, /आपका ऑर्डर दे दिया गया है/);
});

test("placeConfirmedOrder never calls placeFoodOrder again once an orderId is already known (retry safety)", async () => {
  let placeCalls = 0;
  const client = {
    placeFoodOrder: async () => {
      placeCalls += 1;
      return payload({ orderId: "order-1" });
    },
    confirmOrder: async () => payload({ result: "success" }),
  };

  const result = await placeConfirmedOrder({
    swiggyFoodClient: client,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash", orderId: "order-1", lat: 1.1, lng: 2.2 },
  });

  assert.equal(placeCalls, 0);
  assert.equal(result.status, "confirmed");
});

test("placeConfirmedOrder treats a placeFoodOrder throw as success if a new order shows up in getFoodOrders (went through despite the error)", async () => {
  let getFoodOrdersCalls = 0;
  const confirmCalls = [];
  const client = {
    getFoodOrders: async () => {
      getFoodOrdersCalls += 1;
      // First call (the pre-attempt baseline) sees only the old order;
      // the second call (after placeFoodOrder throws) sees a new one too.
      const orders = getFoodOrdersCalls === 1 ? [{ orderId: "old-order" }] : [{ orderId: "old-order" }, { orderId: "new-order" }];
      return payload({ orders });
    },
    placeFoodOrder: async () => {
      throw new Error("network error, response lost");
    },
    confirmOrder: async (params) => {
      confirmCalls.push(params);
      return payload({ result: "success" });
    },
  };

  const result = await placeConfirmedOrder({
    swiggyFoodClient: client,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
  });

  assert.equal(result.status, "confirmed");
  assert.equal(confirmCalls.length, 1);
  assert.equal(confirmCalls[0].orderId, "new-order");
});

test("placeConfirmedOrder still reports failure when placeFoodOrder throws and no new order appears", async () => {
  const client = {
    getFoodOrders: async () => payload({ orders: [{ orderId: "old-order" }] }),
    placeFoodOrder: async () => {
      throw new Error("boom");
    },
  };

  const result = await placeConfirmedOrder({
    swiggyFoodClient: client,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
  });

  assert.equal(result.status, "failed");
});

// --- findUsualOrder ---

test("findUsualOrder requires at least 2 non-active orders at the same restaurant", () => {
  const orders = [orderSummary({ orderId: "o1", restaurantId: "rest-1" })];
  assert.equal(findUsualOrder(orders), undefined);
});

test("findUsualOrder returns the most recent qualifying order (get_food_orders is newest-first)", () => {
  const orders = [
    orderSummary({ orderId: "o3", restaurantId: "rest-1" }),
    orderSummary({ orderId: "o2", restaurantId: "rest-2" }),
    orderSummary({ orderId: "o1", restaurantId: "rest-1" }),
    orderSummary({ orderId: "o0", restaurantId: "rest-2" }),
  ];

  const result = findUsualOrder(orders);
  assert.equal(result.orderId, "o3");
  assert.equal(result.restaurantId, "rest-1");
});

test("findUsualOrder ignores active (in-progress) orders when counting", () => {
  const orders = [
    orderSummary({ orderId: "o2", restaurantId: "rest-1", isActiveOrder: true }),
    orderSummary({ orderId: "o1", restaurantId: "rest-1" }),
  ];

  assert.equal(findUsualOrder(orders), undefined);
});

test("findUsualOrder ignores orders with no restaurantId", () => {
  const orders = [
    orderSummary({ orderId: "o2", restaurantId: undefined }),
    orderSummary({ orderId: "o1", restaurantId: undefined }),
  ];

  assert.equal(findUsualOrder(orders), undefined);
});

// --- buildReorderUsualReply ---

test("buildReorderUsualReply rebuilds the cart from the qualifying order and shows the live total, not the old order's", async () => {
  const pendingCartSessions = new PendingCartSessions();
  const updateFoodCartCalls = [];
  const flushCalls = [];

  const client = fakeClient({
    getFoodOrders: async () =>
      payload({
        orders: [
          orderSummary({ orderId: "o2", restaurantId: "rest-1" }),
          orderSummary({ orderId: "o1", restaurantId: "rest-1" }),
        ],
      }),
    getFoodOrderDetails: async (params) => {
      assert.deepEqual(params, { orderId: "o2" });
      return orderDetailsPayload();
    },
    flushFoodCart: async () => {
      flushCalls.push(true);
      return payload({ success: true });
    },
    updateFoodCart: async (params) => {
      updateFoodCartCalls.push(params);
      return cartPayload(cartData());
    },
  });

  const reply = await buildReorderUsualReply({
    senderId: "sender-1",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.equal(flushCalls.length, 1);
  assert.equal(updateFoodCartCalls.length, 1);
  assert.equal(updateFoodCartCalls[0].restaurantId, "rest-1");
  assert.equal(updateFoodCartCalls[0].addressId, "addr-1");
  assert.deepEqual(updateFoodCartCalls[0].cartItems, [
    { menu_item_id: "item-1", quantity: 1, variantsV2: [{ group_id: 1, variation_id: 10 }] },
  ]);
  assert.match(reply, /Reordering your usual from Test Restaurant/);
  // cartData()'s pricing.to_pay (187), not the old order's orderTotal (301)
  // - the reply must show the freshly-rebuilt cart's live total.
  assert.match(reply, /Total: ₹187/);
  assert.doesNotMatch(reply, /301/);
  assert.deepEqual(pendingCartSessions.peek("sender-1"), {
    restaurantId: "rest-1",
    restaurantName: "Test Restaurant",
    addressId: "addr-1",
    cartRestaurantId: "rest-1",
  });
});

test("buildReorderUsualReply gives a plain reply when no restaurant has a repeat order", async () => {
  const pendingCartSessions = new PendingCartSessions();
  const client = fakeClient({
    getFoodOrders: async () => payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1" })] }),
  });

  const reply = await buildReorderUsualReply({
    senderId: "sender-1",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.match(reply, /don't have a repeat order/);
  assert.equal(pendingCartSessions.peek("sender-1"), undefined);
});

test("buildReorderUsualReply declines when Swiggy reports the qualifying order isn't reorderable", async () => {
  const pendingCartSessions = new PendingCartSessions();
  const client = fakeClient({
    getFoodOrders: async () =>
      payload({
        orders: [
          orderSummary({ orderId: "o2", restaurantId: "rest-1" }),
          orderSummary({ orderId: "o1", restaurantId: "rest-1" }),
        ],
      }),
    getFoodOrderDetails: async () => orderDetailsPayload({ is_reorderable_order: false }),
  });

  const reply = await buildReorderUsualReply({
    senderId: "sender-1",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.match(reply, /don't have a repeat order/);
});

test("buildReorderUsualReply tells the user to add an address when they have none", async () => {
  const pendingCartSessions = new PendingCartSessions();
  const client = fakeClient({
    getAddresses: async () => payload({ addresses: [], total: 0 }),
  });

  const reply = await buildReorderUsualReply({
    senderId: "sender-1",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.match(reply, /don't have a saved delivery address/);
});

test("buildReorderUsualReply skips an order item with no item_id rather than inventing one", async () => {
  const pendingCartSessions = new PendingCartSessions();
  const updateFoodCartCalls = [];
  const client = fakeClient({
    getFoodOrders: async () =>
      payload({
        orders: [
          orderSummary({ orderId: "o2", restaurantId: "rest-1" }),
          orderSummary({ orderId: "o1", restaurantId: "rest-1" }),
        ],
      }),
    getFoodOrderDetails: async () =>
      orderDetailsPayload({
        order_items: [
          { item_id: "item-1", name: "Chicken Biryani", quantity: "1" },
          { name: "Mystery Item", quantity: "1" },
        ],
      }),
    updateFoodCart: async (params) => {
      updateFoodCartCalls.push(params);
      return cartPayload(cartData());
    },
  });

  await buildReorderUsualReply({ senderId: "sender-1", swiggyFoodClient: client, pendingCartSessions });

  assert.equal(updateFoodCartCalls[0].cartItems.length, 1);
  assert.equal(updateFoodCartCalls[0].cartItems[0].menu_item_id, "item-1");
});

test("buildReorderUsualReply falls back to a generic reply when updateFoodCart throws", async () => {
  const pendingCartSessions = new PendingCartSessions();
  const client = fakeClient({
    getFoodOrders: async () =>
      payload({
        orders: [
          orderSummary({ orderId: "o2", restaurantId: "rest-1" }),
          orderSummary({ orderId: "o1", restaurantId: "rest-1" }),
        ],
      }),
    getFoodOrderDetails: async () => orderDetailsPayload(),
    updateFoodCart: async () => {
      throw new Error("boom");
    },
  });

  const reply = await buildReorderUsualReply({
    senderId: "sender-1",
    swiggyFoodClient: client,
    pendingCartSessions,
  });

  assert.match(reply, /couldn't do that right now/);
});

// --- recommendSimilar ---

function restaurantMenuItemsPayload(items) {
  return payload({ items });
}

test("recommendSimilar (no craving) returns real, in-stock, not-yet-tried items from the most-recent distinct restaurants in real order history", async () => {
  const client = fakeClient({
    getFoodOrders: async () =>
      payload({
        orders: [
          orderSummary({ orderId: "o3", restaurantId: "rest-1", restaurantName: "Biryani House", orderedItems: "1x Chicken Biryani" }),
          orderSummary({ orderId: "o2", restaurantId: "rest-2", restaurantName: "Pizza Place", orderedItems: "1x Margherita" }),
          orderSummary({ orderId: "o1", restaurantId: "rest-1", restaurantName: "Biryani House", orderedItems: "1x Mutton Biryani" }),
        ],
      }),
    getRestaurantMenu: async ({ restaurantId }) =>
      restaurantId === "rest-1"
        ? restaurantMenuItemsPayload([
            { id: "i1", name: "Chicken Biryani", price: 249, inStock: 1 },
            { id: "i2", name: "Veg Biryani", price: 199, inStock: 1 },
          ])
        : restaurantMenuItemsPayload([{ id: "i3", name: "Farmhouse Pizza", price: 299, inStock: 1 }]),
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client });

  // Most-recently-ordered-from restaurant first.
  const biryaniIndex = reply.indexOf("Biryani House");
  const pizzaIndex = reply.indexOf("Pizza Place");
  assert.ok(biryaniIndex >= 0 && pizzaIndex >= 0 && biryaniIndex < pizzaIndex);
  // Already-ordered item excluded entirely from the real candidate lines (a not-yet-tried one exists) -
  // it's still mentioned in the "previously ordered" history note, just not offered as a candidate.
  assert.doesNotMatch(reply, /- Chicken Biryani/);
  assert.match(reply, /Veg Biryani — ₹199/);
  assert.match(reply, /Farmhouse Pizza — ₹299/);
  assert.match(reply, /Pick ONE item from the list above/);
  assert.match(reply, /Never invent a dish, restaurant, price, rating, or delivery time/);
});

// Explicit user ask (2026-09-22): "I want to use the previous order to
// suggest something new and not the same thing" - a real transcript showed
// recommend_similar permanently capped at only the 1-2 restaurants a user
// has ever ordered from, since Case A used to dedupe order history alone.
// This proves the fix: a real, open, genuinely-not-yet-ordered-from
// restaurant (found via one of EXPLORE_CUISINE_TERMS) shows up alongside
// the history-based one, honestly labeled as new rather than folded into
// "previously ordered."
test("recommendSimilar (no craving) also offers a real restaurant outside the user's order history entirely, not just untried dishes at familiar ones", async () => {
  const client = fakeClient({
    getFoodOrders: async () =>
      payload({
        orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1", restaurantName: "Biryani House", orderedItems: "1x Chicken Biryani" })],
      }),
    // Matches whichever explore cuisine term happens to be tried first -
    // findExploreRestaurants shuffles EXPLORE_CUISINE_TERMS per call, so
    // this must not depend on a specific term to stay deterministic.
    searchRestaurants: async () => payload({ restaurants: [{ id: "rest-9", name: "Dragon Wok", availabilityStatus: "OPEN" }] }),
    getRestaurantMenu: async ({ restaurantId }) =>
      restaurantId === "rest-1"
        ? restaurantMenuItemsPayload([{ id: "i1", name: "Chicken Biryani", price: 249, inStock: 1 }])
        : restaurantMenuItemsPayload([{ id: "i9", name: "Chilli Chicken", price: 259, inStock: 1 }]),
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client });

  assert.match(reply, /Biryani House/);
  assert.match(reply, /Dragon Wok/);
  assert.match(reply, /Chilli Chicken — ₹259/);
  assert.match(reply, /you haven't ordered from here before/);
  assert.match(reply, /genuinely new restaurant outside their history/);
});

test("recommendSimilar (no craving) falls back to a restaurant's top items, marked as already-ordered, when everything there was already tried", async () => {
  const client = fakeClient({
    getFoodOrders: async () =>
      payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1", restaurantName: "Biryani House", orderedItems: "1x Chicken Biryani" })] }),
    getRestaurantMenu: async () => restaurantMenuItemsPayload([{ id: "i1", name: "Chicken Biryani", price: 249, inStock: 1 }]),
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client });

  assert.match(reply, /Chicken Biryani — ₹249 \(they've ordered this, or something like it, before\)/);
});

test("recommendSimilar (no craving) excludes out-of-stock items and prefers bestsellers first", async () => {
  const client = fakeClient({
    getFoodOrders: async () =>
      payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1", restaurantName: "Biryani House" })] }),
    getRestaurantMenu: async () =>
      restaurantMenuItemsPayload([
        { id: "i1", name: "Regular Item", price: 100, inStock: 1, isBestseller: false },
        { id: "i2", name: "Out of Stock Item", price: 150, inStock: 0 },
        { id: "i3", name: "Bestseller Item", price: 200, inStock: 1, isBestseller: true },
      ]),
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client });

  assert.doesNotMatch(reply, /Out of Stock Item/);
  assert.ok(reply.indexOf("Bestseller Item") < reply.indexOf("Regular Item"));
});

test("recommendSimilar ignores active (in-progress) orders", async () => {
  const client = fakeClient({
    getFoodOrders: async () =>
      payload({
        orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1", restaurantName: "Biryani House", isActiveOrder: true })],
      }),
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client });

  assert.match(reply, /don't have any past orders/);
});

test("recommendSimilar tells the user to add an address when they have none", async () => {
  const client = fakeClient({ getAddresses: async () => payload({ addresses: [], total: 0 }) });

  const reply = await recommendSimilar({ swiggyFoodClient: client });

  assert.match(reply, /don't have a saved delivery address/);
});

test("recommendSimilar gives a plain reply when there's no order history at all", async () => {
  const client = fakeClient({ getFoodOrders: async () => payload({ orders: [] }) });

  const reply = await recommendSimilar({ swiggyFoodClient: client });

  assert.match(reply, /don't have any past orders/);
});

test("recommendSimilar falls back to a generic reply when getFoodOrders throws", async () => {
  const client = fakeClient({
    getFoodOrders: async () => {
      throw new Error("boom");
    },
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client });

  assert.match(reply, /couldn't do that right now/);
});

test("recommendSimilar never mutates the cart", async () => {
  let updateFoodCartCalled = false;
  const client = fakeClient({
    getFoodOrders: async () => payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1" })] }),
    getRestaurantMenu: async () => restaurantMenuItemsPayload([{ id: "i1", name: "Item", price: 100, inStock: 1 }]),
    updateFoodCart: async () => {
      updateFoodCartCalled = true;
      return cartPayload(cartData());
    },
  });

  await recommendSimilar({ swiggyFoodClient: client });

  assert.equal(updateFoodCartCalled, false);
});

test("recommendSimilar persists the resolved address so a following add_to_cart call reuses it", async () => {
  const pendingCartSessions = new PendingCartSessions();
  const client = fakeClient({
    getFoodOrders: async () => payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1" })] }),
    getRestaurantMenu: async () => restaurantMenuItemsPayload([{ id: "i1", name: "Item", price: 100, inStock: 1 }]),
  });

  await recommendSimilar({ swiggyFoodClient: client, senderId: "sender-1", pendingCartSessions });

  assert.deepEqual(pendingCartSessions.peek("sender-1"), { addressId: "addr-1" });
});

test("recommendSimilar never overwrites an already-established session", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-existing",
    restaurantId: "r-existing",
    restaurantName: "Existing Place",
    cartRestaurantId: "r-existing",
  });
  const client = fakeClient({
    getFoodOrders: async () => payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1" })] }),
    getRestaurantMenu: async () => restaurantMenuItemsPayload([{ id: "i1", name: "Item", price: 100, inStock: 1 }]),
  });

  await recommendSimilar({ swiggyFoodClient: client, senderId: "sender-1", pendingCartSessions });

  assert.deepEqual(pendingCartSessions.peek("sender-1"), {
    addressId: "addr-existing",
    restaurantId: "r-existing",
    restaurantName: "Existing Place",
    cartRestaurantId: "r-existing",
  });
});

test("recommendSimilar with a craving searches real open restaurants for it instead of using order history", async () => {
  let searchedQuery;
  const client = fakeClient({
    searchRestaurants: async ({ query }) => {
      searchedQuery = query;
      return payload({ restaurants: [{ id: "r1", name: "Spice House", availabilityStatus: "OPEN" }] });
    },
    getRestaurantMenu: async () =>
      restaurantMenuItemsPayload([{ id: "i1", name: "Chicken Tikka Masala", price: 279, inStock: 1 }]),
    getFoodOrders: async () => {
      throw new Error("should not be called when a craving is given");
    },
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client, craving: "chicken tikka masala" });

  assert.equal(searchedQuery, "chicken tikka masala");
  assert.match(reply, /Spice House/);
  assert.match(reply, /Chicken Tikka Masala — ₹279/);
});

test("recommendSimilar with a craving reports honestly when nothing real is open for it AND there's no order history to fall back on", async () => {
  // getFoodOrders defaults to { orders: [] } in fakeClient - no history
  // fallback available either.
  const client = fakeClient({ searchRestaurants: async () => payload({ restaurants: [] }) });

  const reply = await recommendSimilar({ swiggyFoodClient: client, craving: "sushi" });

  assert.match(reply, /couldn't find anything open for "sushi"/);
  assert.match(reply, /no order history to fall back on/);
});

test("recommendSimilar falls back to order history when the craving matches nothing real, instead of dead-ending - confirmed live 2026-09-21, a craving unmatched by a small catalog read as 'everything is closed'", async () => {
  const client = fakeClient({
    searchRestaurants: async () => payload({ restaurants: [] }),
    getFoodOrders: async () => payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1", restaurantName: "Biryani House" })] }),
    getRestaurantMenu: async () => restaurantMenuItemsPayload([{ id: "i1", name: "Chicken Tikka Masala", price: 279, inStock: 1 }]),
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client, craving: "sushi" });

  // Real, usable candidates from history are present...
  assert.match(reply, /Biryani House/);
  assert.match(reply, /Chicken Tikka Masala — ₹279/);
  // ...and the agent is told plainly this doesn't satisfy the craving, so
  // it can't falsely claim the pick matches what the user asked for.
  assert.match(reply, /Nothing real was open for "sushi"/);
  assert.match(reply, /Do NOT claim any of these satisfies their stated craving/);
});

// Explicit exclusion, not just a coincidence of empty search results - see
// recommendSimilar's own comment on why explore must never run on a craving
// miss (a candidate found via an unrelated shuffled cuisine term sitting in
// a list captioned "does not satisfy the craving" while the closing
// instructions separately say to prefer it - a real contradiction caught
// before shipping, not after).
test("recommendSimilar never adds an explore restaurant to a craving-miss fallback, even when one would genuinely be found", async () => {
  const client = fakeClient({
    // "sushi" (the stated craving) finds nothing; every OTHER query (i.e.
    // what an explore attempt would search) finds a real, open restaurant -
    // if explore ran here, it would leak into this list.
    searchRestaurants: async ({ query }) =>
      query === "sushi"
        ? payload({ restaurants: [] })
        : payload({ restaurants: [{ id: "rest-9", name: "Dragon Wok", availabilityStatus: "OPEN" }] }),
    getFoodOrders: async () => payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1", restaurantName: "Biryani House" })] }),
    getRestaurantMenu: async () => restaurantMenuItemsPayload([{ id: "i1", name: "Chicken Tikka Masala", price: 279, inStock: 1 }]),
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client, craving: "sushi" });

  assert.doesNotMatch(reply, /Dragon Wok/);
});

// Structural exclusion (persisted on pendingCartSessions), not left to the
// term shuffle's luck - see findExploreRestaurants/recommendSimilar's own
// comments on why chance alone isn't good enough here.
test("recommendSimilar never re-offers the same explore restaurant twice in one session, even when the shuffled term order would otherwise find it again", async () => {
  const pendingCartSessions = new PendingCartSessions();
  const client = fakeClient({
    getFoodOrders: async () => payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1", restaurantName: "Biryani House" })] }),
    searchRestaurants: async () => payload({ restaurants: [{ id: "rest-9", name: "Dragon Wok", availabilityStatus: "OPEN" }] }),
    getRestaurantMenu: async ({ restaurantId }) =>
      restaurantId === "rest-1"
        ? restaurantMenuItemsPayload([{ id: "i1", name: "Chicken Biryani", price: 249, inStock: 1 }])
        : restaurantMenuItemsPayload([{ id: "i9", name: "Chilli Chicken", price: 259, inStock: 1 }]),
  });

  const first = await recommendSimilar({ swiggyFoodClient: client, senderId: "sender-1", pendingCartSessions });
  assert.match(first, /Dragon Wok/);

  const second = await recommendSimilar({ swiggyFoodClient: client, senderId: "sender-1", pendingCartSessions });
  assert.doesNotMatch(second, /Dragon Wok/);
});

test("recommendSimilar reports honestly when the craving misses AND the order-history fallback also finds nothing usable", async () => {
  const client = fakeClient({
    searchRestaurants: async () => payload({ restaurants: [] }),
    getFoodOrders: async () => payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1" })] }),
    getRestaurantMenu: async () => {
      throw new Error("boom");
    },
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client, craving: "sushi" });

  assert.match(reply, /couldn't find anything open for "sushi"/);
  assert.match(reply, /couldn't pull up a real menu from their order history either/);
});

test("recommendSimilar falls back to a generic reply when every candidate restaurant's menu lookup fails", async () => {
  const client = fakeClient({
    getFoodOrders: async () => payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1" })] }),
    getRestaurantMenu: async () => {
      throw new Error("boom");
    },
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client });

  assert.match(reply, /couldn't do that right now/);
});

test("recommendSimilar includes real rating and delivery time in the restaurant header when get_restaurant_menu returns them", async () => {
  const client = fakeClient({
    getFoodOrders: async () => payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1", restaurantName: "Biryani House" })] }),
    getRestaurantMenu: async () =>
      payload({
        restaurant: { id: "rest-1", name: "Biryani House", avgRatingString: "4.3", slaString: "25-30 mins" },
        items: [{ id: "i1", name: "Veg Biryani", price: 199, inStock: 1 }],
      }),
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client });

  assert.match(reply, /Biryani House — ⭐4.3, 25-30 mins \(previously ordered:/);
});

test("recommendSimilar never invents a rating or delivery time when get_restaurant_menu omits them", async () => {
  const client = fakeClient({
    getFoodOrders: async () => payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1", restaurantName: "Biryani House" })] }),
    getRestaurantMenu: async () =>
      payload({
        restaurant: { id: "rest-1", name: "Biryani House" },
        items: [{ id: "i1", name: "Veg Biryani", price: 199, inStock: 1 }],
      }),
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client });

  assert.match(reply, /^Biryani House \(previously ordered:/m);
  assert.doesNotMatch(reply, /⭐/);
});

test("recommendSimilar (no craving) asks which address to use when more than one is saved and none chosen yet, instead of silently picking one", async () => {
  const pendingAddressSelections = new PendingAddressSelections();
  const client = fakeClient({
    getAddresses: async () =>
      payload({
        addresses: [
          { id: "addr-1", addressTag: "Home", addressLine: "1 Main St" },
          { id: "addr-2", addressTag: "Work", addressLine: "2 Other St" },
        ],
        total: 2,
      }),
    getFoodOrders: async () => {
      throw new Error("should not be called before the address is resolved");
    },
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client, senderId: "sender-1", pendingAddressSelections });

  assert.match(reply, /which one should I use/i);
  const pending = pendingAddressSelections.peek("sender-1");
  assert.equal(pending.kind, "recommend");
  assert.equal(pending.candidates.length, 2);
});

test("recommendSimilar (with craving) also asks which address to use when more than one is saved, and remembers the craving for the resume", async () => {
  const pendingAddressSelections = new PendingAddressSelections();
  const client = fakeClient({
    getAddresses: async () =>
      payload({
        addresses: [
          { id: "addr-1", addressTag: "Home", addressLine: "1 Main St" },
          { id: "addr-2", addressTag: "Work", addressLine: "2 Other St" },
        ],
        total: 2,
      }),
  });

  const reply = await recommendSimilar({
    swiggyFoodClient: client,
    senderId: "sender-1",
    pendingAddressSelections,
    craving: "chicken tikka masala",
  });

  assert.match(reply, /which one should I use/i);
  assert.equal(pendingAddressSelections.peek("sender-1").craving, "chicken tikka masala");
});

test("recommendSimilar does not ask for an address when exactly one is saved (no genuine choice to make)", async () => {
  const pendingAddressSelections = new PendingAddressSelections();
  const client = fakeClient({
    getFoodOrders: async () => payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1" })] }),
    getRestaurantMenu: async () => payload({ items: [{ id: "i1", name: "Item", price: 100, inStock: 1 }] }),
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client, senderId: "sender-1", pendingAddressSelections });

  assert.doesNotMatch(reply, /which one should I use/i);
  assert.equal(pendingAddressSelections.peek("sender-1"), undefined);
});

test("recommendSimilar reuses an already-established session address without asking again", async () => {
  const pendingAddressSelections = new PendingAddressSelections();
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-already-chosen" });
  let getAddressesCalled = false;
  const client = fakeClient({
    getAddresses: async () => {
      getAddressesCalled = true;
      return payload({ addresses: [], total: 0 });
    },
    getFoodOrders: async () => payload({ orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1" })] }),
    getRestaurantMenu: async () => payload({ items: [{ id: "i1", name: "Item", price: 100, inStock: 1 }] }),
  });

  await recommendSimilar({ swiggyFoodClient: client, senderId: "sender-1", pendingAddressSelections, pendingCartSessions });

  assert.equal(getAddressesCalled, false);
});

function transientSwiggyError() {
  return new SwiggyFoodToolError("place_food_order", Object.assign(new Error("Upstream error"), { code: 503 }));
}

function orderClient({ placeFoodOrder, ordersAfterFailure = [] }) {
  const calls = [];
  let orderListCalls = 0;
  return {
    calls,
    client: {
      getFoodOrders: async () => {
        orderListCalls += 1;
        calls.push("list");
        return payload({ orders: orderListCalls === 1 ? [{ orderId: "old-1" }] : [{ orderId: "old-1" }, ...ordersAfterFailure] });
      },
      placeFoodOrder: async () => {
        calls.push("place");
        return placeFoodOrder(calls.filter((call) => call === "place").length);
      },
      confirmOrder: async () => {
        calls.push("confirm");
        return payload({ result: "success" });
      },
      flushFoodCart: async () => payload({ success: true }),
    },
  };
}

const noWait = async () => {};

test("placeConfirmedOrder retries once after a transient failure when no order was created", async () => {
  const { client, calls } = orderClient({
    placeFoodOrder: (attempt) => {
      if (attempt === 1) {
        throw transientSwiggyError();
      }
      return payload({ orderId: "order-2", lat: 1, lng: 2 });
    },
  });

  const result = await placeConfirmedOrder({
    swiggyFoodClient: client,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
    sleep: noWait,
  });

  assert.equal(result.status, "confirmed");
  assert.deepEqual(calls, ["list", "place", "list", "place", "confirm"]);
});

test("placeConfirmedOrder never places a second order when the first one went through despite the error", async () => {
  const { client, calls } = orderClient({
    placeFoodOrder: () => {
      throw transientSwiggyError();
    },
    ordersAfterFailure: [{ orderId: "order-new" }],
  });

  const result = await placeConfirmedOrder({
    swiggyFoodClient: client,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
    sleep: noWait,
  });

  assert.equal(result.status, "confirmed");
  assert.equal(calls.filter((call) => call === "place").length, 1);
});

test("placeConfirmedOrder gives up after the second transient failure", async () => {
  const { client, calls } = orderClient({
    placeFoodOrder: () => {
      throw transientSwiggyError();
    },
  });

  const result = await placeConfirmedOrder({
    swiggyFoodClient: client,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
    sleep: noWait,
  });

  assert.equal(result.status, "failed");
  assert.equal(calls.filter((call) => call === "place").length, 2);
});

test("placeConfirmedOrder doesn't retry when Swiggy refuses the order", async () => {
  const { client, calls } = orderClient({
    placeFoodOrder: () => {
      throw new SwiggyFoodToolError("place_food_order", { isError: true, content: [] });
    },
  });

  const result = await placeConfirmedOrder({
    swiggyFoodClient: client,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
    sleep: noWait,
  });

  assert.equal(result.status, "failed");
  assert.equal(calls.filter((call) => call === "place").length, 1);
});

test("placeConfirmedOrder never retries when it couldn't record the order list first", async () => {
  let placeCalls = 0;
  const result = await placeConfirmedOrder({
    swiggyFoodClient: {
      getFoodOrders: async () => {
        throw new Error("down");
      },
      placeFoodOrder: async () => {
        placeCalls += 1;
        throw transientSwiggyError();
      },
    },
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
    sleep: noWait,
  });

  assert.equal(result.status, "failed");
  assert.equal(placeCalls, 1);
});

test("viewOrders lists recent orders newest-first with their real status, using the first saved address", async () => {
  let requestedAddressId;
  const pendingCartSessions = new PendingCartSessions();
  const text = await viewOrders({
    senderId: "sender-1",
    pendingCartSessions,
    swiggyFoodClient: fakeClient({
      getFoodOrders: async ({ addressId }) => {
        requestedAddressId = addressId;
        return payload({
          orders: [
            { orderId: "o2", restaurantName: "Dosa Place", orderTotal: "196", orderedTime: "Sep 28", orderStatus: "PLACED", isActiveOrder: true, orderedItems: "1x Masala Dosa" },
            { orderId: "o1", restaurantName: "Biryani House", orderTotal: "301", orderedTime: "Sep 15", orderStatus: "DELIVERED", isActiveOrder: false, orderedItems: "1x Chicken Biryani" },
          ],
        });
      },
    }),
  });

  assert.equal(requestedAddressId, "addr-1");
  assert.equal(pendingCartSessions.peek("sender-1"), undefined);
  assert.equal(
    text,
    "Your recent Swiggy orders:\n1. Dosa Place — ₹196, Sep 28, In progress\n   1x Masala Dosa\n2. Biryani House — ₹301, Sep 15, DELIVERED\n   1x Chicken Biryani",
  );
});

test("viewOrders uses the session's address and says so plainly when there are no orders", async () => {
  let requestedAddressId;
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-9" });
  const text = await viewOrders({
    senderId: "sender-1",
    pendingCartSessions,
    lang: "hinglish",
    swiggyFoodClient: fakeClient({
      getFoodOrders: async ({ addressId }) => {
        requestedAddressId = addressId;
        return payload({ orders: [] });
      },
    }),
  });

  assert.equal(requestedAddressId, "addr-9");
  assert.equal(text, "Aapka abhi tak koi Swiggy food order nahi hai.");
});

test("recommendSimilar with vegOnly offers only items Swiggy marks veg, leaving out unflagged ones", async () => {
  const client = fakeClient({
    getFoodOrders: async () =>
      payload({
        orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1", restaurantName: "Burger Barn", orderedItems: "1x Fries" })],
      }),
    getRestaurantMenu: async () =>
      restaurantMenuItemsPayload([
        { id: "i1", name: "Classic Cheeseburger", price: 219, inStock: 1, isVeg: false },
        { id: "i2", name: "Veg Burger", price: 159, inStock: 1, isVeg: true },
        { id: "i3", name: "Mystery Wrap", price: 189, inStock: 1 },
      ]),
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client, vegOnly: true });

  assert.match(reply, /Veg Burger — ₹159/);
  assert.doesNotMatch(reply, /Cheeseburger/);
  assert.doesNotMatch(reply, /Mystery Wrap/);
  assert.match(reply, /marked vegetarian by Swiggy/);
});

test("recommendSimilar with vegOnly says nothing veg came up rather than offering non-veg", async () => {
  const client = fakeClient({
    getFoodOrders: async () =>
      payload({
        orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1", restaurantName: "Burger Barn", orderedItems: "1x Fries" })],
      }),
    getRestaurantMenu: async () =>
      restaurantMenuItemsPayload([{ id: "i1", name: "Classic Cheeseburger", price: 219, inStock: 1, isVeg: false }]),
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client, vegOnly: true });

  assert.match(reply, /No real vegetarian items/);
  assert.doesNotMatch(reply, /Cheeseburger/);
});

test("recommendSimilar with vegOnly and a missed craving still explores new restaurants and says the picks are veg", async () => {
  const client = fakeClient({
    getFoodOrders: async () =>
      payload({
        orders: [orderSummary({ orderId: "o1", restaurantId: "rest-1", restaurantName: "Pizza Place", orderedItems: "1x Margherita" })],
      }),
    searchRestaurants: async ({ query }) =>
      query === "paneer"
        ? payload({ restaurants: [] })
        : payload({ restaurants: [{ id: "rest-9", name: "Taco Fiesta", availabilityStatus: "OPEN" }] }),
    getRestaurantMenu: async ({ restaurantId }) =>
      restaurantId === "rest-1"
        ? restaurantMenuItemsPayload([{ id: "i1", name: "Margherita", price: 219, inStock: 1, isVeg: true }])
        : restaurantMenuItemsPayload([
            { id: "i9", name: "Veg Tacos", price: 219, inStock: 1, isVeg: true },
            { id: "i8", name: "Chicken Tacos", price: 249, inStock: 1, isVeg: false },
          ]),
  });

  const reply = await recommendSimilar({ swiggyFoodClient: client, craving: "paneer", vegOnly: true });

  assert.match(reply, /Veg Tacos — ₹219/);
  assert.doesNotMatch(reply, /Chicken Tacos/);
  assert.match(reply, /every item below is vegetarian/);
  assert.doesNotMatch(reply, /tell them honestly that nothing matched/);
});
