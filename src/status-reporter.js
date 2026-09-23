// Pushes component health to an Atlassian Statuspage page
// (PATCH https://api.statuspage.io/v1/pages/{page_id}/components/{component_id},
// body {"component": {"status": ...}}). Statuspage allows 1 request/second
// per API key, so a request is only sent when a component's status actually
// changes, and requests are spaced out one at a time.
//
// Nothing here ever throws or delays the caller: reporting is fire-and-forget.

const API_BASE_URL = "https://api.statuspage.io/v1";
const MIN_REQUEST_SPACING_MS = 1100;

// Consecutive-outcome thresholds, so one blip doesn't flip a public page.
const DEGRADED_AFTER_FAILURES = 2;
const MAJOR_OUTAGE_AFTER_FAILURES = 5;
const OPERATIONAL_AFTER_SUCCESSES = 3;

export const COMPONENTS = Object.freeze({
  swiggy: "swiggy",
  agent: "agent",
  translation: "translation",
  whatsapp: "whatsapp",
});

// A failure only counts when it says the service itself is unhealthy: no
// response at all (network error, timeout), a server error, rate limiting,
// or rejected credentials. Other 4xx responses are about one request.
export function isOutageStatus(status) {
  return status === undefined || status >= 500 || status === 401 || status === 403 || status === 429;
}

export function createStatusReporter({ apiKey, pageId, componentIds, fetchImpl = fetch, now = Date.now, sleep }) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const states = new Map();
  let queue = Promise.resolve();
  let lastRequestAt = -Infinity;

  function send(componentId, status) {
    queue = queue.then(async () => {
      const elapsed = now() - lastRequestAt;
      if (elapsed < MIN_REQUEST_SPACING_MS) {
        await wait(MIN_REQUEST_SPACING_MS - elapsed);
      }
      lastRequestAt = now();

      try {
        const response = await fetchImpl(`${API_BASE_URL}/pages/${pageId}/components/${componentId}`, {
          method: "PATCH",
          headers: { Authorization: `OAuth ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ component: { status } }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          console.error("Statuspage component update failed.", { componentId, status, httpStatus: response.status });
        }
      } catch (error) {
        console.error("Statuspage component update failed.", { componentId, status, name: error?.name });
      }
    });
    return queue;
  }

  function record(component, ok) {
    const componentId = componentIds[component];
    if (!componentId) {
      return undefined;
    }

    // Status starts unknown, so the first success after a restart clears
    // whatever an earlier process left on the page.
    const state = states.get(component) ?? { status: undefined, failures: 0, successes: 0 };
    if (ok) {
      state.successes += 1;
      state.failures = 0;
    } else {
      state.failures += 1;
      state.successes = 0;
    }

    let next = state.status;
    if (!ok && state.failures >= MAJOR_OUTAGE_AFTER_FAILURES) {
      next = "major_outage";
    } else if (!ok && state.failures >= DEGRADED_AFTER_FAILURES && state.status !== "major_outage") {
      next = "degraded_performance";
    } else if (ok && (state.status === undefined || state.successes >= OPERATIONAL_AFTER_SUCCESSES)) {
      next = "operational";
    }

    states.set(component, state);
    if (next === state.status) {
      return undefined;
    }
    state.status = next;
    console.warn("Component status changed.", { component, status: next });
    return send(componentId, next);
  }

  return {
    success: (component) => record(component, true),
    failure: (component) => record(component, false),
  };
}

let activeReporter;

export function configureStatusReporter(reporter) {
  activeReporter = reporter;
}

export function reportSuccess(component) {
  activeReporter?.success(component);
}

export function reportFailure(component) {
  activeReporter?.failure(component);
}
