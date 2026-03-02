const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveRenderGlyphProfile } = require("../../.test-dist/render/display-profile.js");

function makeWindow({
  search = "",
  hostname = "example.com",
  platform = "MacIntel",
  userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
  maxTouchPoints = 0,
  localStorage = undefined,
} = {}) {
  return {
    location: {
      search,
      hostname,
    },
    navigator: {
      platform,
      userAgent,
      maxTouchPoints,
    },
    localStorage,
  };
}

test("display profile query override takes precedence over storage and heuristics", () => {
  const win = makeWindow({
    search: "?displayProfile=device",
    hostname: "localhost",
    localStorage: {
      getItem() {
        return "simulator";
      },
    },
  });

  assert.equal(resolveRenderGlyphProfile(win), "device");
});

test("stored display profile takes precedence over runtime heuristics", () => {
  const win = makeWindow({
    hostname: "localhost",
    localStorage: {
      getItem() {
        return "device";
      },
    },
  });

  assert.equal(resolveRenderGlyphProfile(win), "device");
});

test("local simulator host falls back to simulator profile when no overrides exist", () => {
  const win = makeWindow({
    hostname: "localhost",
    localStorage: undefined,
  });

  assert.equal(resolveRenderGlyphProfile(win), "simulator");
});

test("localStorage getter failure falls back to runtime heuristics without throwing", () => {
  const win = makeWindow({
    platform: "iPhone",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile",
    maxTouchPoints: 5,
  });
  Object.defineProperty(win, "localStorage", {
    get() {
      throw new Error("storage blocked");
    },
  });

  assert.doesNotThrow(() => {
    assert.equal(resolveRenderGlyphProfile(win), "device");
  });
});
