export interface AdvanceDueTicksOptions<TState> {
  state: TState;
  nowMs: number;
  nextDueAtMs: number;
  canAdvance: (state: TState) => boolean;
  getIntervalMs: (state: TState) => number;
  advance: (state: TState) => TState;
  maxSteps?: number;
}

export interface AdvanceDueTicksResult<TState> {
  state: TState;
  nextDueAtMs: number;
  advancedCount: number;
}

const DEFAULT_MAX_STEPS = 256;

export function advanceDueTicks<TState>({
  state,
  nowMs,
  nextDueAtMs,
  canAdvance,
  getIntervalMs,
  advance,
  maxSteps = DEFAULT_MAX_STEPS,
}: AdvanceDueTicksOptions<TState>): AdvanceDueTicksResult<TState> {
  let currentState = state;
  let dueAtMs = nextDueAtMs;
  let advancedCount = 0;

  while (canAdvance(currentState) && dueAtMs > 0 && nowMs >= dueAtMs && advancedCount < maxSteps) {
    currentState = advance(currentState);
    advancedCount += 1;
    dueAtMs += getIntervalMs(currentState);
  }

  if (canAdvance(currentState) && dueAtMs > 0 && nowMs >= dueAtMs) {
    dueAtMs = nowMs + getIntervalMs(currentState);
  }

  return {
    state: currentState,
    nextDueAtMs: dueAtMs,
    advancedCount,
  };
}
