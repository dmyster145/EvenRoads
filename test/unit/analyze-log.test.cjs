const test = require("node:test");
const assert = require("node:assert/strict");

const { parsePerfLog } = require("../../scripts/perf/analyze-log.cjs");

test("parsePerfLog extracts minSend from bridge stats when present", () => {
  const log = [
    "[EvenRoads][Perf][Bridge] setupPage=100.0ms",
    "[EvenRoads][Perf][Bridge] sends=10 avgSend=120.0ms maxSend=200.0ms minSend=80.0ms avgQueue=1.0ms maxQueue=5.0ms coalesced=0 skippedSame=0 droppedLowPri=0 dropRecentInputTick=0 failed=0",
  ].join("\n");

  const { summary } = parsePerfLog(log);
  assert.equal(summary.bridge.minSendMs, 80);
  assert.equal(summary.bridge.maxSendMs, 200);
});

test("parsePerfLog handles logs without minSend field (backward compat)", () => {
  const log = [
    "[EvenRoads][Perf][Bridge] setupPage=100.0ms",
    "[EvenRoads][Perf][Bridge] sends=5 avgSend=130.0ms maxSend=180.0ms avgQueue=2.0ms maxQueue=10.0ms coalesced=0 skippedSame=0 droppedLowPri=0 dropRecentInputTick=0 failed=0",
  ].join("\n");

  const { summary } = parsePerfLog(log);
  assert.equal(summary.bridge.minSendMs, 0);
  assert.equal(summary.bridge.maxSendMs, 180);
});

test("bridge_max_send_high fires when maxSendMs > 250", () => {
  const log = [
    "[EvenRoads][Perf][Bridge] setupPage=100.0ms",
    "[EvenRoads][Perf][Bridge] sends=10 avgSend=130.0ms maxSend=300.0ms minSend=90.0ms avgQueue=1.0ms maxQueue=5.0ms coalesced=0 skippedSame=0 droppedLowPri=0 dropRecentInputTick=0 failed=0",
  ].join("\n");

  const { issues } = parsePerfLog(log);
  const maxSendIssue = issues.find((i) => i.code === "bridge_max_send_high");
  assert.ok(maxSendIssue, "should flag bridge_max_send_high");
  assert.match(maxSendIssue.message, /300\.0ms/);
});

test("bridge_send_spike_spread fires when max/min ratio > 2.5", () => {
  const log = [
    "[EvenRoads][Perf][Bridge] setupPage=100.0ms",
    "[EvenRoads][Perf][Bridge] sends=10 avgSend=130.0ms maxSend=300.0ms minSend=80.0ms avgQueue=1.0ms maxQueue=5.0ms coalesced=0 skippedSame=0 droppedLowPri=0 dropRecentInputTick=0 failed=0",
  ].join("\n");

  const { issues } = parsePerfLog(log);
  const spreadIssue = issues.find((i) => i.code === "bridge_send_spike_spread");
  assert.ok(spreadIssue, "should flag bridge_send_spike_spread");
  assert.match(spreadIssue.message, /3\.8x/);
});

test("bridge_send_spike_spread does not fire when spread is narrow", () => {
  const log = [
    "[EvenRoads][Perf][Bridge] setupPage=100.0ms",
    "[EvenRoads][Perf][Bridge] sends=10 avgSend=110.0ms maxSend=130.0ms minSend=90.0ms avgQueue=1.0ms maxQueue=5.0ms coalesced=0 skippedSame=0 droppedLowPri=0 dropRecentInputTick=0 failed=0",
  ].join("\n");

  const { issues } = parsePerfLog(log);
  const spreadIssue = issues.find((i) => i.code === "bridge_send_spike_spread");
  assert.equal(spreadIssue, undefined, "should not flag narrow spread");
});
