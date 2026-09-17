// In-memory, per-process store of which restaurant a WhatsApp sender is
// currently building a cart with. No TTL, no persistence across restarts -
// same simplicity level as PendingAddressSelections.
export class PendingCartSessions {
  #sessionsBySender = new Map();

  set(senderId, session) {
    this.#sessionsBySender.set(senderId, Object.freeze(session));
  }

  peek(senderId) {
    return this.#sessionsBySender.get(senderId);
  }

  clear(senderId) {
    this.#sessionsBySender.delete(senderId);
  }
}
