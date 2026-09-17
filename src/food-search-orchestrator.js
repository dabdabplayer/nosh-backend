import { classifyMessage as defaultClassifyMessage } from "./nlu-client.js";
import { parseStructuredPayload } from "./swiggy-food-client.js";

const MAX_ADDRESS_CANDIDATES = 5;
const MAX_RESTAURANT_RESULTS = 5;

const GENERIC_FALLBACK_REPLY =
  "Sorry, I couldn't complete that search right now. Please try again in a bit.";
const NO_SAVED_ADDRESS_REPLY =
  "You don't have a saved delivery address yet. Please add one in the Swiggy app and try again.";

function noOpenRestaurantsReply(searchTerm) {
  return `I couldn't find any open restaurants for "${searchTerm}" right now.`;
}

// Matches an explicit "find X" / "search X" trigger. There's no NLU/intent
// layer yet — this is deliberately a literal prefix match.
export function matchFoodSearchTrigger(text) {
  const match = /^(?:find|search)\s+(.+)$/i.exec(text.trim());
  const searchTerm = match?.[1]?.trim();
  return searchTerm ? searchTerm : undefined;
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

// Falls back to NVIDIA NIM intent classification only when the literal
// find/search prefix doesn't match, so free-form messages like "I want
// biryani" still trigger a search. Never throws - classifyMessage itself
// fails closed, so a NIM outage just means no search-term match here.
//
// Passes hasActiveCart so the classifier can tell a genuine new search apart
// from a cart-related message like "from Pizza Hut add a margherita pizza" -
// without that context, the search classifier can't tell the two apart and
// swallows cart messages before classifyOrderIntent ever sees them
// (confirmed live).
async function resolveSearchTerm(
  trimmedText,
  senderId,
  { nvidiaNim, pendingCartSessions, classifyMessage = defaultClassifyMessage } = {},
) {
  const regexSearchTerm = matchFoodSearchTrigger(trimmedText);

  if (regexSearchTerm) {
    return regexSearchTerm;
  }

  if (!nvidiaNim?.enabled) {
    return undefined;
  }

  const hasActiveCart = Boolean(await pendingCartSessions?.peek(senderId));

  const intent = await classifyMessage({
    text: trimmedText,
    apiKey: nvidiaNim.apiKey,
    baseUrl: nvidiaNim.baseUrl,
    model: nvidiaNim.model,
    timeoutMs: nvidiaNim.timeoutMs,
    hasActiveCart,
  });

  return intent?.type === "search_food" ? intent.query : undefined;
}

export async function classifyIncomingMessage(message, pendingAddressSelections, nluOptions) {
  const trimmedText = message.text.trim();
  const pending = await pendingAddressSelections.peek(message.from);

  if (pending) {
    const selectedIndex = parseAddressSelectionReply(trimmedText, pending.candidates.length);

    if (selectedIndex !== undefined) {
      return {
        type: "address_selection_answer",
        pending,
        selectedCandidate: pending.candidates[selectedIndex],
      };
    }
  }

  const searchTerm = await resolveSearchTerm(trimmedText, message.from, nluOptions);

  if (pending) {
    if (searchTerm) {
      return { type: "new_search", searchTerm };
    }

    return { type: "unrecognized_pending_reply", pending };
  }

  if (searchTerm) {
    return { type: "new_search", searchTerm };
  }

  return { type: "no_trigger" };
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

  return [`Here's what I found for "${searchTerm}":`, ...lines].join("\n");
}

// Records the resolved delivery address as a lightweight cart session (no
// restaurant chosen yet) so a later "add to cart" doesn't need to re-resolve
// the address or make the user pick a restaurant by number first -
// food-order-orchestrator.js fills in the restaurant on the first add.
async function runRestaurantSearch(swiggyFoodClient, searchTerm, addressId, senderId, pendingCartSessions) {
  if (senderId && pendingCartSessions) {
    await pendingCartSessions.set(senderId, { addressId });
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
  // (confirmed live). getFoodOrderReply resolves this deterministically,
  // no NLU call needed, since food-order-orchestrator.js runs first
  // whenever a cart session exists (see server.js).
  if (senderId && pendingCartSessions) {
    await pendingCartSessions.set(senderId, {
      addressId,
      restaurantCandidates: openRestaurants.map((restaurant) => ({ id: restaurant.id, name: restaurant.name })),
    });
  }

  return formatRestaurantReply(searchTerm, openRestaurants);
}

async function handleNewFoodSearch(
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

  if (parsed?.resolution?.needsUserClarification === true) {
    const candidates = addresses.slice(0, MAX_ADDRESS_CANDIDATES).map((address) => ({
      id: address.id,
      label: formatAddressLabel(address),
    }));

    await pendingAddressSelections.set(senderId, { searchTerm, candidates });
    return formatAddressPrompt(candidates);
  }

  const addressId = parsed?.resolution?.defaultAddressId ?? addresses[0]?.id;

  if (!addressId) {
    return GENERIC_FALLBACK_REPLY;
  }

  return runRestaurantSearch(swiggyFoodClient, searchTerm, addressId, senderId, pendingCartSessions);
}

// The single entry point server.js calls. Never throws: any Swiggy tool
// failure or unparseable response is caught and replaced with a generic,
// non-technical reply, per AGENTS.md's rule against exposing raw MCP errors.
// Returns undefined for ordinary messages so the caller falls back to its
// own static placeholder reply.
//
// Accepts an already-computed `classification` when the caller ran one
// already (server.js and the dev scripts do, to decide auth/routing before
// calling this). Reusing it avoids a second NLU call for the same message -
// classifying twice doubles exposure to NIM latency/timeouts for no benefit,
// and previously could silently discard an already-correct classification
// if only the second call happened to time out.
export async function getFoodSearchReply({
  message,
  swiggyFoodClient,
  pendingAddressSelections,
  pendingCartSessions,
  nvidiaNim,
  classifyMessage,
  classification: precomputedClassification,
}) {
  const classification =
    precomputedClassification ??
    (await classifyIncomingMessage(message, pendingAddressSelections, { nvidiaNim, classifyMessage }));

  try {
    switch (classification.type) {
      case "no_trigger":
        return undefined;

      case "new_search":
        await pendingAddressSelections.clear(message.from);
        return await handleNewFoodSearch(
          message.from,
          classification.searchTerm,
          swiggyFoodClient,
          pendingAddressSelections,
          pendingCartSessions,
        );

      case "address_selection_answer":
        await pendingAddressSelections.clear(message.from);
        return await runRestaurantSearch(
          swiggyFoodClient,
          classification.pending.searchTerm,
          classification.selectedCandidate.id,
          message.from,
          pendingCartSessions,
        );

      case "unrecognized_pending_reply":
        return formatAddressPrompt(classification.pending.candidates);

      default:
        return undefined;
    }
  } catch (error) {
    console.error("Food search orchestration failed unexpectedly.", { name: error.name });
    return GENERIC_FALLBACK_REPLY;
  }
}
