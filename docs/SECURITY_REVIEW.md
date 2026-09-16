# Nosh Security Review — 2026-09-16

Pre-AWS-migration security review, run against the local dev instance
(`src/server.js` via `node --env-file=.env src/server.js`) at the user's
explicit request, specifically to avoid disturbing the live Render
deployment. Two parts: a static code review for plaintext storage of
sensitive data, and an active adversarial test battery against the running
server.

## Scope

- The Node.js backend (`src/`) as of commit `891d18c` plus the uncommitted
  token-encryption fix from this review (see "Findings" below).
- WhatsApp webhook ingestion, Swiggy OAuth flow, token storage, and general
  HTTP-layer hardening.
- Out of scope: Swiggy's own MCP servers, Meta's WhatsApp Cloud API
  infrastructure, and anything requiring production credentials (all
  testing used local dev secrets only, with `WHATSAPP_ACCESS_TOKEN` removed
  for the duration of the active test phase to guarantee no real outbound
  WhatsApp message could be sent as a side effect).

## Overall rating: **Good, with one real fix applied and one open hardening item**

The codebase held up well against a real adversarial pass — no injection,
no auth bypass, no crash, no information disclosure found anywhere in the
attack surface tested. One genuine plaintext-secrets-at-rest finding was
found and fixed during this review (see below). This is a pre-production,
low-traffic app, not a hardened multi-tenant SaaS product — the rating
reflects that context, not a formal third-party audit.

## Part 1 — Static review: plaintext storage of sensitive data

| Item | Finding | Status |
| --- | --- | --- |
| Swiggy OAuth token **values** (`accessToken`/`refreshToken`) in `data/swiggy-tokens.json` | **Real finding.** A live, real access/refresh token pair from earlier live testing was sitting on disk in complete plaintext — anyone with filesystem read access could use it to act as that Swiggy user for up to 5 days (the token lifetime). Sender-ID hashing (from an earlier fix this session) only protected the *lookup key*, not the secret values themselves. | **Fixed.** `SwiggyTokenStore` now encrypts the whole record with AES-256-GCM before writing (`src/swiggy-token-store.js`). New required env var `SWIGGY_TOKEN_ENCRYPTION_KEY` (32 random bytes, base64). Decryption failure (wrong/rotated key, corruption) fails closed — treated as "no token," forcing a normal reconnect, never a crash. The one real exposed token found was deleted. |
| WhatsApp sender IDs (phone numbers) at rest | Hashed (SHA-256) before touching disk — done in an earlier fix this session, re-confirmed still correct. | ✅ Clean |
| Secrets in git history | `.env` and `data/` are gitignored; `git log --all -p -- .env` shows no history at all (never committed); `.env.example` contains no real values. | ✅ Clean |
| Logging | Every `console.*` call site in `src/` was reviewed — none print tokens, message content, or phone numbers; only error names, tool names, counts, and durations. | ✅ Clean |
| Other persistent storage | Only one file-write path exists anywhere in the codebase (`SwiggyTokenStore`); every other "Pending*" store is in-memory only, never touches disk. | ✅ Clean |
| Dependency vulnerabilities | `npm audit` — 0 vulnerabilities across 95 production dependencies. | ✅ Clean |

## Part 2 — Active adversarial test battery

All tests run as real HTTP requests against the locally running server
(`localhost:3000`), not read from code. `WHATSAPP_ACCESS_TOKEN` was removed
from the local environment for the duration of this phase so that even a
fully valid, correctly-signed test message could not trigger a real
outbound WhatsApp send as a side effect.

| # | Test | Method | Result |
| --- | --- | --- | --- |
| 1 | Webhook subscription handshake, wrong verify token | `GET /webhooks/whatsapp?hub.verify_token=WRONG...` | ✅ 403, no challenge echoed |
| 2 | Webhook subscription handshake, correct verify token | `GET /webhooks/whatsapp?hub.verify_token=<real>...` | ✅ 200, challenge correctly echoed |
| 3 | Webhook POST, no signature header | `POST /webhooks/whatsapp` | ✅ 401 `invalid_webhook_signature` |
| 4 | Webhook POST, malformed signature (fails format regex) | `POST` with garbage `X-Hub-Signature-256` | ✅ 401, rejected before any HMAC computation |
| 5 | Webhook POST, wrong-but-well-formed signature | `POST` with a real-looking but incorrect signature | ✅ 401 |
| 6 | Timing-safety of signature/token comparison | Code review of `secretsMatch()` in `whatsapp-webhook.js` | ✅ Uses `crypto.timingSafeEqual` correctly for both the verify-token and HMAC checks |
| 7 | Method fuzzing on webhook path | `PUT`/`DELETE`/`OPTIONS` | ✅ Consistent, safe responses (503 given local config state at the time), no crash |
| 8 | Path traversal | `GET /../../../etc/passwd`, `/data/swiggy-tokens.json`, `/.env` | ✅ All 404 — no static file serving exists anywhere in the router, so traversal is structurally impossible |
| 9 | OAuth connect-link token guessing | `GET /oauth/swiggy/start?token=<guessed>` | ✅ Consistent generic 400, regardless of input |
| 10 | OAuth `state` (CSRF) guessing/replay | `GET /oauth/swiggy/callback?state=<guessed>` | ✅ Consistent generic 400 |
| 11 | Token/state entropy | Code review: `randomBytes(16)` (connect token) and `randomBytes(16)` via `generateState()` — 128 bits each, single-use (`.take()` deletes on read) | ✅ Cryptographically unguessable, no replay after first use |
| 12 | Reflected XSS / injection via query params | `<script>alert(1)</script>` in `token` param | ✅ Never reflected anywhere; responses are `text/plain` regardless |
| 13 | Memory-exhaustion DoS via unbounded token stores | Code review of `PendingConnectLinks`/`PendingOAuthExchanges` growth paths | ✅ Both only grow in response to already-gated actions (a signature-verified WhatsApp message, or a valid pre-issued connect token) — anonymous guessing traffic cannot grow them |
| 14 | Full valid, correctly-signed text message | Byte-exact HMAC-signed `POST` with a real message shape | ✅ 200, processed correctly, no crash (send path was disabled for this test — see Scope) |
| 15 | Prototype pollution via `__proto__` key in JSON body | Byte-exact HMAC-signed `POST` with `"__proto__":{"polluted":"yes"}` in the payload | ✅ Not exploitable — verified empirically (`JSON.parse` creates a normal own property, does not touch the real prototype chain) *and* by code search (no `Object.assign`/spread/`for...in` copying of parsed payload fields anywhere in `src/`) |
| 16 | Wrong `object` type, malformed JSON, empty object (all validly signed) | `POST` with `{"object":"not_whatsapp",...}`, `not even json {{{`, `{}` | ✅ Clean 400s (`invalid_whatsapp_webhook_payload`), no crash |
| 17 | Oversized payload (2MB vs. documented 1MB limit) | Byte-exact HMAC-signed 2MB body | ✅ 413 `payload_too_large`, server stayed healthy immediately after |
| 18 | Server survival across the full battery | `GET /health` after every phase | ✅ Stayed responsive (`200`) throughout — no crash, no hang, at any point |

## Open item (not fixed, flagged for a decision)

- **No TTL on connect-link tokens or OAuth `state` values** (`PendingConnectLinks`, `PendingOAuthExchanges`). Not exploitable today — 128-bit entropy makes brute-forcing infeasible regardless of how long a token stays valid — but a leaked-and-unused token remains valid indefinitely instead of expiring after, e.g., 10 minutes. Low severity, real defense-in-depth gap. Not yet actioned as of this writing.

## What this review did **not** cover

- Load/DoS resilience at volume (only single-request tests were run; no burst/concurrency stress test).
- Anything requiring real production Swiggy or Meta credentials (this session's other work already covers Swiggy MCP error handling and retry behavior separately — see `docs/RUNBOOK.md`).
- Infrastructure-level hardening (AWS IAM, network ACLs, secrets-manager integration) — not yet applicable, migration hasn't happened yet.
- Static analysis tooling (no SAST/linter security plugin run — this was a manual review plus `npm audit`).
