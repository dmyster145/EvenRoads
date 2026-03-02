const BEST_SCORE_STORAGE_KEY = "evenroads.bestScore";

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function loadPersistedBestScore(storage: Storage | null = getBrowserStorage()): number {
  if (!storage) return 0;
  let raw: string | null;
  try {
    raw = storage.getItem(BEST_SCORE_STORAGE_KEY);
  } catch {
    return 0;
  }
  if (!raw) return 0;
  return normalizeScore(Number(raw));
}

export function persistBestScore(bestScore: number, storage: Storage | null = getBrowserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(BEST_SCORE_STORAGE_KEY, String(normalizeScore(bestScore)));
  } catch {
    // Ignore storage write failures so gameplay can continue in restricted runtimes.
  }
}
