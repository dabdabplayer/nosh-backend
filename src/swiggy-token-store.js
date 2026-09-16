import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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

// The token VALUES (accessToken/refreshToken) are real bearer credentials -
// good for 5 days per Swiggy's docs, enough to act as that user against the
// real Swiggy API - and hashing the lookup key does nothing to protect them.
// Found live during a pre-AWS-migration security review: an existing local
// data/swiggy-tokens.json had a real access/refresh token sitting in plain
// JSON. Encrypt the whole record with AES-256-GCM before it touches disk.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;
// Explicit, not left to the default: caught by Semgrep's
// javascript.node-crypto.security.gcm-no-tag-length rule in CI. Without
// pinning this on both sides, a stored record with a shorter-than-expected
// tag could in principle be accepted, weakening the authentication
// guarantee GCM is supposed to provide. 16 bytes is the standard/maximum
// GCM tag length - Node already produces this by default, so pinning it
// changes nothing about normal operation, only what's accepted as valid.
const AUTH_TAG_LENGTH_BYTES = 16;

function encryptRecord(record, key) {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

// Returns undefined (never throws) on decryption failure - e.g. the file was
// encrypted with a since-rotated key, or corrupted. Treating that as "no
// token" forces a normal reconnect instead of crashing the request; the
// caller already handles a missing token as the ordinary unauthenticated
// case.
function decryptRecord(encrypted, key) {
  try {
    const authTag = Buffer.from(encrypted.authTag, "base64");

    if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
      return undefined;
    }

    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, "base64"), {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    return undefined;
  }
}

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
