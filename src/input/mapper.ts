/**
 * Normalizes Even Hub events into game inputs.
 *
 * The SDK may emit duplicated gesture events on some firmware revisions; these
 * small dedupe windows keep controls responsive while preventing accidental doubles.
 */
import {
  OsEventTypeList,
  type EvenHubEvent,
  type List_ItemEvent,
  type Text_ItemEvent,
  type Sys_ItemEvent,
} from "@evenrealities/even_hub_sdk";
import type { InputAction } from "../game/types";
import { perfNowMs } from "../perf/log";

// Keep scroll filtering nearly transparent; we only want to collapse duplicate callbacks
// generated within the same gesture burst, not slow down intentional repeated swipes.
const RAW_SCROLL_DEBOUNCE_MS = 1;
const SAME_DIR_SCROLL_DEDUPE_MS = 1;
// Taps are more prone to accidental repeats from firmware and user finger bounce.
const TAP_DEDUPE_MS = 10;
const DOUBLE_TAP_DEDUPE_MS = 140;
const INPUT_PERF_LOG_EVERY_MS = 4000;
const INPUT_PERF_LOG_MIN_DROPS = 16;
const INPUT_PERF_LOG_MIN_MAPPED = 80;

let lastRawScrollAt = 0;
let lastAcceptedScrollAt = 0;
let lastAcceptedScrollDir: "up" | "down" | null = null;
let lastTapAt = 0;
let lastDoubleTapAt = 0;
let droppedRawScrollCount = 0;
let droppedSameDirectionScrollCount = 0;
let droppedTapCount = 0;
let droppedDoubleTapCount = 0;
let mappedCount = 0;
let lastInputPerfLogAtMs = perfNowMs();

function maybeLogInputPerf(force = false): void {
  const now = perfNowMs();
  const droppedCount =
    droppedRawScrollCount + droppedSameDirectionScrollCount + droppedTapCount + droppedDoubleTapCount;
  const byTime = now - lastInputPerfLogAtMs >= INPUT_PERF_LOG_EVERY_MS;
  const byDrops = droppedCount >= INPUT_PERF_LOG_MIN_DROPS;
  const byMapped = mappedCount >= INPUT_PERF_LOG_MIN_MAPPED;
  if (!force && !byTime && !byDrops && !byMapped) return;

  if (mappedCount === 0 && droppedCount === 0) {
    lastInputPerfLogAtMs = now;
    return;
  }

  console.log(
    `[EvenRoads][Perf][Input] mapped=${mappedCount} dropRawScroll=${droppedRawScrollCount} ` +
      `dropSameDirScroll=${droppedSameDirectionScrollCount} dropTap=${droppedTapCount} dropDoubleTap=${droppedDoubleTapCount}`,
  );

  droppedRawScrollCount = 0;
  droppedSameDirectionScrollCount = 0;
  droppedTapCount = 0;
  droppedDoubleTapCount = 0;
  mappedCount = 0;
  lastInputPerfLogAtMs = now;
}

function shouldDropScroll(direction: "up" | "down"): boolean {
  const now = perfNowMs();
  const rawDt = now - lastRawScrollAt;
  lastRawScrollAt = now;
  if (rawDt < RAW_SCROLL_DEBOUNCE_MS) {
    droppedRawScrollCount += 1;
    maybeLogInputPerf();
    return true;
  }

  const acceptedDt = now - lastAcceptedScrollAt;
  if (lastAcceptedScrollDir === direction && acceptedDt < SAME_DIR_SCROLL_DEDUPE_MS) {
    droppedSameDirectionScrollCount += 1;
    maybeLogInputPerf();
    return true;
  }

  lastAcceptedScrollAt = now;
  lastAcceptedScrollDir = direction;
  return false;
}

function shouldDropTap(isDouble: boolean): boolean {
  const now = perfNowMs();
  if (isDouble) {
    if (now - lastDoubleTapAt < DOUBLE_TAP_DEDUPE_MS) {
      droppedDoubleTapCount += 1;
      maybeLogInputPerf();
      return true;
    }
    lastDoubleTapAt = now;
    return false;
  }
  if (now - lastTapAt < TAP_DEDUPE_MS) {
    droppedTapCount += 1;
    maybeLogInputPerf();
    return true;
  }
  lastTapAt = now;
  return false;
}

function recordMapped(action: InputAction | null): InputAction | null {
  if (!action) return null;
  mappedCount += 1;
  maybeLogInputPerf();
  return action;
}

function mapEventType(eventType: number | undefined | null): InputAction | null {
  switch (eventType) {
    case OsEventTypeList.SCROLL_TOP_EVENT:
      if (shouldDropScroll("up")) return null;
      return "move_left";
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      if (shouldDropScroll("down")) return null;
      return "move_right";
    case OsEventTypeList.CLICK_EVENT:
      if (shouldDropTap(false)) return null;
      return "move_up";
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      if (shouldDropTap(true)) return null;
      return "toggle_pause";
    default:
      return null;
  }
}

function mapListEvent(event: List_ItemEvent): InputAction | null {
  const mapped = mapEventType(event.eventType);
  if (mapped) return recordMapped(mapped);

  // Some SDK paths surface clicks as undefined eventType but with list selection payload.
  if (event.eventType == null && event.currentSelectItemIndex != null) {
    if (shouldDropTap(false)) return null;
    return recordMapped("move_up");
  }

  return null;
}

function mapTextEvent(event: Text_ItemEvent): InputAction | null {
  const mapped = mapEventType(event.eventType);
  if (mapped) return recordMapped(mapped);

  if (event.eventType == null) {
    if (shouldDropTap(false)) return null;
    return recordMapped("move_up");
  }

  return null;
}

function mapSysEvent(event: Sys_ItemEvent): InputAction | null {
  const mapped = mapEventType(event.eventType);
  if (mapped) return recordMapped(mapped);

  if (event.eventType == null) {
    if (shouldDropTap(false)) return null;
    return recordMapped("move_up");
  }

  return null;
}

export function mapEvenHubEventToInput(event: EvenHubEvent): InputAction | null {
  if (event.listEvent) return mapListEvent(event.listEvent);
  if (event.textEvent) return mapTextEvent(event.textEvent);
  if (event.sysEvent) return mapSysEvent(event.sysEvent);
  return null;
}

/**
 * Deterministic reset hook for tests and stress harnesses.
 */
export function resetInputMapperStateForTests(): void {
  lastRawScrollAt = 0;
  lastAcceptedScrollAt = 0;
  lastAcceptedScrollDir = null;
  lastTapAt = 0;
  lastDoubleTapAt = 0;
  droppedRawScrollCount = 0;
  droppedSameDirectionScrollCount = 0;
  droppedTapCount = 0;
  droppedDoubleTapCount = 0;
  mappedCount = 0;
  lastInputPerfLogAtMs = perfNowMs();
}
