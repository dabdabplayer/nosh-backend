// Retry/error classification for Swiggy MCP tool calls.
//
// Symbolic error codes (UNAUTHENTICATED, RATE_LIMITED, etc.) are documented
// as "planned, not yet emitted" - see
// https://mcp.swiggy.com/builders/docs/reference/errors.md. Today, failures
// have to be classified by message text and HTTP status instead:
//   - "No or invalid session credentials"      -> reauth (not retryable)
//   - message starts with "Invalid "/"Missing " -> terminal (bad input)
//   - message contains "timeout"                -> retry, backoff, max 5
//   - HTTP 502/503                               -> retry, backoff, max 5
//   - HTTP 500 or JSON-RPC -32603                -> retry once, then escalate
// Anything else is treated as terminal rather than guessed at, since a wrong
// "retry" classification risks re-sending a request Swiggy already rejected
// for a reason that won't change.
export class SwiggyAuthFailureError extends Error {
  constructor(cause) {
    super("Swiggy rejected the request as unauthenticated.");
    this.name = "SwiggyAuthFailureError";
    this.cause = cause;
  }
}

function statusOf(error) {
  return error?.status ?? error?.statusCode ?? error?.response?.status;
}

export function classifySwiggyError(error) {
  const message = String(error?.message ?? "");
  const status = statusOf(error);

  if (message.includes("No or invalid session credentials")) {
    return "reauth";
  }

  if (/^(Invalid|Missing)\s/.test(message)) {
    return "terminal";
  }

  if (message.toLowerCase().includes("timeout")) {
    return "retry";
  }

  if (status === 502 || status === 503) {
    return "retry";
  }

  if (status === 500 || message.includes("-32603")) {
    return "retry-once";
  }

  return "terminal";
}

const RETRY_BASE_MS = 500;
const RETRY_JITTER_RATIO = 0.3;

// Wraps a single Swiggy MCP tool call with the documented exponential
// backoff (500ms, 1s, 2s, 4s + jitter). Throws SwiggyAuthFailureError for a
// reauth classification so callers can distinguish "needs reconnect" from
// every other failure; everything else is rethrown as-is once retries are
// exhausted or the error is classified as non-retryable.
export async function withSwiggyRetry(fn, { maxAttempts = 4 } = {}) {
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
