import http from "node:http";
import { config } from "./config.js";
import { getFoodSearchReply } from "./food-search-orchestrator.js";
import { InProcessMessageIdempotency } from "./message-idempotency.js";
import { PendingAddressSelections } from "./pending-address-selection.js";
import { PendingOAuthExchanges } from "./pending-oauth-exchanges.js";
import { createSwiggyFoodClient } from "./swiggy-food-client.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generatePkcePair,
  generateState,
  SwiggyOAuthError,
} from "./swiggy-oauth.js";
import { SwiggyTokenStore } from "./swiggy-token-store.js";
import { sendTextMessage } from "./whatsapp-client.js";
import {
  extractInboundTextMessages,
  parseWhatsAppWebhookPayload,
  readRawBody,
  verifyWebhookSignature,
  verifyWebhookSubscription,
} from "./whatsapp-webhook.js";

const serviceName = "nosh-backend";
const processedMessageIds = new InProcessMessageIdempotency();
const pendingAddressSelections = new PendingAddressSelections();
const pendingOAuthExchanges = new PendingOAuthExchanges();
const swiggyTokenStore = new SwiggyTokenStore(config.swiggyOAuth.tokenStorePath);
const swiggyFoodClient = config.swiggyFood.enabled
  ? createSwiggyFoodClient({ mcpUrl: config.swiggyFood.mcpUrl, token: config.swiggyFood.testToken })
  : undefined;

// Fallback reply for messages that don't trigger a Swiggy Food search (no
// NLU/intent layer yet) and for when Swiggy Food isn't configured at all.
const PLACEHOLDER_REPLY_TEXT =
  "Thanks for messaging Nosh! We're still setting things up — full replies are coming soon.";

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function acknowledgeIncomingTextMessages(messages) {
  if (messages.length === 0) {
    return;
  }

  // Keep operational logs free of WhatsApp message content and identifiers.
  console.info("Received supported inbound WhatsApp text message(s).", {
    count: messages.length,
  });
}

async function buildReplyText(message) {
  if (!swiggyFoodClient) {
    return PLACEHOLDER_REPLY_TEXT;
  }

  const foodSearchReply = await getFoodSearchReply({
    message,
    swiggyFoodClient,
    pendingAddressSelections,
  });

  return foodSearchReply ?? PLACEHOLDER_REPLY_TEXT;
}

async function replyToIncomingTextMessages(messages) {
  if (!config.whatsapp.sendEnabled || messages.length === 0) {
    return;
  }

  await Promise.allSettled(
    messages.map(async (message) => {
      try {
        await sendTextMessage({
          accessToken: config.whatsapp.accessToken,
          apiVersion: config.whatsapp.apiVersion,
          phoneNumberId: message.phoneNumberId,
          to: message.from,
          text: await buildReplyText(message),
        });
      } catch (error) {
        console.error("Failed to send WhatsApp reply.", { name: error.name });
      }
    }),
  );
}

// Manual/dev entry point until this is wired into the WhatsApp conversation
// flow: GET /oauth/swiggy/start?sender=<whatsapp-sender-id> kicks off the
// PKCE authorize redirect for that sender.
function handleSwiggyOAuthStart(request, response, url) {
  const senderId = url.searchParams.get("sender");

  if (!senderId) {
    sendJson(response, 400, { error: "missing_sender", message: "Query param 'sender' is required." });
    return;
  }

  const { verifier, challenge } = generatePkcePair();
  const state = generateState();
  pendingOAuthExchanges.set(state, { senderId, codeVerifier: verifier });

  const authorizeUrl = buildAuthorizeUrl({
    authBaseUrl: config.swiggyOAuth.authBaseUrl,
    clientId: config.swiggyOAuth.clientId,
    redirectUri: config.swiggyOAuth.redirectUri,
    codeChallenge: challenge,
    state,
  });

  response.writeHead(302, { location: authorizeUrl });
  response.end();
}

async function handleSwiggyOAuthCallback(request, response, url) {
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const pending = state ? pendingOAuthExchanges.take(state) : undefined;

  if (!pending) {
    sendText(response, 400, "This Swiggy connection link is invalid or has expired. Please try again.");
    return;
  }

  if (oauthError) {
    sendText(response, 200, "Swiggy connection cancelled. You can try again anytime.");
    return;
  }

  const code = url.searchParams.get("code");

  if (!code) {
    sendText(response, 400, "This Swiggy connection link is invalid or has expired. Please try again.");
    return;
  }

  try {
    const tokenRecord = await exchangeCodeForToken({
      authBaseUrl: config.swiggyOAuth.authBaseUrl,
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: config.swiggyOAuth.redirectUri,
    });

    swiggyTokenStore.set(pending.senderId, tokenRecord);
    sendText(response, 200, "Your Swiggy account is connected. You can return to WhatsApp now.");
  } catch (error) {
    if (error instanceof SwiggyOAuthError) {
      console.error("Swiggy OAuth token exchange failed.", { step: error.step, error: error.error });
    } else {
      console.error("Swiggy OAuth callback failed unexpectedly.", { name: error.name });
    }

    sendText(response, 502, "Couldn't connect your Swiggy account right now. Please try again.");
  }
}

async function handleWhatsAppWebhook(request, response, url) {
  if (!config.whatsapp.enabled) {
    sendJson(response, 503, {
      error: "whatsapp_webhook_not_configured",
      message: "WhatsApp webhook credentials have not been configured.",
    });
    return;
  }

  if (request.method === "GET") {
    const challenge = verifyWebhookSubscription(url, config.whatsapp.verifyToken);

    if (challenge === undefined) {
      sendJson(response, 403, { error: "webhook_verification_failed" });
      return;
    }

    sendText(response, 200, challenge);
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  try {
    const rawBody = await readRawBody(request);
    const signature = request.headers["x-hub-signature-256"];

    if (
      typeof signature !== "string" ||
      !verifyWebhookSignature(rawBody, signature, config.whatsapp.appSecret)
    ) {
      sendJson(response, 401, { error: "invalid_webhook_signature" });
      return;
    }

    const payload = parseWhatsAppWebhookPayload(rawBody);

    if (payload === undefined) {
      sendJson(response, 400, { error: "invalid_whatsapp_webhook_payload" });
      return;
    }

    const messages = extractInboundTextMessages(payload);
    const unprocessedMessages = processedMessageIds.takeUnprocessed(messages);
    acknowledgeIncomingTextMessages(unprocessedMessages);

    // Persistence beyond in-memory dedup/pending-address state arrives later.
    sendJson(response, 200, { status: "received" });
    await replyToIncomingTextMessages(unprocessedMessages);
  } catch (error) {
    if (error.code === "BODY_TOO_LARGE") {
      sendJson(response, 413, { error: "payload_too_large" });
      return;
    }

    console.error("WhatsApp webhook processing failed.", { name: error.name });
    sendJson(response, 500, { error: "webhook_processing_failed" });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === config.whatsapp.webhookPath) {
    await handleWhatsAppWebhook(request, response, url);
    return;
  }

  if (request.method === "GET" && url.pathname === "/oauth/swiggy/start") {
    handleSwiggyOAuthStart(request, response, url);
    return;
  }

  if (request.method === "GET" && url.pathname === "/oauth/swiggy/callback") {
    await handleSwiggyOAuthCallback(request, response, url);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: serviceName,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    sendJson(response, 200, {
      service: serviceName,
      message: "Nosh backend is running.",
    });
    return;
  }

  sendJson(response, 404, {
    error: "not_found",
    message: "Route not found.",
  });
});

server.listen(config.port, () => {
  console.log(`${serviceName} listening on port ${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  server.close((error) => {
    if (error) {
      console.error("Server shutdown failed.", error);
      process.exitCode = 1;
    }
  });

  swiggyFoodClient?.close().catch((error) => {
    console.error("Failed to close Swiggy Food MCP connection.", { name: error.name });
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
