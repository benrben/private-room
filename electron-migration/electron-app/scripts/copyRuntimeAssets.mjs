import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Non-TypeScript files read beside compiled modules at runtime. Keep this in
 * sync with index.electron.test.ts's RUNTIME_ASSETS list. */
export const RUNTIME_ASSETS = [
  ["electron", "main", "bootStub.html"],
  ["electron", "main", "db-host", "schema.sql"],
  ["electron", "main", "browser", "page.js"],
];

export async function copyRuntimeAssets({ sourceRoot, outputRoot }) {
  for (const parts of RUNTIME_ASSETS) {
    const source = path.join(sourceRoot, ...parts);
    const destination = path.join(outputRoot, ...parts);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await copyRuntimeAssets({ sourceRoot: appRoot, outputRoot: path.join(appRoot, "dist_package") });
  console.log(`Copied ${RUNTIME_ASSETS.length} runtime assets into dist_package/.`);
}
