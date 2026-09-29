import { parseServiceAccountKey, vertexModelName, vertexOpenAiBaseUrl } from "./vertex-auth.js";

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
const DEFAULT_SWIGGY_OAUTH_REDIRECT_URI = "https://whatsapp-test-webhook-low-latency.onrender.com/oauth/swiggy/callback";
const DEFAULT_SWIGGY_TOKEN_STORE_PATH = "data/swiggy-tokens.json";
// Sarvam is now used only to translate Hindi/Hinglish to English for the
// agent and the agent's English replies back (src/sarvam-translator.js).
const DEFAULT_NLU_BASE_URL = "https://api.sarvam.ai";
const DEFAULT_NLU_TIMEOUT_MS = 15_000;

// The agent (src/agent.js) runs on Gemini through the Gemini API's
// OpenAI-compatible Chat Completions endpoint
// (https://ai.google.dev/gemini-api/docs/openai).
const DEFAULT_AGENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_AGENT_MODEL = "gemini-3.5-flash-lite";
// With GOOGLE_SERVICE_ACCOUNT_JSON set, the agent uses Gemini on Vertex AI
// (Google Cloud) instead: authenticated with the service account, billed to
// its project, and processed in VERTEX_LOCATION. Gemini 3.5 Flash-Lite is
// served in "global" or the "us"/"eu" multi-regions.
const DEFAULT_VERTEX_LOCATION = "global";
// Per completions call, not per turn - later rounds of a multi-tool turn
// carry more context and run longer.
const DEFAULT_AGENT_TIMEOUT_MS = 35_000;
// Sent as reasoning_effort; "medium" is gemini-3.8-flash's own default.
// Higher effort means slower first replies, which matters on WhatsApp.
const DEFAULT_AGENT_REASONING_EFFORT = "medium";
const VALID_AGENT_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

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
// token (see src/swiggy-oauth.js), used by scripts/food-search-check.js and
// friends, AND by server.js's own SWIGGY_TEST_MODE bypass below - it's no
// longer true that the live conversation flow never reads this value.
const swiggyFoodTestToken = readOptionalSecret(
  process.env.SWIGGY_FOOD_TEST_TOKEN,
  "SWIGGY_FOOD_TEST_TOKEN",
);

// Deliberately strict (like readRolloutPercent above): a stray "0" or
// "false" throws at boot instead of silently doing nothing, so turning this
// off is unambiguous - delete the var. When on, server.js skips real
// per-sender Swiggy OAuth entirely and force-routes every Food MCP call to
// an in-process mock (see scripts/mock-swiggy-food-server.js) - real
// WhatsApp messages get real replies, but nothing ever reaches Swiggy.
// NEVER set this on a service carrying real user traffic.
function readTestModeFlag(value) {
  if (value === undefined || value === "") {
    return false;
  }

  if (value === "1" || value === "true") {
    return true;
  }

  throw new Error('SWIGGY_TEST_MODE must be "1", "true", or unset.');
}

const swiggyTestModeEnabled = readTestModeFlag(process.env.SWIGGY_TEST_MODE);

function readPositiveInteger(value, name, defaultValue) {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

const nluApiKey = readOptionalSecret(process.env.NLU_API_KEY, "NLU_API_KEY");
const nluBaseUrl = readOptionalSecret(process.env.NLU_BASE_URL, "NLU_BASE_URL") ?? DEFAULT_NLU_BASE_URL;
const nluTimeoutMs = readPositiveInteger(process.env.NLU_TIMEOUT_MS, "NLU_TIMEOUT_MS", DEFAULT_NLU_TIMEOUT_MS);
// "none" (default): Gemini reads and replies in the user's own language.
// "sarvam": Sarvam translates to English and back (needs NLU_API_KEY).
const agentTranslator = process.env.AGENT_TRANSLATOR || "none";

if (agentTranslator !== "none" && agentTranslator !== "sarvam") {
  throw new Error('AGENT_TRANSLATOR must be "none" or "sarvam".');
}

if (agentTranslator === "sarvam" && !nluApiKey) {
  throw new Error('AGENT_TRANSLATOR="sarvam" needs NLU_API_KEY.');
}

const agentApiKey = readOptionalSecret(process.env.AGENT_API_KEY, "AGENT_API_KEY");
const googleServiceAccountJson = readOptionalSecret(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  "GOOGLE_SERVICE_ACCOUNT_JSON",
);
const vertexServiceAccount = googleServiceAccountJson ? parseServiceAccountKey(googleServiceAccountJson) : undefined;
const vertexProjectId =
  readOptionalSecret(process.env.VERTEX_PROJECT_ID, "VERTEX_PROJECT_ID") ?? vertexServiceAccount?.project_id;
const vertexLocation = readOptionalSecret(process.env.VERTEX_LOCATION, "VERTEX_LOCATION") ?? DEFAULT_VERTEX_LOCATION;
const agentProvider = vertexServiceAccount ? "vertex" : "gemini-api";

const configuredAgentModel = readOptionalSecret(process.env.AGENT_MODEL, "AGENT_MODEL") ?? DEFAULT_AGENT_MODEL;
const agentModel = vertexServiceAccount ? vertexModelName(configuredAgentModel) : configuredAgentModel;
const agentBaseUrl =
  readOptionalSecret(process.env.AGENT_BASE_URL, "AGENT_BASE_URL") ??
  (vertexServiceAccount
    ? vertexOpenAiBaseUrl({ projectId: vertexProjectId, location: vertexLocation })
    : DEFAULT_AGENT_BASE_URL);
const agentTimeoutMs = readPositiveInteger(process.env.AGENT_TIMEOUT_MS, "AGENT_TIMEOUT_MS", DEFAULT_AGENT_TIMEOUT_MS);
const agentReasoningEffort = process.env.AGENT_REASONING_EFFORT || DEFAULT_AGENT_REASONING_EFFORT;

if (!VALID_AGENT_REASONING_EFFORTS.has(agentReasoningEffort)) {
  throw new Error('AGENT_REASONING_EFFORT must be "minimal", "low", "medium", or "high".');
}

// Optional: pushes Swiggy/Gemini/Sarvam/WhatsApp health to an Atlassian
// Statuspage page (src/status-reporter.js). Each component id is the one
// shown for that component in the Statuspage dashboard; any left unset is
// simply not reported.
const statuspageApiKey = readOptionalSecret(process.env.STATUSPAGE_API_KEY, "STATUSPAGE_API_KEY");
const statuspagePageId = readOptionalSecret(process.env.STATUSPAGE_PAGE_ID, "STATUSPAGE_PAGE_ID");

if (Boolean(statuspageApiKey) !== Boolean(statuspagePageId)) {
  throw new Error("STATUSPAGE_API_KEY and STATUSPAGE_PAGE_ID must be set together.");
}

const statuspageComponentIds = Object.freeze({
  swiggy: readOptionalSecret(process.env.STATUSPAGE_COMPONENT_SWIGGY, "STATUSPAGE_COMPONENT_SWIGGY"),
  agent: readOptionalSecret(process.env.STATUSPAGE_COMPONENT_AGENT, "STATUSPAGE_COMPONENT_AGENT"),
  translation: readOptionalSecret(process.env.STATUSPAGE_COMPONENT_TRANSLATION, "STATUSPAGE_COMPONENT_TRANSLATION"),
  whatsapp: readOptionalSecret(process.env.STATUSPAGE_COMPONENT_WHATSAPP, "STATUSPAGE_COMPONENT_WHATSAPP"),
});

// Senders whose WhatsApp number starts with this prefix are treated as
// load-test traffic (see scripts/simulate-load.js): replies are built but never
// sent. Unset means off. "999" is not a real country calling code, so no
// real WhatsApp user can match it.
function readLoadTestSenderPrefix(value) {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!/^\d{3,}$/.test(value)) {
    throw new Error("LOAD_TEST_SENDER_PREFIX must be at least 3 digits.");
  }
  return value;
}

const loadTestSenderPrefix = readLoadTestSenderPrefix(process.env.LOAD_TEST_SENDER_PREFIX);

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
// Shared by CHAT_LOG_ENCRYPTION_KEY below - same shape, different secret.
function read32ByteBase64Key(value, name) {
  if (!value) {
    throw new Error(
      `${name} must be set (32 random bytes, base64-encoded). ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  const key = Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new Error(`${name} must decode (from base64) to exactly 32 bytes.`);
  }

  return key;
}

const swiggyTokenEncryptionKey = read32ByteBase64Key(
  process.env.SWIGGY_TOKEN_ENCRYPTION_KEY,
  "SWIGGY_TOKEN_ENCRYPTION_KEY",
);

// Both optional, but must be set together (same pattern as the WhatsApp
// webhook verify token / app secret pair above): CHAT_LOG_REDIS_URL with no
// encryption key would mean writing chat transcripts to a remote store in
// plaintext, and a key with no URL does nothing. Unset entirely, chat
// logging is simply off - see src/conversation-log.js and its "see who said
// what when something goes wrong" use case in server.js. A separate key
// from SWIGGY_TOKEN_ENCRYPTION_KEY on purpose: these protect different data
// (OAuth bearer tokens vs. message content), so a compromise or rotation of
// one doesn't affect the other.
const chatLogRedisUrl = readOptionalSecret(process.env.CHAT_LOG_REDIS_URL, "CHAT_LOG_REDIS_URL");
const chatLogEncryptionKeyRaw = readOptionalSecret(process.env.CHAT_LOG_ENCRYPTION_KEY, "CHAT_LOG_ENCRYPTION_KEY");

if (Boolean(chatLogRedisUrl) !== Boolean(chatLogEncryptionKeyRaw)) {
  throw new Error("CHAT_LOG_REDIS_URL and CHAT_LOG_ENCRYPTION_KEY must be set together.");
}

const chatLogEncryptionKey = chatLogEncryptionKeyRaw
  ? read32ByteBase64Key(chatLogEncryptionKeyRaw, "CHAT_LOG_ENCRYPTION_KEY")
  : undefined;

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
    // Test mode enables the flow even with SWIGGY_FOOD_MCP_URL unset -
    // server.js force-routes to the in-process mock instead in that case.
    enabled: swiggyTestModeEnabled || Boolean(swiggyFoodMcpUrl),
    mcpUrl: swiggyFoodMcpUrl,
    testToken: swiggyFoodTestToken,
    testModeEnabled: swiggyTestModeEnabled,
  }),
  translation: Object.freeze({
    apiKey: nluApiKey,
    baseUrl: nluBaseUrl,
    enabled: agentTranslator === "sarvam",
    timeoutMs: nluTimeoutMs,
  }),
  loadTest: Object.freeze({
    senderPrefix: loadTestSenderPrefix,
  }),
  statuspage: Object.freeze({
    enabled: Boolean(statuspageApiKey),
    apiKey: statuspageApiKey,
    pageId: statuspagePageId,
    componentIds: statuspageComponentIds,
  }),
  agent: Object.freeze({
    provider: agentProvider,
    apiKey: agentApiKey,
    serviceAccount: vertexServiceAccount,
    baseUrl: agentBaseUrl,
    enabled: Boolean(vertexServiceAccount || agentApiKey),
    model: agentModel,
    timeoutMs: agentTimeoutMs,
    reasoningEffort: agentReasoningEffort,
  }),
  swiggyOAuth: Object.freeze({
    authBaseUrl: swiggyOAuthBaseUrl,
    clientId: swiggyOAuthClientId,
    redirectUri: swiggyOAuthRedirectUri,
    tokenStorePath: swiggyTokenStorePath,
    tokenEncryptionKey: swiggyTokenEncryptionKey,
  }),
  chatLog: Object.freeze({
    enabled: Boolean(chatLogRedisUrl),
    redisUrl: chatLogRedisUrl,
    encryptionKey: chatLogEncryptionKey,
  }),
});
