// Remembers what a WhatsApp sender was trying to search for when we had to
// interrupt them to connect their Swiggy account, so the search can resume
// automatically once /oauth/swiggy/callback succeeds instead of making them
// repeat themselves. In-memory, per-process, no TTL - same simplicity level
// as the other pending-* stores.
export class PendingPostAuthActions {
  #pendingBySender = new Map();

  set(senderId, pending) {
    this.#pendingBySender.set(senderId, Object.freeze(pending));
  }

  take(senderId) {
    const pending = this.#pendingBySender.get(senderId);
    this.#pendingBySender.delete(senderId);
    return pending;
  }
}
