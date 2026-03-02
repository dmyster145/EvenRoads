/**
 * Text renderer for both device output (board) and browser diagnostics.
 *
 * Keeping this pure string generation makes render costs predictable and easy to profile.
 */
import { laneGlyph } from "../game/engine";
import type { GameState, Lane } from "../game/types";

const laneRowCache = new WeakMap<Lane, string>();

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function renderScoreboardLine(state: GameState): string {
  return `Score: ${pad2(state.score)}  Best: ${pad2(state.bestScore)}  Level: ${pad2(state.level)}  State: ${state.runState.toUpperCase()}`;
}

export function renderTextBoard(state: GameState): string {
  const lines: string[] = new Array<string>(state.height + 1);
  lines[0] = renderScoreboardLine(state);

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

    const solidRow = state.solidCells[y];
    if (solidRow && solidRow.some((isSolid) => isSolid)) {
      const chars = row.split("");
      for (let x = 0; x < state.width; x++) {
        if (solidRow[x]) {
          chars[x] = "■";
        }
      }
      row = chars.join("");
    }

    if (state.playerY === y) {
      const playerGlyph = state.runState === "dead!" ? "X" : "●";
      row = `${row.slice(0, state.playerX)}${playerGlyph}${row.slice(state.playerX + 1)}`;
    }

    lines[y + 1] = row;
  }
  return lines.join("\n");
}

export function renderBrowserStatus(state: GameState): string {
  return renderScoreboardLine(state);
}
