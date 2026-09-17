import { putValue, takeValue } from "./dynamo-item-store.js";

function pk(senderId) {
  return `POSTAUTH#${senderId}`;
}

// Remembers what a WhatsApp sender was trying to search for when we had to
// interrupt them to connect their Swiggy account, so the search can resume
// automatically once /oauth/swiggy/callback succeeds instead of making them
// repeat themselves. Backed by DynamoDB (see dynamo-item-store.js) so it
// survives across Fargate tasks/restarts. No TTL by design, same simplicity
// level as the in-memory version this replaced.
export class PendingPostAuthActions {
  #documentClient;
  #tableName;

  constructor({ documentClient, tableName }) {
    this.#documentClient = documentClient;
    this.#tableName = tableName;
  }

  set(senderId, pending) {
    return putValue(this.#documentClient, this.#tableName, pk(senderId), Object.freeze(pending));
  }

  take(senderId) {
    return takeValue(this.#documentClient, this.#tableName, pk(senderId));
  }
}
