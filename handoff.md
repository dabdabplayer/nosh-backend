# Nosh — Session Handoff

**Last updated: 2026-09-17 (second session, on a different machine than the first — see §0).**

## 0. Read this first if you're picking this up cold

- **`main` on GitHub is at `31314e4`** — the same deployable state as `3b1c25f` (old file/in-memory storage, no DynamoDB, no Docker). Confirmed via `git diff 3b1c25f HEAD` (empty).
- **The entire AWS/DynamoDB/Docker migration exists only as uncommitted local changes on this machine** — 33 files, `git status` will show them all modified/untracked. **Do not commit or push this without first provisioning a real DynamoDB table** (see §5) — the code requires `DYNAMODB_TABLE_NAME` to even boot, and pushing it broke the live Render deploy once already today (see §5.3).
- **Local `.env` on this machine has real credentials** (NVIDIA, Swiggy token-encryption key, Meta app secret) plus two new lines pointing the NLU layer at a local Ollama model — see §6. It's gitignored; nothing in it is at risk of being committed.
- If you're a fresh session on a machine that doesn't have the Ollama/DynamoDB local state described here, treat §5–§6 as "what was done," not "what you'll find" — re-verify before assuming.

## 1. Goal

Extend Nosh (WhatsApp-first Swiggy Food conversational agent) and get it
production-ready:

1. Real NLU (NVIDIA NIM) instead of literal `find`/`search` triggers. **Done, confirmed working, including real multilingual (Hindi/Hinglish) understanding.**
2. Cart, coupons, and confirmed checkout via real Swiggy Food MCP tools. **Done, live-tested.**
3. A real WhatsApp user able to go back-and-forth with Nosh via the deployed backend, not just a local CLI harness. **Done — see §2.**
4. Work through Swiggy's go-live checklist so the team can apply for Swiggy production access. **Mostly done — see §3.**
5. Migrate off Render to AWS. **Code written and tested (Docker + DynamoDB persistence layer), but provisioning real AWS resources is blocked by an org-level policy — see §5. Paused, not abandoned.**
6. Pre-migration security review. **Done, plus made continuous — see `docs/SECURITY_REVIEW.md`.**
7. CI security automation (runs on every push). **Done — see §2 and `docs/SECURITY_REVIEW.md` Part 3.**
8. Local dev without hitting NVIDIA NIM's real API. **Done this session — see §6.** Became relevant because of a real, currently-unresolved production issue — see §5.4.

## 2. Current production state (Render)

- **Live and healthy.** Confirmed via `GET /health` → 200 at both the start and end of this session.
- **Render service**: `whatsapp-test-webhook` (`srv-dajrrd5g1s2s73buv5tg`), workspace `tea-dajrphp5efls73a45fe0`, region Oregon, free plan, 1 instance. `autoDeploy` is **off** — every deploy needs an explicit trigger. The Render MCP server (`list_deploys`, `get_deploy`, `list_logs`, `list_services`) is available in Claude Code sessions and is the fast way to check status/logs — use it instead of asking the user to check the dashboard.
- Build command is still `npm install express` — stale/wrong (plain `node:http` server, never uses Express) but harmless. Still not fixed, still not urgent.
- **Running commit: `31314e4`** (the revert — see §5.3). File-based `SwiggyTokenStore`, in-memory `Pending*` stores. `SWIGGY_TOKEN_ENCRYPTION_KEY` **is** set on Render now (confirmed by the user at the start of this session).
- **Full test suite: 192/192 passing** on the local uncommitted DynamoDB-migration branch of work (190/190 on the currently-deployed commit — the 2 extra are for `dynamo-item-store.js` and the fake DynamoDB test helper, neither of which exist in what's actually live).
- A known-issue log correlation this session: **NVIDIA NIM is timing out on real production traffic right now**, not intermittently. See §5.4 — this is the most actionable unresolved item in this whole document.

## 3. Swiggy go-live checklist status

Unchanged since last session — full detail in that session's transcript, condensed here.

| Item | Status |
| --- | --- |
| Access (staging 48h + production confirmed) | ❌ Not started — business step, requires applying at `/access` with a video walkthrough |
| Redirect URIs allowlisted | ❌ Still `localhost` only, by deliberate choice (see §4) |
| Servers + uniform v1 scopes | ✅ Scope requests `mcp:tools mcp:resources mcp:prompts` together. Only Food is *built*; Instamart + Dineout are declared-but-not-built by choice |
| Error handling (retry, 401/-32001, timeouts) | ✅ Done — `src/swiggy-retry.js` |
| Idempotency guards on order placement | ✅ Done — snapshot-diff on `get_food_orders` around `place_food_order` |
| Cart confirmation before order | ✅ Deterministic YES/NO gate |
| Rate limits | ⚠️ Partial — 429 handling wired, not benchmarked against real production traffic |
| Observability (session id, metrics) | ⚠️ Partial — no Swiggy doc documents the session-id field; metrics export destination still unspecified |
| Deprecation monitoring (`_meta.swiggy.deprecation`) | ✅ Pre-wired, inert until Swiggy's v1.1 |
| Incident contact | ❌ Business relationship, post-approval only |
| Data handling | ✅ Hashed sender IDs + encrypted token values |
| Support runbook | ✅ `docs/RUNBOOK.md` |
| Rollout ramp | ✅ `ROLLOUT_PERCENT` env var, defaults to 100 |

Draft application copy from the prior session still hasn't been saved to a file — re-derive if picking this up.

## 4. Production environment reference

Render env vars currently set (values not repeated — check Render dashboard or local `.env`):
`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`, `NVIDIA_API_KEY`, `SWIGGY_FOOD_MCP_URL=https://mcp.swiggy.com/food`, `NVIDIA_NIM_TIMEOUT_MS=45000`, `SWIGGY_TOKEN_ENCRYPTION_KEY` (confirmed set this session). `SWIGGY_OAUTH_REDIRECT_URI` still deliberately unset (stays at `localhost` default) pending Swiggy production access.

## 5. AWS migration — code done, provisioning blocked

### 5.1 What was built (all local, uncommitted — see §0)

- **`Dockerfile`** — `node:20-alpine`, non-root user, no build step needed. Built and smoke-tested successfully (`docker build` + `docker run` + `curl /health` → 200) on the machine this work started on.
- **A full DynamoDB persistence layer** replacing every stateful store: the file-based `SwiggyTokenStore` and all 7 in-memory `Pending*` classes (`PendingAddressSelections`, `PendingCartSessions`, `PendingOrderConfirmations`, `PendingPostAuthActions`, `PendingOAuthExchanges`, `PendingConnectLinks`, `MessageIdempotency` — renamed from `InProcessMessageIdempotency` since that name stopped being accurate). One shared table (`nosh-app-state`, never actually created — see §5.2), partition key `pk` only, no TTL (deliberate — exact behavioral parity with the in-memory version, not a design gap). New shared helper `src/dynamo-item-store.js` (get/put/delete/atomic-take/atomic-claim). Every store's public method names/signatures are unchanged — only became `async`.
- **A real correctness bug found and fixed before touching real AWS**: `DynamoDBDocumentClient` throws on `PutItem` when a stored value has an explicit `undefined`-valued property (e.g. `{...pendingConfirmation, orderId, lat, lng}` when Swiggy's response omits `lat`/`lng`) — this would have broken the order-confirmation retry-safety path in production. Fixed with `marshallOptions: { removeUndefinedValues: true }` on the `DynamoDBDocumentClient.from(...)` call in `server.js` and both dev scripts. The hand-rolled in-memory test fake (`test/helpers/fake-dynamodb-document-client.js`) didn't marshal at all, so it never caught this — fixed the fake too (`stripUndefined`) so this class of bug can't silently pass again.
- **`test/security-adversarial.test.js`** (spawns the real server as a subprocess) needed a fake DynamoDB HTTP server (`test/helpers/fake-dynamodb-server.js`, hand-rolled AWS JSON 1.0 protocol, GetItem/PutItem/DeleteItem only) so it stays hermetic — every webhook POST now needs *some* reachable DynamoDB for message-idempotency, even in tests.
- **192/192 tests passing** on this branch of work.
- Verified `claimOnce`'s `error.name === "ConditionalCheckFailedException"` check against the actual installed `@aws-sdk/client-dynamodb` source (`node_modules`), not docs — correct.

### 5.2 What's blocked

- AWS target was already decided in the prior session: **Amazon ECS Express Mode** (Lambda ruled out — doesn't fit the ack-then-reply pattern; App Runner is closed to new customers as of April 30, 2026). Cost estimate ~$26–31/mo (Fargate ~$9 + a mandatory ALB ~$17–22).
- Account: `690387687623`, region `ap-south-1` (correctly pre-configured — matches an India-serving WhatsApp/Swiggy app). Identity: `assumed-role/AccountFullAccessRole` — a **temporary session that expires mid-task**; if a command suddenly fails with an auth error, re-login (`aws login`), don't assume something broke in the code.
- **`aws dynamodb create-table` fails with an explicit deny from an AWS Organizations Service Control Policy** (`arn:...policy/o-jr7atsf0jr/service_control_policy/p-xlezxcsd`). Confirmed **not** a region issue — same deny in both `ap-south-1` and `us-east-1`. Also denies `ecr:DescribeRepositories`. **S3 works fine** (`aws s3api list-buckets` succeeds), so this isn't a fully-suspended account — it's a scoped SCP that appears to allowlist a small set of services and DynamoDB/ECR/(almost certainly ECS) aren't in it.
- Could not read the SCP's own content to find its full scope (`organizations:DescribePolicy` also denied) — the actual fix has to come from whoever administers the AWS Organization. **This is a business/access problem, not a technical one.**
- Verified the real ECS Express Mode CLI surface before writing any provisioning commands (per the "don't reconstruct AWS command shapes from memory" lesson below): `aws ecs create-express-gateway-service` is real in CLI 2.36.47, and needs **three** IAM roles, not two as originally planned — `--execution-role-arn` (ECR pull, Secrets Manager read, CloudWatch Logs), `--task-role-arn` (DynamoDB access only), and a previously-unaccounted-for `--infrastructure-role-arn` (ECS-managed ALB/target-groups/security-groups/autoscaling) — AWS has a purpose-built managed policy for the last one: `AmazonECSInfrastructureRoleforExpressGatewayServices`.

### 5.3 The mystery merge (resolved, but the "who" was never answered)

- Mid-session, a PR (`#1`, branch `migration`) merged into `main` on GitHub containing DynamoDB-migration code nearly identical in shape to the local uncommitted work described in §5.1 — **but this Claude Code session never made that commit or PR.** Never determined what did (another session, a teammate, some automation) — worth figuring out before it happens again, since if something is still pushing to this repo unattended, it could recreate the same failure.
- Render auto-deployed it twice (`dep-dalr7bv40ujc73f07f20`, then the merge commit `dep-dalumtgae00c73cmfrs0`). Both crashed identically and immediately: `Error: DYNAMODB_TABLE_NAME must be set to the shared Nosh state table's name.` **Render auto-rolled back and kept serving the previous good deploy both times — zero real outage**, confirmed via live `/health` checks bracketing the incident.
- Reverted cleanly: `git revert -m 1 --no-edit 772b82e` → commit `31314e4`, pushed. `git diff 3b1c25f HEAD` is empty (exact match). 190/190 tests passing on the reverted state.

### 5.4 A real, currently-unresolved production issue found while investigating the above

- Correlating real inbound-message timestamps against `NVIDIA NIM classification request errored. { name: 'AbortError' }` log lines in Render: **every single sampled message in a ~5 minute window timed out at exactly 45.00s** (the configured `NVIDIA_NIM_TIMEOUT_MS`), 3 for 3. Real users are silently getting the static placeholder reply instead of an actual AI response right now — `classifyMessage` fails closed by design (doesn't crash), which also means nobody gets paged about it.
- This is worse than the prior session's finding ("routinely exceeded a 25s timeout") — the 45s bump didn't fix it, or NVIDIA NIM/Render's network path has degraded further since. **Root cause not identified. Not fixed.** Candidates worth checking next: NVIDIA's own status page, whether the timeout needs raising again, or whether this needs a different network path entirely (see §5.2's blocked AWS migration — a different egress path is one of the few things that might actually fix this, which is a real argument for unblocking it).

## 6. Local dev: NLU classifier can now point at a local model

- `src/nlu-client.js` already just calls a standard OpenAI-compatible `{baseUrl}/chat/completions` with tool-calling — no code change needed, just `NVIDIA_NIM_BASE_URL` / `NVIDIA_NIM_MODEL` overrides (already supported by `config.js`, now documented in `.env.example`).
- Verified live against **Ollama, `qwen2.5:7b`** (`ollama pull qwen2.5:7b`, `ollama serve`, port 11434) — both the raw `/chat/completions` contract and the real `classifyMessage`/`classifyOrderIntent` functions, positive case (Hinglish "mujhe biryani mangwani hai" → correct `search_food` + extracted query) and negative case (greeting → no tool call) both correct.
- Further verified through the **actual local server + real webhook HTTP path**, not just the function in isolation: a correctly HMAC-signed synthetic WhatsApp payload → `/webhooks/whatsapp` → real Qwen classification → reply generation → send attempt, using a deliberately-fake `WHATSAPP_ACCESS_TOKEN` so the final send step is guaranteed to fail safely (zero chance of a real message reaching anyone) while still exercising the whole pipeline. Both a food-intent message and a plain greeting ran clean, no crashes.
- **Local `.env` now has these two lines** (commented out in `.env.example` as documentation):
  ```
  NVIDIA_NIM_BASE_URL=http://localhost:11434/v1
  NVIDIA_NIM_MODEL=qwen2.5:7b
  ```
  Comment them out in `.env` to go back to real NVIDIA NIM.
- **Confirmed this cannot reach Render** — `localhost:11434` on Render means Render's own container, not your machine. No bridge without a tunnel. A tunnel approach (ngrok) was set up partway (installed, then an authtoken requirement surfaced) and then **explicitly abandoned by the user** — ngrok was uninstalled, nothing else was changed. If this comes up again: the real fix for using a local/self-hosted model in production is hosting it somewhere both always-on and reachable from Render, not tunneling a laptop.
- **Gotcha, real and easy to hit again**: `npm start` (`node src/server.js`) **never reads `.env`** — only `npm run dev` (`node --env-file=.env src/server.js`) does. A `DYNAMODB_TABLE_NAME`-or-similar error from `npm start` locally is very likely just this, not a real config problem. Use `npm run dev` for all local testing.

## 7. Failed Attempts / Lessons (carried over + new this session)

- **(Carried over, still relevant)** A `WebFetch`'d docs page can be flatly wrong — verify against a real live call. **This session's version of the same lesson: don't reconstruct an AWS CLI command's shape from a prior session's notes either** — `handoff.md`'s own ECS Express Mode research was correct on the target but missed a required IAM role; verified the real command surface (`aws ecs create-express-gateway-service help`) before writing anything, and it's a good thing — the shape had a gap.
- **A hand-rolled test double that doesn't replicate a real SDK's behavior hides real bugs.** The in-memory DynamoDB document-client fake didn't marshal like the real `DynamoDBDocumentClient` does, so 192 passing tests said nothing about the real `removeUndefinedValues` throw — this is the same category of lesson as the `@modelcontextprotocol/sdk` `.code` dual-meaning quirk from the prior session (verify a wrapped SDK's actual behavior, don't assume a test double captures it).
- **An AWS Organizations SCP explicit-deny overrides even a full-access role** — don't try multiple regions or workarounds once one is confirmed; check whether it's account-wide (try an unrelated service like S3) to scope the actual problem before concluding anything, then stop and escalate to whoever owns the Organization. Not something to route around.
- **`npm start` vs `npm run dev`: only the latter loads `.env`.** Real, already bit this session once (see §6). Worth fixing the confusion in `README.md` next time someone's here for more than a few minutes.
- **Untracked files get swept into `git stash push -u` just like tracked changes**, and this bit twice this session — `handoff.md` itself (untracked, deliberately) disappeared from disk after a stash and had to be recovered by popping. If you stash with `-u` for one purpose, remember it also carries away anything else untracked, including this very file.
- **Real correctness bugs surface late if you only test with hand-rolled fakes** — same story as the marshalling bug in §5.1. The general shape of this lesson keeps recurring across sessions: verify against the real thing (SDK source, real API behavior, real CLI help) before trusting a doc, a memory, or a mock.

## 8. Next steps

1. **Most actionable: NVIDIA NIM is timing out on real production traffic right now (§5.4).** Real users are getting placeholder replies. Check NVIDIA's status page, consider raising the timeout again, or treat this as a reason to prioritize unblocking the AWS migration (different network path).
2. **Get the AWS SCP resolved or use a different account** — nothing else in the AWS migration can proceed without this. Whoever administers AWS Organization `o-jr7atsf0jr` needs to either allow DynamoDB/ECR/ECS on account `690387687623`, or a different, unrestricted account/OU needs to be used instead.
3. **Once AWS access exists**: create the DynamoDB table first and do a real round-trip smoke test through `dynamo-item-store.js` (`putValue`/`getValue`, double `take`, double `claimOnce`) before touching ECR/ECS — cheapest, safest validation step, and confirms IAM permissions actually work.
4. **Do not commit/push the local DynamoDB migration work until step 3 is done** — pushing it without a real table breaks the Render deploy exactly like §5.3.
5. **Find out what created the `migration` branch and PR #1** (§5.3) — if it's unattended automation, it could happen again.
6. Add TTL to connect-link/OAuth-state tokens — still an open, low-severity item from the security review.
7. Apply for Swiggy production access at `/access` — draft application copy still not saved to a file.
8. UPI checkout — still COD-only, not built.
9. Metrics export destination — still unspecified.

## 9. Swiggy Builders Club docs reference

You have access to Swiggy Builders Club docs - the authoritative source
for Swiggy MCP (Food, Instamart, Dineout). Always consult these before
writing Swiggy code:

- Index:      https://mcp.swiggy.com/builders/llms.txt
- Full text:  https://mcp.swiggy.com/builders/llms-full.txt
- Per-page:   append `.md` to any https://mcp.swiggy.com/builders/docs/... URL

Tool schemas live under `/docs/reference/{food,instamart,dineout}`.
Error codes live at `/docs/reference/errors`. Auth flow is at
`/docs/start/authenticate`.

Rules:
1. Before recommending a tool name, parameter, error code, rate limit,
   or auth flow, fetch the relevant doc and verify.
2. Never invent tool names or parameters. If the docs don't cover it,
   say so and ask.
3. Prefer `.md` page fetches over `llms-full.txt` when you know the
   exact area - it's cheaper on context.
4. **Prefer a raw `curl`/direct fetch over `WebFetch`'s summarization when
   an exact field name, error code, or numeric value matters.**

This is already enforced project-wide via [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md) — repeated here so it travels with this handoff even if those aren't loaded.
