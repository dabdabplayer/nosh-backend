// Retry/error classification for Swiggy MCP tool calls, per
// https://mcp.swiggy.com/builders/docs/reference/errors.md and
// https://mcp.swiggy.com/builders/docs/operate/rate-limits.md (both
// re-verified against their raw content, not a summary).
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
//   - message starts with "Invalid "/"Missing "                        -> terminal
//   - HTTP 429                                                          -> rate_limited
//   - HTTP 504, HTTP 502/503, or message containing "timeout"           -> retry
//   - HTTP 500 or JSON-RPC -32603                                       -> retry-once
// Anything else is terminal rather than guessed at, since a wrong "retry"
// classification risks re-sending a request Swiggy already rejected for a
// reason that won't change.
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

  if (status === 401 || rpcCode === -32001 || message.includes("No or invalid session credentials")) {
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

      const attemptLimit = classification === "retry-once" ? 2 : maxAttempts;
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
