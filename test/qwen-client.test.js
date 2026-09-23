import assert from "node:assert/strict";
import test from "node:test";
import { createQwenClient, QwenApiError } from "../src/qwen-client.js";

test("createQwenClient posts to the chat completions path with a bearer key", async () => {
  const calls = [];
  const client = createQwenClient({
    apiKey: "key-1",
    baseUrl: "https://example.test/compatible-mode/v1/",
    timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
    },
  });

  const response = await client.chat.completions({ model: "qwen3.8-flash", messages: [] });

  assert.equal(calls[0].url, "https://example.test/compatible-mode/v1/chat/completions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer key-1");
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "qwen3.8-flash", messages: [] });
  assert.equal(response.choices[0].message.content, "hi");
});

test("createQwenClient throws a QwenApiError with only the status and error code", async () => {
  const client = createQwenClient({
    apiKey: "key-1",
    baseUrl: "https://example.test/v1",
    timeoutMs: 1000,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "echo of user text" } }), { status: 401 }),
  });

  await assert.rejects(client.chat.completions({}), (error) => {
    assert.ok(error instanceof QwenApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "invalid_api_key");
    assert.doesNotMatch(error.message, /echo of user text/);
    return true;
  });
});
