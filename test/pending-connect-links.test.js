import assert from "node:assert/strict";
import test from "node:test";
import { PendingConnectLinks } from "../src/pending-connect-links.js";
import { testStoreDeps } from "./helpers/fake-dynamodb-document-client.js";

test("create then take resolves the token to the sender it was issued for", async () => {
  const links = new PendingConnectLinks(testStoreDeps());
  const token = await links.create("sender-1");

  assert.deepEqual(await links.take(token), { senderId: "sender-1" });
});

test("take consumes the token - a second take returns undefined", async () => {
  const links = new PendingConnectLinks(testStoreDeps());
  const token = await links.create("sender-1");

  await links.take(token);

  assert.equal(await links.take(token), undefined);
});

test("take on an unknown token returns undefined", async () => {
  const links = new PendingConnectLinks(testStoreDeps());
  assert.equal(await links.take("never-issued"), undefined);
});

test("each created token is unique", async () => {
  const links = new PendingConnectLinks(testStoreDeps());
  const a = await links.create("sender-1");
  const b = await links.create("sender-1");

  assert.notEqual(a, b);
});
