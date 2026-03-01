/**
 * Even Hub bridge wrapper.
 *
 * We keep this intentionally small:
 * - one-time page setup
 * - coalesced text updates
 * - event subscription wiring
 *
 * Keeping transport concerns here avoids leaking SDK-specific behavior into gameplay code.
 */
import {
  waitForEvenAppBridge,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import { perfNowMs } from "../perf/log";

export type EvenHubEventHandler = (event: EvenHubEvent) => void;
export type TextUpdatePriority = "tick" | "default" | "input";
const BRIDGE_STATS_LOG_EVERY_MS = 4000;
const BRIDGE_STATS_LOG_MIN_SENDS = 24;
const INPUT_GUARD_TICK_DROP_MS = 85;

type QueuedTextUpdate = {
  id: number;
  name: string;
  content: string;
  enqueuedAtMs: number;
  priority: number;
};

const PRIORITY_TICK = 0;
const PRIORITY_DEFAULT = 1;
const PRIORITY_INPUT = 2;

function toPriorityWeight(priority: TextUpdatePriority): number {
  if (priority === "input") return PRIORITY_INPUT;
  if (priority === "default") return PRIORITY_DEFAULT;
  return PRIORITY_TICK;
}

export class RoadsBridge {
  private bridge: EvenAppBridge | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private isSendingText = false;
  private senderTask: Promise<void> | null = null;
  private queuedText: QueuedTextUpdate | null = null;
  private inFlightText = "";
  private lastSentText = "";
  private sendCount = 0;
  private sendTotalMs = 0;
  private sendMaxMs = 0;
  private sendMinMs = Infinity;
  private queueDelayTotalMs = 0;
  private queueDelayMaxMs = 0;
  private coalescedCount = 0;
  private unchangedSkipCount = 0;
  private failedSendCount = 0;
  private droppedLowerPriorityCount = 0;
  private droppedRecentInputTickCount = 0;
  private lastInputEnqueueAtMs = 0;
  private lastStatsLogAtMs = perfNowMs();

  private maybeLogTransportStats(force = false): void {
    const now = perfNowMs();
    const shouldLogByTime = now - this.lastStatsLogAtMs >= BRIDGE_STATS_LOG_EVERY_MS;
    const shouldLogByCount = this.sendCount >= BRIDGE_STATS_LOG_MIN_SENDS;
    if (!force && !shouldLogByTime && !shouldLogByCount) return;

    if (
      this.sendCount === 0 &&
      this.coalescedCount === 0 &&
      this.unchangedSkipCount === 0 &&
      this.failedSendCount === 0 &&
      this.droppedLowerPriorityCount === 0 &&
      this.droppedRecentInputTickCount === 0
    ) {
      this.lastStatsLogAtMs = now;
      return;
    }

    const avgSendMs = this.sendCount > 0 ? this.sendTotalMs / this.sendCount : 0;
    const avgQueueMs = this.sendCount > 0 ? this.queueDelayTotalMs / this.sendCount : 0;
    const minSendMs = this.sendMinMs === Infinity ? 0 : this.sendMinMs;
    console.log(
      `[EvenRoads][Perf][Bridge] sends=${this.sendCount} avgSend=${avgSendMs.toFixed(1)}ms maxSend=${this.sendMaxMs.toFixed(1)}ms minSend=${minSendMs.toFixed(1)}ms ` +
        `avgQueue=${avgQueueMs.toFixed(1)}ms maxQueue=${this.queueDelayMaxMs.toFixed(1)}ms ` +
        `coalesced=${this.coalescedCount} skippedSame=${this.unchangedSkipCount} droppedLowPri=${this.droppedLowerPriorityCount} ` +
        `dropRecentInputTick=${this.droppedRecentInputTickCount} failed=${this.failedSendCount}`,
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
    this.droppedLowerPriorityCount = 0;
    this.droppedRecentInputTickCount = 0;
    this.lastStatsLogAtMs = now;
  }

  isTransportBusy(): boolean {
    return this.isSendingText || !!this.queuedText;
  }

  async init(): Promise<void> {
    const startedAt = perfNowMs();
    try {
      this.bridge = await waitForEvenAppBridge();
      const waitMs = perfNowMs() - startedAt;
      console.log(`[EvenRoads][Bridge] ready in ${waitMs.toFixed(1)}ms`);
    } catch (err) {
      console.warn("[EvenRoads][Bridge] init failed (preview mode)", err);
      this.bridge = null;
    }
  }

  async setupPage(page: CreateStartUpPageContainer): Promise<boolean> {
    if (!this.bridge) return false;
    try {
      const setupStartedAt = perfNowMs();
      const result = await this.bridge.createStartUpPageContainer(page);
      const setupMs = perfNowMs() - setupStartedAt;
      if (result === 0) {
        console.log(`[EvenRoads][Perf][Bridge] setupPage=${setupMs.toFixed(1)}ms`);
      }
      if (result !== 0) {
        console.warn(`[EvenRoads][Bridge] setupPage returned non-zero result=${result}`);
        try {
          console.warn("[EvenRoads][Bridge] setupPage payload", CreateStartUpPageContainer.toJson(page));
        } catch (jsonErr) {
          console.warn("[EvenRoads][Bridge] setupPage payload serialization failed", jsonErr);
        }
      }
      return result === 0;
    } catch (err) {
      console.error("[EvenRoads][Bridge] setup failed", err);
      return false;
    }
  }

  async updateText(
    containerID: number,
    containerName: string,
    content: string,
    priority: TextUpdatePriority = "default",
  ): Promise<boolean> {
    if (!this.bridge) return false;
    if (content === this.lastSentText && !this.queuedText && !this.isSendingText) {
      this.unchangedSkipCount += 1;
      this.maybeLogTransportStats();
      return true;
    }

    const nextPriority = toPriorityWeight(priority);

    if (this.isSendingText && content === this.inFlightText) {
      // The latest state matches what is already in flight; drop any stale queued payload.
      this.queuedText = null;
      this.unchangedSkipCount += 1;
      this.maybeLogTransportStats();
      return true;
    }

    const now = perfNowMs();
    if (priority === "input") {
      this.lastInputEnqueueAtMs = now;
    } else if (
      priority === "tick" &&
      this.lastInputEnqueueAtMs > 0 &&
      now - this.lastInputEnqueueAtMs < INPUT_GUARD_TICK_DROP_MS
    ) {
      // Protect fresh input responsiveness by suppressing near-term tick churn.
      this.droppedRecentInputTickCount += 1;
      this.maybeLogTransportStats();
      return true;
    }

    if (this.queuedText) {
      if (this.queuedText.content === content) {
        this.unchangedSkipCount += 1;
        this.maybeLogTransportStats();
        return true;
      }

      if (this.queuedText.priority > nextPriority) {
        // Keep higher-priority pending updates (typically input) from being displaced by tick churn.
        this.droppedLowerPriorityCount += 1;
        this.maybeLogTransportStats();
        return true;
      }

      this.coalescedCount += 1;
    }

    this.queuedText = {
      id: containerID,
      name: containerName,
      content,
      enqueuedAtMs: now,
      priority: nextPriority,
    };

    try {
      await this.ensureSenderTask();
      return true;
    } catch (err) {
      this.failedSendCount += 1;
      this.maybeLogTransportStats(true);
      console.error("[EvenRoads][Bridge] text update failed", err);
      return false;
    }
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
      const sendStartedAt = perfNowMs();
      const queueDelayMs = sendStartedAt - next.enqueuedAtMs;
      this.inFlightText = next.content;
      const ok = await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: next.id,
          containerName: next.name,
          content: next.content,
        }),
      );
      const sendMs = perfNowMs() - sendStartedAt;
      this.sendCount += 1;
      this.sendTotalMs += sendMs;
      this.sendMaxMs = Math.max(this.sendMaxMs, sendMs);
      this.sendMinMs = Math.min(this.sendMinMs, sendMs);
      this.queueDelayTotalMs += queueDelayMs;
      this.queueDelayMaxMs = Math.max(this.queueDelayMaxMs, queueDelayMs);

      if (ok) {
        this.lastSentText = next.content;
      } else {
        this.failedSendCount += 1;
      }
      this.maybeLogTransportStats();
      next = this.queuedText;
      this.queuedText = null;
    }
  }

  subscribeEvents(handler: EvenHubEventHandler): void {
    this.unsubscribeEvents?.();
    if (!this.bridge) return;

    try {
      this.unsubscribeEvents = this.bridge.onEvenHubEvent((event) => {
        handler(event);
      });
    } catch (err) {
      console.error("[EvenRoads][Bridge] subscribe failed", err);
      this.unsubscribeEvents = null;
    }
  }

  async shutdown(): Promise<void> {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.queuedText = null;
    this.senderTask = null;
    this.maybeLogTransportStats(true);

    if (this.bridge) {
      try {
        await this.bridge.shutDownPageContainer(0);
      } catch (err) {
        console.error("[EvenRoads][Bridge] shutdown failed", err);
      }
    }
  }
}
