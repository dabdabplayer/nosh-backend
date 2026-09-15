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

export function classifyIncomingMessage(message, pendingAddressSelections) {
  const trimmedText = message.text.trim();
  const searchTerm = matchFoodSearchTrigger(trimmedText);
  const pending = pendingAddressSelections.peek(message.from);

  if (pending) {
    const selectedIndex = parseAddressSelectionReply(trimmedText, pending.candidates.length);

    if (selectedIndex !== undefined) {
      return {
        type: "address_selection_answer",
        pending,
        selectedCandidate: pending.candidates[selectedIndex],
      };
    }

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

async function runRestaurantSearch(swiggyFoodClient, searchTerm, addressId) {
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

  return formatRestaurantReply(searchTerm, openRestaurants);
}

async function handleNewFoodSearch(senderId, searchTerm, swiggyFoodClient, pendingAddressSelections) {
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

    pendingAddressSelections.set(senderId, { searchTerm, candidates });
    return formatAddressPrompt(candidates);
  }

  const addressId = parsed?.resolution?.defaultAddressId ?? addresses[0]?.id;

  if (!addressId) {
    return GENERIC_FALLBACK_REPLY;
  }

  return runRestaurantSearch(swiggyFoodClient, searchTerm, addressId);
}

// The single entry point server.js calls. Never throws: any Swiggy tool
// failure or unparseable response is caught and replaced with a generic,
// non-technical reply, per AGENTS.md's rule against exposing raw MCP errors.
// Returns undefined for ordinary messages so the caller falls back to its
// own static placeholder reply.
export async function getFoodSearchReply({ message, swiggyFoodClient, pendingAddressSelections }) {
  const classification = classifyIncomingMessage(message, pendingAddressSelections);

  try {
    switch (classification.type) {
      case "no_trigger":
        return undefined;

      case "new_search":
        pendingAddressSelections.clear(message.from);
        return await handleNewFoodSearch(
          message.from,
          classification.searchTerm,
          swiggyFoodClient,
          pendingAddressSelections,
        );

      case "address_selection_answer":
        pendingAddressSelections.clear(message.from);
        return await runRestaurantSearch(
          swiggyFoodClient,
          classification.pending.searchTerm,
          classification.selectedCandidate.id,
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
