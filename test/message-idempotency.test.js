import assert from "node:assert/strict";
import test from "node:test";
import { MessageIdempotency } from "../src/message-idempotency.js";
import { testStoreDeps } from "./helpers/fake-dynamodb-document-client.js";

function message(id) {
  return { id };
}

test("accepts each inbound WhatsApp message ID only once", async () => {
  const idempotency = new MessageIdempotency(testStoreDeps());
  const inboundMessage = message("wamid.unique-message");

  assert.deepEqual(await idempotency.takeUnprocessed([inboundMessage]), [inboundMessage]);
  assert.deepEqual(await idempotency.takeUnprocessed([inboundMessage]), []);
});

test("does not process duplicate IDs within one webhook delivery", async () => {
  const idempotency = new MessageIdempotency(testStoreDeps());
  const firstMessage = message("wamid.duplicate-message");
  const duplicateMessage = message("wamid.duplicate-message");
  const otherMessage = message("wamid.other-message");

  assert.deepEqual(await idempotency.takeUnprocessed([firstMessage, duplicateMessage, otherMessage]), [
    firstMessage,
    otherMessage,
  ]);
});
