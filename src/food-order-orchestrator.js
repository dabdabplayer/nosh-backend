import { classifyOrderIntent as defaultClassifyOrderIntent } from "./nlu-client.js";
import { NO_SAVED_ADDRESS_REPLY, parseAddressSelectionReply } from "./food-search-orchestrator.js";
import { parseStructuredPayload } from "./swiggy-food-client.js";

const MAX_COUPONS = 5;
const MIN_USUAL_ORDER_COUNT = 2;
const MAX_ITEM_RESULTS = 5;

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
const EMPTY_CART_REPLY = "Your cart is empty — search for something and ask me to add it first.";

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
function formatPricingBreakdown(pricing, offers, { totalLabel = "Total" } = {}) {
  if (!pricing) {
    return [];
  }

  const lines = [];

  if (typeof pricing.item_total === "number") {
    lines.push(`Item total: ₹${pricing.item_total}`);
  }

  if (typeof pricing.delivery_charge === "number") {
    lines.push(`Delivery charge: ₹${pricing.delivery_charge}`);
  }

  // Swiggy's own field name (taxes_and_charges, not just "taxes") already
  // says this is a bundle - get_food_cart/update_food_cart's documented
  // FoodCartPricing doesn't break it into GST vs. a platform/convenience
  // fee vs. anything else, and there's no live Swiggy account available to
  // inspect a real response for undocumented sub-fields. Label it as the
  // bundle it is rather than inventing a split Swiggy doesn't provide.
  if (typeof pricing.taxes_and_charges === "number") {
    lines.push(`Taxes & other charges: ₹${pricing.taxes_and_charges}`);
  }

  // coupon_discount can be present but 0 when Swiggy auto-suggests a coupon
  // without actually applying it (see handleApplyCoupon below) - only show
  // a discount line once it's genuinely applied.
  const couponDiscount = offers?.coupon_discount;
  if (typeof couponDiscount === "number" && couponDiscount > 0) {
    lines.push(`Coupon discount: −₹${couponDiscount}`);
  }

  if (typeof pricing.to_pay === "number") {
    lines.push(`${totalLabel}: ₹${pricing.to_pay}`);
  }

  return lines;
}

function formatCartReply(cartData) {
  if (!cartData || !Array.isArray(cartData.items) || cartData.items.length === 0) {
    return EMPTY_CART_REPLY;
  }

  const lines = cartData.items.map((item) => {
    const variantNames = Array.isArray(item.variants)
      ? item.variants.map((variant) => variant.name).filter(Boolean)
      : [];
    const suffix = variantNames.length > 0 ? ` (${variantNames.join(", ")})` : "";
    return `${item.quantity}x ${item.name}${suffix} — ₹${item.total}`;
  });

  return [
    `Your cart (${cartData.restaurant?.name ?? "restaurant"}):`,
    ...lines,
    ...formatPricingBreakdown(cartData.pricing, cartData.offers),
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

// The single entry point for the "reorder my usual" intent (see
// src/nlu-client.js's reorder_usual tool and
// src/food-search-orchestrator.js's classifyIncomingMessage). Calls
// get_food_orders live every time - no caching - per this feature's design.
//
// Requires >=2 non-active orders at the SAME restaurant to call it a
// "usual" (a single past order isn't a pattern); otherwise returns
// NO_USUAL_REPLY so the caller's normal message handling applies, same as
// any other unmatched message - this deliberately does not guess at a
// search term or invent a recommendation (out of scope per this feature's
// spec: no ranking/scoring, no unsolicited suggestions).
//
// On a match: fetches that order's structured items via
// get_food_order_details, clears the cart, rebuilds it item-for-item, and
// hands off into the EXACT SAME pendingCartSessions/formatCartReply path
// handleAddToCart uses - so the normal view-cart/checkout/YES-NO-confirm
// flow (getFoodOrderReply, placeConfirmedOrder) picks it up unmodified.
// Always shows the freshly-rebuilt cart's live total, never the old order's
// orderTotal - Swiggy pricing/availability can differ since the order was
// placed, and AGENTS.md forbids showing stale/fabricated pricing.
export async function buildReorderUsualReply({ senderId, swiggyFoodClient, pendingCartSessions }) {
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
  // response has no "default address" field to prefer instead.)
  const addressId = addresses[0]?.id;

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

  return [`Reordering your usual from ${order.restaurant_name}:`, formatCartReply(cartData)].join("\n\n");
}

const NO_ORDER_HISTORY_REPLY =
  "You don't have any past orders yet for me to base a recommendation on — search for a restaurant or dish instead.";

// The single entry point for the "recommend me something" intent (see
// src/nlu-client.js's recommend tool and food-search-orchestrator.js's
// classifyIncomingMessage). Swiggy's Food MCP has no documented
// recommendation, bestseller-ranking, or personalization tool (AGENTS.md:
// never invent one), so this is built entirely from get_food_orders' own
// documented fields (restaurantName, orderedItems) rather than fabricating
// a suggestion - it recommends a RESTAURANT the user has actually ordered
// from before, not a specific dish they've never tried. Text-only: unlike
// buildReorderUsualReply, this never touches the cart.
export async function buildRecommendationReply({ swiggyFoodClient }) {
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

  // Same one-message-shortcut simplification as buildReorderUsualReply
  // above - doesn't prompt to disambiguate multiple saved addresses.
  const addressId = addresses[0]?.id;

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

  // Unlike findUsualOrder above, there's no >=2 threshold here - even a
  // single past order is enough to recommend going back, since this isn't
  // claiming a "usual", just a suggestion. Active (in-progress) orders are
  // excluded - recommending a restaurant the user is already mid-delivery
  // with reads as broken, not helpful.
  const pastOrders = orders.filter((order) => order?.restaurantId && order.isActiveOrder !== true);

  if (pastOrders.length === 0) {
    return NO_ORDER_HISTORY_REPLY;
  }

  // get_food_orders' own doc says results come back newest-first, so the
  // first order seen for a given restaurant while scanning in that order is
  // also the most recently ordered-from one there - used below to break a
  // count tie toward whichever restaurant they ordered from most recently,
  // with no timestamp parsing needed (orderedTime is a year-less,
  // human-readable string elsewhere in this file - see
  // findOrderPlacedSinceSnapshot - and can't be used for that directly).
  const countsByRestaurant = new Map();
  const firstOrderByRestaurant = new Map();

  for (const order of pastOrders) {
    countsByRestaurant.set(order.restaurantId, (countsByRestaurant.get(order.restaurantId) ?? 0) + 1);
    if (!firstOrderByRestaurant.has(order.restaurantId)) {
      firstOrderByRestaurant.set(order.restaurantId, order);
    }
  }

  // Array.prototype.sort is stable, so restaurants tied on count keep their
  // Map insertion order (i.e. most-recently-ordered-from first) rather than
  // an arbitrary one.
  const [topRestaurantId, timesOrdered] = [...countsByRestaurant.entries()].sort((a, b) => b[1] - a[1])[0];
  const topOrder = firstOrderByRestaurant.get(topRestaurantId);
  const timesPhrase = timesOrdered === 1 ? "before" : `${timesOrdered} times before`;
  const lastOrderPhrase = topOrder.orderedItems ? ` Last time you got: ${topOrder.orderedItems}.` : "";

  // Only point to "reorder my usual" once this restaurant would actually
  // qualify as one - findUsualOrder/buildReorderUsualReply require
  // MIN_USUAL_ORDER_COUNT non-active orders at the same restaurant, but
  // this function deliberately has no such threshold (a single past order
  // is still worth recommending). Suggesting the reorder shortcut below
  // that threshold would have the bot immediately contradict itself with
  // NO_USUAL_REPLY on the very next message.
  const reorderSuggestion =
    timesOrdered >= MIN_USUAL_ORDER_COUNT ? ` or say "reorder my usual" to get that again` : "";

  return (
    `You've ordered from ${topOrder.restaurantName} ${timesPhrase}.${lastOrderPhrase} ` +
    `Want to see their menu for something new${reorderSuggestion}?`
  );
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
  const menuItem = Array.isArray(scopedItems)
    ? scopedItems.find((item) => item?.inStock !== 0)
    : undefined;

  return menuItem ? { menuItem, restaurantId: scopedRestaurantId, restaurantName: scopedRestaurantName } : undefined;
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
    "Reply with the number, or tell me what else you'd like.",
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
// numbered-list branch in getFoodOrderReply). Observed in manual testing
// against the mock server (not confirmed against real Swiggy) without this
// check: picking a different restaurant than whatever was already in the
// cart (a prior abandoned session, a restaurant switch, items added
// outside Nosh entirely) silently merged the new item onto the old cart's
// leftover items AND its already-applied coupon, instead of starting
// clean. Flushing whenever the two don't match - including the very first
// add of a fresh session, when knownCartRestaurantId is simply unset -
// means a new order never inherits stale contents it didn't ask for.
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
}) {
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

  return [`Added ${menuItem.name} to your cart.`, formatCartReply(cartData)].join("\n\n");
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
}) {
  let targetRestaurantId = existingRestaurantId;
  let targetRestaurantName = existingRestaurantName;

  // A restaurant the user explicitly named takes priority over whatever
  // dish search would otherwise turn up - never silently substitute a
  // different restaurant than the one they asked for.
  if (!targetRestaurantId && restaurantNameHint) {
    const restaurant = await resolveRestaurant({ swiggyFoodClient, restaurantName: restaurantNameHint, addressId });

    if (!restaurant) {
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
  });
}

async function handleViewCart({ swiggyFoodClient, addressId, restaurantName }) {
  let cartResult;
  try {
    cartResult = await swiggyFoodClient.getFoodCart({ addressId, restaurantName });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  return formatCartReply(unwrapCartPayload(cartResult));
}

function formatCoupons(couponsPayload) {
  const sections = Array.isArray(couponsPayload?.coupon_sections) ? couponsPayload.coupon_sections : [];
  const coupons = sections.flatMap((section) => (Array.isArray(section?.coupons) ? section.coupons : []));

  if (coupons.length === 0) {
    return "No coupons available for this order right now.";
  }

  // coupons[].title IS the redeemable code (confirmed live) - there's no
  // separate "code" field.
  const lines = coupons
    .slice(0, MAX_COUPONS)
    .map((coupon) => `${coupon.title} — ${coupon.description ?? coupon.subtitle ?? ""}`.trim());

  return ["Available coupons:", ...lines, 'Reply "apply <code>" to use one, e.g. "apply SWIGGYIT".'].join("\n");
}

async function handleFindCoupons({ swiggyFoodClient, restaurantId, addressId }) {
  let result;
  try {
    result = await swiggyFoodClient.fetchFoodCoupons({ restaurantId, addressId });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  return formatCoupons(parseStructuredPayload(result));
}

async function handleApplyCoupon({ swiggyFoodClient, couponCode, addressId }) {
  let result;
  try {
    result = await swiggyFoodClient.applyFoodCoupon({ couponCode, addressId });
  } catch {
    return `Sorry, I couldn't apply "${couponCode}" — it may not be valid for this order right now.`;
  }

  const cartData = unwrapCartPayload(result);
  // update/apply responses can report a coupon as "suggested" with
  // coupon_discount: 0 even when not actually applied (documented in the
  // tool's own schema) - never claim savings unless the discount is > 0.
  const discount = cartData?.offers?.coupon_discount ?? 0;

  if (!cartData || discount <= 0) {
    return `"${couponCode}" isn't giving a discount on this order right now — you may need to add more items to qualify.`;
  }

  return [`Applied ${couponCode} — you saved ₹${discount}.`, formatCartReply(cartData)].join("\n\n");
}

function formatOrderSummary(cartData, paymentMethodLabel) {
  const lines = cartData.items.map((item) => `${item.quantity}x ${item.name} — ₹${item.total}`);

  return [
    `Order summary — ${cartData.restaurant?.name ?? "your order"}:`,
    ...lines,
    ...formatPricingBreakdown(cartData.pricing, cartData.offers, { totalLabel: "Total to pay" }),
    `Payment: ${paymentMethodLabel}`,
    "",
    "Reply YES to place this order, or NO to cancel.",
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
async function handleCheckout({ senderId, swiggyFoodClient, addressId, restaurantName, pendingOrderConfirmations }) {
  let cartResult;
  try {
    cartResult = await swiggyFoodClient.getFoodCart({ addressId, restaurantName });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const cartData = unwrapCartPayload(cartResult);

  if (!cartData || !Array.isArray(cartData.items) || cartData.items.length === 0) {
    return EMPTY_CART_REPLY;
  }

  let paymentResult;
  try {
    paymentResult = await swiggyFoodClient.getPaymentOptions({ addressId });
  } catch {
    return GENERIC_FALLBACK_REPLY;
  }

  const paymentOptions = parseStructuredPayload(paymentResult);

  if (!paymentOptions?.cod?.available) {
    return "Cash on Delivery isn't available for this order, and Nosh can't complete a UPI payment over WhatsApp yet — please finish this order in the Swiggy app.";
  }

  pendingOrderConfirmations.set(senderId, {
    addressId,
    cartId: cartData.cart_id,
    paymentMethod: "Cash",
  });

  return formatOrderSummary(cartData, paymentOptions.cod.displayName ?? "Cash on Delivery");
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
export async function placeConfirmedOrder({ swiggyFoodClient, confirmation }) {
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
    try {
      placeResult = await swiggyFoodClient.placeFoodOrder({
        addressId: confirmation.addressId,
        paymentMethod: confirmation.paymentMethod,
      });
    } catch {
      const newOrder = priorOrderIds
        ? await findOrderPlacedSinceSnapshot(swiggyFoodClient, confirmation.addressId, priorOrderIds)
        : undefined;

      if (!newOrder) {
        return { status: "failed", replyText: "Sorry, I couldn't place that order right now. Please try again in a bit." };
      }

      // It actually went through despite the error - fall through to
      // confirm_order below instead of telling the user it failed.
      orderId = newOrder.orderId;
    }

    if (!orderId) {
      const orderData = parseStructuredPayload(placeResult);

      if (!orderData?.orderId) {
        return { status: "failed", replyText: "Sorry, I couldn't place that order right now. Please try again in a bit." };
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
      replyText:
        "Your order was placed, but we couldn't confirm it just now — reply YES again and I'll retry confirming without placing a duplicate order.",
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

  return { status: "confirmed", replyText: "Your order has been placed! You'll get delivery updates from Swiggy." };
}

const NO_ACTIVE_ORDER_REPLY = "You don't have an order in progress yet — search for something first.";

// The single entry point server.js calls for cart/coupon/checkout intents,
// mirroring getFoodSearchReply's contract: never throws, returns undefined
// for messages that don't match any order intent so the caller falls back
// to its own placeholder/search handling.
//
// add_to_cart works even with no prior session - food-search-orchestrator.js
// records a lightweight {addressId} session as soon as a search resolves an
// address, and handleAddToCart's cross-restaurant lookup fills in the
// restaurant on the first add. The other intents need an actual restaurant
// context, so they report NO_ACTIVE_ORDER_REPLY instead of guessing one.
export async function getFoodOrderReply({
  message,
  swiggyFoodClient,
  pendingCartSessions,
  pendingOrderConfirmations,
  classifyOrderIntent = defaultClassifyOrderIntent,
  nvidiaNim,
}) {
  const session = pendingCartSessions.peek(message.from);

  // A bare number reply to the item list just shown (see the
  // restaurant-selection branch right below) picks straight off it - same
  // deterministic, no-NLU-needed pattern as every other numbered prompt in
  // this app (restaurant selection, address selection, order confirmation).
  if (session?.itemCandidates) {
    const selectedIndex = parseAddressSelectionReply(message.text, session.itemCandidates.length);

    if (selectedIndex !== undefined) {
      const menuItem = session.itemCandidates[selectedIndex];
      return addResolvedItemToCart({
        senderId: message.from,
        swiggyFoodClient,
        pendingCartSessions,
        addressId: session.addressId,
        restaurantId: session.restaurantId,
        restaurantName: session.restaurantName,
        menuItem,
        knownCartRestaurantId: session.cartRestaurantId,
      });
    }
  }

  // A bare number reply to the restaurant list just shown (see
  // runRestaurantSearch in food-search-orchestrator.js) is resolved
  // deterministically here, the same way parseOrderConfirmationReply gates
  // order placement - no NLU call needed, and it still works if NIM is
  // down. Falls through to classifyOrderIntent below for anything that
  // isn't a valid selection number (e.g. naming the restaurant instead).
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
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          itemCandidates: items,
        });
        return formatItemSelectionReply(session.searchTerm, restaurant.name, items);
      }

      pendingCartSessions.set(message.from, { addressId: session.addressId, restaurantId: restaurant.id, restaurantName: restaurant.name });
      return `Got it — what would you like from ${restaurant.name}?`;
    }
  }

  if (!nvidiaNim?.enabled) {
    return undefined;
  }

  const intent = await classifyOrderIntent({
    text: message.text.trim(),
    apiKey: nvidiaNim.apiKey,
    baseUrl: nvidiaNim.baseUrl,
    model: nvidiaNim.model,
    timeoutMs: nvidiaNim.timeoutMs,
  });

  if (!intent) {
    return undefined;
  }

  try {
    if (intent.type === "add_to_cart") {
      return await handleAddToCart({
        senderId: message.from,
        query: intent.query,
        quantity: intent.quantity,
        restaurantNameHint: intent.restaurantName,
        swiggyFoodClient,
        pendingCartSessions,
        addressId: session?.addressId,
        restaurantId: session?.restaurantId,
        restaurantName: session?.restaurantName,
        cartRestaurantId: session?.cartRestaurantId,
      });
    }

    if (!session) {
      return NO_ACTIVE_ORDER_REPLY;
    }

    switch (intent.type) {
      case "view_cart":
        return await handleViewCart({
          swiggyFoodClient,
          addressId: session.addressId,
          restaurantName: session.restaurantName,
        });

      case "find_coupons":
        return await handleFindCoupons({
          swiggyFoodClient,
          restaurantId: session.restaurantId,
          addressId: session.addressId,
        });

      case "apply_coupon":
        return await handleApplyCoupon({
          swiggyFoodClient,
          couponCode: intent.couponCode,
          addressId: session.addressId,
        });

      case "checkout":
        // Same stale-cart concern addResolvedItemToCart guards against on
        // add-to-cart: if nothing in THIS session has actually put anything
        // in the live cart yet, get_food_cart could still return leftover
        // items from an earlier session/restaurant. The deterministic
        // YES/NO confirmation still shows the real cart contents before
        // anything irreversible happens, so this isn't a safety gap, but
        // treating it as "no active order" here is more honest than
        // building an order summary around a cart this session never
        // actually built.
        if (!session.cartRestaurantId) {
          return NO_ACTIVE_ORDER_REPLY;
        }

        return await handleCheckout({
          senderId: message.from,
          swiggyFoodClient,
          addressId: session.addressId,
          restaurantName: session.restaurantName,
          pendingOrderConfirmations,
        });

      default:
        return undefined;
    }
  } catch (error) {
    console.error("Food order orchestration failed unexpectedly.", { name: error.name });
    return GENERIC_FALLBACK_REPLY;
  }
}
