import { SarvamAIClient } from "sarvamai";
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
  viewCart,
} from "./food-order-orchestrator.js";

// History: this was raised from 4 -> 6 -> 8 because a recommendation turn
// used to need recommend_similar (text-only) + agent-driven search_food +
// one-or-more agent-driven search_menu retries + a final text round - each
// retry was a full Sarvam round-trip, and REJECTING a recommendation needed
// even more room to avoid every dish already tried this conversation. That
// entire multi-round shape is gone: recommendSimilar (in
// food-order-orchestrator.js) now does the address/history-or-craving
// lookup AND fetches real candidate menu items via get_restaurant_menu
// itself, in one tool call, so a real recommendation is back down to ~2
// rounds (the tool call, then the final phrased reply) in the common case.
// Left at 8 rather than lowered, since no other flow (explicit search,
// cart edits, checkout) was ever the source of a round-cap failure in
// Render's logs - there's no evidence a smaller cap is needed elsewhere,
// and 8 only matters as a ceiling, not a typical cost. Revisit downward if
// Sarvam round-trip latency (not round *count*) is still the bottleneck
// after this change - see AGENTS.md's rate-limit math note for the req/min
// tradeoff either way.
const MAX_TOOL_ROUNDS = 8;

// Sarvam's default max_tokens is 2048, and with reasoning_effort enabled,
// reasoning tokens are billed against that SAME budget as completion tokens
// (docs.sarvam.ai/api/api-guides-tutorials/chat-completion/overview) - a low
// budget can be consumed entirely by reasoning, leaving finish_reason:
// "length" with empty content and only reasoning_content populated. This app
// sends a system prompt + tool schemas + up to 20 turns of history on every
// call, so the default budget is not generous enough to reliably leave room
// for both reasoning and a full cart/restaurant-list reply. Set explicitly,
// generously, rather than silently inheriting the default.
const MAX_TOKENS = 4096;

// The custom Sarvam agent's role. Per the user's own instruction ("tell it
// it's role"): a real e-commerce assistant for deciding what to eat via
// Swiggy, never guessing - only ever stating facts a tool actually
// returned. Every rule below maps to a specific requirement/safety
// constraint from AGENTS.md or an explicit user ask; none of it is
// decorative.
const SYSTEM_PROMPT = [
  "You are Nosh, an e-commerce agent that helps a WhatsApp user decide what to eat and order it through real Swiggy tools.",
  "You decide on your own which tool (if any) to call based on what the user actually wants - never rely on keyword/trigger-word matching, and never call a tool the user's message doesn't call for.",
  "Do not guess. Never state a price, availability, ETA, restaurant name, dish name, order status, or any other fact unless it came from a tool result in this conversation. If you don't know, call a tool to find out, or say you don't know.",
  "Mirror the language of the user's MOST RECENT message specifically, not the conversation's overall history - reply in Hindi only if their latest message is in Hindi (Devanagari) script, in Hinglish only if their latest message is Latin-script code-mixed Hindi/English, and in English otherwise. If they switch languages mid-conversation, switch your reply immediately to match - do not let an earlier turn's language (even several recent ones) carry over once they've moved on. Match their tone, not just their vocabulary.",
  "Vary your phrasing turn to turn - do not reuse the same sentence structure or stock phrases repeatedly; this should read like a real conversation, not a form letter.",
  "Keep every reply SHORT - this is WhatsApp, read on a phone, not email. One to three short sentences for most replies. Say the point first, skip preamble (\"Sorry\", \"Hmm\", \"Honestly\", \"I'm really sorry\" as an opener), skip restating the situation before getting to it, and skip padding the end with extra alternatives/options unless the user actually asked for options. When you genuinely have nothing to offer, one short sentence saying so is enough - do not also explain why, apologize at length, or list several fallback suggestions nobody asked for.",
  "When a tool's result contains a numbered list (a restaurant search or a menu search), translate/adapt it into the user's language and tone, but keep every number, name, and price EXACTLY as given, in the exact same order - never renumber, reorder, merge, or drop an item. Exception: recommend_similar's candidate list (see below) - do not show that list to the user at all, you pick from it yourself.",
  "checkout, view_cart, find_coupons, and apply_coupon are different from every other tool: their real result goes straight to the user, verbatim, the moment you call them - you will never see that result, and anything you write in that same turn is discarded, never shown to anyone. So don't bother composing a summary, a translation, or a confirmation-style ending around calling one of these - just call the right one when the user's request calls for it (checking out, seeing their cart, finding or applying a coupon) and your turn is done. This also means you can NEVER see or state real cart contents, prices, or coupon status yourself - if the user asks what's in their cart or wants a price check, call view_cart or find_coupons rather than answering from memory of an earlier turn, which may be stale.",
  "You can never place or confirm an order yourself, under any circumstance - there is no tool available to you that does that, and you never even see checkout's own result (see above) to relay it. Only the user replying literally \"YES\" to an order summary already shown by checkout can place an order, through a separate part of this app you have no visibility into. You have no way to know whether an order was ever placed, confirmed, or is being tracked, or what its ETA is - never say or imply any of that, under any circumstance, including right after a user says \"yes\"/\"confirm\" to you (that alone proves nothing - the real confirmation, if any, happened entirely outside this conversation). If asked about order status, say you can't check that here and suggest they look in the Swiggy app, or offer to show their cart.",
  "The general rule for whether the user has to pick a restaurant themselves: did they name a SPECIFIC dish or restaurant (\"biryani\", \"from Pizza Hut\", \"margherita pizza\")? If so, search normally and let them choose from real results - there's genuine ambiguity there. If they only described a craving, mood, or cuisine with no specific dish or restaurant named (\"I want to eat something good\", \"what should I get\", \"I want something spicy\", \"mujhe kuch teekha khana hai\", \"surprise me\") - in ANY language or phrasing, not just these exact examples - that is a request for YOU to decide; the user should never have to pick from a list in that case.",
  "For that second case (you're deciding): call recommend_similar FIRST, every single time this happens, even if you already discussed their order history earlier in this conversation - do not rely on memory, always get a fresh real answer. It already returns a short list of real, in-stock menu items with real restaurant names and prices - pass a `craving` argument (your own concrete translation of a mood/cuisine, e.g. \"spicy\" -> \"chicken tikka masala\") ONLY if their CURRENT message actually states a craving; omit it entirely for a bare \"suggest something\"/\"recommend something\" so it uses their real order history instead. Pick ONE item from the result that best fits what they tend to like, preferring one not marked as already-ordered-before - do not repeat their literal last order. Present that pick - name, restaurant, and its real price - and ask whether they want it added. Do NOT call add_to_cart yet; only call it after they say yes (in whatever words/language they use), using the exact restaurant and item name from the recommend_similar result. Do NOT show recommend_similar's candidate list to the user or ask them to pick - that defeats the point of a recommendation.",
  "If the user rejects a recommendation you already made this conversation (\"something different\", \"no\", \"something else\", etc.), call recommend_similar again and pick a genuinely different real item than the one you already offered (check your own earlier reply in this conversation for what that was) - never re-confirm or re-describe the same item you just offered, that is not what \"different\" means. If you genuinely cannot find anything else after that, say so plainly (per the no-hallucination rule) rather than repeating your last offer.",
  "If every search this turn genuinely came back empty and you truly have nothing real to recommend, say so plainly and stop there - never invent a cuisine, restaurant, or dish as a consolation suggestion (e.g. mentioning \"Chinese places\" or any other option you did not actually see in a tool result this conversation is a hallucination, not a helpful save). Reporting an honest \"nothing matched\" is always correct; making something up to sound more helpful is never acceptable, no exceptions for this being a disappointing answer.",
  "This applies just as much when a tool call itself succeeds but its result says it found nothing (e.g. search_menu replying \"Couldn't find X at Y\") - that is the SAME empty-result case as above, not a license to state a specific item name or price anyway because the call technically went through. A tool call succeeding only means the request reached Swiggy; it does not mean it found what you were looking for - read what the result actually says before claiming anything from it.",
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
    description: "Add a dish to the user's cart, at the restaurant already established in this conversation.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The dish name, as the user said it. Fix obvious typos." },
        quantity: { type: "integer", description: "How many, if stated. Defaults to 1." },
        restaurantName: {
          type: "string",
          description: "The restaurant the user explicitly named, if they named one. Omit if they didn't say.",
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
// end to end).
const TERMINAL_TOOLS = new Set(["checkout", "view_cart", "find_coupons", "apply_coupon"]);

// Every tool call is executed here, never left to the model to reach
// Swiggy directly. Never throws - a failure inside a tool becomes a tool
// RESULT the agent can react to gracefully, distinct from a failure of the
// Sarvam API call itself (which propagates up out of runAgentTurn
// unchanged, since that's the "NLU provider is down" case the caller
// already knows how to handle).
//
// Returns { text, terminal } rather than a bare string - see
// TERMINAL_TOOLS above and runAgentTurn's own use of `terminal` below.
async function executeTool(name, args, ctx) {
  const { senderId, swiggyFoodClient, pendingCartSessions, pendingAddressSelections, pendingOrderConfirmations, searchMenuState } =
    ctx;

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
        // result for lack of one).
        const hadPendingAddress = Boolean(pendingAddressSelections.peek(senderId));
        const text = await searchFood(senderId, args.query, swiggyFoodClient, pendingAddressSelections, pendingCartSessions);
        const nowPendingAddress = Boolean(pendingAddressSelections.peek(senderId));
        return { text, terminal: !hadPendingAddress && nowPendingAddress };
      }

      case "search_menu": {
        const result = await searchMenu({
          senderId,
          restaurantName: args.restaurantName,
          query: args.query,
          swiggyFoodClient,
          pendingCartSessions,
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
        if (searchMenuState && result.startsWith("Here's what I found")) {
          searchMenuState.foundMatch = true;
        }

        return { text: result, terminal: false };
      }

      case "add_to_cart":
        return {
          text: await addToCart({
            senderId,
            query: args.query,
            quantity: Number.isInteger(args.quantity) && args.quantity > 0 ? args.quantity : undefined,
            restaurantNameHint: typeof args.restaurantName === "string" ? args.restaurantName : undefined,
            swiggyFoodClient,
            pendingCartSessions,
          }),
          terminal: false,
        };

      case "remove_from_cart":
        return {
          text: await removeFromCart({
            senderId,
            query: args.query,
            quantity: Number.isInteger(args.quantity) && args.quantity > 0 ? args.quantity : undefined,
            swiggyFoodClient,
            pendingCartSessions,
          }),
          terminal: false,
        };

      case "view_cart":
        return { text: await viewCart({ senderId, swiggyFoodClient, pendingCartSessions }), terminal: TERMINAL_TOOLS.has(name) };

      case "find_coupons":
        return { text: await findCoupons({ senderId, swiggyFoodClient, pendingCartSessions }), terminal: TERMINAL_TOOLS.has(name) };

      case "apply_coupon":
        return {
          text: await applyCoupon({ senderId, couponCode: args.couponCode, swiggyFoodClient, pendingCartSessions }),
          terminal: TERMINAL_TOOLS.has(name),
        };

      case "checkout":
        return {
          text: await checkout({ senderId, swiggyFoodClient, pendingCartSessions, pendingOrderConfirmations }),
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
        const text = await recommendSimilar({
          swiggyFoodClient,
          senderId,
          pendingCartSessions,
          pendingAddressSelections,
          craving: typeof args.craving === "string" && args.craving.trim() ? args.craving.trim() : undefined,
        });
        const nowPendingAddress = Boolean(pendingAddressSelections.peek(senderId));
        return { text, terminal: !hadPendingAddress && nowPendingAddress };
      }

      default:
        return { text: "That action isn't available.", terminal: false };
    }
  } catch (error) {
    console.error("Sarvam agent tool execution failed.", { tool: name, name: error?.name });
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
function getClient(nlu) {
  // Cached across calls (same apiKey/baseUrl for the process lifetime, per
  // config.js) rather than constructed per turn - matches the SDK's own
  // intended usage (one client per app).
  if (!cachedClient) {
    cachedClient = new SarvamAIClient({
      apiSubscriptionKey: nlu.apiKey,
      baseUrl: nlu.baseUrl,
      timeoutInSeconds: Math.ceil(nlu.timeoutMs / 1000),
    });
  }
  return cachedClient;
}

// Runs one full agentic turn: the model decides which real Swiggy tools (if
// any) to call, tool results are fed back, and it loops (capped at
// MAX_TOOL_ROUNDS - see src/config.js's NLU rate-limit note) until it
// returns a plain natural-language reply. That final reply IS the phrased,
// language-mirrored response - no separate "translate this" call needed.
//
// Never catches a failure of the Sarvam API call itself - that propagates
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
  nlu,
  client = getClient(nlu),
}) {
  const senderId = message.from;
  const history = pendingConversationHistory.peek(senderId);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: message.text },
  ];

  // Mutable, scoped to this one runAgentTurn call only - tracks whether
  // search_menu has already found a real match THIS turn, so executeTool
  // can short-circuit any further search_menu call rather than let the
  // model keep searching past a good answer (see executeTool's comment).
  const searchMenuState = {};
  const toolCtx = {
    senderId,
    swiggyFoodClient,
    pendingCartSessions,
    pendingAddressSelections,
    pendingOrderConfirmations,
    searchMenuState,
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.chat.completions({
      model: nlu.model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      reasoning_effort: nlu.reasoningEffort,
      temperature: 0.4,
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
        console.error("Sarvam agent turn produced no usable final content.", {
          finishReason: response.choices?.[0]?.finish_reason,
          hadReasoningContent: Boolean(responseMessage?.reasoning_content),
        });
        return undefined;
      }

      pendingConversationHistory.append(senderId, { role: "user", content: message.text });
      pendingConversationHistory.append(senderId, { role: "assistant", content: finalText });
      return finalText;
    }

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
      const result = searchMenuState.foundMatch
        ? {
            text: "You already found a real, in-stock item earlier this turn - present that one as your recommendation now instead of calling another tool.",
            terminal: false,
          }
        : await executeTool(toolCall.function.name, parseToolArgs(toolCall), toolCtx);

      messages.push({ role: "tool", tool_call_id: toolCall.id, content: result.text });

      if (result.terminal && terminalResultText === undefined) {
        terminalResultText = result.text;
      }
    }

    if (terminalResultText !== undefined) {
      pendingConversationHistory.append(senderId, { role: "user", content: message.text });
      pendingConversationHistory.append(senderId, { role: "assistant", content: terminalResultText });
      return terminalResultText;
    }
  }

  // Hit the round cap without a final answer - fail closed rather than loop
  // forever or burn more of the 40 req/min Starter budget on one message.
  console.error("Sarvam agent exceeded the tool-call round cap.", { rounds: MAX_TOOL_ROUNDS });
  return undefined;
}
