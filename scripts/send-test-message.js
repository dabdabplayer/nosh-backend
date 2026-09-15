// Manual dev tool: verify this backend's WhatsApp send path works with
// whatever WHATSAPP_ACCESS_TOKEN is set locally. Not part of the app itself.
//
// Usage:
//   WHATSAPP_ACCESS_TOKEN=... node scripts/send-test-message.js <phoneNumberId> <toE164>

import { config } from "../src/config.js";
import { sendTextMessage } from "../src/whatsapp-client.js";

const [phoneNumberId, to] = process.argv.slice(2);

if (!phoneNumberId || !to) {
  console.error("Usage: node scripts/send-test-message.js <phoneNumberId> <toE164>");
  process.exitCode = 1;
} else if (!config.whatsapp.sendEnabled) {
  console.error("WHATSAPP_ACCESS_TOKEN is not set.");
  process.exitCode = 1;
} else {
  const result = await sendTextMessage({
    accessToken: config.whatsapp.accessToken,
    apiVersion: config.whatsapp.apiVersion,
    phoneNumberId,
    to,
    text: "Nosh backend outbound test (via src/whatsapp-client.js) — if you see this, sending works.",
  });

  console.log("Sent.", result);
}
