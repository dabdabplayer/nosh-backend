import http from "node:http";
import { config } from "./config.js";
import { ConversationLog } from "./conversation-log.js";
import { resolvePendingAddressReply } from "./food-search-orchestrator.js";
import {
  parseOrderConfirmationReply,
  placeConfirmedOrder,
  resolvePendingCartCandidateReply,
} from "./food-order-orchestrator.js";
import { pick, PendingLanguagePreference } from "./language-preference.js";
import { InProcessMessageIdempotency } from "./message-idempotency.js";
import { PendingAddressSelections } from "./pending-address-selection.js";
import { PendingCartSessions } from "./pending-cart-sessions.js";
import { PendingConnectLinks } from "./pending-connect-links.js";
import { PendingConversationHistory } from "./pending-conversation-history.js";
import { PendingOAuthExchanges } from "./pending-oauth-exchanges.js";
import { PendingOrderConfirmations } from "./pending-order-confirmations.js";
import { PendingPostAuthActions } from "./pending-post-auth-actions.js";
import { PRIVACY_POLICY_HTML } from "./privacy-policy.js";
import { isSenderInRollout } from "./rollout.js";
import { runAgentTurn } from "./sarvam-agent.js";
import { createSwiggyFoodClient } from "./swiggy-food-client.js";
// Not a typo: this dev/test-only mock lives under scripts/, not src/ - see
// SWIGGY_TEST_MODE in config.js. Importing it never starts its own listener
// (see the "run as main module" guard at its bottom); it's only ever
// invoked here, mounted as a route on this file's own server.
import { handleMockSwiggyFoodRequest, MOCK_FOOD_PATH } from "../scripts/mock-swiggy-food-server.js";
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
const pendingConversationHistory = new PendingConversationHistory();
const pendingLanguagePreference = new PendingLanguagePreference();
const swiggyTokenStore = new SwiggyTokenStore(
  config.swiggyOAuth.tokenStorePath,
  config.swiggyOAuth.tokenEncryptionKey,
);
// Undefined (not just disabled) when CHAT_LOG_REDIS_URL isn't set - every
// call site below already guards on config.chatLog.enabled first, so this
// is never touched unless it's a real, constructed instance.
const conversationLog = config.chatLog.enabled
  ? new ConversationLog({ url: config.chatLog.redisUrl, encryptionKey: config.chatLog.encryptionKey })
  : undefined;

if (config.swiggyFood.testModeEnabled) {
  console.warn(
    "SWIGGY_TEST_MODE is ON - real Swiggy OAuth and Food MCP calls are bypassed. " +
      "Every sender is treated as connected, and all Food calls go to an in-process mock. " +
      "Never leave this on for real traffic.",
  );
}

// Loopback, not the public hostname: this request goes right back into the
// same process (see the MOCK_FOOD_PATH route below), so there's no reason
// to round-trip it through TLS/the load balancer.
const effectiveSwiggyFoodMcpUrl = config.swiggyFood.testModeEnabled
  ? `http://127.0.0.1:${config.port}${MOCK_FOOD_PATH}`
  : config.swiggyFood.mcpUrl;

// Single choke point for resolving a usable Swiggy Food auth result -
// SWIGGY_TEST_MODE short-circuits here so both call sites below (inside
// withSwiggyFoodClient and buildReplyText's search/reorder path) honor the
// bypass identically. Never returns "unauthenticated" while test mode is
// on, since there's no real per-sender connection to be missing.
//
// The bypass token is deliberately suffixed with senderId, not one shared
// constant - the in-process mock (scripts/mock-swiggy-food-server.js) has
// no other way to tell two different WhatsApp senders apart (there's no
// real per-user OAuth token in test mode), and it uses this exact
// Authorization header value to key its per-sender cart storage. A single
// shared token here means every sender's cart collides with every other's
// - confirmed as the cause of a live report ("doesn't update the cart")
// once more than one conversation was live against this deployed test
// service at the same time. See mock-swiggy-food-server.js's own
// cartsByKey/cartKeyStorage comment for the other half of this.
async function resolveSwiggyFoodAuth(senderId) {
  if (config.swiggyFood.testModeEnabled) {
    return { status: "ok", accessToken: `${config.swiggyFood.testToken ?? "test-mode-bypass-token"}:${senderId}` };
  }

  return resolveSwiggyAccessToken({
    senderId,
    tokenStore: swiggyTokenStore,
    authBaseUrl: config.swiggyOAuth.authBaseUrl,
  });
}

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
  const authResult = await resolveSwiggyFoodAuth(senderId);

  if (authResult.status === "unauthenticated") {
    return { authenticated: false };
  }

  const swiggyFoodClient = createSwiggyFoodClient({
    mcpUrl: effectiveSwiggyFoodMcpUrl,
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
async function buildOrderConfirmationReply(message, pendingConfirmation, lang = "en") {
  const decision = parseOrderConfirmationReply(message.text);

  if (decision === "cancel") {
    pendingOrderConfirmations.clear(message.from);
    return pick(lang, {
      en: "Order cancelled. Your cart is still there if you'd like to check out again later.",
      hi: "ऑर्डर रद्द कर दिया गया। अगर आप बाद में फिर से चेकआउट करना चाहें तो आपकी कार्ट अभी भी वहीं है।",
      hinglish: "Order cancel kar diya gaya. Agar baad mein phir se checkout karna ho to aapki cart abhi bhi wahi hai.",
    });
  }

  if (decision !== "confirm") {
    // MUST keep the literal uppercase "YES"/"NO" tokens - parseOrderConfirmationReply's
    // regex and this file's own backstop below are both English-only by
    // design (see AGENTS.md's Commerce Safety section).
    return pick(lang, {
      en: "Please reply YES to place this order, or NO to cancel.",
      hi: "इस ऑर्डर को देने के लिए YES लिखें, या रद्द करने के लिए NO लिखें।",
      hinglish: "Is order ko place karne ke liye YES likhein, ya cancel karne ke liye NO likhein.",
    });
  }

  const outcome = await withSwiggyFoodClient(message.from, (swiggyFoodClient) =>
    placeConfirmedOrder({ swiggyFoodClient, confirmation: pendingConfirmation, lang }),
  );

  if (!outcome.authenticated) {
    pendingOrderConfirmations.clear(message.from);
    return pick(lang, {
      en: "Your Swiggy connection expired before we could place this order. Please search again to reconnect.",
      hi: "यह ऑर्डर देने से पहले आपका Swiggy कनेक्शन एक्सपायर हो गया। दोबारा कनेक्ट करने के लिए फिर से खोजें।",
      hinglish: "Yeh order place karne se pehle aapka Swiggy connection expire ho gaya. Dobara connect karne ke liye phir se search karein.",
    });
  }

  const { status, replyText, orderId, lat, lng } = outcome.result;

  if (status === "placed_not_confirmed") {
    // Keep the confirmation around with the orderId so a retried YES skips
    // straight to confirm_order instead of placing a duplicate order.
    pendingOrderConfirmations.set(message.from, { ...pendingConfirmation, orderId, lat, lng });
  } else {
    pendingOrderConfirmations.clear(message.from);
  }

  // Only on a genuinely confirmed order - a "failed" order must leave the
  // active-cart session alone so the earlier cancel-path promise ("Your
  // cart is still there") stays true, and "placed_not_confirmed" is still
  // in flight until a retried YES resolves it one way or the other.
  // pendingConversationHistory is cleared in lockstep with pendingCartSessions
  // (not on a plain "NO"/cancel, which keeps the cart around too) - "context
  // until the order is complete" means exactly this moment, not every time a
  // confirmation prompt is dismissed.
  if (status === "confirmed") {
    pendingCartSessions.clear(message.from);
    pendingConversationHistory.clear(message.from);
  }

  return replyText;
}

async function buildReplyText(message) {
  // Updated on every inbound message regardless of which path below ends up
  // handling it (see language-preference.js's own header comment) - a
  // no-op when the message carries no real language signal (a bare number,
  // "YES"/"NO"), so a content-free reply never overwrites a real earlier
  // preference.
  pendingLanguagePreference.update(message.from, message.text);
  const lang = pendingLanguagePreference.get(message.from);

  if (!config.swiggyFood.enabled) {
    return PLACEHOLDER_REPLY_TEXT;
  }

  if (!isSenderInRollout(message.from, config.rollout.percent)) {
    return PLACEHOLDER_REPLY_TEXT;
  }

  const pendingConfirmation = pendingOrderConfirmations.peek(message.from);

  if (pendingConfirmation) {
    return buildOrderConfirmationReply(message, pendingConfirmation, lang);
  }

  // Deterministic backstop, not the primary fix (see the system prompt's
  // new "never invite a YES/NO reply unless relaying checkout's own result"
  // rule in sarvam-agent.js): confirmed live that the agent can still
  // append a checkout-style "reply YES to confirm" ending onto some OTHER
  // tool's result (e.g. after apply_coupon) without ever actually calling
  // checkout - pendingOrderConfirmations never gets set in that case, so a
  // literal "yes" reply falls straight through to a fresh agent turn, which
  // then hallucinated a full "your order is confirmed, arriving in 25-30
  // mins" reply with no real order ever placed (no tool exists for that -
  // see TOOLS in sarvam-agent.js - so it was 100% invented text, not a
  // structural safety gap). Caught here: a bare YES/NO-shaped reply with
  // nothing genuinely pending, immediately preceded by the agent's own
  // turn containing literal uppercase "YES" and "NO" tokens - the exact,
  // deliberately-uppercase wording the system prompt requires ONLY for a
  // genuine checkout relay (kept literal English even mid-translation) -
  // is a strong signal this just happened. Uppercase specifically (not a
  // loose "yes"/"no" text match) so an ordinary lowercase "reply yes or no"
  // question the agent asks about something unrelated isn't caught here -
  // nothing else in this app's own text ever emits capitalized "YES"/"NO"
  // together outside that one instructed case.
  const bareConfirmationDecision = parseOrderConfirmationReply(message.text);

  if (bareConfirmationDecision === "confirm" || bareConfirmationDecision === "cancel") {
    const history = pendingConversationHistory.peek(message.from);
    const lastAssistantTurn = [...history].reverse().find((turn) => turn.role === "assistant");
    const lastReplyText = lastAssistantTurn?.content ?? "";

    if (/\bYES\b/.test(lastReplyText) && /\bNO\b/.test(lastReplyText)) {
      return pick(lang, {
        en: "There's no order actually waiting for confirmation right now - I may have jumped the gun. Want me to show your cart, or go ahead and check out for real?",
        hi: "अभी वाकई कोई ऑर्डर कन्फर्मेशन का इंतज़ार नहीं कर रहा - शायद मैंने जल्दबाज़ी कर दी। क्या मैं आपकी कार्ट दिखाऊं, या असल में चेकआउट करूं?",
        hinglish: "Abhi actually koi order confirmation ka wait nahi kar raha - shayad maine jaldi kar di. Aapki cart dikhaun, ya sach mein checkout karein?",
      });
    }
  }

  if (!config.nlu.enabled) {
    return PLACEHOLDER_REPLY_TEXT;
  }

  // Auth is resolved once for the whole turn now (rather than separately
  // per intent, as the old classifier-driven dispatch did) - everything
  // below, deterministic short-circuits and the agent alike, shares one
  // authenticated Swiggy Food connection.
  const authResult = await resolveSwiggyFoodAuth(message.from);

  if (authResult.status === "unauthenticated") {
    pendingPostAuthActions.set(message.from, { text: message.text, phoneNumberId: message.phoneNumberId });
    const connectToken = pendingConnectLinks.create(message.from);
    const connectUrl = `${swiggyOAuthOrigin}/oauth/swiggy/start?token=${connectToken}`;
    return buildConnectReplyText({ connectUrl, searchTerm: undefined });
  }

  const swiggyFoodClient = createSwiggyFoodClient({
    mcpUrl: effectiveSwiggyFoodMcpUrl,
    token: authResult.accessToken,
  });

  try {
    // Deterministic pre-agent short-circuits, in the same priority a
    // pending address prompt used to take over an active cart session in
    // the old classifier-driven dispatch: a bare number reply to a list
    // this bot already showed is resolved with zero agent calls, in any
    // language, before the agent ever sees the message.
    const addressOutcome = await resolvePendingAddressReply({
      message,
      swiggyFoodClient,
      pendingAddressSelections,
      pendingCartSessions,
      lang,
    });

    if (addressOutcome.handled) {
      return addressOutcome.replyText ?? PLACEHOLDER_REPLY_TEXT;
    }

    const candidateOutcome = await resolvePendingCartCandidateReply({
      message,
      swiggyFoodClient,
      pendingCartSessions,
      lang,
    });

    if (candidateOutcome.handled) {
      return candidateOutcome.replyText ?? PLACEHOLDER_REPLY_TEXT;
    }

    const reply = await runAgentTurn({
      message,
      swiggyFoodClient,
      pendingCartSessions,
      pendingOrderConfirmations,
      pendingAddressSelections,
      pendingConversationHistory,
      nlu: config.nlu,
      lang,
    });

    return reply ?? PLACEHOLDER_REPLY_TEXT;
  } catch (error) {
    if (error instanceof SwiggyAuthFailureError) {
      // Swiggy rejected the token mid-conversation even though our locally
      // tracked expiry said it was still good - drop it so the next
      // message goes through the normal reconnect flow.
      swiggyTokenStore.delete(message.from);
      return PLACEHOLDER_REPLY_TEXT;
    }
    throw error;
  } finally {
    swiggyFoodClient.close().catch((error) => {
      console.error("Failed to close per-request Swiggy Food MCP connection.", { name: error.name });
    });
  }
}

// Single choke point for logging a conversation turn, wrapping
// buildReplyText rather than modifying it - buildReplyText has many early
// returns internally, so wrapping the one place both its callers already
// invoke it from is simpler than threading a logging call through every
// branch. isPlaceholder flags one of the cases most worth looking at when
// debugging: Nosh disabled, not in this sender's rollout, or no intent was
// recognized at all (see PLACEHOLDER_REPLY_TEXT above) - a real answer or
// error message won't match it. Logging is skipped entirely (not just a
// no-op append) when it's off, so there's zero Redis traffic either way.
async function buildReplyTextAndLog(message) {
  const replyText = await buildReplyText(message);

  if (conversationLog) {
    // Fire-and-forget: append() never throws (see conversation-log.js), and
    // awaiting it here would add Redis round-trip latency (connect + rPush +
    // lTrim + expire) to every user-visible reply. The reply goes out
    // immediately; the log write lands a moment later.
    const isPlaceholder = replyText === PLACEHOLDER_REPLY_TEXT;
    void conversationLog.append(message.from, { inboundText: message.text, replyText, isPlaceholder });
  }

  return replyText;
}

// After a sender finishes connecting their Swiggy account, automatically
// resume whatever they originally asked for instead of making them repeat
// themselves - replays their own original message text verbatim through
// buildReplyTextAndLog (the agent interprets it the same way it would have
// the first time). Best-effort: if the agent is disabled or something goes
// wrong at this moment, the resume silently falls through to the normal
// placeholder instead of resuming, same as any other agent outage
// elsewhere in this app.
async function resumePendingSearchAfterAuth(senderId) {
  const pendingAction = pendingPostAuthActions.take(senderId);

  if (!pendingAction || !config.whatsapp.sendEnabled) {
    return;
  }

  const syntheticMessage = {
    from: senderId,
    id: `post-auth-resume-${Date.now()}`,
    phoneNumberId: pendingAction.phoneNumberId,
    text: pendingAction.text,
  };

  try {
    await sendTextMessage({
      accessToken: config.whatsapp.accessToken,
      apiVersion: config.whatsapp.apiVersion,
      phoneNumberId: pendingAction.phoneNumberId,
      to: senderId,
      text: await buildReplyTextAndLog(syntheticMessage),
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
          text: await buildReplyTextAndLog(message),
        });
      } catch (error) {
        console.error("Failed to send WhatsApp reply.", { name: error.name, message: error.message });
      }
    }),
  );
}

// GET /oauth/swiggy/start?token=<connect-token> kicks off the PKCE authorize
// redirect for whichever sender that unguessable, single-use token was
// issued to (see pending-connect-links.js for why this isn't a raw
// ?sender= param).
function handleSwiggyOAuthStart(request, response, url) {
  if (config.swiggyFood.testModeEnabled) {
    sendText(response, 200, "Test mode is on - Swiggy connection is disabled while testing against the mock server.");
    return;
  }

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
  if (config.swiggyFood.testModeEnabled) {
    sendText(response, 200, "Test mode is on - Swiggy connection is disabled while testing against the mock server.");
    return;
  }

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

  if (config.swiggyFood.testModeEnabled && url.pathname === MOCK_FOOD_PATH) {
    await handleMockSwiggyFoodRequest(request, response);
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
  conversationLog?.close().catch((error) => {
    console.error("Failed to close conversation log connection.", { name: error?.name });
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
