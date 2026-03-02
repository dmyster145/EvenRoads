const test = require("node:test");
const assert = require("node:assert/strict");

const { OsEventTypeList } = require("@evenrealities/even_hub_sdk");
const { setPerfNowProvider, resetPerfLogState } = require("../../.test-dist/perf/log.js");
const { resetInputMapperStateForTests } = require("../../.test-dist/input/mapper.js");

function flushMicrotasks(rounds = 12) {
  let chain = Promise.resolve();
  for (let i = 0; i < rounds; i++) {
    chain = chain.then(() => Promise.resolve());
  }
  return chain;
}

function createBrowserHarness(initialStorage = {}) {
  const listeners = new Map();
  const app = { textContent: "" };
  const status = { textContent: "" };
  const storageData = new Map(
    Object.entries({
      "evenroads.displayProfile": "device",
      ...initialStorage,
    }),
  );
  const localStorage = {
    getItem(key) {
      return storageData.has(key) ? storageData.get(key) : null;
    },
    setItem(key, value) {
      storageData.set(key, String(value));
    },
    removeItem(key) {
      storageData.delete(key);
    },
  };

  const window = {
    localStorage,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type, event) {
      const group = listeners.get(type);
      if (!group) return;
      for (const handler of [...group]) {
        handler(event);
      }
    },
  };

  const document = {
    getElementById(id) {
      if (id === "app") return app;
      if (id === "status") return status;
      return null;
    },
  };

  return { window, document, app, status, listeners };
}

function playerXFromBottomRow(boardText) {
  const lines = boardText.split("\n");
  const bottomRow = lines[lines.length - 1] ?? "";
  const aliveX = bottomRow.indexOf("▲");
  const crashedX = bottomRow.indexOf("※");
  return aliveX >= 0 ? aliveX : crashedX;
}

function installTimerHarness() {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let nextId = 0;
  const timers = new Map();

  global.setTimeout = (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, delay });
    return id;
  };

  global.clearTimeout = (id) => {
    timers.delete(id);
  };

  return {
    restore() {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    },
  };
}

function makeFakeBridgeClass(config = {}) {
  const setupResults = [...(config.setupPageResults ?? [true])];
  const updateResults = [...(config.updateTextResults ?? [])];
  const instances = [];

  class FakeRoadsBridge {
    constructor() {
      this.initCalls = 0;
      this.setupPageCalls = [];
      this.updateTextCalls = [];
      this.shutdownCalls = 0;
      this.eventHandler = null;
      instances.push(this);
    }

    isTransportBusy() {
      return false;
    }

    async init() {
      this.initCalls += 1;
    }

    async setupPage(page) {
      this.setupPageCalls.push(page);
      if (setupResults.length > 0) return setupResults.shift();
      return true;
    }

    async updateText(containerID, containerName, content, priority) {
      this.updateTextCalls.push({ containerID, containerName, content, priority });
      if (updateResults.length > 0) return updateResults.shift();
      return true;
    }

    subscribeEvents(handler) {
      this.eventHandler = handler;
    }

    emit(event) {
      this.eventHandler?.(event);
    }

    async shutdown() {
      this.shutdownCalls += 1;
    }
  }

  FakeRoadsBridge.instances = instances;
  return FakeRoadsBridge;
}

function loadInitWithBridgeClass(BridgeClass) {
  const bridgePath = require.resolve("../../.test-dist/evenhub/bridge.js");
  const initPath = require.resolve("../../.test-dist/app/init.js");
  const bridgeModule = require(bridgePath);
  const originalBridgeClass = bridgeModule.RoadsBridge;

  delete require.cache[initPath];
  bridgeModule.RoadsBridge = BridgeClass;
  const { initApp } = require(initPath);

  return {
    initApp,
    restore() {
      delete require.cache[initPath];
      bridgeModule.RoadsBridge = originalBridgeClass;
    },
  };
}

function withPerfClock(run) {
  let now = 1000;
  setPerfNowProvider(() => now);
  resetPerfLogState();
  resetInputMapperStateForTests();

  const clock = {
    advance(ms) {
      now += ms;
    },
  };

  return Promise.resolve()
    .then(() => run(clock))
    .finally(() => {
      setPerfNowProvider(null);
      resetPerfLogState();
      resetInputMapperStateForTests();
    });
}

test("initApp wires startup render, SDK input, and unload cleanup", async () => {
  await withPerfClock(async (clock) => {
    const browser = createBrowserHarness();
    const timerHarness = installTimerHarness();
    const originalWindow = global.window;
    const originalDocument = global.document;
    global.window = browser.window;
    global.document = browser.document;

    const FakeBridge = makeFakeBridgeClass();
    const { initApp, restore } = loadInitWithBridgeClass(FakeBridge);

    try {
      await initApp();
      await flushMicrotasks();

      const bridge = FakeBridge.instances[0];
      assert.ok(bridge, "expected bridge instance");
      assert.equal(bridge.initCalls, 1);
      assert.equal(bridge.setupPageCalls.length >= 1, true, "expected startup page setup");
      assert.match(browser.app.textContent, /Score:/);
      assert.match(browser.status.textContent, /State:/);
      assert.equal(bridge.updateTextCalls.length >= 1, true, "expected at least one device text enqueue");
      assert.ok(bridge.eventHandler, "expected SDK event subscription");

      const updateCountBeforeInput = bridge.updateTextCalls.length;
      let preventDefaultCalls = 0;
      browser.window.dispatch("keydown", {
        key: "p",
        repeat: false,
        preventDefault() {
          preventDefaultCalls += 1;
        },
      });
      await flushMicrotasks();

      assert.equal(bridge.updateTextCalls.length > updateCountBeforeInput, true, "input should enqueue render");
      const latestUpdate = bridge.updateTextCalls[bridge.updateTextCalls.length - 1];
      assert.equal(latestUpdate.priority, "input");
      assert.match(browser.status.textContent, /PAUSED/);
      assert.equal(preventDefaultCalls, 1);

      assert.equal(browser.listeners.get("beforeunload")?.size ?? 0, 1);
      browser.window.dispatch("beforeunload", {});
      await flushMicrotasks(4);
      assert.equal(bridge.shutdownCalls, 1);
      assert.equal(browser.listeners.get("keydown")?.size ?? 0, 0);
    } finally {
      restore();
      timerHarness.restore();
      global.window = originalWindow;
      global.document = originalDocument;
    }
  });
});

test("initApp retries failed page setup only after retry window", async () => {
  await withPerfClock(async (clock) => {
    const browser = createBrowserHarness();
    const timerHarness = installTimerHarness();
    const originalWindow = global.window;
    const originalDocument = global.document;
    global.window = browser.window;
    global.document = browser.document;

    const FakeBridge = makeFakeBridgeClass({
      setupPageResults: [false, true],
    });
    const { initApp, restore } = loadInitWithBridgeClass(FakeBridge);

    try {
      await initApp();
      await flushMicrotasks();

      const bridge = FakeBridge.instances[0];
      assert.equal(bridge.setupPageCalls.length, 1, "first setup attempt should run immediately");

      clock.advance(100);
      bridge.emit({
        textEvent: {
          containerID: 1,
          containerName: "evt",
          eventType: OsEventTypeList.CLICK_EVENT,
        },
      });
      await flushMicrotasks();
      assert.equal(bridge.setupPageCalls.length, 1, "should not retry before backoff window");

      clock.advance(1600);
      bridge.emit({
        textEvent: {
          containerID: 1,
          containerName: "evt",
          eventType: OsEventTypeList.CLICK_EVENT,
        },
      });
      await flushMicrotasks();
      assert.equal(bridge.setupPageCalls.length, 2, "should retry setup after backoff expires");
      assert.equal(bridge.updateTextCalls.length >= 1, true, "should enqueue text once setup succeeds");
    } finally {
      restore();
      timerHarness.restore();
      global.window = originalWindow;
      global.document = originalDocument;
    }
  });
});

test("initApp reset event clears score/best and restarts at a new home column", async () => {
  await withPerfClock(async () => {
    const browser = createBrowserHarness({ "evenroads.bestScore": "42" });
    const timerHarness = installTimerHarness();
    const originalWindow = global.window;
    const originalDocument = global.document;
    const originalDateNow = Date.now;
    Date.now = () => 1000;
    global.window = browser.window;
    global.document = browser.document;

    const FakeBridge = makeFakeBridgeClass();
    const { initApp, restore } = loadInitWithBridgeClass(FakeBridge);

    try {
      await initApp();
      await flushMicrotasks();

      assert.match(browser.status.textContent, /Best:\s*42/i);
      const beforeResetX = playerXFromBottomRow(browser.app.textContent);
      assert.equal(beforeResetX >= 0, true, "expected player glyph before reset");

      browser.window.dispatch("evenroads:reset-best-score", {});
      await flushMicrotasks();

      assert.match(browser.status.textContent, /Score:\s*00/i);
      assert.match(browser.status.textContent, /Best:\s*00/i);
      assert.equal(browser.window.localStorage.getItem("evenroads.bestScore"), "0");
      const afterResetX = playerXFromBottomRow(browser.app.textContent);
      assert.equal(afterResetX >= 0, true, "expected player glyph after reset");
      assert.notEqual(afterResetX, beforeResetX, "expected new run to spawn at a different home column");
    } finally {
      restore();
      timerHarness.restore();
      Date.now = originalDateNow;
      global.window = originalWindow;
      global.document = originalDocument;
    }
  });
});

test("initApp simulator profile clamps right movement to visible board edge", async () => {
  await withPerfClock(async () => {
    const browser = createBrowserHarness({ "evenroads.displayProfile": "simulator" });
    const timerHarness = installTimerHarness();
    const originalWindow = global.window;
    const originalDocument = global.document;
    global.window = browser.window;
    global.document = browser.document;

    const FakeBridge = makeFakeBridgeClass();
    const { initApp, restore } = loadInitWithBridgeClass(FakeBridge);

    try {
      await initApp();
      await flushMicrotasks();

      for (let i = 0; i < 64; i++) {
        browser.window.dispatch("keydown", {
          key: "ArrowRight",
          repeat: false,
          preventDefault() {},
        });
      }
      await flushMicrotasks();

      const lines = browser.app.textContent.split("\n");
      const bottomRow = lines[lines.length - 1] ?? "";
      const playerX = playerXFromBottomRow(browser.app.textContent);
      assert.equal(playerX >= 0, true, "expected visible player glyph");
      assert.equal(playerX, bottomRow.length - 1, "expected player clamped at visible right edge");
    } finally {
      restore();
      timerHarness.restore();
      global.window = originalWindow;
      global.document = originalDocument;
    }
  });
});
