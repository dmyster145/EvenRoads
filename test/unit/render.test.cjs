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
  assert.match(status, /State:\s*PAUSED/i);
  assert.doesNotMatch(status, /Crossed!\s*Level/i);
});

test("crashed state label can be hidden for blink-off frame", () => {
  const state = {
    ...createInitialState(31),
    runState: "crashed!",
  };
  const shown = renderBrowserStatus(state);
  const hidden = renderBrowserStatus(state, { showCrashedState: false });
  assert.match(shown, /State:\s*CRASHED!/i);
  assert.doesNotMatch(hidden, /CRASHED!/i);
});

test("crossed message appears in status line only when crossed", () => {
  const crossed = {
    ...createInitialState(32),
    message: "Crossed! Level 3",
    runState: "alive",
  };
  const shown = renderBrowserStatus(crossed);
  assert.match(shown, /Crossed!\s*Level 3\.?/i);

  const shownWithPeriod = renderBrowserStatus({ ...crossed, message: "Crossed! Level 3." });
  assert.match(shownWithPeriod, /Crossed!\s*Level 3\./i);

  const hidden = renderBrowserStatus({ ...crossed, message: "New game." });
  assert.doesNotMatch(hidden, /Crossed!\s*Level/i);
});

test("solid blocks render as filled squares", () => {
  const state = createInitialState(15);
  const board = renderTextBoard(state);
  assert.match(board, /▩/);
});

test("bridges render as hollow squares on road rows", () => {
  const state = createInitialState(16);
  const row = 1;
  const x = 2;

  const lanes = state.lanes.slice();
  lanes[row] = {
    ...lanes[row],
    type: "road",
    cells: new Array(state.width).fill(false),
  };

  const solidCells = state.solidCells.map((line) => line.slice());
  solidCells[row][x] = false;

  const bridgeCells = state.bridgeCells.map((line) => line.slice());
  for (let r = 0; r < state.height; r++) {
    for (let c = 0; c < state.width; c++) {
      bridgeCells[r][c] = false;
    }
  }
  bridgeCells[row][x] = true;

  const board = renderTextBoard({ ...state, lanes, solidCells, bridgeCells });
  const lines = board.split("\n");
  assert.equal(lines[row + 1][x], "□");
});

test("obstacle runs get directional start markers", () => {
  const state = createInitialState(17);
  const rightRow = 2;
  const leftRow = 3;

  const lanes = state.lanes.slice();
  lanes[rightRow] = {
    ...lanes[rightRow],
    type: "road",
    direction: 1,
    cells: new Array(state.width).fill(false),
  };
  lanes[rightRow].cells[4] = true;
  lanes[rightRow].cells[5] = true;
  lanes[rightRow].cells[6] = true;

  lanes[leftRow] = {
    ...lanes[leftRow],
    type: "road",
    direction: -1,
    cells: new Array(state.width).fill(false),
  };
  lanes[leftRow].cells[12] = true;
  lanes[leftRow].cells[13] = true;
  lanes[leftRow].cells[14] = true;

  const solidCells = state.solidCells.map((line) => line.slice());
  const bridgeCells = state.bridgeCells.map((line) => line.slice());
  for (let r = 0; r < state.height; r++) {
    for (let c = 0; c < state.width; c++) {
      solidCells[r][c] = false;
      bridgeCells[r][c] = false;
    }
  }

  const board = renderTextBoard({ ...state, lanes, solidCells, bridgeCells });
  const lines = board.split("\n");
  assert.equal(lines[rightRow + 1][4], "◈");
  assert.equal(lines[rightRow + 1][5], "◈");
  assert.equal(lines[rightRow + 1][6], "▷");
  assert.equal(lines[leftRow + 1][12], "◁");
  assert.equal(lines[leftRow + 1][13], "◈");
  assert.equal(lines[leftRow + 1][14], "◈");
});

test("simulator glyph profile preserves device unicode glyph semantics", () => {
  const state = createInitialState(18);
  const rightRow = 2;
  const leftRow = 3;

  const lanes = state.lanes.slice();
  lanes[rightRow] = {
    ...lanes[rightRow],
    type: "road",
    direction: 1,
    cells: new Array(state.width).fill(false),
  };
  lanes[rightRow].cells[4] = true;
  lanes[rightRow].cells[5] = true;
  lanes[rightRow].cells[6] = true;

  lanes[leftRow] = {
    ...lanes[leftRow],
    type: "road",
    direction: -1,
    cells: new Array(state.width).fill(false),
  };
  lanes[leftRow].cells[12] = true;
  lanes[leftRow].cells[13] = true;
  lanes[leftRow].cells[14] = true;

  const solidCells = state.solidCells.map((line) => line.slice());
  const bridgeCells = state.bridgeCells.map((line) => line.slice());
  for (let r = 0; r < state.height; r++) {
    for (let c = 0; c < state.width; c++) {
      solidCells[r][c] = false;
      bridgeCells[r][c] = false;
    }
  }
  solidCells[1][1] = true;
  bridgeCells[1][2] = true;

  const board = renderTextBoard(
    { ...state, lanes, solidCells, bridgeCells },
    { glyphProfile: "simulator" },
  );
  const lines = board.split("\n");
  assert.equal(lines[rightRow + 1][4], "◈");
  assert.equal(lines[rightRow + 1][5], "◈");
  assert.equal(lines[rightRow + 1][6], "▷");
  assert.equal(lines[leftRow + 1][12], "◁");
  assert.equal(lines[leftRow + 1][13], "◈");
  assert.equal(lines[leftRow + 1][14], "◈");
  assert.equal(lines[2][1], "▩");
  assert.equal(lines[2][2], "□");
});

test("simulator profile trims two rightmost board columns", () => {
  const state = createInitialState(19);
  const row = 1;
  const lanes = state.lanes.slice();
  lanes[row] = {
    ...lanes[row],
    type: "road",
    direction: 1,
    cells: new Array(state.width).fill(true),
  };

  const board = renderTextBoard({ ...state, lanes }, { glyphProfile: "simulator" });
  const lines = board.split("\n");

  for (const laneLine of lines.slice(1)) {
    assert.equal(laneLine.length, state.width - 2);
  }

  const simulatorRow = lines[row + 1];
  assert.equal(simulatorRow.length, state.width - 2);
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
