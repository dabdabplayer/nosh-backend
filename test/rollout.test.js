import assert from "node:assert/strict";
import test from "node:test";
import { isSenderInRollout } from "../src/rollout.js";

test("100 percent always includes every sender", () => {
  assert.equal(isSenderInRollout("+911111111111", 100), true);
  assert.equal(isSenderInRollout("+912222222222", 100), true);
});

test("0 percent always excludes every sender", () => {
  assert.equal(isSenderInRollout("+911111111111", 0), false);
  assert.equal(isSenderInRollout("+912222222222", 0), false);
});

test("the same sender at the same percent always gets the same answer", () => {
  const first = isSenderInRollout("+919220133162", 42);
  const second = isSenderInRollout("+919220133162", 42);
  assert.equal(first, second);
});

test("a sender included at a lower percent stays included as the percent ramps up", () => {
  const sender = "+919220133162";
  let includedAt = undefined;

  for (let percent = 1; percent <= 100; percent += 1) {
    if (isSenderInRollout(sender, percent)) {
      includedAt = percent;
      break;
    }
  }

  assert.ok(includedAt !== undefined, "sender should be included by percent=100 at the latest");

  for (let percent = includedAt; percent <= 100; percent += 1) {
    assert.equal(isSenderInRollout(sender, percent), true, `expected sender still included at ${percent}%`);
  }
});

test("roughly distributes senders across buckets (sanity check, not exact)", () => {
  const included = Array.from({ length: 1000 }, (_, i) => `+91900000${String(i).padStart(4, "0")}`).filter((sender) =>
    isSenderInRollout(sender, 10),
  );

  // Loose bounds - this is a hash-bucket sanity check, not a precision test.
  assert.ok(included.length > 50 && included.length < 200, `expected roughly 100 of 1000 included, got ${included.length}`);
});
