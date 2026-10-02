import assert from "node:assert/strict";
import test from "node:test";
import { buildLandingPageHtml } from "../src/landing-page.js";

const html = buildLandingPageHtml({ whatsappNumber: "919220133162", launched: true, year: 2026 });

test("the landing page's main button opens a WhatsApp chat with Nosh's number", () => {
  const links = html.match(/href="https:\/\/wa\.me\/[^"]+"/g) ?? [];
  assert.ok(links.length >= 2);
  for (const link of links) {
    assert.equal(link, 'href="https://wa.me/919220133162?text=Hi%20Nosh"');
  }
  assert.match(html, /Message Nosh on WhatsApp/);
});

test("the landing page links to the privacy policy and has the feature, ease, privacy and security sections", () => {
  assert.match(html, /href="\/privacy-policy"/);
  for (const id of ["features", "ease", "privacy", "security"]) {
    assert.match(html, new RegExp(`<section id="${id}"`));
    assert.match(html, new RegExp(`href="#${id}"`));
  }
});

test("the landing page loads nothing from other sites: no external scripts, styles, fonts or images", () => {
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"/);
  assert.doesNotMatch(html, /@import|url\(\s*["']?https?:/);
  assert.doesNotMatch(html, /<img[^>]+src="https?:/);
});

test("the landing page's privacy and security claims match what Nosh does", () => {
  // Kept in step with src/privacy-policy.js and the order-confirmation code.
  assert.match(html, /deleted automatically 14 days after your last message/);
  assert.match(html, /AES-256/);
  assert.match(html, /only after you reply YES, or tap twice to confirm/);
  assert.match(html, /Cash on Delivery and orders up to ₹1,000/);
  assert.match(html, /Example conversation\. Real prices, ratings and delivery times come from Swiggy\./);
});

test("the WhatsApp number is escaped into the page", () => {
  const odd = buildLandingPageHtml({ whatsappNumber: '1"><script>', launched: true, year: 2026 });
  assert.doesNotMatch(odd, /wa\.me\/1"><script>/);
});

test("the landing page uses the Nosh logo mark and WhatsApp's chat colours for the example chat", () => {
  assert.match(html, /<link rel="icon" type="image\/png" href="\/nosh-mark\.png">/);
  assert.match(html, /<img class="avatar" src="\/nosh-mark\.png"/);
  // Brand colours from the logo, and WhatsApp's outgoing-bubble green.
  assert.match(html, /--brand: #0b3028/);
  assert.match(html, /--lime: #caf743/);
  assert.match(html, /--wa-out: #d9fdd3/);
});

test("the landing page's motion is CSS, with one small inline script, and is switched off for reduced-motion visitors", () => {
  // One inline script (it starts the ₹0 count); nothing loaded from elsewhere.
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\{[^}]*\}\s*\*, \*::before, \*::after \{ animation: none !important;/);
  // Scroll effects only where the browser supports them; content is never
  // hidden by default.
  assert.match(html, /@supports \(animation-timeline: view\(\)\)/);
  assert.doesNotMatch(html, /\.reveal \{[^}]*opacity: 0/);
});

test("the languages card lists the four supported languages and says more are coming", () => {
  for (const language of ["English", "हिन्दी", "Hinglish", "ਪੰਜਾਬੀ"]) {
    assert.match(html, new RegExp(`<span class="lang">${language}</span>`));
  }
  assert.match(html, /<span class="lang soon">\+ many more to come<\/span>/);
});

test("before launch every button says Coming soon and the page has no WhatsApp link or number", () => {
  const prelaunch = buildLandingPageHtml({ whatsappNumber: "919220133162", year: 2026 });

  assert.equal((prelaunch.match(/aria-disabled="true">Coming soon<\/span>/g) ?? []).length, 3);
  assert.doesNotMatch(prelaunch, /wa\.me/);
  assert.doesNotMatch(prelaunch, /919220133162/);
  // No button is a link: the only things with the button style are the
  // three "Coming soon" labels.
  assert.doesNotMatch(prelaunch, /<a class="button/);
  assert.doesNotMatch(prelaunch, /Order now/);
  assert.match(prelaunch, /Launching soon\./);
  // The rest of the page is unchanged.
  assert.match(prelaunch, /href="\/privacy-policy"/);
  assert.match(prelaunch, /<section id="features"/);
});

test("the page says, prominently and accurately, that Nosh is free for the user", () => {
  // A full-width band straight after the hero, before "How it works".
  const freeAt = html.indexOf('<section id="free"');
  assert.ok(freeAt > html.indexOf('class="hero"') && freeAt < html.indexOf('<section id="how"'));
  // "completely" small and lowercase, "FREE" as the stamp.
  assert.match(html, /<h2 id="free-heading"><span class="free-word">completely<\/span> <span class="stamp">FREE<\/span><\/h2>/);
  assert.match(html, /Nosh charges you nothing\. No fees\. No markup\. No subscription\./);
  // Free means Nosh's own charges: the food itself is still paid for.
  assert.match(html, /You pay only for your food, at the same prices Swiggy shows you\./);
  assert.match(html, /<strong>Completely free to use\.<\/strong> You only pay for your food\./);
  // The amount is read out as "₹0"; visually it counts up to ₹1000 and drops to zero.
  assert.match(html, /<div class="num" role="img" aria-label="₹0">₹<span class="count" aria-hidden="true"><\/span><\/div><p>charged by Nosh<\/p>/);
  // Up to 1000, held there (36% to 71% of 5s is about 1.75s), then zero.
  assert.match(html, /36% \{ --count: 1000;/);
  assert.match(html, /71% \{ --count: 1000;/);
  assert.match(html, /71\.01%, 100% \{ --count: 0; \}/);
  assert.match(html, /\.count\.play \{ animation: count-up 5s/);
});

test("the FREE stamp is only hidden while a running script is about to stamp it", () => {
  // Hidden before it plays only under html.js (set by the script itself) and
  // only when motion is allowed - never by default.
  assert.match(html, /\.js \.stamp:not\(\.play\) \{ opacity: 0; \}/);
  assert.doesNotMatch(html, /\n  \.stamp \{[^}]*opacity: 0/);
  assert.match(html, /\.stamp\.play \{ animation: stamp 0\.9s/);
});

test("the count turns red and shakes while it sits at ₹1000, and the ₹0 is back in the normal colour", () => {
  assert.match(html, /@keyframes heat \{\s*0% \{ color: var\(--link\); \}\s*36%, 71% \{ color: var\(--red\);/);
  assert.match(html, /71\.01%, 100% \{ color: var\(--link\); \}/);
  // The shake covers the hold: it starts when the count reaches 1000 (1.8s
  // in, plus the 0.15s start delay) and lasts until the collapse.
  assert.match(html, /shake 1\.75s linear 1\.95s;/);
  assert.match(html, /@keyframes shake \{ 0% \{ translate:/);
});
