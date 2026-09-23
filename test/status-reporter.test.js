import assert from "node:assert/strict";
import test from "node:test";
import { createStatusReporter, isOutageStatus } from "../src/status-reporter.js";

function harness() {
  const requests = [];
  const sleeps = [];
  let clock = 0;
  const reporter = createStatusReporter({
    apiKey: "sp-key",
    pageId: "page-1",
    componentIds: { agent: "comp-agent", swiggy: undefined },
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { reporter, requests, sleeps };
}

async function settle(promise) {
  await promise;
}

test("the first success marks the component operational, later successes send nothing", async () => {
  const { reporter, requests } = harness();

  await settle(reporter.success("agent"));
  assert.equal(reporter.success("agent"), undefined);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.statuspage.io/v1/pages/page-1/components/comp-agent");
  assert.equal(requests[0].init.method, "PATCH");
  assert.equal(requests[0].init.headers.Authorization, "OAuth sp-key");
  assert.deepEqual(requests[0].body, { component: { status: "operational" } });
});

test("failures escalate to degraded after 2 and major outage after 5, and recovery needs 3 successes", async () => {
  const { reporter, requests } = harness();
  let last;

  for (let i = 0; i < 5; i += 1) {
    last = reporter.failure("agent") ?? last;
  }
  await settle(last);
  assert.deepEqual(
    requests.map((request) => request.body.component.status),
    ["degraded_performance", "major_outage"],
  );

  assert.equal(reporter.success("agent"), undefined);
  assert.equal(reporter.success("agent"), undefined);
  await settle(reporter.success("agent"));
  assert.equal(requests.at(-1).body.component.status, "operational");
  assert.equal(requests.length, 3);
});

test("a single failure between successes doesn't change the page", async () => {
  const { reporter, requests } = harness();

  await settle(reporter.success("agent"));
  assert.equal(reporter.failure("agent"), undefined);
  assert.equal(reporter.success("agent"), undefined);

  assert.equal(requests.length, 1);
});

test("updates are spaced at least a second apart to respect Statuspage's rate limit", async () => {
  const { reporter, sleeps } = harness();

  reporter.failure("agent");
  reporter.failure("agent");
  reporter.failure("agent");
  reporter.failure("agent");
  await settle(reporter.failure("agent"));

  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 1000);
});

test("components without an id are never reported", () => {
  const { reporter, requests } = harness();

  assert.equal(reporter.success("swiggy"), undefined);
  assert.equal(reporter.failure("whatsapp"), undefined);
  assert.equal(requests.length, 0);
});

test("a failed Statuspage request is logged, never thrown", async () => {
  const reporter = createStatusReporter({
    apiKey: "sp-key",
    pageId: "page-1",
    componentIds: { agent: "comp-agent" },
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });

  await assert.doesNotReject(reporter.success("agent"));
});

test("isOutageStatus counts no response, 5xx, auth and rate limits, but not other 4xx", () => {
  assert.equal(isOutageStatus(undefined), true);
  assert.equal(isOutageStatus(503), true);
  assert.equal(isOutageStatus(401), true);
  assert.equal(isOutageStatus(429), true);
  assert.equal(isOutageStatus(400), false);
  assert.equal(isOutageStatus(404), false);
});
