import { createClient } from "redis";
import { KEY_LENGTH_BYTES, decryptRecord, encryptRecord, hashSenderId } from "./at-rest-encryption.js";

const KEY_PREFIX = "nosh:chatlog:";
// Bounds what would otherwise be an infinite retry loop, each attempt
// logging "Conversation log Redis client error." forever, if the store is
// ever unreachable (wrong URL, network issue, or - confirmed live via
// scripts/view-chat-log.js - a Render Key Value IP allowlist blocking the
// caller's current IP). node-redis's own default reconnectStrategy retries
// forever with no bound, which is what caused that loop. connectTimeout
// bounds a single attempt too, so a network black hole (not just a refused
// connection) can't hang one either.
const MAX_RECONNECT_ATTEMPTS = 3;
const CONNECT_TIMEOUT_MS = 5000;

function reconnectStrategy(retries, cause) {
  if (retries >= MAX_RECONNECT_ATTEMPTS) {
    return cause instanceof Error ? cause : new Error("Redis reconnect attempts exhausted.");
  }
  return Math.min(retries * 200, 1000);
}

// 14 days: long enough to debug an issue a user reports a few days late,
// short enough to limit exposure if the store were ever compromised - see
// the retention section this feature added to the privacy policy. Applied
// as a Redis key TTL, refreshed on every append, so it's really "14 days
// since this sender's last message" rather than a fixed calendar window -
// an idle conversation ages out on its own with no cleanup job required.
const TTL_SECONDS = 14 * 24 * 60 * 60;
// Bounds memory per sender regardless of TTL - a very chatty sender within
// the 14-day window shouldn't be able to grow one entry without limit.
const MAX_TURNS_PER_SENDER = 200;

// Records every inbound-message/reply pair so a real conversation can be
// replayed when a user reports something went wrong (see server.js's
// buildReplyText). This is a deliberate reversal of this codebase's
// previous logging stance (operational console logs elsewhere are kept
// free of message content/identifiers - see acknowledgeIncomingTextMessages
// in server.js) - message content is genuinely useful here because it's
// the whole point of the feature, so it's protected the same way
// SwiggyTokenStore protects OAuth tokens instead: the sender id (a phone
// number) is hashed before it's used as a lookup key, and every record is
// encrypted at rest with its own key, separate from SwiggyTokenStore's -
// see config.js's CHAT_LOG_ENCRYPTION_KEY.
//
// Backed by a Redis-compatible store (Render Key Value) rather than a
// local file: unlike SwiggyTokenStore, this doesn't need to survive an
// ephemeral filesystem forever, but it does need TTL support to make the
// 14-day retention automatic rather than a cleanup job this app would
// otherwise have to run itself.
export class ConversationLog {
  #client;
  #encryptionKey;
  #connecting;

  // encryptionKey: a 32-byte Buffer (see config.js's CHAT_LOG_ENCRYPTION_KEY
  // handling). createClient is injectable so tests can supply an in-memory
  // fake instead of a real Redis connection.
  constructor({ url, encryptionKey, createClient: createRedisClient = createClient }) {
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== KEY_LENGTH_BYTES) {
      throw new Error(`ConversationLog requires a ${KEY_LENGTH_BYTES}-byte encryption key.`);
    }

    this.#encryptionKey = encryptionKey;
    this.#client = createRedisClient({ url, socket: { reconnectStrategy, connectTimeout: CONNECT_TIMEOUT_MS } });
    this.#client.on("error", (error) => {
      console.error("Conversation log Redis client error.", { name: error?.name, message: error?.message });
    });
  }

  async #ensureConnected() {
    if (this.#client.isOpen) {
      return;
    }

    if (!this.#connecting) {
      // Cleared on failure so a LATER call (once whatever blocked the
      // connection - e.g. an IP allowlist - is fixed) gets a fresh bounded
      // attempt instead of replaying the same rejection for the rest of
      // this process's life.
      this.#connecting = this.#client.connect().catch((error) => {
        this.#connecting = undefined;
        throw error;
      });
    }

    await this.#connecting;
  }

  // Appends one turn ({ inboundText, replyText, isPlaceholder, error? }) for
  // a sender and refreshes the 14-day TTL. Best-effort and never throws: a
  // logging failure must never break the actual WhatsApp reply, so callers
  // fire this off without letting it affect the response they send back.
  async append(senderId, turn) {
    try {
      await this.#ensureConnected();

      const key = KEY_PREFIX + hashSenderId(senderId);
      const record = { ...turn, ts: new Date().toISOString() };
      const encrypted = JSON.stringify(encryptRecord(record, this.#encryptionKey));

      await this.#client.rPush(key, encrypted);
      await this.#client.lTrim(key, -MAX_TURNS_PER_SENDER, -1);
      await this.#client.expire(key, TTL_SECONDS);
    } catch (error) {
      console.error("Failed to append conversation log entry.", { name: error?.name, message: error?.message });
    }
  }

  // Reads back a sender's logged turns, oldest first (append order).
  // Returns [] on any failure, if nothing's logged for them, or if it
  // already aged out - never throws. senderId is the same raw phone number
  // append() was called with; this hashes it the same way to find the
  // record; there's no way to enumerate senders without already knowing
  // the number, by design.
  async read(senderId) {
    try {
      await this.#ensureConnected();

      const key = KEY_PREFIX + hashSenderId(senderId);
      const rawEntries = await this.#client.lRange(key, 0, -1);

      return rawEntries
        .map((entry) => decryptRecord(JSON.parse(entry), this.#encryptionKey))
        .filter((turn) => turn !== undefined);
    } catch (error) {
      console.error("Failed to read conversation log.", { name: error?.name, message: error?.message });
      return [];
    }
  }

  async close() {
    if (this.#client.isOpen) {
      await this.#client.quit();
    }
  }
}
