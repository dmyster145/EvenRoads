export interface TickSource {
  schedule(delayMs: number): void;
  cancel(): void;
  destroy(): void;
}

const WORKER_SOURCE = `
let timer = null;

function clearScheduledTick() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === "schedule") {
    clearScheduledTick();
    const delayMs = Math.max(0, Number(data.delayMs) || 0);
    timer = setTimeout(() => {
      timer = null;
      self.postMessage({ type: "tick" });
    }, delayMs);
    return;
  }

  if (data.type === "cancel") {
    clearScheduledTick();
    return;
  }

  if (data.type === "destroy") {
    clearScheduledTick();
    self.close();
  }
};
`;

export function createTickSource(onTick: () => void): TickSource {
  const browserWindow = typeof window !== "undefined" ? window : null;
  if (
    browserWindow &&
    typeof browserWindow.Worker === "function" &&
    typeof browserWindow.Blob === "function" &&
    typeof browserWindow.URL !== "undefined" &&
    typeof browserWindow.URL.createObjectURL === "function"
  ) {
    let worker: Worker | null = null;
    let workerUrl: string | null = null;

    try {
      workerUrl = browserWindow.URL.createObjectURL(
        new browserWindow.Blob([WORKER_SOURCE], { type: "text/javascript" }),
      );
      worker = new browserWindow.Worker(workerUrl);
      worker.onmessage = (event: MessageEvent<{ type?: string }>) => {
        if (event.data?.type === "tick") {
          onTick();
        }
      };
    } catch (err) {
      console.warn("[HoppyRoads] Falling back to main-thread tick source", err);
      worker?.terminate();
      worker = null;
    } finally {
      if (workerUrl) {
        browserWindow.URL.revokeObjectURL(workerUrl);
      }
    }

    if (worker) {
      return {
        schedule(delayMs: number) {
          worker?.postMessage({ type: "schedule", delayMs });
        },
        cancel() {
          worker?.postMessage({ type: "cancel" });
        },
        destroy() {
          worker?.postMessage({ type: "destroy" });
          worker?.terminate();
          worker = null;
        },
      };
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(delayMs: number) {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        onTick();
      }, delayMs);
    },
    cancel() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    },
    destroy() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
