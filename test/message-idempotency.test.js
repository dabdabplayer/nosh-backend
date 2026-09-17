import assert from "node:assert/strict";
import test from "node:test";
import { InProcessMessageIdempotency } from "../src/message-idempotency.js";

function message(id) {
  return { id };
}

test("accepts each inbound WhatsApp message ID only once", () => {
  const idempotency = new InProcessMessageIdempotency();
  const inboundMessage = message("wamid.unique-message");

  assert.deepEqual(idempotency.takeUnprocessed([inboundMessage]), [inboundMessage]);
  assert.deepEqual(idempotency.takeUnprocessed([inboundMessage]), []);
});

test("does not process duplicate IDs within one webhook delivery", () => {
  const idempotency = new InProcessMessageIdempotency();
  const firstMessage = message("wamid.duplicate-message");
  const duplicateMessage = message("wamid.duplicate-message");
  const otherMessage = message("wamid.other-message");

  assert.deepEqual(idempotency.takeUnprocessed([firstMessage, duplicateMessage, otherMessage]), [
    firstMessage,
    otherMessage,
  ]);
});
