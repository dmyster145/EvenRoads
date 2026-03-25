const test = require("node:test");
const assert = require("node:assert/strict");

const { advanceDueTicks } = require("../../.test-dist/app/tick-timeline.js");

test("advanceDueTicks leaves state untouched before the next deadline", () => {
  const state = { ticks: 0, intervalMs: 100, alive: true };
  const result = advanceDueTicks({
    state,
    nowMs: 90,
    nextDueAtMs: 100,
    canAdvance: (currentState) => currentState.alive,
    getIntervalMs: (currentState) => currentState.intervalMs,
    advance: (currentState) => ({ ...currentState, ticks: currentState.ticks + 1 }),
  });

  assert.equal(result.state, state);
  assert.equal(result.nextDueAtMs, 100);
  assert.equal(result.advancedCount, 0);
});

test("advanceDueTicks catches up multiple elapsed ticks without drift", () => {
  const result = advanceDueTicks({
    state: { ticks: 0, intervalMs: 100, alive: true },
    nowMs: 350,
    nextDueAtMs: 100,
    canAdvance: (currentState) => currentState.alive,
    getIntervalMs: (currentState) => currentState.intervalMs,
    advance: (currentState) => ({ ...currentState, ticks: currentState.ticks + 1 }),
  });

  assert.equal(result.state.ticks, 3);
  assert.equal(result.nextDueAtMs, 400);
  assert.equal(result.advancedCount, 3);
});

test("advanceDueTicks uses the next state's interval for future scheduling", () => {
  const result = advanceDueTicks({
    state: { ticks: 0, intervalMs: 100, alive: true },
    nowMs: 210,
    nextDueAtMs: 100,
    canAdvance: (currentState) => currentState.alive,
    getIntervalMs: (currentState) => currentState.intervalMs,
    advance: (currentState) => ({
      ...currentState,
      ticks: currentState.ticks + 1,
      intervalMs: 60,
    }),
  });

  assert.equal(result.state.ticks, 2);
  assert.equal(result.nextDueAtMs, 220);
  assert.equal(result.advancedCount, 2);
});
