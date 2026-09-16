import { createHash } from "node:crypto";

// Deterministic percentage-based rollout gate, keyed by WhatsApp sender id.
// The same sender always lands on the same side of the gate for a given
// percent, so nobody flips between the real flow and the placeholder from
// one message to the next as traffic gets ramped up.
export function isSenderInRollout(senderId, percent) {
  if (percent >= 100) {
    return true;
  }

  if (percent <= 0) {
    return false;
  }

  const bucket = createHash("sha256").update(senderId).digest().readUInt32BE(0) % 100;
  return bucket < percent;
}
