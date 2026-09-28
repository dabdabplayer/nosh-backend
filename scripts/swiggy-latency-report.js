// Builds a per-tool Swiggy latency report from Nosh's own server logs, so
// cart changes and order placement - which the read-only benchmark
// (scripts/swiggy-latency.js) deliberately never does - are measured from
// real traffic. Reads the "Swiggy Food tool call ..." lines src/swiggy-food-client.js
// logs for every call, with their toolName and durationMs.
//
// Save Render's logs for a time window (Logs > Download, or the Render CLI)
// to a file, then:
//
//   node scripts/swiggy-latency-report.js render-logs.txt
//   render logs ... | node scripts/swiggy-latency-report.js
//
// durationMs covers the whole call as Nosh sees it, including network and
// any retries, so it runs higher than Swiggy's edge-measured targets.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { printLatencyTable } from "./swiggy-latency-targets.js";

const LINE_PATTERN = /Swiggy Food tool call (succeeded|failed|returned an error result)\.\s*\{[^}]*toolName:\s*'([a-z_]+)'[^}]*durationMs:\s*(\d+)/;

export function collectSamples(text) {
  const samples = {};
  for (const line of text.split("\n")) {
    const match = LINE_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    const [, outcome, tool, durationMs] = match;
    samples[tool] ??= { durations: [], failures: 0 };
    if (outcome === "succeeded") {
      samples[tool].durations.push(Number(durationMs));
    } else {
      samples[tool].failures += 1;
    }
  }
  return samples;
}

async function readInput(path) {
  if (path) {
    return readFile(path, "utf8");
  }
  if (process.stdin.isTTY) {
    throw new Error("Usage: node scripts/swiggy-latency-report.js <log file>   (or pipe logs in)");
  }
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

async function main() {
  const samples = collectSamples(await readInput(process.argv[2]));
  printLatencyTable(samples, {
    note:
      "From Nosh's logs: times include network and retries, which Swiggy's edge-measured targets exclude. " +
      "Check SWIGGY_TEST_MODE was off for this window, or these are mock timings.",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
