# Nosh backend

This is the initial backend foundation for Nosh, FoodieLab's WhatsApp-first AI food and commerce agent.

## Included in this increment

- A dependency-free Node.js HTTP service suitable for a container or VM.
- `GET /health` for platform health checks.
- `GET /` to confirm the service is reachable.
- A WhatsApp webhook endpoint at `GET`/`POST /webhooks/whatsapp`.
- Meta challenge verification and HMAC-SHA256 signature validation for webhook deliveries.
- Parsing of supported inbound WhatsApp text messages into a small internal shape.
- Environment-based configuration with validation for `PORT`.
- Graceful handling of `SIGINT` and `SIGTERM` for cloud shutdowns.

The webhook acknowledges valid WhatsApp events. It extracts only non-empty inbound text messages and records only a count in operational logs; it does not log message content or identifiers. It does not yet persist messages, call the model, or send a reply. Those will be introduced in separate, small increments.

## Prerequisite

Node.js 20 or later.

## Run locally

```powershell
npm start
```

In another terminal, check the service:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

Expected response:

```json
{"status":"ok","service":"nosh-backend"}
```

## Configure the WhatsApp webhook

Before registering a callback URL with Meta, set these two secrets in your local shell or deployment secret manager:

- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`: a high-entropy value you create and enter again in Meta's webhook configuration.
- `META_APP_SECRET`: your Meta app secret.

They must be set together. The backend does not expose either value and refuses incoming webhook traffic until both are configured.

Meta should use this callback path:

```
https://your-public-domain/webhooks/whatsapp
```

During callback registration, Meta sends a `GET` request containing `hub.mode`, `hub.verify_token`, and `hub.challenge`. The backend returns the challenge only when the configured verification token matches. For each subsequent `POST`, it verifies the raw request body using the `X-Hub-Signature-256` HMAC-SHA256 header before acknowledging the event.

To use another port for the current PowerShell session:

```powershell
$env:PORT = 8080
npm start
```

## Deploying this increment

Use `npm start` as the start command. Configure the platform health check to call `GET /health`. AWS and Google Cloud both commonly inject `PORT`; the service reads it automatically.

Keep deployment secrets in the platform's secret manager or environment configuration. Do not commit `.env` files.
