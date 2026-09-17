// In-memory, per-process store of an in-flight "which address?" prompt per
// WhatsApp sender. No TTL, no persistence across restarts — same simplicity
// level as InProcessMessageIdempotency, accepted as a known limitation.
export class PendingAddressSelections {
  #pendingBySender = new Map();

  set(senderId, pending) {
    this.#pendingBySender.set(senderId, Object.freeze(pending));
  }

  peek(senderId) {
    return this.#pendingBySender.get(senderId);
  }

  take(senderId) {
    const pending = this.#pendingBySender.get(senderId);
    this.#pendingBySender.delete(senderId);
    return pending;
  }

  clear(senderId) {
    this.#pendingBySender.delete(senderId);
  }
}
