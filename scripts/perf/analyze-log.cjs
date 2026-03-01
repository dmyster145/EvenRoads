#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function parseCli(argv) {
  const args = argv.slice(2);
  let logPath = "";
  let jsonOut = "";
  let strict = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      jsonOut = args[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (!logPath) {
      logPath = arg;
    }
  }

  if (!logPath) {
    console.error("Usage: node scripts/perf/analyze-log.cjs <log-path> [--json <out-path>] [--strict]");
    process.exit(1);
  }
  return { logPath, jsonOut, strict };
}

function toNum(value) {
  return Number.parseFloat(value);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function weightedAverage(records, valueKey, weightKey) {
  let num = 0;
  let den = 0;
  for (const record of records) {
    const weight = record[weightKey] ?? 0;
    const value = record[valueKey] ?? 0;
    num += value * weight;
    den += weight;
  }
  return den > 0 ? num / den : 0;
}

function safeRegex(line, regex) {
  const match = line.match(regex);
  return match?.groups || null;
}

function parsePerfLog(text) {
  const lines = text.split(/\r?\n/);
  const startupSetupMs = [];
  const bridge = [];
  const render = [];
  const inputBursts = [];
  const inputEvents = [];

  for (const line of lines) {
    const setup = safeRegex(line, /\[EvenRoads\]\[Perf\]\[Bridge\] setupPage=(?<setup>[0-9.]+)ms/);
    if (setup) {
      startupSetupMs.push(toNum(setup.setup));
      continue;
    }

    const bridgeSummary = safeRegex(
      line,
      /\[EvenRoads\]\[Perf\]\[Bridge\] sends=(?<sends>\d+) avgSend=(?<avgSend>[0-9.]+)ms maxSend=(?<maxSend>[0-9.]+)ms(?: minSend=(?<minSend>[0-9.]+)ms)? avgQueue=(?<avgQueue>[0-9.]+)ms maxQueue=(?<maxQueue>[0-9.]+)ms coalesced=(?<coalesced>\d+) skippedSame=(?<skippedSame>\d+)(?: droppedLowPri=(?<droppedLowPri>\d+))?(?: dropRecentInputTick=(?<dropRecentInputTick>\d+))? failed=(?<failed>\d+)/,
    );
    if (bridgeSummary) {
      bridge.push({
        sends: Number.parseInt(bridgeSummary.sends, 10),
        avgSend: toNum(bridgeSummary.avgSend),
        maxSend: toNum(bridgeSummary.maxSend),
        minSend: bridgeSummary.minSend != null ? toNum(bridgeSummary.minSend) : null,
        avgQueue: toNum(bridgeSummary.avgQueue),
        maxQueue: toNum(bridgeSummary.maxQueue),
        coalesced: Number.parseInt(bridgeSummary.coalesced, 10),
        skippedSame: Number.parseInt(bridgeSummary.skippedSame, 10),
        droppedLowPri: Number.parseInt(bridgeSummary.droppedLowPri || "0", 10),
        dropRecentInputTick: Number.parseInt(bridgeSummary.dropRecentInputTick || "0", 10),
        failed: Number.parseInt(bridgeSummary.failed, 10),
      });
      continue;
    }

    const renderSummary = safeRegex(
      line,
      /\[EvenRoads\]\[Perf\]\[Render\] samples=(?<samples>\d+) avgBuild=(?<avgBuild>-?[0-9.]+)ms maxBuild=(?<maxBuild>-?[0-9.]+)ms avgPreview=(?<avgPreview>-?[0-9.]+)ms maxPreview=(?<maxPreview>-?[0-9.]+)ms avgSetup=(?<avgSetup>-?[0-9.]+)ms maxSetup=(?<maxSetup>-?[0-9.]+)ms avgEnqueue=(?<avgEnqueue>-?[0-9.]+)ms maxEnqueue=(?<maxEnqueue>-?[0-9.]+)ms skipPreview=(?<skipPreview>\d+) skipBridge=(?<skipBridge>\d+)(?: skipBusyTick=(?<skipBusyTick>\d+))?(?: skipInputCooldownTick=(?<skipInputCooldownTick>\d+))?(?: skipStaticTick=(?<skipStaticTick>\d+))? input->render=(?<inputToRender>-?[0-9.]+)ms max=(?<inputToRenderMax>-?[0-9.]+)ms input->enqueue=(?<inputToEnqueue>-?[0-9.]+)ms max=(?<inputToEnqueueMax>-?[0-9.]+)ms/,
    );
    if (renderSummary) {
      render.push({
        samples: Number.parseInt(renderSummary.samples, 10),
        avgBuild: toNum(renderSummary.avgBuild),
        maxBuild: toNum(renderSummary.maxBuild),
        avgPreview: toNum(renderSummary.avgPreview),
        maxPreview: toNum(renderSummary.maxPreview),
        avgSetup: toNum(renderSummary.avgSetup),
        maxSetup: toNum(renderSummary.maxSetup),
        avgEnqueue: toNum(renderSummary.avgEnqueue),
        maxEnqueue: toNum(renderSummary.maxEnqueue),
        skipPreview: Number.parseInt(renderSummary.skipPreview, 10),
        skipBridge: Number.parseInt(renderSummary.skipBridge, 10),
        skipBusyTick: Number.parseInt(renderSummary.skipBusyTick || "0", 10),
        skipInputCooldownTick: Number.parseInt(renderSummary.skipInputCooldownTick || "0", 10),
        skipStaticTick: Number.parseInt(renderSummary.skipStaticTick || "0", 10),
        inputToRender: toNum(renderSummary.inputToRender),
        inputToRenderMax: toNum(renderSummary.inputToRenderMax),
        inputToEnqueue: toNum(renderSummary.inputToEnqueue),
        inputToEnqueueMax: toNum(renderSummary.inputToEnqueueMax),
      });
      continue;
    }

    const inputBurst = safeRegex(
      line,
      /\[EvenRoads\]\[Perf\]\[Input\] mapped=(?<mapped>\d+) dropRawScroll=(?<dropRaw>\d+) dropSameDirScroll=(?<dropDir>\d+) dropTap=(?<dropTap>\d+) dropDoubleTap=(?<dropDoubleTap>\d+)/,
    );
    if (inputBurst) {
      inputBursts.push({
        mapped: Number.parseInt(inputBurst.mapped, 10),
        dropRaw: Number.parseInt(inputBurst.dropRaw, 10),
        dropDir: Number.parseInt(inputBurst.dropDir, 10),
        dropTap: Number.parseInt(inputBurst.dropTap, 10),
        dropDoubleTap: Number.parseInt(inputBurst.dropDoubleTap, 10),
      });
      continue;
    }

    const inputEvent = safeRegex(
      line,
      /\[EvenRoads\]\[Perf\]\[input\].*input->render=(?<inputToRender>-?[0-9.]+)ms .*setup=(?<setup>[0-9.]+)ms enqueue=(?<enqueue>[0-9.]+)ms/,
    );
    if (inputEvent) {
      inputEvents.push({
        inputToRender: toNum(inputEvent.inputToRender),
        setup: toNum(inputEvent.setup),
        enqueue: toNum(inputEvent.enqueue),
      });
    }
  }

  const bridgeSends = bridge.reduce((sum, item) => sum + item.sends, 0);
  const bridgeFailed = bridge.reduce((sum, item) => sum + item.failed, 0);
  const bridgeCoalesced = bridge.reduce((sum, item) => sum + item.coalesced, 0);
  const bridgeDroppedLowPri = bridge.reduce((sum, item) => sum + item.droppedLowPri, 0);
  const bridgeDropRecentInputTick = bridge.reduce((sum, item) => sum + item.dropRecentInputTick, 0);
  const renderSamples = render.reduce((sum, item) => sum + item.samples, 0);
  const renderSkipBridge = render.reduce((sum, item) => sum + item.skipBridge, 0);
  const renderSkipPreview = render.reduce((sum, item) => sum + item.skipPreview, 0);
  const renderSkipBusyTick = render.reduce((sum, item) => sum + item.skipBusyTick, 0);
  const renderSkipInputCooldownTick = render.reduce((sum, item) => sum + item.skipInputCooldownTick, 0);
  const renderSkipStaticTick = render.reduce((sum, item) => sum + item.skipStaticTick, 0);
  const mappedInput = inputBursts.reduce((sum, item) => sum + item.mapped, 0);
  const droppedInput =
    inputBursts.reduce((sum, item) => sum + item.dropRaw + item.dropDir + item.dropTap + item.dropDoubleTap, 0);

  const inputEventInputToRender = inputEvents.map((item) => item.inputToRender).filter((value) => value >= 0);
  const inputEventSetup = inputEvents.map((item) => item.setup);
  const inputEventEnqueue = inputEvents.map((item) => item.enqueue);

  const summary = {
    startup: {
      setupMs: startupSetupMs[0] ?? 0,
      maxSetupMs: startupSetupMs.length ? Math.max(...startupSetupMs) : 0,
      samples: startupSetupMs.length,
    },
    bridge: {
      windows: bridge.length,
      sends: bridgeSends,
      failed: bridgeFailed,
      coalesced: bridgeCoalesced,
      droppedLowPri: bridgeDroppedLowPri,
      droppedRecentInputTick: bridgeDropRecentInputTick,
      weightedAvgSendMs: weightedAverage(bridge, "avgSend", "sends"),
      weightedAvgQueueMs: weightedAverage(bridge, "avgQueue", "sends"),
      maxSendMs: bridge.length ? Math.max(...bridge.map((item) => item.maxSend)) : 0,
      minSendMs: bridge.some((item) => item.minSend != null)
        ? Math.min(...bridge.filter((item) => item.minSend != null).map((item) => item.minSend))
        : 0,
      maxQueueMs: bridge.length ? Math.max(...bridge.map((item) => item.maxQueue)) : 0,
    },
    render: {
      windows: render.length,
      samples: renderSamples,
      weightedAvgBuildMs: weightedAverage(render, "avgBuild", "samples"),
      weightedAvgSetupMs: weightedAverage(render, "avgSetup", "samples"),
      weightedAvgEnqueueMs: weightedAverage(render, "avgEnqueue", "samples"),
      weightedAvgInputToRenderMs: weightedAverage(render, "inputToRender", "samples"),
      weightedAvgInputToEnqueueMs: weightedAverage(render, "inputToEnqueue", "samples"),
      maxSetupMs: render.length ? Math.max(...render.map((item) => item.maxSetup)) : 0,
      skippedBridgeWrites: renderSkipBridge,
      skippedPreviewWrites: renderSkipPreview,
      skippedBusyTickWrites: renderSkipBusyTick,
      skippedInputCooldownTickWrites: renderSkipInputCooldownTick,
      skippedStaticTickRenders: renderSkipStaticTick,
    },
    input: {
      burstWindows: inputBursts.length,
      events: inputEvents.length,
      mapped: mappedInput,
      dropped: droppedInput,
      dropRate: mappedInput > 0 ? droppedInput / mappedInput : 0,
      eventP50InputToRenderMs: percentile(inputEventInputToRender, 50),
      eventP95InputToRenderMs: percentile(inputEventInputToRender, 95),
      eventP95SetupMs: percentile(inputEventSetup, 95),
      eventP95EnqueueMs: percentile(inputEventEnqueue, 95),
    },
  };

  const issues = [];
  if (summary.startup.setupMs > 1500) {
    issues.push({
      severity: "warn",
      code: "startup_setup_slow",
      message: `Startup page setup is ${summary.startup.setupMs.toFixed(1)}ms (>1500ms). Expect noticeable first-frame delay on hardware.`,
    });
  }
  if (summary.bridge.failed > 0) {
    issues.push({
      severity: "error",
      code: "bridge_send_failures",
      message: `Bridge send failures detected (${summary.bridge.failed}).`,
    });
  }
  if (summary.bridge.weightedAvgSendMs > 120) {
    issues.push({
      severity: "warn",
      code: "bridge_avg_send_high",
      message: `Bridge weighted avg send is ${summary.bridge.weightedAvgSendMs.toFixed(1)}ms (>120ms).`,
    });
  }
  if (summary.bridge.maxSendMs > 250) {
    issues.push({
      severity: "warn",
      code: "bridge_max_send_high",
      message: `Bridge max send spike is ${summary.bridge.maxSendMs.toFixed(1)}ms (>250ms). Likely cold-start or transient SDK stall.`,
    });
  }
  if (
    summary.bridge.minSendMs > 0 &&
    summary.bridge.maxSendMs > 0 &&
    summary.bridge.maxSendMs / summary.bridge.minSendMs > 2.5
  ) {
    issues.push({
      severity: "info",
      code: "bridge_send_spike_spread",
      message: `Bridge send spread is ${(summary.bridge.maxSendMs / summary.bridge.minSendMs).toFixed(1)}x (max=${summary.bridge.maxSendMs.toFixed(1)}ms min=${summary.bridge.minSendMs.toFixed(1)}ms). Average is pulled by outlier spikes rather than consistent baseline.`,
    });
  }
  if (summary.bridge.maxQueueMs > 100) {
    issues.push({
      severity: "warn",
      code: "bridge_queue_spikes",
      message: `Bridge queue delay spikes to ${summary.bridge.maxQueueMs.toFixed(1)}ms (>100ms).`,
    });
  }
  if (summary.input.eventP95SetupMs > 10) {
    issues.push({
      severity: "warn",
      code: "setup_spikes_during_input",
      message: `Input path setup p95 is ${summary.input.eventP95SetupMs.toFixed(1)}ms (>10ms).`,
    });
  }
  if (
    summary.render.weightedAvgInputToRenderMs > 200 &&
    summary.input.eventP95InputToRenderMs < 10 &&
    summary.input.events > 0
  ) {
    issues.push({
      severity: "warn",
      code: "input_latency_aggregation_bias",
      message:
        "Render aggregate input->render includes stale tick frames; use per-input event latency as primary tuning metric.",
    });
  }

  return { summary, issues };
}

function printReport(logPath, analysis) {
  const { summary, issues } = analysis;
  console.log(`Analyzed: ${path.resolve(logPath)}`);
  const minSendLabel = summary.bridge.minSendMs > 0 ? ` min=${summary.bridge.minSendMs.toFixed(1)}ms` : "";
  console.log(
    `Startup setup: ${summary.startup.setupMs.toFixed(1)}ms | Bridge avg send: ${summary.bridge.weightedAvgSendMs.toFixed(1)}ms max=${summary.bridge.maxSendMs.toFixed(1)}ms${minSendLabel} | Bridge max queue: ${summary.bridge.maxQueueMs.toFixed(1)}ms`,
  );
  console.log(
    `Render avg build/setup/enqueue: ${summary.render.weightedAvgBuildMs.toFixed(2)} / ${summary.render.weightedAvgSetupMs.toFixed(2)} / ${summary.render.weightedAvgEnqueueMs.toFixed(2)} ms`,
  );
  console.log(
    `Input p95 input->render/setup/enqueue: ${summary.input.eventP95InputToRenderMs.toFixed(2)} / ${summary.input.eventP95SetupMs.toFixed(2)} / ${summary.input.eventP95EnqueueMs.toFixed(2)} ms`,
  );
  console.log(
    `Input mapped=${summary.input.mapped} dropped=${summary.input.dropped} dropRate=${(summary.input.dropRate * 100).toFixed(2)}%`,
  );

  if (issues.length === 0) {
    console.log("Issues: none detected by current heuristics.");
    return;
  }
  console.log("Issues:");
  for (const issue of issues) {
    console.log(`- [${issue.severity}] ${issue.code}: ${issue.message}`);
  }
}

function main() {
  const { logPath, jsonOut, strict } = parseCli(process.argv);
  const raw = fs.readFileSync(logPath, "utf8");
  const analysis = parsePerfLog(raw);
  printReport(logPath, analysis);

  if (jsonOut) {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          sourceLog: path.resolve(logPath),
          ...analysis,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log(`Wrote summary JSON: ${path.resolve(jsonOut)}`);
  }

  if (strict && analysis.issues.some((issue) => issue.severity === "error" || issue.severity === "warn")) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parsePerfLog,
};
