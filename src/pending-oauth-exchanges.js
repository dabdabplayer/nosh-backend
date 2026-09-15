// In-memory, per-process store of in-flight OAuth authorize->callback
// exchanges, keyed by the opaque `state` value round-tripped through
// Swiggy's consent flow. No TTL, no persistence across restarts - same
// simplicity level as InProcessMessageIdempotency and
// PendingAddressSelections; an abandoned exchange just lingers harmlessly
// until the process restarts.
export class PendingOAuthExchanges {
  #pendingByState = new Map();

  set(state, pending) {
    this.#pendingByState.set(state, Object.freeze(pending));
  }

  take(state) {
    const pending = this.#pendingByState.get(state);
    this.#pendingByState.delete(state);
    return pending;
  }
}
