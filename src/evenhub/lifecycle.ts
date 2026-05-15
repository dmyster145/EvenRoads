/**
 * Lifecycle event parsing for the Even Hub bridge.
 *
 * Two sources:
 *  1. `onDeviceStatusChanged` — device connect/disconnect, wearing, battery.
 *  2. `onEvenHubEvent` filtered to `sysEvent.eventType` 4..7 — foreground enter/exit,
 *     abnormal exit, system exit.
 *
 * Game input events (clicks, scrolls, double-clicks) are forwarded to a separate
 * callback so the controller can keep input handling independent from lifecycle
 * state-machine concerns.
 *
 * Protobuf strips zero-value fields, so eventType=0 (CLICK_EVENT) and similar
 * may arrive as undefined. Use nullish coalescing throughout.
 */
import {
  DeviceConnectType,
  OsEventTypeList,
  type DeviceStatus,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";

export type LifecycleEventName =
  | "foregroundEnter"
  | "foregroundExit"
  | "abnormalExit"
  | "systemExit";

export type LifecycleEventListener = (name: LifecycleEventName) => void;
export type InputEventListener = (event: EvenHubEvent) => void;
export type ConnectionState = "unknown" | "connecting" | "connected" | "disconnected" | "failed";
export type ConnectionListener = (state: ConnectionState, status: DeviceStatus | null) => void;

export function parseLifecycleEvent(event: EvenHubEvent): LifecycleEventName | null {
  const sys = event.sysEvent;
  if (!sys) return null;
  const eventType = sys.eventType ?? 0;
  switch (eventType) {
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      return "foregroundEnter";
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      return "foregroundExit";
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      return "abnormalExit";
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
      return "systemExit";
    default:
      return null;
  }
}

function mapConnectionState(status: DeviceStatus): ConnectionState {
  switch (status.connectType) {
    case DeviceConnectType.Connected:
      return "connected";
    case DeviceConnectType.Connecting:
      return "connecting";
    case DeviceConnectType.Disconnected:
      return "disconnected";
    case DeviceConnectType.ConnectionFailed:
      return "failed";
    case DeviceConnectType.None:
    default:
      return "unknown";
  }
}

export interface LifecycleSourceOptions {
  onLifecycle: LifecycleEventListener;
  onInput: InputEventListener;
  onConnection: ConnectionListener;
}

export interface LifecycleSource {
  /** Last reported connection state. Defaults to "unknown" until first event. */
  getConnectionState(): ConnectionState;
  destroy(): void;
}

/**
 * Wire all bridge event sources into the supplied listeners. Returns a handle
 * with a single `destroy()` to tear them all down.
 *
 * In preview mode (`bridge === null`), this is a no-op handle.
 */
export function createLifecycleSource(
  bridge: EvenAppBridge | null,
  options: LifecycleSourceOptions,
): LifecycleSource {
  let connectionState: ConnectionState = "unknown";
  const unsubscribers: Array<() => void> = [];

  if (bridge) {
    try {
      const unsub = bridge.onEvenHubEvent((event) => {
        // TEMP debug: ground-truth of every SDK event. Critical for the exit
        // freeze — tells us exactly what (if anything) fires when the dialog
        // shows and when the user picks "No"/"Yes".
        console.log(
          `[HoppyRoads][RawEvent] sys=${event.sysEvent?.eventType ?? "·"} ` +
            `text=${event.textEvent?.eventType ?? "·"} ` +
            `list=${event.listEvent?.eventType ?? "·"} ` +
            `sysReason=${event.sysEvent?.systemExitReasonCode ?? "·"}`,
        );
        const lifecycleName = parseLifecycleEvent(event);
        if (lifecycleName) {
          try {
            options.onLifecycle(lifecycleName);
          } catch (err) {
            console.error("[HoppyRoads][Lifecycle] onLifecycle handler threw", err);
          }
          return;
        }
        try {
          options.onInput(event);
        } catch (err) {
          console.error("[HoppyRoads][Lifecycle] onInput handler threw", err);
        }
      });
      unsubscribers.push(unsub);
    } catch (err) {
      console.error("[HoppyRoads][Lifecycle] onEvenHubEvent subscribe failed", err);
    }

    try {
      const unsub = bridge.onDeviceStatusChanged((status) => {
        const next = mapConnectionState(status);
        if (next === connectionState) return;
        connectionState = next;
        try {
          options.onConnection(connectionState, status);
        } catch (err) {
          console.error("[HoppyRoads][Lifecycle] onConnection handler threw", err);
        }
      });
      unsubscribers.push(unsub);
    } catch (err) {
      console.error("[HoppyRoads][Lifecycle] onDeviceStatusChanged subscribe failed", err);
    }
  }

  return {
    getConnectionState() {
      return connectionState;
    },
    destroy() {
      while (unsubscribers.length > 0) {
        const fn = unsubscribers.pop();
        if (!fn) continue;
        try {
          fn();
        } catch (err) {
          console.error("[HoppyRoads][Lifecycle] unsubscribe threw", err);
        }
      }
    },
  };
}
