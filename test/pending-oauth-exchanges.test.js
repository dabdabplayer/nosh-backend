import assert from "node:assert/strict";
import test from "node:test";
import { PendingOAuthExchanges } from "../src/pending-oauth-exchanges.js";

test("take returns the stored value and consumes it", () => {
  const pending = new PendingOAuthExchanges();
  pending.set("state-1", { senderId: "sender-1", codeVerifier: "verifier-1" });

  assert.deepEqual(pending.take("state-1"), { senderId: "sender-1", codeVerifier: "verifier-1" });
  assert.equal(pending.take("state-1"), undefined);
});

test("take on an unknown state returns undefined", () => {
  const pending = new PendingOAuthExchanges();
  assert.equal(pending.take("unknown"), undefined);
});

test("different states don't interfere with each other", () => {
  const pending = new PendingOAuthExchanges();
  pending.set("state-1", { senderId: "sender-1", codeVerifier: "verifier-1" });
  pending.set("state-2", { senderId: "sender-2", codeVerifier: "verifier-2" });

  assert.deepEqual(pending.take("state-2"), { senderId: "sender-2", codeVerifier: "verifier-2" });
  assert.deepEqual(pending.take("state-1"), { senderId: "sender-1", codeVerifier: "verifier-1" });
});
