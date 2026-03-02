/**
 * Deterministic game engine.
 *
 * This module stays framework/SDK-agnostic so behavior can be validated in isolation
 * and reused across renderer experiments without reintroducing gameplay drift.
 */
import type { GameState, InputAction, Lane, LaneType } from "./types";

export const WORLD_WIDTH = 28;
export const WORLD_HEIGHT = 9;
const MIN_TICK_MS = 90;
const BASE_TICK_MS = 170;
const NO_QUEUED_HOP = -1;
const HOP_GRACE_TICKS = 3;
const START_MESSAGE = "Scroll Up/Down: left/right. Tap: hop.";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function xorshift32(seed: number): () => number {
  let x = seed | 0;
  if (x === 0) x = 0x6d2b79f5;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };
}

function nextTickIntervalMs(level: number): number {
  return Math.max(MIN_TICK_MS, BASE_TICK_MS - (level - 1) * 8);
}

function spawnXForSeed(seed: number, width: number): number {
  const rng = xorshift32(seed ^ 0x7f4a7c15);
  return Math.floor(rng() * width);
}

function makeLaneCells(width: number, density: number, rng: () => number): boolean[] {
  const cells = new Array<boolean>(width).fill(false);
  for (let i = 0; i < width; i++) {
    cells[i] = rng() < density;
  }

  // Keep at least one obstacle so road lanes are always meaningful.
  if (cells.every((value) => !value)) {
    cells[Math.floor(rng() * width)] = true;
  }
  // Keep at least one clear tile to avoid guaranteed collisions.
  if (cells.every((value) => value)) {
    cells[Math.floor(rng() * width)] = false;
  }
  return cells;
}

function laneTypeForRow(row: number): LaneType {
  // Fixed anchor rows make progression readable: top is always goal, bottom always spawn.
  if (row === 0) return "goal";
  if (row === WORLD_HEIGHT - 1) return "start";
  return "road";
}

function createLane(row: number, width: number, level: number, rng: () => number): Lane {
  const type = laneTypeForRow(row);
  if (type !== "road") {
    return {
      type,
      direction: 1,
      speedTicks: 1,
      cells: new Array<boolean>(width).fill(false),
    };
  }

  const density = clamp(0.23 + level * 0.015, 0.2, 0.45);
  const speedTicks = clamp(4 - Math.floor(level / 3), 1, 4);
  // Alternate road flow by row so adjacent lanes move in opposite directions.
  const direction = row % 2 === 0 ? -1 : 1;
  return {
    type,
    direction,
    speedTicks,
    cells: makeLaneCells(width, density, rng),
  };
}

function createLanes(width: number, level: number, seed: number): Lane[] {
  const rng = xorshift32(seed ^ (level * 0x9e3779b9));
  const lanes: Lane[] = [];
  for (let row = 0; row < WORLD_HEIGHT; row++) {
    lanes.push(createLane(row, width, level, rng));
  }
  return lanes;
}

function tryPlaceSegment(
  rowCells: boolean[],
  width: number,
  rng: () => number,
  blockedCells?: boolean[],
): boolean {
  for (let attempt = 0; attempt < 12; attempt++) {
    const blockWidth = 1 + Math.floor(rng() * 3);
    const startX = Math.floor(rng() * (width - blockWidth + 1));
    const left = Math.max(0, startX - 1);
    const right = Math.min(width - 1, startX + blockWidth);

    let blocked = false;
    for (let x = left; x <= right; x++) {
      if (rowCells[x]) {
        blocked = true;
        break;
      }
    }
    if (!blocked && blockedCells) {
      for (let x = startX; x < startX + blockWidth; x++) {
        if (blockedCells[x]) {
          blocked = true;
          break;
        }
      }
    }
    if (blocked) continue;

    for (let x = startX; x < startX + blockWidth; x++) {
      rowCells[x] = true;
    }
    return true;
  }
  return false;
}

function createSolidCells(width: number, height: number, level: number, seed: number): boolean[][] {
  const rng = xorshift32(seed ^ (level * 0x85ebca6b) ^ 0xc2b2ae35);
  const rowPlacementChance = 0.72;
  const secondSegmentChance = 0.45;
  const rows: boolean[][] = new Array<boolean[]>(height);
  for (let row = 0; row < height; row++) {
    rows[row] = new Array<boolean>(width).fill(false);
  }

  let placedAny = false;
  for (let row = 1; row < height - 1; row++) {
    if (rng() >= rowPlacementChance) continue;
    if (!tryPlaceSegment(rows[row], width, rng)) continue;
    placedAny = true;
    if (rng() < secondSegmentChance) {
      tryPlaceSegment(rows[row], width, rng);
    }
  }

  // Ensure at least one blocker exists each run so the mechanic is always present.
  if (!placedAny && height > 2) {
    const row = 1 + Math.floor(rng() * (height - 2));
    if (!tryPlaceSegment(rows[row], width, rng)) {
      rows[row][Math.floor(rng() * width)] = true;
    }
  }

  return rows;
}

function createBridgeCells(
  width: number,
  height: number,
  level: number,
  seed: number,
  solidCells: boolean[][],
): boolean[][] {
  const rng = xorshift32(seed ^ (level * 0x27d4eb2f) ^ 0x165667b1);
  const rowPlacementChance = 0.58;
  const secondBridgeChance = 0.28;
  const rows: boolean[][] = new Array<boolean[]>(height);
  for (let row = 0; row < height; row++) {
    rows[row] = new Array<boolean>(width).fill(false);
  }

  function hasNeighborBridgeCell(targetRow: number, targetX: number): boolean {
    const top = Math.max(0, targetRow - 1);
    const bottom = Math.min(height - 1, targetRow + 1);
    const left = Math.max(0, targetX - 1);
    const right = Math.min(width - 1, targetX + 1);
    for (let row = top; row <= bottom; row++) {
      for (let x = left; x <= right; x++) {
        if (row === targetRow && x === targetX) continue;
        if (rows[row][x]) return true;
      }
    }
    return false;
  }

  function tryPlaceBridgeCell(targetRow: number): boolean {
    for (let attempt = 0; attempt < 24; attempt++) {
      const x = Math.floor(rng() * width);
      if (solidCells[targetRow][x]) continue;
      if (hasNeighborBridgeCell(targetRow, x)) continue;
      rows[targetRow][x] = true;
      return true;
    }
    return false;
  }

  let placedAny = false;
  for (let row = 1; row < height - 1; row++) {
    if (rng() >= rowPlacementChance) continue;
    if (tryPlaceBridgeCell(row)) {
      placedAny = true;
    }
    if (rng() < secondBridgeChance) {
      if (tryPlaceBridgeCell(row)) {
        placedAny = true;
      }
    }
  }

  // Ensure bridge mechanic appears each run while still avoiding solid blockers.
  if (!placedAny && height > 2) {
    for (let attempt = 0; attempt < height * width; attempt++) {
      const row = 1 + Math.floor(rng() * (height - 2));
      if (tryPlaceBridgeCell(row)) {
        placedAny = true;
        break;
      }
    }
  }

  if (!placedAny && height > 2) {
    for (let row = 1; row < height - 1; row++) {
      for (let x = 0; x < width; x++) {
        if (solidCells[row][x]) continue;
        if (hasNeighborBridgeCell(row, x)) continue;
        rows[row][x] = true;
        return rows;
      }
    }
  }

  return rows;
}

function shiftRoadCells(cells: boolean[], direction: -1 | 1): boolean[] {
  const width = cells.length;
  const shifted = new Array<boolean>(width).fill(false);
  for (let x = 0; x < width; x++) {
    const source = direction === 1 ? (x - 1 + width) % width : (x + 1) % width;
    shifted[x] = cells[source] ?? false;
  }
  return shifted;
}

function collides(state: GameState, x: number, y: number): boolean {
  const lane = state.lanes[y];
  if (!lane || lane.type !== "road") return false;
  if (isBridgeCell(state, x, y)) return false;
  if (
    x === state.playerX &&
    y === state.playerY &&
    state.tickCount <= state.hopInvulnerableUntilTick
  ) {
    return false;
  }
  return lane.cells[x] ?? false;
}

function isSolidCell(state: GameState, x: number, y: number): boolean {
  return state.solidCells[y]?.[x] ?? false;
}

function isBridgeCell(state: GameState, x: number, y: number): boolean {
  return state.bridgeCells[y]?.[x] ?? false;
}

function withMessage(state: GameState, message: string): GameState {
  return { ...state, message };
}

function isCrossedMessage(message: string): boolean {
  return /^Crossed! Level \d+\.$/.test(message);
}

function clearCrossedMessageIfLeftHome(previous: GameState, next: GameState): GameState {
  const homeY = previous.height - 1;
  if (!isCrossedMessage(previous.message)) return next;
  if (previous.playerY !== homeY) return next;
  if (next.playerY >= homeY) return next;
  if (next.runState !== "alive") return next;
  return { ...next, message: START_MESSAGE };
}

function isRoadLane(state: GameState, y: number): boolean {
  return state.lanes[y]?.type === "road";
}

function hasRoadObstacleAt(state: GameState, x: number, y: number): boolean {
  if (!isRoadLane(state, y)) return false;
  if (isBridgeCell(state, x, y)) return false;
  return state.lanes[y]?.cells[x] ?? false;
}

function withHopGraceIfOnRoad(state: GameState, previousY: number): GameState {
  if (state.playerY >= previousY) return state;
  if (!isRoadLane(state, state.playerY)) return state;
  return {
    ...state,
    hopInvulnerableUntilTick: Math.max(state.hopInvulnerableUntilTick, state.tickCount + HOP_GRACE_TICKS),
  };
}

function consumeQueuedHop(state: GameState): GameState {
  if (state.queuedHopUntilTick === NO_QUEUED_HOP) return state;
  if (state.queuedHopUntilTick < state.tickCount) {
    return { ...state, queuedHopUntilTick: NO_QUEUED_HOP };
  }
  if (state.playerY === 0) {
    return { ...state, queuedHopUntilTick: NO_QUEUED_HOP };
  }

  const targetY = state.playerY - 1;
  if (isSolidCell(state, state.playerX, targetY)) {
    return { ...state, queuedHopUntilTick: NO_QUEUED_HOP };
  }

  let next: GameState = {
    ...state,
    queuedHopUntilTick: NO_QUEUED_HOP,
    playerY: targetY,
  };
  next = withHopGraceIfOnRoad(next, state.playerY);
  if (next.playerY === 0) {
    return handleGoalReached(next);
  }
  return next;
}

export function createInitialState(seed = Date.now()): GameState {
  const level = 1;
  const solidCells = createSolidCells(WORLD_WIDTH, WORLD_HEIGHT, level, seed);
  const bridgeCells = createBridgeCells(WORLD_WIDTH, WORLD_HEIGHT, level, seed, solidCells);
  const spawnX = spawnXForSeed(seed, WORLD_WIDTH);
  return {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    tickCount: 0,
    tickIntervalMs: nextTickIntervalMs(level),
    level,
    score: 0,
    bestScore: 0,
    playerX: spawnX,
    playerY: WORLD_HEIGHT - 1,
    runState: "alive",
    message: START_MESSAGE,
    seed,
    lanes: createLanes(WORLD_WIDTH, level, seed),
    solidCells,
    bridgeCells,
    queuedHopUntilTick: NO_QUEUED_HOP,
    hopInvulnerableUntilTick: NO_QUEUED_HOP,
    lastInputAtMs: 0,
    lastInputName: "-",
  };
}

function applyCollisionIfNeeded(state: GameState, x: number, y: number): GameState {
  if (!collides(state, x, y)) return state;
  return {
    ...state,
    runState: "crashed!",
    message: "Crash! Double tap to restart.",
    bestScore: Math.max(state.bestScore, state.score),
  };
}

function handleGoalReached(state: GameState): GameState {
  const score = state.score + 1;
  const level = state.level + 1;
  const solidCells = createSolidCells(state.width, state.height, level, state.seed + score * 29);
  const bridgeCells = createBridgeCells(state.width, state.height, level, state.seed + score * 31, solidCells);
  return {
    ...state,
    score,
    level,
    tickIntervalMs: nextTickIntervalMs(level),
    bestScore: Math.max(state.bestScore, score),
    message: `Crossed! Level ${level}fd`,
    lanes: createLanes(state.width, level, state.seed + score * 17),
    solidCells,
    bridgeCells,
    playerX: state.playerX,
    playerY: state.height - 1,
    queuedHopUntilTick: NO_QUEUED_HOP,
    hopInvulnerableUntilTick: NO_QUEUED_HOP,
  };
}

export function applyInput(state: GameState, action: InputAction, atMs: number): GameState {
  const withInputMeta = {
    ...state,
    lastInputAtMs: atMs,
    lastInputName: action,
  };

  if (action === "restart") {
    if (state.runState !== "crashed!") {
      return applyInput(state, "move_up", atMs);
    }
    const restarted = createInitialState(state.seed + 1);
    return {
      ...restarted,
      bestScore: Math.max(state.bestScore, state.score),
      lastInputAtMs: atMs,
      lastInputName: action,
      message: "New run.",
    };
  }

  if (action === "toggle_pause") {
    if (state.runState === "crashed!") return withInputMeta;
    const nextState = state.runState === "paused" ? "alive" : "paused";
    return withMessage({ ...withInputMeta, runState: nextState }, nextState === "paused" ? "Paused." : "Resumed.");
  }

  if (state.runState === "crashed!") {
    return withInputMeta;
  }

  if (state.runState !== "alive") return withInputMeta;

  let x = state.playerX;
  let y = state.playerY;
  let queuedHopUntilTick = action === "move_up" ? state.queuedHopUntilTick : NO_QUEUED_HOP;
  const previousY = state.playerY;

  if (action === "move_left") x = clamp(x - 1, 0, state.width - 1);
  if (action === "move_right") x = clamp(x + 1, 0, state.width - 1);
  if (action === "move_up") {
    const targetY = clamp(y - 1, 0, state.height - 1);
    if (!isSolidCell(state, x, targetY) && hasRoadObstacleAt(state, x, targetY)) {
      return {
        ...withInputMeta,
        queuedHopUntilTick: state.tickCount + 1,
      };
    }
    y = targetY;
  }
  if (isSolidCell(state, x, y)) {
    x = state.playerX;
    y = state.playerY;
  }

  let next: GameState = { ...withInputMeta, playerX: x, playerY: y, queuedHopUntilTick };
  next = withHopGraceIfOnRoad(next, previousY);
  next = applyCollisionIfNeeded(next, x, y);

  if (next.runState === "alive" && y === 0) {
    next = handleGoalReached(next);
  }

  return clearCrossedMessageIfLeftHome(state, next);
}

export function advanceTick(state: GameState): GameState {
  if (state.runState !== "alive") return state;

  const tickCount = state.tickCount + 1;
  const lanes = state.lanes.map((lane) => {
    if (lane.type !== "road") return lane;
    if (tickCount % lane.speedTicks !== 0) return lane;
    return { ...lane, cells: shiftRoadCells(lane.cells, lane.direction) };
  });

  let next: GameState = {
    ...state,
    tickCount,
    lanes,
  };

  next = consumeQueuedHop(next);
  next = applyCollisionIfNeeded(next, next.playerX, next.playerY);
  return clearCrossedMessageIfLeftHome(state, next);
}

export function laneGlyph(lane: Lane, x: number): string {
  if (lane.type === "goal") return x % 2 === 0 ? "▩" : "□";
  if (lane.type === "start") return "□";
  if (!lane.cells[x]) return "▒";
  return "◈";
}
