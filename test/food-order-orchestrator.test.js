import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReorderUsualReply,
  findUsualOrder,
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
  return payload({ statusCode: 0, statusMessage: "CART_UPDATED_SUCCESSFULLY", data });
}

// A failed mutation can still surface with a non-zero statusCode while
// echoing back a data object (e.g. the cart unchanged) - confirmed via the
// real envelope shape, { statusCode, statusMessage, data }, live.
function cartFailurePayload(data) {
  return payload({ statusCode: 1, statusMessage: "FAILED", data });
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

// --- getFoodOrderReply: restaurant selection by number ---

test("getFoodOrderReply: a bare number picks the restaurant off the shown list, deterministically (no NLU call)", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantCandidates: [
      { id: "r-billu", name: "Billu's Pasta Hut (Ad)" },
      { id: "r-kfc", name: "KFC (Ad)" },
    ],
  });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  let classifyOrderIntentCalled = false;
  const reply = await getFoodOrderReply({
    message: message("2"),
    swiggyFoodClient: fakeClient(),
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent: async () => {
      classifyOrderIntentCalled = true;
      return undefined;
    },
    nvidiaNim,
  });

  assert.equal(classifyOrderIntentCalled, false);
  assert.equal(reply, "Got it — what would you like from KFC (Ad)?");
  assert.deepEqual(pendingCartSessions.peek("sender-1"), {
    addressId: "addr-1",
    restaurantId: "r-kfc",
    restaurantName: "KFC (Ad)",
  });
});

test("getFoodOrderReply: an out-of-range or non-numeric reply falls through to normal intent classification", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantCandidates: [{ id: "r-kfc", name: "KFC" }],
  });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const reply = await getFoodOrderReply({
    message: message("from KFC add wings"),
    swiggyFoodClient: fakeClient(),
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent: async () => undefined,
    nvidiaNim,
  });

  assert.equal(reply, undefined);
});

test("getFoodOrderReply: works even when NVIDIA NIM is disabled, since restaurant selection is deterministic", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", {
    addressId: "addr-1",
    restaurantCandidates: [{ id: "r-kfc", name: "KFC" }],
  });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const reply = await getFoodOrderReply({
    message: message("1"),
    swiggyFoodClient: fakeClient(),
    pendingCartSessions,
    pendingOrderConfirmations,
    nvidiaNim: { enabled: false },
  });

  assert.equal(reply, "Got it — what would you like from KFC?");
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

test("getFoodOrderReply: add_to_cart skips a sponsored ad ranked ahead of the actual named restaurant", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

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

  const classifyOrderIntent = async () => ({
    type: "add_to_cart",
    query: "zinger burger",
    quantity: 1,
    restaurantName: "KFC",
  });

  const reply = await getFoodOrderReply({
    message: message("from KFC add a zinger burger"),
    swiggyFoodClient: client,
    pendingCartSessions,
    pendingOrderConfirmations,
    classifyOrderIntent,
    nvidiaNim,
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

test("getFoodOrderReply: add_to_cart does not report success when update_food_cart returns a non-zero statusCode", async () => {
  const pendingCartSessions = new PendingCartSessions();
  pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  const client = fakeClient({
    searchMenu: async () => payload({ items: [menuItem()] }),
    // A failed mutation can still echo back a data object (e.g. the
    // unchanged cart) - a non-zero statusCode must never be read as "added".
    updateFoodCart: async () => cartFailurePayload(cartData()),
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

  assert.doesNotMatch(reply, /Added/);
  // Session must stay exactly as it was before the failed attempt - no
  // restaurantName should get written in from a failed mutation's echo.
  assert.deepEqual(pendingCartSessions.peek("sender-1"), { addressId: "addr-1", restaurantId: "r-1" });
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
