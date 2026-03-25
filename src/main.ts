import "./styles/app.css";
import { initApp } from "./app/init";
import { mountCompanionShell } from "./companion/shell";
import { initDebugConsole } from "./debug/console";

// Let the console module decide whether the panel should be shown or hidden.
initDebugConsole();

mountCompanionShell();

initApp().catch((err) => {
  console.error("[HoppyRoads] initialization failed", err);
  const root = document.getElementById("app");
  if (root) {
    root.textContent = "HoppyRoads - initialization failed. Check console.";
  }
});
