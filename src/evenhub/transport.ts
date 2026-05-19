/**
 * Low-level transport for Even Hub bridge I/O.
 *
 * Every call to the SDK is wrapped in a timeout so a single hung BLE hop
 * cannot freeze the send queue. The text-update queue is priority-aware
 * (input > default > tick) and coalesces redundant updates.
 *
 * A timeout is logged and counted but does NOT brick the queue — the next
 * queued item proceeds. Three consecutive timeouts emit a `degraded` signal
 * so the runtime can pause sends instead of piling more timeouts on a stuck
 * link.
 */
import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { isPerfLoggingEnabled, perfLogLazy, perfNowMs } from "../perf/log";

export type TextUpdatePriority = "tick" | "default" | "input";
export type SetupResult = "ok" | "permanent" | "retry";
export type DegradedListener = () => void;

const PRIORITY_TICK = 0;
const PRIORITY_DEFAULT = 1;
const PRIORITY_INPUT = 2;

const INPUT_GUARD_TICK_DROP_MS = 85;
// Ceiling on how often tick-priority frames are admitted to the send queue.
// The simulation tick rate accelerates with level (down to ~90ms), but BLE
// cannot push a full-board text payload that fast; uncapped, the link
// saturates at higher levels and trips the degraded path (the freeze that
// worsens with score). Input/default priority is never throttled, so input
// latency is unaffected — only the device frame rate is bounded.
const MIN_TICK_SEND_INTERVAL_MS = 150;
const BRIDGE_STATS_LOG_EVERY_MS = 4000;
const BRIDGE_STATS_LOG_MIN_SENDS = 24;
const CONSECUTIVE_TIMEOUTS_FOR_DEGRADED = 3;

export const TIMEOUT_BRIDGE_INIT_MS = 10_000;
export const TIMEOUT_PAGE_SETUP_MS = 6000;
export const TIMEOUT_TEXT_UPDATE_MS = 4000;
export const TIMEOUT_SHUTDOWN_MS = 3000;
export const TIMEOUT_STORAGE_MS = 3000;

class TransportTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`Transport timeout: ${label} > ${timeoutMs}ms`);
    this.name = "TransportTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TransportTimeoutError(label, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function waitForBridgeWithTimeout(): Promise<EvenAppBridge | null> {
  try {
    return await withTimeout(waitForEvenAppBridge(), TIMEOUT_BRIDGE_INIT_MS, "bridgeInit");
  } catch (err) {
    if (err instanceof TransportTimeoutError) {
      console.warn(`[HoppyRoads][Transport] ${err.message} — falling back to preview mode`);
    } else {
      console.warn("[HoppyRoads][Transport] bridge init failed", err);
    }
    return null;
  }
}

type QueuedTextUpdate = {
  id: number;
  name: string;
  content: string;
  enqueuedAtMs: number;
  priority: number;
};

function toPriorityWeight(priority: TextUpdatePriority): number {
  if (priority === "input") return PRIORITY_INPUT;
  if (priority === "default") return PRIORITY_DEFAULT;
  return PRIORITY_TICK;
}

export class Transport {
  private readonly perfEnabled = isPerfLoggingEnabled();
  private bridge: EvenAppBridge | null = null;

  private isSendingText = false;
  private senderTask: Promise<void> | null = null;
  private queuedText: QueuedTextUpdate | null = null;
  private inFlightText = "";
  private lastSentText = "";
  private discardNextResult = false;
  private consecutiveTimeouts = 0;
  private degradedSignaled = false;
  private readonly degradedListeners = new Set<DegradedListener>();
  private lastInputEnqueueAtMs = 0;
  private lastTickSendAtMs = 0;

  private sendCount = 0;
  private sendTotalMs = 0;
  private sendMaxMs = 0;
  private sendMinMs = Infinity;
  private queueDelayTotalMs = 0;
  private queueDelayMaxMs = 0;
  private coalescedCount = 0;
  private unchangedSkipCount = 0;
  private failedSendCount = 0;
  private timeoutCount = 0;
  private droppedLowerPriorityCount = 0;
  private droppedRecentInputTickCount = 0;
  private lastStatsLogAtMs = perfNowMs();

  setBridge(bridge: EvenAppBridge | null): void {
    this.bridge = bridge;
  }

  hasBridge(): boolean {
    return this.bridge !== null;
  }

  onDegraded(listener: DegradedListener): () => void {
    this.degradedListeners.add(listener);
    return () => this.degradedListeners.delete(listener);
  }

  isBusy(): boolean {
    return this.isSendingText || this.queuedText !== null;
  }

  /**
   * Mark any in-flight send as no-op-on-resolve. Used on FG_EXIT or disconnect
   * so a promise that may or may not eventually resolve doesn't update state.
   */
  discardInFlight(): void {
    this.discardNextResult = true;
  }

  /**
   * Drop the pending queue and reset the dedupe baseline. Called on disconnect
   * so the first send after reconnect isn't skipped as a duplicate.
   */
  dropQueue(): void {
    this.queuedText = null;
    this.lastSentText = "";
    this.inFlightText = "";
  }

  resetDegraded(): void {
    this.consecutiveTimeouts = 0;
    this.degradedSignaled = false;
  }

  async setupPage(page: CreateStartUpPageContainer): Promise<SetupResult> {
    if (!this.bridge) return "retry";
    try {
      const startedAt = perfNowMs();
      const result = await withTimeout(
        this.bridge.createStartUpPageContainer(page),
        TIMEOUT_PAGE_SETUP_MS,
        "setupPage",
      );
      const elapsedMs = perfNowMs() - startedAt;
      this.recordCallSuccess();
      if (result === StartUpPageCreateResult.success) {
        if (this.perfEnabled) {
          perfLogLazy(() => `[HoppyRoads][Perf][Bridge] setupPage=${elapsedMs.toFixed(1)}ms`);
        }
        return "ok";
      }
      // 1=invalid, 2=oversize, 3=outOfMemory — deterministic; retrying same payload won't help.
      console.warn(
        `[HoppyRoads][Transport] setupPage permanent failure result=${result} (1=invalid,2=oversize,3=oom)`,
      );
      return "permanent";
    } catch (err) {
      this.recordCallFailure(err, "setupPage");
      return "retry";
    }
  }

  async rebuildPage(page: RebuildPageContainer): Promise<SetupResult> {
    if (!this.bridge) return "retry";
    try {
      const startedAt = perfNowMs();
      const ok = await withTimeout(
        this.bridge.rebuildPageContainer(page),
        TIMEOUT_PAGE_SETUP_MS,
        "rebuildPage",
      );
      const elapsedMs = perfNowMs() - startedAt;
      this.recordCallSuccess();
      if (ok) {
        if (this.perfEnabled) {
          perfLogLazy(() => `[HoppyRoads][Transport] rebuildPage ok in ${elapsedMs.toFixed(1)}ms`);
        }
        return "ok";
      }
      return "retry";
    } catch (err) {
      this.recordCallFailure(err, "rebuildPage");
      return "retry";
    }
  }

  async shutdownPage(exitMode = 0): Promise<void> {
    if (!this.bridge) {
      console.log(`[HoppyRoads][Transport] shutdownPage(${exitMode}) skipped — no bridge`);
      return;
    }
    try {
      console.log(`[HoppyRoads][Transport] shutdownPage(${exitMode}) → calling SDK`);
      const ok = await withTimeout(
        this.bridge.shutDownPageContainer(exitMode),
        TIMEOUT_SHUTDOWN_MS,
        "shutdownPage",
      );
      console.log(`[HoppyRoads][Transport] shutdownPage(${exitMode}) SDK returned ${ok}`);
    } catch (err) {
      console.log(`[HoppyRoads][Transport] shutdownPage(${exitMode}) threw/timed out: ${String(err)}`);
      this.recordCallFailure(err, "shutdownPage");
    }
  }

  async writeStorage(key: string, value: string): Promise<void> {
    if (!this.bridge) {
      try {
        window.localStorage?.setItem(key, value);
      } catch {
        // ignore
      }
      return;
    }
    try {
      await withTimeout(
        this.bridge.setLocalStorage(key, value),
        TIMEOUT_STORAGE_MS,
        "writeStorage",
      );
      this.recordCallSuccess();
    } catch (err) {
      this.recordCallFailure(err, "writeStorage");
    }
  }

  async readStorage(key: string): Promise<string | null> {
    if (!this.bridge) {
      try {
        return window.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    }
    try {
      const result = await withTimeout(
        this.bridge.getLocalStorage(key),
        TIMEOUT_STORAGE_MS,
        "readStorage",
      );
      this.recordCallSuccess();
      return result ?? null;
    } catch (err) {
      this.recordCallFailure(err, "readStorage");
      return null;
    }
  }

  /**
   * Queue a text update. Returns true if the request was accepted (queued,
   * coalesced, or skipped as redundant); false on enqueue failure.
   */
  async updateText(
    containerID: number,
    containerName: string,
    content: string,
    priority: TextUpdatePriority = "default",
  ): Promise<boolean> {
    if (!this.bridge) return false;

    if (content === this.lastSentText && !this.queuedText && !this.isSendingText) {
      if (this.perfEnabled) this.unchangedSkipCount += 1;
      this.maybeLogTransportStats();
      return true;
    }

    if (this.isSendingText && content === this.inFlightText) {
      this.queuedText = null;
      if (this.perfEnabled) this.unchangedSkipCount += 1;
      this.maybeLogTransportStats();
      return true;
    }

    const now = perfNowMs();
    const nextPriority = toPriorityWeight(priority);
    if (priority === "input") {
      this.lastInputEnqueueAtMs = now;
    } else if (
      priority === "tick" &&
      this.lastInputEnqueueAtMs > 0 &&
      now - this.lastInputEnqueueAtMs < INPUT_GUARD_TICK_DROP_MS
    ) {
      // Protect fresh input responsiveness by suppressing near-term tick churn.
      if (this.perfEnabled) this.droppedRecentInputTickCount += 1;
      this.maybeLogTransportStats();
      return true;
    }

    if (
      priority === "tick" &&
      this.lastTickSendAtMs > 0 &&
      now - this.lastTickSendAtMs < MIN_TICK_SEND_INTERVAL_MS
    ) {
      // Frame-rate cap: the sim ticks faster than BLE can transmit at higher
      // levels. Drop the intermediate tick frame — local state already moved
      // on; the next admitted frame reflects it.
      this.maybeLogTransportStats();
      return true;
    }
    if (priority === "tick") {
      this.lastTickSendAtMs = now;
    }

    if (this.queuedText) {
      if (this.queuedText.content === content) {
        if (this.perfEnabled) this.unchangedSkipCount += 1;
        this.maybeLogTransportStats();
        return true;
      }

      if (this.queuedText.priority > nextPriority) {
        if (this.perfEnabled) this.droppedLowerPriorityCount += 1;
        this.maybeLogTransportStats();
        return true;
      }

      if (this.perfEnabled) this.coalescedCount += 1;
    }

    this.queuedText = {
      id: containerID,
      name: containerName,
      content,
      enqueuedAtMs: now,
      priority: nextPriority,
    };

    void this.ensureSenderTask();
    return true;
  }

  private ensureSenderTask(): Promise<void> {
    if (this.senderTask) return this.senderTask;
    if (!this.bridge) return Promise.resolve();
    const first = this.queuedText;
    if (!first) return Promise.resolve();

    this.queuedText = null;
    this.isSendingText = true;
    this.inFlightText = first.content;
    // Defer transport work to a microtask so input/render paths do not pay sync send overhead.
    this.senderTask = Promise.resolve()
      .then(() => this.runSendLoop(first))
      .finally(() => {
        this.inFlightText = "";
        this.isSendingText = false;
        this.senderTask = null;
        if (this.queuedText && this.bridge) {
          void this.ensureSenderTask();
        }
      });
    return this.senderTask;
  }

  private async runSendLoop(first: QueuedTextUpdate): Promise<void> {
    let next: QueuedTextUpdate | null = first;
    while (next && this.bridge) {
      const queuedItem = next;
      const sendStartedAt = this.perfEnabled ? perfNowMs() : 0;
      const queueDelayMs = this.perfEnabled ? sendStartedAt - queuedItem.enqueuedAtMs : 0;
      this.inFlightText = queuedItem.content;

      let ok = false;
      try {
        ok = await withTimeout(
          this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: queuedItem.id,
              containerName: queuedItem.name,
              content: queuedItem.content,
            }),
          ),
          TIMEOUT_TEXT_UPDATE_MS,
          "textUpgrade",
        );
      } catch (err) {
        this.recordCallFailure(err, "textUpgrade");
        ok = false;
      }

      if (this.discardNextResult) {
        // Disconnect or FG_EXIT happened mid-flight — abandon the result and
        // reset baseline so the next send isn't dedupe-skipped on resume.
        this.discardNextResult = false;
        this.lastSentText = "";
      } else {
        const sendMs = this.perfEnabled ? perfNowMs() - sendStartedAt : 0;
        if (this.perfEnabled) {
          this.sendCount += 1;
          this.sendTotalMs += sendMs;
          this.sendMaxMs = Math.max(this.sendMaxMs, sendMs);
          this.sendMinMs = Math.min(this.sendMinMs, sendMs);
          this.queueDelayTotalMs += queueDelayMs;
          this.queueDelayMaxMs = Math.max(this.queueDelayMaxMs, queueDelayMs);
        }

        if (ok) {
          this.lastSentText = queuedItem.content;
          this.recordCallSuccess();
        } else if (this.perfEnabled) {
          this.failedSendCount += 1;
        }
      }

      this.maybeLogTransportStats();
      next = this.queuedText;
      this.queuedText = null;
    }
  }

  private recordCallSuccess(): void {
    if (this.consecutiveTimeouts > 0) {
      this.consecutiveTimeouts = 0;
    }
    if (this.degradedSignaled) {
      this.degradedSignaled = false;
    }
  }

  private recordCallFailure(err: unknown, label: string): void {
    if (err instanceof TransportTimeoutError) {
      this.timeoutCount += 1;
      this.consecutiveTimeouts += 1;
      console.warn(`[HoppyRoads][Transport] ${err.message}`);
      if (
        this.consecutiveTimeouts >= CONSECUTIVE_TIMEOUTS_FOR_DEGRADED &&
        !this.degradedSignaled
      ) {
        this.degradedSignaled = true;
        for (const fn of this.degradedListeners) {
          try {
            fn();
          } catch (listenerErr) {
            console.error("[HoppyRoads][Transport] degraded listener threw", listenerErr);
          }
        }
      }
    } else {
      this.failedSendCount += 1;
      console.error(`[HoppyRoads][Transport] ${label} threw`, err);
    }
  }

  private maybeLogTransportStats(force = false): void {
    if (!this.perfEnabled) return;
    const now = perfNowMs();
    const shouldLogByTime = now - this.lastStatsLogAtMs >= BRIDGE_STATS_LOG_EVERY_MS;
    const shouldLogByCount = this.sendCount >= BRIDGE_STATS_LOG_MIN_SENDS;
    if (!force && !shouldLogByTime && !shouldLogByCount) return;

    if (
      this.sendCount === 0 &&
      this.coalescedCount === 0 &&
      this.unchangedSkipCount === 0 &&
      this.failedSendCount === 0 &&
      this.timeoutCount === 0 &&
      this.droppedLowerPriorityCount === 0 &&
      this.droppedRecentInputTickCount === 0
    ) {
      this.lastStatsLogAtMs = now;
      return;
    }

    const avgSendMs = this.sendCount > 0 ? this.sendTotalMs / this.sendCount : 0;
    const avgQueueMs = this.sendCount > 0 ? this.queueDelayTotalMs / this.sendCount : 0;
    const minSendMs = this.sendMinMs === Infinity ? 0 : this.sendMinMs;
    perfLogLazy(
      () =>
        `[HoppyRoads][Perf][Bridge] sends=${this.sendCount} avgSend=${avgSendMs.toFixed(1)}ms maxSend=${this.sendMaxMs.toFixed(1)}ms minSend=${minSendMs.toFixed(1)}ms ` +
        `avgQueue=${avgQueueMs.toFixed(1)}ms maxQueue=${this.queueDelayMaxMs.toFixed(1)}ms ` +
        `coalesced=${this.coalescedCount} skippedSame=${this.unchangedSkipCount} droppedLowPri=${this.droppedLowerPriorityCount} ` +
        `dropRecentInputTick=${this.droppedRecentInputTickCount} failed=${this.failedSendCount} timeouts=${this.timeoutCount} ` +
        `consecutiveTimeouts=${this.consecutiveTimeouts}`,
    );

    this.sendCount = 0;
    this.sendTotalMs = 0;
    this.sendMaxMs = 0;
    this.sendMinMs = Infinity;
    this.queueDelayTotalMs = 0;
    this.queueDelayMaxMs = 0;
    this.coalescedCount = 0;
    this.unchangedSkipCount = 0;
    this.failedSendCount = 0;
    this.timeoutCount = 0;
    this.droppedLowerPriorityCount = 0;
    this.droppedRecentInputTickCount = 0;
    this.lastStatsLogAtMs = now;
  }

  flushStats(): void {
    this.maybeLogTransportStats(true);
  }
}
