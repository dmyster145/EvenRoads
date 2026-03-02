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
  const targetX = 3;
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
  return {
    ...state,
    playerX: targetX,
    playerY: targetY + 1,
    lanes,
    solidCells,
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
  for (const row of state.solidCells) {
    assert.equal(row.length, WORLD_WIDTH);
  }
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
  const collided = applyInput(state, "move_up", 10);
  assert.equal(collided.runState, "dead!");
  assert.match(collided.message, /Crash/i);
  assert.equal(collided.bestScore >= state.score, true);
});

test("reaching goal increments score and level then resets player", () => {
  const state = createInitialState(4);
  const almostGoal = { ...state, playerY: 1, playerX: Math.floor(state.width / 2) };
  const next = applyInput(almostGoal, "move_up", 12);
  assert.equal(next.score, almostGoal.score + 1);
  assert.equal(next.level, almostGoal.level + 1);
  assert.equal(next.playerY, next.height - 1);
  assert.equal(next.playerX, Math.floor(next.width / 2));
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
