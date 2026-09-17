import assert from "node:assert/strict";
import test from "node:test";
import { PendingAddressSelections } from "../src/pending-address-selection.js";

test("peek returns the stored value without consuming it", () => {
  const pending = new PendingAddressSelections();
  pending.set("sender-1", { searchTerm: "pizza", candidates: [] });

  assert.deepEqual(pending.peek("sender-1"), { searchTerm: "pizza", candidates: [] });
  assert.deepEqual(pending.peek("sender-1"), { searchTerm: "pizza", candidates: [] });
});

test("take consumes the stored value", () => {
  const pending = new PendingAddressSelections();
  pending.set("sender-1", { searchTerm: "pizza", candidates: [] });

  assert.deepEqual(pending.take("sender-1"), { searchTerm: "pizza", candidates: [] });
  assert.equal(pending.take("sender-1"), undefined);
  assert.equal(pending.peek("sender-1"), undefined);
});

test("clear removes an entry without needing to read it first", () => {
  const pending = new PendingAddressSelections();
  pending.set("sender-1", { searchTerm: "pizza", candidates: [] });

  pending.clear("sender-1");

  assert.equal(pending.peek("sender-1"), undefined);
});

test("peek and take on an unknown sender return undefined", () => {
  const pending = new PendingAddressSelections();

  assert.equal(pending.peek("unknown"), undefined);
  assert.equal(pending.take("unknown"), undefined);
});

test("state for one sender does not affect another sender", () => {
  const pending = new PendingAddressSelections();
  pending.set("sender-1", { searchTerm: "pizza", candidates: [] });

  assert.equal(pending.peek("sender-2"), undefined);
  assert.deepEqual(pending.peek("sender-1"), { searchTerm: "pizza", candidates: [] });
});
