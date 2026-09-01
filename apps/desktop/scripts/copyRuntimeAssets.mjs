import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Non-TypeScript files read beside compiled modules at runtime. Keep this in
 * sync with index.electron.test.ts's RUNTIME_ASSETS list. */
export const RUNTIME_ASSETS = [
  ["src", "main", "bootStub.html"],
  ["src", "main", "db-host", "schema.sql"],
  ["src", "main", "browser", "pageCore.js"],
  ["src", "main", "browser", "pageSnapshot.js"],
  ["src", "main", "browser", "pageRead.js"],
  ["src", "main", "browser", "pageActions.js"],
  ["src", "main", "browser", "page.js"],
];

/** Repository-level manifests consumed by both Electron and Python harnesses. */
export const SHARED_RUNTIME_ASSETS = [
  ["config", "agent-manifest.json"],
];

export async function copyRuntimeAssets({ sourceRoot, outputRoot }) {
  for (const parts of RUNTIME_ASSETS) {
    const source = path.join(sourceRoot, ...parts);
    const destination = path.join(outputRoot, ...parts);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  for (const parts of SHARED_RUNTIME_ASSETS) {
    const source = path.join(sourceRoot, "../..", ...parts);
    const destination = path.join(outputRoot, ...parts);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

export function runtimeAssetsOutputRoot(appRoot, args) {
  const outputFlag = args.indexOf("--output-root");
  if (outputFlag < 0) return path.join(appRoot, "dist_package");
  const supplied = args[outputFlag + 1];
  if (!supplied) throw new Error("--output-root needs a path.");
  return path.resolve(appRoot, supplied);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outputRoot = runtimeAssetsOutputRoot(appRoot, process.argv.slice(2));
  await copyRuntimeAssets({ sourceRoot: appRoot, outputRoot });
  console.log(`Copied ${RUNTIME_ASSETS.length + SHARED_RUNTIME_ASSETS.length} runtime assets into ${outputRoot}.`);
}
