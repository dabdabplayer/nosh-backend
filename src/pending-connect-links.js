import { randomBytes } from "node:crypto";

// A raw `?sender=<phone>` query param on /oauth/swiggy/start would let
// anyone link THEIR OWN Swiggy account to SOMEONE ELSE'S WhatsApp number
// just by knowing/guessing that phone number - a real account-linking spoof,
// not just a CSRF risk on the OAuth callback itself (which `state` already
// covers). Instead, /start takes an unguessable, single-use `token` created
// here, only ever handed to a sender via a WhatsApp reply sent TO that same
// sender's own phone number. In-memory, per-process, no TTL - same
// simplicity level as the other pending-* stores.
export class PendingConnectLinks {
  #pendingByToken = new Map();

  create(senderId) {
    const token = randomBytes(16).toString("base64url");
    this.#pendingByToken.set(token, Object.freeze({ senderId }));
    return token;
  }

  take(token) {
    const pending = this.#pendingByToken.get(token);
    this.#pendingByToken.delete(token);
    return pending;
  }
}
