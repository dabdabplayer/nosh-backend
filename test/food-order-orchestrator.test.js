import assert from "node:assert/strict";
import test from "node:test";
import {
  getFoodOrderReply,
  parseOrderConfirmationReply,
  placeConfirmedOrder,
} from "../src/food-order-orchestrator.js";
import { PendingCartSessions } from "../src/pending-cart-sessions.js";
import { PendingOrderConfirmations } from "../src/pending-order-confirmations.js";

function message(text, from = "sender-1") {
  return { from, id: "wamid.1", phoneNumberId: "pn-1", text };
}

function payload(data) {
  return { text: "", structured: data };
}

function cartPayload(data) {
  return payload({ statusCode: 0, statusMessage: "ok", data });
}

const nvidiaNim = Object.freeze({
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://example.test",
  model: "test-model",
});

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

// --- getFoodOrderReply: add_to_cart ---

test("getFoodOrderReply: add_to_cart bootstraps a session via cross-restaurant search", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

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

  const classifyOrderIntent = async () => ({ type: "add_to_cart", query: "margherita pizza", quantity: 1 });

  const reply = await getFoodOrderReply({
    message: message("add a margherita pizza"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent,
    nvidiaNim,
  });

  assert.equal(searchCalls.length, 2);
  assert.equal(searchCalls[0].restaurantIdOfAddedItem, undefined);
  assert.equal(searchCalls[1].restaurantIdOfAddedItem, "r-1");
  assert.match(reply, /Added Margherita Pizza to your cart/);
  assert.deepEqual(pendingCartSessions.peek("sender-1"), {
    restaurantId: "r-1",
    restaurantName: "Test Restaurant",
    addressId: "addr-1",
  });
});

test("getFoodOrderReply: add_to_cart reuses the existing restaurant and skips cross-restaurant search", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test Restaurant" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const searchCalls = [];
  const client = fakeClient({
    searchMenu: async (params) => {
      searchCalls.push(params);
      return payload({ items: [menuItem()] });
    },
    updateFoodCart: async () => cartPayload(cartData()),
  });

  const classifyOrderIntent = async () => ({ type: "add_to_cart", query: "margherita pizza", quantity: 1 });

  await getFoodOrderReply({
    message: message("add another margherita pizza"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent,
    nvidiaNim,
  });

  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].restaurantIdOfAddedItem, "r-1");
});

test("getFoodOrderReply: add_to_cart honors an explicit restaurant name instead of the cross-restaurant search result", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

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

  const classifyOrderIntent = async () => ({
    type: "add_to_cart",
    query: "margherita pizza",
    quantity: 1,
    restaurantName: "Pizza Hut",
  });

  const reply = await getFoodOrderReply({
    message: message("from Pizza Hut add a margherita pizza"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent,
    nvidiaNim,
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
  });
});

test("getFoodOrderReply: add_to_cart reports a friendly message when the named restaurant can't be found", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  let updateCartCalled = false;
  const client = fakeClient({
    searchRestaurants: async () => payload({ restaurants: [] }),
    updateFoodCart: async () => {
      updateCartCalled = true;
      return cartPayload(cartData());
    },
  });

  const classifyOrderIntent = async () => ({
    type: "add_to_cart",
    query: "margherita pizza",
    quantity: 1,
    restaurantName: "Nonexistent Place",
  });

  const reply = await getFoodOrderReply({
    message: message("from Nonexistent Place add a margherita pizza"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent,
    nvidiaNim,
  });

  assert.match(reply, /couldn't find a restaurant called "Nonexistent Place"/);
  assert.equal(updateCartCalled, false);
});

test("getFoodOrderReply: add_to_cart names the restaurant when the dish isn't on its menu", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({
    searchRestaurants: async () =>
      payload({ restaurants: [{ id: "r-pizzahut", name: "Pizza Hut", availabilityStatus: "OPEN" }] }),
    searchMenu: async () => payload({ items: [] }),
  });

  const classifyOrderIntent = async () => ({
    type: "add_to_cart",
    query: "sushi",
    quantity: 1,
    restaurantName: "Pizza Hut",
  });

  const reply = await getFoodOrderReply({
    message: message("from Pizza Hut add sushi"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent,
    nvidiaNim,
  });

  assert.match(reply, /couldn't find "sushi" at Pizza Hut/);
});

test("getFoodOrderReply: add_to_cart ignores a restaurant hint once a session restaurant already exists", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Existing Place" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  let restaurantSearchCalled = false;
  const client = fakeClient({
    searchRestaurants: async () => {
      restaurantSearchCalled = true;
      return payload({ restaurants: [] });
    },
    searchMenu: async () => payload({ items: [menuItem()] }),
    updateFoodCart: async () => cartPayload(cartData()),
  });

  const classifyOrderIntent = async () => ({
    type: "add_to_cart",
    query: "margherita pizza",
    quantity: 1,
    restaurantName: "Pizza Hut",
  });

  await getFoodOrderReply({
    message: message("from Pizza Hut add a margherita pizza"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent,
    nvidiaNim,
  });

  assert.equal(restaurantSearchCalled, false);
});

test("getFoodOrderReply: add_to_cart sends the default variant selection, not an invented one", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  let cartItemsSent;
  const client = fakeClient({
    searchMenu: async () => payload({ items: [menuItem()] }),
    updateFoodCart: async (params) => {
      cartItemsSent = params.cartItems;
      return cartPayload(cartData());
    },
  });

  const classifyOrderIntent = async () => ({ type: "add_to_cart", query: "pizza", quantity: 2 });

  await getFoodOrderReply({
    message: message("add 2 pizzas"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent,
    nvidiaNim,
  });

  assert.deepEqual(cartItemsSent, [
    {
      menu_item_id: "item-1",
      quantity: 2,
      variantsV2: [{ group_id: "g-crust", variation_id: "v-crust-default" }],
    },
  ]);
});

test("getFoodOrderReply: add_to_cart reports a friendly message when nothing matches", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({ searchMenu: async () => payload({ items: [] }) });
  const classifyOrderIntent = async () => ({ type: "add_to_cart", query: "unobtainium roll", quantity: 1 });

  const reply = await getFoodOrderReply({
    message: message("add unobtainium roll"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent,
    nvidiaNim,
  });

  assert.match(reply, /couldn't find "unobtainium roll"/);
});

// --- getFoodOrderReply: view_cart / find_coupons / apply_coupon / checkout without a session ---

test("getFoodOrderReply: non-add intents without an active session report no active order", async () => {
  const pendingCartSessions = new PendingCartSessions();
  const pendingOrderConfirmations = new PendingOrderConfirmations();
  const client = fakeClient();

  for (const type of ["view_cart", "find_coupons", "checkout"]) {
    const reply = await getFoodOrderReply({
      message: message("whatever"),
      swiggyFoodClient: client,
      pendingCartSessions,
      pendingOrderConfirmations,
      classifyOrderIntent: async () => ({ type }),
      nvidiaNim,
    });

    assert.match(reply, /don't have an order in progress/);
  }
});

// --- getFoodOrderReply: view_cart ---

test("getFoodOrderReply: view_cart formats the cart contents", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test Restaurant" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({ getFoodCart: async () => cartPayload(cartData()) });

  const reply = await getFoodOrderReply({
    message: message("what's in my cart"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent: async () => ({ type: "view_cart" }),
    nvidiaNim,
  });

  assert.match(reply, /Test Restaurant/);
  assert.match(reply, /1x Margherita Pizza \(Hand Tossed\) — ₹119/);
  assert.match(reply, /Total: ₹187/);
});

test("getFoodOrderReply: view_cart reports an empty cart", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({ getFoodCart: async () => cartPayload(cartData({ items: [] })) });

  const reply = await getFoodOrderReply({
    message: message("what's in my cart"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent: async () => ({ type: "view_cart" }),
    nvidiaNim,
  });

  assert.match(reply, /cart is empty/);
});

// --- getFoodOrderReply: find_coupons / apply_coupon ---

test("getFoodOrderReply: find_coupons lists each coupon's code as the title field", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({
    fetchFoodCoupons: async () =>
      payload({
        coupon_sections: [
          { coupons: [{ title: "SWIGGYIT", description: "20% off orders above ₹189" }] },
        ],
      }),
  });

  const reply = await getFoodOrderReply({
    message: message("any coupons?"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent: async () => ({ type: "find_coupons" }),
    nvidiaNim,
  });

  assert.match(reply, /SWIGGYIT — 20% off orders above ₹189/);
});

test("getFoodOrderReply: find_coupons reports when there are none", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({ fetchFoodCoupons: async () => payload({ coupon_sections: [] }) });

  const reply = await getFoodOrderReply({
    message: message("any coupons?"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent: async () => ({ type: "find_coupons" }),
    nvidiaNim,
  });

  assert.match(reply, /No coupons available/);
});

test("getFoodOrderReply: apply_coupon reports success only when coupon_discount is greater than zero", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({
    applyFoodCoupon: async () => cartPayload(cartData({ offers: { coupon_discount: 50 } })),
  });

  const reply = await getFoodOrderReply({
    message: message("apply SWIGGYIT"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent: async () => ({ type: "apply_coupon", couponCode: "SWIGGYIT" }),
    nvidiaNim,
  });

  assert.match(reply, /Applied SWIGGYIT — you saved ₹50/);
});

test("getFoodOrderReply: apply_coupon never claims a discount when coupon_discount is 0 (suggested, not applied)", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({
    applyFoodCoupon: async () => cartPayload(cartData({ offers: { coupon_discount: 0 } })),
  });

  const reply = await getFoodOrderReply({
    message: message("apply SWIGGYIT"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent: async () => ({ type: "apply_coupon", couponCode: "SWIGGYIT" }),
    nvidiaNim,
  });

  assert.doesNotMatch(reply, /Applied/);
  assert.match(reply, /isn't giving a discount/);
});

test("getFoodOrderReply: apply_coupon degrades gracefully when the tool rejects the code", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({
    applyFoodCoupon: async () => {
      throw new Error("not valid in this time slot");
    },
  });

  const reply = await getFoodOrderReply({
    message: message("apply BADCODE"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent: async () => ({ type: "apply_coupon", couponCode: "BADCODE" }),
    nvidiaNim,
  });

  assert.match(reply, /couldn't apply "BADCODE"/);
});

// --- getFoodOrderReply: checkout ---

test("getFoodOrderReply: checkout builds a summary and stores a pending confirmation", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test Restaurant" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const getFoodCartCalls = [];
  const client = fakeClient({
    getFoodCart: async (params) => {
      getFoodCartCalls.push(params);
      return cartPayload(cartData());
    },
    getPaymentOptions: async () => payload({ cod: { available: true, displayName: "Cash on Delivery" } }),
  });

  const reply = await getFoodOrderReply({
    message: message("checkout"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent: async () => ({ type: "checkout" }),
    nvidiaNim,
  });

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

test("getFoodOrderReply: checkout refuses an empty cart", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({ getFoodCart: async () => cartPayload(cartData({ items: [] })) });

  const reply = await getFoodOrderReply({
    message: message("checkout"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent: async () => ({ type: "checkout" }),
    nvidiaNim,
  });

  assert.match(reply, /cart is empty/);
  assert.equal(pendingOrderConfirmations.peek("sender-1"), undefined);
});

test("getFoodOrderReply: checkout never guesses a payment method when COD isn't available", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({
    getFoodCart: async () => cartPayload(cartData()),
    getPaymentOptions: async () => payload({ cod: { available: false } }),
  });

  const reply = await getFoodOrderReply({
    message: message("checkout"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent: async () => ({ type: "checkout" }),
    nvidiaNim,
  });

  assert.match(reply, /Cash on Delivery isn't available/);
  assert.equal(pendingOrderConfirmations.peek("sender-1"), undefined);
});

// --- getFoodOrderReply: fail-closed behavior ---

test("getFoodOrderReply returns undefined when NVIDIA NIM isn't enabled", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });

  const reply = await getFoodOrderReply({
    message: message("add a pizza"),
    swiggyFoodClient: fakeClient(),
    pendingCartSessions,
    pendingOrderConfirmations: new PendingOrderConfirmations(),
    classifyOrderIntent: async () => ({ type: "add_to_cart", query: "pizza", quantity: 1 }),
    nvidiaNim: { enabled: false },
  });

  assert.equal(reply, undefined);
});

test("getFoodOrderReply returns undefined when no order intent is classified", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });

  const reply = await getFoodOrderReply({
    message: message("thanks!"),
    swiggyFoodClient: fakeClient(),
    pendingCartSessions,
    pendingOrderConfirmations: new PendingOrderConfirmations(),
    classifyOrderIntent: async () => undefined,
    nvidiaNim,
  });

  assert.equal(reply, undefined);
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
  };

  const result = await placeConfirmedOrder({
    swiggyFoodClient: client,
    confirmation: { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" },
  });

  assert.deepEqual(result, { status: "confirmed", replyText: "Your order has been placed! You'll get delivery updates from Swiggy." });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "place");
  assert.deepEqual(calls[1][1], { orderId: "order-1", addressId: "addr-1", cartId: 1, lat: 1.1, lng: 2.2 });
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
