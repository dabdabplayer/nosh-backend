const DEFAULT_TIMEOUT_MS = 8000;

const SEARCH_SYSTEM_PROMPT = [
  "You classify a single inbound WhatsApp message for a food-delivery bot named Nosh.",
  "Call search_food when the user is asking to find, search for, or start ordering a dish, cuisine, or restaurant they named.",
  "Call reorder_usual instead when the user asks to repeat, reorder, or get their usual/regular food order WITHOUT naming a",
  "specific dish, cuisine, or restaurant (e.g. \"get me my usual\", \"order the same as last time\", \"reorder what I always get\").",
  "Call recommend when the user asks you to recommend, suggest, or pick something for them, or asks what they should order,",
  "WITHOUT naming a specific dish, cuisine, or restaurant (e.g. \"recommend me something\", \"what should I get?\", \"surprise me\").",
  "For anything else - greetings, small talk, unrelated questions - do not call any tool.",
].join(" ");

// Used instead of SEARCH_SYSTEM_PROMPT when the sender already has an active
// cart with a restaurant. Without this, a message like "from Pizza Hut add a
// margherita pizza" gets misread as a brand new search (confirmed live) -
// this classifier has no visibility into cart state on its own, so it has to
// be told explicitly to step aside for cart-related messages and let
// classifyOrderIntent (which does know about the cart) handle them instead.
const SEARCH_WITH_ACTIVE_CART_SYSTEM_PROMPT = [
  "You classify a single inbound WhatsApp message for a food-delivery bot named Nosh.",
  "The user already has an active cart with a restaurant.",
  "Do NOT call search_food for messages about adding items to that cart, viewing the cart, coupons, or",
  "checking out - those are handled elsewhere and are not your job.",
  "Only call search_food if they clearly want to search for something new, or a different restaurant.",
  "For anything else, do not call any tool.",
].join(" ");

const SEARCH_FOOD_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "search_food",
    description:
      "The user wants to find, search for, or order a dish, cuisine, or restaurant for delivery.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The dish, cuisine, or restaurant name to search for, as the user said it.",
        },
      },
      required: ["query"],
    },
  },
});

const REORDER_USUAL_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "reorder_usual",
    description:
      "The user wants to repeat, reorder, or get their usual/regular food order, without naming a specific dish, " +
      "cuisine, or restaurant.",
    parameters: { type: "object", properties: {} },
  },
});

const RECOMMEND_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "recommend",
    description:
      "The user wants a recommendation or suggestion for what to order, based on what they usually get, without " +
      "naming a specific dish, cuisine, or restaurant.",
    parameters: { type: "object", properties: {} },
  },
});

const ORDER_SYSTEM_PROMPT = [
  "You classify a single inbound WhatsApp message for a food-delivery bot named Nosh.",
  "The user already has an active order in progress with one restaurant.",
  "Call exactly one tool that matches what they're asking for right now: add_to_cart to add a dish,",
  "remove_from_cart to remove a dish already in the cart or reduce its quantity, view_cart to see what's",
  "in the cart, find_coupons to see available discounts, apply_coupon to use a specific coupon code, or",
  "checkout when they want to place the order.",
  "For anything else, do not call any tool.",
].join(" ");

const ADD_TO_CART_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "add_to_cart",
    description: "The user wants to add a dish to their cart.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The dish name, as the user said it. Fix obvious typos." },
        quantity: { type: "integer", description: "How many, if stated. Defaults to 1." },
        restaurantName: {
          type: "string",
          description: "The restaurant the user named, if they named one (e.g. \"from Pizza Hut\"). Omit if they didn't say.",
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
    description:
      "The user wants to remove a dish already in their cart, or reduce its quantity - e.g. \"remove the biryani\", " +
      "\"take off the pizza\", \"I don't want the coke anymore\", \"remove 1 biryani\".",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The dish name to remove, as the user said it. Fix obvious typos." },
        quantity: {
          type: "integer",
          description:
            "How many to remove, only if the user gave a specific count (e.g. \"remove 1 biryani\"). Omit to remove the item entirely.",
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
    description: "The user wants to see what's currently in their cart.",
    parameters: { type: "object", properties: {} },
  },
});

const FIND_COUPONS_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "find_coupons",
    description: "The user wants to see available coupons or discounts for this order.",
    parameters: { type: "object", properties: {} },
  },
});

const APPLY_COUPON_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "apply_coupon",
    description: "The user wants to apply a specific coupon code to their order.",
    parameters: {
      type: "object",
      properties: {
        couponCode: { type: "string", description: "The coupon code, as the user said it." },
      },
      required: ["couponCode"],
    },
  },
});

const CHECKOUT_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "checkout",
    description: "The user wants to place their order / check out / pay now.",
    parameters: { type: "object", properties: {} },
  },
});

const ORDER_TOOLS = Object.freeze([
  ADD_TO_CART_TOOL,
  REMOVE_FROM_CART_TOOL,
  VIEW_CART_TOOL,
  FIND_COUPONS_TOOL,
  APPLY_COUPON_TOOL,
  CHECKOUT_TOOL,
]);

// Sends one chat-completions request with the given tool schemas. Returns
// { ok: true, toolCalls } on any completed response (toolCalls is [] when
// the model chose not to call anything - that's a real answer, not a
// failure), or { ok: false } on non-2xx, timeout, network error, or
// malformed body. Never throws. Callers that offer a deterministic fallback
// (see food-search-orchestrator.js's resolveIntent) need this ok/not-ok
// distinction to fall back only when the NLU provider itself is unavailable,
// not every time it decides a message doesn't match any tool.
async function requestToolCalls({ text, systemPrompt, tools, apiKey, baseUrl, model, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        // Sarvam's documented auth header (required on every Sarvam
        // endpoint - see docs.sarvam.ai/api-reference/authentication).
        // Authorization: Bearer is only its OpenAI-compat accommodation,
        // sent too so a local OpenAI-compatible dev server (e.g. Ollama,
        // which reads Authorization and ignores unknown headers) still
        // works unchanged.
        "api-subscription-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        tools,
        tool_choice: "auto",
        // Sarvam's chat models run in "thinking mode" by default, which
        // bills reasoning tokens as completion tokens and adds latency -
        // exactly the kind of multi-second delay that forced this classifier's
        // timeout up from 8s to 25s under the prior provider. This is a
        // single-turn tool-call classification, not a task that benefits from
        // reasoning, so disable it explicitly (the documented wire value is a
        // literal JSON null, not an omitted field).
        reasoning_effort: null,
      }),
    });

    if (!response.ok) {
      // Body text included (truncated) - these are structured
      // status/title/detail objects, never a secret, and knowing *why* a
      // request was rejected (bad model/param vs. auth vs. rate limit) is
      // the difference between guessing and fixing the right thing. Read
      // as text, not .json(), since an error body might not even be valid
      // JSON.
      let bodyText;
      try {
        bodyText = (await response.text()).slice(0, 500);
      } catch {
        bodyText = undefined;
      }
      console.error("NLU classification request failed.", { status: response.status, body: bodyText });
      return { ok: false };
    }

    const body = await response.json();
    const toolCalls = body?.choices?.[0]?.message?.tool_calls;
    return { ok: true, toolCalls: Array.isArray(toolCalls) ? toolCalls : [] };
  } catch (error) {
    console.error("NLU classification request errored.", { name: error.name });
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

function parseToolCallArgs(toolCall) {
  try {
    return JSON.parse(toolCall.function.arguments ?? "");
  } catch {
    return undefined;
  }
}

// Returned instead of undefined when the NLU request itself failed (bad
// auth, timeout, network error, non-2xx) - distinct from the model
// completing normally and simply not calling any tool. resolveIntent (in
// food-search-orchestrator.js) uses this to fall back to the literal
// find/search trigger only on a genuine NLU outage, not every time the model
// decides a message isn't a search/reorder/recommend request.
export const NLU_UNAVAILABLE = Symbol("nlu-unavailable");

// Classifies one inbound message via the configured NLU provider's
// OpenAI-compatible chat completions endpoint (Sarvam by default - see
// src/config.js), using function calling for a structured result instead of
// parsing prose. Never throws: returns NLU_UNAVAILABLE if the request itself
// failed, or undefined if the model responded but didn't recognize a
// search/reorder/recommend intent in the message.
export async function classifyMessage({
  text,
  apiKey,
  baseUrl,
  model,
  hasActiveCart = false,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  // reorder_usual and recommend are only offered when there's no active
  // cart - they're both ways to START an order (like search_food), not
  // cart-manipulation intents, and aren't part of the scope the cart-aware
  // prompt/tool set covers.
  const result = await requestToolCalls({
    text,
    systemPrompt: hasActiveCart ? SEARCH_WITH_ACTIVE_CART_SYSTEM_PROMPT : SEARCH_SYSTEM_PROMPT,
    tools: hasActiveCart ? [SEARCH_FOOD_TOOL] : [SEARCH_FOOD_TOOL, REORDER_USUAL_TOOL, RECOMMEND_TOOL],
    apiKey,
    baseUrl,
    model,
    fetchImpl,
    timeoutMs,
  });

  if (!result.ok) {
    return NLU_UNAVAILABLE;
  }

  for (const toolCall of result.toolCalls) {
    const name = toolCall?.function?.name;

    if (name === "reorder_usual") {
      return Object.freeze({ type: "reorder_usual" });
    }

    if (name === "recommend") {
      return Object.freeze({ type: "recommend" });
    }

    if (name !== "search_food") {
      continue;
    }

    const args = parseToolCallArgs(toolCall);
    const query = typeof args?.query === "string" ? args.query.trim() : "";

    if (query.length > 0) {
      return Object.freeze({ type: "search_food", query });
    }
  }

  return undefined;
}

// Same idea as classifyMessage, but for the cart/coupon/checkout intents
// that only make sense once a sender already has an active cart session
// (see food-order-orchestrator.js). Never throws, same fail-closed contract.
export async function classifyOrderIntent({
  text,
  apiKey,
  baseUrl,
  model,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const result = await requestToolCalls({
    text,
    systemPrompt: ORDER_SYSTEM_PROMPT,
    tools: ORDER_TOOLS,
    apiKey,
    baseUrl,
    model,
    fetchImpl,
    timeoutMs,
  });

  if (!result.ok) {
    return undefined;
  }

  for (const toolCall of result.toolCalls) {
    const name = toolCall?.function?.name;
    const args = parseToolCallArgs(toolCall);

    if (name === "add_to_cart") {
      const query = typeof args?.query === "string" ? args.query.trim() : "";
      if (query.length === 0) {
        continue;
      }
      const quantity = Number.isInteger(args?.quantity) && args.quantity > 0 ? args.quantity : 1;
      const restaurantName = typeof args?.restaurantName === "string" ? args.restaurantName.trim() : "";
      return Object.freeze({
        type: "add_to_cart",
        query,
        quantity,
        restaurantName: restaurantName.length > 0 ? restaurantName : undefined,
      });
    }

    if (name === "remove_from_cart") {
      const query = typeof args?.query === "string" ? args.query.trim() : "";
      if (query.length === 0) {
        continue;
      }
      const quantity = Number.isInteger(args?.quantity) && args.quantity > 0 ? args.quantity : undefined;
      return Object.freeze({ type: "remove_from_cart", query, quantity });
    }

    if (name === "view_cart") {
      return Object.freeze({ type: "view_cart" });
    }

    if (name === "find_coupons") {
      return Object.freeze({ type: "find_coupons" });
    }

    if (name === "apply_coupon") {
      const couponCode = typeof args?.couponCode === "string" ? args.couponCode.trim() : "";
      if (couponCode.length === 0) {
        continue;
      }
      return Object.freeze({ type: "apply_coupon", couponCode });
    }

    if (name === "checkout") {
      return Object.freeze({ type: "checkout" });
    }
  }

  return undefined;
}
