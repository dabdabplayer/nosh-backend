import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SwiggyAuthFailureError, SwiggyRateLimitedError, withSwiggyRetry } from "./swiggy-retry.js";

const CLIENT_NAME = "nosh-backend";
const CLIENT_VERSION = "0.1.0";

// Not yet emitted by Swiggy MCP as of v1.0 - the field only starts appearing
// once v1.1 ships (see https://mcp.swiggy.com/builders/docs/operate/versioning.md).
// This is pre-wired now, as their own docs recommend, so nothing else needs
// to change when it does: { tool, replaced_by, remove_after }.
function warnIfDeprecated(toolName, result) {
  const deprecation = result?._meta?.swiggy?.deprecation;

  if (deprecation) {
    console.warn("Swiggy tool deprecation notice.", { toolName, ...deprecation });
  }
}

export class SwiggyFoodToolError extends Error {
  constructor(toolName, cause) {
    super(`Swiggy Food tool "${toolName}" failed.`);
    this.name = "SwiggyFoodToolError";
    this.toolName = toolName;
    this.cause = cause;
  }
}

// Concatenates the text content blocks from an MCP tool result and passes
// through structuredContent when the tool provides it. Everything else in
// the raw MCP response (isError aside) is left alone rather than reshaped
// into fields Swiggy hasn't documented.
export function parseToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");

  return Object.freeze({
    text,
    structured: result?.structuredContent ?? null,
  });
}

// The MCP SDK may surface a tool's JSON payload as structuredContent or as a
// text block containing a JSON string, depending on the server. Try
// structured first, fall back to parsing text, and never throw — callers
// treat undefined as "unparseable" and fall back to a generic reply.
export function parseStructuredPayload(toolResult) {
  if (toolResult?.structured && typeof toolResult.structured === "object") {
    return toolResult.structured;
  }

  if (typeof toolResult?.text === "string" && toolResult.text.length > 0) {
    try {
      return JSON.parse(toolResult.text);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

// Wraps the official MCP SDK client so callers only depend on this
// project's interface. `createClient`/`createTransport` are injectable for
// testing without a real network connection.
export function createSwiggyFoodClient({
  mcpUrl,
  token,
  createClient = () => new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }),
  createTransport = () =>
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
}) {
  let connecting;

  async function ensureConnected() {
    if (!connecting) {
      connecting = (async () => {
        const client = createClient();
        await client.connect(createTransport());
        return client;
      })();
    }

    return connecting;
  }

  async function callTool(name, args) {
    const startedAt = Date.now();

    let result;
    try {
      result = await withSwiggyRetry(async () => {
        const client = await ensureConnected();
        return client.callTool({ name, arguments: args });
      });
    } catch (error) {
      console.error("Swiggy Food tool call failed.", {
        toolName: name,
        durationMs: Date.now() - startedAt,
        errorName: error?.name,
      });
      throw error instanceof SwiggyAuthFailureError || error instanceof SwiggyRateLimitedError
        ? error
        : new SwiggyFoodToolError(name, error);
    }

    if (result?.isError) {
      console.error("Swiggy Food tool call returned an error result.", {
        toolName: name,
        durationMs: Date.now() - startedAt,
      });
      throw new SwiggyFoodToolError(name, result);
    }

    console.info("Swiggy Food tool call succeeded.", {
      toolName: name,
      durationMs: Date.now() - startedAt,
    });
    warnIfDeprecated(name, result);

    return parseToolResult(result);
  }

  return Object.freeze({
    searchRestaurants: (params) => callTool("search_restaurants", params),
    searchMenu: (params) => callTool("search_menu", params),
    getRestaurantMenu: (params) => callTool("get_restaurant_menu", params),
    getAddresses: (params) => callTool("get_addresses", params),
    updateFoodCart: (params) => callTool("update_food_cart", params),
    getFoodCart: (params) => callTool("get_food_cart", params),
    flushFoodCart: (params) => callTool("flush_food_cart", params),
    fetchFoodCoupons: (params) => callTool("fetch_food_coupons", params),
    applyFoodCoupon: (params) => callTool("apply_food_coupon", params),
    getPaymentOptions: (params) => callTool("get_payment_options", params),
    placeFoodOrder: (params) => callTool("place_food_order", params),
    confirmOrder: (params) => callTool("confirm_order", params),
    async close() {
      if (connecting) {
        const client = await connecting;
        connecting = undefined;
        await client.close();
      }
    },
  });
}
