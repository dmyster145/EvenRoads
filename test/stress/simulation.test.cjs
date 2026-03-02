const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");

const { createInitialState, applyInput, advanceTick } = require("../../.test-dist/game/engine.js");
const { renderTextBoard } = require("../../.test-dist/render/text-board.js");

const ACTIONS = ["move_left", "move_right", "move_up", "toggle_pause"];

function xorshift32(seed) {
  let x = seed | 0;
  if (x === 0) x = 0x6d2b79f5;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

function assertStateInvariants(state) {
  assert.equal(state.playerX >= 0 && state.playerX < state.width, true);
  assert.equal(state.playerY >= 0 && state.playerY < state.height, true);
  assert.equal(state.lanes.length, state.height);
  assert.equal(state.solidCells.length, state.height);
  assert.equal(state.bridgeCells.length, state.height);
  assert.equal(Number.isInteger(state.queuedHopUntilTick), true);
  assert.equal(Number.isInteger(state.hopInvulnerableUntilTick), true);
  for (const lane of state.lanes) {
    assert.equal(lane.cells.length, state.width);
  }
  for (const row of state.solidCells) {
    assert.equal(row.length, state.width);
  }
  for (const row of state.bridgeCells) {
    assert.equal(row.length, state.width);
  }
}

test("stress: randomized simulation preserves invariants under heavy load", () => {
  const seedCount = 18;
  const stepsPerSeed = 3200;
  const startedAt = performance.now();

  for (let seed = 1; seed <= seedCount; seed++) {
    let state = createInitialState(seed);
    const rnd = xorshift32(seed * 991);
    for (let step = 0; step < stepsPerSeed; step++) {
      const roll = rnd();
      if (roll < 0.58) {
        state = advanceTick(state);
      } else {
        const action = ACTIONS[Math.floor(rnd() * ACTIONS.length)];
        state = applyInput(state, action, step);
      }

      // Simulate production pipeline pressure: render snapshots during the simulation.
      if (step % 3 === 0) {
        renderTextBoard(state);
      }

      assertStateInvariants(state);
    }
  }

  const elapsedMs = performance.now() - startedAt;
  const totalSteps = seedCount * stepsPerSeed;
  const stepsPerMs = totalSteps / elapsedMs;
  assert.equal(stepsPerMs > 15, true, `simulation throughput too low: ${stepsPerMs.toFixed(2)} steps/ms`);
});
