import { SarvamAIClient } from "sarvamai";
import { COMPONENTS, isOutageStatus, reportFailure, reportSuccess } from "./status-reporter.js";

// mayura:v1 is the Sarvam translate model that supports source "auto",
// code-mixed mode and romanized output (see TranslationRequest in the
// sarvamai SDK's types).
const MODEL = "mayura:v1";
const MAX_INPUT_CHARS = 1000;

const OUTBOUND_OPTIONS = {
  hi: { target_language_code: "hi-IN", mode: "modern-colloquial" },
  hinglish: { target_language_code: "hi-IN", mode: "code-mixed", output_script: "roman" },
};

// Splits on line breaks so a numbered list is never cut mid-item; a single
// line over the limit is split on the last space before it.
export function splitForTranslation(text, maxChars = MAX_INPUT_CHARS) {
  const chunks = [];
  let current = "";

  const pushLine = (line) => {
    let rest = line;
    while (rest.length > maxChars) {
      const cut = rest.lastIndexOf(" ", maxChars);
      const at = cut > 0 ? cut : maxChars;
      chunks.push(rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    return rest;
  };

  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    current = pushLine(line);
  }
  chunks.push(current);

  return chunks;
}

// Translation is best-effort: on any failure the original text is returned,
// since an untranslated reply is better than none. Nothing here decides
// what the user asked for - YES/NO and numbered replies never reach it.
export function createSarvamTranslator({ apiKey, baseUrl, timeoutMs, client }) {
  const sarvam =
    client ??
    new SarvamAIClient({
      apiSubscriptionKey: apiKey,
      baseUrl,
      timeoutInSeconds: Math.ceil(timeoutMs / 1000),
    });

  async function translate(text, options) {
    try {
      const parts = [];
      for (const chunk of splitForTranslation(text)) {
        if (!chunk.trim()) {
          parts.push(chunk);
          continue;
        }
        const response = await sarvam.text.translate({ input: chunk, model: MODEL, ...options });
        parts.push(response.translated_text);
      }
      reportSuccess(COMPONENTS.translation);
      return parts.join("\n");
    } catch (error) {
      if (isOutageStatus(error?.statusCode)) {
        reportFailure(COMPONENTS.translation);
      }
      console.error("Sarvam translation failed; using the untranslated text.", { name: error?.name });
      return text;
    }
  }

  return {
    // lang is the detected language of this specific message.
    toEnglish(text, lang) {
      if (lang !== "hi" && lang !== "hinglish") {
        return Promise.resolve(text);
      }
      return translate(text, {
        source_language_code: lang === "hi" ? "hi-IN" : "auto",
        target_language_code: "en-IN",
      });
    },
    fromEnglish(text, lang) {
      const options = OUTBOUND_OPTIONS[lang];
      if (!options || !text) {
        return Promise.resolve(text);
      }
      return translate(text, { source_language_code: "en-IN", ...options });
    },
  };
}
