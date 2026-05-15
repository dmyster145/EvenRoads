/**
 * Even Hub bridge facade.
 *
 * Owns the SDK handle, the transport queue, and the lifecycle event source.
 * The runtime/controller interact with `transport` and `lifecycle` directly
 * via the accessors below — this class is just a composition root.
 */
import type {
  EvenAppBridge,
  EvenHubEvent,
  LaunchSource,
} from "@evenrealities/even_hub_sdk";
import {
  Transport,
  waitForBridgeWithTimeout,
} from "./transport";
import {
  createLifecycleSource,
  type ConnectionListener,
  type ConnectionState,
  type InputEventListener,
  type LifecycleEventListener,
  type LifecycleSource,
} from "./lifecycle";
import { perfNowMs } from "../perf/log";

export type LaunchSourceHandler = (source: LaunchSource) => void;
export type { ConnectionState };

export interface BridgeSubscriptions {
  onLifecycle: LifecycleEventListener;
  onInput: InputEventListener;
  onConnection: ConnectionListener;
}

export class RoadsBridge {
  readonly transport = new Transport();
  private sdk: EvenAppBridge | null = null;
  private lifecycleSource: LifecycleSource | null = null;
  private unsubscribeLaunchSource: (() => void) | null = null;
  private latestLaunchSource: LaunchSource | null = null;
  private readonly launchSourceHandlers = new Set<LaunchSourceHandler>();

  async init(): Promise<void> {
    const startedAt = perfNowMs();
    this.sdk = await waitForBridgeWithTimeout();
    this.transport.setBridge(this.sdk);

    if (this.sdk) {
      try {
        this.unsubscribeLaunchSource = this.sdk.onLaunchSource((source) => {
          this.latestLaunchSource = source;
          for (const handler of this.launchSourceHandlers) {
            try {
              handler(source);
            } catch (err) {
              console.error("[HoppyRoads][Bridge] launch source handler threw", err);
            }
          }
        });
      } catch (err) {
        console.warn("[HoppyRoads][Bridge] launch source subscribe failed", err);
        this.unsubscribeLaunchSource = null;
      }
      const waitMs = perfNowMs() - startedAt;
      console.log(`[HoppyRoads][Bridge] ready in ${waitMs.toFixed(1)}ms`);
    } else {
      console.log("[HoppyRoads][Bridge] running in preview mode (no SDK bridge)");
    }
  }

  hasBridge(): boolean {
    return this.sdk !== null;
  }

  /**
   * Wire lifecycle/input/connection callbacks. Idempotent — calling again
   * tears down the previous wiring first.
   */
  subscribe(subscriptions: BridgeSubscriptions): void {
    this.lifecycleSource?.destroy();
    this.lifecycleSource = createLifecycleSource(this.sdk, subscriptions);
  }

  getConnectionState(): ConnectionState {
    return this.lifecycleSource?.getConnectionState() ?? "unknown";
  }

  subscribeLaunchSource(handler: LaunchSourceHandler): () => void {
    this.launchSourceHandlers.add(handler);
    if (this.latestLaunchSource) {
      handler(this.latestLaunchSource);
    }
    return () => {
      this.launchSourceHandlers.delete(handler);
    };
  }

  async shutdown(): Promise<void> {
    this.lifecycleSource?.destroy();
    this.lifecycleSource = null;
    this.unsubscribeLaunchSource?.();
    this.unsubscribeLaunchSource = null;
    this.launchSourceHandlers.clear();
    this.transport.dropQueue();
    this.transport.flushStats();
    await this.transport.shutdownPage(0);
    this.transport.setBridge(null);
    this.sdk = null;
  }
}
