const test = require("node:test");
const assert = require("node:assert/strict");

const { RoadsBridge } = require("../../.test-dist/evenhub/bridge.js");
const { setPerfNowProvider, resetPerfLogState } = require("../../.test-dist/perf/log.js");

function createFakeBridge(options = {}) {
  const sent = [];
  const delayMs = options.delayMs ?? 0;
  let handler = null;

  return {
    sent,
    async createStartUpPageContainer() {
      return 0;
    },
    async textContainerUpgrade(payload) {
      sent.push(payload.content);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return true;
    },
    onEvenHubEvent(next) {
      handler = next;
      return () => {
        handler = null;
      };
    },
    emit(event) {
      if (handler) handler(event);
    },
    async shutDownPageContainer() {
      return true;
    },
  };
}

function attachBridgeInstance(roadsBridge, fakeBridge) {
  roadsBridge.bridge = fakeBridge;
}

async function withFakeClock(run) {
  let now = 1000;
  setPerfNowProvider(() => now);
  resetPerfLogState();
  const clock = {
    set(value) {
      now = value;
    },
    advance(delta) {
      now += delta;
    },
  };
  try {
    await run(clock);
  } finally {
    setPerfNowProvider(null);
    resetPerfLogState();
  }
}

test("setupPage delegates to sdk bridge", async () => {
  const roadsBridge = new RoadsBridge();
  const fake = createFakeBridge();
  attachBridgeInstance(roadsBridge, fake);

  const ok = await roadsBridge.setupPage({});
  assert.equal(ok, true);
});

test("updateText coalesces in-flight updates and sends latest payload", async () => {
  const roadsBridge = new RoadsBridge();
  const fake = createFakeBridge({ delayMs: 8 });
  attachBridgeInstance(roadsBridge, fake);

  const p1 = roadsBridge.updateText(2, "screen", "A");
  const p2 = roadsBridge.updateText(2, "screen", "B");
  const p3 = roadsBridge.updateText(2, "screen", "C");

  await Promise.all([p1, p2, p3]);
  assert.deepEqual(fake.sent, ["A", "C"]);
});

test("high-priority input update is not displaced by lower-priority tick update", async () => {
  const roadsBridge = new RoadsBridge();
  const fake = createFakeBridge({ delayMs: 8 });
  attachBridgeInstance(roadsBridge, fake);

  const p1 = roadsBridge.updateText(2, "screen", "tick-0", "tick");
  const p2 = roadsBridge.updateText(2, "screen", "input-1", "input");
  const p3 = roadsBridge.updateText(2, "screen", "tick-2", "tick");

  await Promise.all([p1, p2, p3]);
  assert.deepEqual(fake.sent, ["tick-0", "input-1"]);
});

test("in-flight duplicate payload cancels stale queued update", async () => {
  const roadsBridge = new RoadsBridge();
  const fake = createFakeBridge({ delayMs: 8 });
  attachBridgeInstance(roadsBridge, fake);

  const p1 = roadsBridge.updateText(2, "screen", "state-A", "tick");
  const p2 = roadsBridge.updateText(2, "screen", "state-B", "input");
  const p3 = roadsBridge.updateText(2, "screen", "state-A", "tick");

  await Promise.all([p1, p2, p3]);
  assert.deepEqual(fake.sent, ["state-A"]);
});

test("updateText skips unchanged content while idle", async () => {
  const roadsBridge = new RoadsBridge();
  const fake = createFakeBridge();
  attachBridgeInstance(roadsBridge, fake);

  await roadsBridge.updateText(2, "screen", "same");
  await roadsBridge.updateText(2, "screen", "same");
  await roadsBridge.updateText(2, "screen", "different");

  assert.deepEqual(fake.sent, ["same", "different"]);
});

test("recent input suppresses near-term tick update", async () => {
  await withFakeClock(async (clock) => {
    const roadsBridge = new RoadsBridge();
    const fake = createFakeBridge();
    attachBridgeInstance(roadsBridge, fake);

    await roadsBridge.updateText(2, "screen", "input-0", "input");
    clock.advance(20);
    await roadsBridge.updateText(2, "screen", "tick-1", "tick");
    clock.advance(90);
    await roadsBridge.updateText(2, "screen", "tick-2", "tick");

    assert.deepEqual(fake.sent, ["input-0", "tick-2"]);
  });
});

test("transport stats track minSend across sends", async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => {
    const msg = args.join(" ");
    if (msg.includes("[Perf][Bridge]") && msg.includes("sends=")) logs.push(msg);
  };

  try {
    await withFakeClock(async (clock) => {
      const roadsBridge = new RoadsBridge();
      const fake = createFakeBridge({ delayMs: 1 });
      attachBridgeInstance(roadsBridge, fake);

      // Send enough to trigger stats logging (BRIDGE_STATS_LOG_MIN_SENDS = 24).
      for (let i = 0; i < 25; i++) {
        clock.advance(1);
        await roadsBridge.updateText(2, "screen", `frame-${i}`);
      }

      // Force remaining stats flush.
      clock.advance(5000);
      await roadsBridge.updateText(2, "screen", "flush");
    });

    assert.equal(logs.length >= 1, true, "expected at least one bridge stats log line");
    const firstLog = logs[0];
    assert.match(firstLog, /minSend=[0-9.]+ms/, "stats should include minSend field");
  } finally {
    console.log = origLog;
  }
});

test("subscribeEvents wires and unwires callback", () => {
  const roadsBridge = new RoadsBridge();
  const fake = createFakeBridge();
  attachBridgeInstance(roadsBridge, fake);

  let calls = 0;
  roadsBridge.subscribeEvents(() => {
    calls += 1;
  });
  fake.emit({ sysEvent: { eventType: 0 } });
  assert.equal(calls, 1);
});
