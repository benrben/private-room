import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("./package.sh", import.meta.url), "utf8");
const e2eScript = readFileSync(new URL("./e2e.sh", import.meta.url), "utf8");
const builderConfig = readFileSync(new URL("../electron-builder.config.mjs", import.meta.url), "utf8");
const desktopPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const rootLock = JSON.parse(readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8"));

describe("package.sh native-module ABI guard", () => {
  it("pins Electron to an exact version in both the workspace and root lockfile", () => {
    const electronVersion = desktopPackage.devDependencies.electron;

    expect(electronVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(rootLock.packages["apps/desktop"].devDependencies.electron).toBe(electronVersion);
  });

  it("forces the database addon to Electron and verifies the finished app before restoring Node", () => {
    const preflight = script.indexOf("if ! npm test");
    const trap = script.indexOf("trap rebuild_back EXIT");
    const forcedElectronRebuild = script.indexOf("electron-rebuild -f -w");
    const builder = script.indexOf("npx electron-builder");
    const packagedVerification = script.indexOf("ARCELLE_PACKAGED_NATIVE");

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(trap).toBeGreaterThan(preflight);
    expect(forcedElectronRebuild).toBeGreaterThan(trap);
    expect(builder).toBeGreaterThan(forcedElectronRebuild);
    expect(packagedVerification).toBeGreaterThan(builder);
    expect(script).toContain('PACKAGED_APP="$PWD/release/mac-arm64/Arcelle.app"');
    expect(script).toContain('"$PACKAGED_APP/Contents/MacOS/Arcelle" -e');
    expect(script).toContain(
      'npm run build-release --prefix "../../node_modules/${NATIVE_MODULE}"',
    );
    expect(script).not.toContain("npm rebuild");
    // Builder's generic dependency pass must not replace the exact binary the
    // forced electron-rebuild above just proved (the 137-vs-148 regression).
    expect(builderConfig).toMatch(/npmRebuild:\s*false/);
    expect(builderConfig).not.toMatch(/npmRebuild:\s*true/);
  });

  it("runs deep Electron plus the focused privacy renderer E2E and always restores Node's ABI", () => {
    const trap = e2eScript.indexOf("trap restore_node_abi EXIT");
    const forcedElectronRebuild = e2eScript.indexOf("electron-rebuild -f -w");
    const deepTest = e2eScript.indexOf("electron-deep.mjs");
    const qaEntry = e2eScript.indexOf("make-qa.mjs");
    const privacyTest = e2eScript.indexOf("cloud-video-privacy.e2e.mjs");

    expect(trap).toBeGreaterThanOrEqual(0);
    expect(e2eScript).toMatch(/^set -euo pipefail$/m);
    expect(forcedElectronRebuild).toBeGreaterThan(trap);
    expect(deepTest).toBeGreaterThan(forcedElectronRebuild);
    expect(qaEntry).toBeGreaterThan(deepTest);
    expect(privacyTest).toBeGreaterThan(qaEntry);
    expect(e2eScript).toContain(
      "SKIP_BUILD=1 npm run e2e:qa -- --spec tests/e2e/qa/cloud-video-privacy.e2e.mjs",
    );
    expect(e2eScript).toContain(
      'npm run build-release --prefix "../../node_modules/${NATIVE_MODULE}"',
    );
    expect(e2eScript).not.toContain("npm rebuild");
    expect(e2eScript).toContain("ELECTRON_RUN_AS_NODE=1");
  });
});
