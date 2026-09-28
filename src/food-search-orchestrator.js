import { parseStructuredPayload } from "./swiggy-food-client.js";
import { pick } from "./language-preference.js";

// Exported so recommendSimilar (src/food-order-orchestrator.js) can offer
// the exact same address-disambiguation prompt/candidate shape rather than
// duplicating it - see recommendSimilar's own address-choice branch.
export const MAX_ADDRESS_CANDIDATES = 5;
const MAX_RESTAURANT_RESULTS = 5;

const GENERIC_FALLBACK_REPLY =
  "Sorry, I couldn't complete that search right now. Please try again in a bit.";
export const NO_SAVED_ADDRESS_REPLY =
  "You don't have a saved delivery address yet. Please add one in the Swiggy app and try again.";

function noOpenRestaurantsReply(searchTerm, lang = "en") {
  return pick(lang, {
    en: `I couldn't find any open restaurants for "${searchTerm}" right now.`,
    hi: `अभी "${searchTerm}" के लिए कोई खुला रेस्टोरेंट नहीं मिला।`,
    hinglish: `Abhi "${searchTerm}" ke liye koi open restaurant nahi mila.`,
  });
}

// Position words people use to pick from a numbered list, in English,
// Hindi and Hinglish. "last" is resolved against the list's length.
const ORDINAL_POSITIONS = new Map([
  ["first", 1], ["1st", 1], ["pehla", 1], ["pehli", 1], ["pahla", 1], ["pahli", 1], ["pehela", 1], ["pahela", 1], ["pehle", 1], ["पहला", 1], ["पहली", 1],
  ["second", 2], ["2nd", 2], ["doosra", 2], ["dusra", 2], ["doosri", 2], ["dusri", 2], ["दूसरा", 2], ["दूसरी", 2],
  ["third", 3], ["3rd", 3], ["teesra", 3], ["tisra", 3], ["teesri", 3], ["तीसरा", 3], ["तीसरी", 3],
  ["fourth", 4], ["4th", 4], ["chautha", 4], ["चौथा", 4],
  ["fifth", 5], ["5th", 5], ["panchva", 5], ["paanchva", 5], ["पांचवां", 5],
]);
// Words that can surround the pick without changing it ("the first one",
// "option 2", "pehla wala", "no. 1 please").
const SELECTION_FILLER_WORDS = new Set([
  "the", "one", "option", "number", "no", "num", "#", "please", "pls", "plz", "wala", "wali", "vala", "vali", "waala", "vaala",
]);

// A reply to a numbered list ("which address?", restaurants, dishes): a
// number or a position word, optionally with filler words around it.
// Anything else returns undefined, so the reply goes to the agent instead.
export function parseAddressSelectionReply(text, candidateCount) {
  const words = text
    .toLowerCase()
    .replace(/[.,!?#:)(]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !SELECTION_FILLER_WORDS.has(word));

  if (words.length !== 1) {
    return undefined;
  }

  const [word] = words;
  let position;
  if (/^\d+$/.test(word)) {
    position = Number(word);
  } else if (word === "last" || word === "aakhri" || word === "akhri" || word === "आखिरी") {
    position = candidateCount;
  } else {
    position = ORDINAL_POSITIONS.get(word);
  }

  const index = position - 1;
  return Number.isInteger(index) && index >= 0 && index < candidateCount ? index : undefined;
}

export function formatAddressLabel(address) {
  const tag = address?.addressTag ?? address?.addressCategory ?? "Address";
  return address?.addressLine ? `${tag} — ${address.addressLine}` : tag;
}

export function toAddressCandidate(address) {
  return {
    id: address.id,
    label: formatAddressLabel(address),
    tag: address?.addressTag ?? address?.addressCategory,
  };
}

// Words people use for Swiggy's standard address tags, in English, Hindi
// and Hinglish.
const ADDRESS_TAG_SYNONYMS = {
  home: ["home", "house", "ghar", "घर"],
  work: ["work", "office", "ofc", "daftar", "ऑफिस", "ऑफ़िस", "दफ्तर", "दफ़्तर"],
  other: ["other", "others"],
};
const MAX_ADDRESS_NAME_REPLY_WORDS = 5;

function normalizeWords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// A short reply naming one saved address by its tag ("Home", "work",
// "ghar pe", "Mom's place") picks it. Returns undefined when nothing - or
// more than one address - matches, so the reply falls through to the agent
// like any other non-numeric reply.
export function matchAddressByName(text, candidates) {
  const words = normalizeWords(text);
  if (words.length === 0 || words.length > MAX_ADDRESS_NAME_REPLY_WORDS) {
    return undefined;
  }
  const joined = ` ${words.join(" ")} `;

  const matches = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => {
      const tagWords = normalizeWords(candidate.tag ?? "");
      if (tagWords.length === 0) {
        return false;
      }
      const names = [tagWords.join(" "), ...(ADDRESS_TAG_SYNONYMS[tagWords.join(" ")] ?? [])];
      return names.some((name) => joined.includes(` ${name} `));
    });

  return matches.length === 1 ? matches[0].index : undefined;
}

export function formatAddressPrompt(candidates, lang = "en") {
  const lines = candidates.map((candidate, index) => `${index + 1}. ${candidate.label}`);
  const header = pick(lang, {
    en: "You have a few saved addresses — which one should I use?",
    hi: "आपके पास कुछ सेव किए गए पते हैं — मैं कौन सा इस्तेमाल करूं?",
    hinglish: "Aapke paas kuch saved addresses hain — kaunsa use karoon?",
  });
  const footer = pick(lang, {
    en: "Reply with the number or the name (like Home).",
    hi: "नंबर या नाम (जैसे Home) के साथ जवाब दें।",
    hinglish: "Number ya naam (jaise Home) ke saath reply karein.",
  });
  return [header, ...lines, footer].join("\n");
}

function formatRestaurantReply(searchTerm, restaurants, lang = "en") {
  const lines = restaurants.map((restaurant, index) => {
    const parts = [
      restaurant.avgRating !== undefined ? `⭐${restaurant.avgRating}` : undefined,
      restaurant.distanceKm !== undefined ? `${restaurant.distanceKm} km` : undefined,
      restaurant.deliveryTimeRange,
      restaurant.costForTwo,
    ].filter((part) => part !== undefined);

    return `${index + 1}. ${restaurant.name}${parts.length > 0 ? ` — ${parts.join(", ")}` : ""}`;
  });

  const header = pick(lang, {
    en: `Here's what I found for "${searchTerm}":`,
    hi: `"${searchTerm}" के लिए मुझे ये मिले:`,
    hinglish: `"${searchTerm}" ke liye ye mile:`,
  });
  const footer = pick(lang, {
    en: "Which one would you like? Reply with the number.",
    hi: "कौन सा चाहिए? नंबर के साथ जवाब दें।",
    hinglish: "Kaunsa chahiye? Number ke saath reply karein.",
  });

  return [header, ...lines, footer].join("\n");
}

// Records the resolved delivery address as a lightweight cart session (no
// restaurant chosen yet) so a later "add to cart" doesn't need to re-resolve
// the address or make the user pick a restaurant by number first -
// food-order-orchestrator.js fills in the restaurant on the first add.
async function runRestaurantSearch(swiggyFoodClient, searchTerm, addressId, senderId, pendingCartSessions, lang = "en") {
  // A search doesn't touch the live cart, so which restaurant it holds must
  // survive - otherwise the next add treats the cart as unknown and empties
  // it without telling the user.
  const cartRestaurantId = pendingCartSessions?.peek(senderId)?.cartRestaurantId;

  if (senderId && pendingCartSessions) {
    pendingCartSessions.set(senderId, { addressId, cartRestaurantId });
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
    return noOpenRestaurantsReply(searchTerm, lang);
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
      cartRestaurantId,
      searchTerm,
      restaurantCandidates: openRestaurants.map((restaurant) => ({ id: restaurant.id, name: restaurant.name })),
    });
  }

  return formatRestaurantReply(searchTerm, openRestaurants, lang);
}

// Tool implementation for the agent's `search_food` tool (see
// src/agent.js) - the agent calls this whenever it decides the user
// wants to find/order a dish, cuisine, or restaurant, with no keyword
// trigger involved; it's the model's judgment call, not a regex's. Resolves
// the delivery address (asking which one, if more than one is saved) and
// then searches restaurants, returning already-good English text that the
// agent is expected to relay/translate into the user's own language rather
// than repeat verbatim - see the system prompt in agent.js.
// `lang` is used ONLY for this function's own address-disambiguation prompt
// (the one branch below that's actually terminal when reached via the
// agent's search_food tool call - see executeTool's "search_food" case in
// agent.js). It is deliberately NEVER forwarded to runRestaurantSearch
// below (always "en" there): a restaurant list reached via the agent's own
// search_food call is never terminal - the agent itself translates it per
// the system prompt - so pre-translating it here would be a silent behavior
// change to a path nobody asked to change. Only resolvePendingAddressReply's
// own direct call to runRestaurantSearch (the "search" kind resume, which
// bypasses this function and the agent entirely) passes a real lang.
export async function searchFood(
  senderId,
  searchTerm,
  swiggyFoodClient,
  pendingAddressSelections,
  pendingCartSessions,
  lang = "en",
) {
  // Reuse an address this sender already picked earlier in the same session
  // rather than asking again - confirmed live: with 2 saved addresses,
  // "which one?" was being asked on every single search_food call within
  // one conversation, including twice within 20 seconds of each other, and
  // again mid-recommendation (defeating "the user shouldn't have to
  // decide"). This doesn't contradict get_addresses' own "always show the
  // list and let the user pick" guidance below - that's about a FRESH
  // resolution with no established context; this is just not re-asking a
  // question this conversation already answered.
  const existingAddressId = pendingCartSessions?.peek(senderId)?.addressId;

  if (existingAddressId) {
    return runRestaurantSearch(swiggyFoodClient, searchTerm, existingAddressId, senderId, pendingCartSessions);
  }

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
    const candidates = addresses.slice(0, MAX_ADDRESS_CANDIDATES).map(toAddressCandidate);

    pendingAddressSelections.set(senderId, { kind: "search", searchTerm, candidates });
    return formatAddressPrompt(candidates, lang);
  }

  const addressId = addresses[0]?.id;

  if (!addressId) {
    return GENERIC_FALLBACK_REPLY;
  }

  return runRestaurantSearch(swiggyFoodClient, searchTerm, addressId, senderId, pendingCartSessions);
}

// Deterministic pre-agent short-circuit: if this sender already has a
// pending "which saved address?" prompt outstanding, a bare number reply
// resolves it without ever invoking the agent for a "search" kind pending
// selection - zero extra Sarvam calls, and it works in any language since
// it's just a digit, not a keyword match. A "recommend" kind pending
// selection is different (see below) and DOES fall through to the agent.
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
  lang = "en",
}) {
  const pending = pendingAddressSelections.peek(message.from);

  if (!pending) {
    return { handled: false };
  }

  const selectedIndex =
    parseAddressSelectionReply(message.text.trim(), pending.candidates.length) ??
    matchAddressByName(message.text, pending.candidates);

  if (selectedIndex === undefined) {
    pendingAddressSelections.clear(message.from);
    return { handled: false };
  }

  pendingAddressSelections.clear(message.from);
  const addressId = pending.candidates[selectedIndex].id;

  // A recommendation's address prompt does NOT resolve deterministically
  // here, unlike a search's. recommendSimilar's own return value is
  // LLM-facing instructional text (candidate items + "pick one and phrase
  // it" guidance), never meant to reach the user directly - calling it here
  // and returning its text as replyText would leak that raw internal text
  // straight to WhatsApp. Instead, just record the resolved address and step
  // aside (handled: false): buildReplyText then runs the bare number reply
  // through the normal agent turn, and the agent has everything it needs in
  // pendingConversationHistory - its own address-list turn (with this exact
  // candidate's label) and the original craving-bearing request before it -
  // to infer which address was picked and call recommend_similar again
  // itself, now that pendingCartSessions.addressId is already set. pending.
  // craving is kept in the pending record (unused here) as a documented
  // upgrade path if this inference ever proves unreliable in practice.
  if (pending.kind === "recommend") {
    pendingCartSessions?.set(message.from, { addressId });
    return { handled: false };
  }

  try {
    const replyText = await runRestaurantSearch(
      swiggyFoodClient,
      pending.searchTerm,
      addressId,
      message.from,
      pendingCartSessions,
      lang,
    );
    return { handled: true, replyText };
  } catch (error) {
    console.error("Food search orchestration failed unexpectedly.", { name: error.name });
    return { handled: true, replyText: GENERIC_FALLBACK_REPLY };
  }
}
