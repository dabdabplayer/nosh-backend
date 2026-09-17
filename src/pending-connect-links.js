import { randomBytes } from "node:crypto";
import { putValue, takeValue } from "./dynamo-item-store.js";

function pk(token) {
  return `CONNECT#${token}`;
}

// A raw `?sender=<phone>` query param on /oauth/swiggy/start would let
// anyone link THEIR OWN Swiggy account to SOMEONE ELSE'S WhatsApp number
// just by knowing/guessing that phone number - a real account-linking spoof,
// not just a CSRF risk on the OAuth callback itself (which `state` already
// covers). Instead, /start takes an unguessable, single-use `token` created
// here, only ever handed to a sender via a WhatsApp reply sent TO that same
// sender's own phone number. Backed by DynamoDB (see dynamo-item-store.js)
// so it survives across Fargate tasks/restarts. No TTL by design, same
// simplicity level as the in-memory version this replaced.
export class PendingConnectLinks {
  #documentClient;
  #tableName;

  constructor({ documentClient, tableName }) {
    this.#documentClient = documentClient;
    this.#tableName = tableName;
  }

  async create(senderId) {
    const token = randomBytes(16).toString("base64url");
    await putValue(this.#documentClient, this.#tableName, pk(token), Object.freeze({ senderId }));
    return token;
  }

  take(token) {
    return takeValue(this.#documentClient, this.#tableName, pk(token));
  }
}
