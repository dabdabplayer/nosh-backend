import { COMPONENTS, isOutageStatus, reportFailure, reportSuccess } from "./status-reporter.js";

export class WhatsAppSendError extends Error {
  constructor(status, cause) {
    super(`WhatsApp send message request failed with status ${status ?? "unknown"}.`);
    this.name = "WhatsAppSendError";
    this.status = status;
    this.cause = cause;
  }
}

// Sends a WhatsApp Cloud API text message. See
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
export async function sendTextMessage({
  accessToken,
  apiVersion,
  phoneNumberId,
  to,
  text,
  fetchImpl = fetch,
}) {
  let response;
  try {
    response = await fetchImpl(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { body: text },
        }),
      },
    );
  } catch (error) {
    reportFailure(COMPONENTS.whatsapp);
    throw new WhatsAppSendError(undefined, error);
  }

  if (!response.ok) {
    // Other 4xx responses are about this one message (e.g. outside the 24h
    // window), not a WhatsApp outage.
    if (isOutageStatus(response.status)) {
      reportFailure(COMPONENTS.whatsapp);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    throw new WhatsAppSendError(response.status, body);
  }

  reportSuccess(COMPONENTS.whatsapp);
  const body = await response.json();
  const message = body?.messages?.[0];

  return Object.freeze({
    id: message?.id,
    status: message?.message_status,
  });
}

// Marks an incoming message as read (blue ticks, and every earlier message
// in the chat too) and shows "typing…" until Nosh replies or 25 seconds
// pass. Meta only allows the typing indicator together with a read receipt.
// https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators/
// Meta's docs don't say which Graph API version the typing indicator needs,
// so if Meta rejects the request the plain read receipt is sent instead.
export async function sendReadReceipt({
  accessToken,
  apiVersion,
  phoneNumberId,
  messageId,
  fetchImpl = fetch,
}) {
  const post = async (withTypingIndicator) => {
    let response;
    try {
      response = await fetchImpl(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
          ...(withTypingIndicator ? { typing_indicator: { type: "text" } } : {}),
        }),
      });
    } catch (error) {
      throw new WhatsAppSendError(undefined, error);
    }
    await response.body?.cancel();
    return response;
  };

  let response = await post(true);
  let typingIndicator = true;
  if (response.status === 400) {
    typingIndicator = false;
    response = await post(false);
  }
  if (!response.ok) {
    throw new WhatsAppSendError(response.status);
  }
  return { typingIndicator };
}

// Meta's length limits for interactive messages, in characters.
const LIMITS = Object.freeze({
  buttonTitle: 20,
  buttonBody: 1024,
  maxButtons: 3,
  listButton: 20,
  rowTitle: 24,
  rowDescription: 72,
  listBody: 4096,
  maxRows: 10,
});

// Cuts by code point (never through the middle of an emoji) and marks the
// cut with an ellipsis.
export function truncateLabel(text, max) {
  const characters = [...String(text ?? "").trim()];
  return characters.length <= max ? characters.join("") : `${characters.slice(0, max - 1).join("")}…`;
}

// Builds the `interactive` object for reply buttons or a list, or returns
// undefined when the options don't fit Meta's limits (too many, or the text
// is too long) - the caller then sends plain text.
// options: { buttons: [{ id, title }] } or
//          { list: { button, rows: [{ id, title, description? }] } }
export function buildInteractive(text, options) {
  const length = [...text].length;

  if (Array.isArray(options?.buttons) && options.buttons.length > 0) {
    if (options.buttons.length > LIMITS.maxButtons || length > LIMITS.buttonBody) {
      return undefined;
    }
    return {
      type: "button",
      body: { text },
      action: {
        buttons: options.buttons.map((button) => ({
          type: "reply",
          reply: { id: button.id, title: truncateLabel(button.title, LIMITS.buttonTitle) },
        })),
      },
    };
  }

  const rows = options?.list?.rows;
  if (Array.isArray(rows) && rows.length > 0) {
    if (rows.length > LIMITS.maxRows || length > LIMITS.listBody) {
      return undefined;
    }
    return {
      type: "list",
      body: { text },
      action: {
        button: truncateLabel(options.list.button, LIMITS.listButton),
        sections: [
          {
            rows: rows.map((row) => ({
              id: row.id,
              title: truncateLabel(row.title, LIMITS.rowTitle),
              ...(row.description ? { description: truncateLabel(row.description, LIMITS.rowDescription) } : {}),
            })),
          },
        ],
      },
    };
  }

  return undefined;
}

// Sends a reply with tappable buttons or a list. The text is the full
// message either way, so if the options don't fit, or Meta rejects the
// interactive message, the same text goes out as a plain message and the
// user can still type their answer.
// https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
export async function sendReply({
  accessToken,
  apiVersion,
  phoneNumberId,
  to,
  text,
  options,
  fetchImpl = fetch,
}) {
  const interactive = options ? buildInteractive(text, options) : undefined;

  if (interactive) {
    let response;
    try {
      response = await fetchImpl(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "interactive",
          interactive,
        }),
      });
    } catch {
      response = undefined;
    }

    if (response?.ok) {
      reportSuccess(COMPONENTS.whatsapp);
      const body = await response.json();
      const message = body?.messages?.[0];
      return Object.freeze({ id: message?.id, status: message?.message_status, interactive: true });
    }

    await response?.body?.cancel();
    console.warn("WhatsApp interactive message was not accepted; sending plain text instead.", {
      status: response?.status,
    });
  }

  return sendTextMessage({ accessToken, apiVersion, phoneNumberId, to, text, fetchImpl });
}

export class WhatsAppMediaError extends Error {
  constructor(reason, status) {
    super(`WhatsApp media download failed: ${reason}.`);
    this.name = "WhatsAppMediaError";
    this.reason = reason;
    this.status = status;
  }
}

// Downloads media a user sent (here: a voice note). Two steps, both with the
// access token: look up the media id to get a short-lived URL (5 minutes),
// then fetch the bytes. Anything over maxBytes is refused before and after
// downloading - reason "too_large".
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
export async function downloadMedia({
  accessToken,
  apiVersion,
  phoneNumberId,
  mediaId,
  maxBytes,
  fetchImpl = fetch,
}) {
  const headers = { authorization: `Bearer ${accessToken}` };
  const lookupUrl = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(phoneNumberId)}`;

  let lookup;
  try {
    lookup = await fetchImpl(lookupUrl, { headers });
  } catch {
    throw new WhatsAppMediaError("lookup_failed");
  }
  if (!lookup.ok) {
    await lookup.body?.cancel();
    throw new WhatsAppMediaError("lookup_failed", lookup.status);
  }

  const info = await lookup.json();
  if (typeof info?.url !== "string" || !info.url.startsWith("https://")) {
    throw new WhatsAppMediaError("lookup_failed");
  }
  if (typeof info.file_size === "number" && info.file_size > maxBytes) {
    throw new WhatsAppMediaError("too_large");
  }

  let download;
  try {
    download = await fetchImpl(info.url, { headers });
  } catch {
    throw new WhatsAppMediaError("download_failed");
  }
  if (!download.ok) {
    await download.body?.cancel();
    throw new WhatsAppMediaError("download_failed", download.status);
  }

  const bytes = Buffer.from(await download.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new WhatsAppMediaError("too_large");
  }

  return { bytes, mimeType: info.mime_type };
}

// Sends a voice note: uploads the OGG/Opus audio, then sends it as an audio
// message marked as a voice message (the play-button bubble).
// https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/audio-messages
export async function sendVoiceNote({ accessToken, apiVersion, phoneNumberId, to, audio, fetchImpl = fetch }) {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", "audio/ogg");
  form.set("file", new Blob([audio], { type: "audio/ogg" }), "reply.ogg");

  let upload;
  try {
    upload = await fetchImpl(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
      body: form,
    });
  } catch (error) {
    throw new WhatsAppSendError(undefined, error);
  }
  if (!upload.ok) {
    await upload.body?.cancel();
    throw new WhatsAppSendError(upload.status);
  }

  const mediaId = (await upload.json())?.id;
  if (!mediaId) {
    throw new WhatsAppSendError(upload.status);
  }

  let response;
  try {
    response = await fetchImpl(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "audio",
        audio: { id: mediaId, voice: true },
      }),
    });
  } catch (error) {
    throw new WhatsAppSendError(undefined, error);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new WhatsAppSendError(response.status);
  }

  const message = (await response.json())?.messages?.[0];
  return Object.freeze({ id: message?.id });
}
