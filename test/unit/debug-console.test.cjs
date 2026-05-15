const test = require("node:test");
const assert = require("node:assert/strict");

function loadDebugConsoleModule() {
  const modulePath = require.resolve("../../.test-dist/debug/console.js");
  delete require.cache[modulePath];
  return require(modulePath);
}

test("initDebugConsole panel visibility matches DOM perf logging flag", () => {
  const panelAttributes = new Map();
  const panel = {
    style: {},
    setAttribute(name, value) {
      panelAttributes.set(name, String(value));
    },
    getAttribute(name) {
      return panelAttributes.has(name) ? panelAttributes.get(name) : null;
    },
  };

  const originalWindow = global.window;
  const originalDocument = global.document;
  global.window = {};
  global.document = {
    getElementById(id) {
      return id === "perf-console-panel" ? panel : null;
    },
  };

  try {
    const { isPerfDomConsoleEnabled } = require("../../.test-dist/perf/log.js");
    const { initDebugConsole } = loadDebugConsoleModule();
    initDebugConsole();

    if (isPerfDomConsoleEnabled()) {
      // Debug build: panel is shown and expanded.
      assert.equal(panel.style.display, "flex");
      assert.equal(panel.getAttribute("data-collapsed"), "false");
    } else {
      // Default build: panel is hidden.
      assert.equal(panel.style.display, "none");
      assert.equal(panel.getAttribute("data-collapsed"), "true");
    }
  } finally {
    global.window = originalWindow;
    global.document = originalDocument;
  }
});
