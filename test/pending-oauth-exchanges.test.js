import assert from "node:assert/strict";
import test from "node:test";
import { PendingOAuthExchanges } from "../src/pending-oauth-exchanges.js";
import { testStoreDeps } from "./helpers/fake-dynamodb-document-client.js";

test("take returns the stored value and consumes it", async () => {
  const pending = new PendingOAuthExchanges(testStoreDeps());
  await pending.set("state-1", { senderId: "sender-1", codeVerifier: "verifier-1" });

  assert.deepEqual(await pending.take("state-1"), { senderId: "sender-1", codeVerifier: "verifier-1" });
  assert.equal(await pending.take("state-1"), undefined);
});

test("take on an unknown state returns undefined", async () => {
  const pending = new PendingOAuthExchanges(testStoreDeps());
  assert.equal(await pending.take("unknown"), undefined);
});

test("different states don't interfere with each other", async () => {
  const pending = new PendingOAuthExchanges(testStoreDeps());
  await pending.set("state-1", { senderId: "sender-1", codeVerifier: "verifier-1" });
  await pending.set("state-2", { senderId: "sender-2", codeVerifier: "verifier-2" });

  assert.deepEqual(await pending.take("state-2"), { senderId: "sender-2", codeVerifier: "verifier-2" });
  assert.deepEqual(await pending.take("state-1"), { senderId: "sender-1", codeVerifier: "verifier-1" });
});
