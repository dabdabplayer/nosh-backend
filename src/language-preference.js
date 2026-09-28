// Deterministic (non-LLM) language detection + per-sender persistence, used
// ONLY by the hardcoded/deterministic reply paths - checkout, cart view,
// coupons, address prompts, order confirmation outcomes (see AGENTS.md's
// 2026-09-21 "place order and get address should be hardcoded" decision).
// The agent-phrased paths (search, recommend, add/remove from cart) already
// mirror the CURRENT message's language on their own via the LLM's own
// judgment and don't use any of this.
//
// This exists because several deterministic paths are triggered by a
// content-free reply (a bare number, "YES"/"NO") that carries no language
// signal of its own - the language of the MOST RECENT message that actually
// had content is what should decide the reply's language, not that bare
// reply itself. PendingLanguagePreference remembers that, in-memory only,
// per sender - same simplicity level as every other Pending* store in this
// codebase (no TTL, lost on restart, re-detected from the next
// language-bearing message).

const DEVANAGARI_RE = /[ऀ-ॿ]/;

// Deliberately a short list of common romanized Hindi/Hinglish tokens that
// are unlikely to appear in an ordinary English sentence, matched as whole
// words only. This is a heuristic, not a real language classifier - good
// enough to pick between three template sets, not to translate arbitrary
// text (that's the agent's job, on the paths that still need it).
const HINGLISH_WORDS = [
  "hai", "hain", "kar", "karo", "kijiye", "kijiyega", "karna", "karein",
  "chahiye", "mujhe", "kya", "haan", "nahi", "nahin", "bhai", "accha",
  "acha", "theek", "thik", "bhejo", "dikhao", "batao", "abhi", "zara",
  "thoda", "kitna", "kitne", "paisa", "rupaye", "khana", "mein", "hoga",
  "yeh", "woh", "kaise", "kab", "kripya", "krupya",
];
const HINGLISH_WORD_RE = new RegExp(`\\b(${HINGLISH_WORDS.join("|")})\\b`, "i");

// A bare reply with no real language signal either way - a number, or one
// of the literal English tokens the checkout YES/NO gate requires
// (parseOrderConfirmationReply in food-order-orchestrator.js). Updating the
// stored preference off one of these would overwrite a real earlier signal
// with nothing meaningful.
const AMBIGUOUS_RE = /^(\d+|yes|y|no|n|confirm|confirmed|cancel|cancelled|canceled|stop|place( it)?|proceed|ok|okay)$/i;
// A one-word pick from a list ("First", "Pehla", "Home", "ghar") says nothing
// about which language the user prefers, so it keeps the previous one.
const LIST_PICK_WORD_RE =
  /^(first|second|third|last|1st|2nd|3rd|pehla|pehli|pehela|pahla|pahli|pahela|pehle|dusra|doosra|dusri|doosri|teesra|tisra|home|work|other|office|ghar|house)$/i;

// Returns "hi" | "hinglish" | "en", or undefined when the text carries no
// real signal either way (empty, a bare number, a bare yes/no/confirm token
// - see AMBIGUOUS_RE). Callers should leave any stored preference unchanged
// on undefined, not overwrite it with a guess.
export function detectLanguage(text) {
  const trimmed = (text ?? "").trim();

  if (!trimmed || AMBIGUOUS_RE.test(trimmed) || LIST_PICK_WORD_RE.test(trimmed)) {
    return undefined;
  }

  if (DEVANAGARI_RE.test(trimmed)) {
    return "hi";
  }

  if (HINGLISH_WORD_RE.test(trimmed)) {
    return "hinglish";
  }

  return "en";
}

export class PendingLanguagePreference {
  #languageBySender = new Map();

  // Call on every inbound message, regardless of which path ends up
  // handling it - a no-op when detectLanguage finds no real signal.
  update(senderId, text) {
    const detected = detectLanguage(text);

    if (detected) {
      this.#languageBySender.set(senderId, detected);
    }
  }

  // Defaults to "en" for a sender with no stored preference yet (never
  // messaged, or every message so far was content-free) - same safe
  // default every hardcoded template below falls back to.
  get(senderId) {
    return this.#languageBySender.get(senderId) ?? "en";
  }
}

// Small helper every hardcoded template below uses: pick(lang, {en, hi,
// hinglish}) returns the matching variant, falling back to English for an
// unrecognized/missing lang - keeps every call site terse and keeps "en" as
// the unconditional safe default (existing tests assert exact English
// strings with no lang argument passed at all).
export function pick(lang, variants) {
  return variants[lang] ?? variants.en;
}
