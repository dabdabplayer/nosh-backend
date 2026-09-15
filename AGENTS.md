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