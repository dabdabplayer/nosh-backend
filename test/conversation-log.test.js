import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { ConversationLog } from "../src/conversation-log.js";

// A minimal in-memory stand-in for the real Redis client, implementing just
// the handful of commands ConversationLog calls. Lets these tests exercise
// the real hashing/encryption/TTL logic without a real Redis connection.
function fakeRedisClient({ failConnect = false } = {}) {
  const lists = new Map();
  const ttls = new Map();
  let isOpen = false;

  return {
    get isOpen() {
      return isOpen;
    },
    on() {},
    async connect() {
      if (failConnect) {
        throw new Error("connection refused");
      }
      isOpen = true;
    },
    async rPush(key, value) {
      const list = lists.get(key) ?? [];
      list.push(value);
      lists.set(key, list);
    },
    async lTrim(key, start, stop) {
      // Emulates real Redis LTRIM's index clamping: a negative index maps
      // to list.length + index, but never below 0 (a shorter list than the
      // trim window just keeps everything) - JS's own Array.slice applies
      // that SAME negative-relative-to-length adjustment a second time if
      // handed an already-negative index, which silently over-trims.
      const list = lists.get(key) ?? [];
      const clamp = (index) => (index < 0 ? Math.max(0, list.length + index) : Math.min(index, list.length));
      lists.set(key, list.slice(clamp(start), stop === -1 ? list.length : clamp(stop) + 1));
    },
    async expire(key, ttlSeconds) {
      ttls.set(key, ttlSeconds);
    },
    async lRange(key) {
      return lists.get(key) ?? [];
    },
    async quit() {
      isOpen = false;
    },
    // Test-only inspection helpers, not part of the real redis client.
    _lists: lists,
    _ttls: ttls,
  };
}

function testKey() {
  return randomBytes(32);
}

test("append then read round-trips a logged turn", async () => {
  const client = fakeRedisClient();
  const log = new ConversationLog({ url: "redis://test", encryptionKey: testKey(), createClient: () => client });

  await log.append("+15551234567", { inboundText: "find biryani", replyText: "Here's what I found...", isPlaceholder: false });

  const turns = await log.read("+15551234567");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].inboundText, "find biryani");
  assert.equal(turns[0].replyText, "Here's what I found...");
  assert.equal(turns[0].isPlaceholder, false);
  assert.equal(typeof turns[0].ts, "string");
});

test("the raw sender id is never used as the literal Redis key", async () => {
  const client = fakeRedisClient();
  const log = new ConversationLog({ url: "redis://test", encryptionKey: testKey(), createClient: () => client });

  await log.append("+15551234567", { inboundText: "hi", replyText: "hello" });

  for (const key of client._lists.keys()) {
    assert.doesNotMatch(key, /\+15551234567/);
  }
});

test("message content is encrypted at rest, not stored as plain JSON", async () => {
  const client = fakeRedisClient();
  const log = new ConversationLog({ url: "redis://test", encryptionKey: testKey(), createClient: () => client });

  await log.append("+15551234567", { inboundText: "a secret dish name", replyText: "a secret reply" });

  for (const list of client._lists.values()) {
    for (const entry of list) {
      assert.doesNotMatch(entry, /secret/);
    }
  }
});

test("a record encrypted with one key cannot be read back with a different key (fails closed, not crashed)", async () => {
  const client = fakeRedisClient();
  const writeLog = new ConversationLog({ url: "redis://test", encryptionKey: testKey(), createClient: () => client });
  await writeLog.append("+15551234567", { inboundText: "hi", replyText: "hello" });

  const readLog = new ConversationLog({ url: "redis://test", encryptionKey: testKey(), createClient: () => client });
  const turns = await readLog.read("+15551234567");

  assert.deepEqual(turns, []);
});

test("refreshes the TTL on every append", async () => {
  const client = fakeRedisClient();
  const log = new ConversationLog({ url: "redis://test", encryptionKey: testKey(), createClient: () => client });

  await log.append("+15551234567", { inboundText: "hi", replyText: "hello" });

  const [ttlSeconds] = [...client._ttls.values()];
  assert.equal(ttlSeconds, 14 * 24 * 60 * 60);
});

test("trims a sender's log to the most recent 200 turns", async () => {
  const client = fakeRedisClient();
  const log = new ConversationLog({ url: "redis://test", encryptionKey: testKey(), createClient: () => client });

  for (let i = 0; i < 205; i += 1) {
    await log.append("+15551234567", { inboundText: `message ${i}`, replyText: "ok" });
  }

  const turns = await log.read("+15551234567");
  assert.equal(turns.length, 200);
  assert.equal(turns[0].inboundText, "message 5");
  assert.equal(turns[199].inboundText, "message 204");
});

test("different senders don't interfere with each other", async () => {
  const client = fakeRedisClient();
  const log = new ConversationLog({ url: "redis://test", encryptionKey: testKey(), createClient: () => client });

  await log.append("+15551111111", { inboundText: "from sender one", replyText: "ok" });
  await log.append("+15552222222", { inboundText: "from sender two", replyText: "ok" });

  const senderOneTurns = await log.read("+15551111111");
  const senderTwoTurns = await log.read("+15552222222");

  assert.equal(senderOneTurns.length, 1);
  assert.equal(senderOneTurns[0].inboundText, "from sender one");
  assert.equal(senderTwoTurns.length, 1);
  assert.equal(senderTwoTurns[0].inboundText, "from sender two");
});

test("read returns an empty array for a sender with no logged turns", async () => {
  const client = fakeRedisClient();
  const log = new ConversationLog({ url: "redis://test", encryptionKey: testKey(), createClient: () => client });

  assert.deepEqual(await log.read("+15559999999"), []);
});

test("append never throws when the connection fails - a logging failure must not break the real reply", async () => {
  const client = fakeRedisClient({ failConnect: true });
  const log = new ConversationLog({ url: "redis://test", encryptionKey: testKey(), createClient: () => client });

  await assert.doesNotReject(log.append("+15551234567", { inboundText: "hi", replyText: "hello" }));
});

test("read never throws when the connection fails", async () => {
  const client = fakeRedisClient({ failConnect: true });
  const log = new ConversationLog({ url: "redis://test", encryptionKey: testKey(), createClient: () => client });

  assert.deepEqual(await log.read("+15551234567"), []);
});

test("constructor rejects a missing or wrong-length encryption key", () => {
  assert.throws(() => new ConversationLog({ url: "redis://test", encryptionKey: undefined }));
  assert.throws(() => new ConversationLog({ url: "redis://test", encryptionKey: Buffer.from("too-short") }));
});

test("close() quits an open connection", async () => {
  const client = fakeRedisClient();
  const log = new ConversationLog({ url: "redis://test", encryptionKey: testKey(), createClient: () => client });

  await log.append("+15551234567", { inboundText: "hi", replyText: "hello" });
  assert.equal(client.isOpen, true);

  await log.close();
  assert.equal(client.isOpen, false);
});

test("close() on a never-connected client is a no-op", async () => {
  const client = fakeRedisClient();
  const log = new ConversationLog({ url: "redis://test", encryptionKey: testKey(), createClient: () => client });

  await assert.doesNotReject(log.close());
});
