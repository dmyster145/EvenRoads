#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function parseCli(argv) {
  const args = argv.slice(2);
  if (args.length < 2) {
    console.error(
      "Usage: node scripts/perf/compare-summaries.cjs <baseline-summary.json> <candidate-summary.json> [--strict]",
    );
    process.exit(1);
  }
  return {
    baselinePath: args[0],
    candidatePath: args[1],
    strict: args.includes("--strict"),
  };
}

function readSummary(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function formatDelta(base, next) {
  const delta = next - base;
  if (base === 0) {
    return `${delta >= 0 ? "+" : ""}${delta.toFixed(2)} (n/a%)`;
  }
  const pct = (delta / base) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`;
}

function pick(obj, pathKey, fallback = 0) {
  const parts = pathKey.split(".");
  let node = obj;
  for (const part of parts) {
    node = node?.[part];
    if (node == null) return fallback;
  }
  return typeof node === "number" ? node : fallback;
}

function main() {
  const { baselinePath, candidatePath, strict } = parseCli(process.argv);
  const baseline = readSummary(baselinePath);
  const candidate = readSummary(candidatePath);

  const rows = [
    { label: "startup.setupMs", better: "lower" },
    { label: "bridge.weightedAvgSendMs", better: "lower" },
    { label: "bridge.maxSendMs", better: "lower" },
    { label: "bridge.maxQueueMs", better: "lower" },
    { label: "render.weightedAvgBuildMs", better: "lower" },
    { label: "render.weightedAvgEnqueueMs", better: "lower" },
    { label: "input.eventP95InputToRenderMs", better: "lower" },
    { label: "input.eventP95SetupMs", better: "lower" },
    { label: "input.eventP95EnqueueMs", better: "lower" },
  ];

  console.log(`Baseline:  ${path.resolve(baselinePath)}`);
  console.log(`Candidate: ${path.resolve(candidatePath)}`);
  console.log("");

  let regressions = 0;
  for (const row of rows) {
    const base = pick(baseline.summary, row.label);
    const next = pick(candidate.summary, row.label);
    const deltaText = formatDelta(base, next);
    const improved = row.better === "lower" ? next < base : next > base;
    const regressed = row.better === "lower" ? next > base : next < base;
    if (regressed) regressions += 1;
    const verdict = improved ? "improved" : regressed ? "regressed" : "same";
    console.log(
      `${row.label}: baseline=${base.toFixed(2)} candidate=${next.toFixed(2)} delta=${deltaText} => ${verdict}`,
    );
  }

  const baseIssues = baseline.issues?.length ?? 0;
  const nextIssues = candidate.issues?.length ?? 0;
  const issueDelta = nextIssues - baseIssues;
  const issueDirection = issueDelta > 0 ? "regressed" : issueDelta < 0 ? "improved" : "same";
  console.log("");
  console.log(`issues.count: baseline=${baseIssues} candidate=${nextIssues} delta=${issueDelta >= 0 ? "+" : ""}${issueDelta} => ${issueDirection}`);

  if (strict && regressions > 0) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main();
}
