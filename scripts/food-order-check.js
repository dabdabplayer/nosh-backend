// Manual dev tool: drive the FULL conversation flow (search -> pick a
// restaurant -> add to cart -> view cart / coupons -> checkout -> confirm)
// against the real Swiggy Food MCP server, without needing a live WhatsApp
// round-trip or real Swiggy OAuth. Not part of the app itself.
//
// This is food-search-check.js's sibling: that script only ever calls
// getFoodSearchReply, so it can't exercise add-to-cart/checkout at all (see
// src/food-order-orchestrator.js's getFoodOrderReply - it dispatches on
// pendingCartSessions, which food-search-check.js never drives). This
// script replicates src/server.js's buildReplyText dispatch order
// (pending order confirmation -> active cart session -> search) message by
// message, the same decision logic scripts/oauth-connect-check.js uses for
// its interactive/real-OAuth flow - just non-interactive, and swapping the
// real per-sender OAuth token for the same SWIGGY_FOOD_TEST_TOKEN dev
// bypass food-search-check.js already uses.
//
// Beyond add-to-cart and checkout, and unlike food-search-check.js,
// order-intent classification (add_to_cart/view_cart/find_coupons/
// apply_coupon/checkout) requires nvidiaNim.enabled - see
// getFoodOrderReply's early return. A bare numeric restaurant pick (e.g.
// "1") is the one exception; it's resolved deterministically, no NLU
// needed. For everything else (e.g. "add a margherita pizza", "checkout"),
// set NVIDIA_API_KEY (real NVIDIA NIM) or point NVIDIA_NIM_BASE_URL /
// NVIDIA_NIM_MODEL at a local OpenAI-compatible server (e.g. Ollama - see
// .env.example) before running this.
//
// Also exercises "reorder my usual" (src/food-order-orchestrator.js's
// buildReorderUsualReply) - like add_to_cart/checkout, it needs NVIDIA NIM
// enabled to be recognized, since reorder_usual is an NLU tool-call
// classification, not a literal trigger. Against the mock server
// (scripts/mock-swiggy-food-server.js), "reorder my usual" qualifies for
// mock-rest-1 (2 seeded past orders there) and shows the freshly-rebuilt
// cart, not the old order's total.
//
// Usage:
//   SWIGGY_FOOD_MCP_URL=... SWIGGY_FOOD_TEST_TOKEN=... \
//     node scripts/food-order-check.js \
//     "find biryani" "1" "add a margherita pizza" "checkout" "yes"
//   SWIGGY_FOOD_MCP_URL=... SWIGGY_FOOD_TEST_TOKEN=... \
//     node scripts/food-order-check.js "reorder my usual" "checkout" "yes"

import { config } from "../src/config.js";
import { classifyIncomingMessage, getFoodSearchReply } from "../src/food-search-orchestrator.js";
import {
  buildReorderUsualReply,
  getFoodOrderReply,
  parseOrderConfirmationReply,
  placeConfirmedOrder,
} from "../src/food-order-orchestrator.js";
import { PendingAddressSelections } from "../src/pending-address-selection.js";
import { PendingCartSessions } from "../src/pending-cart-sessions.js";
import { PendingOrderConfirmations } from "../src/pending-order-confirmations.js";
import { createSwiggyFoodClient } from "../src/swiggy-food-client.js";

const messages = process.argv.slice(2);
const sender = "test-sender";

if (messages.length === 0) {
  console.error(
    'Usage: node scripts/food-order-check.js "find biryani" "1" "add a margherita pizza" "checkout" "yes"',
  );
  process.exitCode = 1;
} else if (!config.swiggyFood.enabled || !config.swiggyFood.testToken) {
  console.error("SWIGGY_FOOD_MCP_URL and SWIGGY_FOOD_TEST_TOKEN must both be set.");
  process.exitCode = 1;
} else {
  const swiggyFoodClient = createSwiggyFoodClient({
    mcpUrl: config.swiggyFood.mcpUrl,
    token: config.swiggyFood.testToken,
  });
  const pendingAddressSelections = new PendingAddressSelections();
  const pendingCartSessions = new PendingCartSessions();
  const pendingOrderConfirmations = new PendingOrderConfirmations();

  if (!config.nvidiaNim.enabled) {
    console.warn(
      "NVIDIA NIM isn't configured (no NVIDIA_API_KEY / NVIDIA_NIM_BASE_URL) - only the literal " +
        '"find X" search trigger and numeric restaurant picks will work. Set NVIDIA_API_KEY or point ' +
        "NVIDIA_NIM_BASE_URL at a local model (see .env.example) to exercise add-to-cart/checkout.",
    );
  }

  // Mirrors src/server.js's buildOrderConfirmationReply, minus the real
  // per-sender auth wrapper (withSwiggyFoodClient) - swiggyFoodClient here
  // is already authenticated via the test token, same shortcut
  // food-search-check.js takes for search.
  async function buildOrderConfirmationReply(message, pendingConfirmation) {
    const decision = parseOrderConfirmationReply(message.text);

    if (decision === "cancel") {
      pendingOrderConfirmations.clear(message.from);
      return "Order cancelled. Your cart is still there if you'd like to check out again later.";
    }

    if (decision !== "confirm") {
      return "Please reply YES to place this order, or NO to cancel.";
    }

    const outcome = await placeConfirmedOrder({ swiggyFoodClient, confirmation: pendingConfirmation });
    const { status, replyText, orderId, lat, lng } = outcome;

    if (status === "placed_not_confirmed") {
      pendingOrderConfirmations.set(message.from, { ...pendingConfirmation, orderId, lat, lng });
    } else {
      pendingOrderConfirmations.clear(message.from);
    }

    return replyText;
  }

  // Mirrors src/server.js's buildReplyText dispatch order exactly (pending
  // confirmation -> active cart session -> search), minus rollout gating
  // and the real OAuth connect-link branch - this dev tool is always
  // "authenticated" via the test token.
  async function buildReplyText(message) {
    const pendingConfirmation = pendingOrderConfirmations.peek(message.from);

    if (pendingConfirmation) {
      return buildOrderConfirmationReply(message, pendingConfirmation);
    }

    const hasPendingAddressSelection = Boolean(pendingAddressSelections.peek(message.from));
    const activeCartSession = pendingCartSessions.peek(message.from);

    if (activeCartSession && !hasPendingAddressSelection) {
      const orderReply = await getFoodOrderReply({
        message,
        swiggyFoodClient,
        pendingCartSessions,
        pendingOrderConfirmations,
        nvidiaNim: config.nvidiaNim,
      });

      if (orderReply !== undefined) {
        return orderReply;
      }
    }

    const classification = await classifyIncomingMessage(message, pendingAddressSelections, {
      nvidiaNim: config.nvidiaNim,
      pendingCartSessions,
    });

    if (classification.type === "reorder_usual") {
      pendingAddressSelections.clear(message.from);
      return await buildReorderUsualReply({ senderId: message.from, swiggyFoodClient, pendingCartSessions });
    }

    const reply = await getFoodSearchReply({
      message,
      swiggyFoodClient,
      pendingAddressSelections,
      pendingCartSessions,
      classification,
    });

    return reply ?? "(no trigger matched — placeholder would be used)";
  }

  for (const [index, text] of messages.entries()) {
    const message = { from: sender, id: String(index + 1), phoneNumberId: "test", text };
    const reply = await buildReplyText(message);
    console.log(`> ${text}\n${reply}\n`);
  }

  await swiggyFoodClient.close();
}
