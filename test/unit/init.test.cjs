const test = require("node:test");
const assert = require("node:assert/strict");

const { OsEventTypeList } = require("@evenrealities/even_hub_sdk");
const { LAUNCH_SOURCE_EVENT } = require("../../.test-dist/companion/contracts.js");
const { setPerfNowProvider, resetPerfLogState } = require("../../.test-dist/perf/log.js");
const { resetInputMapperState } = require("../../.test-dist/input/mapper.js");

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
  const bodyAttributes = new Map();
  const storageData = new Map(
    Object.entries({
      "hoppyroads.displayProfile": "device",
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
  window.dispatchEvent = (event) => {
    if (!event?.type) return true;
    window.dispatch(event.type, event);
    return true;
  };

  const body = {
    setAttribute(name, value) {
      bodyAttributes.set(name, String(value));
    },
    getAttribute(name) {
      return bodyAttributes.has(name) ? bodyAttributes.get(name) : null;
    },
  };

  const document = {
    body,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    getElementById(id) {
      if (id === "app") return app;
      if (id === "status") return status;
      return null;
    },
  };

  return {
    window,
    document,
    app,
    status,
    listeners,
    body,
  };
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
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let nextId = 0;
  const timers = new Map();
  const intervals = new Map();

  global.setTimeout = (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, delay });
    return id;
  };

  global.clearTimeout = (id) => {
    timers.delete(id);
  };

  global.setInterval = (callback, delay) => {
    const id = ++nextId;
    intervals.set(id, { callback, delay });
    return id;
  };

  global.clearInterval = (id) => {
    intervals.delete(id);
  };

  return {
    fireNextTimer() {
      const iterator = timers.entries().next();
      if (iterator.done) return false;
      const [id, { callback }] = iterator.value;
      timers.delete(id);
      callback();
      return true;
    },
    pendingTimers() {
      return timers.size;
    },
    pendingIntervals() {
      return intervals.size;
    },
    restore() {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      timers.clear();
      intervals.clear();
    },
  };
}

/**
 * Drop-in fake for the new RoadsBridge facade. Exposes `.transport` with the
 * timeout-wrapped surface used by the runtime + controller, plus the
 * `.subscribe()` callback bundle for lifecycle/input/connection.
 */
function makeFakeBridgeClass(config = {}) {
  const setupResults = [...(config.setupPageResults ?? ["ok"])];
  const rebuildResults = [...(config.rebuildPageResults ?? ["ok"])];
  const updateResults = [...(config.updateTextResults ?? [])];
  const instances = [];

  class FakeRoadsBridge {
    constructor() {
      this.initCalls = 0;
      this.setupPageCalls = [];
      this.rebuildPageCalls = [];
      this.updateTextCalls = [];
      this.shutdownCalls = 0;
      this.shutdownPageCalls = 0;
      this.subscriptions = null;
      this.launchSourceHandler = null;
      this.degradedListeners = new Set();

      this.transport = {
        setupPage: async (page) => {
          this.setupPageCalls.push(page);
          if (setupResults.length > 0) return setupResults.shift();
          return "ok";
        },
        rebuildPage: async (page) => {
          this.rebuildPageCalls.push(page);
          if (rebuildResults.length > 0) return rebuildResults.shift();
          return "ok";
        },
        updateText: async (containerID, containerName, content, priority) => {
          this.updateTextCalls.push({ containerID, containerName, content, priority });
          if (updateResults.length > 0) return updateResults.shift();
          return true;
        },
        shutdownPage: async () => {
          this.shutdownPageCalls += 1;
        },
        // Mirror SDK storage into the browser harness so tests that seed
        // localStorage observe the same values via the bridge.
        writeStorage: async (key, value) => {
          try {
            globalThis.window?.localStorage?.setItem(key, value);
          } catch {
            // ignore
          }
        },
        readStorage: async (key) => {
          try {
            return globalThis.window?.localStorage?.getItem(key) ?? null;
          } catch {
            return null;
          }
        },
        discardInFlight: () => {},
        dropQueue: () => {},
        resetDegraded: () => {},
        flushStats: () => {},
        onDegraded: (fn) => {
          this.degradedListeners.add(fn);
          return () => this.degradedListeners.delete(fn);
        },
        isBusy: () => false,
      };

      instances.push(this);
    }

    hasBridge() {
      return true;
    }

    async init() {
      this.initCalls += 1;
    }

    subscribe(subs) {
      this.subscriptions = subs;
    }

    getConnectionState() {
      return "unknown";
    }

    subscribeLaunchSource(handler) {
      this.launchSourceHandler = handler;
      return () => {
        if (this.launchSourceHandler === handler) this.launchSourceHandler = null;
      };
    }

    emitInput(event) {
      this.subscriptions?.onInput?.(event);
    }

    emitLifecycle(name) {
      this.subscriptions?.onLifecycle?.(name);
    }

    emitConnection(state) {
      this.subscriptions?.onConnection?.(state, null);
    }

    emitLaunchSource(source) {
      this.launchSourceHandler?.(source);
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
  const controllerPath = require.resolve("../../.test-dist/app/lifecycle-controller.js");
  const bridgeModule = require(bridgePath);
  const originalBridgeClass = bridgeModule.RoadsBridge;

  // Force reload so the swapped class wins.
  delete require.cache[initPath];
  delete require.cache[controllerPath];
  bridgeModule.RoadsBridge = BridgeClass;
  const { initApp } = require(initPath);

  return {
    initApp,
    restore() {
      delete require.cache[initPath];
      delete require.cache[controllerPath];
      bridgeModule.RoadsBridge = originalBridgeClass;
    },
  };
}

function withPerfClock(run) {
  let now = 1000;
  setPerfNowProvider(() => now);
  resetPerfLogState();
  resetInputMapperState();

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
      resetInputMapperState();
    });
}

test("initApp wires startup render, SDK input, and pagehide cleanup", async () => {
  await withPerfClock(async () => {
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
      assert.ok(bridge.subscriptions, "expected lifecycle subscriptions");
      assert.equal(typeof bridge.subscriptions.onInput, "function");

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

      // pagehide replaces beforeunload as the iOS-safe lifecycle hook.
      assert.equal(browser.listeners.get("pagehide")?.size ?? 0, 1);

      bridge.emitLifecycle("abnormalExit");
      await flushMicrotasks();
    } finally {
      restore();
      timerHarness.restore();
      global.window = originalWindow;
      global.document = originalDocument;
    }
  });
});

test("initApp retries failed page setup with exponential backoff", async () => {
  await withPerfClock(async () => {
    const browser = createBrowserHarness();
    const timerHarness = installTimerHarness();
    const originalWindow = global.window;
    const originalDocument = global.document;
    global.window = browser.window;
    global.document = browser.document;

    const FakeBridge = makeFakeBridgeClass({
      setupPageResults: ["retry"],
      rebuildPageResults: ["ok"],
    });
    const { initApp, restore } = loadInitWithBridgeClass(FakeBridge);

    try {
      await initApp();
      await flushMicrotasks();

      const bridge = FakeBridge.instances[0];
      assert.equal(bridge.setupPageCalls.length, 1, "first setup attempt runs immediately");
      assert.equal(bridge.rebuildPageCalls.length, 0, "rebuild only on attempt 2+");
      assert.equal(timerHarness.pendingTimers() >= 1, true, "expected a retry timer pending");

      // Fire the retry timer manually so we don't have to wait 500ms real time.
      timerHarness.fireNextTimer();
      await flushMicrotasks();

      assert.equal(
        bridge.rebuildPageCalls.length,
        1,
        "second attempt uses rebuildPage (createStartUp is one-shot)",
      );
      assert.equal(bridge.updateTextCalls.length >= 1, true, "should enqueue text once setup succeeds");

      bridge.emitLifecycle("abnormalExit");
      await flushMicrotasks();
    } finally {
      restore();
      timerHarness.restore();
      global.window = originalWindow;
      global.document = originalDocument;
    }
  });
});

test("reset best score event clears score/best and restarts at a new home column", async () => {
  await withPerfClock(async () => {
    const browser = createBrowserHarness({ "hoppyroads.bestScore": "42" });
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

      browser.window.dispatch("hoppyroads:reset-best-score", {});
      await flushMicrotasks();

      assert.match(browser.status.textContent, /Score:\s*00/i);
      assert.match(browser.status.textContent, /Best:\s*00/i);
      const afterResetX = playerXFromBottomRow(browser.app.textContent);
      assert.equal(afterResetX >= 0, true, "expected player glyph after reset");
      assert.notEqual(afterResetX, beforeResetX, "expected new run to spawn at a different home column");

      const bridge = FakeBridge.instances[0];
      bridge.emitLifecycle("abnormalExit");
      await flushMicrotasks();
    } finally {
      restore();
      timerHarness.restore();
      Date.now = originalDateNow;
      global.window = originalWindow;
      global.document = originalDocument;
    }
  });
});

test("simulator profile clamps right movement to visible board edge", async () => {
  await withPerfClock(async () => {
    const browser = createBrowserHarness({ "hoppyroads.displayProfile": "simulator" });
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

      const bridge = FakeBridge.instances[0];
      bridge.emitLifecycle("abnormalExit");
      await flushMicrotasks();
    } finally {
      restore();
      timerHarness.restore();
      global.window = originalWindow;
      global.document = originalDocument;
    }
  });
});

test("initApp surfaces app-menu launch source in the help shell", async () => {
  await withPerfClock(async () => {
    const browser = createBrowserHarness();
    const timerHarness = installTimerHarness();
    const launchEvents = [];
    const originalWindow = global.window;
    const originalDocument = global.document;
    global.window = browser.window;
    global.document = browser.document;

    const FakeBridge = makeFakeBridgeClass();
    const { initApp, restore } = loadInitWithBridgeClass(FakeBridge);

    try {
      browser.window.addEventListener(LAUNCH_SOURCE_EVENT, (event) => {
        launchEvents.push(event.detail?.launchSource ?? null);
      });
      await initApp();
      await flushMicrotasks();

      const bridge = FakeBridge.instances[0];
      bridge.emitLaunchSource("appMenu");
      await flushMicrotasks();

      assert.equal(browser.body.getAttribute("data-launch-source"), "appMenu");
      assert.deepEqual(launchEvents, ["appMenu"]);

      bridge.emitLifecycle("abnormalExit");
      await flushMicrotasks();
    } finally {
      restore();
      timerHarness.restore();
      global.window = originalWindow;
      global.document = originalDocument;
    }
  });
});

test("initApp surfaces glasses-menu launch source in the help shell", async () => {
  await withPerfClock(async () => {
    const browser = createBrowserHarness();
    const timerHarness = installTimerHarness();
    const launchEvents = [];
    const originalWindow = global.window;
    const originalDocument = global.document;
    global.window = browser.window;
    global.document = browser.document;

    const FakeBridge = makeFakeBridgeClass();
    const { initApp, restore } = loadInitWithBridgeClass(FakeBridge);

    try {
      browser.window.addEventListener(LAUNCH_SOURCE_EVENT, (event) => {
        launchEvents.push(event.detail?.launchSource ?? null);
      });
      await initApp();
      await flushMicrotasks();

      const bridge = FakeBridge.instances[0];
      bridge.emitLaunchSource("glassesMenu");
      await flushMicrotasks();

      assert.equal(browser.body.getAttribute("data-launch-source"), "glassesMenu");
      assert.deepEqual(launchEvents, ["glassesMenu"]);

      bridge.emitLifecycle("abnormalExit");
      await flushMicrotasks();
    } finally {
      restore();
      timerHarness.restore();
      global.window = originalWindow;
      global.document = originalDocument;
    }
  });
});

test("FOREGROUND_EXIT pauses runtime; FOREGROUND_ENTER resumes", async () => {
  await withPerfClock(async () => {
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
      const updateCountBeforePause = bridge.updateTextCalls.length;
      bridge.emitLifecycle("foregroundExit");
      await flushMicrotasks();

      const updateCountAfterPause = bridge.updateTextCalls.length;
      // While paused, any tick-driven updates are suppressed. Pressing input
      // keys also no-ops because runtime.applyAction short-circuits on pause.
      browser.window.dispatch("keydown", {
        key: "ArrowLeft",
        repeat: false,
        preventDefault() {},
      });
      await flushMicrotasks();
      assert.equal(
        bridge.updateTextCalls.length,
        updateCountAfterPause,
        "input should not enqueue updates while paused",
      );

      bridge.emitLifecycle("foregroundEnter");
      await flushMicrotasks();

      browser.window.dispatch("keydown", {
        key: "ArrowRight",
        repeat: false,
        preventDefault() {},
      });
      await flushMicrotasks();
      assert.equal(
        bridge.updateTextCalls.length > updateCountAfterPause,
        true,
        "input should enqueue again after resume",
      );

      // FG_EXIT recorded a startup-render request when we resumed.
      assert.equal(
        bridge.updateTextCalls.length > updateCountBeforePause,
        true,
        "expected fresh render after resume",
      );

      bridge.emitLifecycle("abnormalExit");
      await flushMicrotasks();
    } finally {
      restore();
      timerHarness.restore();
      global.window = originalWindow;
      global.document = originalDocument;
    }
  });
});
