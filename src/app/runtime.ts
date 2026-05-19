/**
 * Pausable game runtime.
 *
 * Owns the game state, tick scheduling, render scheduling, and input
 * application. Pausing cancels ticks, stops the crash blink, and short-circuits
 * `scheduleRender` / `scheduleTick`. Resuming clamps the wall-clock backlog so
 * we advance exactly one tick after a long background instead of catching up
 * the full delta in a burst (catching up was the bug at the heart of the iOS
 * resume freeze).
 *
 * All transport writes flow through `bridge.transport.updateText` so the
 * per-call timeout in the transport protects this layer from BLE hangs.
 */
import type { RoadsBridge } from "../evenhub/bridge";
import type { TextUpdatePriority } from "../evenhub/transport";
import { CONTAINER_ID_TEXT, CONTAINER_NAME_TEXT } from "../evenhub/page";
import { advanceTick, applyInput, createInitialState } from "../game/engine";
import type { GameState, InputAction } from "../game/types";
import {
  getLastInputTrace,
  isPerfLoggingEnabled,
  perfLog,
  perfLogLazy,
  perfNowMs,
  recordInput,
} from "../perf/log";
import { renderBrowserStatus, renderTextBoard, visibleBoardWidth } from "../render/text-board";
import { resolveRenderGlyphProfile, type RenderGlyphProfile } from "../render/display-profile";
import { createTickSource, type TickSource } from "./tick-source";
import { advanceDueTicks } from "./tick-timeline";
import { loadBestScoreFromBridge, persistBestScoreToBridge } from "./best-score-storage";

type RenderReason = "startup" | "input" | "tick";
const RENDER_REASON_STARTUP = 1;
const RENDER_REASON_INPUT = 1 << 1;
const RENDER_REASON_TICK = 1 << 2;
const RENDER_STATS_LOG_EVERY_MS = 4000;
const RENDER_STATS_LOG_MIN_SAMPLES = 24;
const CRASH_BLINK_INTERVAL_MS = 420;
const NO_INPUT_TRACE = { seq: 0, atMs: 0, name: "-" };

function reasonToMask(reason: RenderReason): number {
  if (reason === "startup") return RENDER_REASON_STARTUP;
  if (reason === "input") return RENDER_REASON_INPUT;
  return RENDER_REASON_TICK;
}

function maskToPrimaryReason(mask: number): RenderReason {
  if ((mask & RENDER_REASON_INPUT) !== 0) return "input";
  if ((mask & RENDER_REASON_STARTUP) !== 0) return "startup";
  return "tick";
}

function clampPlayerXToVisibleWidth(state: GameState, glyphProfile: RenderGlyphProfile): GameState {
  const visibleWidth = visibleBoardWidth(state.width, glyphProfile);
  const maxPlayerX = Math.max(0, visibleWidth - 1);
  const clampedPlayerX = Math.max(0, Math.min(maxPlayerX, state.playerX));
  if (clampedPlayerX === state.playerX) return state;
  return { ...state, playerX: clampedPlayerX };
}

function maxPlayableX(state: GameState, glyphProfile: RenderGlyphProfile): number {
  return Math.max(0, visibleBoardWidth(state.width, glyphProfile) - 1);
}

function didTickChangeVisibleState(beforeState: GameState, nextState: GameState): boolean {
  if (beforeState.runState !== nextState.runState) return true;
  if (beforeState.playerX !== nextState.playerX || beforeState.playerY !== nextState.playerY) return true;
  if (beforeState.score !== nextState.score || beforeState.bestScore !== nextState.bestScore) return true;
  if (beforeState.level !== nextState.level || beforeState.message !== nextState.message) return true;
  for (let i = 0; i < beforeState.lanes.length; i++) {
    if (beforeState.lanes[i] !== nextState.lanes[i]) return true;
  }
  return false;
}

export type RuntimeRunState = "stopped" | "running" | "paused";

export interface RuntimeOptions {
  bridge: RoadsBridge;
  glyphProfile?: RenderGlyphProfile;
}

export interface Runtime {
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  destroy(): void;
  isPaused(): boolean;
  getRunState(): RuntimeRunState;
  getGameState(): GameState;
  getCurrentDeviceText(): string;
  applyAction(action: InputAction): void;
  /**
   * Re-render and re-queue text so the next page setup picks up the latest
   * state. Used after a reconnect-driven rebuildPage.
   */
  requestStartupRender(): void;
  /**
   * Mark the page as needing setup (e.g. after disconnect). The next render
   * loop iteration will detect missing setup and request it.
   */
  resetPageSetup(): void;
  /**
   * Called by the controller after page setup completes successfully.
   */
  markPageReady(): void;
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const perfEnabled = isPerfLoggingEnabled();
  const glyphProfile: RenderGlyphProfile = options.glyphProfile ?? resolveRenderGlyphProfile();
  const bridge = options.bridge;
  const boardRoot = typeof document !== "undefined" ? document.getElementById("app") : null;
  const statusRoot = typeof document !== "undefined" ? document.getElementById("status") : null;

  console.log(`[HoppyRoads] Display profile: ${glyphProfile}`);
  if (glyphProfile === "simulator") {
    console.log("[HoppyRoads] Simulator glyph profile active");
  }

  let state: GameState = clampPlayerXToVisibleWidth(createInitialState(), glyphProfile);
  let lastPersistedBestScore = state.bestScore;
  let lastLoggedLevel = state.level;
  let lastLoggedRunState: GameState["runState"] = state.runState;
  let crashBlinkTimer: ReturnType<typeof setInterval> | null = null;
  let crashBlinkVisible = true;
  let runState: RuntimeRunState = "stopped";
  let destroyed = false;
  let nextTickDueAtMs = 0;
  let isPageReady = false;
  let lastPreviewBoardText = "";
  let lastPreviewStatusText = "";
  let lastQueuedDeviceText = "";

  let requestedRenderVersion = 0;
  let completedRenderVersion = 0;
  let renderInProgress = false;
  let pendingRenderReasonsMask = 0;

  const tickSource: TickSource = createTickSource(() => {
    drainTicksAndSchedule();
  });

  let renderSampleCount = 0;
  let buildTotalMs = 0;
  let buildMaxMs = 0;
  let previewTotalMs = 0;
  let previewMaxMs = 0;
  let enqueueTotalMs = 0;
  let enqueueMaxMs = 0;
  let skippedPreviewWrites = 0;
  let skippedBridgeWrites = 0;
  let skippedStaticTickRenders = 0;
  let inputToRenderSamples = 0;
  let inputToRenderTotalMs = 0;
  let inputToRenderMaxMs = 0;
  let inputToEnqueueSamples = 0;
  let inputToEnqueueTotalMs = 0;
  let inputToEnqueueMaxMs = 0;
  let lastRenderStatsLogAtMs = perfNowMs();

  function stopCrashBlink(): void {
    if (!crashBlinkTimer) return;
    clearInterval(crashBlinkTimer);
    crashBlinkTimer = null;
  }

  function syncCrashBlink(): void {
    if (destroyed || runState !== "running") {
      stopCrashBlink();
      crashBlinkVisible = true;
      return;
    }
    if (state.runState !== "crashed!") {
      stopCrashBlink();
      crashBlinkVisible = true;
      return;
    }
    if (crashBlinkTimer) return;

    crashBlinkVisible = true;
    crashBlinkTimer = setInterval(() => {
      if (destroyed || runState !== "running") return;
      if (state.runState !== "crashed!") {
        syncCrashBlink();
        return;
      }
      crashBlinkVisible = !crashBlinkVisible;
      scheduleRender("tick");
    }, CRASH_BLINK_INTERVAL_MS);
  }

  function syncBestScorePersistence(nextState: GameState): void {
    if (nextState.bestScore <= lastPersistedBestScore) return;
    persistBestScoreToBridge(nextState.bestScore, bridge);
    lastPersistedBestScore = nextState.bestScore;
  }

  // Game-state markers so a captured log can correlate a transport `degraded`
  // with the level/score it happened at. Idempotent (logs only on change), so
  // it's safe to call from both the tick and input paths.
  function logGameStateTransition(): void {
    if (!perfEnabled) return;
    if (state.level !== lastLoggedLevel) {
      const prevLevel = lastLoggedLevel;
      lastLoggedLevel = state.level;
      perfLogLazy(
        () =>
          `[HoppyRoads][Game] level ${prevLevel}->${state.level} score=${state.score} tickMs=${state.tickIntervalMs} runState=${state.runState}`,
      );
    }
    if (state.runState !== lastLoggedRunState) {
      const prevRun = lastLoggedRunState;
      lastLoggedRunState = state.runState;
      perfLogLazy(
        () =>
          `[HoppyRoads][Game] runState ${prevRun}->${state.runState} level=${state.level} score=${state.score}`,
      );
    }
  }

  function maybeLogRenderStats(force = false): void {
    if (!perfEnabled) return;
    const now = perfNowMs();
    const shouldLogByTime = now - lastRenderStatsLogAtMs >= RENDER_STATS_LOG_EVERY_MS;
    const shouldLogByCount = renderSampleCount >= RENDER_STATS_LOG_MIN_SAMPLES;
    if (!force && !shouldLogByTime && !shouldLogByCount) return;
    if (
      renderSampleCount === 0 &&
      skippedBridgeWrites === 0 &&
      skippedPreviewWrites === 0 &&
      skippedStaticTickRenders === 0
    ) {
      lastRenderStatsLogAtMs = now;
      return;
    }

    const avgBuild = renderSampleCount > 0 ? buildTotalMs / renderSampleCount : 0;
    const avgPreview = renderSampleCount > 0 ? previewTotalMs / renderSampleCount : 0;
    const avgEnqueue = renderSampleCount > 0 ? enqueueTotalMs / renderSampleCount : 0;
    const avgInputToRender = inputToRenderSamples > 0 ? inputToRenderTotalMs / inputToRenderSamples : -1;
    const avgInputToEnqueue = inputToEnqueueSamples > 0 ? inputToEnqueueTotalMs / inputToEnqueueSamples : -1;
    // avgSetup/maxSetup are kept as zero placeholders for compatibility with the
    // perf log analyzer regex; setup happens in the controller now, not the render loop.
    perfLog(
      `[HoppyRoads][Perf][Render] samples=${renderSampleCount} avgBuild=${avgBuild.toFixed(2)}ms maxBuild=${buildMaxMs.toFixed(2)}ms ` +
        `avgPreview=${avgPreview.toFixed(2)}ms maxPreview=${previewMaxMs.toFixed(2)}ms ` +
        `avgSetup=0.00ms maxSetup=0.00ms ` +
        `avgEnqueue=${avgEnqueue.toFixed(2)}ms maxEnqueue=${enqueueMaxMs.toFixed(2)}ms ` +
        `skipPreview=${skippedPreviewWrites} skipBridge=${skippedBridgeWrites} ` +
        `skipStaticTick=${skippedStaticTickRenders} ` +
        `input->render=${avgInputToRender.toFixed(1)}ms max=${inputToRenderMaxMs.toFixed(1)}ms ` +
        `input->enqueue=${avgInputToEnqueue.toFixed(1)}ms max=${inputToEnqueueMaxMs.toFixed(1)}ms`,
    );

    renderSampleCount = 0;
    buildTotalMs = 0;
    buildMaxMs = 0;
    previewTotalMs = 0;
    previewMaxMs = 0;
    enqueueTotalMs = 0;
    enqueueMaxMs = 0;
    skippedPreviewWrites = 0;
    skippedBridgeWrites = 0;
    skippedStaticTickRenders = 0;
    inputToRenderSamples = 0;
    inputToRenderTotalMs = 0;
    inputToRenderMaxMs = 0;
    inputToEnqueueSamples = 0;
    inputToEnqueueTotalMs = 0;
    inputToEnqueueMaxMs = 0;
    lastRenderStatsLogAtMs = now;
  }

  function updatePreview(boardText: string, statusText: string): boolean {
    let changed = false;
    if (boardRoot && boardText !== lastPreviewBoardText) {
      boardRoot.textContent = boardText;
      lastPreviewBoardText = boardText;
      changed = true;
    }
    if (statusRoot && statusText !== lastPreviewStatusText) {
      statusRoot.textContent = statusText;
      lastPreviewStatusText = statusText;
      changed = true;
    }
    return changed;
  }

  function advanceDueGameTicks(nowMs: number): { advancedCount: number; didVisualChange: boolean } {
    let didVisualChange = false;
    let skippedStaticTicks = 0;
    const result = advanceDueTicks({
      state,
      nowMs,
      nextDueAtMs: nextTickDueAtMs,
      canAdvance: (currentState) => currentState.runState === "alive",
      getIntervalMs: (currentState) => currentState.tickIntervalMs,
      advance: (currentState) => {
        const nextTickState = clampPlayerXToVisibleWidth(advanceTick(currentState), glyphProfile);
        if (didTickChangeVisibleState(currentState, nextTickState)) {
          didVisualChange = true;
        } else {
          skippedStaticTicks += 1;
        }
        return nextTickState;
      },
    });

    state = result.state;
    nextTickDueAtMs = result.nextDueAtMs;
    if (result.advancedCount > 0) {
      if (skippedStaticTicks > 0) {
        skippedStaticTickRenders += skippedStaticTicks;
      }
      syncCrashBlink();
      syncBestScorePersistence(state);
      logGameStateTransition();
    }
    return {
      advancedCount: result.advancedCount,
      didVisualChange,
    };
  }

  async function runRenderLoop(): Promise<void> {
    if (renderInProgress) return;
    renderInProgress = true;

    try {
      while (!destroyed && completedRenderVersion < requestedRenderVersion) {
        const targetVersion = requestedRenderVersion;
        const reasonsMask = pendingRenderReasonsMask;
        pendingRenderReasonsMask = 0;
        const primaryReason = maskToPrimaryReason(reasonsMask);

        try {
          const renderStartedAt = perfNowMs();
          const buildStartedAt = renderStartedAt;
          const textRenderOptions = { showCrashedState: crashBlinkVisible, glyphProfile };
          const deviceText = renderTextBoard(state, textRenderOptions);
          const statusText = renderBrowserStatus(state, textRenderOptions);
          const buildMs = perfNowMs() - buildStartedAt;

          const previewStartedAt = perfNowMs();
          const previewChanged = updatePreview(deviceText, statusText);
          const previewMs = perfNowMs() - previewStartedAt;
          if (!previewChanged) {
            skippedPreviewWrites += 1;
          }

          const inputTrace = perfEnabled ? getLastInputTrace() : NO_INPUT_TRACE;
          const fromInputMs = perfEnabled && inputTrace.atMs > 0 ? renderStartedAt - inputTrace.atMs : -1;
          const trackInputLatency = perfEnabled && primaryReason === "input";
          if (trackInputLatency && fromInputMs >= 0) {
            inputToRenderSamples += 1;
            inputToRenderTotalMs += fromInputMs;
            inputToRenderMaxMs = Math.max(inputToRenderMaxMs, fromInputMs);
          }

          if (!isPageReady) {
            // Don't send while page isn't set up. The lifecycle controller is
            // responsible for setting up the page; we just skip the bridge write.
            if (perfEnabled) {
              renderSampleCount += 1;
              buildTotalMs += buildMs;
              buildMaxMs = Math.max(buildMaxMs, buildMs);
              previewTotalMs += previewMs;
              previewMaxMs = Math.max(previewMaxMs, previewMs);
              skippedBridgeWrites += 1;
              maybeLogRenderStats();
            }
            completedRenderVersion = targetVersion;
            continue;
          }

          let enqueueMs = 0;
          const priority: TextUpdatePriority =
            primaryReason === "input" ? "input" : primaryReason === "tick" ? "tick" : "default";
          if (deviceText !== lastQueuedDeviceText) {
            lastQueuedDeviceText = deviceText;
            const enqueueStartedAt = perfNowMs();
            const queuedText = deviceText;
            void bridge.transport
              .updateText(CONTAINER_ID_TEXT, CONTAINER_NAME_TEXT, queuedText, priority)
              .then((ok) => {
                if (!ok && lastQueuedDeviceText === queuedText) {
                  // Reset the dedupe baseline so a retry can re-queue the same text.
                  lastQueuedDeviceText = "";
                }
              })
              .catch((err) => {
                if (lastQueuedDeviceText === queuedText) {
                  lastQueuedDeviceText = "";
                }
                console.error("[HoppyRoads] bridge update enqueue failed", err);
              });
            enqueueMs = perfNowMs() - enqueueStartedAt;

            const inputToEnqueueMs = inputTrace.atMs > 0 ? perfNowMs() - inputTrace.atMs : -1;
            if (trackInputLatency && inputToEnqueueMs >= 0) {
              inputToEnqueueSamples += 1;
              inputToEnqueueTotalMs += inputToEnqueueMs;
              inputToEnqueueMaxMs = Math.max(inputToEnqueueMaxMs, inputToEnqueueMs);
            }
          } else {
            skippedBridgeWrites += 1;
          }

          if (perfEnabled) {
            renderSampleCount += 1;
            buildTotalMs += buildMs;
            buildMaxMs = Math.max(buildMaxMs, buildMs);
            previewTotalMs += previewMs;
            previewMaxMs = Math.max(previewMaxMs, previewMs);
            enqueueTotalMs += enqueueMs;
            enqueueMaxMs = Math.max(enqueueMaxMs, enqueueMs);

            if (primaryReason !== "tick") {
              perfLogLazy(
                () =>
                  `[HoppyRoads][Perf][${primaryReason}] v=${targetVersion} input=${inputTrace.name}#${inputTrace.seq} ` +
                  `input->render=${fromInputMs.toFixed(1)}ms build=${buildMs.toFixed(2)}ms preview=${previewMs.toFixed(2)}ms ` +
                  `enqueue=${enqueueMs.toFixed(2)}ms`,
              );
            }
            maybeLogRenderStats();
          }
        } catch (err) {
          console.error("[HoppyRoads] render iteration failed", err);
        }

        completedRenderVersion = targetVersion;
      }
    } finally {
      renderInProgress = false;
    }
  }

  function scheduleRender(reason: RenderReason): void {
    if (destroyed) return;
    pendingRenderReasonsMask |= reasonToMask(reason);
    requestedRenderVersion += 1;
    void runRenderLoop();
  }

  function scheduleTick(resetPhase = false): void {
    tickSource.cancel();
    if (destroyed || runState !== "running" || state.runState !== "alive") {
      nextTickDueAtMs = 0;
      return;
    }

    const now = perfNowMs();
    if (resetPhase || nextTickDueAtMs <= 0) {
      nextTickDueAtMs = now + state.tickIntervalMs;
    }
    tickSource.schedule(Math.max(0, nextTickDueAtMs - now));
  }

  function drainTicksAndSchedule(): void {
    if (destroyed || runState !== "running") return;
    const { advancedCount, didVisualChange } = advanceDueGameTicks(perfNowMs());
    if (advancedCount > 0) {
      if (didVisualChange) {
        scheduleRender("tick");
      } else {
        maybeLogRenderStats();
      }
    }
    scheduleTick(false);
  }

  function applyAction(action: InputAction): void {
    if (destroyed) return;
    if (runState !== "running") return;

    const { advancedCount, didVisualChange } = advanceDueGameTicks(perfNowMs());
    if (advancedCount > 0) {
      if (didVisualChange) {
        scheduleRender("tick");
      } else {
        maybeLogRenderStats();
      }
    }

    const prevRunState = state.runState;
    const prevTickMs = state.tickIntervalMs;
    const input = recordInput(action);
    state = applyInput(state, action, input.atMs, {
      maxPlayerX: maxPlayableX(state, glyphProfile),
    });
    syncCrashBlink();
    syncBestScorePersistence(state);
    logGameStateTransition();
    scheduleRender("input");

    const runStateChanged = prevRunState !== state.runState;
    const tickChanged = prevTickMs !== state.tickIntervalMs;
    scheduleTick(runStateChanged || tickChanged || advancedCount > 0);
  }

  function resetBestScore(): void {
    const restarted = clampPlayerXToVisibleWidth(createInitialState(state.seed + 1), glyphProfile);
    lastPersistedBestScore = 0;
    state = {
      ...restarted,
      bestScore: 0,
      message: "New game.",
    };
    syncCrashBlink();
    persistBestScoreToBridge(0, bridge);
    if (runState === "running") {
      scheduleRender("input");
      scheduleTick(true);
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("hoppyroads:reset-best-score", () => {
      if (destroyed) return;
      resetBestScore();
    });
  }

  async function start(): Promise<void> {
    if (destroyed) return;
    const persistedBestScore = await loadBestScoreFromBridge(bridge);
    if (persistedBestScore > state.bestScore) {
      state = { ...state, bestScore: persistedBestScore };
      lastPersistedBestScore = state.bestScore;
    }

    const initialRenderOptions = { showCrashedState: crashBlinkVisible, glyphProfile };
    const initialDeviceText = renderTextBoard(state, initialRenderOptions);
    const initialStatusText = renderBrowserStatus(state, initialRenderOptions);
    updatePreview(initialDeviceText, initialStatusText);

    runState = "running";
    syncCrashBlink();
    scheduleRender("startup");
    scheduleTick(true);
  }

  function pause(): void {
    if (destroyed || runState !== "running") return;
    runState = "paused";
    tickSource.cancel();
    nextTickDueAtMs = 0;
    stopCrashBlink();
    maybeLogRenderStats(true);
  }

  function resume(): void {
    if (destroyed || runState !== "paused") return;
    runState = "running";
    // Clamp wall-clock backlog: do not catch up missed ticks. Advance exactly
    // one tick from "now" so the player sees a fresh frame instead of a burst.
    nextTickDueAtMs = perfNowMs() + state.tickIntervalMs;
    syncCrashBlink();
    scheduleRender("startup");
    scheduleTick(true);
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    runState = "stopped";
    tickSource.destroy();
    stopCrashBlink();
    maybeLogRenderStats(true);
  }

  function getCurrentDeviceText(): string {
    return renderTextBoard(state, { showCrashedState: crashBlinkVisible, glyphProfile });
  }

  return {
    start,
    pause,
    resume,
    destroy,
    isPaused: () => runState === "paused",
    getRunState: () => runState,
    getGameState: () => state,
    getCurrentDeviceText,
    applyAction,
    requestStartupRender: () => {
      lastQueuedDeviceText = "";
      scheduleRender("startup");
    },
    resetPageSetup: () => {
      isPageReady = false;
      lastQueuedDeviceText = "";
    },
    markPageReady: () => {
      isPageReady = true;
      lastQueuedDeviceText = "";
      scheduleRender("startup");
    },
  };
}
