import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SwiggyTokenStore } from "../src/swiggy-token-store.js";

function tempStorePath() {
  const dir = mkdtempSync(join(tmpdir(), "nosh-swiggy-token-store-"));
  return join(dir, "nested", "tokens.json");
}

test("get returns undefined for an unknown sender on a fresh store", () => {
  const store = new SwiggyTokenStore(tempStorePath());
  assert.equal(store.get("sender-1"), undefined);
});

test("set then get round-trips a token record", () => {
  const store = new SwiggyTokenStore(tempStorePath());
  const record = { accessToken: "abc", refreshToken: "def", expiresAt: 123 };

  store.set("sender-1", record);

  assert.deepEqual(store.get("sender-1"), record);
});

test("delete removes a stored token", () => {
  const store = new SwiggyTokenStore(tempStorePath());
  store.set("sender-1", { accessToken: "abc" });

  store.delete("sender-1");

  assert.equal(store.get("sender-1"), undefined);
});

test("persists across separate store instances pointed at the same file", () => {
  const filePath = tempStorePath();
  const first = new SwiggyTokenStore(filePath);
  first.set("sender-1", { accessToken: "abc" });

  const second = new SwiggyTokenStore(filePath);

  assert.deepEqual(second.get("sender-1"), { accessToken: "abc" });
});

test("tokens for different senders don't interfere with each other", () => {
  const store = new SwiggyTokenStore(tempStorePath());
  store.set("sender-1", { accessToken: "one" });
  store.set("sender-2", { accessToken: "two" });

  assert.deepEqual(store.get("sender-1"), { accessToken: "one" });
  assert.deepEqual(store.get("sender-2"), { accessToken: "two" });
});

test("the raw sender id (a phone number) is never written to disk in plaintext", () => {
  const filePath = tempStorePath();
  const store = new SwiggyTokenStore(filePath);
  const senderId = "+919220133162";

  store.set(senderId, { accessToken: "abc" });

  const fileContents = readFileSync(filePath, "utf8");
  assert.ok(!fileContents.includes(senderId));
  assert.ok(!fileContents.includes("9220133162"));
});
