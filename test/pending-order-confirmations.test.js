import assert from "node:assert/strict";
import test from "node:test";
import { PendingOrderConfirmations } from "../src/pending-order-confirmations.js";

test("peek returns the stored value without consuming it", () => {
  const pending = new PendingOrderConfirmations();
  pending.set("sender-1", { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });

  assert.deepEqual(pending.peek("sender-1"), { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });
  assert.deepEqual(pending.peek("sender-1"), { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });
});

test("clear removes an entry", () => {
  const pending = new PendingOrderConfirmations();
  pending.set("sender-1", { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });

  pending.clear("sender-1");

  assert.equal(pending.peek("sender-1"), undefined);
});

test("peek on an unknown sender returns undefined", () => {
  const pending = new PendingOrderConfirmations();
  assert.equal(pending.peek("unknown"), undefined);
});

test("state for one sender does not affect another sender", () => {
  const pending = new PendingOrderConfirmations();
  pending.set("sender-1", { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });

  assert.equal(pending.peek("sender-2"), undefined);
  assert.deepEqual(pending.peek("sender-1"), { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });
});

test("set overwrites a previous confirmation for the same sender", () => {
  const pending = new PendingOrderConfirmations();
  pending.set("sender-1", { addressId: "addr-1", cartId: 1, paymentMethod: "Cash" });
  pending.set("sender-1", { addressId: "addr-1", cartId: 1, paymentMethod: "Cash", orderId: "o-1" });

  assert.deepEqual(pending.peek("sender-1"), {
    addressId: "addr-1",
    cartId: 1,
    paymentMethod: "Cash",
    orderId: "o-1",
  });
});
