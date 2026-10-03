import assert from "node:assert/strict";
import test from "node:test";
import {
  createVertexTokenProvider,
  parseServiceAccountKey,
  vertexModelName,
  vertexOpenAiBaseUrl,
} from "../src/vertex-auth.js";

const key = {
  type: "service_account",
  project_id: "nosh-prod",
  client_email: "nosh@nosh-prod.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
};

test("parseServiceAccountKey accepts a service account key and keeps only what's needed", () => {
  const parsed = parseServiceAccountKey(JSON.stringify({ ...key, private_key_id: "x", extra: 1 }));
  assert.deepEqual(parsed, key);
});

test("parseServiceAccountKey rejects other credential types and malformed input", () => {
  assert.throws(() => parseServiceAccountKey("not json"), /JSON contents/);
  assert.throws(
    () => parseServiceAccountKey(JSON.stringify({ type: "external_account", credential_source: { executable: {} } })),
    /service_account/,
  );
  assert.throws(() => parseServiceAccountKey(JSON.stringify({ ...key, private_key: undefined })), /service_account/);
});

test("vertexOpenAiBaseUrl builds the global and regional OpenAI-compatible endpoints", () => {
  assert.equal(
    vertexOpenAiBaseUrl({ projectId: "nosh-prod", location: "global" }),
    "https://aiplatform.googleapis.com/v1/projects/nosh-prod/locations/global/endpoints/openapi",
  );
  assert.equal(
    vertexOpenAiBaseUrl({ projectId: "nosh-prod", location: "us-central1" }),
    "https://us-central1-aiplatform.googleapis.com/v1/projects/nosh-prod/locations/us-central1/endpoints/openapi",
  );
});

test("vertexModelName adds Google's publisher prefix only when missing", () => {
  assert.equal(vertexModelName("gemini-3.5-flash-lite"), "google/gemini-3.5-flash-lite");
  assert.equal(vertexModelName("google/gemini-3.5-flash-lite"), "google/gemini-3.5-flash-lite");
});

test("createVertexTokenProvider gets tokens from GoogleAuth with the cloud-platform scope, creating it once", async () => {
  const constructed = [];
  let tokenCalls = 0;
  const loadGoogleAuth = async () => ({
    GoogleAuth: class {
      constructor(options) {
        constructed.push(options);
      }
      async getAccessToken() {
        tokenCalls += 1;
        return `token-${tokenCalls}`;
      }
    },
  });

  const getToken = createVertexTokenProvider(key, { loadGoogleAuth });

  assert.equal(await getToken(), "token-1");
  assert.equal(await getToken(), "token-2");
  assert.equal(constructed.length, 1);
  assert.deepEqual(constructed[0], { credentials: key, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
});

test("createVertexTokenProvider starts over after a failed token fetch", async () => {
  let attempts = 0;
  const loadGoogleAuth = async () => ({
    GoogleAuth: class {
      async getAccessToken() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("network");
        }
        return "token";
      }
    },
  });

  const getToken = createVertexTokenProvider(key, { loadGoogleAuth });

  await assert.rejects(getToken());
  assert.equal(await getToken(), "token");
});

test("vertexGenerateContentUrl builds the model's native URL, with or without the google/ prefix", async () => {
  const { vertexGenerateContentUrl } = await import("../src/vertex-auth.js");
  assert.equal(
    vertexGenerateContentUrl({ projectId: "p1", location: "global", model: "google/gemini-3.5-flash-lite" }),
    "https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/google/models/gemini-3.5-flash-lite:generateContent",
  );
  assert.equal(
    vertexGenerateContentUrl({ projectId: "p1", location: "asia-south1", model: "gemini-3.5-flash-lite" }),
    "https://asia-south1-aiplatform.googleapis.com/v1/projects/p1/locations/asia-south1/publishers/google/models/gemini-3.5-flash-lite:generateContent",
  );
});
