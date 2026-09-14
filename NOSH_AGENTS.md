# Nosh — Codex Project Instructions

## Project

Nosh is FoodieLab's cloud-hosted, WhatsApp-first AI food and commerce agent. The MVP has no CLI and no web app. Users interact with Nosh through WhatsApp using natural language, including Hindi, Hinglish, and native Indian-language scripts.

Target flow:

WhatsApp → Nosh backend → Nosh agent/orchestrator → Swiggy MCP → Nosh response → WhatsApp

Nosh will support Swiggy Food, Instamart, and Dineout. A database stores the minimum user identity, preferences, and personalization data needed by the product.

## Current priority

Build a near-production-like demo incrementally. The first working flow is:

WhatsApp message → understand request → use the appropriate Swiggy MCP capability → respond through WhatsApp.

Implement one small, coherent step at a time. Do not build the entire product at once.

## Architecture

Keep these responsibilities separate:

- WhatsApp integration: receiving/sending messages and Meta webhook verification.
- Nosh backend: authentication, user/session handling, persistence, APIs, logging, and orchestration.
- Agent/orchestrator: uses `gpt-oss-20b` to understand requests, choose actions, and produce responses.
- Deterministic control/execution: validates important actions and controls side effects rather than letting the LLM directly perform arbitrary operations.
- Swiggy MCP: external Food, Instamart, and Dineout capabilities.
- Database: user identity, preferences, required session state, and product data.

Avoid premature microservices and unnecessary abstractions. Prefer a simple deployable backend until the product requires separation.

## Models

Use:
- Model: `openai/gpt-oss-20b`
- NVIDIA API base URL: `https://integrate.api.nvidia.com/v1`

Keep API configuration in environment variables or secrets. Never commit API keys, access tokens, webhook secrets, OAuth tokens, or other credentials.

## Swiggy MCP

Swiggy Builders Club is the source of truth:

https://mcp.swiggy.com/builders/

Before implementing or changing Swiggy integration, consult the current official documentation for the exact capability, tool name, parameters, authentication requirements, and behavior.

Never invent MCP tool names, parameters, error codes, authentication flows, or capabilities.

Swiggy MCP uses OAuth 2.1 + PKCE and supports multi-user/delegated authorization. Treat each user's authorization/session data as a secret and store it securely.

## External docs - Swiggy Builders Club
 
This project integrates Swiggy MCP servers. Before writing Swiggy code,
fetch the authoritative docs:
 
- Index:     https://mcp.swiggy.com/builders/llms.txt
- Full text: https://mcp.swiggy.com/builders/llms-full.txt
- Per-page:  append `.md` to any https://mcp.swiggy.com/builders/docs/... URL
 
Use `/docs/reference/{food,instamart,dineout}` for tool schemas and
`/docs/operate/errors` for the canonical error taxonomy. Do not invent tool names or parameters.

## WhatsApp

Use the official Meta WhatsApp Cloud API documentation as the source of truth.

WhatsApp is the only user-facing interface for the MVP. Support the webhook flow required to receive messages and send responses.

The Meta-provided test number may be used during development. Do not hard-code assumptions about production numbers or business verification status.

Validate webhook requests according to Meta's documented mechanism. Keep credentials and verification secrets out of source control.

## Security and privacy

Treat WhatsApp messages, user identifiers, preferences, addresses, order information, authorization tokens, and commerce activity as sensitive data.

Use least-privilege access, secure secret storage, input validation, safe logging, and clear error handling.

Never log access tokens, API keys, authorization codes, or unnecessary personal data.

Collect only the data Nosh actually needs. Production release requires an appropriate privacy policy and user-facing privacy/data handling.

## Development workflow

Inspect the existing repository before changing anything. Preserve working behavior and follow existing conventions.

Make the smallest change necessary for the requested step. Do not refactor unrelated code.

Do not build a CLI or web UI unless explicitly requested. The product interface is WhatsApp.

The user will manually test changes unless they explicitly ask Codex to run tests or services. Do not automatically start servers, containers, test suites, or external integrations.

When finished, briefly report what changed and how the user can manually test it, then stop.

## Testing

Prefer small deterministic tests for logic that does not require external services.

For WhatsApp, Swiggy, OAuth, or other external integrations, isolate integration boundaries so most application behavior can be tested independently.

Never claim an integration works unless it has actually been verified.

## Error handling

Handle external-service failures, expired authentication, invalid responses, and unavailable services explicitly.

User-facing errors should be understandable. Internal errors should contain enough structured information for debugging without leaking secrets or unnecessary personal data.

## Documentation

Keep important architecture and product decisions in repository documentation rather than relying on chat history.

If a decision materially changes the architecture or workflow, update the relevant documentation.

Keep this file concise. Put detailed project knowledge in focused documentation files as the repository grows.
