/**
 * Minimal input timing state shared by the runtime.
 *
 * This intentionally tracks only the latest input to keep render-loop logging cheap.
 */
const PERF_LOG_CONSOLE_ENABLED = false;
const PERF_LOG_DOM_ENABLED = false;

export type PerfConfig = {
  consoleEnabled: boolean;
  domEnabled: boolean;
  anyEnabled: boolean;
};

const PERF_CONFIG: PerfConfig = {
  consoleEnabled: PERF_LOG_CONSOLE_ENABLED,
  domEnabled: PERF_LOG_DOM_ENABLED,
  anyEnabled: PERF_LOG_CONSOLE_ENABLED || PERF_LOG_DOM_ENABLED,
};

if (typeof window !== "undefined") {
  (
    window as Window & {
      __evenRoadsPerfConfig?: PerfConfig;
    }
  ).__evenRoadsPerfConfig = PERF_CONFIG;
}

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

export function getPerfConfig(): PerfConfig {
  return PERF_CONFIG;
}

export function isPerfLoggingEnabled(): boolean {
  return PERF_CONFIG.anyEnabled;
}

export function isPerfConsoleLoggingEnabled(): boolean {
  return PERF_CONFIG.consoleEnabled;
}

export function isPerfDomConsoleEnabled(): boolean {
  return PERF_CONFIG.domEnabled;
}

export function perfLog(msg: string): void {
  if (!PERF_LOG_CONSOLE_ENABLED) return;
  console.log(msg);
}

export function perfLogLazy(msgFactory: () => string): void {
  if (!PERF_LOG_CONSOLE_ENABLED) return;
  perfLog(msgFactory());
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

declare global {
  interface Window {
    __evenRoadsPerfConfig?: PerfConfig;
  }
}
