import type { LaunchSource } from "@evenrealities/even_hub_sdk";
import { BEST_SCORE_STORAGE_KEY, loadPersistedBestScore } from "../app/best-score-storage";
import type {
  CompanionSnapshot,
  LaunchSourceEventDetail,
  ResetBestScoreResult,
} from "./contracts";
import { LAUNCH_SOURCE_EVENT, RESET_BEST_SCORE_EVENT } from "./contracts";

interface TextNodeLike {
  textContent: string | null;
}

interface DocumentLike {
  body?: {
    getAttribute?: (name: string) => string | null;
  } | null;
  getElementById: (id: string) => TextNodeLike | null;
}

interface WindowLike {
  addEventListener?: (type: string, handler: EventListener) => void;
  removeEventListener?: (type: string, handler: EventListener) => void;
  dispatchEvent?: (event: Event) => boolean;
  localStorage?: Storage;
}

interface MutationObserverLike {
  observe: (target: Node, options?: MutationObserverInit) => void;
  disconnect: () => void;
}

type MutationObserverCtor = new (
  callback: MutationCallback,
) => MutationObserverLike;

export interface CompanionRuntimeStore {
  getSnapshot: () => CompanionSnapshot;
  subscribe: (listener: () => void) => () => void;
  destroy: () => void;
}

export interface CompanionRuntimeStoreOptions {
  document?: DocumentLike;
  window?: WindowLike;
  MutationObserver?: MutationObserverCtor | null;
}

const SCORE_RE = /Score:\s*(\d+)/i;
const BEST_RE = /Best:\s*(\d+)/i;
const STATE_RE = /State:\s*([A-Z!]+)/i;

function normalizeScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function launchSourceFromValue(value: string | null | undefined): LaunchSource | null {
  if (value === "appMenu" || value === "glassesMenu") return value;
  return null;
}

function readLaunchSource(documentLike: DocumentLike): LaunchSource | null {
  return launchSourceFromValue(documentLike.body?.getAttribute?.("data-launch-source"));
}

function getLocalStorage(windowLike: WindowLike): Storage | null {
  try {
    return windowLike.localStorage ?? null;
  } catch {
    return null;
  }
}

function parseScoreMatch(statusText: string, regex: RegExp): number | null {
  const match = statusText.match(regex);
  if (!match) return null;
  return normalizeScore(Number(match[1]));
}

export function parseCompanionStatus(statusText: string, fallbackBestScore = 0): Omit<CompanionSnapshot, "launchSource"> {
  const score = parseScoreMatch(statusText, SCORE_RE) ?? 0;
  const bestScore = parseScoreMatch(statusText, BEST_RE) ?? normalizeScore(fallbackBestScore);
  const stateMatch = statusText.match(STATE_RE);
  const runState = stateMatch?.[1]?.toUpperCase() ?? "ALIVE";
  let crossedMessage: string | null = null;

  if (stateMatch) {
    const suffix = statusText.slice((stateMatch.index ?? 0) + stateMatch[0].length).trim();
    crossedMessage = suffix.length > 0 ? suffix : null;
  }

  return {
    score,
    bestScore,
    runState,
    crossedMessage,
  };
}

function buildSnapshot(documentLike: DocumentLike, windowLike: WindowLike): CompanionSnapshot {
  const statusText = documentLike.getElementById("status")?.textContent ?? "";
  const fallbackBestScore = loadPersistedBestScore(getLocalStorage(windowLike));
  return {
    ...parseCompanionStatus(statusText, fallbackBestScore),
    launchSource: readLaunchSource(documentLike),
  };
}

function snapshotsEqual(a: CompanionSnapshot, b: CompanionSnapshot): boolean {
  return (
    a.score === b.score &&
    a.bestScore === b.bestScore &&
    a.runState === b.runState &&
    a.crossedMessage === b.crossedMessage &&
    a.launchSource === b.launchSource
  );
}

function extractLaunchSourceFromEvent(event: Event): LaunchSource | null {
  const detail = (event as CustomEvent<LaunchSourceEventDetail | undefined>).detail;
  return launchSourceFromValue(detail?.launchSource);
}

function createResetEvent(): Event | null {
  if (typeof CustomEvent === "function") {
    return new CustomEvent(RESET_BEST_SCORE_EVENT);
  }
  if (typeof Event === "function") {
    return new Event(RESET_BEST_SCORE_EVENT);
  }
  return null;
}

export function resetBestScore(windowLike: WindowLike = window): ResetBestScoreResult {
  try {
    const storage = windowLike.localStorage;
    if (!storage) throw new Error("storage unavailable");
    storage.setItem(BEST_SCORE_STORAGE_KEY, "0");
    const event = createResetEvent();
    if (!event || typeof windowLike.dispatchEvent !== "function") {
      throw new Error("event dispatch unavailable");
    }
    windowLike.dispatchEvent(event);
    return {
      ok: true,
      message: "Scores reset. New game started.",
      variant: "info",
    };
  } catch {
    return {
      ok: false,
      message: "Could not reset scores on this device.",
      variant: "error",
    };
  }
}

export function createCompanionRuntimeStore(
  options: CompanionRuntimeStoreOptions = {},
): CompanionRuntimeStore {
  const documentLike = options.document ?? document;
  const windowLike = options.window ?? window;
  const MutationObserverImpl =
    options.MutationObserver === undefined
      ? typeof MutationObserver === "function"
        ? MutationObserver
        : null
      : options.MutationObserver;

  let snapshot = buildSnapshot(documentLike, windowLike);
  const listeners = new Set<() => void>();

  const emitIfChanged = (): void => {
    const next = buildSnapshot(documentLike, windowLike);
    if (snapshotsEqual(snapshot, next)) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const onLaunchSource: EventListener = (event) => {
    const source = extractLaunchSourceFromEvent(event) ?? readLaunchSource(documentLike);
    if (!source || snapshot.launchSource === source) return;
    snapshot = {
      ...snapshot,
      launchSource: source,
    };
    for (const listener of [...listeners]) listener();
  };

  windowLike.addEventListener?.(LAUNCH_SOURCE_EVENT, onLaunchSource);

  const statusRoot = documentLike.getElementById("status");
  let observer: MutationObserverLike | null = null;
  if (statusRoot && MutationObserverImpl) {
    const nextObserver = new MutationObserverImpl(() => {
      emitIfChanged();
    });
    nextObserver.observe(statusRoot as unknown as Node, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    observer = nextObserver;
  }

  return {
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      observer?.disconnect();
      listeners.clear();
      windowLike.removeEventListener?.(LAUNCH_SOURCE_EVENT, onLaunchSource);
    },
  };
}
