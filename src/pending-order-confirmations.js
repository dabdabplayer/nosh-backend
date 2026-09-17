import { deleteValue, getValue, putValue } from "./dynamo-item-store.js";

function pk(senderId) {
  return `ORDERCONF#${senderId}`;
}

// Store of an order summary shown to a WhatsApp sender while waiting for
// their explicit YES/NO. This is the deterministic confirmation gate for the
// one irreversible action in the app (placing a real order) - see
// food-order-orchestrator.js. Backed by DynamoDB (see dynamo-item-store.js)
// so it survives across Fargate tasks/restarts. No TTL by design, same
// simplicity level as the in-memory version this replaced.
//
// Deliberately peek/clear only, not take - the caller (server.js) must
// explicitly clear() after acting on a peeked value, since a retried YES
// needs to be able to re-peek the same pending confirmation (see
// placeConfirmedOrder's retry-safety handling).
export class PendingOrderConfirmations {
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

  clear(senderId) {
    return deleteValue(this.#documentClient, this.#tableName, pk(senderId));
  }
}
