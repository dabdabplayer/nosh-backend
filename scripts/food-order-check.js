// Manual dev tool: drive the FULL conversation flow (search -> pick a
// restaurant -> add to cart -> view cart / coupons -> checkout -> confirm)
// against the real Swiggy Food MCP server, without needing a live WhatsApp
// round-trip or real Swiggy OAuth. Not part of the app itself.
//
// This replicates src/server.js's buildReplyText dispatch order (pending
// order confirmation -> deterministic address/candidate short-circuits ->
// the Sarvam agent) message by message, the same decision logic
// scripts/oauth-connect-check.js uses for its interactive/real-OAuth flow -
// just non-interactive, and swapping the real per-sender OAuth token for
// the same SWIGGY_FOOD_TEST_TOKEN dev bypass.
//
// Requires NLU_API_KEY (real Sarvam) - the agent decides on its own which
// tool to call, there's no more literal "find X" trigger. A bare numeric
// restaurant/item pick (e.g. "1") is the one exception; it's still resolved
// deterministically, no agent call needed.
//
// Usage:
//   SWIGGY_FOOD_MCP_URL=... SWIGGY_FOOD_TEST_TOKEN=... NLU_API_KEY=... \
//     node scripts/food-order-check.js \
//     "I want biryani" "1" "add a margherita pizza" "checkout" "yes"
//   SWIGGY_FOOD_MCP_URL=... SWIGGY_FOOD_TEST_TOKEN=... NLU_API_KEY=... \
//     node scripts/food-order-check.js "reorder my usual" "checkout" "yes"

import { config } from "../src/config.js";
import { resolvePendingAddressReply } from "../src/food-search-orchestrator.js";
import {
  parseOrderConfirmationReply,
  placeConfirmedOrder,
  resolvePendingCartCandidateReply,
} from "../src/food-order-orchestrator.js";
import { PendingAddressSelections } from "../src/pending-address-selection.js";
import { PendingCartSessions } from "../src/pending-cart-sessions.js";
import { PendingConversationHistory } from "../src/pending-conversation-history.js";
import { PendingOrderConfirmations } from "../src/pending-order-confirmations.js";
import { runAgentTurn } from "../src/sarvam-agent.js";
import { createSwiggyFoodClient } from "../src/swiggy-food-client.js";

const messages = process.argv.slice(2);
const sender = "test-sender";

if (messages.length === 0) {
  console.error(
    'Usage: node scripts/food-order-check.js "I want biryani" "1" "add a margherita pizza" "checkout" "yes"',
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
  const pendingConversationHistory = new PendingConversationHistory();

  if (!config.nlu.enabled) {
    console.warn(
      "The NLU provider isn't configured (no NLU_API_KEY) - only numeric restaurant/item picks will work. " +
        "Set NLU_API_KEY (see .env.example) to exercise the agent.",
    );
  }

  // Mirrors src/server.js's buildOrderConfirmationReply, minus the real
  // per-sender auth wrapper (withSwiggyFoodClient) - swiggyFoodClient here
  // is already authenticated via the test token.
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

    if (status === "confirmed") {
      pendingCartSessions.clear(message.from);
      pendingConversationHistory.clear(message.from);
    }

    return replyText;
  }

  // Mirrors src/server.js's buildReplyText dispatch order exactly (pending
  // confirmation -> address/candidate short-circuits -> the agent), minus
  // rollout gating and the real OAuth connect-link branch - this dev tool
  // is always "authenticated" via the test token.
  async function buildReplyText(message) {
    const pendingConfirmation = pendingOrderConfirmations.peek(message.from);

    if (pendingConfirmation) {
      return buildOrderConfirmationReply(message, pendingConfirmation);
    }

    const addressOutcome = await resolvePendingAddressReply({
      message,
      swiggyFoodClient,
      pendingAddressSelections,
      pendingCartSessions,
    });

    if (addressOutcome.handled) {
      return addressOutcome.replyText ?? "(no reply)";
    }

    const candidateOutcome = await resolvePendingCartCandidateReply({ message, swiggyFoodClient, pendingCartSessions });

    if (candidateOutcome.handled) {
      return candidateOutcome.replyText ?? "(no reply)";
    }

    const reply = await runAgentTurn({
      message,
      swiggyFoodClient,
      pendingCartSessions,
      pendingOrderConfirmations,
      pendingAddressSelections,
      pendingConversationHistory,
      nlu: config.nlu,
    });

    return reply ?? "(no reply — placeholder would be used)";
  }

  for (const [index, text] of messages.entries()) {
    const message = { from: sender, id: String(index + 1), phoneNumberId: "test", text };
    const reply = await buildReplyText(message);
    console.log(`> ${text}\n${reply}\n`);
  }

  await swiggyFoodClient.close();
}
