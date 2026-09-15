const DEFAULT_PORT = 3000;
const DEFAULT_WHATSAPP_WEBHOOK_PATH = "/webhooks/whatsapp";
const DEFAULT_WHATSAPP_API_VERSION = "v21.0";
// Verified live against https://mcp.swiggy.com/.well-known/oauth-authorization-server
const DEFAULT_SWIGGY_OAUTH_BASE_URL = "https://mcp.swiggy.com/auth";
// Swiggy's Dynamic Client Registration (POST /auth/register) currently
// returns this same client_id regardless of the registering app's name or
// redirect_uris - confirmed by registering twice with different values.
// There is no real per-app client identity yet, so this is just the value
// their server hands back; it is not a secret.
const DEFAULT_SWIGGY_OAUTH_CLIENT_ID = "swiggy-mcp";
const DEFAULT_SWIGGY_OAUTH_REDIRECT_URI = "http://localhost:3000/oauth/swiggy/callback";
const DEFAULT_SWIGGY_TOKEN_STORE_PATH = "data/swiggy-tokens.json";

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

const whatsappAccessToken = readOptionalSecret(
  process.env.WHATSAPP_ACCESS_TOKEN,
  "WHATSAPP_ACCESS_TOKEN",
);
const whatsappApiVersion =
  readOptionalSecret(process.env.WHATSAPP_API_VERSION, "WHATSAPP_API_VERSION") ??
  DEFAULT_WHATSAPP_API_VERSION;

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

const swiggyOAuthClientId =
  readOptionalSecret(process.env.SWIGGY_OAUTH_CLIENT_ID, "SWIGGY_OAUTH_CLIENT_ID") ??
  DEFAULT_SWIGGY_OAUTH_CLIENT_ID;
const swiggyOAuthRedirectUri =
  readOptionalSecret(process.env.SWIGGY_OAUTH_REDIRECT_URI, "SWIGGY_OAUTH_REDIRECT_URI") ??
  DEFAULT_SWIGGY_OAUTH_REDIRECT_URI;
const swiggyOAuthBaseUrl =
  readOptionalSecret(process.env.SWIGGY_OAUTH_BASE_URL, "SWIGGY_OAUTH_BASE_URL") ??
  DEFAULT_SWIGGY_OAUTH_BASE_URL;
const swiggyTokenStorePath =
  readOptionalSecret(process.env.SWIGGY_TOKEN_STORE_PATH, "SWIGGY_TOKEN_STORE_PATH") ??
  DEFAULT_SWIGGY_TOKEN_STORE_PATH;

export const config = Object.freeze({
  environment: process.env.NODE_ENV ?? "development",
  port: readPort(process.env.PORT),
  whatsapp: Object.freeze({
    accessToken: whatsappAccessToken,
    apiVersion: whatsappApiVersion,
    appSecret: metaAppSecret,
    enabled: Boolean(whatsappVerifyToken && metaAppSecret),
    sendEnabled: Boolean(whatsappAccessToken),
    verifyToken: whatsappVerifyToken,
    webhookPath: readWebhookPath(process.env.WHATSAPP_WEBHOOK_PATH),
  }),
  swiggyFood: Object.freeze({
    enabled: Boolean(swiggyFoodMcpUrl && swiggyFoodTestToken),
    mcpUrl: swiggyFoodMcpUrl,
    testToken: swiggyFoodTestToken,
  }),
  swiggyOAuth: Object.freeze({
    authBaseUrl: swiggyOAuthBaseUrl,
    clientId: swiggyOAuthClientId,
    redirectUri: swiggyOAuthRedirectUri,
    tokenStorePath: swiggyTokenStorePath,
  }),
});
