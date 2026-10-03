import {
  formatAddressPrompt,
  MAX_ADDRESS_CANDIDATES,
  NO_SAVED_ADDRESS_REPLY,
  parseAddressSelectionReply,
  toAddressCandidate,
} from "./food-search-orchestrator.js";
import { newConfirmationNonce } from "./interactive-replies.js";
import { pick } from "./language-preference.js";
import { parseStructuredPayload } from "./swiggy-food-client.js";
import { isTransientSwiggyFailure } from "./swiggy-retry.js";

const MAX_COUPONS = 5;
const MIN_USUAL_ORDER_COUNT = 2;
const MAX_ITEM_RESULTS = 5;

// Real Swiggy Builders Club platform rule, not a Nosh-invented limit -
// verified against docs/build/recipes/order-food.md, which states this as
// "Swiggy v1: hard ₹1000 cap on Builders Club orders" (not illustrative
// sample code) and checks it against the cart's `to_pay` field before
// place_food_order. Nosh has no client-side visibility into whether Swiggy
// also enforces this server-side, so this is a real guard, not a redundant
// one - without it, a cart over the cap would get a full checkout summary
// and a YES prompt for an order that (as far as Nosh can tell) might never
// actually be placeable.
const BUILDERS_CLUB_CART_CAP = 1000;

const CONFIRM_REPLY_PATTERN = /^(yes|y|confirm|confirmed|place( it)?|proceed)$/i;
const CANCEL_REPLY_PATTERN = /^(no|n|cancel|cancelled|canceled|stop)$/i;

// The deterministic yes/no gate in front of the one irreversible action
// (placing a real order) - a plain keyword match, same style as
// food-search-orchestrator.js's parseAddressSelectionReply, never an LLM
// judgment call. Per AGENTS.md: confirmation must be enforced in
// deterministic application code, not left to the model.
export function parseOrderConfirmationReply(text) {
  const trimmed = text.trim();

  if (CONFIRM_REPLY_PATTERN.test(trimmed)) {
    return "confirm";
  }

  if (CANCEL_REPLY_PATTERN.test(trimmed)) {
    return "cancel";
  }

  return undefined;
}

const GENERIC_FALLBACK_REPLY =
  "Sorry, I couldn't do that right now. Please try again in a bit.";

// lang-aware, used only by the deterministic TERMINAL_TOOLS paths
// (view_cart/checkout/apply_coupon - see formatCartReply/handleCheckout
// below); every agent-phrased caller (add_to_cart, remove_from_cart,
// reorder_usual) keeps calling this with no lang argument (default "en")
// since the agent already translates its own replies.
function emptyCartReply(lang = "en") {
  return pick(lang, {
    en: "Your cart is empty — search for something and ask me to add it first.",
    hi: "आपकी कार्ट खाली है — पहले कुछ खोजें और मुझसे कार्ट में डालने को कहें।",
    hinglish: "Aapki cart khali hai — pehle kuch search karein aur mujhe add karne ko kahein.",
  });
}

// Every tool that reads/writes the cart returns the real data nested under
// `data` (confirmed live against the real Swiggy Food MCP server), unlike
// search_restaurants/get_addresses which put fields at the top level.
// Confirmed live (2026-09-15, real get_food_cart call): the actual envelope
// is { statusCode, statusMessage, data }, e.g.
// { statusCode: 0, statusMessage: "CART_UPDATED_SUCCESSFULLY", data: {...} }
// - NOT the { success, data } shape the Builders Club docs page described
// when fetched (that page was wrong/hallucinated for this tool; verify
// against a live call, not the doc fetch, if this ever needs re-checking).
function unwrapCartPayload(toolResult) {
  const payload = parseStructuredPayload(toolResult);
  return payload?.statusCode === 0 ? payload.data : undefined;
}

// Breaks out every charge Swiggy's cart pricing carries (item total,
// delivery charge, taxes, coupon discount) instead of only showing the
// final to_pay figure - a lump total makes it look like Nosh is hiding
// charges when it's really just delivery fee + taxes on top of the item
// price. Field names are FoodCartPricing/FoodCartOffers from
// get_food_cart's documented output schema. Only shows a line when its
// field is actually present, per this file's existing "never invent a
// fallback value" convention.
function formatPricingBreakdown(pricing, offers, { totalLabel, lang = "en" } = {}) {
  if (!pricing) {
    return [];
  }

  const lines = [];

  if (typeof pricing.item_total === "number") {
    const label = pick(lang, { en: "Item total", hi: "आइटम टोटल", hinglish: "Item total" });
    lines.push(`${label}: ₹${pricing.item_total}`);
  }

  if (typeof pricing.delivery_charge === "number") {
    const label = pick(lang, { en: "Delivery charge", hi: "डिलीवरी चार्ज", hinglish: "Delivery charge" });
    lines.push(`${label}: ₹${pricing.delivery_charge}`);
  }

  // Swiggy's own field name (taxes_and_charges, not just "taxes") already
  // says this is a bundle - get_food_cart/update_food_cart's documented
  // FoodCartPricing doesn't break it into GST vs. a platform/convenience
  // fee vs. anything else, and there's no live Swiggy account available to
  // inspect a real response for undocumented sub-fields. Label it as the
  // bundle it is rather than inventing a split Swiggy doesn't provide.
  if (typeof pricing.taxes_and_charges === "number") {
    const label = pick(lang, {
      en: "Taxes & other charges",
      hi: "टैक्स और अन्य शुल्क",
      hinglish: "Tax aur other charges",
    });
    lines.push(`${label}: ₹${pricing.taxes_and_charges}`);
  }

  // coupon_discount can be present but 0 when Swiggy auto-suggests a coupon
  // without actually applying it (see handleApplyCoupon below) - only show
  // a discount line once it's genuinely applied.
  const couponDiscount = offers?.coupon_discount;
  if (typeof couponDiscount === "number" && couponDiscount > 0) {
    const label = pick(lang, { en: "Coupon discount", hi: "कूपन छूट", hinglish: "Coupon discount" });
    lines.push(`${label}: −₹${couponDiscount}`);
  }

  if (typeof pricing.to_pay === "number") {
    const label = totalLabel ?? pick(lang, { en: "Total", hi: "कुल", hinglish: "Total" });
    lines.push(`${label}: ₹${pricing.to_pay}`);
  }

  return lines;
}

function formatCartReply(cartData, lang = "en") {
  if (!cartData || !Array.isArray(cartData.items) || cartData.items.length === 0) {
    return emptyCartReply(lang);
  }

  const lines = cartData.items.map((item) => {
    const variantNames = Array.isArray(item.variants)
      ? item.variants.map((variant) => variant.name).filter(Boolean)
      : [];
    const suffix = variantNames.length > 0 ? ` (${variantNames.join(", ")})` : "";
    return `${item.quantity}x ${item.name}${suffix} — ₹${item.total}`;
  });

  const header = pick(lang, {
    en: `Your cart (${cartData.restaurant?.name ?? "restaurant"}):`,
    hi: `आपकी कार्ट (${cartData.restaurant?.name ?? "restaurant"}):`,
    hinglish: `Aapki cart (${cartData.restaurant?.name ?? "restaurant"}):`,
  });

  return [
    header,
    ...lines,
    ...formatPricingBreakdown(cartData.pricing, cartData.offers, { lang }),
  ]
    .filter(Boolean)
    .join("\n");
}

const NO_USUAL_REPLY =
  "You don't have a repeat order yet for me to reorder — search for a restaurant or dish instead.";

// get_food_orders' own doc says results come back newest-first, so scanning
// in the given array order and stopping at the first restaurant that
// reaches MIN_USUAL_ORDER_COUNT gives both "which restaurant qualifies" and
// "their most recent order there" in one pass, with no timestamp parsing
// needed - orderedTime is a year-less, human-readable string elsewhere in
// this file (see findOrderPlacedSinceSnapshot below) and can't be used for
// recency comparison.
//
// Swiggy doesn't document an orderStatus enum (their own docs warn against
// inventing status/enum values), so there's no confirmed "completed" string
// to match against. isActiveOrder is the only typed, unambiguous signal at
// this list level - "not active" (delivered, cancelled, or failed all
// alike) is used as "reached a terminal state" for counting purposes. A
// cancelled order can therefore count toward the >=2 threshold same as a
// delivered one; the actual reorder is still gated by is_reorderable_order
// (checked via get_food_order_details below) and by the ordinary
// deterministic YES/NO confirmation before anything is placed, so a
// mis-qualified count here is a minor UX miss, not a safety issue.
export function findUsualOrder(orders, { minCount = MIN_USUAL_ORDER_COUNT } = {}) {
  const terminalOrders = orders.filter((order) => order?.restaurantId && order.isActiveOrder !== true);

  const countsByRestaurant = new Map();
  for (const order of terminalOrders) {
    countsByRestaurant.set(order.restaurantId, (countsByRestaurant.get(order.restaurantId) ?? 0) + 1);
  }

  return terminalOrders.find((order) => countsByRestaurant.get(order.restaurantId) >= minCount);
}

// Rebuilds cartItems from get_food_order_details' order_items for
// update_food_cart. Field mapping (item_id -> menu_item_id, variants'
// {variation_id, group_id} -> a variantsV2 selection pair) is inferred from
// Swiggy's documented schemas, NOT yet confirmed against a real live call
// (no production/staging Swiggy account was available while building this)
// - re-verify against an actual get_food_order_details response before
// relying on this in production, the same way this file's other "confirmed
// live" comments were established. Addons are deliberately dropped: there's
// no live-verified update_food_cart addons INPUT shape anywhere in this
// codebase to map onto (handleAddToCart above never sends addons either),
// so a reordered item may come back without its previous add-ons rather
// than risk sending an invented field shape.
function buildReorderCartItems(orderItems) {
  return orderItems
    .filter((item) => typeof item?.item_id === "string" && item.item_id.length > 0)
    .map((item) => {
      const variantsV2 =
        Array.isArray(item.variants) && item.variants.length > 0
          ? item.variants
              .filter((variant) => variant?.group_id !== undefined && variant?.variation_id !== undefined)
              .map((variant) => ({ group_id: variant.group_id, variation_id: variant.variation_id }))
          : undefined;

      return {
        menu_item_id: item.item_id,
        quantity: Number.parseInt(item.quantity, 10) > 0 ? Number.parseInt(item.quantity, 10) : 1,
        variantsV2: variantsV2 && variantsV2.length > 0 ? variantsV2 : undefined,
      };
    });
}

// Tool implementation for the agent's `reorder_usual` tool (see
// src/agent.js) - the agent calls this when the user wants to repeat
// a past order without naming a specific dish/restaurant. Calls
// get_food_orders live every time - no caching - per this feature's design.
//
// Requires >=2 non-active orders at the SAME restaurant to call it a
// "usual" (a single past order isn't a pattern); otherwise returns
// NO_USUAL_REPLY as the tool result, which the agent is expected to relay
// (see recommendSimilar/recommend_similar below for the "something
// similar, not identical" case instead).
//
// On a match: fetches that order's structured items via
// get_food_order_details, clears the cart, rebuilds it item-for-item, and
// hands off into the EXACT SAME pendingCartSessions/formatCartReply path
// handleAddToCart uses - so the normal view-cart/checkout/YES-NO-confirm
// flow (checkout, placeConfirmedOrder) picks it up unmodified.
// Always shows the freshly-rebuilt cart's live total, never the old order's
// orderTotal - Swiggy pricing/availability can differ since the order was
// placed, and AGENTS.md forbids showing stale/fabricated pricing.
// `meta.replacedEarlierCart` (optional output): set when the rebuilt cart
// replaced one from a different restaurant, so the agent path can add its
// fixed "your cart was replaced" note - same as add_to_cart.
export async function buildReorderUsualReply({ senderId, swiggyFoodClient, pendingCartSessions, meta }) {
  const sessionBefore = pendingCartSessions.peek(senderId);
  let addressResult;
  try {
    addressResult = await swiggyFoodClient.getAddresses({});
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const parsedAddresses = parseStructuredPayload(addressResult);
  const addresses = Array.isArray(parsedAddresses?.addresses) ? parsedAddresses.addresses : undefined;

  if (addresses === undefined) {
    return GENERIC_FALLBACK_REPLY;
  }

  if ((typeof parsedAddresses?.total === "number" ? parsedAddresses.total : addresses.length) === 0) {
    return NO_SAVED_ADDRESS_REPLY;
  }

  // Unlike food-search-orchestrator.js's handleNewFoodSearch, this doesn't
  // prompt to disambiguate between multiple saved addresses - reorder is
  // meant to be a one-message shortcut, and that prompt-and-wait flow isn't
  // exported from that module. Falls back to the first saved address - a
  // scoped simplification, not an oversight. (get_addresses' documented
  // response has no "default address" field to prefer instead.) An address
  // already chosen in this conversation wins: seen live, a reorder used
  // Home after the user had picked Work.
  const addressId = sessionBefore?.addressId ?? addresses[0]?.id;

  if (!addressId) {
    return GENERIC_FALLBACK_REPLY;
  }

  let ordersResult;
  try {
    ordersResult = await swiggyFoodClient.getFoodOrders({ addressId });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const orders = parseStructuredPayload(ordersResult)?.orders;

  if (!Array.isArray(orders)) {
    return GENERIC_FALLBACK_REPLY;
  }

  const usualOrder = findUsualOrder(orders);

  if (!usualOrder) {
    return NO_USUAL_REPLY;
  }

  let detailsResult;
  try {
    detailsResult = await swiggyFoodClient.getFoodOrderDetails({ orderId: usualOrder.orderId });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const order = parseStructuredPayload(detailsResult)?.order;

  if (!order?.is_reorderable_order || !Array.isArray(order.order_items)) {
    return NO_USUAL_REPLY;
  }

  const cartItems = buildReorderCartItems(order.order_items);

  if (cartItems.length === 0) {
    return NO_USUAL_REPLY;
  }

  try {
    await swiggyFoodClient.flushFoodCart({});
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  let cartResult;
  try {
    cartResult = await swiggyFoodClient.updateFoodCart({
      restaurantId: order.restaurant_id,
      restaurantName: order.restaurant_name,
      addressId,
      cartItems,
    });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const cartData = unwrapCartPayload(cartResult);

  if (!cartData) {
    return GENERIC_FALLBACK_REPLY;
  }

  // cartRestaurantId is set here too (not just restaurantId/restaurantName)
  // since the flush+rebuild above already confirmed the live cart matches
  // this restaurant - without it, the next add-to-cart call would see no
  // cartRestaurantId and flush again, wiping the cart just rebuilt here.
  pendingCartSessions.set(senderId, {
    restaurantId: order.restaurant_id,
    restaurantName: order.restaurant_name,
    addressId,
    cartRestaurantId: order.restaurant_id,
  });

  if (meta) {
    meta.replacedEarlierCart =
      Boolean(sessionBefore?.cartRestaurantId) && sessionBefore.cartRestaurantId !== order.restaurant_id;
  }

  return [`Reordering your usual from ${order.restaurant_name}:`, formatCartReply(cartData)].join("\n\n");
}

const NO_ORDER_HISTORY_REPLY =
  "You don't have any past orders yet for me to base a recommendation on — search for a restaurant or dish instead.";

const RECOMMEND_MAX_RESTAURANTS = 2;
const RECOMMEND_MAX_ITEMS_PER_RESTAURANT = 4;

// Real menu items a sender has already ordered (per their own order-history
// strings, e.g. "1x Chicken Biryani") are excluded by a loose case-insensitive
// substring check rather than an exact match - get_food_orders' orderedItems
// field is a free-text description ("1x Chicken Biryani"), not a structured
// item name/id, so this is the only real-data way to tell "have they had
// this exact dish before" without inventing a match strategy Swiggy doesn't
// document.
function wasAlreadyOrdered(itemName, orderedItemStrings) {
  const nameNormalized = (itemName ?? "").trim().toLowerCase();
  if (!nameNormalized) {
    return false;
  }
  return orderedItemStrings.some((raw) => raw.toLowerCase().includes(nameNormalized));
}

// Turns a restaurant's real, live get_restaurant_menu result into a short
// block of real candidate items for the agent to pick from - in-stock only,
// bestsellers first, capped at RECOMMEND_MAX_ITEMS_PER_RESTAURANT. Prefers
// items NOT already in orderedItemStrings (a genuinely new suggestion), but
// falls back to the restaurant's top items generally (still real, just not
// guaranteed novel) rather than returning nothing when everything on a small
// menu has already been tried. Returns undefined if the menu call fails or
// comes back with nothing usable, so the caller can move on to its next
// candidate restaurant instead of failing the whole recommendation.
// vegOnly keeps only items Swiggy marks isVeg: true (an optional field per
// get_restaurant_menu's docs) - an item with no flag is left out rather than
// guessed. Enforced here because a prompt rule alone didn't hold: a user who
// asked for veg was offered a non-veg cheeseburger.
async function buildRestaurantCandidateBlock({
  swiggyFoodClient,
  addressId,
  restaurantId,
  restaurantName,
  orderedItemStrings,
  vegOnly = false,
}) {
  let menuResult;
  try {
    menuResult = await swiggyFoodClient.getRestaurantMenu({ addressId, restaurantId });
  } catch {
    return undefined;
  }

  const parsed = parseStructuredPayload(menuResult);
  const items = parsed?.items;
  if (!Array.isArray(items)) {
    return undefined;
  }

  const inStockItems = items.filter((item) => item?.inStock !== 0 && (!vegOnly || item.isVeg === true));
  const notYetTried = inStockItems.filter((item) => !wasAlreadyOrdered(item.name, orderedItemStrings));
  const pool = notYetTried.length > 0 ? notYetTried : inStockItems;

  if (pool.length === 0) {
    return undefined;
  }

  const sorted = [...pool].sort((a, b) => (b.isBestseller ? 1 : 0) - (a.isBestseller ? 1 : 0));
  const picked = sorted.slice(0, RECOMMEND_MAX_ITEMS_PER_RESTAURANT);
  const notYetTriedSet = new Set(notYetTried);

  const itemLines = picked.map((item) => {
    const price = typeof item.price === "number" ? ` — ₹${item.price}` : "";
    const badge = notYetTriedSet.has(item) ? "" : " (they've ordered this, or something like it, before)";
    return `  - ${item.name}${price}${badge}`;
  });

  // Real display facts about the restaurant itself, straight from THIS SAME
  // get_restaurant_menu call - verified against Swiggy's own docs
  // (mcp.swiggy.com/builders/docs/reference/food/get_restaurant_menu.md)
  // that its restaurant object can carry avgRating/avgRatingString and
  // deliveryTime/slaString, explicitly documented as optional "display/
  // ranking signals" - so only shown when actually present, never
  // fabricated when Swiggy omits them.
  const restaurant = parsed?.restaurant;
  const ratingText =
    restaurant?.avgRatingString ?? (typeof restaurant?.avgRating === "number" ? String(restaurant.avgRating) : undefined);
  const etaText = restaurant?.slaString ?? (typeof restaurant?.deliveryTime === "number" ? `${restaurant.deliveryTime} mins` : undefined);
  const restaurantFacts = [ratingText ? `⭐${ratingText}` : undefined, etaText].filter(Boolean).join(", ");
  const restaurantHeader = restaurantFacts ? `${restaurantName} — ${restaurantFacts}` : restaurantName;

  // Genuinely empty (as opposed to the old, effectively-dead "unknown"
  // fallback this replaced) now really happens - see findExploreRestaurants
  // below, whose candidates have no order history by definition. Say so
  // honestly rather than leaving a vague "unknown" that reads like missing
  // data rather than "you've truly never ordered here."
  const historyNote =
    orderedItemStrings.length > 0
      ? `previously ordered: ${orderedItemStrings.join(", ")}`
      : "you haven't ordered from here before - a genuinely new pick";
  return [`${restaurantHeader} (${historyNote}):`, ...itemLines].join("\n");
}

// Broad, universal cuisine terms tried so Case A below can offer at least
// one restaurant genuinely OUTSIDE a user's order history, not just
// untried dishes at the same restaurants they always order from - explicit
// user ask (2026-09-22): "I want to use the previous order to suggest
// something new and not the same thing." Before this, Case A only ever
// dedupes real order-history restaurants (capped at RECOMMEND_MAX_RESTAURANTS)
// - for a user who has only ever ordered from 1-2 places, that's a
// permanent ceiling no amount of "don't repeat" prompting can lift, since
// there's nothing else in the candidate set to reach for. Verified against
// Swiggy's own docs (mcp.swiggy.com/builders/docs/reference/food/
// search_restaurants.md) before adding this: query is required and no
// empty/"browse everything" query is documented - the docs themselves
// recommend exactly this pattern ("broad cuisine terms like 'biryani',
// 'pizza', 'chinese', 'thali'"), so every term here is a real search, never
// an invented parameter. Deliberately a short, generic list (not tuned to
// any one catalog, mock or real) - a term matching nothing at a given
// address is simply skipped, not treated as an error.
const EXPLORE_CUISINE_TERMS = ["chinese", "italian", "mexican", "south indian", "japanese", "american"];
const RECOMMEND_MAX_EXPLORE_RESTAURANTS = 1;
// Real Swiggy calls, one per term tried, all inside this single tool call
// (no extra Sarvam round-trip either way - see recommendSimilar's own
// comment on why this whole function exists as ONE call). Capped
// independently of RECOMMEND_MAX_EXPLORE_RESTAURANTS so a run of terms that
// keep missing can't turn into 6 sequential real HTTP calls before giving
// up - AGENTS.md already documents "no one is gonna wait this long" as the
// reason recommend_similar became a single bulk-gathering call in the first
// place; this must not quietly reintroduce that latency.
const EXPLORE_MAX_ATTEMPTS = 3;

// Fisher-Yates - order picked fresh per call so repeated recommendations in
// the same conversation don't always try (and typically land on) the same
// first cuisine term, giving genuine turn-to-turn variety in which new
// restaurant surfaces, not just which dish at it.
function shuffled(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Finds up to RECOMMEND_MAX_EXPLORE_RESTAURANTS real, open restaurants NOT
// already in knownRestaurantIds, by trying up to EXPLORE_MAX_ATTEMPTS of
// EXPLORE_CUISINE_TERMS (shuffled) - every result is a real
// search_restaurants call; a term producing nothing (or nothing novel) is
// skipped, not substituted with anything invented. Stops as soon as enough
// are found rather than always spending the full attempt budget.
async function findExploreRestaurants({ swiggyFoodClient, addressId, knownRestaurantIds }) {
  const found = [];
  const seenIds = new Set(knownRestaurantIds);

  for (const term of shuffled(EXPLORE_CUISINE_TERMS).slice(0, EXPLORE_MAX_ATTEMPTS)) {
    if (found.length >= RECOMMEND_MAX_EXPLORE_RESTAURANTS) {
      break;
    }

    let searchResult;
    try {
      searchResult = await swiggyFoodClient.searchRestaurants({ query: term, addressId });
    } catch {
      continue;
    }

    const restaurants = parseStructuredPayload(searchResult)?.restaurants;
    if (!Array.isArray(restaurants)) {
      continue;
    }

    for (const restaurant of restaurants) {
      if (found.length >= RECOMMEND_MAX_EXPLORE_RESTAURANTS) {
        break;
      }
      if (restaurant?.availabilityStatus !== "OPEN" || !restaurant?.id || seenIds.has(restaurant.id)) {
        continue;
      }
      seenIds.add(restaurant.id);
      found.push({ restaurantId: restaurant.id, restaurantName: restaurant.name, orderedItemStrings: [] });
    }
  }

  return found;
}

const RECOMMEND_CLOSING_INSTRUCTIONS =
  "Pick ONE item from the list above that best fits what they tend to like, preferring one not marked as " +
  "already-ordered-before AND one you have not already offered earlier in THIS conversation (scan every one " +
  "of your own prior replies this conversation, not just your most recent one - a small menu means the same " +
  "item can resurface a few turns later if you only check the last offer). A restaurant marked \"you haven't " +
  "ordered from here before\" is a genuinely new place, not just a new dish at somewhere familiar - if the " +
  "user is asking for something new/different, or has already rejected picks from their usual restaurants " +
  "this conversation, prefer one of those over yet another item at a restaurant they already order from. " +
  "Present its real name, restaurant, " +
  "real price, and (when a restaurant header includes one) its real rating and delivery time, and ask if they " +
  "want it added - do not call add_to_cart until they say yes. If a restaurant header has no rating/delivery " +
  "time listed, don't mention either - never invent one. Do not show this raw list to the user or ask them to " +
  "pick - you decide. If they reject this pick, call recommend_similar again and choose an item you have " +
  "never offered them before in this conversation (check EVERY one of your own earlier replies this " +
  "conversation, not only your last one). If every real item in the list above has already been offered and " +
  "rejected this conversation, say so honestly instead of repeating one of them. Never invent a dish, " +
  "restaurant, price, rating, or delivery time not listed above.";

// Tool implementation for the agent's `recommend_similar` tool (see
// src/agent.js). Does the entire "find something real to suggest"
// job in ONE tool call - resolving the address, reading real order history
// (or, if `craving` is given, running a real restaurant search for that
// craving instead), and fetching each candidate restaurant's real, live
// menu via get_restaurant_menu - so the agent gets a short list of real,
// in-stock items with real prices to choose from directly, without needing
// a separate search_food/search_menu round-trip (or several, if the first
// pick didn't pan out) to get there. This used to be spread across
// recommend_similar (text-only, describing history) + a agent-driven
// search_food + one-or-more search_menu calls; collapsing it here cuts a
// real recommendation from 4-8 sequential Sarvam round-trips down to about
// 2 (this tool call, then the final phrased reply) without moving the
// actual judgment call (which real item best fits this user) off the
// model - the code only gathers candidates, same pattern checkout already
// uses for "fetch cart + payment options in one call, then let the agent
// phrase the summary". Swiggy's Food MCP has no documented
// recommendation/bestseller/personalization tool (AGENTS.md: never invent
// one) - every fact returned here (restaurant name, item name, price) comes
// straight from a real tool result; only which restaurants/items to surface
// is this function's own heuristic (recency + bestseller-first), not a
// judgment about what the user would actually like.
export async function recommendSimilar({
  swiggyFoodClient,
  senderId,
  pendingCartSessions,
  pendingAddressSelections,
  craving,
  vegOnly = false,
  // Only used for this function's own address-disambiguation prompt below
  // (terminal when reached via the agent's recommend_similar tool call - see
  // executeTool's "recommend_similar" case in agent.js) - same split
  // as searchFood's own lang param in food-search-orchestrator.js. The rest
  // of this function's text (the candidate-block instructions) is always
  // agent-facing, never shown to the user directly, so it's unaffected.
  lang = "en",
  // Optional output object, marked with `hasData: true/false` right before
  // every return below - the same convention searchFood/runRestaurantSearch
  // use (food-search-orchestrator.js). Lets executeTool know, structurally,
  // whether this call surfaced real candidate items vs. a genuine dead end,
  // without string-matching the returned text. Never set on the
  // address-prompt branch - that's a separate, already-terminal path (see
  // executeTool's before/after pendingAddressSelections check) whose
  // hasData value is never consulted.
  meta,
}) {
  const markData = (hasData) => {
    if (meta) {
      meta.hasData = hasData;
    }
  };

  const existingAddressId = pendingCartSessions?.peek(senderId)?.addressId;
  let addressId = existingAddressId;

  if (!addressId) {
    let addressResult;
    try {
      addressResult = await swiggyFoodClient.getAddresses({});
    } catch {
      markData(false);
      return GENERIC_FALLBACK_REPLY;
    }

    const parsedAddresses = parseStructuredPayload(addressResult);
    const addresses = Array.isArray(parsedAddresses?.addresses) ? parsedAddresses.addresses : undefined;

    if (addresses === undefined) {
      markData(false);
      return GENERIC_FALLBACK_REPLY;
    }

    if ((typeof parsedAddresses?.total === "number" ? parsedAddresses.total : addresses.length) === 0) {
      markData(false);
      return NO_SAVED_ADDRESS_REPLY;
    }

    // A genuine choice exists - ask, exactly like an explicit search_food
    // request would (see searchFood in food-search-orchestrator.js). Used
    // to always silently auto-pick addresses[0] here ("the point of a
    // recommendation is that they don't have to decide") - explicit user
    // ask changed that: "I only want it to ask during the beginning of a
    // new order" is exactly what this is, recommendation or not. Only
    // asked ONCE per session either way - resolvePendingAddressReply
    // (food-search-orchestrator.js) persists the pick into
    // pendingCartSessions, so every later tool call this session (recommend
    // or explicit search) reuses it via existingAddressId above.
    if (addresses.length > 1) {
      const candidates = addresses.slice(0, MAX_ADDRESS_CANDIDATES).map(toAddressCandidate);

      pendingAddressSelections?.set(senderId, { kind: "recommend", craving, candidates });
      return formatAddressPrompt(candidates, lang);
    }

    addressId = addresses[0]?.id;

    if (!addressId) {
      markData(false);
      return GENERIC_FALLBACK_REPLY;
    }
  }

  // Persist this choice (but never overwrite an existing session) so a
  // later add_to_cart call this conversation, once the user says yes,
  // reuses this address instead of asking again.
  if (senderId && pendingCartSessions && !pendingCartSessions.peek(senderId)?.addressId) {
    pendingCartSessions.set(senderId, { addressId });
  }

  // Case B: the user stated a craving/cuisine and the agent translated it
  // into a concrete search term - find real open restaurants matching that,
  // rather than restaurants from history (a stated craving overrides "what
  // they usually get"). If nothing real matches the craving, this FALLS
  // THROUGH to Case A (order history) below rather than dead-ending -
  // confirmed live (2026-09-21) that an unusual/compound craving ("spicy
  // and umami") against this mock's small 3-restaurant catalog produced
  // "I couldn't find any open restaurants for X" on every retry, even
  // across a completely fresh turn, which the user reasonably read as
  // "everything is closed." A small mock catalog structurally can't match
  // every craving the way real Swiggy's much larger one would, and this
  // feature's whole premise ("the user shouldn't have to decide") is
  // defeated by a hard stop here when a real alternative (their own order
  // history) is sitting right there. `cravingMissed` tracks whether this
  // fallback fired, so the returned instructions can tell the agent to be
  // honest that the craving itself didn't match, rather than silently
  // presenting a history-based pick as if it satisfied the craving.
  let cravingMissed = false;

  if (craving) {
    let searchResult;
    try {
      searchResult = await swiggyFoodClient.searchRestaurants({ query: craving, addressId });
    } catch {
      markData(false);
      return GENERIC_FALLBACK_REPLY;
    }

    const restaurants = parseStructuredPayload(searchResult)?.restaurants;
    const openRestaurants = Array.isArray(restaurants)
      ? restaurants.filter((restaurant) => restaurant?.availabilityStatus === "OPEN").slice(0, RECOMMEND_MAX_RESTAURANTS)
      : [];

    if (openRestaurants.length > 0) {
      const blocks = [];
      for (const restaurant of openRestaurants) {
        const block = await buildRestaurantCandidateBlock({
          swiggyFoodClient,
          addressId,
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          orderedItemStrings: [],
          vegOnly,
        });
        if (block) {
          blocks.push(block);
        }
      }

      if (blocks.length > 0) {
        markData(true);
        return [
          `Real menu candidates for "${craving}", from real open restaurants near this user:`,
          vegOnly ? "Every item listed is marked vegetarian by Swiggy." : undefined,
          ...blocks,
          RECOMMEND_CLOSING_INSTRUCTIONS,
        ]
          .filter(Boolean)
          .join("\n");
      }
    }

    cravingMissed = true;
  }

  // Case A: no stated craving, OR a stated craving that genuinely matched
  // nothing real (see cravingMissed above) - base the recommendation on
  // real order history instead.
  let ordersResult;
  try {
    ordersResult = await swiggyFoodClient.getFoodOrders({ addressId });
  } catch {
    markData(false);
    return GENERIC_FALLBACK_REPLY;
  }

  const orders = parseStructuredPayload(ordersResult)?.orders;

  if (!Array.isArray(orders)) {
    markData(false);
    return GENERIC_FALLBACK_REPLY;
  }

  // Active (in-progress) orders are excluded - they aren't "history" yet.
  const pastOrders = orders.filter((order) => order?.restaurantId && order.isActiveOrder !== true);

  if (pastOrders.length === 0) {
    markData(false);
    return cravingMissed
      ? `I couldn't find anything open for "${craving}" right now, and there's no order history to fall back on either.`
      : NO_ORDER_HISTORY_REPLY;
  }

  // get_food_orders' own doc says results come back newest-first; dedupe to
  // distinct restaurants while preserving that recency order, and collect
  // every raw orderedItems string per restaurant so real menu items can be
  // filtered against what was actually ordered before.
  const orderedByRestaurant = new Map();
  for (const order of pastOrders) {
    const existing = orderedByRestaurant.get(order.restaurantId);
    if (existing) {
      if (order.orderedItems) {
        existing.orderedItemStrings.push(order.orderedItems);
      }
    } else {
      orderedByRestaurant.set(order.restaurantId, {
        restaurantId: order.restaurantId,
        restaurantName: order.restaurantName,
        orderedItemStrings: order.orderedItems ? [order.orderedItems] : [],
      });
    }
  }

  const candidateRestaurants = [...orderedByRestaurant.values()].slice(0, RECOMMEND_MAX_RESTAURANTS);

  // Genuinely new restaurants, outside this user's order history entirely -
  // see findExploreRestaurants' own comment for why this exists. Fetched
  // even when candidateRestaurants is non-empty (not just as a fallback for
  // "history came up empty") - the whole point is to stop capping every
  // recommendation at only the restaurants someone has already ordered
  // from, not just to handle the edge case where history has nothing at
  // all.
  //
  // Deliberately SKIPPED when cravingMissed is true. This branch is also
  // reached on a craving miss (Case B falling through to Case A) - if
  // explore ran there too, a candidate found by searching an unrelated
  // (shuffled) cuisine term would sit in the SAME list this function's own
  // header text says "do NOT claim satisfies their stated craving," while
  // RECOMMEND_CLOSING_INSTRUCTIONS separately tells the agent to prefer a
  // genuinely-new-restaurant pick when the user asked for something new -
  // two correct-sounding instructions that combine into presenting a
  // random, non-matching restaurant as if it were relevant. Explore is for
  // "no craving stated" only; a craving miss already has its own honest
  // fallback wording.
  //
  // exploredRestaurantIds (persisted on pendingCartSessions, same pattern
  // as addressId below) is ALSO excluded, not just this turn's history -
  // without it, findExploreRestaurants' term shuffle (for genuine
  // turn-to-turn cuisine variety) could just as easily re-pick the SAME
  // restaurant on a later call this conversation, which would read as "it's
  // still stuck" rather than "it's exploring." Structural exclusion, not
  // left to chance.
  const existingSession = pendingCartSessions?.peek(senderId);
  const alreadyExploredIds = existingSession?.exploredRestaurantIds ?? [];

  // With vegOnly, a craving miss still explores: the user's real ask is
  // "something veg", every explored item is filtered to veg, and the header
  // below says not to present it as the craving. Without this, a missed
  // craving like "paneer" left only already-ordered history items.
  const exploreRestaurants = cravingMissed && !vegOnly
    ? []
    : await findExploreRestaurants({
        swiggyFoodClient,
        addressId,
        knownRestaurantIds: [...orderedByRestaurant.keys(), ...alreadyExploredIds],
      });

  if (senderId && pendingCartSessions && exploreRestaurants.length > 0) {
    pendingCartSessions.set(senderId, {
      ...existingSession,
      addressId,
      exploredRestaurantIds: [...alreadyExploredIds, ...exploreRestaurants.map((restaurant) => restaurant.restaurantId)],
    });
  }

  const blocks = [];
  for (const restaurant of [...candidateRestaurants, ...exploreRestaurants]) {
    const block = await buildRestaurantCandidateBlock({ swiggyFoodClient, addressId, ...restaurant, vegOnly });
    if (block) {
      blocks.push(block);
    }
  }

  if (blocks.length === 0) {
    markData(false);
    if (vegOnly) {
      return "I couldn't find any vegetarian items at open restaurants near you right now.";
    }
    return cravingMissed
      ? `I couldn't find anything open for "${craving}" right now, and couldn't pull up a real menu from their order history either.`
      : GENERIC_FALLBACK_REPLY;
  }

  const header = cravingMissed && vegOnly
    ? `Nothing open matched "${craving}", but every item below is vegetarian, from this user's order history ` +
      "or a restaurant they haven't tried. Say plainly that nothing matched " +
      `"${craving}", then offer one of these as a veg alternative - never present it as "${craving}":`
    : cravingMissed
    ? `Nothing real was open for "${craving}", so here are real candidates from this user's actual order history ` +
      "and each restaurant's real current menu instead - tell them honestly that nothing matched what they asked " +
      "for, then offer one of these as an alternative. Do NOT claim any of these satisfies their stated craving:"
    : "Real menu candidates for a recommendation, gathered from this user's actual order history AND (where " +
      "marked 'you haven't ordered from here before') a genuinely new restaurant outside their history - " +
      "each restaurant's real current menu:";

  markData(true);
  const vegNote = vegOnly ? "Every item listed is marked vegetarian by Swiggy." : undefined;
  return [header, vegNote, ...blocks, RECOMMEND_CLOSING_INSTRUCTIONS].filter(Boolean).join("\n");
}

// What a message means while an order summary is waiting for its answer.
// Only typed text can place or cancel the order:
//   "place" / "cancel"  a typed yes / no (parseOrderConfirmationReply)
//   "voice"             a voice note - never places or cancels, however it
//                       was transcribed, because speech recognition can
//                       mishear and an order can't be undone
//   "reminder"          a tapped button that isn't an order button, or any
//                       other typed text
// (The order buttons themselves are handled before this, by their own ids -
// see resolveTap in interactive-replies.js.)
export function decidePendingOrderReply(message) {
  if (message.replyId) {
    return "reminder";
  }
  if (message.fromVoice) {
    return "voice";
  }
  const decision = parseOrderConfirmationReply(message.text ?? "");
  return decision === "confirm" ? "place" : decision === "cancel" ? "cancel" : "reminder";
}

// Auto-picks each variant group's Swiggy-marked default (falling back to the
// first option) so a plain "add a margherita pizza" doesn't require
// interrogating the user about crust/size first. Never invents a selection
// Swiggy didn't already mark as the default.
function selectDefaultVariants(menuItem) {
  if (!Array.isArray(menuItem.variantsV2) || menuItem.variantsV2.length === 0) {
    return undefined;
  }

  const selections = menuItem.variantsV2
    .map((group) => {
      const variations = Array.isArray(group.variations) ? group.variations : [];
      const chosen = variations.find((variation) => variation.default === 1) ?? variations[0];
      return chosen ? { group_id: group.groupId, variation_id: chosen.id } : undefined;
    })
    .filter(Boolean);

  return selections.length > 0 ? selections : undefined;
}

// search_restaurants can inject an unrelated sponsored listing ahead of the
// actual match - confirmed live, searching "KFC" put an ad for a completely
// different restaurant ("Billu's Food Hut") in position 1, ahead of the
// real "KFC" result in position 2. Strips the "(Ad)" suffix before
// comparing since that's just Swiggy's own sponsorship marker, not part of
// the restaurant's actual name.
function normalizeRestaurantName(name) {
  return (name ?? "")
    .replace(/\s*\(ad\)\s*$/i, "")
    .trim()
    .toLowerCase();
}

function restaurantNamesMatch(a, b) {
  const aNormalized = normalizeRestaurantName(a);
  const bNormalized = normalizeRestaurantName(b);
  return aNormalized.includes(bNormalized) || bNormalized.includes(aNormalized);
}

// Resolves a restaurant name the user named (e.g. "from Pizza Hut") to an
// actual open restaurant via search_restaurants. Confirmed live: a named
// restaurant often doesn't even appear in a cross-restaurant dish search's
// top results, so silently falling back to "whatever dish search returned"
// would ignore the user's explicit choice - this must be resolved on its
// own rather than hoped for as a side effect of the dish search.
//
// Never just takes the first "OPEN" result - that's exactly how the ad
// above got picked instead of KFC. Only resolves to a restaurant whose name
// actually matches what the user named; otherwise reports not-found rather
// than silently ordering from the wrong place.
async function resolveRestaurant({ swiggyFoodClient, restaurantName, addressId }) {
  let result;
  try {
    result = await swiggyFoodClient.searchRestaurants({ query: restaurantName, addressId });
  } catch {
    return undefined;
  }

  const restaurants = parseStructuredPayload(result)?.restaurants;

  if (!Array.isArray(restaurants)) {
    return undefined;
  }

  const queryNormalized = normalizeRestaurantName(restaurantName);

  return restaurants.find((restaurant) => {
    if (restaurant?.availabilityStatus !== "OPEN") {
      return false;
    }

    const nameNormalized = normalizeRestaurantName(restaurant?.name);
    return nameNormalized.includes(queryNormalized) || queryNormalized.includes(nameNormalized);
  });
}

// Resolves a free-text dish query to a specific menu item, given a specific
// restaurant. If no restaurant is given, searches across all restaurants
// first (search_menu's documented cross-restaurant mode) and picks the top
// in-stock match. Either way, a second scoped search_menu call is required
// to get the variant/addon detail update_food_cart needs - the
// cross-restaurant response doesn't carry it (confirmed live). Also
// confirmed live: scoping to a known restaurant first produces a much better
// dish match than the cross-restaurant search alone, even for a typo'd
// query - so callers that already know the restaurant (existing session, or
// a resolved restaurantName hint) should always pass restaurantId in.
async function resolveMenuItem({ swiggyFoodClient, query, addressId, restaurantId }) {
  let scopedRestaurantId = restaurantId;
  let scopedRestaurantName;

  if (!scopedRestaurantId) {
    let crossResult;
    try {
      crossResult = await swiggyFoodClient.searchMenu({ query, addressId });
    } catch {
      return undefined;
    }

    const crossItems = parseStructuredPayload(crossResult)?.items;
    const match = Array.isArray(crossItems)
      ? crossItems.find((item) => item?.in_stock !== 0 && item?.inStock !== 0)
      : undefined;

    if (!match) {
      return undefined;
    }

    scopedRestaurantId = match.restaurant_id;
    scopedRestaurantName = match.restaurant_name;
  }

  let scopedResult;
  try {
    scopedResult = await swiggyFoodClient.searchMenu({
      query,
      addressId,
      restaurantIdOfAddedItem: scopedRestaurantId,
    });
  } catch {
    return undefined;
  }

  const scopedItems = parseStructuredPayload(scopedResult)?.items;
  let menuItem = Array.isArray(scopedItems) ? scopedItems.find((item) => item?.inStock !== 0) : undefined;

  // Fuzzy fallback for a query that just missed Swiggy's own substring match
  // at a restaurant we already know - confirmed live (2026-09-22, sender
  // 919289388564): a "add items 1-9" turn, moments after Nosh itself had
  // shown all 9 real, in-stock item names, added only the one item already
  // used earlier in the conversation - the other 8, each a genuine real
  // in-stock dish, all missed search_menu's own query match (query text
  // isn't logged, so the exact mismatch can't be confirmed, but 8 fresh
  // dish names reproduced across 8 rapid tool calls in one round is the
  // same transcription-fidelity risk already fixed for restaurant names,
  // see resolveRestaurant's own fuzzy matching above). The model then
  // fabricated a stock-related excuse ("might have run out") for what was
  // actually its own near-miss - this closes the gap the same way: try
  // once more against every real item at this restaurant, fuzzy-matched,
  // before reporting not-found.
  if (!menuItem) {
    menuItem = await fuzzyResolveMenuItemByName({ swiggyFoodClient, query, addressId, restaurantId: scopedRestaurantId });
  }

  return menuItem ? { menuItem, restaurantId: scopedRestaurantId, restaurantName: scopedRestaurantName } : undefined;
}

// get_restaurant_menu's item shape has no menu_item_id/variantsV2 (verified
// against docs/reference/food/get_restaurant_menu.md - it's documented as a
// "compact browse view" that intentionally omits them, "use search_menu for
// those instead") - not adaptable directly into the cart-add pipeline. Used
// here ONLY to find the real, correctly-spelled name of the closest match,
// then re-run through the ALREADY-WORKING scoped search_menu call (same
// shape resolveMenuItem's normal path already returns) to get a properly
// shaped item. Never throws; undefined means "still couldn't find it",
// same as resolveMenuItem's other empty-result paths.
async function fuzzyResolveMenuItemByName({ swiggyFoodClient, query, addressId, restaurantId }) {
  let menuResult;
  try {
    menuResult = await swiggyFoodClient.getRestaurantMenu({ addressId, restaurantId });
  } catch {
    return undefined;
  }

  const items = parseStructuredPayload(menuResult)?.items;
  if (!Array.isArray(items)) {
    return undefined;
  }

  // Deliberately ONE-DIRECTIONAL (the real name must contain the query, not
  // the other way round) and requires a UNIQUE match - caught in review
  // before shipping: a short, generic query like "taco" is exactly the
  // real live-transcript case, and the bidirectional check restaurant-name
  // matching uses (query.includes(name) too) would let "taco" match "Veg
  // Tacos (Mock)" at a restaurant that genuinely has no taco - silently
  // adding the wrong real item instead of reporting an honest not-found is
  // strictly worse than the bug this function exists to fix (a fabricated
  // excuse becomes a wrong item in a real cart, one confirmation away from
  // a real order). A transcription near-miss on a real name (the actual
  // incident: "Katsu Curry" for "Chicken Katsu Curry") still resolves to
  // exactly one item under both restrictions; a vague/generic query either
  // matches nothing or matches more than one real item, and either way
  // this must fail closed to the honest not-found instead of guessing.
  const queryNormalized = normalizeRestaurantName(query);
  const matches = items.filter((item) => {
    if (item?.inStock === 0) {
      return false;
    }
    return normalizeRestaurantName(item?.name).includes(queryNormalized);
  });

  if (matches.length !== 1) {
    return undefined;
  }

  const match = matches[0];

  let correctedResult;
  try {
    correctedResult = await swiggyFoodClient.searchMenu({
      query: match.name,
      addressId,
      restaurantIdOfAddedItem: restaurantId,
    });
  } catch {
    return undefined;
  }

  const correctedItems = parseStructuredPayload(correctedResult)?.items;
  return Array.isArray(correctedItems) ? correctedItems.find((item) => item?.inStock !== 0) : undefined;
}

// Once the user has picked a specific restaurant off a shown list, this
// finds what's actually available there matching their original search term
// (e.g. "pizza") - per search_menu's own documented guidance: "Present all
// matching results; let the user choose before calling update_food_cart."
// Scoping via restaurantIdOfAddedItem also gets the full variantsV2/addon
// detail update_food_cart needs, the same as resolveMenuItem's second call
// above - no extra request required to add whichever one they pick. Never
// throws; an empty array means "nothing matched" or "the lookup failed",
// either way the caller falls back to asking freeform.
async function findMatchingMenuItems({ swiggyFoodClient, query, addressId, restaurantId }) {
  if (!query) {
    return [];
  }

  let result;
  try {
    result = await swiggyFoodClient.searchMenu({ query, addressId, restaurantIdOfAddedItem: restaurantId });
  } catch {
    return [];
  }

  const items = parseStructuredPayload(result)?.items;
  return Array.isArray(items) ? items.filter((item) => item?.inStock !== 0).slice(0, MAX_ITEM_RESULTS) : [];
}

function formatItemSelectionReply(searchTerm, restaurantName, items) {
  const lines = items.map((item, index) => {
    const price = typeof item.price === "number" ? ` — ₹${item.price}` : "";
    return `${index + 1}. ${item.name}${price}`;
  });

  return [
    `Here's what I found for "${searchTerm}" at ${restaurantName}:`,
    ...lines,
    "Tap one to add it, or tell me what else you'd like.",
  ].join("\n");
}

// Shared by handleAddToCart (a freshly resolved dish) and the numbered
// item-selection reply below (a dish already picked off a shown list) -
// both end the same way: call update_food_cart, record the session, and
// show the updated cart.
//
// knownCartRestaurantId is this session's own record of which restaurant
// the LIVE Swiggy cart is already confirmed to hold (set below, only after
// a successful add) - not the same thing as restaurantId/restaurantName,
// which just describe where THIS add is going and get set as soon as a
// restaurant is chosen, ahead of any actual cart write (see the restaurant
// numbered-list branch in resolvePendingCartCandidateReply below). Observed in manual testing
// against the mock server (not confirmed against real Swiggy) without this
// check: picking a different restaurant than whatever was already in the
// cart (a prior abandoned session, a restaurant switch, items added
// outside Nosh entirely) silently merged the new item onto the old cart's
// leftover items AND its already-applied coupon, instead of starting
// clean. Flushing whenever the two don't match - including the very first
// add of a fresh session, when knownCartRestaurantId is simply unset -
// means a new order never inherits stale contents it didn't ask for.
// `meta`: same optional output object recommendSimilar/searchMenu accept -
// marked with `hasData: true/false` right before every return, so
// executeTool's add_to_cart case gets a structural signal for whether the
// item genuinely landed in the cart, instead of trusting the agent's own
// free-text claim (see cartMutationState in agent.js).
async function addResolvedItemToCart({
  senderId,
  swiggyFoodClient,
  pendingCartSessions,
  addressId,
  restaurantId,
  restaurantName,
  menuItem,
  quantity,
  knownCartRestaurantId,
  announceCartReplacement = true,
  meta,
}) {
  const markData = (hasData) => {
    if (meta) {
      meta.hasData = hasData;
    }
  };

  // Deliberately left UNMARKED (meta.hasData stays undefined, not false) on
  // every GENERIC_FALLBACK_REPLY path below - these are thrown/infra
  // failures (a network hiccup, an unparseable payload), not a genuine
  // "item not on the real menu" business result. Marking them false would
  // make cartMutationState's guard in agent.js force GENERIC_FALLBACK_
  // REPLY's English-only text verbatim onto a Hindi/Hinglish conversation
  // instead of letting the agent phrase its own language-mirrored apology -
  // the exact regression already caught and fixed once for search_food/
  // search_menu's own thrown-call case (see executeTool's search_food
  // comment). Only a real "couldn't find X" business dead end is marked
  // false; see handleAddToCart's own two returns below for that case.
  if (knownCartRestaurantId !== restaurantId) {
    try {
      await swiggyFoodClient.flushFoodCart({});
    } catch {
      return GENERIC_FALLBACK_REPLY;
    }
  }

  let cartResult;
  try {
    cartResult = await swiggyFoodClient.updateFoodCart({
      restaurantId,
      restaurantName,
      addressId,
      cartItems: [
        {
          menu_item_id: menuItem.menu_item_id,
          quantity: quantity ?? 1,
          variantsV2: selectDefaultVariants(menuItem),
        },
      ],
    });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const cartData = unwrapCartPayload(cartResult);

  if (!cartData) {
    return GENERIC_FALLBACK_REPLY;
  }

  pendingCartSessions.set(senderId, { restaurantId, restaurantName, addressId, cartRestaurantId: restaurantId });

  const replacedEarlierCart = Boolean(knownCartRestaurantId) && knownCartRestaurantId !== restaurantId;
  if (meta) {
    meta.replacedEarlierCart = replacedEarlierCart;
  }

  // The agent path appends its own fixed note instead (see runAgentTurn),
  // since the agent can't be trusted to relay this line.
  const addedLine =
    replacedEarlierCart && announceCartReplacement
      ? `Added ${menuItem.name} to a fresh cart at ${restaurantName} — your earlier cart's items were removed.`
      : `Added ${menuItem.name} to your cart.`;

  // Checkout refuses carts over the limit; say so now rather than letting
  // the user find out at checkout (seen live: 50 biryanis, ₹13,113).
  const overLimitLine =
    typeof cartData.pricing?.to_pay === "number" && cartData.pricing.to_pay > BUILDERS_CLUB_CART_CAP
      ? `Heads up: Nosh can only check out carts up to ₹${BUILDERS_CLUB_CART_CAP}, and this one is ₹${cartData.pricing.to_pay}.`
      : undefined;

  markData(true);
  return [addedLine, formatCartReply(cartData), overLimitLine].filter(Boolean).join("\n\n");
}

async function handleAddToCart({
  senderId,
  query,
  quantity,
  restaurantNameHint,
  swiggyFoodClient,
  pendingCartSessions,
  addressId,
  restaurantId: existingRestaurantId,
  restaurantName: existingRestaurantName,
  cartRestaurantId,
  meta,
}) {
  const markData = (hasData) => {
    if (meta) {
      meta.hasData = hasData;
    }
  };

  let targetRestaurantId = existingRestaurantId;
  let targetRestaurantName = existingRestaurantName;

  // A named restaurant takes priority over both dish search and the
  // session's current restaurant - never silently substitute a different
  // restaurant than the one asked for.
  const hintNamesAnotherRestaurant =
    restaurantNameHint && !(existingRestaurantName && restaurantNamesMatch(existingRestaurantName, restaurantNameHint));

  if (hintNamesAnotherRestaurant) {
    const restaurant = await resolveRestaurant({ swiggyFoodClient, restaurantName: restaurantNameHint, addressId });

    if (!restaurant) {
      markData(false);
      return `Sorry, I couldn't find a restaurant called "${restaurantNameHint}" near you.`;
    }

    targetRestaurantId = restaurant.id;
    targetRestaurantName = restaurant.name;
  }

  const resolved = await resolveMenuItem({
    swiggyFoodClient,
    query,
    addressId,
    restaurantId: targetRestaurantId,
  });

  if (!resolved) {
    markData(false);
    return targetRestaurantName
      ? `Sorry, I couldn't find "${query}" at ${targetRestaurantName} right now.`
      : `Sorry, I couldn't find "${query}" on the menu right now.`;
  }

  const { menuItem, restaurantId, restaurantName } = resolved;
  const resolvedRestaurantName = restaurantName ?? targetRestaurantName;

  return addResolvedItemToCart({
    senderId,
    swiggyFoodClient,
    pendingCartSessions,
    addressId,
    restaurantId,
    restaurantName: resolvedRestaurantName,
    menuItem,
    quantity,
    knownCartRestaurantId: cartRestaurantId,
    announceCartReplacement: false,
    meta,
  });
}

async function handleViewCart({ swiggyFoodClient, addressId, restaurantName, lang = "en" }) {
  let cartResult;
  try {
    cartResult = await swiggyFoodClient.getFoodCart({ addressId, restaurantName });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  return formatCartReply(unwrapCartPayload(cartResult), lang);
}

// Matches a user-typed dish name (e.g. "the pizza") against every line in
// the live cart - same case-insensitive, either-direction substring match
// normalizeRestaurantName already uses to match a user-typed restaurant
// name, since it's the same underlying problem (Swiggy's own name vs.
// whatever the user actually typed). Returns every match rather than just
// the first: a cart can hold more than one item matching a broad query
// (e.g. "pizza" matching both Margherita and Pepperoni) - removing
// whichever one happens to come first would silently delete the wrong
// item, so the caller has to disambiguate instead of guessing.
function findMatchingCartItems(cartData, query) {
  const items = Array.isArray(cartData?.items) ? cartData.items : [];
  const queryNormalized = normalizeRestaurantName(query);

  return items.filter((item) => {
    const nameNormalized = normalizeRestaurantName(item?.name);
    return nameNormalized.includes(queryNormalized) || queryNormalized.includes(nameNormalized);
  });
}

// Maps a cart item's existing variant selections (get_food_cart's
// FoodCartItem.variants - group_id/variation_id pairs, per its documented
// schema) back into the {group_id, variation_id} shape update_food_cart's
// variantsV2 expects, so a quantity change on a customized item keeps its
// existing customization instead of dropping it. Same field mapping
// buildReorderCartItems above already does for reorder.
function cartItemVariantsV2(cartItem) {
  const variants = Array.isArray(cartItem?.variants) ? cartItem.variants : [];
  const selections = variants
    .filter((variant) => variant?.group_id !== undefined && variant?.variation_id !== undefined)
    .map((variant) => ({ group_id: variant.group_id, variation_id: variant.variation_id }));

  return selections.length > 0 ? selections : undefined;
}

// Swiggy's Food MCP has no dedicated remove/delete-cart-item tool (checked
// against the full documented tool catalogue - AGENTS.md: never invent
// one). update_food_cart's own docs confirm quantity CAN be changed for an
// item already in the cart ("asks to change quantity of an item"), but
// never say whether quantity: 0 removes the line entirely - this is the
// same assumption the mock server already encodes (quantity <= 0 deletes
// the item) and is close to universal for cart APIs, but it is NOT
// confirmed against a real Swiggy account. Re-verify before trusting this
// in production, the same way this file's other unconfirmed-live notes ask
// for.
// `meta`: same optional output object addResolvedItemToCart accepts above -
// marked `hasData: true` only on a genuine, unambiguous removal/quantity
// change; an ambiguous multi-match is marked `false` too, since nothing was
// actually removed yet and the agent must not claim otherwise.
async function handleRemoveFromCart({
  swiggyFoodClient,
  addressId,
  restaurantId,
  restaurantName,
  query,
  quantity,
  meta,
}) {
  const markData = (hasData) => {
    if (meta) {
      meta.hasData = hasData;
    }
  };

  // Deliberately left UNMARKED (meta.hasData stays undefined) on this catch
  // and the updateFoodCart catch/!updatedCartData path below - see
  // addResolvedItemToCart's identical comment: these are thrown/infra
  // failures, not a genuine cart-content business result, so the agent
  // should still get to phrase its own language-mirrored apology around
  // GENERIC_FALLBACK_REPLY rather than have it forced through verbatim.
  let cartResult;
  try {
    cartResult = await swiggyFoodClient.getFoodCart({ addressId, restaurantName });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const cartData = unwrapCartPayload(cartResult);

  if (!cartData || !Array.isArray(cartData.items) || cartData.items.length === 0) {
    markData(false);
    return emptyCartReply();
  }

  const matches = findMatchingCartItems(cartData, query);

  if (matches.length === 0) {
    markData(false);
    return `Sorry, I couldn't find "${query}" in your cart.`;
  }

  if (matches.length > 1) {
    markData(false);
    const names = matches.map((item) => item.name).join(" and ");
    return `You have a few things matching "${query}" in your cart: ${names}. Which one did you mean? Reply with the full name.`;
  }

  const cartItem = matches[0];
  const currentQuantity = Number(cartItem.quantity) > 0 ? Number(cartItem.quantity) : 0;
  // No count given ("remove the pizza") removes the whole line; a stated
  // count ("remove 1 biryani") only reduces it, clamped so it can't go
  // negative if they ask to remove more than there actually are.
  const newQuantity = Number.isInteger(quantity) ? Math.max(0, currentQuantity - quantity) : 0;

  // variantsV2 is only sent (and only reconstructed) when the line survives
  // at a reduced quantity - it needs to keep its existing customization
  // then, but on a full removal (quantity: 0) it's an unverified field
  // mapping serving no purpose on a call whose entire point is to make the
  // line disappear, so it's left out rather than risking the removal
  // itself on it.
  const cartItemPayload = { menu_item_id: cartItem.menu_item_id, quantity: newQuantity };

  if (newQuantity > 0) {
    cartItemPayload.variantsV2 = cartItemVariantsV2(cartItem);
  }

  let updateResult;
  try {
    updateResult = await swiggyFoodClient.updateFoodCart({
      restaurantId,
      restaurantName,
      addressId,
      cartItems: [cartItemPayload],
    });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const updatedCartData = unwrapCartPayload(updateResult);

  if (!updatedCartData) {
    return GENERIC_FALLBACK_REPLY;
  }

  const confirmationLine =
    newQuantity === 0 ? `Removed ${cartItem.name} from your cart.` : `Updated ${cartItem.name} to ${newQuantity}x.`;

  markData(true);
  return [confirmationLine, formatCartReply(updatedCartData)].join("\n\n");
}

function formatCoupons(couponsPayload, lang = "en") {
  const sections = Array.isArray(couponsPayload?.coupon_sections) ? couponsPayload.coupon_sections : [];
  const coupons = sections.flatMap((section) => (Array.isArray(section?.coupons) ? section.coupons : []));

  if (coupons.length === 0) {
    return pick(lang, {
      en: "No coupons available for this order right now.",
      hi: "अभी इस ऑर्डर के लिए कोई कूपन उपलब्ध नहीं है।",
      hinglish: "Abhi is order ke liye koi coupon available nahi hai.",
    });
  }

  // coupons[].title IS the redeemable code (confirmed live) - there's no
  // separate "code" field.
  const lines = coupons
    .slice(0, MAX_COUPONS)
    .map((coupon) => `${coupon.title} — ${coupon.description ?? coupon.subtitle ?? ""}`.trim());

  const header = pick(lang, { en: "Available coupons:", hi: "उपलब्ध कूपन:", hinglish: "Available coupons:" });
  const example = coupons[0].title;
  const footer = pick(lang, {
    en: `Tap one to apply it, or reply "apply ${example}".`,
    hi: `लगाने के लिए एक चुनें, या "apply ${example}" लिखें।`,
    hinglish: `Apply karne ke liye ek tap karein, ya "apply ${example}" likhein.`,
  });

  return [header, ...lines, footer].join("\n");
}

// fetch_food_coupons marks each coupon with applicable / applicabilityStatus
// (mcp.swiggy.com/builders/docs/reference/food/fetch_food_coupons.md). Both
// are optional, so a coupon with neither is still offered; apply_food_coupon
// has the final say.
function couponIsUsable(coupon) {
  if (coupon?.applicabilityStatus === "APPLIED") {
    return false;
  }
  if (coupon?.applicable === undefined && coupon?.applicabilityStatus === undefined) {
    return true;
  }
  return coupon?.applicable === true || coupon?.applicabilityStatus === "APPLICABLE";
}

// Offers ONE coupon and asks before applying it. Swiggy gives no discount
// amounts to compare, so "best" is the first coupon Swiggy lists that works
// on this cart; the real saving shows once it is applied. Never mentions
// uppercase YES/NO - that wording is reserved for the checkout summary.
function formatCouponOffer(couponsPayload, lang = "en") {
  const sections = Array.isArray(couponsPayload?.coupon_sections) ? couponsPayload.coupon_sections : [];
  const coupons = sections
    .flatMap((section) => (Array.isArray(section?.coupons) ? section.coupons : []))
    .filter((coupon) => typeof coupon?.title === "string" && coupon.title.trim());

  if (coupons.length === 0) {
    return { text: formatCoupons(couponsPayload, lang) };
  }

  const applied = coupons.find((coupon) => coupon.applicabilityStatus === "APPLIED");
  if (applied) {
    return {
      text: pick(lang, {
        en: `${applied.title} is already applied to this order.`,
        hi: `${applied.title} इस ऑर्डर पर पहले से लागू है।`,
        hinglish: `${applied.title} is order par pehle se apply hai.`,
      }),
    };
  }

  const usable = coupons.filter(couponIsUsable);
  if (usable.length === 0) {
    return {
      text: pick(lang, {
        en: "None of the available coupons work on this order right now - adding more items may unlock one.",
        hi: "अभी कोई भी कूपन इस ऑर्डर पर लागू नहीं हो रहा - और आइटम जोड़ने पर कोई लागू हो सकता है।",
        hinglish: "Abhi koi bhi coupon is order par nahi chal raha - aur items add karne par koi chal sakta hai.",
      }),
    };
  }

  const best = usable[0];
  const details = (best.description ?? best.subtitle ?? "").trim();
  const couponLine = details ? `${best.title} — ${details}` : best.title;
  const others = usable.length - 1;

  const lines = [
    pick(lang, {
      en: "Best coupon I found for this order:",
      hi: "इस ऑर्डर के लिए मुझे सबसे अच्छा कूपन यह मिला:",
      hinglish: "Is order ke liye sabse accha coupon yeh mila:",
    }),
    couponLine,
    pick(lang, { en: "Should I apply it?", hi: "क्या मैं इसे लगा दूँ?", hinglish: "Kya main ise apply kar doon?" }),
  ];

  if (others > 0) {
    lines.push(
      pick(lang, {
        en: `(${others} more available - ask to see all coupons.)`,
        hi: `(${others} और उपलब्ध हैं - सभी कूपन देखने के लिए कहें।)`,
        hinglish: `(${others} aur available hain - saare coupons dekhne ke liye bolein.)`,
      }),
    );
  }

  return { text: lines.join("\n"), offeredCouponCode: best.title };
}

async function handleFindCoupons({ swiggyFoodClient, restaurantId, addressId, showAll = false, lang = "en" }) {
  let result;
  try {
    result = await swiggyFoodClient.fetchFoodCoupons({ restaurantId, addressId });
  } catch {
    return { text: GENERIC_FALLBACK_REPLY };
  }

  const couponsPayload = parseStructuredPayload(result);

  if (!showAll) {
    return formatCouponOffer(couponsPayload, lang);
  }

  const sections = Array.isArray(couponsPayload?.coupon_sections) ? couponsPayload.coupon_sections : [];
  const listedCoupons = sections
    .flatMap((section) => (Array.isArray(section?.coupons) ? section.coupons : []))
    .filter((coupon) => typeof coupon?.title === "string" && coupon.title.trim())
    .slice(0, MAX_COUPONS)
    .map((coupon) => ({ code: coupon.title, description: (coupon.description ?? coupon.subtitle ?? "").trim() }));

  return { text: formatCoupons(couponsPayload, lang), listedCoupons };
}

async function handleApplyCoupon({ swiggyFoodClient, couponCode, addressId, lang = "en" }) {
  let result;
  try {
    result = await swiggyFoodClient.applyFoodCoupon({ couponCode, addressId });
  } catch {
    return pick(lang, {
      en: `Sorry, I couldn't apply "${couponCode}" — it may not be valid for this order right now.`,
      hi: `माफ़ कीजिए, मैं "${couponCode}" लागू नहीं कर सका — यह अभी इस ऑर्डर के लिए मान्य नहीं हो सकता।`,
      hinglish: `Sorry, main "${couponCode}" apply nahi kar saka — shayad yeh abhi is order ke liye valid nahi hai.`,
    });
  }

  const cartData = unwrapCartPayload(result);
  // update/apply responses can report a coupon as "suggested" with
  // coupon_discount: 0 even when not actually applied (documented in the
  // tool's own schema) - never claim savings unless the discount is > 0.
  const discount = cartData?.offers?.coupon_discount ?? 0;

  if (!cartData || discount <= 0) {
    return pick(lang, {
      en: `"${couponCode}" didn't give a discount on this order — the code may not be valid, or the order may not qualify for it.`,
      hi: `"${couponCode}" से इस ऑर्डर पर कोई छूट नहीं मिली — हो सकता है कोड मान्य न हो, या यह ऑर्डर उसके लिए योग्य न हो।`,
      hinglish: `"${couponCode}" se is order par koi discount nahi mila — ho sakta hai code valid na ho, ya order uske liye qualify na karta ho.`,
    });
  }

  const confirmationLine = pick(lang, {
    en: `Applied ${couponCode} — you saved ₹${discount}.`,
    hi: `${couponCode} लागू हो गया — आपने ₹${discount} बचाए।`,
    hinglish: `${couponCode} apply ho gaya — aapne ₹${discount} bachaye.`,
  });

  return [confirmationLine, formatCartReply(cartData, lang)].join("\n\n");
}

function formatOrderSummary(cartData, paymentMethodLabel, lang = "en") {
  const lines = cartData.items.map((item) => `${item.quantity}x ${item.name} — ₹${item.total}`);

  const header = pick(lang, {
    en: `Order summary — ${cartData.restaurant?.name ?? "your order"}:`,
    hi: `ऑर्डर सारांश — ${cartData.restaurant?.name ?? "your order"}:`,
    hinglish: `Order summary — ${cartData.restaurant?.name ?? "your order"}:`,
  });
  const totalLabel = pick(lang, { en: "Total to pay", hi: "कुल भुगतान", hinglish: "Total pay karna hai" });
  const paymentLabel = pick(lang, { en: "Payment", hi: "भुगतान", hinglish: "Payment" });
  // MUST keep the literal uppercase English "YES"/"NO" tokens regardless of
  // language - parseOrderConfirmationReply's regex and server.js's own
  // /\bYES\b/ / /\bNO\b/ backstop check are both English-only by design (see
  // AGENTS.md's Commerce Safety section); translating these two tokens would
  // silently break order placement for a non-English speaker.
  const confirmFooter = pick(lang, {
    en: "Reply YES to place this order, or NO to cancel.",
    hi: "इस ऑर्डर को देने के लिए YES लिखें, रद्द करने के लिए NO लिखें।",
    hinglish: "Order place karne ke liye YES likhein, cancel karne ke liye NO likhein.",
  });

  return [
    header,
    ...lines,
    ...formatPricingBreakdown(cartData.pricing, cartData.offers, { totalLabel, lang }),
    `${paymentLabel}: ${paymentMethodLabel}`,
    "",
    confirmFooter,
  ]
    .filter(Boolean)
    .join("\n");
}

// Builds the order summary and stores it for the deterministic confirmation
// gate in server.js - this function itself never calls place_food_order.
// COD-only for this increment: place_food_order's own contract requires an
// explicit user-picked method, and completing a UPI payment needs a polling
// flow (check_payment_status) that's a separate increment. If COD isn't
// available, Nosh says so rather than guessing at a payment method.
async function handleCheckout({
  senderId,
  swiggyFoodClient,
  addressId,
  restaurantName,
  pendingOrderConfirmations,
  lang = "en",
}) {
  let cartResult;
  try {
    cartResult = await swiggyFoodClient.getFoodCart({ addressId, restaurantName });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const cartData = unwrapCartPayload(cartResult);

  if (!cartData || !Array.isArray(cartData.items) || cartData.items.length === 0) {
    return emptyCartReply(lang);
  }

  // Checked before spending a getPaymentOptions call on an order that can't
  // proceed anyway - see BUILDERS_CLUB_CART_CAP's own comment above.
  if (typeof cartData.pricing?.to_pay === "number" && cartData.pricing.to_pay > BUILDERS_CLUB_CART_CAP) {
    return pick(lang, {
      en: `Your cart total is ₹${cartData.pricing.to_pay}, which is over the ₹${BUILDERS_CLUB_CART_CAP} limit Nosh can currently check out. Please remove some items and try again.`,
      hi: `आपकी कार्ट का कुल ₹${cartData.pricing.to_pay} है, जो Nosh की मौजूदा ₹${BUILDERS_CLUB_CART_CAP} सीमा से ज़्यादा है। कृपया कुछ आइटम हटाकर फिर कोशिश करें।`,
      hinglish: `Aapki cart ka total ₹${cartData.pricing.to_pay} hai, jo Nosh ki abhi ki ₹${BUILDERS_CLUB_CART_CAP} limit se zyada hai. Kripya kuch items hatakar phir try karein.`,
    });
  }

  let paymentResult;
  try {
    paymentResult = await swiggyFoodClient.getPaymentOptions({ addressId });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const paymentOptions = parseStructuredPayload(paymentResult);

  if (!paymentOptions?.cod?.available) {
    return pick(lang, {
      en: "Cash on Delivery isn't available for this order, and Nosh can't complete a UPI payment over WhatsApp yet — please finish this order in the Swiggy app.",
      hi: "इस ऑर्डर के लिए कैश ऑन डिलीवरी उपलब्ध नहीं है, और Nosh अभी WhatsApp पर UPI पेमेंट पूरा नहीं कर सकता — कृपया इस ऑर्डर को Swiggy ऐप में पूरा करें।",
      hinglish:
        "Is order ke liye Cash on Delivery available nahi hai, aur Nosh abhi WhatsApp par UPI payment complete nahi kar sakta — please is order ko Swiggy app mein complete karein.",
    });
  }

  pendingOrderConfirmations.set(senderId, {
    addressId,
    cartId: cartData.cart_id,
    paymentMethod: "Cash",
    // For the tap-to-order buttons (see interactive-replies.js): the nonce
    // ties a button to this exact summary, and the summary line is repeated
    // in the "place this order?" check.
    nonce: newConfirmationNonce(),
    summary: { restaurantName: cartData.restaurant?.name, toPay: cartData.pricing?.to_pay },
  });

  return formatOrderSummary(cartData, paymentOptions.cod.displayName ?? "Cash on Delivery", lang);
}

// Best-effort check for "did place_food_order actually go through despite
// the error", used only when placeFoodOrder itself throws. Swiggy's tools
// don't expose a way to correlate a specific placement attempt to an order
// (no idempotency key, no cart->order link), and get_food_orders' own
// orderedTime is a year-less, human-readable string ("September 8, 3:59 PM")
// - confirmed live - so it can't be parsed to check recency. A before/after
// set-diff on orderId sidesteps both problems: it doesn't need to parse a
// timestamp, only to notice an order that wasn't there a moment ago. It can
// still misattribute if a genuinely different order lands in that same
// window (e.g. another device orders concurrently), but that's strictly
// better than the previous behavior of no check at all before this fix.
async function findOrderPlacedSinceSnapshot(swiggyFoodClient, addressId, priorOrderIds) {
  try {
    const afterData = parseStructuredPayload(await swiggyFoodClient.getFoodOrders({ addressId }));
    return afterData?.orders?.find((order) => !priorOrderIds.has(order.orderId));
  } catch {
    return undefined;
  }
}

// Only called after server.js's deterministic YES check on a pending
// confirmation - never from NLU classification.
//
// Non-idempotent retry safety (AGENTS.md: never blindly retry a
// non-idempotent commerce operation, check whether it already succeeded
// first): once place_food_order returns an orderId, it's saved onto the
// pending confirmation itself (see server.js) and a retried YES skips
// straight to confirm_order rather than placing a second order. That
// protects a retry within the same pending-confirmation lifecycle (doesn't
// survive a process restart, same as every other Pending* store). It does
// NOT protect the case where placeFoodOrder itself throws without us ever
// learning the orderId - for that, findOrderPlacedSinceSnapshot below
// snapshots the order list first and diffs it against the failure so a
// retry doesn't double-order just because the success response got lost.
const PLACE_ORDER_FAILED_REPLY = {
  en: "Sorry, I couldn't place that order right now. Please try again in a bit.",
  hi: "माफ़ कीजिए, मैं अभी वह ऑर्डर नहीं दे सका। कृपया थोड़ी देर में फिर कोशिश करें।",
  hinglish: "Sorry, main abhi wo order place nahi kar saka. Thodi der mein phir try karein.",
};

// Swiggy's guidance after a 5xx or network error on order placement: wait
// 2-5 seconds, check get_food_orders, treat a new order as success, and
// only retry the original call if none appeared.
// https://mcp.swiggy.com/builders/docs/build/ship-to-production.md
const ORDER_CHECK_DELAY_MS = 3000;
const MAX_PLACE_ORDER_ATTEMPTS = 2;

export async function placeConfirmedOrder({
  swiggyFoodClient,
  confirmation,
  lang = "en",
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let orderId = confirmation.orderId;
  let lat = confirmation.lat;
  let lng = confirmation.lng;

  if (!orderId) {
    let priorOrderIds;
    try {
      const beforeData = parseStructuredPayload(
        await swiggyFoodClient.getFoodOrders({ addressId: confirmation.addressId }),
      );
      priorOrderIds = new Set((beforeData?.orders ?? []).map((order) => order.orderId));
    } catch {
      priorOrderIds = undefined; // Best-effort baseline only - proceed without it if it fails.
    }

    let placeResult;
    for (let attempt = 1; attempt <= MAX_PLACE_ORDER_ATTEMPTS; attempt += 1) {
      try {
        placeResult = await swiggyFoodClient.placeFoodOrder({
          addressId: confirmation.addressId,
          paymentMethod: confirmation.paymentMethod,
        });
        break;
      } catch (error) {
        // Without a baseline there's no way to tell whether the order went
        // through, so it is never retried.
        if (!priorOrderIds) {
          return { status: "failed", replyText: pick(lang, PLACE_ORDER_FAILED_REPLY) };
        }

        const transient = isTransientSwiggyFailure(error);
        if (transient) {
          await sleep(ORDER_CHECK_DELAY_MS);
        }
        const newOrder = await findOrderPlacedSinceSnapshot(swiggyFoodClient, confirmation.addressId, priorOrderIds);

        if (newOrder) {
          // It actually went through despite the error - fall through to
          // confirm_order below instead of telling the user it failed.
          orderId = newOrder.orderId;
          break;
        }

        if (!transient || attempt === MAX_PLACE_ORDER_ATTEMPTS) {
          return { status: "failed", replyText: pick(lang, PLACE_ORDER_FAILED_REPLY) };
        }
        console.warn("Retrying place_food_order after confirming no order was created.");
      }
    }

    if (!orderId) {
      const orderData = parseStructuredPayload(placeResult);

      if (!orderData?.orderId) {
        return { status: "failed", replyText: pick(lang, PLACE_ORDER_FAILED_REPLY) };
      }

      orderId = orderData.orderId;
      lat = orderData.lat;
      lng = orderData.lng;
    }
  }

  try {
    await swiggyFoodClient.confirmOrder({
      orderId,
      addressId: confirmation.addressId,
      cartId: confirmation.cartId,
      lat,
      lng,
    });
  } catch {
    return {
      status: "placed_not_confirmed",
      orderId,
      lat,
      lng,
      // MUST keep the literal uppercase "YES" - see formatOrderSummary's own
      // comment above; this re-prompt feeds the same deterministic gate.
      replyText: pick(lang, {
        en: "Your order was placed, but we couldn't confirm it just now — reply YES again and I'll retry confirming without placing a duplicate order.",
        hi: "आपका ऑर्डर दे दिया गया है, लेकिन हम इसे अभी कन्फर्म नहीं कर सके — फिर से YES लिखें और मैं बिना डुप्लीकेट ऑर्डर दिए कन्फर्म करने की कोशिश करूंगा।",
        hinglish:
          "Aapka order place ho gaya hai, lekin abhi confirm nahi ho saka — dobara YES likhein aur main duplicate order diye bina confirm karne ki koshish karunga.",
      }),
    };
  }

  // Swiggy's docs don't document the cart being emptied as a side effect of
  // confirm_order, so flush explicitly rather than assume it. Best-effort
  // only, and never re-thrown: the order is already confirmed, so a failed
  // flush must not turn into a false "your Swiggy connection expired"
  // reply (server.js's withSwiggyFoodClient treats a thrown
  // SwiggyAuthFailureError as reason to report the order as not placed).
  try {
    await swiggyFoodClient.flushFoodCart({});
  } catch (error) {
    console.error("Failed to flush Swiggy Food cart after a confirmed order.", { name: error?.name });
  }

  return {
    status: "confirmed",
    replyText: pick(lang, {
      en: "Your order has been placed! You'll get delivery updates from Swiggy.",
      hi: "आपका ऑर्डर दे दिया गया है! आपको Swiggy से डिलीवरी अपडेट मिलते रहेंगे।",
      hinglish: "Aapka order place ho gaya hai! Aapko Swiggy se delivery updates milte rahenge.",
    }),
  };
}

// lang-aware, used only by the terminal tool wrappers below (view_cart,
// find_coupons, apply_coupon, checkout - see each wrapper's own call);
// removeFromCart/searchMenu (agent-phrased, never terminal) call this with
// no lang argument (default "en") since the agent translates its own reply.
export function noActiveOrderReply(lang = "en") {
  return pick(lang, {
    en: "You don't have an order in progress yet — search for something first.",
    hi: "अभी आपका कोई ऑर्डर प्रोसेस में नहीं है — पहले कुछ खोजें।",
    hinglish: "Abhi aapka koi order in progress nahi hai — pehle kuch search karein.",
  });
}

// Deterministic pre-agent short-circuit, extracted unchanged from what used
// to be the top of getFoodOrderReply: a bare number reply to an item or
// restaurant list this bot just showed is resolved straight off it, no
// agent call involved - same zero-cost, any-language numbered-list pattern
// as resolvePendingAddressReply in food-search-orchestrator.js, and for the
// same reason (not a "trigger word", just picking an option off a list).
// Returns { handled: false } when neither candidate list applies, so the
// caller (server.js) knows to hand the message to the agent instead.
export async function resolvePendingCartCandidateReply({ message, swiggyFoodClient, pendingCartSessions, lang = "en" }) {
  const session = pendingCartSessions.peek(message.from);

  if (session?.itemCandidates) {
    const selectedIndex = parseAddressSelectionReply(message.text, session.itemCandidates.length);

    if (selectedIndex !== undefined) {
      const menuItem = session.itemCandidates[selectedIndex];
      const replyText = await addResolvedItemToCart({
        senderId: message.from,
        swiggyFoodClient,
        pendingCartSessions,
        addressId: session.addressId,
        restaurantId: session.restaurantId,
        restaurantName: session.restaurantName,
        menuItem,
        knownCartRestaurantId: session.cartRestaurantId,
      });
      return { handled: true, replyText };
    }
  }

  // itemCandidates is checked above and restaurantCandidates never carries
  // over onto the session it replaces, so at most one of these two blocks
  // can ever match the same numbered reply.
  if (session?.restaurantCandidates) {
    const selectedIndex = parseAddressSelectionReply(message.text, session.restaurantCandidates.length);

    if (selectedIndex !== undefined) {
      const restaurant = session.restaurantCandidates[selectedIndex];

      // Per search_menu's own documented guidance ("Present all matching
      // results; let the user choose before calling update_food_cart") -
      // look up what's actually available at this restaurant matching the
      // original search term (e.g. "pizza"), rather than making the user
      // restate what they want freeform. Falls back to the old open-ended
      // prompt if nothing matched or the lookup failed - never a dead end.
      const items = await findMatchingMenuItems({
        swiggyFoodClient,
        query: session.searchTerm,
        addressId: session.addressId,
        restaurantId: restaurant.id,
      });

      if (items.length > 0) {
        pendingCartSessions.set(message.from, {
          addressId: session.addressId,
          cartRestaurantId: session.cartRestaurantId,
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          itemCandidates: items,
        });
        return { handled: true, replyText: formatItemSelectionReply(session.searchTerm, restaurant.name, items) };
      }

      pendingCartSessions.set(message.from, {
        addressId: session.addressId,
        cartRestaurantId: session.cartRestaurantId,
        restaurantId: restaurant.id,
        restaurantName: restaurant.name,
      });

      // No dish there is named after the search term - seen live: "sushi" at
      // a sushi restaurant whose dishes are California Roll, Salmon Nigiri...
      // Show the real menu rather than ask an open question the user can only
      // answer by guessing dish names.
      const menuMeta = {};
      const menuReply = await showRestaurantMenu({
        senderId: message.from,
        swiggyFoodClient,
        pendingCartSessions,
        lang,
        meta: menuMeta,
      }).catch(() => undefined);

      if (menuMeta.shown) {
        return { handled: true, replyText: menuReply };
      }

      const gotItReply = pick(lang, {
        en: `Got it — what would you like from ${restaurant.name}?`,
        hi: `ठीक है — ${restaurant.name} से आपको क्या चाहिए?`,
        hinglish: `Theek hai — ${restaurant.name} se aapko kya chahiye?`,
      });
      return { handled: true, replyText: gotItReply };
    }
  }

  return { handled: false };
}

// When a search found exactly one open restaurant, asking "which one would
// you like?" is a wasted step (seen live). This picks it, exactly as if the
// user had replied "1", and returns what that shows: the matching dishes, or
// the restaurant's menu. Returns undefined when there isn't exactly one.
export async function autoPickOnlyRestaurant({ senderId, swiggyFoodClient, pendingCartSessions, lang = "en" }) {
  const session = pendingCartSessions.peek(senderId);

  if (session?.restaurantCandidates?.length !== 1 || session.itemCandidates) {
    return undefined;
  }

  const outcome = await resolvePendingCartCandidateReply({
    message: { from: senderId, text: "1" },
    swiggyFoodClient,
    pendingCartSessions,
    lang,
  });

  return outcome.handled ? outcome.replyText : undefined;
}

// Everything below is a thin tool-facing wrapper: pulls this sender's
// current cart session (addressId/restaurantId/restaurantName/
// cartRestaurantId) and delegates to the deterministic Swiggy-calling
// helpers above, unchanged - the only difference from the old
// classifyOrderIntent-driven dispatch is that the AGENT (src/agent.js)
// decides when to call these, not app-code branching on a pre-classified
// intent. None of these ever call placeFoodOrder/confirmOrder - see
// placeConfirmedOrder above, only reachable via server.js's deterministic
// YES/NO gate.

// Looks up the sender's saved addresses and, when there is a real choice,
// asks which one to use (the same question search and recommend ask).
// Returns { addressId } when there is exactly one, { prompt } when the
// question was asked, or { error } with a ready reply otherwise. `kind` is
// stored with the open question; anything other than "search" means "record
// the pick and hand back to the agent" (see resolvePendingAddressReply).
async function resolveAddressOrAsk({ senderId, swiggyFoodClient, pendingAddressSelections, kind, lang }) {
  let parsedAddresses;
  try {
    parsedAddresses = parseStructuredPayload(await swiggyFoodClient.getAddresses({}));
  } catch {
    return { error: GENERIC_FALLBACK_REPLY };
  }

  const addresses = Array.isArray(parsedAddresses?.addresses) ? parsedAddresses.addresses : undefined;

  if (addresses === undefined) {
    return { error: GENERIC_FALLBACK_REPLY };
  }

  if (addresses.length === 0) {
    return { error: NO_SAVED_ADDRESS_REPLY };
  }

  if (addresses.length === 1 || !pendingAddressSelections) {
    return addresses[0]?.id ? { addressId: addresses[0].id, addresses } : { error: GENERIC_FALLBACK_REPLY };
  }

  const candidates = addresses.slice(0, MAX_ADDRESS_CANDIDATES).map(toAddressCandidate);
  pendingAddressSelections.set(senderId, { kind, candidates });
  return { prompt: formatAddressPrompt(candidates, lang) };
}

// Tool implementation for the agent's `change_address` tool: re-asks which
// saved address to deliver to. The pick replaces the session (a cart belongs
// to one address), then the agent carries on. Before this, "change my
// address to Home" was answered with "update it in the Swiggy app" even
// though the user had Home saved.
export async function changeAddress({ senderId, swiggyFoodClient, pendingAddressSelections, lang = "en" }) {
  const outcome = await resolveAddressOrAsk({ senderId, swiggyFoodClient, pendingAddressSelections, kind: "change", lang });

  if (outcome.prompt) {
    return outcome.prompt;
  }

  if (outcome.error) {
    return outcome.error;
  }

  const label = toAddressCandidate(outcome.addresses[0]).label;
  return pick(lang, {
    en: `You have only one saved address (${label}). Add another in the Swiggy app to switch.`,
    hi: `आपका सिर्फ़ एक पता सेव है (${label})। बदलने के लिए Swiggy ऐप में दूसरा पता जोड़ें।`,
    hinglish: `Aapka sirf ek address saved hai (${label}). Badalne ke liye Swiggy app mein doosra address add karein.`,
  });
}

// `meta`: see addResolvedItemToCart's own comment above.
// With no delivery address chosen yet (a first message, or after a restart),
// asks for one first. Before this, the Swiggy lookups ran with no address,
// failed, and the user was told the restaurant they named doesn't exist.
export async function addToCart({
  senderId,
  query,
  quantity,
  restaurantNameHint,
  swiggyFoodClient,
  pendingCartSessions,
  pendingAddressSelections,
  lang = "en",
  meta,
}) {
  if (!pendingCartSessions.peek(senderId)?.addressId) {
    const outcome = await resolveAddressOrAsk({ senderId, swiggyFoodClient, pendingAddressSelections, kind: "add", lang });

    if (outcome.prompt || outcome.error) {
      return outcome.prompt ?? outcome.error;
    }

    pendingCartSessions.set(senderId, { ...pendingCartSessions.peek(senderId), addressId: outcome.addressId });
  }

  const session = pendingCartSessions.peek(senderId);
  return handleAddToCart({
    senderId,
    query,
    quantity,
    restaurantNameHint,
    swiggyFoodClient,
    pendingCartSessions,
    addressId: session?.addressId,
    restaurantId: session?.restaurantId,
    restaurantName: session?.restaurantName,
    cartRestaurantId: session?.cartRestaurantId,
    meta,
  });
}

// Prefer a fuzzy match against the restaurant list search_food already
// showed for THIS session, if any, before falling back to a fresh
// Swiggy-side name search. Confirmed live: with only a couple of real
// restaurants in play, an approximate/paraphrased name the agent passes
// (rather than copying search_food's result verbatim, despite being told
// to) can fail a live name search repeatedly, burning the tool-call round
// budget - this list is the same real, already-fetched candidates from
// moments earlier in this exact conversation, so matching against it
// fuzzily first is still 100% real data, just more forgiving of an
// imprecise name.
async function findRestaurantByNameHint({ session, restaurantName, swiggyFoodClient }) {
  const hintNormalized = normalizeRestaurantName(restaurantName);
  const knownCandidate = session.restaurantCandidates?.find((candidate) => {
    const candidateNormalized = normalizeRestaurantName(candidate.name);
    return candidateNormalized.includes(hintNormalized) || hintNormalized.includes(candidateNormalized);
  });

  return knownCandidate ?? (await resolveRestaurant({ swiggyFoodClient, restaurantName, addressId: session.addressId }));
}

// Tool implementation for the agent's `search_menu` tool (see
// src/agent.js) - lets the agent find a real dish and its real price
// at a specific restaurant WITHOUT adding anything to the cart, so it can
// quote a real price and ask "want me to add it?" before committing, for an
// EXPLICIT dish/restaurant request (recommend_similar handles the "you
// decide" case itself now, via get_restaurant_menu, without going through
// this tool). Needs an addressId already established by a prior search_food
// call in this conversation - this never resolves a delivery address
// itself, unlike searchFood.
// `meta`: same optional output object recommendSimilar/searchFood accept
// (see recommendSimilar's own comment) - marked with `hasData: true/false`
// right before every return, so executeTool's search_menu case gets a
// structural signal instead of string-matching the reply.
export async function searchMenu({ senderId, restaurantName, query, swiggyFoodClient, pendingCartSessions, meta }) {
  const markData = (hasData) => {
    if (meta) {
      meta.hasData = hasData;
    }
  };

  const session = pendingCartSessions.peek(senderId);

  if (!session?.addressId) {
    markData(false);
    return noActiveOrderReply();
  }

  let restaurantId = session.restaurantId;
  let resolvedRestaurantName = session.restaurantName;

  if (restaurantName) {
    const restaurant = await findRestaurantByNameHint({ session, restaurantName, swiggyFoodClient });

    if (!restaurant) {
      markData(false);
      return `Sorry, I couldn't find a restaurant called "${restaurantName}" near you.`;
    }

    restaurantId = restaurant.id;
    resolvedRestaurantName = restaurant.name;
  }

  const items = await findMatchingMenuItems({ swiggyFoodClient, query, addressId: session.addressId, restaurantId });

  if (items.length === 0) {
    markData(false);
    return `Couldn't find "${query}" at ${resolvedRestaurantName ?? "that restaurant"} right now.`;
  }

  markData(true);
  return formatItemSelectionReply(query, resolvedRestaurantName ?? "that restaurant", items);
}

// get_restaurant_menu returns up to 150 dishes; a WhatsApp message is capped
// at 4096 characters, so the list is cut well below both.
const MAX_MENU_ITEMS = 40;

// TERMINAL_TOOLS tool (see src/agent.js) - the result goes straight to
// the user, so the agent can never reword or invent a menu. Backed by Swiggy's
// real get_restaurant_menu (docs/reference/food/get_restaurant_menu.md: "Browse
// a restaurant's complete menu... when users want to explore offerings").
// That tool is browse-only - its items carry `id`, not the menu_item_id/
// variantsV2 update_food_cart needs, and the docs say to use search_menu for
// ordering - so adding a dish from this list still goes through add_to_cart,
// which already resolves it via search_menu.
// `meta.shown` (optional output) is set when a real menu was listed.
export async function showRestaurantMenu({ senderId, restaurantName, swiggyFoodClient, pendingCartSessions, lang = "en", meta }) {
  const session = pendingCartSessions.peek(senderId);

  if (!session?.addressId) {
    return noActiveOrderReply(lang);
  }

  let restaurantId = session.restaurantId;
  let resolvedRestaurantName = session.restaurantName;

  if (restaurantName) {
    const restaurant = await findRestaurantByNameHint({ session, restaurantName, swiggyFoodClient });

    if (!restaurant) {
      return pick(lang, {
        en: `Sorry, I couldn't find a restaurant called "${restaurantName}" near you.`,
        hi: `माफ़ कीजिए, आपके पास "${restaurantName}" नाम का कोई रेस्टोरेंट नहीं मिला।`,
        hinglish: `Sorry, aapke paas "${restaurantName}" naam ka koi restaurant nahi mila.`,
      });
    }

    restaurantId = restaurant.id;
    resolvedRestaurantName = restaurant.name;
  }

  if (!restaurantId) {
    return pick(lang, {
      en: "Which restaurant's menu would you like to see?",
      hi: "आप किस रेस्टोरेंट का मेन्यू देखना चाहेंगे?",
      hinglish: "Aap kis restaurant ka menu dekhna chahenge?",
    });
  }

  let menuResult;
  try {
    menuResult = await swiggyFoodClient.getRestaurantMenu({ addressId: session.addressId, restaurantId });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const parsed = parseStructuredPayload(menuResult);
  const displayName = parsed?.restaurant?.name ?? resolvedRestaurantName ?? "this restaurant";
  const inStockItems = (Array.isArray(parsed?.items) ? parsed.items : []).filter((item) => item?.inStock !== 0);

  if (inStockItems.length === 0) {
    return pick(lang, {
      en: `I couldn't load ${displayName}'s menu right now.`,
      hi: `अभी ${displayName} का मेन्यू लोड नहीं हो सका।`,
      hinglish: `Abhi ${displayName} ka menu load nahi ho saka.`,
    });
  }

  // Later adds from this list must target this restaurant. Earlier numbered
  // lists are dropped so a bare "2" can't be resolved against a stale
  // restaurant/item list by resolvePendingCartCandidateReply; cartRestaurantId
  // is kept so add_to_cart only flushes the cart on a genuine restaurant switch.
  const shown = inStockItems.slice(0, MAX_MENU_ITEMS);
  // menuItems lets the menu be shown as tappable rows (interactive-replies.js).
  const { restaurantCandidates, itemCandidates, searchTerm, menuItems, ...rest } = session;
  pendingCartSessions.set(senderId, {
    ...rest,
    restaurantId,
    restaurantName: displayName,
    menuItems: shown.map((item) => ({ id: item.id, name: item.name, price: item.price })),
  });
  if (meta) {
    meta.shown = true;
  }

  const lines = shown.map((item, index) => {
    const price = typeof item.price === "number" ? ` — ₹${item.price}` : "";
    return `${index + 1}. ${item.name}${price}`;
  });

  const header = pick(lang, {
    en: `${displayName} menu:`,
    hi: `${displayName} का मेन्यू:`,
    hinglish: `${displayName} ka menu:`,
  });

  const moreNote =
    inStockItems.length > shown.length || parsed?.truncated === true
      ? pick(lang, {
          en: `Showing ${shown.length} dishes — ask for any other dish by name.`,
          hi: `${shown.length} डिश दिखाई गई हैं — कोई और डिश नाम से पूछें।`,
          hinglish: `${shown.length} dishes dikhayi gayi hain — koi aur dish naam se poochein.`,
        })
      : undefined;

  const footer = pick(lang, {
    en: "Tap a dish to add it, or tell me what you'd like.",
    hi: "जोड़ने के लिए कोई डिश चुनें, या बताइए आपको क्या चाहिए।",
    hinglish: "Add karne ke liye koi dish tap karein, ya batayein kya chahiye.",
  });

  return [header, ...lines, moreNote, footer].filter(Boolean).join("\n");
}

// lang is threaded through to real detected language here (unlike addToCart/
// removeFromCart/searchMenu above) because view_cart is a TERMINAL_TOOLS tool
// - its result becomes the final reply directly, with no agent phrasing/
// translation pass in between. See AGENTS.md's "place order and get address
// should be hardcoded" decision and src/agent.js's TERMINAL_TOOLS.
export async function viewCart({ senderId, swiggyFoodClient, pendingCartSessions, lang = "en" }) {
  const session = pendingCartSessions.peek(senderId);

  if (!session) {
    return noActiveOrderReply(lang);
  }

  return handleViewCart({
    swiggyFoodClient,
    addressId: session.addressId,
    restaurantName: session.restaurantName,
    lang,
  });
}

const MAX_ORDERS_SHOWN = 5;

// Tool implementation for the agent's `view_orders` tool: the user's recent
// orders from get_food_orders, newest-first, listed verbatim (terminal - see
// TERMINAL_TOOLS in agent.js). get_food_orders requires an addressId, so this
// uses the session's address, or the first saved one without asking - it's a
// lookup, not the start of an order, and never saves that address to the
// session.
export async function viewOrders({ senderId, swiggyFoodClient, pendingCartSessions, lang = "en" }) {
  let addressId = pendingCartSessions?.peek(senderId)?.addressId;

  if (!addressId) {
    const addresses = parseStructuredPayload(await swiggyFoodClient.getAddresses({}))?.addresses;
    if (!Array.isArray(addresses)) {
      return GENERIC_FALLBACK_REPLY;
    }
    if (addresses.length === 0) {
      return NO_SAVED_ADDRESS_REPLY;
    }
    addressId = addresses[0]?.id;
    if (!addressId) {
      return GENERIC_FALLBACK_REPLY;
    }
  }

  const orders = parseStructuredPayload(await swiggyFoodClient.getFoodOrders({ addressId }))?.orders;

  if (!Array.isArray(orders)) {
    return GENERIC_FALLBACK_REPLY;
  }

  const shown = orders.filter((order) => order?.restaurantName).slice(0, MAX_ORDERS_SHOWN);

  if (shown.length === 0) {
    return pick(lang, {
      en: "You don't have any Swiggy food orders yet.",
      hi: "आपका अभी तक कोई Swiggy फ़ूड ऑर्डर नहीं है।",
      hinglish: "Aapka abhi tak koi Swiggy food order nahi hai.",
    });
  }

  const activeLabel = pick(lang, { en: "In progress", hi: "जारी है", hinglish: "Chal raha hai" });
  const lines = shown.map((order, index) => {
    const status = order.isActiveOrder === true ? activeLabel : (order.orderDeliveryStatus ?? order.orderStatus);
    const details = [order.orderTotal ? `₹${order.orderTotal}` : undefined, order.orderedTime, status].filter(Boolean);
    const items = order.orderedItems ? `\n   ${order.orderedItems}` : "";
    return `${index + 1}. ${order.restaurantName} — ${details.join(", ")}${items}`;
  });

  const header = pick(lang, {
    en: "Your recent Swiggy orders:",
    hi: "आपके हाल के Swiggy ऑर्डर:",
    hinglish: "Aapke recent Swiggy orders:",
  });

  return [header, ...lines].join("\n");
}

// `meta`: see handleRemoveFromCart's own comment above.
export async function removeFromCart({ senderId, query, quantity, swiggyFoodClient, pendingCartSessions, meta }) {
  const session = pendingCartSessions.peek(senderId);

  if (!session) {
    if (meta) {
      meta.hasData = false;
    }
    return noActiveOrderReply();
  }

  return handleRemoveFromCart({
    swiggyFoodClient,
    addressId: session.addressId,
    restaurantId: session.restaurantId,
    restaurantName: session.restaurantName,
    query,
    quantity,
    meta,
  });
}

// TERMINAL_TOOLS tool - see viewCart's comment above.
//
// By default offers the one best coupon and asks before applying it; the
// offered code is kept on the session (offeredCouponCode) so a plain "yes"
// applies it in code - see takeOfferedCoupon and buildReplyText in server.js.
// showAll lists every coupon instead.
export async function findCoupons({ senderId, swiggyFoodClient, pendingCartSessions, showAll = false, lang = "en" }) {
  const session = pendingCartSessions.peek(senderId);

  if (!session) {
    return noActiveOrderReply(lang);
  }

  // "Best coupon for this order" makes no sense with nothing in the cart
  // (seen live after "remove everything"). The session can outlive the
  // cart's contents, so check the real cart.
  let cartItems;
  try {
    cartItems = unwrapCartPayload(await swiggyFoodClient.getFoodCart({ addressId: session.addressId }))?.items;
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return emptyCartReply(lang);
  }

  const { text, offeredCouponCode, listedCoupons } = await handleFindCoupons({
    swiggyFoodClient,
    restaurantId: session.restaurantId,
    addressId: session.addressId,
    showAll,
    lang,
  });

  if (offeredCouponCode) {
    pendingCartSessions.set(senderId, { ...pendingCartSessions.peek(senderId), offeredCouponCode });
  } else if (listedCoupons?.length > 0) {
    // Lets the full list be shown as tappable rows (interactive-replies.js).
    pendingCartSessions.set(senderId, { ...pendingCartSessions.peek(senderId), listedCoupons });
  }

  return text;
}

// Returns the coupon code Nosh last offered this sender, if any, and forgets
// it - an offer only covers the very next message.
export function takeOfferedCoupon({ senderId, pendingCartSessions }) {
  const session = pendingCartSessions.peek(senderId);

  if (!session?.offeredCouponCode) {
    return undefined;
  }

  const { offeredCouponCode, ...rest } = session;
  pendingCartSessions.set(senderId, rest);
  return offeredCouponCode;
}

// TERMINAL_TOOLS tool - see viewCart's comment above.
export async function applyCoupon({ senderId, couponCode, swiggyFoodClient, pendingCartSessions, lang = "en" }) {
  const session = pendingCartSessions.peek(senderId);

  if (!session) {
    return noActiveOrderReply(lang);
  }

  return handleApplyCoupon({ swiggyFoodClient, couponCode, addressId: session.addressId, lang });
}

// TERMINAL_TOOLS tool - see viewCart's comment above.
export async function checkout({ senderId, swiggyFoodClient, pendingCartSessions, pendingOrderConfirmations, lang = "en" }) {
  const session = pendingCartSessions.peek(senderId);

  // Same stale-cart concern addResolvedItemToCart guards against on
  // add-to-cart: if nothing in THIS session has actually put anything in
  // the live cart yet, get_food_cart could still return leftover items from
  // an earlier session/restaurant. The deterministic YES/NO confirmation
  // still shows the real cart contents before anything irreversible
  // happens, so this isn't a safety gap, but treating it as "no active
  // order" here is more honest than building an order summary around a
  // cart this session never actually built.
  if (!session?.cartRestaurantId) {
    return noActiveOrderReply(lang);
  }

  return handleCheckout({
    senderId,
    swiggyFoodClient,
    addressId: session.addressId,
    restaurantName: session.restaurantName,
    pendingOrderConfirmations,
    lang,
  });
}
