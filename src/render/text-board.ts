/**
 * Text renderer for both device output (board) and browser diagnostics.
 *
 * Keeping this pure string generation makes render costs predictable and easy to profile.
 */
import { laneGlyph } from "../game/engine";
import type { GameState, Lane } from "../game/types";
import type { RenderGlyphProfile } from "./display-profile";

interface BoardGlyphs {
  markerRight: string;
  markerLeft: string;
  bridge: string;
  solid: string;
  playerAlive: string;
  playerCrashed: string;
}

const DEVICE_GLYPHS: BoardGlyphs = {
  markerRight: "▷",
  markerLeft: "◁",
  bridge: "□",
  solid: "▩",
  playerAlive: "▲",
  playerCrashed: "※",
};

const laneRowCache = new WeakMap<Lane, string>();
const CRASHED_STATE_LABEL = "CRASHED!";

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export interface RenderTextOptions {
  showCrashedState?: boolean;
  glyphProfile?: RenderGlyphProfile;
}

function renderRunState(state: GameState, options?: RenderTextOptions): string {
  if (state.runState !== "crashed!") return state.runState.toUpperCase();
  if (options?.showCrashedState === false) return " ".repeat(CRASHED_STATE_LABEL.length);
  return CRASHED_STATE_LABEL;
}

function renderCrossedStatusMessage(state: GameState): string {
  return /^Crossed! Level \d+\.?$/.test(state.message) ? `  ${state.message}` : "";
}

function renderScoreboardLine(state: GameState, options?: RenderTextOptions): string {
  return `Score: ${pad2(state.score)}  Best: ${pad2(state.bestScore)}  State: ${renderRunState(state, options)}${renderCrossedStatusMessage(state)}`;
}

function glyphsForProfile(_profile: RenderGlyphProfile | undefined): BoardGlyphs {
  // Keep one glyph mapping across device/simulator so visual semantics stay identical in docs/screenshots.
  return DEVICE_GLYPHS;
}

function laneGlyphForProfile(lane: Lane, x: number): string {
  return laneGlyph(lane, x);
}

export function visibleBoardWidth(stateWidth: number, profile: RenderGlyphProfile | undefined): number {
  if (profile !== "simulator") return stateWidth;
  return Math.max(0, stateWidth - 2);
}

function withDirectionalObstacleMarkers(row: string, lane: Lane, glyphs: BoardGlyphs): string {
  if (lane.type !== "road") return row;
  const width = lane.cells.length;
  const chars = row.split("");
  for (let x = 0; x < width; x++) {
    if (!lane.cells[x]) continue;
    if (lane.direction === 1) {
      const nextX = (x + 1) % width;
      if (!lane.cells[nextX]) {
        chars[x] = glyphs.markerRight;
      }
      continue;
    }
    const prevX = (x - 1 + width) % width;
    if (!lane.cells[prevX]) {
      chars[x] = glyphs.markerLeft;
    }
  }
  return chars.join("");
}

export function renderTextBoard(state: GameState, options?: RenderTextOptions): string {
  const glyphs = glyphsForProfile(options?.glyphProfile);
  const visibleWidth = visibleBoardWidth(state.width, options?.glyphProfile);
  const lines: string[] = new Array<string>(state.height + 1);
  lines[0] = renderScoreboardLine(state, options);

  for (let y = 0; y < state.height; y++) {
    const lane = state.lanes[y];
    let row = laneRowCache.get(lane);
    if (!row) {
      let built = "";
      for (let x = 0; x < state.width; x++) {
        built += laneGlyphForProfile(lane, x);
      }
      row = built;
      laneRowCache.set(lane, row);
    }
    row = withDirectionalObstacleMarkers(row, lane, glyphs);

    const bridgeRow = state.bridgeCells[y];
    if (bridgeRow && bridgeRow.some((isBridge) => isBridge)) {
      const chars = row.split("");
      for (let x = 0; x < state.width; x++) {
        if (bridgeRow[x]) {
          chars[x] = glyphs.bridge;
        }
      }
      row = chars.join("");
    }

    const solidRow = state.solidCells[y];
    if (solidRow && solidRow.some((isSolid) => isSolid)) {
      const chars = row.split("");
      for (let x = 0; x < state.width; x++) {
        if (solidRow[x]) {
          chars[x] = glyphs.solid;
        }
      }
      row = chars.join("");
    }

    if (state.playerY === y) {
      const playerGlyph = state.runState === "crashed!" ? glyphs.playerCrashed : glyphs.playerAlive;
      row = `${row.slice(0, state.playerX)}${playerGlyph}${row.slice(state.playerX + 1)}`;
    }

    lines[y + 1] = visibleWidth === state.width ? row : row.slice(0, visibleWidth);
  }
  return lines.join("\n");
}

export function renderBrowserStatus(state: GameState, options?: RenderTextOptions): string {
  return renderScoreboardLine(state, options);
}
