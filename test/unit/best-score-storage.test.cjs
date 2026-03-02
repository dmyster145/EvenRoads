const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadPersistedBestScore,
  persistBestScore,
} = require("../../.test-dist/app/best-score-storage.js");

function makeStorage(initial = null) {
  const values = new Map();
  if (initial !== null) {
    values.set("evenroads.bestScore", initial);
  }
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("loadPersistedBestScore returns 0 when storage missing", () => {
  assert.equal(loadPersistedBestScore(null), 0);
});

test("loadPersistedBestScore parses stored value", () => {
  const storage = makeStorage("12");
  assert.equal(loadPersistedBestScore(storage), 12);
});

test("loadPersistedBestScore normalizes invalid values", () => {
  assert.equal(loadPersistedBestScore(makeStorage("-5")), 0);
  assert.equal(loadPersistedBestScore(makeStorage("abc")), 0);
});

test("persistBestScore stores normalized integer value", () => {
  const storage = makeStorage();
  persistBestScore(19.8, storage);
  assert.equal(storage.getItem("evenroads.bestScore"), "19");
});

test("loadPersistedBestScore returns 0 when storage read throws", () => {
  const storage = {
    getItem() {
      throw new Error("read blocked");
    },
  };
  assert.equal(loadPersistedBestScore(storage), 0);
});

test("persistBestScore does not throw when storage write fails", () => {
  const storage = {
    setItem() {
      throw new Error("quota exceeded");
    },
  };
  assert.doesNotThrow(() => {
    persistBestScore(8, storage);
  });
});
