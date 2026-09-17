import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SwiggyTokenStore } from "../src/swiggy-token-store.js";

function tempStorePath() {
  const dir = mkdtempSync(join(tmpdir(), "nosh-swiggy-token-store-"));
  return join(dir, "nested", "tokens.json");
}

function testKey() {
  return randomBytes(32);
}

test("get returns undefined for an unknown sender on a fresh store", () => {
  const store = new SwiggyTokenStore(tempStorePath(), testKey());
  assert.equal(store.get("sender-1"), undefined);
});

test("set then get round-trips a token record", () => {
  const store = new SwiggyTokenStore(tempStorePath(), testKey());
  const record = { accessToken: "abc", refreshToken: "def", expiresAt: 123 };

  store.set("sender-1", record);

  assert.deepEqual(store.get("sender-1"), record);
});

test("delete removes a stored token", () => {
  const store = new SwiggyTokenStore(tempStorePath(), testKey());
  store.set("sender-1", { accessToken: "abc" });

  store.delete("sender-1");

  assert.equal(store.get("sender-1"), undefined);
});

test("persists across separate store instances pointed at the same file and key", () => {
  const filePath = tempStorePath();
  const key = testKey();
  const first = new SwiggyTokenStore(filePath, key);
  first.set("sender-1", { accessToken: "abc" });

  const second = new SwiggyTokenStore(filePath, key);

  assert.deepEqual(second.get("sender-1"), { accessToken: "abc" });
});

test("tokens for different senders don't interfere with each other", () => {
  const store = new SwiggyTokenStore(tempStorePath(), testKey());
  store.set("sender-1", { accessToken: "one" });
  store.set("sender-2", { accessToken: "two" });

  assert.deepEqual(store.get("sender-1"), { accessToken: "one" });
  assert.deepEqual(store.get("sender-2"), { accessToken: "two" });
});

test("the raw sender id (a phone number) is never written to disk in plaintext", () => {
  const filePath = tempStorePath();
  const store = new SwiggyTokenStore(filePath, testKey());
  const senderId = "+919220133162";

  store.set(senderId, { accessToken: "abc" });

  const fileContents = readFileSync(filePath, "utf8");
  assert.ok(!fileContents.includes(senderId));
  assert.ok(!fileContents.includes("9220133162"));
});

test("the token value itself is encrypted at rest, not just the sender-id key", () => {
  const filePath = tempStorePath();
  const store = new SwiggyTokenStore(filePath, testKey());
  const accessToken = "super-secret-bearer-token-value";
  const refreshToken = "super-secret-refresh-token-value";

  store.set("sender-1", { accessToken, refreshToken, expiresAt: 123 });

  const fileContents = readFileSync(filePath, "utf8");
  assert.ok(!fileContents.includes(accessToken));
  assert.ok(!fileContents.includes(refreshToken));
});

test("a record encrypted with one key cannot be decrypted with a different key (fails closed, not crashed)", () => {
  const filePath = tempStorePath();
  const firstKey = testKey();
  const first = new SwiggyTokenStore(filePath, firstKey);
  first.set("sender-1", { accessToken: "abc" });

  const secondKey = testKey();
  const second = new SwiggyTokenStore(filePath, secondKey);

  assert.equal(second.get("sender-1"), undefined);
});

test("constructor rejects a missing or wrong-length encryption key", () => {
  assert.throws(() => new SwiggyTokenStore(tempStorePath(), undefined));
  assert.throws(() => new SwiggyTokenStore(tempStorePath(), Buffer.alloc(16)));
  assert.throws(() => new SwiggyTokenStore(tempStorePath(), "not-a-buffer"));
});
