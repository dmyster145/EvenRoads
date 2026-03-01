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
  return {
    ...state,
    playerX: targetX,
    playerY: targetY + 1,
    lanes,
  };
}

test("createInitialState sets expected bounds and defaults", () => {
  const state = createInitialState(42);
  assert.equal(state.width, WORLD_WIDTH);
  assert.equal(state.height, WORLD_HEIGHT);
  assert.equal(state.playerX >= 0 && state.playerX < state.width, true);
  assert.equal(state.playerY, state.height - 1);
  assert.equal(state.runState, "running");
  assert.equal(state.lanes.length, WORLD_HEIGHT);
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

test("collision transitions to game_over and preserves best score", () => {
  const state = forceRoadCollisionState(2);
  const collided = applyInput(state, "move_up", 10);
  assert.equal(collided.runState, "game_over");
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
