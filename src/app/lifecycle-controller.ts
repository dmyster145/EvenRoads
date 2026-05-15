/**
 * Lifecycle controller: the single state machine wiring bridge events
 * (lifecycle, connection, input) and transport health into runtime control
 * (pause / resume / page-setup) plus the exit flow.
 *
 * State transitions:
 *  - FOREGROUND_EXIT / disconnect / degraded → runtime.pause(), transport.discardInFlight()
 *  - FOREGROUND_ENTER / reconnect → reset mapper, rebuildPage (or setupPage if first
 *    boot), then runtime.resume()
 *  - ABNORMAL_EXIT / SYSTEM_EXIT → terminal cleanup (no auto-reconnect)
 *  - Double-tap during alive/paused → requestExit (system dialog). Crashed → restart.
 *
 * Page setup retry policy (8 attempts, exponential backoff):
 *  - 500, 1000, 2000, 4000, 4000, 4000, 4000, 4000 ms between attempts
 *  - 'permanent' result → no retries (set data-bridge-state="failed")
 *  - Reconnect resets the attempt budget
 *  - Attempt 1 uses createStartUpPageContainer; attempts 2+ use rebuildPageContainer
 *    (the SDK requires createStartUp is one-shot per session).
 */
import type { EvenHubEvent } from "@evenrealities/even_hub_sdk";
import type { RoadsBridge } from "../evenhub/bridge";
import type { LifecycleEventName, ConnectionState } from "../evenhub/lifecycle";
import { composeRebuildPage, composeStartupPage } from "../evenhub/page";
import type { Runtime } from "./runtime";
import { mapEvenHubEventToInput } from "../input/mapper";
import { resetInputMapperState } from "../input/mapper";

const PAGE_SETUP_BACKOFFS_MS = [500, 1000, 2000, 4000, 4000, 4000, 4000, 4000];
const DOUBLE_TAP_LIFECYCLE_TYPE = 3; // OsEventTypeList.DOUBLE_CLICK_EVENT
// Firmware can emit several DOUBLE_CLICK events for one physical double-tap.
// Collapse them here so a single gesture can't both restart (crashed) and
// then re-trigger as an exit (the restart flips runState to "alive" between
// the duplicate events). Wider than the mapper's 20ms scroll/tap window
// because the decision here (restart vs exit) is state-changing.
const DOUBLE_TAP_ACTION_DEDUPE_MS = 600;
// Observed exit-dialog event sequence (from on-device logs):
//   double-tap → shutDownPageContainer(1) returns true (dialog shown)
//   → FOREGROUND_ENTER (sys=4)  : host cleared the page; we rebuild it here
//   → [user decides; game runs] → FOREGROUND_EXIT (sys=5) when "No" is tapped
//   → (or SYSTEM_EXIT sys=7 when "Yes" is tapped)
// So for the exit dialog the polarity is INVERTED vs a genuine background:
// FOREGROUND_EXIT means "dialog dismissed, keep running", NOT "app backgrounded".
// While an exit request is pending we must not pause on FOREGROUND_EXIT.
// Safety cap so a stuck flag can't suppress a later genuine background pause.
const EXIT_DIALOG_MAX_MS = 20_000;

type BridgeStateAttr = "idle" | "connecting" | "ready" | "degraded" | "disconnected" | "failed";

export interface LifecycleControllerOptions {
  bridge: RoadsBridge;
  runtime: Runtime;
}

export interface LifecycleController {
  start(): void;
  destroy(): Promise<void>;
  requestExit(): Promise<void>;
}

export function createLifecycleController(
  options: LifecycleControllerOptions,
): LifecycleController {
  const { bridge, runtime } = options;
  let terminal = false;
  let setupInFlight = false;
  let setupAttempts = 0;
  let setupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let pageEverSetUp = false;
  let degradedActive = false;
  let unsubscribeTransportDegraded: (() => void) | null = null;
  let started = false;
  let lastDoubleTapActionAtMs = 0;
  let exitInFlight = false;
  let exitDialogPending = false;
  let exitDialogTimer: ReturnType<typeof setTimeout> | null = null;

  function clearExitDialogPending(): void {
    exitDialogPending = false;
    if (exitDialogTimer !== null) {
      clearTimeout(exitDialogTimer);
      exitDialogTimer = null;
    }
  }

  function setBridgeStateAttr(value: BridgeStateAttr): void {
    if (typeof document !== "undefined" && document.body) {
      document.body.setAttribute("data-bridge-state", value);
    }
  }

  function clearSetupRetryTimer(): void {
    if (setupRetryTimer !== null) {
      clearTimeout(setupRetryTimer);
      setupRetryTimer = null;
    }
  }

  function scheduleSetupRetry(): void {
    if (terminal) return;
    if (setupAttempts >= PAGE_SETUP_BACKOFFS_MS.length) {
      console.error("[HoppyRoads][Controller] page setup exhausted retry budget");
      setBridgeStateAttr("failed");
      return;
    }
    const delay = PAGE_SETUP_BACKOFFS_MS[setupAttempts];
    clearSetupRetryTimer();
    setupRetryTimer = setTimeout(() => {
      setupRetryTimer = null;
      void doPageSetup();
    }, delay);
  }

  async function doPageSetup(): Promise<void> {
    if (terminal || setupInFlight || !bridge.hasBridge()) return;
    setupInFlight = true;
    setupAttempts += 1;
    setBridgeStateAttr("connecting");

    const text = runtime.getCurrentDeviceText();
    const isFirstAttempt = setupAttempts === 1 && !pageEverSetUp;
    console.log(
      `[HoppyRoads][Controller] doPageSetup attempt=${setupAttempts} via=${isFirstAttempt ? "setupPage" : "rebuildPage"}`,
    );
    const result = isFirstAttempt
      ? await bridge.transport.setupPage(composeStartupPage(text))
      : await bridge.transport.rebuildPage(composeRebuildPage(text));
    setupInFlight = false;
    console.log(`[HoppyRoads][Controller] doPageSetup result=${result}`);

    if (terminal) return;

    if (result === "ok") {
      pageEverSetUp = true;
      setupAttempts = 0;
      clearSetupRetryTimer();
      setBridgeStateAttr("ready");
      runtime.markPageReady();
      console.log("[HoppyRoads][Controller] page ready");
      return;
    }

    if (result === "permanent") {
      setBridgeStateAttr("failed");
      return;
    }

    // 'retry'
    scheduleSetupRetry();
  }

  function resetSetupRetryBudget(): void {
    setupAttempts = 0;
    clearSetupRetryTimer();
  }

  function handleConnection(state: ConnectionState): void {
    if (terminal) return;
    console.log(`[HoppyRoads][Controller] connection state: ${state}`);
    if (state === "connected") {
      if (degradedActive) {
        degradedActive = false;
        bridge.transport.resetDegraded();
      }
      resetSetupRetryBudget();
      setBridgeStateAttr("connecting");
      runtime.resetPageSetup();
      void doPageSetup();
      // Resume only happens after page setup completes (markPageReady) — but
      // if the runtime was paused due to disconnect, we should be ready to
      // re-run once the page is ready. The runtime stays paused until then.
      if (runtime.isPaused()) {
        runtime.resume();
      }
      return;
    }

    if (state === "disconnected" || state === "failed") {
      setBridgeStateAttr(state === "failed" ? "failed" : "disconnected");
      bridge.transport.discardInFlight();
      bridge.transport.dropQueue();
      clearSetupRetryTimer();
      runtime.resetPageSetup();
      runtime.pause();
      return;
    }

    if (state === "connecting") {
      setBridgeStateAttr("connecting");
      return;
    }

    // "unknown" — assume connected until told otherwise; no action.
  }

  function handleLifecycle(name: LifecycleEventName): void {
    if (terminal) return;
    console.log(`[HoppyRoads][Controller] lifecycle: ${name}`);
    switch (name) {
      case "foregroundExit": {
        if (exitDialogPending) {
          // This is the exit dialog being dismissed ("No"), NOT the app
          // backgrounding. The page was already rebuilt on the dialog's
          // FOREGROUND_ENTER. Do NOT pause — the game must keep running.
          console.log(
            "[HoppyRoads][Controller] foregroundExit during exit dialog — cancel, not pausing",
          );
          clearExitDialogPending();
          if (runtime.isPaused()) runtime.resume();
          return;
        }
        bridge.transport.discardInFlight();
        runtime.pause();
        bridge.transport.flushStats();
        return;
      }
      case "foregroundEnter": {
        resetInputMapperState();
        if (!pageEverSetUp) {
          // First time foregrounding without an existing page — kick a setup.
          if (!setupInFlight && setupRetryTimer === null) {
            void doPageSetup();
          }
        } else {
          // Rebuild in the background so the current display stays live.
          // Do NOT call resetPageSetup() here — that sets isPageReady=false
          // and freezes the display until rebuild completes. The SDK fires
          // FOREGROUND_ENTER after both genuine backgrounds AND after the user
          // dismisses the exit dialog; in both cases the existing container is
          // still valid and a background rebuild is the right response.
          resetSetupRetryBudget();
          void doPageSetup();
        }
        if (runtime.isPaused()) {
          runtime.resume();
        }
        return;
      }
      case "abnormalExit": {
        console.warn("[HoppyRoads][Controller] abnormal exit — terminal cleanup");
        clearExitDialogPending();
        void terminalCleanup();
        return;
      }
      case "systemExit": {
        // User confirmed "Yes" on the exit dialog.
        clearExitDialogPending();
        void terminalCleanup();
        return;
      }
    }
  }

  function handleInput(event: EvenHubEvent): void {
    if (terminal) return;
    // Double-tap may arrive as sysEvent OR textEvent OR listEvent depending on
    // which container captured it (our text container has isEventCapture=1, so
    // input events usually come through textEvent). Check all three.
    const eventType =
      event.sysEvent?.eventType ??
      event.textEvent?.eventType ??
      event.listEvent?.eventType ??
      -1;
    if (eventType === DOUBLE_TAP_LIFECYCLE_TYPE) {
      const now = Date.now();
      const sinceLast = now - lastDoubleTapActionAtMs;
      if (sinceLast < DOUBLE_TAP_ACTION_DEDUPE_MS) {
        // Firmware duplicate of a double-tap we already acted on. Drop it so
        // one physical gesture can't restart (crashed) and then, now that the
        // restart flipped runState to "alive", re-fire as an exit.
        console.log(`[HoppyRoads][Controller] double-tap dropped (dup ${sinceLast}ms)`);
        return;
      }
      lastDoubleTapActionAtMs = now;
      const runState = runtime.getGameState().runState;
      console.log(`[HoppyRoads][Controller] double-tap accepted runState=${runState}`);
      if (runState === "alive") {
        void requestExit();
      } else {
        // crashed/paused → restart. Apply directly rather than via the mapper
        // so the mapper's separate (shorter) dedupe window can't drop it.
        runtime.applyAction("restart");
      }
      return;
    }
    const action = mapEvenHubEventToInput(event);
    if (!action) return;
    runtime.applyAction(action);
  }

  function handleDegraded(): void {
    if (terminal || degradedActive) return;
    degradedActive = true;
    console.warn(
      "[HoppyRoads][Controller] transport degraded (3 consecutive timeouts) — pausing runtime",
    );
    setBridgeStateAttr("degraded");
    bridge.transport.discardInFlight();
    bridge.transport.dropQueue();
    runtime.pause();
  }

  async function requestExit(): Promise<void> {
    if (terminal || exitInFlight) return;
    exitInFlight = true;
    // Arm the pending flag synchronously, before any await, so the dialog's
    // FOREGROUND_ENTER/EXIT events (which fire within ~100ms) are interpreted
    // as dialog lifecycle, not app background.
    exitDialogPending = true;
    if (exitDialogTimer !== null) clearTimeout(exitDialogTimer);
    exitDialogTimer = setTimeout(() => {
      // Dialog never resolved (no No/Yes) — release so a later genuine
      // background can still pause normally.
      console.log("[HoppyRoads][Controller] exit dialog timed out — clearing pending");
      clearExitDialogPending();
    }, EXIT_DIALOG_MAX_MS);
    console.log("[HoppyRoads][Controller] requestExit: calling shutdownPage(1)");
    try {
      // Shows the exit dialog. The host clears the page container as a side
      // effect, then fires FOREGROUND_ENTER (sys=4) → we rebuild it there.
      // "Yes" → SYSTEM_EXIT (sys=7) → terminalCleanup.
      // "No"  → FOREGROUND_EXIT (sys=5) → handled WITHOUT pausing.
      await bridge.transport.shutdownPage(1);
      console.log(
        `[HoppyRoads][Controller] requestExit: shutdownPage resolved (terminal=${terminal})`,
      );
    } finally {
      exitInFlight = false;
    }
  }

  async function terminalCleanup(): Promise<void> {
    if (terminal) return;
    terminal = true;
    clearSetupRetryTimer();
    clearExitDialogPending();
    unsubscribeTransportDegraded?.();
    unsubscribeTransportDegraded = null;
    runtime.pause();
    runtime.destroy();
    setBridgeStateAttr("idle");
    await bridge.shutdown();
  }

  function start(): void {
    if (started || terminal) return;
    started = true;
    setBridgeStateAttr("connecting");

    bridge.subscribe({
      onLifecycle: handleLifecycle,
      onInput: handleInput,
      onConnection: (state) => handleConnection(state),
    });

    unsubscribeTransportDegraded = bridge.transport.onDegraded(handleDegraded);

    // Kick the initial page setup. Connection state may be "unknown" at this
    // point — we assume connected per skill best practice; if a disconnected
    // status fires later, handleConnection will pause + tear down.
    if (bridge.hasBridge()) {
      void doPageSetup();
    } else {
      // Preview mode: no real bridge, mark page ready so the runtime renders
      // straight to the DOM preview.
      runtime.markPageReady();
      setBridgeStateAttr("ready");
    }
  }

  return {
    start,
    destroy: terminalCleanup,
    requestExit,
  };
}
