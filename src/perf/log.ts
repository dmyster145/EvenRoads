/**
 * Minimal input timing state shared by the runtime.
 *
 * This intentionally tracks only the latest input to keep render-loop logging cheap.
 */
export type InputPerfTrace = {
  seq: number;
  atMs: number;
  name: string;
};

type PerfNowProvider = () => number;

let inputSeq = 0;
let lastInputTrace: InputPerfTrace = { seq: 0, atMs: 0, name: "-" };
let perfNowProvider: PerfNowProvider | null = null;

function nowMs(): number {
  if (perfNowProvider) return perfNowProvider();
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function recordInput(name: string): InputPerfTrace {
  lastInputTrace = {
    seq: ++inputSeq,
    atMs: nowMs(),
    name,
  };
  return lastInputTrace;
}

export function getLastInputTrace(): InputPerfTrace {
  return lastInputTrace;
}

export function perfNowMs(): number {
  return nowMs();
}

/**
 * Test hook for deterministic timing. Pass null to restore default behavior.
 */
export function setPerfNowProvider(provider: PerfNowProvider | null): void {
  perfNowProvider = provider;
}

/**
 * Clears input timing history so stress tests can start from a known baseline.
 */
export function resetPerfLogState(): void {
  inputSeq = 0;
  lastInputTrace = { seq: 0, atMs: 0, name: "-" };
}
