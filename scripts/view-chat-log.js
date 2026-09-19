// Operator tool: read back a specific WhatsApp sender's logged conversation
// with Nosh, for debugging a reported issue. Not part of the app itself -
// run it locally, pointed at the same Redis-compatible store the deployed
// service uses (see src/conversation-log.js and CHAT_LOG_REDIS_URL /
// CHAT_LOG_ENCRYPTION_KEY in .env.example).
//
// You need the sender's WhatsApp number to look them up - there is no way
// to list "who's been chatting recently" by design, to keep this tool
// narrowly a "look up the person who reported an issue" tool, not a
// general browse-everyone's-messages one.
//
// Usage:
//   CHAT_LOG_REDIS_URL=... CHAT_LOG_ENCRYPTION_KEY=... \
//     node scripts/view-chat-log.js "+15551234567"

import { config } from "../src/config.js";
import { ConversationLog } from "../src/conversation-log.js";

const [senderId] = process.argv.slice(2);

if (!senderId) {
  console.error('Usage: node scripts/view-chat-log.js "+15551234567"');
  process.exitCode = 1;
} else if (!config.chatLog.enabled) {
  console.error("CHAT_LOG_REDIS_URL and CHAT_LOG_ENCRYPTION_KEY must both be set.");
  process.exitCode = 1;
} else {
  const conversationLog = new ConversationLog({
    url: config.chatLog.redisUrl,
    encryptionKey: config.chatLog.encryptionKey,
  });

  const turns = await conversationLog.read(senderId);

  if (turns.length === 0) {
    console.log(`No logged conversation for ${senderId} (never messaged, or it aged out after 14 days).`);
  } else {
    for (const turn of turns) {
      console.log(`[${turn.ts}] ${senderId}`);
      console.log(`  > ${turn.inboundText}`);
      console.log(`  < ${turn.replyText}${turn.isPlaceholder ? "  (placeholder - no intent recognized)" : ""}`);
      console.log("");
    }
    console.log(`${turns.length} turn(s) shown, oldest first.`);
  }

  await conversationLog.close();
}
