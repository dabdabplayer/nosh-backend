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
const DEFAULT_NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_NVIDIA_NIM_MODEL = "openai/gpt-oss-20b";
// NVIDIA NIM's hosted inference has real, sometimes multi-second latency -
// confirmed live (an 8s timeout was aborting almost every classification
// call in production). 25s gives it real room without hanging a reply
// indefinitely if NIM is actually down.
const DEFAULT_NVIDIA_NIM_TIMEOUT_MS = 25_000;

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

function readRolloutPercent(value) {
  if (value === undefined || value === "") {
    return 100;
  }

  const percent = Number(value);

  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error("ROLLOUT_PERCENT must be an integer between 0 and 100.");
  }

  return percent;
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

const swiggyFoodMcpUrl = readOptionalSecret(
  process.env.SWIGGY_FOOD_MCP_URL,
  "SWIGGY_FOOD_MCP_URL",
);
// SWIGGY_FOOD_TEST_TOKEN is a dev-only stand-in for a real per-user OAuth
// token (see src/swiggy-oauth.js), used only by scripts/food-search-check.js.
// The live conversation flow in server.js resolves a per-sender token via
// swiggy-auth-flow.js instead and never reads this value.
const swiggyFoodTestToken = readOptionalSecret(
  process.env.SWIGGY_FOOD_TEST_TOKEN,
  "SWIGGY_FOOD_TEST_TOKEN",
);

const nvidiaNimApiKey = readOptionalSecret(process.env.NVIDIA_API_KEY, "NVIDIA_API_KEY");
const nvidiaNimBaseUrl =
  readOptionalSecret(process.env.NVIDIA_NIM_BASE_URL, "NVIDIA_NIM_BASE_URL") ??
  DEFAULT_NVIDIA_NIM_BASE_URL;
const nvidiaNimModel =
  readOptionalSecret(process.env.NVIDIA_NIM_MODEL, "NVIDIA_NIM_MODEL") ?? DEFAULT_NVIDIA_NIM_MODEL;

function readNvidiaNimTimeoutMs(value) {
  if (value === undefined || value === "") {
    return DEFAULT_NVIDIA_NIM_TIMEOUT_MS;
  }

  const timeoutMs = Number(value);

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("NVIDIA_NIM_TIMEOUT_MS must be a positive integer.");
  }

  return timeoutMs;
}

const nvidiaNimTimeoutMs = readNvidiaNimTimeoutMs(process.env.NVIDIA_NIM_TIMEOUT_MS);

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

// Required, not optional: SwiggyTokenStore encrypts every record it writes
// (see src/swiggy-token-store.js) - found live during a pre-migration
// security review that the token VALUES, not just the lookup key, were
// sitting on disk in plain JSON. A 32-byte key, base64-encoded. Generate one
// with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
function readSwiggyTokenEncryptionKey(value) {
  if (!value) {
    throw new Error(
      "SWIGGY_TOKEN_ENCRYPTION_KEY must be set (32 random bytes, base64-encoded). " +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  const key = Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new Error("SWIGGY_TOKEN_ENCRYPTION_KEY must decode (from base64) to exactly 32 bytes.");
  }

  return key;
}

const swiggyTokenEncryptionKey = readSwiggyTokenEncryptionKey(process.env.SWIGGY_TOKEN_ENCRYPTION_KEY);

export const config = Object.freeze({
  environment: process.env.NODE_ENV ?? "development",
  port: readPort(process.env.PORT),
  // Percentage-based go-live ramp (1% -> 10% -> 50% -> 100%): a sender
  // outside the rollout gets the same placeholder reply as when Swiggy Food
  // isn't configured at all. Defaults to 100 (everyone) so existing
  // deployments are unaffected unless ROLLOUT_PERCENT is explicitly set.
  rollout: Object.freeze({
    percent: readRolloutPercent(process.env.ROLLOUT_PERCENT),
  }),
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
    enabled: Boolean(swiggyFoodMcpUrl),
    mcpUrl: swiggyFoodMcpUrl,
    testToken: swiggyFoodTestToken,
  }),
  nvidiaNim: Object.freeze({
    apiKey: nvidiaNimApiKey,
    baseUrl: nvidiaNimBaseUrl,
    enabled: Boolean(nvidiaNimApiKey),
    model: nvidiaNimModel,
    timeoutMs: nvidiaNimTimeoutMs,
  }),
  swiggyOAuth: Object.freeze({
    authBaseUrl: swiggyOAuthBaseUrl,
    clientId: swiggyOAuthClientId,
    redirectUri: swiggyOAuthRedirectUri,
    tokenStorePath: swiggyTokenStorePath,
    tokenEncryptionKey: swiggyTokenEncryptionKey,
  }),
});
