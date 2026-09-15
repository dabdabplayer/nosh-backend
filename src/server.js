import http from "node:http";
import { config } from "./config.js";
import { InProcessMessageIdempotency } from "./message-idempotency.js";
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

// Placeholder reply until conversation orchestration (intent handling,
// Swiggy MCP calls) lands in a later increment.
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
          text: PLACEHOLDER_REPLY_TEXT,
        });
      } catch (error) {
        console.error("Failed to send WhatsApp reply.", { name: error.name });
      }
    }),
  );
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

    // Persistence and conversation orchestration arrive in later increments.
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
