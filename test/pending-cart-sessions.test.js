import assert from "node:assert/strict";
import test from "node:test";
import { PendingCartSessions } from "../src/pending-cart-sessions.js";

test("peek returns the stored value without consuming it", () => {
  const sessions = new PendingCartSessions();
  sessions.set("sender-1", { addressId: "addr-1" });

  assert.deepEqual(sessions.peek("sender-1"), { addressId: "addr-1" });
  assert.deepEqual(sessions.peek("sender-1"), { addressId: "addr-1" });
});

test("clear removes an entry", () => {
  const sessions = new PendingCartSessions();
  sessions.set("sender-1", { addressId: "addr-1" });

  sessions.clear("sender-1");

  assert.equal(sessions.peek("sender-1"), undefined);
});

test("peek on an unknown sender returns undefined", () => {
  const sessions = new PendingCartSessions();
  assert.equal(sessions.peek("unknown"), undefined);
});

test("state for one sender does not affect another sender", () => {
  const sessions = new PendingCartSessions();
  sessions.set("sender-1", { addressId: "addr-1" });

  assert.equal(sessions.peek("sender-2"), undefined);
  assert.deepEqual(sessions.peek("sender-1"), { addressId: "addr-1" });
});

test("set overwrites a previous session for the same sender", () => {
  const sessions = new PendingCartSessions();
  sessions.set("sender-1", { addressId: "addr-1" });
  sessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test" });

  assert.deepEqual(sessions.peek("sender-1"), {
    addressId: "addr-1",
    restaurantId: "r-1",
    restaurantName: "Test",
  });
});
