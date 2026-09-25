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

export function createGeminiClient({ apiKey, baseUrl, timeoutMs, fetchImpl = fetch }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    chat: {
      async completions(request) {
        let response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          reportFailure(COMPONENTS.agent);
          throw error;
        }

        if (!response.ok) {
          if (isOutageStatus(response.status)) {
            reportFailure(COMPONENTS.agent);
          }
          // Only the status and the provider's error code are surfaced - the
          // error body can echo request content, which stays out of logs.
          // Gemini sometimes wraps the error object in a one-element array.
          let code;
          try {
            const body = await response.json();
            const error = Array.isArray(body) ? body[0]?.error : body?.error;
            code = error?.status ?? error?.code;
          } catch {
            code = undefined;
          }
          throw new GeminiApiError(response.status, typeof code === "string" ? code : undefined);
        }

        reportSuccess(COMPONENTS.agent);
        return response.json();
      },
    },
  };
}
