import http from "node:http";
import { config } from "./config.js";
import { classifyIncomingMessage, getFoodSearchReply } from "./food-search-orchestrator.js";
import { getFoodOrderReply, parseOrderConfirmationReply, placeConfirmedOrder } from "./food-order-orchestrator.js";
import { InProcessMessageIdempotency } from "./message-idempotency.js";
import { PendingAddressSelections } from "./pending-address-selection.js";
import { PendingCartSessions } from "./pending-cart-sessions.js";
import { PendingConnectLinks } from "./pending-connect-links.js";
import { PendingOAuthExchanges } from "./pending-oauth-exchanges.js";
import { PendingOrderConfirmations } from "./pending-order-confirmations.js";
import { PendingPostAuthActions } from "./pending-post-auth-actions.js";
import { PRIVACY_POLICY_HTML } from "./privacy-policy.js";
import { isSenderInRollout } from "./rollout.js";
import { createSwiggyFoodClient } from "./swiggy-food-client.js";
import { buildConnectReplyText, resolveSwiggyAccessToken } from "./swiggy-auth-flow.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generatePkcePair,
  generateState,
  SwiggyOAuthError,
} from "./swiggy-oauth.js";
import { SwiggyAuthFailureError } from "./swiggy-retry.js";
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
const swiggyOAuthOrigin = new URL(config.swiggyOAuth.redirectUri).origin;
const processedMessageIds = new InProcessMessageIdempotency();
const pendingAddressSelections = new PendingAddressSelections();
const pendingOAuthExchanges = new PendingOAuthExchanges();
const pendingConnectLinks = new PendingConnectLinks();
const pendingPostAuthActions = new PendingPostAuthActions();
const pendingCartSessions = new PendingCartSessions();
const pendingOrderConfirmations = new PendingOrderConfirmations();
const swiggyTokenStore = new SwiggyTokenStore(
  config.swiggyOAuth.tokenStorePath,
  config.swiggyOAuth.tokenEncryptionKey,
);

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

function sendHtml(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
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

// Shared by the two newer code paths (order confirmation, cart/coupon
// intents) that just need a plain authenticated-or-not result, unlike the
// main search path below which has its own connect-link handling on
// "unauthenticated". Always closes the per-request MCP connection.
async function withSwiggyFoodClient(senderId, fn) {
  const authResult = await resolveSwiggyAccessToken({
    senderId,
    tokenStore: swiggyTokenStore,
    authBaseUrl: config.swiggyOAuth.authBaseUrl,
  });

  if (authResult.status === "unauthenticated") {
    return { authenticated: false };
  }

  const swiggyFoodClient = createSwiggyFoodClient({
    mcpUrl: config.swiggyFood.mcpUrl,
    token: authResult.accessToken,
  });

  try {
    return { authenticated: true, result: await fn(swiggyFoodClient) };
  } catch (error) {
    if (error instanceof SwiggyAuthFailureError) {
      // Swiggy rejected the token mid-conversation even though our locally
      // tracked expiry said it was still good - drop it so the next message
      // goes through the normal reconnect flow instead of failing silently.
      swiggyTokenStore.delete(senderId);
      return { authenticated: false };
    }
    throw error;
  } finally {
    swiggyFoodClient.close().catch((error) => {
      console.error("Failed to close per-request Swiggy Food MCP connection.", { name: error.name });
    });
  }
}

// Deterministic gate for the one irreversible action (placing a real order):
// only a literal YES/NO reply to a specific stored order summary can trigger
// it - never an NLU/LLM judgment call. See food-order-orchestrator.js.
async function buildOrderConfirmationReply(message, pendingConfirmation) {
  const decision = parseOrderConfirmationReply(message.text);

  if (decision === "cancel") {
    pendingOrderConfirmations.clear(message.from);
    return "Order cancelled. Your cart is still there if you'd like to check out again later.";
  }

  if (decision !== "confirm") {
    return "Please reply YES to place this order, or NO to cancel.";
  }

  const outcome = await withSwiggyFoodClient(message.from, (swiggyFoodClient) =>
    placeConfirmedOrder({ swiggyFoodClient, confirmation: pendingConfirmation }),
  );

  if (!outcome.authenticated) {
    pendingOrderConfirmations.clear(message.from);
    return "Your Swiggy connection expired before we could place this order. Please search again to reconnect.";
  }

  const { status, replyText, orderId, lat, lng } = outcome.result;

  if (status === "placed_not_confirmed") {
    // Keep the confirmation around with the orderId so a retried YES skips
    // straight to confirm_order instead of placing a duplicate order.
    pendingOrderConfirmations.set(message.from, { ...pendingConfirmation, orderId, lat, lng });
  } else {
    pendingOrderConfirmations.clear(message.from);
  }

  return replyText;
}

async function buildReplyText(message) {
  if (!config.swiggyFood.enabled) {
    return PLACEHOLDER_REPLY_TEXT;
  }

  if (!isSenderInRollout(message.from, config.rollout.percent)) {
    return PLACEHOLDER_REPLY_TEXT;
  }

  const pendingConfirmation = pendingOrderConfirmations.peek(message.from);

  if (pendingConfirmation) {
    return buildOrderConfirmationReply(message, pendingConfirmation);
  }

  // An active cart gets first crack at the message via classifyOrderIntent,
  // ahead of the search classifier. Previously the search classifier ran
  // first and had to be trusted to defer on cart-related messages via its
  // "cart-aware" prompt - confirmed live, a message like "add chicken wings
  // from KFC" (naming a restaurant, which the cart-aware prompt treats as a
  // possible "different restaurant" search) still got misread as a brand
  // new search, re-prompting for an address and showing a restaurant list
  // instead of adding to the cart. Trying the order classifier first removes
  // that race: only if it finds no order intent do we fall through to
  // search, so a genuinely new search still works while a cart is active.
  const hasPendingAddressSelection = Boolean(pendingAddressSelections.peek(message.from));
  const activeCartSession = pendingCartSessions.peek(message.from);

  if (activeCartSession && !hasPendingAddressSelection) {
    const outcome = await withSwiggyFoodClient(message.from, (swiggyFoodClient) =>
      getFoodOrderReply({
        message,
        swiggyFoodClient,
        pendingCartSessions,
        pendingOrderConfirmations,
        nvidiaNim: config.nvidiaNim,
      }),
    );

    if (!outcome.authenticated) {
      return PLACEHOLDER_REPLY_TEXT;
    }

    if (outcome.result !== undefined) {
      return outcome.result;
    }
  }

  const classification = await classifyIncomingMessage(message, pendingAddressSelections, {
    nvidiaNim: config.nvidiaNim,
    pendingCartSessions,
  });

  if (classification.type === "no_trigger") {
    return PLACEHOLDER_REPLY_TEXT;
  }

  // Doesn't need a Swiggy call at all - just re-prompts the existing
  // address choice, so it never needs to be gated on auth.
  if (classification.type === "unrecognized_pending_reply") {
    const reply = await getFoodSearchReply({
      message,
      swiggyFoodClient: undefined,
      pendingAddressSelections,
      pendingCartSessions,
      classification,
    });
    return reply ?? PLACEHOLDER_REPLY_TEXT;
  }

  const searchTerm = classification.searchTerm ?? classification.pending?.searchTerm;

  const authResult = await resolveSwiggyAccessToken({
    senderId: message.from,
    tokenStore: swiggyTokenStore,
    authBaseUrl: config.swiggyOAuth.authBaseUrl,
  });

  if (authResult.status === "unauthenticated") {
    pendingPostAuthActions.set(message.from, { searchTerm, phoneNumberId: message.phoneNumberId });
    const connectToken = pendingConnectLinks.create(message.from);
    const connectUrl = `${swiggyOAuthOrigin}/oauth/swiggy/start?token=${connectToken}`;
    return buildConnectReplyText({ connectUrl, searchTerm });
  }

  const swiggyFoodClient = createSwiggyFoodClient({
    mcpUrl: config.swiggyFood.mcpUrl,
    token: authResult.accessToken,
  });

  try {
    const reply = await getFoodSearchReply({
      message,
      swiggyFoodClient,
      pendingAddressSelections,
      pendingCartSessions,
      classification,
    });
    return reply ?? PLACEHOLDER_REPLY_TEXT;
  } finally {
    swiggyFoodClient.close().catch((error) => {
      console.error("Failed to close per-request Swiggy Food MCP connection.", { name: error.name });
    });
  }
}

// After a sender finishes connecting their Swiggy account, automatically
// resume whatever search prompted the connection instead of making them
// repeat themselves.
async function resumePendingSearchAfterAuth(senderId) {
  const pendingAction = pendingPostAuthActions.take(senderId);

  if (!pendingAction?.searchTerm || !config.whatsapp.sendEnabled) {
    return;
  }

  const syntheticMessage = {
    from: senderId,
    id: `post-auth-resume-${Date.now()}`,
    phoneNumberId: pendingAction.phoneNumberId,
    text: `find ${pendingAction.searchTerm}`,
  };

  try {
    await sendTextMessage({
      accessToken: config.whatsapp.accessToken,
      apiVersion: config.whatsapp.apiVersion,
      phoneNumberId: pendingAction.phoneNumberId,
      to: senderId,
      text: await buildReplyText(syntheticMessage),
    });
  } catch (error) {
    console.error("Failed to resume search after Swiggy auth.", { name: error.name });
  }
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

// GET /oauth/swiggy/start?token=<connect-token> kicks off the PKCE authorize
// redirect for whichever sender that unguessable, single-use token was
// issued to (see pending-connect-links.js for why this isn't a raw
// ?sender= param).
function handleSwiggyOAuthStart(request, response, url) {
  const connectToken = url.searchParams.get("token");
  const pendingLink = connectToken ? pendingConnectLinks.take(connectToken) : undefined;

  if (!pendingLink) {
    sendText(response, 400, "This connection link is invalid or has expired. Please ask Nosh for a new one.");
    return;
  }

  const { verifier, challenge } = generatePkcePair();
  const state = generateState();
  pendingOAuthExchanges.set(state, { senderId: pendingLink.senderId, codeVerifier: verifier });

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
    await resumePendingSearchAfterAuth(pending.senderId);
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

  console.info("Received WhatsApp webhook POST.");

  try {
    const rawBody = await readRawBody(request);
    const signature = request.headers["x-hub-signature-256"];

    if (
      typeof signature !== "string" ||
      !verifyWebhookSignature(rawBody, signature, config.whatsapp.appSecret)
    ) {
      console.warn("Rejected WhatsApp webhook POST: invalid signature.", {
        hasSignatureHeader: typeof signature === "string",
      });
      sendJson(response, 401, { error: "invalid_webhook_signature" });
      return;
    }

    const payload = parseWhatsAppWebhookPayload(rawBody);

    if (payload === undefined) {
      console.warn("Rejected WhatsApp webhook POST: unparseable payload.");
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

  if (request.method === "GET" && url.pathname === "/privacy-policy") {
    sendHtml(response, 200, PRIVACY_POLICY_HTML);
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
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
