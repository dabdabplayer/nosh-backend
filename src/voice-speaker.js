// Turns one of Nosh's text replies into a spoken WhatsApp voice note, for
// people who sent a voice note themselves. The text reply is always sent as
// well (it carries the buttons and the exact prices); this is the same
// answer, spoken.
//
// Uses Google's Text-to-Speech API with a Gemini voice model, asking for
// OGG/Opus directly - the format WhatsApp shows as a voice note - so no
// audio conversion is needed.
// https://docs.cloud.google.com/text-to-speech/docs/gemini-tts
import { pick } from "./language-preference.js";
import { COMPONENTS, isOutageStatus, reportFailure, reportSuccess } from "./status-reporter.js";

const SYNTHESIZE_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";

// Replies longer than this (carts, order summaries, menus) are not read out
// in full: the first line is spoken, with a pointer to the message.
const MAX_SPOKEN_CHARS = 350;

const LANGUAGE_CODES = { en: "en-IN", hi: "hi-IN", hinglish: "hi-IN", punjabi: "pa-IN", pa: "pa-IN" };

// The words to say for a reply: no emoji or symbols a voice would stumble
// over, and only the gist of a long, list-like reply.
export function spokenVersion(text, lang = "en") {
  const cleaned = String(text ?? "")
    .replace(/\(Mock\)/gi, "")
    .replace(/⭐\s*/g, pick(lang, { en: "rated ", hi: "रेटिंग ", hinglish: "rating " }))
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.:;?!)])/g, "$1")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (cleaned.length === 0) {
    return "";
  }

  const whole = cleaned.join(". ").replace(/([.?!:,])\.\s/g, "$1 ");
  if (whole.length <= MAX_SPOKEN_CHARS) {
    return whole;
  }

  const pointer = pick(lang, {
    en: "The details are in the message.",
    hi: "पूरी जानकारी मैसेज में है।",
    hinglish: "Poori details message mein hain.",
  });
  return `${cleaned[0].slice(0, MAX_SPOKEN_CHARS)} ${pointer}`;
}

// getAuthHeaders: resolves to the headers that authenticate the call.
// model: a Gemini TTS model name, or undefined to use a plain named voice
// (voiceName is then a full voice name such as "hi-IN-Chirp3-HD-Kore", or a
// suffix like "Chirp3-HD-Kore" that gets the language code in front).
export function createVoiceSpeaker({ getAuthHeaders, model, voiceName, timeoutMs, fetchImpl = fetch, now = () => performance.now() }) {
  return {
    // Resolves to the spoken reply as OGG/Opus bytes, or undefined when
    // there is nothing to say. Throws when the call fails.
    async speak({ text, lang = "en" }) {
      const words = spokenVersion(text, lang);
      if (!words) {
        return undefined;
      }

      const languageCode = LANGUAGE_CODES[lang] ?? LANGUAGE_CODES.en;
      const voice = model
        ? { languageCode, name: voiceName, model_name: model }
        : { languageCode, name: /^[a-z]{2,3}-[A-Z]{2}-/.test(voiceName) ? voiceName : `${languageCode}-${voiceName}` };

      const startedAt = now();
      const elapsedMs = () => Math.round(now() - startedAt);
      let response;
      try {
        response = await fetchImpl(SYNTHESIZE_URL, {
          method: "POST",
          headers: { ...(await getAuthHeaders()), "Content-Type": "application/json" },
          body: JSON.stringify({ input: { text: words }, voice, audioConfig: { audioEncoding: "OGG_OPUS" } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        reportFailure(COMPONENTS.agent);
        console.warn("Voice reply synthesis failed.", { durationMs: elapsedMs(), errorName: error?.name });
        throw error;
      }

      if (!response.ok) {
        if (isOutageStatus(response.status)) {
          reportFailure(COMPONENTS.agent);
        }
        await response.body?.cancel();
        console.warn("Voice reply synthesis failed.", { durationMs: elapsedMs(), status: response.status });
        throw new Error(`Voice reply synthesis failed with status ${response.status}.`);
      }

      reportSuccess(COMPONENTS.agent);
      const body = await response.json();
      const audio = Buffer.from(body?.audioContent ?? "", "base64");
      if (audio.length === 0) {
        throw new Error("Voice reply synthesis returned no audio.");
      }

      // Timing and sizes only - never what was said.
      console.info("Voice reply synthesis succeeded.", { durationMs: elapsedMs(), characters: words.length, audioBytes: audio.length });
      return audio;
    },
  };
}
