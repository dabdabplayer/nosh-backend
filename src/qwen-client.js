import { COMPONENTS, isOutageStatus, reportFailure, reportSuccess } from "./status-reporter.js";

// Minimal client for Alibaba Cloud Model Studio's OpenAI-compatible Chat
// Completions endpoint (https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope).
// Exposes the same `chat.completions(request)` shape runAgentTurn calls, so
// tests can inject a fake client.
export class QwenApiError extends Error {
  constructor(status, code) {
    super(`Qwen chat completion failed with status ${status}${code ? ` (${code})` : ""}.`);
    this.name = "QwenApiError";
    this.status = status;
    this.code = code;
  }
}

export function createQwenClient({ apiKey, baseUrl, timeoutMs, fetchImpl = fetch }) {
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
          let code;
          try {
            code = (await response.json())?.error?.code;
          } catch {
            code = undefined;
          }
          throw new QwenApiError(response.status, typeof code === "string" ? code : undefined);
        }

        reportSuccess(COMPONENTS.agent);
        return response.json();
      },
    },
  };
}
