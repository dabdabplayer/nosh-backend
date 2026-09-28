import { COMPONENTS, isOutageStatus, reportFailure, reportSuccess } from "./status-reporter.js";

// Minimal client for the Gemini API's OpenAI-compatible Chat Completions
// endpoint (https://ai.google.dev/gemini-api/docs/openai). Exposes the same
// `chat.completions(request)` shape runAgentTurn calls, so tests can inject
// a fake client.
export class GeminiApiError extends Error {
  constructor(status, code) {
    super(`Gemini chat completion failed with status ${status}${code ? ` (${code})` : ""}.`);
    this.name = "GeminiApiError";
    this.status = status;
    this.code = code;
  }
}

// Asking the model the same thing again has no side effects, so a failed
// call is retried once when the failure is likely temporary: rate limiting,
// a server error (Gemini's 503 "UNAVAILABLE" when overloaded), or a
// network error. A timeout is not retried - it has already used up the
// whole per-call budget.
const MAX_ATTEMPTS = 2;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 5000;

function isTimeout(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError";
}

function retryDelayMs(response) {
  const retryAfterSeconds = Number(response?.headers?.get?.("retry-after"));
  const base =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : DEFAULT_RETRY_DELAY_MS;
  return Math.min(base, MAX_RETRY_DELAY_MS) + Math.random() * 250;
}

async function errorCodeOf(response) {
  // Only the status and the provider's error code are surfaced - the error
  // body can echo request content, which stays out of logs. Gemini
  // sometimes wraps the error object in a one-element array.
  try {
    const body = await response.json();
    const error = Array.isArray(body) ? body[0]?.error : body?.error;
    const code = error?.status ?? error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

// `apiKey` for the Gemini API; `getAuthToken` (an async function) for
// Vertex AI, whose access tokens expire and are refreshed between calls.
export function createGeminiClient({
  apiKey,
  getAuthToken = async () => apiKey,
  baseUrl,
  timeoutMs,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  async function attempt(request) {
    const token = await getAuthToken();
    return fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    chat: {
      async completions(request) {
        for (let attemptNumber = 1; ; attemptNumber += 1) {
          const isLastAttempt = attemptNumber >= MAX_ATTEMPTS;

          let response;
          try {
            response = await attempt(request);
          } catch (error) {
            if (isLastAttempt || isTimeout(error)) {
              reportFailure(COMPONENTS.agent);
              throw error;
            }
            console.warn("Retrying Gemini call after a network error.", { name: error?.name });
            await sleep(retryDelayMs());
            continue;
          }

          if (response.ok) {
            reportSuccess(COMPONENTS.agent);
            return response.json();
          }

          if (!isLastAttempt && RETRYABLE_STATUSES.has(response.status)) {
            console.warn("Retrying Gemini call.", { status: response.status });
            await response.body?.cancel();
            await sleep(retryDelayMs(response));
            continue;
          }

          if (isOutageStatus(response.status)) {
            reportFailure(COMPONENTS.agent);
          }
          throw new GeminiApiError(response.status, await errorCodeOf(response));
        }
      },
    },
  };
}
