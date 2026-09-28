import assert from "node:assert/strict";
import test from "node:test";
import { detectLanguage, PendingLanguagePreference, pick } from "../src/language-preference.js";
import { parseOrderConfirmationReply } from "../src/food-order-orchestrator.js";

test("detectLanguage recognizes Devanagari script as Hindi", () => {
  assert.equal(detectLanguage("मुझे बिरयानी चाहिए"), "hi");
});

test("detectLanguage recognizes common romanized Hindi words as Hinglish", () => {
  assert.equal(detectLanguage("mujhe biryani chahiye"), "hinglish");
  assert.equal(detectLanguage("cart dikhao"), "hinglish");
  assert.equal(detectLanguage("order confirm kar do"), "hinglish");
});

test("detectLanguage treats an ordinary English sentence as English", () => {
  assert.equal(detectLanguage("I want to order biryani"), "en");
  assert.equal(detectLanguage("show my cart please"), "en");
});

test("detectLanguage returns undefined for content-free replies (no signal either way)", () => {
  assert.equal(detectLanguage("1"), undefined);
  assert.equal(detectLanguage("42"), undefined);
  assert.equal(detectLanguage("YES"), undefined);
  assert.equal(detectLanguage("no"), undefined);
  assert.equal(detectLanguage("confirm"), undefined);
  assert.equal(detectLanguage("cancel"), undefined);
  assert.equal(detectLanguage(""), undefined);
  assert.equal(detectLanguage("   "), undefined);
  assert.equal(detectLanguage(undefined), undefined);
});

test("detectLanguage does not mistake an English word containing a Hinglish substring for Hinglish", () => {
  // "hai" must match as a whole word only - "chain"/"main" etc. must not trip it.
  assert.equal(detectLanguage("keep the chain moving please"), "en");
  assert.equal(detectLanguage("that's the main dish"), "en");
});

test("PendingLanguagePreference defaults to English for an unknown sender", () => {
  const store = new PendingLanguagePreference();
  assert.equal(store.get("sender-1"), "en");
});

test("PendingLanguagePreference records a detected language and returns it later", () => {
  const store = new PendingLanguagePreference();
  store.update("sender-1", "mujhe biryani chahiye");
  assert.equal(store.get("sender-1"), "hinglish");
});

test("PendingLanguagePreference does not overwrite a real preference with a content-free message", () => {
  const store = new PendingLanguagePreference();
  store.update("sender-1", "मुझे बिरयानी चाहिए");
  store.update("sender-1", "1");
  store.update("sender-1", "YES");
  assert.equal(store.get("sender-1"), "hi");
});

test("PendingLanguagePreference updates when the sender genuinely switches languages", () => {
  const store = new PendingLanguagePreference();
  store.update("sender-1", "मुझे बिरयानी चाहिए");
  store.update("sender-1", "actually show me pizza instead");
  assert.equal(store.get("sender-1"), "en");
});

test("PendingLanguagePreference keeps different senders independent", () => {
  const store = new PendingLanguagePreference();
  store.update("sender-1", "मुझे बिरयानी चाहिए");
  store.update("sender-2", "I want pizza");
  assert.equal(store.get("sender-1"), "hi");
  assert.equal(store.get("sender-2"), "en");
});

test("every reply parseOrderConfirmationReply (food-order-orchestrator.js's YES/NO gate) accepts is also content-free to detectLanguage, so a real stored language preference always survives the checkout->YES boundary", () => {
  // If these two ever drift apart - e.g. a new synonym added to
  // CONFIRM_REPLY_PATTERN/CANCEL_REPLY_PATTERN without also adding it to
  // AMBIGUOUS_RE - a user who gets a Hindi checkout summary (formatOrderSummary,
  // "...YES लिखें...") and replies with that synonym would silently overwrite
  // their stored "hi" preference with "en" (since it reads as an ordinary
  // English word to detectLanguage), and placeConfirmedOrder's outcome text
  // would come back in English right after a Hindi summary. See AGENTS.md's
  // i18n gotcha entry for the full reasoning.
  const tokens = [
    "yes", "y", "confirm", "confirmed", "place", "place it", "proceed",
    "no", "n", "cancel", "cancelled", "canceled", "stop",
  ];

  for (const token of tokens) {
    assert.notEqual(parseOrderConfirmationReply(token), undefined, `parseOrderConfirmationReply should accept "${token}"`);
    assert.equal(detectLanguage(token), undefined, `detectLanguage should treat "${token}" as content-free`);
    assert.equal(detectLanguage(token.toUpperCase()), undefined, `detectLanguage should treat "${token.toUpperCase()}" as content-free`);
  }
});

test("pick returns the matching language variant, falling back to English", () => {
  const variants = { en: "Hello", hi: "नमस्ते", hinglish: "Namaste" };
  assert.equal(pick("en", variants), "Hello");
  assert.equal(pick("hi", variants), "नमस्ते");
  assert.equal(pick("hinglish", variants), "Namaste");
  assert.equal(pick("fr", variants), "Hello");
  assert.equal(pick(undefined, variants), "Hello");
});

test("detectLanguage treats a one-word list pick as no language signal", () => {
  for (const word of ["First", "Pehla", "Pehela", "dusra", "Home", "work", "ghar"]) {
    assert.equal(detectLanguage(word), undefined, word);
  }
  assert.equal(detectLanguage("mujhe pizza chahiye"), "hinglish");
  assert.equal(detectLanguage("show my cart"), "en");
});
