// Manual dev tool: exercise the NVIDIA NIM intent classifier directly,
// without needing Swiggy credentials or a live WhatsApp round-trip. Not
// part of the app itself.
//
// Usage:
//   node --env-file=.env scripts/nlu-check.js "I want biryani"

import { config } from "../src/config.js";
import { classifyMessage } from "../src/nlu-client.js";

const text = process.argv.slice(2).join(" ");

if (!text) {
  console.error('Usage: node --env-file=.env scripts/nlu-check.js "I want biryani"');
  process.exitCode = 1;
} else if (!config.nvidiaNim.enabled) {
  console.error("NVIDIA_API_KEY must be set (in .env, loaded via --env-file=.env).");
  process.exitCode = 1;
} else {
  const result = await classifyMessage({
    text,
    apiKey: config.nvidiaNim.apiKey,
    baseUrl: config.nvidiaNim.baseUrl,
    model: config.nvidiaNim.model,
  });

  console.log(result ?? "(no food-search intent detected)");
}
