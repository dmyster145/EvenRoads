const test = require("node:test");
const assert = require("node:assert/strict");

const { RoadsBridge } = require("../../.test-dist/evenhub/bridge.js");
const {
  setPerfNowProvider,
  resetPerfLogState,
  isPerfLoggingEnabled,
} = require("../../.test-dist/perf/log.js");

function createFakeBridge(options = {}) {
  const sent = [];
  const delayMs = options.delayMs ?? 0;
  const setupResult = options.setupResult ?? 0;
  const setupError = options.setupError ?? null;
  const subscribeError = options.subscribeError ?? null;
  const shutdownError = options.shutdownError ?? null;
  const textError = options.textError ?? null;
  const textErrorOnce = options.textErrorOnce ?? false;
  let didThrowTextError = false;
  let handler = null;

  return {
    sent,
    async createStartUpPageContainer() {
      if (setupError) throw setupError;
      return setupResult;
    },
    async textContainerUpgrade(payload) {
      if (textError && (!textErrorOnce || !didThrowTextError)) {
        didThrowTextError = true;
        throw textError;
      }
      sent.push(payload.content);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return true;
    },
    onEvenHubEvent(next) {
      if (subscribeError) throw subscribeError;
      handler = next;
      return () => {
        handler = null;
      };
    },
    emit(event) {
      if (handler) handler(event);
    },
    async shutDownPageContainer() {
      if (shutdownError) throw shutdownError;
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

test("setupPage returns false when sdk bridge is missing", async () => {
  const roadsBridge = new RoadsBridge();
  const ok = await roadsBridge.setupPage({});
  assert.equal(ok, false);
});

test("setupPage returns false when sdk returns non-zero", async () => {
  const roadsBridge = new RoadsBridge();
  const fake = createFakeBridge({ setupResult: 9 });
  attachBridgeInstance(roadsBridge, fake);

  const ok = await roadsBridge.setupPage({});
  assert.equal(ok, false);
});

test("setupPage returns false when sdk throws", async () => {
  const roadsBridge = new RoadsBridge();
  const fake = createFakeBridge({ setupError: new Error("setup failed") });
  attachBridgeInstance(roadsBridge, fake);

  const ok = await roadsBridge.setupPage({});
  assert.equal(ok, false);
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

test("updateText returns false when sdk bridge is missing", async () => {
  const roadsBridge = new RoadsBridge();
  const ok = await roadsBridge.updateText(2, "screen", "frame");
  assert.equal(ok, false);
});

test("updateText returns false when transport throws", async () => {
  const roadsBridge = new RoadsBridge();
  const fake = createFakeBridge({
    textError: new Error("send failed"),
    textErrorOnce: true,
  });
  attachBridgeInstance(roadsBridge, fake);

  const ok = await roadsBridge.updateText(2, "screen", "frame");
  assert.equal(ok, false);
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
  const perfEnabled = isPerfLoggingEnabled();
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

      assert.equal(fake.sent.length, 26, "expected all queued updates to reach bridge transport");
    });

    if (perfEnabled) {
      assert.equal(logs.length >= 1, true, "expected at least one bridge stats log line");
      const firstLog = logs[0];
      assert.match(firstLog, /minSend=[0-9.]+ms/, "stats should include minSend field");
    } else {
      assert.equal(logs.length, 0, "expected no bridge perf logs when perf logging is disabled");
    }
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

test("subscribeEvents swallows sdk subscription errors", () => {
  const roadsBridge = new RoadsBridge();
  const fake = createFakeBridge({ subscribeError: new Error("subscribe failed") });
  attachBridgeInstance(roadsBridge, fake);

  assert.doesNotThrow(() => {
    roadsBridge.subscribeEvents(() => {});
  });
});

test("shutdown swallows sdk shutdown errors", async () => {
  const roadsBridge = new RoadsBridge();
  const fake = createFakeBridge({ shutdownError: new Error("shutdown failed") });
  attachBridgeInstance(roadsBridge, fake);

  await assert.doesNotReject(async () => {
    await roadsBridge.shutdown();
  });
});

test("shutdown during in-flight send drops queued update without rejection", async () => {
  const roadsBridge = new RoadsBridge();
  const fake = createFakeBridge({ delayMs: 10 });
  attachBridgeInstance(roadsBridge, fake);

  const p1 = roadsBridge.updateText(2, "screen", "frame-a");
  const p2 = roadsBridge.updateText(2, "screen", "frame-b");
  const shutdown = roadsBridge.shutdown();

  await assert.doesNotReject(async () => {
    await Promise.all([p1, p2, shutdown]);
  });

  assert.deepEqual(fake.sent, ["frame-a"]);
});
