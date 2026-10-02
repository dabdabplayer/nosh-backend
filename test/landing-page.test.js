import assert from "node:assert/strict";
import test from "node:test";
import { buildLandingPageHtml } from "../src/landing-page.js";

const html = buildLandingPageHtml({ whatsappNumber: "919220133162", year: 2026 });

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
  const odd = buildLandingPageHtml({ whatsappNumber: '1"><script>', year: 2026 });
  assert.doesNotMatch(odd, /wa\.me\/1"><script>/);
});
