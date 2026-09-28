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
import { percentile, printLatencyTable } from "./swiggy-latency-targets.js";

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

const SERVICE_PATTERNS = [
  [/Gemini call (succeeded|failed)\.\s*\{[^}]*durationMs:\s*(\d+)/, () => "gemini"],
  [/Sarvam translation (succeeded|failed)[^{]*\{[^}]*durationMs:\s*(\d+)[^}]*direction:\s*'([a-z-]+)'/, (match) => `sarvam ${match[3]}`],
];

// Gemini and Sarvam timings (from src/gemini-client.js and
// src/sarvam-translator.js). They publish no latency targets, so these are
// reported without comparison. Gemini lines also carry token counts.
export function collectServiceSamples(text) {
  const samples = {};
  for (const line of text.split("\n")) {
    for (const [pattern, nameOf] of SERVICE_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) {
        continue;
      }
      const name = nameOf(match);
      samples[name] ??= { durations: [], failures: 0, inputTokens: 0, outputTokens: 0 };
      if (match[1] === "succeeded") {
        samples[name].durations.push(Number(match[2]));
        samples[name].inputTokens += Number(/inputTokens:\s*(\d+)/.exec(line)?.[1] ?? 0);
        samples[name].outputTokens += Number(/outputTokens:\s*(\d+)/.exec(line)?.[1] ?? 0);
      } else {
        samples[name].failures += 1;
      }
    }
  }
  return samples;
}

function printServiceTable(samples) {
  const rows = Object.entries(samples).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) {
    return;
  }
  console.log("\nservice\tcalls\tfailed\tp50 ms\tp95 ms\tp99 ms\ttokens in/out");
  for (const [name, { durations, failures, inputTokens, outputTokens }] of rows) {
    const sorted = [...durations].sort((a, b) => a - b);
    const format = (value) => (value === undefined ? "-" : Math.round(value));
    console.log(
      [
        name,
        durations.length,
        failures,
        format(percentile(sorted, 50)),
        format(percentile(sorted, 95)),
        format(percentile(sorted, 99)),
        name === "gemini" ? `${inputTokens}/${outputTokens}` : "-",
      ].join("\t"),
    );
  }
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
  const text = await readInput(process.argv[2]);
  const samples = collectSamples(text);
  printServiceTable(collectServiceSamples(text));
  console.log("");
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
