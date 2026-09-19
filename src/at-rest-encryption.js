import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Shared by every store that persists per-WhatsApp-sender data at rest
// (SwiggyTokenStore, ConversationLog) - factored out once there were two
// consumers of the identical requirement: hash the sender id (a phone
// number) before it's ever used as a lookup key, and encrypt the record
// itself, so a leaked file/store never exposes phone numbers or message
// content in the clear.

export const KEY_LENGTH_BYTES = 32;

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
// Explicit, not left to the default: caught by Semgrep's
// javascript.node-crypto.security.gcm-no-tag-length rule in CI. Without
// pinning this on both sides, a stored record with a shorter-than-expected
// tag could in principle be accepted, weakening the authentication
// guarantee GCM is supposed to provide. 16 bytes is the standard/maximum
// GCM tag length - Node already produces this by default, so pinning it
// changes nothing about normal operation, only what's accepted as valid.
const AUTH_TAG_LENGTH_BYTES = 16;

// senderId (a WhatsApp phone number) is hashed before it ever touches disk
// or a remote store - Swiggy's own data-and-compliance docs require hashing
// user identifiers at rest unless there's a specific lawful reason not to,
// and there isn't one here. The hash is one-way and unsalted-but-keyless
// (deterministic), so the same senderId always maps to the same lookup key
// - required so an operator can look a sender back up by phone number - and
// a leaked store still never exposes the phone number itself.
export function hashSenderId(senderId) {
  return createHash("sha256").update(senderId).digest("hex");
}

export function encryptRecord(record, key) {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

// Returns undefined (never throws) on decryption failure - e.g. the record
// was encrypted with a since-rotated key, or corrupted. Callers treat that
// the same as "no record" rather than crashing.
export function decryptRecord(encrypted, key) {
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
