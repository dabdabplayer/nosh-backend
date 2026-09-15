import assert from "node:assert/strict";
import test from "node:test";
import { sendTextMessage, WhatsAppSendError } from "../src/whatsapp-client.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("sends a text message to the Graph API with the documented request shape", async () => {
  const calls = [];
  const result = await sendTextMessage({
    accessToken: "test-token",
    apiVersion: "v21.0",
    phoneNumberId: "123456",
    to: "919999999999",
    text: "Hello from Nosh",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, {
        messages: [{ id: "wamid.reply-1", message_status: "accepted" }],
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://graph.facebook.com/v21.0/123456/messages");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "919999999999",
    type: "text",
    text: { body: "Hello from Nosh" },
  });
  assert.deepEqual(result, { id: "wamid.reply-1", status: "accepted" });
});

test("wraps a non-2xx Graph API response in WhatsAppSendError", async () => {
  await assert.rejects(
    sendTextMessage({
      accessToken: "test-token",
      apiVersion: "v21.0",
      phoneNumberId: "123456",
      to: "919999999999",
      text: "Hello",
      fetchImpl: async () =>
        jsonResponse(401, { error: { message: "Invalid OAuth access token" } }),
    }),
    (error) => {
      assert.ok(error instanceof WhatsAppSendError);
      assert.equal(error.status, 401);
      return true;
    },
  );
});

test("wraps a network-level failure in WhatsAppSendError", async () => {
  const networkError = new Error("fetch failed");
  await assert.rejects(
    sendTextMessage({
      accessToken: "test-token",
      apiVersion: "v21.0",
      phoneNumberId: "123456",
      to: "919999999999",
      text: "Hello",
      fetchImpl: async () => {
        throw networkError;
      },
    }),
    (error) => {
      assert.ok(error instanceof WhatsAppSendError);
      assert.equal(error.cause, networkError);
      return true;
    },
  );
});
