import assert from "node:assert/strict";
import test from "node:test";
import { PendingPostAuthActions } from "../src/pending-post-auth-actions.js";

test("take returns the stored value and consumes it", () => {
  const pending = new PendingPostAuthActions();
  pending.set("sender-1", { searchTerm: "biryani", phoneNumberId: "pn-1" });

  assert.deepEqual(pending.take("sender-1"), { searchTerm: "biryani", phoneNumberId: "pn-1" });
  assert.equal(pending.take("sender-1"), undefined);
});

test("take on an unknown sender returns undefined", () => {
  const pending = new PendingPostAuthActions();
  assert.equal(pending.take("unknown"), undefined);
});

test("different senders don't interfere with each other", () => {
  const pending = new PendingPostAuthActions();
  pending.set("sender-1", { searchTerm: "biryani", phoneNumberId: "pn-1" });
  pending.set("sender-2", { searchTerm: "pizza", phoneNumberId: "pn-2" });

  assert.deepEqual(pending.take("sender-2"), { searchTerm: "pizza", phoneNumberId: "pn-2" });
  assert.deepEqual(pending.take("sender-1"), { searchTerm: "biryani", phoneNumberId: "pn-1" });
});
