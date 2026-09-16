import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Persists per-WhatsApp-sender Swiggy OAuth tokens to a single JSON file.
// This is a stopgap, not production-grade storage: a plain file has no
// concurrent-write safety and won't survive an ephemeral filesystem (e.g.
// a Render deploy without a persistent disk). Good enough for local/dev use
// while the OAuth flow itself is being built and tested.
//
// senderId (a WhatsApp phone number) is hashed before it ever touches disk -
// Swiggy's own data-and-compliance docs require hashing user identifiers at
// rest unless there's a specific lawful reason not to, and there isn't one
// here. The hash is one-way, so a leaked file doesn't expose phone numbers.
function hashSenderId(senderId) {
  return createHash("sha256").update(senderId).digest("hex");
}

export class SwiggyTokenStore {
  #filePath;
  #tokensByHashedSender;

  constructor(filePath) {
    this.#filePath = filePath;
    this.#tokensByHashedSender = this.#load();
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
    writeFileSync(this.#filePath, JSON.stringify(this.#tokensByHashedSender, null, 2));
  }

  get(senderId) {
    return this.#tokensByHashedSender[hashSenderId(senderId)];
  }

  set(senderId, tokenRecord) {
    this.#tokensByHashedSender[hashSenderId(senderId)] = tokenRecord;
    this.#save();
  }

  delete(senderId) {
    delete this.#tokensByHashedSender[hashSenderId(senderId)];
    this.#save();
  }
}
