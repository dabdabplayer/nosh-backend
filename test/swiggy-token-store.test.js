import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { SwiggyTokenStore } from "../src/swiggy-token-store.js";
import { createFakeDynamoDocumentClient } from "./helpers/fake-dynamodb-document-client.js";

function testKey() {
  return randomBytes(32);
}

function newStore({ documentClient = createFakeDynamoDocumentClient(), encryptionKey = testKey() } = {}) {
  return new SwiggyTokenStore({ documentClient, tableName: "test-table", encryptionKey });
}

test("get returns undefined for an unknown sender on a fresh store", async () => {
  const store = newStore();
  assert.equal(await store.get("sender-1"), undefined);
});

test("set then get round-trips a token record", async () => {
  const store = newStore();
  const record = { accessToken: "abc", refreshToken: "def", expiresAt: 123 };

  await store.set("sender-1", record);

  assert.deepEqual(await store.get("sender-1"), record);
});

test("delete removes a stored token", async () => {
  const store = newStore();
  await store.set("sender-1", { accessToken: "abc" });

  await store.delete("sender-1");

  assert.equal(await store.get("sender-1"), undefined);
});

test("persists across separate store instances sharing the same table and key", async () => {
  const documentClient = createFakeDynamoDocumentClient();
  const key = testKey();
  const first = newStore({ documentClient, encryptionKey: key });
  await first.set("sender-1", { accessToken: "abc" });

  const second = newStore({ documentClient, encryptionKey: key });

  assert.deepEqual(await second.get("sender-1"), { accessToken: "abc" });
});

test("tokens for different senders don't interfere with each other", async () => {
  const store = newStore();
  await store.set("sender-1", { accessToken: "one" });
  await store.set("sender-2", { accessToken: "two" });

  assert.deepEqual(await store.get("sender-1"), { accessToken: "one" });
  assert.deepEqual(await store.get("sender-2"), { accessToken: "two" });
});

test("the raw sender id (a phone number) is never written in plaintext", async () => {
  const documentClient = createFakeDynamoDocumentClient();
  const store = newStore({ documentClient });
  const senderId = "+919220133162";

  await store.set(senderId, { accessToken: "abc" });

  const written = JSON.stringify([...documentClient.__itemsForTest()]);
  assert.ok(!written.includes(senderId));
  assert.ok(!written.includes("9220133162"));
});

test("the token value itself is encrypted at rest, not just the sender-id key", async () => {
  const documentClient = createFakeDynamoDocumentClient();
  const store = newStore({ documentClient });
  const accessToken = "super-secret-bearer-token-value";
  const refreshToken = "super-secret-refresh-token-value";

  await store.set("sender-1", { accessToken, refreshToken, expiresAt: 123 });

  const written = JSON.stringify([...documentClient.__itemsForTest()]);
  assert.ok(!written.includes(accessToken));
  assert.ok(!written.includes(refreshToken));
});

test("a record encrypted with one key cannot be decrypted with a different key (fails closed, not crashed)", async () => {
  const documentClient = createFakeDynamoDocumentClient();
  const first = newStore({ documentClient, encryptionKey: testKey() });
  await first.set("sender-1", { accessToken: "abc" });

  const second = newStore({ documentClient, encryptionKey: testKey() });

  assert.equal(await second.get("sender-1"), undefined);
});

test("constructor rejects a missing or wrong-length encryption key", () => {
  const documentClient = createFakeDynamoDocumentClient();
  assert.throws(() => new SwiggyTokenStore({ documentClient, tableName: "test-table", encryptionKey: undefined }));
  assert.throws(
    () => new SwiggyTokenStore({ documentClient, tableName: "test-table", encryptionKey: Buffer.alloc(16) }),
  );
  assert.throws(
    () => new SwiggyTokenStore({ documentClient, tableName: "test-table", encryptionKey: "not-a-buffer" }),
  );
});
