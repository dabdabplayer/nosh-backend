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
