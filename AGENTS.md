# AGENTS.md

## Project
- Nosh is a cloud-hosted, WhatsApp-first conversational commerce agent.
- MVP interface: WhatsApp only. Do not introduce a CLI or web UI unless explicitly requested.
- Swiggy integrations: Food, Instamart, and Dineout via Swiggy MCP.

## Swiggy MCP — Non-Negotiable Rules
- Official source of truth: https://mcp.swiggy.com/builders/docs/
- Before implementing or modifying Swiggy integration, consult the current relevant Swiggy documentation.
- Prefer the specific `.md` reference page when the required capability is known.
- Never invent or assume Swiggy tool names, parameters, response fields, IDs, enums, errors, authentication behavior, rate limits, payment capabilities, or availability.
- Treat every identifier returned by Swiggy as opaque; pass it back exactly as returned.
- Food, Instamart, and Dineout are separate MCP servers with separate state; do not assume state or carts are shared.
- Use Swiggy's documented OAuth 2.1 + PKCE delegated-auth flow for multi-user access.
- Authorization and tokens are per user; never share authentication state between users.
- Never collect, store, or request Swiggy passwords or OTPs.
- Never expose Swiggy tokens, internal IDs, MCP tool names, raw tool responses, or raw MCP errors to users.
- Never autonomously place an order, book a table, or perform another irreversible commerce action.
- Before an irreversible action, show the user the relevant final details and obtain explicit confirmation immediately before execution.
- Enforce confirmation in deterministic application code; do not rely solely on the LLM.
- Never blindly retry a non-idempotent commerce operation. Check whether it already succeeded before retrying.
- Handle documented 401/authentication failures and expired authorization explicitly.
- Respect Swiggy's documented rate limits and retry behavior.
- Do not assume a payment method or payment flow is available; verify it in the current documentation.
- Do not fabricate availability, prices, ETAs, order status, booking status, or other Swiggy data.
- Preserve required Swiggy session/context state explicitly in Nosh rather than relying only on LLM context.
- Monitor Swiggy deprecation information and adapt before deprecated capabilities are removed.

## Commerce Safety
- Never place an order or booking without explicit user confirmation immediately before the irreversible action.
- Confirmation must show the relevant final details, including items/details and total where applicable.
- Enforce confirmation in deterministic application code; do not rely only on the LLM prompt.
- Never blindly retry order/booking operations. Check whether the operation succeeded before retrying.
- Do not assume payment methods or payment capabilities; verify them in current Swiggy docs.

## WhatsApp
- Use the official Meta WhatsApp Cloud API documentation for WhatsApp behavior.
- Webhook verification must follow Meta's documented mechanism.
- Never commit Meta credentials, webhook secrets, or access tokens.
- The Meta test number is suitable for development; production phone-number requirements must be verified against current Meta documentation.

## Development
- Inspect the existing implementation before modifying it.
- Make the smallest change required for the requested task.
- Do not refactor unrelated code.
- Do not add dependencies or infrastructure without a concrete reason.
- Do not automatically start services, containers, tests, or external integrations; run them only when explicitly requested.
- Never perform real orders/bookings as an implementation test unless explicitly requested.
- After implementation, report changed files and concise manual test steps.

## Repository-Specific Context
- Put newly discovered, reusable implementation gotchas here when they are specific enough to prevent a future mistake.
- Prefer exact facts and commands over general principles.
- Remove obsolete instructions when the implementation changes.
- Chat conversation logging (src/conversation-log.js, for debugging reported issues - see scripts/view-chat-log.js) is a deliberate exception to "keep operational logs free of message content/identifiers" elsewhere in this codebase (see server.js's acknowledgeIncomingTextMessages). It requires CHAT_LOG_REDIS_URL + CHAT_LOG_ENCRYPTION_KEY (both or neither); if you add a new place that computes a user-facing reply, route it through server.js's buildReplyTextAndLog rather than calling buildReplyText directly, so it stays logged. Any change to what gets logged or how long it's kept must also update the privacy policy (src/privacy-policy.js) - it makes specific retention/encryption promises about this feature.
- 2026-09-21: replaced the classify-then-template-dispatch NLU layer (`src/nlu-client.js`, `classifyMessage`/`classifyOrderIntent`, deleted) with a real autonomous agent, `src/sarvam-agent.js`'s `runAgentTurn`, built on the official `sarvamai` npm SDK (pinned `1.1.10`, not the newest alpha - re-check `npm view sarvamai versions` before bumping). The agent decides on its own which Swiggy tool to call each turn (no more `hasActiveCart`-based tool-subset pre-filtering, no more regex trigger words) and phrases every reply itself, in the user's own language/register, for anything that goes through `runAgentTurn` (`src/food-search-orchestrator.js` and `src/food-order-orchestrator.js` now export thin tool-implementation functions - `searchFood`, `addToCart`, `removeFromCart`, `viewCart`, `findCoupons`, `applyCoupon`, `checkout`, `buildReorderUsualReply`, `describePastOrders` - that do the same Swiggy-calling work as before and return already-good English text, which the agent is instructed to translate/relay rather than repeat verbatim). This does NOT cover every user-facing string: the two deterministic short-circuits below and the entire YES/NO confirmation flow (`buildOrderConfirmationReply`'s re-prompt/cancel text, `placeConfirmedOrder`'s failed/placed/confirmed text in `src/food-order-orchestrator.js`) never touch the agent and stay fixed English by design (the confirmation flow especially - it's the safety-critical path and deliberately not LLM-phrased). A Hindi/Hinglish speaker will still see literal English at those points; known, not yet asked for by the user, worth surfacing rather than silently living with it.
- The agent's tool list (`TOOLS` in `src/sarvam-agent.js`) deliberately has **no tool that maps to `place_food_order` or `confirm_order`** - those two Swiggy calls are reachable ONLY through `placeConfirmedOrder`, which is reachable ONLY from `server.js`'s `buildOrderConfirmationReply`, which is reachable ONLY after `parseOrderConfirmationReply` (a plain anchored regex, unchanged) matches a literal YES/NO. This is AGENTS.md's non-negotiable Commerce Safety rule made structural, not just prompted - if you ever add a new tool to `TOOLS`, it must not be able to reach either of those two Swiggy calls, full stop. The system prompt also tells the agent to always ask for a literal English "YES"/"NO" when relaying a checkout summary, even mid-reply-in-another-language - the regex only recognizes those tokens (plus a small synonym set), so a translated confirmation prompt would otherwise silently break the gate for a non-English speaker.
- Two categories of message stay deterministic, checked BEFORE the agent ever runs (see `buildReplyText` in `server.js`): a bare number reply to a list the bot already showed (`resolvePendingAddressReply` in food-search-orchestrator.js, `resolvePendingCartCandidateReply` in food-order-orchestrator.js) - zero extra Sarvam calls, works in any language since it's just a digit - and the YES/NO confirmation gate above. Neither is a "trigger word" in the sense of free-text intent detection; don't route either through the agent to satisfy a literal reading of "no trigger words." `resolvePendingAddressReply` specifically must return `{ handled: false }` (after clearing the stale prompt) for a non-numeric reply, NOT re-prompt unconditionally - an earlier version of this function always re-showed the address list on anything that wasn't a valid number, which trapped a sender who changed their mind (e.g. "actually, find pizza instead") with no way out short of picking a number for the old search. `resolvePendingCartCandidateReply` already got this right (falls through to `{handled: false}` on a non-numeric reply); mirror that pattern in any future deterministic short-circuit of this shape.
- Conversation context (`src/pending-conversation-history.js`, `PendingConversationHistory`) is in-memory only, per sender, capped at 20 turns, and cleared exactly where `pendingCartSessions` is cleared on `status === "confirmed"` in `buildOrderConfirmationReply` - NOT on a plain NO/cancel, which keeps the cart (and so the conversation context) around. It's deliberately separate from `src/conversation-log.js` (the encrypted, 14-day, debug-only Redis log with its own privacy-policy promises) - never merge the two.
- Sarvam's chat-completions rate limit for `sarvam-105b` specifically is 40 req/min on the Starter tier (lower than Sarvam's other chat models - see `docs.sarvam.ai/api/getting-started/ratelimits`), and the agent loop can cost 2+ Sarvam calls per user turn (decide-tool-call, then final-phrased-reply, more for multi-tool turns - capped at `MAX_TOOL_ROUNDS = 4` in `src/sarvam-agent.js`). That's roughly a 20 msg/min ceiling before `429`s start - they fail closed the same as any other Sarvam-call failure (propagates out of `runAgentTurn`, caught and logged - not thrown into a template - in `replyToIncomingTextMessages`), not silently. Don't add retry/backoff for this without deciding it's actually wanted - the fail-closed behavior is intentional.
- `src/sarvam-agent.js` sends an explicit `max_tokens: 4096` on every `chat.completions` call rather than relying on Sarvam's default (2048). With `reasoning_effort` enabled, reasoning tokens are billed against the SAME `max_tokens` budget as the final reply (`docs.sarvam.ai/api/api-guides-tutorials/chat-completion/overview`) - a budget eaten entirely by reasoning comes back as `finish_reason: "length"` with an empty `content` and a populated `reasoning_content`, which `runAgentTurn` cannot tell apart from "the model genuinely had nothing to say" by content alone (both return `undefined`). The `!finalText` branch logs `finishReason`/`hadReasoningContent` specifically so this is distinguishable in Render logs; if you see repeated `"Sarvam agent turn produced no usable final content"` with `hadReasoningContent: true`, raise `MAX_TOKENS`, not `reasoning_effort` down (that would just make the recommend-something-similar reasoning worse).
- 2026-09-20 production incident, confirmed via Render logs (`whatsapp-test-webhook-low-latency`): every real WhatsApp message failed with `SarvamAIError`, `Status code: 404`, `{"error":{"message":"Not Found","code":"not_found_error"}}`, immediately after the sarvam-agent.js rollout. Root cause: `config.js`'s `DEFAULT_NLU_BASE_URL` was `"https://api.sarvam.ai/v1"`, left over from the old `nlu-client.js`'s plain-fetch implementation - but the `sarvamai` SDK's `ChatClient` appends `"v1/chat/completions"` to whatever `baseUrl` it's given itself (see `node_modules/sarvamai/dist/cjs/api/resources/chat/client/Client.js` and its own default in `environments.js`), so the `/v1` suffix doubled up into `.../v1/v1/chat/completions`, a real 404. Fixed by dropping the default to the bare origin `"https://api.sarvam.ai"`. **If `NLU_BASE_URL` is ever set as an actual env var (on Render or anywhere else, not just the code default) it must also be a bare origin with no `/v1` suffix** - the code fix alone doesn't help if an env var is overriding it with the old value; check the deployment's env vars directly, not just the code, when diagnosing a repeat of this. The Ollama local-dev example in `.env.example` had the identical bug (`http://localhost:11434/v1`) and was fixed the same way. General lesson: when swapping an implementation that built a URL by hand for one that ships an SDK, re-derive every URL-shaped config value from the SDK's own source rather than carrying the old value forward unchecked - this exact case was flagged as "not yet confirmed against a real API key/real WhatsApp traffic" in the entry below at the time it shipped, and the first real traffic broke it within minutes.
- The same rule that caused the 2026-09-20 NVIDIA→Sarvam incident still applies to any future NLU-provider or model change: do not pick a model by guessing a plausible-sounding name; verify tool-calling support and the API key's inference entitlement empirically first (a `GET /models`-style endpoint listing a model does not mean the key is entitled to call chat/completions on it, or that it supports tool calling at all). `sarvam-105b` (not `-conversations`) was chosen for the agent specifically because the SDK's own shipped `.d.ts` documents it, not `-conversations`, as the one for "agentic workflows" - this has NOT yet been confirmed against a real API key/real WhatsApp traffic end-to-end; do that with `scripts/food-order-check.js` and a Hindi/Hinglish probe like "mujhe biryani mangwani hai" before trusting it in production.
- 2026-09-21 production bug, confirmed live: a recommendation ("I want to eat something good") was surfacing `search_food`'s numbered restaurant list and asking the user to pick, defeating the entire point of a recommendation. Two compounding causes, both fixed: (1) `describePastOrders`'s returned instruction text told the agent to "call search_food or search_menu" - but `search_menu` has never been an agent tool (only 9 tools are exposed, see `TOOLS` in `src/sarvam-agent.js`; `search_menu`/`get_restaurant_menu` are internal Swiggy calls used only inside `food-*-orchestrator.js`'s own helpers, never exposed directly), so the agent was pointed at a nonexistent tool. (2) The system prompt's numbered-list-preservation rule ("keep every number... reply with the number") applied unconditionally to every tool result, with no carve-out - so when the agent correctly fell back to `search_food` alone, it dutifully relayed the list and asked the user to choose, exactly as instructed. Fixed by explicitly exempting `search_food`'s restaurant list during a recommendation from the list-preservation rule, and adding a directive (in the system prompt, `RECOMMEND_SIMILAR_TOOL`'s description, and `describePastOrders`'s own returned text - three places on purpose, same belt-and-suspenders pattern as the YES/NO checkout wording) that the agent must silently pick one open restaurant + one real dish itself and call `add_to_cart` directly, presenting only the finished pick. `handleAddToCart`/`resolveRestaurant` already supported resolving a restaurant fresh from a plain name hint with no prior numbered-list session (confirmed by reading `src/food-order-orchestrator.js:449-473` and `:634-660`) - this was a prompt-instruction bug, not a missing capability, so no orchestrator code changed. If a future "should decide for the user" flow needs this same pattern, mirror it: reuse an existing hint-based resolve path rather than adding a new tool, and make sure every place that tells the agent what to do next names only tools that actually exist in `TOOLS`.

## Nosh Conversation Design
- Nosh must behave as a conversational assistant, not an MCP/API interface.
- Users must be able to express intent naturally; do not require commands, Swiggy terminology, or structured syntax.
- Support natural multilingual input, including Hindi, Hinglish, and native scripts.
- Use conversation state to avoid asking for information the user has already provided.
- Progressively narrow choices: discover → narrow → select → customize → review → confirm → execute.
- Prefer concise responses; do not dump raw MCP results or unnecessarily large lists.
- When presenting choices, show only decision-relevant information such as name, rating, distance, ETA, and price where applicable.
- Ask clarifying questions only when the request cannot be safely resolved from available context.
- Never invent availability, prices, ETAs, order status, booking status, or other external-service information.
- Never expose MCP tool names, internal IDs, tokens, JSON, raw errors, or implementation details to users.
- All irreversible actions require explicit, user-visible confirmation immediately before execution.
- The deterministic execution layer must enforce the confirmation requirement independently of the LLM.

## Swiggy Production Access — Non-Negotiable

Nosh must remain compliant with Swiggy's production-access requirements.

### Application Requirements
- Maintain accurate company/developer identity and Nosh use-case information.
- Keep the integration architecture documented and current.
- Keep all OAuth redirect URIs exact and controlled.
- Maintain documented static IP/gateway IP ranges where required.
- Maintain a security contact.
- Maintain a clear data-handling and privacy declaration.
- Document production infrastructure and environment configuration.
- Acknowledge and comply with Swiggy MCP terms.
- Maintain security documentation/audit material where applicable.
- Maintain expected traffic and scaling information as the system grows.

### Platform Rules
- Use Swiggy MCP only within the capabilities and scope granted to Nosh.
- Do not resell, share, or expose Nosh's Swiggy MCP access to unapproved third parties.
- Do not build an aggregation layer that hides Swiggy's brand or confuses users about the service being used.
- Never misrepresent Swiggy prices, availability, delivery times, booking information, or order status.
- Never scrape or extract data beyond what Swiggy MCP provides.
- Never use Swiggy MCP for competitive intelligence or benchmarking.
- Never bypass rate limits, logging, authentication, whitelisting, or platform safeguards.
- Never manipulate Swiggy order flows, incentives, or ranking systems.
- Never use dark patterns, deceptive UX, fake traffic, or misleading attribution.
- Never harvest data beyond Nosh's agreed scope.
- Never reverse engineer Swiggy MCP internals.
- Never circumvent Swiggy access controls or whitelisting.
- Follow Swiggy's branding and attribution requirements so users understand when Swiggy services/data are involved.
- Treat Swiggy transaction data according to Swiggy's platform terms and applicable privacy regulations.
- If Nosh needs a capability outside its approved scope, stop and obtain the appropriate Swiggy approval rather than working around the restriction.

### Production Readiness
- Keep API usage observable and auditable.
- Design for gradual rollout rather than immediately sending unrestricted production traffic.
- Do not artificially generate traffic or manipulate usage metrics.
- Do not benchmark Swiggy MCP through production traffic.
- Keep security, privacy, infrastructure, traffic, and architecture documentation current enough to support Swiggy's production review.

## Claude Code
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
## Swiggy Builders Club
 
When writing code against Swiggy MCP (Food, Instamart, Dineout),
consult the authoritative docs at:
 
- Index:     https://mcp.swiggy.com/builders/llms.txt
- Full text: https://mcp.swiggy.com/builders/llms-full.txt
- Per-page:  append `.md` to any https://mcp.swiggy.com/builders/docs/... URL
 
Before recommending a tool name, parameter, error code, rate limit, or
auth flow, verify against these docs. The tool catalog lives under
`/docs/reference/{food,instamart,dineout}`.