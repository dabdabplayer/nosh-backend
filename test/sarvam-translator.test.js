import assert from "node:assert/strict";
import test from "node:test";
import { createSarvamTranslator, splitForTranslation } from "../src/sarvam-translator.js";

test("splitForTranslation keeps short text whole", () => {
  assert.deepEqual(splitForTranslation("1. Biryani\n2. Pizza", 1000), ["1. Biryani\n2. Pizza"]);
});

test("splitForTranslation splits on line breaks so list items stay intact", () => {
  const lines = Array.from({ length: 6 }, (_, index) => `${index + 1}. ${"x".repeat(15)}`);
  const chunks = splitForTranslation(lines.join("\n"), 40);

  assert.ok(chunks.every((chunk) => chunk.length <= 40));
  assert.deepEqual(chunks.join("\n").split("\n"), lines);
});

test("splitForTranslation splits an over-long single line on a space", () => {
  const chunks = splitForTranslation("aaaa bbbb cccc dddd", 10);

  assert.ok(chunks.every((chunk) => chunk.length <= 10));
  assert.equal(chunks.join(" "), "aaaa bbbb cccc dddd");
});

test("translator translates each chunk of a long reply and rejoins them", async () => {
  const inputs = [];
  const translator = createSarvamTranslator({
    client: {
      text: {
        translate: async (request) => {
          inputs.push(request.input);
          return { translated_text: request.input.toUpperCase() };
        },
      },
    },
  });
  const text = Array.from({ length: 30 }, (_, index) => `${index + 1}. ${"item ".repeat(10)}`).join("\n");

  const result = await translator.fromEnglish(text, "hi");

  assert.ok(inputs.length > 1);
  assert.ok(inputs.every((input) => input.length <= 1000));
  assert.equal(result, text.toUpperCase());
});

test("translator leaves English and unknown languages untouched without calling Sarvam", async () => {
  let called = false;
  const translator = createSarvamTranslator({
    client: {
      text: {
        translate: async () => {
          called = true;
          return { translated_text: "x" };
        },
      },
    },
  });

  assert.equal(await translator.toEnglish("add biryani", "en"), "add biryani");
  assert.equal(await translator.toEnglish("2", undefined), "2");
  assert.equal(await translator.fromEnglish("Done.", "en"), "Done.");
  assert.equal(called, false);
});
