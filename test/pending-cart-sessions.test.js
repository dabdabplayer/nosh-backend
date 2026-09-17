import assert from "node:assert/strict";
import test from "node:test";
import { PendingCartSessions } from "../src/pending-cart-sessions.js";
import { testStoreDeps } from "./helpers/fake-dynamodb-document-client.js";

test("peek returns the stored value without consuming it", async () => {
  const sessions = new PendingCartSessions(testStoreDeps());
  await sessions.set("sender-1", { addressId: "addr-1" });

  assert.deepEqual(await sessions.peek("sender-1"), { addressId: "addr-1" });
  assert.deepEqual(await sessions.peek("sender-1"), { addressId: "addr-1" });
});

test("clear removes an entry", async () => {
  const sessions = new PendingCartSessions(testStoreDeps());
  await sessions.set("sender-1", { addressId: "addr-1" });

  await sessions.clear("sender-1");

  assert.equal(await sessions.peek("sender-1"), undefined);
});

test("peek on an unknown sender returns undefined", async () => {
  const sessions = new PendingCartSessions(testStoreDeps());
  assert.equal(await sessions.peek("unknown"), undefined);
});

test("state for one sender does not affect another sender", async () => {
  const sessions = new PendingCartSessions(testStoreDeps());
  await sessions.set("sender-1", { addressId: "addr-1" });

  assert.equal(await sessions.peek("sender-2"), undefined);
  assert.deepEqual(await sessions.peek("sender-1"), { addressId: "addr-1" });
});

test("set overwrites a previous session for the same sender", async () => {
  const sessions = new PendingCartSessions(testStoreDeps());
  await sessions.set("sender-1", { addressId: "addr-1" });
  await sessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Test" });

  assert.deepEqual(await sessions.peek("sender-1"), {
    addressId: "addr-1",
    restaurantId: "r-1",
    restaurantName: "Test",
  });
});
