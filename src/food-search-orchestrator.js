import { parseStructuredPayload } from "./swiggy-food-client.js";

const MAX_ADDRESS_CANDIDATES = 5;
const MAX_RESTAURANT_RESULTS = 5;

const GENERIC_FALLBACK_REPLY =
  "Sorry, I couldn't complete that search right now. Please try again in a bit.";
export const NO_SAVED_ADDRESS_REPLY =
  "You don't have a saved delivery address yet. Please add one in the Swiggy app and try again.";

function noOpenRestaurantsReply(searchTerm) {
  return `I couldn't find any open restaurants for "${searchTerm}" right now.`;
}

// A reply to a pending "which address?" prompt is just the 1-based number of
// the chosen candidate.
export function parseAddressSelectionReply(text, candidateCount) {
  const trimmed = text.trim();

  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }

  const index = Number(trimmed) - 1;
  return index >= 0 && index < candidateCount ? index : undefined;
}

function formatAddressLabel(address) {
  const tag = address?.addressTag ?? address?.addressCategory ?? "Address";
  return address?.addressLine ? `${tag} — ${address.addressLine}` : tag;
}

function formatAddressPrompt(candidates) {
  const lines = candidates.map((candidate, index) => `${index + 1}. ${candidate.label}`);
  return [
    "You have a few saved addresses — which one should I use?",
    ...lines,
    "Reply with the number.",
  ].join("\n");
}

function formatRestaurantReply(searchTerm, restaurants) {
  const lines = restaurants.map((restaurant, index) => {
    const parts = [
      restaurant.avgRating !== undefined ? `⭐${restaurant.avgRating}` : undefined,
      restaurant.distanceKm !== undefined ? `${restaurant.distanceKm} km` : undefined,
      restaurant.deliveryTimeRange,
      restaurant.costForTwo,
    ].filter((part) => part !== undefined);

    return `${index + 1}. ${restaurant.name}${parts.length > 0 ? ` — ${parts.join(", ")}` : ""}`;
  });

  return [`Here's what I found for "${searchTerm}":`, ...lines, "Which one would you like? Reply with the number."].join(
    "\n",
  );
}

// Records the resolved delivery address as a lightweight cart session (no
// restaurant chosen yet) so a later "add to cart" doesn't need to re-resolve
// the address or make the user pick a restaurant by number first -
// food-order-orchestrator.js fills in the restaurant on the first add.
async function runRestaurantSearch(swiggyFoodClient, searchTerm, addressId, senderId, pendingCartSessions) {
  if (senderId && pendingCartSessions) {
    pendingCartSessions.set(senderId, { addressId });
  }

  let searchResult;
  try {
    searchResult = await swiggyFoodClient.searchRestaurants({ query: searchTerm, addressId });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const parsed = parseStructuredPayload(searchResult);
  const restaurants = Array.isArray(parsed?.restaurants) ? parsed.restaurants : undefined;

  if (restaurants === undefined) {
    return GENERIC_FALLBACK_REPLY;
  }

  const openRestaurants = restaurants
    .filter((restaurant) => restaurant?.availabilityStatus === "OPEN")
    .slice(0, MAX_RESTAURANT_RESULTS);

  if (openRestaurants.length === 0) {
    return noOpenRestaurantsReply(searchTerm);
  }

  // Lets a bare number reply (e.g. "2") pick a restaurant straight off this
  // numbered list, the same way a bare number already picks an address
  // above - without this, the list looked selectable the same way the
  // address prompt is, but only "add X from <name>" actually worked
  // (confirmed live). food-order-orchestrator.js's
  // resolvePendingCartCandidateReply resolves this deterministically, no
  // agent call needed, checked before the agent ever runs (see server.js).
  // searchTerm rides along so that once a restaurant is picked, it can look
  // up what matches the user's original request (e.g. "pizza") at that
  // restaurant instead of asking them to repeat themselves.
  if (senderId && pendingCartSessions) {
    pendingCartSessions.set(senderId, {
      addressId,
      searchTerm,
      restaurantCandidates: openRestaurants.map((restaurant) => ({ id: restaurant.id, name: restaurant.name })),
    });
  }

  return formatRestaurantReply(searchTerm, openRestaurants);
}

// Tool implementation for the agent's `search_food` tool (see
// src/sarvam-agent.js) - the agent calls this whenever it decides the user
// wants to find/order a dish, cuisine, or restaurant, with no keyword
// trigger involved; it's the model's judgment call, not a regex's. Resolves
// the delivery address (asking which one, if more than one is saved) and
// then searches restaurants, returning already-good English text that the
// agent is expected to relay/translate into the user's own language rather
// than repeat verbatim - see the system prompt in sarvam-agent.js.
export async function searchFood(
  senderId,
  searchTerm,
  swiggyFoodClient,
  pendingAddressSelections,
  pendingCartSessions,
) {
  let addressResult;
  try {
    addressResult = await swiggyFoodClient.getAddresses({});
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const parsed = parseStructuredPayload(addressResult);
  const addresses = Array.isArray(parsed?.addresses) ? parsed.addresses : undefined;

  if (addresses === undefined) {
    return GENERIC_FALLBACK_REPLY;
  }

  const total = typeof parsed?.total === "number" ? parsed.total : addresses.length;

  if (total === 0) {
    return NO_SAVED_ADDRESS_REPLY;
  }

  // get_addresses' documented response has no "which one is default" or
  // "does this need clarification" field of its own (Swiggy's own docs for
  // this tool instead say to always show the list and let the user pick) -
  // an earlier version of this code read a `resolution.needsUserClarification`
  // / `resolution.defaultAddressId` pair that was never part of the
  // documented schema and never confirmed against a real response, which
  // is why a sender with multiple saved addresses was never actually asked
  // which one to use. With more than one saved address there's a genuine
  // choice to make, so ask; with exactly one, there's nothing to choose
  // between and asking would just be friction.
  if (addresses.length > 1) {
    const candidates = addresses.slice(0, MAX_ADDRESS_CANDIDATES).map((address) => ({
      id: address.id,
      label: formatAddressLabel(address),
    }));

    pendingAddressSelections.set(senderId, { searchTerm, candidates });
    return formatAddressPrompt(candidates);
  }

  const addressId = addresses[0]?.id;

  if (!addressId) {
    return GENERIC_FALLBACK_REPLY;
  }

  return runRestaurantSearch(swiggyFoodClient, searchTerm, addressId, senderId, pendingCartSessions);
}

// Deterministic pre-agent short-circuit: if this sender already has a
// pending "which saved address?" prompt outstanding, a bare number reply
// resolves it without ever invoking the agent - zero extra Sarvam calls, and
// it works in any language since it's just a digit, not a keyword match.
// Returns { handled: false } when there's no pending address selection at
// all, OR when there is one but the reply isn't a valid number - in that
// second case the stale prompt is cleared and the message is handed to the
// agent fresh, the same way a genuinely new request used to override a
// stale address prompt under the old NLU-classifier dispatch (confirmed via
// a dropped test: unconditionally re-prompting here instead would trap a
// sender who changes their mind - e.g. "actually, find pizza instead" -
// forever behind "which address?" with no way out except picking a number
// for the OLD search). This is NOT a "trigger word" in the sense AGENTS.md's
// no-trigger-word rule is about (free-text intent detection) - it's picking
// an option off a numbered list the bot itself just showed, or noticing the
// reply isn't that and stepping aside.
export async function resolvePendingAddressReply({
  message,
  swiggyFoodClient,
  pendingAddressSelections,
  pendingCartSessions,
}) {
  const pending = pendingAddressSelections.peek(message.from);

  if (!pending) {
    return { handled: false };
  }

  const selectedIndex = parseAddressSelectionReply(message.text.trim(), pending.candidates.length);

  if (selectedIndex === undefined) {
    pendingAddressSelections.clear(message.from);
    return { handled: false };
  }

  pendingAddressSelections.clear(message.from);

  try {
    const replyText = await runRestaurantSearch(
      swiggyFoodClient,
      pending.searchTerm,
      pending.candidates[selectedIndex].id,
      message.from,
      pendingCartSessions,
    );
    return { handled: true, replyText };
  } catch (error) {
    console.error("Food search orchestration failed unexpectedly.", { name: error.name });
    return { handled: true, replyText: GENERIC_FALLBACK_REPLY };
  }
}
