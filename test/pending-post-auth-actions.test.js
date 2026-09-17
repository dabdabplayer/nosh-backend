import assert from "node:assert/strict";
import test from "node:test";
import { PendingPostAuthActions } from "../src/pending-post-auth-actions.js";
import { testStoreDeps } from "./helpers/fake-dynamodb-document-client.js";

test("take returns the stored value and consumes it", async () => {
  const pending = new PendingPostAuthActions(testStoreDeps());
  await pending.set("sender-1", { searchTerm: "biryani", phoneNumberId: "pn-1" });

  assert.deepEqual(await pending.take("sender-1"), { searchTerm: "biryani", phoneNumberId: "pn-1" });
  assert.equal(await pending.take("sender-1"), undefined);
});

test("take on an unknown sender returns undefined", async () => {
  const pending = new PendingPostAuthActions(testStoreDeps());
  assert.equal(await pending.take("unknown"), undefined);
});

test("different senders don't interfere with each other", async () => {
  const pending = new PendingPostAuthActions(testStoreDeps());
  await pending.set("sender-1", { searchTerm: "biryani", phoneNumberId: "pn-1" });
  await pending.set("sender-2", { searchTerm: "pizza", phoneNumberId: "pn-2" });

  assert.deepEqual(await pending.take("sender-2"), { searchTerm: "pizza", phoneNumberId: "pn-2" });
  assert.deepEqual(await pending.take("sender-1"), { searchTerm: "biryani", phoneNumberId: "pn-1" });
});
