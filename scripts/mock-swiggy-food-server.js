// Manual dev tool: a local, in-process stand-in for the real Swiggy Food MCP
// server (mcp.swiggy.com/food), for exercising Nosh's full search -> cart ->
// checkout -> confirm conversation flow end-to-end without real Swiggy
// staging/production access (blocked right now - the /access application
// hasn't been submitted; see handoff.md). Not part of the app itself, and
// NOT connected to Swiggy in any way - every response below is fabricated
// data, deliberately labelled "(Mock)" so it's never mistaken for a real
// Swiggy result (see AGENTS.md: never present fabricated data as real).
//
// It speaks the real MCP Streamable HTTP protocol via the same
// @modelcontextprotocol/sdk the app already depends on, so
// src/swiggy-food-client.js talks to it completely unmodified - this tests
// the real MCP transport/retry code path, not just orchestration logic
// against hand-rolled fakes (that's what test/food-order-orchestrator.test.js
// already covers).
//
// Response shapes below follow the LIVE-VERIFIED envelopes Nosh's own code
// already relies on (see comments in src/food-order-orchestrator.js and
// src/food-search-orchestrator.js, and the fixtures in their test files) -
// e.g. cart-touching tools return { statusCode, statusMessage, data },
// while search/address tools return their fields at the top level. Where
// those diverge from the generic { success, data, message } envelope shown
// on mcp.swiggy.com/builders/docs, the live-verified shape wins, per those
// files' own comments.
//
// Carts are isolated per caller (see the Authorization-header-keyed
// cartsByKey map below) - src/server.js's SWIGGY_TEST_MODE bypass sends a
// distinct bearer token per real WhatsApp sender specifically so this mock
// can back a shared, multiple-sender-at-once deployed test service without
// one sender's cart bleeding into another's. Run standalone (this file's
// own usage comment below) with no Authorization header at all, every
// caller shares one "default" cart - fine for one developer driving one
// manual test at a time.
//
// Usage:
//   node scripts/mock-swiggy-food-server.js
//   [MOCK_SWIGGY_FOOD_PORT=3901 node scripts/mock-swiggy-food-server.js]
//
// Then point Nosh at it:
//   SWIGGY_FOOD_MCP_URL=http://localhost:3901/food SWIGGY_FOOD_TEST_TOKEN=mock-token \
//     node scripts/food-search-check.js "find biryani" "1"
//
// or for the full interactive flow (npm run dev / oauth-connect-check.js),
// set SWIGGY_FOOD_MCP_URL=http://localhost:3901/food in .env or the shell
// before starting. The Authorization header is accepted but never checked.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = Number(process.env.MOCK_SWIGGY_FOOD_PORT ?? 3901);
const PATH = "/food";

// --- Fake catalog -----------------------------------------------------

const RESTAURANTS = [
  {
    id: "mock-rest-1",
    name: "Test Kitchen Biryani House (Mock)",
    cuisines: ["Biryani", "North Indian"],
    avgRating: 4.3,
    totalRatings: "1.2K+",
    costForTwo: "₹400 for two",
    areaName: "Mock Nagar",
    distanceKm: 2.1,
    deliveryTimeMinutes: 28,
    deliveryTimeRange: "25-30 mins",
    veg: false,
    availabilityStatus: "OPEN",
  },
  {
    id: "mock-rest-2",
    name: "Fake Pizza Co (Mock)",
    cuisines: ["Pizza", "Italian"],
    avgRating: 4.1,
    totalRatings: "800+",
    costForTwo: "₹350 for two",
    areaName: "Mock Nagar",
    distanceKm: 3.4,
    deliveryTimeMinutes: 32,
    deliveryTimeRange: "30-35 mins",
    veg: true,
    availabilityStatus: "OPEN",
  },
  // Added 2026-09-21: the original 2-restaurant/3-item inventory was too
  // small for the Sarvam agent's "recommend something similar but not
  // identical" feature to ever actually work - a sender who'd ordered
  // Chicken Biryani and Margherita Pizza before had NO other real dish at
  // either restaurant to be recommended instead, and nothing anywhere
  // matched a "spicy" craving by name/cuisine, so every recommendation
  // attempt genuinely dead-ended. This restaurant/its items exist
  // specifically to give real alternatives to recommend.
  {
    id: "mock-rest-3",
    name: "Dragon Wok (Mock)",
    cuisines: ["Chinese", "Asian"],
    avgRating: 4.2,
    totalRatings: "950+",
    costForTwo: "₹380 for two",
    areaName: "Mock Nagar",
    distanceKm: 2.8,
    deliveryTimeMinutes: 30,
    deliveryTimeRange: "25-35 mins",
    veg: false,
    availabilityStatus: "OPEN",
  },
  // Added 2026-09-22: 3 cuisines still wasn't enough real variety - a
  // confirmed live incident showed the agent hallucinating a fake "Sushi
  // platter / Ramen / Truffle pasta" menu when a real craving (Japanese/
  // umami) had nothing anywhere in this catalog to match, and other common
  // cravings (Mexican, South Indian, burgers) had the same structural gap.
  // These 4 restaurants exist to close that gap with real, matchable data
  // across the cuisines most likely to come up in ordinary conversation.
  {
    id: "mock-rest-4",
    name: "Sushi Central (Mock)",
    cuisines: ["Japanese", "Sushi", "Asian"],
    avgRating: 4.4,
    totalRatings: "670+",
    costForTwo: "₹600 for two",
    areaName: "Mock Nagar",
    distanceKm: 4.1,
    deliveryTimeMinutes: 35,
    deliveryTimeRange: "30-40 mins",
    veg: false,
    availabilityStatus: "OPEN",
  },
  {
    id: "mock-rest-5",
    name: "Taco Fiesta (Mock)",
    cuisines: ["Mexican"],
    avgRating: 4.0,
    totalRatings: "540+",
    costForTwo: "₹450 for two",
    areaName: "Mock Nagar",
    distanceKm: 3.0,
    deliveryTimeMinutes: 27,
    deliveryTimeRange: "25-30 mins",
    veg: false,
    availabilityStatus: "OPEN",
  },
  {
    id: "mock-rest-6",
    name: "Idli Dosa Corner (Mock)",
    cuisines: ["South Indian"],
    avgRating: 4.5,
    totalRatings: "1.5K+",
    costForTwo: "₹300 for two",
    areaName: "Mock Nagar",
    distanceKm: 1.6,
    deliveryTimeMinutes: 22,
    deliveryTimeRange: "20-25 mins",
    veg: true,
    availabilityStatus: "OPEN",
  },
  {
    id: "mock-rest-7",
    name: "Burger Barn (Mock)",
    cuisines: ["American", "Burgers", "Fast Food"],
    avgRating: 4.0,
    totalRatings: "900+",
    costForTwo: "₹400 for two",
    areaName: "Mock Nagar",
    distanceKm: 2.5,
    deliveryTimeMinutes: 25,
    deliveryTimeRange: "20-30 mins",
    veg: false,
    availabilityStatus: "OPEN",
  },
];

// menu_item_id -> item definition (also carries which restaurant it's on).
const MENU_ITEMS = {
  "mock-item-biryani": {
    menu_item_id: "mock-item-biryani",
    name: "Chicken Biryani (Mock)",
    price: 249,
    isVeg: false,
    inStock: 1,
    hasVariants: true,
    hasAddons: true,
    isBestseller: true,
    restaurant_id: "mock-rest-1",
    restaurant_name: "Test Kitchen Biryani House (Mock)",
    variantsV2: [
      {
        groupId: "g-size",
        name: "Size",
        variations: [
          { id: "v-half", name: "Half", price: 0, default: 1, inStock: 1 },
          { id: "v-full", name: "Full", price: 150, inStock: 1 },
        ],
      },
    ],
    addons: [
      {
        groupId: "g-extras",
        groupName: "Extras",
        minAddons: 0,
        maxAddons: 2,
        choices: [
          { id: "a-raita", name: "Extra Raita (Mock)", price: 20 },
          { id: "a-salan", name: "Salan (Mock)", price: 15 },
        ],
      },
    ],
  },
  "mock-item-margherita": {
    menu_item_id: "mock-item-margherita",
    name: "Margherita Pizza (Mock)",
    price: 219,
    isVeg: true,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: true,
    restaurant_id: "mock-rest-2",
    restaurant_name: "Fake Pizza Co (Mock)",
  },
  // A second pizza item at the SAME restaurant as mock-item-margherita, so a
  // "pizza" search that resolves to Fake Pizza Co actually shows more than
  // one matching item to choose from (see findMatchingMenuItems /
  // formatItemSelectionReply in src/food-order-orchestrator.js) instead of a
  // trivial one-item list.
  "mock-item-pepperoni": {
    menu_item_id: "mock-item-pepperoni",
    name: "Pepperoni Pizza (Mock)",
    price: 269,
    isVeg: false,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: false,
    restaurant_id: "mock-rest-2",
    restaurant_name: "Fake Pizza Co (Mock)",
  },
  // Added 2026-09-21 alongside mock-rest-3 - see that restaurant's own
  // comment. A second, different real dish at each of the original two
  // restaurants so "similar to what they've had, but not the same again"
  // has an actual alternative to find - and a real "spicy" match at both
  // Test Kitchen Biryani House and Dragon Wok, which nothing in this mock
  // previously matched by name/cuisine at all.
  "mock-item-tikka-masala": {
    menu_item_id: "mock-item-tikka-masala",
    name: "Chicken Tikka Masala (Mock)",
    price: 279,
    isVeg: false,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: false,
    restaurant_id: "mock-rest-1",
    restaurant_name: "Test Kitchen Biryani House (Mock)",
  },
  "mock-item-peri-peri-pizza": {
    menu_item_id: "mock-item-peri-peri-pizza",
    name: "Peri Peri Chicken Pizza (Mock)",
    price: 299,
    isVeg: false,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: false,
    restaurant_id: "mock-rest-2",
    restaurant_name: "Fake Pizza Co (Mock)",
  },
  "mock-item-chilli-chicken": {
    menu_item_id: "mock-item-chilli-chicken",
    name: "Chilli Chicken (Mock)",
    price: 259,
    isVeg: false,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: true,
    restaurant_id: "mock-rest-3",
    restaurant_name: "Dragon Wok (Mock)",
  },
  "mock-item-szechuan-noodles": {
    menu_item_id: "mock-item-szechuan-noodles",
    name: "Szechuan Noodles (Mock)",
    price: 229,
    isVeg: true,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: false,
    restaurant_id: "mock-rest-3",
    restaurant_name: "Dragon Wok (Mock)",
  },
  // Added 2026-09-22 alongside mock-rest-4 through mock-rest-7 - see those
  // restaurants' own comment above.
  "mock-item-california-roll": {
    menu_item_id: "mock-item-california-roll",
    name: "California Roll (Mock)",
    price: 349,
    isVeg: false,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: true,
    restaurant_id: "mock-rest-4",
    restaurant_name: "Sushi Central (Mock)",
  },
  "mock-item-salmon-nigiri": {
    menu_item_id: "mock-item-salmon-nigiri",
    name: "Salmon Nigiri (Mock)",
    price: 399,
    isVeg: false,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: false,
    restaurant_id: "mock-rest-4",
    restaurant_name: "Sushi Central (Mock)",
  },
  "mock-item-miso-ramen": {
    menu_item_id: "mock-item-miso-ramen",
    name: "Miso Ramen (Mock)",
    price: 329,
    isVeg: false,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: false,
    restaurant_id: "mock-rest-4",
    restaurant_name: "Sushi Central (Mock)",
  },
  "mock-item-chicken-burrito": {
    menu_item_id: "mock-item-chicken-burrito",
    name: "Chicken Burrito (Mock)",
    price: 289,
    isVeg: false,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: true,
    restaurant_id: "mock-rest-5",
    restaurant_name: "Taco Fiesta (Mock)",
  },
  "mock-item-veg-tacos": {
    menu_item_id: "mock-item-veg-tacos",
    name: "Veg Tacos (Mock)",
    price: 219,
    isVeg: true,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: false,
    restaurant_id: "mock-rest-5",
    restaurant_name: "Taco Fiesta (Mock)",
  },
  "mock-item-nachos": {
    menu_item_id: "mock-item-nachos",
    name: "Nachos Supreme (Mock)",
    price: 259,
    isVeg: true,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: false,
    restaurant_id: "mock-rest-5",
    restaurant_name: "Taco Fiesta (Mock)",
  },
  "mock-item-masala-dosa": {
    menu_item_id: "mock-item-masala-dosa",
    name: "Masala Dosa (Mock)",
    price: 149,
    isVeg: true,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: true,
    restaurant_id: "mock-rest-6",
    restaurant_name: "Idli Dosa Corner (Mock)",
  },
  "mock-item-idli-sambar": {
    menu_item_id: "mock-item-idli-sambar",
    name: "Idli Sambar (Mock)",
    price: 99,
    isVeg: true,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: false,
    restaurant_id: "mock-rest-6",
    restaurant_name: "Idli Dosa Corner (Mock)",
  },
  "mock-item-medu-vada": {
    menu_item_id: "mock-item-medu-vada",
    name: "Medu Vada (Mock)",
    price: 89,
    isVeg: true,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: false,
    restaurant_id: "mock-rest-6",
    restaurant_name: "Idli Dosa Corner (Mock)",
  },
  "mock-item-cheeseburger": {
    menu_item_id: "mock-item-cheeseburger",
    name: "Classic Cheeseburger (Mock)",
    price: 219,
    isVeg: false,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: true,
    restaurant_id: "mock-rest-7",
    restaurant_name: "Burger Barn (Mock)",
  },
  "mock-item-grilled-chicken-burger": {
    menu_item_id: "mock-item-grilled-chicken-burger",
    name: "Grilled Chicken Burger (Mock)",
    price: 249,
    isVeg: false,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: false,
    restaurant_id: "mock-rest-7",
    restaurant_name: "Burger Barn (Mock)",
  },
  "mock-item-loaded-fries": {
    menu_item_id: "mock-item-loaded-fries",
    name: "Loaded Fries (Mock)",
    price: 179,
    isVeg: true,
    inStock: 1,
    hasVariants: false,
    hasAddons: false,
    isBestseller: false,
    restaurant_id: "mock-rest-7",
    restaurant_name: "Burger Barn (Mock)",
  },
};

const ADDRESSES = [
  { id: "mock-addr-home", addressLine: "1 Mock Street, Test Layout", phoneNumber: "9999999999", addressCategory: "Home", addressTag: "Home" },
  { id: "mock-addr-work", addressLine: "2 Fake Avenue, Test Layout", phoneNumber: "9999999999", addressCategory: "Work", addressTag: "Work" },
];

const COUPON_CODE = "MOCKSAVE20";

// --- Order history (get_food_orders / get_food_order_details, for testing
// Nosh's "reorder my usual" feature - see src/food-order-orchestrator.js's
// buildReorderUsualReply - and its recommend_similar "already ordered"
// exclusion, see recommendSimilar's wasAlreadyOrdered) --------------------
// Two DELIVERED orders at mock-rest-1 (biryani) so it qualifies as a
// "usual" (>=2 non-active orders at the same restaurant); one order at
// mock-rest-2 (pizza) that does NOT qualify on its own, so the
// per-restaurant counting/tie-break logic has something real to pick
// between. Listed newest-first, matching get_food_orders' documented order.
// This is the SEED for a fresh sender's history (see
// orderHistoryByKey/getOrderHistory below) - never mutated directly.
const SEED_ORDER_HISTORY = [
  {
    orderId: "mock-order-hist-3",
    restaurantId: "mock-rest-1",
    restaurantName: "Test Kitchen Biryani House (Mock)",
    restaurantAreaName: "Mock Nagar",
    orderTotal: "301",
    orderStatus: "DELIVERED",
    orderDeliveryStatus: "DELIVERED",
    orderType: "REGULAR",
    orderedItems: "1x Chicken Biryani (Mock)",
    orderedTime: "September 15, 8:10 PM (Mock)",
    isActiveOrder: false,
    actions: [],
  },
  {
    orderId: "mock-order-hist-2",
    restaurantId: "mock-rest-2",
    restaurantName: "Fake Pizza Co (Mock)",
    restaurantAreaName: "Mock Nagar",
    orderTotal: "259",
    orderStatus: "DELIVERED",
    orderDeliveryStatus: "DELIVERED",
    orderType: "REGULAR",
    orderedItems: "1x Margherita Pizza (Mock)",
    orderedTime: "September 12, 1:30 PM (Mock)",
    isActiveOrder: false,
    actions: [],
  },
  {
    orderId: "mock-order-hist-1",
    restaurantId: "mock-rest-1",
    restaurantName: "Test Kitchen Biryani House (Mock)",
    restaurantAreaName: "Mock Nagar",
    orderTotal: "301",
    orderStatus: "DELIVERED",
    orderDeliveryStatus: "DELIVERED",
    orderType: "REGULAR",
    orderedItems: "1x Chicken Biryani (Mock)",
    orderedTime: "September 5, 7:45 PM (Mock)",
    isActiveOrder: false,
    actions: [],
  },
];

// Keyed by orderId, matching get_food_order_details' structured order_items
// shape. NOTE: Swiggy's own docs type variants[].variation_id/group_id as
// NUMBERS on this endpoint, unlike the STRING ids variantsV2 selections use
// everywhere else (search_menu, update_food_cart) - a real, live-unverified
// mismatch risk flagged in src/food-order-orchestrator.js's
// buildReorderCartItems. This mock deliberately uses the SAME string ids as
// MENU_ITEMS' variantsV2 below so a local reorder test round-trips cleanly
// through update_food_cart's mock matching logic - that means exercising
// this mock does NOT prove the number-vs-string question either way;
// re-verify buildReorderCartItems' field mapping against a real
// get_food_order_details response before trusting it in production.
const ORDER_DETAILS = {
  "mock-order-hist-3": {
    order_id: 3,
    restaurant_id: "mock-rest-1",
    restaurant_name: "Test Kitchen Biryani House (Mock)",
    is_reorderable_order: true,
    order_status: "DELIVERED",
    order_total: 301,
    item_total: 249,
    order_items: [
      {
        item_id: "mock-item-biryani",
        name: "Chicken Biryani (Mock)",
        quantity: "1",
        variants: [{ variation_id: "v-half", group_id: "g-size", name: "Half", price: 0 }],
      },
    ],
  },
  "mock-order-hist-1": {
    order_id: 1,
    restaurant_id: "mock-rest-1",
    restaurant_name: "Test Kitchen Biryani House (Mock)",
    is_reorderable_order: true,
    order_status: "DELIVERED",
    order_total: 301,
    item_total: 249,
    order_items: [
      {
        item_id: "mock-item-biryani",
        name: "Chicken Biryani (Mock)",
        quantity: "1",
        variants: [{ variation_id: "v-half", group_id: "g-size", name: "Half", price: 0 }],
      },
    ],
  },
  "mock-order-hist-2": {
    order_id: 2,
    restaurant_id: "mock-rest-2",
    restaurant_name: "Fake Pizza Co (Mock)",
    is_reorderable_order: true,
    order_status: "DELIVERED",
    order_total: 259,
    item_total: 219,
    order_items: [{ item_id: "mock-item-margherita", name: "Margherita Pizza (Mock)", quantity: "1" }],
  },
};

// --- Per-caller in-memory carts -----------------------------------------
// Keyed by the request's Authorization bearer token via cartKeyStorage (an
// AsyncLocalStorage set once per incoming HTTP request in
// handleMockSwiggyFoodRequest below, not per MCP session) - a fresh MCP
// session is opened on every single webhook request (see
// src/swiggy-food-client.js: a new client is created and closed per
// message), so keying by MCP session id alone would reset the cart on
// every message; keying by the bearer token instead lets it persist across
// a sender's whole conversation while staying isolated from every other
// sender hitting this same deployed mock. AsyncLocalStorage (not a plain
// module variable holding "the current key") because requests from
// different senders can genuinely be in flight concurrently - a plain
// variable would race between them.
const cartsByKey = new Map();
const cartKeyStorage = new AsyncLocalStorage();

// --- Per-caller in-memory order history -----------------------------------
// Same AsyncLocalStorage key as cartsByKey above (the request's Authorization
// bearer token) - keeps each sender's order history isolated from every
// other sender's, for the same reason carts are isolated (see cartsByKey's
// own comment). Seeded with a COPY of SEED_ORDER_HISTORY on first access per
// key, then genuinely appended to by place_food_order below - unlike the
// original static ORDER_HISTORY constant this replaces, which place_food_order
// never wrote to. That staleness was a real, confirmed-live bug: with a
// fixed, never-growing history, recommend_similar's "already ordered"
// exclusion and restaurant-recency picks could never learn about an order a
// tester had just placed THROUGH Nosh itself in the same session, so it kept
// confidently offering items like "something you haven't tried" that the
// same conversation had, in fact, already ordered and paid for moments
// earlier - confirmed against a real decrypted transcript (sender
// 919289388564, 2026-09-21/22) where Chicken Tikka Masala and Peri Peri
// Chicken Pizza were both really ordered, then kept being re-offered as
// novel across later sessions.
const orderHistoryByKey = new Map();

function getOrderHistory() {
  const key = cartKeyStorage.getStore() ?? "default";
  let history = orderHistoryByKey.get(key);

  if (!history) {
    history = [...SEED_ORDER_HISTORY];
    orderHistoryByKey.set(key, history);
  }

  return history;
}

// Called by place_food_order's COD path once an order is genuinely placed -
// see that handler below. Prepended (newest-first, matching get_food_orders'
// documented order). Marked DELIVERED/isActiveOrder:false immediately rather
// than modeling a real in-flight delivery window - a mock-only
// simplification (this order will never actually be delivered) needed so
// recommend_similar's history-based logic, which excludes active orders,
// treats it as real history right away instead of only after some further
// mocked state transition nothing in this file drives.
function recordPlacedOrder({ orderId, cartData, addressId }) {
  const orderedItems = cartData.items.map((item) => `${item.quantity}x ${item.name}`).join(", ");

  getOrderHistory().unshift({
    orderId,
    restaurantId: cartData.restaurant?.id,
    restaurantName: cartData.restaurant?.name,
    restaurantAreaName: cartData.restaurant?.area ?? "Mock Nagar",
    orderTotal: String(cartData.pricing.to_pay),
    orderStatus: "DELIVERED",
    orderDeliveryStatus: "DELIVERED",
    orderType: "REGULAR",
    orderedItems,
    orderedTime: `${new Date().toLocaleString("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })} (Mock)`,
    isActiveOrder: false,
    actions: [],
  });
}

function freshCart(previousCartId) {
  return {
    cart_id: (previousCartId ?? 0) + 1,
    restaurantId: undefined,
    restaurantName: undefined,
    items: new Map(), // menu_item_id -> { menu_item_id, name, quantity, unitPrice, variants }
    couponCode: undefined,
  };
}

function getCart() {
  const key = cartKeyStorage.getStore() ?? "default";
  let cart = cartsByKey.get(key);

  if (!cart) {
    cart = freshCart(0);
    cartsByKey.set(key, cart);
  }

  return cart;
}

function resetCart() {
  const key = cartKeyStorage.getStore() ?? "default";
  const next = freshCart(cartsByKey.get(key)?.cart_id);
  cartsByKey.set(key, next);
  return next;
}

function computeCartData() {
  const cart = getCart();
  const items = [...cart.items.values()].map((item) => {
    const total = item.unitPrice * item.quantity;
    return {
      menu_item_id: item.menu_item_id,
      name: item.name,
      quantity: item.quantity,
      is_veg: item.isVeg,
      subtotal: total,
      total,
      final_price: item.unitPrice,
      in_stock: true,
      variants: item.variants,
    };
  });

  const itemTotal = items.reduce((sum, item) => sum + item.total, 0);
  const deliveryCharge = items.length > 0 ? 40 : 0;
  const taxesAndCharges = Math.round(itemTotal * 0.05);
  const couponDiscount = cart.couponCode === COUPON_CODE ? Math.min(50, Math.round(itemTotal * 0.1)) : 0;
  const toPay = Math.max(0, itemTotal + deliveryCharge + taxesAndCharges - couponDiscount);

  return {
    cart_id: cart.cart_id,
    result: "success",
    restaurant: cart.restaurantId
      ? { id: cart.restaurantId, name: cart.restaurantName, area: "Mock Nagar" }
      : null,
    items,
    item_count: items.length,
    pricing: {
      item_total: itemTotal,
      delivery_charge: deliveryCharge,
      taxes_and_charges: taxesAndCharges,
      to_pay: toPay,
    },
    offers: {
      coupon_applied: couponDiscount > 0 ? cart.couponCode : null,
      coupon_discount: couponDiscount,
      free_delivery_applied: false,
    },
  };
}

function cartEnvelope(statusMessage = "CART_UPDATED_SUCCESSFULLY") {
  return { statusCode: 0, statusMessage, data: computeCartData() };
}

function structuredResult(structured) {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

// --- MCP server + tools -------------------------------------------------
// Parameter names/types and output field names below are taken directly
// from mcp.swiggy.com/builders/docs/reference/food/*.md (fetched live for
// this file) and cross-checked against src/food-order-orchestrator.js and
// src/food-search-orchestrator.js's own parsing code plus their test
// fixtures, which is the more authoritative source where the two disagree.

function buildServer() {
  const server = new McpServer({ name: "mock-swiggy-food", version: "0.1.0" });

  server.registerTool(
    "search_restaurants",
    {
      description: "Mock: search restaurants for delivery.",
      inputSchema: {
        addressId: z.string(),
        query: z.string(),
        offset: z.number().optional(),
        collection: z.enum(["EATRIGHT", "BOLT", "STORE_99"]).optional(),
      },
    },
    async ({ query }) => {
      // Was `nameMatches || query.trim().length > 0` - the second clause
      // made this return every restaurant for any non-empty query,
      // regardless of relevance. Confirmed live: a "pasta" search returned
      // a biryani house and a pizza place, neither of which serves pasta,
      // and the agent burned multiple tool-call rounds discovering that via
      // search_menu before running out of budget. Now matches by name,
      // cuisine tag, or having an actual matching menu item - a reasonable
      // stand-in for real Swiggy's cross-restaurant dish search, not "show
      // everything."
      const normalizedQuery = query.trim().toLowerCase();
      const menuItemList = Object.values(MENU_ITEMS);

      const restaurants = RESTAURANTS.filter((restaurant) => {
        if (normalizedQuery.length === 0) {
          return true;
        }

        const nameMatches = restaurant.name.toLowerCase().includes(normalizedQuery);
        const cuisineMatches = (restaurant.cuisines ?? []).some((cuisine) =>
          cuisine.toLowerCase().includes(normalizedQuery),
        );
        const hasMatchingItem = menuItemList.some(
          (item) => item.restaurant_id === restaurant.id && item.name.toLowerCase().includes(normalizedQuery),
        );

        return nameMatches || cuisineMatches || hasMatchingItem;
      });

      return structuredResult({
        restaurants,
        dishes: [],
        query,
        totalRestaurants: restaurants.length,
        hasMore: false,
      });
    },
  );

  server.registerTool(
    "search_menu",
    {
      description: "Mock: search dishes/menu items.",
      inputSchema: {
        addressId: z.string(),
        query: z.string(),
        restaurantIdOfAddedItem: z.string().optional(),
        vegFilter: z.union([z.literal(0), z.literal(1)]).optional(),
        offset: z.number().optional(),
      },
    },
    async ({ query, restaurantIdOfAddedItem }) => {
      const normalizedQuery = query.trim().toLowerCase();
      let items = Object.values(MENU_ITEMS).filter((item) => item.name.toLowerCase().includes(normalizedQuery));

      if (restaurantIdOfAddedItem) {
        items = items.filter((item) => item.restaurant_id === restaurantIdOfAddedItem);
      }

      return structuredResult({
        items,
        query,
        restaurantIdOfAddedItem,
        totalItems: items.length,
        hasMore: false,
      });
    },
  );

  server.registerTool(
    "get_restaurant_menu",
    {
      description: "Mock: browse a restaurant's full menu.",
      inputSchema: { addressId: z.string(), restaurantId: z.string() },
    },
    async ({ restaurantId }) => {
      const restaurant = RESTAURANTS.find((entry) => entry.id === restaurantId);
      const items = Object.values(MENU_ITEMS)
        .filter((item) => item.restaurant_id === restaurantId)
        .map((item) => ({
          id: item.menu_item_id,
          name: item.name,
          price: item.price,
          inStock: item.inStock,
          isVeg: item.isVeg,
          isBestseller: item.isBestseller,
          hasVariants: item.hasVariants,
          hasAddons: item.hasAddons,
          categories: ["Recommended"],
        }));

      return structuredResult({
        restaurant: restaurant
          ? {
              id: restaurant.id,
              name: restaurant.name,
              city: "Mock City",
              isOpen: true,
              avgRating: restaurant.avgRating,
              avgRatingString: String(restaurant.avgRating),
              deliveryTime: restaurant.deliveryTimeMinutes,
              slaString: restaurant.deliveryTimeRange,
            }
          : null,
        items,
        categoryLabels: ["Recommended"],
        totalItems: items.length,
        totalCategories: 1,
      });
    },
  );

  server.registerTool(
    "get_addresses",
    {
      description: "Mock: saved delivery addresses.",
      inputSchema: { page: z.number().optional(), pageSize: z.number().optional() },
    },
    async () => {
      // Matches the documented response shape exactly - { addresses,
      // pagination }, no "resolution" object. There are 2 mock addresses on
      // purpose so this exercises the real "which address?" prompt (see
      // handleNewFoodSearch in src/food-search-orchestrator.js) during
      // manual testing, instead of silently defaulting.
      return structuredResult({
        addresses: ADDRESSES,
        total: ADDRESSES.length,
        pagination: { page: 1, pageSize: 10, total: ADDRESSES.length, totalPages: 1, hasMore: false },
      });
    },
  );

  server.registerTool(
    "update_food_cart",
    {
      description: "Mock: add/update items in the cart.",
      inputSchema: {
        restaurantId: z.string(),
        cartItems: z.array(z.any()),
        addressId: z.string(),
        restaurantName: z.string().optional(),
        cutleryOptIn: z.boolean().optional(),
      },
    },
    async ({ restaurantId, restaurantName, cartItems }) => {
      const cart = getCart();
      cart.restaurantId = restaurantId;
      cart.restaurantName = restaurantName ?? cart.restaurantName;

      for (const requested of cartItems) {
        const menuItem = MENU_ITEMS[requested.menu_item_id];

        if (!menuItem) {
          continue; // Unknown item id - silently ignored, same as "no-op" rather than a hard error.
        }

        const quantity = Number(requested.quantity ?? 1);

        if (quantity <= 0) {
          cart.items.delete(requested.menu_item_id);
          continue;
        }

        const variantSurcharge = (Array.isArray(requested.variantsV2) ? requested.variantsV2 : [])
          .map((selection) => {
            const group = menuItem.variantsV2?.find((g) => g.groupId === selection.group_id);
            const variation = group?.variations?.find((v) => v.id === selection.variation_id);
            return variation?.price ?? 0;
          })
          .reduce((sum, price) => sum + price, 0);

        cart.items.set(requested.menu_item_id, {
          menu_item_id: requested.menu_item_id,
          name: menuItem.name,
          quantity,
          unitPrice: menuItem.price + variantSurcharge,
          isVeg: menuItem.isVeg,
          variants: (requested.variantsV2 ?? []).map((selection) => ({
            group_id: selection.group_id,
            variation_id: selection.variation_id,
            name: menuItem.variantsV2
              ?.find((g) => g.groupId === selection.group_id)
              ?.variations?.find((v) => v.id === selection.variation_id)?.name,
          })),
        });
      }

      return structuredResult(cartEnvelope("CART_UPDATED_SUCCESSFULLY"));
    },
  );

  server.registerTool(
    "get_food_cart",
    {
      description: "Mock: view the current cart.",
      inputSchema: { addressId: z.string(), restaurantName: z.string().optional() },
    },
    async () => structuredResult(cartEnvelope("CART_FETCHED_SUCCESSFULLY")),
  );

  server.registerTool(
    "flush_food_cart",
    { description: "Mock: clear the cart.", inputSchema: {} },
    async () => {
      resetCart();
      return structuredResult({ statusCode: 0, statusMessage: "CART_CLEARED_SUCCESSFULLY", success: true, message: "Cart cleared (mock)." });
    },
  );

  server.registerTool(
    "fetch_food_coupons",
    {
      description: "Mock: list available coupons.",
      inputSchema: { restaurantId: z.string(), addressId: z.string(), couponCode: z.string().optional() },
    },
    async () => {
      return structuredResult({
        coupon_sections: [
          {
            title: "Best offers (Mock)",
            type: "best",
            coupons: [
              {
                id: "mock-coupon-1",
                applicable: true,
                applicabilityStatus: "APPLICABLE",
                title: COUPON_CODE,
                subtitle: "10% off, up to ₹50 (Mock)",
                description: `Use ${COUPON_CODE} for 10% off, up to ₹50 (Mock, COD only)`,
              },
            ],
          },
        ],
        summary: { total_coupons: 1, applicable_coupons: 1, sections_count: 1, filter_applied: "COD" },
      });
    },
  );

  server.registerTool(
    "apply_food_coupon",
    {
      description: "Mock: apply a coupon to the cart.",
      inputSchema: { couponCode: z.string(), addressId: z.string(), cartId: z.union([z.string(), z.number()]).optional() },
    },
    async ({ couponCode }) => {
      getCart().couponCode = couponCode.trim().toUpperCase() === COUPON_CODE ? COUPON_CODE : undefined;
      return structuredResult(cartEnvelope("COUPON_APPLIED"));
    },
  );

  server.registerTool(
    "get_payment_options",
    {
      description: "Mock: live payment methods for the cart.",
      inputSchema: { addressId: z.string().optional() },
    },
    async ({ addressId }) => {
      const cod = { available: true, id: "mock-cod", displayName: "Cash on Delivery (Mock)" };
      return structuredResult({
        platforms: { mobile: { groupName: "Mock UPI Apps", methods: [] }, desktop: { groupName: "Mock Scan & Pay", methods: [] } },
        cod,
        allMethods: [{ id: cod.id, groupName: "Cash", displayName: cod.displayName, kind: undefined, enabled: true }],
        paymentAmount: String(computeCartData().pricing.to_pay),
        addressId,
        placeOrderToolName: "place_food_order",
      });
    },
  );

  server.registerTool(
    "place_food_order",
    {
      description: "Mock: place the order (Cash/COD only; UPI is a stub).",
      inputSchema: {
        addressId: z.string(),
        paymentMethod: z.string().optional(),
        intentApp: z.string().optional(),
        generateUPIQR: z.boolean().optional(),
        noteToRestaurant: z.string().optional(),
      },
    },
    async ({ addressId, paymentMethod }) => {
      const cartData = computeCartData();
      const orderId = `mock-order-${Date.now()}`;
      // Mock coordinates - a real cart's lat/lng come from the resolved
      // address. Included even on the COD path because Nosh's own
      // placeConfirmedOrder() reads lat/lng unconditionally from this
      // response and passes them straight to confirm_order (see
      // src/food-order-orchestrator.js) - matches observed live behaviour,
      // not just the (COD-omits-lat/lng) documented union type.
      const lat = 12.9716;
      const lng = 77.5946;

      if (paymentMethod && paymentMethod.toUpperCase() === "UPI") {
        return structuredResult({
          orderId,
          paasId: `mock-paas-${Date.now()}`,
          transactionId: `mock-txn-${Date.now()}`,
          upiIntentUrl: "upi://mock-pay",
          bridgeUrl: "https://example.invalid/mock-bridge",
          isQrFlow: false,
          pollingIntervalInMs: 2000,
          maxTimeToPollForInMs: 60000,
          paymentMethod: "UPI",
          status: "PENDING_PAYMENT",
          normalizedStatus: "pending",
          totalAmount: cartData.pricing.to_pay,
          restaurantName: cartData.restaurant?.name ?? null,
          restaurantAddress: "Mock Nagar",
          deliveryAddress: ADDRESSES.find((address) => address.id === addressId)?.addressLine ?? null,
          addressId,
          cartId: String(cartData.cart_id),
          lat,
          lng,
        });
      }

      // Record it into THIS sender's order history now, not just return a
      // response - see recordPlacedOrder's own comment for why this matters
      // (a confirmed-live bug: without this, get_food_orders never learned
      // about an order just placed through Nosh itself).
      recordPlacedOrder({ orderId, cartData, addressId });

      return structuredResult({
        orderId,
        status: "CONFIRMED",
        normalizedStatus: "success",
        items: cartData.items.map((item) => ({
          item_id: item.menu_item_id,
          name: item.name,
          quantity: item.quantity,
          total: item.total,
          subtotal: item.subtotal,
          final_price: item.final_price,
        })),
        restaurantName: cartData.restaurant?.name ?? null,
        restaurantAddress: "Mock Nagar",
        totalAmount: cartData.pricing.to_pay,
        estimatedDelivery: "30-35 mins (Mock)",
        deliveryAddress: ADDRESSES.find((address) => address.id === addressId)?.addressLine ?? null,
        lat,
        lng,
      });
    },
  );

  server.registerTool(
    "confirm_order",
    {
      description: "Mock: finalize an order after payment.",
      inputSchema: {
        orderId: z.string(),
        transactionId: z.string().optional(),
        paasId: z.string().optional(),
        addressId: z.string().optional(),
        cartId: z.union([z.string(), z.number()]).optional(),
        lat: z.number().optional(),
        lng: z.number().optional(),
      },
    },
    async ({ orderId }) => {
      return structuredResult({ orderId, orderStatus: "CONFIRMED", result: "success" });
    },
  );

  server.registerTool(
    "get_food_orders",
    {
      description: "Mock: order history (active and delivered), newest-first.",
      inputSchema: { addressId: z.string(), activeOnly: z.boolean().optional() },
    },
    async ({ activeOnly }) => {
      const history = getOrderHistory();
      const orders = activeOnly ? history.filter((order) => order.isActiveOrder) : history;
      return structuredResult({ orders });
    },
  );

  server.registerTool(
    "get_food_order_details",
    {
      description: "Mock: detailed structured items/pricing for one past order.",
      inputSchema: { orderId: z.string() },
    },
    async ({ orderId }) => {
      const order = ORDER_DETAILS[orderId];

      if (!order) {
        return { isError: true, content: [{ type: "text", text: "Mock: unknown orderId." }] };
      }

      return structuredResult({ order });
    },
  );

  return server;
}

// --- Plain node:http transport wiring (no express - matches the rest of
// this app, which never uses it either) -------------------------------

const sessions = new Map(); // sessionId -> { server, transport }

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

function sendJsonRpcError(response, statusCode, message) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

// Exported so src/server.js can mount this MCP server as one more route on
// its own listener (see SWIGGY_TEST_MODE in src/config.js) instead of
// standing up a second process/port - real WhatsApp round-trip testing
// without ever contacting real Swiggy. Operates generically on whatever
// request/response pair it's given; the only thing callers must not do is
// read the request body themselves first (readJsonBody below needs to).
export const MOCK_FOOD_PATH = PATH;

export async function handleMockSwiggyFoodRequest(request, response) {
  if (request.method === "GET" || request.method === "DELETE") {
    response.writeHead(405, { allow: "POST" }).end("Method Not Allowed (mock server: stateless GET/DELETE unsupported)");
    return;
  }

  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" }).end();
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJsonRpcError(response, 400, `Invalid JSON body: ${error.message}`);
    return;
  }

  // Cart isolation key for this request - see cartsByKey/cartKeyStorage
  // above. Deliberately the raw Authorization header value (not decoded or
  // validated - this mock never checks auth), so distinct bearer tokens map
  // to distinct carts; no header at all (the standalone single-developer
  // usage this file's own header comment documents) falls back to one
  // shared "default" bucket.
  const authHeader = request.headers.authorization;
  const cartKey = typeof authHeader === "string" && authHeader.trim() ? authHeader.trim() : "default";

  await cartKeyStorage.run(cartKey, async () => {
    try {
      const sessionId = request.headers["mcp-session-id"];
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session) {
        if (sessionId) {
          response.writeHead(404).end();
          return;
        }

        if (!isInitializeRequest(body)) {
          sendJsonRpcError(response, 400, "No valid session ID provided.");
          return;
        }

        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, { server, transport });
          },
        });

        await server.connect(transport);
        await transport.handleRequest(request, response, body);
        return;
      }

      await session.transport.handleRequest(request, response, body);
    } catch (error) {
      console.error("Mock Swiggy Food server error handling request.", error);

      if (!response.headersSent) {
        sendJsonRpcError(response, 500, "Internal mock server error.");
      }
    }
  });
}

// Only runs the file as a standalone server when executed directly (`node
// scripts/mock-swiggy-food-server.js`) - importing it for the exports above
// (from src/server.js in SWIGGY_TEST_MODE) must never also open this
// second listener.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const httpServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://localhost:${PORT}`);

    if (url.pathname !== PATH) {
      response.writeHead(404).end();
      return;
    }

    await handleMockSwiggyFoodRequest(request, response);
  });

  httpServer.listen(PORT, () => {
    console.log(`Mock Swiggy Food MCP server listening on http://localhost:${PORT}${PATH}`);
    console.log(`Point Nosh at it with: SWIGGY_FOOD_MCP_URL=http://localhost:${PORT}${PATH}`);
  });

  process.on("SIGINT", () => {
    httpServer.close(() => process.exit(0));
  });
}
