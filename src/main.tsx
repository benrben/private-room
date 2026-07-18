import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { checkForUpdatesQuietly } from "./updater";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Fire-and-forget launch update check (visually silent on launch; logs outcome).
void checkForUpdatesQuietly();
