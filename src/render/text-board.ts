/**
 * Text renderer for both device output (board) and browser diagnostics.
 *
 * Keeping this pure string generation makes render costs predictable and easy to profile.
 */
import { laneGlyph } from "../game/engine";
import type { GameState, Lane } from "../game/types";

// Browser status panel is narrower than device text, so clamp long diagnostic lines
// to keep local debugging readable without horizontal scrolling noise.
const STATUS_MAX_LINE = 46;
const laneRowCache = new WeakMap<Lane, string>();

function clampLine(text: string): string {
  return text.length > STATUS_MAX_LINE ? text.slice(0, STATUS_MAX_LINE) : text;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function renderTextBoard(state: GameState): string {
  const lines: string[] = new Array<string>(state.height);
  for (let y = 0; y < state.height; y++) {
    const lane = state.lanes[y];
    let row = laneRowCache.get(lane);
    if (!row) {
      let built = "";
      for (let x = 0; x < state.width; x++) {
        built += laneGlyph(lane, x);
      }
      row = built;
      laneRowCache.set(lane, row);
    }

    if (state.playerY === y) {
      const playerGlyph = state.runState === "game_over" ? "X" : "●";
      row = `${row.slice(0, state.playerX)}${playerGlyph}${row.slice(state.playerX + 1)}`;
    }

    lines[y] = row;
  }
  return lines.join("\n");
}

export function renderBrowserStatus(state: GameState): string {
  const lines: string[] = [];
  lines.push("EvenRoads V1");
  lines.push(`State: ${state.runState.toUpperCase()}`);
  lines.push(`Score: ${pad2(state.score)}  Best: ${pad2(state.bestScore)}  Level: ${pad2(state.level)}`);
  lines.push(`Tick: ${state.tickIntervalMs}ms  TickCount: ${state.tickCount}`);
  lines.push(`Last Input: ${state.lastInputName}`);
  lines.push(`Message: ${state.message}`);
  lines.push("Controls: ScrollUp=LEFT, ScrollDown=RIGHT, Tap=UP, DoubleTap=PAUSE");
  lines.push("Keyboard (browser): A/Left, D/Right, W/Up, Space/Pause");
  return lines.map(clampLine).join("\n");
}
