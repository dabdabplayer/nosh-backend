// Buttons and lists on Nosh's replies, and what a tap on one means.
//
// Two halves:
//  - replyOptionsFor: after a reply is built, decides which buttons or list
//    (if any) go with it, by looking at what the turn just created - a new
//    address question, a new order summary, a coupon offer, a numbered list
//    of restaurants or dishes, or a recommendation.
//  - resolveTap: turns a tapped option's id back into an action, checking it
//    against the CURRENT state. WhatsApp lets people tap buttons on old
//    messages, so an id is never trusted on its own.
//
// Typing still works everywhere: the reply text is the full prompt, and the
// buttons are only a shortcut.
//
// Placing an order by tapping takes two taps - "Place order" on the summary,
// then "Yes, place it" on a second message that repeats the restaurant and
// total - so one accidental tap can't place an order. Both buttons carry the
// order summary's own random nonce, so a button from an older summary can
// never place a newer cart. Typing YES stays a single, deliberate step.
import { randomBytes } from "node:crypto";
import { pick } from "./language-preference.js";

const ADDRESS_PREFIX = "addr:";
const RESTAURANT_PREFIX = "rest:";
const ITEM_PREFIX = "item:";
const ORDER_PLACE_PREFIX = "order:place:";
const ORDER_CONFIRM_PREFIX = "order:confirm:";
const ORDER_CANCEL_PREFIX = "order:cancel:";
const COUPON_APPLY_PREFIX = "coupon:apply:";
const COUPON_ALL = "coupon:all";
const RECOMMEND_ADD = "rec:add";
const RECOMMEND_OTHER = "rec:other";

const MAX_BUTTONS = 3;

export function newConfirmationNonce() {
  return randomBytes(9).toString("base64url");
}

function itemKey(item, index) {
  return String(item?.menu_item_id ?? item?.id ?? `#${index}`);
}

// The parts of a sender's state that can carry a prompt. Compared by object
// identity before and after a turn: every store freezes a NEW object on each
// set(), so "changed" means "created this turn". Needed because an address
// question can stay open across turns (see resolvePendingAddressReply) - a
// prompt merely existing doesn't mean this reply is that prompt.
export function snapshotPromptState({ senderId, pendingAddressSelections, pendingOrderConfirmations, pendingCartSessions }) {
  const session = pendingCartSessions.peek(senderId);
  return {
    session,
    addressPrompt: pendingAddressSelections.peek(senderId),
    confirmation: pendingOrderConfirmations.peek(senderId),
    offeredCouponCode: session?.offeredCouponCode,
    restaurantCandidates: session?.restaurantCandidates,
    itemCandidates: session?.itemCandidates,
  };
}

function orderButtons(nonce, lang) {
  return {
    buttons: [
      {
        id: `${ORDER_PLACE_PREFIX}${nonce}`,
        title: pick(lang, { en: "Place order", hi: "ऑर्डर करें", hinglish: "Order place karein" }),
      },
      { id: `${ORDER_CANCEL_PREFIX}${nonce}`, title: pick(lang, { en: "Cancel", hi: "रद्द करें", hinglish: "Cancel" }) },
    ],
  };
}

function confirmButtons(nonce, lang) {
  return {
    buttons: [
      {
        id: `${ORDER_CONFIRM_PREFIX}${nonce}`,
        title: pick(lang, { en: "Yes, place it", hi: "हाँ, ऑर्डर करें", hinglish: "Haan, place karein" }),
      },
      { id: `${ORDER_CANCEL_PREFIX}${nonce}`, title: pick(lang, { en: "Cancel", hi: "रद्द करें", hinglish: "Cancel" }) },
    ],
  };
}

// The second-step message after "Place order" is tapped: repeats what is
// about to be ordered. Deliberately has no uppercase YES/NO wording.
export function formatPlaceOrderCheck(confirmation, lang = "en") {
  const restaurant = confirmation?.summary?.restaurantName;
  const toPay = confirmation?.summary?.toPay;
  const amount = typeof toPay === "number" ? `₹${toPay}` : undefined;

  return pick(lang, {
    en: `Place this order${restaurant ? ` from ${restaurant}` : ""}${amount ? ` for ${amount}` : ""}? It can't be undone once placed.`,
    hi: `${restaurant ? `${restaurant} से ` : ""}${amount ? `${amount} का ` : ""}यह ऑर्डर दे दूँ? ऑर्डर देने के बाद इसे वापस नहीं लिया जा सकता।`,
    hinglish: `${restaurant ? `${restaurant} se ` : ""}${amount ? `${amount} ka ` : ""}yeh order place kar doon? Place hone ke baad ise wapas nahi liya ja sakta.`,
  });
}

// Which buttons or list go with the reply just built. `before` and `after`
// are snapshotPromptState results; `recommended` is true when the agent just
// presented a recommendation. Returns undefined for a plain text reply.
export function replyOptionsFor({ before, after, lang = "en", recommended = false }) {
  const confirmation = after.confirmation;
  if (confirmation && confirmation !== before.confirmation && confirmation.nonce) {
    return confirmation.armed ? confirmButtons(confirmation.nonce, lang) : orderButtons(confirmation.nonce, lang);
  }

  const addressPrompt = after.addressPrompt;
  if (addressPrompt && addressPrompt !== before.addressPrompt && addressPrompt.kind !== "agent") {
    const candidates = addressPrompt.candidates ?? [];
    if (candidates.length > 0 && candidates.length <= MAX_BUTTONS) {
      return {
        buttons: candidates.map((candidate) => ({
          id: `${ADDRESS_PREFIX}${candidate.id}`,
          title: candidate.tag ?? candidate.label,
        })),
      };
    }
    return {
      list: {
        button: pick(lang, { en: "Choose address", hi: "पता चुनें", hinglish: "Address chunein" }),
        rows: candidates.map((candidate) => ({
          id: `${ADDRESS_PREFIX}${candidate.id}`,
          title: candidate.tag ?? candidate.label,
          description: candidate.label,
        })),
      },
    };
  }

  // The session object changes whenever it is written; an offer left over
  // from an earlier turn (same object) gets no buttons.
  if (after.offeredCouponCode && after.session !== before.session) {
    return {
      buttons: [
        {
          id: `${COUPON_APPLY_PREFIX}${after.offeredCouponCode}`,
          title: pick(lang, { en: "Apply", hi: "लगाएँ", hinglish: "Apply karein" }),
        },
        { id: COUPON_ALL, title: pick(lang, { en: "See all coupons", hi: "सभी कूपन देखें", hinglish: "Saare coupons" }) },
      ],
    };
  }

  const chooseLabel = pick(lang, { en: "Choose", hi: "चुनें", hinglish: "Chunein" });

  if (Array.isArray(after.itemCandidates) && after.itemCandidates !== before.itemCandidates && after.itemCandidates.length > 0) {
    return {
      list: {
        button: chooseLabel,
        rows: after.itemCandidates.map((item, index) => ({
          id: `${ITEM_PREFIX}${itemKey(item, index)}`,
          title: item.name,
          ...(typeof item.price === "number" ? { description: `₹${item.price}` } : {}),
        })),
      },
    };
  }

  if (
    Array.isArray(after.restaurantCandidates) &&
    after.restaurantCandidates !== before.restaurantCandidates &&
    after.restaurantCandidates.length > 0
  ) {
    return {
      list: {
        button: chooseLabel,
        rows: after.restaurantCandidates.map((restaurant) => ({
          id: `${RESTAURANT_PREFIX}${restaurant.id}`,
          title: restaurant.name,
        })),
      },
    };
  }

  if (recommended) {
    return {
      buttons: [
        { id: RECOMMEND_ADD, title: pick(lang, { en: "Add it", hi: "जोड़ें", hinglish: "Add kar do" }) },
        { id: RECOMMEND_OTHER, title: pick(lang, { en: "Something else", hi: "कुछ और", hinglish: "Kuch aur" }) },
      ],
    };
  }

  return undefined;
}

export function expiredOptionReply(lang = "en") {
  return pick(lang, {
    en: "That option is no longer available. Tell me what you'd like and I'll pick it up from there.",
    hi: "यह विकल्प अब उपलब्ध नहीं है। बताइए आपको क्या चाहिए, मैं वहीं से आगे बढ़ता हूँ।",
    hinglish: "Yeh option ab available nahi hai. Bataiye aapko kya chahiye, main wahin se aage badhta hoon.",
  });
}

// Turns a tapped option's id into what to do, checked against current state.
// Returns one of:
//   { kind: "expired" }                       the button no longer applies
//   { kind: "order-check", confirmation }     first tap: ask "place this order?"
//   { kind: "order-place", confirmation }     second tap: place it
//   { kind: "order-cancel" }                  cancel the pending order
//   { kind: "coupon-apply", couponCode }      apply the coupon just offered
//   { kind: "text", text, forAgent }          continue as if the user had typed `text`
// Never returns "order-place" unless the id's nonce matches the pending
// order summary AND "Place order" was tapped on that same summary first.
export function resolveTap({ replyId, senderId, pendingAddressSelections, pendingOrderConfirmations, pendingCartSessions }) {
  const id = String(replyId ?? "");
  const confirmation = pendingOrderConfirmations.peek(senderId);
  const nonceMatches = (prefix) =>
    Boolean(confirmation?.nonce) && id.startsWith(prefix) && id.slice(prefix.length) === confirmation.nonce;

  if (id.startsWith("order:")) {
    if (nonceMatches(ORDER_PLACE_PREFIX)) {
      const armed = { ...confirmation, armed: true };
      pendingOrderConfirmations.set(senderId, armed);
      return { kind: "order-check", confirmation: pendingOrderConfirmations.peek(senderId) };
    }
    if (nonceMatches(ORDER_CONFIRM_PREFIX)) {
      return confirmation.armed ? { kind: "order-place", confirmation } : { kind: "expired" };
    }
    if (nonceMatches(ORDER_CANCEL_PREFIX)) {
      return { kind: "order-cancel" };
    }
    return { kind: "expired" };
  }

  if (id.startsWith(ADDRESS_PREFIX)) {
    const candidates = pendingAddressSelections.peek(senderId)?.candidates ?? [];
    const index = candidates.findIndex((candidate) => candidate.id === id.slice(ADDRESS_PREFIX.length));
    return index === -1 ? { kind: "expired" } : { kind: "text", text: String(index + 1), forAgent: false };
  }

  const session = pendingCartSessions.peek(senderId);

  if (id.startsWith(COUPON_APPLY_PREFIX)) {
    const couponCode = id.slice(COUPON_APPLY_PREFIX.length);
    return session?.offeredCouponCode && session.offeredCouponCode === couponCode
      ? { kind: "coupon-apply", couponCode }
      : { kind: "expired" };
  }

  if (id.startsWith(ITEM_PREFIX)) {
    const candidates = session?.itemCandidates ?? [];
    const index = candidates.findIndex((item, position) => itemKey(item, position) === id.slice(ITEM_PREFIX.length));
    return index === -1 ? { kind: "expired" } : { kind: "text", text: String(index + 1), forAgent: false };
  }

  if (id.startsWith(RESTAURANT_PREFIX)) {
    const candidates = session?.restaurantCandidates ?? [];
    const index = candidates.findIndex((restaurant) => restaurant.id === id.slice(RESTAURANT_PREFIX.length));
    return index === -1 ? { kind: "expired" } : { kind: "text", text: String(index + 1), forAgent: false };
  }

  // Quick replies: the agent picked the dish, so code can't act on these
  // itself - they continue the conversation as a typed message would.
  if (id === RECOMMEND_ADD) {
    return { kind: "text", text: "Yes, add it to my cart.", forAgent: true };
  }
  if (id === RECOMMEND_OTHER) {
    return { kind: "text", text: "Recommend something else.", forAgent: true };
  }
  if (id === COUPON_ALL) {
    return { kind: "text", text: "Show me all the coupons.", forAgent: true };
  }

  return { kind: "expired" };
}

// Guards the moment between "the user confirmed" and "Swiggy answered": two
// quick taps (or two YES messages) arrive as two separate webhooks, and
// without this both would place an order. Returns the confirmation to place,
// or undefined when one is already being placed.
export function beginPlacingOrder({ senderId, pendingOrderConfirmations }) {
  const confirmation = pendingOrderConfirmations.peek(senderId);

  if (!confirmation || confirmation.placing) {
    return undefined;
  }

  pendingOrderConfirmations.set(senderId, { ...confirmation, placing: true });
  return confirmation;
}

// Undoes beginPlacingOrder when placing threw before any outcome was
// recorded, so the user can try again.
export function stopPlacingOrder({ senderId, pendingOrderConfirmations, confirmation }) {
  if (pendingOrderConfirmations.peek(senderId)?.placing) {
    pendingOrderConfirmations.set(senderId, confirmation);
  }
}
