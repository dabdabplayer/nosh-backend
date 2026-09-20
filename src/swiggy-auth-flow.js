import { isTokenExpired, refreshAccessToken as defaultRefreshAccessToken } from "./swiggy-oauth.js";

// Resolves a usable Swiggy access token for a WhatsApp sender, transparently
// refreshing an expired one when possible. refreshImpl is injectable for
// testing without a real network call.
//
// Refresh is opportunistic: Swiggy's live OAuth metadata advertises a
// refresh_token grant, but their prose docs say it isn't wired up yet (see
// src/swiggy-oauth.js). Either way, a refresh failure just means the
// account needs to be reconnected - not a hard error.
export async function resolveSwiggyAccessToken({
  senderId,
  tokenStore,
  authBaseUrl,
  refreshImpl = defaultRefreshAccessToken,
}) {
  const record = tokenStore.get(senderId);

  if (!record) {
    return { status: "unauthenticated" };
  }

  if (!isTokenExpired(record)) {
    return { status: "ok", accessToken: record.accessToken };
  }

  if (!record.refreshToken) {
    tokenStore.delete(senderId);
    return { status: "unauthenticated" };
  }

  try {
    const refreshed = await refreshImpl({ authBaseUrl, refreshToken: record.refreshToken });
    tokenStore.set(senderId, refreshed);
    return { status: "ok", accessToken: refreshed.accessToken };
  } catch {
    tokenStore.delete(senderId);
    return { status: "unauthenticated" };
  }
}

// The searchTerm (when there is one) is echoed back so the user knows their
// request wasn't dropped - we automatically resume it once they finish
// connecting. Omitting searchTerm (the reorder_usual case - see
// src/food-order-orchestrator.js's buildReorderUsualReply) uses a generic
// action phrase instead, since there's no specific term to echo.
export function buildConnectReplyText({ connectUrl, searchTerm }) {
  const actionText = searchTerm ? `search for "${searchTerm}"` : "do that";

  return [
    `To ${actionText}, please connect your Swiggy account first:`,
    connectUrl,
    "",
    "I'll do that automatically once you're connected.",
  ].join("\n");
}
