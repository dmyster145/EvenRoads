/**
 * App runtime orchestration.
 *
 * Centralizing render/tick/input scheduling here keeps game logic pure and makes
 * transport bottlenecks observable in one place.
 */
import { RoadsBridge, type TextUpdatePriority } from "../evenhub/bridge";
import { loadPersistedBestScore, persistBestScore } from "./best-score-storage";
import {
  CONTAINER_ID_TEXT,
  CONTAINER_NAME_TEXT,
  composeStartupPage,
} from "../evenhub/page";
import { advanceTick, applyInput, createInitialState } from "../game/engine";
import type { GameState, InputAction } from "../game/types";
import { mapEvenHubEventToInput } from "../input/mapper";
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

type RenderReason = "startup" | "input" | "tick";
const RENDER_REASON_STARTUP = 1;
const RENDER_REASON_INPUT = 1 << 1;
const RENDER_REASON_TICK = 1 << 2;
const RENDER_STATS_LOG_EVERY_MS = 4000;
const RENDER_STATS_LOG_MIN_SAMPLES = 24;
const PAGE_SETUP_RETRY_MS = 1500;
const TICK_AFTER_INPUT_BRIDGE_COOLDOWN_MS = 95;
const CRASH_BLINK_INTERVAL_MS = 420;
const NO_INPUT_TRACE = { seq: 0, atMs: 0, name: "-" };

function reasonToMask(reason: RenderReason): number {
  if (reason === "startup") return RENDER_REASON_STARTUP;
  if (reason === "input") return RENDER_REASON_INPUT;
  return RENDER_REASON_TICK;
}

function maskToPrimaryReason(mask: number): RenderReason {
  // Keep input highest priority in logs: when input and ticks interleave, input latency is what we tune first.
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

export async function initApp(): Promise<void> {
  const perfEnabled = isPerfLoggingEnabled();
  const glyphProfile: RenderGlyphProfile = resolveRenderGlyphProfile();
  const boardRoot = document.getElementById("app");
  const statusRoot = document.getElementById("status");
  const bridge = new RoadsBridge();

  console.log(`[EvenRoads] Display profile: ${glyphProfile}`);
  if (glyphProfile === "simulator") {
    console.log("[EvenRoads] Simulator glyph profile active");
  }

  await bridge.init();

  const persistedBestScore = loadPersistedBestScore();
  let state: GameState = clampPlayerXToVisibleWidth(createInitialState(), glyphProfile);
  if (persistedBestScore > state.bestScore) {
    state = { ...state, bestScore: persistedBestScore };
  }
  let lastPersistedBestScore = state.bestScore;
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  let crashBlinkTimer: ReturnType<typeof setInterval> | null = null;
  let crashBlinkVisible = true;
  let destroyed = false;

  let requestedRenderVersion = 0;
  let completedRenderVersion = 0;
  let renderInProgress = false;
  let pendingRenderReasonsMask = 0;

  let isPageInitialized = false;
  let pageSetupInFlight: Promise<void> | null = null;
  let nextPageSetupRetryAtMs = 0;
  let lastPageErrorAtMs = 0;
  let lastPreviewBoardText = "";
  let lastPreviewStatusText = "";
  let lastQueuedDeviceText = "";

  let renderSampleCount = 0;
  let buildTotalMs = 0;
  let buildMaxMs = 0;
  let previewTotalMs = 0;
  let previewMaxMs = 0;
  let setupTotalMs = 0;
  let setupMaxMs = 0;
  let enqueueTotalMs = 0;
  let enqueueMaxMs = 0;
  let skippedPreviewWrites = 0;
  let skippedBridgeWrites = 0;
  let skippedBusyTickWrites = 0;
  let skippedInputCooldownTickWrites = 0;
  let skippedStaticTickRenders = 0;
  let inputToRenderSamples = 0;
  let inputToRenderTotalMs = 0;
  let inputToRenderMaxMs = 0;
  let inputToEnqueueSamples = 0;
  let inputToEnqueueTotalMs = 0;
  let inputToEnqueueMaxMs = 0;
  let lastInputAppliedAtMs = 0;
  let lastRenderStatsLogAtMs = perfNowMs();
  const resetBestScoreHandler: EventListener = () => {
    if (destroyed) return;
    const restarted = clampPlayerXToVisibleWidth(createInitialState(state.seed + 1), glyphProfile);
    lastPersistedBestScore = 0;
    state = {
      ...restarted,
      bestScore: 0,
      message: "New game.",
    };
    syncCrashBlink();
    persistBestScore(0);
    scheduleRender("input");
    scheduleTick();
  };

  function stopCrashBlink(): void {
    if (!crashBlinkTimer) return;
    clearInterval(crashBlinkTimer);
    crashBlinkTimer = null;
  }

  function syncCrashBlink(): void {
    if (destroyed) {
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
      if (destroyed) return;
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
    persistBestScore(nextState.bestScore);
    lastPersistedBestScore = nextState.bestScore;
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
    const avgSetup = renderSampleCount > 0 ? setupTotalMs / renderSampleCount : 0;
    const avgEnqueue = renderSampleCount > 0 ? enqueueTotalMs / renderSampleCount : 0;
    const avgInputToRender = inputToRenderSamples > 0 ? inputToRenderTotalMs / inputToRenderSamples : -1;
    const avgInputToEnqueue = inputToEnqueueSamples > 0 ? inputToEnqueueTotalMs / inputToEnqueueSamples : -1;
    perfLog(
      `[EvenRoads][Perf][Render] samples=${renderSampleCount} avgBuild=${avgBuild.toFixed(2)}ms maxBuild=${buildMaxMs.toFixed(2)}ms ` +
        `avgPreview=${avgPreview.toFixed(2)}ms maxPreview=${previewMaxMs.toFixed(2)}ms ` +
        `avgSetup=${avgSetup.toFixed(2)}ms maxSetup=${setupMaxMs.toFixed(2)}ms ` +
        `avgEnqueue=${avgEnqueue.toFixed(2)}ms maxEnqueue=${enqueueMaxMs.toFixed(2)}ms ` +
        `skipPreview=${skippedPreviewWrites} skipBridge=${skippedBridgeWrites} ` +
        `skipBusyTick=${skippedBusyTickWrites} skipInputCooldownTick=${skippedInputCooldownTickWrites} ` +
        `skipStaticTick=${skippedStaticTickRenders} ` +
        `input->render=${avgInputToRender.toFixed(1)}ms max=${inputToRenderMaxMs.toFixed(1)}ms ` +
        `input->enqueue=${avgInputToEnqueue.toFixed(1)}ms max=${inputToEnqueueMaxMs.toFixed(1)}ms`,
    );

    renderSampleCount = 0;
    buildTotalMs = 0;
    buildMaxMs = 0;
    previewTotalMs = 0;
    previewMaxMs = 0;
    setupTotalMs = 0;
    setupMaxMs = 0;
    enqueueTotalMs = 0;
    enqueueMaxMs = 0;
    skippedPreviewWrites = 0;
    skippedBridgeWrites = 0;
    skippedBusyTickWrites = 0;
    skippedInputCooldownTickWrites = 0;
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

  function startPageSetupIfNeeded(textContent: string): void {
    if (isPageInitialized || pageSetupInFlight || destroyed) return;
    const now = perfNowMs();
    if (now < nextPageSetupRetryAtMs) return;

    const setupStartedAt = now;
    pageSetupInFlight = (async () => {
      const ok = await bridge.setupPage(composeStartupPage(textContent));
      if (!ok) {
        const errNow = perfNowMs();
        nextPageSetupRetryAtMs = errNow + PAGE_SETUP_RETRY_MS;
        if (errNow - lastPageErrorAtMs > 2000) {
          console.warn("[EvenRoads] Failed to apply text page");
          lastPageErrorAtMs = errNow;
        }
        return;
      }

      isPageInitialized = true;
      const setupMs = perfNowMs() - setupStartedAt;
      if (perfEnabled) {
        perfLogLazy(() => `[EvenRoads][Perf][Setup] ready=${setupMs.toFixed(1)}ms`);
      }
      console.log("[EvenRoads] Text page active");
      // Kick an immediate render so the device gets the freshest state after delayed setup.
      scheduleRender("startup");
    })()
      .catch((err: unknown) => {
        console.error("[EvenRoads] setup task failed", err);
      })
      .finally(() => {
        pageSetupInFlight = null;
      });
  }

  async function runRenderLoop(): Promise<void> {
    // Collapse bursts of state changes into sequential renders so SDK sends stay ordered.
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

          const setupStartedAt = perfNowMs();
          if (!isPageInitialized) {
            startPageSetupIfNeeded(deviceText);
          }
          const setupMs = perfNowMs() - setupStartedAt;
          if (!isPageInitialized) {
            if (perfEnabled) {
              renderSampleCount += 1;
              buildTotalMs += buildMs;
              buildMaxMs = Math.max(buildMaxMs, buildMs);
              previewTotalMs += previewMs;
              previewMaxMs = Math.max(previewMaxMs, previewMs);
              setupTotalMs += setupMs;
              setupMaxMs = Math.max(setupMaxMs, setupMs);
              skippedBridgeWrites += 1;
              maybeLogRenderStats();
            }
            completedRenderVersion = targetVersion;
            continue;
          }

          let enqueueMs = 0;
          const priority: TextUpdatePriority =
            primaryReason === "input" ? "input" : primaryReason === "tick" ? "tick" : "default";
          const shouldDropTickFrameForBackpressure = primaryReason === "tick" && bridge.isTransportBusy();
          const shouldDropTickFrameForInputCooldown =
            primaryReason === "tick" &&
            lastInputAppliedAtMs > 0 &&
            renderStartedAt - lastInputAppliedAtMs < TICK_AFTER_INPUT_BRIDGE_COOLDOWN_MS;

          if (shouldDropTickFrameForBackpressure || shouldDropTickFrameForInputCooldown) {
            skippedBridgeWrites += 1;
            if (shouldDropTickFrameForBackpressure) {
              skippedBusyTickWrites += 1;
            } else {
              skippedInputCooldownTickWrites += 1;
            }
          } else if (deviceText !== lastQueuedDeviceText) {
            lastQueuedDeviceText = deviceText;
            const enqueueStartedAt = perfNowMs();
            const queuedText = deviceText;
            void bridge
              .updateText(CONTAINER_ID_TEXT, CONTAINER_NAME_TEXT, queuedText, priority)
              .then((ok) => {
                if (!ok && lastQueuedDeviceText === queuedText) {
                  lastQueuedDeviceText = "";
                }
              })
              .catch((err) => {
                if (lastQueuedDeviceText === queuedText) {
                  lastQueuedDeviceText = "";
                }
                console.error("[EvenRoads] bridge update enqueue failed", err);
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
            setupTotalMs += setupMs;
            setupMaxMs = Math.max(setupMaxMs, setupMs);
            enqueueTotalMs += enqueueMs;
            enqueueMaxMs = Math.max(enqueueMaxMs, enqueueMs);

            if (primaryReason !== "tick") {
              perfLogLazy(
                () =>
                  `[EvenRoads][Perf][${primaryReason}] v=${targetVersion} input=${inputTrace.name}#${inputTrace.seq} ` +
                  `input->render=${fromInputMs.toFixed(1)}ms build=${buildMs.toFixed(2)}ms preview=${previewMs.toFixed(2)}ms ` +
                  `setup=${setupMs.toFixed(2)}ms enqueue=${enqueueMs.toFixed(2)}ms`,
              );
            }
            maybeLogRenderStats();
          }
        } catch (err) {
          console.error("[EvenRoads] render iteration failed", err);
        }

        completedRenderVersion = targetVersion;
      }
    } finally {
      renderInProgress = false;
    }
  }

  function scheduleRender(reason: RenderReason): void {
    pendingRenderReasonsMask |= reasonToMask(reason);
    requestedRenderVersion += 1;
    void runRenderLoop();
  }

  function applyAction(action: InputAction): void {
    const prevRunState = state.runState;
    const prevTickMs = state.tickIntervalMs;
    const input = recordInput(action);
    lastInputAppliedAtMs = input.atMs;
    state = applyInput(state, action, input.atMs, {
      maxPlayerX: maxPlayableX(state, glyphProfile),
    });
    syncCrashBlink();
    syncBestScorePersistence(state);
    scheduleRender("input");

    const runStateChanged = prevRunState !== state.runState;
    const tickChanged = prevTickMs !== state.tickIntervalMs;
    if (runStateChanged || tickChanged) {
      scheduleTick();
    }
  }

  function scheduleTick(): void {
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    if (destroyed || state.runState !== "alive") return;

    // Use setTimeout instead of setInterval so long frames do not queue multiple stale ticks.
    tickTimer = setTimeout(() => {
      if (destroyed) return;
      if (state.runState !== "alive") return;

      const beforeTickState = state;
      const nextTickState = advanceTick(beforeTickState);
      state = clampPlayerXToVisibleWidth(nextTickState, glyphProfile);
      syncCrashBlink();
      syncBestScorePersistence(state);

      let didVisualChange = beforeTickState.runState !== nextTickState.runState;
      if (!didVisualChange) {
        for (let i = 0; i < beforeTickState.lanes.length; i++) {
          if (beforeTickState.lanes[i] !== nextTickState.lanes[i]) {
            didVisualChange = true;
            break;
          }
        }
      }

      if (didVisualChange) {
        scheduleRender("tick");
      } else {
        skippedStaticTickRenders += 1;
        maybeLogRenderStats();
      }
      scheduleTick();
    }, state.tickIntervalMs);
  }

  syncCrashBlink();
  const initialRenderOptions = { showCrashedState: crashBlinkVisible, glyphProfile };
  const initialDeviceText = renderTextBoard(state, initialRenderOptions);
  const initialStatusText = renderBrowserStatus(state, initialRenderOptions);
  updatePreview(initialDeviceText, initialStatusText);

  bridge.subscribeEvents((event) => {
    const action = mapEvenHubEventToInput(event);
    if (!action) return;
    applyAction(action);
  });

  const keyHandler = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    const key = event.key;
    const lowerKey = key.length === 1 ? key.toLowerCase() : key;

    if (lowerKey === "ArrowUp" || lowerKey === "w") {
      event.preventDefault();
      applyAction("move_up");
      return;
    }
    if (lowerKey === "ArrowLeft" || lowerKey === "a") {
      event.preventDefault();
      applyAction("move_left");
      return;
    }
    if (lowerKey === "ArrowRight" || lowerKey === "d") {
      event.preventDefault();
      applyAction("move_right");
      return;
    }
    if (key === " " || lowerKey === "p") {
      event.preventDefault();
      applyAction("toggle_pause");
    }
  };
  window.addEventListener("keydown", keyHandler, { passive: false });
  window.addEventListener("evenroads:reset-best-score", resetBestScoreHandler);

  scheduleRender("startup");
  scheduleTick();

  window.addEventListener("beforeunload", () => {
    destroyed = true;
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    stopCrashBlink();
    maybeLogRenderStats(true);
    window.removeEventListener("keydown", keyHandler);
    window.removeEventListener("evenroads:reset-best-score", resetBestScoreHandler);
    void bridge.shutdown();
  });
}
