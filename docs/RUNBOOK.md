# Nosh Support Runbook: Swiggy MCP Failures

What to do when Swiggy returns X. Grounded in
[Swiggy's error codes doc](https://mcp.swiggy.com/builders/docs/reference/errors.md)
and this codebase's actual handling as of this writing
([src/swiggy-retry.js](../src/swiggy-retry.js)).

## How Nosh classifies a Swiggy failure today

Swiggy's symbolic error codes (`UNAUTHENTICATED`, `RATE_LIMITED`, etc.) are
documented as "planned, not yet emitted" - as of v1.0, failures have to be
told apart by message text and HTTP status. `classifySwiggyError` in
[src/swiggy-retry.js](../src/swiggy-retry.js) does this classification;
`withSwiggyRetry` wraps every Swiggy Food tool call with it.

**Important SDK quirk** (confirmed by reading `@modelcontextprotocol/sdk`'s
source, not assumed): the transport's `StreamableHTTPError` puts the HTTP
status on a property called **`.code`** (not `.status`), and `McpError`
*also* uses `.code` - but for the JSON-RPC error number instead. The two are
told apart by sign: a positive `.code` is an HTTP status, a negative one is
a JSON-RPC code. Swiggy's `-32001` is documented as "unauthenticated/expired
session" - this collides with the SDK's own generic enum name for that
number (`ErrorCode.RequestTimeout`); trust Swiggy's documented meaning for
their server, not the SDK's generic label.

| What you see | Classification | What Nosh does | What you should do |
|---|---|---|---|
| HTTP 401, JSON-RPC `-32001`, or message contains `"No or invalid session credentials"` | `reauth` | Drops the sender's stored token immediately (no retry) and falls back to the reconnect flow on their next message | Nothing, unless it's happening for *every* sender at once - see "Widespread auth failures" below |
| Message starts with `"Invalid "` or `"Missing "` | `terminal` | Fails immediately, no retry, surfaces a generic "couldn't do that right now" reply | Check the calling code passed the right arguments - this is a bug in our request, not a transient Swiggy problem |
| **HTTP 429** | `rate_limited` | Waits 30s (Swiggy's docs' suggested default - their SDK error discards the real `Retry-After` header, so we can't read the actual value) and retries, up to `maxAttempts` | If this is happening under normal single-user testing traffic, something is reconnecting far more than it should - see "Rate limiting" below, this is enforced **today**, not a future concern |
| HTTP 504, HTTP 502/503, or message contains `"timeout"` | `retry` | Retries up to 4 times with exponential backoff (500ms/1s/2s/4s + jitter) | Nothing, unless it happens on *every* attempt for a stretch of time - see "Sustained timeouts" below |
| HTTP 500 or JSON-RPC `-32603` | `retry-once` | One retry, then gives up | If it's still failing after the retry, this is likely a real Swiggy-side issue - check `status.swiggy.com/mcp` (once it ships) or escalate |
| Anything else unrecognized | `terminal` | Fails immediately - Nosh does **not** guess that an unrecognized error is safe to retry | If you see this a lot for one error, it's worth adding an explicit classification rather than leaving it as an unknown terminal failure |

## Rate limiting

Enforced **today** (confirmed from Swiggy's raw rate-limits doc - an earlier
version of this runbook, based on a stale/summarized fetch, wrongly said
this was "planned for v1.1"). Real ceilings, per authenticated user per
server: **70 requests/minute** (30/minute for write tools), burst allowance
2x steady-state for 10 seconds. The most common cause of hitting this isn't
raw traffic volume, it's **reconnecting per tool call instead of holding one
session per user** - Swiggy's own docs call this out as "the most common
cause of rate limit breaches in production." Nosh already does this
correctly: `createSwiggyFoodClient` is one connection per WhatsApp request,
reused for every tool call within it, not reconnected per call.

If you do get blocked, Swiggy's guidance is to stop retrying immediately and
email `builders@swiggy.in` - Nosh's automatic retry already backs off, but
persistent 429s past that need a human, not another retry.

## Widespread auth failures (many senders reconnecting at once)

1. Confirm it's not just one user's revoked/expired token - check whether
   multiple different senders are hitting `reauth` in the logs
   (`Swiggy Food tool call failed.` entries).
2. If it's widespread, suspect a Swiggy-side session/token invalidation
   event, not a bug in Nosh - check Swiggy's status page and your own
   OAuth client registration hasn't changed.
3. Do **not** try to work around this by having Nosh silently retry with
   the same token - `reauth` is intentionally non-retryable.

## Sustained timeouts / 5xx from Swiggy

1. Check whether it's isolated to one tool (e.g. only `search_restaurants`)
   or every Swiggy Food call - isolated points at a specific endpoint issue,
   broad points at a wider Swiggy MCP incident.
2. Confirm you're not being rate-limited (see below) - a burst of retries
   during a real outage can look like sustained failures from the retry
   logs alone.
3. If it's ongoing for more than a few minutes, escalate to Swiggy per
   their [support doc](https://mcp.swiggy.com/builders/docs/operate/support.md).
   Include the failing tool name and timeframe - Nosh does not currently
   have a documented session/request ID to hand them (see "Known gaps"
   below).

## Order placement failures specifically

`placeConfirmedOrder` in
[src/food-order-orchestrator.js](../src/food-order-orchestrator.js) is the
one non-idempotent, real-money path. If `place_food_order` throws:

1. Nosh already snapshots the sender's order list *before* attempting
   placement and diffs it against another read *after* the failure - if a
   new order appears, it's treated as placed and Nosh proceeds to confirm
   it rather than reporting failure (avoids a duplicate order on retry).
2. If you're investigating a user's report of "it said failed but I got
   charged" (or the reverse), check `get_food_orders` for that user's
   address directly - the diff-based check is best-effort and can
   theoretically misattribute if a second, genuinely different order lands
   in the same narrow window.
3. Never manually re-run `place_food_order` for a user without first
   checking `get_food_orders` yourself.

## Domain-level failures (bad coupon, closed restaurant, etc.)

These come back as a normal (non-`isError`) tool result whose *content*
encodes the failure - e.g. Food's cart-mutation envelope is
`{ statusCode, statusMessage, data }` with a non-zero `statusCode`
(confirmed live; do not assume Swiggy's docs' `{ success, data }` shape -
see the comment in
[src/food-order-orchestrator.js](../src/food-order-orchestrator.js)).
These are not retried and should not be - they're a real answer from
Swiggy, not a transport failure.

## Known gaps (read before assuming something is broken)

- **No documented session/request ID field exists yet.** Swiggy's own
  "ship to production" doc says every call is tagged with one and to log
  it, but no field name or location is documented anywhere we could find.
  Nosh currently logs tool name, duration, and outcome per call
  ([src/swiggy-food-client.js](../src/swiggy-food-client.js)) but nothing
  Swiggy support can correlate against on their end. If Swiggy documents
  this later, wire it in here.
- **`_meta.swiggy.deprecation` won't appear until Swiggy's v1.1 ships.**
  Nosh already checks for it on every call and logs a warning if present
  ([src/swiggy-food-client.js](../src/swiggy-food-client.js)) - this is
  pre-wired and inert until Swiggy turns it on.
- **Instamart and Dineout are not integrated.** Only Swiggy Food is wired
  into Nosh today. If a user asks for groceries or a restaurant booking,
  Nosh has no path for that request.
