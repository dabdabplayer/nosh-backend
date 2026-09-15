import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  generatePkcePair,
  generateState,
  isTokenExpired,
  refreshAccessToken,
  SwiggyOAuthError,
} from "../src/swiggy-oauth.js";

function base64UrlEncode(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("generatePkcePair derives the challenge as SHA256(verifier), base64url-encoded", () => {
  const { verifier, challenge } = generatePkcePair();
  const expectedChallenge = base64UrlEncode(createHash("sha256").update(verifier).digest());

  assert.equal(challenge, expectedChallenge);
  assert.doesNotMatch(verifier, /[+/=]/);
  assert.doesNotMatch(challenge, /[+/=]/);
});

test("generatePkcePair and generateState produce different values each call", () => {
  const a = generatePkcePair();
  const b = generatePkcePair();

  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(generateState(), generateState());
});

test("buildAuthorizeUrl builds the documented query string", () => {
  const url = buildAuthorizeUrl({
    authBaseUrl: "https://mcp.swiggy.com/auth",
    clientId: "swiggy-mcp",
    redirectUri: "http://localhost:3000/oauth/swiggy/callback",
    codeChallenge: "challenge-123",
    state: "state-abc",
  });

  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://mcp.swiggy.com/auth/authorize");
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(parsed.searchParams.get("client_id"), "swiggy-mcp");
  assert.equal(parsed.searchParams.get("redirect_uri"), "http://localhost:3000/oauth/swiggy/callback");
  assert.equal(parsed.searchParams.get("code_challenge"), "challenge-123");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("state"), "state-abc");
  assert.equal(parsed.searchParams.get("scope"), "mcp:tools");
});

test("exchangeCodeForToken posts the documented body and parses the token response", async () => {
  const calls = [];
  const before = Date.now();

  const result = await exchangeCodeForToken(
    {
      authBaseUrl: "https://mcp.swiggy.com/auth",
      code: "auth-code",
      codeVerifier: "verifier-xyz",
      redirectUri: "http://localhost:3000/oauth/swiggy/callback",
    },
    async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, {
        access_token: "access-token-123",
        refresh_token: "refresh-token-456",
        expires_in: 432000,
        scope: "mcp:tools",
      });
    },
  );

  assert.equal(calls[0].url, "https://mcp.swiggy.com/auth/token");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    grant_type: "authorization_code",
    code: "auth-code",
    code_verifier: "verifier-xyz",
    redirect_uri: "http://localhost:3000/oauth/swiggy/callback",
  });
  assert.equal(result.accessToken, "access-token-123");
  assert.equal(result.refreshToken, "refresh-token-456");
  assert.equal(result.scope, "mcp:tools");
  assert.ok(result.expiresAt >= before + 432000 * 1000);
});

test("exchangeCodeForToken throws SwiggyOAuthError on a non-2xx response", async () => {
  await assert.rejects(
    exchangeCodeForToken(
      {
        authBaseUrl: "https://mcp.swiggy.com/auth",
        code: "bad-code",
        codeVerifier: "verifier",
        redirectUri: "http://localhost:3000/oauth/swiggy/callback",
      },
      async () => jsonResponse(400, { error: "invalid_grant", error_description: "invalid authorization code" }),
    ),
    (error) => {
      assert.ok(error instanceof SwiggyOAuthError);
      assert.equal(error.step, "token_exchange");
      assert.equal(error.error, "invalid_grant");
      return true;
    },
  );
});

test("refreshAccessToken posts a refresh_token grant", async () => {
  const calls = [];

  await refreshAccessToken(
    { authBaseUrl: "https://mcp.swiggy.com/auth", refreshToken: "refresh-token-456" },
    async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, { access_token: "new-token", expires_in: 432000 });
    },
  );

  assert.deepEqual(JSON.parse(calls[0].init.body), {
    grant_type: "refresh_token",
    refresh_token: "refresh-token-456",
  });
});

test("refreshAccessToken throws SwiggyOAuthError on failure", async () => {
  await assert.rejects(
    refreshAccessToken(
      { authBaseUrl: "https://mcp.swiggy.com/auth", refreshToken: "bad-refresh" },
      async () => jsonResponse(400, { error: "invalid_grant" }),
    ),
    (error) => {
      assert.ok(error instanceof SwiggyOAuthError);
      assert.equal(error.step, "refresh");
      return true;
    },
  );
});

test("isTokenExpired accounts for the skew window", () => {
  const almostExpired = { expiresAt: Date.now() + 30_000 };
  const comfortablyValid = { expiresAt: Date.now() + 10 * 60_000 };

  assert.equal(isTokenExpired(almostExpired), true);
  assert.equal(isTokenExpired(comfortablyValid), false);
});
