const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LAUNCH_SOURCE_EVENT,
  RESET_BEST_SCORE_EVENT,
} = require("../../.test-dist/companion/contracts.js");
const {
  createCompanionRuntimeStore,
  parseCompanionStatus,
  resetBestScore,
} = require("../../.test-dist/companion/runtime.js");
const {
  buildBoardGlyphRows,
  buildControlRows,
  buildGuideCards,
  buildLaunchHint,
  buildLaunchSourceBanner,
  buildOverviewQuickStart,
  defaultTabForLaunchSource,
  formatScore,
} = require("../../.test-dist/companion/view-model.js");

function createMutationObserverHarness() {
  const observers = [];

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.disconnected = false;
      observers.push(this);
    }

    observe(target) {
      this.target = target;
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  return {
    FakeMutationObserver,
    flush() {
      for (const observer of observers) {
        if (!observer.disconnected) observer.callback([], observer);
      }
    },
    observers,
  };
}

function createCompanionHarness({ statusText = "", bestScore = "0", launchSource = null } = {}) {
  const listeners = new Map();
  const bodyAttributes = new Map();
  if (launchSource) bodyAttributes.set("data-launch-source", launchSource);
  const status = { textContent: statusText };
  const storage = new Map([["hoppyroads.bestScore", bestScore]]);

  const window = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event) {
      const group = listeners.get(event.type);
      if (!group) return true;
      for (const handler of [...group]) handler(event);
      return true;
    },
  };

  const document = {
    body: {
      getAttribute(name) {
        return bodyAttributes.has(name) ? bodyAttributes.get(name) : null;
      },
      setAttribute(name, value) {
        bodyAttributes.set(name, String(value));
      },
    },
    getElementById(id) {
      if (id === "status") return status;
      return null;
    },
  };

  return {
    document,
    window,
    status,
    storage,
  };
}

test("parseCompanionStatus extracts score, best, run state, and crossed message", () => {
  const parsed = parseCompanionStatus("Score: 03  Best: 11  State: CRASHED!  Crossed! Level 4");
  assert.deepEqual(parsed, {
    score: 3,
    bestScore: 11,
    runState: "CRASHED!",
    crossedMessage: "Crossed! Level 4",
  });
});

test("companion runtime store falls back to persisted best score when status omits it", () => {
  const browser = createCompanionHarness({
    statusText: "Score: 02  State: ALIVE",
    bestScore: "17",
  });
  const mutations = createMutationObserverHarness();
  const store = createCompanionRuntimeStore({
    document: browser.document,
    window: browser.window,
    MutationObserver: mutations.FakeMutationObserver,
  });

  assert.equal(store.getSnapshot().score, 2);
  assert.equal(store.getSnapshot().bestScore, 17);
  assert.equal(store.getSnapshot().launchSource, null);
});

test("companion runtime store updates when status changes and launch source events arrive", () => {
  const browser = createCompanionHarness({
    statusText: "Score: 01  Best: 03  State: ALIVE",
  });
  const mutations = createMutationObserverHarness();
  const store = createCompanionRuntimeStore({
    document: browser.document,
    window: browser.window,
    MutationObserver: mutations.FakeMutationObserver,
  });
  const snapshots = [];
  const unsubscribe = store.subscribe(() => {
    snapshots.push(store.getSnapshot());
  });

  browser.status.textContent = "Score: 04  Best: 07  State: PAUSED";
  mutations.flush();
  browser.document.body.setAttribute("data-launch-source", "glassesMenu");
  browser.window.dispatchEvent(
    new CustomEvent(LAUNCH_SOURCE_EVENT, { detail: { launchSource: "glassesMenu" } }),
  );

  assert.equal(store.getSnapshot().score, 4);
  assert.equal(store.getSnapshot().bestScore, 7);
  assert.equal(store.getSnapshot().runState, "PAUSED");
  assert.equal(store.getSnapshot().launchSource, "glassesMenu");
  assert.equal(snapshots.length, 2);

  unsubscribe();
  store.destroy();
  assert.equal(mutations.observers[0].disconnected, true);
});

test("resetBestScore writes storage and dispatches the preserved browser event", () => {
  const dispatched = [];
  const window = {
    localStorage: {
      setItem(key, value) {
        dispatched.push(`${key}:${value}`);
      },
    },
    dispatchEvent(event) {
      dispatched.push(event.type);
      return true;
    },
  };

  assert.deepEqual(resetBestScore(window), {
    ok: true,
    message: "Scores reset. New game started.",
    variant: "info",
  });
  assert.deepEqual(dispatched, ["hoppyroads.bestScore:0", RESET_BEST_SCORE_EVENT]);
});

test("resetBestScore reports an error when storage access fails", () => {
  const window = {
    get localStorage() {
      throw new Error("blocked");
    },
    dispatchEvent() {
      return true;
    },
  };

  assert.deepEqual(resetBestScore(window), {
    ok: false,
    message: "Could not reset scores on this device.",
    variant: "error",
  });
});

test("launch-source routing and companion content map to the new tabs", () => {
  assert.equal(defaultTabForLaunchSource("appMenu"), "overview");
  assert.equal(defaultTabForLaunchSource("glassesMenu"), "controls");
  assert.equal(formatScore(4), "04");

  assert.match(buildLaunchSourceBanner("appMenu").title, /Even App menu/i);
  assert.match(buildLaunchHint("glassesMenu"), /live legend/i);
  assert.match(buildOverviewQuickStart("glassesMenu")[0].title, /already running/i);
  assert.equal(buildControlRows().length, 4);
  assert.equal(buildBoardGlyphRows().some((row) => row.glyph.includes("▲")), true);
  assert.equal(buildGuideCards().some((card) => card.title === "Progression & Persistence"), true);
});
