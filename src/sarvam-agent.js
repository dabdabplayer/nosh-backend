import { SarvamAIClient } from "sarvamai";
import { searchFood } from "./food-search-orchestrator.js";
import {
  addToCart,
  applyCoupon,
  buildReorderUsualReply,
  checkout,
  describePastOrders,
  findCoupons,
  removeFromCart,
  searchMenu,
  viewCart,
} from "./food-order-orchestrator.js";

// Confirmed live at 4: a real recommendation turn needs recommend_similar +
// search_food + search_menu + a final text round = 4 rounds in the BEST
// case (nothing round-limit-relevant left over), and the model reasonably
// trying a second restaurant/dish when the first search_menu result wasn't
// a good match (a legitimate retry, not a bug) pushes that to 5+ - which
// hit this exact cap with `rounds: 4` in Render's logs, silently returning
// the generic placeholder instead of the recommendation. 4 was sized for
// the older, simpler tool set (pre-search_menu) and never revisited when
// search_menu was added.
// Raised again, 6 -> 8: confirmed live that REJECTING a recommendation and
// asking for something different needs even more room than a first-time
// recommendation - it has to avoid every dish already tried/had/rejected
// this conversation, which shrinks the real remaining options and can take
// more search_menu attempts to land on one. Hit `rounds: 6` with every
// search_menu call in the trace actually reaching Swiggy for real (not
// short-circuited), meaning genuinely none of those attempts found a
// match within budget. See AGENTS.md's rate-limit math note for the
// req/min tradeoff of raising this further.
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
  "When a tool's result already contains a numbered list, a cart summary, a coupon list, or an order summary, translate/adapt it into the user's language and tone, but keep every number, name, quantity, and price EXACTLY as given, in the exact same order - never renumber, reorder, merge, or drop an item. Exception: search_food's restaurant list during a recommendation (see below) - do not show that list to the user at all.",
  "The checkout tool's result is an order summary awaiting confirmation, not a placed order. Relay it faithfully and always end by telling the user to reply with the literal English word \"YES\" to confirm or \"NO\" to cancel, even if the rest of your reply is in another language - that exact wording is what a separate, deterministic part of this app checks for, so do not paraphrase it into another language or a synonym.",
  "You can never place or confirm an order yourself, under any circumstance - there is no tool available to you that does that. Only the user replying literally \"YES\" to an order summary already shown can do that, through a separate part of this app. Never say or imply that an order has been placed or confirmed unless a tool result explicitly told you so.",
  "The general rule for whether the user has to pick a restaurant themselves: did they name a SPECIFIC dish or restaurant (\"biryani\", \"from Pizza Hut\", \"margherita pizza\")? If so, search normally and let them choose from real results - there's genuine ambiguity there. If they only described a craving, mood, or cuisine with no specific dish or restaurant named (\"I want to eat something good\", \"what should I get\", \"I want something spicy\", \"mujhe kuch teekha khana hai\", \"surprise me\") - in ANY language or phrasing, not just these exact examples - that is a request for YOU to decide; the user should never have to pick from a list in that case.",
  "For that second case (you're deciding): call recommend_similar FIRST, every single time this happens, even if you already discussed their order history earlier in this conversation - do not rely on memory or skip straight to search_food/search_menu, always get a fresh real answer. Do not repeat their literal last order. Use their real order history (recommend_similar) to judge what they tend to like, then call search_food yourself - but ALWAYS with a concrete, specific, searchable term as the query. If their CURRENT message names a craving/cuisine (\"spicy\"), translate that into your own best concrete guess at a matching dish/cuisine (e.g. \"spicy\" -> try a dish like \"chicken tikka masala\" or a cuisine like \"North Indian\") - but if their current message names NO craving at all (a bare \"suggest me something\", \"suggest me\", \"recommend something\"), do NOT carry forward a craving from earlier in the conversation - instead search using the CUISINE or RESTAURANT NAME (never the specific dish name itself) from an order in their real history, so you land at a restaurant they already like, which is guaranteed to be real and searchable. Then, once you call search_menu there, you MUST pick a DIFFERENT item than the one they already ordered at that restaurant - never literally re-suggest their past dish itself, that defeats the entire point of a recommendation. If that restaurant genuinely has nothing else, try a different restaurant from their history the same way before falling back to a plain cuisine guess. If your search term finds nothing, try ONE different concrete term before giving up - never retry with the same vague word. Do NOT show search_food's restaurant list to the user or ask them which restaurant they want. Instead, pick one genuinely open restaurant from the result yourself, then call search_menu at that restaurant for a specific real dish and pick one real item from the result. Present that single pick as your recommendation - name, restaurant, and its real price from search_menu - and ask whether they want you to add it to their cart. Do NOT call add_to_cart yet at this point; only call it after they say yes (in whatever words/language they use) to that specific offer, using the exact restaurant and item you already found. You have a limited number of tool calls per turn - if your first restaurant genuinely has nothing matching, try at most ONE other real restaurant from search_food's result, then commit to whatever real, in-stock item you've found so far rather than continuing to search for something better; a good real recommendation beats no reply at all.",
  "If the user rejects a recommendation you already made this conversation (\"something different\", \"no\", \"something else\", etc.), that means try an actually DIFFERENT real restaurant and item than the one you already proposed - never re-confirm or re-describe the same item you just offered, that is not what \"different\" means. Prefer a different real restaurant from search_food's candidate list over guessing a whole new cuisine, since you already know those restaurants are real and open. If you genuinely cannot find anything else after a reasonable try, say so plainly (per the no-hallucination rule) rather than repeating your last offer.",
  "If every search this turn genuinely came back empty and you truly have nothing real to recommend, say so plainly and stop there - never invent a cuisine, restaurant, or dish as a consolation suggestion (e.g. mentioning \"Chinese places\" or any other option you did not actually see in a tool result this conversation is a hallucination, not a helpful save). Reporting an honest \"nothing matched\" is always correct; making something up to sound more helpful is never acceptable, no exceptions for this being a disappointing answer.",
  "This applies just as much when a tool call itself succeeds but its result says it found nothing (e.g. search_menu replying \"Couldn't find X at Y\") - that is the SAME empty-result case as above, not a license to state a specific item name or price anyway because the call technically went through. A tool call succeeding only means the request reached Swiggy; it does not mean it found what you were looking for - read what the result actually says before claiming anything from it.",
  "Never claim their order history is sparse, unavailable, or unhelpful unless you actually called recommend_similar THIS turn and it genuinely came back that way - skipping that call and then saying you \"don't have much to go on\" is the same kind of false claim as inventing a restaurant, just phrased as a limitation instead of a suggestion.",
].join(" ");

const SEARCH_FOOD_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "search_food",
    description:
      "Find restaurants for a dish, cuisine, or restaurant name the user wants to order. Resolves the delivery address (asking which saved address to use, if more than one) and returns a numbered restaurant list.",
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
  function: { name: "view_cart", description: "Show what's currently in the user's cart.", parameters: { type: "object", properties: {} } },
});

const FIND_COUPONS_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "find_coupons",
    description: "List available coupons/discounts for the user's current order.",
    parameters: { type: "object", properties: {} },
  },
});

const APPLY_COUPON_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "apply_coupon",
    description: "Apply a specific coupon code to the user's current order.",
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
      "Get the order summary (items, pricing, payment method) for the user's current cart, ready for them to confirm. Does NOT place the order.",
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
      "Get the user's real past-order history so you can reason about what to suggest next - something similar to what they tend to like, but not the exact same order again. After calling this, call search_food to find a concrete restaurant, then search_menu for a real dish and price there - never show search_food's restaurant list to the user or ask them to pick one; the point of a recommendation is that they don't have to decide. Present your single pick with its real price and ask if they want it added - do not call add_to_cart until they say yes.",
    parameters: { type: "object", properties: {} },
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

// Every tool call is executed here, never left to the model to reach
// Swiggy directly. Never throws - a failure inside a tool becomes a tool
// RESULT the agent can react to gracefully, distinct from a failure of the
// Sarvam API call itself (which propagates up out of runAgentTurn
// unchanged, since that's the "NLU provider is down" case the caller
// already knows how to handle).
async function executeTool(name, args, ctx) {
  const { senderId, swiggyFoodClient, pendingCartSessions, pendingAddressSelections, pendingOrderConfirmations, searchMenuState } =
    ctx;

  try {
    switch (name) {
      case "search_food":
        return await searchFood(senderId, args.query, swiggyFoodClient, pendingAddressSelections, pendingCartSessions);

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

        return result;
      }

      case "add_to_cart":
        return await addToCart({
          senderId,
          query: args.query,
          quantity: Number.isInteger(args.quantity) && args.quantity > 0 ? args.quantity : undefined,
          restaurantNameHint: typeof args.restaurantName === "string" ? args.restaurantName : undefined,
          swiggyFoodClient,
          pendingCartSessions,
        });

      case "remove_from_cart":
        return await removeFromCart({
          senderId,
          query: args.query,
          quantity: Number.isInteger(args.quantity) && args.quantity > 0 ? args.quantity : undefined,
          swiggyFoodClient,
          pendingCartSessions,
        });

      case "view_cart":
        return await viewCart({ senderId, swiggyFoodClient, pendingCartSessions });

      case "find_coupons":
        return await findCoupons({ senderId, swiggyFoodClient, pendingCartSessions });

      case "apply_coupon":
        return await applyCoupon({ senderId, couponCode: args.couponCode, swiggyFoodClient, pendingCartSessions });

      case "checkout":
        return await checkout({ senderId, swiggyFoodClient, pendingCartSessions, pendingOrderConfirmations });

      case "reorder_usual":
        return await buildReorderUsualReply({ senderId, swiggyFoodClient, pendingCartSessions });

      case "recommend_similar":
        return await describePastOrders({ swiggyFoodClient, senderId, pendingCartSessions });

      default:
        return "That action isn't available.";
    }
  } catch (error) {
    console.error("Sarvam agent tool execution failed.", { tool: name, name: error?.name });
    return "Something went wrong doing that just now. Let the user know and suggest trying again in a bit.";
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
      const resultText = searchMenuState.foundMatch
        ? "You already found a real, in-stock item earlier this turn - present that one as your recommendation now instead of calling another tool."
        : await executeTool(toolCall.function.name, parseToolArgs(toolCall), toolCtx);
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText });
    }
  }

  // Hit the round cap without a final answer - fail closed rather than loop
  // forever or burn more of the 40 req/min Starter budget on one message.
  console.error("Sarvam agent exceeded the tool-call round cap.", { rounds: MAX_TOOL_ROUNDS });
  return undefined;
}
