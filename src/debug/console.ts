/**
 * In-browser debug console.
 *
 * This mirrors device/runtime logs into an on-page panel so we can diagnose
 * bridge behavior while testing on glasses where devtools are limited.
 */
import { isPerfDomConsoleEnabled } from "../perf/log";

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";

const DOM_MAX_LINES = 1200;
const METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

let initialized = false;
let recordingPaused = false;
let patched = false;
let lines: string[] = [];
let flushScheduled = false;

function timestampIso(): string {
  return new Date().toISOString();
}

function stringifyArg(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || value.message;
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toLogLine(level: ConsoleMethod, args: unknown[]): string {
  const msg = args.map(stringifyArg).join(" ");
  return `${timestampIso()} [${level.toUpperCase()}] ${msg}`;
}

function getPanel(): HTMLElement | null {
  return document.getElementById("perf-console-panel");
}

function getOutput(): HTMLPreElement | null {
  const el = document.getElementById("perf-console-output");
  return el instanceof HTMLPreElement ? el : null;
}

function getButton(id: string): HTMLButtonElement | null {
  const el = document.getElementById(id);
  return el instanceof HTMLButtonElement ? el : null;
}

function flushOutput(): void {
  flushScheduled = false;
  const output = getOutput();
  if (!output) return;

  // Avoid rebuilding large text blobs while panel is collapsed.
  const panel = getPanel();
  if (panel?.getAttribute("data-collapsed") === "true") return;

  output.textContent = lines.join("\n");
  output.scrollTop = output.scrollHeight;
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => {
      flushOutput();
    });
    return;
  }
  setTimeout(() => {
    flushOutput();
  }, 16);
}

function appendLine(line: string): void {
  if (recordingPaused) return;
  lines.push(line);
  if (lines.length > DOM_MAX_LINES) {
    lines.splice(0, lines.length - DOM_MAX_LINES);
  }
  scheduleFlush();
}

async function copyText(text: string): Promise<boolean> {
  if (!text) return true;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Some embedded webviews block clipboard APIs; keep a legacy path to avoid losing copy support.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

function patchConsole(): void {
  if (patched) return;
  patched = true;

  for (const method of METHODS) {
    const base = console[method].bind(console);

    console[method] = (...args: unknown[]): void => {
      base(...args);
      appendLine(toLogLine(method, args));
    };
  }
}

function wireControls(): void {
  const panel = getPanel();
  if (!panel) return;

  const toggleBtn = getButton("perf-console-toggle");
  const clearBtn = getButton("perf-console-clear");
  const copyBtn = getButton("perf-console-copy");
  const recordBtn = getButton("perf-console-record");

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const collapsed = panel.getAttribute("data-collapsed") === "true";
      panel.setAttribute("data-collapsed", collapsed ? "false" : "true");
      toggleBtn.textContent = collapsed ? "Hide" : "Show";
      if (collapsed) {
        // Refresh when expanded so users always see the latest buffered logs.
        flushOutput();
      }
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      lines = [];
      scheduleFlush();
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      void copyText(lines.join("\n")).then((ok) => {
        if (ok) {
          appendLine(`${timestampIso()} [DEBUG] copied ${lines.length} line(s)`);
        } else {
          appendLine(`${timestampIso()} [DEBUG] copy failed`);
        }
      });
    });
  }

  if (recordBtn) {
    recordBtn.addEventListener("click", () => {
      recordingPaused = !recordingPaused;
      recordBtn.textContent = recordingPaused ? "Start" : "Stop";
      if (!recordingPaused) {
        appendLine(`${timestampIso()} [DEBUG] recording resumed`);
      }
    });
  }
}

function attachApi(): void {
  window.__evenRoadsDebug = {
    clear: () => {
      lines = [];
      scheduleFlush();
    },
    copyAll: async () => copyText(lines.join("\n")),
    setPaused: (paused: boolean) => {
      recordingPaused = paused;
      const recordBtn = getButton("perf-console-record");
      if (recordBtn) recordBtn.textContent = paused ? "Start" : "Stop";
    },
    getText: () => lines.join("\n"),
  };
}

export function initDebugConsole(): void {
  if (initialized) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;

  initialized = true;
  const panel = getPanel();
  if (!panel) return;
  if (!isPerfDomConsoleEnabled()) {
    panel.style.display = "none";
    panel.setAttribute("data-collapsed", "true");
    return;
  }

  panel.style.display = "flex";
  panel.setAttribute("data-collapsed", "false");

  patchConsole();
  wireControls();
  attachApi();
  appendLine(`${timestampIso()} [DEBUG] debug console initialized`);
}

declare global {
  interface Window {
    __evenRoadsDebug?: {
      clear: () => void;
      copyAll: () => Promise<boolean>;
      setPaused: (paused: boolean) => void;
      getText: () => string;
    };
  }
}

export {};
