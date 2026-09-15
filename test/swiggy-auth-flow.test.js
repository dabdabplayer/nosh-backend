import assert from "node:assert/strict";
import test from "node:test";
import { buildConnectReplyText, resolveSwiggyAccessToken } from "../src/swiggy-auth-flow.js";

function fakeTokenStore(initial = {}) {
  const records = { ...initial };
  return {
    get: (senderId) => records[senderId],
    set: (senderId, record) => {
      records[senderId] = record;
    },
    delete: (senderId) => {
      delete records[senderId];
    },
    _records: records,
  };
}

test("returns unauthenticated when there's no stored token", async () => {
  const tokenStore = fakeTokenStore();

  const result = await resolveSwiggyAccessToken({
    senderId: "sender-1",
    tokenStore,
    authBaseUrl: "https://mcp.swiggy.com/auth",
  });

  assert.deepEqual(result, { status: "unauthenticated" });
});

test("returns the stored token as-is when it isn't expired, without refreshing", async () => {
  const tokenStore = fakeTokenStore({
    "sender-1": { accessToken: "valid-token", expiresAt: Date.now() + 10 * 60_000 },
  });
  let refreshCalled = false;

  const result = await resolveSwiggyAccessToken({
    senderId: "sender-1",
    tokenStore,
    authBaseUrl: "https://mcp.swiggy.com/auth",
    refreshImpl: async () => {
      refreshCalled = true;
      throw new Error("should not be called");
    },
  });

  assert.deepEqual(result, { status: "ok", accessToken: "valid-token" });
  assert.equal(refreshCalled, false);
});

test("refreshes an expired token and persists the new record", async () => {
  const tokenStore = fakeTokenStore({
    "sender-1": {
      accessToken: "old-token",
      refreshToken: "refresh-abc",
      expiresAt: Date.now() - 1000,
    },
  });

  const result = await resolveSwiggyAccessToken({
    senderId: "sender-1",
    tokenStore,
    authBaseUrl: "https://mcp.swiggy.com/auth",
    refreshImpl: async ({ refreshToken }) => {
      assert.equal(refreshToken, "refresh-abc");
      return { accessToken: "new-token", refreshToken: "refresh-abc", expiresAt: Date.now() + 432000000 };
    },
  });

  assert.deepEqual(result, { status: "ok", accessToken: "new-token" });
  assert.equal(tokenStore.get("sender-1").accessToken, "new-token");
});

test("treats a failed refresh as unauthenticated and clears the dead token", async () => {
  const tokenStore = fakeTokenStore({
    "sender-1": {
      accessToken: "old-token",
      refreshToken: "refresh-abc",
      expiresAt: Date.now() - 1000,
    },
  });

  const result = await resolveSwiggyAccessToken({
    senderId: "sender-1",
    tokenStore,
    authBaseUrl: "https://mcp.swiggy.com/auth",
    refreshImpl: async () => {
      throw new Error("refresh rejected");
    },
  });

  assert.deepEqual(result, { status: "unauthenticated" });
  assert.equal(tokenStore.get("sender-1"), undefined);
});

test("treats an expired token with no refresh token as unauthenticated without calling refreshImpl", async () => {
  const tokenStore = fakeTokenStore({
    "sender-1": { accessToken: "old-token", expiresAt: Date.now() - 1000 },
  });
  let refreshCalled = false;

  const result = await resolveSwiggyAccessToken({
    senderId: "sender-1",
    tokenStore,
    authBaseUrl: "https://mcp.swiggy.com/auth",
    refreshImpl: async () => {
      refreshCalled = true;
      return {};
    },
  });

  assert.deepEqual(result, { status: "unauthenticated" });
  assert.equal(refreshCalled, false);
  assert.equal(tokenStore.get("sender-1"), undefined);
});

test("buildConnectReplyText includes the connect URL and the search term", () => {
  const text = buildConnectReplyText({
    connectUrl: "http://localhost:3000/oauth/swiggy/start?token=abc",
    searchTerm: "biryani",
  });

  assert.match(text, /biryani/);
  assert.match(text, /http:\/\/localhost:3000\/oauth\/swiggy\/start\?token=abc/);
});
