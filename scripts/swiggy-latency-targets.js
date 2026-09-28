// Swiggy's published latency targets, measured at their MCP server edge
// (excluding client network and inference).
// https://mcp.swiggy.com/builders/docs/operate/sla.md
export const LATENCY_TARGETS_MS = Object.freeze({
  read: { p50: 200, p95: 600, p99: 1200 },
  write: { p50: 400, p95: 1000, p99: 2000 },
  order: { p50: 800, p95: 2000, p99: 4000 },
});

// Swiggy's SLA page gives search_restaurants, update_food_cart and
// place_food_order as the examples of each class; the rest are grouped by
// whether they only read, change the cart/account, or place an order.
const WRITE_TOOLS = new Set(["update_food_cart", "flush_food_cart", "apply_food_coupon", "create_address", "delete_address"]);
const ORDER_TOOLS = new Set(["place_food_order", "confirm_order"]);

export function toolClass(toolName) {
  if (ORDER_TOOLS.has(toolName)) {
    return "order";
  }
  return WRITE_TOOLS.has(toolName) ? "write" : "read";
}

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) {
    return undefined;
  }
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[index];
}

// Prints one row per tool with p50/p95/p99 next to Swiggy's target for its
// class. `samples` maps toolName -> { durations: number[], failures: number }.
export function printLatencyTable(samples, { note } = {}) {
  const rows = Object.entries(samples)
    .filter(([, sample]) => sample.durations.length > 0 || sample.failures > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  if (rows.length === 0) {
    console.log("No Swiggy tool calls found.");
    return;
  }

  const format = (value, target) =>
    value === undefined ? "-" : `${Math.round(value)}${value > target ? " OVER" : ""}`;

  console.log(
    ["tool", "class", "calls", "failed", "p50 ms", "p95 ms", "p99 ms", "target p50/p95/p99"].join("\t"),
  );
  for (const [tool, { durations, failures }] of rows) {
    const cls = toolClass(tool);
    const target = LATENCY_TARGETS_MS[cls];
    const sorted = [...durations].sort((a, b) => a - b);
    console.log(
      [
        tool,
        cls,
        durations.length,
        failures,
        format(percentile(sorted, 50), target.p50),
        format(percentile(sorted, 95), target.p95),
        format(percentile(sorted, 99), target.p99),
        `${target.p50}/${target.p95}/${target.p99}`,
      ].join("\t"),
    );
  }
  if (note) {
    console.log(`\n${note}`);
  }
}
