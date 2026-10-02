// Writes the public website as static files, for hosting on Firebase Hosting
// (Google Cloud) instead of from the Node service:
//
//   site/index.html            the landing page (src/landing-page.js)
//   site/privacy-policy.html   the privacy policy (src/privacy-policy.js)
//   site/nosh-mark.png         the logo mark
//
//   node scripts/build-site.js
//   npx firebase-tools deploy --only hosting
//
// The buttons say "Coming soon" until built with NOSH_LAUNCHED=true; then
// they open a WhatsApp chat with NOSH_WHATSAPP_NUMBER. Rebuild and redeploy
// whenever either page changes.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

// src/privacy-policy.js loads the server's config, which insists on an
// encryption key even though nothing here encrypts anything.
process.env.SWIGGY_TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const { config } = await import("../src/config.js");
const { buildLandingPageHtml } = await import("../src/landing-page.js");
const { PRIVACY_POLICY_HTML } = await import("../src/privacy-policy.js");

const outDir = new URL("../site/", import.meta.url);
await mkdir(outDir, { recursive: true });
await writeFile(new URL("index.html", outDir), buildLandingPageHtml(config.publicSite));
await writeFile(new URL("privacy-policy.html", outDir), PRIVACY_POLICY_HTML);
await copyFile(new URL("../public/nosh-mark.png", import.meta.url), new URL("nosh-mark.png", outDir));

console.log("Built site/: index.html, privacy-policy.html, nosh-mark.png");
