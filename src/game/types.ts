/**
 * Core engine contracts.
 *
 * Shared types keep renderer/input/engine modules loosely coupled and easier to evolve.
 */
export type LaneType = "goal" | "road" | "safe" | "start";

export type InputAction = "move_left" | "move_right" | "move_up" | "toggle_pause" | "restart";

export interface Lane {
  type: LaneType;
  direction: -1 | 1;
  speedTicks: number;
  cells: boolean[];
}

export type RunState = "alive" | "paused" | "crashed!";

export interface GameState {
  width: number;
  height: number;
  tickCount: number;
  tickIntervalMs: number;
  level: number;
  score: number;
  bestScore: number;
  playerX: number;
  playerY: number;
  runState: RunState;
  message: string;
  seed: number;
  lanes: Lane[];
  solidCells: boolean[][];
  bridgeCells: boolean[][];
  queuedHopUntilTick: number;
  hopInvulnerableUntilTick: number;
  lastInputAtMs: number;
  lastInputName: string;
}
