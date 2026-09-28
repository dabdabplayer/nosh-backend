import assert from "node:assert/strict";
import test from "node:test";
import { createGeminiClient, GeminiApiError } from "../src/gemini-client.js";

test("createGeminiClient posts to the chat completions path with a bearer key", async () => {
  const calls = [];
  const client = createGeminiClient({
    apiKey: "key-1",
    baseUrl: "https://example.test/v1beta/openai/",
    timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
    },
  });

  const response = await client.chat.completions({ model: "gemini-3.8-flash", messages: [] });

  assert.equal(calls[0].url, "https://example.test/v1beta/openai/chat/completions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer key-1");
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "gemini-3.8-flash", messages: [] });
  assert.equal(response.choices[0].message.content, "hi");
});

test("createGeminiClient throws a GeminiApiError with only the status and error code", async () => {
  const client = createGeminiClient({
    apiKey: "key-1",
    baseUrl: "https://example.test/v1",
    timeoutMs: 1000,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "echo of user text" } }), { status: 401 }),
  });

  await assert.rejects(client.chat.completions({}), (error) => {
    assert.ok(error instanceof GeminiApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "invalid_api_key");
    assert.doesNotMatch(error.message, /echo of user text/);
    return true;
  });
});

test("createGeminiClient reads the error status when Gemini wraps the error in an array", async () => {
  const client = createGeminiClient({
    apiKey: "key-1",
    baseUrl: "https://example.test/v1beta/openai",
    timeoutMs: 1000,
    fetchImpl: async () =>
      new Response(JSON.stringify([{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } }]), { status: 429 }),
    sleep: async () => {},
  });

  await assert.rejects(client.chat.completions({}), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, "RESOURCE_EXHAUSTED");
    return true;
  });
});

function sequenceClient(responses, calls = []) {
  return createGeminiClient({
    apiKey: "key-1",
    baseUrl: "https://example.test/v1beta/openai",
    timeoutMs: 1000,
    sleep: async () => {},
    fetchImpl: async () => {
      const next = responses[calls.length];
      calls.push(next);
      if (next instanceof Error) {
        throw next;
      }
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
    },
  });
}

test("createGeminiClient retries once after a 503 and returns the successful answer", async () => {
  const calls = [];
  const client = sequenceClient([{ status: 503 }, { status: 200, body: { choices: [{ message: { content: "ok" } }] } }], calls);

  const response = await client.chat.completions({});

  assert.equal(response.choices[0].message.content, "ok");
  assert.equal(calls.length, 2);
});

test("createGeminiClient retries a failure at most once", async () => {
  const calls = [];
  const client = sequenceClient([{ status: 503 }, { status: 503 }, { status: 200 }], calls);

  await assert.rejects(client.chat.completions({}), (error) => error.status === 503);
  assert.equal(calls.length, 2);
});

test("createGeminiClient doesn't retry a request Gemini rejected", async () => {
  const calls = [];
  const client = sequenceClient([{ status: 400 }, { status: 200 }], calls);

  await assert.rejects(client.chat.completions({}), (error) => error.status === 400);
  assert.equal(calls.length, 1);
});

test("createGeminiClient retries a network error but not a timeout", async () => {
  const networkCalls = [];
  const recovering = sequenceClient(
    [new TypeError("fetch failed"), { status: 200, body: { choices: [] } }],
    networkCalls,
  );
  await recovering.chat.completions({});
  assert.equal(networkCalls.length, 2);

  const timeoutCalls = [];
  const timingOut = sequenceClient(
    [Object.assign(new Error("timed out"), { name: "TimeoutError" }), { status: 200 }],
    timeoutCalls,
  );
  await assert.rejects(timingOut.chat.completions({}), (error) => error.name === "TimeoutError");
  assert.equal(timeoutCalls.length, 1);
});

test("createGeminiClient sends a freshly fetched token on every call when given getAuthToken", async () => {
  const headers = [];
  let token = 0;
  const client = createGeminiClient({
    getAuthToken: async () => `vertex-token-${++token}`,
    baseUrl: "https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi",
    timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      headers.push([url, init.headers.Authorization]);
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    },
  });

  await client.chat.completions({});
  await client.chat.completions({});

  assert.deepEqual(headers, [
    ["https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi/chat/completions", "Bearer vertex-token-1"],
    ["https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi/chat/completions", "Bearer vertex-token-2"],
  ]);
});

test("createGeminiClient logs Google's explanation for a permission error, but not for other errors", async () => {
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const denied = sequenceClient([
      { status: 403, body: { error: { status: "PERMISSION_DENIED", message: "Permission 'aiplatform.endpoints.predict' denied on project p" } } },
    ]);
    await assert.rejects(denied.chat.completions({}));

    const badRequest = sequenceClient([{ status: 400, body: { error: { status: "INVALID_ARGUMENT", message: "echo of user text" } } }]);
    await assert.rejects(badRequest.chat.completions({}));
  } finally {
    console.error = originalError;
  }

  assert.equal(logged.length, 1);
  assert.match(logged[0][1].detail, /aiplatform\.endpoints\.predict/);
  assert.doesNotMatch(JSON.stringify(logged), /echo of user text/);
});

test("createGeminiClient logs each call's timing and token counts, never its content", async () => {
  const logged = [];
  const originalInfo = console.info;
  console.info = (...args) => logged.push(args);
  try {
    const client = sequenceClient([
      { status: 200, body: { choices: [{ message: { content: "secret reply" } }], usage: { prompt_tokens: 120, completion_tokens: 8 } } },
    ]);
    await client.chat.completions({ messages: [{ role: "user", content: "secret question" }] });
  } finally {
    console.info = originalInfo;
  }

  const line = logged.find(([message]) => message === "Gemini call succeeded.");
  assert.ok(line);
  assert.equal(line[1].attempts, 1);
  assert.equal(line[1].inputTokens, 120);
  assert.equal(line[1].outputTokens, 8);
  assert.equal(typeof line[1].durationMs, "number");
  assert.doesNotMatch(JSON.stringify(logged), /secret/);
});
