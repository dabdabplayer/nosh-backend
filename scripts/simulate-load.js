// Simulates many WhatsApp users messaging Nosh at the same moment by sending
// signed webhook POSTs exactly like Meta's, from fake senders whose numbers
// start with LOAD_TEST_SENDER_PREFIX. The server must have the same prefix
// set, so it builds each reply but never sends it; per-reply timings and
// outcomes land in the server's own logs ("Load test reply ready.").
//
// Measures here: how fast the webhook is acknowledged (Meta asks for a
// median under 250ms and fewer than 1% over 1s).
//
//   META_APP_SECRET=... node scripts/simulate-load.js --url https://nosh.arysha.app/webhooks/whatsapp --users 10
import { createHmac, randomUUID } from "node:crypto";

const MESSAGES = [
  "I want biryani",
  "Suggest me something to eat",
  "show my cart",
  "mujhe pizza chahiye",
  "I want a burger",
  "what's good for dinner tonight?",
];

function readArgs(argv) {
  const args = { users: 10, prefix: "999" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    args[key] = argv[i + 1];
  }
  args.users = Number(args.users);
  if (!args.url || !Number.isInteger(args.users) || args.users < 1 || args.users > 500) {
    throw new Error("Usage: node scripts/simulate-load.js --url <webhook url> --users <1-500> [--prefix 999]");
  }
  if (!/^\d{3,}$/.test(args.prefix)) {
    throw new Error("--prefix must be at least 3 digits and match the server's LOAD_TEST_SENDER_PREFIX.");
  }
  return args;
}

function webhookBody(senderId, text) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "load-test",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "0000000000", phone_number_id: "load-test" },
              contacts: [{ profile: { name: "Load Test" }, wa_id: senderId }],
              messages: [
                {
                  from: senderId,
                  id: `wamid.loadtest.${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
  const { url, users, prefix } = readArgs(process.argv.slice(2));
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    throw new Error("META_APP_SECRET is required to sign the webhooks.");
  }

  const runId = String(Date.now()).slice(-5);
  const requests = Array.from({ length: users }, (_, index) => {
    const senderId = `${prefix}${runId}${String(index).padStart(4, "0")}`;
    const body = webhookBody(senderId, MESSAGES[index % MESSAGES.length]);
    const signature = `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
    return { body, signature };
  });

  console.log(`Sending ${users} webhooks at once to ${new URL(url).host} (senders ${prefix}${runId}xxxx)...`);
  const startedAt = Date.now();

  const results = await Promise.all(
    requests.map(async ({ body, signature }) => {
      const sentAt = performance.now();
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-signature-256": signature },
          body,
          signal: AbortSignal.timeout(30_000),
        });
        await response.arrayBuffer();
        return { status: response.status, ms: performance.now() - sentAt };
      } catch (error) {
        return { status: error.name, ms: performance.now() - sentAt };
      }
    }),
  );

  const latencies = results.map((result) => result.ms).sort((a, b) => a - b);
  const statuses = results.reduce((counts, { status }) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {});
  const overOneSecond = latencies.filter((ms) => ms > 1000).length;

  console.log(`Done in ${Date.now() - startedAt}ms.`);
  console.log("Responses:", statuses);
  console.log(
    `Acknowledgement latency: median ${Math.round(percentile(latencies, 50))}ms, p95 ${Math.round(percentile(latencies, 95))}ms, max ${Math.round(latencies.at(-1))}ms, over 1s: ${overOneSecond}/${users}`,
  );
  console.log(`Replies are built on the server; check its logs for "Load test reply ready." from ${new Date(startedAt).toISOString()}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
