import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySwiggyError,
  SwiggyAuthFailureError,
  SwiggyRateLimitedError,
  withSwiggyRetry,
} from "../src/swiggy-retry.js";

test("classifySwiggyError: auth failure message classifies as reauth", () => {
  assert.equal(classifySwiggyError(new Error("No or invalid session credentials")), "reauth");
});

// Real @modelcontextprotocol/sdk shapes (confirmed by reading the SDK source,
// not assumed): StreamableHTTPError puts the HTTP status on `.code`, McpError
// puts its JSON-RPC error number on the same property name. A positive `.code`
// is an HTTP status; a negative one is a JSON-RPC code.
test("classifySwiggyError: StreamableHTTPError-shaped 401 (status on .code) classifies as reauth", () => {
  assert.equal(classifySwiggyError({ message: "unauthorized", code: 401 }), "reauth");
});

test("classifySwiggyError: McpError-shaped -32001 (Swiggy's documented auth-failure code) classifies as reauth", () => {
  assert.equal(classifySwiggyError({ message: "MCP error -32001: session expired", code: -32001 }), "reauth");
});

test("classifySwiggyError: McpError-shaped -32603 classifies as retry-once", () => {
  assert.equal(classifySwiggyError({ message: "MCP error -32603: internal", code: -32603 }), "retry-once");
});

test("classifySwiggyError: HTTP 429 (on .code, StreamableHTTPError-shaped) classifies as rate_limited", () => {
  assert.equal(classifySwiggyError({ message: "too many requests", code: 429 }), "rate_limited");
});

test("classifySwiggyError: HTTP 504 classifies as retry", () => {
  assert.equal(classifySwiggyError({ message: "gateway timeout", code: 504 }), "retry");
});

test("classifySwiggyError: Invalid/Missing prefixed messages classify as terminal", () => {
  assert.equal(classifySwiggyError(new Error("Invalid addressId")), "terminal");
  assert.equal(classifySwiggyError(new Error("Missing query")), "terminal");
});

test("classifySwiggyError: timeout message classifies as retry", () => {
  assert.equal(classifySwiggyError(new Error("upstream request timeout")), "retry");
});

test("classifySwiggyError: HTTP 502/503 classify as retry", () => {
  assert.equal(classifySwiggyError({ message: "bad gateway", status: 502 }), "retry");
  assert.equal(classifySwiggyError({ message: "unavailable", status: 503 }), "retry");
});

test("classifySwiggyError: HTTP 500 or -32603 classify as retry-once", () => {
  assert.equal(classifySwiggyError({ message: "server error", status: 500 }), "retry-once");
  assert.equal(classifySwiggyError(new Error("JSON-RPC -32603 internal error")), "retry-once");
});

test("classifySwiggyError: unrecognized errors are terminal, not guessed as retryable", () => {
  assert.equal(classifySwiggyError(new Error("something unexpected")), "terminal");
});

test("withSwiggyRetry: succeeds without retrying on first success", async () => {
  let calls = 0;
  const result = await withSwiggyRetry(async () => {
    calls += 1;
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withSwiggyRetry: retries a retryable failure and eventually succeeds", async () => {
  let calls = 0;
  const result = await withSwiggyRetry(async () => {
    calls += 1;
    if (calls < 3) {
      throw new Error("timeout");
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withSwiggyRetry: throws SwiggyAuthFailureError immediately on a reauth classification, without retrying", async () => {
  let calls = 0;

  await assert.rejects(
    () =>
      withSwiggyRetry(async () => {
        calls += 1;
        throw new Error("No or invalid session credentials");
      }),
    SwiggyAuthFailureError,
  );

  assert.equal(calls, 1);
});

test("withSwiggyRetry: does not retry a terminal error", async () => {
  let calls = 0;

  await assert.rejects(
    () =>
      withSwiggyRetry(async () => {
        calls += 1;
        throw new Error("Invalid input");
      }),
    /Invalid input/,
  );

  assert.equal(calls, 1);
});

test("withSwiggyRetry: retry-once errors stop after two attempts", async () => {
  let calls = 0;

  await assert.rejects(
    () =>
      withSwiggyRetry(async () => {
        calls += 1;
        throw new Error("JSON-RPC -32603 internal error");
      }),
    /-32603/,
  );

  assert.equal(calls, 2);
});

test("withSwiggyRetry: gives up after maxAttempts on a repeatedly retryable failure", async () => {
  let calls = 0;

  await assert.rejects(
    () =>
      withSwiggyRetry(
        async () => {
          calls += 1;
          throw new Error("timeout");
        },
        { maxAttempts: 2 },
      ),
    /timeout/,
  );

  assert.equal(calls, 2);
});

test("withSwiggyRetry: throws SwiggyRateLimitedError after exhausting attempts on a 429", async () => {
  let calls = 0;

  await assert.rejects(
    () =>
      withSwiggyRetry(
        async () => {
          calls += 1;
          throw { message: "rate limited", code: 429 };
        },
        { maxAttempts: 2, rateLimitWaitMs: 1 },
      ),
    SwiggyRateLimitedError,
  );

  assert.equal(calls, 2);
});
