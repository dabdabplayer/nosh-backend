export class InProcessMessageIdempotency {
  #processedMessageIds = new Set();

  takeUnprocessed(messages) {
    const unprocessedMessages = [];

    for (const message of messages) {
      if (this.#processedMessageIds.has(message.id)) {
        continue;
      }

      this.#processedMessageIds.add(message.id);
      unprocessedMessages.push(message);
    }

    return Object.freeze(unprocessedMessages);
  }
}
