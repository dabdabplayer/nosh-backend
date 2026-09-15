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
    throw new WhatsAppSendError(undefined, error);
  }

  if (!response.ok) {
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    throw new WhatsAppSendError(response.status, body);
  }

  const body = await response.json();
  const message = body?.messages?.[0];

  return Object.freeze({
    id: message?.id,
    status: message?.message_status,
  });
}
