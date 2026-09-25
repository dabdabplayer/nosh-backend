// Retry/error classification for Swiggy MCP tool calls, per
// https://mcp.swiggy.com/builders/docs/reference/errors.md,
// https://mcp.swiggy.com/builders/docs/operate/rate-limits.md, and
// https://mcp.swiggy.com/builders/docs/start/enterprise/delegated-auth/#error-handling-troubleshooting
// (all re-verified against their raw content, not a summary).
//
// Two @modelcontextprotocol/sdk quirks this depends on (confirmed by reading
// node_modules/@modelcontextprotocol/sdk/dist/esm/{types,client/streamableHttp}.js
// directly, not assumed):
//   - StreamableHTTPError carries the HTTP status on `.code` (NOT `.status`,
//     `.statusCode`, or `.response.status`).
//   - McpError ALSO carries its JSON-RPC error number on `.code` - the same
//     property name, a different kind of value. The two are told apart by
//     sign: an HTTP status is always positive, a JSON-RPC code here is
//     always negative (-32001, -32603, ...).
//   - Swiggy's -32001 is documented as "unauthenticated/expired session" -
//     this collides with the SDK's own generic enum name for -32001
//     (ErrorCode.RequestTimeout). Trust Swiggy's documented meaning for
//     their own server's codes, not the SDK's generic label.
//
// Symbolic string codes (UNAUTHENTICATED, RATE_LIMITED, etc.) are documented
// as "planned, not yet emitted" as of v1.0 - classify by message text and
// HTTP/JSON-RPC status instead:
//   - HTTP 401 / JSON-RPC -32001 / "No or invalid session credentials" -> reauth
//   - HTTP 419 (session revoked)                                       -> reauth
//   - message starts with "Invalid "/"Missing "                        -> terminal
//   - HTTP 429                                                          -> rate_limited
//   - HTTP 504, HTTP 502/503, or message containing "timeout"           -> retry
//   - HTTP 500 or JSON-RPC -32603                                       -> retry-once
// Anything else is terminal rather than guessed at, since a wrong "retry"
// classification risks re-sending a request Swiggy already rejected for a
// reason that won't change.
//
// 419 folds into the SAME "reauth" classification as 401, not a separate
// one - the delegated-auth doc's troubleshooting table describes a
// different underlying cause (401: token expired, silently re-authable;
// 419: session revoked, needs a full phone+OTP re-auth), but that
// distinction only matters on SWIGGY's own hosted authorize page, which
// decides silent-vs-OTP on its own; Nosh's side of the fix is identical for
// both: drop the stored token and let the next message trigger a fresh
// /oauth/swiggy/start (see server.js's SwiggyAuthFailureError catch).
// Confirmed via the delegated-auth doc that 401/419 are real MCP tool-call
// responses (e.g. calling https://mcp.swiggy.com/food), not OAuth-endpoint
// errors - this file, which wraps client.callTool, is the right place.
//
// HTTP 403 is deliberately NOT classified as reauth, despite errors.md
// documenting a planned INSUFFICIENT_SCOPE/403 meaning: the delegated-auth
// doc's own scopes section says v1 access control "is keyed at the user
// level, not at the application level" and finer-grained scopes "are not
// enforced today - requesting them has no effect" - and swiggy-oauth.js
// already requests all three v1 scopes uniformly on every authorize call,
// so there is no code path in this app that can produce an under-scoped
// token today. A bare HTTP 403 with no way to confirm it's really
// INSUFFICIENT_SCOPE (the symbolic error codes are "planned, not yet
// emitted", so there's no message text to key on either) is far more
// likely an infra/WAF/IP-allowlist denial (see AGENTS.md's Swiggy
// Production Access section on static IP/gateway ranges) - classifying
// that as reauth would make server.js delete a perfectly valid token
// (swiggyTokenStore.delete on the reauth path) and loop the user through a
// pointless reconnect on every message. Revisit once Swiggy actually emits
// the symbolic INSUFFICIENT_SCOPE code, matching on that specifically
// rather than on bare 403.
export class SwiggyAuthFailureError extends Error {
  constructor(cause) {
    super("Swiggy rejected the request as unauthenticated.");
    this.name = "SwiggyAuthFailureError";
    this.cause = cause;
  }
}

// Rate limiting is enforced today (confirmed live, not "planned" - an
// earlier version of this comment, copied from a stale doc summary, said
// otherwise). The SDK's StreamableHTTPError discards response headers, so
// Retry-After can't be read from the thrown error - fall back to a fixed
// wait matching the docs' own suggested default.
export class SwiggyRateLimitedError extends Error {
  constructor(cause) {
    super("Swiggy rate-limited this request.");
    this.name = "SwiggyRateLimitedError";
    this.cause = cause;
  }
}

const FALLBACK_RATE_LIMIT_WAIT_MS = 30_000;

function httpStatusOf(error) {
  const code = error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.code;
  return typeof code === "number" && code > 0 ? code : undefined;
}

function jsonRpcCodeOf(error) {
  const code = error?.code;
  return typeof code === "number" && code < 0 ? code : undefined;
}

export function classifySwiggyError(error) {
  const message = String(error?.message ?? "");
  const status = httpStatusOf(error);
  const rpcCode = jsonRpcCodeOf(error);

  if (status === 401 || status === 419 || rpcCode === -32001 || message.includes("No or invalid session credentials")) {
    return "reauth";
  }

  if (/^(Invalid|Missing)\s/.test(message)) {
    return "terminal";
  }

  if (status === 429) {
    return "rate_limited";
  }

  if (status === 504 || message.toLowerCase().includes("timeout")) {
    return "retry";
  }

  if (status === 502 || status === 503) {
    return "retry";
  }

  if (status === 500 || rpcCode === -32603 || message.includes("-32603")) {
    return "retry-once";
  }

  return "terminal";
}

const RETRY_BASE_MS = 500;
const RETRY_JITTER_RATIO = 0.3;

// Wraps a single Swiggy MCP tool call with the documented exponential
// backoff (500ms, 1s, 2s, 4s + jitter). Swiggy's own docs are inconsistent
// on the exact cap - ship-to-production.md's sample code defaults to 4
// total attempts, errors.md's prose says "cap at 5 retries" (5-6 total,
// depending on how "retries" is meant) - defaulting to the concrete sample
// code's value (4) rather than presenting false precision either way.
// Throws SwiggyAuthFailureError for a reauth classification and
// SwiggyRateLimitedError for a rate_limited one (after waiting out the
// window and exhausting attempts) so callers can tell those apart from
// every other failure; everything else is rethrown as-is once retries are
// exhausted or the error is classified as non-retryable.
export async function withSwiggyRetry(fn, { maxAttempts = 4, rateLimitWaitMs = FALLBACK_RATE_LIMIT_WAIT_MS } = {}) {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      const classification = classifySwiggyError(error);

      if (classification === "reauth") {
        throw new SwiggyAuthFailureError(error);
      }

      if (classification === "rate_limited") {
        if (attempt >= maxAttempts) {
          throw new SwiggyRateLimitedError(error);
        }
        await new Promise((resolve) => setTimeout(resolve, rateLimitWaitMs));
        continue;
      }

      const attemptLimit = classification === "retry-once" ? Math.min(2, maxAttempts) : maxAttempts;
      const isRetryable = classification === "retry" || classification === "retry-once";

      if (!isRetryable || attempt >= attemptLimit) {
        throw error;
      }

      const baseMs = RETRY_BASE_MS * 2 ** (attempt - 1);
      const jitterMs = Math.random() * baseMs * RETRY_JITTER_RATIO;
      await new Promise((resolve) => setTimeout(resolve, baseMs + jitterMs));
    }
  }
}

// True when a failed call may not have reached Swiggy or may have been
// dropped on the way back (timeouts, 5xx, rate limiting), so checking and
// possibly retrying makes sense. False for auth failures and for Swiggy
// answering with a real refusal (bad input, or a domain failure such as out
// of stock), which a retry can't change.
export function isTransientSwiggyFailure(error) {
  if (error instanceof SwiggyAuthFailureError) {
    return false;
  }
  if (error instanceof SwiggyRateLimitedError) {
    return true;
  }
  const cause = error?.name === "SwiggyFoodToolError" ? error.cause : error;
  if (cause?.isError) {
    return false;
  }
  return ["retry", "retry-once", "rate_limited"].includes(classifySwiggyError(cause));
}
