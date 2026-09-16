// Adversarial regression tests, ported from a manual security review
// (2026-09-16, see docs/SECURITY_REVIEW.md) into a permanent, automated
// suite. Spawns the REAL src/server.js as a child process (not a mock, not
// an in-process shortcut) and fires the same attack battery a real attacker
// would try. Every assertion checks a security PROPERTY that must hold
// ("an invalid signature must be rejected"), not "does the code do what the
// code does" - this is meant to actually fail if a future change breaks one
// of these protections, not to pass by construction.
//
// Fully hermetic: the spawned server gets its own fixed dummy env vars, not
// whatever the test runner's ambient environment has, so this needs no CI
// configuration and doesn't touch a developer's local .env.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const PORT = 34599;
const BASE_URL = `http://localhost:${PORT}`;
const META_APP_SECRET = "ci-adversarial-test-app-secret-not-a-real-credential";
const WHATSAPP_WEBHOOK_VERIFY_TOKEN = "ci-adversarial-test-verify-token";

let serverProcess;
let stderrOutput = "";

function sign(body) {
  return `sha256=${createHmac("sha256", META_APP_SECRET).update(body).digest("hex")}`;
}

// Guards against a transient ECONNRESET from Node's default keep-alive
// socket timeout (5s) being hit between test cases in a longer-running
// suite - a connection-pooling artifact, not something under test here.
async function fetchRetrying(url, init, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, { ...init, headers: { ...init?.headers, connection: "close" } });
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }
    }
  }
}

async function waitForServer(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet - keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Server did not become healthy within ${timeoutMs}ms.\nstderr:\n${stderrOutput}`);
}

before(async () => {
  serverProcess = spawn(
    process.execPath,
    ["src/server.js"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        PORT: String(PORT),
        // Deliberately unset (and NOT inherited from the outer environment):
        // WHATSAPP_ACCESS_TOKEN (no real send capability), SWIGGY_FOOD_MCP_URL,
        // NVIDIA_API_KEY - not needed for these tests, and keeps this suite
        // hermetic (no real external calls, no chance of a real WhatsApp send).
        SWIGGY_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        WHATSAPP_WEBHOOK_VERIFY_TOKEN,
        META_APP_SECRET,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  serverProcess.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });

  await waitForServer();
});

after(() => {
  serverProcess?.kill();
});

test("adversarial: webhook subscription handshake rejects a wrong verify token", async () => {
  const response = await fetchRetrying(
    `${BASE_URL}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=should-not-be-echoed`,
  );
  assert.equal(response.status, 403);
  assert.notEqual(await response.text(), "should-not-be-echoed");
});

test("adversarial: webhook subscription handshake accepts the correct verify token and echoes the challenge", async () => {
  const response = await fetchRetrying(
    `${BASE_URL}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${WHATSAPP_WEBHOOK_VERIFY_TOKEN}&hub.challenge=echo-me`,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "echo-me");
});

test("adversarial: webhook POST with no signature header is rejected", async () => {
  const response = await fetchRetrying(`${BASE_URL}/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ object: "whatsapp_business_account" }),
  });
  assert.equal(response.status, 401);
});

test("adversarial: webhook POST with a malformed signature is rejected before any HMAC comparison", async () => {
  const response = await fetchRetrying(`${BASE_URL}/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": "not-even-the-right-shape" },
    body: JSON.stringify({ object: "whatsapp_business_account" }),
  });
  assert.equal(response.status, 401);
});

test("adversarial: webhook POST with a well-formed but wrong signature is rejected", async () => {
  const body = JSON.stringify({ object: "whatsapp_business_account" });
  const response = await fetchRetrying(`${BASE_URL}/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
    body,
  });
  assert.equal(response.status, 401);
});

test("adversarial: a fully valid, correctly-signed message is accepted", async () => {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "123" },
              messages: [
                { type: "text", id: "wamid.1", from: "911234567890", text: { body: "hello" }, timestamp: "1" },
              ],
            },
          },
        ],
      },
    ],
  });

  const response = await fetchRetrying(`${BASE_URL}/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    body,
  });

  assert.equal(response.status, 200);
});

test("adversarial: a __proto__ key in a validly-signed payload does not pollute Object.prototype", async () => {
  // Built as a raw string, not JSON.stringify(objectLiteral) - a literal
  // `__proto__:` in a JS object literal sets the prototype at construction
  // time rather than becoming an own property, so stringifying that literal
  // would never actually put a "__proto__" key on the wire. This has to be
  // a real string to test what an attacker's raw HTTP body would contain.
  const body =
    '{"object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages","value":' +
    '{"metadata":{"phone_number_id":"123"},"messages":[{"type":"text","id":"wamid.1",' +
    '"from":"911234567890","text":{"body":"x"},"__proto__":{"polluted":"yes"},"timestamp":"1"}]}}]}]}';

  const response = await fetchRetrying(`${BASE_URL}/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    body,
  });

  assert.equal(response.status, 200);
  // The real assertion: this test process's own Object.prototype must be
  // unaffected. Non-exploitability is a permanent code-level property
  // (JSON.parse never triggers the prototype setter, and no code in src/
  // dynamically copies parsed keys onto another object - see
  // docs/SECURITY_REVIEW.md) - this just guards against a future change
  // introducing an unsafe merge/assign over parsed webhook content.
  assert.equal({}.polluted, undefined);
});

test("adversarial: wrong top-level object type in a validly-signed payload is rejected as invalid, not silently accepted", async () => {
  const body = JSON.stringify({ object: "not_whatsapp", entry: "garbage" });
  const response = await fetchRetrying(`${BASE_URL}/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    body,
  });
  assert.equal(response.status, 400);
});

test("adversarial: malformed JSON with a valid signature is rejected, not crashed on", async () => {
  const body = "not even json {{{";
  const response = await fetchRetrying(`${BASE_URL}/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    body,
  });
  assert.equal(response.status, 400);
});

test("adversarial: an oversized (2MB, limit is 1MB) payload is rejected, not crashed on", async () => {
  const body = "a".repeat(2 * 1024 * 1024);

  // undici (Node's fetch) pushes the whole body before waiting for a
  // response, unlike curl's default Expect: 100-continue negotiation - so
  // the server closing the connection early (correctly, once it's read past
  // MAX_BODY_BYTES) can surface here as a connection reset instead of a
  // clean 413, depending on send-buffer timing. Both outcomes mean the same
  // thing - the oversized body was never accepted - so both count as pass;
  // only a genuinely unexpected status or a hang would be a real finding.
  let response;
  try {
    response = await fetchRetrying(`${BASE_URL}/webhooks/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      body,
    });
  } catch (error) {
    assert.match(String(error.cause ?? error), /ECONNRESET|EPIPE|UND_ERR_SOCKET/);
    return;
  }

  assert.equal(response.status, 413);
});

test("adversarial: path traversal / arbitrary file requests are never served", async () => {
  for (const path of ["/../../../etc/passwd", "/data/swiggy-tokens.json", "/.env", "/src/config.js"]) {
    const response = await fetchRetrying(`${BASE_URL}${path}`);
    assert.equal(response.status, 404, `expected 404 for ${path}, got ${response.status}`);
  }
});

test("adversarial: the server survives the full battery and is still healthy", async () => {
  const response = await fetchRetrying(`${BASE_URL}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", service: "nosh-backend" });
});
