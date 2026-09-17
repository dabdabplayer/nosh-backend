import { deleteValue, getValue, putValue, takeValue } from "./dynamo-item-store.js";

// Shared single DynamoDB table (see dynamo-item-store.js) - this store owns
// keys of the form ADDR#<senderId>.
function pk(senderId) {
  return `ADDR#${senderId}`;
}

// Durable store of an in-flight "which address?" prompt per WhatsApp
// sender, backed by DynamoDB so it survives across Fargate tasks/restarts.
// No TTL by design - matches the exact behavior of the in-memory version it
// replaced.
export class PendingAddressSelections {
  #documentClient;
  #tableName;

  constructor({ documentClient, tableName }) {
    this.#documentClient = documentClient;
    this.#tableName = tableName;
  }

  set(senderId, pending) {
    return putValue(this.#documentClient, this.#tableName, pk(senderId), Object.freeze(pending));
  }

  peek(senderId) {
    return getValue(this.#documentClient, this.#tableName, pk(senderId));
  }

  take(senderId) {
    return takeValue(this.#documentClient, this.#tableName, pk(senderId));
  }

  clear(senderId) {
    return deleteValue(this.#documentClient, this.#tableName, pk(senderId));
  }
}
