// Measures real Swiggy Food MCP latency per tool and compares it with
// Swiggy's published targets (scripts/swiggy-latency-targets.js).
//
// Read-only on purpose: it calls get_addresses, search_restaurants,
// get_restaurant_menu, get_food_cart and get_food_orders, and never changes
// a cart or places an order on a real account. Cart and order latency comes
// from real traffic instead - see scripts/swiggy-latency-report.js.
//
// Uses one MCP session for every call (Swiggy: never re-initialize per tool
// call) and paces requests at 1 per second, under Swiggy's 70/minute
// per-user limit. The first call includes connecting and is reported
// separately as the cold call.
//
// Times include your network to Swiggy; Swiggy's targets exclude it, so run
// this from the same region as the Nosh server (e.g. a Render shell).
//
//   SWIGGY_FOOD_MCP_URL=https://mcp.swiggy.com/food SWIGGY_FOOD_TEST_TOKEN=<a real user's access token> \
//     node scripts/swiggy-latency.js --samples 20
import { parseStructuredPayload, createSwiggyFoodClient } from "../src/swiggy-food-client.js";
import { SwiggyRateLimitedError } from "../src/swiggy-retry.js";
import { printLatencyTable } from "./swiggy-latency-targets.js";

const QUERIES = ["biryani", "pizza", "burger", "dosa", "chinese", "thali", "rolls", "coffee"];
const MIN_INTERVAL_MS = 1000;

function readArgs(argv) {
  const args = { samples: "20" };
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i]?.replace(/^--/, "")] = argv[i + 1];
  }
  const samples = Number(args.samples);
  if (!Number.isInteger(samples) || samples < 1 || samples > 100) {
    throw new Error("Usage: node scripts/swiggy-latency.js [--samples 1-100] [--address-id <id>]");
  }
  return { samples, addressId: args["address-id"] };
}

async function main() {
  const { samples, addressId: addressIdArg } = readArgs(process.argv.slice(2));
  const mcpUrl = process.env.SWIGGY_FOOD_MCP_URL;
  const token = process.env.SWIGGY_FOOD_TEST_TOKEN;
  if (!mcpUrl || !token) {
    throw new Error("SWIGGY_FOOD_MCP_URL and SWIGGY_FOOD_TEST_TOKEN (a real user's access token) are required.");
  }

  const client = createSwiggyFoodClient({ mcpUrl, token });
  const results = {};
  let lastCallAt = 0;
  let coldMs;

  async function timed(tool, call) {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastCallAt = Date.now();
    results[tool] ??= { durations: [], failures: 0 };

    const startedAt = performance.now();
    try {
      const result = await call();
      const ms = performance.now() - startedAt;
      if (coldMs === undefined) {
        coldMs = ms;
      } else {
        results[tool].durations.push(ms);
      }
      return result;
    } catch (error) {
      results[tool].failures += 1;
      if (error instanceof SwiggyRateLimitedError) {
        throw error;
      }
      console.warn(`${tool} failed: ${error?.name}`);
      return undefined;
    }
  }

  try {
    const addresses = parseStructuredPayload(await timed("get_addresses", () => client.getAddresses({})))?.addresses;
    const addressId = addressIdArg ?? addresses?.[0]?.id;
    if (!addressId) {
      throw new Error("No saved address on this account - add one in the Swiggy app, or pass --address-id.");
    }

    console.log(`Measuring ${samples} rounds of read calls (about ${samples * 5}s)...`);
    for (let round = 0; round < samples; round += 1) {
      await timed("get_addresses", () => client.getAddresses({}));

      const search = parseStructuredPayload(
        await timed("search_restaurants", () =>
          client.searchRestaurants({ query: QUERIES[round % QUERIES.length], addressId }),
        ),
      );
      const restaurant = search?.restaurants?.find((candidate) => candidate?.availabilityStatus === "OPEN");
      if (restaurant) {
        await timed("get_restaurant_menu", () => client.getRestaurantMenu({ addressId, restaurantId: restaurant.id }));
      }

      await timed("get_food_cart", () => client.getFoodCart({ addressId }));
      await timed("get_food_orders", () => client.getFoodOrders({ addressId }));
    }
  } catch (error) {
    if (!(error instanceof SwiggyRateLimitedError)) {
      throw error;
    }
    console.warn("Stopped early: Swiggy rate-limited this account. Results so far:");
  } finally {
    await client.close().catch(() => {});
  }

  console.log("");
  printLatencyTable(results, {
    note:
      `Cold call (connect + first request): ${coldMs === undefined ? "-" : `${Math.round(coldMs)}ms`}. ` +
      "Times include network to Swiggy, which Swiggy's targets exclude; OVER means above the target for that class.",
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
