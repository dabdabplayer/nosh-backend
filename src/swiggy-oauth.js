import { createHash, randomBytes } from "node:crypto";

// Swiggy MCP OAuth 2.1 + PKCE flow, verified live against
// https://mcp.swiggy.com/.well-known/oauth-authorization-server and by
// exercising /auth/authorize and /auth/token directly:
//   authorize: GET  {authBaseUrl}/authorize
//   token:     POST {authBaseUrl}/token  (JSON body)
// The token endpoint's metadata advertises a "refresh_token" grant, but
// Swiggy's own prose docs say refresh issuance isn't wired yet - so refresh
// is attempted opportunistically and callers must fall back to a fresh
// authorize flow on failure rather than assuming either claim.

export class SwiggyOAuthError extends Error {
  constructor(step, body) {
    super(`Swiggy OAuth ${step} failed: ${body?.error ?? "unknown_error"}`);
    this.name = "SwiggyOAuthError";
    this.step = step;
    this.error = body?.error;
    this.errorDescription = body?.error_description;
  }
}

function base64UrlEncode(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Per the docs: verifier = random 32 bytes (base64url), challenge =
// SHA256(verifier) (base64url), method S256.
export function generatePkcePair() {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function generateState() {
  return base64UrlEncode(randomBytes(16));
}

export function buildAuthorizeUrl({ authBaseUrl, clientId, redirectUri, codeChallenge, state, scope }) {
  const url = new URL(`${authBaseUrl}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  // Requests all three v1 scopes uniformly, per the go-live checklist's
  // "v1 scopes are requested uniformly" requirement - Nosh only calls tools
  // today, but the checklist asks for all three regardless, and Swiggy's own
  // documented token response example grants all three back even when only
  // mcp:tools was requested (scopes are server-level, not finely enforced in
  // v1 per the auth docs), so this costs nothing and matches what's asked.
  url.searchParams.set("scope", scope ?? "mcp:tools mcp:resources mcp:prompts");
  return url.toString();
}

function tokenRecordFromResponse(body) {
  return Object.freeze({
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    scope: body.scope,
  });
}

async function postToken(authBaseUrl, payload, step, fetchImpl) {
  const response = await fetchImpl(`${authBaseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    throw new SwiggyOAuthError(step, body);
  }

  return tokenRecordFromResponse(body);
}

export async function exchangeCodeForToken(
  { authBaseUrl, code, codeVerifier, redirectUri },
  fetchImpl = fetch,
) {
  return postToken(
    authBaseUrl,
    { grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirectUri },
    "token_exchange",
    fetchImpl,
  );
}

// Opportunistic: the server's metadata advertises this grant, but Swiggy's
// docs say it isn't wired yet. Callers must catch SwiggyOAuthError and fall
// back to a fresh authorize flow rather than assuming this succeeds.
export async function refreshAccessToken({ authBaseUrl, refreshToken }, fetchImpl = fetch) {
  return postToken(
    authBaseUrl,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    "refresh",
    fetchImpl,
  );
}

export function isTokenExpired(tokenRecord, { skewMs = 60_000 } = {}) {
  return tokenRecord.expiresAt - skewMs <= Date.now();
}
