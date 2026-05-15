/**
 * App composition root.
 *
 * Wires bridge ↔ lifecycle controller ↔ runtime, then installs the preview-mode
 * fallbacks (keyboard, pagehide/pageshow) that drive things when the SDK isn't
 * present. In SDK mode the lifecycle controller drives pause/resume from real
 * device events — the browser visibility events are belt-and-suspenders.
 */
import type { LaunchSource } from "@evenrealities/even_hub_sdk";
import { RoadsBridge } from "../evenhub/bridge";
import { createLifecycleController } from "./lifecycle-controller";
import { createRuntime } from "./runtime";
import { resolveRenderGlyphProfile } from "../render/display-profile";
import { LAUNCH_SOURCE_EVENT } from "../companion/contracts";

function broadcastLaunchSource(source: LaunchSource): void {
  if (typeof document === "undefined") return;
  document.body?.setAttribute("data-launch-source", source);
  if (typeof window === "undefined") return;
  if (typeof window.dispatchEvent !== "function" || typeof CustomEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(LAUNCH_SOURCE_EVENT, { detail: { launchSource: source } }));
}

export async function initApp(): Promise<void> {
  const glyphProfile = resolveRenderGlyphProfile();
  const bridge = new RoadsBridge();
  await bridge.init();

  const runtime = createRuntime({ bridge, glyphProfile });
  const controller = createLifecycleController({ bridge, runtime });

  bridge.subscribeLaunchSource((source) => {
    console.log(`[HoppyRoads] Launch source: ${source}`);
    broadcastLaunchSource(source);
  });

  controller.start();
  await runtime.start();

  installPreviewFallbacks(runtime);
}

function installPreviewFallbacks(runtime: ReturnType<typeof createRuntime>): void {
  if (typeof window === "undefined") return;

  const keyHandler = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    const key = event.key;
    const lowerKey = key.length === 1 ? key.toLowerCase() : key;

    if (key === "ArrowUp" || lowerKey === "w") {
      event.preventDefault();
      runtime.applyAction("move_up");
      return;
    }
    if (key === "ArrowLeft" || lowerKey === "a") {
      event.preventDefault();
      runtime.applyAction("move_left");
      return;
    }
    if (key === "ArrowRight" || lowerKey === "d") {
      event.preventDefault();
      runtime.applyAction("move_right");
      return;
    }
    if (key === " " || lowerKey === "p") {
      event.preventDefault();
      runtime.applyAction("toggle_pause");
    }
  };
  window.addEventListener("keydown", keyHandler, { passive: false });

  // pagehide/pageshow are iOS WKWebView-safe alternatives to beforeunload +
  // visibilitychange. In SDK mode the lifecycle controller drives pause/resume
  // from real device events; these are fallbacks for preview/desktop browsers.
  const pageHideHandler = (): void => {
    runtime.pause();
  };
  const pageShowHandler = (): void => {
    if (runtime.isPaused()) {
      runtime.resume();
    }
  };
  window.addEventListener("pagehide", pageHideHandler);
  window.addEventListener("pageshow", pageShowHandler);
}
