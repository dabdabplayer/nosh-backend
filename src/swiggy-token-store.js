import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Persists per-WhatsApp-sender Swiggy OAuth tokens to a single JSON file.
// This is a stopgap, not production-grade storage: a plain file has no
// concurrent-write safety and won't survive an ephemeral filesystem (e.g.
// a Render deploy without a persistent disk). Good enough for local/dev use
// while the OAuth flow itself is being built and tested.
export class SwiggyTokenStore {
  #filePath;
  #tokensBySender;

  constructor(filePath) {
    this.#filePath = filePath;
    this.#tokensBySender = this.#load();
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
    writeFileSync(this.#filePath, JSON.stringify(this.#tokensBySender, null, 2));
  }

  get(senderId) {
    return this.#tokensBySender[senderId];
  }

  set(senderId, tokenRecord) {
    this.#tokensBySender[senderId] = tokenRecord;
    this.#save();
  }

  delete(senderId) {
    delete this.#tokensBySender[senderId];
    this.#save();
  }
}
