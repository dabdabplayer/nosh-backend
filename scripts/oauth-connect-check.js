// Manual dev tool: exercise the real Swiggy OAuth connect flow and the
// food-search conversation end-to-end against a real Swiggy account,
// without needing WhatsApp or a published Meta app. Starts a tiny local
// server implementing the same /oauth/swiggy/start and
// /oauth/swiggy/callback logic as src/server.js, and drops you into an
// interactive prompt where each line you type is treated as a WhatsApp
// message from a test sender. Not part of the app itself.
//
// Usage:
//   SWIGGY_FOOD_MCP_URL=https://mcp.swiggy.com/food node scripts/oauth-connect-check.js
//
// Then type things like "find biryani" and, once prompted, "1" to pick an
// address - exactly as you would over WhatsApp. Ctrl+C to quit.
//
// If a token is already saved from a previous run (see
// SWIGGY_TOKEN_STORE_PATH / data/swiggy-tokens.json), it skips the OAuth
// dance entirely and searches immediately using the saved token.

import http from "node:http";
import readline from "node:readline/promises";
import { config } from "../src/config.js";
import { classifyIncomingMessage, getFoodSearchReply } from "../src/food-search-orchestrator.js";
import { getFoodOrderReply, parseOrderConfirmationReply, placeConfirmedOrder } from "../src/food-order-orchestrator.js";
import { PendingAddressSelections } from "../src/pending-address-selection.js";
import { PendingCartSessions } from "../src/pending-cart-sessions.js";
import { PendingConnectLinks } from "../src/pending-connect-links.js";
import { PendingOAuthExchanges } from "../src/pending-oauth-exchanges.js";
import { PendingOrderConfirmations } from "../src/pending-order-confirmations.js";
import { PendingPostAuthActions } from "../src/pending-post-auth-actions.js";
import { createSwiggyFoodClient } from "../src/swiggy-food-client.js";
import { buildConnectReplyText, resolveSwiggyAccessToken } from "../src/swiggy-auth-flow.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generatePkcePair,
  generateState,
  SwiggyOAuthError,
} from "../src/swiggy-oauth.js";
import { SwiggyTokenStore } from "../src/swiggy-token-store.js";

const TEST_SENDER = "oauth-connect-check";

if (!config.swiggyFood.enabled) {
  console.error("SWIGGY_FOOD_MCP_URL must be set.");
  process.exitCode = 1;
} else {
  const port = new URL(config.swiggyOAuth.redirectUri).port || 3000;

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
  const swiggyOAuthOrigin = new URL(config.swiggyOAuth.redirectUri).origin;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  function sendText(response, statusCode, body) {
    response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
    response.end(body);
  }

  // Same as server.js's withSwiggyFoodClient helper.
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
    } finally {
      await swiggyFoodClient.close().catch(() => {});
    }
  }

  // Same as server.js's buildOrderConfirmationReply.
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
      pendingOrderConfirmations.set(message.from, { ...pendingConfirmation, orderId, lat, lng });
    } else {
      pendingOrderConfirmations.clear(message.from);
    }

    return replyText;
  }

  // Same decision logic as server.js's buildReplyText, minus the WhatsApp send.
  async function buildReplyText(message) {
    const pendingConfirmation = pendingOrderConfirmations.peek(message.from);

    if (pendingConfirmation) {
      return buildOrderConfirmationReply(message, pendingConfirmation);
    }

    // Same order-first-when-cart-active fix as server.js's buildReplyText:
    // trying the search classifier first let it misread cart-continuation
    // messages like "add chicken wings from KFC" as a brand new search
    // (confirmed live) since deferring on cart-related messages was only a
    // probabilistic prompt instruction, not a deterministic check.
    const hasPendingAddressSelection = Boolean(pendingAddressSelections.peek(message.from));
    const activeCartSession = pendingCartSessions.peek(message.from);

    if (activeCartSession && !hasPendingAddressSelection) {
      const outcome = await withSwiggyFoodClient(message.from, (swiggyFoodClient) =>
        getFoodOrderReply({
          message,
          swiggyFoodClient,
          pendingCartSessions,
          pendingOrderConfirmations,
          nlu: config.nlu,
        }),
      );

      if (!outcome.authenticated) {
        return "(no trigger matched - try \"find <something>\")";
      }

      if (outcome.result !== undefined) {
        return outcome.result;
      }
    }

    const classification = await classifyIncomingMessage(message, pendingAddressSelections, {
      nlu: config.nlu,
      pendingCartSessions,
    });

    if (classification.type === "no_trigger") {
      return "(no trigger matched - try \"find <something>\")";
    }

    if (classification.type === "unrecognized_pending_reply") {
      const reply = await getFoodSearchReply({
        message,
        swiggyFoodClient: undefined,
        pendingAddressSelections,
        pendingCartSessions,
        classification,
      });
      return reply ?? "(fallthrough)";
    }

    const searchTerm = classification.searchTerm ?? classification.pending?.searchTerm;
    const authResult = await resolveSwiggyAccessToken({
      senderId: message.from,
      tokenStore: swiggyTokenStore,
      authBaseUrl: config.swiggyOAuth.authBaseUrl,
    });

    if (authResult.status === "unauthenticated") {
      pendingPostAuthActions.set(message.from, { searchTerm, phoneNumberId: "manual-test" });
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
      return reply ?? "(getFoodSearchReply returned undefined)";
    } finally {
      await swiggyFoodClient.close().catch(() => {});
    }
  }

  async function sendAsTestSender(text) {
    const reply = await buildReplyText({
      from: TEST_SENDER,
      id: `msg-${Date.now()}`,
      phoneNumberId: "manual-test",
      text,
    });
    console.log(`\n${reply}\n`);
  }

  // Fired from the real /oauth/swiggy/callback once login succeeds, so the
  // search that prompted the connect link resumes without you retyping it.
  async function resumePendingSearchAfterAuth(senderId) {
    const pendingAction = pendingPostAuthActions.take(senderId);
    if (!pendingAction?.searchTerm) {
      return;
    }

    console.log(`\n[auto-resuming search for "${pendingAction.searchTerm}"]`);
    await sendAsTestSender(`find ${pendingAction.searchTerm}`);
  }

  function handleStart(request, response, url) {
    const connectToken = url.searchParams.get("token");
    const pendingLink = connectToken ? pendingConnectLinks.take(connectToken) : undefined;

    if (!pendingLink) {
      sendText(response, 400, "This connection link is invalid or has expired.");
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

  async function handleCallback(request, response, url) {
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");
    const pending = state ? pendingOAuthExchanges.take(state) : undefined;

    if (!pending) {
      sendText(response, 400, "This Swiggy connection link is invalid or has expired.");
      return;
    }

    if (oauthError) {
      sendText(response, 200, "Swiggy connection cancelled.");
      return;
    }

    const code = url.searchParams.get("code");

    if (!code) {
      sendText(response, 400, "Missing code.");
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
      sendText(response, 200, "Your Swiggy account is connected! Check the terminal running this script.");
      await resumePendingSearchAfterAuth(pending.senderId);
    } catch (error) {
      if (error instanceof SwiggyOAuthError) {
        console.error("Token exchange failed.", { step: error.step, error: error.error });
      } else {
        console.error("Callback failed unexpectedly.", error);
      }
      sendText(response, 502, "Couldn't connect your Swiggy account. Check the terminal.");
    }
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname === "/oauth/swiggy/start") {
      handleStart(request, response, url);
      return;
    }

    if (url.pathname === "/oauth/swiggy/callback") {
      await handleCallback(request, response, url);
      return;
    }

    sendText(response, 404, "not found");
  });

  server.listen(port, async () => {
    console.log(`Listening on ${swiggyOAuthOrigin}`);
    console.log('Type a message as this test sender, e.g. "find biryani". Ctrl+C to quit.\n');

    try {
      for (;;) {
        const line = await rl.question("> ");
        const text = line.trim();

        if (text) {
          await sendAsTestSender(text);
        }
      }
    } catch (error) {
      if (error.code !== "ERR_USE_AFTER_CLOSE") {
        console.error("\nInput loop stopped unexpectedly.", error);
      }
    } finally {
      server.close();
      process.exit(0);
    }
  });
}
