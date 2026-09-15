const DEFAULT_PORT = 3000;
const DEFAULT_WHATSAPP_WEBHOOK_PATH = "/webhooks/whatsapp";

function readPort(value) {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return port;
}

function readOptionalSecret(value, name) {
  if (value === undefined || value === "") {
    return undefined;
  }

  if (value.trim().length === 0) {
    throw new Error(`${name} must not contain only whitespace.`);
  }

  return value;
}

function readWebhookPath(value) {
  if (value === undefined || value === "") {
    return DEFAULT_WHATSAPP_WEBHOOK_PATH;
  }

  if (!value.startsWith("/")) {
    throw new Error("WHATSAPP_WEBHOOK_PATH must start with '/'.");
  }

  return value;
}

const whatsappVerifyToken = readOptionalSecret(
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
);
const metaAppSecret = readOptionalSecret(process.env.META_APP_SECRET, "META_APP_SECRET");

if (Boolean(whatsappVerifyToken) !== Boolean(metaAppSecret)) {
  throw new Error(
    "WHATSAPP_WEBHOOK_VERIFY_TOKEN and META_APP_SECRET must be set together.",
  );
}

// SWIGGY_FOOD_TEST_TOKEN is a stand-in for per-user OAuth 2.1 + PKCE tokens
// (see https://mcp.swiggy.com/builders/docs/start/authenticate) until that
// flow is implemented. Do not use this path in production.
const swiggyFoodMcpUrl = readOptionalSecret(
  process.env.SWIGGY_FOOD_MCP_URL,
  "SWIGGY_FOOD_MCP_URL",
);
const swiggyFoodTestToken = readOptionalSecret(
  process.env.SWIGGY_FOOD_TEST_TOKEN,
  "SWIGGY_FOOD_TEST_TOKEN",
);

if (Boolean(swiggyFoodMcpUrl) !== Boolean(swiggyFoodTestToken)) {
  throw new Error("SWIGGY_FOOD_MCP_URL and SWIGGY_FOOD_TEST_TOKEN must be set together.");
}

export const config = Object.freeze({
  environment: process.env.NODE_ENV ?? "development",
  port: readPort(process.env.PORT),
  whatsapp: Object.freeze({
    appSecret: metaAppSecret,
    enabled: Boolean(whatsappVerifyToken && metaAppSecret),
    verifyToken: whatsappVerifyToken,
    webhookPath: readWebhookPath(process.env.WHATSAPP_WEBHOOK_PATH),
  }),
  swiggyFood: Object.freeze({
    enabled: Boolean(swiggyFoodMcpUrl && swiggyFoodTestToken),
    mcpUrl: swiggyFoodMcpUrl,
    testToken: swiggyFoodTestToken,
  }),
});
