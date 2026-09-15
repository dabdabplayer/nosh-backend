import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CLIENT_NAME = "nosh-backend";
const CLIENT_VERSION = "0.1.0";

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
    const client = await ensureConnected();

    let result;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch (error) {
      throw new SwiggyFoodToolError(name, error);
    }

    if (result?.isError) {
      throw new SwiggyFoodToolError(name, result);
    }

    return parseToolResult(result);
  }

  return Object.freeze({
    searchRestaurants: (params) => callTool("search_restaurants", params),
    searchMenu: (params) => callTool("search_menu", params),
    getRestaurantMenu: (params) => callTool("get_restaurant_menu", params),
    async close() {
      if (connecting) {
        const client = await connecting;
        connecting = undefined;
        await client.close();
      }
    },
  });
}
