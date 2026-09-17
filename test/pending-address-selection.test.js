import assert from "node:assert/strict";
import test from "node:test";
import { PendingAddressSelections } from "../src/pending-address-selection.js";
import { testStoreDeps } from "./helpers/fake-dynamodb-document-client.js";

test("peek returns the stored value without consuming it", async () => {
  const pending = new PendingAddressSelections(testStoreDeps());
  await pending.set("sender-1", { searchTerm: "pizza", candidates: [] });

  assert.deepEqual(await pending.peek("sender-1"), { searchTerm: "pizza", candidates: [] });
  assert.deepEqual(await pending.peek("sender-1"), { searchTerm: "pizza", candidates: [] });
});

test("take consumes the stored value", async () => {
  const pending = new PendingAddressSelections(testStoreDeps());
  await pending.set("sender-1", { searchTerm: "pizza", candidates: [] });

  assert.deepEqual(await pending.take("sender-1"), { searchTerm: "pizza", candidates: [] });
  assert.equal(await pending.take("sender-1"), undefined);
  assert.equal(await pending.peek("sender-1"), undefined);
});

test("clear removes an entry without needing to read it first", async () => {
  const pending = new PendingAddressSelections(testStoreDeps());
  await pending.set("sender-1", { searchTerm: "pizza", candidates: [] });

  await pending.clear("sender-1");

  assert.equal(await pending.peek("sender-1"), undefined);
});

test("peek and take on an unknown sender return undefined", async () => {
  const pending = new PendingAddressSelections(testStoreDeps());

  assert.equal(await pending.peek("unknown"), undefined);
  assert.equal(await pending.take("unknown"), undefined);
});

test("state for one sender does not affect another sender", async () => {
  const pending = new PendingAddressSelections(testStoreDeps());
  await pending.set("sender-1", { searchTerm: "pizza", candidates: [] });

  assert.equal(await pending.peek("sender-2"), undefined);
  assert.deepEqual(await pending.peek("sender-1"), { searchTerm: "pizza", candidates: [] });
});
