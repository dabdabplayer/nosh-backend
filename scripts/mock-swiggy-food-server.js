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
// This is a single-cart, single-session stub (no concurrent-user isolation)
// - fine for one developer driving one manual test at a time.
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
    isBestseller: false,
    restaurant_id: "mock-rest-2",
    restaurant_name: "Fake Pizza Co (Mock)",
  },
};

const ADDRESSES = [
  { id: "mock-addr-home", addressLine: "1 Mock Street, Test Layout", phoneNumber: "9999999999", addressCategory: "Home", addressTag: "Home" },
  { id: "mock-addr-work", addressLine: "2 Fake Avenue, Test Layout", phoneNumber: "9999999999", addressCategory: "Work", addressTag: "Work" },
];

const COUPON_CODE = "MOCKSAVE20";

// --- Order history (get_food_orders / get_food_order_details, for testing
// Nosh's "reorder my usual" feature - see src/food-order-orchestrator.js's
// buildReorderUsualReply) -------------------------------------------------
// Two DELIVERED orders at mock-rest-1 (biryani) so it qualifies as a
// "usual" (>=2 non-active orders at the same restaurant); one order at
// mock-rest-2 (pizza) that does NOT qualify on its own, so the
// per-restaurant counting/tie-break logic has something real to pick
// between. Listed newest-first, matching get_food_orders' documented order.
const ORDER_HISTORY = [
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

// --- Single in-memory cart --------------------------------------------
// Deliberately module-level, not per-session: this is a single-developer
// manual test tool, not a multi-user server.

let cart = {
  cart_id: 1,
  restaurantId: undefined,
  restaurantName: undefined,
  items: new Map(), // menu_item_id -> { menu_item_id, name, quantity, unitPrice, variants }
  couponCode: undefined,
};

function computeCartData() {
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
      const restaurants = RESTAURANTS.filter((restaurant) =>
        restaurant.name.toLowerCase().includes(query.trim().toLowerCase()) || query.trim().length > 0,
      );

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
        restaurant: restaurant ? { id: restaurant.id, name: restaurant.name, city: "Mock City", isOpen: true } : null,
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
      return structuredResult({
        addresses: ADDRESSES,
        total: ADDRESSES.length,
        resolution: { needsUserClarification: false, defaultAddressId: ADDRESSES[0].id },
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
      cart = { cart_id: cart.cart_id + 1, restaurantId: undefined, restaurantName: undefined, items: new Map(), couponCode: undefined };
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
      cart.couponCode = couponCode.trim().toUpperCase() === COUPON_CODE ? COUPON_CODE : undefined;
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
      const orders = activeOnly ? ORDER_HISTORY.filter((order) => order.isActiveOrder) : ORDER_HISTORY;
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
