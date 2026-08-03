import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { checkForUpdatesQuietly } from "./updater";
import { initTheme } from "./theme";
import { warmRichPlugins } from "./viewers/markdownRich";
import ErrorBoundary from "./shell/ErrorBoundary";

// Apply the saved theme before first paint (tokens.css keys off data-theme).
initTheme();

// Maths and syntax highlighting live in their own chunk so they cost nothing
// at cold start; fetch it once the window is idle, so the first note or chat
// message that needs them already has them.
warmRichPlugins();

// The root boundary is the last line of defence: without it a single thrown
// render empties the window with no message and no way back but quitting.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary scope="Arcelle" root>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// Fire-and-forget launch update check (visually silent on launch unless an
// update is offered; honours the "check automatically" preference).
void checkForUpdatesQuietly();
