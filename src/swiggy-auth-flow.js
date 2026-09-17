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
  const record = await tokenStore.get(senderId);

  if (!record) {
    return { status: "unauthenticated" };
  }

  if (!isTokenExpired(record)) {
    return { status: "ok", accessToken: record.accessToken };
  }

  if (!record.refreshToken) {
    await tokenStore.delete(senderId);
    return { status: "unauthenticated" };
  }

  try {
    const refreshed = await refreshImpl({ authBaseUrl, refreshToken: record.refreshToken });
    await tokenStore.set(senderId, refreshed);
    return { status: "ok", accessToken: refreshed.accessToken };
  } catch {
    await tokenStore.delete(senderId);
    return { status: "unauthenticated" };
  }
}

// The searchTerm is echoed back so the user knows their request wasn't
// dropped - we automatically resume it once they finish connecting.
export function buildConnectReplyText({ connectUrl, searchTerm }) {
  return [
    `To search for "${searchTerm}", please connect your Swiggy account first:`,
    connectUrl,
    "",
    "I'll run your search automatically once you're connected.",
  ].join("\n");
}
