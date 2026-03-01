# EvenRoads

Text-first Crossy Roads / Frogger-style prototype for Even Realities G2.

## Current Scope

- Text rendering only (no image rendering path)
- Reaction-time gameplay with moving road hazards
- Low-overhead runtime with one-time page setup and per-frame text updates

## Controls

- `Scroll up`: move left
- `Scroll down`: move right
- `Tap`: move up
- `Double tap`: pause/resume
- `Tap while game over`: restart

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Automated Testing

Run all unit and stress tests against compiled production modules:

```bash
npm test
```

### Performance Baseline Tracking

Analyze a log export (from the debug panel copy output) and print issue flags:

```bash
npm run perf:analyze -- /path/to/PerfLog.txt --json docs/perf/latest-summary.json
```

Regenerate the committed baseline summary from `2026-03-01`:

```bash
npm run perf:baseline
```

Compare a new run summary against the baseline:

```bash
npm run perf:compare -- docs/perf/baseline-summary.json docs/perf/latest-summary.json
```

## Architecture

`src/game/*`
- Deterministic engine and state contracts. No SDK dependencies.

`src/input/mapper.ts`
- Normalizes Even Hub events into engine actions with lightweight dedupe guards.

`src/evenhub/*`
- SDK bridge and startup page composition.

`src/render/text-board.ts`
- Pure string renderer for device board output and browser status panel.

`src/app/init.ts`
- Runtime orchestration: page setup, render scheduling, input dispatch, and tick loop.

`src/debug/console.ts`
- On-page log console for glass/device debugging without external devtools.
