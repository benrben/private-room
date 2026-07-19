import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { checkForUpdatesQuietly } from "./updater";
import { initTheme } from "./theme";

// Apply the saved theme before first paint (tokens.css keys off data-theme).
initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Fire-and-forget launch update check (visually silent on launch; logs outcome).
void checkForUpdatesQuietly();
