import { classifyOrderIntent as defaultClassifyOrderIntent } from "./nlu-client.js";
import { parseStructuredPayload } from "./swiggy-food-client.js";

const MAX_COUPONS = 5;

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
function unwrapCartPayload(toolResult) {
  return parseStructuredPayload(toolResult)?.data;
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

  const toPay = cartData.pricing?.to_pay;
  const totalLine = typeof toPay === "number" ? `Total: ₹${toPay}` : undefined;

  return [`Your cart (${cartData.restaurant?.name ?? "restaurant"}):`, ...lines, totalLine]
    .filter(Boolean)
    .join("\n");
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

  let cartResult;
  try {
    cartResult = await swiggyFoodClient.updateFoodCart({
      restaurantId,
      restaurantName: resolvedRestaurantName,
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

  pendingCartSessions.set(senderId, { restaurantId, restaurantName: resolvedRestaurantName, addressId });

  return [`Added ${menuItem.name} to your cart.`, formatCartReply(cartData)].join("\n\n");
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
  const toPay = cartData.pricing?.to_pay;

  return [
    `Order summary — ${cartData.restaurant?.name ?? "your order"}:`,
    ...lines,
    typeof toPay === "number" ? `Total to pay: ₹${toPay}` : undefined,
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

// Only called after server.js's deterministic YES check on a pending
// confirmation - never from NLU classification.
//
// Non-idempotent retry safety (AGENTS.md: never blindly retry a
// non-idempotent commerce operation, check whether it already succeeded
// first): Swiggy's tools don't expose a way to correlate a cart to a past
// order, so this tracks success locally instead - once place_food_order
// returns an orderId, it's saved onto the pending confirmation itself
// (see server.js) and a retried YES skips straight to confirm_order rather
// than placing a second order. This protects against a retry within the
// same pending-confirmation lifecycle; it doesn't survive a process
// restart, consistent with every other Pending* store's documented
// in-memory-only limitation.
export async function placeConfirmedOrder({ swiggyFoodClient, confirmation }) {
  let orderId = confirmation.orderId;
  let lat = confirmation.lat;
  let lng = confirmation.lng;

  if (!orderId) {
    let placeResult;
    try {
      placeResult = await swiggyFoodClient.placeFoodOrder({
        addressId: confirmation.addressId,
        paymentMethod: confirmation.paymentMethod,
      });
    } catch {
      return { status: "failed", replyText: "Sorry, I couldn't place that order right now. Please try again in a bit." };
    }

    const orderData = parseStructuredPayload(placeResult);

    if (!orderData?.orderId) {
      return { status: "failed", replyText: "Sorry, I couldn't place that order right now. Please try again in a bit." };
    }

    orderId = orderData.orderId;
    lat = orderData.lat;
    lng = orderData.lng;
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
  if (!nvidiaNim?.enabled) {
    return undefined;
  }

  const intent = await classifyOrderIntent({
    text: message.text.trim(),
    apiKey: nvidiaNim.apiKey,
    baseUrl: nvidiaNim.baseUrl,
    model: nvidiaNim.model,
  });

  if (!intent) {
    return undefined;
  }

  const session = pendingCartSessions.peek(message.from);

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
