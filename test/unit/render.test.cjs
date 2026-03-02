const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");

const { createInitialState, advanceTick, applyInput } = require("../../.test-dist/game/engine.js");
const { renderTextBoard, renderBrowserStatus } = require("../../.test-dist/render/text-board.js");

function lineCount(text) {
  return text.split("\n").length;
}

test("text board dimensions match game state", () => {
  const state = createInitialState(10);
  const board = renderTextBoard(state);
  const lines = board.split("\n");
  assert.equal(lines.length, state.height + 1);
  assert.match(lines[0], /Score:\s*\d{2}/i);
  for (const line of lines.slice(1)) {
    assert.equal(line.length, state.width);
  }
});

test("render output remains deterministic for same immutable state", () => {
  const state = createInitialState(22);
  const one = renderTextBoard(state);
  const two = renderTextBoard(state);
  const three = renderTextBoard(state);
  assert.equal(one, two);
  assert.equal(two, three);
});

test("status render emits single-line scoreboard", () => {
  let state = createInitialState(3);
  state = applyInput(state, "toggle_pause", 100);
  const status = renderBrowserStatus(state);
  assert.equal(lineCount(status), 1);
  assert.match(status, /Score:\s*\d{2}/i);
  assert.match(status, /Best:\s*\d{2}/i);
  assert.match(status, /Level:\s*\d{2}/i);
  assert.match(status, /State:\s*PAUSED/i);
});

test("solid blocks render as filled squares", () => {
  const state = createInitialState(15);
  const board = renderTextBoard(state);
  assert.match(board, /■/);
});

test("stress: repeated render and tick stays under budget", () => {
  let state = createInitialState(99);
  const iterations = 12000;
  const startedAt = performance.now();

  for (let i = 0; i < iterations; i++) {
    if (i % 3 === 0) state = advanceTick(state);
    if (i % 17 === 0) state = applyInput(state, "move_up", i);
    if (i % 19 === 0) state = applyInput(state, "move_left", i);
    renderTextBoard(state);
  }

  const elapsedMs = performance.now() - startedAt;
  const avgRenderMs = elapsedMs / iterations;
  // Generous threshold meant to catch major regressions, not machine-to-machine jitter.
  assert.equal(avgRenderMs < 1.5, true, `avg render ${avgRenderMs.toFixed(3)}ms exceeded budget`);
});
