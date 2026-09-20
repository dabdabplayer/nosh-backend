// Manual dev tool: exercise the Swiggy Food search orchestration directly
// against the real Swiggy Food MCP server, without needing a live WhatsApp
// round-trip (useful while the Meta app is still unpublished). Not part of
// the app itself.
//
// Usage:
//   SWIGGY_FOOD_MCP_URL=... SWIGGY_FOOD_TEST_TOKEN=... node scripts/food-search-check.js "find biryani"
//   SWIGGY_FOOD_MCP_URL=... SWIGGY_FOOD_TEST_TOKEN=... node scripts/food-search-check.js "find biryani" "1"

import { config } from "../src/config.js";
import { getFoodSearchReply } from "../src/food-search-orchestrator.js";
import { PendingAddressSelections } from "../src/pending-address-selection.js";
import { createSwiggyFoodClient } from "../src/swiggy-food-client.js";

const [firstMessageText, secondMessageText] = process.argv.slice(2);
const sender = "test-sender";

if (!firstMessageText) {
  console.error(
    'Usage: node scripts/food-search-check.js "find biryani" ["<address selection reply>"]',
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

  const firstReply = await getFoodSearchReply({
    message: { from: sender, id: "1", phoneNumberId: "test", text: firstMessageText },
    swiggyFoodClient,
    pendingAddressSelections,
    nlu: config.nlu,
  });

  console.log(firstReply ?? "(no trigger matched — placeholder would be used)");

  if (secondMessageText) {
    const secondReply = await getFoodSearchReply({
      message: { from: sender, id: "2", phoneNumberId: "test", text: secondMessageText },
      swiggyFoodClient,
      pendingAddressSelections,
      nlu: config.nlu,
    });

    console.log(secondReply ?? "(no trigger matched — placeholder would be used)");
  }

  await swiggyFoodClient.close();
}
