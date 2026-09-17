import { claimOnce } from "./dynamo-item-store.js";

function pk(messageId) {
  return `MSGID#${messageId}`;
}

// Backed by DynamoDB's atomic conditional-write (see claimOnce in
// dynamo-item-store.js) rather than an in-process Set, so exactly-once
// processing holds even when >1 Fargate task can receive the same WhatsApp
// webhook delivery. No TTL - marker rows accumulate for the table's
// lifetime, same accepted tradeoff the in-process Set had (unbounded growth
// over the process's lifetime).
export class MessageIdempotency {
  #documentClient;
  #tableName;

  constructor({ documentClient, tableName }) {
    this.#documentClient = documentClient;
    this.#tableName = tableName;
  }

  async takeUnprocessed(messages) {
    const unprocessedMessages = [];

    for (const message of messages) {
      if (await claimOnce(this.#documentClient, this.#tableName, pk(message.id))) {
        unprocessedMessages.push(message);
      }
    }

    return Object.freeze(unprocessedMessages);
  }
}
