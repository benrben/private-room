import { createRequire } from "node:module";

// Playwright belongs to the Electron workspace. Resolve it from that package
// even though this repository-level smoke test lives under e2e/.
const requireFromElectronWorkspace = createRequire(
  new URL("../../../apps/desktop/package.json", import.meta.url),
);
const { _electron: electron } = requireFromElectronWorkspace("playwright");

const electronEnv = { ...process.env, ARCELLE_E2E: "1" };
// Some Node-based runners set this for Electron helper processes. Keeping it
// here turns the Electron executable itself into plain Node and prevents the
// browser process from accepting Chromium's debugging flags.
delete electronEnv.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  args: ["dist_package/src/main/index.js"],
  env: electronEnv,
  timeout: 30_000,
});

try {
  const window = await app.firstWindow({ timeout: 30_000 });
  await window.waitForLoadState("domcontentloaded");
  const bridge = await window.evaluate(() => ({
    title: document.title,
    hasRoot: document.querySelector("#root") !== null,
    hasInvoke: typeof window.arcelle?.invoke === "function",
  }));
  if (!bridge.hasRoot || !bridge.hasInvoke) {
    throw new Error(`Electron smoke failed: ${JSON.stringify(bridge)}`);
  }
  console.log(`Electron smoke passed: ${bridge.title || "Arcelle"}`);
} finally {
  await app.close();
}
