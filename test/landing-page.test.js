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

test("the landing page's motion is CSS only and is switched off for reduced-motion visitors", () => {
  assert.doesNotMatch(html, /<script/);
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
  assert.match(html, /<h2 id="free-heading" class="reveal"><span class="free-word">completely<\/span> <span class="stamp">FREE<\/span><\/h2>/);
  assert.match(html, /Nosh charges you nothing\. No fees\. No markup\. No subscription\./);
  // Free means Nosh's own charges: the food itself is still paid for.
  assert.match(html, /You pay only for your food, at the same prices Swiggy shows you\./);
  assert.match(html, /<strong>Completely free to use\.<\/strong> You only pay for your food\./);
  assert.match(html, /<div class="num">₹0<\/div><p>charged by Nosh<\/p>/);
});
