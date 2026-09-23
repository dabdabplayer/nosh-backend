import assert from "node:assert/strict";
import test from "node:test";
import { renderBackendStatus } from "../scripts/sync-render-status.js";

function summary(singaporeStatuses, otherRegionStatus = "operational") {
  return {
    components: [
      { id: "sg", name: "Singapore", group: true },
      { id: "or", name: "Oregon", group: true },
      { id: "a", name: "Web Services", status: singaporeStatuses[0], group_id: "sg" },
      { id: "b", name: "Web Services - Free Tier", status: singaporeStatuses[1], group_id: "sg" },
      { id: "c", name: "PostgreSQL", status: "major_outage", group_id: "sg" },
      { id: "d", name: "Web Services", status: otherRegionStatus, group_id: "or" },
    ],
  };
}

test("reports the worst status of Singapore's web service components", () => {
  assert.equal(renderBackendStatus(summary(["operational", "operational"])), "operational");
  assert.equal(renderBackendStatus(summary(["degraded_performance", "partial_outage"])), "partial_outage");
});

test("ignores other regions and services Nosh doesn't use", () => {
  assert.equal(renderBackendStatus(summary(["operational", "operational"], "major_outage")), "operational");
});

test("fails loudly if Render renames the region", () => {
  assert.throws(() => renderBackendStatus({ components: [] }), /Singapore/);
});
