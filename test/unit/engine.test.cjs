const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  createInitialState,
  applyInput,
  advanceTick,
} = require("../../.test-dist/game/engine.js");

function forceRoadCollisionState(seed = 7) {
  const state = createInitialState(seed);
  const targetY = 4;
  const targetX = 4;
  const lane = state.lanes[targetY];
  const collisionLane = {
    ...lane,
    type: "road",
    cells: new Array(state.width).fill(false),
  };
  collisionLane.cells[targetX] = true;
  const lanes = state.lanes.slice();
  lanes[targetY] = collisionLane;
  const solidCells = state.solidCells.map((row) => row.slice());
  solidCells[targetY][targetX] = false;
  const bridgeCells = state.bridgeCells.map((row) => row.slice());
  bridgeCells[targetY][targetX] = false;
  return {
    ...state,
    playerX: targetX - 1,
    playerY: targetY,
    lanes,
    solidCells,
    bridgeCells,
  };
}

test("createInitialState sets expected bounds and defaults", () => {
  const state = createInitialState(42);
  assert.equal(state.width, WORLD_WIDTH);
  assert.equal(state.height, WORLD_HEIGHT);
  assert.equal(state.playerX >= 0 && state.playerX < state.width, true);
  assert.equal(state.playerY, state.height - 1);
  assert.equal(state.runState, "alive");
  assert.equal(state.lanes.length, WORLD_HEIGHT);
  assert.equal(state.solidCells.length, WORLD_HEIGHT);
  assert.equal(state.bridgeCells.length, WORLD_HEIGHT);
  assert.equal(state.queuedHopUntilTick, -1);
  assert.equal(state.hopInvulnerableUntilTick, -1);
  for (const row of state.solidCells) {
    assert.equal(row.length, WORLD_WIDTH);
  }
  for (const row of state.bridgeCells) {
    assert.equal(row.length, WORLD_WIDTH);
  }
});

test("createInitialState spawn is deterministic per seed and varies across seeds", () => {
  const seedA = createInitialState(101);
  const seedARepeat = createInitialState(101);
  const seedB = createInitialState(102);

  assert.equal(seedA.playerX, seedARepeat.playerX);
  assert.equal(seedA.playerY, seedA.height - 1);
  assert.equal(seedB.playerY, seedB.height - 1);

  const spawnPositions = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    spawnPositions.add(createInitialState(seed).playerX);
  }
  assert.equal(spawnPositions.size > 1, true);
});

test("movement clamps at world boundaries", () => {
  let state = createInitialState(1);
  state = { ...state, playerX: 0 };
  const left = applyInput(state, "move_left", 1);
  assert.equal(left.playerX, 0);

  state = { ...state, playerX: state.width - 1 };
  const right = applyInput(state, "move_right", 2);
  assert.equal(right.playerX, state.width - 1);

  state = { ...state, runState: "paused", playerY: 0 };
  const up = applyInput(state, "move_up", 3);
  assert.equal(up.playerY, 0);
});

test("collision transitions to GAME OVER and preserves best score", () => {
  const state = forceRoadCollisionState(2);
  const collided = applyInput(state, "move_right", 10);
  assert.equal(collided.runState, "crashed!");
  assert.match(collided.message, /Crash/i);
  assert.equal(collided.bestScore >= state.score, true);
});

test("single tap/up does not restart while crashed", () => {
  const state = forceRoadCollisionState(23);
  const crashed = applyInput(state, "move_right", 10);
  const next = applyInput(crashed, "move_up", 11);
  assert.equal(next.runState, "crashed!");
  assert.equal(next.playerX, crashed.playerX);
  assert.equal(next.playerY, crashed.playerY);
});

test("restart action behaves like move_up when running and restarts when crashed", () => {
  const alive = createInitialState(24);
  const targetRow = alive.playerY - 1;
  const targetX = alive.playerX;

  const lanes = alive.lanes.slice();
  lanes[targetRow] = {
    ...lanes[targetRow],
    type: "road",
    cells: new Array(alive.width).fill(false),
  };
  const solidCells = alive.solidCells.map((line) => line.slice());
  solidCells[targetRow][targetX] = false;
  const bridgeCells = alive.bridgeCells.map((line) => line.slice());
  bridgeCells[targetRow][targetX] = false;

  const moved = applyInput({ ...alive, lanes, solidCells, bridgeCells }, "restart", 9);
  assert.equal(moved.runState, "alive");
  assert.equal(moved.playerY, targetRow);

  const state = forceRoadCollisionState(25);
  const crashed = applyInput(state, "move_right", 10);
  const restarted = applyInput(crashed, "restart", 12);
  assert.equal(restarted.runState, "alive");
  assert.equal(restarted.playerY, restarted.height - 1);
  assert.equal(restarted.message, "New game.");
});

test("reaching goal increments score and level then resets player", () => {
  const state = createInitialState(4);
  const crossingX = 7;
  const almostGoal = { ...state, playerY: 1, playerX: crossingX };
  const next = applyInput(almostGoal, "move_up", 12);
  assert.equal(next.score, almostGoal.score + 1);
  assert.equal(next.level, almostGoal.level + 1);
  assert.equal(next.playerY, next.height - 1);
  assert.equal(next.playerX, crossingX);
});

test("crossed message stays on home row and clears after leaving home row", () => {
  const state = createInitialState(41);
  const crossingX = 9;
  const crossed = applyInput({ ...state, playerY: 1, playerX: crossingX }, "move_up", 12);
  assert.match(crossed.message, /Crossed! Level \d+\.?/);
  assert.equal(crossed.playerY, crossed.height - 1);

  const homeMove = applyInput(crossed, "move_left", 13);
  assert.equal(homeMove.playerY, crossed.height - 1);
  assert.equal(homeMove.message, crossed.message);

  const targetRow = crossed.playerY - 1;
  const lanes = crossed.lanes.slice();
  lanes[targetRow] = {
    ...lanes[targetRow],
    type: "road",
    cells: new Array(crossed.width).fill(false),
  };
  const solidCells = crossed.solidCells.map((line) => line.slice());
  solidCells[targetRow][crossed.playerX] = false;
  const bridgeCells = crossed.bridgeCells.map((line) => line.slice());
  bridgeCells[targetRow][crossed.playerX] = false;

  const leaveHome = applyInput({ ...crossed, lanes, solidCells, bridgeCells }, "move_up", 14);
  assert.equal(leaveHome.playerY, targetRow);
  assert.equal(leaveHome.message, "Scroll Up/Down: right/left. Tap: hop.");
});

test("crossed message clears when a queued hop leaves home row on tick", () => {
  const state = createInitialState(42);
  const crossed = applyInput({ ...state, playerY: 1, playerX: state.playerX }, "move_up", 20);
  assert.match(crossed.message, /Crossed! Level \d+\.?/);

  const targetRow = crossed.playerY - 1;
  const lanes = crossed.lanes.slice();
  lanes[targetRow] = {
    ...lanes[targetRow],
    type: "road",
    direction: 1,
    speedTicks: 1,
    cells: new Array(crossed.width).fill(false),
  };
  lanes[targetRow].cells[crossed.playerX] = true;
  const solidCells = crossed.solidCells.map((line) => line.slice());
  solidCells[targetRow][crossed.playerX] = false;
  const bridgeCells = crossed.bridgeCells.map((line) => line.slice());
  bridgeCells[targetRow][crossed.playerX] = false;

  const queued = applyInput({ ...crossed, lanes, solidCells, bridgeCells }, "move_up", 21);
  assert.equal(queued.playerY, crossed.playerY);
  assert.equal(queued.queuedHopUntilTick, crossed.tickCount + 1);

  const next = advanceTick(queued);
  assert.equal(next.playerY, targetRow);
  assert.equal(next.message, "Scroll Up/Down: right/left. Tap: hop.");
});

test("advanceTick increments only while running", () => {
  const state = createInitialState(6);
  const running = advanceTick(state);
  assert.equal(running.tickCount, state.tickCount + 1);

  const pausedState = { ...state, runState: "paused" };
  const paused = advanceTick(pausedState);
  assert.equal(paused.tickCount, pausedState.tickCount);
  assert.equal(paused, pausedState);
});

test("interior road lanes alternate directions by row", () => {
  const state = createInitialState(11);
  for (let row = 1; row < state.height - 1; row++) {
    const lane = state.lanes[row];
    assert.equal(lane.type, "road");
    const expectedDirection = row % 2 === 0 ? -1 : 1;
    assert.equal(lane.direction, expectedDirection);
  }
});

test("solid blocks are interior and generated as 1-3 wide segments", () => {
  const state = createInitialState(12);
  assert.equal(state.solidCells[0].some(Boolean), false);
  assert.equal(state.solidCells[state.height - 1].some(Boolean), false);

  let segmentCount = 0;
  for (let row = 1; row < state.height - 1; row++) {
    let runLength = 0;
    for (let x = 0; x < state.width; x++) {
      if (state.solidCells[row][x]) {
        runLength += 1;
        continue;
      }
      if (runLength > 0) {
        assert.equal(runLength >= 1 && runLength <= 3, true);
        segmentCount += 1;
        runLength = 0;
      }
    }
    if (runLength > 0) {
      assert.equal(runLength >= 1 && runLength <= 3, true);
      segmentCount += 1;
    }
  }

  assert.equal(segmentCount > 0, true);
});

test("bridges are isolated single cells and do not overlap solid blocks", () => {
  const state = createInitialState(16);
  assert.equal(state.bridgeCells[0].some(Boolean), false);
  assert.equal(state.bridgeCells[state.height - 1].some(Boolean), false);

  let bridgeCellCount = 0;
  for (let row = 1; row < state.height - 1; row++) {
    for (let x = 0; x < state.width; x++) {
      if (!state.bridgeCells[row][x]) continue;
      bridgeCellCount += 1;
      assert.equal(state.solidCells[row][x], false);
      for (let nRow = Math.max(1, row - 1); nRow <= Math.min(state.height - 2, row + 1); nRow++) {
        for (let nX = Math.max(0, x - 1); nX <= Math.min(state.width - 1, x + 1); nX++) {
          if (nRow === row && nX === x) continue;
          assert.equal(state.bridgeCells[nRow][nX], false);
        }
      }
    }
  }
  assert.equal(bridgeCellCount > 0, true);
});

test("player cannot move into solid blocks", () => {
  const state = createInitialState(13);

  let targetRow = -1;
  let targetX = -1;
  for (let row = 1; row < state.height - 1 && targetRow === -1; row++) {
    for (let x = 1; x < state.width; x++) {
      if (state.solidCells[row][x] && !state.solidCells[row][x - 1]) {
        targetRow = row;
        targetX = x;
        break;
      }
    }
  }

  assert.equal(targetRow >= 1, true);

  const lanes = state.lanes.slice();
  lanes[targetRow] = {
    ...lanes[targetRow],
    type: "road",
    cells: new Array(state.width).fill(false),
  };

  const setup = {
    ...state,
    lanes,
    playerX: targetX - 1,
    playerY: targetRow,
  };
  const next = applyInput(setup, "move_right", 21);
  assert.equal(next.playerX, setup.playerX);
  assert.equal(next.playerY, setup.playerY);
  assert.equal(next.runState, "alive");
});

test("moving obstacles continue through solid blocks", () => {
  const state = createInitialState(14);
  const row = 1;
  const solidCells = state.solidCells.map((line) => line.slice());
  for (let x = 0; x < state.width; x++) {
    solidCells[row][x] = false;
  }
  solidCells[row][1] = true;

  const lanes = state.lanes.slice();
  lanes[row] = {
    ...lanes[row],
    type: "road",
    direction: 1,
    speedTicks: 1,
    cells: new Array(state.width).fill(false),
  };
  lanes[row].cells[0] = true;

  const setup = {
    ...state,
    lanes,
    solidCells,
    playerY: state.height - 1,
  };
  const next = advanceTick(setup);

  assert.equal(next.solidCells[row][1], true);
  assert.equal(next.lanes[row].cells[1], true);
});

test("bridge protects frog from obstacle collision on input move", () => {
  const state = createInitialState(17);
  const row = 2;
  const targetX = 5;

  const lanes = state.lanes.slice();
  lanes[row] = {
    ...lanes[row],
    type: "road",
    cells: new Array(state.width).fill(false),
  };
  lanes[row].cells[targetX] = true;

  const solidCells = state.solidCells.map((line) => line.slice());
  solidCells[row][targetX] = false;

  const bridgeCells = state.bridgeCells.map((line) => line.slice());
  for (let x = 0; x < state.width; x++) {
    bridgeCells[row][x] = false;
  }
  bridgeCells[row][targetX] = true;

  const setup = {
    ...state,
    lanes,
    solidCells,
    bridgeCells,
    playerX: targetX,
    playerY: row + 1,
  };
  const next = applyInput(setup, "move_up", 33);
  assert.equal(next.playerX, targetX);
  assert.equal(next.playerY, row);
  assert.equal(next.runState, "alive");
});

test("bridge protects frog from obstacle collision during tick", () => {
  const state = createInitialState(18);
  const row = 2;
  const targetX = 6;

  const lanes = state.lanes.slice();
  lanes[row] = {
    ...lanes[row],
    type: "road",
    direction: 1,
    speedTicks: 1,
    cells: new Array(state.width).fill(false),
  };
  lanes[row].cells[targetX - 1] = true;

  const solidCells = state.solidCells.map((line) => line.slice());
  solidCells[row][targetX] = false;

  const bridgeCells = state.bridgeCells.map((line) => line.slice());
  for (let x = 0; x < state.width; x++) {
    bridgeCells[row][x] = false;
  }
  bridgeCells[row][targetX] = true;

  const setup = {
    ...state,
    lanes,
    solidCells,
    bridgeCells,
    playerX: targetX,
    playerY: row,
  };
  const next = advanceTick(setup);
  assert.equal(next.lanes[row].cells[targetX], true);
  assert.equal(next.runState, "alive");
});

test("tap up into occupied road buffers hop for next tick", () => {
  const state = createInitialState(19);
  const targetRow = state.playerY - 1;
  const targetX = state.playerX;

  const lanes = state.lanes.slice();
  lanes[targetRow] = {
    ...lanes[targetRow],
    type: "road",
    cells: new Array(state.width).fill(false),
  };
  lanes[targetRow].cells[targetX] = true;

  const solidCells = state.solidCells.map((line) => line.slice());
  solidCells[targetRow][targetX] = false;
  const bridgeCells = state.bridgeCells.map((line) => line.slice());
  bridgeCells[targetRow][targetX] = false;

  const setup = { ...state, lanes, solidCells, bridgeCells };
  const next = applyInput(setup, "move_up", 41);
  assert.equal(next.playerY, setup.playerY);
  assert.equal(next.runState, "alive");
  assert.equal(next.queuedHopUntilTick, setup.tickCount + 1);
});

test("buffered hop executes after lane update when target clears", () => {
  const state = createInitialState(20);
  const targetRow = state.playerY - 1;
  const targetX = state.playerX;

  const lanes = state.lanes.slice();
  lanes[targetRow] = {
    ...lanes[targetRow],
    type: "road",
    direction: 1,
    speedTicks: 1,
    cells: new Array(state.width).fill(false),
  };
  lanes[targetRow].cells[targetX] = true;

  const solidCells = state.solidCells.map((line) => line.slice());
  solidCells[targetRow][targetX] = false;
  const bridgeCells = state.bridgeCells.map((line) => line.slice());
  bridgeCells[targetRow][targetX] = false;

  const queued = applyInput({ ...state, lanes, solidCells, bridgeCells }, "move_up", 44);
  assert.equal(queued.queuedHopUntilTick, queued.tickCount + 1);

  const next = advanceTick(queued);
  assert.equal(next.playerY, targetRow);
  assert.equal(next.runState, "alive");
  assert.equal(next.queuedHopUntilTick, -1);
});

test("hop grace allows narrow-timing survival through grace window", () => {
  const state = createInitialState(21);
  const targetRow = state.playerY - 1;
  const targetX = state.playerX;

  const lanes = state.lanes.slice();
  lanes[targetRow] = {
    ...lanes[targetRow],
    type: "road",
    direction: 1,
    speedTicks: 99,
    cells: new Array(state.width).fill(false),
  };
  lanes[targetRow].cells[targetX] = true;

  const solidCells = state.solidCells.map((line) => line.slice());
  solidCells[targetRow][targetX] = false;
  const bridgeCells = state.bridgeCells.map((line) => line.slice());
  bridgeCells[targetRow][targetX] = false;

  const queued = applyInput({ ...state, lanes, solidCells, bridgeCells }, "move_up", 47);
  let current = advanceTick(queued);
  const graceEndsAt = current.hopInvulnerableUntilTick;
  while (current.tickCount <= graceEndsAt) {
    assert.equal(current.runState, "alive");
    current = advanceTick(current);
  }
  assert.equal(current.runState, "crashed!");
});
