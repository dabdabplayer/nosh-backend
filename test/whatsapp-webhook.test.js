import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  extractInboundTextMessages,
  parseWhatsAppWebhookPayload,
  verifyWebhookSignature,
  verifyWebhookSubscription,
} from "../src/whatsapp-webhook.js";

const appSecret = "test-app-secret";

test("returns Meta's challenge only for a matching subscription token", () => {
  const validUrl = new URL(
    "http://localhost/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-token&hub.challenge=challenge-123",
  );
  const invalidUrl = new URL(
    "http://localhost/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=challenge-123",
  );

  assert.equal(verifyWebhookSubscription(validUrl, "test-token"), "challenge-123");
  assert.equal(verifyWebhookSubscription(invalidUrl, "test-token"), undefined);
});

test("accepts only a valid Meta HMAC-SHA256 signature", () => {
  const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');
  const validSignature = `sha256=${createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex")}`;

  assert.equal(verifyWebhookSignature(rawBody, validSignature, appSecret), true);
  assert.equal(verifyWebhookSignature(rawBody, "sha256=" + "0".repeat(64), appSecret), false);
  assert.equal(verifyWebhookSignature(rawBody, undefined, appSecret), false);
});

test("extracts only valid inbound text messages and ignores other events", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "123456" },
              messages: [
                {
                  from: "919999999999",
                  id: "wamid.text-message",
                  timestamp: "1710000000",
                  text: { body: "Order paneer tikka" },
                  type: "text",
                },
                {
                  from: "919999999999",
                  id: "wamid.image-message",
                  type: "image",
                },
              ],
            },
          },
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "123456" },
              statuses: [{ id: "wamid.status" }],
            },
          },
        ],
      },
    ],
  };

  const rawBody = Buffer.from(JSON.stringify(payload));
  const parsedPayload = parseWhatsAppWebhookPayload(rawBody);

  assert.deepEqual(extractInboundTextMessages(parsedPayload), [
    {
      from: "919999999999",
      id: "wamid.text-message",
      phoneNumberId: "123456",
      text: "Order paneer tikka",
      timestamp: "1710000000",
    },
  ]);
});

test("rejects malformed and non-WhatsApp webhook bodies", () => {
  assert.equal(parseWhatsAppWebhookPayload(Buffer.from("not json")), undefined);
  assert.equal(
    parseWhatsAppWebhookPayload(Buffer.from('{"object":"not_whatsapp"}')),
    undefined,
  );
});
