import { putValue, takeValue } from "./dynamo-item-store.js";

function pk(state) {
  return `OAUTH#${state}`;
}

// Durable store of in-flight OAuth authorize->callback exchanges, keyed by
// the opaque `state` value round-tripped through Swiggy's consent flow.
// Backed by DynamoDB (see dynamo-item-store.js) so it survives across
// Fargate tasks/restarts. No TTL by design - an abandoned exchange just
// lingers harmlessly, same as the in-memory version it replaced.
export class PendingOAuthExchanges {
  #documentClient;
  #tableName;

  constructor({ documentClient, tableName }) {
    this.#documentClient = documentClient;
    this.#tableName = tableName;
  }

  set(state, pending) {
    return putValue(this.#documentClient, this.#tableName, pk(state), Object.freeze(pending));
  }

  take(state) {
    return takeValue(this.#documentClient, this.#tableName, pk(state));
  }
}
