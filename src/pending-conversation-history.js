// In-memory, per-process store of a WhatsApp sender's recent conversation
// turns with the Sarvam agent (src/sarvam-agent.js) - gives the agent
// context across a whole ordering session (e.g. "the biryani place" still
// resolving correctly two messages later) without re-deriving it from
// scratch every turn. No TTL, no persistence across restarts, same
// simplicity level as PendingCartSessions - this is conversational context,
// not a record of what happened, so losing it on a restart is acceptable.
//
// Deliberately separate from src/conversation-log.js: that's an encrypted,
// Redis-backed, 14-day debug log with specific retention/encryption
// promises made in the privacy policy - this store is in-memory-only, never
// persisted, never encrypted, and holds nothing that needs disclosing
// beyond what the privacy policy already covers ("message text is sent to a
// third-party AI service").
//
// Turns are natural-language {role, content} pairs only (never raw
// tool-call traces) to keep what's sent to Sarvam on every turn bounded.
const MAX_TURNS_PER_SENDER = 20;

export class PendingConversationHistory {
  #turnsBySender = new Map();

  append(senderId, turn) {
    const turns = this.#turnsBySender.get(senderId) ?? [];
    const updated = [...turns, Object.freeze(turn)].slice(-MAX_TURNS_PER_SENDER);
    this.#turnsBySender.set(senderId, updated);
  }

  peek(senderId) {
    return this.#turnsBySender.get(senderId) ?? [];
  }

  clear(senderId) {
    this.#turnsBySender.delete(senderId);
  }
}
