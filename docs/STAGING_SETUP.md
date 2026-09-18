# Testing The Full Conversation Flow On Render Against Swiggy Staging

How to point the Render deployment at Swiggy's staging environment so the
whole WhatsApp conversation → Swiggy flow (connect → search → cart →
confirm → `place_food_order`) can be exercised end-to-end **without placing
a real order**. Grounded in this codebase's actual OAuth wiring
([src/server.js](../src/server.js), [src/config.js](../src/config.js)) and
Swiggy's own docs as of this writing
([access/onboarding](https://mcp.swiggy.com/builders/docs/operate/access.md),
[authenticate](https://mcp.swiggy.com/builders/docs/start/authenticate.md)).

## What "staging" actually means here

Swiggy's staging MCP environment is "backed by seeded data (no real
orders)" - `place_food_order` and every other tool call succeed exactly as
they would in production, but against a fake catalog. This is different
from a local dev stub you'd write yourself: staging is Swiggy's own server,
reached over the real OAuth 2.1 + PKCE flow, with real phone/OTP login. That
matters because it means the redirect-URI requirement below still applies
in staging - it is not a shortcut around Swiggy's application review.

**Not yet confirmed, do not assume**: whether Swiggy's staging environment
uses the same `https://mcp.swiggy.com/auth` OAuth base URL as production, or
a separate staging auth host/URL. Swiggy's docs describe staging access as
something granted after application review but don't spell out a distinct
base URL in the pages fetched for this doc. Get the actual staging
`SWIGGY_FOOD_MCP_URL` (and confirm the OAuth base URL to use with it) from
Swiggy directly (`builders@swiggy.in` or your access-application contact) -
do not guess a URL by pattern-matching the production one.

## Prerequisite that lives outside this repo (Swiggy's side)

Redirect URIs are validated as part of Swiggy's application review and
issued alongside your credentials - they are **not** something you
self-register afterward. Before setting the Render env vars below, confirm
with Swiggy that:

1. You have staging (not just local-dev-stub) access.
2. The exact URL `https://<your-render-service-domain>/oauth/swiggy/callback`
   is the one on file for that access grant. If your original application
   only listed `http://localhost:3000/oauth/swiggy/callback`, the OAuth
   flow will fail with a redirect_uri mismatch the moment a real user hits
   it on Render, and that is fixed by updating the application with Swiggy
   (`builders@swiggy.in`), not by changing anything here.

## Render environment variables to set

| Variable | Value | Why |
|---|---|---|
| `SWIGGY_FOOD_MCP_URL` | Swiggy's **staging** Food MCP URL (get this from Swiggy, see caveat above) | Gates `config.swiggyFood.enabled` in [src/config.js](../src/config.js) - unset, every reply is the placeholder text and no Swiggy call happens at all |
| `SWIGGY_OAUTH_REDIRECT_URI` | `https://<your-render-service-domain>/oauth/swiggy/callback` | Must be the exact string already on file with Swiggy for this access grant (see prerequisite above). Also determines the domain of the `/oauth/swiggy/start` link Nosh sends over WhatsApp - `server.js` builds that link from `new URL(config.swiggyOAuth.redirectUri).origin`, so leaving this at its `localhost` default would send users a link to their own machine, not to Render |
| `SWIGGY_OAUTH_CLIENT_ID` | Leave unset unless Swiggy gave you a specific one | Defaults to `"swiggy-mcp"` - per the comment in [src/config.js](../src/config.js), Swiggy's Dynamic Client Registration currently returns this same value regardless of the registering app, confirmed by registering twice with different inputs |
| `SWIGGY_OAUTH_BASE_URL` | Confirm with Swiggy whether staging uses the same base URL as production (`https://mcp.swiggy.com/auth`, the default) or a separate one | Do not assume - see the "not yet confirmed" note above |
| `WHATSAPP_ACCESS_TOKEN` | Your WhatsApp Cloud API access token | Without this, `config.whatsapp.sendEnabled` is false and Nosh never sends a reply, including the connect link itself |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` / `META_APP_SECRET` | Must match what's configured on the Meta app's webhook subscription | Required together; gates `config.whatsapp.enabled` |
| `DYNAMODB_TABLE_NAME` / `SWIGGY_TOKEN_ENCRYPTION_KEY` | Your provisioned table name / a 32-byte base64 key | Required at startup regardless of staging vs production - the server won't boot without both |
| `ROLLOUT_PERCENT` | Leave unset (defaults to 100) unless you're deliberately testing the gradual-rollout gate | `isSenderInRollout` in [src/rollout.js](../src/rollout.js) buckets senders deterministically by this percentage |

Also confirm separately, in Meta's own dashboard (not a Render env var):
the WhatsApp webhook callback URL registered there points at
`https://<your-render-service-domain>` + whatever `WHATSAPP_WEBHOOK_PATH` is
set to (default `/webhooks/whatsapp`).

## Test procedure

1. Deploy to Render with the env vars above set.
2. From a real WhatsApp number, message your Nosh WhatsApp Business number
   with a food-related request (e.g. "find biryani near me").
3. Expect a reply containing a connect link
   (`buildConnectReplyText` in [src/swiggy-auth-flow.js](../src/swiggy-auth-flow.js)).
   If you instead get the placeholder "We're still setting things up..."
   text, `config.swiggyFood.enabled` is false - `SWIGGY_FOOD_MCP_URL` isn't
   set on Render.
4. Tap the link on the same phone. It should open Swiggy's real staging
   login (phone + OTP) - if it errors immediately instead, this is almost
   always the redirect_uri mismatch described in the prerequisite above,
   not a bug in this flow.
5. After approving, you should land back on a Nosh page confirming the
   connection, and get a WhatsApp message confirming it - your original
   search should resume automatically (`resumePendingSearchAfterAuth` in
   [src/server.js](../src/server.js)).
6. Walk the conversation through to an order confirmation. The final
   `place_food_order` / `confirm_order` calls will succeed against seeded
   data - there is no real charge and no real delivery, by design of
   Swiggy's staging environment.

## Known gaps (read before assuming something is broken)

- This doc does not cover getting from staging to production access - see
  [docs/RUNBOOK.md](RUNBOOK.md) for what to do once a request actually
  reaches Swiggy and fails, and Swiggy's own
  [ship-to-production doc](https://mcp.swiggy.com/builders/docs/build/ship-to-production.md)
  for the go-live checklist (≥48h stable staging, then a gradual
  1%→10%→50%→100% ramp).
- Whether staging enforces the same rate limits documented for production
  (70 req/min, 30/min for write tools - see
  [docs/RUNBOOK.md](RUNBOOK.md)) was not confirmed while writing this doc.
