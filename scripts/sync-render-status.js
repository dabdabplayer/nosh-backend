// Mirrors Render's own status for the region Nosh runs in onto the
// "Backend" component of Nosh's Statuspage page. Render isn't in
// Statuspage's third-party catalog, so this copies it from Render's public
// status feed instead. Runs on a schedule from GitHub Actions
// (.github/workflows/render-status.yml) rather than inside Nosh, so it
// still reports when Render itself is down.
//
//   STATUSPAGE_API_KEY=... STATUSPAGE_PAGE_ID=... STATUSPAGE_COMPONENT_BACKEND=... \
//     node scripts/sync-render-status.js
import { pathToFileURL } from "node:url";

const RENDER_SUMMARY_URL = "https://status.render.com/api/v2/summary.json";
const RENDER_REGION = "Singapore";
const RENDER_COMPONENTS = new Set(["Web Services", "Web Services - Free Tier"]);

const SEVERITY = ["operational", "under_maintenance", "degraded_performance", "partial_outage", "major_outage"];

// Worst status among the tracked components in the tracked region.
export function renderBackendStatus(summary) {
  const region = summary.components.find((component) => component.group && component.name === RENDER_REGION);
  if (!region) {
    throw new Error(`Render's status feed has no "${RENDER_REGION}" region group.`);
  }

  const tracked = summary.components.filter(
    (component) => component.group_id === region.id && RENDER_COMPONENTS.has(component.name),
  );
  if (tracked.length === 0) {
    throw new Error(`Render's status feed has no tracked components under "${RENDER_REGION}".`);
  }

  return tracked
    .map((component) => component.status)
    .reduce((worst, status) => (SEVERITY.indexOf(status) > SEVERITY.indexOf(worst) ? status : worst), "operational");
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${new URL(url).host} failed with status ${response.status}.`);
  }
  return response.json();
}

async function main() {
  const { STATUSPAGE_API_KEY: apiKey, STATUSPAGE_PAGE_ID: pageId, STATUSPAGE_COMPONENT_BACKEND: componentId } =
    process.env;
  if (!apiKey || !pageId || !componentId) {
    throw new Error("STATUSPAGE_API_KEY, STATUSPAGE_PAGE_ID and STATUSPAGE_COMPONENT_BACKEND are required.");
  }

  const wanted = renderBackendStatus(await fetchJson(RENDER_SUMMARY_URL));

  const componentsUrl = `https://api.statuspage.io/v1/pages/${pageId}/components`;
  const headers = { Authorization: `OAuth ${apiKey}`, "Content-Type": "application/json" };
  const current = (await fetchJson(componentsUrl, { headers })).find((component) => component.id === componentId);
  if (!current) {
    throw new Error("The Backend component id wasn't found on the Statuspage page.");
  }

  if (current.status === wanted) {
    console.log(`Backend is already ${wanted}.`);
    return;
  }

  await fetchJson(`${componentsUrl}/${componentId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ component: { status: wanted } }),
  });
  console.log(`Backend changed from ${current.status} to ${wanted}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
