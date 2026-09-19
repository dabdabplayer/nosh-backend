import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { KEY_LENGTH_BYTES, decryptRecord, encryptRecord, hashSenderId } from "./at-rest-encryption.js";

// Persists per-WhatsApp-sender Swiggy OAuth tokens to a single JSON file.
// This is a stopgap, not production-grade storage: a plain file has no
// concurrent-write safety and won't survive an ephemeral filesystem (e.g.
// a Render deploy without a persistent disk). Good enough for local/dev use
// while the OAuth flow itself is being built and tested.
//
// The token VALUES (accessToken/refreshToken) are real bearer credentials -
// good for 5 days per Swiggy's docs, enough to act as that user against the
// real Swiggy API - and hashing the lookup key (see at-rest-encryption.js's
// hashSenderId) does nothing to protect them. Found live during a
// pre-AWS-migration security review: an existing local data/swiggy-tokens.json
// had a real access/refresh token sitting in plain JSON. Encrypt the whole
// record with AES-256-GCM before it touches disk.

export class SwiggyTokenStore {
  #filePath;
  #encryptionKey;
  #recordsByHashedSender;

  // encryptionKey: a 32-byte Buffer (see config.js's SWIGGY_TOKEN_ENCRYPTION_KEY
  // handling for how it's read and validated from the environment).
  constructor(filePath, encryptionKey) {
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== KEY_LENGTH_BYTES) {
      throw new Error(`SwiggyTokenStore requires a ${KEY_LENGTH_BYTES}-byte encryption key.`);
    }

    this.#filePath = filePath;
    this.#encryptionKey = encryptionKey;
    this.#recordsByHashedSender = this.#load();
  }

  #load() {
    try {
      return JSON.parse(readFileSync(this.#filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  #save() {
    mkdirSync(dirname(this.#filePath), { recursive: true });
    writeFileSync(this.#filePath, JSON.stringify(this.#recordsByHashedSender, null, 2));
  }

  get(senderId) {
    const encrypted = this.#recordsByHashedSender[hashSenderId(senderId)];
    return encrypted ? decryptRecord(encrypted, this.#encryptionKey) : undefined;
  }

  set(senderId, tokenRecord) {
    this.#recordsByHashedSender[hashSenderId(senderId)] = encryptRecord(tokenRecord, this.#encryptionKey);
    this.#save();
  }

  delete(senderId) {
    delete this.#recordsByHashedSender[hashSenderId(senderId)];
    this.#save();
  }
}
