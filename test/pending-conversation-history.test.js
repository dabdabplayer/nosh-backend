import assert from "node:assert/strict";
import test from "node:test";
import { PendingConversationHistory } from "../src/pending-conversation-history.js";

test("peek on an unknown sender returns an empty array", () => {
  const history = new PendingConversationHistory();
  assert.deepEqual(history.peek("unknown"), []);
});

test("append adds turns in order", () => {
  const history = new PendingConversationHistory();
  history.append("sender-1", { role: "user", content: "hi" });
  history.append("sender-1", { role: "assistant", content: "hello!" });

  assert.deepEqual(
    history.peek("sender-1").map((turn) => ({ role: turn.role, content: turn.content })),
    [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
    ],
  );
});

test("clear removes all turns for a sender", () => {
  const history = new PendingConversationHistory();
  history.append("sender-1", { role: "user", content: "hi" });

  history.clear("sender-1");

  assert.deepEqual(history.peek("sender-1"), []);
});

test("state for one sender does not affect another sender", () => {
  const history = new PendingConversationHistory();
  history.append("sender-1", { role: "user", content: "hi" });

  assert.deepEqual(history.peek("sender-2"), []);
  assert.equal(history.peek("sender-1").length, 1);
});

test("caps stored turns at 20, dropping the oldest first", () => {
  const history = new PendingConversationHistory();

  for (let i = 0; i < 25; i++) {
    history.append("sender-1", { role: "user", content: `turn-${i}` });
  }

  const turns = history.peek("sender-1");
  assert.equal(turns.length, 20);
  assert.equal(turns[0].content, "turn-5");
  assert.equal(turns[19].content, "turn-24");
});

test("appended turns are frozen", () => {
  const history = new PendingConversationHistory();
  history.append("sender-1", { role: "user", content: "hi" });

  assert.ok(Object.isFrozen(history.peek("sender-1")[0]));
});
