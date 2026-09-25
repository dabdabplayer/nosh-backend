import { createGeminiClient } from "./gemini-client.js";
import { detectLanguage, pick } from "./language-preference.js";
import { searchFood } from "./food-search-orchestrator.js";
import {
  addToCart,
  applyCoupon,
  buildReorderUsualReply,
  checkout,
  findCoupons,
  recommendSimilar,
  removeFromCart,
  searchMenu,
  showRestaurantMenu,
  viewCart,
} from "./food-order-orchestrator.js";

// History: this was raised from 4 -> 6 -> 8 because a recommendation turn
// used to need recommend_similar (text-only) + agent-driven search_food +
// one-or-more agent-driven search_menu retries + a final text round - each
// retry was a full model round-trip, and REJECTING a recommendation needed
// even more room to avoid every dish already tried this conversation. That
// entire multi-round shape is gone: recommendSimilar (in
// food-order-orchestrator.js) now does the address/history-or-craving
// lookup AND fetches real candidate menu items via get_restaurant_menu
// itself, in one tool call, so a real recommendation is back down to ~2
// rounds (the tool call, then the final phrased reply) in the common case.
// Left at 8 rather than lowered, since no other flow (explicit search,
// cart edits, checkout) was ever the source of a round-cap failure in
// Render's logs - there's no evidence a smaller cap is needed elsewhere,
// and 8 only matters as a ceiling, not a typical cost.
const MAX_TOOL_ROUNDS = 8;

// Explicit and generous: with thinking on, a small budget can be used up
// by reasoning and leave an empty reply (see the !finalText branch below).
const MAX_TOKENS = 8192;

// The agent's role. Per the user's own instruction ("tell it
// it's role"): a real e-commerce assistant for deciding what to eat via
// Swiggy, never guessing - only ever stating facts a tool actually
// returned. Every rule below maps to a specific requirement/safety
// constraint from AGENTS.md or an explicit user ask; none of it is
// decorative.
const SYSTEM_PROMPT = [
  "You are Nosh, an e-commerce agent that helps a WhatsApp user decide what to eat and order it through real Swiggy tools.",
  "You decide on your own which tool (if any) to call based on what the user actually wants - never rely on keyword/trigger-word matching, and never call a tool the user's message doesn't call for.",
  "You exist only to help with Swiggy food ordering - deciding what to eat, searching, recommending, managing a cart, checking out, coupons, and order-adjacent questions. A greeting, thanks, or a short question about who you are or what you can help with is still in scope - answer those normally and briefly, the same as any other reply. But never answer a SUBSTANTIVE request for something else, under any circumstance: general knowledge, trivia, homework, coding help, personal/medical/legal/financial advice, roleplay, or especially adult/sexual/explicit/violent content, however the request is phrased, translated, framed as a joke or hypothetical, or disguised as something else. Do not comply even partially before redirecting - decline in one short sentence (same brevity as everywhere else in this prompt) and steer back to food, without lecturing or over-explaining why. The boundary is what the request is actually asking for, not the specific wording used to ask it - so this holds in every language and phrasing, the same principle as never relying on keyword/trigger-word matching above. The examples above are illustrative of the category (anything unrelated to deciding what to eat and ordering it), not an exhaustive list - if a new kind of off-topic request slips through, the operative rule is the principle in this sentence, not a missing example.",
  "Do not guess. Never state a price, availability, ETA, restaurant name, dish name, order status, or any other fact unless it came from a tool result in this conversation. If you don't know, call a tool to find out, or say you don't know.",
  "Always write your reply in plain, casual English, even if earlier messages in this conversation are in Hindi or Hinglish. A separate step translates the user's messages to English before you see them and translates your reply back into their language, so never translate anything yourself. Keep restaurant names, dish names, numbers and prices exactly as the tools gave them.",
  "Vary your phrasing turn to turn - do not reuse the same sentence structure or stock phrases repeatedly; this should read like a real conversation, not a form letter.",
  "Keep every reply SHORT - this is WhatsApp, read on a phone, not email. One to three short sentences for most replies. Say the point first, skip preamble (\"Sorry\", \"Hmm\", \"Honestly\", \"I'm really sorry\" as an opener), skip restating the situation before getting to it, and skip padding the end with extra alternatives/options unless the user actually asked for options. When you genuinely have nothing to offer, one short sentence saying so is enough - do not also explain why, apologize at length, or list several fallback suggestions nobody asked for.",
  "When a tool's result contains a numbered list (a restaurant search or a menu search), relay it in your own words, but keep every number, name, and price EXACTLY as given, in the exact same order - never renumber, reorder, merge, or drop an item. Exception: recommend_similar's candidate list (see below) - do not show that list to the user at all, you pick from it yourself.",
  "checkout, view_cart, find_coupons, apply_coupon, and get_restaurant_menu are different from every other tool: their real result goes straight to the user, verbatim, the moment you call them - you will never see that result, and anything you write in that same turn is discarded, never shown to anyone. So don't bother composing a summary or a confirmation-style ending around calling one of these - just call the right one when the user's request calls for it (checking out, seeing their cart, finding or applying a coupon, seeing a restaurant's menu) and your turn is done. Never list a restaurant's dishes yourself - when the user asks what a restaurant has or to see its menu, call get_restaurant_menu. This also means you can NEVER see or state real cart contents, prices, or coupon status yourself - if the user asks what's in their cart or wants a price check, call view_cart or find_coupons rather than answering from memory of an earlier turn, which may be stale.",
  "You can never place or confirm an order yourself, under any circumstance - there is no tool available to you that does that, and you never even see checkout's own result (see above) to relay it. Only the user replying literally \"YES\" to an order summary already shown by checkout can place an order, through a separate part of this app you have no visibility into. You have no way to know whether an order was ever placed, confirmed, or is being tracked, or what its ETA is - never say or imply any of that, under any circumstance, including right after a user says \"yes\"/\"confirm\" to you (that alone proves nothing - the real confirmation, if any, happened entirely outside this conversation). If asked about order status, say you can't check that here and suggest they look in the Swiggy app, or offer to show their cart.",
  "Never tell the user you can't place their order, that ordering isn't possible from here, or that they need to check out in the Swiggy app instead - that's false and a different mistake from the one above: you genuinely CAN show them a real order summary and a YES/NO prompt to actually place it, by calling checkout, you just can't complete the placement yourself once they say yes. When their message means \"I'm ready to order\" (\"order it\", \"place it\", \"checkout\", \"buy it\", or the same idea in any language/phrasing), call checkout - don't decline, redirect them elsewhere, or guess at a limitation instead of trying the real tool you actually have.",
  "The general rule for whether the user has to pick a restaurant themselves: did they name a SPECIFIC dish or restaurant (\"biryani\", \"from Pizza Hut\", \"margherita pizza\")? If so, search normally and let them choose from real results - there's genuine ambiguity there. If they only described a craving, mood, or cuisine with no specific dish or restaurant named (\"I want to eat something good\", \"what should I get\", \"I want something spicy\", \"mujhe kuch teekha khana hai\", \"surprise me\") - in ANY language or phrasing, not just these exact examples - that is a request for YOU to decide; the user should never have to pick from a list in that case.",
  "For that second case (you're deciding): call recommend_similar FIRST, every single time this happens, even if you already discussed their order history earlier in this conversation - do not rely on memory, always get a fresh real answer. It already returns a short list of real, in-stock menu items with real restaurant names and prices - pass a `craving` argument (your own concrete translation of a mood/cuisine, e.g. \"spicy\" -> \"chicken tikka masala\") ONLY if their CURRENT message actually states a craving; omit it entirely for a bare \"suggest something\"/\"recommend something\" so it uses their real order history instead. Pick ONE item from the result that best fits what they tend to like, preferring one not marked as already-ordered-before - do not repeat their literal last order. Present that pick - name, restaurant, and its real price - and ask whether they want it added. Do NOT call add_to_cart yet; only call it after they say yes (in whatever words/language they use), using the exact restaurant and item name from the recommend_similar result. Do NOT show recommend_similar's candidate list to the user or ask them to pick - that defeats the point of a recommendation.",
  "If the user rejects a recommendation you already made this conversation (\"something different\", \"no\", \"something else\", etc.), call recommend_similar again and pick a real item you have NOT already offered at any point earlier in this conversation - scan EVERY one of your own prior replies this conversation, not just your most recent one, before picking; a small menu means an item you offered several turns ago can show up again in a fresh recommend_similar result, and re-offering it is exactly as wrong as re-offering your last one. Never re-confirm or re-describe an item you have already offered, at any point this conversation - that is not what \"different\" means. If every real item recommend_similar returns has already been offered (and rejected) earlier this conversation, say so plainly (per the no-hallucination rule) rather than repeating one of them.",
  "If every search this turn genuinely came back empty and you truly have nothing real to recommend, say so plainly and stop there - never invent a cuisine, restaurant, or dish as a consolation suggestion (e.g. mentioning \"Chinese places\" or any other option you did not actually see in a tool result this conversation is a hallucination, not a helpful save). Reporting an honest \"nothing matched\" is always correct; making something up to sound more helpful is never acceptable, no exceptions for this being a disappointing answer.",
  "This applies just as much when a tool call itself succeeds but its result says it found nothing (e.g. search_menu replying \"Couldn't find X at Y\") - that is the SAME empty-result case as above, not a license to state a specific item name or price anyway because the call technically went through. A tool call succeeding only means the request reached Swiggy; it does not mean it found what you were looking for - read what the result actually says before claiming anything from it.",
  "The exact same rule applies to add_to_cart and remove_from_cart: never tell the user an item was added, removed, or changed, and never describe what's now in their cart, unless that tool's own real result THIS turn actually says so. If the item they asked for genuinely isn't on the real menu at their current restaurant, or the add/remove call comes back saying it couldn't find it, tell them that plainly instead of claiming success anyway - inventing a successful add is exactly as much a hallucination as inventing a restaurant, just about the cart instead of a recommendation. If they then ask to see the cart or check out, call view_cart or checkout rather than describing contents from memory or from what you just (possibly wrongly) claimed.",
  "Never claim their order history is sparse, unavailable, or unhelpful unless you actually called recommend_similar THIS turn and it genuinely came back that way - skipping that call and then saying you \"don't have much to go on\" is the same kind of false claim as inventing a restaurant, just phrased as a limitation instead of a suggestion.",
].join(" ");

const SEARCH_FOOD_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "search_food",
    description:
      "Find restaurants for a dish, cuisine, or restaurant name the user wants to order. Resolves the delivery address first - if more than one is saved, that question goes straight to the user verbatim and you won't see a restaurant list this call; otherwise it returns a numbered restaurant list to you as normal.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The dish, cuisine, or restaurant name, as the user said it." },
      },
      required: ["query"],
    },
  },
});

const SEARCH_MENU_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "search_menu",
    description:
      "Look up real menu items and their real prices at a specific restaurant, WITHOUT adding anything to the cart. Use this to find out what something actually costs before recommending it or telling the user a price.",
    parameters: {
      type: "object",
      properties: {
        restaurantName: { type: "string", description: "The restaurant's real name, exactly as a prior tool result gave it." },
        query: { type: "string", description: "The dish or cuisine to look for at that restaurant." },
      },
      required: ["restaurantName", "query"],
    },
  },
});

const ADD_TO_CART_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "add_to_cart",
    description:
      "Add a dish to the user's cart. Uses the restaurant already established in this conversation unless restaurantName names a different one.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The dish name, as the user said it. Fix obvious typos." },
        quantity: { type: "integer", description: "How many, if stated. Defaults to 1." },
        restaurantName: {
          type: "string",
          description:
            "The restaurant this dish is from: the one the user named, or the one a tool result (e.g. a recommendation) showed this dish at. Copy the name exactly as shown. Omit only if neither applies.",
        },
      },
      required: ["query"],
    },
  },
});

const REMOVE_FROM_CART_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "remove_from_cart",
    description: "Remove a dish already in the user's cart, or reduce its quantity.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The dish name to remove, as the user said it. Fix obvious typos." },
        quantity: {
          type: "integer",
          description: "How many to remove, only if the user gave a specific count. Omit to remove the item entirely.",
        },
      },
      required: ["query"],
    },
  },
});

const GET_RESTAURANT_MENU_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "get_restaurant_menu",
    description:
      "Show the user a restaurant's real menu (dish names and prices) when they ask to see a menu or what a restaurant has. Its result goes straight to the user - you will not see it. To add a dish from it afterwards, call add_to_cart with that dish's name.",
    parameters: {
      type: "object",
      properties: {
        restaurantName: {
          type: "string",
          description:
            "The restaurant's real name, exactly as a prior tool result gave it. Omit to use the restaurant already established in this conversation.",
        },
      },
    },
  },
});

const VIEW_CART_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "view_cart",
    description: "Show what's currently in the user's cart. Its result goes straight to the user - you will not see it.",
    parameters: { type: "object", properties: {} },
  },
});

const FIND_COUPONS_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "find_coupons",
    description:
      "List available coupons/discounts for the user's current order. Its result goes straight to the user - you will not see it.",
    parameters: { type: "object", properties: {} },
  },
});

const APPLY_COUPON_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "apply_coupon",
    description:
      "Apply a specific coupon code to the user's current order. Its result goes straight to the user - you will not see it.",
    parameters: {
      type: "object",
      properties: { couponCode: { type: "string", description: "The coupon code, as the user said it." } },
      required: ["couponCode"],
    },
  },
});

// Deliberately the ONLY checkout-adjacent tool. There is no tool for
// placing or confirming an order - see placeConfirmedOrder in
// food-order-orchestrator.js, reachable only via server.js's deterministic
// YES/NO gate on parseOrderConfirmationReply, never from here.
const CHECKOUT_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "checkout",
    description:
      "Get the order summary (items, pricing, payment method) for the user's current cart, ready for them to confirm, and the YES/NO confirmation prompt. Does NOT place the order. Its result goes straight to the user - you will not see it, so don't write your own summary or confirmation prompt; just call this when the user is ready to check out.",
    parameters: { type: "object", properties: {} },
  },
});

const REORDER_USUAL_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "reorder_usual",
    description: "Repeat the user's usual/regular order, without them naming a specific dish, cuisine, or restaurant.",
    parameters: { type: "object", properties: {} },
  },
});

const RECOMMEND_SIMILAR_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "recommend_similar",
    description:
      "Get a short list of real, in-stock menu items (with real restaurant names, ratings, delivery times where known, and real prices) to recommend from - already gathered for you, no further search needed. With no craving argument, these come from the user's real past-order history (restaurants they already like, items they haven't already had there). With a craving argument, these come from a real search for that craving/cuisine instead. Pick ONE item from the result yourself and present it - never show the full list to the user or ask them to pick; the point of a recommendation is that they don't have to decide. Do not call add_to_cart until they say yes. If more than one address is saved and none has been picked yet this session, this instead asks the user which address to use - that question goes straight to them verbatim, and you won't get a candidate list this call.",
    parameters: {
      type: "object",
      properties: {
        craving: {
          type: "string",
          description:
            "A concrete cuisine/dish guess translated from a craving/mood the user's CURRENT message actually stated (e.g. \"spicy\" -> \"chicken tikka masala\" or \"North Indian\"). Omit entirely if their current message named no craving at all (a bare \"suggest something\"/\"recommend something\") - omitting uses their real order history instead, which is what you want in that case.",
        },
      },
    },
  },
});

const TOOLS = Object.freeze([
  SEARCH_FOOD_TOOL,
  SEARCH_MENU_TOOL,
  GET_RESTAURANT_MENU_TOOL,
  ADD_TO_CART_TOOL,
  REMOVE_FROM_CART_TOOL,
  VIEW_CART_TOOL,
  FIND_COUPONS_TOOL,
  APPLY_COUPON_TOOL,
  CHECKOUT_TOOL,
  REORDER_USUAL_TOOL,
  RECOMMEND_SIMILAR_TOOL,
]);

// Exported so a test can assert, structurally, that no tool here ever
// reaches place_food_order/confirm_order - see the comment on CHECKOUT_TOOL
// above and AGENTS.md's Commerce Safety rule.
export { TOOLS };

// Tools whose result is deterministic, already-final text - once one of
// these is called, ITS OWN output becomes the reply directly, with no
// further agent phrasing, translation, or commentary layered on top. Per
// an explicit product decision (2026-09-21, see AGENTS.md's
// hallucinated-order-confirmation gotcha): the agent only ever DECIDES
// when to check out, view the cart, or look up/apply a coupon - it never
// writes the words for what those actions actually said, since letting it
// paraphrase a checkout-adjacent result is exactly what let it fabricate a
// fake order confirmation once already. search_food is handled separately
// in executeTool below (only terminal on the specific call where it
// triggers an address-disambiguation prompt, not on an ordinary
// restaurant-list result, which still gets agent-phrased like any other
// search result - ditto recommend_similar, add_to_cart, remove_from_cart,
// reorder_usual, and search_menu, deliberately left OFF this set: those
// are the "decide what to get" middle of the funnel this agent still owns
// end to end). get_restaurant_menu joined this set after the agent, with no
// real menu tool available, invented a full restaurant menu in its own words
// when asked to "show me the menu" - a menu is listed verbatim, never phrased.
const TERMINAL_TOOLS = new Set(["checkout", "view_cart", "find_coupons", "apply_coupon", "get_restaurant_menu"]);

// Every tool call is executed here, never left to the model to reach
// Swiggy directly. Never throws - a failure inside a tool becomes a tool
// RESULT the agent can react to gracefully, distinct from a failure of the
// model API call itself (which propagates up out of runAgentTurn
// unchanged, since that's the "NLU provider is down" case the caller
// already knows how to handle).
//
// Returns { text, terminal } rather than a bare string - see
// TERMINAL_TOOLS above and runAgentTurn's own use of `terminal` below.
async function executeTool(name, args, ctx) {
  const {
    senderId,
    swiggyFoodClient,
    pendingCartSessions,
    pendingAddressSelections,
    pendingOrderConfirmations,
    searchMenuState,
    dataAvailabilityState,
    cartMutationState,
    lang,
  } = ctx;

  try {
    switch (name) {
      case "search_food": {
        // Only terminal on the specific call where THIS invocation is what
        // triggers the address-disambiguation prompt (pending went from
        // unset to set) - an ordinary restaurant-list result (the common
        // case) stays agent-phrased, same as before. Comparing before/after
        // state rather than sniffing the returned text for an address-y
        // phrase, since a real state signal exists here (unlike the
        // search_menu case just below, which has to string-match its own
        // result for lack of one). lang is passed through regardless of
        // which branch fires - searchFood itself only actually uses it for
        // the (terminal) address prompt, see its own comment.
        const hadPendingAddress = Boolean(pendingAddressSelections.peek(senderId));
        // Deliberately not tracked in dataAvailabilityState (see that
        // state's own comment in runAgentTurn, and recommend_similar's case
        // below): the documented consolation-hallucination incidents
        // (inventing a restaurant/cuisine/menu) all happened in the "you
        // decide" recommend_similar flow, never in an EXPLICIT search_food
        // dead end ("no open restaurants for X" is already an honest,
        // sufficient answer on its own, with nothing to invent around it -
        // there's no craving-translation guess involved here the way there
        // is in recommend_similar). Scoping the guard narrowly avoids
        // regressing this tool's normal agent-phrased apology/fallback
        // behavior for an unrelated failure category (a thrown Swiggy call,
        // say) that was never part of the documented bug.
        const text = await searchFood(
          senderId,
          args.query,
          swiggyFoodClient,
          pendingAddressSelections,
          pendingCartSessions,
          lang,
        );
        const nowPendingAddress = Boolean(pendingAddressSelections.peek(senderId));
        return { text, terminal: !hadPendingAddress && nowPendingAddress };
      }

      case "search_menu": {
        const meta = {};
        const result = await searchMenu({
          senderId,
          restaurantName: args.restaurantName,
          query: args.query,
          swiggyFoodClient,
          pendingCartSessions,
          meta,
        });

        // Marks that a real match was found this turn - checked by the
        // caller (runAgentTurn's loop, not here) BEFORE routing to any tool
        // at all, so every entry point into "search again" is covered, not
        // just this one. See runAgentTurn's own comment on why this moved
        // out of individual tool cases: confirmed live twice in one
        // session, once the model has a real match it doesn't reliably
        // stop - and it doesn't always retry through the SAME tool either
        // (search_menu again the first time, search_food with a different
        // query the second time).
        //
        // Deliberately NOT fed into dataAvailabilityState (see search_food's
        // comment above for why) - search_menu is only ever reached for an
        // EXPLICIT dish/restaurant request under the current architecture
        // (recommend_similar owns the "you decide" flow entirely, see its
        // own header comment in food-order-orchestrator.js), so there's no
        // craving to invent a substitute for here; a thrown/empty result
        // should still let the agent phrase its own honest apology.
        if (searchMenuState && meta.hasData) {
          searchMenuState.foundMatch = true;
        }

        return { text: result, terminal: false };
      }

      case "add_to_cart": {
        const meta = {};
        const text = await addToCart({
          senderId,
          query: args.query,
          quantity: Number.isInteger(args.quantity) && args.quantity > 0 ? args.quantity : undefined,
          restaurantNameHint: typeof args.restaurantName === "string" ? args.restaurantName : undefined,
          swiggyFoodClient,
          pendingCartSessions,
          meta,
        });

        // Structural signal for cartMutationState (see its own comment in
        // runAgentTurn) instead of trusting the agent's own free-text claim
        // about whether the item was actually added. Checked with `===`,
        // not truthiness: meta.hasData is explicitly `false` only for a
        // genuine "not found" business result (see addToCart's own
        // comment) - left `undefined` on a thrown/infra failure, which must
        // NOT set lastFailureText, or a network hiccup would force
        // GENERIC_FALLBACK_REPLY's English-only text verbatim onto a
        // non-English reply instead of letting the agent phrase its own
        // apology (the same regression already caught once for
        // search_food/search_menu's thrown-call case, see that case above).
        if (cartMutationState) {
          cartMutationState.anyToolCalled = true;
          if (meta.hasData === true) {
            cartMutationState.sawSuccess = true;
          } else if (meta.hasData === false) {
            cartMutationState.lastFailureText = text;
          }
          if (meta.replacedEarlierCart) {
            cartMutationState.replacedEarlierCart = true;
          }
        }

        if (meta.replacedEarlierCart) {
          return {
            text: `${text}\n\n(The cart held items from a different restaurant, so those were removed first. Nosh tells the user this itself - don't mention it.)`,
            terminal: false,
          };
        }

        return { text, terminal: false };
      }

      case "remove_from_cart": {
        const meta = {};
        const text = await removeFromCart({
          senderId,
          query: args.query,
          quantity: Number.isInteger(args.quantity) && args.quantity > 0 ? args.quantity : undefined,
          swiggyFoodClient,
          pendingCartSessions,
          meta,
        });

        // Same === distinction as add_to_cart above.
        if (cartMutationState) {
          cartMutationState.anyToolCalled = true;
          if (meta.hasData === true) {
            cartMutationState.sawSuccess = true;
          } else if (meta.hasData === false) {
            cartMutationState.lastFailureText = text;
          }
        }

        return { text, terminal: false };
      }

      case "get_restaurant_menu":
        return {
          text: await showRestaurantMenu({
            senderId,
            restaurantName: typeof args.restaurantName === "string" && args.restaurantName.trim() ? args.restaurantName : undefined,
            swiggyFoodClient,
            pendingCartSessions,
            lang,
          }),
          terminal: TERMINAL_TOOLS.has(name),
        };

      case "view_cart":
        return {
          text: await viewCart({ senderId, swiggyFoodClient, pendingCartSessions, lang }),
          terminal: TERMINAL_TOOLS.has(name),
        };

      case "find_coupons":
        return {
          text: await findCoupons({ senderId, swiggyFoodClient, pendingCartSessions, lang }),
          terminal: TERMINAL_TOOLS.has(name),
        };

      case "apply_coupon":
        return {
          text: await applyCoupon({ senderId, couponCode: args.couponCode, swiggyFoodClient, pendingCartSessions, lang }),
          terminal: TERMINAL_TOOLS.has(name),
        };

      case "checkout":
        return {
          text: await checkout({ senderId, swiggyFoodClient, pendingCartSessions, pendingOrderConfirmations, lang }),
          terminal: TERMINAL_TOOLS.has(name),
        };

      case "reorder_usual":
        return { text: await buildReorderUsualReply({ senderId, swiggyFoodClient, pendingCartSessions }), terminal: false };

      case "recommend_similar": {
        // Same before/after pendingAddressSelections check as search_food
        // above, and for the same reason: recommendSimilar can now ALSO
        // trigger a real address-disambiguation prompt (see
        // food-order-orchestrator.js) when more than one address is saved -
        // that specific result must be terminal too, not agent-paraphrased,
        // while an ordinary recommendation stays ordinary (non-terminal).
        const hadPendingAddress = Boolean(pendingAddressSelections.peek(senderId));
        const meta = {};
        const text = await recommendSimilar({
          swiggyFoodClient,
          senderId,
          pendingCartSessions,
          pendingAddressSelections,
          craving: typeof args.craving === "string" && args.craving.trim() ? args.craving.trim() : undefined,
          lang,
          meta,
        });
        const nowPendingAddress = Boolean(pendingAddressSelections.peek(senderId));
        const terminal = !hadPendingAddress && nowPendingAddress;

        if (!terminal && dataAvailabilityState) {
          dataAvailabilityState.anyToolCalled = true;
          if (meta.hasData) {
            dataAvailabilityState.sawRealData = true;
          } else {
            dataAvailabilityState.lastNoDataText = text;
          }
        }

        return { text, terminal };
      }

      default:
        return { text: "That action isn't available.", terminal: false };
    }
  } catch (error) {
    console.error("Agent tool execution failed.", { tool: name, name: error?.name });
    return {
      text: "Something went wrong doing that just now. Let the user know and suggest trying again in a bit.",
      terminal: false,
    };
  }
}

function parseToolArgs(toolCall) {
  try {
    return JSON.parse(toolCall.function.arguments ?? "{}");
  } catch {
    return {};
  }
}

let cachedClient;
function getClient(agent) {
  if (!cachedClient) {
    cachedClient = createGeminiClient({ apiKey: agent.apiKey, baseUrl: agent.baseUrl, timeoutMs: agent.timeoutMs });
  }
  return cachedClient;
}

// Runs one full agentic turn: the model decides which real Swiggy tools (if
// any) to call, tool results are fed back, and it loops (capped at
// MAX_TOOL_ROUNDS) until it returns a plain English reply.
//
// The agent works in English only. When a translator is given, a Hindi or
// Hinglish message is translated to English before the model sees it, and
// the model's free-form reply is translated back into `lang`. Text that is
// already localized (TERMINAL_TOOLS results, the fake-confirmation redirect,
// the cart-replaced note) is never passed through translation, so the
// literal English YES/NO tokens the confirmation gate depends on are never
// touched. Conversation history is kept in English.
//
// Never catches a failure of the model API call itself - that propagates
// up to the caller (server.js), same as any other unexpected error in the
// reply-building path, so it's visible wherever failures are already being
// watched. Returns undefined only when the model completes with empty
// content and no tool calls (treated the same as "no trigger" was before -
// caller falls back to its own placeholder).
export async function runAgentTurn({
  message,
  swiggyFoodClient,
  pendingCartSessions,
  pendingOrderConfirmations,
  pendingAddressSelections,
  pendingConversationHistory,
  agent,
  client = getClient(agent),
  translator,
  // The user's language: used by the localized TERMINAL_TOOLS results and
  // as the target when translating the agent's reply.
  lang = "en",
}) {
  const senderId = message.from;
  const history = pendingConversationHistory.peek(senderId);

  const userText = translator ? await translator.toEnglish(message.text, detectLanguage(message.text)) : message.text;
  const toUserLanguage = (text) => (translator ? translator.fromEnglish(text, lang) : text);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: userText },
  ];

  // Mutable, scoped to this one runAgentTurn call only - tracks whether
  // search_menu has already found a real match THIS turn, so executeTool
  // can short-circuit any further search_menu call rather than let the
  // model keep searching past a good answer (see executeTool's comment).
  const searchMenuState = {};

  // Mutable, scoped to this one runAgentTurn call only - tracks, across
  // every recommend_similar call this turn (and ONLY recommend_similar -
  // see the "search_food"/"search_menu" cases in executeTool above for why
  // they're deliberately excluded), whether any call surfaced real
  // candidate items vs. a genuine, tool-authored dead end (set from the
  // `meta.hasData` flag recommendSimilar itself marks - never inferred from
  // the reply text). Consulted below, once a round ends with no further
  // tool calls: if recommend_similar was called this turn and never found
  // real candidates, the model has nothing legitimate left to recommend,
  // and per AGENTS.md's documented "consolation hallucination" incidents
  // (inventing a cuisine/restaurant/dish, or a fake menu, once every real
  // search in this flow came back empty - "invented Chinese places",
  // fabricated "Sushi platter / Ramen / Truffle pasta") it cannot be
  // trusted to write that "nothing found" answer itself - it's substituted
  // with the tool's own honest dead-end text instead, the same way
  // TERMINAL_TOOLS never lets the agent phrase a checkout-adjacent result.
  // This does NOT fire when recommend_similar was never called this turn
  // (small talk, an explicit search/cart edit, or a reply drawn from
  // legitimate conversation memory) - only when the model asked for a
  // recommendation and came back empty-handed.
  const dataAvailabilityState = { anyToolCalled: false, sawRealData: false, lastNoDataText: undefined };

  // Mutable, scoped to this one runAgentTurn call only - same shape and
  // purpose as dataAvailabilityState above, for add_to_cart/remove_from_cart
  // instead of recommend_similar. Confirmed live (2026-09-22, sender
  // 919289388564): "I want a pepsi" got a fabricated "Done — Pepsi added
  // too" reply with ZERO tool calls that turn - the YES/NO guard below
  // closes the fake-summary half of that incident, this closes the other
  // half: an add/remove call that genuinely fires but fails (item not on
  // the real menu, ambiguous cart match, a thrown Swiggy call) must not let
  // the model claim success anyway. Set from `meta.hasData`, which
  // addToCart/removeFromCart mark at every return point (never inferred
  // from the reply text) - see executeTool's add_to_cart/remove_from_cart
  // cases above. Does NOT fire when neither tool was called this turn, or
  // when at least one call this turn genuinely succeeded.
  const cartMutationState = {
    anyToolCalled: false,
    sawSuccess: false,
    lastFailureText: undefined,
    replacedEarlierCart: false,
  };

  // Appended in code, not left to the agent - confirmed live that the agent
  // sometimes drops add_to_cart's "earlier cart was removed" line, silently
  // losing items the user thinks are still in their cart.
  const withCartReplacementNote = (text) =>
    cartMutationState.replacedEarlierCart
      ? `${text}\n\n${pick(lang, {
          en: "Heads up: your cart had items from a different restaurant, so those were removed.",
          hi: "ध्यान दें: आपकी कार्ट में किसी दूसरे रेस्टोरेंट के आइटम थे, इसलिए वे हटा दिए गए।",
          hinglish: "Heads up: aapki cart mein dusre restaurant ke items the, isliye woh hata diye gaye.",
        })}`
      : text;

  const toolCtx = {
    senderId,
    swiggyFoodClient,
    pendingCartSessions,
    pendingAddressSelections,
    pendingOrderConfirmations,
    searchMenuState,
    dataAvailabilityState,
    cartMutationState,
    lang,
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.chat.completions({
      model: agent.model,
      messages,
      tools: TOOLS,
      reasoning_effort: agent.reasoningEffort,
      // No temperature: Google recommends Gemini 3's default of 1.0, since
      // lower values can cause looping on reasoning-heavy turns.
      max_tokens: MAX_TOKENS,
    });

    const responseMessage = response.choices?.[0]?.message;
    const toolCalls = responseMessage?.tool_calls;

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      const finalText = responseMessage?.content?.trim();

      if (!finalText) {
        // Distinguishes "the reasoning/token budget got eaten" (see
        // MAX_TOKENS above - finishReason "length" with reasoning_content
        // populated but content empty) from "the model genuinely had
        // nothing to say" - the two look identical to the caller
        // (undefined), but only the first is a real problem worth grepping
        // Render logs for.
        console.error("Agent turn produced no usable final content.", {
          finishReason: response.choices?.[0]?.finish_reason,
          hadReasoningContent: Boolean(responseMessage?.reasoning_content),
        });
        return undefined;
      }

      // Structural guard against a fabricated order/checkout summary -
      // confirmed live (2026-09-22, sender 919289388564): "I want a pepsi"
      // then "Yes" produced a full order-summary-shaped reply (fake item,
      // internally-inconsistent pricing, ending in the exact "Reply YES to
      // place this order, or NO to cancel." wording) with ZERO Swiggy tool
      // calls fired that turn (confirmed via Render's tool-call trace) -
      // i.e. 100% agent-invented text mimicking checkout's own real output.
      // This branch (no tool_calls this round) means, by construction, that
      // whatever text the model just wrote did NOT come from a genuine
      // checkout/view_cart/etc. TERMINAL_TOOLS pass-through this turn - so
      // if it contains the literal uppercase "YES"/"NO" confirmation
      // invitation (a token pattern reserved, per the system prompt, for
      // relaying a real checkout result THIS turn), it is definitionally
      // fabricated, not a judgment call to prompt-reinforce. A general
      // check - it doesn't matter what fake item or price is in the text,
      // only that this exact reserved wording never legitimately appears
      // outside a real TERMINAL_TOOLS result. Overriding with a safe
      // redirect (ask them to say "checkout") rather than the model's own
      // text ensures the user is never shown invented cart contents or
      // pricing, and steers them toward the one path that DOES call the
      // real tool. Phrased as intent ("ask me to check out"), not a literal
      // command keyword - this app has no trigger-word interface (see the
      // system prompt's first rule), so the redirect must not imply one.
      if (/\bYES\b/.test(finalText) && /\bNO\b/.test(finalText)) {
        console.error("Agent produced a fabricated confirmation-shaped reply with no real tool call this turn.");
        const safeRedirect = withCartReplacementNote(pick(lang, {
          en: "Let me pull up your actual order for you — ask me to check out and I'll show the real summary and total.",
          hi: "मैं आपका असली ऑर्डर दिखाता हूं — मुझे checkout करने के लिए कहें और मैं असली सारांश और कुल राशि दिखाऊंगा।",
          hinglish: "Main aapka actual order dikhata hoon — mujhe checkout karne ke liye kahein aur main real summary aur total dikhaunga.",
        }));
        pendingConversationHistory.append(senderId, { role: "user", content: userText });
        pendingConversationHistory.append(senderId, { role: "assistant", content: safeRedirect });
        return safeRedirect;
      }

      // Structural guard against the "consolation hallucination" pattern
      // AGENTS.md documents (inventing a restaurant/cuisine/menu once every
      // real search this turn came back empty) - see dataAvailabilityState's
      // own comment above. Only overrides when tools were genuinely called
      // and every one of them came back with a known, tool-authored "nothing
      // found" reply; a turn that never called a tool at all is left alone.
      const recommendSafeText =
        dataAvailabilityState.anyToolCalled &&
        !dataAvailabilityState.sawRealData &&
        dataAvailabilityState.lastNoDataText
          ? dataAvailabilityState.lastNoDataText
          : finalText;

      // Structural guard against claiming a cart add/remove succeeded when
      // the tool's own last call this turn actually failed - see
      // cartMutationState's own comment above. Mirrors the recommend_similar
      // guard immediately above; applied after it so a (practically
      // impossible) turn that trips both guards still gets an honest reply
      // about whichever tool actually ran.
      const safeFinalText =
        cartMutationState.anyToolCalled && !cartMutationState.sawSuccess && cartMutationState.lastFailureText
          ? cartMutationState.lastFailureText
          : recommendSafeText;

      pendingConversationHistory.append(senderId, { role: "user", content: userText });
      pendingConversationHistory.append(senderId, { role: "assistant", content: safeFinalText });
      return withCartReplacementNote(await toUserLanguage(safeFinalText));
    }

    // tool_calls must go back exactly as received: each carries Gemini's
    // thought signature (extra_content.google.thought_signature), and a
    // missing one fails the next request with a 400.
    messages.push({ role: "assistant", content: responseMessage.content ?? null, tool_calls: toolCalls });

    // Set the moment any tool call this round comes back terminal (see
    // TERMINAL_TOOLS above) - the FIRST one found wins on the rare chance
    // more than one fires in the same round (an even rarer edge case than
    // the model bundling tool calls at all). Every tool call this round
    // still executes (real side effects must happen), but once any of them
    // is terminal, that tool's own text becomes the reply directly below -
    // no further completions call, so the agent never gets a chance to
    // phrase, translate, or add commentary around it.
    let terminalResultText;

    // A TERMINAL_TOOLS call bundled with ordinary tool calls in the same round
    // is NOT run at all - otherwise its result ends the turn and whatever the
    // other calls were doing for the user is silently dropped (confirmed live:
    // "add one of everything" bundled view_cart with a menu search, and the
    // user just got their unchanged cart back). Not running it, rather than
    // running it and discarding the text, matters: checkout and apply_coupon
    // have side effects. The agent sees why and can call it alone next round.
    const hasOrdinaryCall = toolCalls.some((toolCall) => !TERMINAL_TOOLS.has(toolCall.function?.name));

    for (const toolCall of toolCalls) {
      // Checked before EVERY tool call this turn, not just search_food/
      // search_menu specifically - once search_menu has found a real match,
      // any further tool call (whichever one the model reaches for) gets
      // the same short-circuit, never a real Swiggy call. Confirmed live
      // that guarding individual tool cases one at a time doesn't hold: the
      // model found a different tool to keep going with each time a
      // narrower guard shipped. add_to_cart is deliberately included here
      // too - the system prompt already requires waiting for the user's
      // yes on a LATER turn before calling it, so it should never
      // legitimately fire in the SAME turn a match was just found either.
      let result;
      if (searchMenuState.foundMatch) {
        result = {
          text: "You already found a real, in-stock item earlier this turn - present that one as your recommendation now instead of calling another tool.",
          terminal: false,
        };
      } else if (hasOrdinaryCall && TERMINAL_TOOLS.has(toolCall.function.name)) {
        result = {
          text: "Not run: this tool's result goes straight to the user and ends your turn, so it can't be combined with other tool calls. Finish the other tool calls first, then call this one again on its own if it's still needed.",
          terminal: false,
        };
      } else {
        result = await executeTool(toolCall.function.name, parseToolArgs(toolCall), toolCtx);
      }

      messages.push({ role: "tool", tool_call_id: toolCall.id, content: result.text });

      if (result.terminal && terminalResultText === undefined) {
        terminalResultText = result.text;
      }
    }

    if (terminalResultText !== undefined) {
      const replyText = withCartReplacementNote(terminalResultText);
      pendingConversationHistory.append(senderId, { role: "user", content: userText });
      pendingConversationHistory.append(senderId, { role: "assistant", content: replyText });
      return replyText;
    }
  }

  // Hit the round cap without a final answer - fail closed rather than loop
  // forever or burn more of the 40 req/min Starter budget on one message.
  console.error("Agent exceeded the tool-call round cap.", { rounds: MAX_TOOL_ROUNDS });
  return undefined;
}
