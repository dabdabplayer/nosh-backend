// In-memory, per-process store of an order summary shown to a WhatsApp
// sender while waiting for their explicit YES/NO. This is the deterministic
// confirmation gate for the one irreversible action in the app (placing a
// real order) - see food-order-orchestrator.js. No TTL, no persistence
// across restarts - same simplicity level as PendingAddressSelections.
export class PendingOrderConfirmations {
  #pendingBySender = new Map();

  set(senderId, pending) {
    this.#pendingBySender.set(senderId, Object.freeze(pending));
  }

  peek(senderId) {
    return this.#pendingBySender.get(senderId);
  }

  clear(senderId) {
    this.#pendingBySender.delete(senderId);
  }
}
