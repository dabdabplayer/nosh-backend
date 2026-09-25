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
  });

  await assert.rejects(client.chat.completions({}), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, "RESOURCE_EXHAUSTED");
    return true;
  });
});
