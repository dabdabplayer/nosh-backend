import { classifyMessage as defaultClassifyMessage, NIM_UNAVAILABLE } from "./nlu-client.js";
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

// Matches an explicit "find X" / "search X" trigger. Only used as the
// deterministic fallback in resolveIntent below when NVIDIA NIM isn't
// configured - with NIM enabled, the LLM is the one deciding whether this is
// a search, not this regex (see resolveIntent's comment).
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

// The LLM (NVIDIA NIM) is the primary interpreter of what the user wants,
// the same way classifyOrderIntent already is for everything that happens
// once a cart exists (food-order-orchestrator.js) - it's the model's job to
// recognize "I want biryani", "find biryani", and "get me my usual biryani
// place" all correctly, not a regex's. The literal find/search prefix match
// is only a fallback for when NIM itself is unreachable (disabled entirely,
// or the request failed/timed out - see NIM_UNAVAILABLE in nlu-client.js),
// so the bot still does something useful rather than going fully silent. It
// is NOT a fallback for "NIM ran and decided this isn't a search" - trusting
// that answer, rather than second-guessing it with the regex, is the whole
// point of this change; overriding it would just reintroduce the
// trigger-word dependence this is meant to remove.
//
// Passes hasActiveCart so the classifier can tell a genuine new search apart
// from a cart-related message like "from Pizza Hut add a margherita pizza" -
// without that context, the search classifier can't tell the two apart and
// swallows cart messages before classifyOrderIntent ever sees them
// (confirmed live).
//
// Returns the raw { type: "search_food", query } / { type: "reorder_usual" }
// / { type: "recommend" } intent (not just a search term) so
// classifyIncomingMessage below can tell them apart.
async function resolveIntent(
  trimmedText,
  senderId,
  { nvidiaNim, pendingCartSessions, classifyMessage = defaultClassifyMessage } = {},
) {
  const fallbackToRegex = () => {
    const regexSearchTerm = matchFoodSearchTrigger(trimmedText);
    return regexSearchTerm ? { type: "search_food", query: regexSearchTerm } : undefined;
  };

  if (!nvidiaNim?.enabled) {
    return fallbackToRegex();
  }

  const hasActiveCart = Boolean(pendingCartSessions?.peek(senderId));

  const intent = await classifyMessage({
    text: trimmedText,
    apiKey: nvidiaNim.apiKey,
    baseUrl: nvidiaNim.baseUrl,
    model: nvidiaNim.model,
    timeoutMs: nvidiaNim.timeoutMs,
    hasActiveCart,
  });

  if (intent === NIM_UNAVAILABLE) {
    return fallbackToRegex();
  }

  return intent?.type === "search_food" || intent?.type === "reorder_usual" || intent?.type === "recommend"
    ? intent
    : undefined;
}

export async function classifyIncomingMessage(message, pendingAddressSelections, nluOptions) {
  const trimmedText = message.text.trim();
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
  }

  const intent = await resolveIntent(trimmedText, message.from, nluOptions);

  // A reorder or recommendation request supersedes any stale "which
  // address?" prompt the same way a genuine new search does below - the
  // caller is expected to clear pendingAddressSelections, same as the
  // new_search case in getFoodSearchReply.
  if (intent?.type === "reorder_usual") {
    return { type: "reorder_usual" };
  }

  if (intent?.type === "recommend") {
    return { type: "recommend" };
  }

  const searchTerm = intent?.type === "search_food" ? intent.query : undefined;

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
  // (confirmed live). getFoodOrderReply resolves this deterministically,
  // no NLU call needed, since food-order-orchestrator.js runs first
  // whenever a cart session exists (see server.js). searchTerm rides along
  // so that once a restaurant is picked, getFoodOrderReply can look up what
  // matches the user's original request (e.g. "pizza") at that restaurant
  // instead of asking them to repeat themselves.
  if (senderId && pendingCartSessions) {
    pendingCartSessions.set(senderId, {
      addressId,
      searchTerm,
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
        pendingAddressSelections.clear(message.from);
        return await handleNewFoodSearch(
          message.from,
          classification.searchTerm,
          swiggyFoodClient,
          pendingAddressSelections,
          pendingCartSessions,
        );

      case "address_selection_answer":
        pendingAddressSelections.clear(message.from);
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
