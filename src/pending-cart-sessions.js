import { deleteValue, getValue, putValue } from "./dynamo-item-store.js";

function pk(senderId) {
  return `CART#${senderId}`;
}

// Store of which restaurant a WhatsApp sender is currently building a cart
// with. Backed by DynamoDB (see dynamo-item-store.js) so it survives across
// Fargate tasks/restarts. No TTL by design, same simplicity level as the
// in-memory version this replaced.
export class PendingCartSessions {
  #documentClient;
  #tableName;

  constructor({ documentClient, tableName }) {
    this.#documentClient = documentClient;
    this.#tableName = tableName;
  }

  set(senderId, session) {
    return putValue(this.#documentClient, this.#tableName, pk(senderId), Object.freeze(session));
  }

  peek(senderId) {
    return getValue(this.#documentClient, this.#tableName, pk(senderId));
  }

  clear(senderId) {
    return deleteValue(this.#documentClient, this.#tableName, pk(senderId));
  }
}
