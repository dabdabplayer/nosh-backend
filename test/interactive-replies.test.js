import assert from "node:assert/strict";
import test from "node:test";
import {
  beginPlacingOrder,
  formatPlaceOrderCheck,
  orderOptionsFor,
  replyOptionsFor,
  resolveTap,
  snapshotPromptState,
  stopPlacingOrder,
} from "../src/interactive-replies.js";
import { PendingAddressSelections } from "../src/pending-address-selection.js";
import { PendingCartSessions } from "../src/pending-cart-sessions.js";
import { PendingOrderConfirmations } from "../src/pending-order-confirmations.js";

function stores() {
  return {
    senderId: "sender-1",
    pendingAddressSelections: new PendingAddressSelections(),
    pendingOrderConfirmations: new PendingOrderConfirmations(),
    pendingCartSessions: new PendingCartSessions(),
  };
}

const HOME = { id: "addr-1", label: "Home — 1 Main St", tag: "Home" };
const WORK = { id: "addr-2", label: "Work — 2 Other St", tag: "Work" };

function optionsAfter(s, change, extra = {}) {
  const before = snapshotPromptState(s);
  change();
  return replyOptionsFor({ before, after: snapshotPromptState(s), ...extra });
}

test("a new address question gets one button per address, carrying the Swiggy address id", () => {
  const s = stores();
  const options = optionsAfter(s, () => s.pendingAddressSelections.set("sender-1", { kind: "recommend", candidates: [HOME, WORK] }));

  assert.deepEqual(options, {
    buttons: [
      { id: "addr:addr-1", title: "Home" },
      { id: "addr:addr-2", title: "Work" },
    ],
  });
});

test("more than three addresses become a list with the full address as the description", () => {
  const s = stores();
  const candidates = [1, 2, 3, 4].map((n) => ({ id: `addr-${n}`, label: `Place ${n} — ${n} Main St`, tag: `Place ${n}` }));
  const options = optionsAfter(s, () => s.pendingAddressSelections.set("sender-1", { kind: "search", candidates }));

  assert.equal(options.list.button, "Choose address");
  assert.equal(options.list.rows.length, 4);
  assert.deepEqual(options.list.rows[0], { id: "addr:addr-1", title: "Place 1", description: "Place 1 — 1 Main St" });
});

test("an address question left open from an earlier turn adds no buttons to an unrelated reply", () => {
  const s = stores();
  s.pendingAddressSelections.set("sender-1", { kind: "recommend", candidates: [HOME, WORK] });

  assert.equal(optionsAfter(s, () => {}), undefined);
  // Kept open after a non-address reply (kind "agent"): still not a prompt.
  assert.equal(
    optionsAfter(s, () => s.pendingAddressSelections.set("sender-1", { kind: "agent", candidates: [HOME, WORK] })),
    undefined,
  );
});

test("tapping an address resolves to its position in the current question, and an old button is expired", () => {
  const s = stores();
  s.pendingAddressSelections.set("sender-1", { kind: "search", candidates: [HOME, WORK] });

  assert.deepEqual(resolveTap({ ...s, replyId: "addr:addr-2" }), { kind: "text", text: "2", forAgent: false });
  assert.deepEqual(resolveTap({ ...s, replyId: "addr:addr-9" }), { kind: "expired" });

  s.pendingAddressSelections.clear("sender-1");
  assert.deepEqual(resolveTap({ ...s, replyId: "addr:addr-2" }), { kind: "expired" });
});

// --- Tap-to-order: the one path here that can place a real order ---

function withOrderSummary(nonce = "nonce-current") {
  const s = stores();
  s.pendingOrderConfirmations.set("sender-1", {
    addressId: "addr-1",
    cartId: 1,
    paymentMethod: "Cash",
    nonce,
    summary: { restaurantName: "Taco Fiesta", toPay: 314 },
  });
  return s;
}

test("a new order summary gets Place order and Cancel buttons tied to its nonce", () => {
  const s = stores();
  const options = optionsAfter(s, () =>
    s.pendingOrderConfirmations.set("sender-1", { addressId: "addr-1", cartId: 1, paymentMethod: "Cash", nonce: "n1" }),
  );

  assert.deepEqual(options, {
    buttons: [
      { id: "order:place:n1", title: "Place order" },
      { id: "order:cancel:n1", title: "Cancel" },
    ],
  });
});

test("the first tap only asks 'place this order?' - it never places the order", () => {
  const s = withOrderSummary();
  const before = snapshotPromptState(s);

  const tap = resolveTap({ ...s, replyId: "order:place:nonce-current" });

  assert.equal(tap.kind, "order-check");
  assert.equal(s.pendingOrderConfirmations.peek("sender-1").armed, true);
  assert.equal(formatPlaceOrderCheck(tap.confirmation), "Place this order from Taco Fiesta for ₹314? It can't be undone once placed.");
  assert.deepEqual(replyOptionsFor({ before, after: snapshotPromptState(s) }), {
    buttons: [
      { id: "order:confirm:nonce-current", title: "Yes, place it" },
      { id: "order:cancel:nonce-current", title: "Cancel" },
    ],
  });
});

test("the confirm button places the order only after Place order was tapped on the same summary", () => {
  const s = withOrderSummary();

  // Straight to confirm, skipping the first step: refused.
  assert.deepEqual(resolveTap({ ...s, replyId: "order:confirm:nonce-current" }), { kind: "expired" });

  resolveTap({ ...s, replyId: "order:place:nonce-current" });
  assert.equal(resolveTap({ ...s, replyId: "order:confirm:nonce-current" }).kind, "order-place");
});

test("buttons from an older order summary can never arm, place or cancel the current one", () => {
  const s = withOrderSummary("nonce-current");

  for (const replyId of ["order:place:nonce-old", "order:confirm:nonce-old", "order:cancel:nonce-old", "order:confirm:", "order:confirm"]) {
    assert.deepEqual(resolveTap({ ...s, replyId }), { kind: "expired" }, replyId);
  }
  assert.equal(s.pendingOrderConfirmations.peek("sender-1").armed, undefined);

  // Even once the current summary is armed, the old nonce still fails.
  resolveTap({ ...s, replyId: "order:place:nonce-current" });
  assert.deepEqual(resolveTap({ ...s, replyId: "order:confirm:nonce-old" }), { kind: "expired" });
});

test("order buttons do nothing when no order summary is waiting", () => {
  const s = stores();
  for (const replyId of ["order:place:x", "order:confirm:x", "order:cancel:x"]) {
    assert.deepEqual(resolveTap({ ...s, replyId }), { kind: "expired" });
  }
});

test("a second confirm while the order is being placed is refused, and a failed attempt can be retried", () => {
  const s = withOrderSummary();

  const first = beginPlacingOrder(s);
  assert.equal(first.cartId, 1);
  assert.equal(beginPlacingOrder(s), undefined);

  stopPlacingOrder({ ...s, confirmation: first });
  assert.equal(beginPlacingOrder(s).cartId, 1);
});

test("beginPlacingOrder returns nothing when no order is waiting", () => {
  assert.equal(beginPlacingOrder(stores()), undefined);
});

// --- Coupons, lists and recommendations ---

test("a coupon offer gets Apply and See all buttons, and Apply keeps working after the offer has passed", () => {
  const s = stores();
  s.pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  const options = optionsAfter(s, () =>
    s.pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", offeredCouponCode: "SAVE10" }),
  );

  assert.deepEqual(options, {
    buttons: [
      { id: "coupon:apply:SAVE10", title: "Apply" },
      { id: "coupon:all", title: "See all coupons" },
    ],
  });
  assert.deepEqual(resolveTap({ ...s, replyId: "coupon:apply:SAVE10" }), { kind: "coupon-apply", couponCode: "SAVE10" });
  assert.deepEqual(resolveTap({ ...s, replyId: "coupon:all" }), { kind: "text", text: "Show me all the coupons.", forAgent: true });

  // An offer left over from an earlier turn adds no buttons.
  assert.equal(optionsAfter(s, () => {}), undefined);

  // The offer is gone (the user asked to see all coupons), but the button
  // names its own coupon and there is still a cart to apply it to.
  s.pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  assert.deepEqual(resolveTap({ ...s, replyId: "coupon:apply:SAVE10" }), { kind: "coupon-apply", couponCode: "SAVE10" });

  // No cart, or an id that isn't a plausible coupon code: refused.
  s.pendingCartSessions.clear("sender-1");
  assert.deepEqual(resolveTap({ ...s, replyId: "coupon:apply:SAVE10" }), { kind: "expired" });
  s.pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  assert.deepEqual(resolveTap({ ...s, replyId: "coupon:apply:not a code!" }), { kind: "expired" });
});

test("the full coupon list becomes tappable rows that each apply their coupon", () => {
  const s = stores();
  s.pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1" });
  const listedCoupons = [
    { code: "SAVE10", description: "10% off, up to ₹50" },
    { code: "FLAT20", description: "" },
  ];
  const options = optionsAfter(s, () => s.pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", listedCoupons }));

  assert.equal(options.list.button, "Apply a coupon");
  assert.deepEqual(options.list.rows, [
    { id: "coupon:apply:SAVE10", title: "SAVE10", description: "10% off, up to ₹50" },
    { id: "coupon:apply:FLAT20", title: "FLAT20" },
  ]);

  // Carried along on later session writes without being shown again.
  assert.equal(
    optionsAfter(s, () => s.pendingCartSessions.set("sender-1", { ...s.pendingCartSessions.peek("sender-1"), cartRestaurantId: "r-1" })),
    undefined,
  );
});

test("numbered restaurant and dish lists become tappable rows matched by real id", () => {
  const s = stores();
  const restaurants = [
    { id: "r-1", name: "Biryani House" },
    { id: "r-2", name: "Pizza Place" },
  ];
  const options = optionsAfter(s, () => s.pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantCandidates: restaurants }));

  assert.deepEqual(options.list.rows, [
    { id: "rest:r-1", title: "Biryani House" },
    { id: "rest:r-2", title: "Pizza Place" },
  ]);
  assert.deepEqual(resolveTap({ ...s, replyId: "rest:r-2" }), { kind: "text", text: "2", forAgent: false });
  assert.deepEqual(resolveTap({ ...s, replyId: "rest:r-9" }), { kind: "expired" });

  const items = [
    { menu_item_id: "i-1", name: "Chicken Biryani", price: 249 },
    { menu_item_id: "i-2", name: "Veg Biryani", price: 199 },
  ];
  const itemOptions = optionsAfter(s, () => s.pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", itemCandidates: items }));

  assert.deepEqual(itemOptions.list.rows[1], { id: "item:i-2", title: "Veg Biryani", description: "₹199" });
  assert.deepEqual(resolveTap({ ...s, replyId: "item:i-2" }), { kind: "text", text: "2", forAgent: false });
  // The restaurant list was replaced, so its rows are out of date.
  assert.deepEqual(resolveTap({ ...s, replyId: "rest:r-2" }), { kind: "expired" });
});

test("a recommendation gets Add it and Something else quick replies, in the user's language", () => {
  const s = stores();
  const before = snapshotPromptState(s);

  assert.deepEqual(replyOptionsFor({ before, after: before, recommended: true, lang: "hinglish" }), {
    buttons: [
      { id: "rec:add", title: "Add kar do" },
      { id: "rec:other", title: "Kuch aur" },
    ],
  });
  assert.equal(replyOptionsFor({ before, after: before }), undefined);
  assert.deepEqual(resolveTap({ ...s, replyId: "rec:add" }), { kind: "text", text: "Yes, add it to my cart.", forAgent: true });
  assert.deepEqual(resolveTap({ ...s, replyId: "something-unknown" }), { kind: "expired" });
});

test("every button label fits WhatsApp's 20-character limit in every language", () => {
  for (const lang of ["en", "hi", "hinglish", "punjabi", "pa"]) {
    const s = withOrderSummary();
    const before = snapshotPromptState(stores());
    const summary = replyOptionsFor({ before, after: snapshotPromptState(s), lang });
    resolveTap({ ...s, replyId: "order:place:nonce-current" });
    const check = replyOptionsFor({ before, after: snapshotPromptState(s), lang });
    const recommendation = replyOptionsFor({ before, after: before, recommended: true, lang });
    const c = stores();
    c.pendingCartSessions.set("sender-1", { offeredCouponCode: "SAVE10" });
    const coupon = replyOptionsFor({ before, after: snapshotPromptState(c), lang });

    for (const button of [...summary.buttons, ...check.buttons, ...recommendation.buttons, ...coupon.buttons]) {
      assert.ok([...button.title].length <= 20, `${lang}: ${button.title}`);
    }
  }
});

test("orderOptionsFor repeats the right order buttons for a waiting summary", () => {
  assert.equal(orderOptionsFor(undefined), undefined);
  assert.equal(orderOptionsFor({ cartId: 1 }), undefined);
  assert.equal(orderOptionsFor({ nonce: "n1" }).buttons[0].id, "order:place:n1");
  assert.equal(orderOptionsFor({ nonce: "n1", armed: true }).buttons[0].id, "order:confirm:n1");
});

test("a restaurant menu becomes tappable rows that add the dish through the agent", () => {
  const s = stores();
  s.pendingCartSessions.set("sender-1", { addressId: "addr-1" });
  const menuItems = Array.from({ length: 12 }, (_, n) => ({ id: `i-${n + 1}`, name: `Dish ${n + 1}`, price: 100 + n }));
  const options = optionsAfter(s, () =>
    s.pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", restaurantName: "Sushi Central", menuItems }),
  );

  assert.equal(options.list.button, "Add a dish");
  assert.equal(options.list.rows.length, 10);
  assert.deepEqual(options.list.rows[0], { id: "menu:i-1", title: "Dish 1", description: "₹100" });

  assert.deepEqual(resolveTap({ ...s, replyId: "menu:i-2" }), {
    kind: "text",
    text: "Add Dish 2 from Sushi Central to my cart.",
    forAgent: true,
  });
  // A row from a menu that is no longer the one on record.
  assert.deepEqual(resolveTap({ ...s, replyId: "menu:i-99" }), { kind: "expired" });

  // The same menu carried along on a later session write isn't shown again.
  assert.equal(
    optionsAfter(s, () => s.pendingCartSessions.set("sender-1", { ...s.pendingCartSessions.peek("sender-1"), cartRestaurantId: "r-1" })),
    undefined,
  );
});

test("a reply about the cart gets Checkout, View cart and Coupons buttons when there is a cart", () => {
  const s = stores();
  s.pendingCartSessions.set("sender-1", { addressId: "addr-1", restaurantId: "r-1", cartRestaurantId: "r-1" });
  const state = snapshotPromptState(s);

  assert.deepEqual(replyOptionsFor({ before: state, after: state, cartShown: true, lang: "hinglish" }), {
    buttons: [
      { id: "cart:checkout", title: "Checkout" },
      { id: "cart:view", title: "Cart dekhein" },
      { id: "cart:coupons", title: "Coupons" },
    ],
  });
  assert.equal(replyOptionsFor({ before: state, after: state }), undefined);

  // No cart yet: no cart buttons.
  const empty = stores();
  empty.pendingCartSessions.set("sender-1", { addressId: "addr-1" });
  const emptyState = snapshotPromptState(empty);
  assert.equal(replyOptionsFor({ before: emptyState, after: emptyState, cartShown: true }), undefined);

  assert.deepEqual(resolveTap({ ...s, replyId: "cart:checkout" }), { kind: "text", text: "Checkout.", forAgent: true });
  assert.deepEqual(resolveTap({ ...s, replyId: "cart:view" }), { kind: "text", text: "Show my cart.", forAgent: true });
  assert.deepEqual(resolveTap({ ...s, replyId: "cart:coupons" }), { kind: "text", text: "Any coupons?", forAgent: true });
});
