import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = 1024 * 1024;

function secretsMatch(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyWebhookSubscription(url, verifyToken) {
  const mode = url.searchParams.get("hub.mode");
  const suppliedToken = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode !== "subscribe" || suppliedToken === null || challenge === null) {
    return undefined;
  }

  return secretsMatch(suppliedToken, verifyToken) ? challenge : undefined;
}

export function verifyWebhookSignature(rawBody, signature, appSecret) {
  if (!signature?.match(/^sha256=[a-f0-9]{64}$/i)) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return secretsMatch(signature, expected);
}

export async function readRawBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      const error = new Error("Webhook body exceeds the 1 MB limit.");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function parseWhatsAppWebhookPayload(rawBody) {
  try {
    const payload = JSON.parse(rawBody.toString("utf8"));
    return payload?.object === "whatsapp_business_account" ? payload : undefined;
  } catch {
    return undefined;
  }
}

export function extractInboundTextMessages(payload) {
  const incomingMessages = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      if (change?.field !== "messages") {
        continue;
      }

      const phoneNumberId = change.value?.metadata?.phone_number_id;
      const messages = Array.isArray(change.value?.messages) ? change.value.messages : [];

      for (const message of messages) {
        if (!isNonEmptyString(message?.id) || !isNonEmptyString(message.from) || !isNonEmptyString(phoneNumberId)) {
          continue;
        }

        // A tap on a button or list row Nosh sent. `text` is the label the
        // user saw (for logs and conversation history); `replyId` is the id
        // Nosh gave that option, which is what the tap is routed by.
        // https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
        const tapped =
          message.type === "interactive"
            ? (message.interactive?.button_reply ?? message.interactive?.list_reply)
            : undefined;

        if (tapped) {
          if (!isNonEmptyString(tapped.id) || !isNonEmptyString(tapped.title)) {
            continue;
          }
          incomingMessages.push(
            Object.freeze({
              from: message.from,
              id: message.id,
              phoneNumberId,
              text: tapped.title,
              replyId: tapped.id,
              timestamp: message.timestamp,
            }),
          );
          continue;
        }

        if (message.type !== "text" || !isNonEmptyString(message.text?.body)) {
          continue;
        }

        incomingMessages.push(
          Object.freeze({
            from: message.from,
            id: message.id,
            phoneNumberId,
            text: message.text.body,
            timestamp: message.timestamp,
          }),
        );
      }
    }
  }

  return Object.freeze(incomingMessages);
}
