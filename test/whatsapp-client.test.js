import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInteractive,
  sendReadReceipt,
  sendReply,
  sendTextMessage,
  truncateLabel,
  WhatsAppSendError,
} from "../src/whatsapp-client.js";

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

test("sendReadReceipt marks the message read and shows the typing indicator", async () => {
  const requests = [];
  await sendReadReceipt({
    accessToken: "token",
    apiVersion: "v23.0",
    phoneNumberId: "pn-1",
    messageId: "wamid.1",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    },
  });

  assert.equal(requests[0].url, "https://graph.facebook.com/v23.0/pn-1/messages");
  assert.equal(requests[0].init.headers.authorization, "Bearer token");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    messaging_product: "whatsapp",
    status: "read",
    message_id: "wamid.1",
    typing_indicator: { type: "text" },
  });
});

test("sendReadReceipt falls back to a plain read receipt when Meta rejects the typing indicator", async () => {
  const bodies = [];
  await sendReadReceipt({
    accessToken: "token",
    apiVersion: "v21.0",
    phoneNumberId: "pn-1",
    messageId: "wamid.1",
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response("{}", { status: bodies.length === 1 ? 400 : 200 });
    },
  });

  assert.equal(bodies.length, 2);
  assert.equal("typing_indicator" in bodies[1], false);
  assert.equal(bodies[1].status, "read");
});

test("sendReadReceipt throws a WhatsAppSendError with the status when Meta rejects it", async () => {
  await assert.rejects(
    sendReadReceipt({
      accessToken: "token",
      apiVersion: "v23.0",
      phoneNumberId: "pn-1",
      messageId: "wamid.1",
      fetchImpl: async () => new Response("{}", { status: 401 }),
    }),
    (error) => error instanceof WhatsAppSendError && error.status === 401,
  );
});

test("truncateLabel cuts to the limit by character and marks the cut", () => {
  assert.equal(truncateLabel("Home", 20), "Home");
  assert.equal(truncateLabel("Test Kitchen Biryani House (Mock)", 24), "Test Kitchen Biryani Ho…");
  assert.equal([...truncateLabel("ऑर्डर प्लेस करें अभी तुरंत यहाँ", 20)].length, 20);
});

test("buildInteractive builds reply buttons and lists in Meta's format, with labels cut to fit", () => {
  assert.deepEqual(buildInteractive("Which address?", { buttons: [{ id: "addr:1", title: "Home" }] }), {
    type: "button",
    body: { text: "Which address?" },
    action: { buttons: [{ type: "reply", reply: { id: "addr:1", title: "Home" } }] },
  });

  const list = buildInteractive("Pick one", {
    list: { button: "Choose", rows: [{ id: "rest:r-1", title: "Test Kitchen Biryani House (Mock)", description: "⭐4.3" }] },
  });
  assert.equal(list.type, "list");
  assert.equal(list.action.button, "Choose");
  assert.deepEqual(list.action.sections[0].rows[0], { id: "rest:r-1", title: "Test Kitchen Biryani Ho…", description: "⭐4.3" });
});

test("buildInteractive gives up when the options don't fit, so plain text is sent", () => {
  const fourButtons = [1, 2, 3, 4].map((n) => ({ id: `b${n}`, title: `B${n}` }));
  assert.equal(buildInteractive("text", { buttons: fourButtons }), undefined);
  assert.equal(buildInteractive("x".repeat(1025), { buttons: [{ id: "a", title: "A" }] }), undefined);
  assert.equal(buildInteractive("text", { list: { button: "Choose", rows: Array.from({ length: 11 }, (_, n) => ({ id: `r${n}`, title: `R${n}` })) } }), undefined);
  assert.equal(buildInteractive("text", undefined), undefined);
});

test("sendReply sends an interactive message when there are options", async () => {
  const bodies = [];
  const result = await sendReply({
    accessToken: "token",
    apiVersion: "v26.0",
    phoneNumberId: "pn-1",
    to: "15550001111",
    text: "Which address?",
    options: { buttons: [{ id: "addr:1", title: "Home" }] },
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
    },
  });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].type, "interactive");
  assert.equal(bodies[0].interactive.body.text, "Which address?");
  assert.equal(result.interactive, true);
});

test("sendReply falls back to the same text as a plain message when Meta rejects the interactive one", async () => {
  const bodies = [];
  await sendReply({
    accessToken: "token",
    apiVersion: "v26.0",
    phoneNumberId: "pn-1",
    to: "15550001111",
    text: "Which address?",
    options: { buttons: [{ id: "addr:1", title: "Home" }] },
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1
        ? new Response("{}", { status: 400 })
        : new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
    },
  });

  assert.deepEqual(bodies.map((body) => body.type), ["interactive", "text"]);
  assert.equal(bodies[1].text.body, "Which address?");
});

test("sendReply sends plain text when there are no options", async () => {
  const bodies = [];
  await sendReply({
    accessToken: "token",
    apiVersion: "v26.0",
    phoneNumberId: "pn-1",
    to: "15550001111",
    text: "Hello",
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
    },
  });

  assert.deepEqual(bodies.map((body) => body.type), ["text"]);
});
