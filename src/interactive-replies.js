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
const MENU_PREFIX = "menu:";
const CART_CHECKOUT = "cart:checkout";
const CART_VIEW = "cart:view";
const CART_COUPONS = "cart:coupons";
const MAX_LIST_ROWS = 10;
const RECOMMEND_ADD = "rec:add";
const RECOMMEND_OTHER = "rec:other";

const HOME_RECOMMEND = "home:recommend";
const HOME_CUISINES = "home:cuisines";
const HOME_MORE = "home:more";
const CUISINE_PREFIX = "cuisine:";
const MORE_PREFIX = "more:";

// Shown by "Browse cuisines". Plain search terms, in the order people most
// often ask for them; tapping one runs a normal search for it.
const CUISINES = Object.freeze([
  "Biryani",
  "Pizza",
  "Burgers",
  "Chinese",
  "South Indian",
  "North Indian",
  "Italian",
  "Mexican",
  "Japanese",
  "Desserts",
]);

// What each "More options" row says on the user's behalf.
const MORE_ACTIONS = Object.freeze({
  veg: "Recommend me something vegetarian.",
  usual: "Reorder my usual.",
  cart: "Show my cart.",
  orders: "Show my recent orders.",
  address: "Change my delivery address.",
});

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
    listedCoupons: session?.listedCoupons,
    menuItems: session?.menuItems,
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

// The order buttons for a waiting summary, e.g. to repeat them under the
// "please reply YES or NO" reminder.
export function orderOptionsFor(confirmation, lang = "en") {
  if (!confirmation?.nonce) {
    return undefined;
  }
  return confirmation.armed ? confirmButtons(confirmation.nonce, lang) : orderButtons(confirmation.nonce, lang);
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
// presented a recommendation; `cartShown` when the reply is about the cart
// (an item added, the cart shown, a coupon applied). Returns undefined for a
// plain text reply.
export function replyOptionsFor({ before, after, lang = "en", recommended = false, cartShown = false }) {
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

  // The full coupon list: each row applies that coupon.
  if (Array.isArray(after.listedCoupons) && after.listedCoupons !== before.listedCoupons && after.listedCoupons.length > 0) {
    return {
      list: {
        button: pick(lang, { en: "Apply a coupon", hi: "कूपन लगाएँ", hinglish: "Coupon lagayein" }),
        rows: after.listedCoupons.map((coupon) => ({
          id: `${COUPON_APPLY_PREFIX}${coupon.code}`,
          title: coupon.code,
          ...(coupon.description ? { description: coupon.description } : {}),
        })),
      },
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

  // A restaurant's menu: each row adds that dish. WhatsApp lists hold ten
  // rows; a longer menu shows the first ten and the rest are asked for by name.
  if (Array.isArray(after.menuItems) && after.menuItems !== before.menuItems && after.menuItems.length > 0) {
    return {
      list: {
        button: pick(lang, { en: "Add a dish", hi: "डिश जोड़ें", hinglish: "Dish add karein" }),
        rows: after.menuItems.slice(0, MAX_LIST_ROWS).map((item, index) => ({
          id: `${MENU_PREFIX}${item.id ?? `#${index}`}`,
          title: item.name,
          ...(typeof item.price === "number" ? { description: `₹${item.price}` } : {}),
        })),
      },
    };
  }

  // After the cart changes or is shown: the usual next steps.
  if (cartShown && after.session?.cartRestaurantId) {
    return {
      buttons: [
        { id: CART_CHECKOUT, title: pick(lang, { en: "Checkout", hi: "चेकआउट", hinglish: "Checkout" }) },
        { id: CART_VIEW, title: pick(lang, { en: "View cart", hi: "कार्ट देखें", hinglish: "Cart dekhein" }) },
        { id: CART_COUPONS, title: pick(lang, { en: "Coupons", hi: "कूपन", hinglish: "Coupons" }) },
      ],
    };
  }

  if (recommended) {
    return {
      buttons: [
        { id: RECOMMEND_ADD, title: pick(lang, { en: "Add it", hi: "जोड़ें", hinglish: "Add kar do" }) },
        { id: RECOMMEND_OTHER, title: pick(lang, { en: "Something else", hi: "कुछ और", hinglish: "Kuch aur" }) },
        { id: HOME_CUISINES, title: pick(lang, { en: "Browse cuisines", hi: "खाना चुनें", hinglish: "Cuisine chuno" }) },
      ],
    };
  }

  return undefined;
}

// The main menu: goes with any reply that has no buttons of its own, so
// there is always something to tap. Tapping is the main way to use Nosh;
// typing is for changes and extra detail.
export function homeOptions(lang = "en") {
  return {
    buttons: [
      { id: HOME_RECOMMEND, title: pick(lang, { en: "Recommend for me", hi: "मेरे लिए चुनें", hinglish: "Mere liye chuno" }) },
      { id: HOME_CUISINES, title: pick(lang, { en: "Browse cuisines", hi: "खाना चुनें", hinglish: "Cuisine chuno" }) },
      { id: HOME_MORE, title: pick(lang, { en: "More options", hi: "और विकल्प", hinglish: "Aur options" }) },
    ],
  };
}

// The reply to "Browse cuisines": a list of cuisines to tap.
export function cuisinesReply(lang = "en") {
  return {
    text: pick(lang, {
      en: "What are you in the mood for? Pick one, or type any dish or restaurant.",
      hi: "आज क्या खाने का मन है? एक चुनें, या कोई भी डिश या रेस्टोरेंट लिखें।",
      hinglish: "Aaj kya khane ka mann hai? Ek chuno, ya koi bhi dish ya restaurant likho.",
    }),
    options: {
      list: {
        button: pick(lang, { en: "Choose a cuisine", hi: "खाना चुनें", hinglish: "Cuisine chuno" }),
        rows: CUISINES.map((cuisine) => ({ id: `${CUISINE_PREFIX}${cuisine}`, title: cuisine })),
      },
    },
  };
}

// The reply to "More options": everything else Nosh can do.
export function moreOptionsReply(lang = "en") {
  const titles = {
    veg: pick(lang, { en: "Recommend veg food", hi: "शाकाहारी सुझाव", hinglish: "Veg recommend karo" }),
    usual: pick(lang, { en: "Reorder my usual", hi: "पिछला ऑर्डर दोबारा", hinglish: "Usual reorder karo" }),
    cart: pick(lang, { en: "View cart", hi: "कार्ट देखें", hinglish: "Cart dekhein" }),
    orders: pick(lang, { en: "My orders", hi: "मेरे ऑर्डर", hinglish: "Mere orders" }),
    address: pick(lang, { en: "Change address", hi: "पता बदलें", hinglish: "Address badlein" }),
  };
  return {
    text: pick(lang, {
      en: "Here's what else I can do. Pick one, or just tell me what you need.",
      hi: "मैं यह सब भी कर सकता हूँ। एक चुनें, या बताइए आपको क्या चाहिए।",
      hinglish: "Main yeh sab bhi kar sakta hoon. Ek chuno, ya bataiye kya chahiye.",
    }),
    options: {
      list: {
        button: pick(lang, { en: "More options", hi: "और विकल्प", hinglish: "Aur options" }),
        rows: Object.keys(MORE_ACTIONS).map((key) => ({ id: `${MORE_PREFIX}${key}`, title: titles[key] })),
      },
    },
  };
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
//   { kind: "cuisines" } / { kind: "more" }   show the cuisine list / the full menu
// Never returns "order-place" unless the id's nonce matches the pending
// order summary AND "Place order" was tapped on that same summary first.
export function resolveTap({ replyId, senderId, pendingAddressSelections, pendingOrderConfirmations, pendingCartSessions }) {
  const id = String(replyId ?? "");

  // The main menu never goes out of date.
  if (id === HOME_RECOMMEND) {
    return { kind: "text", text: "Recommend me something.", forAgent: true };
  }
  if (id === HOME_CUISINES) {
    return { kind: "cuisines" };
  }
  if (id === HOME_MORE) {
    return { kind: "more" };
  }
  if (id.startsWith(CUISINE_PREFIX)) {
    const cuisine = CUISINES.find((name) => name === id.slice(CUISINE_PREFIX.length));
    return cuisine ? { kind: "text", text: `I want ${cuisine}.`, forAgent: true } : { kind: "expired" };
  }
  if (id.startsWith(MORE_PREFIX)) {
    const action = MORE_ACTIONS[id.slice(MORE_PREFIX.length)];
    return action ? { kind: "text", text: action, forAgent: true } : { kind: "expired" };
  }

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

  // The button names the coupon itself, so it stays usable after the offer
  // has scrolled by (seen live: "See all coupons", then Apply on the earlier
  // offer was refused). Applying is checked by Swiggy and changes no order,
  // so all this needs is a cart to apply it to.
  if (id.startsWith(COUPON_APPLY_PREFIX)) {
    const couponCode = id.slice(COUPON_APPLY_PREFIX.length);
    return (session?.cartRestaurantId || session?.restaurantId) && /^[A-Za-z0-9_-]{1,40}$/.test(couponCode)
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

  // A dish on a menu Nosh showed: add it, through the agent (which resolves
  // sizes and add-ons and replies in the user's language). Only for the menu
  // currently on record, so an old menu's rows can't add from another
  // restaurant.
  if (id.startsWith(MENU_PREFIX)) {
    const items = session?.menuItems ?? [];
    const item = items.find((candidate, index) => String(candidate.id ?? `#${index}`) === id.slice(MENU_PREFIX.length));
    return item && session.restaurantName
      ? { kind: "text", text: `Add ${item.name} from ${session.restaurantName} to my cart.`, forAgent: true }
      : { kind: "expired" };
  }

  if (id === CART_CHECKOUT) {
    return { kind: "text", text: "Checkout.", forAgent: true };
  }
  if (id === CART_VIEW) {
    return { kind: "text", text: "Show my cart.", forAgent: true };
  }
  if (id === CART_COUPONS) {
    return { kind: "text", text: "Any coupons?", forAgent: true };
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
