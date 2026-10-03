import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceSpeaker, spokenVersion } from "../src/voice-speaker.js";

test("spokenVersion drops emoji, mock labels and symbols a voice would stumble over", () => {
  assert.equal(
    spokenVersion("📍 Got it, delivering to Home.\n\nHow about Veg Tacos (Mock) from Taco Fiesta (Mock) — ₹219 (⭐4, 25-30 mins)? Shall I add it?"),
    "Got it, delivering to Home. How about Veg Tacos from Taco Fiesta, ₹219 (rated 4, 25-30 mins)? Shall I add it?",
  );
  assert.equal(spokenVersion("   "), "");
});

test("spokenVersion speaks only the first line of a long, list-like reply and points to the message", () => {
  const summary = ["Order summary — Taco Fiesta (Mock):", ...Array.from({ length: 12 }, (_, n) => `${n + 1}x Item number ${n + 1} — ₹${100 + n}`), "Reply YES to place this order, or NO to cancel."].join("\n");

  assert.equal(spokenVersion(summary), "Order summary, Taco Fiesta: The details are in the message.");
  assert.equal(spokenVersion(summary, "hinglish"), "Order summary, Taco Fiesta: Poori details message mein hain.");
});

function speaker(options, respond) {
  const requests = [];
  const voice = createVoiceSpeaker({
    getAuthHeaders: async () => ({ Authorization: "Bearer token" }),
    timeoutMs: 1000,
    ...options,
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return respond();
    },
  });
  return { voice, requests };
}

const audioReply = () => new Response(JSON.stringify({ audioContent: Buffer.from("OggS-reply").toString("base64") }), { status: 200 });

test("speak asks the Gemini voice for OGG/Opus in the user's language and returns the audio", async () => {
  const { voice, requests } = speaker({ model: "gemini-3.1-flash-tts-preview", voiceName: "Kore" }, audioReply);

  const audio = await voice.speak({ text: "Veg Tacos add kar doon?", lang: "hinglish" });

  assert.equal(audio.toString(), "OggS-reply");
  assert.equal(requests[0].url, "https://texttospeech.googleapis.com/v1/text:synthesize");
  assert.equal(requests[0].headers.Authorization, "Bearer token");
  assert.deepEqual(requests[0].body, {
    input: { text: "Veg Tacos add kar doon?" },
    voice: { languageCode: "hi-IN", name: "Kore", model_name: "gemini-3.1-flash-tts-preview" },
    audioConfig: { audioEncoding: "OGG_OPUS" },
  });
});

test("speak can use a plain Google voice instead of a Gemini model", async () => {
  const { voice, requests } = speaker({ model: undefined, voiceName: "Chirp3-HD-Kore" }, audioReply);

  await voice.speak({ text: "Shall I add it?", lang: "en" });

  assert.deepEqual(requests[0].body.voice, { languageCode: "en-IN", name: "en-IN-Chirp3-HD-Kore" });
});

test("speak says nothing for an empty reply, and throws when the call fails or returns no audio", async () => {
  const empty = speaker({ model: "m", voiceName: "Kore" }, audioReply);
  assert.equal(await empty.voice.speak({ text: "🙂" }), undefined);
  assert.equal(empty.requests.length, 0);

  await assert.rejects(speaker({ model: "m", voiceName: "Kore" }, () => new Response("{}", { status: 403 })).voice.speak({ text: "hello" }));
  await assert.rejects(speaker({ model: "m", voiceName: "Kore" }, () => new Response("{}", { status: 200 })).voice.speak({ text: "hello" }));
});
