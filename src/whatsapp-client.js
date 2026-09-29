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
  if (response.status === 400) {
    response = await post(false);
  }
  if (!response.ok) {
    throw new WhatsAppSendError(response.status);
  }
}
