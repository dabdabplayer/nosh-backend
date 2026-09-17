import assert from "node:assert/strict";
import test from "node:test";
import { PendingConnectLinks } from "../src/pending-connect-links.js";

test("create then take resolves the token to the sender it was issued for", () => {
  const links = new PendingConnectLinks();
  const token = links.create("sender-1");

  assert.deepEqual(links.take(token), { senderId: "sender-1" });
});

test("take consumes the token - a second take returns undefined", () => {
  const links = new PendingConnectLinks();
  const token = links.create("sender-1");

  links.take(token);

  assert.equal(links.take(token), undefined);
});

test("take on an unknown token returns undefined", () => {
  const links = new PendingConnectLinks();
  assert.equal(links.take("never-issued"), undefined);
});

test("each created token is unique", () => {
  const links = new PendingConnectLinks();
  const a = links.create("sender-1");
  const b = links.create("sender-1");

  assert.notEqual(a, b);
});
