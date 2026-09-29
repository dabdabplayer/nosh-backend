// Compares two ways of handling non-English chats, end to end, on the real
// agent (Gemini + the real system prompt and tools) against the in-process
// mock Swiggy:
//
//   sarvam  - the current setup: Sarvam translates the user's message to
//             English, Gemini works in English, Sarvam translates the reply.
//   gemini  - no translator: Gemini reads the message as written and replies
//             in the user's language and script itself.
//
// Each conversation in the cases file is run fresh for each variant. Prints a
// per-turn log and a summary: time per turn, Gemini tokens, Sarvam
// characters (billed per character), replies whose script doesn't match the
// user's, and numbers in a reply that no tool result, message or prompt
// contained (a sign of an invented price, rating or time).
//
// Needs the same credentials as the server (GOOGLE_SERVICE_ACCOUNT_JSON or
// AGENT_API_KEY for Gemini, NLU_API_KEY for Sarvam). Never contacts real
// Swiggy or WhatsApp.
//
//   node --env-file=.env scripts/compare-translation.js cases.json [report.json]
//
// cases.json: [{ "name": "...", "messages": ["...", "..."] }, ...]
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { SarvamAIClient } from "sarvamai";
import { config } from "../src/config.js";
import { runAgentTurn, SYSTEM_PROMPT } from "../src/agent.js";
import { createGeminiClient } from "../src/gemini-client.js";
import { createVertexTokenProvider } from "../src/vertex-auth.js";
import { createSarvamTranslator } from "../src/sarvam-translator.js";
import { createSwiggyFoodClient } from "../src/swiggy-food-client.js";
import { PendingLanguagePreference } from "../src/language-preference.js";
import { PendingAddressSelections } from "../src/pending-address-selection.js";
import { PendingCartSessions } from "../src/pending-cart-sessions.js";
import { PendingConversationHistory } from "../src/pending-conversation-history.js";
import { PendingOrderConfirmations } from "../src/pending-order-confirmations.js";
import { handleMockSwiggyFoodRequest, MOCK_FOOD_PATH } from "./mock-swiggy-food-server.js";

const SARVAM_RUPEES_PER_CHAR = 0.005; // sarvam.ai/api-pricing, pay as you go

const ENGLISH_REPLIES_RULE =
  "Replies: plain, casual English only - a separate step translates to and from the user's language, so never translate yourself.";
const OWN_LANGUAGE_REPLIES_RULE =
  "Replies: write in the language and script of the user's latest message - Hinglish in Roman letters, Hindi in " +
  "Devanagari, Punjabi in whichever script they used, English in English. Keep the literal English YES and NO " +
  "whenever you mention confirming an order.";

function geminiOnlyPrompt() {
  if (!SYSTEM_PROMPT.includes(ENGLISH_REPLIES_RULE)) {
    throw new Error("The system prompt's reply-language rule changed; update ENGLISH_REPLIES_RULE here.");
  }
  return SYSTEM_PROMPT.replace(ENGLISH_REPLIES_RULE, OWN_LANGUAGE_REPLIES_RULE);
}

function scriptOf(text) {
  if (/[਀-੿]/.test(text)) return "gurmukhi";
  if (/[ऀ-ॿ]/.test(text)) return "devanagari";
  return "latin";
}

const digitsOf = (text) =>
  (String(text ?? "").replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d))).match(/\d+/g) ?? []);

async function startMockSwiggy() {
  const server = createServer((request, response) => {
    if (new URL(request.url, "http://localhost").pathname === MOCK_FOOD_PATH) {
      handleMockSwiggyFoodRequest(request, response);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}${MOCK_FOOD_PATH}` };
}

function geminiClient() {
  const agent = config.agent;
  const inner = createGeminiClient({
    apiKey: agent.apiKey,
    getAuthToken: agent.serviceAccount ? createVertexTokenProvider(agent.serviceAccount) : undefined,
    baseUrl: agent.baseUrl,
    timeoutMs: agent.timeoutMs,
  });
  const turn = { calls: 0, inputTokens: 0, outputTokens: 0, seenDigits: new Set() };
  const client = {
    chat: {
      async completions(request) {
        for (const message of request.messages) {
          for (const digits of digitsOf(typeof message.content === "string" ? message.content : "")) {
            turn.seenDigits.add(digits);
          }
        }
        const body = await inner.chat.completions(request);
        turn.calls += 1;
        turn.inputTokens += body?.usage?.prompt_tokens ?? 0;
        turn.outputTokens += body?.usage?.completion_tokens ?? 0;
        return body;
      },
    },
  };
  const reset = () => Object.assign(turn, { calls: 0, inputTokens: 0, outputTokens: 0, seenDigits: new Set() });
  return { client, turn, reset };
}

function sarvamTranslator() {
  const sdk = new SarvamAIClient({
    apiSubscriptionKey: config.translation.apiKey,
    baseUrl: config.translation.baseUrl,
    timeoutInSeconds: Math.ceil(config.translation.timeoutMs / 1000),
    maxRetries: 1,
  });
  const turn = { chars: 0, englishReply: undefined };
  const client = {
    text: {
      translate: async (request) => {
        turn.chars += request.input.length;
        return sdk.text.translate(request);
      },
    },
  };
  const translator = createSarvamTranslator({ client });
  const wrapped = {
    toEnglish: translator.toEnglish,
    fromEnglish: async (text, lang) => {
      turn.englishReply = text;
      return translator.fromEnglish(text, lang);
    },
  };
  const reset = () => Object.assign(turn, { chars: 0, englishReply: undefined });
  return { translator: wrapped, turn, reset };
}

async function runConversation({ variant, conversation, mockUrl, gemini, sarvam }) {
  const senderId = `compare-${variant}-${conversation.name}`;
  const swiggyFoodClient = createSwiggyFoodClient({ mcpUrl: mockUrl, token: senderId });
  const state = {
    pendingCartSessions: new PendingCartSessions(),
    pendingOrderConfirmations: new PendingOrderConfirmations(),
    pendingAddressSelections: new PendingAddressSelections(),
    pendingConversationHistory: new PendingConversationHistory(),
  };
  // Skip the "which address?" step, which never reaches the agent.
  state.pendingCartSessions.set(senderId, { addressId: "mock-addr-home" });
  const languages = new PendingLanguagePreference();
  const turns = [];

  try {
    for (const text of conversation.messages) {
      languages.update(senderId, text);
      const lang = languages.get(senderId);
      gemini.reset();
      sarvam?.reset();
      const startedAt = performance.now();
      let reply;
      let error;
      try {
        reply = await runAgentTurn({
          message: { from: senderId, text },
          swiggyFoodClient,
          ...state,
          agent: config.agent,
          client: gemini.client,
          translator: sarvam?.translator,
          lang,
          systemPrompt: variant === "gemini" ? geminiOnlyPrompt() : SYSTEM_PROMPT,
        });
      } catch (caught) {
        error = caught?.name ?? "Error";
      }
      const ms = Math.round(performance.now() - startedAt);

      const allowed = new Set([...gemini.turn.seenDigits, ...digitsOf(text)]);
      const unsupportedNumbers = digitsOf(reply).filter((digits) => !allowed.has(digits));
      const userScript = scriptOf(text);
      const replyScript = reply ? scriptOf(reply) : undefined;

      turns.push({
        user: text,
        reply,
        englishBeforeTranslation: sarvam?.turn.englishReply,
        error,
        ms,
        geminiCalls: gemini.turn.calls,
        inputTokens: gemini.turn.inputTokens,
        outputTokens: gemini.turn.outputTokens,
        sarvamChars: sarvam?.turn.chars ?? 0,
        userScript,
        replyScript,
        scriptMismatch: Boolean(reply) && userScript !== replyScript,
        unsupportedNumbers,
      });
      console.log(`\n[${variant}] ${conversation.name} (${ms} ms)\n  > ${text}\n  < ${reply ?? `ERROR ${error}`}`);
      if (unsupportedNumbers.length > 0) {
        console.log(`  ! numbers not found in any tool result or message: ${unsupportedNumbers.join(", ")}`);
      }
    }
  } finally {
    await swiggyFoodClient.close().catch(() => {});
  }
  return turns;
}

function summarize(variant, turns) {
  const sorted = turns.map((turn) => turn.ms).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const sum = (key) => turns.reduce((total, turn) => total + (turn[key] ?? 0), 0);
  const sarvamChars = sum("sarvamChars");
  return {
    variant,
    turns: turns.length,
    errors: turns.filter((turn) => turn.error).length,
    medianMs: median,
    maxMs: sorted.at(-1),
    geminiInputTokens: sum("inputTokens"),
    geminiOutputTokens: sum("outputTokens"),
    sarvamChars,
    sarvamRupees: Number((sarvamChars * SARVAM_RUPEES_PER_CHAR).toFixed(2)),
    scriptMismatches: turns.filter((turn) => turn.scriptMismatch).length,
    turnsWithUnsupportedNumbers: turns.filter((turn) => turn.unsupportedNumbers.length > 0).length,
  };
}

async function main() {
  const [casesPath, reportPath] = process.argv.slice(2);
  if (!casesPath) {
    throw new Error("Usage: node --env-file=.env scripts/compare-translation.js cases.json [report.json]");
  }
  if (!config.agent.serviceAccount && !config.agent.apiKey) {
    throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON (Vertex) or AGENT_API_KEY for Gemini.");
  }
  if (!config.translation.enabled) {
    throw new Error("Set NLU_API_KEY for Sarvam.");
  }

  const conversations = JSON.parse(await readFile(casesPath, "utf8"));
  const { server, url } = await startMockSwiggy();
  const results = {};

  try {
    for (const variant of ["sarvam", "gemini"]) {
      const gemini = geminiClient();
      const sarvam = variant === "sarvam" ? sarvamTranslator() : undefined;
      results[variant] = [];
      for (const conversation of conversations) {
        const turns = await runConversation({ variant, conversation, mockUrl: url, gemini, sarvam });
        results[variant].push({ name: conversation.name, turns });
      }
    }
  } finally {
    server.close();
  }

  const summary = Object.entries(results).map(([variant, conversationResults]) =>
    summarize(variant, conversationResults.flatMap((conversation) => conversation.turns)),
  );
  console.log("\nSummary:");
  console.table(summary);

  if (reportPath) {
    await writeFile(reportPath, JSON.stringify({ summary, results }, null, 2));
    console.log(`Full report written to ${reportPath}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
