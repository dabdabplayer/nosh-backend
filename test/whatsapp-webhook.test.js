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

function interactivePayload(interactive) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "pn-1" },
              messages: [{ from: "15550001111", id: "wamid.tap", timestamp: "1714510003", type: "interactive", interactive }],
            },
          },
        ],
      },
    ],
  };
}

test("extracts a tapped reply button with its id and label", () => {
  const messages = extractInboundTextMessages(
    interactivePayload({ type: "button_reply", button_reply: { id: "addr:addr-1", title: "Home" } }),
  );

  assert.deepEqual(messages, [
    { from: "15550001111", id: "wamid.tap", phoneNumberId: "pn-1", text: "Home", replyId: "addr:addr-1", timestamp: "1714510003" },
  ]);
});

test("extracts a tapped list row with its id and label", () => {
  const messages = extractInboundTextMessages(
    interactivePayload({ type: "list_reply", list_reply: { id: "rest:r-2", title: "Pizza Place", description: "4.1" } }),
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "Pizza Place");
  assert.equal(messages[0].replyId, "rest:r-2");
});

test("ignores an interactive message with no usable id or label", () => {
  assert.deepEqual(extractInboundTextMessages(interactivePayload({ type: "button_reply", button_reply: { id: "", title: "Home" } })), []);
  assert.deepEqual(extractInboundTextMessages(interactivePayload({ type: "nfm_reply" })), []);
});

function audioPayload(audio) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "pn-1" },
              messages: [{ from: "15550001111", id: "wamid.voice", timestamp: "1714510003", type: "audio", audio }],
            },
          },
        ],
      },
    ],
  };
}

test("extracts a voice note as an audio message with no text yet", () => {
  const messages = extractInboundTextMessages(
    audioPayload({ id: "media-1", mime_type: "audio/ogg; codecs=opus", sha256: "abc", voice: true }),
  );

  assert.deepEqual(messages, [
    {
      from: "15550001111",
      id: "wamid.voice",
      phoneNumberId: "pn-1",
      audio: { id: "media-1", mimeType: "audio/ogg; codecs=opus" },
      fromVoice: true,
      timestamp: "1714510003",
    },
  ]);
});

test("ignores an audio message with no media id", () => {
  assert.deepEqual(extractInboundTextMessages(audioPayload({ mime_type: "audio/ogg" })), []);
});
