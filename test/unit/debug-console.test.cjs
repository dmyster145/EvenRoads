const test = require("node:test");
const assert = require("node:assert/strict");

function loadDebugConsoleModule() {
  const modulePath = require.resolve("../../.test-dist/debug/console.js");
  delete require.cache[modulePath];
  return require(modulePath);
}

test("initDebugConsole hides the panel when DOM perf logging is disabled", () => {
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
    const { initDebugConsole } = loadDebugConsoleModule();
    initDebugConsole();

    assert.equal(panel.style.display, "none");
    assert.equal(panel.getAttribute("data-collapsed"), "true");
  } finally {
    global.window = originalWindow;
    global.document = originalDocument;
  }
});
