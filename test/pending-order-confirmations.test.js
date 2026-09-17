import assert from "node:assert/strict";
import test from "node:test";
import { PendingOrderConfirmations } from "../src/pending-order-confirmations.js";
import { testStoreDeps } from "./helpers/fake-dynamodb-document-client.js";

test("peek returns the stored value without consuming it", async () => {
  const pending = new PendingOrderConfirmations(testStoreDeps());
  await pending.set("sender-1", { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });

  assert.deepEqual(await pending.peek("sender-1"), { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });
  assert.deepEqual(await pending.peek("sender-1"), { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });
});

test("clear removes an entry", async () => {
  const pending = new PendingOrderConfirmations(testStoreDeps());
  await pending.set("sender-1", { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });

  await pending.clear("sender-1");

  assert.equal(await pending.peek("sender-1"), undefined);
});

test("peek on an unknown sender returns undefined", async () => {
  const pending = new PendingOrderConfirmations(testStoreDeps());
  assert.equal(await pending.peek("unknown"), undefined);
});

test("state for one sender does not affect another sender", async () => {
  const pending = new PendingOrderConfirmations(testStoreDeps());
  await pending.set("sender-1", { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });

  assert.equal(await pending.peek("sender-2"), undefined);
  assert.deepEqual(await pending.peek("sender-1"), { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });
});

test("set overwrites a previous confirmation for the same sender", async () => {
  const pending = new PendingOrderConfirmations(testStoreDeps());
  await pending.set("sender-1", { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });
  await pending.set("sender-1", { addressId: "addr-1", cartId: 1, paymentMethod: "Cash", orderId: "o-1" });

  assert.deepEqual(await pending.peek("sender-1"), {
    addressId: "addr-1",
    cartId: 1,
    paymentMethod: "Cash",
    orderId: "o-1",
  });
});
