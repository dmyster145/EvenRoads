import { initApp } from "./app/init";
import { initDebugConsole } from "./debug/console";

// Capture startup logs before any async bridge/setup work begins.
initDebugConsole();

initApp().catch((err) => {
  console.error("[EvenRoads] initialization failed", err);
  const root = document.getElementById("app");
  if (root) {
    root.textContent = "EvenRoads - initialization failed. Check console.";
  }
});
