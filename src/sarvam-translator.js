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

// Every number in the English reply (prices, ratings, delivery times, list
// numbers) must survive translation. Sarvam has turned "Loaded Fries - ₹179"
// into "Loaded Fries kitne ke honge?" (how much would it be?), dropping the
// price, so a translation that loses one is not used. Devanagari digits
// count as the same number.
const DEVANAGARI_DIGITS = "०१२३४५६७८९";

function digitsOf(text) {
  const ascii = text.replace(/[०-९]/g, (digit) => String(DEVANAGARI_DIGITS.indexOf(digit)));
  return ascii.match(/\d+/g) ?? [];
}

export function keepsEveryNumber(original, translated) {
  const remaining = digitsOf(translated);
  for (const number of digitsOf(original)) {
    const index = remaining.indexOf(number);
    if (index === -1) {
      return false;
    }
    remaining.splice(index, 1);
  }
  return true;
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
      // The SDK retries 408/429/5xx on its own (default 2, with waits of up
      // to 60s). One retry is enough for a chat reply; translation falls
      // back to the untranslated text anyway.
      maxRetries: 1,
    });

  // One line per translation with timing only - never the text.
  async function translate(text, options) {
    const startedAt = performance.now();
    const direction = options.target_language_code === "en-IN" ? "to-english" : "from-english";
    let chunks = 0;
    try {
      const parts = [];
      for (const chunk of splitForTranslation(text)) {
        if (!chunk.trim()) {
          parts.push(chunk);
          continue;
        }
        const response = await sarvam.text.translate({ input: chunk, model: MODEL, ...options });
        parts.push(response.translated_text);
        chunks += 1;
      }
      reportSuccess(COMPONENTS.translation);
      console.info("Sarvam translation succeeded.", {
        durationMs: Math.round(performance.now() - startedAt),
        direction,
        chunks,
      });
      return parts.join("\n");
    } catch (error) {
      if (isOutageStatus(error?.statusCode)) {
        reportFailure(COMPONENTS.translation);
      }
      console.error("Sarvam translation failed; using the untranslated text.", {
        durationMs: Math.round(performance.now() - startedAt),
        direction,
        name: error?.name,
        status: error?.statusCode,
      });
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
      return translate(text, { source_language_code: "en-IN", ...options }).then((translated) => {
        if (keepsEveryNumber(text, translated)) {
          return translated;
        }
        console.warn("Sarvam translation dropped a number; sending the English reply instead.");
        return text;
      });
    },
  };
}
